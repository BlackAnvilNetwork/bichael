import { planQuantityFills, type AskQuote } from "@bellgrave/protocol";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUY_FILL_BATCH, LOG_SNAPSHOT_EVERY, LokWorld, MAX_FILLS_PER_BUY_MESSAGE } from "./lok-world";

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

  const doc = JSON.parse(lok.logDocument()) as {
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

  assert.equal(lok.importFromBag(a.tokenId, "7", "2").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
  assert.equal(lok.kekOf(a.tokenId), "0");
  const before = lok.length;
  const badDrop = lok.itemDrop(a.tokenId, "0", "1");
  assert.equal(badDrop.ok, false);
  if (!badDrop.ok) assert.match(badDrop.error, /cannot mint/i);
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

test("order book sells the lowest Pale Dust ask at the ask price and leaves the rest", () => {
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
  assert.equal(bought.price, "100");
  assert.equal(lok.kekOf(a.tokenId), "200");
  assert.equal(lok.kekOf(d.tokenId), "2900");
  assert.equal(lok.vaultClaim(a.tokenId), "200");
  assert.equal(lok.vaultClaim(d.tokenId), "2900");
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

test("blank names are rejected and case-folded names cannot both be reserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-names-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spaces = lok.claimName("char-blank", "  ");
  assert.equal(spaces.ok, false);
  if (!spaces.ok) assert.match(spaces.error, /blank/i);
  const invisible = lok.spawn("char-inv", "\u200b\u200b", 0);
  assert.equal(invisible.ok, false);
  const first = lok.claimName("char-a", "Chrona");
  assert.equal(first.ok, true);
  assert.equal(lok.tokenFor("char-a"), null);
  const folded = lok.claimName("char-b", "chrona");
  assert.equal(folded.ok, false);
  if (!folded.ok) assert.match(folded.error, /already/i);
  const look = lok.claimName("char-c", "Chr\u03bfna");
  assert.equal(look.ok, false);
  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.claimName("char-d", "CHRONA").ok, false);
  const spawned = again.spawn("char-a", "Chrona", 0);
  assert.equal(spawned.ok, true);
  assert.equal(again.spawn("char-b", "chrona", 0).ok, false);
});

test("a send uses the character id and does not deliver to a lookalike name", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-look-"));
  const lok = LokWorld.open(dir, undefined, {});
  const chrona = lok.spawn("char-chrona", "Chrona", 0);
  const other = lok.spawn("char-other", "Bea", 0);
  const ada = lok.spawn("char-ada", "Ada", 0);
  assert.equal(chrona.ok && other.ok && ada.ok, true);
  if (!chrona.ok || !other.ok || !ada.ok) return;
  const bindPath = join(dir, "lok-bind.json");
  const bind = JSON.parse(readFileSync(bindPath, "utf8")) as {
    chars: { charId: string; name: string }[];
  };
  const planted = bind.chars.find((row) => row.charId === "char-other");
  assert.ok(planted);
  planted.name = "Chr\u03bfna";
  writeFileSync(bindPath, JSON.stringify(bind));
  const opened = LokWorld.open(dir, undefined, {});
  const rows = opened.boundChars();
  const real = rows.find((row) => row.charId === "char-chrona");
  const fake = rows.find((row) => row.charId === "char-other");
  const sender = rows.find((row) => row.charId === "char-ada");
  assert.ok(real && fake && sender);
  assert.equal(noteImport(opened, sender.tokenId, "7", "1", "1").ok, true);
  assert.equal(noteDeposit(opened, sender.tokenId, "5", "2").ok, true);
  const byLook = opened.resolveRecipient(fake.name, sender.tokenId);
  assert.equal(byLook.ok, false);
  const byFold = opened.resolveRecipient("chrona", sender.tokenId);
  assert.equal(byFold.ok, false);
  const byId = opened.resolveRecipient(real.charId, sender.tokenId);
  assert.equal(byId.ok, true);
  if (!byId.ok) return;
  assert.equal(byId.tokenId, real.tokenId);
  assert.notEqual(byId.tokenId, fake.tokenId);
  assert.equal(opened.sendItem(sender.tokenId, byId.tokenId, "7", "1").ok, true);
  assert.equal(opened.itemOf(real.tokenId, "7"), "1");
  assert.equal(opened.itemOf(fake.tokenId, "7"), "0");
  const fakeId = opened.resolveRecipient(fake.tokenId, sender.tokenId);
  assert.equal(fakeId.ok, true);
  if (!fakeId.ok) return;
  assert.equal(fakeId.tokenId, fake.tokenId);
  assert.equal(opened.sendKek(sender.tokenId, fakeId.tokenId, "2").ok, true);
  assert.equal(opened.kekOf(fake.tokenId), "2");
  assert.equal(opened.kekOf(real.tokenId), "0");
  assert.equal(opened.kekOf(sender.tokenId), "3");
});

test("a name outside the ascii alphabet is rejected and Chrona 2 still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-alpha-"));
  const lok = LokWorld.open(dir, undefined, {});
  const ok = lok.claimName("char-ok", "  Chrona  2 ");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.name, "Chrona 2");
  const punct = lok.claimName("char-punct", "Chrona!");
  assert.equal(punct.ok, false);
  const look = lok.claimName("char-look", "Chr\u043ena");
  assert.equal(look.ok, false);
  assert.equal(lok.claimName("char-dup", "chrona 2").ok, false);
  const spawned = lok.spawn("char-ok", "Chrona 2", 0);
  assert.equal(spawned.ok, true);
});

test("a buy pays the lowest ask and a higher fill cannot overpay", () => {
  const lok = world();
  const seller = lok.spawn("char-s", "Sue", 0);
  const buyer = lok.spawn("char-u", "Uma", 1);
  assert.equal(seller.ok && buyer.ok, true);
  if (!seller.ok || !buyer.ok) return;
  assert.equal(noteImport(lok, seller.tokenId, "7", "2", "1").ok, true);
  assert.equal(noteDeposit(lok, buyer.tokenId, "5000", "1").ok, true);
  assert.equal(lok.ask(seller.tokenId, "7", "1", "100", 10).ok, true);
  assert.equal(lok.ask(seller.tokenId, "7", "1", "100", 11).ok, true);
  const bought = lok.buy(buyer.tokenId, "7");
  assert.equal(bought.ok, true);
  if (!bought.ok) return;
  assert.equal(bought.price, "100");
  assert.equal(lok.kekOf(buyer.tokenId), "4900");
  assert.equal(lok.kekOf(seller.tokenId), "100");
  assert.equal(lok.vaultClaim(buyer.tokenId), "4900");
  assert.equal(lok.vaultClaim(seller.tokenId), "100");
  const over = lok.fill(buyer.tokenId, "7", "4000");
  assert.equal(over.ok, true);
  if (!over.ok) return;
  assert.equal(over.price, "100");
  assert.equal(lok.kekOf(buyer.tokenId), "4800");
  assert.equal(lok.vaultClaim(buyer.tokenId), "4800");
});

test("received KEK is the recipient claim and spent KEK is not withdrawable", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(noteDeposit(lok, a.tokenId, "12000", "1").ok, true);
  assert.equal(lok.vaultClaim(a.tokenId), "12000");
  assert.equal(lok.sendKek(a.tokenId, b.tokenId, "4000").ok, true);
  assert.equal(lok.vaultClaim(a.tokenId), "8000");
  assert.equal(lok.vaultClaim(b.tokenId), "4000");
  assert.equal(lok.withdrawKek(a.tokenId, "8001").ok, false);
  assert.equal(lok.withdrawKek(b.tokenId, "4000").ok, true);
  assert.equal(lok.vaultClaim(b.tokenId), "0");
  assert.equal(lok.spendKek(a.tokenId, "1000").ok, true);
  assert.equal(lok.paidRespecSkills(a.tokenId, "7000", ["fire"]).ok, true);
  assert.equal(lok.kekOf(a.tokenId), "0");
  assert.equal(lok.vaultClaim(a.tokenId), "0");
  assert.equal(lok.sunkKek(a.tokenId), "8000");
  assert.equal(lok.withdrawKek(a.tokenId, "1").ok, false);
});

test("item drop cannot mint an arbitrary credit", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const before = lok.length;
  const dropped = lok.itemDrop(a.tokenId, "7", "9");
  assert.equal(dropped.ok, false);
  if (!dropped.ok) assert.match(dropped.error, /cannot mint/i);
  assert.equal(lok.length, before);
  assert.equal(lok.itemOf(a.tokenId, "7"), "0");
  assert.equal(lok.importFromBag(a.tokenId, "7", "2").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
});

test("quantity buy fills cheapest asks first, charges each ask, skips self, and stops when short", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-qty-"));
  const lok = LokWorld.open(dir, undefined, {});
  const ada = lok.spawn("char-a", "Ada", 0);
  const bea = lok.spawn("char-b", "Bea", 1);
  const cam = lok.spawn("char-c", "Cam", 2);
  const dot = lok.spawn("char-d", "Dot", 0);
  const eve = lok.spawn("char-e", "Eve", 1);
  assert.equal(ada.ok && bea.ok && cam.ok && dot.ok && eve.ok, true);
  if (!ada.ok || !bea.ok || !cam.ok || !dot.ok || !eve.ok) return;
  const dust = "1057";
  assert.equal(noteImport(lok, ada.tokenId, dust, "1", "1").ok, true);
  assert.equal(noteImport(lok, bea.tokenId, dust, "2", "1").ok, true);
  assert.equal(noteImport(lok, cam.tokenId, dust, "2", "1").ok, true);
  assert.equal(noteImport(lok, eve.tokenId, dust, "4", "1").ok, true);
  assert.equal(noteImport(lok, dot.tokenId, dust, "5", "1").ok, true);
  assert.equal(noteDeposit(lok, dot.tokenId, "10000", "2").ok, true);
  const t0 = 1_700_000_000;
  const askCam = lok.ask(cam.tokenId, dust, "2", "10", t0 + 50);
  const askBea = lok.ask(bea.tokenId, dust, "2", "10", t0);
  const askEve = lok.ask(eve.tokenId, dust, "4", "8", t0 + 1);
  const askAda = lok.ask(ada.tokenId, dust, "1", "100", t0 + 2);
  const askSelf = lok.ask(dot.tokenId, dust, "5", "1", t0);
  assert.equal(askCam.ok && askBea.ok && askEve.ok && askAda.ok && askSelf.ok, true);
  if (!askCam.ok || !askBea.ok || !askEve.ok || !askAda.ok || !askSelf.ok) return;

  const quotes: AskQuote[] = lok.view(dot.tokenId).listings.map((row) => ({
    id: row.id,
    seller: row.seller,
    itemId: row.itemId,
    amount: row.amount,
    minPrice: row.minPrice,
    listedAt: row.listedAt,
    book: row.book,
  }));
  const planned = planQuantityFills(quotes, dot.tokenId, 1057, 3);
  assert.deepEqual(planned.fills.map((fill) => fill.id), [askEve.listingId]);
  assert.equal(planned.filled, "4");
  assert.equal(planned.short, false);
  assert.equal(planned.fills[0]!.price, "8");

  const rejected = await lok.buyQuantity(dot.tokenId, dust, 0);
  assert.equal(rejected.ok, false);
  const len = lok.length;

  const first = await lok.buyQuantity(dot.tokenId, dust, 3);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.fills.map((fill) => fill.listingId), [askEve.listingId]);
  assert.deepEqual(first.fills.map((fill) => fill.price), ["8"]);
  assert.equal(first.filled, "4");
  assert.equal(first.short, false);
  assert.equal(lok.length, len + 1);
  assert.equal(lok.kekOf(dot.tokenId), "9992");
  assert.equal(lok.kekOf(eve.tokenId), "8");
  assert.equal(lok.kekOf(bea.tokenId), "0");
  assert.equal(lok.view(dot.tokenId).listings.some((row) => row.id === askSelf.listingId), true);

  const tie = await lok.buyQuantity(dot.tokenId, dust, 2);
  assert.equal(tie.ok, true);
  if (!tie.ok) return;
  assert.deepEqual(tie.fills.map((fill) => fill.listingId), [askBea.listingId]);
  assert.deepEqual(tie.fills.map((fill) => fill.price), ["10"]);
  assert.equal(lok.kekOf(bea.tokenId), "10");
  assert.equal(lok.kekOf(cam.tokenId), "0");
  assert.equal(lok.view(dot.tokenId).listings.some((row) => row.id === askCam.listingId), true);

  const beforeShort = lok.length;
  const kekBefore = lok.kekOf(dot.tokenId);
  const rest = await lok.buyQuantity(dot.tokenId, dust, 50);
  assert.equal(rest.ok, true);
  if (!rest.ok) return;
  assert.equal(rest.short, true);
  assert.deepEqual(rest.fills.map((fill) => fill.listingId), [askCam.listingId, askAda.listingId]);
  assert.deepEqual(rest.fills.map((fill) => fill.price), ["10", "100"]);
  assert.equal(rest.filled, "3");
  assert.equal(lok.length, beforeShort + 2);
  assert.equal(lok.kekOf(dot.tokenId), (BigInt(kekBefore) - 110n).toString());
  assert.equal(lok.kekOf(cam.tokenId), "10");
  assert.equal(lok.kekOf(ada.tokenId), "100");
  assert.equal(lok.itemOf(dot.tokenId, dust), "0");
  assert.equal(lok.view(dot.tokenId).inbox.find((row) => row.tokenId === 1057)?.amount, "9");
  assert.deepEqual(
    lok.view(dot.tokenId).listings.map((row) => row.id),
    [askSelf.listingId],
  );

  const stuck = lok.length;
  const own = await lok.buyQuantity(dot.tokenId, dust, 1);
  assert.equal(own.ok, false);
  if (!own.ok) assert.match(own.error, /ask/i);
  assert.equal(lok.length, stuck);
  assert.equal(lok.kekOf(dot.tokenId), (BigInt(kekBefore) - 110n).toString());
  assert.equal(lok.view(dot.tokenId).listings[0]?.id, askSelf.listingId);

  const buys = lok.explore({ tokenId: dot.tokenId }).events.filter((event) => event.kind === "buy");
  assert.equal(buys.length, 4);
  assert.equal(buys.some((event) => event.kind !== "buy"), false);
});

test("one event appends a journal line and does not rewrite the world log", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-append-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-a", "Ada", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  assert.equal(noteImport(lok, token, "7", "4", "1").ok, true);
  const depositsBeforeTail = LOG_SNAPSHOT_EVERY - 2;
  for (let i = 0; i < depositsBeforeTail; i++) {
    assert.equal(noteDeposit(lok, token, "1", String(i + 2)).ok, true);
  }
  assert.equal(lok.length, LOG_SNAPSHOT_EVERY);
  const snap = readFileSync(lok.logPath);
  const journalBefore = readFileSync(lok.journalPath);
  assert.ok(snap.length > 2000);
  assert.ok(snap.subarray(0, 16).toString("utf8").startsWith('{"journalBytes":'));
  assert.equal(noteDeposit(lok, token, "1", String(depositsBeforeTail + 2)).ok, true);
  const snapAfter = readFileSync(lok.logPath);
  assert.equal(snapAfter.equals(snap), true);
  const journalAfter = readFileSync(lok.journalPath);
  const added = journalAfter.subarray(journalBefore.length).toString("utf8");
  const addedLines = added.split("\n").filter((line) => line.length > 0);
  assert.equal(addedLines.length, 1);
  assert.equal(added.includes("\"characters\""), false);
  assert.ok(added.length < 500);
  assert.ok(snap.length > added.length * 10);
  const line = JSON.parse(addedLines[0]!) as { cmd?: { op?: string; nonce?: string } };
  assert.equal(line.cmd?.op, "depositKek");
  assert.equal(line.cmd?.nonce, String(depositsBeforeTail + 2));
  const kek = (BigInt(depositsBeforeTail) + 1n).toString();
  assert.equal(lok.kekOf(token), kek);
  assert.equal(lok.itemOf(token, "7"), "4");

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.kekOf(token), kek);
  assert.equal(again.itemOf(token, "7"), "4");
  assert.equal(again.length, lok.length);

  const oldDir = mkdtempSync(join(tmpdir(), "lok-old-log-"));
  const parsed = JSON.parse(snap.toString("utf8")) as { journalBytes?: number };
  delete parsed.journalBytes;
  writeFileSync(join(oldDir, "lok-world.json"), JSON.stringify(parsed));
  assert.equal(existsSync(join(oldDir, "lok-world.jsonl")), false);
  const old = LokWorld.open(oldDir, undefined, {});
  assert.equal(old.kekOf(token), depositsBeforeTail.toString());
  assert.equal(old.itemOf(token, "7"), "4");
  assert.equal(old.length, LOG_SNAPSHOT_EVERY);
});

test("one quantity buy cannot fill an unbounded synchronous loop", async () => {
  const lok = world();
  const seller = lok.spawn("char-s", "Seller", 0);
  const buyer = lok.spawn("char-b", "Buyer", 1);
  assert.equal(seller.ok && buyer.ok, true);
  if (!seller.ok || !buyer.ok) return;
  const item = "7";
  const asks = MAX_FILLS_PER_BUY_MESSAGE + BUY_FILL_BATCH;
  assert.equal(noteImport(lok, seller.tokenId, item, String(asks), "1").ok, true);
  assert.equal(noteDeposit(lok, buyer.tokenId, "100000", "1").ok, true);
  const t0 = 1_700_000_000;
  for (let i = 0; i < asks; i++) {
    assert.equal(lok.ask(seller.tokenId, item, "1", "3", t0 + i).ok, true);
  }
  const beforeKek = BigInt(lok.kekOf(buyer.tokenId));
  const beforeSeller = BigInt(lok.kekOf(seller.tokenId));
  const beforeLen = lok.length;
  let interleaved = false;
  const pending = lok.buyQuantity(buyer.tokenId, item, 1_000_000);
  setImmediate(() => {
    interleaved = true;
  });
  const res = await pending;
  assert.equal(interleaved, true);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.fills.length, MAX_FILLS_PER_BUY_MESSAGE);
  assert.equal(res.short, true);
  assert.match(res.stopped ?? "", new RegExp(String(MAX_FILLS_PER_BUY_MESSAGE)));
  assert.match(res.stopped ?? "", /nothing further was charged/i);
  const charged = res.fills.reduce((sum, fill) => sum + BigInt(fill.price || "0"), 0n);
  assert.equal(charged, BigInt(MAX_FILLS_PER_BUY_MESSAGE) * 3n);
  assert.equal(lok.kekOf(buyer.tokenId), (beforeKek - charged).toString());
  assert.equal(lok.kekOf(seller.tokenId), (beforeSeller + charged).toString());
  assert.equal(lok.length, beforeLen + MAX_FILLS_PER_BUY_MESSAGE);
  assert.equal(lok.view(buyer.tokenId).listings.length, asks - MAX_FILLS_PER_BUY_MESSAGE);

  const more = await lok.buyQuantity(buyer.tokenId, item, BUY_FILL_BATCH);
  assert.equal(more.ok, true);
  if (!more.ok) return;
  assert.equal(more.fills.length, BUY_FILL_BATCH);
  assert.equal(more.short, false);
  assert.equal(lok.kekOf(buyer.tokenId), (beforeKek - charged - BigInt(BUY_FILL_BATCH) * 3n).toString());
  assert.equal(lok.view(buyer.tokenId).listings.length, 0);
});
