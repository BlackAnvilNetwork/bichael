/**
 * Cached CharacterNFT ownerOf, updated at Transfer finality.
 * Character-scoped actions authorize against this cache (fallback: live eth_call).
 *
 * #285: live ownerOf writes must not clobber a confirmed Transfer block with block=0.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultLokDir } from "./lok-world";
import { readCharacterNftOwner } from "./lok-vault";

export const NFT_OWNER_CACHE_FILE = "nft-owner-cache.json";

export type NftOwnerEntry = {
  owner: string;
  block: string;
  updatedAt: string;
};

type CacheFile = { owners: Record<string, NftOwnerEntry> };

export function nftOwnerCachePath(dataDir: string = defaultLokDir()): string {
  return join(dataDir, NFT_OWNER_CACHE_FILE);
}

/** Numeric rank for cache watermarks; invalid → 0. */
export function nftOwnerBlockRank(block: string | number | bigint): bigint {
  try {
    const n = typeof block === "bigint" ? block : BigInt(String(block).trim() || "0");
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

export class NftOwnerCache {
  private owners: Record<string, NftOwnerEntry> = {};

  constructor(readonly path: string) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.path)) {
      this.owners = {};
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as CacheFile;
      this.owners = parsed.owners && typeof parsed.owners === "object" ? parsed.owners : {};
    } catch {
      this.owners = {};
    }
  }

  private persist(): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ owners: this.owners } satisfies CacheFile, null, 2) + "\n");
    renameSync(tmp, this.path);
  }

  get(tokenId: string): string | null {
    const row = this.owners[tokenId];
    return row?.owner ?? null;
  }

  getEntry(tokenId: string): NftOwnerEntry | null {
    return this.owners[tokenId] ?? null;
  }

  /**
   * Store owner. Monotonic by block:
   * - never let block 0 (unknown / live eth_call) overwrite a confirmed block > 0
   * - never move the watermark backwards
   */
  set(tokenId: string, owner: string, block: string | number | bigint): boolean {
    const o = owner.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(o) || !/^[1-9][0-9]{0,77}$/.test(tokenId)) return false;
    const nextBlock = String(block);
    const nextRank = nftOwnerBlockRank(nextBlock);
    const prev = this.owners[tokenId];
    if (prev) {
      const prevRank = nftOwnerBlockRank(prev.block);
      if (nextRank === 0n && prevRank > 0n) return false;
      if (nextRank < prevRank) return false;
    }
    this.owners[tokenId] = {
      owner: o,
      block: nextBlock,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return true;
  }

  /** Apply a finalized ERC-721 Transfer (skip mint-from-zero is caller's job). */
  onTransfer(tokenId: string, to: string, block: string | number | bigint): boolean {
    return this.set(tokenId, to, block);
  }
}

let shared: NftOwnerCache | null = null;

export function nftOwnerCache(dataDir?: string): NftOwnerCache {
  if (!shared || (dataDir && shared.path !== nftOwnerCachePath(dataDir))) {
    shared = new NftOwnerCache(nftOwnerCachePath(dataDir));
  }
  return shared;
}

export function resetNftOwnerCacheForTests(): void {
  shared = null;
}

/**
 * Resolve controlling wallet for a character token.
 * Prefer cache; fall back to live ownerOf.
 */
export async function resolveCharacterController(
  tokenId: string,
  opts?: { env?: NodeJS.ProcessEnv; dataDir?: string; preferLive?: boolean },
): Promise<{ ok: true; owner: string; source: "cache" | "live" } | { ok: false; error: string }> {
  const cache = nftOwnerCache(opts?.dataDir);
  if (!opts?.preferLive) {
    const cached = cache.get(tokenId);
    if (cached) return { ok: true, owner: cached, source: "cache" };
  }
  const live = await readCharacterNftOwner(tokenId, opts?.env);
  if (!live.ok) return { ok: false, error: live.error };
  // block=0 means "unconfirmed live read" — must not clobber Transfer watermarks (#285).
  cache.set(tokenId, live.holder, 0);
  return { ok: true, owner: live.holder.toLowerCase(), source: "live" };
}

/** Session may act on this character only when wallet == current NFT owner. */
export async function sessionOwnsCharacter(
  sessionWallet: string,
  tokenId: string,
  opts?: { env?: NodeJS.ProcessEnv; dataDir?: string; preferLive?: boolean },
): Promise<{ ok: true; owner: string } | { ok: false; error: string }> {
  const w = sessionWallet.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w)) return { ok: false, error: "Bad session wallet." };
  // Value-moving actions should preferLive so a pre-finality Transfer cannot leave
  // the seller in control for ~30 blocks (re-test #5).
  const ctrl = await resolveCharacterController(tokenId, {
    env: opts?.env,
    dataDir: opts?.dataDir,
    preferLive: opts?.preferLive !== false,
  });
  if (!ctrl.ok) return ctrl;
  if (ctrl.owner !== w) {
    return {
      ok: false,
      error: "This character NFT is owned by " + ctrl.owner + ", not your session wallet.",
    };
  }
  return { ok: true, owner: ctrl.owner };
}
