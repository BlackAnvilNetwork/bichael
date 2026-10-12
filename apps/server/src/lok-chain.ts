import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DepositQuarantine, depositQuarantinePath, type QuarantinedInbound, type QuarantineReason } from "./lok-deposit-quarantine";
import { defaultLokDir, type LokWorld } from "./lok-world";

/** Keccak of KekDepositRequested(uint256,uint64,uint256,address). */
export const KEK_DEPOSIT_TOPIC = "0x44f9238c77e838571825580331e7e82218690fd4282906f9c351f6b85533ef47";
/** Keccak of ItemImportRequested(uint256,uint64,uint256,uint32,address). */
export const ITEM_IMPORT_TOPIC = "0xf6727226080847e6097c252c5a6e8dd0c52fe516569f787bd4962c417646441f";

export type KekDeposit = { tokenId: string; nonce: string; amount: string };
export type ItemImport = { tokenId: string; nonce: string; itemId: string; amount: string };
export type ChainInbound =
  | ({ kind: "depositKek" } & KekDeposit)
  | ({ kind: "importItem" } & ItemImport);

const here = dirname(fileURLToPath(import.meta.url));

/** Fill empty env keys from a gitignored local file. Never overrides a value already set. */
export function loadLokEnv(env: NodeJS.ProcessEnv = process.env, paths?: string[]): void {
  const files = paths ?? [join(here, "../.env.local"), join(here, "../../../.env.local")];
  for (const path of files) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (env[key] == null || env[key] === "") env[key] = value;
    }
  }
}

export function decodeKekDeposit(log: { topics?: string[]; data?: string }): KekDeposit | null {
  const topics = log.topics ?? [];
  if (topics.length < 3 || topics[0]?.toLowerCase() !== KEK_DEPOSIT_TOPIC.toLowerCase()) return null;
  const data = log.data ?? "";
  if (!data.startsWith("0x") || data.length < 2 + 64) return null;
  try {
    return {
      tokenId: BigInt(topics[1]!).toString(),
      nonce: BigInt(topics[2]!).toString(),
      amount: BigInt(data.slice(0, 2 + 64)).toString(),
    };
  } catch {
    return null;
  }
}

export function decodeItemImport(log: { topics?: string[]; data?: string }): ItemImport | null {
  const topics = log.topics ?? [];
  if (topics.length < 3 || topics[0]?.toLowerCase() !== ITEM_IMPORT_TOPIC.toLowerCase()) return null;
  const data = log.data ?? "";
  // abi.encode(uint256 itemId, uint32 amount, address from) => 96 bytes
  if (!data.startsWith("0x") || data.length < 2 + 64 * 2) return null;
  try {
    const itemId = BigInt("0x" + data.slice(2, 2 + 64)).toString();
    const amountWord = BigInt("0x" + data.slice(2 + 64, 2 + 128));
    return {
      tokenId: BigInt(topics[1]!).toString(),
      nonce: BigInt(topics[2]!).toString(),
      itemId,
      amount: amountWord.toString(),
    };
  } catch {
    return null;
  }
}

export function decodeChainInbound(log: { topics?: string[]; data?: string }): ChainInbound | null {
  const deposit = decodeKekDeposit(log);
  if (deposit) return { kind: "depositKek", ...deposit };
  const item = decodeItemImport(log);
  if (item) return { kind: "importItem", ...item };
  return null;
}

/** Record a vault deposit the server already saw, then credit that character's log. Not a mint. */
export function applyKekDeposit(
  lok: Pick<LokWorld, "noteCustodyInbound" | "depositKek">,
  deposit: KekDeposit,
): { ok: true } | { ok: false; error: string } {
  lok.noteCustodyInbound({
    kind: "depositKek",
    tokenId: deposit.tokenId,
    nonce: deposit.nonce,
    amount: deposit.amount,
  });
  return lok.depositKek(deposit.tokenId, deposit.amount, deposit.nonce);
}

/** Record a chain item import the server already saw, then credit that character's log. */
export function applyItemImport(
  lok: Pick<LokWorld, "noteCustodyInbound" | "importItem">,
  inbound: ItemImport,
): { ok: true } | { ok: false; error: string } {
  lok.noteCustodyInbound({
    kind: "importItem",
    tokenId: inbound.tokenId,
    nonce: inbound.nonce,
    itemId: inbound.itemId,
    amount: inbound.amount,
  });
  return lok.importItem(inbound.tokenId, inbound.itemId, inbound.amount, inbound.nonce);
}

export function applyChainInbound(
  lok: Pick<LokWorld, "noteCustodyInbound" | "depositKek" | "importItem">,
  inbound: ChainInbound,
): { ok: true } | { ok: false; error: string } {
  if (inbound.kind === "depositKek") return applyKekDeposit(lok, inbound);
  return applyItemImport(lok, inbound);
}

type RpcLog = { topics?: string[]; data?: string; blockNumber?: string; logIndex?: string; transactionHash?: string };

/** Blocks a deposit must sit before it can be credited. Anvil's finalized tag is genesis here, so depth is used instead. */
export const DEPOSIT_CONFIRMATIONS = 2n;

export function depositCursorPath(dataDir: string): string {
  return join(dataDir, "lok-deposit-cursor.json");
}

export function readDepositCursor(path: string): bigint {
  if (!existsSync(path)) return 0n;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { cursor?: string };
    if (!parsed.cursor || !/^\d+$/.test(parsed.cursor)) return 0n;
    return BigInt(parsed.cursor);
  } catch {
    return 0n;
  }
}

export function writeDepositCursor(path: string, cursor: bigint): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ cursor: cursor.toString() }));
  renameSync(tmp, path);
}

/** True only for an inbound nonce already applied (strictly below the next expected). Gaps must not match. */
export function depositAlreadyConsumed(error: string): boolean {
  return /already consumed/i.test(error) && !/out of order/i.test(error);
}

export function inboundIsGap(error: string): boolean {
  return /out of order/i.test(error);
}

/** Classify a failed apply against the next expected nonce for that character. */
export function classifyInboundFailure(
  expectedNext: number,
  nonce: string,
  error: string,
): "replay" | "gap" | "other" {
  let n: bigint;
  try {
    n = BigInt(nonce);
  } catch {
    return "other";
  }
  if (n > 0n && n < BigInt(expectedNext)) return "replay";
  if (n > BigInt(expectedNext) || inboundIsGap(error)) return "gap";
  if (depositAlreadyConsumed(error)) return "replay";
  return "other";
}

export async function scanKekDeposits(opts: {
  cursor: bigint;
  checkpoint: string;
  rpcCall: (method: string, params: unknown[]) => Promise<unknown>;
  apply: (deposit: KekDeposit) => { ok: true } | { ok: false; error: string };
  /** Optional: next expected inbound nonce for a token. Used to classify replay vs gap. */
  expectedNonce?: (tokenId: string) => number;
}): Promise<{ cursor: bigint }> {
  return scanChainInbounds({
    cursor: opts.cursor,
    checkpoint: opts.checkpoint,
    rpcCall: opts.rpcCall,
    expectedNonce: opts.expectedNonce,
    apply: (inbound) => {
      if (inbound.kind !== "depositKek") return { ok: true };
      return opts.apply(inbound);
    },
  });
}

/**
 * Engine refusals that retrying the same event can never fix. These are
 * quarantined instead of halting the cursor for every player.
 */
export function permanentInboundError(error: string): QuarantineReason | null {
  if (/character is not spawned/i.test(error)) return "unknown-token";
  if (/id is empty or invalid|amount must be greater than zero|balance overflow/i.test(error)) return "unprocessable";
  return null;
}

/** Stable id of a chain log: blockNumber:logIndex. */
export function inboundLogId(log: { blockNumber?: string; logIndex?: string }): string {
  const hex = (v: string | undefined) => "0x" + BigInt(v && v !== "0x" ? v : "0x0").toString(16);
  return hex(log.blockNumber) + ":" + hex(log.logIndex);
}

export type InboundQuarantine = Pick<DepositQuarantine, "has" | "add" | "explainsGap">;

export async function scanChainInbounds(opts: {
  cursor: bigint;
  checkpoint: string;
  rpcCall: (method: string, params: unknown[]) => Promise<unknown>;
  apply: (inbound: ChainInbound) => { ok: true } | { ok: false; error: string };
  expectedNonce?: (tokenId: string) => number;
  /**
   * Where permanently unprocessable events go. Without it the old behavior
   * stands: undecodable logs are skipped and every other refusal halts.
   */
  quarantine?: InboundQuarantine;
  /** Alert sink for quarantines and halts. Defaults to console.error. */
  alert?: (message: string) => void;
  now?: () => Date;
}): Promise<{ cursor: bigint; halted?: { id: string; kind: "gap" | "other"; error: string }; quarantined: string[] }> {
  const alert = opts.alert ?? ((message: string) => console.error(message));
  const quarantined: string[] = [];
  // RPC failures throw out of here before the cursor moves: a transient error halts and retries.
  const latest = BigInt(String(await opts.rpcCall("eth_blockNumber", [])));
  if (latest < DEPOSIT_CONFIRMATIONS) return { cursor: opts.cursor, quarantined };
  const safeHead = latest - DEPOSIT_CONFIRMATIONS;
  if (safeHead < opts.cursor) return { cursor: opts.cursor, quarantined };
  const logs = (await opts.rpcCall("eth_getLogs", [
    {
      address: opts.checkpoint,
      fromBlock: "0x" + opts.cursor.toString(16),
      toBlock: "0x" + safeHead.toString(16),
      topics: [[KEK_DEPOSIT_TOPIC, ITEM_IMPORT_TOPIC]],
    },
  ])) as RpcLog[];
  if (!Array.isArray(logs)) throw new Error("eth_getLogs returned no list");
  let cursor = safeHead + 1n;
  const ordered = logs
    .slice()
    .sort((a, b) => cmpHex(a.blockNumber, b.blockNumber) || cmpHex(a.logIndex, b.logIndex));
  const topicOk = (log: RpcLog) => {
    const t = (log.topics?.[0] ?? "").toLowerCase();
    return t === KEK_DEPOSIT_TOPIC.toLowerCase() || t === ITEM_IMPORT_TOPIC.toLowerCase();
  };
  const park = (log: RpcLog, id: string, inbound: ChainInbound | null, reason: QuarantineReason, error: string) => {
    const entry: QuarantinedInbound = {
      id,
      reason,
      error,
      inbound,
      tokenId: inbound?.tokenId ?? safeBig(log.topics?.[1]),
      nonce: inbound?.nonce ?? safeBig(log.topics?.[2]),
      blockNumber: log.blockNumber ?? "",
      logIndex: log.logIndex ?? "",
      transactionHash: log.transactionHash ?? "",
      topics: [...(log.topics ?? [])],
      data: log.data ?? "",
      quarantinedAt: (opts.now?.() ?? new Date()).toISOString(),
    };
    // Persisted before the cursor moves past it. A write failure throws and the cursor stays.
    if (opts.quarantine!.add(entry)) {
      quarantined.push(id);
      alert(
        "[bellgrave] ALERT chain inbound quarantined id=" +
          id +
          " reason=" +
          reason +
          " kind=" +
          (inbound?.kind ?? "?") +
          " token=" +
          entry.tokenId +
          " nonce=" +
          entry.nonce +
          (inbound && inbound.kind === "depositKek" ? " amount=" + inbound.amount : "") +
          " tx=" +
          (entry.transactionHash || "?") +
          ": " +
          error +
          ". It is in vault custody with no log credit. Deposits for everyone else keep flowing. " +
          "Fix the cause, stop the server, then run: pnpm --filter @bellgrave/server lok:replay-quarantined " +
          id,
      );
    }
  };
  for (const log of ordered) {
    if (!topicOk(log)) continue;
    const id = inboundLogId(log);
    if (opts.quarantine?.has(id)) continue;
    const inbound = decodeChainInbound(log);
    if (!inbound) {
      if (opts.quarantine) park(log, id, null, "bad-shape", "event did not decode");
      continue;
    }
    if (opts.quarantine && (inbound.nonce === "0" || inbound.tokenId === "0")) {
      park(log, id, inbound, "bad-shape", "token id or nonce is zero");
      continue;
    }
    const res = opts.apply(inbound);
    if (res.ok) continue;
    const expected = opts.expectedNonce?.(inbound.tokenId) ?? 1;
    // Only a nonce strictly below the next expected one is an already-applied replay.
    if (BigInt(inbound.nonce) < BigInt(expected)) continue;
    const permanent = permanentInboundError(res.error);
    if (permanent && opts.quarantine) {
      park(log, id, inbound, permanent, res.error);
      continue;
    }
    const kind = classifyInboundFailure(expected, inbound.nonce, res.error);
    if (kind === "replay") continue;
    if (kind === "gap" && opts.quarantine?.explainsGap(inbound.tokenId, expected, inbound.nonce)) {
      park(log, id, inbound, "behind-quarantined-nonce", res.error);
      continue;
    }
    // A nonce gap with no quarantined explanation, or an unclassified refusal:
    // halt the cursor at this block so it is retried and nothing is skipped.
    cursor = BigInt(log.blockNumber && log.blockNumber !== "0x" ? log.blockNumber : "0x0");
    alert(
      "[bellgrave] chain inbound halted (" +
        kind +
        ") id=" +
        id +
        " token=" +
        inbound.tokenId +
        " nonce=" +
        inbound.nonce +
        " expected=" +
        expected +
        ": " +
        res.error,
    );
    return { cursor, halted: { id, kind, error: res.error }, quarantined };
  }
  return { cursor, quarantined };
}

function safeBig(value: string | undefined): string {
  try {
    return value ? BigInt(value).toString() : "";
  } catch {
    return "";
  }
}

export function startKekDepositWatcher(
  lok: Pick<LokWorld, "noteCustodyInbound" | "depositKek" | "importItem" | "inboundAppliedOf">,
  cursorPath = depositCursorPath(defaultLokDir()),
): void {
  const rpc = process.env.LOK_CHAIN_RPC?.trim();
  const checkpoint = process.env.LOK_CHECKPOINT?.trim();
  if (!rpc || !checkpoint) return;
  const vault = process.env.LOK_VAULT?.trim() || "-";
  const kek = process.env.LOK_KEK?.trim() || "-";
  console.log(
    "[bellgrave] lok watcher rpc=" +
      rpc +
      " checkpoint=" +
      checkpoint +
      " vault=" +
      vault +
      " kek=" +
      kek +
      " confirmations=" +
      DEPOSIT_CONFIRMATIONS.toString(),
  );
  let cursor = readDepositCursor(cursorPath);
  // A corrupt quarantine file throws here and stops boot: it lists custody KEK with no log credit.
  const quarantine = new DepositQuarantine(depositQuarantinePath(dirname(cursorPath)));
  const parked = quarantine.list();
  if (parked.length > 0) {
    console.error(
      "[bellgrave] ALERT " +
        parked.length +
        " chain inbound(s) are quarantined with no log credit: " +
        parked.map((e) => e.id + " (token " + e.tokenId + " nonce " + e.nonce + ", " + e.reason + ")").join(", ") +
        ". See pnpm --filter @bellgrave/server lok:replay-quarantined --list",
    );
  }
  let busy = false;
  let lastHalt = "";
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const next = await scanChainInbounds({
        cursor,
        checkpoint,
        rpcCall: (method, params) => jsonRpc(rpc, method, params),
        expectedNonce: (tokenId) => (lok.inboundAppliedOf?.(tokenId) ?? 0) + 1,
        quarantine,
        // Log a standing halt once, not every 4s.
        alert: (message) => {
          if (message.includes(" halted (")) {
            if (message === lastHalt) return;
            lastHalt = message;
          }
          console.error(message);
        },
        apply: (inbound) => {
          const res = applyChainInbound(lok, inbound);
          if (res.ok) {
            if (inbound.kind === "depositKek") {
              console.log(
                "[bellgrave] credited KEK deposit token=" +
                  inbound.tokenId +
                  " nonce=" +
                  inbound.nonce +
                  " amount=" +
                  inbound.amount,
              );
            } else {
              console.log(
                "[bellgrave] credited item import token=" +
                  inbound.tokenId +
                  " nonce=" +
                  inbound.nonce +
                  " item=" +
                  inbound.itemId +
                  " amount=" +
                  inbound.amount,
              );
            }
          }
          return res;
        },
      });
      if (!next.halted) lastHalt = "";
      cursor = next.cursor;
      writeDepositCursor(cursorPath, cursor);
    } finally {
      busy = false;
    }
  };
  tick().catch((err) => console.error("[bellgrave] lok watcher", err));
  const timer = setInterval(() => {
    tick().catch((err) => console.error("[bellgrave] lok watcher", err));
  }, 4000);
  timer.unref?.();
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
