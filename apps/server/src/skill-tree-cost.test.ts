import assert from "node:assert/strict";
import test from "node:test";
import {
  JOB_IDS,
  SKILL_HUBS,
  SKILL_NODES,
  SKILL_NODE_COST,
  canUnlockSkillNode,
  freeSkillHubs,
  skillHubForJob,
  skillNodeCost,
  skillPointsAvailable,
  skillPointsEarned,
  skillPointsSpentOnTree,
} from "@bellgrave/combat";
import { hydrateSkillTree, type PlayerProgress } from "./player-progress";

const MAIN = "knight" as const;
const MAIN_HUB = skillHubForJob(MAIN);
const FOREIGN = JOB_IDS.find((j) => j !== MAIN && SKILL_NODES[SKILL_HUBS[j]]?.hub)!;
const FOREIGN_HUB = SKILL_HUBS[FOREIGN];
/** A normal node linked to the foreign heart. */
const FOREIGN_SPOKE = SKILL_NODES[FOREIGN_HUB]!.edges.find((e) => SKILL_NODES[e] && !SKILL_NODES[e]!.hub)!;
/** A normal node linked to the main heart. */
const MAIN_SPOKE = SKILL_NODES[MAIN_HUB]!.edges.find((e) => SKILL_NODES[e] && !SKILL_NODES[e]!.hub)!;

test("cost table: every heart is free, every other node costs 1, unknown ids cost 0", () => {
  for (const job of JOB_IDS) {
    const hub = SKILL_HUBS[job];
    if (!SKILL_NODES[hub]) continue;
    assert.equal(skillNodeCost(hub), 0, `${hub} should be free`);
  }
  for (const node of Object.values(SKILL_NODES)) {
    assert.equal(skillNodeCost(node.id), node.hub ? 0 : SKILL_NODE_COST, node.id);
  }
  assert.equal(skillNodeCost("not_a_node"), 0);
});

test("spent points come from the cost table and count each node once", () => {
  assert.ok(MAIN_SPOKE && FOREIGN_SPOKE, "fixture nodes exist");
  assert.equal(skillPointsSpentOnTree([MAIN_HUB]), 0);
  assert.equal(skillPointsSpentOnTree([MAIN_HUB, MAIN_SPOKE]), 1);
  assert.equal(skillPointsSpentOnTree([MAIN_HUB, MAIN_SPOKE, MAIN_SPOKE, "junk"]), 1);
  // A foreign heart never adds to spent, whatever the main/support job is.
  assert.equal(skillPointsSpentOnTree([MAIN_HUB, MAIN_SPOKE, FOREIGN_SPOKE, FOREIGN_HUB], MAIN, null), 2);
  assert.equal(skillPointsSpentOnTree([MAIN_HUB, MAIN_SPOKE, FOREIGN_SPOKE, FOREIGN_HUB], FOREIGN, MAIN), 2);
  // The "free hearts" list agrees with the cost table.
  for (const id of freeSkillHubs(MAIN, FOREIGN, [MAIN_HUB, FOREIGN_HUB])) {
    assert.equal(skillNodeCost(id), 0);
  }
});

test("unlocking a heart does not burn a point; remaining SP matches earned minus spent", () => {
  const level = 20;
  const earned = skillPointsEarned(level, 0);
  let unlocked = [MAIN_HUB];
  assert.equal(skillPointsAvailable(level, 0, unlocked), earned);

  // Paid spoke next to the foreign heart: 1 point.
  unlocked = [...unlocked, FOREIGN_SPOKE];
  assert.equal(skillPointsAvailable(level, 0, unlocked), earned - 1);

  // The heart is now reachable and costs nothing to open.
  assert.equal(canUnlockSkillNode(FOREIGN_HUB, new Set(unlocked)), true);
  assert.equal(skillNodeCost(FOREIGN_HUB), 0);
  unlocked = [...unlocked, FOREIGN_HUB];
  assert.equal(skillPointsAvailable(level, 0, unlocked), earned - 1);
  // UI "spent" and server "remaining" read the same table.
  assert.equal(skillPointsAvailable(level, 0, unlocked), earned - skillPointsSpentOnTree(unlocked));

  // Clearing the paid nodes (what respec does) gives every point back.
  const afterRespec = unlocked.filter((id) => skillNodeCost(id) === 0);
  assert.deepEqual(afterRespec, [MAIN_HUB, FOREIGN_HUB]);
  assert.equal(skillPointsAvailable(level, 0, afterRespec), earned);
});

test("a heart can be opened with 0 points left, a paid node cannot", () => {
  const earned1 = skillPointsEarned(1, 0);
  // Spend every level-1 point on paid nodes (not the fixture spokes).
  const paid = Object.values(SKILL_NODES)
    .filter((n) => !n.hub && n.id !== MAIN_SPOKE && n.id !== FOREIGN_SPOKE)
    .slice(0, earned1)
    .map((n) => n.id);
  const unlocked = [MAIN_HUB, ...paid];
  const left = skillPointsAvailable(1, 0, unlocked);
  assert.equal(left, 0);
  assert.ok(skillNodeCost(FOREIGN_HUB) <= left, "a heart needs no points");
  assert.ok(skillNodeCost(MAIN_SPOKE) > left, "a paid node needs a point");
  // Remaining never goes negative, even with more paid nodes than earned.
  assert.equal(skillPointsAvailable(1, 0, [...unlocked, MAIN_SPOKE, FOREIGN_SPOKE]), 0);
});

function progressWith(skillUnlocked: string[], skillPoints: number): PlayerProgress {
  return { skillUnlocked, skillPoints } as unknown as PlayerProgress;
}

test("log hydration prices nodes with the same table: hearts from the log cost nothing", () => {
  const isFree = (id: string) => skillNodeCost(id) === 0;
  const progress = progressWith([MAIN_HUB], 5);
  hydrateSkillTree(progress, [FOREIGN_SPOKE, FOREIGN_HUB], [MAIN_HUB], isFree);
  assert.deepEqual(progress.skillUnlocked, [MAIN_HUB, FOREIGN_SPOKE, FOREIGN_HUB]);
  assert.equal(progress.skillPoints, 4, "only the spoke is charged");

  const dropped = progressWith([MAIN_HUB, FOREIGN_SPOKE, FOREIGN_HUB], 4);
  hydrateSkillTree(dropped, [], [MAIN_HUB], isFree, [FOREIGN_SPOKE, FOREIGN_HUB]);
  assert.deepEqual(dropped.skillUnlocked, [MAIN_HUB]);
  assert.equal(dropped.skillPoints, 5, "only the spoke is refunded");
});
