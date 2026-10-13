/**
 * #55 — magic damage taken (Shell / Asylum / Fealty / Mana Wall / tree magDt)
 * applies to magic pending hits; physical hits keep phys DT.
 * Pure helpers only; no server boot, no data dir.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASYLUM_MAG_MUL,
  DT_FLOOR,
  FEALTY_MAG_MUL,
  MANA_WALL_MAG_MUL,
  pendingHitDtMul,
  physDtMul,
  playerMagDtMul,
} from "./incoming-dt";
import { tryMobJobAbility, type MobJobCombatant } from "./mob-job-ai";

const NOW = 1_000_000;
const LATER = NOW + 60_000;
const RAW = 200;

function bare() {
  return {
    bulwarkUntil: 0,
    sentinelUntil: 0,
    coverUntil: 0,
    rampartUntil: 0,
    guardianUntil: 0,
    protectUntil: 0,
    protectPhysMul: 1,
    phalanxUntil: 0,
    phalanxPhysMul: 1,
    asylumUntil: 0,
    fealtyUntil: 0,
    shellUntil: 0,
    shellMagMul: 1,
    manaWallUntil: 0,
  };
}

const noTree = { physDt: 0, magDt: 0 };
/** Same flooring as applyPendingMobDamage. */
const hit = (mul: number) => Math.max(0, Math.floor(RAW * mul));

test("bare target takes full magic and physical damage", () => {
  const p = bare();
  assert.equal(pendingHitDtMul(p, NOW, true, noTree), 1);
  assert.equal(pendingHitDtMul(p, NOW, false, noTree), 1);
});

test("Shell reduces magic pending damage vs bare", () => {
  const p = { ...bare(), shellUntil: LATER, shellMagMul: 0.88 };
  const mul = pendingHitDtMul(p, NOW, true, noTree);
  assert.equal(mul, 0.88);
  assert.ok(hit(mul) < hit(pendingHitDtMul(bare(), NOW, true, noTree)));
  assert.equal(hit(mul), 176);
});

test("expired Shell no longer reduces magic damage", () => {
  const p = { ...bare(), shellUntil: NOW - 1, shellMagMul: 0.88 };
  assert.equal(pendingHitDtMul(p, NOW, true, noTree), 1);
});

test("Asylum, Fealty and Mana Wall each reduce magic damage", () => {
  assert.equal(playerMagDtMul({ ...bare(), asylumUntil: LATER }, NOW, 0), ASYLUM_MAG_MUL);
  assert.equal(playerMagDtMul({ ...bare(), fealtyUntil: LATER }, NOW, 0), FEALTY_MAG_MUL);
  assert.equal(playerMagDtMul({ ...bare(), manaWallUntil: LATER }, NOW, 0), MANA_WALL_MAG_MUL);
  for (const k of ["asylumUntil", "fealtyUntil", "manaWallUntil"] as const) {
    const p = { ...bare(), [k]: LATER };
    assert.ok(hit(pendingHitDtMul(p, NOW, true, noTree)) < RAW, k);
  }
});

test("stacked magic wards keep helping down to the soft floor", () => {
  const shell = { ...bare(), shellUntil: LATER, shellMagMul: 0.88 };
  const shellAsylum = { ...shell, asylumUntil: LATER };
  assert.ok(playerMagDtMul(shellAsylum, NOW, 0) < playerMagDtMul(shell, NOW, 0));
  const all = { ...shellAsylum, fealtyUntil: LATER, manaWallUntil: LATER };
  // 0.88 * 0.7 * 0.5 * 0.55 — still above the floor, still lower than fewer wards.
  assert.ok(Math.abs(playerMagDtMul(all, NOW, 0) - 0.1694) < 1e-9);
  // Shellra (0.75) + everything dips under 0.15 and clamps to the floor.
  assert.equal(playerMagDtMul({ ...all, shellMagMul: 0.75 }, NOW, 0), DT_FLOOR);
});

test("skill-tree magDt (Veil) reduces magic damage", () => {
  const p = bare();
  // Five Veil nodes at +0.012 magDt each.
  const mul = pendingHitDtMul(p, NOW, true, { physDt: 0, magDt: 0.012 * 5 });
  assert.ok(Math.abs(mul - 0.94) < 1e-9);
  assert.ok(hit(mul) < RAW);
  // Tree magDt never leaks into physical hits.
  assert.equal(pendingHitDtMul(p, NOW, false, { physDt: 0, magDt: 0.06 }), 1);
});

test("physical hits use phys DT (Protect), not mag DT", () => {
  const protect = { ...bare(), protectUntil: LATER, protectPhysMul: 0.88 };
  assert.equal(pendingHitDtMul(protect, NOW, false, noTree), 0.88);
  assert.equal(physDtMul(protect, NOW, 0), 0.88);
  // Protect does nothing vs magic.
  assert.equal(pendingHitDtMul(protect, NOW, true, noTree), 1);

  const shelled = { ...bare(), shellUntil: LATER, shellMagMul: 0.75, asylumUntil: LATER, fealtyUntil: LATER };
  // Shell / Asylum / Fealty do nothing vs physical.
  assert.equal(pendingHitDtMul(shelled, NOW, false, noTree), 1);
  // Bulwark is physical-only immunity.
  const bulwark = { ...bare(), bulwarkUntil: LATER };
  assert.equal(pendingHitDtMul(bulwark, NOW, false, noTree), 0);
  assert.equal(pendingHitDtMul(bulwark, NOW, true, noTree), 1);
});

test("mob magic bolt pending hit is flagged magic", () => {
  const mob: MobJobCombatant = {
    id: "m1",
    name: "Ash Adept",
    x: 0,
    z: 0,
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    job: "sorcerer",
    level: 10,
    archetype: "test",
    anim: "idle",
    animUntil: 0,
    nextSwingAt: 0,
    nextAbilityAt: 0,
    atkBuffUntil: 0,
    atkBuffMul: 1,
    atkDownUntil: 0,
    atkDownMul: 1,
    addleUntil: 0,
    silenceUntil: 0,
    slowUntil: 0,
    swingPenalty: 0,
  };
  const player = {
    wallet: "0xp",
    x: 3,
    z: 0,
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    slowUntil: 0,
    moveUntil: 0,
    movePct: 0,
    blindUntil: 0,
  };
  const orig = Math.random;
  Math.random = () => 0;
  try {
    const res = tryMobJobAbility(mob, {
      now: NOW,
      dist: 3,
      player,
      vitals: { vit: 10, agi: 10 },
      pushLog: () => {},
      applyPlayerDamage: () => assert.fail("bolt must not resolve immediately"),
    });
    assert.equal(res.ok, true);
    assert.ok(res.ok && res.pending);
    assert.equal(res.ok && res.pending?.type, "damage");
    assert.equal(res.ok && res.pending && "magic" in res.pending && res.pending.magic, true);
  } finally {
    Math.random = orig;
  }
});
