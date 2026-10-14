/**
 * PvpBounty escrow address + anvil-only synthetic receipt gate.
 * Live claim/watcher is operator-side (LISTING key); local play uses synthetic mirrors.
 */

import { envSettlementChainId } from "./settlement-chain";

export function pvpBountyAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const addr = env.LOK_PVP_BOUNTY?.trim();
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr.toLowerCase() : null;
}

/** True when synthetic escrow receipts are allowed (anvil / unset chain only). */
export function pvpSyntheticReceiptsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LOK_PVP_SYNTHETIC?.trim() === "0") return false;
  if (env.LOK_PVP_SYNTHETIC?.trim() === "1") return true;
  const chainId = envSettlementChainId(env);
  // Local anvil (31337) or no settlement chain — never Gnosis/Chiado.
  return chainId === 31337 || chainId === 0;
}

export function pvpBountyClientConfig(env: NodeJS.ProcessEnv = process.env): {
  address: string;
  bountyWei: string;
  synthetic: boolean;
} | null {
  const address = pvpBountyAddress(env);
  const synthetic = pvpSyntheticReceiptsAllowed(env);
  if (!address && !synthetic) return null;
  return {
    address: address ?? "0x0000000000000000000000000000000000000000",
    bountyWei: "1000000000000000000",
    synthetic,
  };
}
