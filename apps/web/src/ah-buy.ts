/**
 * Client-signed AhEscrow.buyAsk — pays ETH from the local browser wallet.
 * The server watches AskFilled and mirrors items via chainFill; this never
 * credits ETH onto the character log.
 */
import { createWalletClient, type Chain, type Hex } from "viem";
import type { AhEscrowClientConfig } from "@bellgrave/protocol";
import { injectedTransport, linkedWallet } from "./wallet";

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

function chainOf(cfg: AhEscrowClientConfig): Chain {
  return {
    id: cfg.chainId,
    name: cfg.chainId === 31337 ? "Bellgrave Anvil" : "Bellgrave",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
}

export type BuyAskFill = {
  listingId: string;
  priceWei: string;
};

export async function buyAsksWithWallet(opts: {
  escrow: AhEscrowClientConfig;
  buyerTokenId: string;
  fills: BuyAskFill[];
}): Promise<{ ok: true; hashes: Hex[] } | { ok: false; error: string; hashes: Hex[] }> {
  if (!opts.fills.length) return { ok: false, error: "No asks to buy.", hashes: [] };
  if (!/^[1-9][0-9]{0,77}$/.test(opts.buyerTokenId)) {
    return { ok: false, error: "Bad buyer character id.", hashes: [] };
  }
  const address = linkedWallet();
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { ok: false, error: "Connect your wallet first.", hashes: [] };
  }
  const transport = injectedTransport();
  if (!transport) return { ok: false, error: "Connect your wallet first.", hashes: [] };
  const chain = chainOf(opts.escrow);
  const client = createWalletClient({
    account: address as `0x${string}`,
    chain,
    transport,
  });
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
      const hash = await client.writeContract({
        address: opts.escrow.address as `0x${string}`,
        abi: BUY_ASK_ABI,
        functionName: "buyAsk",
        args: [BigInt(fill.listingId), BigInt(opts.buyerTokenId)],
        value,
        chain,
        account: address as `0x${string}`,
      });
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
