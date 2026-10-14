/**
 * Record LISTING cancelAsk broadcasts so a timed-out finality wait can be
 * distinguished from an AskFilled on retry (re-test MED #2).
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDurableJsonObject } from "./durable-json";
import { defaultLokDir } from "./lok-world";

export const CANCEL_TX_RECORD_FILE = "cancel-ask-txs.json";

export type CancelTxRecord = {
  listingId: string;
  hash: string;
  at: string;
};

type FileShape = { cancels: Record<string, CancelTxRecord> };

export function cancelTxRecordPath(dataDir: string = defaultLokDir()): string {
  return join(dataDir, CANCEL_TX_RECORD_FILE);
}

export class CancelTxRecordStore {
  private cancels: Record<string, CancelTxRecord> = {};

  constructor(readonly path: string) {
    this.reload();
  }

  reload(): void {
    const parsed = loadDurableJsonObject<FileShape>(this.path, "cancel-ask-txs");
    if (!parsed) {
      this.cancels = {};
      return;
    }
    if (!parsed.cancels || typeof parsed.cancels !== "object" || Array.isArray(parsed.cancels)) {
      throw new Error(
        "cancel-ask-txs " + this.path + " is corrupt (expected { cancels: object }). Fix or restore it before boot.",
      );
    }
    this.cancels = parsed.cancels;
  }

  private persist(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ cancels: this.cancels } satisfies FileShape, null, 2) + "\n");
    renameSync(tmp, this.path);
  }

  get(listingId: string): CancelTxRecord | null {
    return this.cancels[listingId] ?? null;
  }

  set(listingId: string, hash: string): void {
    if (!/^[1-9][0-9]{0,77}$/.test(listingId)) return;
    this.cancels[listingId] = {
      listingId,
      hash,
      at: new Date().toISOString(),
    };
    this.persist();
  }

  clear(listingId: string): void {
    if (!this.cancels[listingId]) return;
    delete this.cancels[listingId];
    this.persist();
  }
}

let shared: CancelTxRecordStore | null = null;

export function cancelTxRecordStore(dataDir?: string): CancelTxRecordStore {
  if (!shared || (dataDir && shared.path !== cancelTxRecordPath(dataDir))) {
    shared = new CancelTxRecordStore(cancelTxRecordPath(dataDir));
  }
  return shared;
}

export function resetCancelTxRecordForTests(): void {
  shared = null;
}
