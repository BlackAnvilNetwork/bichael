/**
 * The auction fee stays 1%. Half is the guild-vault share and half is the
 * treasury share, and those two amounts sum to the fee. A change waits one day.
 * The 20 Hz tick does not wait. In-game gold is outside this fee.
 * There is no score and no combat bonus.
 */
import {
  AH_FEE_BPS,
  AH_TREASURY_FEE_BPS,
  AH_VAULT_FEE_BPS,
  ahGuildFeeShares,
} from "@bellgrave/protocol";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { meleeAtkBonus, withGearMab } from "./gear-combat";
import { incomingMagicDamage } from "./incoming-dt";
import { LOCAL_RULESET_WASM_SHA256 } from "./lok-vault";
import { LokWorld } from "./lok-world";
import { submitOnSimTick } from "./order-submit";
import { epochSettledXdai, resetRootAnchorForTests } from "./root-anchor";

const ESCROW_SOL = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../contracts/lok-log/src/AhEscrow.sol",
);

function root(fill: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(fill);
  return out;
}

describe("guild vault fee split", { concurrency: false }, () => {
  test("the two shares sum to the 1% fee and a change waits one day", () => {
    resetRootAnchorForTests();
    try {
      const sol = readFileSync(ESCROW_SOL, "utf8");
      assert.equal(AH_FEE_BPS, 100);
      assert.equal(AH_VAULT_FEE_BPS, 50);
      assert.equal(AH_TREASURY_FEE_BPS, 50);
      assert.equal(AH_VAULT_FEE_BPS + AH_TREASURY_FEE_BPS, AH_FEE_BPS);
      assert.match(sol, /uint256 public constant FEE_BPS = 100;/);
      assert.match(sol, /uint64 public constant SHARE_DELAY = 1 days;/);
      assert.match(sol, /function proposeFeeShares/);
      assert.match(sol, /function executeFeeShares/);
      assert.equal(sol.includes("function setFeeShares"), false);
      assert.equal(sol.includes("function score"), false);
      assert.equal(sol.includes("goldEarn"), false);
      assert.equal(
        LOCAL_RULESET_WASM_SHA256,
        "4d2610aa110a9f6bb163934d29a6ca7410b98530d59a700d8cd1b66cc5804178",
      );

      const shares = ahGuildFeeShares(10_000n);
      assert.deepEqual(shares, { feeWei: 100n, vaultWei: 50n, treasuryWei: 50n });
      assert.equal(epochSettledXdai(), 0n);
      assert.deepEqual(ahGuildFeeShares(0n), { feeWei: 0n, vaultWei: 0n, treasuryWei: 0n });
    } finally {
      resetRootAnchorForTests();
    }
  });

  test("quoting the split does not wait on the tick, touch gold, or add a combat bonus", async () => {
    resetRootAnchorForTests();
    const calls: string[] = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      calls.push(typeof init?.body === "string" ? init.body : "");
      return new Response("refused", { status: 500 });
    }) as typeof fetch;
    try {
      const dir = mkdtempSync(join(tmpdir(), "lok-guild-vault-"));
      const lok = LokWorld.open(dir, undefined, {});
      const spawned = lok.spawn("char-a", "Ada", 0);
      assert.equal(spawned.ok, true);
      if (!spawned.ok) return;
      assert.equal(lok.goldEarn(spawned.tokenId, "quest", "100", 1).ok, true);
      const gold = lok.goldOf(spawned.tokenId);
      assert.equal(gold, "100");

      const sheet = { level: 20 };
      const melee = meleeAtkBonus(sheet);
      const spell = withGearMab(sheet, 40);
      const incoming = incomingMagicDamage(50, 10, 1);

      const shares = ahGuildFeeShares(200n);
      assert.deepEqual(shares, { feeWei: 2n, vaultWei: 1n, treasuryWei: 1n });
      const tick = submitOnSimTick(null, { ok: true, height: 9, nextRoot: root(0x41) });
      assert.equal(tick.tickFailed, false);
      assert.equal(tick.status, "provisional");
      assert.equal(tick.blob, null);

      assert.equal(lok.goldOf(spawned.tokenId), gold);
      assert.equal(meleeAtkBonus(sheet), melee);
      assert.equal(melee, 0);
      assert.equal(withGearMab(sheet, 40), spell);
      assert.equal(spell, 40);
      assert.equal(incomingMagicDamage(50, 10, 1), incoming);
      assert.equal(epochSettledXdai(), 0n);
      assert.equal(calls.length, 0);
    } finally {
      globalThis.fetch = prev;
      resetRootAnchorForTests();
    }
  });
});
