import assert from "node:assert/strict";
import test from "node:test";
import { ENGAGE_MAX_RANGE, withinEngageRange } from "./engage-range";

test("engage accepts mobs inside the max range (#62)", () => {
  assert.equal(withinEngageRange(0, 0, 0, 0), true);
  assert.equal(withinEngageRange(0, 0, 10, 10), true);
  assert.equal(withinEngageRange(5, 5, 5 + ENGAGE_MAX_RANGE, 5), true);
});

test("engage rejects mobs beyond the max range (#62)", () => {
  assert.equal(withinEngageRange(0, 0, ENGAGE_MAX_RANGE + 0.01, 0), false);
  assert.equal(withinEngageRange(-80, 10, 80, 200), false);
});

test("engage rejects non-finite positions", () => {
  assert.equal(withinEngageRange(0, 0, Number.NaN, 0), false);
  assert.equal(withinEngageRange(0, 0, Number.POSITIVE_INFINITY, 0), false);
});
