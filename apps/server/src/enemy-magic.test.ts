/**
 * #81 — damage interrupts an enemy cast, incoming magic consults resistance,
 * casters pick a target, and sorcerers can splash with Cinder Burst.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAGIC_RESIST_FLOOR,
  magicDefenseFromMnd,
  magicResistMul,
  mitigateMagicDamage,
  playerMagicDefense,
} from "@bellgrave/combat";
import { gearMdb } from "./gear-combat";
import { resetGameRollForTests, scriptNextRollsForTests } from "./game-roll";
import { incomingMagicDamage } from "./incoming-dt";
import {
  CAST_INTERRUPT_RECOVERY_MS,
  interruptCastOnDamage,
  type CastWindup,
} from "./mob-cast-interrupt";
import { emptyMobEnhances, takeMobHit } from "./mob-enhances";
import {
  CASTER_BACKLINE_BONUS,
  CASTER_FOCUS_STICK,
  CASTER_HATE_WEIGHT,
  CASTER_TANK_PENALTY,
  CASTER_WOUND_WEIGHT,
  MELEE_FOCUS_STICK,
  MELEE_HATE_WEIGHT,
  MOB_CINDER_RADIUS,
  mobFocusScore,
  mobMagicDefense,
  pickMobFocus,
  tryMobJobAbility,
  type MobFocusCandidate,
  type MobJobCombatant,
} from "./mob-job-ai";

const NOW = 1_000_000;

function windup(over: Partial<CastWindup> = {}): CastWindup {
  return {
    pendingCastHitAt: NOW + 400,
    pendingCastTarget: "0xmage",
    pendingCastKind: "damage",
    pendingCastDmg: 40,
    pendingCastLog: "casts Ember Lance",
    pendingCastSlowMs: 0,
    pendingCastMovePct: 0,
    pendingCastMagic: true,
    pendingCastAoe: 0,
    nextSwingAt: NOW,
    anim: "cast",
    interruptShout: "",
    interruptShoutTo: null,
    ...over,
  };
}

function sorcerer(over: Partial<MobJobCombatant> = {}): MobJobCombatant {
  return {
    id: "m1",
    name: "Ash Adept",
    x: 0,
    z: 0,
    hp: 50,
    maxHp: 100,
    mp: 40,
    maxMp: 40,
    job: "sorcerer",
    level: 12,
    archetype: "test",
    anim: "idle",
    animUntil: 0,
    nextSwingAt: 0,
    nextAbilityAt: 0,
    atkBuffUntil: 0,
    atkBuffMul: 1,
    shellUntil: NOW + 60_000,
    shellMagMul: 0.75,
    atkDownUntil: 0,
    atkDownMul: 1,
    addleUntil: 0,
    silenceUntil: 0,
    slowUntil: 0,
    swingPenalty: 0,
    ...over,
  };
}

const player = {
  wallet: "0xp",
  x: 4,
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

test("damage during wind-up cancels the cast and delays the next swing", () => {
  const mob = windup();
  assert.equal(interruptCastOnDamage(mob, NOW, 12), true);
  assert.equal(mob.pendingCastHitAt, 0);
  assert.equal(mob.pendingCastTarget, null);
  assert.equal(mob.pendingCastKind, "");
  assert.equal(mob.pendingCastDmg, 0);
  assert.equal(mob.pendingCastMagic, false);
  assert.equal(mob.pendingCastAoe, 0);
  assert.equal(mob.anim, "idle");
  assert.equal(mob.nextSwingAt, NOW + CAST_INTERRUPT_RECOVERY_MS);
  assert.equal(mob.interruptShoutTo, "0xmage");
  assert.match(mob.interruptShout ?? "", /unravels/);
});

test("a hit after the wind-up, or a zero-damage hit, does not cancel the cast", () => {
  const due = windup({ pendingCastHitAt: NOW });
  assert.equal(interruptCastOnDamage(due, NOW, 20), false);
  assert.equal(due.pendingCastHitAt, NOW);
  assert.equal(due.anim, "cast");

  const soaked = windup();
  assert.equal(interruptCastOnDamage(soaked, NOW, 0), false);
  assert.equal(soaked.pendingCastKind, "damage");
  assert.equal(soaked.anim, "cast");
});

test("takeMobHit damage interrupts a winding cast; a fully soaked blow does not", () => {
  const casting = {
    ...emptyMobEnhances(),
    ...windup(),
  };
  const dealt = takeMobHit(casting, 30, "physical", NOW);
  assert.equal(dealt, 30);
  assert.equal(casting.pendingCastHitAt, 0);
  assert.equal(casting.anim, "idle");

  const skinned = {
    ...emptyMobEnhances(),
    ...windup(),
    stoneskinUntil: NOW + 5_000,
    stoneskinAbsorb: 80,
  };
  assert.equal(takeMobHit(skinned, 20, "magic", NOW), 0);
  assert.equal(skinned.pendingCastHitAt, NOW + 400);
  assert.equal(skinned.anim, "cast");
});

test("magic resistance and mitigation reduce incoming magic and leave a floor", () => {
  assert.equal(magicDefenseFromMnd(10), 12);
  assert.equal(magicDefenseFromMnd(0), 0);
  assert.equal(playerMagicDefense(10, 8), 20);
  assert.equal(playerMagicDefense(10, Number.NaN), 12);
  assert.equal(magicResistMul(0), 1);
  assert.equal(magicResistMul(Number.NaN), 1);
  // 20 defense shaves 20/200.
  assert.ok(Math.abs(magicResistMul(20) - 0.9) < 1e-9);
  assert.equal(mitigateMagicDamage(100, 0), 100);
  assert.equal(mitigateMagicDamage(100, 20), 90);
  assert.equal(mitigateMagicDamage(100, 10_000), Math.floor(100 * MAGIC_RESIST_FLOOR));
  assert.equal(mitigateMagicDamage(1, 10_000), 1);
  assert.equal(mitigateMagicDamage(0, 20), 0);

  const raw = 200;
  const bare = incomingMagicDamage(raw, 0, 1);
  const resisted = incomingMagicDamage(raw, 20, 1);
  const resistedAndShell = incomingMagicDamage(raw, 20, 0.75);
  assert.equal(bare, 200);
  assert.equal(resisted, 180);
  assert.ok(resistedAndShell < resisted);
  assert.equal(resistedAndShell, 135);
  // Physical DT is not this function. Callers pass mag DT only for magic hits.
  assert.equal(incomingMagicDamage(raw, 0, 0.88), 176);
  assert.equal(gearMdb({ equip: {} }), 0);
});

test("takeMobHit consults magResist for magic and not for physical, then Shell", () => {
  const host = { ...emptyMobEnhances(), magResist: 20 };
  assert.equal(takeMobHit(host, 100, "physical", NOW), 100);
  assert.equal(takeMobHit({ ...host }, 100, "magic", NOW), 90);

  const shelled = { ...host, shellUntil: NOW + 1, shellMagMul: 0.75 };
  assert.equal(takeMobHit(shelled, 100, "magic", NOW), 67);
  assert.equal(takeMobHit(shelled, 100, "physical", NOW), 100);
});

test("cleric mobs resist magic more than fighters of the same level", () => {
  assert.ok(mobMagicDefense("cleric", 30) > mobMagicDefense("fighter", 30));
  assert.ok(mobMagicDefense("sorcerer", 30) > mobMagicDefense("fighter", 30));
});

function candidate(over: Partial<MobFocusCandidate> & Pick<MobFocusCandidate, "id">): MobFocusCandidate {
  return {
    x: 5,
    z: 0,
    hp: 100,
    maxHp: 100,
    enmity: 0,
    job: "fighter",
    ...over,
  };
}

test("casters prefer a wounded backliner; a high-enmity tank still holds", () => {
  const mob = { x: 0, z: 0, job: "sorcerer" as const, targetId: "tank" };
  const tank = candidate({ id: "tank", x: 5, job: "knight", enmity: 80, hp: 100 });
  const cleric = candidate({ id: "heal", x: 5.5, job: "cleric", enmity: 20, hp: 40, maxHp: 100 });
  assert.ok(mobFocusScore(mob, cleric) > mobFocusScore(mob, tank));
  assert.equal(pickMobFocus(mob, [tank, cleric])?.id, "heal");

  const provoked = candidate({ id: "tank", x: 4, job: "knight", enmity: 2000, hp: 100 });
  const wounded = candidate({ id: "heal", x: 4, job: "cleric", enmity: 0, hp: 20, maxHp: 100 });
  assert.ok(mobFocusScore(mob, provoked) > mobFocusScore(mob, wounded));
  assert.equal(pickMobFocus(mob, [wounded, provoked])?.id, "tank");

  // Locked weights so a later tweak has to update the test on purpose.
  const dTank = 5;
  const expectedTank =
    -dTank + 80 * CASTER_HATE_WEIGHT + CASTER_FOCUS_STICK - CASTER_TANK_PENALTY;
  assert.ok(Math.abs(mobFocusScore(mob, tank) - expectedTank) < 1e-9);
  const expectedCleric =
    -5.5 + 20 * CASTER_HATE_WEIGHT + 0.6 * CASTER_WOUND_WEIGHT + CASTER_BACKLINE_BONUS;
  assert.ok(Math.abs(mobFocusScore(mob, cleric) - expectedCleric) < 1e-9);
});

test("melee focus stays on distance, hate, and the current target", () => {
  const mob = { x: 0, z: 0, job: "fighter" as const, targetId: "tank" };
  const tank = candidate({ id: "tank", x: 5, job: "knight", enmity: 80, hp: 100 });
  const cleric = candidate({ id: "heal", x: 5.5, job: "cleric", enmity: 20, hp: 40, maxHp: 100 });
  const expected = -5 + 80 * MELEE_HATE_WEIGHT + MELEE_FOCUS_STICK;
  assert.ok(Math.abs(mobFocusScore(mob, tank) - expected) < 1e-9);
  assert.equal(pickMobFocus(mob, [cleric, tank])?.id, "tank");

  const tieMob = { x: 0, z: 0, job: "fighter" as const, targetId: null };
  const a = candidate({ id: "b", x: 3, enmity: 10 });
  const b = candidate({ id: "a", x: 3, enmity: 10 });
  assert.equal(pickMobFocus(tieMob, [a, b])?.id, "a");
});

test("a packed sorcerer winds up Cinder Burst; Silence blocks it", () => {
  resetGameRollForTests();
  scriptNextRollsForTests([0]);
  try {
    const mob = sorcerer();
    const res = tryMobJobAbility(mob, {
      now: NOW,
      dist: 4,
      player,
      vitals: { vit: 10, agi: 10 },
      nearby: 2,
      pushLog: () => {},
      applyPlayerDamage: () => assert.fail("burst must not resolve immediately"),
    });
    assert.equal(res.ok, true);
    assert.ok(res.ok && res.pending);
    assert.equal(res.ok && res.pending?.type, "aoe");
    if (res.ok && res.pending && res.pending.type === "aoe") {
      assert.equal(res.pending.radius, MOB_CINDER_RADIUS);
      assert.equal(res.pending.magic, true);
      assert.ok(res.pending.dmg >= 1);
    }
    assert.equal(mob.mp, 26);
    assert.equal(mob.anim, "cast");
  } finally {
    resetGameRollForTests();
  }

  resetGameRollForTests();
  scriptNextRollsForTests([0]);
  try {
    const muted = sorcerer({ silenceUntil: NOW + 5_000, mp: 40 });
    const res = tryMobJobAbility(muted, {
      now: NOW,
      dist: 4,
      player,
      vitals: { vit: 10, agi: 10 },
      nearby: 3,
      pushLog: () => {},
      applyPlayerDamage: () => assert.fail("silence must mute the burst"),
    });
    assert.equal(res.ok, false);
    assert.equal(muted.mp, 40);
  } finally {
    resetGameRollForTests();
  }
});
