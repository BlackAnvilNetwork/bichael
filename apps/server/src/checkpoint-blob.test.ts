/**
 * A certified checkpoint is published as an EIP-4844 blob on local anvil.
 * A 20 Hz batch is not. The anchor records the sidecar commitment and the
 * keccak of the checkpoint bytes. The validator copy stays after the blob is gone.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createPublicClient, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BLOB_BYTES,
  BLOB_COMMITMENT_BYTES,
  MAX_CHECKPOINT_BYTES,
  anchoredCheckpointBlob,
  blobSidecarFromRawTx,
  checkpointBytesFromBlob,
  checkpointKeccak,
  keepCheckpointBytes,
  losePublishedBlob,
  packageCertifiedCheckpoint,
  postCertifiedCheckpoint,
  publishedBlobExists,
  readKeptCheckpoint,
  resetCheckpointBlobsForTests,
  resolveCastBin,
  versionedBlobHash,
  writePublishedBlob,
  type CertifiedCheckpoint,
} from "./checkpoint-blob";
import { submitOnSimTick } from "./order-submit";
import { anchoredHeight, postCertifiedBatch, resetRootAnchorForTests, type CertifiedBatch } from "./root-anchor";
import { runForgeScriptBroadcast, startThrowawayAnvil, supportAnvilAvailable, type ThrowawayAnvil } from "./support-anvil";

const certificate = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
const ANCHOR_POSTER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const POSTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function checkpoint(bytes: Uint8Array): CertifiedCheckpoint {
  return { kind: "checkpoint", bytes, certificate };
}

function versionedHex(commitment: Uint8Array): string {
  const digest = createHash("sha256").update(commitment).digest();
  const out = Buffer.alloc(32);
  out[0] = 0x01;
  digest.subarray(1).copy(out, 1);
  return "0x" + out.toString("hex");
}

describe("checkpoint blobs", { concurrency: false }, () => {
  test("a certified checkpoint is packaged as one blob", () => {
    resetCheckpointBlobsForTests();
    const bytes = new Uint8Array([0x00, 0x00, 0x10, 0xff, 0x01]);
    const packed = packageCertifiedCheckpoint(checkpoint(bytes));
    assert.ok(packed);
    assert.equal(packed.blob.length, BLOB_BYTES);
    assert.equal(packed.checkpointKeccak.length, 32);
    assert.deepEqual(packed.checkpointKeccak, new Uint8Array(keccak256(bytes, "bytes")));
    for (let i = 0; i < BLOB_BYTES; i += 32) assert.equal(packed.blob[i], 0);
    assert.deepEqual(checkpointBytesFromBlob(packed.blob), bytes);

    const spanning = new Uint8Array(40);
    spanning[0] = 0x01;
    spanning[31] = 0x02;
    spanning[39] = 0x03;
    const wide = packageCertifiedCheckpoint(checkpoint(spanning));
    assert.ok(wide);
    assert.deepEqual(checkpointBytesFromBlob(wide.blob), spanning);

    const again = packageCertifiedCheckpoint(checkpoint(bytes));
    assert.ok(again);
    assert.deepEqual(again.blob, packed.blob);
    assert.deepEqual(again.checkpointKeccak, packed.checkpointKeccak);

    const changed = packageCertifiedCheckpoint(checkpoint(new Uint8Array([0x02])));
    assert.ok(changed);
    assert.notDeepEqual(changed.blob, packed.blob);
    assert.notDeepEqual(changed.checkpointKeccak, packed.checkpointKeccak);
  });

  test("the versioned hash is 0x01 plus sha256 of the commitment without its first byte", () => {
    const commitment = Buffer.from(
      "8d11423a504d39e6b3a36f4c1e72932fc104a4f7edc5087f07b8433e975a2593ac6937b9a08f379d12568d774a63b411",
      "hex",
    );
    assert.equal(commitment.length, BLOB_COMMITMENT_BYTES);
    const versioned = versionedBlobHash(commitment);
    assert.equal(toHex(versioned), "0x01f63dba6fe23bbe500c0921a48221d15507f5cf0148612203597f57c3c1dbd3");
    assert.equal(toHex(versioned), versionedHex(commitment));
  });

  test("an uncertified or oversized body produces no blob", async () => {
    resetCheckpointBlobsForTests();
    let calls = 0;
    const poster = async () => {
      calls += 1;
      return true;
    };
    const bare = await postCertifiedCheckpoint(
      { kind: "checkpoint", bytes: new Uint8Array([1]), certificate: new Uint8Array() },
      { env: { LOK_CHAIN_ID: "31337" }, poster },
    );
    const empty = await postCertifiedCheckpoint(
      { kind: "checkpoint", bytes: new Uint8Array(), certificate },
      { env: { LOK_CHAIN_ID: "31337" }, poster },
    );
    const huge = new Uint8Array(MAX_CHECKPOINT_BYTES + 1);
    huge[0] = 1;
    const oversized = await postCertifiedCheckpoint(checkpoint(huge), {
      env: { LOK_CHAIN_ID: "31337" },
      poster,
    });
    assert.equal(bare, false);
    assert.equal(empty, false);
    assert.equal(oversized, false);
    assert.equal(calls, 0);
    assert.equal(packageCertifiedCheckpoint(checkpoint(huge)), null);
  });

  test("a failed post does not record the checkpoint", async () => {
    resetCheckpointBlobsForTests();
    const bytes = new Uint8Array([0x07, 0x08]);
    const packed = packageCertifiedCheckpoint(checkpoint(bytes));
    assert.ok(packed);
    const failed = await postCertifiedCheckpoint(checkpoint(bytes), {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => false,
    });
    assert.equal(failed, false);
    assert.equal(anchoredCheckpointBlob(packed.checkpointKeccak), null);
  });

  test("Gnosis and Chiado do not receive a checkpoint blob", async () => {
    resetCheckpointBlobsForTests();
    const bytes = new Uint8Array([0x09]);
    for (const chainId of ["100", "10200"]) {
      let calls = 0;
      const ok = await postCertifiedCheckpoint(checkpoint(bytes), {
        env: {
          LOK_CHAIN_ID: chainId,
          LOK_CHAIN_RPC: "http://127.0.0.1:9",
        },
        poster: async () => {
          calls += 1;
          return true;
        },
      });
      assert.equal(ok, false);
      assert.equal(calls, 0);
    }
    const remote = await postCertifiedCheckpoint(checkpoint(bytes), {
      env: { LOK_CHAIN_ID: "31337", LOK_CHAIN_RPC: "https://rpc.gnosischain.com" },
      poster: async () => true,
    });
    assert.equal(remote, false);
    const chiado = await postCertifiedCheckpoint(checkpoint(bytes), {
      env: { LOK_CHAIN_ID: "31337", LOK_CHAIN_RPC: "https://rpc.chiadochain.net" },
      poster: async () => true,
    });
    assert.equal(chiado, false);
    const packed = packageCertifiedCheckpoint(checkpoint(bytes));
    assert.ok(packed);
    assert.equal(anchoredCheckpointBlob(packed.checkpointKeccak), null);
  });

  test("owner, private, and listing keys do not publish a checkpoint", async () => {
    resetCheckpointBlobsForTests();
    const bytes = new Uint8Array([0x0a]);
    const shared = "0x" + "11".repeat(32);
    const base = {
      LOK_CHAIN_ID: "31337",
      LOK_CHAIN_RPC: "http://127.0.0.1:9",
      LOK_ROOT_ANCHOR: "0x" + "33".repeat(20),
      LOK_ANCHOR_POSTER_KEY: shared,
    };
    for (const extra of [{ LOK_OWNER_KEY: shared }, { PRIVATE_KEY: shared }, { LOK_LISTING_KEY: shared }]) {
      const ok = await postCertifiedCheckpoint(checkpoint(bytes), { env: { ...base, ...extra } });
      assert.equal(ok, false);
    }
    const missing = await postCertifiedCheckpoint(checkpoint(bytes), {
      env: { LOK_CHAIN_ID: "31337", LOK_CHAIN_RPC: "http://127.0.0.1:9", LOK_ROOT_ANCHOR: "0x" + "33".repeat(20) },
    });
    assert.equal(missing, false);
    const packed = packageCertifiedCheckpoint(checkpoint(bytes));
    assert.ok(packed);
    assert.equal(anchoredCheckpointBlob(packed.checkpointKeccak), null);
  });

  test("the validator keeps the checkpoint bytes after the published blob is deleted", () => {
    const bytes = new Uint8Array([0x11, 0x00, 0x22, 0x33, 0x00]);
    const packed = packageCertifiedCheckpoint(checkpoint(bytes));
    assert.ok(packed);
    const dir = mkdtempSync(join(tmpdir(), "lok-checkpoint-keep-"));
    keepCheckpointBytes(dir, bytes);
    writePublishedBlob(dir, packed.blob, packed.checkpointKeccak);
    assert.equal(publishedBlobExists(dir, packed.checkpointKeccak), true);
    losePublishedBlob(dir, packed.checkpointKeccak);
    assert.equal(publishedBlobExists(dir, packed.checkpointKeccak), false);
    assert.equal(existsSync(join(dir, "checkpoints", Buffer.from(packed.checkpointKeccak).toString("hex"))), true);
    assert.deepEqual(readKeptCheckpoint(dir, packed.checkpointKeccak), bytes);
    assert.deepEqual(checkpointKeccak(readKeptCheckpoint(dir, packed.checkpointKeccak)), packed.checkpointKeccak);
  });

  test("a 20 Hz batch submission does not produce a blob", async () => {
    resetCheckpointBlobsForTests();
    resetRootAnchorForTests();
    try {
      const nextRoot = new Uint8Array(32);
      nextRoot[0] = 0x11;
      const tick = submitOnSimTick(null, { ok: true, height: 1, nextRoot });
      assert.equal(tick.tickFailed, false);
      assert.equal(tick.status, "provisional");
      assert.equal(tick.blob, null);

      const asBatch = packageCertifiedCheckpoint({
        kind: "batch",
        bytes: nextRoot,
        certificate,
      } as unknown as CertifiedCheckpoint);
      assert.equal(asBatch, null);

      const batch: CertifiedBatch = { height: 1, nextRoot, certificate };
      const anchored = await postCertifiedBatch(batch, {
        env: { LOK_CHAIN_ID: "31337" },
        poster: async () => true,
      });
      assert.equal(anchored, true);
      assert.equal(anchoredCheckpointBlob(checkpointKeccak(nextRoot)), null);
      assert.equal(anchoredCheckpointBlob(checkpointKeccak(certificate)), null);
    } finally {
      resetRootAnchorForTests();
      resetCheckpointBlobsForTests();
    }
  });

  test(
    "anvil accepts the blob transaction and stores that sidecar commitment",
    { skip: !supportAnvilAvailable, timeout: 180_000 },
    async () => {
      resetCheckpointBlobsForTests();
      resetRootAnchorForTests();
      let anvil: ThrowawayAnvil | undefined;
      try {
        anvil = await startThrowawayAnvil();
        const poster = privateKeyToAccount(ANCHOR_POSTER_KEY);
        assert.equal(poster.address.toLowerCase(), POSTER.toLowerCase());
        const out = runForgeScriptBroadcast(
          [
            "script",
            "script/RootAnchorFixture.s.sol:RootAnchorFixture",
            "--rpc-url",
            anvil.rpc,
            "--private-key",
            ANCHOR_POSTER_KEY,
            "-vv",
          ],
          { env: { LOK_OWNER_KEY: "", PRIVATE_KEY: "", LOK_LISTING_KEY: "" } },
        );
        const deployed = /ANCHOR\s+(0x[a-fA-F0-9]{40})/.exec(out);
        assert.ok(deployed, out.slice(-800));
        const address = deployed[1] as Hex;
        const env = {
          LOK_CHAIN_ID: "31337",
          LOK_CHAIN_RPC: anvil.rpc,
          LOK_ROOT_ANCHOR: address,
          LOK_ANCHOR_POSTER_KEY: ANCHOR_POSTER_KEY,
          LOK_OWNER_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
          PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
          LOK_LISTING_KEY: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
        };
        const bytes = new Uint8Array([0x11, 0x00, 0x22, 0x33, 0x00, 0x44]);
        const packed = packageCertifiedCheckpoint(checkpoint(bytes));
        assert.ok(packed);
        const cast = resolveCastBin();
        assert.ok(cast);
        const dir = mkdtempSync(join(tmpdir(), "lok-checkpoint-anvil-"));
        const blobPath = join(dir, "checkpoint.bin");
        writeFileSync(blobPath, bytes);
        const probe = execFileSync(
          cast,
          [
            "mktx",
            "--blob",
            "--path",
            blobPath,
            "--rpc-url",
            anvil.rpc,
            "--private-key",
            ANCHOR_POSTER_KEY,
            "--nonce",
            "0",
            "--gas-limit",
            "100000",
            "--blob-gas-price",
            "1",
            "--priority-gas-price",
            "1000000000",
            "--gas-price",
            "2000000000",
            "0x0000000000000000000000000000000000000001",
            "--value",
            "0",
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, ETH_RPC_URL: anvil.rpc, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
          },
        );
        const sidecar = blobSidecarFromRawTx(probe);
        assert.equal(sidecar.commitments.length, 1);
        assert.equal(sidecar.blobs.length, 1);
        assert.equal(sidecar.commitments[0]!.length, BLOB_COMMITMENT_BYTES);
        assert.deepEqual(checkpointBytesFromBlob(sidecar.blobs[0]!), bytes);
        const commitmentHex = toHex(sidecar.commitments[0]!);
        const versioned = versionedHex(sidecar.commitments[0]!);

        const pub = createPublicClient({ transport: http(anvil.rpc) });
        const chainId = await pub.getChainId();
        assert.equal(chainId, 31337);
        const before = await pub.getBlockNumber();
        const nonceBefore = await pub.getTransactionCount({ address: poster.address });
        const posted = await postCertifiedCheckpoint(checkpoint(bytes), { env, dataDir: dir });
        assert.equal(posted, true);
        const after = await pub.getBlockNumber();
        assert.ok(after > before);

        let blobTx: { hash: Hex; from: string; type: string; blobVersionedHashes?: readonly Hex[] } | undefined;
        for (let n = before + 1n; n <= after; n += 1n) {
          const block = await pub.getBlock({ blockNumber: n, includeTransactions: true });
          for (const tx of block.transactions) {
            if (typeof tx === "string") continue;
            if (tx.from.toLowerCase() !== POSTER.toLowerCase()) continue;
            blobTx = tx;
          }
        }
        assert.ok(blobTx, "anvil block has no transaction from the poster");
        assert.equal(blobTx.type, "eip4844");
        assert.equal(blobTx.from.toLowerCase(), POSTER.toLowerCase());
        assert.ok(blobTx.blobVersionedHashes?.length);
        assert.equal(blobTx.blobVersionedHashes[0]?.toLowerCase(), versioned);
        const receipt = await pub.getTransactionReceipt({ hash: blobTx.hash });
        assert.equal(receipt.status, "success");
        assert.equal(receipt.blobGasUsed !== undefined && receipt.blobGasUsed > 0n, true);

        const abi = [
          {
            type: "function",
            name: "checkpointBlob",
            stateMutability: "view",
            inputs: [{ name: "checkpointKeccak", type: "bytes32" }],
            outputs: [
              { name: "commitment", type: "bytes" },
              { name: "storedKeccak", type: "bytes32" },
            ],
          },
        ] as const;
        const stored = await pub.readContract({
          address,
          abi,
          functionName: "checkpointBlob",
          args: [toHex(packed.checkpointKeccak)],
        });
        assert.equal(stored[0].toLowerCase(), commitmentHex);
        assert.equal(stored[1].toLowerCase(), toHex(packed.checkpointKeccak));
        assert.equal((stored[0].length - 2) / 2, 48);
        assert.notEqual(stored[0].toLowerCase(), toHex(bytes));
        const remembered = anchoredCheckpointBlob(packed.checkpointKeccak);
        assert.ok(remembered);
        assert.equal(toHex(remembered.commitment), commitmentHex);
        assert.equal(publishedBlobExists(dir, packed.checkpointKeccak), true);
        assert.deepEqual(readKeptCheckpoint(dir, packed.checkpointKeccak), bytes);
        losePublishedBlob(dir, packed.checkpointKeccak);
        assert.equal(publishedBlobExists(dir, packed.checkpointKeccak), false);
        assert.deepEqual(readKeptCheckpoint(dir, packed.checkpointKeccak), bytes);

        const nonceAfter = await pub.getTransactionCount({ address: poster.address });
        const repeat = await postCertifiedCheckpoint(checkpoint(bytes), { env, dataDir: dir });
        assert.equal(repeat, true);
        assert.equal(await pub.getTransactionCount({ address: poster.address }), nonceAfter);

        const wrong = "0x" + "11".repeat(48);
        let mismatchOut = "";
        try {
          mismatchOut = execFileSync(
            cast,
            [
              "send",
              "--blob",
              "--path",
              blobPath,
              "--rpc-url",
              anvil.rpc,
              "--private-key",
              ANCHOR_POSTER_KEY,
              "--gas-limit",
              "500000",
              "--blob-gas-price",
              "2000000000",
              "--priority-gas-price",
              "1000000000",
              "--gas-price",
              "20000000000",
              address,
              "postCheckpointBlob(bytes,bytes32)",
              wrong,
              toHex(packed.checkpointKeccak),
            ],
            {
              encoding: "utf8",
              windowsHide: true,
              maxBuffer: 16 * 1024 * 1024,
              env: { ...process.env, ETH_RPC_URL: anvil.rpc, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
            },
          );
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string; message?: string };
          mismatchOut = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`;
        }
        const mismatchHash = /transactionHash\s+(0x[0-9a-fA-F]{64})/.exec(mismatchOut)?.[1] as Hex | undefined;
        assert.ok(mismatchHash, mismatchOut.slice(-500));
        const mismatchTx = await pub.getTransaction({ hash: mismatchHash });
        const mismatchReceipt = await pub.getTransactionReceipt({ hash: mismatchHash });
        assert.equal(mismatchTx.type, "eip4844");
        assert.equal(mismatchReceipt.status, "reverted");
        assert.equal(mismatchReceipt.blobGasUsed !== undefined && mismatchReceipt.blobGasUsed > 0n, true);
        const still = await pub.readContract({
          address,
          abi,
          functionName: "checkpointBlob",
          args: [toHex(packed.checkpointKeccak)],
        });
        assert.equal(still[0].toLowerCase(), commitmentHex);

        const batchRoot = new Uint8Array(32);
        batchRoot[0] = 0xab;
        assert.equal(anchoredHeight(), null);
        const nonceBeforeBatch = await pub.getTransactionCount({ address: poster.address });
        const batchBefore = await pub.getBlockNumber();
        const batchOk = await postCertifiedBatch({ height: 7, nextRoot: batchRoot, certificate }, { env });
        assert.equal(batchOk, true);
        const nonceAfterBatch = await pub.getTransactionCount({ address: poster.address });
        assert.equal(Number(nonceAfterBatch), Number(nonceBeforeBatch) + 1);
        let batchTx: { type: string; hash: Hex; blobVersionedHashes?: readonly Hex[] } | undefined;
        for (let n = batchBefore + 1n; n <= batchBefore + 6n; n += 1n) {
          let block: Awaited<ReturnType<typeof pub.getBlock>>;
          try {
            block = await pub.getBlock({ blockNumber: n, includeTransactions: true });
          } catch {
            break;
          }
          for (const tx of block.transactions) {
            if (typeof tx === "string") continue;
            if (tx.from.toLowerCase() === POSTER.toLowerCase()) batchTx = tx;
          }
        }
        assert.ok(batchTx);
        assert.notEqual(batchTx.type, "eip4844");
        assert.equal(batchTx.blobVersionedHashes?.length ?? 0, 0);
        assert.equal((await pub.getTransactionReceipt({ hash: batchTx.hash })).status, "success");
        assert.equal(anchoredCheckpointBlob(checkpointKeccak(batchRoot)), null);
        const blobStill = await pub.readContract({
          address,
          abi,
          functionName: "checkpointBlob",
          args: [toHex(packed.checkpointKeccak)],
        });
        assert.equal(blobStill[0].toLowerCase(), commitmentHex);
      } finally {
        if (anvil?.proc.pid && anvil.proc.exitCode == null) {
          anvil.stop();
          try {
            execFileSync("taskkill", ["/PID", String(anvil.proc.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } catch {
            /* already stopped */
          }
        }
        resetRootAnchorForTests();
        resetCheckpointBlobsForTests();
      }
    },
  );
});
