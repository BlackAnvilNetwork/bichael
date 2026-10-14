/**
 * Tests for mainnet self-audit fixes (PR #212 @ a88c275): C-1, H-1, H-2, M-1..M-7, lows.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  GNOSIS_DRY_RUN_ADDRESSES,
  findDryRunEnvHits,
  isDryRunAddress,
  dryRunDeployAllowed,
} from "./dry-run-denylist";
import {
  GLOBAL_LISTING_TX_MAX_PER_HOUR,
  LIST_MAX_PER_CHAR_PER_HOUR,
  MIN_LISTING_LIFETIME_MS,
  consumeCancelBudget,
  consumeGlobalListingTxBudget,
  consumeListBudget,
  listingMinLifetimeOk,
  maybeAlertListingLowBalance,
  noteListingOpened,
  resetListRateForTests,
} from "./lok-list-rate";
import { LokWorld } from "./lok-world";
import { resetNftOwnerCacheForTests, sessionOwnsCharacter } from "./nft-owner-cache";
import { decodeErc721Transfer, ERC721_TRANSFER_TOPIC } from "./nft-transfer-ask-cancel";
import { ASK_CANCELLED_TOPIC } from "./ah-escrow";
import {
  ASK_CLOSED_SELECTOR,
  CANCEL_FINALITY_TIMEOUT_MS,
  cancelReceiptProvesAskCancelled,
  decideRecordedCancelReceipt,
  resetListingCancelLocksForTests,
  withListingCancelLock,
} from "./ah-escrow-tx";
import { recentOpsAlerts, resetOpsAlertsForTests } from "./ops-log";
import {
  CancelTxRecordStore,
  resetCancelTxRecordForTests,
} from "./cancel-tx-record";
import {
  MIGRATE_CONCURRENCY,
  MIGRATE_RPC_TIMEOUT_MS,
  migrateCharacterWalletsToNftOwners,
} from "./nft-wallet-migrate";
import { isProductionOpsEnv } from "./ops-health";
import { redactRpcText } from "./ops-redact";
import {
  OpenAskPendingStore,
  resetOpenAskPendingForTests,
} from "./open-ask-pending";
import {
  assertProductionEnvShape,
  isProductionSettlementChain,
} from "./production-boot";
import { applySettlementDeployFile } from "./settlement-deploy";
import { authMessage, clientAddress } from "./wallet-auth";
import {
  WS_MAX_PAYLOAD,
  consumeWsMessage,
  noteWsConnect,
  noteWsDisconnect,
  resetWsLimitsForTests,
  wsIpExemptFromCaps,
  WS_MSG_LIMIT,
} from "./ws-limits";
import { keccak256, toBytes } from "viem";

function padAddr(addr: string): string {
  return "0x" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}
function padId(id: bigint): string {
  return "0x" + id.toString(16).padStart(64, "0");
}

describe("C-1 NFT owner cache + rebind", () => {
  it("sessionOwnsCharacter denies non-owner from cache", async () => {
    resetNftOwnerCacheForTests();
    const dir = mkdtempSync(join(tmpdir(), "nft-own-"));
    const { nftOwnerCache } = await import("./nft-owner-cache");
    nftOwnerCache(dir).set("7", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 100);
    const denied = await sessionOwnsCharacter(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "7",
      { dataDir: dir, env: {}, preferLive: false },
    );
    assert.equal(denied.ok, false);
    const allowed = await sessionOwnsCharacter(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "7",
      { dataDir: dir, env: {}, preferLive: false },
    );
    assert.equal(allowed.ok, true);
  });

  it("rebindWallet overwrites write-once bind", () => {
    const dir = mkdtempSync(join(tmpdir(), "rebind-"));
    const lok = LokWorld.open(dir);
    const spawned = lok.spawn("Hero", "Hero", 0, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(spawned.ok, true);
    const token = lok.boundChars()[0]!.tokenId;
    const charId = lok.boundChars()[0]!.charId;
    // write-once bind is a no-op when already set
    lok.bindWallet(charId, "0xcccccccccccccccccccccccccccccccccccccccc");
    assert.equal(lok.charsForWallet("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").length, 1);
    const reb = lok.rebindWallet(charId, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(reb.ok, true);
    if (reb.ok) assert.equal(reb.previous, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(lok.charsForWallet("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").length, 0);
    assert.equal(lok.charsForWallet("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").length, 1);
    assert.equal(lok.charByTokenId(token)?.wallet, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("decodeErc721Transfer includes blockNumber", () => {
    const xfer = decodeErc721Transfer({
      topics: [
        ERC721_TRANSFER_TOPIC,
        padAddr("0x00000000000000000000000000000000000000aa"),
        padAddr("0x00000000000000000000000000000000000000bb"),
        padId(7n),
      ],
      blockNumber: "0x2a",
    });
    assert.ok(xfer);
    assert.equal(xfer!.blockNumber, "42");
  });
});

describe("H-1 list/cancel rate limits", () => {
  it("enforces per-character list budget and min cancel lifetime", () => {
    resetListRateForTests();
    const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (let i = 0; i < LIST_MAX_PER_CHAR_PER_HOUR; i++) {
      assert.equal(consumeListBudget({ charId: "c1", wallet }).ok, true);
    }
    assert.equal(consumeListBudget({ charId: "c1", wallet }).ok, false);
    // other character still ok
    assert.equal(consumeListBudget({ charId: "c2", wallet }).ok, true);

    noteListingOpened("99", 1_000_000);
    const early = listingMinLifetimeOk("99", 1_000_000 + MIN_LISTING_LIFETIME_MS - 1);
    assert.equal(early.ok, false);
    const ok = listingMinLifetimeOk("99", 1_000_000 + MIN_LISTING_LIFETIME_MS);
    assert.equal(ok.ok, true);
    assert.equal(consumeCancelBudget({ charId: "c1", wallet }).ok, true);
  });

  it("alerts on listing low balance", async () => {
    resetListRateForTests();
    const alerted = await maybeAlertListingLowBalance({
      balanceWei: 1n,
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { LOK_LISTING_LOW_BALANCE_WEI: "1000" },
      now: Date.now(),
    });
    assert.equal(alerted, true);
    const deduped = await maybeAlertListingLowBalance({
      balanceWei: 1n,
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      env: { LOK_LISTING_LOW_BALANCE_WEI: "1000" },
      now: Date.now() + 100,
    });
    assert.equal(deduped, false);
  });

  it("enforces a persisted global LISTING tx budget", () => {
    resetListRateForTests();
    const dir = mkdtempSync(join(tmpdir(), "list-budget-"));
    const now = 5_000_000;
    for (let i = 0; i < GLOBAL_LISTING_TX_MAX_PER_HOUR; i++) {
      assert.equal(consumeGlobalListingTxBudget({ now, dataDir: dir }).ok, true);
    }
    assert.equal(consumeGlobalListingTxBudget({ now, dataDir: dir }).ok, false);
    // New hour window
    assert.equal(
      consumeGlobalListingTxBudget({ now: now + 3_600_000 + 1, dataDir: dir }).ok,
      true,
    );
  });

  it("per-char list/cancel budgets do not charge the global LISTING budget", () => {
    resetListRateForTests();
    const dir = mkdtempSync(join(tmpdir(), "list-budget-sep-"));
    const now = 6_000_000;
    const wallet = "0xcccccccccccccccccccccccccccccccccccccccc";
    for (let i = 0; i < LIST_MAX_PER_CHAR_PER_HOUR; i++) {
      assert.equal(consumeListBudget({ charId: "sep", wallet, now }).ok, true);
    }
    // Global budget still fully available (charged only at broadcast).
    for (let i = 0; i < GLOBAL_LISTING_TX_MAX_PER_HOUR; i++) {
      assert.equal(consumeGlobalListingTxBudget({ now, dataDir: dir }).ok, true);
    }
    assert.equal(consumeGlobalListingTxBudget({ now, dataDir: dir }).ok, false);
  });
});

describe("MED cancel finality + AskClosed selector", () => {
  it("AskClosed selector is keccak(AskClosed())[0:4]", () => {
    const expected = keccak256(toBytes("AskClosed()")).slice(0, 10);
    assert.equal(ASK_CLOSED_SELECTOR, "0x756918b7");
    assert.equal(ASK_CLOSED_SELECTOR, expected);
  });

  it("cancel finality timeout covers ~30 Gnosis blocks", () => {
    assert.ok(CANCEL_FINALITY_TIMEOUT_MS >= 900_000);
  });

  it("records server cancelAsk hashes for retry release", () => {
    resetCancelTxRecordForTests();
    const dir = mkdtempSync(join(tmpdir(), "cancel-tx-"));
    const store = new CancelTxRecordStore(join(dir, "cancel-ask-txs.json"));
    const hash = "0x" + "ab".repeat(32);
    store.set("77", hash);
    assert.equal(store.get("77")?.hash, hash);
    store.clear("77");
    assert.equal(store.get("77"), null);
  });

  it("reverted cancelAsk receipt must not release log escrow on retry", () => {
    const listingId = "99";
    const topic1 = ("0x" + BigInt(listingId).toString(16).padStart(64, "0")) as `0x${string}`;
    const escrow = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    const reverted = {
      status: "reverted" as const,
      logs: [
        {
          address: escrow,
          topics: [ASK_CANCELLED_TOPIC as `0x${string}`, topic1],
          data: "0x" as `0x${string}`,
        },
      ],
    };
    assert.equal(cancelReceiptProvesAskCancelled(reverted, listingId, escrow), false);
    assert.equal(decideRecordedCancelReceipt(reverted, listingId, escrow).decision, "notOurCancel");

    const successNoEvent = {
      status: "success" as const,
      logs: [] as { address: string; topics: `0x${string}`[]; data: `0x${string}` }[],
    };
    assert.equal(cancelReceiptProvesAskCancelled(successNoEvent, listingId, escrow), false);
    assert.equal(
      decideRecordedCancelReceipt(successNoEvent, listingId, escrow).decision,
      "notOurCancel",
    );

    const cancelled = {
      status: "success" as const,
      logs: [
        {
          address: escrow,
          topics: [ASK_CANCELLED_TOPIC as `0x${string}`, topic1],
          data: "0x" as `0x${string}`,
        },
      ],
    };
    assert.equal(cancelReceiptProvesAskCancelled(cancelled, listingId, escrow), true);
    assert.equal(
      decideRecordedCancelReceipt(cancelled, listingId, escrow).decision,
      "serverCancelled",
    );

    // Simulate revert → clear record → retry must not treat as serverCancelled.
    resetCancelTxRecordForTests();
    const dir = mkdtempSync(join(tmpdir(), "cancel-rev-"));
    const store = new CancelTxRecordStore(join(dir, "cancel-ask-txs.json"));
    store.set(listingId, "0x" + "cd".repeat(32));
    assert.ok(store.get(listingId));
    if (decideRecordedCancelReceipt(reverted, listingId, escrow).decision === "notOurCancel") {
      store.clear(listingId);
    }
    assert.equal(store.get(listingId), null, "reverted cancel clears record; retry cannot release");
  });
});

describe("ops auth + migration lows", () => {
  it("treats Chiado like prod for ops auth", () => {
    assert.equal(isProductionOpsEnv({ NETWORK: "chiado", LOK_CHAIN_ID: "10200" }), true);
    assert.equal(isProductionOpsEnv({ LOK_CHAIN_ID: "10200" }), true);
    assert.equal(isProductionOpsEnv({ NETWORK: "anvil", LOK_CHAIN_ID: "31337" }), false);
  });

  it("scrubs RPC URLs from ops error text", () => {
    const scrubbed = redactRpcText(
      "RPC at https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY_HERE failed",
    );
    assert.match(scrubbed, /https:\/\/eth-mainnet\.g\.alchemy\.com/);
    assert.doesNotMatch(scrubbed, /SECRET_KEY/);
  });

  it("boot migration uses bounded concurrency and RPC timeout", async () => {
    assert.ok(MIGRATE_CONCURRENCY >= 2);
    assert.ok(MIGRATE_RPC_TIMEOUT_MS <= 15_000);
    let maxInFlight = 0;
    let inFlight = 0;
    const chars = Array.from({ length: 20 }, (_, i) => ({
      charId: "c" + i,
      tokenId: String(i + 1),
      name: "Char" + i,
      job: 0,
      wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
    const lok = {
      boundChars: () => chars,
      rebindWallet: (_charId: string, _wallet: string) => ({
        ok: true as const,
        previous: chars[0]!.wallet,
      }),
    };
    await migrateCharacterWalletsToNftOwners(lok, {
      concurrency: 4,
      rpcTimeoutMs: 200,
      readOwner: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { ok: true as const, holder: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
      },
    });
    assert.ok(maxInFlight <= 4, "concurrency capped, got " + maxInFlight);
    assert.ok(maxInFlight >= 2, "actually parallelized");
  });

  it("alerts when boot migration has ownerOf errors", async () => {
    resetOpsAlertsForTests();
    const lok = {
      boundChars: () => [
        {
          charId: "c1",
          tokenId: "1",
          name: "Char1",
          job: 0,
          wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      rebindWallet: (_charId: string, _wallet: string) => ({ ok: true as const, previous: null }),
    };
    const out = await migrateCharacterWalletsToNftOwners(lok, {
      readOwner: async () => ({ ok: false as const, error: "rpc down" }),
    });
    assert.equal(out.errors.length, 1);
    const alerts = recentOpsAlerts();
    assert.ok(
      alerts.some((a) => a.event === "ops" && /ownerOf errors/i.test(a.msg)),
      "expected migration error alert",
    );
  });

  it("serializes concurrent cancel/reclaim for the same listing", async () => {
    resetListingCancelLocksForTests();
    const order: string[] = [];
    const a = withListingCancelLock("42", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("a-end");
      return 1;
    });
    const b = withListingCancelLock("42", async () => {
      order.push("b-start");
      order.push("b-end");
      return 2;
    });
    const c = withListingCancelLock("99", async () => {
      order.push("c");
      return 3;
    });
    await Promise.all([a, b, c]);
    assert.deepEqual(order.filter((x) => x.startsWith("a") || x.startsWith("b")), [
      "a-start",
      "a-end",
      "b-start",
      "b-end",
    ]);
    assert.ok(order.includes("c"));
  });
});

describe("M-1 openAsk revert clears pending", () => {
  it("clears pending record so cancel can treat as neverOpened", () => {
    resetOpenAskPendingForTests();
    const dir = mkdtempSync(join(tmpdir(), "open-ask-rev-"));
    const store = new OpenAskPendingStore(join(dir, "open-ask-pending.json"));
    store.set({
      listingId: "42",
      sellerTokenId: "7",
      hash: "0x" + "cd".repeat(32),
      nonce: "9",
      broadcastAt: new Date().toISOString(),
    });
    assert.equal(store.has("42"), true);
    store.clear("42");
    assert.equal(store.has("42"), false);
  });
});

describe("H-2 / M-7 production boot + dry-run denylist", () => {
  it("recognizes dry-run addresses", () => {
    assert.equal(isDryRunAddress(GNOSIS_DRY_RUN_ADDRESSES.CharacterNFT), true);
    assert.equal(isDryRunAddress("0x1111111111111111111111111111111111111111"), false);
  });

  it("fails env shape when NETWORK=gnosis without contracts", () => {
    assert.equal(isProductionSettlementChain({ NETWORK: "gnosis" }), true);
    const r = assertProductionEnvShape({
      NETWORK: "gnosis",
      LOK_CHAIN_ID: "100",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /LOK_NFT|production/);
  });

  it("refuses dry-run denylist hits on production without inspect flags", () => {
    const r = assertProductionEnvShape({
      NETWORK: "gnosis",
      LOK_CHAIN_ID: "100",
      LOK_NFT: GNOSIS_DRY_RUN_ADDRESSES.CharacterNFT,
      LOK_FACTORY: GNOSIS_DRY_RUN_ADDRESSES.CharacterFactory,
      LOK_AH_ESCROW: GNOSIS_DRY_RUN_ADDRESSES.AhEscrow,
      LOK_CHAIN_RPC: "https://rpc.gnosischain.com",
      LOK_LISTING_KEY: "0x" + "11".repeat(32),
      LOK_OPS_STATUS_TOKEN: "secret",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /dry-run denylist/);
    assert.equal(dryRunDeployAllowed({ LOK_ALLOW_DRY_RUN_DEPLOY: "1" }), false);
    assert.equal(
      dryRunDeployAllowed({ LOK_ALLOW_DRY_RUN_DEPLOY: "1", LOK_DRY_RUN_INSPECT: "1" }),
      true,
    );
    assert.deepEqual(
      findDryRunEnvHits({ LOK_NFT: GNOSIS_DRY_RUN_ADDRESSES.CharacterNFT }).map((h) => h.key),
      ["LOK_NFT"],
    );
  });

  it("NETWORK=gnosis fills official deployments/gnosis.json (not dry-run)", () => {
    const env: NodeJS.ProcessEnv = { NETWORK: "gnosis" };
    applySettlementDeployFile(env);
    assert.equal(env.LOK_CHAIN_ID, "100");
    assert.equal(env.LOK_NFT, "0x48aFeC17A56c5Bd32ABDbcAD57f16d3859b1289F");
    assert.equal(env.LOK_AH_ESCROW, "0x4669488AE862D7cbf979878fCb1e1b9b80fba6Df");
    assert.equal(env.LOK_PVP_BOUNTY, "0x02bDDCaF5a19fD9Be7f39fC7419F794CECE9E64e");
    // Dry-run file is never auto-selected by the gnosis profile.
    assert.equal(isDryRunAddress(env.LOK_NFT!), false);
  });
});

describe("M-1 pending openAsk store", () => {
  it("records and clears broadcast rows; neverOpened only without record", () => {
    resetOpenAskPendingForTests();
    const dir = mkdtempSync(join(tmpdir(), "open-ask-"));
    const store = new OpenAskPendingStore(join(dir, "open-ask-pending.json"));
    assert.equal(store.has("1"), false);
    store.set({
      listingId: "1",
      sellerTokenId: "7",
      hash: "0x" + "ab".repeat(32),
      nonce: "3",
      broadcastAt: new Date().toISOString(),
    });
    assert.equal(store.has("1"), true);
    assert.equal(store.get("1")?.nonce, "3");
    store.clear("1");
    assert.equal(store.has("1"), false);
  });
});

describe("M-3 WS limits + XFF", () => {
  it("exports 64KiB maxPayload and rate-limits messages", () => {
    resetWsLimitsForTests();
    assert.equal(WS_MAX_PAYLOAD, 64 * 1024);
    const sock = {};
    for (let i = 0; i < WS_MSG_LIMIT; i++) assert.equal(consumeWsMessage(sock, 1_000), true);
    assert.equal(consumeWsMessage(sock, 1_000), false);
    assert.equal(wsIpExemptFromCaps("127.0.0.1", {}), true);
    assert.equal(wsIpExemptFromCaps("127.0.0.1", { AUTH_TRUST_PROXY: "1" }), false);
    const a = noteWsConnect("203.0.113.1");
    assert.equal(a.ok, true);
    noteWsDisconnect("203.0.113.1");
  });

  it("clientAddress uses right-most XFF hop when trusting proxy", () => {
    const req = {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.2" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    assert.equal(clientAddress(req, { AUTH_TRUST_PROXY: "1" }), "10.0.0.2");
  });
});

describe("M-4 SIWE message branding", () => {
  it("uses Black Anvil statement, real URI, and settlement chain id", () => {
    const msg = authMessage({
      wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nonce: "abc",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expirationTime: "2026-01-01T00:05:00.000Z",
      chainId: 100,
      uri: "https://play.blackanvil.gg",
      domain: "play.blackanvil.gg",
    });
    assert.match(msg, /Sign in to Black Anvil/);
    assert.match(msg, /URI: https:\/\/play\.blackanvil\.gg/);
    assert.match(msg, /Chain ID: 100/);
    assert.doesNotMatch(msg, /bellgrave:\/\/local/);
    assert.doesNotMatch(msg, /Chain ID: 31337/);
  });
});
