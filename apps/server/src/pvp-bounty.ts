/**
 * PvpBounty escrow address + synthetic receipt gate.
 * When `LOK_PVP_BOUNTY` is set (anvil deploy / Gnosis), join requires a real place tx.
 * OPERATOR claim/cancel uses LOK_LISTING_KEY (anvil K0 filled by settlement-deploy).
 */

import type { PvpBountyClientConfig } from "@bellgrave/protocol";
import { envSettlementChainId } from "./settlement-chain";

export function pvpBountyAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const addr = env.LOK_PVP_BOUNTY?.trim();
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr.toLowerCase() : null;
}

/**
 * Synthetic receipts only when explicitly enabled.
 * When `LOK_PVP_BOUNTY` is set, real escrow is required (default).
 */
export function pvpSyntheticReceiptsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LOK_PVP_SYNTHETIC?.trim() === "1") return true;
  if (env.LOK_PVP_SYNTHETIC?.trim() === "0") return false;
  // Real contract wired → never invent receipts.
  if (pvpBountyAddress(env)) return false;
  const chainId = envSettlementChainId(env);
  // Engine-only local without a deploy file may still use synthetic.
  return chainId === 31337 || chainId === 0;
}

export function pvpBountyClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): PvpBountyClientConfig | null {
  const address = pvpBountyAddress(env);
  const synthetic = pvpSyntheticReceiptsAllowed(env);
  if (!address && !synthetic) return null;
  const rpcUrl = (env.LOK_PUBLIC_RPC?.trim() || env.LOK_CHAIN_RPC?.trim() || "").replace(/\/$/, "");
  const chainId = envSettlementChainId(env);
  return {
    address: address ?? "0x0000000000000000000000000000000000000000",
    bountyWei: "1000000000000000000",
    synthetic,
    rpcUrl: rpcUrl || "http://127.0.0.1:8545",
    chainId,
  };
}
