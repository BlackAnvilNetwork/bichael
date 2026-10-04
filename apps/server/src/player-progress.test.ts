import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LokWorld } from "./lok-world";
import {
  chargeSkillRespec,
  hydrateCraftSkills,
  hydrateLearnedFromLog,
  hydrateSkillTree,
  readPlayerProgress,
  reconcileCharacterProgress,
  rememberLedger,
  RESPEC_KEK_COST,
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


test("a failed export does not drop a stack that arrives on the next boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-gap-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-g", "Gap", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  assert.equal(lok.itemDrop(token, "7", "1").ok, true);
  assert.equal(lok.itemDrop(token, "8", "1").ok, true);

  let failEight = true;
  const args = reconcileArgs(dir, lok);
  reconcileCharacterProgress({
    ...args,
    exportItem: (id, itemId, amount) => {
      if (itemId === "8" && failEight) return { ok: false, error: "export failed" };
      return lok.exportItem(id, itemId, amount);
    },
  });
  const mid = readPlayerProgress(join(dir, "players", "char-g.json"));
  assert.equal(mid?.logItemsMoved, false);
  assert.equal(mid?.inventory.find((row) => row.tokenId === 7)?.amount, 1);
  assert.equal(mid?.inventory.find((row) => row.tokenId === 8)?.amount, 1);
  assert.equal(lok.itemOf(token, "7"), "0");
  assert.equal(lok.itemOf(token, "8"), "1");

  assert.equal(lok.itemDrop(token, "9", "1").ok, true);
  failEight = false;
  reconcileCharacterProgress(reconcileArgs(dir, lok));
  const saved = readPlayerProgress(join(dir, "players", "char-g.json"));
  assert.equal(saved?.logItemsMoved, true);
  assert.equal(saved?.inventory.find((row) => row.tokenId === 7)?.amount, 1);
  assert.equal(saved?.inventory.find((row) => row.tokenId === 8)?.amount, 1);
  assert.equal(saved?.inventory.find((row) => row.tokenId === 9)?.amount, 1);
  assert.equal(lok.itemOf(token, "9"), "0");
  reconcileCharacterProgress(reconcileArgs(dir, lok));
  const still = readPlayerProgress(join(dir, "players", "char-g.json"));
  assert.equal(still?.inventory.find((row) => row.tokenId === 7)?.amount, 1);
  assert.equal(still?.inventory.find((row) => row.tokenId === 8)?.amount, 1);
  assert.equal(still?.inventory.find((row) => row.tokenId === 9)?.amount, 1);
});

test("craft levels keep the higher of the save and the log and do not invent one", () => {
  const progress: PlayerProgress = {
    version: 1,
    level: 1,
    xp: 12,
    inventory: [],
    baseMats: {},
    equip: {},
    craftSkills: { weaving: { level: 4, xp: 9 } },
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
  assert.equal(hydrateCraftSkills(progress, [{ skillId: "weaving", level: 2 }, { skillId: "smithing", level: 3 }]), 1);
  assert.equal(progress.craftSkills.weaving?.level, 4);
  assert.equal(progress.craftSkills.weaving?.xp, 9);
  assert.equal(progress.craftSkills.smithing?.level, 3);
  assert.equal(progress.craftSkills.smithing?.xp, 0);
  assert.equal(hydrateCraftSkills(progress, [{ skillId: "alchemy", level: 0 }]), 0);
  assert.equal(progress.craftSkills.alchemy, undefined);
});

test("a skill tree the log has not recorded is not wiped or refunded", () => {
  const progress: PlayerProgress = {
    version: 1,
    level: 3,
    xp: 0,
    inventory: [],
    baseMats: {},
    equip: {},
    craftSkills: {},
    learned: [],
    skillUnlocked: ["time_mage_0", "node_a"],
    skillPoints: 2,
    skillPrestige: 0,
    freeStats: {},
    freeStatPoints: 0,
    claimedStarter: false,
    dust: 0,
    subjob: null,
    logItemsMoved: true,
  };
  assert.equal(hydrateSkillTree(progress, [], ["time_mage_0"], (id) => id === "time_mage_0", []), false);
  assert.deepEqual(progress.skillUnlocked, ["time_mage_0", "node_a"]);
  assert.equal(progress.skillPoints, 2);
  assert.equal(hydrateSkillTree(progress, ["node_b"], ["time_mage_0"], (id) => id === "time_mage_0", []), true);
  assert.ok(progress.skillUnlocked.includes("node_b"));
  assert.equal(progress.skillPoints, 1);
  assert.equal(hydrateSkillTree(progress, [], ["time_mage_0"], (id) => id === "time_mage_0", ["node_a", "node_b"]), true);
  assert.deepEqual(progress.skillUnlocked, ["time_mage_0"]);
  assert.equal(progress.skillPoints, 3);
});

test("respec spends nothing when the tree has no paid nodes or the balance is short", async () => {
  let spent = 0;
  let recorded = 0;
  const empty = await chargeSkillRespec({
    charId: "respec-empty",
    paidNodes: () => [],
    earnedPoints: 4,
    kept: () => ["hub"],
    payAndClear: async (amount) => {
      spent += amount;
      recorded += 1;
      return { ok: true };
    },
    apply: () => {},
  });
  assert.equal(empty.ok, false);
  assert.equal(spent, 0);
  assert.equal(recorded, 0);

  const short = await chargeSkillRespec({
    charId: "respec-short",
    paidNodes: () => ["node_a"],
    earnedPoints: 4,
    kept: () => ["hub"],
    payAndClear: async () => ({ ok: false, error: "Need 10000 KEK (you have 3)." }),
    apply: () => {
      throw new Error("apply");
    },
  });
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /10000/);
  assert.equal(recorded, 0);
  assert.equal(RESPEC_KEK_COST, 10000);
});

test("one respec at a time and a second call does not spend again", async () => {
  let nodes = ["hub", "node_a"];
  let spent = 0;
  const run = () =>
    chargeSkillRespec({
      charId: "respec-once",
      paidNodes: () => nodes.filter((id) => id !== "hub"),
      earnedPoints: 6,
      kept: (clearIds) => nodes.filter((id) => !clearIds.includes(id)),
      payAndClear: async (amount) => {
        spent += amount;
        return { ok: true };
      },
      apply: (unlocked) => {
        nodes = unlocked;
      },
    });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(spent, 10000);
  assert.deepEqual(nodes, ["hub"]);
});

test("rememberLedger skips an unchanged player and refuses a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-ledger-"));
  const path = join(dir, "char.json");
  const build = (flags: { logItemsMoved: boolean; logItemsCopied: boolean }) => ({
    version: 1 as const,
    level: 1,
    xp: 0,
    inventory: [],
    baseMats: {},
    equip: {},
    craftSkills: {},
    learned: [] as string[],
    skillUnlocked: ["time_mage_0"],
    skillPoints: 1,
    skillPrestige: 0,
    freeStats: {},
    freeStatPoints: 0,
    claimedStarter: false,
    dust: 0,
    subjob: null,
    logItemsMoved: flags.logItemsMoved,
    logItemsCopied: flags.logItemsCopied,
  });
  assert.equal(rememberLedger(path, build), true);
  assert.equal(rememberLedger(path, build), false);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{");
  assert.throws(() => rememberLedger(bad, build));
  assert.equal(readFileSync(bad, "utf8"), "{");
});

test("payAndClear failure spends nothing and does not apply", async () => {
  let applied = false;
  let calls = 0;
  const failed = await chargeSkillRespec({
    charId: "respec-atomic",
    paidNodes: () => ["node_a"],
    earnedPoints: 4,
    kept: () => ["hub"],
    payAndClear: async () => {
      calls += 1;
      return { ok: false, error: "log write failed" };
    },
    apply: () => {
      applied = true;
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(calls, 1);
  assert.equal(applied, false);
});
