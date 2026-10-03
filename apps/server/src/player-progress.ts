import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SavedStack = { tokenId: number; amount: number; starter?: boolean };

export type PlayerProgress = {
  version: 1;
  level: number;
  xp: number;
  inventory: SavedStack[];
  baseMats: Record<string, number>;
  equip: Record<string, number | null>;
  craftSkills: Record<string, { level: number; xp: number }>;
  learned: string[];
  skillUnlocked: string[];
  skillPoints: number;
  skillPrestige: number;
  freeStats: Record<string, number>;
  freeStatPoints: number;
  claimedStarter: boolean;
  dust: number;
  subjob: string | null;
  /** Spendable log items were copied into the bag and exported off the log. */
  logItemsMoved: boolean;
};

export function playerProgressPath(dataDir: string, charId: string): string {
  return join(dataDir, "players", charId + ".json");
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function isStack(value: unknown): value is SavedStack {
  if (!value || typeof value !== "object") return false;
  const row = value as { tokenId?: unknown; amount?: unknown; starter?: unknown };
  if (!Number.isSafeInteger(row.tokenId) || (row.tokenId as number) <= 0) return false;
  if (!Number.isSafeInteger(row.amount) || (row.amount as number) <= 0) return false;
  return row.starter === undefined || typeof row.starter === "boolean";
}

export function readPlayerProgress(path: string): PlayerProgress | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("character progress could not be read. Refusing to start from an empty character.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("character progress is not an object.");
  }
  const row = parsed as Partial<PlayerProgress>;
  if (row.version !== 1 || !Number.isSafeInteger(row.level) || (row.level as number) < 1) {
    throw new Error("character progress has no level.");
  }
  if (!Number.isSafeInteger(row.xp) || (row.xp as number) < 0) throw new Error("character progress has bad xp.");
  if (!Array.isArray(row.inventory) || !row.inventory.every(isStack)) {
    throw new Error("character progress has a bad bag.");
  }
  if (typeof row.logItemsMoved !== "boolean") throw new Error("character progress has no ledger flag.");
  return row as PlayerProgress;
}

export function writePlayerProgress(path: string, progress: PlayerProgress): void {
  atomicWrite(path, JSON.stringify(progress));
}

export function stacksFromLogItems(
  items: { tokenId: number; amount: string }[],
  slugOf: (tokenId: number) => string | null,
): { inventory: SavedStack[]; baseMats: Record<string, number> } {
  const inventory: SavedStack[] = [];
  const baseMats: Record<string, number> = {};
  for (const item of items) {
    const amount = Number(item.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    inventory.push({ tokenId: item.tokenId, amount });
    const slug = slugOf(item.tokenId);
    if (slug) baseMats[slug] = (baseMats[slug] ?? 0) + amount;
  }
  return { inventory, baseMats };
}

export function freshProgress(args: {
  level: number;
  items: { tokenId: number; amount: string }[];
  slugOf: (tokenId: number) => string | null;
  skillPoints: number;
  skillUnlocked: string[];
  craftSkills: PlayerProgress["craftSkills"];
  equip: PlayerProgress["equip"];
}): PlayerProgress {
  const bag = stacksFromLogItems(args.items, args.slugOf);
  return {
    version: 1,
    level: Math.max(1, args.level),
    xp: 0,
    inventory: bag.inventory,
    baseMats: bag.baseMats,
    equip: args.equip,
    craftSkills: args.craftSkills,
    learned: [],
    skillUnlocked: args.skillUnlocked,
    skillPoints: args.skillPoints,
    skillPrestige: 0,
    freeStats: { str: 0, dex: 0, vit: 0, agi: 0, int: 0, mnd: 0 },
    freeStatPoints: 0,
    claimedStarter: false,
    dust: 0,
    subjob: null,
    logItemsMoved: false,
  };
}

/**
 * First boot for a character with no save: copy the log's spendable items into the bag,
 * then export them off the log so a drop is not spendable twice. Later calls leave the bag alone.
 * Level stays the logged level. XP is not in the log, so a first save starts the level at 0 XP.
 */
export function reconcileCharacterProgress(args: {
  dir: string;
  chars: { charId: string; tokenId: string }[];
  levelOf: (tokenId: string) => number;
  itemsOf: (tokenId: string) => { tokenId: number; amount: string }[];
  exportItem: (tokenId: string, itemId: string, amount: string) => { ok: true } | { ok: false; error: string };
  skillPointsForLevel: (level: number) => number;
  skillUnlocked: (charId: string) => string[];
  slugOf: (tokenId: number) => string | null;
  craftSkills: () => PlayerProgress["craftSkills"];
  equip: () => PlayerProgress["equip"];
}): { charId: string; moved: number }[] {
  const moved: { charId: string; moved: number }[] = [];
  for (const row of args.chars) {
    const path = playerProgressPath(args.dir, row.charId);
    let progress = readPlayerProgress(path);
    if (!progress) {
      const level = Math.max(1, args.levelOf(row.tokenId));
      progress = freshProgress({
        level,
        items: args.itemsOf(row.tokenId),
        slugOf: args.slugOf,
        skillPoints: args.skillPointsForLevel(level),
        skillUnlocked: args.skillUnlocked(row.charId),
        craftSkills: args.craftSkills(),
        equip: args.equip(),
      });
      writePlayerProgress(path, progress);
    }
    if (progress.logItemsMoved) {
      moved.push({ charId: row.charId, moved: 0 });
      continue;
    }
    const items = args.itemsOf(row.tokenId);
    let ok = true;
    for (const item of items) {
      const res = args.exportItem(row.tokenId, String(item.tokenId), item.amount);
      if (!res.ok) ok = false;
    }
    if (!ok) {
      moved.push({ charId: row.charId, moved: 0 });
      continue;
    }
    progress.logItemsMoved = true;
    writePlayerProgress(path, progress);
    moved.push({ charId: row.charId, moved: items.length });
  }
  return moved;
}
