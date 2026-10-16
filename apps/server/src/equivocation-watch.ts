/**
 * Signed batches the server process is holding.
 *
 * Each sealed tick notes its signed batch here. A second batch from the same
 * signer, for the same epoch and height, with a different next root, is
 * submitted to the equivocation court. The slash is that signer's posted
 * bond in slashable-bonds.json. No posted bond writes nothing. This module
 * does not invent an amount, does not broadcast, and does not wait.
 * Gnosis mainnet and Chiado are not called.
 */
import { timingSafeEqual } from "node:crypto";
import type { BatchEnvelope } from "./batch-envelope";
import {
  equivocationSignerId,
  submitEquivocationPair,
  type CourtResult,
} from "./equivocation-court";

/** Recent heights kept per signer. A slot that already conflicts is kept. */
const MAX_SLOTS = 64;

const noted = new Map<string, BatchEnvelope[]>();

export function resetNotedBatchesForTests(): void {
  noted.clear();
}

function sameRoot(left: Uint8Array, right: Uint8Array): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function copyBatch(batch: BatchEnvelope): BatchEnvelope {
  return {
    inputs: copyBytes(batch.inputs),
    inputsCommitment: copyBytes(batch.inputsCommitment),
    parentRoot: copyBytes(batch.parentRoot),
    nextRoot: copyBytes(batch.nextRoot),
    rulesetHash: copyBytes(batch.rulesetHash),
    epoch: batch.epoch,
    height: batch.height,
    worldId: batch.worldId,
    protocolVersion: batch.protocolVersion,
    leaderCommitment: copyBytes(batch.leaderCommitment),
    gnosisRandomness: copyBytes(batch.gnosisRandomness),
    epochSeed: copyBytes(batch.epochSeed),
    rollCommitment: copyBytes(batch.rollCommitment),
    signature: batch.signature ? copyBytes(batch.signature) : undefined,
  };
}

function pruneNoted(signerId: string): void {
  const prefix = `${signerId}:`;
  const rows: { key: string; height: number; conflict: boolean }[] = [];
  for (const [key, batches] of noted) {
    if (!key.startsWith(prefix)) continue;
    const height = Number(key.slice(key.lastIndexOf(":") + 1));
    let conflict = false;
    for (let i = 1; i < batches.length; i += 1) {
      if (!sameRoot(batches[0]!.nextRoot, batches[i]!.nextRoot)) {
        conflict = true;
        break;
      }
    }
    rows.push({ key, height, conflict });
  }
  if (rows.length <= MAX_SLOTS) return;
  rows.sort((a, b) => a.height - b.height);
  let drop = rows.length - MAX_SLOTS;
  for (const row of rows) {
    if (drop <= 0) break;
    if (row.conflict) continue;
    noted.delete(row.key);
    drop -= 1;
  }
}

/**
 * Note one signed batch this process is holding.
 * Submits the pair when another held batch conflicts. Otherwise returns
 * `{ slashed: false }` without reading a vote. Sync. Does not broadcast.
 */
export function observeSignedBatch(batch: BatchEnvelope, signer: Uint8Array): CourtResult {
  const id = equivocationSignerId(signer);
  const key = `${id}:${batch.epoch}:${batch.height}`;
  const list = noted.get(key) ?? [];
  let result: CourtResult = { slashed: false };
  for (const other of list) {
    if (sameRoot(other.nextRoot, batch.nextRoot)) continue;
    const submitted = submitEquivocationPair(other, batch, signer);
    if (!submitted.slashed) continue;
    result = submitted;
    break;
  }
  if (!list.some((other) => sameRoot(other.nextRoot, batch.nextRoot))) {
    list.push(copyBatch(batch));
    noted.set(key, list);
    pruneNoted(id);
  }
  return result;
}
