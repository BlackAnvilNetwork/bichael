import {
  createPublicClient,
  decodeEventLog,
  http,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import type { CharacterMintClientConfig } from "@bellgrave/protocol";

/** Same event CharacterFactory emits. topic0 is keccak256 of the signature. */
export const CHARACTER_CREATED_TOPIC = keccak256(
  toBytes("CharacterCreated(address,uint256,uint8)"),
);

const CHARACTER_CREATED_ABI = [
  {
    type: "event",
    name: "CharacterCreated",
    inputs: [
      { name: "player", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "startingJob", type: "uint8", indexed: false },
    ],
  },
] as const;

const OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Browser-reachable factory. The player wallet calls createCharacter and pays mintFee.
 * Absent when the server has no factory, so create stays a log identity only.
 */
export function characterMintClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): CharacterMintClientConfig | null {
  const factory = env.LOK_FACTORY?.trim() ?? "";
  const nft = env.LOK_NFT?.trim() ?? "";
  const rpcUrl = (env.LOK_PUBLIC_RPC?.trim() || env.LOK_CHAIN_RPC?.trim() || "").replace(/\/$/, "");
  const chainRaw = env.LOK_CHAIN_ID?.trim() ?? "";
  if (!isAddress(factory) || !isAddress(nft) || !rpcUrl || !chainRaw) return null;
  if (!/^https?:\/\//i.test(rpcUrl)) return null;
  if (!/^\d+$/.test(chainRaw)) return null;
  const chainId = Number(chainRaw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return { factory, nft, rpcUrl, chainId };
}

export type MintLog = { address: string; topics: string[]; data: string };

/**
 * Pure check of a confirmed factory mint. The caller supplies ownerOf.
 * The NFT id does not have to equal the log token id.
 */
export function assessCharacterMint(input: {
  wallet: string;
  job: number;
  factory: string;
  txFrom: string;
  txTo: string | null;
  status: "success" | "reverted";
  logs: MintLog[];
  owner: string;
}): { ok: true; tokenId: string } | { ok: false; error: string } {
  const wallet = input.wallet.toLowerCase();
  const factory = input.factory.toLowerCase();
  if (!isAddress(wallet) || !isAddress(factory)) {
    return { ok: false, error: "Character mint is not configured." };
  }
  if (!Number.isInteger(input.job) || input.job < 0 || input.job > 255) {
    return { ok: false, error: "That job cannot be minted." };
  }
  if (!input.txTo || input.txTo.toLowerCase() !== factory) {
    return { ok: false, error: "That transaction did not call the character factory." };
  }
  if (input.txFrom.toLowerCase() !== wallet) {
    return { ok: false, error: "That mint was not sent by your wallet." };
  }
  if (input.status !== "success") {
    return { ok: false, error: "Character mint transaction reverted. No character was created." };
  }
  const logs = input.logs.filter(
    (log) =>
      log.address.toLowerCase() === factory &&
      (log.topics[0] ?? "").toLowerCase() === CHARACTER_CREATED_TOPIC,
  );
  if (logs.length === 0) return { ok: false, error: "That transaction did not mint a character." };
  if (logs.length !== 1) return { ok: false, error: "That transaction minted more than one character." };
  const log = logs[0]!;
  let decoded: ReturnType<typeof decodeEventLog<typeof CHARACTER_CREATED_ABI>>;
  try {
    decoded = decodeEventLog({
      abi: CHARACTER_CREATED_ABI,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
    });
  } catch {
    return { ok: false, error: "Character mint log could not be read." };
  }
  if (decoded.eventName !== "CharacterCreated") {
    return { ok: false, error: "That transaction did not mint a character." };
  }
  const player = decoded.args.player.toLowerCase();
  const tokenId = decoded.args.tokenId;
  const job = Number(decoded.args.startingJob);
  if (player !== wallet) return { ok: false, error: "That mint was paid by a different wallet." };
  if (job !== input.job) return { ok: false, error: "That mint is for a different job." };
  if (tokenId <= 0n) return { ok: false, error: "Character mint returned an empty token id." };
  if (input.owner.toLowerCase() !== wallet) {
    return { ok: false, error: "That character NFT is not in your wallet." };
  }
  return { ok: true, tokenId: tokenId.toString() };
}

/** Read the mint transaction from the configured chain and check the NFT sits on the player. */
export async function confirmCharacterMint(
  input: { txHash: string; wallet: string; job: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; tokenId: string } | { ok: false; error: string }> {
  const cfg = characterMintClientConfig(env);
  if (!cfg) return { ok: false, error: "Character mint is not configured." };
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    return { ok: false, error: "Bad mint transaction." };
  }
  const serverRpc = (env.LOK_CHAIN_RPC?.trim() || cfg.rpcUrl).replace(/\/$/, "");
  try {
    const client = createPublicClient({ transport: http(serverRpc) });
    const chainId = await client.getChainId();
    if (chainId !== cfg.chainId) {
      return { ok: false, error: "Character mint chain does not match this server." };
    }
    const hash = input.txHash as Hex;
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash }),
      client.getTransactionReceipt({ hash }),
    ]);
    const minted = assessCharacterMint({
      wallet: input.wallet,
      job: input.job,
      factory: cfg.factory,
      txFrom: tx.from,
      txTo: tx.to,
      status: receipt.status,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
      owner: input.wallet,
    });
    if (!minted.ok) return minted;
    const owner = await client.readContract({
      address: cfg.nft as Hex,
      abi: OWNER_OF_ABI,
      functionName: "ownerOf",
      args: [BigInt(minted.tokenId)],
    });
    if (owner.toLowerCase() !== input.wallet.toLowerCase()) {
      return { ok: false, error: "That character NFT is not in your wallet." };
    }
    return minted;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/not found|could not be found/i.test(text)) {
      return { ok: false, error: "Mint transaction was not found on the character chain." };
    }
    return { ok: false, error: "Could not read the character mint from the chain." };
  }
}
