import assert from "node:assert/strict";
import test from "node:test";
import {
  MAB_MAX_BONUS,
  applyMagicAttackBonus,
  defenseFromVit,
  deriveCharacterAttributes,
  magicAttackMul,
  physicalDamage,
  playerDefense,
  type JobId,
} from "@bellgrave/combat";
import { getItem } from "@bellgrave/items";
import { gearDef, gearMab, playerDefenseWithGear, withGearMab } from "./gear-combat";
import { mobAutoAttackRoll, targetPhysDef, type MobJobCombatant } from "./mob-job-ai";
import { resolveSorcererAbility, type SorcererMob, type SorcererPlayer } from "./sorcerer-abilities";

const IRON_MAIL = 5; // body, def 20
const BRONZE_CAP = 104; // head, def 3
const ASHBEAM_STAFF = 1; // main, mab 7
const SOVEREIGN_STAFF = 42; // main, mab 49

test("catalog fixtures used below still carry the stats the tests expect", () => {
  assert.equal(getItem(IRON_MAIL)?.slot, "body");
  assert.equal(getItem(IRON_MAIL)?.stats?.def, 20);
  assert.equal(getItem(BRONZE_CAP)?.stats?.def, 3);
  assert.equal(getItem(ASHBEAM_STAFF)?.stats?.mab, 7);
  assert.equal(getItem(SOVEREIGN_STAFF)?.stats?.mab, 49);
});

test("player defense is VIT defense plus equipped gear def", () => {
  assert.equal(playerDefense(20), defenseFromVit(20));
  assert.equal(playerDefense(20, 23), defenseFromVit(20) + 23);
  // Bad or negative gear values never lower defense.
  assert.equal(playerDefense(20, -50), defenseFromVit(20));
  assert.equal(playerDefense(20, Number.NaN), defenseFromVit(20));

  // High-level player (level >= item level) gets full stats.
  const geared = { equip: { body: IRON_MAIL, head: BRONZE_CAP }, level: 100 };
  assert.equal(gearDef(geared), 23);
  assert.equal(playerDefenseWithGear(geared, 20), defenseFromVit(20) + 23);
  // Gear in the wrong slot does not count (same rule as aggregateEquipmentStats).
  assert.equal(gearDef({ equip: { head: IRON_MAIL }, level: 100 }), 0);
  assert.equal(gearDef({ equip: {}, level: 100 }), 0);
});

test("gear stats scale with player level vs item level (#103)", () => {
  // Iron Mail: iLv 28, def 20, vit 7, hp 29
  // Bronze Cap: iLv 8, def 3
  const ironMailIlv = getItem(IRON_MAIL)!.craftLevel!;
  const bronzeCapIlv = getItem(BRONZE_CAP)!.craftLevel!;
  assert.equal(ironMailIlv, 28, "Iron Mail iLv fixture");
  assert.equal(bronzeCapIlv, 8, "Bronze Cap iLv fixture");

  // At level 28+, Iron Mail gives full 20 def
  const atLevel = { equip: { body: IRON_MAIL }, level: 28 };
  assert.equal(gearDef(atLevel), 20, "full def at item level");

  const aboveLevel = { equip: { body: IRON_MAIL }, level: 50 };
  assert.equal(gearDef(aboveLevel), 20, "full def above item level");

  // At level 14 (half of 28), Iron Mail gives floor(20 * 14/28) = 10 def
  const halfLevel = { equip: { body: IRON_MAIL }, level: 14 };
  assert.equal(gearDef(halfLevel), 10, "half def at half level");

  // At level 2, Iron Mail gives floor(20 * 2/28) = 1 def
  const lowLevel = { equip: { body: IRON_MAIL }, level: 2 };
  assert.equal(gearDef(lowLevel), 1, "minimal def at low level");

  // Combining items with different iLevels: each scales independently
  // At level 14, Iron Mail (iLv 28) gives floor(20 * 14/28) = 10
  // Bronze Cap (iLv 8) at level 14 > iLv 8, so full 3
  const mixedGear = { equip: { body: IRON_MAIL, head: BRONZE_CAP }, level: 14 };
  assert.equal(gearDef(mixedGear), 10 + 3, "mixed gear: scaled mail + full cap");
});

test("gear MAB scales with player level (#103)", () => {
  // Ashbeam Staff: iLv 6, mab 7
  // Sovereign Staff: iLv (check), mab 49
  const ashbeamIlv = getItem(ASHBEAM_STAFF)!.craftLevel!;
  const sovereignIlv = getItem(SOVEREIGN_STAFF)!.craftLevel!;
  assert.equal(ashbeamIlv, 6, "Ashbeam Staff iLv fixture");

  // At level 6+, Ashbeam gives full 7 mab
  const atLevel = { equip: { main: ASHBEAM_STAFF }, level: 6 };
  assert.equal(gearMab(atLevel), 7, "full mab at item level");

  // At level 3 (half of 6), Ashbeam gives floor(7 * 3/6) = 3 mab
  const halfLevel = { equip: { main: ASHBEAM_STAFF }, level: 3 };
  assert.equal(gearMab(halfLevel), 3, "scaled mab at half level");

  // At level 1, Ashbeam gives floor(7 * 1/6) = 1 mab
  const lowLevel = { equip: { main: ASHBEAM_STAFF }, level: 1 };
  assert.equal(gearMab(lowLevel), 1, "minimal mab at low level");

  // At level 100, Sovereign Staff gives full 49 mab
  const highLevel = { equip: { main: SOVEREIGN_STAFF }, level: 100 };
  assert.equal(gearMab(highLevel), 49, "full mab for high level player");
});

function fighterMob(level: number): MobJobCombatant {
  return {
    id: "m1",
    name: "Test Brute",
    x: 0,
    z: 0,
    hp: 500,
    maxHp: 500,
    mp: 0,
    maxMp: 0,
    job: "fighter",
    level,
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
}

test("mob physical hits roll against gear def, but never drop to 0", (t) => {
  t.mock.method(Math, "random", () => 0); // always hit
  const mob = fighterMob(30);
  const vit = 20;
  const bare = mobAutoAttackRoll(mob, { vit, agi: 10 }, 1_000);
  const sameAsVitOnly = mobAutoAttackRoll(mob, { vit, agi: 10, def: playerDefense(vit) }, 1_000);
  const armored = mobAutoAttackRoll(mob, { vit, agi: 10, def: playerDefense(vit, 60) }, 1_000);
  const tank = mobAutoAttackRoll(mob, { vit, agi: 10, def: playerDefense(vit, 100_000) }, 1_000);
  assert.equal(bare.hit, true);
  assert.equal(bare.anim, "melee");
  // No gear def = exactly the old VIT-only number.
  assert.equal(sameAsVitOnly.dmg, bare.dmg);
  assert.ok(armored.dmg < bare.dmg, `armor should cut damage (${armored.dmg} vs ${bare.dmg})`);
  // physicalDamage's 0.1 ratio floor bounds the reduction; never 0 or negative.
  assert.ok(tank.dmg >= 1);
  assert.ok(tank.dmg >= Math.floor(bare.dmg * 0.1) - 1);
  assert.equal(targetPhysDef({ vit, agi: 0 }), defenseFromVit(vit));
  assert.equal(targetPhysDef({ vit, agi: 0, def: -5 }), 1);
});

test("more gear def never increases physical damage", () => {
  let prev = Infinity;
  for (let gear = 0; gear <= 400; gear += 10) {
    const dmg = physicalDamage(60, playerDefense(30, gear), 5, false);
    assert.ok(dmg >= 1);
    assert.ok(dmg <= prev);
    prev = dmg;
  }
});

test("gear MAB is a bounded percent bonus on spell damage", () => {
  assert.equal(magicAttackMul(0), 1);
  assert.equal(magicAttackMul(), 1);
  assert.equal(magicAttackMul(-20), 1);
  assert.equal(magicAttackMul(Number.NaN), 1);
  assert.ok(Math.abs(magicAttackMul(49) - 1.49) < 1e-9);
  assert.equal(magicAttackMul(10_000), 1 + MAB_MAX_BONUS);
  assert.equal(applyMagicAttackBonus(100, 49), 149);
  assert.equal(applyMagicAttackBonus(0, 49), 1);
  assert.equal(gearMab({ equip: { main: SOVEREIGN_STAFF } }), 49);
  assert.equal(withGearMab({ equip: { main: ASHBEAM_STAFF } }, 100), 107);
  assert.equal(withGearMab({ equip: {} }, 100), 100);
});

function sorcPlayer(equip: SorcererPlayer["equip"], level = 100): SorcererPlayer & { wallet: string; subjob: JobId } {
  return {
    wallet: "0xsorc",
    level,
    job: "knight",
    subjob: "sorcerer",
    mp: 9_999,
    maxMp: 9_999,
    hp: 100,
    maxHp: 100,
    tp: 0,
    equip,
    inventory: [],
    anim: "idle",
    animUntil: 0,
    moveTo: null,
    targetId: "m1",
    facing: 0,
    x: 0,
    y: 0,
    z: 0,
    recasts: {},
    arcaneFloodUntil: 0,
    elementalSealUntil: 0,
    manaWallUntil: 0,
    manawellReady: false,
    cascadeUntil: 0,
    focalNeveUntil: 0,
    enmity: 0,
    lastScElement: null,
    scCastFlashUntil: 0,
  };
}

function nukeDamage(equip: SorcererPlayer["equip"], level = 100): number {
  const p = sorcPlayer(equip, level);
  const mob: SorcererMob = {
    id: "m1",
    name: "Dummy",
    alive: true,
    x: 1,
    z: 0,
    hp: 1_000_000,
    maxHp: 1_000_000,
    targetId: null,
    nextSwingAt: 0,
    stunUntil: 0,
    blindUntil: 0,
    bindUntil: 0,
    sleepUntil: 0,
    scImpactUntil: 0,
    scImpactElement: null,
  };
  const logs: string[] = [];
  // Fixed attribute pool so only gear MAB differs between casts.
  const stats = deriveCharacterAttributes("knight", level, "sorcerer", []).total;
  resolveSorcererAbility(p, "sc_ember_lance", "m1", 1_000, {
    pushLog: (_p, m) => logs.push(m),
    stopRest: () => {},
    facingTo: () => 0,
    findMob: (id) => (id === mob.id ? mob : null),
    allMobs: () => [mob],
    onMobKill: () => {},
    dist: (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz),
    playerCombatStats: () => stats,
  });
  const dealt = 1_000_000 - mob.hp;
  assert.ok(dealt > 0, `nuke should land: ${logs.join(" | ")}`);
  return dealt;
}

test("player spell damage scales with equipped gear MAB", () => {
  const plain = nukeDamage({} as SorcererPlayer["equip"]);
  const staff = nukeDamage({ main: SOVEREIGN_STAFF } as SorcererPlayer["equip"]);
  assert.equal(staff, Math.floor(plain * 1.49));
  assert.ok(staff > plain);
});
