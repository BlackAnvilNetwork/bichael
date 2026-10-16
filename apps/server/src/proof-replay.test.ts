/**
 * A proof is ignored when its result disagrees with replay of the pinned wasm.
 * That batch is invalid. An agreeing proof is not rejected for disagreement,
 * and the verifying-key check still applies. A batch with no proof does not
 * replay the wasm.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { concatBytes, keccak256 } from "viem";
import { acceptBatch, commitInputs, commitRoll, type BatchEnvelope, type BatchExpect } from "./batch-envelope";
import { fallbackEpochSeed } from "./fallback-epoch-seed";
import { defaultWasmPath, loadLokExports, lokCall, lokOut } from "./lok-engine";
import { LOCAL_RULESET_WASM_SHA256, LOCAL_SP1_VERIFYING_KEY } from "./lok-vault";
import { acceptedProof, resetAcceptedProofsForTests, storeAcceptedProof } from "./proof-replay";
import { RULESET_MIN_DELAY_MS, resetRulesetPinForTests } from "./ruleset-record";
import {
  provisionalChainLink,
  sealParentRoot,
  sealTickBatch,
  sealView,
  takeSealedSignedBatch,
} from "./seal-tick-batch";
import { executeOnSimTick, startSp1Process, takeArrivedSp1Proof, type Sp1Executor } from "./sp1-execute";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "index.ts");
const SEAL = path.join(HERE, "seal-tick-batch.ts");
const bls = bls12_381.longSignatures;
const leader = bls.keygen();
const leaderKey = new Uint8Array(leader.publicKey.toBytes());
const leaderSecret = new Uint8Array(leader.secretKey);
const ROLL_BYTES = Uint8Array.from([9, 8, 7, 6]);
const OTHER_KEY = `0x${"ab".repeat(32)}`;
const PINNED_WASM = "4d2610aa110a9f6bb163934d29a6ca7410b98530d59a700d8cd1b66cc5804178";

beforeEach(() => {
  resetRulesetPinForTests();
  resetAcceptedProofsForTests();
});

function hash(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function flipLast(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src);
  out[out.length - 1] = (out[out.length - 1]! ^ 0xff) & 0xff;
  return out;
}

/** Spawn through the pinned wasm, then read the log and the character root it replays to. */
function spawnedReplay(): { inputs: Uint8Array; root: Uint8Array } {
  const exp = loadLokExports();
  const opened = lokCall(exp, "", exp.lok_open);
  assert.equal(opened.rc, 0, opened.out);
  const applied = lokCall(exp, '{"op":"spawn","tokenId":"1","startingJob":3}', exp.lok_apply);
  assert.equal(applied.rc, 0);
  assert.match(applied.out, /"ok":true/);
  exp.lok_document();
  const inputs = new TextEncoder().encode(lokOut(exp));
  exp.lok_character_root();
  const hex = lokOut(exp);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.notEqual(hex, "0".repeat(64));
  const root = new Uint8Array(32);
  for (let i = 0; i < 32; i++) root[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { inputs, root };
}

function signed(inputs: Uint8Array, proof?: { verifyingKey: string; result: Uint8Array }): BatchEnvelope {
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
    proofVerifyingKey: proof?.verifyingKey,
    proofResult: proof?.result,
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

test("the pinned wasm digest and verifying key are unchanged", () => {
  assert.equal(LOCAL_RULESET_WASM_SHA256, PINNED_WASM);
  assert.equal(LOCAL_SP1_VERIFYING_KEY, "0x00be4fce8613fcbf00a32a17381c8f54b6632eaf74d9a35192986ce93160cf93");
  assert.equal(RULESET_MIN_DELAY_MS, 86_400_000);
  const actual = createHash("sha256").update(readFileSync(defaultWasmPath())).digest("hex");
  assert.equal(actual, PINNED_WASM);
});

test("a disagreeing proof is ignored and the batch is invalid", () => {
  const replay = spawnedReplay();
  const wrong = flipLast(replay.root);
  assert.equal(storeAcceptedProof(replay.inputs, wrong), false);
  assert.equal(acceptedProof(replay.inputs, wrong), null);
  const batch = signed(replay.inputs, {
    verifyingKey: LOCAL_SP1_VERIFYING_KEY,
    result: wrong,
  });
  assert.deepEqual(decide(batch), { ok: false, error: "proof_disagrees" });
  assert.equal(acceptedProof(replay.inputs, wrong), null);
  assert.equal(acceptedProof(replay.inputs, replay.root), null);
});

test("an agreeing proof is not rejected for disagreement", () => {
  const replay = spawnedReplay();
  const batch = signed(replay.inputs, {
    verifyingKey: LOCAL_SP1_VERIFYING_KEY,
    result: replay.root,
  });
  const result = decide(batch);
  assert.equal(result.ok, true);
  assert.equal("error" in result, false);
  assert.deepEqual(result, { ok: true, epoch: 2, height: 5 });
  assert.deepEqual(acceptedProof(replay.inputs, replay.root), replay.root);
});

test("an agreeing proof on a rejected batch is not stored", () => {
  const replay = spawnedReplay();
  const batch = signed(replay.inputs, {
    verifyingKey: LOCAL_SP1_VERIFYING_KEY,
    result: replay.root,
  });
  batch.signature = new Uint8Array(96);
  assert.deepEqual(decide(batch), { ok: false, error: "bad_signature" });
  assert.equal(acceptedProof(replay.inputs, replay.root), null);
});

test("an agreeing proof under any other key is still not a batch of this world", () => {
  const replay = spawnedReplay();
  const batch = signed(replay.inputs, { verifyingKey: OTHER_KEY, result: replay.root });
  assert.deepEqual(decide(batch), { ok: false, error: "foreign_verifying_key" });
  assert.equal(acceptedProof(replay.inputs, replay.root), null);
});

test("a batch with no proof keeps the current path", () => {
  const batch = signed(Uint8Array.from([1, 2, 3, 4]));
  assert.equal(batch.proofVerifyingKey, undefined);
  assert.equal(batch.proofResult, undefined);
  assert.deepEqual(decide(batch), { ok: true, epoch: 2, height: 5 });
});

test("the tick does not wait on wasm replay or proving", () => {
  const indexSrc = readFileSync(INDEX, "utf8");
  const sealSrc = readFileSync(SEAL, "utf8");
  assert.match(indexSrc, /executeOnSimTick\(\s*tickSp1,\s*\(\)\s*=>\s*lok\.logDocument\(\)\s*\)/);
  assert.match(indexSrc, /takeArrivedSp1Proof\(\s*tickSp1\s*\)/);
  assert.match(indexSrc, /arrivedProof/);
  assert.match(sealSrc, /judgeTickProof\(args\.arrivedProof\)/);
  assert.equal(indexSrc.includes("replayPinnedWasm"), false);
  assert.equal(indexSrc.includes("proofResult"), false);
  assert.equal(sealSrc.includes("proofVerifyingKey"), false);
  assert.equal(sealSrc.includes("proofResult"), false);
  assert.equal(sealSrc.includes("await "), false);
});

function sealArrived(
  arrivedProof: {
    prover: string;
    verifyingKey: string;
    result: Uint8Array;
    log: Uint8Array;
  } | null,
) {
  const inputs = Uint8Array.from([7, arrivedProof?.result[0] ?? 0, arrivedProof?.verifyingKey.length ?? 0]);
  const parent = sealParentRoot();
  return sealTickBatch({
    inputs,
    rollBytes: new Uint8Array(0),
    rulesetHash: hash(0x33),
    gnosisRandomness: new Uint8Array(32),
    parentRoot: parent,
    chainLink: provisionalChainLink(parent, inputs),
    arrivedProof,
  });
}

async function waitForArrivedProof(executor: Sp1Executor, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (executor.lastResult() && !executor.busy()) {
      const proof = takeArrivedSp1Proof(executor);
      if (proof) return proof;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`no SP1 proof\n${executor.stderr()}`);
}

test("the server seal compares an arrived SP1 proof", async (t) => {
  await t.test("a disagreeing proof is ignored and the batch is invalid", async () => {
    const replay = spawnedReplay();
    const wrong = flipLast(replay.root);
    const line = JSON.stringify({
      ok: true,
      prover: "sp1",
      verifyingKey: LOCAL_SP1_VERIFYING_KEY,
      result: `0x${Buffer.from(wrong).toString("hex")}`,
    });
    const executor = startSp1Process(process.execPath, [
      "-e",
      `process.stdin.on("data",()=>{process.stdout.write(${JSON.stringify(line + "\n")});process.exit(0)})`,
    ]);
    assert.ok(executor);
    executeOnSimTick(executor, () => new TextDecoder().decode(replay.inputs));
    const arrived = await waitForArrivedProof(executor, 2_000);
    const before = sealView();
    const sealed = sealArrived(arrived);
    assert.equal(arrived.prover, "sp1");
    assert.equal(arrived.verifyingKey, LOCAL_SP1_VERIFYING_KEY);
    assert.deepEqual(sealed, { ok: false, error: "proof_disagrees" });
    assert.equal(sealView().height, before.height);
    assert.equal(takeSealedSignedBatch(), null);
    assert.equal(acceptedProof(replay.inputs, wrong), null);
    await executor.stop();
  });

  await t.test("a missing proof does not stall the tick", async () => {
    const executor = startSp1Process(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    assert.ok(executor);
    const started = Date.now();
    executeOnSimTick(executor, () => '{"type":"characters","characters":[]}');
    const arrived = takeArrivedSp1Proof(executor);
    const waited = Date.now() - started;
    assert.equal(arrived, null);
    assert.ok(waited < 50, `tick waited ${waited}ms`);
    const before = sealView();
    const sealed = sealArrived(null);
    assert.equal(sealed.ok, true);
    assert.equal(sealView().height, before.height + 1);
    await executor.stop();
  });

  await t.test("a proof under another key is not accepted", () => {
    const before = sealView();
    const sealed = sealArrived({
      prover: "sp1",
      verifyingKey: OTHER_KEY,
      result: new Uint8Array(32),
      log: new TextEncoder().encode('{"type":"characters","characters":[]}'),
    });
    assert.deepEqual(sealed, { ok: false, error: "foreign_verifying_key" });
    assert.equal(sealView().height, before.height);
    assert.equal(takeSealedSignedBatch(), null);
    const risc = sealArrived({
      prover: "risc0",
      verifyingKey: LOCAL_SP1_VERIFYING_KEY,
      result: new Uint8Array(32),
      log: new TextEncoder().encode('{"type":"characters","characters":[]}'),
    });
    assert.deepEqual(risc, { ok: false, error: "foreign_verifying_key" });
    assert.equal(sealView().height, before.height);
  });
});
