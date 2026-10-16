import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { LOG_SNAPSHOT_EVERY, LokWorld } from "./lok-world";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "lok-phase0-"));
  return LokWorld.open(dir, undefined, {});
}

function journalOps(lok: LokWorld): string[] {
  const text = readFileSync(lok.journalPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { cmd?: { op?: string } }).cmd?.op ?? "");
}

test("a tick merges harvest, loot, and gold into one journal line each", () => {
  const lok = world();
  const spawned = lok.spawn("char-a", "Ada", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  const before = readFileSync(lok.journalPath).length;

  lok.beginTick();
  assert.equal(lok.kill(token, "1").ok, true);
  assert.equal(lok.harvest(token, "ore", "2").ok, true);
  assert.equal(lok.harvest(token, "ore", "3").ok, true);
  assert.equal(lok.lootDrop(token, "7", "1", "1").ok, true);
  assert.equal(lok.lootDrop(token, "7", "4", "1").ok, true);
  assert.equal(lok.goldEarn(token, "drop", "5", 3).ok, true);
  assert.equal(lok.goldEarn(token, "drop", "6", 3).ok, true);
  // Still queued: the journal has not grown yet.
  assert.equal(readFileSync(lok.journalPath).length, before);
  const flushed = lok.endTick();
  assert.equal(flushed.ok, true);

  const added = readFileSync(lok.journalPath).subarray(before).toString("utf8");
  const lines = added.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 4);
  const cmds = lines.map((line) => JSON.parse(line) as { cmd: { op: string; amount?: string } });
  assert.deepEqual(
    cmds.map((row) => row.cmd.op),
    ["kill", "harvest", "lootDrop", "goldEarn"],
  );
  assert.deepEqual(
    cmds.slice(1).map((row) => row.cmd.op + ":" + row.cmd.amount),
    ["harvest:5", "lootDrop:5", "goldEarn:11"],
  );
  assert.equal(lok.harvestOf(token, "ore"), "5");
  assert.equal(lok.goldOf(token), "11");

  const again = LokWorld.open(lok.logPath.replace(/lok-world\.json$/, ""), undefined, {});
  assert.equal(again.harvestOf(token, "ore"), "5");
  assert.equal(again.dropOf(token, "7"), "5");
  assert.equal(again.goldOf(token), "11");
  assert.equal(journalOps(again).filter((op) => op === "harvest").length, 1);
});

test("an out-of-tick goldEarn is on the reopened world after the writer is dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-journal-fd-"));
  const token = (() => {
    const lok = LokWorld.open(dir, undefined, {});
    const spawned = lok.spawn("char-a", "Ada", 0);
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return "";
    assert.equal(lok.goldEarn(spawned.tokenId, "quest", "100", 1).ok, true);
    return spawned.tokenId;
  })();
  assert.notEqual(token, "");
  const journal = readFileSync(join(dir, "lok-world.jsonl"), "utf8");
  assert.match(journal, /"op":"goldEarn"/);
  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.goldOf(token), "100");
});

test("outside a tick each harvest is its own journal line", () => {
  const lok = world();
  const spawned = lok.spawn("char-a", "Ada", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  assert.equal(lok.harvest(spawned.tokenId, "ore", "1").ok, true);
  assert.equal(lok.harvest(spawned.tokenId, "ore", "1").ok, true);
  assert.equal(journalOps(lok).filter((op) => op === "harvest").length, 2);
  assert.equal(lok.harvestOf(spawned.tokenId, "ore"), "2");
});

test("a tick defers the full snapshot until after the tick returns", async () => {
  const lok = world();
  const spawned = lok.spawn("char-a", "Ada", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const snapBefore = readFileSync(lok.logPath);
  lok.beginTick();
  for (let i = 0; i < LOG_SNAPSHOT_EVERY; i++) {
    assert.equal(lok.goldEarn(spawned.tokenId, "src" + i, "1", 4).ok, true);
  }
  assert.equal(lok.endTick().ok, true);
  assert.equal(readFileSync(lok.logPath).equals(snapBefore), true);
  await waitImmediate();
  const snapAfter = readFileSync(lok.logPath);
  assert.equal(snapAfter.equals(snapBefore), false);
  assert.ok(snapAfter.subarray(0, 16).toString("utf8").startsWith('{"journalBytes":'));
  const again = LokWorld.open(lok.logPath.replace(/lok-world\.json$/, ""), undefined, {});
  assert.equal(again.goldOf(spawned.tokenId), String(LOG_SNAPSHOT_EVERY));
  assert.equal(journalOps(again).filter((op) => op === "goldEarn").length, LOG_SNAPSHOT_EVERY);
});
