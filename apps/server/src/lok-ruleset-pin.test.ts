import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { defaultWasmPath } from "./lok-engine";
import { LOCAL_RULESET_HASH, LOCAL_RULESET_WASM_SHA256 } from "./lok-vault";

test("the checked-in engine wasm is the bundle pinned to the local ruleset", () => {
  assert.match(LOCAL_RULESET_HASH, /^0x[0-9a-f]{64}$/);
  assert.match(LOCAL_RULESET_WASM_SHA256, /^[0-9a-f]{64}$/, "LOCAL_RULESET_WASM_SHA256 must be a sha256 hex digest");
  const actual = createHash("sha256").update(readFileSync(defaultWasmPath())).digest("hex");
  assert.equal(
    actual,
    LOCAL_RULESET_WASM_SHA256,
    "pkg/lok_engine.wasm does not match LOCAL_RULESET_WASM_SHA256. Rebuild with " +
      "contracts/lok-log/engine/scripts/check-wasm-pin.mjs, then update the pin (and propose a new ruleset off-local).",
  );
});
