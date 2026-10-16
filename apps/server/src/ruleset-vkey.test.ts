import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { concatBytes, keccak256, toBytes } from "viem";
import {
  acceptBatch,
  commitInputs,
  commitRoll,
  type BatchEnvelope,
  type BatchExpect,
} from "./batch-envelope";
import { fallbackEpochSeed } from "./fallback-epoch-seed";
import {
  LOCAL_RULESET_HASH,
  LOCAL_RULESET_RECORD,
  LOCAL_RULESET_WASM_SHA256,
  LOCAL_SP1_VERIFYING_KEY,
} from "./lok-vault";
import {
  RULESET_MIN_DELAY_MS,
  resetRulesetPinForTests,
  rulesetRecord,
  setRulesetClockForTests,
  setVerifyingKey,
} from "./ruleset-record";

const bls = bls12_381.longSignatures;
const leader = bls.keygen();
const leaderKey = new Uint8Array(leader.publicKey.toBytes());
const leaderSecret = new Uint8Array(leader.secretKey);
const ROLL_BYTES = Uint8Array.from([9, 8, 7, 6]);
const OTHER_KEY = `0x${"ab".repeat(32)}`;
/** Empty world. Replay of the pinned wasm is 32 zero bytes. */
const EMPTY_LOG = new TextEncoder().encode('{"type":"characters","characters":[]}');
const EMPTY_REPLAY = new Uint8Array(32);

let now = 1_700_000_000_000;

beforeEach(() => {
  resetRulesetPinForTests();
  now = 1_700_000_000_000;
  setRulesetClockForTests(() => now);
});

function hash(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function signed(proofVerifyingKey?: string): BatchEnvelope {
  const inputs = proofVerifyingKey === undefined ? Uint8Array.from([1, 2, 3, 4]) : EMPTY_LOG;
  const leaderCommitment = hash(0x44);
  const gnosisRandomness = hash(0x55);
  const inputsCommitment = commitInputs(inputs);
  const epochSeed = fallbackEpochSeed(leaderCommitment, gnosisRandomness);
  const batch: BatchEnvelope = {
    inputs,
    inputsCommitment,
    parentRoot: hash(0x11),
    nextRoot: hash(0x22),
    rulesetHash: hash(0x33),
    epoch: 2,
    height: 5,
    worldId: "bellgrave",
    protocolVersion: "1",
    leaderCommitment,
    gnosisRandomness,
    epochSeed,
    rollCommitment: commitRoll(inputsCommitment, epochSeed, ROLL_BYTES),
    proofVerifyingKey,
    proofResult: proofVerifyingKey === undefined ? undefined : EMPTY_REPLAY,
  };
  const epoch = new Uint8Array(8);
  const height = new Uint8Array(8);
  new DataView(epoch.buffer).setBigUint64(0, BigInt(batch.epoch), false);
  new DataView(height.buffer).setBigUint64(0, BigInt(batch.height), false);
  const message = new Uint8Array(
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
  batch.signature = new Uint8Array(bls.sign(bls.hash(message), leaderSecret).toBytes());
  return batch;
}

function decide(batch: BatchEnvelope) {
  const expected: BatchExpect = {
    epoch: batch.epoch,
    height: batch.height,
    worldId: batch.worldId,
    protocolVersion: batch.protocolVersion,
    rollBytes: ROLL_BYTES,
  };
  return acceptBatch(batch, batch.parentRoot, batch.rulesetHash, batch.nextRoot, expected, leaderKey);
}

test("the verifying key is pinned beside the wasm digest", () => {
  assert.equal(LOCAL_RULESET_WASM_SHA256, "4d2610aa110a9f6bb163934d29a6ca7410b98530d59a700d8cd1b66cc5804178");
  assert.equal(LOCAL_RULESET_RECORD.wasmSha256, LOCAL_RULESET_WASM_SHA256);
  assert.equal(LOCAL_RULESET_RECORD.verifyingKey, LOCAL_SP1_VERIFYING_KEY);
  assert.match(LOCAL_SP1_VERIFYING_KEY, /^0x[0-9a-f]{64}$/);
  assert.equal(LOCAL_RULESET_HASH, keccak256(toBytes(LOCAL_RULESET_WASM_SHA256)));
  assert.notEqual(OTHER_KEY, LOCAL_SP1_VERIFYING_KEY);
});

test("an immediate setter does not change the verifying key", () => {
  setVerifyingKey(OTHER_KEY);
  assert.equal(rulesetRecord().verifyingKey, LOCAL_SP1_VERIFYING_KEY);
  assert.equal(rulesetRecord().wasmSha256, LOCAL_RULESET_WASM_SHA256);
  now += RULESET_MIN_DELAY_MS - 1;
  assert.equal(rulesetRecord().verifyingKey, LOCAL_SP1_VERIFYING_KEY);
  assert.equal(rulesetRecord().wasmSha256, LOCAL_RULESET_WASM_SHA256);
});

test("a verifying-key change applies only after the one-day ruleset timelock", () => {
  setVerifyingKey(OTHER_KEY);
  now += RULESET_MIN_DELAY_MS;
  const record = rulesetRecord();
  assert.equal(record.verifyingKey, OTHER_KEY);
  assert.equal(record.wasmSha256, LOCAL_RULESET_WASM_SHA256);
  assert.equal(LOCAL_RULESET_WASM_SHA256, "4d2610aa110a9f6bb163934d29a6ca7410b98530d59a700d8cd1b66cc5804178");
});

test("a value that is not a verifying key does not schedule a change", () => {
  setVerifyingKey("not-a-key");
  now += RULESET_MIN_DELAY_MS;
  assert.equal(rulesetRecord().verifyingKey, LOCAL_SP1_VERIFYING_KEY);
});

test("a proof under any other key is not a batch of this world", () => {
  assert.deepEqual(decide(signed()), { ok: true, epoch: 2, height: 5 });
  assert.deepEqual(decide(signed(LOCAL_SP1_VERIFYING_KEY)), { ok: true, epoch: 2, height: 5 });
  assert.deepEqual(decide(signed(OTHER_KEY)), { ok: false, error: "foreign_verifying_key" });

  setVerifyingKey(OTHER_KEY);
  assert.deepEqual(decide(signed(OTHER_KEY)), { ok: false, error: "foreign_verifying_key" });
  assert.deepEqual(decide(signed(LOCAL_SP1_VERIFYING_KEY)), { ok: true, epoch: 2, height: 5 });

  now += RULESET_MIN_DELAY_MS;
  assert.deepEqual(decide(signed(OTHER_KEY)), { ok: true, epoch: 2, height: 5 });
  assert.deepEqual(decide(signed(LOCAL_SP1_VERIFYING_KEY)), { ok: false, error: "foreign_verifying_key" });
});
