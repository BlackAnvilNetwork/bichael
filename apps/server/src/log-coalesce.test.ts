import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TickCoalesce } from "./log-coalesce";

describe("TickCoalesce", () => {
  it("sums harvest, loot, and gold for the same character inside one tick", () => {
    const batch = new TickCoalesce();
    assert.equal(batch.add({ op: "harvest", tokenId: "1", materialId: "ore", amount: "2" }).ok, true);
    assert.equal(batch.add({ op: "harvest", tokenId: "1", materialId: "ore", amount: "3" }).ok, true);
    assert.equal(batch.add({ op: "harvest", tokenId: "1", materialId: "wood", amount: "1" }).ok, true);
    assert.equal(batch.add({ op: "lootDrop", tokenId: "1", itemId: "7", amount: "1", killId: "4", batchId: 1 }).ok, true);
    assert.equal(batch.add({ op: "lootDrop", tokenId: "1", itemId: "7", amount: "4", killId: "4", batchId: 1 }).ok, true);
    assert.equal(batch.add({ op: "goldEarn", tokenId: "1", source: "drop", amount: "5", day: 10 }).ok, true);
    assert.equal(batch.add({ op: "goldEarn", tokenId: "1", source: "drop", amount: "7", day: 10 }).ok, true);
    assert.equal(batch.add({ op: "goldEarn", tokenId: "2", source: "drop", amount: "1", day: 10 }).ok, true);
    const rows = batch.drain();
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.find((row) => row.op === "harvest" && row.materialId === "ore"),
      { op: "harvest", tokenId: "1", materialId: "ore", amount: "5" },
    );
    assert.deepEqual(
      rows.find((row) => row.op === "lootDrop"),
      { op: "lootDrop", tokenId: "1", itemId: "7", amount: "5", killId: "4", batchId: 1 },
    );
    assert.deepEqual(
      rows.find((row) => row.op === "goldEarn" && row.tokenId === "1"),
      { op: "goldEarn", tokenId: "1", source: "drop", amount: "12", day: 10 },
    );
    assert.equal(batch.drain().length, 0);
  });

  it("rejects an empty material and a zero amount before they are queued", () => {
    const batch = new TickCoalesce();
    const badMat = batch.add({ op: "harvest", tokenId: "1", materialId: "", amount: "1" });
    assert.equal(badMat.ok, false);
    const badAmt = batch.add({ op: "lootDrop", tokenId: "1", itemId: "7", amount: "0", killId: "4", batchId: 1 });
    assert.equal(badAmt.ok, false);
    assert.equal(batch.size, 0);
  });
});
