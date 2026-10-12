/**
 * H5: one unprocessable chain event must not freeze deposits for every player.
 * Every test runs in its own temp dir. None touches apps/server/data.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DATA_DIR_LOCK_FILE } from "./data-dir-lock";
import { applyChainInbound, ITEM_IMPORT_TOPIC, KEK_DEPOSIT_TOPIC, scanChainInbounds, type ChainInbound } from "./lok-chain";
import { DepositQuarantine, depositQuarantinePath, loadDepositQuarantine } from "./lok-deposit-quarantine";
import { replayQuarantinedInbound } from "./lok-deposit-replay";
import { LokWorld } from "./lok-world";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const word = (n: number | bigint) => "0x" + BigInt(n).toString(16).padStart(64, "0");

function depositLog(tokenId: number, nonce: number, amount: number, block: number, index = 0) {
  return {
    topics: [KEK_DEPOSIT_TOPIC, word(tokenId), word(nonce)],
    data: word(amount) + "000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    blockNumber: "0x" + block.toString(16),
    logIndex: "0x" + index.toString(16),
    transactionHash: "0x" + "ab".repeat(32),
  };
}

function rpc(logs: unknown[], head = 0x20) {
  return async (method: string) => {
    if (method === "eth_blockNumber") return "0x" + head.toString(16);
    if (method === "eth_getLogs") return logs;
    throw new Error(method);
  };
}

/** A log with tokens 1 and 2 spawned, scanning through the real engine. */
function world(dir: string) {
  const lok = LokWorld.open(dir, undefined, {});
  assert.equal(lok.spawn("char-a", "Ada", 0).ok, true);
  assert.equal(lok.spawn("char-b", "Bea", 1).ok, true);
  return lok;
}

function scan(lok: LokWorld, quarantine: DepositQuarantine, logs: unknown[], cursor = 0n, alerts: string[] = []) {
  return scanChainInbounds({
    cursor,
    checkpoint: "0xabc",
    rpcCall: rpc(logs),
    expectedNonce: (tokenId) => lok.inboundAppliedOf(tokenId) + 1,
    apply: (inbound: ChainInbound) => applyChainInbound(lok, inbound),
    quarantine,
    alert: (m) => alerts.push(m),
  });
}

test("a deposit to an unspawned (factory-direct) token is quarantined and the cursor moves past it", async () => {
  const dir = tmp("lok-q-unknown-");
  const lok = world(dir);
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  const alerts: string[] = [];
  // Token 9 was never spawned on the log. Token 2's deposit lands after it.
  const logs = [depositLog(9, 1, 500, 0x10), depositLog(2, 1, 40, 0x11)];
  const next = await scan(lok, q, logs, 0n, alerts);
  assert.equal(next.cursor, 0x20n - 2n + 1n, "cursor advances past the safe head");
  assert.equal(next.halted, undefined);
  assert.deepEqual(next.quarantined, ["0x10:0x0"]);
  assert.equal(lok.kekOf("2"), "40", "everyone else's deposits still credit");
  const saved = loadDepositQuarantine(depositQuarantinePath(dir));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.reason, "unknown-token");
  assert.equal(saved[0]!.tokenId, "9");
  assert.equal(saved[0]!.inbound?.kind, "depositKek");
  assert.match(alerts.join("\n"), /ALERT chain inbound quarantined id=0x10:0x0 reason=unknown-token/);
  assert.match(alerts.join("\n"), /lok:replay-quarantined 0x10:0x0/);

  // A rescan of the same range neither re-alerts nor double-credits.
  const again: string[] = [];
  const second = await scan(lok, q, logs, 0n, again);
  assert.deepEqual(second.quarantined, []);
  assert.equal(again.length, 0);
  assert.equal(lok.kekOf("2"), "40");
  assert.equal(loadDepositQuarantine(depositQuarantinePath(dir)).length, 1);
});

test("an event with the deposit topic that does not decode is quarantined as bad-shape", async () => {
  const dir = tmp("lok-q-shape-");
  const lok = world(dir);
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  const bad = { ...depositLog(1, 1, 5, 0x10), data: "0x1234" };
  const zero = depositLog(1, 0, 5, 0x10, 1);
  const next = await scan(lok, q, [bad, zero, depositLog(1, 1, 7, 0x11)]);
  assert.equal(next.halted, undefined);
  assert.deepEqual(q.list().map((e) => e.reason), ["bad-shape", "bad-shape"]);
  assert.equal(q.list()[0]!.inbound, null);
  assert.equal(lok.kekOf("1"), "7");
});

test("a nonce gap halts the cursor at that block and is not quarantined", async () => {
  const dir = tmp("lok-q-gap-");
  const lok = world(dir);
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  // Token 1 expects nonce 1; the chain shows nonce 2 (nonce 1 was missed).
  const next = await scan(lok, q, [depositLog(2, 1, 3, 0x0f), depositLog(1, 2, 5, 0x10), depositLog(2, 2, 4, 0x12)]);
  assert.equal(next.cursor, 0x10n, "halted at the gap's block");
  assert.equal(next.halted?.kind, "gap");
  assert.equal(q.list().length, 0);
  assert.equal(existsSync(depositQuarantinePath(dir)), false);
  assert.equal(lok.kekOf("1"), "0");
  assert.equal(lok.kekOf("2"), "3", "events before the gap applied; events after wait for the retry");
});

test("a nonce below the next expected one is swallowed as already applied", async () => {
  const dir = tmp("lok-q-replay-");
  const lok = world(dir);
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  const first = await scan(lok, q, [depositLog(1, 1, 5, 0x10)]);
  assert.equal(first.halted, undefined);
  const again = await scan(lok, q, [depositLog(1, 1, 5, 0x10), depositLog(1, 2, 6, 0x11)]);
  assert.equal(again.halted, undefined);
  assert.equal(q.list().length, 0);
  assert.equal(lok.kekOf("1"), "11");
});

test("a transient RPC error halts without moving the cursor or quarantining", async () => {
  const dir = tmp("lok-q-rpc-");
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  let calls = 0;
  await assert.rejects(
    scanChainInbounds({
      cursor: 7n,
      checkpoint: "0xabc",
      rpcCall: async (method) => {
        calls++;
        if (method === "eth_blockNumber") return "0x20";
        throw new Error("fetch failed: ECONNREFUSED");
      },
      apply: () => ({ ok: true }),
      quarantine: q,
      alert: () => {},
    }),
    /ECONNREFUSED/,
  );
  assert.equal(calls, 2);
  assert.equal(q.list().length, 0);
});

test("an unclassified engine refusal halts instead of being quarantined", async () => {
  const dir = tmp("lok-q-other-");
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  const next = await scanChainInbounds({
    cursor: 0n,
    checkpoint: "0xabc",
    rpcCall: rpc([depositLog(1, 1, 5, 0x10)]),
    expectedNonce: () => 1,
    apply: () => ({ ok: false, error: "lok journal write failed: EBUSY" }),
    quarantine: q,
    alert: () => {},
  });
  assert.equal(next.cursor, 0x10n);
  assert.equal(next.halted?.kind, "other");
  assert.equal(q.list().length, 0);
});

test("a later nonce for a token whose only missing nonce is quarantined is parked, not a halt", async () => {
  const dir = tmp("lok-q-behind-");
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  const applied: string[] = [];
  const next = await scanChainInbounds({
    cursor: 0n,
    checkpoint: "0xabc",
    rpcCall: rpc([depositLog(3, 1, 5, 0x10), depositLog(3, 2, 6, 0x11), depositLog(4, 1, 1, 0x12)]),
    expectedNonce: () => 1,
    apply: (inbound) => {
      applied.push(inbound.tokenId + ":" + inbound.nonce);
      if (inbound.tokenId === "3" && inbound.nonce === "1") return { ok: false, error: "amount must be greater than zero" };
      if (inbound.tokenId === "3") return { ok: false, error: "inbound nonce is out of order" };
      return { ok: true };
    },
    quarantine: q,
    alert: () => {},
  });
  assert.equal(next.halted, undefined);
  assert.deepEqual(applied, ["3:1", "3:2", "4:1"]);
  assert.deepEqual(q.list().map((e) => e.nonce + ":" + e.reason), ["1:unprocessable", "2:behind-quarantined-nonce"]);
});

test("a corrupt quarantine file refuses to load instead of forgetting custody KEK", () => {
  const dir = tmp("lok-q-corrupt-");
  const path = depositQuarantinePath(dir);
  writeFileSync(path, '{"entries":[{"id":"0x10:0x0"');
  assert.throws(() => new DepositQuarantine(path), /could not be read/);
  writeFileSync(path, '{"nope":1}');
  assert.throws(() => new DepositQuarantine(path), /not a quarantine list/);
});

test("replay-quarantined credits once after the cause is fixed and cannot double-credit", async () => {
  const dir = tmp("lok-q-replay-cmd-");
  const lok = world(dir);
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  // Token 3 does not exist yet: its deposit is quarantined.
  const logs = [depositLog(3, 1, 250, 0x10)];
  await scan(lok, q, logs);
  assert.equal(q.list().length, 1);

  // Still unspawned: the replay is refused and the entry kept.
  const early = replayQuarantinedInbound({ dataDir: dir, id: "0x10:0x0", open: () => lok });
  assert.equal(early.ok, false);
  if (!early.ok) assert.match(early.error, /not spawned/);
  assert.equal(loadDepositQuarantine(depositQuarantinePath(dir)).length, 1);

  // Fix the cause: the character now exists on the log as token 3.
  const c = lok.spawn("char-c", "Cid", 2);
  assert.ok(c.ok && c.tokenId === "3");
  const ok = replayQuarantinedInbound({ dataDir: dir, id: "0x10:0x0", open: () => lok });
  assert.equal(ok.ok, true);
  assert.equal(lok.kekOf("3"), "250");
  assert.equal(loadDepositQuarantine(depositQuarantinePath(dir)).length, 0, "removed on success");

  // Second run: gone from quarantine, nothing credited.
  const twice = replayQuarantinedInbound({ dataDir: dir, id: "0x10:0x0", open: () => lok });
  assert.equal(twice.ok, false);
  if (!twice.ok) assert.match(twice.error, /No quarantined inbound/);
  assert.equal(lok.kekOf("3"), "250");

  // Crash between credit and removal: the entry is back but the engine refuses the nonce.
  const fresh = new DepositQuarantine(depositQuarantinePath(dir));
  const stale = await scanChainInbounds({
    cursor: 0n,
    checkpoint: "0xabc",
    rpcCall: rpc(logs),
    expectedNonce: () => 1,
    apply: () => ({ ok: false, error: "character is not spawned" }),
    quarantine: fresh,
    alert: () => {},
  });
  assert.deepEqual(stale.quarantined, ["0x10:0x0"]);
  const crashed = replayQuarantinedInbound({ dataDir: dir, id: "0x10:0x0", open: () => lok });
  assert.equal(crashed.ok, false);
  if (!crashed.ok) assert.match(crashed.error, /already consumed/);
  assert.equal(lok.kekOf("3"), "250");

  // And the watcher's own rescan treats it as already applied.
  const rescan = await scan(lok, new DepositQuarantine(join(dir, "other-q.json")), logs);
  assert.equal(rescan.halted, undefined);
  assert.deepEqual(rescan.quarantined, []);
  assert.equal(lok.kekOf("3"), "250");
});

test("replay-quarantined refuses while the server holds the data-dir lock and writes nothing", () => {
  const dir = tmp("lok-q-locked-");
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  q.add({
    id: "0x10:0x0",
    reason: "unknown-token",
    error: "character is not spawned",
    inbound: { kind: "depositKek", tokenId: "1", nonce: "1", amount: "5" },
    tokenId: "1",
    nonce: "1",
    blockNumber: "0x10",
    logIndex: "0x0",
    transactionHash: "",
    topics: [],
    data: "",
    quarantinedAt: "2026-10-11T00:00:00.000Z",
  });
  writeFileSync(
    join(dir, DATA_DIR_LOCK_FILE),
    JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: "2026-10-11T00:00:00.000Z" }),
  );
  let opened = false;
  const res = replayQuarantinedInbound({
    dataDir: dir,
    id: "0x10:0x0",
    open: () => {
      opened = true;
      throw new Error("must not open");
    },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /Stop it first/);
  assert.equal(opened, false);
  assert.equal(existsSync(join(dir, "lok-world.json")), false);
  assert.equal(loadDepositQuarantine(depositQuarantinePath(dir)).length, 1);
  void readFileSync;
});

test("replay-quarantined replays the lowest quarantined nonce for a token first", () => {
  const dir = tmp("lok-q-order-");
  const q = new DepositQuarantine(depositQuarantinePath(dir));
  const base = {
    reason: "unprocessable" as const,
    error: "x",
    tokenId: "1",
    blockNumber: "0x10",
    transactionHash: "",
    topics: [],
    data: "",
    quarantinedAt: "2026-10-11T00:00:00.000Z",
  };
  q.add({ ...base, id: "0x10:0x0", logIndex: "0x0", nonce: "1", inbound: { kind: "depositKek", tokenId: "1", nonce: "1", amount: "5" } });
  q.add({ ...base, id: "0x10:0x1", logIndex: "0x1", nonce: "2", inbound: { kind: "depositKek", tokenId: "1", nonce: "2", amount: "5" } });
  const res = replayQuarantinedInbound({ dataDir: dir, id: "0x10:0x1", open: () => { throw new Error("must not open"); } });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /lower nonce/);
  void ITEM_IMPORT_TOPIC;
});
