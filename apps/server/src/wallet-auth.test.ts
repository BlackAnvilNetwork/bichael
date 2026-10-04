import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { LokWorld, MAX_CHARS_PER_WALLET, NAME_RESERVE_MS } from "./lok-world";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  __clearPendingChallengesForTests,
  __expirePendingForTests,
  __resetAuthNoncesForTests,
  AUTH_HELLO_LIMIT,
  AUTH_PENDING_GLOBAL,
  AUTH_PENDING_PER_CONNECTION,
  AUTH_PENDING_PER_IP,
  authAllowlist,
  authMessage,
  authVerifyClient,
  clientAddress,
  dropAuthConnection,
  isLoopbackIp,
  issueAuthChallenge,
  resolveAuthOrigin,
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
  assert.match(msg, /^localhost wants you to sign in with your Ethereum account:/);
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
  assert.equal(lok.paidRespecSkills(spawned.tokenId, "10000", []).ok, false);
  assert.equal(lok.kekOf(spawned.tokenId), "15000");
  assert.equal(lok.hasAbility(spawned.tokenId, "node_a"), true);
  assert.equal(lok.paidRespecSkills(spawned.tokenId, "10000", ["node_a"]).ok, true);
  assert.equal(lok.kekOf(spawned.tokenId), "5000");
  assert.equal(lok.hasAbility(spawned.tokenId, "node_a"), false);
});

test("one nonce cannot authorize two in-flight logins", async () => {
  __resetAuthNoncesForTests();
  const account = privateKeyToAccount(generatePrivateKey());
  const challenged = issueAuthChallenge(account.address, { connectionId: "conn-a", domain: "localhost" });
  assert.equal(challenged.ok, true);
  if (!challenged.ok) return;
  assert.match(challenged.message, /^localhost wants you to sign in with your Ethereum account:/);
  assert.match(challenged.message, /Domain: localhost/);
  assert.match(challenged.message, /Expiration Time: /);
  const signature = await account.signMessage({ message: challenged.message });
  const args = {
    wallet: account.address,
    signature,
    nonce: challenged.nonce,
    message: challenged.message,
    connectionId: "conn-a",
  };
  const [first, second] = await Promise.all([verifyAuthLogin(args), verifyAuthLogin(args)]);
  const wins = [first, second].filter((row) => row.ok);
  assert.equal(wins.length, 1);
});

test("login rejects a different connection, a different message, and an expired nonce", async () => {
  __resetAuthNoncesForTests();
  const account = privateKeyToAccount(generatePrivateKey());
  const challenged = issueAuthChallenge(account.address, { connectionId: "conn-a", domain: "bellgrave.local" });
  assert.equal(challenged.ok, true);
  if (!challenged.ok) return;
  const signature = await account.signMessage({ message: challenged.message });
  const otherConn = await verifyAuthLogin({
    wallet: account.address,
    signature,
    nonce: challenged.nonce,
    message: challenged.message,
    connectionId: "conn-b",
  });
  assert.equal(otherConn.ok, false);

  assert.match(challenged.message, /^bellgrave\.local wants you to sign in with your Ethereum account:/);
  const loosely = challenged.message + "\nExtra: still has the nonce";
  assert.equal(loosely.includes(challenged.nonce), true);
  assert.equal(loosely.toLowerCase().includes(account.address.toLowerCase()), true);
  const otherText = await verifyAuthLogin({
    wallet: account.address,
    signature,
    nonce: challenged.nonce,
    message: loosely,
    connectionId: "conn-a",
  });
  assert.equal(otherText.ok, false);

  const ok = await verifyAuthLogin({
    wallet: account.address,
    signature,
    nonce: challenged.nonce,
    message: challenged.message,
    connectionId: "conn-a",
  });
  assert.equal(ok.ok, true);

  __resetAuthNoncesForTests();
  const expiring = issueAuthChallenge(account.address, { connectionId: "conn-a" });
  assert.equal(expiring.ok, true);
  if (!expiring.ok) return;
  __expirePendingForTests(expiring.nonce);
  const signed = await account.signMessage({ message: expiring.message });
  const expired = await verifyAuthLogin({
    wallet: account.address,
    signature: signed,
    nonce: expiring.nonce,
    message: expiring.message,
    connectionId: "conn-a",
  });
  assert.equal(expired.ok, false);
});

test("auth challenges are capped per connection and globally, and hellos are rate limited", () => {
  __resetAuthNoncesForTests();
  const wallet = "0x8888888888888888888888888888888888888888";
  for (let i = 0; i < AUTH_PENDING_PER_CONNECTION; i++) {
    const issued = issueAuthChallenge(wallet, { connectionId: "capped" });
    assert.equal(issued.ok, true, String(i));
  }
  const overflow = issueAuthChallenge(wallet, { connectionId: "capped" });
  assert.equal(overflow.ok, false);

  __resetAuthNoncesForTests();
  let issuedCount = 0;
  for (let c = 0; c < AUTH_PENDING_GLOBAL / AUTH_PENDING_PER_CONNECTION; c++) {
    for (let i = 0; i < AUTH_PENDING_PER_CONNECTION; i++) {
      const issued = issueAuthChallenge(wallet, { connectionId: "g" + c, clientIp: "198.51.100." + (c + 1) });
      assert.equal(issued.ok, true);
      issuedCount += 1;
    }
  }
  assert.equal(issuedCount, AUTH_PENDING_GLOBAL);
  const globalOverflow = issueAuthChallenge(wallet, { connectionId: "g-extra", clientIp: "198.51.100.250" });
  assert.equal(globalOverflow.ok, false);

  __resetAuthNoncesForTests();
  for (let i = 0; i < AUTH_HELLO_LIMIT; i++) {
    __clearPendingChallengesForTests();
    const issued = issueAuthChallenge(wallet, { connectionId: "rate" });
    assert.equal(issued.ok, true, String(i));
  }
  __clearPendingChallengesForTests();
  const limited = issueAuthChallenge(wallet, { connectionId: "rate" });
  assert.equal(limited.ok, false);
});

test("bindWallet does not replace a wallet that is already set", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-bind-"));
  const first = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const second = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-own", "Owner", 0);
  assert.equal(spawned.ok, true);
  lok.bindWallet("char-own", first);
  lok.bindWallet("char-own", second);
  assert.equal(lok.charsForWallet(first).length, 1);
  assert.equal(lok.charsForWallet(second).length, 0);
  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.charsForWallet(first).some((row) => row.charId === "char-own"), true);
  assert.equal(again.charsForWallet(second).length, 0);
});

function upgradeOnce(port: number, origin?: string): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "open" | "rejected") => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const ws = new WebSocket("ws://127.0.0.1:" + port, origin ? { origin } : undefined);
    ws.once("open", () => {
      ws.close();
      finish("open");
    });
    ws.once("unexpected-response", () => finish("rejected"));
    ws.once("error", () => finish("rejected"));
  });
}

test("a non-loopback address cannot fill the global challenge cap", () => {
  __resetAuthNoncesForTests();
  const wallet = "0x9999999999999999999999999999999999999999";
  const ip = "203.0.113.8";
  let held = 0;
  for (let c = 0; c < 30; c++) {
    for (let i = 0; i < AUTH_PENDING_PER_CONNECTION; i++) {
      const issued = issueAuthChallenge(wallet, { connectionId: "rip" + c, clientIp: ip });
      if (issued.ok) held += 1;
    }
  }
  assert.ok(held <= AUTH_PENDING_PER_IP);
  assert.ok(held < AUTH_PENDING_GLOBAL);
  assert.equal(held, AUTH_PENDING_PER_IP);
  const outsider = issueAuthChallenge(wallet, { connectionId: "other-ip", clientIp: "203.0.113.9" });
  assert.equal(outsider.ok, true);

  __resetAuthNoncesForTests();
  let loopHeld = 0;
  const loops = AUTH_PENDING_GLOBAL / AUTH_PENDING_PER_CONNECTION + 2;
  for (let c = 0; c < loops; c++) {
    for (let i = 0; i < AUTH_PENDING_PER_CONNECTION; i++) {
      const issued = issueAuthChallenge(wallet, { connectionId: "loop" + c, clientIp: "127.0.0.1" });
      assert.equal(issued.ok, true);
      loopHeld += 1;
    }
  }
  assert.ok(loopHeld > AUTH_PENDING_GLOBAL);
  const afterLoop = issueAuthChallenge(wallet, { connectionId: "still-remote", clientIp: "203.0.113.50" });
  assert.equal(afterLoop.ok, true);

  __resetAuthNoncesForTests();
  for (let c = 0; c < 200; c++) {
    const issued = issueAuthChallenge(wallet, { connectionId: "lb" + c, clientIp: "::1" });
    assert.equal(issued.ok, true, String(c));
  }
  const afterTracker = issueAuthChallenge(wallet, { connectionId: "after-loop", clientIp: "203.0.113.77" });
  assert.equal(afterTracker.ok, true);
});

test("a closed connection frees its pending challenges", () => {
  __resetAuthNoncesForTests();
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ip = "203.0.113.40";
  for (let i = 0; i < AUTH_PENDING_PER_CONNECTION; i++) {
    assert.equal(issueAuthChallenge(wallet, { connectionId: "stay", clientIp: ip }).ok, true);
  }
  assert.equal(issueAuthChallenge(wallet, { connectionId: "stay", clientIp: ip }).ok, false);
  dropAuthConnection("stay");
  assert.equal(issueAuthChallenge(wallet, { connectionId: "stay", clientIp: ip }).ok, true);

  __resetAuthNoncesForTests();
  const slots = AUTH_PENDING_GLOBAL / AUTH_PENDING_PER_CONNECTION;
  for (let c = 0; c < slots; c++) {
    for (let i = 0; i < AUTH_PENDING_PER_CONNECTION; i++) {
      const issued = issueAuthChallenge(wallet, {
        connectionId: "fill" + c,
        clientIp: "198.51.100." + (c + 1),
      });
      assert.equal(issued.ok, true);
    }
  }
  assert.equal(
    issueAuthChallenge(wallet, { connectionId: "blocked", clientIp: "198.51.100.250" }).ok,
    false,
  );
  dropAuthConnection("fill0");
  assert.equal(
    issueAuthChallenge(wallet, { connectionId: "freed", clientIp: "198.51.100.250" }).ok,
    true,
  );
});

test("x-forwarded-for is ignored unless the trusted proxy setting is on", () => {
  const req = {
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.2" },
    socket: { remoteAddress: "::ffff:127.0.0.1" },
  };
  const local = clientAddress(req, {});
  assert.equal(local, "127.0.0.1");
  assert.equal(isLoopbackIp(local), true);
  assert.equal(clientAddress(req, { AUTH_TRUST_PROXY: "1" }), "203.0.113.9");
  assert.equal(clientAddress(req, { AUTH_TRUST_PROXY: "true" }), "203.0.113.9");
});

test("a missing or foreign Origin is rejected on upgrade", async () => {
  const allow = authAllowlist({ AUTH_ORIGINS: "https://play.example" });
  assert.deepEqual(allow, [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://play.example",
  ]);
  const fromOrigin = resolveAuthOrigin("http://127.0.0.1:5173", allow);
  assert.equal(fromOrigin.ok, true);
  if (!fromOrigin.ok) return;
  assert.equal(fromOrigin.domain, "127.0.0.1:5173");
  assert.equal(resolveAuthOrigin(undefined, allow).ok, false);
  assert.equal(resolveAuthOrigin("https://evil.example", allow).ok, false);
  assert.equal(resolveAuthOrigin("http://localhost:5173/phish", allow).ok, false);

  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info: { origin: string }) => authVerifyClient(info, { AUTH_ORIGINS: "https://play.example" }),
  });
  if (!wss.address()) {
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  }
  const port = (wss.address() as AddressInfo).port;
  try {
    assert.equal(await upgradeOnce(port), "rejected");
    assert.equal(await upgradeOnce(port, "https://evil.example"), "rejected");
    assert.equal(await upgradeOnce(port, "http://localhost:5173"), "open");
    assert.equal(await upgradeOnce(port, "http://127.0.0.1:5173"), "open");
    assert.equal(await upgradeOnce(port, "https://play.example"), "open");
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  __resetAuthNoncesForTests();
  const wallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const challenged = issueAuthChallenge(wallet, {
    connectionId: "siwe",
    domain: fromOrigin.domain,
    clientIp: "203.0.113.15",
  });
  assert.equal(challenged.ok, true);
  if (!challenged.ok) return;
  assert.equal(
    challenged.message.startsWith("127.0.0.1:5173 wants you to sign in with your Ethereum account:\n"),
    true,
  );
  const swapped =
    "evil.example wants you to sign in with your Ethereum account:\n" +
    challenged.message.slice(challenged.message.indexOf("\n") + 1);
  assert.equal(swapped.includes(challenged.nonce), true);
  assert.notEqual(swapped, challenged.message);
  const rejected = await verifyAuthLogin({
    wallet,
    signature: "0x" + "11".repeat(65),
    nonce: challenged.nonce,
    message: swapped,
    connectionId: "siwe",
  });
  assert.equal(rejected.ok, false);
});
