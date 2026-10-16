/**
 * One bonded operator opens one guild. The bond is the one already posted.
 * Joining is free. A second Mark does not open a second guild. Nothing is paid.
 * A Mark grants no damage, loot, or combat advantage. Validators, light
 * clients, phones, and the listing key stay out. The tick does not wait.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AH_FEE_BPS, ahFeeSplit } from "@bellgrave/protocol";
import {
  postReplicaBond,
  registryAdmin,
  resetBondedAdmissionForTests,
  votingReplica,
  votingSet,
  votingSetCommitThreshold,
} from "./bonded-admission";
import { allowEpochSettlementForTests } from "./epoch-cap-fixture";
import { meleeAtkBonus, withGearMab } from "./gear-combat";
import { gameRollCount } from "./game-roll";
import {
  guildForOperator,
  guildMembers,
  guilds,
  joinGuild,
  openGuild,
  resetGuildRegistryForTests,
} from "./guild-registry";
import { incomingMagicDamage } from "./incoming-dt";
import { installedGameMode } from "./installed-game-mode";
import { LOCAL_RULESET_WASM_SHA256 } from "./lok-vault";
import { submitOnSimTick } from "./order-submit";
import { PINNED_GNOSIS_LISTING_ADDRESS } from "./production-boot";
import {
  chainBoundSendGate,
  configureEpochLedger,
  epochSettledXdai,
  notePostedSlashableBond,
  postedSlashableBond,
  postedSlashableBonds,
  recordPostedSlashableBonds,
  resetRootAnchorForTests,
} from "./root-anchor";

function reset(): void {
  resetGuildRegistryForTests();
  resetBondedAdmissionForTests();
  resetRootAnchorForTests();
}

function root(fill: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(fill);
  return out;
}

describe("guild registry", { concurrency: false }, () => {
  test("one bonded operator opens one guild from the bond already posted", () => {
    reset();
    try {
      const amount = 1n;
      assert.deepEqual(postReplicaBond("operator-a", "replica", amount), { joined: true, amountWei: amount });
      const bondsBefore = postedSlashableBonds();
      const thresholdBefore = votingSetCommitThreshold();
      const adminBefore = registryAdmin();

      const opened = openGuild("operator-a", "operator-a");
      assert.equal(opened.opened, true);
      assert.equal(opened.guild?.id, "guild:operator-a");
      assert.equal(opened.guild?.operatorId, "operator-a");
      assert.equal(opened.guild?.markId, "operator-a");
      assert.equal(opened.guild?.bondWei, amount);
      assert.equal("feeWei" in (opened.guild ?? {}), false);
      assert.equal(postedSlashableBond("operator-a"), amount);
      assert.equal(postedSlashableBonds(), bondsBefore);
      assert.equal(votingSetCommitThreshold(), thresholdBefore);
      assert.equal(thresholdBefore, 1);
      assert.deepEqual(registryAdmin(), adminBefore);
      assert.deepEqual(registryAdmin(), {
        registryOwner: "gnosis-safe",
        slashingAdmin: "gnosis-safe",
        rulesetProposer: "gnosis-safe",
      });

      const again = openGuild("operator-a", "operator-a");
      assert.equal(again.opened, false);
      assert.equal(again.guild?.id, opened.guild?.id);
      assert.equal(guilds().length, 1);
      assert.equal(postedSlashableBond("operator-a"), amount);

      const ceiling = 10n ** 40n;
      assert.deepEqual(postReplicaBond("operator-b", "replica", ceiling), { joined: true, amountWei: ceiling });
      const other = openGuild("operator-b", "operator-b");
      assert.equal(other.opened, true);
      assert.equal(other.guild?.bondWei, ceiling);
      assert.notEqual(other.guild?.id, opened.guild?.id);
      assert.equal(guilds().length, 2);
      assert.equal(postedSlashableBond("operator-b"), ceiling);
      assert.equal(postedSlashableBonds(), amount + ceiling);

      notePostedSlashableBond("noted-only", 999n);
      assert.deepEqual(openGuild("noted-only", "noted-only"), { opened: false, guild: null });
      assert.equal(guilds().length, 2);
      assert.equal(votingReplica("noted-only"), null);
      assert.equal(postedSlashableBond("noted-only"), 999n);

      postReplicaBond("operator-c", "replica", 3n);
      postReplicaBond("operator-d", "replica", 4n);
      assert.equal(votingSet().length, 4);
      assert.equal(votingSetCommitThreshold(), 3);
      const fourth = openGuild("operator-c", "operator-c");
      assert.equal(fourth.opened, true);
      assert.equal(votingSet().length, 4);
      assert.equal(votingSetCommitThreshold(), 3);
      assert.deepEqual(registryAdmin(), adminBefore);
    } finally {
      reset();
    }
  });

  test("joining a guild is free and does not require a bond", async () => {
    reset();
    try {
      postReplicaBond("operator-a", "replica", 9n);
      const opened = openGuild("operator-a", "operator-a");
      assert.equal(opened.opened, true);
      const guildId = opened.guild?.id ?? "";
      const bonds = postedSlashableBonds();
      const settled = epochSettledXdai();
      const mode = await installedGameMode(
        { LOK_REPLICA: "1" },
        {
          readResources: () => {
            throw new Error("hardware");
          },
        },
      );
      assert.equal(mode.mode, "validator");
      assert.equal(mode.ticksWorld, false);
      assert.equal(mode.leads, false);

      assert.deepEqual(joinGuild("guild:missing", "character-1"), { joined: false, feeWei: 0n });
      assert.deepEqual(joinGuild(guildId, "character-1"), { joined: true, feeWei: 0n });
      assert.equal(postedSlashableBond("character-1"), 0n);
      assert.equal(postedSlashableBonds(), bonds);
      assert.equal(votingReplica("character-1"), null);

      assert.deepEqual(joinGuild(guildId, "character-1"), { joined: true, feeWei: 0n });
      assert.equal(guildMembers(guildId).length, 1);
      assert.equal(guildMembers(guildId)[0]?.feeWei, 0n);
      assert.equal(guildMembers(guildId)[0]?.characterId, "character-1");

      const phone = joinGuild(guildId, "phone");
      assert.deepEqual(phone, { joined: true, feeWei: 0n });
      assert.equal(postedSlashableBond("phone"), 0n);
      assert.equal(votingReplica("phone"), null);
      assert.equal(guildForOperator("phone"), null);
      assert.equal(votingSet().length, 1);
      assert.equal(postedSlashableBonds(), bonds);
      assert.equal(epochSettledXdai(), settled);
      assert.equal(postedSlashableBond("character-1"), 0n);
    } finally {
      reset();
    }
  });

  test("a second Mark for the same operator does not open a second guild", () => {
    reset();
    try {
      assert.deepEqual(postReplicaBond("operator-a", "replica", 11n), { joined: true, amountWei: 11n });
      assert.deepEqual(postReplicaBond("mark-2", "replica", 22n), { joined: true, amountWei: 22n });
      const first = openGuild("operator-a", "operator-a");
      assert.equal(first.opened, true);
      assert.equal(first.guild?.bondWei, 11n);

      const second = openGuild("operator-a", "mark-2");
      assert.equal(second.opened, false);
      assert.equal(second.guild?.id, first.guild?.id);
      assert.equal(second.guild?.markId, "operator-a");
      assert.equal(second.guild?.bondWei, 11n);
      assert.equal(guilds().length, 1);

      const asOwn = openGuild("mark-2", "mark-2");
      assert.deepEqual(asOwn, { opened: false, guild: null });
      assert.equal(guilds().length, 1);
      assert.equal(guildForOperator("mark-2"), null);
      assert.equal(guildForOperator("operator-a")?.id, first.guild?.id);
      assert.equal(postedSlashableBond("operator-a"), 11n);
      assert.equal(postedSlashableBond("mark-2"), 22n);
      assert.equal(postedSlashableBonds(), 33n);
      assert.equal(votingSet().length, 2);
      assert.equal(votingSetCommitThreshold(), 2);
    } finally {
      reset();
    }
  });

  test("a guild pays nothing", () => {
    reset();
    try {
      const calls: string[] = [];
      const prev = globalThis.fetch;
      globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
        calls.push(typeof init?.body === "string" ? init.body : "");
        return new Response("refused", { status: 500 });
      }) as typeof fetch;
      try {
        postReplicaBond("operator-a", "replica", 100n);
        const before = postedSlashableBond("operator-a");
        const total = postedSlashableBonds();
        const opened = openGuild("operator-a", "operator-a");
        assert.equal(opened.opened, true);
        const joined = joinGuild(opened.guild?.id ?? "", "character-1");
        assert.deepEqual(joined, { joined: true, feeWei: 0n });

        assert.equal(postedSlashableBond("operator-a"), before);
        assert.equal(postedSlashableBonds(), total);
        assert.equal(AH_FEE_BPS, 100);
        assert.deepEqual(ahFeeSplit(10_000n), { feeWei: 100n, sellerNetWei: 9_900n });
        const sol = readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/lok-log/src/AhEscrow.sol"),
          "utf8",
        );
        assert.match(sol, /uint256 public constant FEE_BPS = 100;/);
        assert.equal(
          LOCAL_RULESET_WASM_SHA256,
          "4d2610aa110a9f6bb163934d29a6ca7410b98530d59a700d8cd1b66cc5804178",
        );
        assert.equal("payout" in (opened.guild ?? {}), false);
        assert.equal("payoutWei" in (opened.guild ?? {}), false);
        assert.equal(calls.length, 0);
      } finally {
        globalThis.fetch = prev;
      }
    } finally {
      reset();
    }
  });

  test("a Mark grants no damage, loot, or combat advantage", () => {
    reset();
    try {
      postReplicaBond("operator-a", "replica", 3n);
      const sheet = { level: 20 };
      const melee = meleeAtkBonus(sheet);
      const spell = withGearMab(sheet, 40);
      const incoming = incomingMagicDamage(50, 10, 1);
      const rolls = gameRollCount();

      const opened = openGuild("operator-a", "operator-a");
      assert.equal(opened.opened, true);
      const guild = opened.guild;
      assert.ok(guild);
      joinGuild(guild.id, "character-1");

      assert.equal(meleeAtkBonus(sheet), melee);
      assert.equal(melee, 0);
      assert.equal(withGearMab(sheet, 40), spell);
      assert.equal(spell, 40);
      assert.equal(incomingMagicDamage(50, 10, 1), incoming);
      assert.equal(gameRollCount(), rolls);
      assert.equal("damage" in guild, false);
      assert.equal("loot" in guild, false);
      assert.equal("crit" in guild, false);
      assert.equal("combat" in guild, false);
      assert.equal("advantage" in guild, false);
      assert.deepEqual(Object.keys(guild).sort(), ["bondWei", "id", "markId", "operatorId"]);
    } finally {
      reset();
    }
  });

  test("validators, light clients, phones, and the listing key do not become bonded operators", async () => {
    reset();
    try {
      const mode = await installedGameMode({});
      assert.equal(mode.mode, "validator");
      assert.deepEqual(postReplicaBond("validator-1", mode.mode, 10n), { joined: false, amountWei: 0n });
      assert.deepEqual(postReplicaBond("phone", "light", 25n), { joined: false, amountWei: 0n });
      assert.deepEqual(postReplicaBond("light-client", "light", 4n), { joined: false, amountWei: 0n });
      assert.deepEqual(postReplicaBond(PINNED_GNOSIS_LISTING_ADDRESS, "replica", 10n), {
        joined: false,
        amountWei: 0n,
      });
      assert.equal(votingSet().length, 0);

      assert.deepEqual(openGuild("validator-1", "validator-1"), { opened: false, guild: null });
      assert.deepEqual(openGuild("phone", "phone"), { opened: false, guild: null });
      assert.deepEqual(openGuild("light-client", "light-client"), { opened: false, guild: null });
      assert.deepEqual(openGuild(PINNED_GNOSIS_LISTING_ADDRESS, PINNED_GNOSIS_LISTING_ADDRESS), {
        opened: false,
        guild: null,
      });
      assert.deepEqual(
        openGuild(
          "0xbFa29a6EE3d1188aa0A9e0c783E5Da620b859E76",
          "0xbFa29a6EE3d1188aa0A9e0c783E5Da620b859E76",
        ),
        { opened: false, guild: null },
      );
      assert.deepEqual(
        openGuild(PINNED_GNOSIS_LISTING_ADDRESS.slice(2), PINNED_GNOSIS_LISTING_ADDRESS.slice(2)),
        { opened: false, guild: null },
      );
      assert.equal(guilds().length, 0);
      assert.equal(votingSet().length, 0);
      assert.equal(postedSlashableBond("validator-1"), 0n);
      assert.equal(postedSlashableBond("phone"), 0n);
      assert.equal(postedSlashableBond("light-client"), 0n);
      assert.equal(postedSlashableBond(PINNED_GNOSIS_LISTING_ADDRESS), 0n);
      assert.equal(guildForOperator("validator-1"), null);
      assert.equal(guildForOperator("phone"), null);
      assert.equal(guildForOperator(PINNED_GNOSIS_LISTING_ADDRESS), null);

      postReplicaBond("operator-a", "replica", 7n);
      const opened = openGuild("operator-a", "operator-a");
      assert.equal(opened.opened, true);
      joinGuild(opened.guild?.id ?? "", "phone");
      joinGuild(opened.guild?.id ?? "", PINNED_GNOSIS_LISTING_ADDRESS);
      joinGuild(opened.guild?.id ?? "", "validator-1");
      assert.equal(votingSet().length, 1);
      assert.equal(votingReplica("phone"), null);
      assert.equal(votingReplica("validator-1"), null);
      assert.equal(votingReplica(PINNED_GNOSIS_LISTING_ADDRESS), null);
      assert.equal(guildForOperator("phone"), null);
      assert.equal(votingSetCommitThreshold(), 1);
      assert.deepEqual(registryAdmin(), {
        registryOwner: "gnosis-safe",
        slashingAdmin: "gnosis-safe",
        rulesetProposer: "gnosis-safe",
      });
    } finally {
      reset();
    }
  });

  test("opening a guild does not stop the 20 Hz tick and does not broadcast", async () => {
    reset();
    try {
      const calls: string[] = [];
      const prev = globalThis.fetch;
      globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
        calls.push(typeof init?.body === "string" ? init.body : "");
        return new Response("refused", { status: 500 });
      }) as typeof fetch;
      try {
        postReplicaBond("operator-a", "replica", 3n);
        const opened = openGuild("operator-a", "operator-a");
        assert.equal(opened.opened, true);
        assert.deepEqual(joinGuild(opened.guild?.id ?? "", "character-1"), { joined: true, feeWei: 0n });
        const tick = submitOnSimTick(null, { ok: true, height: 9, nextRoot: root(0x31) });
        assert.equal(tick.tickFailed, false);
        assert.equal(tick.status, "provisional");
        assert.equal(tick.blob, null);
        assert.equal(calls.length, 0);
        assert.equal(guilds().length, 1);
        assert.equal(postedSlashableBond("operator-a"), 3n);
      } finally {
        globalThis.fetch = prev;
      }
    } finally {
      reset();
    }
  });

  test("no payout function moves xDAI", async () => {
    reset();
    try {
      await allowEpochSettlementForTests(1000n);
      assert.equal(chainBoundSendGate().ok, true);
      assert.equal(epochSettledXdai(), 0n);
      const bonds = postedSlashableBonds();
      assert.deepEqual(postReplicaBond("operator-a", "replica", 100n), { joined: true, amountWei: 100n });
      const opened = openGuild("operator-a", "operator-a");
      assert.equal(opened.opened, true);
      const guildId = opened.guild?.id ?? "";
      assert.deepEqual(joinGuild(guildId, "character-1"), { joined: true, feeWei: 0n });
      assert.equal(epochSettledXdai(), 0n);
      assert.equal(postedSlashableBonds(), bonds);
      assert.equal(postedSlashableBond("operator-a"), 100n);
      assert.equal(postedSlashableBond("character-1"), 0n);
      const source = readFileSync(new URL("./guild-registry.ts", import.meta.url), "utf8");
      assert.equal(source.includes("chainBoundXdaiSend"), false);
      assert.equal(source.includes("function guildPayout"), false);
      assert.equal(source.includes("function payout"), false);
    } finally {
      reset();
    }
  });

  test("a vote cannot open a second guild or block a valid register", () => {
    reset();
    const prevOwner = process.env.LOK_OWNER_KEY;
    const prevPrivate = process.env.PRIVATE_KEY;
    process.env.LOK_OWNER_KEY = PINNED_GNOSIS_LISTING_ADDRESS;
    process.env.PRIVATE_KEY = "0x" + "11".repeat(32);
    try {
      const ballot = {
        replaceSafe: true,
        secondGuild: true,
        blockRegister: true,
        registryOwner: PINNED_GNOSIS_LISTING_ADDRESS,
        slashingAdmin: "0x1111111111111111111111111111111111111111",
        rulesetProposer: "replica-1",
      };
      assert.deepEqual(postReplicaBond("operator-a", "replica", 5n), { joined: true, amountWei: 5n });
      assert.deepEqual(postReplicaBond("mark-2", "replica", 6n), { joined: true, amountWei: 6n });
      const adminBefore = registryAdmin();

      const opened = openGuild("operator-a", "operator-a", ballot);
      assert.equal(opened.opened, true);
      assert.equal(opened.guild?.id, "guild:operator-a");
      assert.equal(opened.guild?.operatorId, "operator-a");
      assert.notEqual(opened.guild?.operatorId, process.env.LOK_OWNER_KEY);
      assert.notEqual(opened.guild?.operatorId, process.env.PRIVATE_KEY);
      assert.equal(guilds().length, 1);

      const again = openGuild("operator-a", "mark-2", ballot);
      assert.equal(again.opened, false);
      assert.equal(again.guild?.id, opened.guild?.id);
      assert.equal(again.guild?.operatorId, "operator-a");
      assert.equal(guilds().length, 1);
      assert.equal(guildForOperator("mark-2"), null);
      assert.deepEqual(registryAdmin(), adminBefore);
      assert.deepEqual(registryAdmin(), {
        registryOwner: "gnosis-safe",
        slashingAdmin: "gnosis-safe",
        rulesetProposer: "gnosis-safe",
      });
      assert.equal(postedSlashableBond("operator-a"), 5n);
      assert.equal(postedSlashableBond("mark-2"), 6n);
    } finally {
      if (prevOwner === undefined) delete process.env.LOK_OWNER_KEY;
      else process.env.LOK_OWNER_KEY = prevOwner;
      if (prevPrivate === undefined) delete process.env.PRIVATE_KEY;
      else process.env.PRIVATE_KEY = prevPrivate;
      reset();
    }
  });

  test("server boot registers one guild for an admitted bond and a character joins free", async () => {
    reset();
    const dir = mkdtempSync(join(tmpdir(), "lok-guild-boot-"));
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
        LOK_POSTED_SLASHABLE_BONDS: "ghost:0, replica-a:-1, " + listing + ":10",
      });
      assert.equal(guilds().length, 0);
      assert.equal(votingSet().length, 0);
      assert.equal(postedSlashableBonds(), 0n);

      recordPostedSlashableBonds({
        LOK_POSTED_SLASHABLE_BONDS: "operator-a:11,operator-a@mark-2:22,operator-b:7",
      });
      assert.equal(guilds().length, 2);
      assert.equal(guildForOperator("operator-a")?.id, "guild:operator-a");
      assert.equal(guildForOperator("operator-a")?.markId, "operator-a");
      assert.equal(guildForOperator("operator-a")?.bondWei, 11n);
      assert.equal(guildForOperator("mark-2"), null);
      assert.equal(guildForOperator("operator-b")?.id, "guild:operator-b");
      assert.equal(postedSlashableBond("operator-a"), 11n);
      assert.equal(postedSlashableBond("mark-2"), 22n);
      assert.equal(postedSlashableBond("operator-b"), 7n);
      assert.equal(postedSlashableBonds(), 40n);
      assert.equal(votingSet().length, 3);
      assert.equal(votingSetCommitThreshold(), 2);
      assert.equal(epochSettledXdai(), 0n);
      assert.equal(AH_FEE_BPS, 100);
      assert.deepEqual(registryAdmin(), {
        registryOwner: "gnosis-safe",
        slashingAdmin: "gnosis-safe",
        rulesetProposer: "gnosis-safe",
      });

      recordPostedSlashableBonds({
        LOK_POSTED_SLASHABLE_BONDS: "operator-a:11,operator-a@mark-2:22,operator-b:7",
      });
      assert.equal(guilds().length, 2);

      const joined = joinGuild("guild:operator-a", "character-1");
      assert.deepEqual(joined, { joined: true, feeWei: 0n });
      assert.equal(postedSlashableBond("character-1"), 0n);
      assert.equal(votingReplica("character-1"), null);
      assert.equal(guildMembers("guild:operator-a").length, 1);
      assert.equal(guildMembers("guild:operator-a")[0]?.feeWei, 0n);

      const anchor = readFileSync(new URL("./root-anchor.ts", import.meta.url), "utf8");
      assert.match(anchor, /openGuild\(who\.operatorId, who\.markId\)/);
      assert.equal(anchor.includes("chainBoundXdaiSend"), true);
      const register = anchor.slice(
        anchor.indexOf("export function recordPostedSlashableBonds"),
        anchor.indexOf("export function setPostedSlashableBonds"),
      );
      assert.equal(register.includes("chainBoundXdaiSend"), false);
      assert.equal(register.includes("fetch("), false);

      const server = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
      const helper = server.slice(server.indexOf("function joinCharacterGuild"), server.indexOf("function createPlayer"));
      assert.match(helper, /joinGuild\(guild\.id, characterId\)/);
      assert.equal(helper.includes("LOK_REPLICA"), false);
      assert.equal(helper.includes("postedSlashableBond"), false);
      assert.equal((server.match(/joinCharacterGuild\(p\.charId\)/g) ?? []).length, 2);

      const tick = submitOnSimTick(null, { ok: true, height: 9, nextRoot: root(0x32) });
      assert.equal(tick.tickFailed, false);
      assert.equal(tick.status, "provisional");
      assert.equal(tick.blob, null);
      assert.equal(calls.length, 0);
    } finally {
      globalThis.fetch = prev;
      reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
