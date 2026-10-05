import assert from "node:assert/strict";
import test from "node:test";
import { clockwindConversion } from "@bellgrave/combat";
import { pickDotKillCredit } from "./dot-credit";

const alice = { wallet: "0xAAA", targetId: null as string | null };
const bob = { wallet: "0xbbb", targetId: "mob1" as string | null };

test("#69 DoT kill credits the caster, not a bystander targeting the mob", () => {
  assert.equal(pickDotKillCredit("0xaaa", new Set<string>(), [bob, alice]), alice);
});

test("#69 DoT kill falls back to an online wallet that hit the mob", () => {
  assert.equal(pickDotKillCredit("0xgone", new Set(["0xbbb"]), [alice, bob]), bob);
});

test("#69 DoT kill with no online contributor credits nobody", () => {
  assert.equal(pickDotKillCredit(null, new Set<string>(), [bob]), null);
  assert.equal(pickDotKillCredit("0xgone", undefined, [bob]), null);
});

test("#68 Clockwind keeps TP it does not convert", () => {
  assert.deepEqual(clockwindConversion(3000, 0, 1000), { mpGained: 150, tpSpent: 1500 });
  assert.deepEqual(clockwindConversion(800, 0, 1000), { mpGained: 80, tpSpent: 800 });
  assert.deepEqual(clockwindConversion(3000, 950, 1000), { mpGained: 50, tpSpent: 500 });
  assert.deepEqual(clockwindConversion(3000, 1000, 1000), { mpGained: 0, tpSpent: 0 });
  assert.deepEqual(clockwindConversion(9, 0, 1000), { mpGained: 0, tpSpent: 0 });
});
