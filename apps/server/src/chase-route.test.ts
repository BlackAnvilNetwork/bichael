import assert from "node:assert/strict";
import test from "node:test";
import { CHASE_HOLD_SHIFT, CHASE_REPLAN_SHIFT, chaseNeedsReplan, shouldAutoEngage } from "./chase-route";

const goal = { x: 10, z: 10 };

test("no goal yet always plans", () => {
  assert.equal(chaseNeedsReplan({ navGoal: null, moveTo: null, navHold: false }, 1, 1), true);
});

test("running route keeps its corridor for small goal shifts", () => {
  const s = { navGoal: goal, moveTo: { x: 5, z: 5 }, navHold: false };
  assert.equal(chaseNeedsReplan(s, 10.5, 10.5), false);
  assert.equal(chaseNeedsReplan(s, 10 + CHASE_REPLAN_SHIFT + 0.01, 10), true);
});

test("finished short route replans when the mob sidesteps under 1.25 (#445)", () => {
  const s = { navGoal: goal, moveTo: null, navHold: true };
  // Sidestep of 0.9: before #445 the player stood still out of melee range.
  assert.equal(chaseNeedsReplan(s, 10.9, 10), true);
  assert.equal(chaseNeedsReplan(s, 10 + CHASE_HOLD_SHIFT + 0.01, 10), true);
});

test("finished short route holds while the goal stays put (no A* every tick)", () => {
  const s = { navGoal: goal, moveTo: null, navHold: true };
  assert.equal(chaseNeedsReplan(s, 10, 10), false);
  assert.equal(chaseNeedsReplan(s, 10.1, 10.1), false);
});

test("route that reached its goal with no hold replans", () => {
  assert.equal(chaseNeedsReplan({ navGoal: goal, moveTo: null, navHold: false }, 10.1, 10), true);
});

test("held movement keys suppress the post-kill chase", () => {
  assert.equal(shouldAutoEngage(true), false);
  assert.equal(shouldAutoEngage(false), true);
});
