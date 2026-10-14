import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PVP_BOUNTY_WEI } from "@bellgrave/config";
import { LokWorld } from "./lok-world";
import { syntheticPvpReceipt } from "./pvp";

describe("pvp ledger mirrors", () => {
  it("opens, cancels, and kills on the lok log", () => {
    const dir = mkdtempSync(join(tmpdir(), "lok-pvp-"));
    try {
      const lok = LokWorld.open(dir, undefined, { NETWORK: "anvil" });
      const a = lok.spawn("char-a", "Alpha", 0, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const b = lok.spawn("char-b", "Bravo", 1, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      assert.ok(a.ok && b.ok);
      const tokenA = lok.tokenFor("char-a")!;
      const tokenB = lok.tokenFor("char-b")!;

      const openRx = syntheticPvpReceipt(`t-open:${tokenA}`);
      const opened = lok.pvpBountyOpen(tokenA, PVP_BOUNTY_WEI, "ash_pit", openRx.txHash, openRx.logIndex);
      assert.equal(opened.ok, true, opened.ok ? undefined : opened.error);
      assert.equal(lok.hasPvpBounty(tokenA), true);
      assert.equal(lok.pvpBountyOf(tokenA)?.areaId, "ash_pit");

      const openB = syntheticPvpReceipt(`t-open:${tokenB}`);
      assert.equal(
        lok.pvpBountyOpen(tokenB, PVP_BOUNTY_WEI, "ash_pit", openB.txHash, openB.logIndex).ok,
        true,
      );

      const killRx = syntheticPvpReceipt(`t-kill:${tokenB}`);
      const killed = lok.pvpKill(
        tokenB,
        tokenA,
        "ash_pit",
        PVP_BOUNTY_WEI,
        killRx.txHash,
        killRx.logIndex,
      );
      assert.equal(killed.ok, true, killed.ok ? undefined : killed.error);
      assert.equal(lok.hasPvpBounty(tokenB), false);
      assert.equal(lok.hasPvpBounty(tokenA), true);

      const cancelRx = syntheticPvpReceipt(`t-cancel:${tokenA}`);
      assert.equal(
        lok.pvpBountyCancel(tokenA, "ash_pit", cancelRx.txHash, cancelRx.logIndex).ok,
        true,
      );
      assert.equal(lok.hasPvpBounty(tokenA), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
