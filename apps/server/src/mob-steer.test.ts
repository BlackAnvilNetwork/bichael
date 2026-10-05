import assert from "node:assert/strict";
import test from "node:test";
import { clampPaleHollow, paleHollowClampMove, paleHollowWalkable } from "@bellgrave/config";
import { steerMobStep } from "./mob-steer";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function inBounds(x: number, z: number): boolean {
  const c = clampPaleHollow(x, z);
  return Math.abs(c.x - x) < 1e-9 && Math.abs(c.z - z) < 1e-9;
}

/** Walkable points whose straight line to a nearby target crosses unwalkable ground. */
function riverCrossings(count: number) {
  const rand = rng(73);
  const out: { x: number; z: number; tx: number; tz: number }[] = [];
  for (let i = 0; i < 40_000 && out.length < count; i++) {
    const x = -90 + rand() * 180;
    const z = rand() * 220;
    if (!inBounds(x, z) || !paleHollowWalkable(x, z)) continue;
    const a = rand() * Math.PI * 2;
    const tx = x + Math.sin(a) * 12;
    const tz = z + Math.cos(a) * 12;
    if (!inBounds(tx, tz) || !paleHollowWalkable(tx, tz)) continue;
    const c = paleHollowClampMove(x, z, tx, tz);
    if (Math.hypot(c.x - tx, c.z - tz) > 1) out.push({ x, z, tx, tz });
  }
  return out;
}

test("there are river crossings to exercise", () => {
  assert.ok(riverCrossings(20).length >= 20);
});

test("chasing mobs never step onto water or river walls (#73)", () => {
  const step = (2.2 * 50) / 1000;
  for (const c of riverCrossings(60)) {
    let x = c.x;
    let z = c.z;
    for (let i = 0; i < 400; i++) {
      const s = steerMobStep(x, z, c.tx, c.tz, step);
      if (s.moved) {
        assert.ok(paleHollowWalkable(s.x, s.z), `stepped into (${s.x.toFixed(2)}, ${s.z.toFixed(2)})`);
        assert.ok(Math.hypot(s.x - x, s.z - z) <= step + 1e-6, "step longer than allowed");
      }
      x = s.x;
      z = s.z;
    }
  }
});

test("open ground still chases in a straight line", () => {
  const rand = rng(7);
  let checked = 0;
  for (let i = 0; i < 5_000 && checked < 20; i++) {
    const x = -60 + rand() * 120;
    const z = 10 + rand() * 200;
    const tx = x + 3;
    if (!inBounds(x, z) || !inBounds(tx, z) || !paleHollowWalkable(x, z)) continue;
    if (Math.hypot(paleHollowClampMove(x, z, tx, z).x - tx, 0) > 1e-6) continue;
    const s = steerMobStep(x, z, tx, z, 0.11);
    assert.equal(s.moved, true);
    assert.ok(Math.abs(s.z - z) < 1e-6 && s.x > x, "direct step expected on open ground");
    checked += 1;
  }
  assert.ok(checked >= 10);
});

test("a mob already standing in water may walk out", () => {
  const rand = rng(11);
  for (let i = 0; i < 40_000; i++) {
    const x = -90 + rand() * 180;
    const z = rand() * 220;
    if (!inBounds(x, z) || paleHollowWalkable(x, z)) continue;
    const s = steerMobStep(x, z, x + 5, z, 0.11);
    assert.equal(s.moved, true);
    return;
  }
  assert.fail("no unwalkable sample found");
});
