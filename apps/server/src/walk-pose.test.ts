import assert from "node:assert/strict";
import test from "node:test";
import {
  HELD_MOVE_WINDOW_MS,
  WALK_STEP_GRACE_MS,
  moveInputHeld,
  shouldDropWalk,
  walkUntilAfterStep,
  walkUntilAtArrival,
} from "./walk-pose";

const TICK = 50;

test("held key keeps walk through a dead tick with no route (#436)", () => {
  const t0 = 10_000;
  // Packets every 50ms; the route finished and the body did not step.
  let lastInput = t0;
  let walkUntil = walkUntilAtArrival(t0, lastInput);
  for (let now = t0 + TICK; now <= t0 + 2_000; now += TICK) {
    lastInput = now - 10; // a packet just before each tick
    assert.equal(shouldDropWalk(now, walkUntil, lastInput), false, `idle at +${now - t0}ms while held`);
  }
});

test("held into a wall: no step, no moveTo, still walking while packets arrive", () => {
  const now = 5_000;
  assert.equal(moveInputHeld(now, now - 40), true);
  assert.equal(shouldDropWalk(now, 0, now - 40), false);
});

test("one late packet does not flicker idle", () => {
  const now = 5_000;
  assert.equal(shouldDropWalk(now, 0, now - (HELD_MOVE_WINDOW_MS - 1)), false);
});

test("releasing the key idles on the next tick, not 150-200ms later", () => {
  const stop = 8_000;
  // Last real step at `stop`; last key packet 60ms earlier, then released.
  const walkUntil = walkUntilAfterStep(stop);
  const lastInput = stop - 60;
  assert.ok(WALK_STEP_GRACE_MS <= TICK + 20);
  assert.equal(shouldDropWalk(stop + TICK, walkUntil, lastInput), false, "grace covers one tick");
  assert.equal(shouldDropWalk(stop + 2 * TICK, walkUntil, lastInput), true, "idle by the second tick");
});

test("click-move arrival idles immediately", () => {
  const now = 20_000;
  const clickAt = now - 3_000;
  const walkUntil = walkUntilAtArrival(now, clickAt);
  assert.equal(walkUntil, now);
  assert.equal(shouldDropWalk(now + TICK, walkUntil, clickAt), true);
});

test("continuous steps never drop walk between ticks", () => {
  for (let now = 1_000; now < 3_000; now += TICK) {
    const walkUntil = walkUntilAfterStep(now);
    assert.equal(shouldDropWalk(now + TICK, walkUntil, 0), false);
  }
});

test("never-moved player is not held", () => {
  assert.equal(moveInputHeld(1_000, 0), false);
});
