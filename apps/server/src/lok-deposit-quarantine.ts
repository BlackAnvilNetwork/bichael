import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainInbound } from "./lok-chain";

/**
 * Chain inbounds (KEK deposits, item imports) the watcher could not apply and
 * will never be able to apply as-is: a token the log has never spawned (for
 * example a character minted straight from the factory), an event that does not
 * decode, or one the engine refuses for a reason retrying cannot fix.
 *
 * Before this list existed one such event halted the deposit cursor for every
 * player. Now it is written here, alerted, and the cursor moves past it. A
 * quarantined deposit is KEK sitting in vault custody with no log credit, so
 * every entry needs an operator: fix the cause, stop the server, then run
 *   pnpm --filter @bellgrave/server lok:replay-quarantined <id>
 *
 * Nonce gaps and transient errors (RPC failures, timeouts) are never
 * quarantined; they still halt the cursor so the event is retried.
 */
export const DEPOSIT_QUARANTINE_FILE = "lok-deposit-quarantine.json";

export type QuarantineReason =
  /** The token has no Spawn on the log (unbound, or minted outside the game server). */
  | "unknown-token"
  /** The event topic matched but the payload did not decode, or names token or nonce 0. */
  | "bad-shape"
  /** The engine refused the payload itself (bad id, zero amount, overflow). */
  | "unprocessable"
  /** A nonce gap for a token whose missing nonces are all already quarantined. */
  | "behind-quarantined-nonce";

export type QuarantinedInbound = {
  /** blockNumber:logIndex of the chain log, both 0x hex. Unique per chain. */
  id: string;
  reason: QuarantineReason;
  error: string;
  /** Decoded inbound, or null when the event did not decode. */
  inbound: ChainInbound | null;
  tokenId: string;
  nonce: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  topics: string[];
  data: string;
  quarantinedAt: string;
};

type QuarantineFile = { entries: QuarantinedInbound[] };

export function depositQuarantinePath(dataDir: string): string {
  return join(dataDir, DEPOSIT_QUARANTINE_FILE);
}

/** Missing file is an empty list. A file that does not parse throws: dropping it would forget custody KEK. */
export function loadDepositQuarantine(path: string): QuarantinedInbound[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      "lok deposit quarantine " + path + " could not be read (" + String(err) + "). Fix or restore it; it lists custody KEK with no log credit.",
    );
  }
  const entries = (parsed as Partial<QuarantineFile> | null)?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("lok deposit quarantine " + path + " is not a quarantine list. Fix or restore it.");
  }
  return entries as QuarantinedInbound[];
}

/** Atomic: write a temp file, then rename over the list. */
export function writeDepositQuarantine(path: string, entries: QuarantinedInbound[]): void {
  const tmp = path + ".tmp";
  const body: QuarantineFile = { entries };
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, path);
}

export class DepositQuarantine {
  private entries: QuarantinedInbound[];

  constructor(readonly path: string) {
    this.entries = loadDepositQuarantine(path);
  }

  list(): QuarantinedInbound[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id);
  }

  /** Persist a new entry. Returns false when that id is already quarantined. */
  add(entry: QuarantinedInbound): boolean {
    if (this.has(entry.id)) return false;
    const next = [...this.entries, entry];
    writeDepositQuarantine(this.path, next);
    this.entries = next;
    return true;
  }

  remove(id: string): boolean {
    if (!this.has(id)) return false;
    const next = this.entries.filter((entry) => entry.id !== id);
    writeDepositQuarantine(this.path, next);
    this.entries = next;
    return true;
  }

  /** Quarantined decoded nonces for one token. */
  noncesOf(tokenId: string): bigint[] {
    const out: bigint[] = [];
    for (const entry of this.entries) {
      if (!entry.inbound || entry.inbound.tokenId !== tokenId) continue;
      try {
        out.push(BigInt(entry.inbound.nonce));
      } catch {
        // not a nonce
      }
    }
    return out;
  }

  /** A quarantined entry for this token holds a nonce below `nonce`. */
  hasLowerNonce(tokenId: string, nonce: string): boolean {
    const n = BigInt(nonce);
    return this.noncesOf(tokenId).some((q) => q < n);
  }

  /**
   * True when every nonce in [expected, nonce) for this token is quarantined, so
   * the gap is explained by the quarantine and not by a missed chain event.
   */
  explainsGap(tokenId: string, expected: number, nonce: string): boolean {
    let n: bigint;
    try {
      n = BigInt(nonce);
    } catch {
      return false;
    }
    const start = BigInt(expected);
    if (n <= start) return false;
    const have = new Set(this.noncesOf(tokenId).map((q) => q.toString()));
    for (let k = start; k < n; k++) {
      if (!have.has(k.toString())) return false;
    }
    return true;
  }
}
