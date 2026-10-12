import assert from "node:assert/strict";
import test from "node:test";
import { deriveCharacterAttributes, type JobId } from "@bellgrave/combat";
import { resolveClericAbility, type ClericHooks, type ClericPlayer } from "./cleric-abilities";

const NOW = 50_000;

// Cleric 60 main: Sunrise Recall (L25) and Recall II (L50) unlocked; neither needs the staff.
function player(wallet: string, hp: number, maxHp = 1_000): ClericPlayer & { subjob: JobId | null } {
  return {
    level: 60,
    job: "cleric",
    subjob: null,
    wallet,
    mp: 500,
    maxMp: 500,
    hp,
    maxHp,
    tp: 0,
    equip: {} as ClericPlayer["equip"],
    inventory: [],
    anim: "idle",
    animUntil: 0,
    moveTo: null,
    targetId: null,
    facing: 0,
    x: 0,
    z: 0,
    recasts: {},
    protectUntil: 0,
    protectPhysMul: 1,
    shellUntil: 0,
    shellMagMul: 1,
    hasteUntil: 0,
    hastePct: 0,
    divineSealCharges: 0,
    divineSealUntil: 0,
    solaceRite: false,
    miseryRite: false,
    miseryEmpowerUntil: 0,
    martyrReadyUntil: 0,
    devotionReadyUntil: 0,
    asylumUntil: 0,
    regenUntil: 0,
    regenTick: 0,
    reraiseUntil: 0,
    healAbsorbUntil: 0,
    healAbsorbHp: 0,
    sacredLightUntil: 0,
    blindUntil: 0,
  };
}

function hooks(caster: ClericPlayer & { subjob: JobId | null }, everyone: ClericPlayer[], logs: string[]): ClericHooks {
  return {
    pushLog: (_p, m) => logs.push(m),
    stopRest: () => {},
    facingTo: () => 0,
    findMob: () => null,
    allMobs: () => [],
    allPlayers: () => everyone,
    onMobKill: () => {},
    dist: (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz),
    playerCombatStats: () => deriveCharacterAttributes(caster.job as JobId, caster.level, caster.subjob, []).total,
  };
}

for (const id of ["cl_raise", "cl_raise_ii"] as const) {
  test(`${id} never lowers a living ally's HP (#51)`, () => {
    const caster = player("0xcaster", 1_000);
    // High-HP ally just below max: the old absolute assignment would drop them to ~heal.
    const ally = player("0xally", 9_999, 10_000);
    const logs: string[] = [];
    const ok = resolveClericAbility(caster, id, "0xally", NOW, hooks(caster, [caster, ally], logs));
    assert.equal(ok, true);
    assert.equal(ally.hp, 10_000);
    assert.ok(caster.mp < 500, "MP spent on a real heal");
  });

  test(`${id} heals additively and caps at max HP (#51)`, () => {
    const caster = player("0xcaster", 1_000);
    const ally = player("0xally", 100, 100_000);
    const logs: string[] = [];
    resolveClericAbility(caster, id, "0xally", NOW, hooks(caster, [caster, ally], logs));
    assert.ok(ally.hp > 100, "HP went up");
    assert.ok(ally.hp <= ally.maxHp);
    const healed = ally.hp - 100;
    // Second target with more HP gets the same additive amount, not an absolute value.
    const caster2 = player("0xcaster2", 1_000);
    const ally2 = player("0xally2", 50_000, 100_000);
    resolveClericAbility(caster2, id, "0xally2", NOW, hooks(caster2, [caster2, ally2], []));
    assert.equal(ally2.hp, 50_000 + healed);
  });

  test(`${id} on a full-HP target (or self fallback) spends nothing (#51)`, () => {
    const caster = player("0xcaster", 1_000);
    const logs: string[] = [];
    const ok = resolveClericAbility(caster, id, undefined, NOW, hooks(caster, [caster], logs));
    assert.equal(ok, true);
    assert.equal(caster.hp, 1_000);
    assert.equal(caster.mp, 500);
    assert.equal(caster.recasts[id], undefined);
    assert.match(logs.join(" | "), /not in need of recall/);
  });
}