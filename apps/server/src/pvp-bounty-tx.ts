/**
 * On-chain PvpBounty txs — operator claim/cancel via listing/owner key;
 * read helpers for open status + receipt fields for log mirrors.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Chain,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { listingRoleKey } from "./ah-escrow";
import { withOwnerKeyQueue } from "./owner-tx-queue";
import { pvpBountyAddress } from "./pvp-bounty";
import { settlementChainId } from "./settlement-chain";
import { settlementConfirmations } from "./settlement-confirmations";

export const PVP_BOUNTY_ABI = [
  {
    type: "function",
    name: "place",
    stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "victimTokenId", type: "uint256" },
      { name: "slayerTokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "open",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "BOUNTY_WEI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "BountyOpened",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "amountWei", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BountyCancelled",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "refundTo", type: "address", indexed: true },
      { name: "amountWei", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BountyClaimed",
    inputs: [
      { name: "victimTokenId", type: "uint256", indexed: true },
      { name: "slayerTokenId", type: "uint256", indexed: true },
      { name: "slayerPayout", type: "address", indexed: true },
      { name: "amountWei", type: "uint256", indexed: false },
    ],
  },
] as const;

export type PvpChainReceipt = {
  txHash: `0x${string}`;
  logIndex: number;
};

function rpcUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const u = (env.LOK_CHAIN_RPC?.trim() || env.LOK_PUBLIC_RPC?.trim() || "").replace(/\/$/, "");
  return u || null;
}

function operatorKey(env: NodeJS.ProcessEnv = process.env): string | null {
  // Prefer listing key (Deploy wires OPERATOR = LISTING); fall back to owner for local anvil.
  return listingRoleKey(env) || env.LOK_OWNER_KEY?.trim() || null;
}

function anvilChain(chainId: number): Chain {
  return {
    id: chainId,
    name: chainId === 31337 ? "anvil" : "lok",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl() || "http://127.0.0.1:8545"] } },
  };
}

export async function readPvpBountyOpen(
  tokenId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean | null> {
  const bounty = pvpBountyAddress(env);
  const rpc = rpcUrl(env);
  if (!bounty || !rpc) return null;
  const client = createPublicClient({
    chain: anvilChain(settlementChainId(env)),
    transport: http(rpc),
  });
  try {
    return await client.readContract({
      address: bounty as Hex,
      abi: PVP_BOUNTY_ABI,
      functionName: "open",
      args: [BigInt(tokenId)],
    });
  } catch {
    return null;
  }
}

function eventReceipt(
  receipt: TransactionReceipt,
  eventName: "BountyOpened" | "BountyCancelled" | "BountyClaimed",
): PvpChainReceipt | null {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: PVP_BOUNTY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === eventName) {
        return {
          txHash: receipt.transactionHash,
          logIndex: Number(log.logIndex),
        };
      }
    } catch {
      /* not our event */
    }
  }
  // Fallback: first log index if decode fails (still binds a unique fill key).
  if (receipt.logs[0]) {
    return { txHash: receipt.transactionHash, logIndex: Number(receipt.logs[0].logIndex) };
  }
  return { txHash: receipt.transactionHash, logIndex: 0 };
}

async function withOperatorWallet<T>(
  env: NodeJS.ProcessEnv,
  fn: (ctx: {
    wallet: ReturnType<typeof createWalletClient>;
    public: ReturnType<typeof createPublicClient>;
    account: ReturnType<typeof privateKeyToAccount>;
    bounty: Hex;
  }) => Promise<T>,
): Promise<T> {
  const bounty = pvpBountyAddress(env);
  const rpc = rpcUrl(env);
  const key = operatorKey(env);
  if (!bounty || !rpc || !key) {
    throw new Error("PvpBounty needs LOK_PVP_BOUNTY + LOK_CHAIN_RPC + LOK_LISTING_KEY (or LOK_OWNER_KEY)");
  }
  const account = privateKeyToAccount(key as Hex);
  const chain = anvilChain(settlementChainId(env));
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  return fn({ wallet, public: publicClient, account, bounty: bounty as Hex });
}

/** Operator cancel — refunds original payer. */
export async function chainPvpCancel(
  tokenId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; receipt: PvpChainReceipt } | { ok: false; error: string }> {
  try {
    return await withOwnerKeyQueue(async () => {
      return withOperatorWallet(env, async ({ wallet, public: pub, account, bounty }) => {
        const hash = await wallet.writeContract({
          address: bounty,
          abi: PVP_BOUNTY_ABI,
          functionName: "cancel",
          args: [BigInt(tokenId)],
          account,
          chain: wallet.chain,
        });
        const conf = settlementConfirmations(env);
        const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: conf });
        if (receipt.status !== "success") return { ok: false, error: "PvpBounty.cancel reverted" };
        const fields = eventReceipt(receipt, "BountyCancelled");
        if (!fields) return { ok: false, error: "PvpBounty.cancel missing event" };
        return { ok: true, receipt: fields };
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Operator claim — pays slayer NFT owner. */
export async function chainPvpClaim(
  victimTokenId: string,
  slayerTokenId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; receipt: PvpChainReceipt } | { ok: false; error: string }> {
  try {
    return await withOwnerKeyQueue(async () => {
      return withOperatorWallet(env, async ({ wallet, public: pub, account, bounty }) => {
        const hash = await wallet.writeContract({
          address: bounty,
          abi: PVP_BOUNTY_ABI,
          functionName: "claim",
          args: [BigInt(victimTokenId), BigInt(slayerTokenId)],
          account,
          chain: wallet.chain,
        });
        const conf = settlementConfirmations(env);
        const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: conf });
        if (receipt.status !== "success") return { ok: false, error: "PvpBounty.claim reverted" };
        const fields = eventReceipt(receipt, "BountyClaimed");
        if (!fields) return { ok: false, error: "PvpBounty.claim missing event" };
        return { ok: true, receipt: fields };
      });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Load place tx receipt fields after the player paid on-chain. */
export async function receiptFromPlaceTx(
  txHash: string,
  tokenId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; receipt: PvpChainReceipt } | { ok: false; error: string }> {
  const bounty = pvpBountyAddress(env);
  const rpc = rpcUrl(env);
  if (!bounty || !rpc) return { ok: false, error: "PvpBounty not configured" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, error: "Bad place tx hash" };
  try {
    const pub = createPublicClient({
      chain: anvilChain(settlementChainId(env)),
      transport: http(rpc),
    });
    const receipt = await pub.waitForTransactionReceipt({
      hash: txHash as Hex,
      confirmations: settlementConfirmations(env),
    });
    if (receipt.status !== "success") return { ok: false, error: "place tx reverted" };
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== bounty.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: PVP_BOUNTY_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "BountyOpened") {
          const tid = (decoded.args as { tokenId: bigint }).tokenId;
          if (tid.toString() !== tokenId) {
            return { ok: false, error: "place tx is for a different character" };
          }
          return {
            ok: true,
            receipt: { txHash: receipt.transactionHash, logIndex: Number(log.logIndex) },
          };
        }
      } catch {
        /* skip */
      }
    }
    // Still open on-chain? Accept tx as place even if event decode failed.
    const open = await readPvpBountyOpen(tokenId, env);
    if (open) {
      return {
        ok: true,
        receipt: { txHash: receipt.transactionHash, logIndex: Number(receipt.logs[0]?.logIndex ?? 0) },
      };
    }
    return { ok: false, error: "place tx did not open a bounty for this character" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Recover the BountyOpened receipt when the bounty is already open on-chain
 * (client lost the place hash, or server restarted mid-join).
 */
export async function receiptFromOpenBounty(
  tokenId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; receipt: PvpChainReceipt } | { ok: false; error: string }> {
  const bounty = pvpBountyAddress(env);
  const rpc = rpcUrl(env);
  if (!bounty || !rpc) return { ok: false, error: "PvpBounty not configured" };
  try {
    const pub = createPublicClient({
      chain: anvilChain(settlementChainId(env)),
      transport: http(rpc),
    });
    const open = await pub.readContract({
      address: bounty as Hex,
      abi: PVP_BOUNTY_ABI,
      functionName: "open",
      args: [BigInt(tokenId)],
    });
    if (!open) return { ok: false, error: "No open bounty on-chain for this character" };
    const logs = await pub.getLogs({
      address: bounty as Hex,
      event: {
        type: "event",
        name: "BountyOpened",
        inputs: [
          { name: "tokenId", type: "uint256", indexed: true },
          { name: "payer", type: "address", indexed: true },
          { name: "amountWei", type: "uint256", indexed: false },
        ],
      },
      args: { tokenId: BigInt(tokenId) },
      fromBlock: 0n,
      toBlock: "latest",
    });
    const last = logs[logs.length - 1];
    if (!last?.transactionHash) {
      return { ok: false, error: "Open bounty has no BountyOpened log — re-place or contact ops" };
    }
    return {
      ok: true,
      receipt: {
        txHash: last.transactionHash,
        logIndex: Number(last.logIndex ?? 0),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
