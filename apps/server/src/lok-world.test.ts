import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LokWorld } from "./lok-world";

function noteImport(lok: LokWorld, tokenId: string, itemId: string, amount: string, nonce: string) {
  lok.noteCustodyInbound({ kind: "importItem", tokenId, nonce, itemId, amount });
  return lok.importItem(tokenId, itemId, amount, nonce);
}

function noteDeposit(lok: LokWorld, tokenId: string, amount: string, nonce: string) {
  lok.noteCustodyInbound({ kind: "depositKek", tokenId, nonce, amount });
  return lok.depositKek(tokenId, amount, nonce);
}


function world() {
  const dir = mkdtempSync(join(tmpdir(), "lok-world-"));
  return LokWorld.open(dir, undefined, {});
}

test("item transfer is logged and a short or self send is rejected", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(noteImport(lok, a.tokenId, "7", "3", "1").ok, true);
  assert.equal(lok.sendItem(a.tokenId, b.tokenId, "7", "2").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "1");
  assert.equal(lok.itemOf(b.tokenId, "7"), "2");
  const len = lok.length;
  const self = lok.sendItem(a.tokenId, a.tokenId, "7", "1");
  assert.equal(self.ok, false);
  if (!self.ok) assert.match(self.error, /self/i);
  const short = lok.sendItem(a.tokenId, b.tokenId, "7", "5");
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /insufficient/i);
  assert.equal(lok.length, len);
  assert.equal(lok.itemOf(a.tokenId, "7"), "1");
  assert.equal(lok.itemOf(b.tokenId, "7"), "2");
});

test("auction settle pays the high bid with no fee and replays after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-auction-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(noteImport(lok, a.tokenId, "7", "1", "1").ok, true);
  // Custody credit, not a faucet: the test stands in for a vault deposit the server was told already happened.
  assert.equal(noteDeposit(lok, b.tokenId, "9", "1").ok, true);
  const listed = lok.list(a.tokenId, "7", "1");
  assert.equal(listed.ok, true);
  if (!listed.ok || !listed.listingId) return;
  assert.equal(lok.itemOf(a.tokenId, "7"), "0");
  assert.equal(lok.bid(listed.listingId, b.tokenId, "3").ok, true);
  const low = lok.bid(listed.listingId, b.tokenId, "2");
  assert.equal(low.ok, false);
  assert.equal(lok.bid(listed.listingId, b.tokenId, "5").ok, true);
  assert.equal(lok.kekOf(b.tokenId), "4");
  const cancel = lok.cancel(listed.listingId, b.tokenId);
  assert.equal(cancel.ok, false);
  if (!cancel.ok) assert.match(cancel.error, /seller/i);
  assert.equal(lok.settle(listed.listingId).ok, true);
  assert.equal(lok.itemOf(b.tokenId, "7"), "1");
  assert.equal(lok.kekOf(a.tokenId), "5");
  assert.equal(lok.kekOf(b.tokenId), "4");
  assert.equal(lok.view(a.tokenId).listings.length, 0);

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.itemOf(b.tokenId, "7"), "1");
  assert.equal(again.kekOf(a.tokenId), "5");
  assert.equal(again.kekOf(b.tokenId), "4");
  assert.equal(again.length, lok.length);
});

test("spendKek debits spendable KEK, leaves escrow locked, and does not mint", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-spend-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(noteImport(lok, a.tokenId, "7", "1", "1").ok, true);
  assert.equal(noteDeposit(lok, b.tokenId, "10", "1").ok, true);
  const listed = lok.list(a.tokenId, "7", "1");
  assert.equal(listed.ok, true);
  if (!listed.ok || !listed.listingId) return;
  assert.equal(lok.bid(listed.listingId, b.tokenId, "6").ok, true);
  assert.equal(lok.kekOf(b.tokenId), "4");
  const short = lok.spendKek(b.tokenId, "5");
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /insufficient/i);
  assert.equal(lok.kekOf(b.tokenId), "4");
  assert.equal(lok.spendKek(b.tokenId, "4").ok, true);
  assert.equal(lok.kekOf(b.tokenId), "0");
  const zero = lok.spendKek(b.tokenId, "0");
  assert.equal(zero.ok, false);
  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.kekOf(b.tokenId), "0");
  assert.equal(again.kekOf(a.tokenId), "0");
});

test("withdrawKek drops spendable balance and a transfer is stored on both logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-withdraw-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(noteDeposit(lok, a.tokenId, "10", "1").ok, true);
  assert.equal(lok.withdrawKek(a.tokenId, "4").ok, true);
  assert.equal(lok.kekOf(a.tokenId), "6");
  const len = lok.length;
  const over = lok.withdrawKek(a.tokenId, "7");
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.error, /insufficient/i);
  assert.equal(lok.length, len);
  assert.equal(lok.kekOf(a.tokenId), "6");
  assert.equal(lok.sendKek(a.tokenId, b.tokenId, "2").ok, true);
  assert.equal(lok.kekOf(a.tokenId), "4");
  assert.equal(lok.kekOf(b.tokenId), "2");

  const doc = JSON.parse(readFileSync(lok.logPath, "utf8")) as {
    type: string;
    characters: { tokenId: string; entries: { hash: string; input: { type: string } }[] }[];
  };
  assert.equal(doc.type, "characters");
  const logA = doc.characters.find((c) => c.tokenId === a.tokenId);
  const logB = doc.characters.find((c) => c.tokenId === b.tokenId);
  const sendA = logA?.entries.find((e) => e.input.type === "sendKek");
  const sendB = logB?.entries.find((e) => e.input.type === "sendKek");
  assert.ok(sendA && sendB);
  assert.notEqual(sendA.hash, sendB.hash);
  assert.deepEqual(sendA.input, sendB.input);

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.kekOf(a.tokenId), "4");
  assert.equal(again.kekOf(b.tokenId), "2");
  assert.equal(again.length, lok.length);
});

test("deposit nonce replay fails and two recorded nonces credit twice", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(lok.depositKek(a.tokenId, "4", "1").ok, false);
  assert.equal(noteDeposit(lok, a.tokenId, "4", "1").ok, true);
  assert.equal(lok.kekOf(a.tokenId), "4");
  assert.equal(noteDeposit(lok, a.tokenId, "4", "1").ok, false);
  assert.equal(lok.kekOf(a.tokenId), "4");
  assert.equal(noteDeposit(lok, a.tokenId, "6", "2").ok, true);
  assert.equal(lok.kekOf(a.tokenId), "10");
  assert.equal(noteImport(lok, a.tokenId, "7", "2", "3").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
  assert.equal(noteImport(lok, a.tokenId, "7", "1", "3").ok, false);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
});


test("level, ability, craft, harvest, and drop replay and a bad event does not append", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-game-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(lok.levelOf(a.tokenId), 1);
  assert.equal(lok.levelUp(a.tokenId, 2).ok, true);
  assert.equal(lok.levelOf(a.tokenId), 2);
  const len = lok.length;
  const skip = lok.levelUp(a.tokenId, 4);
  assert.equal(skip.ok, false);
  if (!skip.ok) assert.match(skip.error, /level/i);
  assert.equal(lok.length, len);
  assert.equal(lok.levelOf(a.tokenId), 2);

  assert.equal(lok.learnAbility(a.tokenId, "fire").ok, true);
  assert.equal(lok.hasAbility(a.tokenId, "fire"), true);
  const againAbility = lok.learnAbility(a.tokenId, "fire");
  assert.equal(againAbility.ok, false);
  if (!againAbility.ok) assert.match(againAbility.error, /already known/i);
  assert.equal(lok.length, len + 1);

  assert.equal(lok.craft(a.tokenId, "9", "1").ok, true);
  assert.equal(lok.craftOf(a.tokenId, "9"), "1");
  assert.equal(lok.itemOf(a.tokenId, "9"), "0");
  assert.equal(lok.kekOf(a.tokenId), "0");
  const badCraft = lok.craft(a.tokenId, "0", "1");
  assert.equal(badCraft.ok, false);

  assert.equal(lok.harvest(a.tokenId, "dustgrain", "2").ok, true);
  assert.equal(lok.harvestOf(a.tokenId, "dustgrain"), "2");
  const badHarvest = lok.harvest(a.tokenId, "", "1");
  assert.equal(badHarvest.ok, false);
  assert.equal(lok.harvestOf(a.tokenId, "dustgrain"), "2");

  assert.equal(lok.itemDrop(a.tokenId, "7", "2").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
  assert.equal(lok.kekOf(a.tokenId), "0");
  const before = lok.length;
  const badDrop = lok.itemDrop(a.tokenId, "0", "1");
  assert.equal(badDrop.ok, false);
  if (!badDrop.ok) assert.match(badDrop.error, /invalid/i);
  assert.equal(lok.length, before);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.levelOf(a.tokenId), 2);
  assert.equal(again.hasAbility(a.tokenId, "fire"), true);
  assert.equal(again.craftOf(a.tokenId, "9"), "1");
  assert.equal(again.harvestOf(a.tokenId, "dustgrain"), "2");
  assert.equal(again.itemOf(a.tokenId, "7"), "2");
  assert.equal(again.kekOf(a.tokenId), "0");
  assert.equal(again.length, lok.length);
});

test("explore reads yours or everyone, searches, and pages newest first", () => {
  const lok = world();
  assert.deepEqual(lok.explore({ tokenId: null }).events, []);
  assert.equal(lok.explore({ tokenId: null }).total, 0);

  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;

  assert.equal(noteImport(lok, a.tokenId, "7", "2", "1").ok, true);
  assert.equal(noteDeposit(lok, b.tokenId, "9", "1").ok, true);
  assert.equal(lok.sendKek(b.tokenId, a.tokenId, "4").ok, true);
  assert.equal(lok.learnAbility(a.tokenId, "fire").ok, true);
  assert.equal(lok.harvest(b.tokenId, "dustgrain", "13").ok, true);
  for (const id of ["a0", "a1", "a2", "a3"]) {
    assert.equal(lok.learnAbility(a.tokenId, id).ok, true);
  }
  const beforeReject = lok.explore({ tokenId: a.tokenId }).total;
  assert.equal(lok.sendKek(a.tokenId, b.tokenId, "99").ok, false);
  assert.equal(lok.explore({ tokenId: a.tokenId }).total, beforeReject);

  const yours = lok.explore({ tokenId: a.tokenId });
  assert.ok(yours.events.every((event) => event.text.includes("Ada") || event.character === "Ada" || event.kind === "sendKek"));
  assert.equal(yours.events.some((event) => event.kind === "harvest"), false);
  assert.equal(yours.events.some((event) => event.kind === "depositKek"), false);
  assert.equal(yours.events.filter((event) => event.kind === "sendKek").length, 1);
  assert.ok(yours.events[0]!.seq >= yours.events[yours.events.length - 1]!.seq);
  assert.equal(yours.events[0]!.kind, "learnAbility");
  assert.match(yours.events[0]!.text, /a3/);

  const worldRows = lok.explore({ tokenId: null });
  assert.equal(worldRows.events.filter((event) => event.kind === "sendKek").length, 1);
  assert.equal(worldRows.events.some((event) => event.kind === "harvest"), true);
  assert.equal(worldRows.events.some((event) => event.kind === "depositKek"), true);
  assert.ok(worldRows.total > yours.total);

  const leather = lok.explore({ tokenId: null, q: "leather" });
  assert.equal(leather.events.length, 1);
  assert.equal(leather.events[0]!.kind, "importItem");
  assert.match(leather.events[0]!.text, /Leather Vest/);

  const byKind = lok.explore({ tokenId: a.tokenId, q: "SENDKEK" });
  assert.equal(byKind.events.length, 1);
  assert.match(byKind.events[0]!.text, /Bea/);
  assert.match(byKind.events[0]!.text, /Ada/);

  const byAbility = lok.explore({ tokenId: a.tokenId, q: "fire" });
  assert.equal(byAbility.events.length, 1);
  assert.equal(byAbility.events[0]!.kind, "learnAbility");

  const byAmount = lok.explore({ tokenId: null, q: "13" });
  assert.equal(byAmount.events.length, 1);
  assert.equal(byAmount.events[0]!.kind, "harvest");
  assert.match(byAmount.events[0]!.text, /Bea/);

  const none = lok.explore({ tokenId: null, q: "not-a-real-event" });
  assert.deepEqual(none.events, []);
  assert.equal(none.total, 0);
  assert.equal(none.hasMore, false);

  const page = lok.explore({ tokenId: a.tokenId, limit: 2 });
  assert.equal(page.events.length, 2);
  assert.equal(page.hasMore, true);
  assert.ok(page.total > 2);
  const older = lok.explore({ tokenId: a.tokenId, limit: 2, beforeSeq: page.events[1]!.seq });
  assert.equal(older.events.length, 2);
  assert.ok(older.events.every((event) => event.seq < page.events[1]!.seq));
  const seen = new Set(page.events.map((event) => event.seq));
  assert.ok(older.events.every((event) => !seen.has(event.seq)));
});

test("order book sells the lowest Pale Dust ask at the bid and leaves the rest", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  const c = lok.spawn("char-c", "Cam", 2);
  const d = lok.spawn("char-d", "Dot", 0);
  assert.equal(a.ok && b.ok && c.ok && d.ok, true);
  if (!a.ok || !b.ok || !c.ok || !d.ok) return;
  const dust = "1057";
  assert.equal(noteImport(lok, a.tokenId, dust, "1", "1").ok, true);
  assert.equal(noteImport(lok, b.tokenId, dust, "1", "1").ok, true);
  assert.equal(noteImport(lok, c.tokenId, dust, "1", "1").ok, true);
  assert.equal(noteDeposit(lok, a.tokenId, "100", "2").ok, true);
  assert.equal(noteDeposit(lok, d.tokenId, "3000", "1").ok, true);
  const t0 = 1_700_000_000;
  const ask100 = lok.ask(a.tokenId, dust, "1", "100", t0);
  const ask1000 = lok.ask(b.tokenId, dust, "1", "1000", t0 + 1);
  const ask2000 = lok.ask(c.tokenId, dust, "1", "2000", t0 + 2);
  assert.equal(ask100.ok && ask1000.ok && ask2000.ok, true);
  if (!ask100.ok || !ask1000.ok || !ask2000.ok) return;

  const own = lok.fill(a.tokenId, dust, "100");
  assert.equal(own.ok, false);
  if (!own.ok) assert.match(own.error, /ask/i);
  assert.equal(lok.kekOf(a.tokenId), "100");
  assert.equal(lok.view(a.tokenId).listings.some((row) => row.id === ask100.listingId), true);

  const low = lok.fill(d.tokenId, dust, "50");
  assert.equal(low.ok, false);
  assert.equal(lok.kekOf(d.tokenId), "3000");

  const bought = lok.fill(d.tokenId, dust, "2000");
  assert.equal(bought.ok, true);
  if (!bought.ok) return;
  assert.equal(bought.listingId, ask100.listingId);
  assert.equal(bought.seller, a.tokenId);
  assert.equal(lok.kekOf(a.tokenId), "2100");
  assert.equal(lok.kekOf(d.tokenId), "1000");
  assert.equal(lok.itemOf(d.tokenId, dust), "0");
  assert.equal(lok.view(d.tokenId).inbox.find((row) => row.tokenId === 1057)?.amount, "1");
  const left = lok.view(d.tokenId).listings.map((row) => row.minPrice).sort();
  assert.deepEqual(left, ["1000", "2000"]);

  assert.equal(lok.sendInbox(d.tokenId, b.tokenId, dust, "1").ok, false);
  assert.equal(lok.takeInbox(d.tokenId, dust, "1").ok, true);
  assert.equal(lok.view(d.tokenId).inbox.length, 0);
  assert.equal(lok.itemOf(d.tokenId, dust), "0");

  assert.equal(lok.cancel(ask1000.listingId!, b.tokenId).ok, true);
  assert.equal(lok.view(b.tokenId).inbox.find((row) => row.tokenId === 1057)?.amount, "1");
  assert.equal(lok.itemOf(b.tokenId, dust), "0");

  const early = lok.reclaim(ask2000.listingId!, c.tokenId, t0 + 2 + 7 * 24 * 60 * 60 - 1);
  assert.equal(early.ok, false);
  assert.equal(lok.reclaim(ask2000.listingId!, c.tokenId, t0 + 2 + 7 * 24 * 60 * 60).ok, true);
  assert.equal(lok.view(c.tokenId).inbox.find((row) => row.tokenId === 1057)?.amount, "1");
  assert.equal(lok.view(c.tokenId).listings.length, 0);
});
