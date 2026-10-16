/**
 * A certified root is anchored only after a successful post.
 * A status line that names a height does not invent one.
 * Chain-bound sends stay in process until that root is posted.
 * The tick helper still returns without waiting.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createPublicClient, http, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PVP_BOUNTY_WEI } from "@bellgrave/config";
import { openAskOnchain } from "./ah-escrow-tx";
import { chainBuyAsk } from "./escrow-buy";
import {
  registryAdmin,
  resetBondedAdmissionForTests,
  votingReplica,
  votingSet,
  votingSetCommitThreshold,
} from "./bonded-admission";
import { allowEpochSettlementForTests } from "./epoch-cap-fixture";
import { LokWorld } from "./lok-world";
import { PINNED_GNOSIS_LISTING_ADDRESS } from "./production-boot";
import { serverMintCharacterFor } from "./lok-vault";
import { buildOpsStatus } from "./ops-health";
import { emptyReplicaHealth, observeOrdererLine, submitOnSimTick } from "./order-submit";
import { chainPvpCancel, chainPvpClaim } from "./pvp-bounty-tx";
import { provisionalChainLink } from "./seal-tick-batch";
import {
  ANCHOR_WAIT,
  CHALLENGE_DELAY_MS,
  CHALLENGE_WAIT,
  EPOCH_MS,
  EPOCH_XDAI_CAP_REFUSAL,
  anchoredHeight,
  admitBountyPayout,
  beginChainWithdrawal,
  chainBoundSendGate,
  chainBoundXdaiSend,
  configureEpochLedger,
  epochIndex,
  epochSettledXdai,
  epochXdaiCapWei,
  observeEscrowSettlement,
  postedSlashableBond,
  postedSlashableBonds,
  restartEpochLedger,
  pinEpochCharge,
  inGameWaitsForAnchor,
  noteCertifiedBatch,
  postCertifiedBatch,
  recordPostedSlashableBonds,
  resetRootAnchorForTests,
  setChallengeClockForTests,
  setPostedSlashableBonds,
  type CertifiedBatch,
} from "./root-anchor";
import {
  runForgeScriptBroadcast,
  startThrowawayAnvil,
  supportAnvilAvailable,
  type ThrowawayAnvil,
} from "./support-anvil";

const root = new Uint8Array(32);
root[0] = 0xab;
const certificate = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
const batch: CertifiedBatch = { height: 4, nextRoot: root, certificate };

function statusHeight(): number | null {
  const dir = mkdtempSync(join(tmpdir(), "lok-anchor-"));
  return buildOpsStatus({
    lokReady: () => true,
    startedAtMs: Date.now(),
    dataDir: dir,
    env: { NETWORK: "anvil", LOK_CHAIN_ID: "31337" },
  }).lastAnchoredHeight;
}

describe("root anchor", { concurrency: false }, () => {
test("nothing is anchored until a post succeeds", async () => {
  resetRootAnchorForTests();
  try {
    assert.equal(anchoredHeight(), null);
    assert.equal(statusHeight(), null);
    assert.equal(chainBoundSendGate().ok, false);

    noteCertifiedBatch(batch);
    assert.equal(anchoredHeight(), null);
    assert.equal(statusHeight(), null);
    const failed = await postCertifiedBatch(batch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => false,
    });
    assert.equal(failed, false);
    assert.equal(anchoredHeight(), null);
    assert.equal(chainBoundSendGate().ok, false);
  } finally {
    resetRootAnchorForTests();
  }
});

test("a status line that claims an anchor does not post one", () => {
  resetRootAnchorForTests();
  try {
    const line = JSON.stringify({
      lastCertifiedHeight: 3,
      lastAnchoredHeight: 9,
      root: "ab".repeat(32),
      commitCertificate: "abcd",
      clockSkew: 0,
      peers: [],
    });
    const health = observeOrdererLine(line, emptyReplicaHealth(), {});
    assert.equal(health.lastAnchoredHeight, null);
    assert.equal(health.lastCertifiedHeight, 3);
    assert.equal(anchoredHeight(), null);
    assert.equal(statusHeight(), null);
    assert.equal(chainBoundSendGate().ok, false);
  } finally {
    resetRootAnchorForTests();
  }
});

test("a successful post sets /status lastAnchoredHeight", async () => {
  resetRootAnchorForTests();
  try {
    noteCertifiedBatch(batch);
    let posted = 0;
    const ok = await postCertifiedBatch(batch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async (seen) => {
        posted += 1;
        assert.equal(seen.height, 4);
        assert.equal(seen.nextRoot[0], 0xab);
        assert.equal(seen.certificate.length, 4);
        return true;
      },
    });
    assert.equal(ok, true);
    assert.equal(posted, 1);
    assert.equal(anchoredHeight(), 4);
    assert.equal(statusHeight(), 4);
    const held = chainBoundSendGate();
    assert.equal(held.ok, false);
    if (!held.ok) assert.equal(held.error, CHALLENGE_WAIT);

    const next = new Uint8Array(32);
    next[0] = 0xcd;
    noteCertifiedBatch({ height: 5, nextRoot: next, certificate });
    assert.equal(chainBoundSendGate().ok, false);
    assert.equal(anchoredHeight(), 4);
  } finally {
    resetRootAnchorForTests();
  }
});

test("Gnosis and Chiado chain ids do not post", async () => {
  resetRootAnchorForTests();
  try {
    for (const chainId of ["100", "10200"]) {
      let calls = 0;
      const ok = await postCertifiedBatch(batch, {
        env: {
          LOK_CHAIN_ID: chainId,
          LOK_ROOT_ANCHOR: "0x" + "11".repeat(20),
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
    assert.equal(anchoredHeight(), null);
  } finally {
    resetRootAnchorForTests();
  }
});

test("chain-bound sends do not go out before the root is anchored", async () => {
  resetRootAnchorForTests();
  try {
    const mint = await serverMintCharacterFor("1", 1, "0x" + "ab".repeat(20), {
      LOK_DEV_SERVER_MINT: "1",
      LOK_CHAIN_RPC: "http://127.0.0.1:1",
      LOK_FACTORY: "0x" + "11".repeat(20),
      LOK_NFT: "0x" + "22".repeat(20),
      LOK_OWNER_KEY: "0x" + "33".repeat(32),
    });
    assert.equal(mint.ok, false);
    if (!mint.ok) assert.equal(mint.error, ANCHOR_WAIT);

    const ask = await openAskOnchain({
      listingId: "1",
      sellerTokenId: "1",
      itemId: "1",
      amount: "1",
      priceWei: "1",
      env: { LOK_CHAIN_RPC: "http://127.0.0.1:1", LOK_LISTING_KEY: "0x" + "44".repeat(32) },
    });
    assert.equal(ask.ok, false);
    if (!ask.ok) assert.equal(ask.error, ANCHOR_WAIT);

    const cancel = await chainPvpCancel("1", {
      LOK_CHAIN_RPC: "http://127.0.0.1:1",
      LOK_PVP_BOUNTY: "0x" + "55".repeat(20),
      LOK_LISTING_KEY: "0x" + "44".repeat(32),
    });
    assert.equal(cancel.ok, false);
    if (!cancel.ok) assert.equal(cancel.error, ANCHOR_WAIT);

    assert.equal(chainBoundSendGate().ok, false);
    const withdrawal = beginChainWithdrawal();
    assert.equal(withdrawal.ok, false);
    if (!withdrawal.ok) assert.equal(withdrawal.error, ANCHOR_WAIT);
    assert.equal(inGameWaitsForAnchor("play"), false);
    assert.equal(inGameWaitsForAnchor("movement"), false);
    assert.equal(inGameWaitsForAnchor("combat"), false);

    const claim = await chainPvpClaim("1", "2", "0x" + "ab".repeat(20), {
      LOK_CHAIN_RPC: "http://127.0.0.1:1",
      LOK_PVP_BOUNTY: "0x" + "55".repeat(20),
      LOK_LISTING_KEY: "0x" + "44".repeat(32),
    });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.error, ANCHOR_WAIT);
  } finally {
    resetRootAnchorForTests();
  }
});

test("owner, private, and listing keys do not post", async () => {
  resetRootAnchorForTests();
  try {
    const shared = "0x" + "11".repeat(32);
    const poster = "0x" + "22".repeat(32);
    const base = {
      LOK_CHAIN_ID: "31337",
      LOK_CHAIN_RPC: "http://127.0.0.1:9",
      LOK_ROOT_ANCHOR: "0x" + "33".repeat(20),
      LOK_ANCHOR_POSTER_KEY: shared,
    };
    for (const extra of [
      { LOK_OWNER_KEY: shared },
      { PRIVATE_KEY: shared },
      { LOK_LISTING_KEY: shared },
    ]) {
      const ok = await postCertifiedBatch(batch, { env: { ...base, ...extra } });
      assert.equal(ok, false);
    }
    const remote = await postCertifiedBatch(batch, {
      env: {
        LOK_CHAIN_ID: "31337",
        LOK_CHAIN_RPC: "http://example.com:8545",
        LOK_ROOT_ANCHOR: "0x" + "33".repeat(20),
        LOK_ANCHOR_POSTER_KEY: poster,
        LOK_OWNER_KEY: shared,
        PRIVATE_KEY: "0x" + "44".repeat(32),
        LOK_LISTING_KEY: "0x" + "55".repeat(32),
      },
    });
    assert.equal(remote, false);
    assert.equal(anchoredHeight(), null);
    assert.equal(statusHeight(), null);
  } finally {
    resetRootAnchorForTests();
  }
});

test("chain-bound sends wait one day after the anchor", async () => {
  resetRootAnchorForTests();
  try {
    assert.equal(CHALLENGE_DELAY_MS, 24 * 60 * 60 * 1000);
    let now = 1_700_000_000_000;
    setChallengeClockForTests(() => now);
    noteCertifiedBatch(batch);
    const posted = await postCertifiedBatch(batch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => true,
    });
    assert.equal(posted, true);
    assert.equal(anchoredHeight(), 4);
    assert.equal(statusHeight(), 4);

    const mintEnv = {
      LOK_DEV_SERVER_MINT: "1",
      LOK_CHAIN_RPC: "http://127.0.0.1:1",
      LOK_FACTORY: "0x" + "11".repeat(20),
      LOK_NFT: "0x" + "22".repeat(20),
      LOK_OWNER_KEY: "0x" + "33".repeat(32),
    };
    const escrowEnv = {
      LOK_CHAIN_RPC: "http://127.0.0.1:1",
      LOK_LISTING_KEY: "0x" + "44".repeat(32),
    };
    const bountyEnv = {
      LOK_CHAIN_RPC: "http://127.0.0.1:1",
      LOK_PVP_BOUNTY: "0x" + "55".repeat(20),
      LOK_LISTING_KEY: "0x" + "44".repeat(32),
    };

    async function sends() {
      return {
        mint: await serverMintCharacterFor("1", 1, "0x" + "ab".repeat(20), mintEnv),
        ask: await openAskOnchain({
          listingId: "1",
          sellerTokenId: "1",
          itemId: "1",
          amount: "1",
          priceWei: "1",
          env: escrowEnv,
        }),
        cancel: await chainPvpCancel("1", bountyEnv),
        claim: await chainPvpClaim("1", "2", "0x" + "ab".repeat(20), bountyEnv),
        withdrawal: beginChainWithdrawal(),
      };
    }

    const early = await sends();
    for (const result of [early.mint, early.ask, early.cancel, early.claim, early.withdrawal]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, CHALLENGE_WAIT);
    }
    assert.equal(inGameWaitsForAnchor("play"), false);
    assert.equal(inGameWaitsForAnchor("combat"), false);
    assert.equal(inGameWaitsForAnchor("movement"), false);
    assert.equal(inGameWaitsForAnchor("loot"), false);
    assert.equal(inGameWaitsForAnchor("tick"), false);
    const dir = mkdtempSync(join(tmpdir(), "lok-challenge-loot-"));
    const lok = LokWorld.open(dir, undefined, {});
    const spawned = lok.spawn("char-a", "Ada", 0);
    assert.equal(spawned.ok, true);
    if (spawned.ok) {
      assert.equal(lok.kill(spawned.tokenId, "1").ok, true);
      assert.equal(lok.lootDrop(spawned.tokenId, "7", "1", "1").ok, true);
    }
    const tick = submitOnSimTick(null, { ok: true, height: 4, nextRoot: root });
    assert.equal(tick.tickFailed, false);
    assert.equal(tick.status, "provisional");
    assert.equal(anchoredHeight(), 4);

    now += 60_000;
    const claimDelayFloor = chainBoundSendGate();
    assert.equal(claimDelayFloor.ok, false);
    if (!claimDelayFloor.ok) assert.equal(claimDelayFloor.error, CHALLENGE_WAIT);

    now += CHALLENGE_DELAY_MS - 60_000 - 1;
    const almost = chainBoundSendGate();
    assert.equal(almost.ok, false);
    if (!almost.ok) assert.equal(almost.error, CHALLENGE_WAIT);

    now += 1;
    assert.equal(chainBoundSendGate().ok, true);
    const open = await sends();
    assert.equal(open.withdrawal.ok, true);
    if (open.withdrawal.ok) assert.equal(open.withdrawal.submitted, false);
    for (const result of [open.mint, open.ask, open.cancel, open.claim]) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.notEqual(result.error, CHALLENGE_WAIT);
        assert.notEqual(result.error, ANCHOR_WAIT);
      }
    }

    const later = new Uint8Array(32);
    later[0] = 0xcd;
    const nextBatch: CertifiedBatch = { height: 5, nextRoot: later, certificate };
    noteCertifiedBatch(nextBatch);
    const unanchored = chainBoundSendGate();
    assert.equal(unanchored.ok, false);
    if (!unanchored.ok) assert.equal(unanchored.error, ANCHOR_WAIT);
    const nextPosted = await postCertifiedBatch(nextBatch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => true,
    });
    assert.equal(nextPosted, true);
    assert.equal(anchoredHeight(), 5);
    const restarted = chainBoundSendGate();
    assert.equal(restarted.ok, false);
    if (!restarted.ok) assert.equal(restarted.error, CHALLENGE_WAIT);
    now += CHALLENGE_DELAY_MS;
    assert.equal(chainBoundSendGate().ok, true);
  } finally {
    resetRootAnchorForTests();
  }
});

test("the sim tick does not wait for an anchor", () => {
  resetRootAnchorForTests();
  try {
    const nextRoot = new Uint8Array(32);
    nextRoot[0] = 0x11;
    const tick = submitOnSimTick(null, { ok: true, height: 1, nextRoot });
    assert.equal(tick.tickFailed, false);
    assert.equal(tick.status, "provisional");
    assert.equal(anchoredHeight(), null);
  } finally {
    resetRootAnchorForTests();
  }
});

/** Anvil account 1. Not the owner key, the private key, or the listing key. */
const ANCHOR_POSTER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

function tickIndexInputs(index: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(index), false);
  return out;
}

test(
  "anvil stores the certified character root and /status reports that height",
  { skip: !supportAnvilAvailable, timeout: 180_000 },
  async () => {
    resetRootAnchorForTests();
    let anvil: ThrowawayAnvil | undefined;
    try {
      anvil = await startThrowawayAnvil();
      const poster = privateKeyToAccount(ANCHOR_POSTER_KEY);
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
        {
          env: {
            LOK_OWNER_KEY: "",
            PRIVATE_KEY: "",
            LOK_LISTING_KEY: "",
          },
        },
      );
      const deployed = /ANCHOR\s+(0x[a-fA-F0-9]{40})/.exec(out);
      assert.ok(deployed, out.slice(-800));
      const address = deployed[1] as Hex;

      const dir = mkdtempSync(join(tmpdir(), "lok-anchor-world-"));
      const lok = LokWorld.open(dir, undefined, {});
      const spawned = lok.spawn("char-a", "Ada", 0);
      assert.equal(spawned.ok, true);
      const characterRoot = lok.characterRootTreeRoot();
      const provisional = provisionalChainLink(new Uint8Array(32), tickIndexInputs(2));
      assert.equal(characterRoot.length, 32);
      assert.notDeepEqual(characterRoot, new Uint8Array(32));
      assert.notDeepEqual(characterRoot, provisional);

      const certified: CertifiedBatch = {
        height: 4,
        nextRoot: characterRoot,
        certificate,
      };
      noteCertifiedBatch(certified);
      assert.equal(anchoredHeight(), null);
      assert.equal(statusHeight(), null);
      assert.equal(chainBoundSendGate().ok, false);
      assert.equal(inGameWaitsForAnchor("movement"), false);
      const tick = submitOnSimTick(null, { ok: true, height: 4, nextRoot: characterRoot });
      assert.equal(tick.tickFailed, false);
      assert.equal(anchoredHeight(), null);

      const chain = {
        id: 31337,
        name: "anvil",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [anvil.rpc] } },
      };
      const pub = createPublicClient({ chain, transport: http(anvil.rpc) });
      const nonceBefore = await pub.getTransactionCount({ address: poster.address });
      const forbidden = await postCertifiedBatch(certified, {
        env: {
          LOK_CHAIN_ID: "31337",
          LOK_CHAIN_RPC: anvil.rpc,
          LOK_ROOT_ANCHOR: address,
          LOK_ANCHOR_POSTER_KEY: "0x" + "11".repeat(32),
          LOK_OWNER_KEY: "0x" + "11".repeat(32),
          PRIVATE_KEY: "0x" + "22".repeat(32),
          LOK_LISTING_KEY: "0x" + "33".repeat(32),
        },
      });
      assert.equal(forbidden, false);
      assert.equal(anchoredHeight(), null);
      assert.equal(await pub.getTransactionCount({ address: poster.address }), nonceBefore);

      let now = 1_700_000_000_000;
      setChallengeClockForTests(() => now);
      const posted = await postCertifiedBatch(certified, {
        env: {
          LOK_CHAIN_ID: "31337",
          LOK_CHAIN_RPC: anvil.rpc,
          LOK_ROOT_ANCHOR: address,
          LOK_ANCHOR_POSTER_KEY: ANCHOR_POSTER_KEY,
          LOK_OWNER_KEY: "0x" + "11".repeat(32),
          PRIVATE_KEY: "0x" + "22".repeat(32),
          LOK_LISTING_KEY: "0x" + "33".repeat(32),
        },
      });
      assert.equal(posted, true);
      assert.equal(anchoredHeight(), 4);
      assert.equal(statusHeight(), 4);
      const held = chainBoundSendGate();
      assert.equal(held.ok, false);
      if (!held.ok) assert.equal(held.error, CHALLENGE_WAIT);
      assert.equal(inGameWaitsForAnchor("loot"), false);
      assert.equal(inGameWaitsForAnchor("combat"), false);
      const early = beginChainWithdrawal();
      assert.equal(early.ok, false);
      now += CHALLENGE_DELAY_MS;
      assert.equal(chainBoundSendGate().ok, true);
      const withdrawal = beginChainWithdrawal();
      assert.equal(withdrawal.ok, true);
      if (withdrawal.ok) assert.equal(withdrawal.submitted, false);
      assert.equal(await pub.getTransactionCount({ address: poster.address }), nonceBefore + 1);

      const abi = [
        {
          type: "function",
          name: "isAnchored",
          stateMutability: "view",
          inputs: [
            { name: "height", type: "uint64" },
            { name: "nextRoot", type: "bytes32" },
          ],
          outputs: [{ type: "bool" }],
        },
      ] as const;
      assert.equal(
        await pub.readContract({
          address,
          abi,
          functionName: "isAnchored",
          args: [4n, toHex(characterRoot)],
        }),
        true,
      );
      assert.equal(
        await pub.readContract({
          address,
          abi,
          functionName: "isAnchored",
          args: [4n, toHex(provisional)],
        }),
        false,
      );

      const ask = await openAskOnchain({
        listingId: "1",
        sellerTokenId: "1",
        itemId: "1",
        amount: "1",
        priceWei: "1",
        env: { LOK_CHAIN_RPC: anvil.rpc },
      });
      assert.equal(ask.ok, false);
      if (!ask.ok) {
        assert.notEqual(ask.error, ANCHOR_WAIT);
        assert.notEqual(ask.error, CHALLENGE_WAIT);
      }
      assert.equal(await pub.getTransactionCount({ address: poster.address }), nonceBefore + 1);
    } finally {
      anvil?.stop();
      resetRootAnchorForTests();
    }
  },
);

test("epoch xDAI stays within 10% of the posted slashable bonds", async () => {
  resetRootAnchorForTests();
  try {
    assert.equal(EPOCH_MS, 10_000);
    assert.equal(epochXdaiCapWei(0n), 0n);
    assert.equal(epochXdaiCapWei(19n), 1n);
    assert.equal(epochXdaiCapWei(100n), 10n);

    let now = 1_700_000_000_000;
    setChallengeClockForTests(() => now);
    // The test supplies the posted total. It is not a bond schedule.
    setPostedSlashableBonds(100n);
    const beforeAnchor = chainBoundXdaiSend("mint", 1n);
    assert.equal(beforeAnchor.ok, false);
    if (!beforeAnchor.ok) assert.equal(beforeAnchor.error, ANCHOR_WAIT);
    assert.equal(epochSettledXdai(), 0n);

    noteCertifiedBatch(batch);
    const posted = await postCertifiedBatch(batch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => true,
    });
    assert.equal(posted, true);
    const duringDelay = chainBoundXdaiSend("escrow", 1n);
    assert.equal(duringDelay.ok, false);
    if (!duringDelay.ok) assert.equal(duringDelay.error, CHALLENGE_WAIT);
    assert.equal(epochSettledXdai(), 0n);
    now += CHALLENGE_DELAY_MS - 1;
    const almost = beginChainWithdrawal(1n);
    assert.equal(almost.ok, false);
    if (!almost.ok) assert.equal(almost.error, CHALLENGE_WAIT);
    now += 1;
    assert.equal(chainBoundSendGate().ok, true);

    assert.equal(chainBoundXdaiSend("mint", 4n).ok, true);
    assert.equal(chainBoundXdaiSend("escrow", 3n).ok, true);
    assert.equal(chainBoundXdaiSend("bounty", 3n).ok, true);
    assert.equal(epochSettledXdai(), 10n);
    const atCap = chainBoundXdaiSend("withdrawal", 1n);
    assert.equal(atCap.ok, false);
    if (!atCap.ok) assert.equal(atCap.error, EPOCH_XDAI_CAP_REFUSAL);
    const withdrawal = beginChainWithdrawal(1n);
    assert.equal(withdrawal.ok, false);
    if (!withdrawal.ok) assert.equal(withdrawal.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(epochSettledXdai(), 10n);
    const plainHold = beginChainWithdrawal();
    assert.equal(plainHold.ok, true);
    assert.equal(epochSettledXdai(), 10n);

    const dir = mkdtempSync(join(tmpdir(), "lok-epoch-gold-"));
    const lok = LokWorld.open(dir, undefined, {});
    const spawned = lok.spawn("char-a", "Ada", 0);
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    assert.equal(lok.goldEarn(spawned.tokenId, "quest", "100", 1).ok, true);
    assert.equal(lok.goldOf(spawned.tokenId), "100");
    assert.equal(lok.kill(spawned.tokenId, "1").ok, true);
    assert.equal(lok.lootDrop(spawned.tokenId, "7", "1", "1").ok, true);
    assert.equal(lok.dropOf(spawned.tokenId, "7"), "1");
    assert.equal(lok.itemOf(spawned.tokenId, "7"), "0");
    assert.equal(lok.harvest(spawned.tokenId, "ore", "2").ok, true);
    assert.equal(lok.harvestOf(spawned.tokenId, "ore"), "2");
    assert.equal(epochSettledXdai(), 10n);
    assert.equal(chainBoundXdaiSend("escrow", 1n).ok, false);

    now += EPOCH_MS;
    assert.equal(epochSettledXdai(), 0n);
    const nextEpoch = beginChainWithdrawal(10n);
    assert.equal(nextEpoch.ok, true);
    if (nextEpoch.ok) assert.equal(nextEpoch.submitted, false);
    assert.equal(epochSettledXdai(), 10n);
    setPostedSlashableBonds(50n);
    assert.equal(epochXdaiCapWei(), 5n);
    const shrunk = chainBoundXdaiSend("mint", 1n);
    assert.equal(shrunk.ok, false);
    if (!shrunk.ok) assert.equal(shrunk.error, EPOCH_XDAI_CAP_REFUSAL);

    now += EPOCH_MS;
    setPostedSlashableBonds(0n);
    assert.equal(epochXdaiCapWei(), 0n);
    const zeroBonds = chainBoundXdaiSend("bounty", 1n);
    assert.equal(zeroBonds.ok, false);
    if (!zeroBonds.ok) assert.equal(zeroBonds.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(epochSettledXdai(), 0n);
    assert.equal(lok.goldEarn(spawned.tokenId, "quest", "1", 1).ok, true);
    assert.equal(lok.goldOf(spawned.tokenId), "101");
    assert.equal(lok.lootDrop(spawned.tokenId, "7", "1", "1").ok, true);
    assert.equal(lok.dropOf(spawned.tokenId, "7"), "2");
    assert.equal(lok.harvest(spawned.tokenId, "ore", "1").ok, true);
    assert.equal(lok.harvestOf(spawned.tokenId, "ore"), "3");
    assert.equal(epochSettledXdai(), 0n);

    setPostedSlashableBonds(100n);
    const escrowEnv = {
      LOK_CHAIN_RPC: "http://127.0.0.1:1",
      LOK_LISTING_KEY: "0x" + "44".repeat(32),
    };
    const askOpen = await openAskOnchain({
      listingId: "1",
      sellerTokenId: "1",
      itemId: "1",
      amount: "1",
      priceWei: "10",
      env: escrowEnv,
    });
    assert.equal(askOpen.ok, false);
    if (!askOpen.ok) assert.notEqual(askOpen.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(epochSettledXdai(), 0n);

    let buyBroadcasts = 0;
    const buy = (priceWei: bigint) =>
      chainBuyAsk({
        priceWei,
        broadcast: async () => {
          buyBroadcasts += 1;
        },
      });

    assert.equal(chainBoundXdaiSend("withdrawal", 10n).ok, true);
    assert.equal(epochSettledXdai(), 10n);
    const fillHeld = await buy(10n);
    assert.equal(fillHeld.ok, false);
    if (!fillHeld.ok) assert.equal(fillHeld.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(buyBroadcasts, 0);
    assert.equal(epochSettledXdai(), 10n);

    const bountyOver = admitBountyPayout(BigInt(PVP_BOUNTY_WEI));
    assert.equal(bountyOver.ok, false);
    if (!bountyOver.ok) assert.equal(bountyOver.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(epochSettledXdai(), 10n);

    const settledAt = now;
    observeEscrowSettlement("0xfill-held", 10n, settledAt);
    assert.equal(epochSettledXdai(), 20n);
    const secondSend = chainBoundXdaiSend("mint", 1n);
    assert.equal(secondSend.ok, false);
    if (!secondSend.ok) assert.equal(secondSend.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(buyBroadcasts, 0);

    now += EPOCH_MS;
    assert.equal(epochSettledXdai(), 0n);
    observeEscrowSettlement("0xfill-held", 10n, now);
    assert.equal(epochSettledXdai(), 0n);
    assert.equal(epochSettledXdai(settledAt), 20n);
    assert.equal(buyBroadcasts, 0);

    const reservedAt = now;
    const reserved = admitBountyPayout(10n);
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    now += EPOCH_MS;
    const paidEpoch = pinEpochCharge(10n, reserved.epoch, now, "bounty-receipt-roll");
    assert.equal(paidEpoch, epochIndex(now));
    assert.equal(epochSettledXdai(), 10n);
    assert.equal(epochSettledXdai(reservedAt), 0n);
    const secondPay = admitBountyPayout(10n);
    assert.equal(secondPay.ok, false);
    if (!secondPay.ok) assert.equal(secondPay.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(epochSettledXdai(), 10n);
    assert.equal(epochSettledXdai(settledAt), 20n);
  } finally {
    resetRootAnchorForTests();
  }
});

const ONE_XDAI = 10n ** 18n;

function cancelEnv(): NodeJS.ProcessEnv {
  return {
    LOK_CHAIN_ID: "31337",
    LOK_CHAIN_RPC: "http://127.0.0.1:1",
    LOK_PVP_BOUNTY: "0x" + "55".repeat(20),
    LOK_LISTING_KEY: "0x" + "44".repeat(32),
  };
}

/** Records JSON-RPC bodies. A refused cap must not reach this. */
async function rpcBodies(run: () => Promise<void>): Promise<string[]> {
  const calls: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    calls.push(typeof init?.body === "string" ? init.body : "");
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stopped" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await run();
    return calls;
  } finally {
    globalThis.fetch = prev;
  }
}

test("bounty cancel and buyAsk do not broadcast outside the epoch cap", async () => {
  resetRootAnchorForTests();
  try {
    await allowEpochSettlementForTests(0n);
    let buyBroadcasts = 0;
    const buy = (priceWei: bigint) =>
      chainBuyAsk({
        priceWei,
        broadcast: async () => {
          buyBroadcasts += 1;
        },
      });

    const zeroCancel = await rpcBodies(async () => {
      const cancel = await chainPvpCancel("1", cancelEnv());
      assert.equal(cancel.ok, false);
      if (!cancel.ok) assert.equal(cancel.error, EPOCH_XDAI_CAP_REFUSAL);
    });
    assert.equal(zeroCancel.length, 0);
    const zeroBuy = await buy(ONE_XDAI);
    assert.equal(zeroBuy.ok, false);
    if (!zeroBuy.ok) assert.equal(zeroBuy.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(buyBroadcasts, 0);
    assert.equal(epochSettledXdai(), 0n);

    await allowEpochSettlementForTests(10n * ONE_XDAI);
    assert.equal(epochXdaiCapWei(), ONE_XDAI);
    const admittedCancel = await rpcBodies(async () => {
      const cancel = await chainPvpCancel("1", cancelEnv());
      assert.equal(cancel.ok, false);
      if (!cancel.ok) assert.notEqual(cancel.error, EPOCH_XDAI_CAP_REFUSAL);
    });
    assert.ok(admittedCancel.length > 0);
    assert.equal(epochSettledXdai(), 0n);

    assert.equal(chainBoundXdaiSend("mint", ONE_XDAI).ok, true);
    const overCancel = await rpcBodies(async () => {
      const cancel = await chainPvpCancel("1", cancelEnv());
      assert.equal(cancel.ok, false);
      if (!cancel.ok) assert.equal(cancel.error, EPOCH_XDAI_CAP_REFUSAL);
    });
    assert.equal(overCancel.length, 0);
    const overBuy = await buy(1n);
    assert.equal(overBuy.ok, false);
    if (!overBuy.ok) assert.equal(overBuy.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(buyBroadcasts, 0);
    assert.equal(epochSettledXdai(), ONE_XDAI);

    await allowEpochSettlementForTests(100n);
    const room = await buy(10n);
    assert.equal(room.ok, true);
    assert.equal(buyBroadcasts, 1);
    const past = await buy(1n);
    assert.equal(past.ok, false);
    if (!past.ok) assert.equal(past.error, EPOCH_XDAI_CAP_REFUSAL);
    assert.equal(buyBroadcasts, 1);
    assert.equal(epochSettledXdai(), 10n);
  } finally {
    resetRootAnchorForTests();
  }
});

test("boot records LOK_POSTED_SLASHABLE_BONDS and a later unset boot keeps them", async () => {
  resetRootAnchorForTests();
  const dir = mkdtempSync(join(tmpdir(), "lok-posted-bonds-"));
  try {
    let now = 1_700_000_000_000;
    setChallengeClockForTests(() => now);
    noteCertifiedBatch(batch);
    const posted = await postCertifiedBatch(batch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => true,
    });
    assert.equal(posted, true);
    now += CHALLENGE_DELAY_MS;
    const half = 5n * ONE_XDAI;
    configureEpochLedger(dir);
    recordPostedSlashableBonds({
      LOK_POSTED_SLASHABLE_BONDS: "ghost:0, host-a:" + half.toString() + ", host-b:" + half.toString(),
    });
    assert.equal(postedSlashableBonds(), 10n * ONE_XDAI);
    assert.equal(epochXdaiCapWei(), ONE_XDAI);
    assert.equal(chainBoundXdaiSend("mint", ONE_XDAI).ok, true);
    const over = chainBoundXdaiSend("mint", 1n);
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.error, EPOCH_XDAI_CAP_REFUSAL);

    restartEpochLedger();
    configureEpochLedger(dir);
    recordPostedSlashableBonds({});
    assert.equal(postedSlashableBonds(), 10n * ONE_XDAI);
    assert.equal(epochSettledXdai(), ONE_XDAI);
    assert.equal(chainBoundXdaiSend("mint", 1n).ok, false);
    assert.equal(inGameWaitsForAnchor("tick"), false);
    assert.equal(inGameWaitsForAnchor("combat"), false);
    assert.equal(votingReplica("host-a")?.amountWei, half);
    assert.equal(votingReplica("host-b")?.amountWei, half);
  } finally {
    resetBondedAdmissionForTests();
    resetRootAnchorForTests();
  }
});

test("server boot admits LOK_POSTED_SLASHABLE_BONDS into the voting set", () => {
  resetRootAnchorForTests();
  resetBondedAdmissionForTests();
  const dir = mkdtempSync(join(tmpdir(), "lok-boot-voting-"));
  const calls: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    calls.push(typeof init?.body === "string" ? init.body : "");
    return new Response("refused", { status: 500 });
  }) as typeof fetch;
  try {
    configureEpochLedger(dir);
    const listing = PINNED_GNOSIS_LISTING_ADDRESS;
    recordPostedSlashableBonds({
      LOK_POSTED_SLASHABLE_BONDS:
        "ghost:0, replica-a:-1, " + listing + ":10, " + listing.slice(2) + ":4",
    });
    assert.equal(votingSet().length, 0);
    assert.equal(postedSlashableBonds(), 0n);
    assert.equal(postedSlashableBond("ghost"), 0n);
    assert.equal(postedSlashableBond("replica-a"), 0n);
    assert.equal(postedSlashableBond(listing), 0n);
    assert.equal(votingReplica(listing), null);
    assert.equal(votingSetCommitThreshold(), null);

    const amount = 123456789012345678901234567890n;
    const posted = ["replica-a:" + amount.toString()];
    for (let i = 1; i <= 6; i += 1) posted.push("replica-" + i + ":" + String(i));
    recordPostedSlashableBonds({ LOK_POSTED_SLASHABLE_BONDS: posted.join(",") });
    assert.equal(votingSet().length, 7);
    assert.deepEqual(votingReplica("replica-a"), { id: "replica-a", amountWei: amount });
    assert.equal(postedSlashableBond("replica-a"), amount);
    assert.equal(postedSlashableBonds(), amount + 21n);
    assert.equal(votingReplica(listing), null);
    assert.equal(votingSetCommitThreshold(), 5);
    assert.deepEqual(registryAdmin(), {
      registryOwner: "gnosis-safe",
      slashingAdmin: "gnosis-safe",
      rulesetProposer: "gnosis-safe",
    });

    const tick = submitOnSimTick(null, { ok: true, height: 9, nextRoot: root });
    assert.equal(tick.tickFailed, false);
    assert.equal(tick.status, "provisional");
    assert.equal(tick.blob, null);
    assert.equal(calls.length, 0);
    assert.equal(inGameWaitsForAnchor("tick"), false);
  } finally {
    globalThis.fetch = prev;
    resetBondedAdmissionForTests();
    resetRootAnchorForTests();
  }
});

test("a boot with no posted bond refuses a positive chain send", async () => {
  resetRootAnchorForTests();
  const dir = mkdtempSync(join(tmpdir(), "lok-no-bonds-"));
  try {
    let now = 1_700_000_000_000;
    setChallengeClockForTests(() => now);
    noteCertifiedBatch(batch);
    const posted = await postCertifiedBatch(batch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => true,
    });
    assert.equal(posted, true);
    now += CHALLENGE_DELAY_MS;
    configureEpochLedger(dir);
    recordPostedSlashableBonds({});
    assert.equal(postedSlashableBonds(), 0n);
    const refused = chainBoundXdaiSend("escrow", 1n);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, EPOCH_XDAI_CAP_REFUSAL);
    recordPostedSlashableBonds({ LOK_POSTED_SLASHABLE_BONDS: "" });
    assert.equal(postedSlashableBonds(), 0n);
    assert.equal(chainBoundXdaiSend("bounty", 1n).ok, false);
  } finally {
    resetRootAnchorForTests();
  }
});

test("a restart keeps posted bonds and does not grant another epoch cap", async () => {
  resetRootAnchorForTests();
  const dir = mkdtempSync(join(tmpdir(), "lok-epoch-ledger-"));
  try {
    let now = 1_700_000_000_000;
    setChallengeClockForTests(() => now);
    noteCertifiedBatch(batch);
    const posted = await postCertifiedBatch(batch, {
      env: { LOK_CHAIN_ID: "31337" },
      poster: async () => true,
    });
    assert.equal(posted, true);
    now += CHALLENGE_DELAY_MS;
    configureEpochLedger(dir);
    setPostedSlashableBonds(10n * ONE_XDAI);
    assert.equal(epochXdaiCapWei(), ONE_XDAI);
    assert.equal(chainBoundXdaiSend("mint", ONE_XDAI).ok, true);
    assert.equal(admitBountyPayout(1n).ok, false);

    restartEpochLedger();
    assert.equal(postedSlashableBonds(), 10n * ONE_XDAI);
    assert.equal(epochSettledXdai(), ONE_XDAI);
    const secondMint = chainBoundXdaiSend("mint", 1n);
    assert.equal(secondMint.ok, false);
    if (!secondMint.ok) assert.equal(secondMint.error, EPOCH_XDAI_CAP_REFUSAL);
    const secondClaim = admitBountyPayout(ONE_XDAI);
    assert.equal(secondClaim.ok, false);
    if (!secondClaim.ok) assert.equal(secondClaim.error, EPOCH_XDAI_CAP_REFUSAL);

    now += EPOCH_MS;
    restartEpochLedger();
    assert.equal(postedSlashableBonds(), 10n * ONE_XDAI);
    assert.equal(epochSettledXdai(), 0n);
    assert.equal(chainBoundXdaiSend("mint", ONE_XDAI).ok, true);
    assert.equal(chainBoundXdaiSend("bounty", 1n).ok, false);
    assert.equal(inGameWaitsForAnchor("tick"), false);
    assert.equal(inGameWaitsForAnchor("combat"), false);
  } finally {
    resetRootAnchorForTests();
  }
});
});
