/**
 * First-party AhEscrow helpers: open/cancel asks on-chain, watch AskFilled,
 * mirror into the log as chainFill (items only). Permanently unapplyable fills
 * are quarantined (#214 policy) so one bad fill cannot freeze AH for everyone.
 */
import { settlementCurrencyView } from "@bellgrave/config";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preferFinalizedTip, settlementConfirmations } from "./settlement-confirmations";
import { settlementChainId } from "./settlement-chain";
import {
  settlementRpc,
  settlementSafeHead,
  watcherLagBlocks,
  watcherStartBlock,
} from "./settlement-rpc";
import {
  alertAskFilledQuarantine,
  AskFilledQuarantine,
  askFilledMirroredPath,
  askFilledQuarantinePath,
  MirroredFills,
  reasonFromEngineError,
  type AskFillQuarantineReason,
  type QuarantinedAskFill,
} from "./lok-ask-filled-quarantine";
import { opsAlert, watcherLagAlertBlocks } from "./ops-log";
import { redactRpcUrl } from "./ops-redact";
import { resolvePublicRpcUrl } from "./public-rpc";
import { readWatcherCursor, writeWatcherCursor } from "./watcher-cursor";
import { defaultLokDir, type LokWorld } from "./lok-world";

/**
 * Keccak of AskFilled(uint256,address,uint256,address,uint256,uint256,uint256,uint256) — includes feeWei.
 *
 * Pre-fee escrow used a 7-arg AskFilled (no feeWei) with a different topic. We intentionally do
 * **not** watch that legacy topic: nothing is deployed on Chiado/Gnosis yet, and openAsk against
 * an old escrow would revert on ABI mismatch. Drain/cancel any old asks before a future upgrade
 * if a pre-fee deployment ever exists. See docs/mainnet-plan.md.
 */
export const ASK_FILLED_TOPIC = "0x7f623940623393c52bf22f242ae3b57d9fbb8e603232b8952a1ad894943a1907";

/** Keccak of AskCancelled(uint256). */
export const ASK_CANCELLED_TOPIC =
  "0x5ab6d218303bd8dc01c2c5e812dcbbadcfc2eb5b1fb91111e0b0ae87888ac568";

/** @deprecated Prefer settlementConfirmations(env). Kept for tests / callers. */
export const ASK_FILL_CONFIRMATIONS = 2n;

export type AskFilled = {
  listingId: string;
  buyer: string;
  buyerTokenId: string;
  sellerPayout: string;
  priceWei: string;
  feeWei: string;
  itemId: string;
  amount: string;
};

export type ChainFillNote = {
  listingId: string;
  buyerTokenId: string;
  priceWei: string;
  fillKey: string;
  itemId: string;
  amount: string;
  sellerTokenId: string;
  txHash: string;
  logIndex: string;
};

type RpcLog = {
  topics?: string[];
  data?: string;
  blockNumber?: string;
  logIndex?: string;
  transactionHash?: string;
};

export type ApplyAskFilledResult =
  | { ok: true; kind: "applied" | "replay" }
  | { ok: false; kind: "quarantine"; error: string; reason: AskFillQuarantineReason }
  | { ok: false; kind: "halt"; error: string };

export function decodeAskFilled(log: { topics?: string[]; data?: string }): AskFilled | null {
  const topics = log.topics ?? [];
  if (topics.length < 4 || topics[0]?.toLowerCase() !== ASK_FILLED_TOPIC.toLowerCase()) return null;
  const data = log.data ?? "";
  // sellerPayout, priceWei, feeWei, itemId, amount
  if (!data.startsWith("0x") || data.length < 2 + 64 * 5) return null;
  try {
    const sellerWord = data.slice(2, 2 + 64);
    const sellerPayout = "0x" + sellerWord.slice(24);
    return {
      listingId: BigInt(topics[1]!).toString(),
      buyer: "0x" + topics[2]!.slice(26),
      buyerTokenId: BigInt(topics[3]!).toString(),
      sellerPayout,
      priceWei: BigInt("0x" + data.slice(2 + 64, 2 + 128)).toString(),
      feeWei: BigInt("0x" + data.slice(2 + 128, 2 + 192)).toString(),
      itemId: BigInt("0x" + data.slice(2 + 192, 2 + 256)).toString(),
      amount: BigInt("0x" + data.slice(2 + 256, 2 + 320)).toString(),
    };
  } catch {
    return null;
  }
}

export function fillKeyOf(log: { transactionHash?: string; logIndex?: string; blockNumber?: string }): string {
  const tx = (log.transactionHash ?? "").toLowerCase();
  const idx = log.logIndex && log.logIndex !== "0x" ? BigInt(log.logIndex).toString() : "0";
  if (tx && tx !== "0x") return tx + "-" + idx;
  const block = log.blockNumber && log.blockNumber !== "0x" ? BigInt(log.blockNumber).toString() : "0";
  return "block-" + block + "-" + idx;
}

function parseTxHash(fillKey: string, log?: RpcLog): string {
  if (log?.transactionHash && /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) {
    return log.transactionHash.toLowerCase();
  }
  const head = fillKey.split("-")[0] ?? "";
  if (/^0x[0-9a-fA-F]{64}$/.test(head)) return head.toLowerCase();
  return "0x" + "0".repeat(64);
}

function parseLogIndex(fillKey: string, log?: RpcLog): string {
  if (log?.logIndex && log.logIndex !== "0x") {
    try {
      return BigInt(log.logIndex).toString();
    } catch {
      /* fall through */
    }
  }
  const parts = fillKey.split("-");
  const last = parts[parts.length - 1] ?? "0";
  return /^\d+$/.test(last) ? last : "0";
}

/**
 * Mirror an AskFilled into the log. Replay when this fillKey is already in the
 * log (ChainFill tx+index) or in the optional mirrored-key cache. Unknown
 * listing / self-buy / not spawned / mismatch → quarantine. Transient → halt.
 */
export function applyAskFilled(
  lok: Pick<LokWorld, "noteChainFill" | "chainFill" | "listingOf" | "hasChainFill">,
  fill: AskFilled,
  fillKey: string,
  opts?: {
    /** Optional cache only — source of truth is the log's ChainFill entries. */
    mirrored?: MirroredFills;
    log?: RpcLog;
  },
): ApplyAskFilledResult {
  const mirrored = opts?.mirrored;
  if (mirrored?.has(fillKey) || lok.hasChainFill(fillKey)) {
    mirrored?.add(fillKey);
    return { ok: true, kind: "replay" };
  }

  const listing = lok.listingOf(fill.listingId);
  if (!listing) {
    return {
      ok: false,
      kind: "quarantine",
      error: "unknown listing",
      reason: "unknown-listing",
    };
  }

  const txHash = parseTxHash(fillKey, opts?.log);
  const logIndex = parseLogIndex(fillKey, opts?.log);

  lok.noteChainFill({
    listingId: fill.listingId,
    buyerTokenId: fill.buyerTokenId,
    priceWei: fill.priceWei,
    fillKey,
    itemId: fill.itemId,
    amount: fill.amount,
    sellerTokenId: listing.seller,
    txHash,
    logIndex,
  });
  const res = lok.chainFill(fill.listingId, fill.buyerTokenId, fill.priceWei, fillKey);
  if (res.ok) {
    mirrored?.add(fillKey);
    return { ok: true, kind: "applied" };
  }

  const reason = reasonFromEngineError(res.error);
  if (reason) {
    return { ok: false, kind: "quarantine", error: res.error, reason };
  }
  return { ok: false, kind: "halt", error: res.error };
}

/** @deprecated use applyAskFilled result kinds; kept for older tests that only check ok. */
export function classifyAskFilledFailure(error: string): "replay" | "quarantine" | "other" {
  if (/already mirrored|already (applied|consumed)/i.test(error)) return "replay";
  return reasonFromEngineError(error) ? "quarantine" : "other";
}

export function ahEscrowAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const addr = env.LOK_AH_ESCROW?.trim();
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : null;
}

export function ahEscrowClientConfig(env: NodeJS.ProcessEnv = process.env): {
  address: string;
  rpcUrl: string;
  chainId: number;
  feeBps: number;
  currency: ReturnType<typeof settlementCurrencyView>;
} | null {
  const address = ahEscrowAddress(env);
  // #272: only keyless public RPC in snapshots — never LOK_CHAIN_RPC secrets.
  const rpcUrl = resolvePublicRpcUrl(env);
  if (!address || !rpcUrl) return null;
  if (!/^https?:\/\//i.test(rpcUrl) && !rpcUrl.startsWith("ws")) return null;
  // Prefer RPC-cached eth_chainId (boot refresh); fall back to LOK_CHAIN_ID.
  const chainId = settlementChainId(env);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  // Matches AhEscrow.FEE_BPS (redeploy package). Override only for tests.
  const feeRaw = env.LOK_AH_FEE_BPS?.trim();
  const feeBps = feeRaw && /^\d+$/.test(feeRaw) ? Number(feeRaw) : 100;
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 10_000) return null;
  return { address, rpcUrl, chainId, feeBps, currency: settlementCurrencyView(chainId) };
}

export function askFilledCursorPath(dataDir: string): string {
  return join(dataDir, "lok-ask-filled-cursor.json");
}

export function readAskFilledCursor(
  path: string,
  opts?: { expectedChainId?: number; expectedAddress?: string },
): bigint {
  if (opts?.expectedChainId != null && opts.expectedAddress) {
    return readWatcherCursor({
      path,
      expectedChainId: opts.expectedChainId,
      expectedAddress: opts.expectedAddress,
      onMismatch: (reason) =>
        console.warn("[bellgrave] AskFilled " + reason + " — falling back to deploy block"),
    });
  }
  if (!existsSync(path)) return 0n;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { cursor?: string };
    if (!parsed.cursor || !/^\d+$/.test(parsed.cursor)) return 0n;
    return BigInt(parsed.cursor);
  } catch {
    return 0n;
  }
}

export function writeAskFilledCursor(
  path: string,
  cursor: bigint,
  opts?: { chainId: number; address: string },
): void {
  if (opts) {
    writeWatcherCursor({ path, cursor, chainId: opts.chainId, address: opts.address });
    return;
  }
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ cursor: cursor.toString() }));
  renameSync(tmp, path);
}

export async function scanAskFilled(opts: {
  cursor: bigint;
  escrow: string;
  rpcCall: (method: string, params: unknown[]) => Promise<unknown>;
  apply: (fill: AskFilled, fillKey: string, log: RpcLog) => ApplyAskFilledResult;
  quarantine?: AskFilledQuarantine;
  /** Blocks behind tip (default ASK_FILL_CONFIRMATIONS / settlementConfirmations). */
  confirmations?: bigint;
  /** When cursor is 0, begin here (deploy block) instead of genesis. */
  startBlock?: bigint;
  /** Prefer eth_getBlockByNumber("finalized") as safe head (Gnosis). */
  preferFinalized?: boolean;
}): Promise<{ cursor: bigint }> {
  const confirmations = opts.confirmations ?? ASK_FILL_CONFIRMATIONS;
  const head = await settlementSafeHead({
    rpcCall: opts.rpcCall,
    confirmations,
    preferFinalized: opts.preferFinalized === true,
  });
  const safeHead = head.safeHead;
  if (safeHead < opts.cursor) return { cursor: opts.cursor };

  // Page getLogs in 2k-block chunks so L2 RPCs with range limits still work.
  const PAGE = 2000n;
  const start = opts.startBlock ?? 0n;
  let from = opts.cursor === 0n ? start : opts.cursor;
  if (from > safeHead) return { cursor: opts.cursor };
  let cursor = safeHead + 1n;
  while (from <= safeHead) {
    const to = from + PAGE - 1n > safeHead ? safeHead : from + PAGE - 1n;
    const logs = (await opts.rpcCall("eth_getLogs", [
      {
        address: opts.escrow,
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        topics: [ASK_FILLED_TOPIC],
      },
    ])) as RpcLog[];
    if (!Array.isArray(logs)) throw new Error("eth_getLogs returned no list");
    const ordered = logs
      .slice()
      .sort((a, b) => cmpHex(a.blockNumber, b.blockNumber) || cmpHex(a.logIndex, b.logIndex));
    for (const log of ordered) {
      const fill = decodeAskFilled(log);
      if (!fill) continue;
      const key = fillKeyOf(log);
      const res = opts.apply(fill, key, log);
      if (res.ok) continue;
      if (res.kind === "quarantine") {
        if (opts.quarantine) {
          const entry: QuarantinedAskFill = {
            id: key,
            reason: res.reason,
            error: res.error,
            fill,
            blockNumber: log.blockNumber ?? "0x0",
            logIndex: log.logIndex ?? "0x0",
            transactionHash: log.transactionHash ?? "",
            quarantinedAt: new Date().toISOString(),
          };
          if (opts.quarantine.add(entry)) alertAskFilledQuarantine(entry);
        }
        continue;
      }
      // halt
      cursor = BigInt(log.blockNumber && log.blockNumber !== "0x" ? log.blockNumber : "0x0");
      return { cursor };
    }
    from = to + 1n;
  }
  return { cursor };
}

export type AskFilledApplied = AskFilled & { sellerTokenId?: string };

export function startAskFilledWatcher(
  lok: Pick<LokWorld, "noteChainFill" | "chainFill" | "listingOf" | "hasChainFill" | "chainFillKeys">,
  opts?: {
    cursorPath?: string;
    dataDir?: string;
    onFilled?: (fill: AskFilledApplied, fillKey: string) => void;
    env?: NodeJS.ProcessEnv;
  },
): void {
  const env = opts?.env ?? process.env;
  const escrow = ahEscrowAddress(env);
  if (!escrow) return;
  const urls = (env.LOK_CHAIN_RPC?.trim() || env.LOK_CHAIN_RPC_URLS?.trim() || "").length > 0;
  if (!urls) return;
  const rpc = settlementRpc(env);
  const dataDir = opts?.dataDir ?? defaultLokDir();
  const cursorPath = opts?.cursorPath ?? askFilledCursorPath(dataDir);
  const quarantine = new AskFilledQuarantine(askFilledQuarantinePath(dataDir));
  const mirrored = new MirroredFills(askFilledMirroredPath(dataDir));
  // Side file is a cache: warm it from ChainFill entries already on the log.
  for (const key of lok.chainFillKeys()) mirrored.add(key);
  if (quarantine.list().length > 0) {
    console.error(
      "[bellgrave] ALERT " +
        quarantine.list().length +
        " AskFilled fill(s) still quarantined — pnpm --filter @bellgrave/server lok:replay-ask-filled --list",
    );
  }
  const confirmations = settlementConfirmations(env);
  const startBlock = watcherStartBlock(env);
  const chainId = settlementChainId(env);
  console.log(
    "[bellgrave] AhEscrow watcher rpc=" +
      redactRpcUrl(rpc.currentUrl()) +
      " fallbacks=" +
      Math.max(0, rpc.urls.length - 1) +
      " escrow=" +
      escrow +
      " chain=" +
      chainId +
      " confirmations=" +
      confirmations.toString() +
      " finalized=" +
      preferFinalizedTip(env) +
      " startBlock=" +
      startBlock.toString(),
  );
  let cursor = readAskFilledCursor(cursorPath, {
    expectedChainId: chainId,
    expectedAddress: escrow,
  });
  let busy = false;
  let haltedLogged = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const next = await scanAskFilled({
        cursor,
        escrow,
        quarantine,
        confirmations,
        startBlock,
        preferFinalized: preferFinalizedTip(env),
        rpcCall: rpc.asCall(),
        apply: (fill, fillKey, log) => {
          const beforeSeller = lok.listingOf(fill.listingId)?.seller;
          const res = applyAskFilled(lok, fill, fillKey, { mirrored, log });
          if (res.ok && res.kind === "applied") {
            console.log(
              "[bellgrave] chainFill listing=" +
                fill.listingId +
                " buyer=" +
                fill.buyerTokenId +
                " price=" +
                fill.priceWei +
                " key=" +
                fillKey,
            );
            opts?.onFilled?.({ ...fill, sellerTokenId: beforeSeller }, fillKey);
            haltedLogged = false;
            return res;
          }
          if (res.ok) {
            haltedLogged = false;
            return res;
          }
          if (res.kind === "halt") {
            if (!haltedLogged) {
              console.error(
                "[bellgrave] AskFilled halted listing=" + fill.listingId + " key=" + fillKey + ": " + res.error,
              );
              haltedLogged = true;
            }
          }
          return res;
        },
      });
      cursor = next.cursor;
      writeAskFilledCursor(cursorPath, cursor, { chainId, address: escrow });
      rpc.noteCursor("askFilled", cursor);
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
          msg: "AskFilled watcher lag=" + lag.toString() + " blocks",
          watcher: "askFilled",
          lagBlocks: lag.toString(),
          tip: rpc.stats.tipBlock?.toString() ?? null,
          cursor: cursor.toString(),
          threshold: lagAlert.toString(),
          dedupeKey: "lag:askFilled:" + lag.toString(),
        });
      }
    } catch (err) {
      console.error("[bellgrave] AhEscrow watcher", err);
    } finally {
      busy = false;
    }
  };
  tick().catch((err) => console.error("[bellgrave] AhEscrow watcher", err));
  const timer = setInterval(() => {
    tick().catch((err) => console.error("[bellgrave] AhEscrow watcher", err));
  }, 4000);
  timer.unref?.();
}

let listingKeyWarned = false;

/**
 * Listing signer for AhEscrow. When AhEscrow is configured, LOK_LISTING_KEY is
 * required (Deploy.s.sol grants LISTING_ROLE to LISTING/ROTATOR, not the owner).
 * Falling back to LOK_OWNER_KEY only when AhEscrow is unset (local engine-only).
 */
export function listingRoleKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const listing = env.LOK_LISTING_KEY?.trim() || "";
  if (/^0x[0-9a-fA-F]{64}$/.test(listing)) return listing;
  if (ahEscrowAddress(env)) {
    if (!listingKeyWarned) {
      listingKeyWarned = true;
      console.error(
        "[bellgrave] LOK_LISTING_KEY is required when AhEscrow is configured. " +
          "LOK_OWNER_KEY does not hold LISTING_ROLE on Deploy-wired chains; openAsk/cancelAsk will fail.",
      );
    }
    return null;
  }
  const owner = env.LOK_OWNER_KEY?.trim() || "";
  return /^0x[0-9a-fA-F]{64}$/.test(owner) ? owner : null;
}

function cmpHex(a: string | undefined, b: string | undefined): number {
  const left = BigInt(a && a !== "0x" ? a : "0x0");
  const right = BigInt(b && b !== "0x" ? b : "0x0");
  return left < right ? -1 : left > right ? 1 : 0;
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
