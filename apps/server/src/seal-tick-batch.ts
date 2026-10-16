/**
 * One process seals one sim tick into a batch envelope and runs `acceptBatch`.
 *
 * The BLS12-381 leader key (48-byte G1 public key, 96-byte G2 signature) and
 * the 32-byte share behind the leader commitment are generated once at process
 * start and kept in memory. This module does not read `LOK_OWNER_KEY`,
 * `PRIVATE_KEY`, or the listing key, and it does not persist the key.
 *
 * The epoch seed is one seed for the whole world:
 * `fallbackEpochSeed(leaderCommitment, gnosisRandomness)`. The leader
 * commitment is fixed for the process. The seed is not derived per player,
 * per character, or per tick. A successful seal starts the shared roll
 * cursor from that envelope seed. The same seed on a later tick does not
 * rewind it. Loot and combat rolls stay derivations from that shared seed
 * plus an event id. The chain commits the seed and the batch root. It does
 * not settle a roll per character.
 *
 * Gnosis randomness is an argument and is stored on the envelope as given.
 * This pull request does not fetch Gnosis.
 */
import { randomBytes } from "node:crypto";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { concatBytes, keccak256 } from "viem";
import {
  acceptBatch,
  commitInputs,
  commitRoll,
  LEADER_KEY_BYTES,
  leaderSigningMessage,
  type AcceptBatchResult,
  type BatchEnvelope,
} from "./batch-envelope";
import { fallbackEpochSeed } from "./fallback-epoch-seed";
import { startEpochRoll } from "./game-roll";

const WORLD_ID = "bellgrave";
const PROTOCOL_VERSION = "1";
/** One epoch for this process. Height is the only counter that advances per seal. */
const WORLD_EPOCH = 0;

const bls = bls12_381.longSignatures;
const leader = bls.keygen();
const leaderSecret = new Uint8Array(leader.secretKey);
const leaderPublicKey = new Uint8Array(leader.publicKey.toBytes());
if (leaderPublicKey.length !== LEADER_KEY_BYTES) {
  throw new Error("leader public key must be 48 bytes");
}

/** In-memory preimage. The published value is its keccak256. */
const leaderShare = new Uint8Array(randomBytes(32));
const leaderCommitment = new Uint8Array(keccak256(leaderShare, "bytes"));

/** First parent is 32 zero bytes. A successful seal stores `chainLink` here. */
let storedParent = new Uint8Array(32);
let height = 0;
/** Latest signed envelope from `sealTickBatch`, until the tick takes it. */
let sealedSigned: { batch: BatchEnvelope; signer: Uint8Array } | null = null;

/**
 * The signed batch from the latest `sealTickBatch`, then clears it.
 * Absent when that call did not attach a signature.
 */
export function takeSealedSignedBatch(): { batch: BatchEnvelope; signer: Uint8Array } | null {
  const found = sealedSigned;
  sealedSigned = null;
  return found;
}

export type SealTickBatchArgs = {
  inputs: Uint8Array;
  rollBytes: Uint8Array;
  rulesetHash: Uint8Array;
  /** 32-byte Gnosis randomness. Recorded on the envelope. This pull request does not fetch it. */
  gnosisRandomness: Uint8Array;
  parentRoot: Uint8Array;
  /**
   * 32-byte batch nextRoot. The live tick passes `World::character_root_tree_root`.
   * Older tests may still pass `provisionalChainLink`.
   */
  chainLink: Uint8Array;
};

/** Chain position this process currently expects. Copies, so a caller cannot mutate it. */
export function sealView(): {
  parentRoot: Uint8Array;
  height: number;
  epoch: number;
  worldId: string;
  protocolVersion: string;
  leaderCommitment: Uint8Array;
  leaderPublicKey: Uint8Array;
} {
  return {
    parentRoot: new Uint8Array(storedParent),
    height,
    epoch: WORLD_EPOCH,
    worldId: WORLD_ID,
    protocolVersion: PROTOCOL_VERSION,
    leaderCommitment: new Uint8Array(leaderCommitment),
    leaderPublicKey: new Uint8Array(leaderPublicKey),
  };
}

/** Parent the next seal must present. The first value is 32 zero bytes. */
export function sealParentRoot(): Uint8Array {
  return new Uint8Array(storedParent);
}

/**
 * keccak256(parentRoot || inputsCommitment).
 * Older tests may pass this as `chainLink`. The live tick passes the character-root tree root.
 */
export function provisionalChainLink(parentRoot: Uint8Array, inputs: Uint8Array): Uint8Array {
  return new Uint8Array(keccak256(concatBytes([parentRoot, commitInputs(inputs)]), "bytes"));
}

function sign(envelope: BatchEnvelope): Uint8Array {
  const hashed = bls.hash(leaderSigningMessage(envelope));
  return new Uint8Array(bls.sign(hashed, leaderSecret).toBytes());
}

/**
 * Run `acceptBatch` for this process's leader key, epoch, and height.
 * Does not advance the parent or the height.
 */
export function checkSealedTick(
  envelope: BatchEnvelope,
  rollBytes: Uint8Array,
  rulesetHash: Uint8Array,
  chainLink: Uint8Array,
): AcceptBatchResult {
  return acceptBatch(
    envelope,
    storedParent,
    rulesetHash,
    chainLink,
    {
      epoch: WORLD_EPOCH,
      height,
      worldId: WORLD_ID,
      protocolVersion: PROTOCOL_VERSION,
      rollBytes,
    },
    leaderPublicKey,
  );
}

/**
 * Fill epoch, height, world id, and protocol version, sign, and run `acceptBatch`.
 * Height increments only after a successful seal. The next parent is `chainLink`.
 * A successful seal starts the shared roll cursor from this batch's epoch seed.
 * The same seed on the next tick does not rewind that cursor.
 */
export function sealTickBatch(args: SealTickBatchArgs): AcceptBatchResult {
  sealedSigned = null;
  const inputsCommitment = commitInputs(args.inputs);
  const epochSeed = fallbackEpochSeed(leaderCommitment, args.gnosisRandomness);
  const envelope: BatchEnvelope = {
    inputs: args.inputs,
    inputsCommitment,
    parentRoot: args.parentRoot,
    nextRoot: args.chainLink,
    rulesetHash: args.rulesetHash,
    epoch: WORLD_EPOCH,
    height,
    worldId: WORLD_ID,
    protocolVersion: PROTOCOL_VERSION,
    leaderCommitment: new Uint8Array(leaderCommitment),
    gnosisRandomness: new Uint8Array(args.gnosisRandomness),
    epochSeed,
    rollCommitment: commitRoll(inputsCommitment, epochSeed, args.rollBytes),
  };
  envelope.signature = sign(envelope);
  sealedSigned = { batch: envelope, signer: leaderPublicKey };
  const result = checkSealedTick(envelope, args.rollBytes, args.rulesetHash, args.chainLink);
  if (result.ok) {
    storedParent = new Uint8Array(args.chainLink);
    height += 1;
    startEpochRoll(epochSeed);
  }
  return result;
}
