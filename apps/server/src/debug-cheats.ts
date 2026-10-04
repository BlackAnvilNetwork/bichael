/** Dev cheats are off unless this process was started with ALLOW_DEBUG_CHEATS=1. */
export function debugCheatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_DEBUG_CHEATS === "1";
}
