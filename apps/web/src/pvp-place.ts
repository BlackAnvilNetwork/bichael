/**
 * Client-signed PvpBounty.place — pays 1 xDAI (1e18 wei) from the browser wallet
 * (injected EIP-1193 when available, else Reown AppKit; burner OK on anvil).
 */
import { settlementCurrency } from "@bellgrave/config";
import { createPublicClient, http, type Hex } from "viem";
import type { PvpBountyClientConfig } from "@bellgrave/protocol";
import { appKitConfigured } from "./appkit";
import { burnerIdentityAllowed } from "./burner-identity";
import { hasInjectedWallet, payWalletSessionOpts } from "./pay-wallet";
import { getWalletSession, type WalletSession } from "./wallet";

export type PayWalletFlags = {
  hasInjected: boolean;
  appKitConfigured: boolean;
  burnerAllowed?: boolean;
};

const PLACE_ABI = [
  {
    type: "function",
    name: "place",
    stateMutability: "payable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
] as const;

export async function placePvpBountyWithWallet(opts: {
  escrow: PvpBountyClientConfig;
  tokenId: string;
  /** Test seam */
  getSession?: typeof getWalletSession;
  /** Test seam — override injected/AppKit/burner detection */
  forceWalletFlags?: PayWalletFlags;
}): Promise<{ ok: true; hash: Hex } | { ok: false; error: string }> {
  if (!/^[1-9][0-9]{0,77}$/.test(opts.tokenId)) {
    return { ok: false, error: "Bad character id." };
  }
  if (!opts.escrow.address || !/^0x[0-9a-fA-F]{40}$/.test(opts.escrow.address)) {
    return { ok: false, error: "PvpBounty is not configured." };
  }
  if (opts.escrow.synthetic) {
    return { ok: false, error: "Synthetic escrow — Join without a place tx." };
  }
  let value: bigint;
  try {
    value = BigInt(opts.escrow.bountyWei);
  } catch {
    return { ok: false, error: "Bad bounty amount." };
  }
  if (value <= 0n) return { ok: false, error: "Bounty must be greater than 0." };

  const flags: PayWalletFlags =
    opts.forceWalletFlags ??
    {
      hasInjected: hasInjectedWallet(),
      appKitConfigured: appKitConfigured(),
      burnerAllowed: burnerIdentityAllowed(),
    };
  const burnerAllowed = flags.burnerAllowed ?? burnerIdentityAllowed();
  const sessionOpts = payWalletSessionOpts({
    hasInjected: flags.hasInjected,
    appKitConfigured: flags.appKitConfigured,
    burnerAllowed,
  });
  let session: WalletSession;
  try {
    session = await (opts.getSession ?? getWalletSession)({
      chainId: opts.escrow.chainId,
      rpcUrl: opts.escrow.rpcUrl,
      allowBurnerFallback: sessionOpts.allowBurnerFallback,
      preferWalletConnect: sessionOpts.preferWalletConnect,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (session.source === "burner" && !burnerAllowed) {
    return {
      ok: false,
      error: "Refusing to pay with local burner on this network. Connect a wallet.",
    };
  }

  const chainId = opts.escrow.chainId;
  const rpcUrl = opts.escrow.rpcUrl;
  const cur = settlementCurrency(chainId);
  const chain = {
    id: chainId,
    name: cur.name,
    nativeCurrency: { name: cur.name, symbol: cur.symbol, decimals: cur.decimals },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  try {
    const hash = await session.client.writeContract({
      address: opts.escrow.address as `0x${string}`,
      abi: PLACE_ABI,
      functionName: "place",
      args: [BigInt(opts.tokenId)],
      value,
      account: session.account,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      return { ok: false, error: "PvpBounty.place reverted." };
    }
    return { ok: true, hash };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
