import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  NftOwnerCache,
  nftOwnerBlockRank,
  resetNftOwnerCacheForTests,
} from "./nft-owner-cache";

describe("NftOwnerCache monotonic watermark (#285)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetNftOwnerCacheForTests();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function cache(): NftOwnerCache {
    const dir = mkdtempSync(join(tmpdir(), "nft-owner-"));
    dirs.push(dir);
    return new NftOwnerCache(join(dir, "nft-owner-cache.json"));
  }

  it("ranks blocks", () => {
    assert.equal(nftOwnerBlockRank(0), 0n);
    assert.equal(nftOwnerBlockRank("42"), 42n);
    assert.equal(nftOwnerBlockRank(100n), 100n);
  });

  it("Transfer block is not clobbered by live ownerOf(block=0)", () => {
    const c = cache();
    const token = "7";
    const buyer = "0x1111111111111111111111111111111111111111";
    const seller = "0x2222222222222222222222222222222222222222";
    assert.equal(c.onTransfer(token, buyer, 1_000_000), true);
    assert.equal(c.get(token), buyer);
    assert.equal(c.set(token, seller, 0), false);
    assert.equal(c.get(token), buyer);
    assert.equal(c.getEntry(token)?.block, "1000000");
  });

  it("allows live fill when cache empty", () => {
    const c = cache();
    const token = "3";
    const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.equal(c.set(token, owner, 0), true);
    assert.equal(c.get(token), owner);
  });

  it("rejects backwards block watermarks", () => {
    const c = cache();
    const token = "9";
    const a = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const b = "0xcccccccccccccccccccccccccccccccccccccccc";
    assert.equal(c.onTransfer(token, a, 50), true);
    assert.equal(c.onTransfer(token, b, 40), false);
    assert.equal(c.get(token), a);
    assert.equal(c.onTransfer(token, b, 51), true);
    assert.equal(c.get(token), b);
  });
});
