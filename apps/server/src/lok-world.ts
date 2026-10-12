import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LokListingView, LokSnapshot } from "@bellgrave/protocol";
import { characterNameKey, normalizeCharacterName } from "./character-name";
import { acquireDataDirLock } from "./data-dir-lock";
import { exploreDocument, type LokExplorePage } from "./lok-explore";
import { defaultWasmPath, loadLokExports, lokCall, lokOut, type LokExports } from "./lok-engine";

export type LokResult = { ok: true } | { ok: false; error: string };

type EngineItem = { itemId: string; amount: string };
type EngineCraft = { itemId: string; amount: string };
type EngineHarvest = { materialId: string; amount: string };
type EngineDrop = { itemId: string; amount: string };
type EngineCraftSkill = { skillId: string; level: number };
type EngineCharacter = {
  tokenId: string;
  kek: string;
  /** In-game gold (log-only). Absent on logs that never earned gold. */
  gold?: string;
  vaultClaim?: string;
  sunkKek?: string;
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
type EngineState = { characters: EngineCharacter[]; listings: EngineListing[] };
type ApplyBody = {
  ok?: boolean;
  error?: string;
  entry?: unknown;
  len?: number;
  state?: EngineState;
};

type BindChar = {
  charId: string;
  tokenId: string;
  name: string;
  job: number;
  wallet?: string;
  /** ERC-721 id minted to the wallet. Independent of the log token id. */
  nftTokenId?: string;
  nftTx?: string;
};
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

/** An inbound the server recorded from custody. The game client cannot insert these. */
export type CustodyInbound =
  | { kind: "depositKek"; tokenId: string; nonce: string; amount: string }
  | { kind: "importItem"; tokenId: string; nonce: string; itemId: string; amount: string };

/** AhEscrow AskFilled the server already saw. Client messages cannot invent these. */
export type ChainFillInbound = {
  listingId: string;
  buyerTokenId: string;
  priceWei: string;
  fillKey: string;
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
  if (env.LOK_AH_ESCROW?.trim() || env.LOK_CHECKPOINT?.trim()) {
    return {
      chain: "watching",
      note: "Chain endpoint set. Player vault deposit/withdraw is closed. AhEscrow AskFilled events mirror item fills into the log (no spendable ETH on the log).",
    };
  }
  return {
    chain: "rpc-unwatched",
    note: "LOK_CHAIN_RPC is set, but AhEscrow is not configured. Vault deposit/withdraw stay closed; AH ETH pay is not live on this server.",
  };
}

/** Filesystem-safe timestamp for backup file names (no ':' so it works on Windows). */
function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function atomicWrite(path: string, text: string) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
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

/**
 * One hash chain per character. The wasm engine accepts or rejects every move.
 * Deposit credits KEK the caller already holds in custody. It does not mint.
 * WithdrawKek decreases spendable KEK and does not submit an onchain withdrawal.
 */
export class LokWorld {
  readonly logPath: string;
  readonly journalPath: string;
  readonly chain: LokSnapshot["chain"];
  readonly chainNote: string;
  private readonly exp: LokExports;
  private readonly bindPath: string;
  private bind: BindFile;
  private state: EngineState = { characters: [], listings: [] };
  /** Custody nonces observed by the server. Not loaded from the client and not a chain watcher. */
  private custody = new Map<string, CustodyInbound>();
  private chainFills = new Map<string, ChainFillInbound>();
  /** Bytes of lok-world.jsonl already folded into the snapshot. */
  private journalBytes = 0;
  /** Accepted events since the snapshot on disk was rewritten. */
  private sinceSnapshot = 0;
  /** Live document for the explorer. Cleared when an event is appended. */
  private cachedDoc: string | null = null;
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
    const text = existsSync(this.logPath) ? readFileSync(this.logPath, "utf8") : "";
    const cursor = journalCursor(text);
    const opened = lokCall(this.exp, text, (ptr, len) => this.exp.lok_open(ptr, len));
    if (opened.rc !== 0) {
      throw new Error("lok log refused to open: " + opened.out);
    }
    this.replayJournal(cursor);
    this.bind = this.readBind();
    this.refresh();
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

  spawn(
    charId: string,
    name: string,
    job: number,
    wallet?: string,
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
    const tokenId = this.bind.nextToken;
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
    this.bind.nextToken = (BigInt(tokenId) + 1n).toString();
    this.saveBind();
    return { ok: true, tokenId };
  }

  /**
   * Remember an inbound the server already saw in custody (a vault deposit or an item burn).
   * Does not credit the log. There is no chain watcher in this process; nothing here reads Robinhood.
   * Game-client messages must not call this.
   */
  noteCustodyInbound(inbound: CustodyInbound): void {
    this.custody.set(this.custodyKey(inbound.tokenId, inbound.nonce), inbound);
  }

  /** Remember an AhEscrow AskFilled before mirroring items via chainFill. */
  noteChainFill(inbound: ChainFillInbound): void {
    this.chainFills.set(inbound.fillKey, inbound);
  }

  /** Log image of a vault deposit. Credits only a nonce this server already recorded. Never a mint. */
  depositKek(tokenId: string, amount: string, nonce: string): LokResult {
    const key = this.custodyKey(tokenId, nonce);
    const noted = this.custody.get(key);
    if (!noted || noted.kind !== "depositKek" || noted.amount !== amount || noted.tokenId !== tokenId) {
      return { ok: false, error: "KEK deposit nonce is not a recorded custody inbound" };
    }
    const res = this.apply({ op: "depositKek", tokenId, amount, nonce });
    if (res.ok) this.custody.delete(key);
    return res;
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

  exportItem(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "exportItem", tokenId, itemId, amount });
  }

  /** Drop spendable KEK on this character's log. Escrowed bids are not spendable. No chain transaction. */
  withdrawKek(tokenId: string, amount: string): LokResult {
    return this.apply({ op: "withdrawKek", tokenId, amount });
  }

  /**
   * Spend deposited KEK on an in-game price. Debits spendable balance only.
   * Escrowed bids stay locked. Does not mint and does not withdraw.
   * Prefer goldSpend for trainer / craft / respec (gold + WETH economy).
   */
  spendKek(tokenId: string, amount: string): LokResult {
    return this.apply({ op: "spendKek", tokenId, amount });
  }

  /** Credit in-game gold. `day` is a server-stamped day id (engine enforces caps). */
  goldEarn(tokenId: string, source: string, amount: string, day: number): LokResult {
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

  /** Record the next level. Rejects a skip. Does not mint KEK. */
  levelUp(tokenId: string, level: number): LokResult {
    return this.apply({ op: "levelUp", tokenId, level });
  }

  /** Record one learned ability or skill node. A repeat is rejected. */
  learnAbility(tokenId: string, abilityId: string): LokResult {
    return this.apply({ op: "learnAbility", tokenId, abilityId });
  }

  /** Record a successful craft. Does not credit spendable items or KEK. */
  craft(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "craft", tokenId, itemId, amount });
  }

  /** Record a successful gather. Does not credit spendable items or KEK. */
  harvest(tokenId: string, materialId: string, amount: string): LokResult {
    return this.apply({ op: "harvest", tokenId, materialId, amount });
  }

  /** Closed: the engine refuses every new ItemDrop append (ClosedMint). Log mob loot with lootDrop. */
  itemDrop(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "itemDrop", tokenId, itemId, amount });
  }

  /** Loot drop counter. Like harvest: records the drop without minting spendable items. */
  lootDrop(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "lootDrop", tokenId, itemId, amount });
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

  sendKek(from: string, to: string, amount: string): LokResult {
    return this.apply({ op: "sendKek", from, to, amount });
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
   * Buy the cheapest ask of this item at or under amount. Pays amount, not the minimum.
   * The engine picks the ask. A rejected bid appends nothing.
   */
  fill(bidder: string, itemId: string, amount: string): LokResult & { listingId?: string; seller?: string; stack?: string; price?: string } {
    const before = this.state.listings.map((row) => ({ ...row }));
    const res = this.apply({ op: "fill", bidder, itemId, amount });
    return this.bought(before, res);
  }

  /** Buy the cheapest ask and pay that ask. No bid amount. */
  buy(bidder: string, itemId: string): LokResult & { listingId?: string; seller?: string; stack?: string; price?: string } {
    const before = this.state.listings.map((row) => ({ ...row }));
    const buyerKek = BigInt(this.kekOf(bidder) || "0");
    const res = this.apply({ op: "buy", bidder, itemId });
    const bought = this.bought(before, res);
    if (!bought.ok) return bought;
    const left = BigInt(this.kekOf(bidder) || "0");
    const price = (buyerKek - left).toString();
    return { ...bought, price };
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
    const res = this.apply({ op: "chainFill", listingId, buyer, priceWei });
    if (res.ok) this.chainFills.delete(fillKey);
    return res;
  }

  /**
   * Buy whole asks until qty items are taken, the book runs out, or this message
   * hits MAX_FILLS_PER_BUY_MESSAGE. Each step is buy(), so the cheapest ask is
   * charged its own price. The buyer's own asks are skipped by the engine.
   * A short book or the per-message cap is an explicit partial: asks that
   * filled were charged, and nothing past the stop was charged. The loop yields
   * every BUY_FILL_BATCH fills so other players' messages can run.
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

  bid(listingId: string, bidder: string, amount: string): LokResult {
    return this.apply({ op: "bid", listingId, bidder, amount });
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

  settle(listingId: string): LokResult {
    return this.apply({ op: "settle", listingId });
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

  /** Debit spendable KEK and clear skill nodes in one engine event. */
  paidRespecSkills(tokenId: string, amount: string, nodeIds: string[]): LokResult {
    return this.apply({ op: "paidRespecSkills", tokenId, amount, nodeIds });
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

  boundChars(): {
    charId: string;
    tokenId: string;
    name: string;
    job: number;
    wallet?: string;
    nftTokenId?: string;
  }[] {
    return this.bind.chars.map((c) => ({ ...c }));
  }

  nftTokenFor(charId: string): string | null {
    return this.bind.chars.find((c) => c.charId === charId)?.nftTokenId ?? null;
  }

  /** Remember a confirmed factory mint on this character. One NFT and one tx, once. */
  attachCharacterNft(
    charId: string,
    nftTokenId: string,
    nftTx: string,
  ): { ok: true } | { ok: false; error: string } {
    if (!/^[1-9][0-9]{0,77}$/.test(nftTokenId)) return { ok: false, error: "Bad character NFT id." };
    if (!/^0x[0-9a-fA-F]{64}$/.test(nftTx)) return { ok: false, error: "Bad mint transaction." };
    const tx = nftTx.toLowerCase();
    const row = this.bind.chars.find((c) => c.charId === charId);
    if (!row) return { ok: false, error: "Character not found." };
    if (row.nftTokenId && row.nftTokenId !== nftTokenId) {
      return { ok: false, error: "This character already has an NFT." };
    }
    const takenId = this.bind.chars.find((c) => c.nftTokenId === nftTokenId && c.charId !== charId);
    if (takenId) return { ok: false, error: "That NFT is already linked to another character." };
    const takenTx = this.bind.chars.find((c) => c.nftTx === tx && c.charId !== charId);
    if (takenTx) return { ok: false, error: "That mint transaction is already linked." };
    row.nftTokenId = nftTokenId;
    row.nftTx = tx;
    this.saveBind();
    return { ok: true };
  }

  /** Characters persisted for this wallet. Unowned rows are never returned. */
  charsForWallet(wallet: string): {
    charId: string;
    tokenId: string;
    name: string;
    job: number;
    wallet: string;
    nftTokenId?: string;
  }[] {
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
    const settlement = me?.kek ?? "0";
    return {
      tokenId,
      kek: settlement,
      eth: settlement,
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

  kekOf(tokenId: string): string {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.kek ?? "0";
  }

  goldOf(tokenId: string): string {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.gold ?? "0";
  }

  vaultClaim(tokenId: string): string {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.vaultClaim ?? "0";
  }

  withdrawCount(tokenId: string, amount: string): number {
    const called = lokCall(
      this.exp,
      JSON.stringify({ op: "withdrawCount", tokenId, amount }),
      (ptr, len) => this.exp.lok_apply(ptr, len),
    );
    try {
      const body = JSON.parse(called.out) as { ok?: boolean; count?: number };
      return body.ok && typeof body.count === "number" ? body.count : 0;
    } catch {
      return 0;
    }
  }

  sunkKek(tokenId: string): string {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.sunkKek ?? "0";
  }

  checkpointFor(tokenId: string, fromIndex: string): {
    ok: true;
    body: {
      prevRoot: string;
      newRoot: string;
      fromIndex: string;
      toIndex: string;
      logHash: string;
      summary: string;
      inboundConsumed: string;
      kekOut: string;
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
      summary?: string;
      inboundConsumed?: string;
      kekOut?: string;
    };
    try {
      body = JSON.parse(called.out);
    } catch {
      return { ok: false, error: "lok engine returned junk" };
    }
    if (!body.ok || !body.prevRoot || !body.newRoot || !body.logHash || !body.fromIndex || !body.toIndex || !body.kekOut) {
      return { ok: false, error: body.error || "No checkpoint for that log position." };
    }
    return {
      ok: true,
      body: {
        prevRoot: body.prevRoot,
        newRoot: body.newRoot,
        fromIndex: body.fromIndex,
        toIndex: body.toIndex,
        logHash: body.logHash,
        summary: body.summary || "0",
        inboundConsumed: body.inboundConsumed || "0",
        kekOut: body.kekOut,
      },
    };
  }

  undoWithdraw(tokenId: string, amount: string): LokResult {
    const cmd = { op: "undoWithdraw", tokenId, amount };
    const res = this.apply(cmd, false);
    if (!res.ok) return res;
    this.notePersisted(cmd);
    return { ok: true };
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

  /** Append one event. The full document is rewritten only every LOG_SNAPSHOT_EVERY events. */
  private notePersisted(cmd: Record<string, unknown>) {
    this.cachedDoc = null;
    const line = JSON.stringify({ seq: this.length, cmd }) + "\n";
    const bytes = Buffer.from(line, "utf8");
    appendFileSync(this.journalPath, bytes);
    this.journalBytes += bytes.length;
    this.sinceSnapshot++;
    if (this.sinceSnapshot >= LOG_SNAPSHOT_EVERY) this.snapshotLog();
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
    const chars = (Array.isArray(parsed.chars) ? parsed.chars : []).map((row) => {
      if (!row || typeof row.charId !== "string") return row;
      const nftTokenId =
        typeof row.nftTokenId === "string" && /^[1-9][0-9]{0,77}$/.test(row.nftTokenId)
          ? row.nftTokenId
          : undefined;
      const nftTx =
        typeof row.nftTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(row.nftTx)
          ? row.nftTx.toLowerCase()
          : undefined;
      const next: BindChar = {
        charId: row.charId,
        tokenId: row.tokenId,
        name: row.name,
        job: row.job,
        ...(row.wallet ? { wallet: String(row.wallet).toLowerCase() } : {}),
        ...(nftTokenId ? { nftTokenId } : {}),
        ...(nftTx ? { nftTx } : {}),
      };
      return next;
    });
    return {
      nextToken: parsed.nextToken || "1",
      nextListing: parsed.nextListing || "1",
      chars,
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
