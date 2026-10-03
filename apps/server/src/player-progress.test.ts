import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LokWorld } from "./lok-world";
import { readPlayerProgress, reconcileCharacterProgress } from "./player-progress";

test("a levelUp and an itemDrop survive a reload the same way the character does", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-progress-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-w", "Wyn", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  assert.equal(lok.levelUp(token, 2).ok, true);
  assert.equal(lok.itemDrop(token, "1057", "1").ok, true);

  const reloaded = LokWorld.open(dir, undefined, {});
  assert.equal(reloaded.levelOf(token), 2);
  assert.equal(reloaded.itemOf(token, "1057"), "1");

  const moved = reconcileCharacterProgress({
    dir,
    chars: reloaded.boundChars(),
    levelOf: (id) => reloaded.levelOf(id),
    itemsOf: (id) => reloaded.view(id).items,
    exportItem: (id, itemId, amount) => reloaded.exportItem(id, itemId, amount),
    skillPointsForLevel: (level) => level,
    skillUnlocked: () => ["time_mage_0"],
    slugOf: (id) => (id === 1057 ? "pale-dust" : null),
    craftSkills: () => ({ weaving: { level: 1, xp: 0 } }),
    equip: () => ({ main: null, body: null }),
  });
  assert.equal(moved[0]?.moved, 1);
  assert.equal(reloaded.levelOf(token), 2);
  assert.equal(reloaded.itemOf(token, "1057"), "0");

  const saved = readPlayerProgress(join(dir, "players", "char-w.json"));
  assert.ok(saved);
  if (!saved) return;
  assert.equal(saved.level, 2);
  assert.equal(saved.xp, 0);
  assert.equal(saved.inventory.length, 1);
  assert.equal(saved.inventory[0]?.tokenId, 1057);
  assert.equal(saved.inventory[0]?.amount, 1);
  assert.equal(saved.baseMats["pale-dust"], 1);
  assert.equal(saved.logItemsMoved, true);

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.levelOf(token), 2);
  assert.equal(again.itemOf(token, "1057"), "0");
  const twice = reconcileCharacterProgress({
    dir,
    chars: again.boundChars(),
    levelOf: (id) => again.levelOf(id),
    itemsOf: (id) => again.view(id).items,
    exportItem: (id, itemId, amount) => again.exportItem(id, itemId, amount),
    skillPointsForLevel: (level) => level,
    skillUnlocked: () => ["time_mage_0"],
    slugOf: (id) => (id === 1057 ? "pale-dust" : null),
    craftSkills: () => ({ weaving: { level: 1, xp: 0 } }),
    equip: () => ({ main: null, body: null }),
  });
  assert.equal(twice[0]?.moved, 0);
  const still = readPlayerProgress(join(dir, "players", "char-w.json"));
  assert.equal(still?.inventory[0]?.amount, 1);
  assert.equal(still?.level, 2);
});
