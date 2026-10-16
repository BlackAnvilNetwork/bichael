import { planQuantityFills, type AskQuote } from "@bellgrave/protocol";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LOCAL_RULESET_HASH } from "./lok-vault";
import { BUY_FILL_BATCH, LOG_SNAPSHOT_EVERY, LokWorld, MAX_FILLS_PER_BUY_MESSAGE } from "./lok-world";

function noteImport(lok: LokWorld, tokenId: string, itemId: string, amount: string, nonce: string) {
  lok.noteCustodyInbound({ kind: "importItem", tokenId, nonce, itemId, amount });
  return lok.importItem(tokenId, itemId, amount, nonce);
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

test("a list escrows the item, KEK bids are retired, and cancel returns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-auction-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(noteImport(lok, a.tokenId, "7", "1", "1").ok, true);
  const listed = lok.list(a.tokenId, "7", "1");
  assert.equal(listed.ok, true);
  if (!listed.ok || !listed.listingId) return;
  assert.equal(lok.itemOf(a.tokenId, "7"), "0");
  const bid = lok.bid(listed.listingId, b.tokenId, "3");
  assert.equal(bid.ok, false);
  if (!bid.ok) assert.match(bid.error, /retired/i);
  const settled = lok.settle(listed.listingId);
  assert.equal(settled.ok, false);
  if (!settled.ok) assert.match(settled.error, /retired/i);
  assert.equal(lok.itemOf(a.tokenId, "7"), "0");
  assert.equal(lok.kekOf(a.tokenId), "0");
  assert.equal(lok.kekOf(b.tokenId), "0");
  const cancel = lok.cancel(listed.listingId, b.tokenId);
  assert.equal(cancel.ok, false);
  if (!cancel.ok) assert.match(cancel.error, /seller/i);
  assert.equal(lok.cancel(listed.listingId, a.tokenId).ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "1");
  assert.equal(lok.view(a.tokenId).listings.length, 0);

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.itemOf(a.tokenId, "7"), "1");
  assert.equal(again.kekOf(a.tokenId), "0");
  assert.equal(again.length, lok.length);
});

test("goldEarn credits gold, goldSpend debits it, and caps reject over-earn", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-gold-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(lok.goldOf(a.tokenId), "0");
  assert.equal(lok.goldEarn(a.tokenId, "quest", "100", 1).ok, true);
  assert.equal(lok.goldOf(a.tokenId), "100");
  assert.equal(lok.goldSpend(a.tokenId, "trainer", "40").ok, true);
  assert.equal(lok.goldOf(a.tokenId), "60");
  const short = lok.goldSpend(a.tokenId, "craft", "61");
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /insufficient gold/i);
  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.goldOf(a.tokenId), "60");
});

test("KEK spend, withdraw, and send are retired and append nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-spend-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  const len = lok.length;
  for (const res of [
    lok.spendKek(b.tokenId, "4"),
    lok.withdrawKek(a.tokenId, "4"),
    lok.sendKek(a.tokenId, b.tokenId, "2"),
    lok.paidRespecSkills(a.tokenId, "1", ["fire"]),
    lok.depositKek(a.tokenId, "4", "1"),
  ]) {
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /retired/i);
  }
  assert.equal(lok.length, len);
  assert.equal(lok.kekOf(a.tokenId), "0");
  assert.equal(lok.goldOf(a.tokenId), "0");
  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.length, len);
  assert.equal(again.kekOf(a.tokenId), "0");
});

test("an item transfer is stored on both logs with different hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-withdraw-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(noteImport(lok, a.tokenId, "7", "3", "1").ok, true);
  const len = lok.length;
  const over = lok.sendItem(a.tokenId, b.tokenId, "7", "4");
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.error, /insufficient/i);
  assert.equal(lok.length, len);
  assert.equal(lok.sendItem(a.tokenId, b.tokenId, "7", "2").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "1");
  assert.equal(lok.itemOf(b.tokenId, "7"), "2");

  const doc = JSON.parse(lok.logDocument()) as {
    type: string;
    characters: { tokenId: string; entries: { hash: string; input: { type: string } }[] }[];
  };
  assert.equal(doc.type, "characters");
  const logA = doc.characters.find((c) => c.tokenId === a.tokenId);
  const logB = doc.characters.find((c) => c.tokenId === b.tokenId);
  const sendA = logA?.entries.find((e) => e.input.type === "sendItem");
  const sendB = logB?.entries.find((e) => e.input.type === "sendItem");
  assert.ok(sendA && sendB);
  assert.notEqual(sendA.hash, sendB.hash);
  assert.deepEqual(sendA.input, sendB.input);

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.itemOf(a.tokenId, "7"), "1");
  assert.equal(again.itemOf(b.tokenId, "7"), "2");
  assert.equal(again.length, lok.length);
});

test("import nonce replay fails and two recorded nonces credit twice", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(lok.importItem(a.tokenId, "7", "4", "1").ok, false);
  assert.equal(noteImport(lok, a.tokenId, "7", "4", "1").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "4");
  assert.equal(noteImport(lok, a.tokenId, "7", "4", "1").ok, false);
  assert.equal(lok.itemOf(a.tokenId, "7"), "4");
  assert.equal(noteImport(lok, a.tokenId, "8", "6", "2").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "8"), "6");
  assert.equal(lok.inboundAppliedOf(a.tokenId), 2);
  assert.equal(lok.kekOf(a.tokenId), "0");
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

  // Bone Ring (313) is bonecraft L1 — default skill rank 1 is enough.
  assert.equal(lok.craft(a.tokenId, "313", "1").ok, true);
  assert.equal(lok.craftOf(a.tokenId, "313"), "1");
  assert.equal(lok.itemOf(a.tokenId, "313"), "0");
  assert.equal(lok.kekOf(a.tokenId), "0");
  // Scale Harness (9) is leathercraft L40 — refused without CraftSkill.
  const underleveled = lok.craft(a.tokenId, "9", "1");
  assert.equal(underleveled.ok, false);
  if (!underleveled.ok) assert.match(underleveled.error, /craft skill|too low|BadCraftLevel/i);
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
  assert.equal(lok.inboundAppliedOf(a.tokenId), 0);
  assert.equal(lok.kill(a.tokenId, "1").ok, true);
  assert.equal(lok.lootDrop(a.tokenId, "7", "3", "1").ok, true);
  assert.equal(lok.dropOf(a.tokenId, "7"), "3");
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
  const before = lok.length;
  const badDrop = lok.lootDrop(a.tokenId, "0", "1", "1");
  assert.equal(badDrop.ok, false);
  assert.equal(lok.length, before);
  const closedDrop = lok.itemDrop(a.tokenId, "7", "1");
  assert.equal(closedDrop.ok, false);
  if (!closedDrop.ok) assert.match(closedDrop.error, /cannot mint/i);
  assert.equal(lok.length, before);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.levelOf(a.tokenId), 2);
  assert.equal(again.hasAbility(a.tokenId, "fire"), true);
  assert.equal(again.craftOf(a.tokenId, "313"), "1");
  assert.equal(again.craftOf(a.tokenId, "9"), "0");
  assert.equal(again.harvestOf(a.tokenId, "dustgrain"), "2");
  assert.equal(again.dropOf(a.tokenId, "7"), "3");
  assert.equal(again.itemOf(a.tokenId, "7"), "2");
  assert.equal(again.kekOf(a.tokenId), "0");
  assert.equal(again.inboundAppliedOf(a.tokenId), 0);
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
  assert.equal(noteImport(lok, b.tokenId, "1057", "9", "1").ok, true);
  assert.equal(lok.sendItem(b.tokenId, a.tokenId, "1057", "4").ok, true);
  assert.equal(lok.learnAbility(a.tokenId, "fire").ok, true);
  assert.equal(lok.harvest(b.tokenId, "dustgrain", "13").ok, true);
  for (const id of ["a0", "a1", "a2", "a3"]) {
    assert.equal(lok.learnAbility(a.tokenId, id).ok, true);
  }
  const beforeReject = lok.explore({ tokenId: a.tokenId }).total;
  assert.equal(lok.sendItem(a.tokenId, b.tokenId, "1057", "99").ok, false);
  assert.equal(lok.explore({ tokenId: a.tokenId }).total, beforeReject);

  const yours = lok.explore({ tokenId: a.tokenId });
  assert.ok(yours.events.every((event) => event.text.includes("Ada") || event.character === "Ada" || event.kind === "sendItem"));
  assert.equal(yours.events.some((event) => event.kind === "harvest"), false);
  assert.equal(yours.events.some((event) => event.kind === "depositKek"), false);
  assert.equal(yours.events.filter((event) => event.kind === "sendItem").length, 1);
  assert.ok(yours.events[0]!.seq >= yours.events[yours.events.length - 1]!.seq);
  assert.equal(yours.events[0]!.kind, "learnAbility");
  assert.match(yours.events[0]!.text, /a3/);

  const worldRows = lok.explore({ tokenId: null });
  assert.equal(worldRows.events.filter((event) => event.kind === "sendItem").length, 1);
  assert.equal(worldRows.events.some((event) => event.kind === "harvest"), true);
  assert.equal(worldRows.events.some((event) => event.kind === "importItem"), true);
  assert.ok(worldRows.total > yours.total);

  const leather = lok.explore({ tokenId: null, q: "leather" });
  assert.equal(leather.events.length, 1);
  assert.equal(leather.events[0]!.kind, "importItem");
  assert.match(leather.events[0]!.text, /Leather Vest/);

  const byKind = lok.explore({ tokenId: a.tokenId, q: "SENDITEM" });
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

test("order book keeps asks until chain fill, cancel, or reclaim", () => {
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
  const t0 = 1_700_000_000;
  const ask100 = lok.ask(a.tokenId, dust, "1", "100", t0);
  const ask1000 = lok.ask(b.tokenId, dust, "1", "1000", t0 + 1);
  const ask2000 = lok.ask(c.tokenId, dust, "1", "2000", t0 + 2);
  assert.equal(ask100.ok && ask1000.ok && ask2000.ok, true);
  if (!ask100.ok || !ask1000.ok || !ask2000.ok) return;

  const own = lok.fill(a.tokenId, dust, "100");
  assert.equal(own.ok, false);
  if (!own.ok) assert.match(own.error, /retired/i);
  const bought = lok.buy(d.tokenId, dust);
  assert.equal(bought.ok, false);
  if (!bought.ok) assert.match(bought.error, /retired/i);
  assert.equal(lok.kekOf(a.tokenId), "0");
  assert.equal(lok.goldOf(d.tokenId), "0");
  assert.equal(lok.view(a.tokenId).listings.some((row) => row.id === ask100.listingId), true);

  const txHash = "0x" + "ab".repeat(32);
  const fillKey = txHash + "-0";
  lok.noteChainFill({
    listingId: ask100.listingId!,
    buyerTokenId: d.tokenId,
    priceWei: "100",
    fillKey,
    itemId: dust,
    amount: "1",
    sellerTokenId: a.tokenId,
    txHash,
    logIndex: "0",
  });
  const filled = lok.chainFill(ask100.listingId!, d.tokenId, "100", fillKey);
  assert.equal(filled.ok, true);
  assert.equal(lok.kekOf(a.tokenId), "0");
  assert.equal(lok.kekOf(d.tokenId), "0");
  assert.equal(lok.goldOf(a.tokenId), "0");
  assert.equal(lok.itemOf(d.tokenId, dust), "0");
  assert.equal(lok.view(d.tokenId).inbox.find((row) => row.tokenId === 1057)?.amount, "1");
  const left = lok.view(d.tokenId).listings.map((row) => row.minPrice).sort();
  assert.deepEqual(left, ["1000", "2000"]);

  assert.equal(lok.sendInbox(d.tokenId, b.tokenId, dust, "1").ok, false);
  assert.equal(lok.takeInbox(d.tokenId, dust, "1").ok, true);
  assert.equal(lok.view(d.tokenId).inbox.length, 0);
  assert.equal(lok.itemOf(d.tokenId, dust), "0");

  assert.equal(lok.cancelAsk(ask1000.listingId!, b.tokenId).ok, true);
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
  assert.equal(noteImport(opened, sender.tokenId, "8", "5", "2").ok, true);
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
  assert.equal(opened.sendItem(sender.tokenId, fakeId.tokenId, "8", "2").ok, true);
  assert.equal(opened.itemOf(fake.tokenId, "8"), "2");
  assert.equal(opened.itemOf(real.tokenId, "8"), "0");
  assert.equal(opened.itemOf(sender.tokenId, "8"), "3");
  assert.equal(opened.kekOf(sender.tokenId), "0");
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

test("KEK buy and fill are retired and leave every ask open", () => {
  const lok = world();
  const seller = lok.spawn("char-s", "Sue", 0);
  const buyer = lok.spawn("char-u", "Uma", 1);
  assert.equal(seller.ok && buyer.ok, true);
  if (!seller.ok || !buyer.ok) return;
  assert.equal(noteImport(lok, seller.tokenId, "7", "2", "1").ok, true);
  assert.equal(lok.ask(seller.tokenId, "7", "1", "100", 10).ok, true);
  assert.equal(lok.ask(seller.tokenId, "7", "1", "100", 11).ok, true);
  const len = lok.length;
  const bought = lok.buy(buyer.tokenId, "7");
  assert.equal(bought.ok, false);
  if (!bought.ok) assert.match(bought.error, /retired/i);
  const over = lok.fill(buyer.tokenId, "7", "4000");
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.error, /retired/i);
  assert.equal(lok.length, len);
  assert.equal(lok.view(buyer.tokenId).listings.length, 2);
  assert.equal(lok.kekOf(buyer.tokenId), "0");
  assert.equal(lok.goldOf(buyer.tokenId), "0");
  assert.equal(lok.itemOf(seller.tokenId, "7"), "0");
});

test("gold paid respec debits gold and KEK custody stays at zero", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(lok.goldEarn(a.tokenId, "quest", "12000", 1).ok, true);
  assert.equal(lok.learnAbility(a.tokenId, "fire").ok, true);
  assert.equal(lok.vaultClaim(a.tokenId), "0");
  assert.equal(lok.sendKek(a.tokenId, b.tokenId, "4000").ok, false);
  assert.equal(lok.withdrawKek(a.tokenId, "1").ok, false);
  assert.equal(lok.spendKek(a.tokenId, "1000").ok, false);
  assert.equal(lok.paidRespecSkills(a.tokenId, "7000", ["fire"]).ok, false);
  assert.equal(lok.goldOf(a.tokenId), "12000");
  assert.equal(lok.hasAbility(a.tokenId, "fire"), true);
  assert.equal(lok.goldPaidRespec(a.tokenId, "7000", ["fire"]).ok, true);
  assert.equal(lok.goldOf(a.tokenId), "5000");
  assert.equal(lok.hasAbility(a.tokenId, "fire"), false);
  assert.equal(lok.kekOf(a.tokenId), "0");
  assert.equal(lok.vaultClaim(a.tokenId), "0");
  assert.equal(lok.sunkKek(a.tokenId), "0");
});

test("loot drop logs a counter without minting spendable items", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const before = lok.length;
  assert.equal(lok.kill(a.tokenId, "1").ok, true);
  const dropped = lok.lootDrop(a.tokenId, "7", "9", "1");
  assert.equal(dropped.ok, true);
  assert.equal(lok.length, before + 2);
  assert.equal(lok.dropOf(a.tokenId, "7"), "9");
  assert.equal(lok.itemOf(a.tokenId, "7"), "0");
  assert.equal(lok.importFromBag(a.tokenId, "7", "2").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
  assert.equal(lok.inboundAppliedOf(a.tokenId), 0);
});

test("a drafted checkpoint stamps the pinned ruleset and lists exports", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const bare = lok.checkpointFor(a.tokenId, "0");
  assert.equal(bare.ok, true);
  if (!bare.ok) return;
  assert.equal(bare.body.rulesetHash, LOCAL_RULESET_HASH);
  assert.deepEqual(bare.body.exports, []);
  assert.equal(noteImport(lok, a.tokenId, "7", "2", "1").ok, true);
  assert.equal(lok.exportItem(a.tokenId, "7", "2").ok, true);
  const drafted = lok.checkpointFor(a.tokenId, "0");
  assert.equal(drafted.ok, true);
  if (!drafted.ok) return;
  assert.equal(drafted.body.rulesetHash, LOCAL_RULESET_HASH);
  assert.deepEqual(drafted.body.exports, [{ itemId: "7", amount: 2 }]);
});

test("a new item drop append cannot mint an arbitrary credit", () => {
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
  assert.equal(lok.dropOf(a.tokenId, "7"), "0");
});

test("a pre-#206 log with ItemDrop entries refuses to open", () => {
  const fixture = readFileSync(
    new URL("../../../contracts/lok-log/engine/tests/fixtures/pre-206-item-drop-world.json", import.meta.url),
    "utf8",
  );
  const dir = mkdtempSync(join(tmpdir(), "lok-historical-"));
  writeFileSync(join(dir, "lok-world.json"), fixture);
  assert.throws(() => LokWorld.open(dir, undefined, {}), /cannot mint/i);
});

test("bag import does not consume the chain inbound nonce", () => {
  const lok = world();
  const a = lok.spawn("char-a", "Ada", 0);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(lok.importFromBag(a.tokenId, "7", "2").ok, true);
  assert.equal(lok.importFromBag(a.tokenId, "8", "1").ok, true);
  assert.equal(lok.inboundAppliedOf(a.tokenId), 0);
  assert.equal(lok.itemOf(a.tokenId, "7"), "2");
  assert.equal(noteImport(lok, a.tokenId, "9", "1", "1").ok, true);
  assert.equal(lok.itemOf(a.tokenId, "9"), "1");
  assert.equal(lok.inboundAppliedOf(a.tokenId), 1);
  assert.equal(lok.kekOf(a.tokenId), "0");
});

test("quantity plan still prices asks, and a log buy fills none of them", async () => {
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

  const len = lok.length;
  const rejected = await lok.buyQuantity(dot.tokenId, dust, 0);
  assert.equal(rejected.ok, false);
  const first = await lok.buyQuantity(dot.tokenId, dust, 3);
  assert.equal(first.ok, false);
  if (!first.ok) assert.match(first.error, /retired/i);
  assert.equal(lok.length, len);
  assert.equal(lok.view(dot.tokenId).listings.length, 5);
  assert.equal(lok.kekOf(dot.tokenId), "0");
  assert.equal(lok.goldOf(dot.tokenId), "0");
  assert.equal(lok.view(dot.tokenId).inbox.length, 0);
  assert.equal(lok.explore({ tokenId: dot.tokenId }).events.some((event) => event.kind === "buy"), false);
});

test("one event appends a journal line and does not rewrite the world log", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-append-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-a", "Ada", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  assert.equal(noteImport(lok, token, "7", "4", "1").ok, true);
  const importsBeforeTail = LOG_SNAPSHOT_EVERY - 2;
  for (let i = 0; i < importsBeforeTail; i++) {
    assert.equal(noteImport(lok, token, "8", "1", String(i + 2)).ok, true);
  }
  assert.equal(lok.length, LOG_SNAPSHOT_EVERY);
  const snap = readFileSync(lok.logPath);
  const journalBefore = readFileSync(lok.journalPath);
  assert.ok(snap.length > 2000);
  assert.ok(snap.subarray(0, 16).toString("utf8").startsWith('{"journalBytes":'));
  assert.equal(noteImport(lok, token, "8", "1", String(importsBeforeTail + 2)).ok, true);
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
  assert.equal(line.cmd?.op, "importItem");
  assert.equal(line.cmd?.nonce, String(importsBeforeTail + 2));
  const stacked = (BigInt(importsBeforeTail) + 1n).toString();
  assert.equal(lok.itemOf(token, "8"), stacked);
  assert.equal(lok.itemOf(token, "7"), "4");
  assert.equal(lok.kekOf(token), "0");

  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.itemOf(token, "8"), stacked);
  assert.equal(again.itemOf(token, "7"), "4");
  assert.equal(again.length, lok.length);

  const oldDir = mkdtempSync(join(tmpdir(), "lok-old-log-"));
  const parsed = JSON.parse(snap.toString("utf8")) as { journalBytes?: number };
  delete parsed.journalBytes;
  writeFileSync(join(oldDir, "lok-world.json"), JSON.stringify(parsed));
  assert.equal(existsSync(join(oldDir, "lok-world.jsonl")), false);
  const old = LokWorld.open(oldDir, undefined, {});
  assert.equal(old.itemOf(token, "8"), importsBeforeTail.toString());
  assert.equal(old.itemOf(token, "7"), "4");
  assert.equal(old.length, LOG_SNAPSHOT_EVERY);
});

test("a retired quantity buy does not fill an open book", async () => {
  const lok = world();
  const seller = lok.spawn("char-s", "Seller", 0);
  const buyer = lok.spawn("char-b", "Buyer", 1);
  assert.equal(seller.ok && buyer.ok, true);
  if (!seller.ok || !buyer.ok) return;
  const item = "7";
  const asks = MAX_FILLS_PER_BUY_MESSAGE + BUY_FILL_BATCH;
  assert.equal(noteImport(lok, seller.tokenId, item, String(asks), "1").ok, true);
  const t0 = 1_700_000_000;
  for (let i = 0; i < asks; i++) {
    assert.equal(lok.ask(seller.tokenId, item, "1", "3", t0 + i).ok, true);
  }
  const beforeLen = lok.length;
  const res = await lok.buyQuantity(buyer.tokenId, item, 1_000_000);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /retired/i);
  assert.equal(lok.length, beforeLen);
  assert.equal(lok.kekOf(buyer.tokenId), "0");
  assert.equal(lok.goldOf(buyer.tokenId), "0");
  assert.equal(lok.view(buyer.tokenId).listings.length, asks);
  assert.equal(lok.view(buyer.tokenId).inbox.length, 0);
});
