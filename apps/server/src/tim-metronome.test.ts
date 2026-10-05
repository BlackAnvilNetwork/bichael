import assert from "node:assert/strict";
import test from "node:test";
import { TIM_ABILITIES, deriveCharacterAttributes, type AbilityId, type JobId } from "@bellgrave/combat";
import { resolveTimAbility, type TimMob, type TimPlayer } from "./tim-abilities";

const NOW = 10_000;

// Knight 60 with Time Mage support (kit level 30): no signature staff needed.
function timPlayer(): TimPlayer & { subjob: JobId } {
  return {
    level: 60,
    job: "knight",
    subjob: "time_mage",
    mp: 500,
    maxMp: 500,
    hp: 500,
    maxHp: 500,
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
    lastEnfeeble: "slow",
    learned: ["slow", "metronome"] as AbilityId[],
  };
}

function mob(id: string, x: number): TimMob {
  return {
    id,
    alive: true,
    x,
    z: 0,
    hp: 1_000,
    maxHp: 1_000,
    targetId: null,
    nextSwingAt: 0,
    slowUntil: 0,
    swingPenalty: 0,
    gravityUntil: 0,
    gravityPct: 0,
    bindUntil: 0,
    petrifyUntil: 0,
    tdImpactUntil: 0,
    stunUntil: 0,
    distractUntil: 0,
    distractAcc: 0,
    frazzleUntil: 0,
    addleUntil: 0,
    silenceUntil: 0,
    paraUntil: 0,
  };
}

function hooks(p: TimPlayer & { subjob: JobId }, logs: string[]) {
  return {
    pushLog: (m: string) => logs.push(m),
    stopRest: () => {},
    facingTo: () => 0,
    playerCombatStats: () => deriveCharacterAttributes(p.job as JobId, p.level, p.subjob, []).total,
  };
}

test("Metronome with no target does not go on cooldown and costs nothing", () => {
  const p = timPlayer();
  const logs: string[] = [];
  const ok = resolveTimAbility(p, "metronome", undefined, [], NOW, hooks(p, logs));
  assert.equal(ok, false);
  assert.equal(p.recasts.metronome, undefined);
  assert.equal(p.recasts.slow, undefined);
  assert.equal(p.mp, 500);
  assert.match(logs.join(" | "), /needs a target/);
  assert.match(logs.at(-1) ?? "", /still ready/);
});

test("Metronome on an out-of-range target does not go on cooldown", () => {
  const p = timPlayer();
  const far = mob("far", 100);
  const logs: string[] = [];
  const ok = resolveTimAbility(p, "metronome", "far", [far], NOW, hooks(p, logs));
  assert.equal(ok, false);
  assert.equal(p.recasts.metronome, undefined);
  assert.equal(far.slowUntil, 0);
  assert.match(logs.join(" | "), /out of range/);
});

test("Metronome with no enfeeble to repeat does not go on cooldown", () => {
  const p = timPlayer();
  p.lastEnfeeble = null;
  const logs: string[] = [];
  assert.equal(resolveTimAbility(p, "metronome", undefined, [], NOW, hooks(p, logs)), false);
  assert.equal(p.recasts.metronome, undefined);
});

test("after a failed repeat, Metronome still works and starts its cooldown once it lands", () => {
  const p = timPlayer();
  const target = mob("m1", 5);
  const logs: string[] = [];
  const h = hooks(p, logs);

  assert.equal(resolveTimAbility(p, "metronome", undefined, [], NOW, h), false);
  assert.equal(p.recasts.metronome, undefined);

  const ok = resolveTimAbility(p, "metronome", "m1", [target], NOW + 1, h);
  assert.equal(ok, true);
  assert.ok(target.slowUntil > NOW, "Slow should land on the target");
  assert.equal(p.recasts.metronome, NOW + 1 + TIM_ABILITIES.metronome.recastMs);
  // The repeat is free: no MP and no Slow recast.
  assert.equal(p.mp, 500);
  assert.equal(p.recasts.slow, undefined);
  assert.match(logs.at(-1) ?? "", /repeated Slow/);

  // Now it really is on cooldown.
  assert.equal(resolveTimAbility(p, "metronome", "m1", [target], NOW + 2, h), false);
  assert.match(logs.at(-1) ?? "", /on cooldown/);
});

test("a normal Slow cast still reports success and pays MP and recast", () => {
  const p = timPlayer();
  const target = mob("m1", 5);
  const logs: string[] = [];
  assert.equal(resolveTimAbility(p, "slow", "m1", [target], NOW, hooks(p, logs)), true);
  assert.equal(p.mp, 500 - TIM_ABILITIES.slow.mp);
  assert.equal(p.recasts.slow, NOW + TIM_ABILITIES.slow.recastMs);
  // A failed normal cast refunds as before.
  const p2 = timPlayer();
  assert.equal(resolveTimAbility(p2, "slow", "nobody", [], NOW, hooks(p2, [])), false);
  assert.equal(p2.mp, 500);
  assert.equal(p2.recasts.slow, undefined);
});
