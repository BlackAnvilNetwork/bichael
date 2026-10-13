import assert from "node:assert/strict";
import test from "node:test";
import {
  JOBS,
  SUBJOB_UNLOCK_LEVEL,
  abilitiesUnlockedDual,
  abilityIdsForJob,
  abilityUnlockLevel,
  activeSubjobLevel,
  canTrainAbility,
  combinedJobStats,
  combinedJobVitals,
  deriveCharacterAttributes,
  isTrainerFreeAbility,
  jobStatsAtLevel,
  jobVitalsAtLevel,
  subjobLevel,
  supportJobStatContribution,
  type AbilityId,
  type JobId,
} from "@bellgrave/combat";
import { resolveKnightAbility } from "./knight-abilities";
import { hasKit, kitLevel } from "./support-job";
import { resolveTimAbility, type TimPlayer } from "./tim-abilities";
// Cleric Raise (#51) tests live in their own file; imported here so they run under the
// existing server test list without editing package.json.
import "./cleric-raise.test";
// Auto-attack support traits (#86, #88).
import "./auto-attack-traits.test";

const ATTRS = ["str", "dex", "vit", "agi", "int", "mnd"] as const;
const PLAYABLE = (Object.keys(JOBS) as JobId[]).filter((j) => JOBS[j].playable);
const PAIRS: [JobId, JobId][] = PLAYABLE.flatMap((main) =>
  PLAYABLE.filter((sub) => sub !== main).map((sub) => [main, sub] as [JobId, JobId]),
);

test("support level is floor(main / 2) and only active from the unlock level", () => {
  assert.equal(subjobLevel(10), 5);
  assert.equal(subjobLevel(11), 5);
  assert.equal(subjobLevel(40), 20);
  assert.equal(subjobLevel(75), 37);
  assert.equal(activeSubjobLevel("knight", 40, "time_mage"), 20);
  assert.equal(activeSubjobLevel("knight", 41, "time_mage"), 20);
  assert.equal(activeSubjobLevel("knight", SUBJOB_UNLOCK_LEVEL - 1, "time_mage"), 0);
  assert.equal(activeSubjobLevel("knight", 40, null), 0);
  assert.equal(activeSubjobLevel("knight", 40, "knight"), 0);
});

test("kit level: main kit at full level, support kit at half, inactive below L10", () => {
  assert.equal(kitLevel({ job: "time_mage", level: 40, subjob: null }, "time_mage"), 40);
  assert.equal(kitLevel({ job: "knight", level: 40, subjob: "time_mage" }, "time_mage"), 20);
  assert.equal(kitLevel({ job: "knight", level: 40, subjob: "time_mage" }, "knight"), 40);
  assert.equal(kitLevel({ job: "knight", level: 9, subjob: "time_mage" }, "time_mage"), 0);
  assert.equal(kitLevel({ job: "knight", level: 40, subjob: null }, "time_mage"), 0);
  assert.equal(hasKit({ job: "knight", level: 9, subjob: "rogue" }, "rogue"), false);
  assert.equal(hasKit({ job: "knight", level: 10, subjob: "rogue" }, "rogue"), true);
});

test("main job keeps full-level stats; no support means main stats only", () => {
  for (const job of PLAYABLE) {
    for (const lv of [1, 10, 40, 75]) {
      assert.deepEqual(combinedJobStats(job, lv, null), jobStatsAtLevel(job, lv));
      assert.deepEqual(combinedJobVitals(job, lv, null), jobVitalsAtLevel(job, lv));
    }
  }
});

test("every support job adds its stats as if it were at half main level", () => {
  for (const [main, sub] of PAIRS) {
    for (const lv of [10, 25, 40, 75]) {
      const half = subjobLevel(lv);
      const mainStats = jobStatsAtLevel(main, lv);
      const subHalf = jobStatsAtLevel(sub, half);
      const subL1 = jobStatsAtLevel(sub, 1);
      const subFull = jobStatsAtLevel(sub, lv);
      const combined = combinedJobStats(main, lv, sub);
      const add = supportJobStatContribution(main, lv, sub);
      for (const a of ATTRS) {
        assert.equal(add[a], subHalf[a] - subL1[a], `${main}/${sub} L${lv} ${a} contribution`);
        assert.equal(combined[a], mainStats[a] + add[a], `${main}/${sub} L${lv} ${a}`);
        // Never the support job at full main level (not a second full kit).
        assert.ok(combined[a] <= mainStats[a] + (subFull[a] - subL1[a]));
      }
      // Character sheet / authoritative combat derive from the same pool.
      assert.deepEqual(deriveCharacterAttributes(main, lv, sub, []).base, combined);
    }
  }
  // Concrete #56 case: Knight 40 / Time Mage support = Time Mage growth to L20 only.
  const kn = jobStatsAtLevel("knight", 40);
  const c = combinedJobStats("knight", 40, "time_mage");
  const timGrowth20 = jobStatsAtLevel("time_mage", 20).mnd - jobStatsAtLevel("time_mage", 1).mnd;
  assert.ok(timGrowth20 > 0);
  assert.equal(c.mnd, kn.mnd + timGrowth20);
});

test("support stats do nothing below the unlock level", () => {
  for (const [main, sub] of PAIRS) {
    const lv = SUBJOB_UNLOCK_LEVEL - 1;
    assert.deepEqual(combinedJobStats(main, lv, sub), jobStatsAtLevel(main, lv));
    assert.deepEqual(combinedJobVitals(main, lv, sub), jobVitalsAtLevel(main, lv));
  }
});

test("support vitals: half-level growth, and an MP-less main gets the support MP pool", () => {
  // Knight has MP: add Time Mage MP growth to L20.
  const knTim = combinedJobVitals("knight", 40, "time_mage");
  const kn = jobVitalsAtLevel("knight", 40);
  const tim20 = jobVitalsAtLevel("time_mage", 20);
  const tim1 = jobVitalsAtLevel("time_mage", 1);
  assert.equal(knTim.maxMp, kn.maxMp + (tim20.maxMp - tim1.maxMp));
  assert.equal(knTim.maxHp, kn.maxHp + (tim20.maxHp - tim1.maxHp));
  // Fighter has no MP pool: Cleric support brings its pool as if Cleric L10.
  assert.equal(jobVitalsAtLevel("fighter", 20).maxMp, 0);
  const fiCl = combinedJobVitals("fighter", 20, "cleric");
  assert.equal(fiCl.maxMp, jobVitalsAtLevel("cleric", 10).maxMp);
  assert.ok(fiCl.maxMp < jobVitalsAtLevel("cleric", 20).maxMp);
});

test("unlearned support skills stay locked; learned ones unlock at the half-level gate", () => {
  for (const [main, sub] of PAIRS) {
    const mainIds = new Set(abilityIdsForJob(main));
    const subOnly = abilityIdsForJob(sub).filter(
      (id) => !mainIds.has(id) && !isTrainerFreeAbility(id),
    );
    for (const lv of [10, 30, 50, 75]) {
      const half = subjobLevel(lv);
      // Nothing learned: no paid support skill is granted.
      const none = new Set(abilitiesUnlockedDual(main, lv, sub, []));
      for (const id of subOnly) assert.ok(!none.has(id), `${main}/${sub} L${lv} auto-granted ${id}`);
      // Everything learned: exactly the ones at or under the support level.
      const all = new Set(abilitiesUnlockedDual(main, lv, sub, subOnly));
      for (const id of subOnly) {
        const ok = abilityUnlockLevel(id) <= half;
        assert.equal(all.has(id), ok, `${main}/${sub} L${lv} ${id} (unlock ${abilityUnlockLevel(id)})`);
        // Same cap the Trainer sells under.
        assert.equal(canTrainAbility(main, lv, sub, half, id), ok, `trainer cap ${id}`);
      }
    }
  }
  // Concrete: Knight 40 / TIM support (L20).
  const learned: AbilityId[] = ["cure_ii", "cure_iii"];
  const u = new Set(abilitiesUnlockedDual("knight", 40, "time_mage", learned));
  assert.ok(!u.has("cure"), "cure was never learned");
  assert.ok(u.has("cure_ii"), "cure_ii (L16) learned, support L20");
  assert.ok(!u.has("cure_iii"), "cure_iii (L30) is above support L20");
  // Main TIM at the same level keeps its full-level unlock.
  assert.ok(abilitiesUnlockedDual("time_mage", 40, "knight", learned).includes("cure_iii"));
  // Support L30 (main 60) reaches it.
  assert.ok(abilitiesUnlockedDual("knight", 60, "time_mage", learned).includes("cure_iii"));
});

function timSupportPlayer(level: number, learned: AbilityId[]): TimPlayer & { subjob: JobId } {
  return {
    level,
    job: "knight",
    subjob: "time_mage",
    mp: 999,
    maxMp: 999,
    hp: 1,
    maxHp: 99_999,
    tp: 0,
    flux: false,
    aether: false,
    equip: {} as TimPlayer["equip"],
    inventory: [],
    anim: "idle",
    animUntil: 0,
    moveTo: null,
    targetId: null,
    facing: 0,
    x: 0,
    z: 0,
    recasts: {},
    hasteUntil: 0,
    hastePct: 0,
    moveUntil: 0,
    movePct: 0,
    quickenUntil: 0,
    overclockUntil: 0,
    timeSealUntil: 0,
    perpetualUntil: 0,
    lastEnfeeble: null,
    learned,
  };
}

function timHooks(p: TimPlayer & { subjob: JobId }, logs: string[]) {
  return {
    pushLog: (m: string) => logs.push(m),
    stopRest: () => {},
    facingTo: () => 0,
    playerCombatStats: () =>
      deriveCharacterAttributes(p.job as JobId, p.level, p.subjob, []).total,
  };
}

test("Time Mage support spells: learned + half-level gate, cast with the character stat pool", () => {
  const p = timSupportPlayer(40, ["cure_ii", "cure_iii"]);
  const logs: string[] = [];
  const hooks = timHooks(p, logs);

  resolveTimAbility(p, "cure", undefined, [], 1_000, hooks);
  assert.match(logs.at(-1) ?? "", /not learned/);
  assert.equal(p.hp, 1);

  resolveTimAbility(p, "cure_iii", undefined, [], 1_000, hooks);
  assert.match(logs.at(-1) ?? "", /unlocks at level 30/);
  assert.equal(p.hp, 1);

  resolveTimAbility(p, "cure_ii", undefined, [], 1_000, hooks);
  const mnd = combinedJobStats("knight", 40, "time_mage").mnd;
  assert.equal(p.hp, 1 + Math.floor(110 + mnd * 1.5));
});

test("Knight support abilities gate on support level, not main level", () => {
  const logs: string[] = [];
  // Fighter 20 / Knight support L10: Buckler Crash (L15) learned but above support level.
  const p = {
    wallet: "0xtest",
    job: "fighter",
    subjob: "knight",
    level: 20,
    mp: 999,
    recasts: {},
    learned: ["shield_bash"],
  };
  const handled = resolveKnightAbility(p as never, "shield_bash", undefined, 1_000, {
    pushLog: (_pl: unknown, m: string) => logs.push(m),
  } as never);
  assert.equal(handled, true);
  assert.match(logs.at(-1) ?? "", /unlocks at level 15/);
});
