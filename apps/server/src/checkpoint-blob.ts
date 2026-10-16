/**
 * Publish one certified checkpoint as an EIP-4844 blob on local anvil.
 *
 * `cast send --blob --path` submits a type-3 transaction. The blob is one
 * 4096-field sidecar: the first field is a big-endian length, and each
 * following field carries 31 checkpoint bytes under a zero high byte. The
 * anchor stores the sidecar's 48-byte KZG commitment and keccak256 of the
 * checkpoint bytes. It does not store the blob or the checkpoint bytes.
 * Validators keep those bytes on disk. Gnosis mainnet (100) and Chiado
 * (10200) are refused. The signer is `LOK_ANCHOR_POSTER_KEY`.
 *
 * A 20 Hz batch is not a checkpoint and is not packaged here.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, http, keccak256, type Hex } from "viem";
import { posterKeyRefused } from "./root-anchor";

const ANVIL_CHAIN_ID = 31337;
const FIELD_ELEMENTS = 4096;
const FIELD_BYTES = 32;
const PAYLOAD_PER_FIELD = 31;

export const BLOB_BYTES = FIELD_ELEMENTS * FIELD_BYTES;
export const BLOB_COMMITMENT_BYTES = 48;
export const MAX_CHECKPOINT_BYTES = (FIELD_ELEMENTS - 1) * PAYLOAD_PER_FIELD;

const CHECKPOINT_BLOB_ABI = [
  {
    type: "function",
    name: "postCheckpointBlob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitment", type: "bytes" },
      { name: "checkpointKeccak", type: "bytes32" },
    ],
    outputs: [],
  },
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

export type CertifiedCheckpoint = {
  kind: "checkpoint";
  bytes: Uint8Array;
  certificate: Uint8Array;
};

export type PackagedCheckpoint = {
  bytes: Uint8Array;
  blob: Uint8Array;
  checkpointKeccak: Uint8Array;
};

export type BlobSidecar = {
  blobs: Uint8Array[];
  commitments: Uint8Array[];
};

/** A test can refuse the send. Returning false records nothing. */
export type CheckpointBlobPoster = (posted: {
  blob: Uint8Array;
  checkpointKeccak: Uint8Array;
}) => Promise<boolean>;

type AnchoredCheckpointBlob = {
  commitment: Uint8Array;
  checkpointKeccak: Uint8Array;
};

const recorded = new Map<string, AnchoredCheckpointBlob>();

export function resetCheckpointBlobsForTests(): void {
  recorded.clear();
}

export function checkpointKeccak(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(keccak256(bytes, "bytes"));
}

/** EIP-4844 versioned hash: `0x01 || sha256(commitment)[1:]`. */
export function versionedBlobHash(commitment: Uint8Array): Uint8Array {
  const digest = createHash("sha256").update(commitment).digest();
  const out = new Uint8Array(32);
  out[0] = 0x01;
  out.set(digest.subarray(1), 1);
  return out;
}

/**
 * Package a certified checkpoint. An empty body, an empty certificate, a
 * body that does not fit in one blob, or anything that is not a checkpoint
 * produces no blob.
 */
export function packageCertifiedCheckpoint(checkpoint: CertifiedCheckpoint): PackagedCheckpoint | null {
  if (checkpoint.kind !== "checkpoint") return null;
  if (!(checkpoint.bytes instanceof Uint8Array) || checkpoint.bytes.length === 0) return null;
  if (!(checkpoint.certificate instanceof Uint8Array) || checkpoint.certificate.length === 0) return null;
  if (checkpoint.bytes.length > MAX_CHECKPOINT_BYTES) return null;
  return {
    bytes: checkpoint.bytes.slice(),
    blob: blobFromCheckpoint(checkpoint.bytes),
    checkpointKeccak: checkpointKeccak(checkpoint.bytes),
  };
}

/** Recover the checkpoint bytes from a blob this module packaged. */
export function checkpointBytesFromBlob(blob: Uint8Array): Uint8Array | null {
  if (blob.length !== BLOB_BYTES) return null;
  for (let i = 0; i < FIELD_ELEMENTS; i += 1) {
    if (blob[i * FIELD_BYTES] !== 0) return null;
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const length = Number(view.getBigUint64(1, false));
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_CHECKPOINT_BYTES) return null;
  for (let i = 9; i < FIELD_BYTES; i += 1) {
    if (blob[i] !== 0) return null;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  let field = 1;
  while (offset < length) {
    if (field >= FIELD_ELEMENTS) return null;
    const n = Math.min(PAYLOAD_PER_FIELD, length - offset);
    const start = field * FIELD_BYTES + 1;
    out.set(blob.subarray(start, start + n), offset);
    for (let i = n; i < PAYLOAD_PER_FIELD; i += 1) {
      if (blob[start + i] !== 0) return null;
    }
    offset += n;
    field += 1;
  }
  for (let f = field; f < FIELD_ELEMENTS; f += 1) {
    for (let i = 1; i < FIELD_BYTES; i += 1) {
      if (blob[f * FIELD_BYTES + i] !== 0) return null;
    }
  }
  return out;
}

export function anchoredCheckpointBlob(checkpointKeccakBytes: Uint8Array): AnchoredCheckpointBlob | null {
  const row = recorded.get(hexKey(checkpointKeccakBytes));
  if (!row) return null;
  return {
    commitment: row.commitment.slice(),
    checkpointKeccak: row.checkpointKeccak.slice(),
  };
}

/**
 * Publish the checkpoint to local anvil and record the sidecar commitment.
 * A refused chain, a refused poster key, or a failed send records nothing.
 */
export async function postCertifiedCheckpoint(
  checkpoint: CertifiedCheckpoint,
  opts?: { env?: NodeJS.ProcessEnv; poster?: CheckpointBlobPoster; dataDir?: string },
): Promise<boolean> {
  const packed = packageCertifiedCheckpoint(checkpoint);
  if (!packed) return false;
  const env = opts?.env ?? process.env;
  if (chainRefused(env)) return false;
  const key = hexKey(packed.checkpointKeccak);
  const existing = recorded.get(key);
  if (existing) {
    if (opts?.dataDir) retain(opts.dataDir, packed);
    return true;
  }
  if (opts?.poster) {
    try {
      if (!(await opts.poster({ blob: packed.blob, checkpointKeccak: packed.checkpointKeccak }))) return false;
    } catch {
      return false;
    }
  }
  if (posterKeyRefused(env)) return false;
  const published = await publishToLocalAnvil(packed, env);
  if (!published) return false;
  recorded.set(key, {
    commitment: published.commitment.slice(),
    checkpointKeccak: packed.checkpointKeccak.slice(),
  });
  if (opts?.dataDir) retain(opts.dataDir, packed);
  return true;
}

export function keepCheckpointBytes(dir: string, bytes: Uint8Array): void {
  const path = checkpointFile(dir, checkpointKeccak(bytes));
  mkdirSync(join(dir, "checkpoints"), { recursive: true });
  writeFileSync(path, bytes);
}

export function readKeptCheckpoint(dir: string, checkpointKeccakBytes: Uint8Array): Uint8Array {
  return new Uint8Array(readFileSync(checkpointFile(dir, checkpointKeccakBytes)));
}

export function writePublishedBlob(dir: string, blob: Uint8Array, checkpointKeccakBytes: Uint8Array): void {
  mkdirSync(join(dir, "blobs"), { recursive: true });
  writeFileSync(blobFile(dir, checkpointKeccakBytes), blob);
}

export function losePublishedBlob(dir: string, checkpointKeccakBytes: Uint8Array): void {
  const path = blobFile(dir, checkpointKeccakBytes);
  if (existsSync(path)) unlinkSync(path);
}

export function publishedBlobExists(dir: string, checkpointKeccakBytes: Uint8Array): boolean {
  return existsSync(blobFile(dir, checkpointKeccakBytes));
}

/** KZG commitment and blob bytes from a raw type-3 transaction `cast` produced. */
export function blobSidecarFromRawTx(raw: string): BlobSidecar {
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .reverse()
    .find((item) => item.startsWith("0x03"));
  if (!line) throw new Error("cast did not return a blob transaction");
  const bytes = Buffer.from(line.slice(2), "hex");
  if (bytes[0] !== 0x03) throw new Error("not a blob transaction");
  const top = decodeRlp(bytes, 1);
  if (!Array.isArray(top.value) || top.value.length < 3) throw new Error("blob sidecar missing");
  const txFields = top.value[0];
  if (!Array.isArray(txFields) || txFields.length < 11) throw new Error("blob transaction fields missing");
  const blobs = byteList(top.value[1], BLOB_BYTES);
  const commitments = byteList(top.value[2], BLOB_COMMITMENT_BYTES);
  if (blobs.length !== 1 || commitments.length !== 1) {
    throw new Error("a checkpoint publishes one blob");
  }
  const hashes = byteList(txFields[10], 32);
  if (hashes.length !== 1 || !bytesEqual(hashes[0]!, versionedBlobHash(commitments[0]!))) {
    throw new Error("sidecar commitment does not match its versioned hash");
  }
  return { blobs, commitments };
}

export function resolveCastBin(): string | null {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  for (const candidate of [
    process.env.CAST_PATH,
    "cast",
    join(home, ".foundry", "bin", "cast.exe"),
    join(home, ".foundry", "bin", "cast"),
    "/home/ubuntu/.foundry/bin/cast",
  ]) {
    if (!candidate) continue;
    try {
      if (candidate === "cast") {
        execFileSync("cast", ["--version"], { stdio: "ignore", windowsHide: true });
        return "cast";
      }
      if (existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

function retain(dir: string, packed: PackagedCheckpoint): void {
  keepCheckpointBytes(dir, packed.bytes);
  writePublishedBlob(dir, packed.blob, packed.checkpointKeccak);
}

function blobFromCheckpoint(bytes: Uint8Array): Uint8Array {
  const blob = new Uint8Array(BLOB_BYTES);
  new DataView(blob.buffer).setBigUint64(1, BigInt(bytes.length), false);
  let offset = 0;
  let field = 1;
  while (offset < bytes.length) {
    const n = Math.min(PAYLOAD_PER_FIELD, bytes.length - offset);
    blob.set(bytes.subarray(offset, offset + n), field * FIELD_BYTES + 1);
    offset += n;
    field += 1;
  }
  return blob;
}

async function publishToLocalAnvil(
  packed: PackagedCheckpoint,
  env: NodeJS.ProcessEnv,
): Promise<{ commitment: Uint8Array } | null> {
  const address = env.LOK_ROOT_ANCHOR?.trim() ?? "";
  const rpc = env.LOK_CHAIN_RPC?.trim() ?? "";
  const key = env.LOK_ANCHOR_POSTER_KEY?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (!localAnvilRpc(rpc) || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  const cast = resolveCastBin();
  if (!cast) throw new Error("cast not found");
  const transport = http(rpc);
  const pub = createPublicClient({ transport });
  const id = await pub.getChainId();
  if (id !== ANVIL_CHAIN_ID) return null;

  const dir = join(tmpdir(), `lok-checkpoint-blob-${Date.now()}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const blobPath = join(dir, "checkpoint.bin");
  writeFileSync(blobPath, packed.bytes);
  try {
    const probe = castOutput(cast, [
      "mktx",
      "--blob",
      "--path",
      blobPath,
      "--rpc-url",
      rpc,
      "--private-key",
      key,
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
    ], rpc, key);
    const sidecar = blobSidecarFromRawTx(probe);
    const commitment = sidecar.commitments[0]!;
    const blob = sidecar.blobs[0]!;
    if (!bytesEqual(blob, packed.blob)) throw new Error("cast blob does not match the checkpoint encoding");
    const calldata = encodeFunctionData({
      abi: CHECKPOINT_BLOB_ABI,
      functionName: "postCheckpointBlob",
      args: [hexOf(commitment), hexOf(packed.checkpointKeccak)],
    });
    const sent = castOutput(cast, [
      "send",
      "--blob",
      "--path",
      blobPath,
      "--rpc-url",
      rpc,
      "--private-key",
      key,
      "--gas-limit",
      "500000",
      "--blob-gas-price",
      "2000000000",
      "--priority-gas-price",
      "1000000000",
      "--gas-price",
      "20000000000",
      address,
      calldata,
    ], rpc, key);
    const txHash = /transactionHash\s+(0x[0-9a-fA-F]{64})/.exec(sent)?.[1] as Hex | undefined;
    if (!txHash) throw new Error("cast send did not report a transaction hash");
    const receipt = await pub.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return null;
    const tx = await pub.getTransaction({ hash: txHash });
    const versioned = hexOf(versionedBlobHash(commitment));
    const hashes = "blobVersionedHashes" in tx ? tx.blobVersionedHashes : undefined;
    if (tx.type !== "eip4844" || !hashes || hashes[0]?.toLowerCase() !== versioned.toLowerCase()) {
      throw new Error("anvil did not include the checkpoint blob transaction");
    }
    const decoded = await pub.readContract({
      address: address as Hex,
      abi: CHECKPOINT_BLOB_ABI,
      functionName: "checkpointBlob",
      args: [hexOf(packed.checkpointKeccak)],
    });
    if (decoded[0].toLowerCase() !== hexOf(commitment).toLowerCase()) return null;
    if (decoded[1].toLowerCase() !== hexOf(packed.checkpointKeccak).toLowerCase()) return null;
    return { commitment };
  } finally {
    if (existsSync(blobPath)) unlinkSync(blobPath);
    try {
      rmdirSync(dir);
    } catch {
      /* best effort */
    }
  }
}

function castOutput(cast: string, args: string[], rpc: string, key: string): string {
  return execFileSync(cast, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: castEnv(rpc, key),
  });
}

function castEnv(rpc: string, key: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
    ETH_RPC_URL: rpc,
    ETH_PRIVATE_KEY: key,
  };
  delete env.PRIVATE_KEY;
  delete env.LOK_OWNER_KEY;
  delete env.LOK_LISTING_KEY;
  return env;
}

function checkpointFile(dir: string, checkpointKeccakBytes: Uint8Array): string {
  return join(dir, "checkpoints", hexKey(checkpointKeccakBytes));
}

function blobFile(dir: string, checkpointKeccakBytes: Uint8Array): string {
  return join(dir, "blobs", hexKey(checkpointKeccakBytes));
}

function hexKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexOf(bytes: Uint8Array): Hex {
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function chainRefused(env: NodeJS.ProcessEnv): boolean {
  const named = env.LOK_CHAIN_ID?.trim() ?? "";
  if (named === "100" || named === "10200") return true;
  if (named !== "" && named !== String(ANVIL_CHAIN_ID)) return true;
  const rpc = env.LOK_CHAIN_RPC?.trim() ?? "";
  return /gnosis|chiado/i.test(rpc);
}

function localAnvilRpc(rpc: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(rpc.trim());
}

type Rlp = Uint8Array | Rlp[];

function decodeRlp(bytes: Uint8Array, offset: number): { value: Rlp; offset: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error("rlp short");
  if (first <= 0x7f) return { value: bytes.subarray(offset, offset + 1), offset: offset + 1 };
  if (first <= 0xb7) {
    const len = first - 0x80;
    const start = offset + 1;
    return { value: bytes.subarray(start, start + len), offset: start + len };
  }
  if (first <= 0xbf) {
    const ll = first - 0xb7;
    const start = offset + 1 + ll;
    return { value: bytes.subarray(start, start + rlpLen(bytes, offset + 1, ll)), offset: start + rlpLen(bytes, offset + 1, ll) };
  }
  if (first <= 0xf7) return decodeList(bytes, offset + 1, offset + 1 + (first - 0xc0));
  const ll = first - 0xf7;
  const start = offset + 1 + ll;
  return decodeList(bytes, start, start + rlpLen(bytes, offset + 1, ll));
}

function rlpLen(bytes: Uint8Array, offset: number, width: number): number {
  let len = 0;
  for (let i = 0; i < width; i += 1) len = len * 256 + (bytes[offset + i] ?? 0);
  return len;
}

function decodeList(bytes: Uint8Array, start: number, end: number): { value: Rlp[]; offset: number } {
  const items: Rlp[] = [];
  let cursor = start;
  while (cursor < end) {
    const next = decodeRlp(bytes, cursor);
    items.push(next.value);
    cursor = next.offset;
  }
  if (cursor !== end) throw new Error("rlp list overrun");
  return { value: items, offset: end };
}

function byteList(value: Rlp | undefined, size: number): Uint8Array[] {
  if (!Array.isArray(value)) throw new Error("expected an rlp list");
  return value.map((item) => {
    if (Array.isArray(item) || item.length !== size) throw new Error("unexpected rlp field");
    return new Uint8Array(item);
  });
}
