import assert from "node:assert/strict";
import test from "node:test";
import { JOBS, SUBJOB_UNLOCK_LEVEL, meleeFStr, type JobId, type Stance } from "@bellgrave/combat";
import {
  autoAttackFStr,
  autoAttackFighterAccBonus,
  autoAttackFighterAttackMul,
} from "./auto-attack-traits";

const PLAYABLE = (Object.keys(JOBS) as JobId[]).filter((j) => JOBS[j].playable);
const STANCES: Stance[] = ["none", "flux", "aether"];
const STATS = { str: 20, dex: 40, mnd: 36 };

test("#86 no active support: autoAttackFStr matches meleeFStr for every job and stance", () => {
  for (const job of PLAYABLE) {
    for (const stance of STANCES) {
      for (const vit of [0, 15, 30, 60]) {
        const solo = { job, level: 30, subjob: null };
        assert.equal(autoAttackFStr(solo, STATS, vit, stance), meleeFStr(job, STATS, vit, stance));
        // Support below the unlock level is inactive.
        const sub = PLAYABLE.find((j) => j !== job)!;
        const low = { job, level: SUBJOB_UNLOCK_LEVEL - 1, subjob: sub };
        assert.equal(autoAttackFStr(low, STATS, vit, stance), meleeFStr(job, STATS, vit, stance));
      }
    }
  }
});

test("#86 support Rogue adds half the DEX trait; main Rogue keeps the full trait", () => {
  const vit = 20;
  // Knight main / Rogue support: STR 20 + floor(40 * 0.125) = 25 -> fSTR 5.
  assert.equal(autoAttackFStr({ job: "knight", subjob: "rogue", level: 30 }, STATS, vit, "none"), 5);
  // Rogue main (with any support): STR 20 + floor(40 * 0.25) = 30 -> fSTR 10.
  assert.equal(autoAttackFStr({ job: "rogue", subjob: "knight", level: 30 }, STATS, vit, "none"), 10);
  assert.equal(
    autoAttackFStr({ job: "rogue", subjob: "knight", level: 30 }, STATS, vit, "none"),
    meleeFStr("rogue", STATS, vit, "none"),
  );
});

test("#86 support Time Mage in Flux adds half of MND's lead over STR", () => {
  const vit = 10;
  // Fighter main / TIM support in Flux: 20 + floor((36 - 20) * 0.5) = 28 -> 18.
  assert.equal(autoAttackFStr({ job: "fighter", subjob: "time_mage", level: 30 }, STATS, vit, "flux"), 18);
  // Out of Flux the support TIM trait does nothing.
  assert.equal(autoAttackFStr({ job: "fighter", subjob: "time_mage", level: 30 }, STATS, vit, "none"), 10);
  // Never lowers STR when MND is lower.
  const lowMnd = { str: 30, dex: 0, mnd: 10 };
  assert.equal(autoAttackFStr({ job: "fighter", subjob: "time_mage", level: 30 }, lowMnd, vit, "flux"), 20);
  // Main TIM in Flux still swings with MND, and support Rogue stacks its half DEX trait.
  assert.equal(autoAttackFStr({ job: "time_mage", subjob: "rogue", level: 30 }, STATS, 30, "flux"), 11);
});

test("#86 staff floor stays a main Sorcerer / Cleric trait", () => {
  const weak = { str: 5, dex: 0, mnd: 0 };
  assert.equal(autoAttackFStr({ job: "cleric", subjob: "knight", level: 30 }, weak, 40, "none"), -1);
  assert.equal(autoAttackFStr({ job: "knight", subjob: "cleric", level: 30 }, weak, 40, "none"), -10);
});

function fighterish(job: string, subjob: string | null, extra: Record<string, number>) {
  return {
    job,
    subjob,
    level: 30,
    berserkUntil: 0,
    defenderUntil: 0,
    warcryUntil: 0,
    aggressorUntil: 0,
    ...extra,
  } as never;
}

test("#88 caster main + Fighter support gets Berserk attack and Aggressor accuracy", () => {
  const now = 1_000;
  const p = fighterish("sorcerer", "fighter", { berserkUntil: 5_000, aggressorUntil: 5_000 });
  assert.equal(autoAttackFighterAttackMul(p, now, false), 1.25);
  assert.equal(autoAttackFighterAccBonus(p, now), 25);
  // Caster main without a Fighter kit gets nothing.
  const q = fighterish("sorcerer", "cleric", { berserkUntil: 5_000, aggressorUntil: 5_000 });
  assert.equal(autoAttackFighterAttackMul(q, now, false), 1);
  assert.equal(autoAttackFighterAccBonus(q, now), 0);
  // Physical main keeps its existing multiplier path.
  const r = fighterish("fighter", null, { warcryUntil: 5_000 });
  assert.equal(autoAttackFighterAttackMul(r, now, true), 1.15);
});
