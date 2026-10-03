import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LokWorld } from "./lok-world";
import {
  hydrateLearnedFromLog,
  readPlayerProgress,
  reconcileCharacterProgress,
  shouldChargeForAbility,
  writePlayerProgress,
  type PlayerProgress,
} from "./player-progress";

function reconcileArgs(dir: string, world: LokWorld) {
  return {
    dir,
    chars: world.boundChars(),
    levelOf: (id: string) => world.levelOf(id),
    itemsOf: (id: string) => world.view(id).items,
    abilitiesOf: (id: string) => world.abilitiesOf(id),
    exportItem: (id: string, itemId: string, amount: string) => world.exportItem(id, itemId, amount),
    skillPointsForLevel: (level: number) => level,
    skillUnlocked: () => ["time_mage_0"],
    slugOf: (id: number) => (id === 1057 ? "pale-dust" : null),
    craftSkills: () => ({ weaving: { level: 1, xp: 0 } }),
    equip: () => ({ main: null, body: null }),
  };
}

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

  const moved = reconcileCharacterProgress(reconcileArgs(dir, reloaded));
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
  const twice = reconcileCharacterProgress(reconcileArgs(dir, again));
  assert.equal(twice[0]?.moved, 0);
  const still = readPlayerProgress(join(dir, "players", "char-w.json"));
  assert.equal(still?.inventory[0]?.amount, 1);
  assert.equal(still?.level, 2);
});

test("learned abilities hydrate from the log after a save drops them", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-learned-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-a", "Ada", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  assert.equal(lok.learnAbility(token, "fire").ok, true);
  assert.equal(lok.hasAbility(token, "fire"), true);

  const first = reconcileCharacterProgress(reconcileArgs(dir, lok));
  assert.ok((first[0]?.learned ?? 0) >= 1);
  const saved = readPlayerProgress(join(dir, "players", "char-a.json"));
  assert.ok(saved);
  if (!saved) return;
  assert.ok(saved.learned.includes("fire"));

  // Simulate a broken save that forgot learned after migration already finished.
  saved.learned = [];
  writePlayerProgress(join(dir, "players", "char-a.json"), saved);
  assert.equal(saved.logItemsMoved, true);

  const again = LokWorld.open(dir, undefined, {});
  const restored = reconcileCharacterProgress(reconcileArgs(dir, again));
  assert.equal(restored[0]?.moved, 0);
  assert.ok((restored[0]?.learned ?? 0) >= 1);
  const fixed = readPlayerProgress(join(dir, "players", "char-a.json"));
  assert.ok(fixed?.learned.includes("fire"));
  assert.equal(fixed?.inventory.length ?? 0, 0);
  // Duplicate learn on the log is rejected; buying must not charge again.
  assert.equal(again.learnAbility(token, "fire").ok, false);
  assert.equal(shouldChargeForAbility(fixed!.learned, again.hasAbility(token, "fire"), "fire"), false);
  assert.equal(shouldChargeForAbility([], again.hasAbility(token, "fire"), "fire"), false);
});

test("partial item migration copies remaining log stacks before export", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-partial-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-p", "Pip", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  assert.equal(lok.itemDrop(token, "1057", "2").ok, true);

  // Existing save: migration not finished, bag empty, copy flag false (resume must copy first).
  const empty: PlayerProgress = {
    version: 1,
    level: 1,
    xp: 0,
    inventory: [],
    baseMats: {},
    equip: { main: null },
    craftSkills: { weaving: { level: 1, xp: 0 } },
    learned: [],
    skillUnlocked: ["time_mage_0"],
    skillPoints: 1,
    skillPrestige: 0,
    freeStats: { str: 0, dex: 0, vit: 0, agi: 0, int: 0, mnd: 0 },
    freeStatPoints: 0,
    claimedStarter: false,
    dust: 0,
    subjob: null,
    logItemsMoved: false,
    logItemsCopied: false,
  };
  mkdirSync(join(dir, "players"), { recursive: true });
  writeFileSync(join(dir, "players", "char-p.json"), JSON.stringify(empty));

  let exports = 0;
  const args = reconcileArgs(dir, lok);
  const result = reconcileCharacterProgress({
    ...args,
    exportItem: (id, itemId, amount) => {
      exports += 1;
      return lok.exportItem(id, itemId, amount);
    },
  });
  assert.equal(result[0]?.moved, 1);
  assert.equal(exports, 1);
  const saved = readPlayerProgress(join(dir, "players", "char-p.json"));
  assert.equal(saved?.logItemsMoved, true);
  assert.equal(saved?.logItemsCopied, true);
  assert.equal(saved?.inventory[0]?.tokenId, 1057);
  assert.equal(saved?.inventory[0]?.amount, 2);
  assert.equal(lok.itemOf(token, "1057"), "0");

  // Second reconcile must not double-grant.
  const twice = reconcileCharacterProgress(reconcileArgs(dir, lok));
  assert.equal(twice[0]?.moved, 0);
  const still = readPlayerProgress(join(dir, "players", "char-p.json"));
  assert.equal(still?.inventory[0]?.amount, 2);
});

test("legacy in-progress migration does not double-grant bag items", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-legacy-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-l", "Len", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  assert.equal(lok.itemDrop(token, "1057", "1").ok, true);

  // #174-style save: bag already has the copy, flag missing, export still pending.
  const legacy: PlayerProgress = {
    version: 1,
    level: 1,
    xp: 0,
    inventory: [{ tokenId: 1057, amount: 1 }],
    baseMats: { "pale-dust": 1 },
    equip: { main: null },
    craftSkills: { weaving: { level: 1, xp: 0 } },
    learned: [],
    skillUnlocked: ["time_mage_0"],
    skillPoints: 1,
    skillPrestige: 0,
    freeStats: { str: 0, dex: 0, vit: 0, agi: 0, int: 0, mnd: 0 },
    freeStatPoints: 0,
    claimedStarter: false,
    dust: 0,
    subjob: null,
    logItemsMoved: false,
  };
  mkdirSync(join(dir, "players"), { recursive: true });
  writeFileSync(join(dir, "players", "char-l.json"), JSON.stringify(legacy));

  reconcileCharacterProgress(reconcileArgs(dir, lok));
  const saved = readPlayerProgress(join(dir, "players", "char-l.json"));
  assert.equal(saved?.inventory[0]?.amount, 1);
  assert.equal(saved?.logItemsMoved, true);
  assert.equal(lok.itemOf(token, "1057"), "0");
});

test("hydrateLearnedFromLog is idempotent and shouldChargeForAbility guards duplicates", () => {
  const progress: PlayerProgress = {
    version: 1,
    level: 5,
    xp: 0,
    inventory: [],
    baseMats: {},
    equip: {},
    craftSkills: {},
    learned: [],
    skillUnlocked: [],
    skillPoints: 0,
    skillPrestige: 0,
    freeStats: {},
    freeStatPoints: 0,
    claimedStarter: false,
    dust: 0,
    subjob: null,
    logItemsMoved: true,
  };
  assert.equal(hydrateLearnedFromLog(progress, ["fire", "fire", "stone"]), 2);
  assert.equal(hydrateLearnedFromLog(progress, ["fire", "stone"]), 0);
  assert.deepEqual(progress.learned, ["fire", "stone"]);
  assert.equal(shouldChargeForAbility(progress.learned, false, "fire"), false);
  assert.equal(shouldChargeForAbility([], true, "fire"), false);
  assert.equal(shouldChargeForAbility([], false, "fire"), true);
});
