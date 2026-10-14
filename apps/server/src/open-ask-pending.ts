/**
 * Track openAsk broadcasts that may still be in the mempool (M-1).
 * cancelAsk must not treat !used as neverOpened when a broadcast is recorded.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDurableJsonObject } from "./durable-json";
import { defaultLokDir } from "./lok-world";

export const OPEN_ASK_PENDING_FILE = "open-ask-pending.json";

export type OpenAskPending = {
  listingId: string;
  sellerTokenId: string;
  hash: string;
  /** Account nonce used for the broadcast (decimal string). */
  nonce: string;
  broadcastAt: string;
};

type FileShape = { pending: Record<string, OpenAskPending> };

export function openAskPendingPath(dataDir: string = defaultLokDir()): string {
  return join(dataDir, OPEN_ASK_PENDING_FILE);
}

export class OpenAskPendingStore {
  private pending: Record<string, OpenAskPending> = {};

  constructor(readonly path: string) {
    this.reload();
  }

  reload(): void {
    const parsed = loadDurableJsonObject<FileShape>(this.path, "open-ask-pending");
    if (!parsed) {
      this.pending = {};
      return;
    }
    if (!parsed.pending || typeof parsed.pending !== "object" || Array.isArray(parsed.pending)) {
      throw new Error(
        "open-ask-pending " + this.path + " is corrupt (expected { pending: object }). Fix or restore it before boot.",
      );
    }
    this.pending = parsed.pending;
  }

  private persist(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ pending: this.pending } satisfies FileShape, null, 2) + "\n");
    renameSync(tmp, this.path);
  }

  get(listingId: string): OpenAskPending | null {
    return this.pending[listingId] ?? null;
  }

  has(listingId: string): boolean {
    return !!this.pending[listingId];
  }

  set(row: OpenAskPending): void {
    if (!/^[1-9][0-9]{0,77}$/.test(row.listingId)) return;
    this.pending[row.listingId] = row;
    this.persist();
  }

  clear(listingId: string): void {
    if (!this.pending[listingId]) return;
    delete this.pending[listingId];
    this.persist();
  }
}

let shared: OpenAskPendingStore | null = null;

export function openAskPendingStore(dataDir?: string): OpenAskPendingStore {
  if (!shared || (dataDir && shared.path !== openAskPendingPath(dataDir))) {
    shared = new OpenAskPendingStore(openAskPendingPath(dataDir));
  }
  return shared;
}

export function resetOpenAskPendingForTests(): void {
  shared = null;
}
