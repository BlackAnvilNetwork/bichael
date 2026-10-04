import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withPlayerCharge } from "./kek-guard";

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
  /**
   * One-time copy from the log into the bag finished. Export may still be pending.
   * Missing on saves from the first migration: those already copied before export.
   */
  logItemsCopied?: boolean;
  /**
   * Log amount already mirrored into the bag for each token still expected on the log.
   * Later passes copy only the difference, so a stack that arrives after a partial export is not dropped.
   */
  logCopied?: Record<string, number>;
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
  if (!Array.isArray(row.learned)) throw new Error("character progress has bad learned abilities.");
  if (row.logItemsCopied !== undefined && typeof row.logItemsCopied !== "boolean") {
    throw new Error("character progress has a bad copy flag.");
  }
  if (row.logCopied !== undefined) {
    if (!row.logCopied || typeof row.logCopied !== "object" || Array.isArray(row.logCopied)) {
      throw new Error("character progress has a bad copy ledger.");
    }
    for (const [key, value] of Object.entries(row.logCopied as Record<string, unknown>)) {
      if (!/^\d+$/.test(key) || !Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error("character progress has a bad copy ledger.");
      }
    }
  }
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

/** Merge log stacks into an existing bag without replacing starter-flagged rows. */
export function mergeLogItemsIntoBag(
  progress: PlayerProgress,
  items: { tokenId: number; amount: string }[],
  slugOf: (tokenId: number) => string | null,
): number {
  let added = 0;
  for (const item of items) {
    const amount = Number(item.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    const row = progress.inventory.find((slot) => slot.tokenId === item.tokenId && !slot.starter);
    if (row) row.amount += amount;
    else progress.inventory.push({ tokenId: item.tokenId, amount });
    const slug = slugOf(item.tokenId);
    if (slug) progress.baseMats[slug] = (progress.baseMats[slug] ?? 0) + amount;
    added += 1;
  }
  return added;
}

/**
 * Union trainer ability ids from the per-character log into `learned`.
 * Does not invent craft XP, equipment, or Dust. Returns true when the save changed.
 */
export function hydrateLearnedFromLog(progress: PlayerProgress, abilityIds: string[]): number {
  let added = 0;
  const have = new Set(progress.learned);
  for (const id of abilityIds) {
    if (!id || have.has(id)) continue;
    progress.learned.push(id);
    have.add(id);
    added += 1;
  }
  return added;
}

/**
 * True when buying this ability should debit KEK.
 * Already in `learned` or already on the character log must not charge again.
 */
export function shouldChargeForAbility(learned: readonly string[], logKnows: boolean, abilityId: string): boolean {
  if (!abilityId) return false;
  if (learned.includes(abilityId)) return false;
  if (logKnows) return false;
  return true;
}

export function freshProgress(args: {
  level: number;
  items: { tokenId: number; amount: string }[];
  slugOf: (tokenId: number) => string | null;
  skillPoints: number;
  skillUnlocked: string[];
  craftSkills: PlayerProgress["craftSkills"];
  equip: PlayerProgress["equip"];
  learned?: string[];
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
    learned: [...(args.learned ?? [])],
    skillUnlocked: args.skillUnlocked,
    skillPoints: args.skillPoints,
    skillPrestige: 0,
    freeStats: { str: 0, dex: 0, vit: 0, agi: 0, int: 0, mnd: 0 },
    freeStatPoints: 0,
    claimedStarter: false,
    dust: 0,
    subjob: null,
    logItemsMoved: false,
    logItemsCopied: true,
  };
}

function bagPlainAmount(progress: PlayerProgress, tokenId: number): number {
  let total = 0;
  for (const slot of progress.inventory) {
    if (slot.tokenId === tokenId && !slot.starter) total += slot.amount;
  }
  return total;
}

function mirroredOf(progress: PlayerProgress, tokenId: number, logAmount: number): number {
  const key = String(tokenId);
  if (progress.logCopied && Object.prototype.hasOwnProperty.call(progress.logCopied, key)) {
    return progress.logCopied[key] ?? 0;
  }
  if (progress.logItemsCopied !== false) {
    const have = bagPlainAmount(progress, tokenId);
    if (have > 0) return Math.min(have, logAmount);
  }
  return 0;
}

function noteMirrored(progress: PlayerProgress, tokenId: number, amount: number): void {
  if (!progress.logCopied) progress.logCopied = {};
  progress.logCopied[String(tokenId)] = amount;
}

function releaseMirrored(progress: PlayerProgress, tokenId: number, exported: number): void {
  const key = String(tokenId);
  const prev =
    progress.logCopied && Object.prototype.hasOwnProperty.call(progress.logCopied, key)
      ? (progress.logCopied[key] ?? 0)
      : exported;
  if (!progress.logCopied) progress.logCopied = {};
  progress.logCopied[key] = Math.max(0, prev - exported);
}

export function hydrateCraftSkills(
  progress: PlayerProgress,
  levels: { skillId: string; level: number }[],
): number {
  let changed = 0;
  for (const row of levels) {
    if (!row.skillId || !Number.isSafeInteger(row.level) || row.level < 1) continue;
    const cur = progress.craftSkills[row.skillId];
    const curLv = cur?.level ?? 1;
    if (row.level <= curLv) continue;
    progress.craftSkills[row.skillId] = { level: row.level, xp: cur?.xp ?? 0 };
    changed += 1;
  }
  return changed;
}

/** Log skill nodes are the tree. Points move with the nodes so a rebuild does not refund them all. */
export function hydrateSkillTree(
  progress: PlayerProgress,
  logNodes: readonly string[],
  freeHubs: readonly string[],
  isFreeNode: (id: string) => boolean,
  dropped: readonly string[] = [],
): boolean {
  const drop = new Set(dropped);
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of progress.skillUnlocked) {
    if (!id || drop.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of [...freeHubs, ...logNodes]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  const prev = new Set(progress.skillUnlocked);
  let addedPaid = 0;
  let removedPaid = 0;
  for (const id of next) {
    if (!prev.has(id) && !isFreeNode(id)) addedPaid += 1;
  }
  for (const id of progress.skillUnlocked) {
    if (!seen.has(id) && !isFreeNode(id)) removedPaid += 1;
  }
  const same =
    next.length === progress.skillUnlocked.length && next.every((id, i) => progress.skillUnlocked[i] === id);
  progress.skillUnlocked = next;
  if (addedPaid !== 0 || removedPaid !== 0) {
    progress.skillPoints = Math.max(0, progress.skillPoints - addedPaid + removedPaid);
  }
  return !same || addedPaid !== 0 || removedPaid !== 0;
}

export const RESPEC_KEK_COST = 10_000;

export async function chargeSkillRespec(args: {
  charId: string;
  paidNodes: () => string[];
  earnedPoints: number;
  kept: (clearIds: readonly string[]) => string[];
  /** One call that debits KEK and clears the tree together (or fails without spending). */
  payAndClear: (amount: number, nodeIds: string[]) => Promise<{ ok: true } | { ok: false; error: string }>;
  apply: (unlocked: string[], skillPoints: number) => void;
}): Promise<{ ok: true; unlocked: string[]; skillPoints: number } | { ok: false; error: string }> {
  let clearIds: string[] = [];
  let outcome: { ok: true; unlocked: string[]; skillPoints: number } | { ok: false; error: string } | null = null;
  const charged = await withPlayerCharge(
    args.charId,
    () => {
      clearIds = args.paidNodes();
      return clearIds.length > 0;
    },
    () => () => {},
    () => args.payAndClear(RESPEC_KEK_COST, clearIds),
    () => {
      const unlocked = args.kept(clearIds);
      args.apply(unlocked, args.earnedPoints);
      outcome = { ok: true, unlocked, skillPoints: args.earnedPoints };
    },
  );
  if (!charged.ok) return charged;
  return outcome ?? { ok: false, error: "Respec was not written to the log." };
}

type LedgerFlags = {
  logItemsMoved: boolean;
  logItemsCopied: boolean;
  logCopied?: Record<string, number>;
};

const ledgerByPath = new Map<string, { flags: LedgerFlags; text: string | null }>();

function flagsFrom(prev: PlayerProgress | null): LedgerFlags {
  return {
    logItemsMoved: prev?.logItemsMoved ?? true,
    logItemsCopied: prev?.logItemsCopied ?? true,
    ...(prev?.logCopied ? { logCopied: { ...prev.logCopied } } : {}),
  };
}

/** Keep the ledger flags in memory. Write only when the snapshot changed. A corrupt file throws and is not replaced. */
export function rememberLedger(path: string, build: (flags: LedgerFlags) => PlayerProgress): boolean {
  let slot = ledgerByPath.get(path);
  if (!slot) {
    const prev = readPlayerProgress(path);
    slot = { flags: flagsFrom(prev), text: null };
    ledgerByPath.set(path, slot);
  }
  const progress = build(slot.flags);
  const text = JSON.stringify(progress);
  if (slot.text === null && existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    if (raw === text) {
      slot.text = text;
      return false;
    }
  }
  if (slot.text === text) return false;
  writePlayerProgress(path, progress);
  slot.text = text;
  slot.flags = flagsFrom(progress);
  return true;
}

/**
 * First boot for a character with no save: copy the log's spendable items into the bag,
 * then export them off the log so a drop is not spendable twice.
 * Every later pass copies any stack that is about to leave the log and was not copied yet.
 * Level stays the logged level. XP is not in the log, so a first save starts the level at 0 XP.
 * Learned trainer abilities, skill-tree nodes, and craft skill levels hydrate from the log,
 * including after a prior item migration. Craft XP is not invented.
 */
export function reconcileCharacterProgress(args: {
  dir: string;
  chars: { charId: string; tokenId: string }[];
  levelOf: (tokenId: string) => number;
  itemsOf: (tokenId: string) => { tokenId: number; amount: string }[];
  abilitiesOf: (tokenId: string) => string[];
  exportItem: (tokenId: string, itemId: string, amount: string) => { ok: true } | { ok: false; error: string };
  skillPointsForLevel: (level: number) => number;
  skillUnlocked: (charId: string) => string[];
  slugOf: (tokenId: number) => string | null;
  craftSkills: () => PlayerProgress["craftSkills"];
  equip: () => PlayerProgress["equip"];
  craftSkillsOf?: (tokenId: string) => { skillId: string; level: number }[];
  isLearnedAbility?: (id: string) => boolean;
  isSkillNode?: (id: string) => boolean;
  isFreeNode?: (id: string) => boolean;
  freeHubsOf?: (charId: string, progress: PlayerProgress) => string[];
  droppedOf?: (tokenId: string) => string[];
  recordNode?: (tokenId: string, nodeId: string) => { ok: true } | { ok: false; error: string };
  recordCraft?: (tokenId: string, skillId: string, level: number) => { ok: true } | { ok: false; error: string };
}): { charId: string; moved: number; learned: number }[] {
  const moved: { charId: string; moved: number; learned: number }[] = [];
  for (const row of args.chars) {
    const path = playerProgressPath(args.dir, row.charId);
    const rawAbilities = args.abilitiesOf(row.tokenId);
    const learnedIds = rawAbilities.filter((id) => {
      if (args.isSkillNode?.(id)) return false;
      if (args.isLearnedAbility) return args.isLearnedAbility(id);
      return true;
    });
    const skillNodes = args.isSkillNode ? rawAbilities.filter((id) => args.isSkillNode!(id)) : [];
    let progress = readPlayerProgress(path);
    let learnedAdded = 0;
    let dirty = false;
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
        learned: learnedIds,
      });
      learnedAdded = progress.learned.length;
      dirty = true;
    } else {
      learnedAdded = hydrateLearnedFromLog(progress, learnedIds);
      if (learnedAdded > 0) dirty = true;
    }
    const loggedCraft = args.craftSkillsOf?.(row.tokenId) ?? [];
    if (hydrateCraftSkills(progress, loggedCraft) > 0) dirty = true;
    if (args.recordCraft) {
      const loggedLevel = new Map(loggedCraft.map((rowSkill) => [rowSkill.skillId, rowSkill.level]));
      for (const [skillId, rowSkill] of Object.entries(progress.craftSkills)) {
        if (rowSkill.level <= 1) continue;
        if (rowSkill.level <= (loggedLevel.get(skillId) ?? 0)) continue;
        args.recordCraft(row.tokenId, skillId, rowSkill.level);
      }
    }
    const dropped = args.droppedOf?.(row.tokenId) ?? [];
    const droppedSet = new Set(dropped);
    if (args.recordNode && args.isSkillNode) {
      for (const id of progress.skillUnlocked) {
        if (!args.isSkillNode(id) || skillNodes.includes(id) || droppedSet.has(id)) continue;
        const recorded = args.recordNode(row.tokenId, id);
        if (recorded.ok) skillNodes.push(id);
      }
    }
    if (args.isSkillNode || args.freeHubsOf || dropped.length > 0) {
      const freeHubs = args.freeHubsOf?.(row.charId, progress) ?? [];
      const isFree = args.isFreeNode ?? ((id: string) => freeHubs.includes(id));
      if (hydrateSkillTree(progress, skillNodes, freeHubs, isFree, dropped)) dirty = true;
    }
    if (dirty) writePlayerProgress(path, progress);

    if (progress.logItemsMoved) {
      moved.push({ charId: row.charId, moved: 0, learned: learnedAdded });
      continue;
    }

    const items = args.itemsOf(row.tokenId);
    let ok = true;
    let exported = 0;
    for (const item of items) {
      const amount = Number(item.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        ok = false;
        continue;
      }
      const mirrored = mirroredOf(progress, item.tokenId, amount);
      const delta = amount - mirrored;
      if (delta > 0) {
        mergeLogItemsIntoBag(progress, [{ tokenId: item.tokenId, amount: String(delta) }], args.slugOf);
        noteMirrored(progress, item.tokenId, amount);
        progress.logItemsCopied = true;
        writePlayerProgress(path, progress);
      }
      const res = args.exportItem(row.tokenId, String(item.tokenId), item.amount);
      if (!res.ok) {
        ok = false;
        continue;
      }
      releaseMirrored(progress, item.tokenId, amount);
      exported += 1;
      writePlayerProgress(path, progress);
    }
    if (!ok) {
      if (progress.logItemsCopied !== true) {
        progress.logItemsCopied = true;
        writePlayerProgress(path, progress);
      }
      moved.push({ charId: row.charId, moved: 0, learned: learnedAdded });
      continue;
    }
    progress.logItemsMoved = true;
    progress.logItemsCopied = true;
    writePlayerProgress(path, progress);
    moved.push({ charId: row.charId, moved: exported, learned: learnedAdded });
  }
  return moved;
}
