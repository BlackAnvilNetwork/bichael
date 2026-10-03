import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endClaim, guardedKekMove, guardedWithdraw, prepareClaim, readWithdrawIntents, reconcileWithdrawIntents, reservedOf, withPlayerCharge, withdrawIntentPath, writeWithdrawIntents } from "./kek-guard";
import { LokWorld } from "./lok-world";

test("a withdrawal in flight cannot fund both the vault queue and a transfer", async () => {
  let alice = 1000n;
  let bob = 0n;
  let queued = false;
  let release: (value: { ok: true; id: string; availableAt: number }) => void = () => {};
  const gate = new Promise<{ ok: true; id: string; availableAt: number }>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const withdraw = guardedWithdraw({
    token: "alice",
    amount: "1000",
    balanceOf: () => alice.toString(),
    debit: () => {
      if (alice < 1000n) return { ok: false, error: "short" };
      alice -= 1000n;
      return { ok: true };
    },
    queue: () => {
      entered();
      return gate.then((row) => {
        queued = true;
        return row;
      });
    },
  });

  await started;
  const send = guardedKekMove("alice", () => {
    const free = alice - reservedOf("alice");
    if (free < 1000n) return { ok: false as const, error: "short" };
    alice -= 1000n;
    bob += 1000n;
    return { ok: true as const };
  });

  release({ ok: true, id: "9", availableAt: 1 });
  const [withdrawn, sent] = await Promise.all([withdraw, send]);
  assert.equal(withdrawn.ok, true);
  assert.equal(sent.ok, false);
  assert.equal(queued, true);
  assert.equal(bob, 0n);
  assert.equal(alice, 0n);
  assert.equal(reservedOf("alice"), 0n);
  assert.equal(bob + alice + (queued ? 1000n : 0n) <= 1000n, true);
});

test("a failed queue returns the reserve so the deposit can still be sent", async () => {
  let alice = 1000n;
  let bob = 0n;
  const withdrawn = await guardedWithdraw({
    token: "alice-fail",
    amount: "1000",
    balanceOf: () => alice.toString(),
    debit: () => {
      alice -= 1000n;
      return { ok: true };
    },
    queue: async () => ({ ok: false, error: "reverted" }),
  });
  assert.equal(withdrawn.ok, false);
  assert.equal(alice, 1000n);
  assert.equal(reservedOf("alice-fail"), 0n);
  const sent = await guardedKekMove("alice-fail", () => {
    const free = alice - reservedOf("alice-fail");
    if (free < 1000n) return { ok: false as const };
    alice -= 1000n;
    bob += 1000n;
    return { ok: true as const };
  });
  assert.equal(sent.ok, true);
  assert.equal(bob, 1000n);
  assert.equal(alice, 0n);
});

test("a claim for another token's withdrawal is rejected before a cast", () => {
  let cast = false;
  const foreign = prepareClaim("bob", { tokenId: "alice" }, 1_000);
  if (foreign.ok) cast = true;
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.match(foreign.error, /another character/);
  assert.equal(cast, false);

  const own = prepareClaim("alice", { tokenId: "alice" }, 1_000);
  assert.equal(own.ok, true);
  const overlap = prepareClaim("alice", { tokenId: "alice" }, 1_500);
  assert.equal(overlap.ok, false);
  if (!overlap.ok) assert.match(overlap.error, /already in progress/);
  endClaim("alice");
  const soon = prepareClaim("alice", { tokenId: "alice" }, 2_000);
  assert.equal(soon.ok, false);
  if (!soon.ok) assert.match(soon.error, /Wait/);
});

test("the withdrawal intent is noted before the queue and cleared only after the debit", async () => {
  const events: string[] = [];
  let release: (row: { ok: true; id: string; availableAt: number }) => void = () => {};
  const gate = new Promise<{ ok: true; id: string; availableAt: number }>((resolve) => {
    release = resolve;
  });
  const withdraw = guardedWithdraw({
    token: "intent-token",
    amount: "1000",
    balanceOf: () => "1000",
    noteIntent: (intent) => events.push("note:" + String(intent.id)),
    clearIntent: () => events.push("clear"),
    queue: () => {
      events.push("queue");
      return gate;
    },
    debit: () => {
      events.push("debit");
      return { ok: true };
    },
  });
  await Promise.resolve();
  assert.deepEqual(events, ["note:null", "queue"]);
  release({ ok: true, id: "4", availableAt: 1 });
  const result = await withdraw;
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["note:null", "queue", "note:4", "debit", "clear"]);
  assert.equal(reservedOf("intent-token"), 0n);
});

test("restart after a queued withdrawal debits instead of leaving spendable KEK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kek-intent-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-w", "Wyn", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  lok.noteCustodyInbound({ kind: "depositKek", tokenId: token, nonce: "1", amount: "1000" });
  assert.equal(lok.depositKek(token, "1000", "1").ok, true);
  const path = withdrawIntentPath(dir);
  writeWithdrawIntents(path, [{ token, amount: "1000", id: "4" }]);
  const restarted = LokWorld.open(dir, undefined, {});
  assert.equal(restarted.kekOf(token), "1000");
  const left = await reconcileWithdrawIntents({
    intents: readWithdrawIntents(path),
    existsOnChain: async () => true,
    debit: (id, amount) => restarted.withdrawKek(id, amount),
  });
  writeWithdrawIntents(path, left);
  assert.equal(restarted.kekOf(token), "0");
  assert.deepEqual(readWithdrawIntents(path), []);
  assert.equal(LokWorld.open(dir, undefined, {}).kekOf(token), "0");
});

test("a withdrawal that is not on chain releases the intent and does not debit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kek-release-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-r", "Ryn", 0);
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  const token = spawned.tokenId;
  lok.noteCustodyInbound({ kind: "depositKek", tokenId: token, nonce: "1", amount: "1000" });
  assert.equal(lok.depositKek(token, "1000", "1").ok, true);
  const path = withdrawIntentPath(dir);
  writeWithdrawIntents(path, [
    { token, amount: "1000", id: null },
    { token: token + "-other", amount: "1000", id: "9" },
  ]);
  let debited = 0;
  const left = await reconcileWithdrawIntents({
    intents: readWithdrawIntents(path),
    existsOnChain: async (intent) => (intent.id === "9" ? false : null),
    debit: () => {
      debited += 1;
      return { ok: true };
    },
  });
  assert.equal(debited, 0);
  assert.deepEqual(left, []);
  assert.equal(lok.kekOf(token), "1000");
});

test("an unreadable chain keeps the intent and the spendable KEK", async () => {
  const intents = [{ token: "7", amount: "1000", id: "4" as string | null }];
  let debited = 0;
  const left = await reconcileWithdrawIntents({
    intents,
    existsOnChain: async () => null,
    debit: () => {
      debited += 1;
      return { ok: true };
    },
  });
  assert.equal(debited, 0);
  assert.deepEqual(left, intents);
});

test("a partial intent temp file does not replace the saved list", () => {
  const dir = mkdtempSync(join(tmpdir(), "kek-atomic-"));
  const path = withdrawIntentPath(dir);
  writeWithdrawIntents(path, [{ token: "7", amount: "1000", id: "4" }]);
  writeFileSync(path + ".tmp", "{");
  const rows = readWithdrawIntents(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "4");
});

test("a second overlapping craft does not double-charge", async () => {
  let kek = 2000;
  let mats = 1;
  let items = 0;
  let charges = 0;
  const craft = () =>
    withPlayerCharge(
      "hero",
      () => mats >= 1,
      () => {
        if (mats < 1) return null;
        mats -= 1;
        return () => {
          mats += 1;
        };
      },
      async () => {
        await Promise.resolve();
        if (kek < 1000) return { ok: false as const, error: "short" };
        kek -= 1000;
        charges += 1;
        return { ok: true as const };
      },
      () => {
        items += 1;
      },
    );
  const [first, second] = await Promise.all([craft(), craft()]);
  assert.equal(items, 1);
  assert.equal(charges, 1);
  assert.equal(kek, 1000);
  assert.equal([first, second].filter((row) => row.ok).length, 1);
});

test("a second overlapping buy does not double-charge or learn twice", async () => {
  let kek = 1000;
  const learned: string[] = [];
  let charges = 0;
  const buy = () =>
    withPlayerCharge(
      "hero-buy",
      () => !learned.includes("fire"),
      () => {
        if (learned.includes("fire")) return null;
        learned.push("fire");
        return () => {
          learned.pop();
        };
      },
      async () => {
        await Promise.resolve();
        if (kek < 500) return { ok: false as const, error: "short" };
        kek -= 500;
        charges += 1;
        return { ok: true as const };
      },
      () => {
        if (!learned.includes("fire")) learned.push("fire");
      },
    );
  const [first, second] = await Promise.all([buy(), buy()]);
  assert.equal(learned.length, 1);
  assert.equal(learned[0], "fire");
  assert.equal(charges, 1);
  assert.equal(kek, 500);
  assert.equal([first, second].filter((row) => row.ok).length, 1);
});

test("a failed craft spend rolls the reserved materials back", async () => {
  let mats = 1;
  let kek = 1000;
  const result = await withPlayerCharge(
    "hero-undo",
    () => mats >= 1,
    () => {
      mats -= 1;
      return () => {
        mats += 1;
      };
    },
    async () => ({ ok: false as const, error: "short" }),
    () => {
      kek -= 1000;
    },
  );
  assert.equal(result.ok, false);
  assert.equal(mats, 1);
  assert.equal(kek, 1000);
});

test("an uncertain withdrawal stays reserved until the chain confirms it", async () => {
  let alice = 1000n;
  let cleared = false;
  const pending = await guardedWithdraw({
    token: "alice-uncertain",
    amount: "1000",
    balanceOf: () => alice.toString(),
    debit: () => {
      alice -= 1000n;
      return { ok: true };
    },
    noteIntent: () => {},
    clearIntent: () => {
      cleared = true;
    },
    queue: async () => ({ ok: false, error: "timed out", uncertain: true, id: "4" }),
    confirm: async () => null,
  });
  assert.equal(pending.ok, false);
  assert.equal(cleared, false);
  assert.equal(alice, 1000n);
  assert.equal(reservedOf("alice-uncertain"), 1000n);

  const missed = await guardedWithdraw({
    token: "alice-miss",
    amount: "1000",
    balanceOf: () => "1000",
    debit: () => ({ ok: true }),
    noteIntent: () => {},
    clearIntent: () => {},
    queue: async () => ({ ok: false, error: "reverted", uncertain: true, id: "5" }),
    confirm: async () => false,
  });
  assert.equal(missed.ok, false);
  assert.equal(reservedOf("alice-miss"), 0n);
});
