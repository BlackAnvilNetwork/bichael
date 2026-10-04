import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { LokWorld, MAX_CHARS_PER_WALLET, NAME_RESERVE_MS } from "./lok-world";
import {
  __resetAuthNoncesForTests,
  authMessage,
  issueAuthChallenge,
  verifyAuthLogin,
} from "./wallet-auth";

function noteDeposit(lok: LokWorld, tokenId: string, amount: string, nonce: string) {
  lok.noteCustodyInbound({ kind: "depositKek", tokenId, nonce, amount });
  return lok.depositKek(tokenId, amount, nonce);
}

test("wallet ownership survives restart and orphans stay unowned", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-own-"));
  const a = "0x1111111111111111111111111111111111111111";
  const b = "0x2222222222222222222222222222222222222222";
  const lok = LokWorld.open(dir, undefined, {});
  const alice = lok.spawn("char-a", "Alice", 0, a);
  const bob = lok.spawn("char-b", "Bob", 0, b);
  assert.equal(alice.ok && bob.ok, true);
  if (!alice.ok || !bob.ok) return;
  assert.equal(noteDeposit(lok, alice.tokenId, "5000", "1").ok, true);
  assert.equal(lok.kekOf(alice.tokenId), "5000");

  // Legacy character with no wallet must not be adopted by the next login.
  const bindPath = join(dir, "lok-bind.json");
  const bind = JSON.parse(readFileSync(bindPath, "utf8")) as {
    chars: { charId: string; tokenId: string; name: string; job: number; wallet?: string }[];
  };
  const orphanSpawn = lok.spawn("char-orphan", "Orphan", 0);
  assert.equal(orphanSpawn.ok, true);
  if (!orphanSpawn.ok) return;
  const rebound = JSON.parse(readFileSync(bindPath, "utf8")) as typeof bind;
  const orphan = rebound.chars.find((row) => row.charId === "char-orphan");
  assert.ok(orphan);
  delete orphan.wallet;
  writeFileSync(bindPath, JSON.stringify(rebound));

  const again = LokWorld.open(dir, undefined, {});
  const forB = again.charsForWallet(b);
  assert.equal(forB.length, 1);
  assert.equal(forB[0]?.charId, "char-b");
  assert.equal(
    again.charsForWallet(b).some((row) => row.charId === "char-a"),
    false,
  );
  assert.equal(
    again.charsForWallet(a).some((row) => row.charId === "char-orphan"),
    false,
  );
  assert.equal(
    again.charsForWallet(b).some((row) => row.charId === "char-orphan"),
    false,
  );
  const aliceAgain = again.boundChars().find((row) => row.charId === "char-a");
  assert.ok(aliceAgain);
  assert.equal(again.kekOf(aliceAgain.tokenId), "5000");
  assert.equal(again.charsForWallet(b).every((row) => again.kekOf(row.tokenId) !== "5000"), true);
});

test("name reservations expire and wallets are capped at 8 characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-cap-"));
  const wallet = "0x3333333333333333333333333333333333333333";
  const lok = LokWorld.open(dir, undefined, {});
  for (let i = 0; i < MAX_CHARS_PER_WALLET; i++) {
    const id = "c" + i;
    const claimed = lok.claimName(id, "Hero" + i, wallet);
    assert.equal(claimed.ok, true, String(i));
    const spawned = lok.spawn(id, "Hero" + i, 0, wallet);
    assert.equal(spawned.ok, true, String(i));
  }
  const ninth = lok.claimName("c9", "Hero9", wallet);
  assert.equal(ninth.ok, false);
  if (!ninth.ok) assert.match(ninth.error, /8/);

  const other = "0x4444444444444444444444444444444444444444";
  const reserved = lok.claimName("temp", "TempName", other);
  assert.equal(reserved.ok, true);
  const bindPath = join(dir, "lok-bind.json");
  const bind = JSON.parse(readFileSync(bindPath, "utf8")) as {
    reserved: { charId: string; name: string; wallet?: string; at: number }[];
  };
  const row = bind.reserved.find((r) => r.charId === "temp");
  assert.ok(row);
  row.at = Date.now() - NAME_RESERVE_MS - 1000;
  writeFileSync(bindPath, JSON.stringify(bind));
  const opened = LokWorld.open(dir, undefined, {});
  assert.equal(opened.nameTaken("TempName"), false);
  assert.equal(opened.claimName("fresh", "TempName", other).ok, true);
});

test("setBoundName surfaces a failed claimName", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-rename-"));
  const lok = LokWorld.open(dir, undefined, {});
  assert.equal(lok.spawn("a", "Alpha", 0, "0x5555555555555555555555555555555555555555").ok, true);
  assert.equal(lok.spawn("b", "Beta", 0, "0x6666666666666666666666666666666666666666").ok, true);
  const failed = lok.setBoundName("b", "Alpha");
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /already/i);
});

test("signed login accepts a fresh nonce and rejects reuse or bare address auth", async () => {
  __resetAuthNoncesForTests();
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const challenged = issueAuthChallenge(account.address);
  assert.equal(challenged.ok, true);
  if (!challenged.ok) return;
  const signature = await account.signMessage({ message: challenged.message });
  const ok = await verifyAuthLogin({
    wallet: account.address,
    signature,
    nonce: challenged.nonce,
    message: challenged.message,
  });
  assert.equal(ok.ok, true);

  const reused = await verifyAuthLogin({
    wallet: account.address,
    signature,
    nonce: challenged.nonce,
    message: challenged.message,
  });
  assert.equal(reused.ok, false);

  __resetAuthNoncesForTests();
  const again = issueAuthChallenge(account.address);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  const forged = await verifyAuthLogin({
    wallet: account.address,
    signature: "0x" + "ab".repeat(65),
    nonce: again.nonce,
    message: again.message,
  });
  assert.equal(forged.ok, false);

  const badAddr = issueAuthChallenge("0xmvpnotanaddress000000000000000000000");
  assert.equal(badAddr.ok, false);

  const msg = authMessage({
    wallet: account.address,
    nonce: "abc",
    issuedAt: new Date().toISOString(),
  });
  assert.match(msg, /Bellgrave wants you to sign in/);
  assert.match(msg, /Chain ID: 31337/);
});

test("paid respec debits and clears in one engine event", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-respec-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("r1", "Respeccer", 0, "0x7777777777777777777777777777777777777777");
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  assert.equal(noteDeposit(lok, spawned.tokenId, "15000", "1").ok, true);
  assert.equal(lok.learnAbility(spawned.tokenId, "node_a").ok, true);
  assert.equal(lok.hasAbility(spawned.tokenId, "node_a"), true);
  assert.equal(lok.paidRespecSkills(spawned.tokenId, "20000", ["node_a"]).ok, false);
  assert.equal(lok.kekOf(spawned.tokenId), "15000");
  assert.equal(lok.hasAbility(spawned.tokenId, "node_a"), true);
  assert.equal(lok.paidRespecSkills(spawned.tokenId, "10000", ["node_a"]).ok, true);
  assert.equal(lok.kekOf(spawned.tokenId), "5000");
  assert.equal(lok.hasAbility(spawned.tokenId, "node_a"), false);
});
