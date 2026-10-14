/**
 * Parallel forge --broadcast must not collide on the shared recovery cache.
 * Regression for CI flake: run-latest.json.recovery.json "another process is already modifying".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deployAhEscrowFixture,
  startThrowawayAnvil,
  supportAnvilAvailable,
} from "./support-anvil";

describe("support-anvil forge cache isolation", { skip: !supportAnvilAvailable }, () => {
  it("two parallel AhEscrowFixture broadcasts do not collide on recovery cache", async () => {
    const a = await startThrowawayAnvil();
    const b = await startThrowawayAnvil();
    try {
      // Previously failed with: another process is already modifying …recovery.json
      // (shared contracts/lok-log/cache). Fresh anvils often share CREATE addresses — that is fine.
      const [escrowA, escrowB] = await Promise.all([
        Promise.resolve().then(() => deployAhEscrowFixture(a.rpc)),
        Promise.resolve().then(() => deployAhEscrowFixture(b.rpc)),
      ]);
      assert.match(escrowA, /^0x[a-fA-F0-9]{40}$/);
      assert.match(escrowB, /^0x[a-fA-F0-9]{40}$/);
    } finally {
      a.stop();
      b.stop();
    }
  });
});
