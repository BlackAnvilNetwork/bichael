import assert from "node:assert/strict";
import test from "node:test";
import { debugCheatsEnabled } from "./debug-cheats";

test("debug cheats are opt-in", () => {
  assert.equal(debugCheatsEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(debugCheatsEnabled({ NODE_ENV: "development" } as NodeJS.ProcessEnv), false);
  assert.equal(debugCheatsEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
  assert.equal(debugCheatsEnabled({ ALLOW_DEBUG_CHEATS: "1", NODE_ENV: "production" } as NodeJS.ProcessEnv), true);
  assert.equal(debugCheatsEnabled({ ALLOW_DEBUG_CHEATS: "0" } as NodeJS.ProcessEnv), false);
});

test("debug cheats refuse production settlement chains (#269)", () => {
  assert.equal(
    debugCheatsEnabled({
      ALLOW_DEBUG_CHEATS: "1",
      NETWORK: "gnosis",
      LOK_CHAIN_ID: "100",
    } as NodeJS.ProcessEnv),
    false,
  );
  assert.equal(
    debugCheatsEnabled({
      ALLOW_DEBUG_CHEATS: "1",
      NETWORK: "chiado",
      LOK_CHAIN_ID: "10200",
    } as NodeJS.ProcessEnv),
    false,
  );
});
