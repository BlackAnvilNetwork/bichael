import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LokWorld } from "./lok-world";

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
  const files =
    paths ??
    [
      join(here, "../.env.local"),
      join(here, "../../../.env.local"),
      // Cloud Agent secure store (never committed).
      "/cursor/stores/self/secure/server-keys.env",
    ];
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

type RpcLog = { topics?: string[]; data?: string; blockNumber?: string; logIndex?: string };

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

export async function scanChainInbounds(opts: {
  cursor: bigint;
  checkpoint: string;
  rpcCall: (method: string, params: unknown[]) => Promise<unknown>;
  apply: (inbound: ChainInbound) => { ok: true } | { ok: false; error: string };
  expectedNonce?: (tokenId: string) => number;
  /** Blocks behind tip (default DEPOSIT_CONFIRMATIONS). */
  confirmations?: bigint;
}): Promise<{ cursor: bigint }> {
  const confirmations = opts.confirmations ?? DEPOSIT_CONFIRMATIONS;
  const latest = BigInt(String(await opts.rpcCall("eth_blockNumber", [])));
  if (latest < confirmations) return { cursor: opts.cursor };
  const safeHead = latest - confirmations;
  if (safeHead < opts.cursor) return { cursor: opts.cursor };
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
  for (const log of ordered) {
    const inbound = decodeChainInbound(log);
    if (!inbound) continue;
    const res = opts.apply(inbound);
    if (res.ok) continue;
    const expected = opts.expectedNonce?.(inbound.tokenId) ?? 1;
    const kind = classifyInboundFailure(expected, inbound.nonce, res.error);
    if (kind === "replay") continue;
    // Gap or other hard failure: halt the cursor at this block so we retry.
    cursor = BigInt(log.blockNumber && log.blockNumber !== "0x" ? log.blockNumber : "0x0");
    break;
  }
  return { cursor };
}

function cmpHex(a: string | undefined, b: string | undefined): number {
  const left = BigInt(a && a !== "0x" ? a : "0x0");
  const right = BigInt(b && b !== "0x" ? b : "0x0");
  return left < right ? -1 : left > right ? 1 : 0;
}
