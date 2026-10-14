/**
 * Client-signed AhEscrow.buyAsk — pays native settlement value from the browser
 * wallet (injected EIP-1193 when available, else Reown AppKit). Never falls back
 * to the localStorage burner for pay on Gnosis/Chiado (or whenever AppKit is configured).
 *
 * EEZ / local mock sync buy: see eez-sync-buy.ts + docs/eez-sync-buy.md.
 */
import { settlementCurrency } from "@bellgrave/config";
import { createPublicClient, http, type Hex } from "viem";
import type { AhEscrowClientConfig } from "@bellgrave/protocol";
import { appKitConfigured } from "./appkit";
import { burnerIdentityAllowed } from "./burner-identity";
import { assertPayAddress, payRpcUrl } from "./pay-trust";
import { hasInjectedWallet, payWalletSessionOpts } from "./pay-wallet";
import { getWalletSession, type WalletSession } from "./wallet";

const BUY_ASK_ABI = [
  {
    type: "function",
    name: "buyAsk",
    stateMutability: "payable",
    inputs: [
      { name: "listingId", type: "uint256" },
      { name: "buyerTokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export type BuyAskFill = {
  listingId: string;
  priceWei: string;
};

export type PayWalletFlags = {
  hasInjected: boolean;
  appKitConfigured: boolean;
  burnerAllowed?: boolean;
};

export async function buyAsksWithWallet(opts: {
  escrow: AhEscrowClientConfig;
  buyerTokenId: string;
  fills: BuyAskFill[];
  /** Test seam */
  getSession?: typeof getWalletSession;
  /** Test seam — override injected/AppKit/burner detection */
  forceWalletFlags?: PayWalletFlags;
}): Promise<{ ok: true; hashes: Hex[] } | { ok: false; error: string; hashes: Hex[] }> {
  if (!opts.fills.length) return { ok: false, error: "No asks to buy.", hashes: [] };
  if (!/^[1-9][0-9]{0,77}$/.test(opts.buyerTokenId)) {
    return { ok: false, error: "Bad buyer character id.", hashes: [] };
  }
  const pinned = assertPayAddress("escrow", opts.escrow.address);
  if (!pinned.ok) return { ok: false, error: pinned.error, hashes: [] };
  const rpcUrl = payRpcUrl(opts.escrow.chainId, opts.escrow.rpcUrl);
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
      rpcUrl,
      allowBurnerFallback: sessionOpts.allowBurnerFallback,
      preferWalletConnect: sessionOpts.preferWalletConnect,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hashes: [],
    };
  }
  if (session.source === "burner" && !burnerAllowed) {
    return {
      ok: false,
      error: "Refusing to pay with local burner on this network. Connect a wallet.",
      hashes: [],
    };
  }
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const hashes: Hex[] = [];
  for (const fill of opts.fills) {
    if (!/^[1-9][0-9]{0,77}$/.test(fill.listingId)) {
      return { ok: false, error: "Bad listing id.", hashes };
    }
    let value: bigint;
    try {
      value = BigInt(fill.priceWei);
    } catch {
      return { ok: false, error: "Bad ask price.", hashes };
    }
    if (value <= 0n) return { ok: false, error: "Ask price must be greater than 0.", hashes };
    try {
      const hash = await session.client.writeContract({
        address: opts.escrow.address as `0x${string}`,
        abi: BUY_ASK_ABI,
        functionName: "buyAsk",
        args: [BigInt(fill.listingId), BigInt(opts.buyerTokenId)],
        value,
        account: session.account,
        chain: (() => {
          const cur = settlementCurrency(opts.escrow.chainId);
          return {
            id: opts.escrow.chainId,
            name: cur.name,
            nativeCurrency: { name: cur.name, symbol: cur.symbol, decimals: cur.decimals },
            rpcUrls: { default: { http: [rpcUrl] } },
          };
        })(),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        return {
          ok: false,
          error: hashes.length
            ? "Paid " + hashes.length + " ask(s), then a buy reverted on-chain."
            : "Buy transaction reverted.",
          hashes,
        };
      }
      hashes.push(hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: hashes.length
          ? "Paid " + hashes.length + " ask(s), then failed: " + msg
          : "Buy failed: " + msg,
        hashes,
      };
    }
  }
  return { ok: true, hashes };
}
