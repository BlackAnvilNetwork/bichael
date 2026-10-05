import assert from "node:assert/strict";
import test from "node:test";
import { PH_ALL_NODES, clampPaleHollow, paleHollowWalkable } from "@bellgrave/config";
import {
  GATHER_MIN_CHANNEL_MS,
  GATHER_RANGE,
  beginGatherChannel,
  tickGatherChannel,
} from "./gather-channel";
import { createPaleHollowNodes, gatherSpawnPool, relocateGatherNode } from "./pale-hollow-world";

const node = { id: "ph-live-0", spawnPointId: "ph-farm-a", name: "Dustgrain Patch", interactMs: 2500 };

test("gather does not complete before interactMs elapses", () => {
  const ch = beginGatherChannel(node, { x: 1, z: 2, hp: 100 }, 1_000);
  const still = { x: 1, z: 2, hp: 100, engaged: false };
  assert.equal(ch.readyAt, 3_500);
  assert.deepEqual(tickGatherChannel(ch, still, 1_000), { kind: "pending" });
  assert.deepEqual(tickGatherChannel(ch, still, 3_499), { kind: "pending" });
  assert.deepEqual(tickGatherChannel(ch, still, 3_500), { kind: "complete" });
});

test("tiny or invalid interactMs still requires a minimum channel", () => {
  const ch = beginGatherChannel({ ...node, interactMs: 0 }, { x: 0, z: 0, hp: 10 }, 0);
  assert.equal(ch.readyAt, GATHER_MIN_CHANNEL_MS);
  const nan = beginGatherChannel({ ...node, interactMs: Number.NaN }, { x: 0, z: 0, hp: 10 }, 0);
  assert.equal(nan.readyAt, GATHER_MIN_CHANNEL_MS);
});

test("moving, taking damage, or engaging breaks the channel", () => {
  const moved = beginGatherChannel(node, { x: 0, z: 0, hp: 100 }, 0);
  assert.equal(tickGatherChannel(moved, { x: 1, z: 0, hp: 100, engaged: false }, 3_000).kind, "cancel");

  const hit = beginGatherChannel(node, { x: 0, z: 0, hp: 100 }, 0);
  assert.equal(tickGatherChannel(hit, { x: 0, z: 0, hp: 99, engaged: false }, 100).kind, "cancel");

  const engaged = beginGatherChannel(node, { x: 0, z: 0, hp: 100 }, 0);
  assert.equal(tickGatherChannel(engaged, { x: 0, z: 0, hp: 100, engaged: true }, 100).kind, "cancel");
});

test("damage after regen still breaks the channel", () => {
  const ch = beginGatherChannel(node, { x: 0, z: 0, hp: 50 }, 0);
  assert.equal(tickGatherChannel(ch, { x: 0, z: 0, hp: 60, engaged: false }, 100).kind, "pending");
  assert.equal(tickGatherChannel(ch, { x: 0, z: 0, hp: 55, engaged: false }, 200).kind, "cancel");
});

function standable(x: number, z: number): boolean {
  if (paleHollowWalkable(x, z)) return true;
  for (let r = 0.4; r <= GATHER_RANGE - 0.2; r += 0.3) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const sx = x + Math.sin(a) * r;
      const sz = z + Math.cos(a) * r;
      const c = clampPaleHollow(sx, sz);
      if (Math.abs(c.x - sx) < 1e-6 && Math.abs(c.z - sz) < 1e-6 && paleHollowWalkable(sx, sz)) return true;
    }
  }
  return false;
}

test("every gather spawn point sits on walkable ground (#74)", () => {
  const pool = gatherSpawnPool();
  assert.ok(pool.length >= Math.floor(PH_ALL_NODES.length * 0.8), `pool shrank to ${pool.length}`);
  for (const p of pool) {
    assert.ok(paleHollowWalkable(p.x, p.z), `${p.id} at (${p.x}, ${p.z}) is not walkable`);
    assert.ok(standable(p.x, p.z), `${p.id} cannot be reached`);
  }
});

test("live and relocated gather nodes stay on walkable ground (#74)", () => {
  const nodes = createPaleHollowNodes();
  for (const n of nodes) assert.ok(paleHollowWalkable(n.x, n.z), `${n.id}@${n.spawnPointId} unwalkable`);
  for (let i = 0; i < 200; i++) {
    const n = nodes[i % nodes.length]!;
    relocateGatherNode(nodes, n, 1);
    assert.ok(paleHollowWalkable(n.x, n.z), `relocated ${n.id}@${n.spawnPointId} unwalkable`);
  }
});
