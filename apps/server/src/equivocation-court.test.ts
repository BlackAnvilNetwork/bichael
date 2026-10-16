/**
 * A local equivocation court slashes only when two signatures reproduce.
 * The slash is the bond already posted for that signer in slashable-bonds.json.
 * No posted bond is not a slash. A vote cannot slash, and a vote cannot refuse.
 * The tick does not wait.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { concatBytes, keccak256 } from "viem";
import { HASH_BYTES, type BatchEnvelope } from "./batch-envelope";
import {
  equivocationSignerId,
  resetEquivocationCourtForTests,
  signerSlash,
  submitEquivocationPair,
  type CourtBallot,
} from "./equivocation-court";
import { observeSignedBatch, resetNotedBatchesForTests } from "./equivocation-watch";
import { submitOnSimTick } from "./order-submit";
import {
  configureEpochLedger,
  notePostedSlashableBond,
  postedSlashableBond,
  postedSlashableBonds,
  resetRootAnchorForTests,
  restartEpochLedger,
  setPostedSlashableBonds,
} from "./root-anchor";

const bls = bls12_381.longSignatures;
const leader = bls.keygen();
const other = bls.keygen();
const leaderKey = new Uint8Array(leader.publicKey.toBytes());
const leaderSecret = new Uint8Array(leader.secretKey);
const otherKey = new Uint8Array(other.publicKey.toBytes());
const otherSecret = new Uint8Array(other.secretKey);

const APPROVE: CourtBallot = { admin: true, multisig: true, social: true };
const REFUSE: CourtBallot = { admin: false, multisig: false, social: false };

function hash(fill: number): Uint8Array {
  const out = new Uint8Array(HASH_BYTES);
  out.fill(fill);
  return out;
}

function envelope(over: Partial<BatchEnvelope> = {}): BatchEnvelope {
  return {
    inputs: Uint8Array.from([1, 2, 3, 4]),
    inputsCommitment: hash(0x11),
    parentRoot: hash(0x21),
    nextRoot: hash(0x31),
    rulesetHash: hash(0x41),
    epoch: 4,
    height: 9,
    worldId: "bellgrave",
    protocolVersion: "1",
    leaderCommitment: hash(0x51),
    gnosisRandomness: hash(0x61),
    epochSeed: hash(0x71),
    rollCommitment: hash(0x81),
    ...over,
  };
}

/** Independent copy of the batch signing preimage. */
function specSigningMessage(batch: BatchEnvelope): Uint8Array {
  const epoch = new Uint8Array(8);
  const height = new Uint8Array(8);
  new DataView(epoch.buffer).setBigUint64(0, BigInt(batch.epoch), false);
  new DataView(height.buffer).setBigUint64(0, BigInt(batch.height), false);
  return new Uint8Array(
    keccak256(
      concatBytes([
        new TextEncoder().encode("bellgrave-batch-v1"),
        batch.inputsCommitment,
        batch.parentRoot,
        batch.nextRoot,
        batch.rulesetHash,
        batch.epochSeed,
        batch.rollCommitment,
        epoch,
        height,
        new TextEncoder().encode(batch.worldId),
        new TextEncoder().encode(batch.protocolVersion),
      ]),
      "bytes",
    ),
  );
}

function sign(batch: BatchEnvelope, secret: Uint8Array): Uint8Array {
  const hashed = bls.hash(specSigningMessage(batch));
  return new Uint8Array(bls.sign(hashed, secret).toBytes());
}

function signed(
  over: Partial<BatchEnvelope> = {},
  secret: Uint8Array = leaderSecret,
): BatchEnvelope {
  const batch = envelope(over);
  return { ...batch, signature: sign(batch, secret) };
}

function reset(): void {
  resetEquivocationCourtForTests();
  resetRootAnchorForTests();
  resetNotedBatchesForTests();
}

const BONDS_NAME = "slashable-bonds.json";

function bondsPath(dir: string): string {
  return join(dir, BONDS_NAME);
}

function bondsText(dir: string): string {
  return readFileSync(bondsPath(dir), "utf8");
}

/** Posted amount in the bond file. A missing row is zero. */
function diskBond(dir: string, id: string): bigint {
  if (!existsSync(bondsPath(dir))) return 0n;
  const parsed = JSON.parse(bondsText(dir)) as { bonds?: { id?: string; amountWei?: string }[] };
  for (const row of parsed.bonds ?? []) {
    if (row.id === id && typeof row.amountWei === "string" && /^\d+$/.test(row.amountWei)) {
      return BigInt(row.amountWei);
    }
  }
  return 0n;
}

function openLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "lok-equivocation-"));
  configureEpochLedger(dir);
  return dir;
}

function closeLedger(dirs: string[]): void {
  reset();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function assertBondFileUnchanged(
  dir: string,
  before: string,
  id: string,
  otherId: string,
  leaderWei: bigint,
  otherWei: bigint,
): void {
  assert.equal(bondsText(dir), before);
  assert.equal(postedSlashableBond(id), leaderWei);
  assert.equal(postedSlashableBond(otherId), otherWei);
  restartEpochLedger();
  assert.equal(postedSlashableBond(id), leaderWei);
  assert.equal(postedSlashableBond(otherId), otherWei);
  assert.equal(bondsText(dir), before);
}

describe("equivocation court", { concurrency: false }, () => {
  test("two signatures at one epoch and height with different roots slash the posted bond", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      const stale = 111n;
      const bond = 123456789n;
      notePostedSlashableBond(id, stale);
      notePostedSlashableBond(otherId, 999n);
      writeFileSync(
        bondsPath(dir),
        JSON.stringify({
          bonds: [
            { id, amountWei: bond.toString() },
            { id: otherId, amountWei: "999" },
          ],
        }) + "\n",
      );
      assert.equal(postedSlashableBond(id), stale);
      assert.equal(diskBond(dir, id), bond);

      const left = signed({ nextRoot: hash(0x31), parentRoot: hash(0x21) });
      const right = signed({ nextRoot: hash(0x32), parentRoot: hash(0x22) });
      assert.equal(left.epoch, right.epoch);
      assert.equal(left.height, right.height);
      assert.notDeepEqual(left.nextRoot, right.nextRoot);

      const result = submitEquivocationPair(left, right, leaderKey);
      assert.equal(result instanceof Promise, false);
      assert.deepEqual(result, { slashed: true, amountWei: bond });
      assert.deepEqual(signerSlash(leaderKey), { slashed: true, amountWei: bond });
      assert.deepEqual(signerSlash(otherKey), { slashed: false });
      assert.equal(postedSlashableBond(id), 0n);
      assert.equal(postedSlashableBond(otherId), 999n);
      assert.equal(postedSlashableBonds(), 999n);
      assert.equal(diskBond(dir, id), 0n);
      assert.equal(diskBond(dir, otherId), 999n);

      const reduced = bondsText(dir);
      const again = submitEquivocationPair(right, left, leaderKey);
      assert.deepEqual(again, { slashed: false });
      assert.equal(bondsText(dir), reduced);
      assert.equal(postedSlashableBond(id), 0n);
      assert.deepEqual(signerSlash(leaderKey), { slashed: true, amountWei: bond });

      restartEpochLedger();
      assert.equal(postedSlashableBond(id), 0n);
      assert.equal(postedSlashableBond(otherId), 999n);
      assert.equal(postedSlashableBonds(), 999n);
      assert.equal(diskBond(dir, id), 0n);
      assert.equal(diskBond(dir, otherId), 999n);
      assert.equal(bondsText(dir), reduced);

      const tick = submitOnSimTick(null, { ok: true, height: left.height, nextRoot: left.nextRoot });
      assert.equal(tick.tickFailed, false);
      assert.equal(tick.status, "provisional");
      assert.equal(bondsText(dir), reduced);
    } finally {
      closeLedger(dirs);
    }
  });

  test("a signer with no posted bond or a zero bond is not slashed", () => {
    reset();
    const dirs: string[] = [];
    try {
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      const left = signed({ nextRoot: hash(0x31) });
      const right = signed({ nextRoot: hash(0x32) });

      const absentDir = openLedger();
      dirs.push(absentDir);
      notePostedSlashableBond(otherId, 999n);
      setPostedSlashableBonds(10n ** 18n);
      assert.equal(postedSlashableBond(id), 0n);
      const absentBefore = bondsText(absentDir);
      assert.deepEqual(submitEquivocationPair(left, right, leaderKey), { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assert.equal(bondsText(absentDir), absentBefore);
      assert.equal(postedSlashableBonds(), 10n ** 18n);
      assert.equal(postedSlashableBond(otherId), 999n);

      reset();
      const zeroDir = mkdtempSync(join(tmpdir(), "lok-equivocation-"));
      dirs.push(zeroDir);
      const zeroBody =
        JSON.stringify({
          bonds: [
            { id, amountWei: "0" },
            { id: otherId, amountWei: "999" },
          ],
        }) + "\n";
      writeFileSync(bondsPath(zeroDir), zeroBody);
      configureEpochLedger(zeroDir);
      assert.equal(postedSlashableBond(id), 0n);
      assert.deepEqual(submitEquivocationPair(left, right, leaderKey), { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assert.equal(bondsText(zeroDir), zeroBody);
      assert.equal(postedSlashableBond(otherId), 999n);
      restartEpochLedger();
      assert.equal(postedSlashableBond(id), 0n);
      assert.equal(bondsText(zeroDir), zeroBody);

      reset();
      const emptyDir = openLedger();
      dirs.push(emptyDir);
      assert.equal(existsSync(bondsPath(emptyDir)), false);
      assert.deepEqual(submitEquivocationPair(left, right, leaderKey), { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assert.equal(existsSync(bondsPath(emptyDir)), false);
    } finally {
      closeLedger(dirs);
    }
  });

  test("the same root is not equivocation", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      notePostedSlashableBond(id, 50n);
      notePostedSlashableBond(otherId, 80n);
      const before = bondsText(dir);
      const root = hash(0x31);
      const left = signed({ nextRoot: root, inputs: Uint8Array.from([1]) });
      const right = signed({ nextRoot: root, inputs: Uint8Array.from([2]) });
      const result = submitEquivocationPair(left, right, leaderKey, APPROVE);
      assert.deepEqual(result, { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assertBondFileUnchanged(dir, before, id, otherId, 50n, 80n);
    } finally {
      closeLedger(dirs);
    }
  });

  test("a different epoch is not equivocation", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      notePostedSlashableBond(id, 50n);
      notePostedSlashableBond(otherId, 80n);
      const before = bondsText(dir);
      const left = signed({ epoch: 4, height: 9, nextRoot: hash(0x31) });
      const right = signed({ epoch: 5, height: 9, nextRoot: hash(0x32) });
      const result = submitEquivocationPair(left, right, leaderKey, APPROVE);
      assert.deepEqual(result, { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assertBondFileUnchanged(dir, before, id, otherId, 50n, 80n);
    } finally {
      closeLedger(dirs);
    }
  });

  test("a different height is not equivocation", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      notePostedSlashableBond(id, 50n);
      notePostedSlashableBond(otherId, 80n);
      const before = bondsText(dir);
      const left = signed({ epoch: 4, height: 9, nextRoot: hash(0x31) });
      const right = signed({ epoch: 4, height: 10, nextRoot: hash(0x32) });
      const result = submitEquivocationPair(left, right, leaderKey, APPROVE);
      assert.deepEqual(result, { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assertBondFileUnchanged(dir, before, id, otherId, 50n, 80n);
    } finally {
      closeLedger(dirs);
    }
  });

  test("a different signer is not equivocation", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      notePostedSlashableBond(id, 50n);
      notePostedSlashableBond(otherId, 80n);
      const before = bondsText(dir);
      const left = signed({ nextRoot: hash(0x31) }, leaderSecret);
      const right = signed({ nextRoot: hash(0x32) }, otherSecret);
      assert.deepEqual(submitEquivocationPair(left, right, leaderKey, APPROVE), { slashed: false });
      assert.deepEqual(submitEquivocationPair(left, right, otherKey, APPROVE), { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assert.deepEqual(signerSlash(otherKey), { slashed: false });
      assert.equal(postedSlashableBonds(), 130n);
      assertBondFileUnchanged(dir, before, id, otherId, 50n, 80n);
    } finally {
      closeLedger(dirs);
    }
  });

  test("an invalid signature is not equivocation", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      notePostedSlashableBond(id, 50n);
      notePostedSlashableBond(otherId, 80n);
      const before = bondsText(dir);
      const left = signed({ nextRoot: hash(0x31) });
      const right = signed({ nextRoot: hash(0x31) });
      right.nextRoot = hash(0x32);
      const swapped = submitEquivocationPair(left, right, leaderKey, APPROVE);
      assert.deepEqual(swapped, { slashed: false });

      const missing = envelope({ nextRoot: hash(0x32) });
      const absent = submitEquivocationPair(left, missing, leaderKey, APPROVE);
      assert.deepEqual(absent, { slashed: false });

      const shortRoot = signed({ nextRoot: new Uint8Array(31) });
      const short = submitEquivocationPair(left, shortRoot, leaderKey, APPROVE);
      assert.deepEqual(short, { slashed: false });

      const notBlsKey = new Uint8Array(32).fill(0x44);
      const unrelated = submitEquivocationPair(
        signed({ nextRoot: hash(0x31) }),
        signed({ nextRoot: hash(0x32) }),
        notBlsKey,
        APPROVE,
      );
      assert.deepEqual(unrelated, { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assert.deepEqual(signerSlash(notBlsKey), { slashed: false });
      assertBondFileUnchanged(dir, before, id, otherId, 50n, 80n);
    } finally {
      closeLedger(dirs);
    }
  });

  test("a vote cannot slash without the pair or refuse a pair that reproduces", async () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      notePostedSlashableBond(id, 42n);
      notePostedSlashableBond(otherId, 999n);
      const before = bondsText(dir);
      const calls: string[] = [];
      const prev = globalThis.fetch;
      globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
        calls.push(typeof init?.body === "string" ? init.body : "");
        return new Response("refused", { status: 500 });
      }) as typeof fetch;
      try {
        const same = signed({ nextRoot: hash(0x31) });
        const voted = submitEquivocationPair(same, same, leaderKey, APPROVE);
        assert.deepEqual(voted, { slashed: false });
        assert.deepEqual(signerSlash(leaderKey), { slashed: false });
        assert.equal(bondsText(dir), before);

        const left = signed({ nextRoot: hash(0x31) });
        const right = signed({ nextRoot: hash(0x32) });
        const refused = submitEquivocationPair(left, right, leaderKey, REFUSE);
        assert.deepEqual(refused, { slashed: true, amountWei: 42n });
        assert.deepEqual(signerSlash(leaderKey), { slashed: true, amountWei: 42n });
        assert.equal(postedSlashableBond(id), 0n);
        assert.equal(postedSlashableBond(otherId), 999n);
        assert.equal(diskBond(dir, id), 0n);
        assert.equal(calls.length, 0);
        const reduced = bondsText(dir);
        restartEpochLedger();
        assert.equal(postedSlashableBond(id), 0n);
        assert.equal(postedSlashableBond(otherId), 999n);
        assert.equal(bondsText(dir), reduced);

        const tick = submitOnSimTick(null, { ok: true, height: 9, nextRoot: hash(0x31) });
        assert.equal(tick.tickFailed, false);
        assert.equal(tick.status, "provisional");
        assert.equal(bondsText(dir), reduced);
      } finally {
        globalThis.fetch = prev;
      }
    } finally {
      closeLedger(dirs);
    }
  });

  test("the server submits a conflicting pair it is holding and zeros that bond file", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      const bond = 77n;
      notePostedSlashableBond(id, 1n);
      notePostedSlashableBond(otherId, 999n);
      writeFileSync(
        bondsPath(dir),
        JSON.stringify({
          bonds: [
            { id, amountWei: bond.toString() },
            { id: otherId, amountWei: "999" },
          ],
        }) + "\n",
      );
      const left = signed({ nextRoot: hash(0x31) });
      const right = signed({ nextRoot: hash(0x32) });
      const calls: string[] = [];
      const prev = globalThis.fetch;
      globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
        calls.push(typeof init?.body === "string" ? init.body : "");
        return new Response("refused", { status: 500 });
      }) as typeof fetch;
      try {
        const held = observeSignedBatch(left, leaderKey);
        assert.equal(held instanceof Promise, false);
        assert.deepEqual(held, { slashed: false });
        assert.equal(diskBond(dir, id), bond);

        const result = observeSignedBatch(right, leaderKey);
        assert.equal(result instanceof Promise, false);
        assert.deepEqual(result, { slashed: true, amountWei: bond });
        assert.equal(postedSlashableBond(id), 0n);
        assert.equal(postedSlashableBond(otherId), 999n);
        assert.equal(diskBond(dir, id), 0n);
        assert.equal(diskBond(dir, otherId), 999n);
        assert.equal(calls.length, 0);

        const reduced = bondsText(dir);
        const third = signed({ nextRoot: hash(0x33) });
        assert.deepEqual(observeSignedBatch(third, leaderKey), { slashed: false });
        assert.equal(bondsText(dir), reduced);
        restartEpochLedger();
        assert.equal(postedSlashableBond(id), 0n);
        assert.equal(diskBond(dir, id), 0n);

        const tick = submitOnSimTick(null, { ok: true, height: left.height, nextRoot: left.nextRoot });
        assert.equal(tick.tickFailed, false);
        assert.equal(tick.status, "provisional");
        assert.equal(bondsText(dir), reduced);
      } finally {
        globalThis.fetch = prev;
      }
    } finally {
      closeLedger(dirs);
    }
  });

  test("a held conflict with no posted bond is not a slash", () => {
    reset();
    const dirs: string[] = [];
    try {
      const id = equivocationSignerId(leaderKey);
      const absentDir = openLedger();
      dirs.push(absentDir);
      notePostedSlashableBond(equivocationSignerId(otherKey), 999n);
      setPostedSlashableBonds(10n ** 18n);
      const absentBefore = bondsText(absentDir);
      const left = signed({ nextRoot: hash(0x41) });
      const right = signed({ nextRoot: hash(0x42) });
      assert.deepEqual(observeSignedBatch(left, leaderKey), { slashed: false });
      const result = observeSignedBatch(right, leaderKey);
      assert.equal(result instanceof Promise, false);
      assert.deepEqual(result, { slashed: false });
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assert.equal(bondsText(absentDir), absentBefore);
      assert.equal(postedSlashableBond(id), 0n);
      assert.equal(postedSlashableBond(equivocationSignerId(otherKey)), 999n);
      assert.equal(postedSlashableBonds(), 10n ** 18n);
    } finally {
      closeLedger(dirs);
    }
  });

  test("the server does not submit a pair that does not conflict", () => {
    reset();
    const dirs: string[] = [];
    try {
      const dir = openLedger();
      dirs.push(dir);
      const id = equivocationSignerId(leaderKey);
      const otherId = equivocationSignerId(otherKey);
      notePostedSlashableBond(id, 50n);
      notePostedSlashableBond(otherId, 80n);
      const before = bondsText(dir);
      const root = hash(0x31);
      observeSignedBatch(signed({ nextRoot: root, inputs: Uint8Array.from([1]) }), leaderKey);
      assert.deepEqual(
        observeSignedBatch(signed({ nextRoot: root, inputs: Uint8Array.from([2]) }), leaderKey),
        { slashed: false },
      );

      resetNotedBatchesForTests();
      resetEquivocationCourtForTests();
      observeSignedBatch(signed({ epoch: 4, nextRoot: hash(0x31) }), leaderKey);
      assert.deepEqual(
        observeSignedBatch(signed({ epoch: 5, nextRoot: hash(0x32) }), leaderKey),
        { slashed: false },
      );

      resetNotedBatchesForTests();
      observeSignedBatch(signed({ height: 9, nextRoot: hash(0x31) }), leaderKey);
      assert.deepEqual(
        observeSignedBatch(signed({ height: 10, nextRoot: hash(0x32) }), leaderKey),
        { slashed: false },
      );

      resetNotedBatchesForTests();
      const badLeft = signed({ nextRoot: hash(0x31) });
      const badRight = signed({ nextRoot: hash(0x31) });
      badRight.nextRoot = hash(0x32);
      observeSignedBatch(badLeft, leaderKey);
      assert.deepEqual(observeSignedBatch(badRight, leaderKey), { slashed: false });

      resetNotedBatchesForTests();
      observeSignedBatch(signed({ nextRoot: hash(0x51) }, leaderSecret), leaderKey);
      assert.deepEqual(
        observeSignedBatch(signed({ nextRoot: hash(0x52) }, otherSecret), otherKey),
        { slashed: false },
      );
      assert.deepEqual(signerSlash(leaderKey), { slashed: false });
      assert.deepEqual(signerSlash(otherKey), { slashed: false });
      assertBondFileUnchanged(dir, before, id, otherId, 50n, 80n);
    } finally {
      closeLedger(dirs);
    }
  });
});
