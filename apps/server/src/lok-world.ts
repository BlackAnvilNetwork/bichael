import {
  appendFileSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNetworkName } from "@bellgrave/config";
import type { LokListingView, LokSnapshot } from "@bellgrave/protocol";
import { projectLightCharacters, type LightCharacter } from "./character-light-proof";
import { characterNameKey, normalizeCharacterName } from "./character-name";
import { acquireDataDirLock } from "./data-dir-lock";
import { durableWrite } from "./durable-write";
import { exploreDocument, type LokExplorePage } from "./lok-explore";
import { defaultWasmPath, loadLokExports, lokCall, lokOut, type LokExports } from "./lok-engine";
import { LOCAL_RULESET_HASH } from "./lok-vault";
import { TickCoalesce, type CoalescedEvent } from "./log-coalesce";

/**
 * Craft skill-validation cutoff (global world seq) for this network.
 * Legacy local anvil may have pre-#222 crafts below seq 175; Chiado/Gnosis are fresh → 0.
 * Override with LOK_CRAFT_VALIDATE_MIN_SEQ when needed.
 */
export function craftValidateMinSeqForNetwork(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LOK_CRAFT_VALIDATE_MIN_SEQ?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  const network = resolveNetworkName(env as Record<string, string | undefined>);
  if (network === "anvil") return 175;
  return 0;
}

export type LokResult = { ok: true } | { ok: false; error: string };

type EngineItem = { itemId: string; amount: string };
type EngineCraft = { itemId: string; amount: string };
type EngineHarvest = { materialId: string; amount: string };
type EngineDrop = { itemId: string; amount: string };
type EngineCraftSkill = { skillId: string; level: number };
type EngineCharacter = {
  tokenId: string;
  /** In-game gold (log-only). Absent on logs that never earned gold. */
  gold?: string;
  inboundApplied?: number;
  level?: number;
  abilities?: string[];
  crafts?: EngineCraft[];
  craftSkills?: EngineCraftSkill[];
  harvests?: EngineHarvest[];
  drops?: EngineDrop[];
  inbox?: EngineItem[];
  droppedSkills?: string[];
  items: EngineItem[];
};
type EngineListing = {
  id: string;
  seller: string;
  itemId: string;
  amount: string;
  highBidder: string | null;
  highBid: string;
  minPrice?: string;
  listedAt?: number;
  book?: boolean;
};
type EnginePvpBounty = { tokenId: string; amountWei: string; areaId: string };
type EngineState = {
  characters: EngineCharacter[];
  listings: EngineListing[];
  pvpBounties?: EnginePvpBounty[];
};
type ApplyBody = {
  ok?: boolean;
  error?: string;
  entry?: unknown;
  len?: number;
  state?: EngineState;
};

type BindChar = { charId: string; tokenId: string; name: string; job: number; wallet?: string };
type ReservedName = { charId: string; name: string; wallet?: string; at: number };
type BindFile = { nextToken: string; nextListing: string; chars: BindChar[]; reserved: ReservedName[] };

export const MAX_CHARS_PER_WALLET = 8;
export const NAME_RESERVE_MS = 10 * 60_000;

/**
 * Accepted events between full-document snapshots.
 * Each applied event appends one JSONL line (lok-world.jsonl). lok-world.json,
 * the engine document, is rewritten only this often, plus once when the file
 * is first created. Startup replays at most this many journal lines after the
 * snapshot, so a crash stays a bounded replay instead of a full rewrite on
 * every event. 128 keeps that tail well under a tenth of a second even if an
 * apply costs about a millisecond, and it keeps a multi-megabyte snapshot
 * (about 2s and 11MB at 20k events in the measured full-file rewrite) off the
 * path of every action.
 */
export const LOG_SNAPSHOT_EVERY = 128;

/**
 * Whole asks one quantity-buy message may fill.
 * The previous loop ran up to 10_000 synchronous fills and rewrote the whole
 * log after each one, so any player could freeze the server for minutes.
 * 32 asks is a useful commodity sweep. Together with a yield every
 * BUY_FILL_BATCH fills, one message cannot hold the event loop for that loop.
 * Past the cap the result is an explicit partial: filled asks were charged at
 * their own prices, and nothing past the cap is charged. Listings are still
 * taken whole, so this counts asks, not loose items.
 */
export const MAX_FILLS_PER_BUY_MESSAGE = 32;

/** Successful fills applied before a quantity buy lets the event loop run. */
export const BUY_FILL_BATCH = 8;

/** An item import the server recorded from custody. The game client cannot insert these. */
export type CustodyInbound = {
  kind: "importItem";
  tokenId: string;
  nonce: string;
  itemId: string;
  amount: string;
};

const KEK_RETIRED: LokResult = { ok: false, error: "KEK custody is retired" };

/** AhEscrow AskFilled the server already saw. Client messages cannot invent these. */
export type ChainFillInbound = {
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

const here = dirname(fileURLToPath(import.meta.url));

export function defaultLokDir(): string {
  return process.env.LOK_DATA_DIR?.trim() || join(here, "../data");
}

export function chainModeFromEnv(env: NodeJS.ProcessEnv = process.env): {
  chain: LokSnapshot["chain"];
  note: string;
} {
  const rpc = env.LOK_CHAIN_RPC?.trim();
  if (!rpc) {
    return {
      chain: "engine-only",
      note: "No LOK_CHAIN_RPC. The log governs items and gold only — no vault deposit path. AH pays ETH on-chain via AhEscrow / EEZ when configured.",
    };
  }
  if (env.LOK_AH_ESCROW?.trim()) {
    return {
      chain: "watching",
      note: "Watching AhEscrow AskFilled. Item fills mirror into the log; ETH never credits a character balance.",
    };
  }
  return {
    chain: "rpc-unwatched",
    note: "LOK_CHAIN_RPC is set, but AhEscrow is not configured. AH ETH pay is not live on this server.",
  };
}

/** Filesystem-safe timestamp for backup file names (no ':' so it works on Windows). */
function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function atomicWrite(path: string, text: string) {
  durableWrite(path, text);
}

/** Bytes of the append journal already included in a snapshot. Old full-file logs have none. */
function journalCursor(text: string): number {
  const head = text.slice(0, 200);
  const matched = /"journalBytes"\s*:\s*(\d+)/.exec(head);
  if (!matched) return 0;
  const n = Number(matched[1]);
  return Number.isSafeInteger(n) ? n : 0;
}

function asItemId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function normalizeFillKey(fillKey: string): string {
  return fillKey.trim().toLowerCase();
}

/** Build fillKeys from ChainFill entries already on the engine document. */
export function collectChainFillKeys(logText: string): Set<string> {
  const keys = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(logText);
  } catch {
    return keys;
  }
  if (!parsed || typeof parsed !== "object") return keys;
  const characters = (parsed as { characters?: unknown }).characters;
  if (!Array.isArray(characters)) return keys;
  for (const row of characters) {
    if (!row || typeof row !== "object") continue;
    const entries = (row as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const input = (entry as { input?: unknown }).input;
      if (!input || typeof input !== "object") continue;
      const body = input as { type?: unknown; txHash?: unknown; logIndex?: unknown };
      if (body.type !== "chainFill") continue;
      if (typeof body.txHash !== "string" || !body.txHash.startsWith("0x")) continue;
      let idx: string;
      if (typeof body.logIndex === "number" && Number.isFinite(body.logIndex)) {
        idx = String(body.logIndex);
      } else if (typeof body.logIndex === "string" && /^\d+$/.test(body.logIndex)) {
        idx = body.logIndex;
      } else {
        continue;
      }
      keys.add(normalizeFillKey(body.txHash + "-" + idx));
    }
  }
  return keys;
}

const PVP_MIRROR_TYPES = new Set(["pvpBountyOpen", "pvpBountyCancel", "pvpKill"]);

/** Build fillKeys from PvP escrow mirrors already on the engine document. */
export function collectPvpFillKeys(logText: string): Set<string> {
  const keys = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(logText);
  } catch {
    return keys;
  }
  if (!parsed || typeof parsed !== "object") return keys;
  const characters = (parsed as { characters?: unknown }).characters;
  if (!Array.isArray(characters)) return keys;
  for (const row of characters) {
    if (!row || typeof row !== "object") continue;
    const entries = (row as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const input = (entry as { input?: unknown }).input;
      if (!input || typeof input !== "object") continue;
      const body = input as { type?: unknown; txHash?: unknown; logIndex?: unknown };
      if (typeof body.type !== "string" || !PVP_MIRROR_TYPES.has(body.type)) continue;
      if (typeof body.txHash !== "string" || !body.txHash.startsWith("0x")) continue;
      let idx: string;
      if (typeof body.logIndex === "number" && Number.isFinite(body.logIndex)) {
        idx = String(body.logIndex);
      } else if (typeof body.logIndex === "string" && /^\d+$/.test(body.logIndex)) {
        idx = body.logIndex;
      } else {
        continue;
      }
      keys.add(normalizeFillKey(body.txHash + "-" + idx));
    }
  }
  return keys;
}

/**
 * One hash chain per character. The wasm engine accepts or rejects every move.
 * Deposit credits KEK the caller already holds in custody. It does not mint.
 * WithdrawKek decreases spendable KEK and does not submit an onchain withdrawal.
 */
function coalescedCmd(row: CoalescedEvent): Record<string, unknown> {
  if (row.op === "harvest") {
    return { op: "harvest", tokenId: row.tokenId, materialId: row.materialId, amount: row.amount };
  }
  if (row.op === "lootDrop") {
    return {
      op: "lootDrop",
      tokenId: row.tokenId,
      itemId: row.itemId,
      amount: row.amount,
      killId: row.killId,
      batchId: row.batchId,
    };
  }
  return { op: "goldEarn", tokenId: row.tokenId, source: row.source, amount: row.amount, day: row.day };
}

export class LokWorld {
  readonly logPath: string;
  readonly journalPath: string;
  readonly chain: LokSnapshot["chain"];
  readonly chainNote: string;
  private readonly exp: LokExports;
  private readonly bindPath: string;
  private bind: BindFile;
  private state: EngineState = { characters: [], listings: [], pvpBounties: [] };
  /** Custody nonces observed by the server. Not loaded from the client and not a chain watcher. */
  private custody = new Map<string, CustodyInbound>();
  private chainFills = new Map<string, ChainFillInbound>();
  /** fillKeys already journaled as ChainFill (txHash-logIndex). Source of truth for AskFilled replay. */
  private appliedChainFillKeys = new Set<string>();
  /** PvP mirror fillKeys (txHash-logIndex). A receipt cannot open, cancel, and kill as three events. */
  private appliedPvpFillKeys = new Set<string>();
  /** Bytes of lok-world.jsonl already folded into the snapshot. */
  private journalBytes = 0;
  /** Accepted events since the snapshot on disk was rewritten. */
  private sinceSnapshot = 0;
  /** Open game tick. Journal lines stay in memory until endTick fsyncs once. */
  private journalHold = false;
  private journalPending: Buffer[] = [];
  /** Commands accepted since the last {@link takeCommittedCmds}. Replay does not push. */
  private committedCmds: Record<string, unknown>[] = [];
  /**
   * One append fd for the life of this world. Out-of-tick ops must not open and
   * close the journal on every call. There is no world close method; process
   * exit releases the fd. Durability is the fsync before the op returns.
   */
  private journalFd: number | null = null;
  private coalesce: TickCoalesce | null = null;
  /** Batch the live tick opened. A kill from an earlier batch is not in this set. */
  private openBatchId: number | null = null;
  /** Snapshot is due, but the tick must return before the full rewrite. */
  private snapshotDeferred = false;
  private snapshotQueued = false;
  /** Live document for the explorer. Cleared when an event is appended. */
  private cachedDoc: string | null = null;
  /** Proof rows for the cached document. */
  private lightRows: { doc: string; rows: LightCharacter[] } | null = null;
  length = 0;

  private constructor(dataDir: string, wasmPath: string, env: NodeJS.ProcessEnv) {
    mkdirSync(dataDir, { recursive: true });
    acquireDataDirLock(dataDir, env);
    this.logPath = join(dataDir, "lok-world.json");
    this.journalPath = join(dataDir, "lok-world.jsonl");
    this.bindPath = join(dataDir, "lok-bind.json");
    const mode = chainModeFromEnv(env);
    this.chain = mode.chain;
    this.chainNote = mode.note;
    this.exp = loadLokExports(wasmPath);
    this.exp.lok_set_craft_validate_min_seq(craftValidateMinSeqForNetwork(env));
    const text = existsSync(this.logPath) ? readFileSync(this.logPath, "utf8") : "";
    const cursor = journalCursor(text);
    const opened = lokCall(this.exp, text, (ptr, len) => this.exp.lok_open(ptr, len));
    if (opened.rc !== 0) {
      throw new Error("lok log refused to open: " + opened.out);
    }
    const stamped = lokCall(
      this.exp,
      JSON.stringify({ op: "setRuleset", rulesetHash: LOCAL_RULESET_HASH }),
      (ptr, len) => this.exp.lok_apply(ptr, len),
    );
    let stampedBody: { ok?: boolean; error?: string } = {};
    try {
      stampedBody = JSON.parse(stamped.out);
    } catch {
      stampedBody = {};
    }
    if (stamped.rc !== 0 || !stampedBody.ok) {
      throw new Error("lok ruleset was not stamped: " + (stampedBody.error || stamped.out));
    }
    this.replayJournal(cursor);
    this.bind = this.readBind();
    this.refresh();
    this.appliedChainFillKeys = collectChainFillKeys(this.logDocument());
    this.appliedPvpFillKeys = collectPvpFillKeys(this.logDocument());
    this.reconcileBind();
    this.pruneExpiredReservations();
    if (!existsSync(this.logPath)) this.snapshotLog();
    this.saveBind();
  }

  static open(dataDir = defaultLokDir(), wasmPath = defaultWasmPath(), env: NodeJS.ProcessEnv = process.env): LokWorld {
    return new LokWorld(dataDir, wasmPath, env);
  }

  tokenFor(charId: string): string | null {
    return this.bind.chars.find((c) => c.charId === charId)?.tokenId ?? null;
  }

  /** Next log token id the bind file would assign (may lag or lead the chain). */
  nextTokenId(): string {
    return this.bind.nextToken;
  }

  spawn(
    charId: string,
    name: string,
    job: number,
    wallet?: string,
    opts?: { tokenId?: string },
  ): { ok: true; tokenId: string } | { ok: false; error: string } {
    const existing = this.tokenFor(charId);
    if (existing) {
      if (wallet) this.bindWallet(charId, wallet);
      return { ok: true, tokenId: existing };
    }
    const owner = wallet?.trim().toLowerCase() || undefined;
    if (owner) {
      const capped = this.ensureWalletCapacity(owner, charId);
      if (!capped.ok) return capped;
    }
    const claimed = this.claimName(charId, name, owner);
    if (!claimed.ok) return claimed;
    const preferred = opts?.tokenId?.trim();
    let tokenId = this.bind.nextToken;
    if (preferred) {
      if (!/^[1-9][0-9]{0,77}$/.test(preferred)) {
        return { ok: false, error: "Bad character token id." };
      }
      if (this.bind.chars.some((c) => c.tokenId === preferred)) {
        return { ok: false, error: "That character NFT is already bound." };
      }
      tokenId = preferred;
    }
    const res = this.apply({ op: "spawn", tokenId, startingJob: job });
    if (!res.ok) return res;
    this.bind.chars.push({
      charId,
      tokenId,
      name: claimed.name,
      job,
      ...(owner ? { wallet: owner } : {}),
    });
    this.bind.reserved = this.bind.reserved.filter((row) => row.charId !== charId);
    const next = BigInt(tokenId) + 1n;
    if (next > BigInt(this.bind.nextToken)) this.bind.nextToken = next.toString();
    this.saveBind();
    return { ok: true, tokenId };
  }

  /** Open book listings (AhEscrow asks) for boot reconcile against on-chain `asks()`. */
  openBookListings(): EngineListing[] {
    return this.state.listings.filter((row) => row.book === true);
  }

  /**
   * Remember an item import the server already saw in custody.
   * Does not credit the log. Game-client messages must not call this.
   */
  noteCustodyInbound(inbound: CustodyInbound): void {
    this.custody.set(this.custodyKey(inbound.tokenId, inbound.nonce), inbound);
  }

  /** Remember an AhEscrow AskFilled before mirroring items via chainFill. */
  noteChainFill(inbound: ChainFillInbound): void {
    this.chainFills.set(inbound.fillKey, inbound);
  }

  /** KEK vault deposits are retired. Item imports use importItem. */
  depositKek(_tokenId: string, _amount: string, _nonce: string): LokResult {
    return KEK_RETIRED;
  }

  /** Log image of an item import. Credits only a nonce this server already recorded. */
  importItem(tokenId: string, itemId: string, amount: string, nonce: string): LokResult {
    const key = this.custodyKey(tokenId, nonce);
    const noted = this.custody.get(key);
    if (
      !noted ||
      noted.kind !== "importItem" ||
      noted.amount !== amount ||
      noted.itemId !== itemId ||
      noted.tokenId !== tokenId
    ) {
      return { ok: false, error: "item import nonce is not a recorded custody inbound" };
    }
    const res = this.apply({ op: "importItem", tokenId, itemId, amount, nonce });
    if (res.ok) this.custody.delete(key);
    return res;
  }

  private custodyKey(tokenId: string, nonce: string): string {
    return tokenId + ":" + nonce;
  }

  /**
   * Move spendable items from the log into the in-game bag.
   * This is not a checkpoint ERC-1155 export.
   */
  bagExport(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "bagExport", tokenId, itemId, amount });
  }

  /**
   * Chain withdrawal. The engine packs this into checkpoint exports.
   * The bag move is bagExport. Live minting stays off until exports are enabled.
   */
  exportItem(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "exportItem", tokenId, itemId, amount });
  }

  /** KEK withdrawals are retired. There is no vault claim to burn. */
  withdrawKek(_tokenId: string, _amount: string): LokResult {
    return KEK_RETIRED;
  }

  /** KEK spends are retired. Live sinks use goldSpend. */
  spendKek(_tokenId: string, _amount: string): LokResult {
    return KEK_RETIRED;
  }

  /** Credit in-game gold. `day` is a server-stamped day id (engine enforces caps). */
  goldEarn(tokenId: string, source: string, amount: string, day: number): LokResult {
    if (this.coalesce) {
      return this.coalesce.add({ op: "goldEarn", tokenId, source, amount, day });
    }
    return this.apply({ op: "goldEarn", tokenId, source, amount, day });
  }

  /** Debit in-game gold for a sink (trainer, craft, respec, shop). */
  goldSpend(tokenId: string, sink: string, amount: string): LokResult {
    return this.apply({ op: "goldSpend", tokenId, sink, amount });
  }

  /** NPC buy-back: burn items, credit gold under the npc_sell earn cap. */
  goldSell(tokenId: string, itemId: string, qty: string, amount: string, day: number): LokResult {
    return this.apply({ op: "goldSell", tokenId, itemId, qty, amount, day });
  }

  /** Record the next level. Rejects a skip. Does not mint items or gold. */
  levelUp(tokenId: string, level: number): LokResult {
    return this.apply({ op: "levelUp", tokenId, level });
  }

  /** Record one learned ability or skill node. A repeat is rejected. */
  learnAbility(tokenId: string, abilityId: string): LokResult {
    return this.apply({ op: "learnAbility", tokenId, abilityId });
  }

  /** Record a successful craft. Does not credit spendable items or gold. */
  craft(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "craft", tokenId, itemId, amount });
  }

  /** Record a successful gather. Does not credit spendable items or gold. */
  harvest(tokenId: string, materialId: string, amount: string): LokResult {
    if (this.coalesce) {
      return this.coalesce.add({ op: "harvest", tokenId, materialId, amount });
    }
    return this.apply({ op: "harvest", tokenId, materialId, amount });
  }

  /** Closed: the engine refuses ItemDrop on append and on replay (ClosedMint). Log mob loot with lootDrop. */
  itemDrop(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "itemDrop", tokenId, itemId, amount });
  }

  /**
   * Open a batch and forget kills from the previous one.
   * The command is not a log entry.
   */
  private beginBatch(batchId: number): LokResult {
    this.openBatchId = batchId;
    return this.apply({ op: "beginBatch", batchId }, false);
  }

  /** Log a kill in the open batch. It does not credit items or gold. */
  kill(tokenId: string, killId: string): LokResult {
    if (this.openBatchId == null) {
      const opened = this.beginBatch(this.length);
      if (!opened.ok) return opened;
    }
    return this.apply({ op: "kill", tokenId, killId, batchId: this.openBatchId });
  }

  /**
   * Loot drop counter. Like harvest: records the drop without minting spendable items.
   * A drop with no kill in the open batch is not logged.
   */
  lootDrop(tokenId: string, itemId: string, amount: string, killId: string): LokResult {
    if (this.openBatchId == null || !killId) {
      return { ok: false, error: "drop does not name a kill in this batch" };
    }
    const batchId = this.openBatchId;
    if (this.coalesce) {
      return this.coalesce.add({ op: "lootDrop", tokenId, itemId, amount, killId, batchId });
    }
    return this.apply({ op: "lootDrop", tokenId, itemId, amount, killId, batchId });
  }

  /**
   * Open a sim tick. Harvest, LootDrop, and GoldEarn queue and merge.
   * Other events still apply immediately, but their journal lines wait for
   * endTick so the tick fsyncs once. The tick is a new batch: a kill from
   * the previous tick does not justify a drop.
   */
  beginTick(): void {
    if (this.journalHold) throw new Error("lok tick is already open");
    this.journalHold = true;
    this.coalesce = new TickCoalesce();
    const opened = this.beginBatch(this.length);
    if (!opened.ok) throw new Error(opened.error);
  }

  /** Apply the merged rows, then one journal fsync for the whole tick. */
  endTick(): { ok: true } | { ok: false; errors: string[] } {
    const queued = this.coalesce?.drain() ?? [];
    this.coalesce = null;
    const errors: string[] = [];
    for (const row of queued) {
      const res = this.apply(coalescedCmd(row));
      if (!res.ok) errors.push(row.op + " " + row.tokenId + ": " + res.error);
    }
    this.journalHold = false;
    const deferSnapshot = this.snapshotDeferred;
    this.snapshotDeferred = false;
    this.flushJournal(deferSnapshot);
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }

  /** Explicit bag import. Credits this stack without a chain inbound nonce. */
  importFromBag(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "bagImport", tokenId, itemId, amount });
  }

  levelOf(tokenId: string): number {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.level ?? 0;
  }

  hasAbility(tokenId: string, abilityId: string): boolean {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return (me?.abilities ?? []).includes(abilityId);
  }

  /** Ability / skill ids already on this character's log. */
  abilitiesOf(tokenId: string): string[] {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return [...(me?.abilities ?? [])];
  }

  craftOf(tokenId: string, itemId: string): string {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return me?.crafts?.find((row) => row.itemId === itemId)?.amount ?? "0";
  }

  harvestOf(tokenId: string, materialId: string): string {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return me?.harvests?.find((row) => row.materialId === materialId)?.amount ?? "0";
  }

  dropOf(tokenId: string, itemId: string): string {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return me?.drops?.find((row) => row.itemId === itemId)?.amount ?? "0";
  }

  /** How many chain inbound nonces this character has consumed. */
  inboundAppliedOf(tokenId: string): number {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.inboundApplied ?? 0;
  }

  sendItem(from: string, to: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "sendItem", from, to, itemId, amount });
  }

  /** KEK transfers are retired. Gold is not transferable. Items use sendItem. */
  sendKek(_from: string, _to: string, _amount: string): LokResult {
    return KEK_RETIRED;
  }

  list(seller: string, itemId: string, amount: string): LokResult & { listingId?: string } {
    const listingId = this.bind.nextListing;
    const res = this.apply({ op: "list", listingId, seller, itemId, amount });
    if (!res.ok) return res;
    this.bind.nextListing = (BigInt(listingId) + 1n).toString();
    this.saveBind();
    return { ok: true, listingId };
  }

  /** Order-book ask. The stack leaves the log and waits at minPrice. listedAt is a unix second. */
  ask(
    seller: string,
    itemId: string,
    amount: string,
    minPrice: string,
    listedAt: number,
  ): LokResult & { listingId?: string } {
    const listingId = this.bind.nextListing;
    const res = this.apply({ op: "ask", listingId, seller, itemId, amount, minPrice, listedAt });
    if (!res.ok) return res;
    this.bind.nextListing = (BigInt(listingId) + 1n).toString();
    this.saveBind();
    return { ok: true, listingId };
  }

  /**
   * KEK-priced fills are retired. Live buys are AhEscrow ChainFill; payment is on-chain ETH.
   */
  fill(
    _bidder: string,
    _itemId: string,
    _amount: string,
  ): LokResult & { listingId?: string; seller?: string; stack?: string; price?: string } {
    return KEK_RETIRED;
  }

  /** KEK-priced buys are retired. Live buys are AhEscrow ChainFill. */
  buy(
    _bidder: string,
    _itemId: string,
  ): LokResult & { listingId?: string; seller?: string; stack?: string; price?: string } {
    return KEK_RETIRED;
  }

  /**
   * Mirror an on-chain AhEscrow fill into the log (items only). Requires a prior
   * noteChainFill for the same fillKey. Does not credit or debit settlement ETH.
   */
  chainFill(listingId: string, buyer: string, priceWei: string, fillKey: string): LokResult {
    const noted = this.chainFills.get(fillKey);
    if (
      !noted ||
      noted.listingId !== listingId ||
      noted.buyerTokenId !== buyer ||
      noted.priceWei !== priceWei
    ) {
      return { ok: false, error: "AhEscrow fill is not a recorded on-chain fill" };
    }
    const res = this.apply({
      op: "chainFill",
      listingId,
      buyer,
      priceWei,
      itemId: noted.itemId,
      amount: noted.amount,
      seller: noted.sellerTokenId,
      txHash: noted.txHash,
      logIndex: noted.logIndex,
    });
    if (res.ok) {
      this.chainFills.delete(fillKey);
      this.appliedChainFillKeys.add(normalizeFillKey(fillKey));
    }
    return res;
  }

  /** True when a ChainFill with this fillKey (txHash-logIndex) is already on the log. */
  hasChainFill(fillKey: string): boolean {
    return this.appliedChainFillKeys.has(normalizeFillKey(fillKey));
  }

  /** All journaled ChainFill fillKeys (source of truth for AskFilled replay). */
  chainFillKeys(): ReadonlySet<string> {
    return this.appliedChainFillKeys;
  }

  goldPaidRespec(tokenId: string, amount: string, nodeIds: string[]): LokResult {
    return this.apply({ op: "goldPaidRespec", tokenId, amount, nodeIds });
  }

  /** Open PvP bounty for a token, if any (from engine state). */
  pvpBountyOf(tokenId: string): EnginePvpBounty | undefined {
    return (this.state.pvpBounties ?? []).find((b) => b.tokenId === tokenId);
  }

  /** True when this character has an open head-bounty on the log. */
  hasPvpBounty(tokenId: string): boolean {
    return !!this.pvpBountyOf(tokenId);
  }

  /**
   * Mirror an on-chain PvP bounty escrow open. Does not credit or debit settlement ETH.
   * `fillKey` is `${txHash}-${logIndex}` for dedupe (same pattern as ChainFill).
   */
  pvpBountyOpen(
    tokenId: string,
    amountWei: string,
    areaId: string,
    txHash: string,
    logIndex: number | string,
  ): LokResult {
    const dup = this.rejectDuplicatePvp(txHash, logIndex);
    if (dup) return dup;
    const res = this.apply({
      op: "pvpBountyOpen",
      tokenId,
      amountWei,
      areaId,
      txHash,
      logIndex,
    });
    if (res.ok) this.rememberPvpFill(txHash, logIndex);
    return res;
  }

  /** Mirror an on-chain PvP bounty cancel/refund. */
  pvpBountyCancel(
    tokenId: string,
    areaId: string,
    txHash: string,
    logIndex: number | string,
  ): LokResult {
    const dup = this.rejectDuplicatePvp(txHash, logIndex);
    if (dup) return dup;
    const res = this.apply({
      op: "pvpBountyCancel",
      tokenId,
      areaId,
      txHash,
      logIndex,
    });
    if (res.ok) this.rememberPvpFill(txHash, logIndex);
    return res;
  }

  /**
   * Mirror an on-chain PvP bounty claim after a slay. Clears the victim's open bounty.
   * Does not move ETH on the log.
   */
  pvpKill(
    victim: string,
    slayer: string,
    areaId: string,
    amountWei: string,
    txHash: string,
    logIndex: number | string,
  ): LokResult {
    const dup = this.rejectDuplicatePvp(txHash, logIndex);
    if (dup) return dup;
    const res = this.apply({
      op: "pvpKill",
      victim,
      slayer,
      areaId,
      amountWei,
      txHash,
      logIndex,
    });
    if (res.ok) this.rememberPvpFill(txHash, logIndex);
    return res;
  }

  private pvpFillKey(txHash: string, logIndex: number | string): string {
    return normalizeFillKey(txHash + "-" + logIndex);
  }

  private rejectDuplicatePvp(txHash: string, logIndex: number | string): LokResult | null {
    if (this.appliedPvpFillKeys.has(this.pvpFillKey(txHash, logIndex))) {
      return { ok: false, error: "pvp receipt already mirrored" };
    }
    return null;
  }

  private rememberPvpFill(txHash: string, logIndex: number | string) {
    this.appliedPvpFillKeys.add(this.pvpFillKey(txHash, logIndex));
  }

  /**
   * Walk asks until qty items are taken, the book runs out, or this message
   * hits MAX_FILLS_PER_BUY_MESSAGE. Each step is buy(). KEK buys are retired,
   * so the first step refuses and nothing is filled. The cap and the yield
   * every BUY_FILL_BATCH fills stay so a future payer cannot hold the loop.
   */
  async buyQuantity(
    bidder: string,
    itemId: string,
    qty: number,
  ): Promise<
    | { ok: true; fills: { listingId?: string; seller?: string; stack?: string; price?: string }[]; filled: string; short: boolean; stopped?: string }
    | { ok: false; error: string }
  > {
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000) {
      return { ok: false, error: "Pick a quantity from 1 to 1000000. Nothing was bought." };
    }
    const fills: { listingId?: string; seller?: string; stack?: string; price?: string }[] = [];
    let filled = 0n;
    const want = BigInt(qty);
    while (filled < want) {
      if (fills.length >= MAX_FILLS_PER_BUY_MESSAGE) {
        return {
          ok: true,
          fills,
          filled: filled.toString(),
          short: true,
          stopped:
            "Stopped after " +
            MAX_FILLS_PER_BUY_MESSAGE +
            " asks. This buy message will not fill more than that. " +
            filled.toString() +
            " items were bought and each ask was charged. Send another buy for the rest. Nothing further was charged.",
        };
      }
      if (fills.length > 0 && fills.length % BUY_FILL_BATCH === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const res = this.buy(bidder, itemId);
      if (!res.ok) {
        if (fills.length === 0) return res;
        return { ok: true, fills, filled: filled.toString(), short: true, stopped: res.error };
      }
      let stack = 0n;
      try {
        stack = BigInt(res.stack || "0");
      } catch {
        stack = 0n;
      }
      fills.push({ listingId: res.listingId, seller: res.seller, stack: res.stack, price: res.price });
      if (stack <= 0n) {
        return {
          ok: true,
          fills,
          filled: filled.toString(),
          short: true,
          stopped: "The ask had no stack. Nothing further was bought.",
        };
      }
      filled += stack;
    }
    return { ok: true, fills, filled: filled.toString(), short: false };
  }


  private bought(
    before: EngineListing[],
    res: LokResult,
  ): LokResult & { listingId?: string; seller?: string; stack?: string; price?: string } {
    if (!res.ok) return res;
    const left = new Set(this.state.listings.map((row) => row.id));
    const prior = before.find((row) => !left.has(row.id));
    return { ok: true, listingId: prior?.id, seller: prior?.seller, stack: prior?.amount, price: prior?.minPrice };
  }

  /** KEK bids are retired. Asks stay as item escrow; payment is on-chain ETH. */
  bid(_listingId: string, _bidder: string, _amount: string): LokResult {
    return KEK_RETIRED;
  }

  cancel(listingId: string, seller: string): LokResult {
    return this.apply({ op: "cancel", listingId, seller });
  }

  /** Cancel an order-book ask into the seller inbox (not the legacy bid/settle path). */
  cancelAsk(listingId: string, seller: string): LokResult {
    return this.apply({ op: "cancelAsk", listingId, seller });
  }

  /** Open ask/listing row, if any. Used before chainFill removes it. */
  listingOf(listingId: string): EngineListing | undefined {
    return this.state.listings.find((row) => row.id === listingId);
  }

  /** KEK settlement is retired. ChainFill moves the item after AhEscrow pays. */
  settle(_listingId: string): LokResult {
    return KEK_RETIRED;
  }

  reclaim(listingId: string, seller: string, now: number): LokResult {
    return this.apply({ op: "reclaimAsk", listingId, seller, now });
  }

  sendInbox(from: string, to: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "sendInbox", from, to, itemId, amount });
  }

  takeInbox(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "takeInbox", tokenId, itemId, amount });
  }

  craftSkill(tokenId: string, skillId: string, level: number): LokResult {
    return this.apply({ op: "craftSkill", tokenId, skillId, level });
  }

  respecSkills(tokenId: string, nodeIds: string[]): LokResult {
    return this.apply({ op: "respecSkills", tokenId, nodeIds });
  }

  /** KEK respec is retired. Live respec uses goldPaidRespec. */
  paidRespecSkills(_tokenId: string, _amount: string, _nodeIds: string[]): LokResult {
    return KEK_RETIRED;
  }

  craftSkillsOf(tokenId: string): { skillId: string; level: number }[] {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return (me?.craftSkills ?? [])
      .filter((row) => row.skillId && Number.isSafeInteger(row.level) && row.level > 0)
      .map((row) => ({ skillId: row.skillId, level: row.level }));
  }

  droppedSkillsOf(tokenId: string): string[] {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return [...(me?.droppedSkills ?? [])];
  }

  /**
   * Send target is a log token or character id. Display names never match, so a lookalike cannot receive the transfer.
   */
  resolveRecipient(
    to: string,
    selfToken: string,
  ): { ok: true; tokenId: string; name: string } | { ok: false; error: string } {
    const id = to.trim();
    if (!id) return { ok: false, error: "Pick a character." };
    const hits = new Map<string, BindChar>();
    for (const row of this.bind.chars) {
      if (row.tokenId === id || row.charId === id) hits.set(row.tokenId, row);
    }
    if (hits.size === 0) {
      return { ok: false, error: "Pick a character. A display name is not a send target." };
    }
    if (hits.size > 1) return { ok: false, error: "That character id is ambiguous. Nothing was sent." };
    const row = [...hits.values()][0]!;
    if (row.tokenId === selfToken) return { ok: false, error: "You cannot send to yourself." };
    return { ok: true, tokenId: row.tokenId, name: row.name };
  }

  /** Reserve the normalized name when it is chosen, before the character exists on the log. */
  claimName(
    charId: string,
    raw: string,
    wallet?: string,
  ): { ok: true; name: string } | { ok: false; error: string } {
    this.pruneExpiredReservations();
    const norm = normalizeCharacterName(raw);
    if (!norm.ok) return norm;
    if (this.nameTaken(norm.name, charId)) {
      return { ok: false, error: "That name is already on the log. Pick another." };
    }
    const owner = wallet?.trim().toLowerCase() || undefined;
    const row = this.bind.chars.find((c) => c.charId === charId);
    if (row) {
      row.name = norm.name;
      if (owner && !row.wallet) row.wallet = owner;
      this.bind.reserved = this.bind.reserved.filter((reserved) => reserved.charId !== charId);
      this.saveBind();
      return { ok: true, name: norm.name };
    }
    if (owner) {
      const capped = this.ensureWalletCapacity(owner, charId);
      if (!capped.ok) return capped;
    }
    const mine = this.bind.reserved.find((reserved) => reserved.charId === charId);
    if (mine) {
      mine.name = norm.name;
      mine.at = Date.now();
      if (owner) mine.wallet = owner;
    } else {
      this.bind.reserved.push({
        charId,
        name: norm.name,
        at: Date.now(),
        ...(owner ? { wallet: owner } : {}),
      });
    }
    this.saveBind();
    return { ok: true, name: norm.name };
  }

  nameTaken(name: string, exceptCharId?: string): boolean {
    this.pruneExpiredReservations();
    const key = characterNameKey(name);
    if (!key) return false;
    const rows = [...this.bind.chars, ...this.bind.reserved];
    return rows.some((row) => row.charId !== exceptCharId && characterNameKey(row.name) === key);
  }

  boundChars(): { charId: string; tokenId: string; name: string; job: number; wallet?: string }[] {
    return this.bind.chars.map((c) => ({ ...c }));
  }

  /** Characters persisted for this wallet. Unowned rows are never returned. */
  charsForWallet(wallet: string): { charId: string; tokenId: string; name: string; job: number; wallet: string }[] {
    const owner = wallet.trim().toLowerCase();
    return this.bind.chars
      .filter((c): c is BindChar & { wallet: string } => !!c.wallet && c.wallet.toLowerCase() === owner)
      .map((c) => ({ ...c, wallet: c.wallet }));
  }

  bindWallet(charId: string, wallet: string): void {
    const owner = wallet.trim().toLowerCase();
    if (!owner) return;
    const row = this.bind.chars.find((c) => c.charId === charId);
    if (!row || row.wallet) return;
    row.wallet = owner;
    this.saveBind();
  }

  /**
   * Re-bind character control after a finalized NFT Transfer (C-1).
   * Overwrites an existing wallet binding — unlike write-once bindWallet.
   */
  rebindWallet(charId: string, wallet: string): { ok: true; previous: string | null } | { ok: false; error: string } {
    const owner = wallet.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(owner)) return { ok: false, error: "Bad wallet." };
    const row = this.bind.chars.find((c) => c.charId === charId);
    if (!row) return { ok: false, error: "Unknown character." };
    const previous = row.wallet?.toLowerCase() ?? null;
    if (previous === owner) return { ok: true, previous };
    row.wallet = owner;
    this.saveBind();
    return { ok: true, previous };
  }

  /** Find bind row by NFT token id. */
  charByTokenId(
    tokenId: string,
  ): { charId: string; tokenId: string; name: string; job: number; wallet?: string } | null {
    const id = tokenId.trim();
    const row = this.bind.chars.find((c) => c.tokenId === id);
    return row ? { ...row } : null;
  }

  walletCharCount(wallet: string, exceptCharId?: string): number {
    this.pruneExpiredReservations();
    const owner = wallet.trim().toLowerCase();
    const live = this.bind.chars.filter(
      (c) => c.wallet?.toLowerCase() === owner && c.charId !== exceptCharId,
    ).length;
    const reserved = this.bind.reserved.filter(
      (c) => c.wallet?.toLowerCase() === owner && c.charId !== exceptCharId,
    ).length;
    return live + reserved;
  }

  ensureWalletCapacity(
    wallet: string,
    exceptCharId?: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.walletCharCount(wallet, exceptCharId) >= MAX_CHARS_PER_WALLET) {
      return { ok: false, error: "This wallet already has " + MAX_CHARS_PER_WALLET + " characters." };
    }
    return { ok: true };
  }

  pruneExpiredReservations(now = Date.now()): number {
    const before = this.bind.reserved.length;
    this.bind.reserved = this.bind.reserved.filter((row) => {
      const at = typeof row.at === "number" ? row.at : 0;
      return at > 0 && now - at < NAME_RESERVE_MS;
    });
    const removed = before - this.bind.reserved.length;
    if (removed > 0) this.saveBind();
    return removed;
  }

  setBoundName(charId: string, name: string): { ok: true; name: string } | { ok: false; error: string } {
    if (!this.bind.chars.some((row) => row.charId === charId)) {
      return { ok: false, error: "Character is not on the bind file." };
    }
    return this.claimName(charId, name);
  }

  /**
   * Live engine document, including events not yet copied into the snapshot.
   * Built on demand so an ordinary event does not serialize the whole world.
   * tokenId null is every character, one row per seq. Nothing is appended.
   */
  logDocument(): string {
    if (this.cachedDoc != null) return this.cachedDoc;
    this.exp.lok_document();
    this.cachedDoc = lokOut(this.exp);
    return this.cachedDoc;
  }

  /**
   * Characters for the light-client proof. Starting job and gold-day counters
   * come from the engine document. Balances come from the live state JSON.
   */
  lightCharacters(): LightCharacter[] {
    const doc = this.logDocument();
    if (this.lightRows?.doc === doc) return this.lightRows.rows;
    const jobs = new Map(this.bind.chars.map((row) => [row.tokenId, row.job]));
    const rows = projectLightCharacters(doc, this.state.characters, jobs);
    this.lightRows = { doc, rows };
    return rows;
  }

  /**
   * Character-root tree root: each leaf is `(tokenId, character state root)`.
   * The engine writes 64 lowercase hex characters. Empty world is 32 zero bytes.
   */
  characterRootTreeRoot(): Uint8Array {
    const rc = this.exp.lok_character_root();
    if (rc !== 0) throw new Error("lok character root failed");
    const hex = lokOut(this.exp);
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error("lok character root is not 64 hex characters");
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  explore(opts: {
    tokenId: string | null;
    q?: string;
    limit?: number;
    beforeSeq?: number | null;
  }): LokExplorePage {
    return exploreDocument(this.logDocument(), (id) => this.bind.chars.find((c) => c.tokenId === id)?.name ?? id, opts);
  }

  view(tokenId: string): LokSnapshot {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    const nameOf = (id: string | null) => {
      if (!id) return null;
      return this.bind.chars.find((c) => c.tokenId === id)?.name ?? id;
    };
    const items = (me?.items ?? [])
      .map((row) => {
        const id = asItemId(row.itemId);
        if (id == null || id <= 0) return null;
        return { tokenId: id, amount: row.amount };
      })
      .filter((row): row is { tokenId: number; amount: string } => row != null);
    const listings: LokListingView[] = [];
    for (const row of this.state.listings) {
      const itemId = asItemId(row.itemId);
      if (itemId == null) continue;
      listings.push({
        id: row.id,
        seller: row.seller,
        sellerName: nameOf(row.seller) ?? row.seller,
        itemId,
        amount: row.amount,
        highBidder: row.highBidder,
        highBidderName: nameOf(row.highBidder),
        highBid: row.highBid,
        minPrice: row.minPrice ?? "0",
        listedAt: row.listedAt ?? 0,
        book: row.book === true,
        yours: row.seller === tokenId,
      });
    }
    const inbox = (me?.inbox ?? [])
      .map((row) => {
        const id = asItemId(row.itemId);
        if (id == null || id <= 0) return null;
        return { tokenId: id, amount: row.amount };
      })
      .filter((row): row is { tokenId: number; amount: string } => row != null);
    return {
      tokenId,
      kek: "0",
      eth: "0",
      gold: me?.gold ?? "0",
      items,
      inbox,
      listings,
      chain: this.chain,
      ahEscrow: null,
      withdrawDelaySec: null,
      queues: [],
    };
  }

  /** Always zero. KEK balances are not part of character state. */
  kekOf(_tokenId: string): string {
    return "0";
  }

  goldOf(tokenId: string): string {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.gold ?? "0";
  }

  /** Always zero. There is no vault claim. */
  vaultClaim(_tokenId: string): string {
    return "0";
  }

  /** Always zero. Withdraw counting left with KEK custody. */
  withdrawCount(_tokenId: string, _amount: string): number {
    return 0;
  }

  /** Always zero. Spent KEK is not tracked. */
  sunkKek(_tokenId: string): string {
    return "0";
  }

  checkpointFor(tokenId: string, fromIndex: string): {
    ok: true;
    body: {
      prevRoot: string;
      newRoot: string;
      fromIndex: string;
      toIndex: string;
      logHash: string;
      rulesetHash: string;
      summary: string;
      inboundConsumed: string;
      exports: { itemId: string; amount: number }[];
    };
  } | { ok: false; error: string } {
    const called = lokCall(
      this.exp,
      JSON.stringify({ op: "checkpoint", tokenId, fromIndex }),
      (ptr, len) => this.exp.lok_apply(ptr, len),
    );
    let body: {
      ok?: boolean;
      error?: string;
      prevRoot?: string;
      newRoot?: string;
      fromIndex?: string;
      toIndex?: string;
      logHash?: string;
      rulesetHash?: string;
      summary?: string;
      inboundConsumed?: string;
      exports?: { itemId?: string; amount?: number }[];
    };
    try {
      body = JSON.parse(called.out);
    } catch {
      return { ok: false, error: "lok engine returned junk" };
    }
    if (
      !body.ok ||
      !body.prevRoot ||
      !body.newRoot ||
      !body.logHash ||
      !body.rulesetHash ||
      !body.fromIndex ||
      !body.toIndex
    ) {
      return { ok: false, error: body.error || "No checkpoint for that log position." };
    }
    const exports = (body.exports ?? []).flatMap((row) => {
      if (!row.itemId || row.amount == null || !Number.isInteger(row.amount) || row.amount < 0) return [];
      return [{ itemId: row.itemId, amount: row.amount }];
    });
    return {
      ok: true,
      body: {
        prevRoot: body.prevRoot,
        newRoot: body.newRoot,
        fromIndex: body.fromIndex,
        toIndex: body.toIndex,
        logHash: body.logHash,
        rulesetHash: body.rulesetHash,
        summary: body.summary || "0",
        inboundConsumed: body.inboundConsumed || "0",
        exports,
      },
    };
  }

  /** KEK withdraw undo is retired. Nothing is appended. */
  undoWithdraw(_tokenId: string, _amount: string): LokResult {
    return KEK_RETIRED;
  }

  itemOf(tokenId: string, itemId: string): string {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return me?.items.find((row) => row.itemId === itemId)?.amount ?? "0";
  }

  private apply(cmd: Record<string, unknown>, record = true): LokResult {
    const called = lokCall(this.exp, JSON.stringify(cmd), (ptr, len) => this.exp.lok_apply(ptr, len));
    let body: ApplyBody;
    try {
      body = JSON.parse(called.out) as ApplyBody;
    } catch {
      return { ok: false, error: "lok engine returned junk" };
    }
    if (!body.ok) return { ok: false, error: body.error || "rejected" };
    if (body.state) this.state = body.state;
    if (typeof body.len === "number") this.length = body.len;
    if (record && body.entry) this.notePersisted(cmd);
    return { ok: true };
  }

  private refresh() {
    const called = lokCall(this.exp, JSON.stringify({ op: "state" }), (ptr, len) => this.exp.lok_apply(ptr, len));
    const body = JSON.parse(called.out) as ApplyBody;
    if (!body.ok || !body.state) throw new Error("lok state failed");
    this.state = body.state;
    this.length = body.len ?? 0;
  }

  /**
   * Replay journal lines that were appended after the snapshot's cursor.
   *
   * A crash mid-append can leave a torn final line. That line never reached the
   * engine, so it is dropped: the file is backed up to lok-world.jsonl.torn-<stamp>
   * and truncated to the last newline, so the next append starts on a clean line
   * instead of concatenating onto the fragment (which made the following restart
   * throw "lok journal is corrupt" and lose that next event).
   *
   * Every line carries the log length after it was applied (`seq`). Replay checks
   * it, so a duplicated line, a reordered tail, or a snapshot paired with the wrong
   * journal fails loudly instead of silently re-applying an event.
   */
  private replayJournal(cursor: number) {
    if (!existsSync(this.journalPath)) {
      if (cursor !== 0) throw new Error("lok snapshot names a journal that is not on disk");
      this.journalBytes = 0;
      return;
    }
    let raw: Buffer = readFileSync(this.journalPath);
    if (cursor > raw.length) throw new Error("lok journal cursor is past the end of the append log");
    raw = this.repairJournalTail(raw, cursor);
    this.journalBytes = raw.length;
    const tail = raw.subarray(cursor).toString("utf8");
    if (!tail) return;
    const lines = tail.split("\n");
    let replayed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line) continue;
      let rec: { seq?: unknown; cmd?: Record<string, unknown> };
      try {
        rec = JSON.parse(line) as { seq?: unknown; cmd?: Record<string, unknown> };
      } catch {
        throw new Error("lok journal is corrupt");
      }
      if (!rec.cmd || typeof rec.cmd !== "object") throw new Error("lok journal line has no command");
      const res = this.apply(rec.cmd, false);
      if (!res.ok) throw new Error("lok journal refused: " + res.error);
      if (typeof rec.seq === "number" && rec.seq !== this.length) {
        throw new Error(
          `lok journal seq mismatch: line ${replayed + 1} after the snapshot says seq ${rec.seq} but the log is at ${this.length}. ` +
            "The journal does not belong to this snapshot or has a duplicated line.",
        );
      }
      replayed++;
    }
    this.sinceSnapshot = replayed;
    if (this.sinceSnapshot >= LOG_SNAPSHOT_EVERY) this.snapshotLog();
  }

  /**
   * Make the journal end on a newline before anything is replayed or appended.
   * An unparseable fragment after the last newline is backed up and cut off. A
   * complete final record that only lacks its newline gets one appended.
   */
  private repairJournalTail(raw: Buffer, cursor: number): Buffer {
    if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return raw;
    const start = raw.lastIndexOf(0x0a) + 1;
    const fragment = raw.subarray(start).toString("utf8");
    let complete = false;
    try {
      const rec = JSON.parse(fragment) as { cmd?: unknown };
      complete = !!rec && typeof rec === "object" && !!rec.cmd && typeof rec.cmd === "object";
    } catch {
      complete = false;
    }
    if (complete) {
      appendFileSync(this.journalPath, "\n");
      return Buffer.concat([raw, Buffer.from("\n")]);
    }
    if (start < cursor) throw new Error("lok journal tail is torn inside the snapshot's cursor");
    const backup = this.journalPath + ".torn-" + fileStamp();
    copyFileSync(this.journalPath, backup);
    truncateSync(this.journalPath, start);
    console.error(
      `[lok] dropped a torn final journal line (${raw.length - start} bytes) that never reached the engine. Backup: ${backup}`,
    );
    return raw.subarray(0, start);
  }

  /**
   * Journal commands accepted since the previous call.
   * The tick reads these after `endTick` so a certified batch can name them.
   */
  takeCommittedCmds(): Record<string, unknown>[] {
    const cmds = this.committedCmds;
    this.committedCmds = [];
    return cmds;
  }

  /** Append one event. The full document is rewritten only every LOG_SNAPSHOT_EVERY events. */
  private notePersisted(cmd: Record<string, unknown>) {
    this.committedCmds.push(cmd);
    this.cachedDoc = null;
    const line = JSON.stringify({ seq: this.length, cmd }) + "\n";
    const bytes = Buffer.from(line, "utf8");
    this.journalPending.push(bytes);
    this.journalBytes += bytes.length;
    this.sinceSnapshot++;
    if (this.journalHold) {
      if (this.sinceSnapshot >= LOG_SNAPSHOT_EVERY) this.snapshotDeferred = true;
      return;
    }
    this.flushJournal(false);
  }

  /** Open the journal append fd once. Later flushes reuse it and still fsync. */
  private journalAppendFd(): number {
    if (this.journalFd === null) this.journalFd = openSync(this.journalPath, "a");
    return this.journalFd;
  }

  /**
   * Write every buffered journal line and fsync once on the append fd held for
   * this world. The fsync finishes before this returns, including out-of-tick
   * applies. A tick asks for a background snapshot so the rewrite does not
   * block the sim; the journal fsync itself stays on this call.
   */
  private flushJournal(backgroundSnapshot: boolean) {
    if (this.journalPending.length > 0) {
      const payload = Buffer.concat(this.journalPending);
      this.journalPending = [];
      const fd = this.journalAppendFd();
      let off = 0;
      while (off < payload.length) {
        const wrote = writeSync(fd, payload, off, payload.length - off);
        if (wrote <= 0) throw new Error("lok journal write stalled");
        off += wrote;
      }
      fsyncSync(fd);
    }
    if (this.sinceSnapshot < LOG_SNAPSHOT_EVERY) return;
    if (backgroundSnapshot) this.scheduleSnapshot();
    else this.snapshotLog();
  }

  /** Full snapshot rewrite off the tick path. */
  private scheduleSnapshot() {
    if (this.snapshotQueued) return;
    this.snapshotQueued = true;
    setImmediate(() => {
      this.snapshotQueued = false;
      if (this.sinceSnapshot >= LOG_SNAPSHOT_EVERY) this.snapshotLog();
    });
  }

  /**
   * Rewrite lok-world.json from the engine document and record how much of the
   * journal is already inside it. An existing full-file log has no journalBytes
   * field; that still opens, and later events append after it.
   */
  private snapshotLog() {
    this.exp.lok_document();
    const doc = lokOut(this.exp);
    if (!doc.startsWith("{")) throw new Error("lok document was not a JSON object");
    const text = '{"journalBytes":' + this.journalBytes + "," + doc.slice(1);
    atomicWrite(this.logPath, text);
    this.sinceSnapshot = 0;
  }

  private readBind(): BindFile {
    if (!existsSync(this.bindPath)) {
      return { nextToken: "1", nextListing: "1", chars: [], reserved: [] };
    }
    const parsed = JSON.parse(readFileSync(this.bindPath, "utf8")) as BindFile;
    const reserved = Array.isArray(parsed.reserved) ? parsed.reserved : [];
    return {
      nextToken: parsed.nextToken || "1",
      nextListing: parsed.nextListing || "1",
      chars: Array.isArray(parsed.chars) ? parsed.chars : [],
      reserved: reserved
        .filter(
          (row): row is ReservedName =>
            !!row &&
            typeof row.charId === "string" &&
            row.charId.length > 0 &&
            typeof row.name === "string",
        )
        .map((row) => ({
          charId: row.charId,
          name: row.name,
          at: typeof (row as { at?: number }).at === "number" ? (row as { at: number }).at : 0,
          ...((row as { wallet?: string }).wallet
            ? { wallet: String((row as { wallet: string }).wallet).toLowerCase() }
            : {}),
        })),
    };
  }

  private reconcileBind() {
    const live = new Set(this.state.characters.map((c) => c.tokenId));
    const dropped = this.bind.chars.filter((c) => !live.has(c.tokenId));
    if (dropped.length > 0) {
      // Rows whose token is not in the log are removed (a recovery to an older
      // log would otherwise point wallets at tokens that do not exist). Keep a
      // copy first: those rows are the only record of the wallet and name.
      const backup = this.bindPath.replace(/\.json$/, "") + ".dropped-" + fileStamp() + ".json";
      atomicWrite(backup, JSON.stringify({ droppedAt: new Date().toISOString(), logLength: this.length, chars: dropped }, null, 2));
      console.error(
        `[lok] ${dropped.length} lok-bind row(s) name tokens that are not in the world log and were removed. Backup: ${backup}`,
      );
    }
    this.bind.chars = this.bind.chars.filter((c) => live.has(c.tokenId));
    for (const c of this.state.characters) {
      if (!this.bind.chars.some((row) => row.tokenId === c.tokenId)) {
        this.bind.chars.push({
          charId: "replayed:" + c.tokenId,
          tokenId: c.tokenId,
          name: c.tokenId,
          job: 0,
        });
      }
    }
    const maxToken = this.state.characters.reduce((max, c) => {
      try {
        const n = BigInt(c.tokenId);
        return n > max ? n : max;
      } catch {
        return max;
      }
    }, 0n);
    const maxList = this.state.listings.reduce((max, row) => {
      try {
        const n = BigInt(row.id);
        return n > max ? n : max;
      } catch {
        return max;
      }
    }, 0n);
    const nextToken = BigInt(this.bind.nextToken);
    const nextListing = BigInt(this.bind.nextListing);
    if (nextToken <= maxToken) this.bind.nextToken = (maxToken + 1n).toString();
    if (nextListing <= maxList) this.bind.nextListing = (maxList + 1n).toString();
  }

  private saveBind() {
    atomicWrite(this.bindPath, JSON.stringify(this.bind, null, 2));
  }
}
