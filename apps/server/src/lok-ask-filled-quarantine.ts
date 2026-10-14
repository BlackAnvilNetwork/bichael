/**
 * AskFilled events the watcher could not mirror into the log and will never be
 * able to apply as-is (self-buy, unspawned buyer, cancelled listing with an
 * unpaid-on-log fill, fill/ask mismatch). Before this list existed one such
 * event halted the AskFilled cursor for every player. Now it is written here,
 * alerted, and the cursor moves past it.
 *
 * Each entry is a buyer who paid on-chain and is owed a refund or a manual
 * mirror. Operator (server stopped):
 *   pnpm --filter @bellgrave/server lok:replay-ask-filled --list
 *   pnpm --filter @bellgrave/server lok:replay-ask-filled <id> [dataDir]
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskFilled } from "./ah-escrow";
import { opsAlert } from "./ops-log";

export const ASK_FILLED_QUARANTINE_FILE = "lok-ask-filled-quarantine.json";
export const ASK_FILLED_MIRRORED_FILE = "lok-ask-filled-mirrored.json";

export type AskFillQuarantineReason =
  | "unknown-listing"
  | "self-transfer"
  | "not-spawned"
  | "fill-mismatch"
  | "over-ask"
  | "unprocessable";

export type QuarantinedAskFill = {
  /** fillKey = txHash-logIndex */
  id: string;
  reason: AskFillQuarantineReason;
  error: string;
  fill: AskFilled;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  quarantinedAt: string;
};

type QuarantineFile = { entries: QuarantinedAskFill[] };
type MirroredFile = { keys: string[] };

export function askFilledQuarantinePath(dataDir: string): string {
  return join(dataDir, ASK_FILLED_QUARANTINE_FILE);
}

export function askFilledMirroredPath(dataDir: string): string {
  return join(dataDir, ASK_FILLED_MIRRORED_FILE);
}

export function loadAskFilledQuarantine(path: string): QuarantinedAskFill[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      "lok ask-filled quarantine " +
        path +
        " could not be read (" +
        String(err) +
        "). Fix or restore it; it lists paid buyers with no item credit.",
    );
  }
  const entries = (parsed as Partial<QuarantineFile> | null)?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("lok ask-filled quarantine " + path + " is not a quarantine list. Fix or restore it.");
  }
  return entries as QuarantinedAskFill[];
}

export function writeAskFilledQuarantine(path: string, entries: QuarantinedAskFill[]): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ entries } satisfies QuarantineFile, null, 2));
  renameSync(tmp, path);
}

export function loadMirroredFillKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MirroredFile>;
    if (!Array.isArray(parsed.keys)) return new Set();
    return new Set(parsed.keys.filter((k) => typeof k === "string"));
  } catch (err) {
    throw new Error("lok ask-filled mirrored " + path + " could not be read (" + String(err) + ").");
  }
}

export function writeMirroredFillKeys(path: string, keys: Set<string>): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ keys: [...keys] } satisfies MirroredFile, null, 2));
  renameSync(tmp, path);
}

export class AskFilledQuarantine {
  private entries: QuarantinedAskFill[];

  constructor(readonly path: string) {
    this.entries = loadAskFilledQuarantine(path);
  }

  list(): QuarantinedAskFill[] {
    return this.entries.map((e) => ({ ...e, fill: { ...e.fill } }));
  }

  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  add(entry: QuarantinedAskFill): boolean {
    if (this.has(entry.id)) return false;
    const next = [...this.entries, entry];
    writeAskFilledQuarantine(this.path, next);
    this.entries = next;
    return true;
  }

  remove(id: string): boolean {
    if (!this.has(id)) return false;
    const next = this.entries.filter((e) => e.id !== id);
    writeAskFilledQuarantine(this.path, next);
    this.entries = next;
    return true;
  }
}

export class MirroredFills {
  private keys: Set<string>;

  constructor(readonly path: string) {
    this.keys = loadMirroredFillKeys(path);
  }

  has(id: string): boolean {
    return this.keys.has(id);
  }

  add(id: string): void {
    if (this.keys.has(id)) return;
    this.keys.add(id);
    writeMirroredFillKeys(this.path, this.keys);
  }
}

/**
 * Classify engine errors for AskFilled (#245).
 * Known permanent → specific quarantine reason.
 * Transient (RPC / nonce / timeout) → null → halt cursor and retry.
 * Everything else → "unprocessable" quarantine so one unknown string cannot freeze AH.
 */
export function reasonFromEngineError(error: string): AskFillQuarantineReason | null {
  if (/unknown listing/i.test(error)) return "unknown-listing";
  if (/self.?transfer|cannot send to self/i.test(error)) return "self-transfer";
  if (/not spawned/i.test(error)) return "not-spawned";
  if (/fill mismatch|does not match/i.test(error)) return "fill-mismatch";
  if (/over.?ask|pay more than the ask/i.test(error)) return "over-ask";
  // Transient / retryable — keep cursor halted on this block.
  if (
    /timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|429|503|502|504|rate.?limit|temporar|nonce too low|replacement transaction|already known|underpriced|pruned history|header not found|block not found/i.test(
      error,
    )
  ) {
    return null;
  }
  return "unprocessable";
}

export function alertAskFilledQuarantine(entry: QuarantinedAskFill): void {
  opsAlert({
    level: "alert",
    event: "ask_filled_quarantine",
    msg:
      "AskFilled quarantined id=" +
      entry.id +
      " reason=" +
      entry.reason +
      " listing=" +
      entry.fill.listingId,
    id: entry.id,
    reason: entry.reason,
    listingId: entry.fill.listingId,
    buyerTokenId: entry.fill.buyerTokenId,
    priceWei: entry.fill.priceWei,
    error: entry.error,
    replay: "pnpm --filter @bellgrave/server lok:replay-ask-filled " + entry.id,
  });
}
