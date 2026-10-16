/**
 * A certified qualifying event scores once. A provisional batch scores nothing.
 * A guild with no Mark signature is ineligible. Payout waits for the anchored
 * root and the one-day delay. A zero score leaves the vault untouched.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AH_FEE_BPS, ahFeeSplit, ahGuildFeeShares } from "@bellgrave/protocol";
import { postReplicaBond, registryAdmin, resetBondedAdmissionForTests } from "./bonded-admission";
import { meleeAtkBonus } from "./gear-combat";
import {
  certifyGuildBatch,
  CHALLENGE_DELAY_MS,
  commitCertificateSigners,
  creditGuildVault,
  GUILD_VAULT_BPS,
  guildAuctionSplit,
  guildPayout,
  guildScore,
  guildTreasuryWei,
  guildVaultWei,
  noteGuildBatch,
  qualifyingEventsFromJournalCmds,
  resetGuildScoreForTests,
  settleGuildPayouts,
  type JournalBatch,
} from "./guild-score";
import { guilds, joinGuild, openGuild, resetGuildRegistryForTests } from "./guild-registry";
import { LOCAL_RULESET_WASM_SHA256 } from "./lok-vault";
import { submitOnSimTick } from "./order-submit";
import {
  ANCHOR_WAIT,
  anchoredAtMs,
  CHALLENGE_WAIT,
  postCertifiedBatch,
  resetRootAnchorForTests,
  setChallengeClockForTests,
} from "./root-anchor";

const MARK = "11".repeat(32);
const OTHER = "22".repeat(32);

function reset(): void {
  resetGuildScoreForTests();
  resetGuildRegistryForTests();
  resetBondedAdmissionForTests();
  resetRootAnchorForTests();
}

function membership(markIds: string[], characterIds: string[]) {
  return [{ guildId: "guild:operator-a", markIds, characterIds }];
}

function certificate(signerHex: string): Uint8Array {
  const out = new Uint8Array(52 + 96);
  new DataView(out.buffer).setUint32(48, 1, true);
  out.set(Buffer.from(signerHex, "hex"), 52);
  return out;
}

function root(fill: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(fill);
  return out;
}

test("a certified qualifying event scores once", () => {
  const events = qualifyingEventsFromJournalCmds(
    [
      { op: "pvpKill", slayer: "7" },
      { op: "harvest", tokenId: "7" },
      { op: "harvest", tokenId: "7" },
      { op: "craft", tokenId: "7" },
      { op: "chainFill", buyer: "7", seller: "7" },
      { op: "lootDrop", tokenId: "7" },
      { op: "goldEarn", tokenId: "7" },
      { op: "harvest", tokenId: "8" },
    ],
    (tokenId) => (tokenId === "7" ? "c1" : "outsider"),
  );
  const journal: JournalBatch[] = [
    {
      epoch: 4,
      certified: true,
      events,
      signers: [MARK, OTHER],
    },
  ];
  const scores = guildScore(journal, 4, membership([MARK, OTHER], ["c1"]));
  assert.equal(scores.length, 1);
  assert.equal(scores[0]?.eligible, true);
  assert.equal(scores[0]?.score, 1);
  assert.equal(scores[0]?.guildId, "guild:operator-a");
});

test("a provisional batch scores nothing", () => {
  const journal: JournalBatch[] = [
    {
      epoch: 4,
      certified: false,
      events: [
        { characterId: "c1", kind: "combat" },
        { characterId: "c1", kind: "gather" },
        { characterId: "c2", kind: "craft" },
      ],
      signers: [MARK],
    },
  ];
  const scores = guildScore(journal, 4, membership([MARK], ["c1", "c2"]));
  assert.equal(scores[0]?.eligible, false);
  assert.equal(scores[0]?.score, 0);

  const mixed = guildScore(
    [
      ...journal,
      {
        epoch: 4,
        certified: true,
        events: [{ characterId: "c1", kind: "trade" }],
        signers: [MARK],
      },
    ],
    4,
    membership([MARK], ["c1", "c2"]),
  );
  assert.equal(mixed[0]?.eligible, true);
  assert.equal(mixed[0]?.score, 1);
});

test("a missing Mark signature leaves the guild ineligible", () => {
  const signedByOther = commitCertificateSigners(certificate(OTHER));
  assert.deepEqual(signedByOther, [OTHER]);
  const journal: JournalBatch[] = [
    {
      epoch: 4,
      certified: true,
      events: [
        { characterId: "c1", kind: "combat" },
        { characterId: "c2", kind: "craft" },
      ],
      signers: signedByOther,
    },
  ];
  const scores = guildScore(journal, 4, membership([MARK], ["c1", "c2"]));
  assert.equal(scores[0]?.eligible, false);
  assert.equal(scores[0]?.score, 0);

  const unsigned = guildScore(
    [{ epoch: 4, certified: true, events: [{ characterId: "c1", kind: "gather" }], signers: [] }],
    4,
    membership([MARK], ["c1"]),
  );
  assert.equal(unsigned[0]?.eligible, false);
  assert.equal(unsigned[0]?.score, 0);
});

test("a payout is refused before the anchor and the one-day delay", async () => {
  reset();
  const calls: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    calls.push(typeof init?.body === "string" ? init.body : "");
    return new Response("refused", { status: 500 });
  }) as typeof fetch;
  try {
    assert.equal(CHALLENGE_DELAY_MS, 86_400_000);
    postReplicaBond(MARK, "replica", 10n);
    const opened = openGuild(MARK, MARK);
    assert.equal(opened.opened, true);
    assert.deepEqual(joinGuild(opened.guild?.id ?? "", "c1"), { joined: true, feeWei: 0n });
    const split = creditGuildVault(10_000n);
    assert.deepEqual(split, { feeWei: 100n, vaultWei: 50n, treasuryWei: 50n });
    assert.equal(guildVaultWei(), 50n);
    assert.equal(AH_FEE_BPS, 100);
    assert.deepEqual(ahFeeSplit(10_000n), { feeWei: 100n, sellerNetWei: 9_900n });

    noteGuildBatch({
      epoch: 0,
      height: 4,
      events: [
        { characterId: "c1", kind: "combat" },
        { characterId: "c1", kind: "gather" },
      ],
    });
    const beforeAnchor = settleGuildPayouts(0);
    assert.equal(beforeAnchor.ok, false);
    assert.equal(beforeAnchor.error, ANCHOR_WAIT);
    assert.equal(beforeAnchor.vaultWei, 50n);
    assert.equal(guildVaultWei(), 50n);
    assert.deepEqual(beforeAnchor.paid, []);

    certifyGuildBatch(4, certificate(MARK));
    const certifiedUnanchored = settleGuildPayouts(0);
    assert.equal(certifiedUnanchored.ok, false);
    assert.equal(certifiedUnanchored.error, ANCHOR_WAIT);
    assert.equal(guildVaultWei(), 50n);

    const anchorAt = 1_700_000_000_000;
    setChallengeClockForTests(() => anchorAt);
    const posted = await postCertifiedBatch(
      { height: 4, nextRoot: root(4), certificate: certificate(MARK) },
      { env: { LOK_CHAIN_ID: "31337" }, poster: async () => true },
    );
    assert.equal(posted, true);
    assert.equal(anchoredAtMs(4), anchorAt);

    const duringDelay = settleGuildPayouts(anchorAt + CHALLENGE_DELAY_MS - 1);
    assert.equal(duringDelay.ok, false);
    assert.equal(duringDelay.error, CHALLENGE_WAIT);
    assert.equal(duringDelay.vaultWei, 50n);
    assert.equal(guildVaultWei(), 50n);
    assert.equal(guildTreasuryWei(), 50n);

    const paid = settleGuildPayouts(anchorAt + CHALLENGE_DELAY_MS);
    assert.equal(paid.ok, true);
    assert.deepEqual(paid.paid, [{ guildId: "guild:" + MARK, wei: 50n }]);
    assert.equal(paid.vaultWei, 0n);
    assert.equal(guildVaultWei(), 0n);
    assert.equal(guildTreasuryWei(), 50n);
    assert.equal(calls.length, 0);

    const share = guildPayout({
      vaultWei: 10n,
      scores: [
        { guildId: "guild-a", score: 1 },
        { guildId: "guild-b", score: 2 },
      ],
      anchoredAtMs: 0,
      nowMs: 86_400_000,
    });
    assert.equal(share.ok, true);
    assert.deepEqual(share.paid, [
      { guildId: "guild-a", wei: 3n },
      { guildId: "guild-b", wei: 6n },
    ]);
    assert.equal(share.vaultWei, 1n);
  } finally {
    globalThis.fetch = prev;
    reset();
  }
});

test("a zero-score epoch leaves the vault untouched", async () => {
  reset();
  try {
    postReplicaBond(MARK, "replica", 10n);
    const opened = openGuild(MARK, MARK);
    assert.equal(opened.opened, true);
    joinGuild(opened.guild?.id ?? "", "c1");
    creditGuildVault(20_000n);
    assert.equal(guildVaultWei(), 100n);
    assert.equal(guildTreasuryWei(), 100n);

    noteGuildBatch({
      epoch: 0,
      height: 8,
      events: [{ characterId: "c1", kind: "lootDrop" }],
    });
    certifyGuildBatch(8, certificate(MARK));
    const anchorAt = 1_700_000_000_000;
    setChallengeClockForTests(() => anchorAt);
    const posted = await postCertifiedBatch(
      { height: 8, nextRoot: root(8), certificate: certificate(MARK) },
      { env: { LOK_CHAIN_ID: "31337" }, poster: async () => true },
    );
    assert.equal(posted, true);

    const idle = guildScore(
      [
        {
          epoch: 0,
          certified: true,
          events: [{ characterId: "c1", kind: "lootDrop" }],
          signers: [MARK],
        },
      ],
      0,
      membership([MARK], ["c1"]),
    );
    assert.equal(idle[0]?.eligible, true);
    assert.equal(idle[0]?.score, 0);

    const settled = settleGuildPayouts(anchorAt + CHALLENGE_DELAY_MS);
    assert.equal(settled.ok, true);
    assert.deepEqual(settled.paid, []);
    assert.equal(settled.vaultWei, 100n);
    assert.equal(guildVaultWei(), 100n);
    assert.equal(guildTreasuryWei(), 100n);
  } finally {
    reset();
  }
});

test("a later epoch pays when no earlier epoch was noted", async () => {
  reset();
  try {
    postReplicaBond(MARK, "replica", 10n);
    const opened = openGuild(MARK, MARK);
    assert.equal(opened.opened, true);
    joinGuild(opened.guild?.id ?? "", "c1");
    creditGuildVault(10_000n);

    noteGuildBatch({
      epoch: 4,
      height: 9,
      events: [{ characterId: "c1", kind: "craft" }],
    });
    certifyGuildBatch(9, certificate(MARK));
    const anchorAt = 1_700_000_000_000;
    setChallengeClockForTests(() => anchorAt);
    const posted = await postCertifiedBatch(
      { height: 9, nextRoot: root(9), certificate: certificate(MARK) },
      { env: { LOK_CHAIN_ID: "31337" }, poster: async () => true },
    );
    assert.equal(posted, true);

    const paid = settleGuildPayouts(anchorAt + CHALLENGE_DELAY_MS);
    assert.equal(paid.ok, true);
    assert.deepEqual(paid.paid, [{ guildId: "guild:" + MARK, wei: 50n }]);
    assert.equal(guildVaultWei(), 0n);
  } finally {
    reset();
  }
});

test("a second Mark signature does not add a second score", () => {
  const scores = guildScore(
    [
      {
        epoch: 4,
        certified: true,
        events: [
          { characterId: "c1", kind: "combat" },
          { characterId: "C1", kind: "craft" },
          { characterId: " c1 ", kind: "gather" },
          { characterId: "c2", kind: "trade" },
        ],
        signers: [MARK, OTHER],
      },
    ],
    4,
    membership([MARK, OTHER], ["c1", "c2"]),
  );
  assert.equal(scores[0]?.eligible, true);
  assert.equal(scores[0]?.score, 2);
});

test("a character who joins after the epoch does not score it", async () => {
  reset();
  try {
    creditGuildVault(10_000n);
    noteGuildBatch({
      epoch: 0,
      height: 4,
      events: [{ characterId: "c1", kind: "craft" }],
    });
    postReplicaBond(MARK, "replica", 10n);
    const opened = openGuild(MARK, MARK);
    assert.equal(opened.opened, true);
    joinGuild(opened.guild?.id ?? "", "c1");
    certifyGuildBatch(4, certificate(MARK));
    const anchorAt = 1_700_000_000_000;
    setChallengeClockForTests(() => anchorAt);
    const posted = await postCertifiedBatch(
      { height: 4, nextRoot: root(4), certificate: certificate(MARK) },
      { env: { LOK_CHAIN_ID: "31337" }, poster: async () => true },
    );
    assert.equal(posted, true);

    const settled = settleGuildPayouts(anchorAt + CHALLENGE_DELAY_MS);
    assert.equal(settled.ok, true);
    assert.deepEqual(settled.paid, []);
    assert.equal(settled.vaultWei, 50n);
    assert.equal(guildVaultWei(), 50n);
  } finally {
    reset();
  }
});

test("a ready epoch stays paid while a later epoch is still waiting", async () => {
  reset();
  try {
    postReplicaBond(MARK, "replica", 10n);
    const opened = openGuild(MARK, MARK);
    assert.equal(opened.opened, true);
    joinGuild(opened.guild?.id ?? "", "c1");
    creditGuildVault(10_000n);
    noteGuildBatch({
      epoch: 0,
      height: 4,
      events: [{ characterId: "c1", kind: "craft" }],
    });
    certifyGuildBatch(4, certificate(MARK));
    const anchorAt = 1_700_000_000_000;
    setChallengeClockForTests(() => anchorAt);
    const posted = await postCertifiedBatch(
      { height: 4, nextRoot: root(4), certificate: certificate(MARK) },
      { env: { LOK_CHAIN_ID: "31337" }, poster: async () => true },
    );
    assert.equal(posted, true);
    noteGuildBatch({
      epoch: 1,
      height: 5,
      events: [{ characterId: "c1", kind: "gather" }],
    });

    const waiting = settleGuildPayouts(anchorAt + CHALLENGE_DELAY_MS);
    assert.equal(waiting.ok, false);
    assert.equal(waiting.error, ANCHOR_WAIT);
    assert.equal(guildVaultWei(), 0n);

    const again = settleGuildPayouts(anchorAt + CHALLENGE_DELAY_MS);
    assert.equal(again.ok, false);
    assert.equal(again.error, ANCHOR_WAIT);
    assert.equal(guildVaultWei(), 0n);
  } finally {
    reset();
  }
});

test("the live tick calls the score and the payout gate", async () => {
  reset();
  const calls: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    calls.push(typeof init?.body === "string" ? init.body : "");
    return new Response("refused", { status: 500 });
  }) as typeof fetch;
  try {
    const sheet = { level: 20 };
    const melee = meleeAtkBonus(sheet);
    assert.equal(AH_FEE_BPS, 100);
    assert.equal(GUILD_VAULT_BPS, 50);
    assert.deepEqual(guildAuctionSplit(10_000n), { feeWei: 100n, vaultWei: 50n, treasuryWei: 50n });
    assert.deepEqual(guildAuctionSplit(100n), ahGuildFeeShares(100n));
    assert.deepEqual(guildAuctionSplit(300n), { feeWei: 3n, vaultWei: 1n, treasuryWei: 2n });
    const sol = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/lok-log/src/AhEscrow.sol"),
      "utf8",
    );
    assert.match(sol, /uint256 public constant FEE_BPS = 100;/);
    assert.match(sol, /uint256 public constant VAULT_BPS_START = 50;/);
    assert.match(sol, /uint64 public constant SHARE_DELAY = 1 days;/);
    assert.equal(sol.includes("claimDelay"), false);
    const scoreSrc = readFileSync(new URL("./guild-score.ts", import.meta.url), "utf8");
    assert.match(scoreSrc, /CHALLENGE_DELAY_MS/);
    assert.equal(scoreSrc.includes("claimDelay()"), false);
    assert.equal(LOCAL_RULESET_WASM_SHA256, "4d2610aa110a9f6bb163934d29a6ca7410b98530d59a700d8cd1b66cc5804178");
    assert.deepEqual(registryAdmin(), {
      registryOwner: "gnosis-safe",
      slashingAdmin: "gnosis-safe",
      rulesetProposer: "gnosis-safe",
    });

    postReplicaBond("operator-a", "replica", 4n);
    postReplicaBond("mark-2", "replica", 5n);
    const opened = openGuild("operator-a", "operator-a");
    assert.equal(opened.opened, true);
    assert.equal(openGuild("operator-a", "mark-2").opened, false);
    assert.equal(guilds().length, 1);

    const server = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const tick = server.slice(server.indexOf("function tickSim()"), server.indexOf("function tickIndexInputs"));
    assert.match(tick, /noteGuildBatch\(/);
    assert.match(tick, /settleGuildPayouts\(Date\.now\(\)\)/);
    assert.equal(tick.includes("await settleGuildPayouts"), false);

    const order = readFileSync(new URL("./order-submit.ts", import.meta.url), "utf8");
    const observe = order.slice(order.indexOf("export function observeOrdererLine"), order.indexOf("function certifiedBatchFromHealth"));
    assert.match(observe, /certifyGuildBatch\(/);
    assert.match(observe, /settleGuildPayouts\(Date\.now\(\)\)/);

    const escrow = readFileSync(new URL("./ah-escrow.ts", import.meta.url), "utf8");
    assert.match(escrow, /creditGuildVault\(price\)/);

    const started = Date.now();
    const submitted = submitOnSimTick(null, { ok: true, height: 9, nextRoot: root(9) });
    assert.equal(submitted.tickFailed, false);
    assert.equal(submitted.status, "provisional");
    assert.equal(submitted.blob, null);
    assert.ok(Date.now() - started < 1000);
    assert.equal(meleeAtkBonus(sheet), melee);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = prev;
    reset();
  }
});
