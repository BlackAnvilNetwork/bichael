/**
 * Regression tests for the 2026-10-05 self-audit (AUDIT-2026-10-05.md).
 * Every test runs in its own temp dir. None touches apps/server/data.
 */
import { MAX_QUANTITY_FILLS, planQuantityFills, type AskQuote } from "@bellgrave/protocol";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDataDirLock, DATA_DIR_LOCK_FILE, dataDirLockedByOther, readDataDirLock } from "./data-dir-lock";
import { guardedWithdraw } from "./kek-guard";
import { LokWorld, MAX_FILLS_PER_BUY_MESSAGE } from "./lok-world";
import { loadVaultPending, queueKekWithdrawal, vaultPendingPath, type CastFn, type LogCheckpoint } from "./lok-vault";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function deposit(lok: LokWorld, tokenId: string, amount: string, nonce: string) {
  lok.noteCustodyInbound({ kind: "depositKek", tokenId, nonce, amount });
  return lok.depositKek(tokenId, amount, nonce);
}

/** Two characters, a deposit, and a send: four journal lines after the first snapshot. */
function seeded(dir: string) {
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) throw new Error("spawn failed");
  assert.equal(deposit(lok, a.tokenId, "10", "1").ok, true);
  assert.equal(lok.sendKek(a.tokenId, b.tokenId, "1").ok, true);
  return { lok, a: a.tokenId, b: b.tokenId };
}

// ---------------------------------------------------------------- data-dir lock

test("a second live process cannot open the same lok data dir", () => {
  const dir = tmp("lok-lock-live-");
  // The parent of the test process is alive and is not us.
  writeFileSync(
    join(dir, DATA_DIR_LOCK_FILE),
    JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: "2026-10-05T00:00:00.000Z" }),
  );
  assert.equal(dataDirLockedByOther(dir)?.pid, process.ppid);
  assert.throws(() => LokWorld.open(dir, undefined, {}), /already open by live pid/);
  assert.equal(existsSync(join(dir, "lok-world.json")), false, "a refused open must not write the log");
  assert.equal(existsSync(join(dir, "lok-bind.json")), false, "a refused open must not write the bind file");
  // Explicit operator override still works.
  const shared = LokWorld.open(dir, undefined, { LOK_ALLOW_SHARED_DATA_DIR: "1" });
  assert.equal(shared.length, 0);
});

test("a stale lock from a dead pid is taken over and the same process may reopen", () => {
  const dir = tmp("lok-lock-stale-");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(typeof dead === "number" && dead > 0);
  writeFileSync(join(dir, DATA_DIR_LOCK_FILE), JSON.stringify({ pid: dead, host: hostname(), startedAt: "x" }));
  const lok = LokWorld.open(dir, undefined, {});
  assert.equal(readDataDirLock(dir)?.pid, process.pid);
  assert.equal(dataDirLockedByOther(dir), null);
  const again = LokWorld.open(dir, undefined, {});
  assert.equal(again.length, lok.length);
  acquireDataDirLock(dir); // idempotent for the holder
});

test("a lock held on another host is refused", () => {
  const dir = tmp("lok-lock-host-");
  writeFileSync(join(dir, DATA_DIR_LOCK_FILE), JSON.stringify({ pid: process.pid, host: "some-other-host", startedAt: "x" }));
  assert.throws(() => LokWorld.open(dir, undefined, {}), /locked by pid/);
});

// ---------------------------------------------------------------- journal tail and seq

test("a torn final journal line is cut off so the next append does not corrupt the journal", () => {
  const dir = tmp("lok-torn-");
  const { lok, a, b } = seeded(dir);
  const len = lok.length;
  const journal = join(dir, "lok-world.jsonl");
  appendFileSync(journal, '{"seq":' + (len + 1) + ',"cmd":{"op":"sendKek","from":"' + a);
  const reopened = LokWorld.open(dir, undefined, {});
  assert.equal(reopened.length, len);
  assert.equal(readFileSync(journal, "utf8").endsWith("\n"), true);
  assert.equal(readdirSync(dir).some((name) => name.startsWith("lok-world.jsonl.torn-")), true);
  // Before the fix this append was concatenated onto the fragment and the next open threw.
  assert.equal(reopened.sendKek(a, b, "1").ok, true);
  const third = LokWorld.open(dir, undefined, {});
  assert.equal(third.length, len + 1);
  assert.equal(third.kekOf(b), "2");
});

test("a complete final journal record without its newline is kept and terminated", () => {
  const dir = tmp("lok-nonl-");
  const { lok, a, b } = seeded(dir);
  const len = lok.length;
  const journal = join(dir, "lok-world.jsonl");
  const text = readFileSync(journal, "utf8");
  writeFileSync(journal, text.slice(0, -1));
  const reopened = LokWorld.open(dir, undefined, {});
  assert.equal(reopened.length, len);
  assert.equal(reopened.kekOf(b), "1");
  assert.equal(reopened.sendKek(a, b, "1").ok, true);
  const third = LokWorld.open(dir, undefined, {});
  assert.equal(third.length, len + 1);
  assert.equal(third.kekOf(b), "2");
});

test("a duplicated journal line is refused instead of applied twice", () => {
  const dir = tmp("lok-dup-");
  const { b } = seeded(dir);
  const journal = join(dir, "lok-world.jsonl");
  const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean);
  const last = lines[lines.length - 1]!;
  assert.match(last, /sendKek/);
  appendFileSync(journal, last + "\n");
  // Without the seq check the engine accepts the second sendKek and b ends with 2 KEK.
  assert.throws(() => LokWorld.open(dir, undefined, {}), /seq mismatch/);
  void b;
});

// ---------------------------------------------------------------- bind reconcile

test("bind rows dropped by reconcile are backed up before lok-bind.json is rewritten", () => {
  const dir = tmp("lok-bind-drop-");
  seeded(dir);
  const bindPath = join(dir, "lok-bind.json");
  const bind = JSON.parse(readFileSync(bindPath, "utf8")) as { chars: { charId: string; tokenId: string; name: string; job: number; wallet?: string }[] };
  bind.chars.push({ charId: "c_lost", tokenId: "999", name: "Lost", job: 0, wallet: "0x" + "ab".repeat(20) });
  writeFileSync(bindPath, JSON.stringify(bind));
  LokWorld.open(dir, undefined, {});
  const after = JSON.parse(readFileSync(bindPath, "utf8")) as { chars: { charId: string }[] };
  assert.equal(after.chars.some((row) => row.charId === "c_lost"), false);
  const backup = readdirSync(dir).find((name) => name.startsWith("lok-bind.dropped-"));
  assert.ok(backup, "a dropped-row backup is written");
  const saved = JSON.parse(readFileSync(join(dir, backup!), "utf8")) as { chars: { charId: string; wallet?: string }[] };
  assert.equal(saved.chars[0]?.charId, "c_lost");
  assert.equal(saved.chars[0]?.wallet, "0x" + "ab".repeat(20));
});

// ---------------------------------------------------------------- quantity-buy plan

test("the UI quantity plan uses the server's per-message fill cap", () => {
  assert.equal(MAX_QUANTITY_FILLS, MAX_FILLS_PER_BUY_MESSAGE);
  const asks: AskQuote[] = Array.from({ length: MAX_QUANTITY_FILLS + 5 }, (_, i) => ({
    id: String(i + 1),
    seller: "seller",
    itemId: 7,
    amount: "1",
    minPrice: "3",
    listedAt: 1000 + i,
    book: true,
  }));
  const plan = planQuantityFills(asks, "buyer", 7, 1000);
  assert.equal(plan.fills.length, MAX_QUANTITY_FILLS);
  assert.equal(plan.filled, String(MAX_QUANTITY_FILLS));
  assert.equal(plan.short, true);
  assert.equal(plan.capped, true);
  const small = planQuantityFills(asks, "buyer", 7, 3);
  assert.equal(small.fills.length, 3);
  assert.equal(small.capped, undefined);
});

// ---------------------------------------------------------------- vault pending + withdrawal

test("a corrupt lok-vault-pending.json refuses to load instead of dropping queued ops", () => {
  const dir = tmp("lok-pending-bad-");
  const path = vaultPendingPath(dir);
  writeFileSync(path, '{"ops":[{"id":"sink-1","kind":"sink"');
  assert.throws(() => loadVaultPending(path), /could not be read/);
  assert.equal(readFileSync(path, "utf8"), '{"ops":[{"id":"sink-1","kind":"sink"', "file is left as found");
  writeFileSync(path, '{"nope":true}');
  assert.throws(() => loadVaultPending(path), /not a vault pending queue/);
});

const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SERVER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ENV = {
  LOK_CHAIN_RPC: "http://127.0.0.1:8545",
  LOK_CHECKPOINT: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  LOK_VAULT: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
  LOK_KEK: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  LOK_NFT: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  LOK_FACTORY: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  LOK_RULESETS: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  LOK_OWNER_KEY: "owner-key",
  LOK_ROTATOR_KEY: "rotator-key",
};

function fakeCast(accepted: boolean, order: string[]): CastFn {
  let next = 4n;
  return async (args) => {
    const cmd = args[0] ?? "";
    const sig = args[2] ?? "";
    if (cmd === "wallet" && args[1] === "address") return { stdout: SERVER + "\n", stderr: "" };
    if (cmd === "block") return { stdout: "1000\n", stderr: "" };
    if (cmd === "chain-id") return { stdout: "31337\n", stderr: "" };
    if (cmd === "keccak" || cmd === "abi-encode") return { stdout: "0x" + "11".repeat(32) + "\n", stderr: "" };
    if (cmd === "wallet" && args[1] === "sign") return { stdout: "0x" + "ab".repeat(65) + "\n", stderr: "" };
    if (cmd === "call") {
      if (sig.startsWith("isAccepted")) {
        order.push("isAccepted");
        return { stdout: (accepted ? "true" : "false") + "\n", stderr: "" };
      }
      if (sig.startsWith("ownerOf")) return { stdout: PLAYER + "\n", stderr: "" };
      if (sig.startsWith("isActiveSigner")) return { stdout: "true\n", stderr: "" };
      if (sig.startsWith("stateRoot")) return { stdout: "0x" + "33".repeat(32) + "\n", stderr: "" };
      if (sig.startsWith("logIndex") || sig.startsWith("version")) return { stdout: "0\n", stderr: "" };
      if (sig.startsWith("nextWithdrawalId")) return { stdout: next.toString() + "\n", stderr: "" };
      if (sig.startsWith("withdrawals")) return { stdout: PLAYER + " 10 1 1000\n", stderr: "" };
    }
    if (cmd === "send" && sig.startsWith("checkpoint")) {
      order.push("send");
      next += 1n;
      return { stdout: "0xhash\n", stderr: "" };
    }
    throw new Error("unexpected " + cmd + " " + sig);
  };
}

function body(amount: string): LogCheckpoint {
  return {
    player: PLAYER,
    prevRoot: "0x" + "33".repeat(32),
    newRoot: "0x" + "44".repeat(32),
    fromIndex: "0",
    toIndex: "1",
    logHash: "0x" + "55".repeat(32),
    summary: "0",
    inboundConsumed: "0",
    kekOut: amount,
  };
}

test("an unaccepted ruleset refuses the withdrawal before the log debit is appended", async () => {
  const order: string[] = [];
  const res = await queueKekWithdrawal("6", "1000", ENV, fakeCast(false, order), {
    debit: () => {
      order.push("debit");
      return { ok: true };
    },
    prepare: () => {
      order.push("prepare");
      return body("1000");
    },
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /ruleset is not accepted/);
  assert.deepEqual(order, ["isAccepted"], "no debit, no draft, no send");
});

test("the withdrawal debit runs after the ruleset check and before the checkpoint is drafted", async () => {
  const order: string[] = [];
  const res = await queueKekWithdrawal("6", "1000", ENV, fakeCast(true, order), {
    debit: () => {
      order.push("debit");
      return { ok: true };
    },
    prepare: () => {
      order.push("prepare");
      return body("1000");
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(order, ["isAccepted", "debit", "prepare", "send"]);

  const refused: string[] = [];
  const short = await queueKekWithdrawal("6", "1000", ENV, fakeCast(true, refused), {
    debit: () => {
      refused.push("debit");
      return { ok: false, error: "insufficient KEK" };
    },
    prepare: () => {
      refused.push("prepare");
      return body("1000");
    },
  });
  assert.equal(short.ok, false);
  if (!short.ok) assert.match(short.error, /insufficient/);
  assert.deepEqual(refused, ["isAccepted", "debit"]);
});

test("a withdrawal the vault does not show does not claim the KEK was returned", async () => {
  const res = await guardedWithdraw({
    token: "audit-miss",
    amount: "5",
    balanceOf: () => "5",
    debit: () => ({ ok: true }),
    noteIntent: () => {},
    clearIntent: () => {},
    queue: async () => ({ ok: false, error: "receipt timed out", uncertain: true, id: "9" }),
    confirm: async () => false,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.doesNotMatch(res.error, /was returned/);
    assert.match(res.error, /debit was kept/);
  }
});
