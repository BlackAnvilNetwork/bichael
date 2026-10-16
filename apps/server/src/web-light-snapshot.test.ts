/**
 * The live snapshot path builds the character-root inclusion and one state
 * leaf from the open world. `snapshotFor` here is the function the server's
 * snapshot attaches. A hand-built proof passed beside it does not count.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { concatBytes } from "viem";
import {
  checkWebLightClient,
  lightClientFromSnapshot,
  setReplicaAllowlist,
} from "../../web/src/light-client";
import { LokWorld } from "./lok-world";
import { encodeCommitCertificate, snapshotFor } from "./web-light-snapshot";

const HEIGHT = 4;
const ROUND = 1;

test("snapshotFor attaches a character-root proof and a state leaf that recompute", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-light-"));
  const lok = LokWorld.open(dir, undefined, {});
  const a = lok.spawn("char-a", "Ada", 0);
  const b = lok.spawn("char-b", "Bea", 1);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  lok.noteCustodyInbound({ kind: "importItem", tokenId: a.tokenId, nonce: "1", itemId: "7", amount: "3" });
  assert.equal(lok.importItem(a.tokenId, "7", "3", "1").ok, true);
  assert.equal(lok.levelUp(a.tokenId, 2).ok, true);
  assert.equal(lok.learnAbility(a.tokenId, "fire").ok, true);
  assert.equal(lok.harvest(a.tokenId, "ore", "4").ok, true);
  assert.equal(lok.craft(a.tokenId, "313", "1").ok, true);
  assert.equal(lok.kill(a.tokenId, "1").ok, true);
  assert.equal(lok.lootDrop(a.tokenId, "7", "2", "1").ok, true);
  assert.equal(lok.goldEarn(a.tokenId, "quest", "100", 1).ok, true);
  assert.equal(lok.goldEarn(a.tokenId, "quest", "5", 2).ok, true);
  assert.equal(lok.goldSpend(a.tokenId, "craft", "40").ok, true);

  const root = lok.characterRootTreeRoot();
  const replicas = [ed25519.keygen(), ed25519.keygen(), ed25519.keygen()];
  setReplicaAllowlist(replicas.map((key) => new Uint8Array(key.publicKey)));
  const certificate = encodeCommitCertificate({
    height: HEIGHT,
    round: ROUND,
    nextRoot: root,
    signers: replicas.slice(0, 2).map((key) => {
      const publicKey = new Uint8Array(key.publicKey);
      return {
        address: publicKey,
        signature: ed25519.sign(precommit(HEIGHT, ROUND, root, publicKey), key.secretKey),
      };
    }),
  });

  const light = snapshotFor({
    commitCertificateHex: hex(certificate),
    certifiedRootHex: hex(root),
    tokenId: a.tokenId,
    characters: lok.lightCharacters(),
  });
  assert.equal(light.claimedRoot, hex(root));
  assert.notEqual(light.characterRoot, "0".repeat(64));
  assert.equal(light.characterSiblings.length > 0, true);
  assert.equal(light.tag, 0);
  assert.notEqual(light.value, "0".repeat(64));
  assert.equal(light.leafSiblings.length > 0, true);

  const passed = checkWebLightClient(lightClientFromSnapshot({ lightClient: light }));
  assert.equal(passed.ok, true, passed.ok ? "" : passed.stage);

  const flippedSibling = {
    ...light,
    characterSiblings: light.characterSiblings.map((sibling, index) =>
      index === 0 ? { ...sibling, hash: flipHex(sibling.hash) } : sibling,
    ),
  };
  const badSibling = checkWebLightClient(lightClientFromSnapshot({ lightClient: flippedSibling }));
  assert.equal(badSibling.ok, false);
  if (!badSibling.ok) assert.equal(badSibling.stage, "character_root");

  const flippedLeaf = { ...light, value: flipHex(light.value) };
  const badLeaf = checkWebLightClient(lightClientFromSnapshot({ lightClient: flippedLeaf }));
  assert.equal(badLeaf.ok, false);
  if (!badLeaf.ok) assert.equal(badLeaf.stage, "leaf");
});

function precommit(height: number, round: number, root: Uint8Array, address: Uint8Array): Uint8Array {
  const heightBytes = new Uint8Array(8);
  const roundBytes = new Uint8Array(8);
  new DataView(heightBytes.buffer).setBigUint64(0, BigInt(height), false);
  new DataView(roundBytes.buffer).setBigInt64(0, BigInt(round), false);
  return concatBytes([
    new TextEncoder().encode("lok-order-vote-v1"),
    new Uint8Array([2]),
    heightBytes,
    roundBytes,
    new Uint8Array([1]),
    root,
    address,
  ]);
}

function flipHex(value: string): string {
  const flipped = (Number.parseInt(value.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, "0");
  return flipped + value.slice(2);
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
