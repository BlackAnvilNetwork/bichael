import { isProductionSettlementChain } from "./production-boot";

/**
 * Dev cheats are off unless ALLOW_DEBUG_CHEATS=1.
 * #269: never arm on Gnosis/Chiado production settlement chains.
 */
export function debugCheatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ALLOW_DEBUG_CHEATS !== "1") return false;
  if (isProductionSettlementChain(env)) return false;
  return true;
}
