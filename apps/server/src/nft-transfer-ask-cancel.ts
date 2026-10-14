/**
 * When a character NFT transfers, cancel open AhEscrow book asks for that
 * character (mainnet rule 2: owner change cancels open listings).
 * Failed on-chain cancels are persisted and retried each tick so the cursor
 * can advance without dropping work. Rebind-without-cancel needs an escrow
 * change and is deferred to redeploy.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ahEscrowAddress, listingRoleKey } from "./ah-escrow";
import { classifyClosedAsk, type ReconcileRpc } from "./ah-escrow-reconcile";
import { cancelAskOnchain, readAskOnchain } from "./ah-escrow-tx";
import { preferFinalizedTip, settlementConfirmations } from "./settlement-confirmations";
import { settlementChainId } from "./settlement-chain";
import {
  settlementRpc,
  settlementSafeHead,
  watcherLagBlocks,
  watcherStartBlock,
} from "./settlement-rpc";
import { opsAlert, watcherLagAlertBlocks } from "./ops-log";
import { redactRpcUrl } from "./ops-redact";
import { nftOwnerCache } from "./nft-owner-cache";
import { readWatcherCursor, writeWatcherCursor } from "./watcher-cursor";
import { defaultLokDir, type LokWorld } from "./lok-world";
import { writeTextAtomic } from "./lok-vault";

/** keccak256("Transfer(address,address,uint256)") — ERC-721. */
export const ERC721_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Scan this many blocks behind tip so a reorg cannot hide a Transfer. */
export const NFT_TRANSFER_CONFIRMATIONS = 2n;

/** Drop ambiguous/failed cancels after this many attempts (with backoff). */
export const PENDING_CANCEL_MAX_ATTEMPTS = 20;

/** Base delay for attempt 1; doubles each attempt up to 2^8. */
export const PENDING_CANCEL_BASE_DELAY_MS = 5_000;

type RpcLog = {
  topics?: string[];
  data?: string;
  blockNumber?: string;
  logIndex?: string;
  transactionHash?: string;
};

export type NftTransfer = {
  from: string;
  to: string;
  tokenId: string;
  /** Block number when present on the log (decimal string). */
  blockNumber?: string;
};

export type PendingCancel = {
  listingId: string;
  sellerTokenId: string;
  /** Consecutive failed / ambiguous attempts (0 = never tried from disk yet). */
  attempts?: number;
  /** Earliest time to retry; omit/0 = due now. */
  nextRetryAtMs?: number;
  /** Last failure was ambiguous closed-ask classification. */
  ambiguous?: boolean;
};

export function decodeErc721Transfer(log: {
  topics?: string[];
  blockNumber?: string;
}): NftTransfer | null {
  const topics = log.topics ?? [];
  if (topics.length < 4 || topics[0]?.toLowerCase() !== ERC721_TRANSFER_TOPIC.toLowerCase()) {
    return null;
  }
  try {
    const blockNumber =
      log.blockNumber != null && log.blockNumber !== ""
        ? BigInt(log.blockNumber).toString()
        : undefined;
    return {
      from: ("0x" + topics[1]!.slice(26)).toLowerCase(),
      to: ("0x" + topics[2]!.slice(26)).toLowerCase(),
      tokenId: BigInt(topics[3]!).toString(),
      ...(blockNumber ? { blockNumber } : {}),
    };
  } catch {
    return null;
  }
}

export function nftTransferCursorPath(dataDir: string): string {
  return join(dataDir, "nft-transfer-ask-cancel-cursor.json");
}

export function nftTransferPendingPath(dataDir: string): string {
  return join(dataDir, "nft-transfer-pending-cancels.json");
}

function readCursor(
  path: string,
  opts?: { expectedChainId: number; expectedAddress: string },
): bigint {
  if (opts) {
    return readWatcherCursor({
      path,
      expectedChainId: opts.expectedChainId,
      expectedAddress: opts.expectedAddress,
      onMismatch: (reason) =>
        console.warn("[bellgrave] NFT transfer " + reason + " — falling back to deploy block"),
    });
  }
  if (!existsSync(path)) return 0n;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { cursor?: string };
    if (raw.cursor && /^\d+$/.test(raw.cursor)) return BigInt(raw.cursor);
  } catch {
    /* start over */
  }
  return 0n;
}

function writeCursor(
  path: string,
  cursor: bigint,
  opts?: { chainId: number; address: string },
): void {
  if (opts) {
    writeWatcherCursor({ path, cursor, chainId: opts.chainId, address: opts.address });
    return;
  }
  writeTextAtomic(path, JSON.stringify({ cursor: cursor.toString() }, null, 2) + "\n");
}

function parsePendingRow(row: unknown): PendingCancel | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const listingId = String(r.listingId ?? "");
  const sellerTokenId = String(r.sellerTokenId ?? "");
  if (!/^[1-9][0-9]{0,77}$/.test(listingId) || !/^[1-9][0-9]{0,77}$/.test(sellerTokenId)) {
    return null;
  }
  const out: PendingCancel = { listingId, sellerTokenId };
  if (typeof r.attempts === "number" && Number.isSafeInteger(r.attempts) && r.attempts >= 0) {
    out.attempts = r.attempts;
  }
  if (typeof r.nextRetryAtMs === "number" && Number.isSafeInteger(r.nextRetryAtMs) && r.nextRetryAtMs >= 0) {
    out.nextRetryAtMs = r.nextRetryAtMs;
  }
  if (r.ambiguous === true) out.ambiguous = true;
  return out;
}

export function readPendingCancels(path: string): PendingCancel[] {
  if (!existsSync(path)) return [];
  let raw: { pending?: unknown[] };
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as { pending?: unknown[] };
  } catch (err) {
    // #258: fail closed — silent [] would drop cancel retries and leave chain asks open.
    throw new Error(
      "pending-cancel " + path + " could not be read (" + String(err) + "). Fix or restore it before boot.",
    );
  }
  if (!Array.isArray(raw.pending)) {
    throw new Error(
      "pending-cancel " + path + " is corrupt (expected { pending: array }). Fix or restore it before boot.",
    );
  }
  const out: PendingCancel[] = [];
  const seen = new Set<string>();
  for (const row of raw.pending) {
    const parsed = parsePendingRow(row);
    if (!parsed || seen.has(parsed.listingId)) continue;
    seen.add(parsed.listingId);
    out.push(parsed);
  }
  return out;
}

function normalizePendingRow(row: PendingCancel): PendingCancel {
  const next: PendingCancel = {
    listingId: row.listingId,
    sellerTokenId: row.sellerTokenId,
  };
  if (row.attempts != null) next.attempts = row.attempts;
  if (row.nextRetryAtMs != null) next.nextRetryAtMs = row.nextRetryAtMs;
  if (row.ambiguous) next.ambiguous = true;
  return next;
}

/** Prefer higher attempts (then later nextRetryAtMs); OR ambiguous flags. */
export function pickRicherPendingCancel(a: PendingCancel, b: PendingCancel): PendingCancel {
  const aAtt = a.attempts ?? 0;
  const bAtt = b.attempts ?? 0;
  let richer: PendingCancel;
  if (bAtt > aAtt) richer = b;
  else if (aAtt > bAtt) richer = a;
  else richer = (b.nextRetryAtMs ?? 0) > (a.nextRetryAtMs ?? 0) ? b : a;
  return normalizePendingRow({
    ...richer,
    ambiguous: a.ambiguous === true || b.ambiguous === true || richer.ambiguous === true,
  });
}

/** Union pending lists by listingId (keeps the richer row). */
export function mergePendingCancelLists(...lists: PendingCancel[][]): PendingCancel[] {
  const map = new Map<string, PendingCancel>();
  for (const list of lists) {
    for (const row of list) {
      const prev = map.get(row.listingId);
      map.set(row.listingId, prev ? pickRicherPendingCancel(prev, row) : normalizePendingRow(row));
    }
  }
  return [...map.values()];
}

export function writePendingCancels(path: string, pending: PendingCancel[]): void {
  const unique = mergePendingCancelLists(pending);
  writeTextAtomic(path, JSON.stringify({ pending: unique }, null, 2) + "\n");
}

/**
 * Re-read disk and merge before write so a concurrent list-race enqueue is not lost.
 * Returns the merged list that was written.
 */
export function writePendingCancelsMerging(path: string, pending: PendingCancel[]): PendingCancel[] {
  const merged = mergePendingCancelLists(pending, readPendingCancels(path));
  writePendingCancels(path, merged);
  return merged;
}

/** Persist pending before cursor so a crash cannot lose newly queued cancels. */
export function persistPendingThenCursor(
  pendingPath: string,
  cursorPath: string,
  pending: PendingCancel[],
  cursor: bigint,
  cursorMeta?: { chainId: number; address: string },
): PendingCancel[] {
  const merged = writePendingCancelsMerging(pendingPath, pending);
  writeCursor(cursorPath, cursor, cursorMeta);
  return merged;
}

export const NFT_TRANSFER_DROPPED_FILE = "nft-transfer-cancel-dropped.json";

export type DroppedPendingCancel = {
  listingId: string;
  sellerTokenId: string;
  attempts: number;
  ambiguous?: boolean;
  droppedAt: string;
  reason: "max-attempts";
};

export function nftTransferDroppedPath(dataDir: string): string {
  return join(dataDir, NFT_TRANSFER_DROPPED_FILE);
}

export function readDroppedPendingCancels(path: string): DroppedPendingCancel[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { dropped?: unknown[] };
    if (!Array.isArray(raw.dropped)) return [];
    const out: DroppedPendingCancel[] = [];
    for (const row of raw.dropped) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const listingId = String(r.listingId ?? "");
      const sellerTokenId = String(r.sellerTokenId ?? "");
      if (!/^[1-9][0-9]{0,77}$/.test(listingId) || !/^[1-9][0-9]{0,77}$/.test(sellerTokenId)) {
        continue;
      }
      const attempts = typeof r.attempts === "number" ? r.attempts : PENDING_CANCEL_MAX_ATTEMPTS + 1;
      const droppedAt = typeof r.droppedAt === "string" ? r.droppedAt : new Date(0).toISOString();
      out.push({
        listingId,
        sellerTokenId,
        attempts,
        droppedAt,
        reason: "max-attempts",
        ...(r.ambiguous === true ? { ambiguous: true } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Append a max-attempts drop to the ops alert file and log ALERT.
 * Durable so ops can see drops without scraping console (same idea as AskFilled quarantine).
 */
export function recordDroppedPendingCancel(
  row: PendingCancel,
  opts?: { droppedPath?: string; dataDir?: string; attempts?: number; now?: Date },
): DroppedPendingCancel {
  const dataDir = opts?.dataDir ?? defaultLokDir();
  const path = opts?.droppedPath ?? nftTransferDroppedPath(dataDir);
  const attempts = opts?.attempts ?? (row.attempts ?? 0) + 1;
  const entry: DroppedPendingCancel = {
    listingId: row.listingId,
    sellerTokenId: row.sellerTokenId,
    attempts,
    droppedAt: (opts?.now ?? new Date()).toISOString(),
    reason: "max-attempts",
    ...(row.ambiguous ? { ambiguous: true } : {}),
  };
  const existing = readDroppedPendingCancels(path).filter((d) => d.listingId !== entry.listingId);
  writeTextAtomic(path, JSON.stringify({ dropped: existing.concat([entry]) }, null, 2) + "\n");
  opsAlert({
    level: "alert",
    event: "nft_transfer_cancel_dropped",
    msg:
      "NFT transfer pending cancel dropped after " +
      entry.attempts +
      " attempts listing#" +
      entry.listingId,
    listingId: entry.listingId,
    sellerTokenId: entry.sellerTokenId,
    attempts: entry.attempts,
    ambiguous: !!entry.ambiguous,
    path,
  });
  return entry;
}

/**
 * Queue a cancel for the transfer watcher (e.g. list/transfer race).
 * Re-reads disk and merges so it cannot clobber an in-flight watcher write.
 */
export function enqueuePendingCancel(
  row: PendingCancel,
  opts?: { pendingPath?: string; dataDir?: string },
): void {
  const dataDir = opts?.dataDir ?? defaultLokDir();
  const pendingPath = opts?.pendingPath ?? nftTransferPendingPath(dataDir);
  const bumped =
    bumpPendingCancel(
      {
        listingId: row.listingId,
        sellerTokenId: row.sellerTokenId,
        attempts: 0,
        ambiguous: row.ambiguous,
      },
      { ambiguous: row.ambiguous, dataDir, recordDrop: false },
    ) ?? normalizePendingRow(row);
  writePendingCancelsMerging(pendingPath, [bumped]);
}

/**
 * Increment attempt counter and schedule backoff. Returns null when capped (alert + drop file).
 */
export function bumpPendingCancel(
  row: PendingCancel,
  opts?: {
    ambiguous?: boolean;
    now?: number;
    dataDir?: string;
    droppedPath?: string;
    /** When false, skip durable drop recording (enqueue first bump). Default true. */
    recordDrop?: boolean;
  },
): PendingCancel | null {
  const attempts = (row.attempts ?? 0) + 1;
  if (attempts > PENDING_CANCEL_MAX_ATTEMPTS) {
    if (opts?.recordDrop !== false) {
      recordDroppedPendingCancel(
        {
          listingId: row.listingId,
          sellerTokenId: row.sellerTokenId,
          attempts: row.attempts,
          ambiguous: opts?.ambiguous === true || row.ambiguous === true,
        },
        {
          dataDir: opts?.dataDir,
          droppedPath: opts?.droppedPath,
          attempts,
        },
      );
    } else {
      opsAlert({
        level: "alert",
        event: "nft_transfer_cancel_dropped",
        msg:
          "NFT transfer pending cancel dropped after " +
          attempts +
          " attempts listing#" +
          row.listingId,
        listingId: row.listingId,
        sellerTokenId: row.sellerTokenId,
        attempts,
        recorded: false,
      });
    }
    return null;
  }
  const exp = Math.min(Math.max(attempts - 1, 0), 8);
  const delay = PENDING_CANCEL_BASE_DELAY_MS * 2 ** exp;
  const now = opts?.now ?? Date.now();
  return {
    listingId: row.listingId,
    sellerTokenId: row.sellerTokenId,
    attempts,
    nextRetryAtMs: now + delay,
    ambiguous: opts?.ambiguous === true || row.ambiguous === true ? true : undefined,
  };
}

function nftAddress(env: NodeJS.ProcessEnv): string | null {
  const nft = env.LOK_NFT?.trim() || "";
  return /^0x[0-9a-fA-F]{40}$/.test(nft) ? nft.toLowerCase() : null;
}

async function jsonRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
}

export type CancelAsksResult = {
  cancelled: string[];
  /** Filled on-chain — leave for AskFilled watcher. */
  skipped: string[];
  /** On-chain or log cancel failed / ambiguous — retry next tick. */
  pending: PendingCancel[];
};

/**
 * Cancel every open book listing for `sellerTokenId` on-chain + log.
 * Failed cancels are returned in `pending` for durable retry.
 */
export async function cancelOpenAsksForCharacter(
  lok: Pick<LokWorld, "openBookListings" | "cancelAsk">,
  sellerTokenId: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    /** Limit to these listing ids (pending retry). Default: all open book asks for the character. */
    listingIds?: string[];
    cancelOnchain?: (listingId: string) => Promise<
      | { ok: true; alreadyClosed?: boolean; neverOpened?: boolean }
      | { ok: false; error: string }
    >;
    /** When on-chain ask is already closed, classify AskFilled vs AskCancelled. */
    classifyClosed?: (listingId: string) => Promise<
      | { action: "cancel-log" }
      | { action: "wait-fill" }
      | { action: "skip" }
    >;
  },
): Promise<CancelAsksResult> {
  const env = opts?.env ?? process.env;
  const out: CancelAsksResult = { cancelled: [], skipped: [], pending: [] };
  const idFilter = opts?.listingIds ? new Set(opts.listingIds) : null;
  const rows = lok
    .openBookListings()
    .filter((row) => row.seller === sellerTokenId && (!idFilter || idFilter.has(row.id)));
  if (rows.length === 0) return out;

  const cancel =
    opts?.cancelOnchain ??
    (async (listingId: string) => {
      // #256: if AhEscrow is configured but LISTING key is missing, do NOT pretend
      // neverOpened — that cancels the log while the chain ask stays buyable.
      if (ahEscrowAddress(env) && !listingRoleKey(env)) {
        return {
          ok: false as const,
          error: "AhEscrow configured but LOK_LISTING_KEY is missing — refusing log-only cancel",
        };
      }
      if (!ahEscrowAddress(env) || !listingRoleKey(env)) {
        return { ok: true as const, neverOpened: true };
      }
      return cancelAskOnchain({ listingId, env });
    });

  for (const row of rows) {
    const chain = await cancel(row.id);
    if (!chain.ok) {
      out.pending.push({ listingId: row.id, sellerTokenId });
      console.error(
        "[bellgrave] NFT transfer: on-chain cancel failed for ask #" +
          row.id +
          " char=" +
          sellerTokenId +
          ": " +
          chain.error +
          " (queued for retry)",
      );
      continue;
    }
    if ("alreadyClosed" in chain && chain.alreadyClosed) {
      // Filled vs cancelled look the same in asks() — classify events (H2 / boot reconcile).
      const decision = opts?.classifyClosed
        ? await opts.classifyClosed(row.id)
        : { action: "skip" as const };
      if (decision.action === "cancel-log") {
        const res = lok.cancelAsk(row.id, sellerTokenId);
        if (res.ok) {
          out.cancelled.push(row.id);
          console.log(
            "[bellgrave] NFT transfer: log-cancelled ask #" +
              row.id +
              " after AskCancelled (on-chain already closed)",
          );
        } else {
          out.pending.push({ listingId: row.id, sellerTokenId });
          console.error(
            "[bellgrave] NFT transfer: log cancel failed for already-closed ask #" +
              row.id +
              ": " +
              res.error +
              " (queued for retry)",
          );
        }
      } else if (decision.action === "wait-fill") {
        out.skipped.push(row.id);
      } else {
        // Ambiguous closed ask — retry classify later with backoff (covers crash before log cancel).
        out.pending.push({ listingId: row.id, sellerTokenId, ambiguous: true });
      }
      continue;
    }
    const neverOpened = "neverOpened" in chain && !!chain.neverOpened;
    const res = lok.cancelAsk(row.id, sellerTokenId);
    if (res.ok) {
      out.cancelled.push(row.id);
      console.log(
        "[bellgrave] NFT transfer: cancelled ask #" +
          row.id +
          " for character " +
          sellerTokenId +
          (neverOpened ? " (log only)" : ""),
      );
    } else {
      // On-chain cancel succeeded; log cancel failed — retry (next pass sees alreadyClosed).
      out.pending.push({ listingId: row.id, sellerTokenId });
      console.error(
        "[bellgrave] NFT transfer: log cancel failed for ask #" +
          row.id +
          ": " +
          res.error +
          " (queued for retry)",
      );
    }
  }
  return out;
}

/** Retry persisted pending cancels; drop rows that are no longer open book asks. */
export async function retryPendingCancels(
  lok: Pick<LokWorld, "openBookListings" | "cancelAsk">,
  pending: PendingCancel[],
  opts?: Parameters<typeof cancelOpenAsksForCharacter>[2] & {
    now?: number;
    dataDir?: string;
    droppedPath?: string;
  },
): Promise<{ remaining: PendingCancel[]; cancelled: string[]; dropped: string[] }> {
  const now = opts?.now ?? Date.now();
  const stillOpen = new Set(lok.openBookListings().map((r) => r.id));
  const bySeller = new Map<string, PendingCancel[]>();
  const remaining: PendingCancel[] = [];
  const cancelled: string[] = [];
  const dropped: string[] = [];

  const due: PendingCancel[] = [];
  for (const row of pending) {
    if (!stillOpen.has(row.listingId)) continue; // already gone from the book
    if (row.nextRetryAtMs != null && row.nextRetryAtMs > now) {
      remaining.push(row);
      continue;
    }
    due.push(row);
    const list = bySeller.get(row.sellerTokenId) ?? [];
    list.push(row);
    bySeller.set(row.sellerTokenId, list);
  }

  const priorById = new Map(due.map((r) => [r.listingId, r]));

  for (const [sellerTokenId, rows] of bySeller) {
    const listingIds = rows.map((r) => r.listingId);
    const res = await cancelOpenAsksForCharacter(lok, sellerTokenId, {
      ...opts,
      listingIds,
    });
    cancelled.push(...res.cancelled);
    // skipped (wait-fill) are intentionally dropped from pending
    for (const p of res.pending) {
      const prior = priorById.get(p.listingId);
      const bumped = bumpPendingCancel(
        {
          listingId: p.listingId,
          sellerTokenId: p.sellerTokenId,
          attempts: prior?.attempts ?? 0,
          ambiguous: p.ambiguous || prior?.ambiguous,
        },
        {
          ambiguous: p.ambiguous === true,
          now,
          dataDir: opts?.dataDir,
          droppedPath: opts?.droppedPath,
        },
      );
      if (bumped) remaining.push(bumped);
      else dropped.push(p.listingId);
    }
  }
  return { remaining, cancelled, dropped };
}

export async function scanNftTransfers(opts: {
  cursor: bigint;
  nft: string;
  rpcCall: (method: string, params: unknown[]) => Promise<unknown>;
  onTransfer: (xfer: NftTransfer) => Promise<void>;
  /** Blocks behind tip (default NFT_TRANSFER_CONFIRMATIONS). */
  confirmations?: bigint;
  /** When cursor is 0, begin here (deploy block) instead of tip. */
  startBlock?: bigint;
  preferFinalized?: boolean;
}): Promise<{ cursor: bigint }> {
  const confirmations = opts.confirmations ?? NFT_TRANSFER_CONFIRMATIONS;
  const head = await settlementSafeHead({
    rpcCall: opts.rpcCall,
    confirmations,
    preferFinalized: opts.preferFinalized === true,
  });
  const safeHead = head.safeHead;
  const start = opts.startBlock ?? 0n;
  // cursor 0 = never scanned: backfill from deploy block (not tip — tip skips history).
  let from = opts.cursor === 0n ? start : opts.cursor + 1n;
  if (from > safeHead) return { cursor: opts.cursor };

  const page = 2_000n;
  let cursor = opts.cursor;
  while (from <= safeHead) {
    const to = from + page - 1n > safeHead ? safeHead : from + page - 1n;
    const logs = (await opts.rpcCall("eth_getLogs", [
      {
        address: opts.nft,
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        topics: [ERC721_TRANSFER_TOPIC],
      },
    ])) as RpcLog[];
    if (!Array.isArray(logs)) throw new Error("eth_getLogs returned no list");
    for (const log of logs) {
      const xfer = decodeErc721Transfer(log);
      if (!xfer) continue;
      // Ignore mint (from zero) — no prior owner listings to fix.
      if (xfer.from === "0x0000000000000000000000000000000000000000") continue;
      // Self-transfer does not change ownership — do not cancel asks.
      if (xfer.from === xfer.to) continue;
      await opts.onTransfer(xfer);
    }
    cursor = to;
    from = to + 1n;
  }
  return { cursor };
}

function defaultClassifyClosed(
  env: NodeJS.ProcessEnv,
  rpc: string,
): (listingId: string) => Promise<{ action: "cancel-log" } | { action: "wait-fill" } | { action: "skip" }> {
  const escrow = ahEscrowAddress(env);
  return async (listingId: string) => {
    if (!escrow) return { action: "skip" };
    const rpcCall: ReconcileRpc = (method, params) => jsonRpc(rpc, method, params);
    const onchainRaw = await (async () => {
      try {
        const r = await readAskOnchain({ listingId, env });
        if (!r.ok) return null;
        return { open: r.ask.open, used: r.ask.used };
      } catch {
        return null;
      }
    })();
    const decision = await classifyClosedAsk({
      listingId,
      escrow,
      rpcCall,
      quarantined: false,
      onchain: onchainRaw,
    });
    if (decision.action === "cancel-log") return { action: "cancel-log" };
    if (decision.action === "wait-fill") return { action: "wait-fill" };
    return { action: "skip" };
  };
}

export type NftOwnershipChange = {
  tokenId: string;
  from: string;
  to: string;
  blockNumber: string;
  charId: string | null;
};

export function startNftTransferAskCancelWatcher(
  lok: Pick<LokWorld, "openBookListings" | "cancelAsk" | "charByTokenId" | "rebindWallet">,
  opts?: {
    cursorPath?: string;
    pendingPath?: string;
    dataDir?: string;
    env?: NodeJS.ProcessEnv;
    /** C-1: after finalized Transfer, update owner cache + rebind + kick sessions. */
    onOwnershipChange?: (change: NftOwnershipChange) => void | Promise<void>;
  },
): void {
  const env = opts?.env ?? process.env;
  const nft = nftAddress(env);
  if (!nft) return;
  if (!ahEscrowAddress(env)) return;
  if (!(env.LOK_CHAIN_RPC?.trim() || env.LOK_CHAIN_RPC_URLS?.trim())) return;

  const rpc = settlementRpc(env);
  const dataDir = opts?.dataDir ?? defaultLokDir();
  const cursorPath = opts?.cursorPath ?? nftTransferCursorPath(dataDir);
  const pendingPath = opts?.pendingPath ?? nftTransferPendingPath(dataDir);
  const droppedPath = nftTransferDroppedPath(dataDir);
  const confirmations = settlementConfirmations(env);
  const startBlock = watcherStartBlock(env);
  const chainId = settlementChainId(env);
  console.log(
    "[bellgrave] NFT transfer ask-cancel watcher rpc=" +
      redactRpcUrl(rpc.currentUrl()) +
      " fallbacks=" +
      Math.max(0, rpc.urls.length - 1) +
      " nft=" +
      nft +
      " chain=" +
      chainId +
      " confirmations=" +
      confirmations.toString() +
      " finalized=" +
      preferFinalizedTip(env) +
      " startBlock=" +
      startBlock.toString() +
      " droppedAlerts=" +
      droppedPath,
  );

  let cursor = readCursor(cursorPath, { expectedChainId: chainId, expectedAddress: nft });
  let pending = readPendingCancels(pendingPath);
  let busy = false;
  const classifyClosed = defaultClassifyClosed(env, rpc.currentUrl());

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Reload disk pending each tick so list-race enqueues are picked up.
      pending = readPendingCancels(pendingPath);
      const retried = await retryPendingCancels(lok, pending, {
        env,
        classifyClosed,
        dataDir,
        droppedPath,
      });
      pending = retried.remaining;

      const next = await scanNftTransfers({
        cursor,
        nft,
        confirmations,
        startBlock,
        preferFinalized: preferFinalizedTip(env),
        rpcCall: rpc.asCall(),
        onTransfer: async (xfer) => {
          const block = xfer.blockNumber ?? "0";
          nftOwnerCache(dataDir).onTransfer(xfer.tokenId, xfer.to, block);
          const bound = lok.charByTokenId?.(xfer.tokenId) ?? null;
          if (bound && typeof lok.rebindWallet === "function") {
            const reb = lok.rebindWallet(bound.charId, xfer.to);
            if (reb.ok && reb.previous && reb.previous !== xfer.to) {
              console.log(
                "[bellgrave] C-1 rebind char=" +
                  bound.charId +
                  " token=" +
                  xfer.tokenId +
                  " " +
                  reb.previous +
                  " → " +
                  xfer.to,
              );
            }
          }
          if (opts?.onOwnershipChange) {
            await opts.onOwnershipChange({
              tokenId: xfer.tokenId,
              from: xfer.from,
              to: xfer.to,
              blockNumber: block,
              charId: bound?.charId ?? null,
            });
          }
          const res = await cancelOpenAsksForCharacter(lok, xfer.tokenId, {
            env,
            classifyClosed,
          });
          for (const p of res.pending) {
            const bumped = bumpPendingCancel(p, {
              ambiguous: p.ambiguous === true,
              dataDir,
              droppedPath,
            });
            if (bumped) pending = pending.filter((x) => x.listingId !== bumped.listingId).concat([bumped]);
          }
        },
      });
      cursor = next.cursor;
      rpc.noteCursor("nftTransfer", cursor);
      const lag = watcherLagBlocks({
        tip: rpc.stats.tipBlock,
        cursor,
        confirmations,
      });
      const lagAlert = watcherLagAlertBlocks();
      if (lag > lagAlert) {
        opsAlert({
          level: "alert",
          event: "watcher_lag",
          msg: "NFT transfer watcher lag=" + lag.toString() + " blocks",
          watcher: "nftTransfer",
          lagBlocks: lag.toString(),
          tip: rpc.stats.tipBlock?.toString() ?? null,
          cursor: cursor.toString(),
          threshold: lagAlert.toString(),
          dedupeKey: "lag:nftTransfer:" + lag.toString(),
        });
      }
      // Re-read+merge pending, then cursor — concurrent list-race enqueues survive this write.
      pending = persistPendingThenCursor(pendingPath, cursorPath, pending, cursor, {
        chainId,
        address: nft,
      });
    } catch (err) {
      console.error("[bellgrave] NFT transfer ask-cancel watcher", err);
      try {
        pending = writePendingCancelsMerging(pendingPath, pending);
      } catch {
        /* ignore */
      }
    } finally {
      busy = false;
    }
  };
  tick().catch((err) => console.error("[bellgrave] NFT transfer ask-cancel watcher", err));
  const timer = setInterval(() => {
    tick().catch((err) => console.error("[bellgrave] NFT transfer ask-cancel watcher", err));
  }, 5000);
  timer.unref?.();
}
