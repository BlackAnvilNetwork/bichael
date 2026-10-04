import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LokListingView, LokSnapshot } from "@bellgrave/protocol";
import { characterNameKey, normalizeCharacterName } from "./character-name";
import { exploreDocument, type LokExplorePage } from "./lok-explore";
import { defaultWasmPath, loadLokExports, lokCall, lokOut, type LokExports } from "./lok-engine";

export type LokResult = { ok: true } | { ok: false; error: string };

type EngineItem = { itemId: string; amount: string };
type EngineCraft = { itemId: string; amount: string };
type EngineHarvest = { materialId: string; amount: string };
type EngineCraftSkill = { skillId: string; level: number };
type EngineCharacter = {
  tokenId: string;
  kek: string;
  level?: number;
  abilities?: string[];
  crafts?: EngineCraft[];
  craftSkills?: EngineCraftSkill[];
  harvests?: EngineHarvest[];
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

type BindChar = { charId: string; tokenId: string; name: string; job: number; wallet?: string };
type ReservedName = { charId: string; name: string; wallet?: string; at: number };
type BindFile = { nextToken: string; nextListing: string; chars: BindChar[]; reserved: ReservedName[] };

export const MAX_CHARS_PER_WALLET = 8;
export const NAME_RESERVE_MS = 10 * 60_000;

/** An inbound the server recorded from custody. The game client cannot insert these. */
export type CustodyInbound =
  | { kind: "depositKek"; tokenId: string; nonce: string; amount: string }
  | { kind: "importItem"; tokenId: string; nonce: string; itemId: string; amount: string };

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
      note: "No LOK_CHAIN_RPC. KEK deposits, KEK withdrawals, and item exports stay engine events; Robinhood L2 is not queried and nothing is submitted.",
    };
  }
  if (env.LOK_CHECKPOINT?.trim()) {
    return {
      chain: "watching",
      note: "Watching the checkpoint for KEK deposits. A withdrawal queues on the vault and waits out its delay. Spendable KEK is debited only after that queue exists.",
    };
  }
  return {
    chain: "rpc-unwatched",
    note: "LOK_CHAIN_RPC is set, but no KekVault watcher or withdrawal transaction is wired. Deposits, withdrawals, and exports still only append the per-character logs.",
  };
}

function atomicWrite(path: string, text: string) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
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
  readonly chain: LokSnapshot["chain"];
  readonly chainNote: string;
  private readonly exp: LokExports;
  private readonly bindPath: string;
  private bind: BindFile;
  private state: EngineState = { characters: [], listings: [] };
  /** Custody nonces observed by the server. Not loaded from the client and not a chain watcher. */
  private custody = new Map<string, CustodyInbound>();
  length = 0;

  private constructor(dataDir: string, wasmPath: string, env: NodeJS.ProcessEnv) {
    mkdirSync(dataDir, { recursive: true });
    this.logPath = join(dataDir, "lok-world.json");
    this.bindPath = join(dataDir, "lok-bind.json");
    const mode = chainModeFromEnv(env);
    this.chain = mode.chain;
    this.chainNote = mode.note;
    this.exp = loadLokExports(wasmPath);
    const text = existsSync(this.logPath) ? readFileSync(this.logPath, "utf8") : "";
    const opened = lokCall(this.exp, text, (ptr, len) => this.exp.lok_open(ptr, len));
    if (opened.rc !== 0) {
      throw new Error("lok log refused to open: " + opened.out);
    }
    this.bind = this.readBind();
    this.refresh();
    this.reconcileBind();
    this.pruneExpiredReservations();
    if (!existsSync(this.logPath)) this.persistLog();
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
   */
  spendKek(tokenId: string, amount: string): LokResult {
    return this.apply({ op: "spendKek", tokenId, amount });
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

  /** Loot into this character's log inventory. Not a KEK mint. */
  itemDrop(tokenId: string, itemId: string, amount: string): LokResult {
    return this.apply({ op: "itemDrop", tokenId, itemId, amount });
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
  fill(bidder: string, itemId: string, amount: string): LokResult & { listingId?: string; seller?: string; stack?: string } {
    const before = this.state.listings.map((row) => ({ ...row }));
    const res = this.apply({ op: "fill", bidder, itemId, amount });
    if (!res.ok) return res;
    const left = new Set(this.state.listings.map((row) => row.id));
    const prior = before.find((row) => !left.has(row.id));
    return { ok: true, listingId: prior?.id, seller: prior?.seller, stack: prior?.amount };
  }

  bid(listingId: string, bidder: string, amount: string): LokResult {
    return this.apply({ op: "bid", listingId, bidder, amount });
  }

  cancel(listingId: string, seller: string): LokResult {
    return this.apply({ op: "cancel", listingId, seller });
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
      if (owner) row.wallet = owner;
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
    if (!row) return;
    if (row.wallet && row.wallet.toLowerCase() === owner) return;
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
   * Read events already on the log. tokenId null is every character, one row per seq.
   * A set token is that character's own chain. Nothing is appended.
   */
  explore(opts: {
    tokenId: string | null;
    q?: string;
    limit?: number;
    beforeSeq?: number | null;
  }): LokExplorePage {
    const text = existsSync(this.logPath) ? readFileSync(this.logPath, "utf8") : "";
    return exploreDocument(text, (id) => this.bind.chars.find((c) => c.tokenId === id)?.name ?? id, opts);
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
      kek: me?.kek ?? "0",
      items,
      inbox,
      listings,
      chain: this.chain,
      withdrawDelaySec: null,
      queues: [],
    };
  }

  kekOf(tokenId: string): string {
    return this.state.characters.find((c) => c.tokenId === tokenId)?.kek ?? "0";
  }

  itemOf(tokenId: string, itemId: string): string {
    const me = this.state.characters.find((c) => c.tokenId === tokenId);
    return me?.items.find((row) => row.itemId === itemId)?.amount ?? "0";
  }

  private apply(cmd: Record<string, unknown>): LokResult {
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
    if (body.entry) this.persistLog();
    return { ok: true };
  }

  private refresh() {
    const called = lokCall(this.exp, JSON.stringify({ op: "state" }), (ptr, len) => this.exp.lok_apply(ptr, len));
    const body = JSON.parse(called.out) as ApplyBody;
    if (!body.ok || !body.state) throw new Error("lok state failed");
    this.state = body.state;
    this.length = body.len ?? 0;
  }

  private persistLog() {
    this.exp.lok_document();
    atomicWrite(this.logPath, lokOut(this.exp));
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
