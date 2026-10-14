import {
  JOBS,
  JOB_IDS,
  MAX_LEVEL,
  REST_TICK,
  SUBJOB_UNLOCK_LEVEL,
  FREE_STAT_POINTS,
  SKILL_POINTS_PER_LEVEL,
  SKILL_PRESTIGE_CAP,
  SKILL_NODES,
  abilitiesUnlockedDual,
  abilityLabel,
  abilityUnlockLevel,
  trainerAbilityGoldCost,
  trainerOffersForJobs,
  canTrainAbility,
  isTrainerFreeAbility,
  aggregateSkillBonuses,
  attackFromStats,
  canUnlockSkillNode,
  combinedJobVitals,
  deriveCharacterAttributes,
  defenseFromVit,
  playerDefense,
  evasionFromAgi,
  critFromAgi,
  freeSkillHubs,
  freeStatsSpent,
  fStr,
  meleeUsesWeaponAttack,
  hitChance,
  initialUnlockedForJob,
  isJobId,
  isClericAbilityId,
  isFighterAbilityId,
  isBattleMageAbilityId,
  isKnightAbilityId,
  isRogueAbilityId,
  isSkillNodeId,
  isSorcererAbilityId,
  isAbilityId,
  isTimAbilityId,
  physicalDamage,
  skillHubForJob,
  skillPointsEarned,
  skillPointsGrantedForLevels,
  skillPointsSpentOnTree,
  skillNodeCost,
  skillPointsAvailable,
  subjobLevel,
  swingDelayMs,
  resolveSwingDelayMs,
  abilityIdsForJob,
  weaponTpUnlocked,
  weaponTypeFromTokenId,
  isWeaponTpAbilityId,
  xpToNextLevel,
  type AttrKey,
  type JobId,
  type TimAbilityId,
  type WeaponTpAbilityId,
  jobStatsAtLevel,
} from "@bellgrave/combat";
import {
  ITEM,
  MELEE_RANGE,
  MOB_DEATH_FADE_MS,
  MOB_RESPAWN_MS,
  PH_HUB,
  PH_HUB_NPCS,
  PH_STORAGE_CHEST,
  PH_HUB_SPAWN,
  PLAYER_SPEED,
  PLAYER_SPEED_FLUX,
  TICK_HZ,
  TICK_MS,
  clampPaleHollow,
  paleHollowBiome,
  paleHollowClampMove,
  paleHollowGateSoftLevel,
  paleHollowHeight,
  paleHollowStandHeight,
  paleHollowInBuildingClearing,
  paleHollowInOpenWater,
  paleHollowMoveMul,
  paleHollowPlaceOnDryLand,
  paleHollowWalkable,
} from "@bellgrave/config";
import {
  SHINY_CLONE_COUNT,
  SHINY_FLEE_RELOCATE_MS,
  applyShinyPromotion,
  emptyShinyFields,
  formationOffset,
  lookupMobDef,
  rollShinyMat,
  rollShinyPromotion,
} from "./shiny-hq-runtime";
import {
  CATALOG_BY_SLUG,
  aggregateEquipmentStats,
  catalogIdToChainFungibleId,
  cloneCraftSkills,
  craftGoldCost,
  craftOutputQty,
  craftXpForRecipe,
  craftXpToNext,
  emptyCraftSkills,
  emptyEquipment,
  getCraftableItem,
  EQUIP_SLOTS,
  getItem,
  isLaunchExportableFungible,
  npcSellTotalGold,
  npcSellUnitGold,
  ownedMatQty,
  pickAffordableMaterials,
  recipeMaterials,
  recipeMaterialsComplete,
  type CraftSkill,
  type ItemDef,
} from "@bellgrave/items";
import {
  STARTER_POTION_AMOUNT,
  STARTER_POTION_ID,
  STARTER_WEAPON,
  addStack,
  discardStack,
  stackAmount,
  starterAmount,
  takeStack,
} from "./starter-kit";
import { createPaleHollowMobs, createPaleHollowNodes, relocateGatherNode, type FieldNode } from "./pale-hollow-world";
import { steerMobStep } from "./mob-steer";
import { withinEngageRange } from "./engage-range";
import { GATHER_RANGE, beginGatherChannel, tickGatherChannel, type GatherChannel } from "./gather-channel";
import {
  MOB_CAST_ANIM_MS,
  MOB_CAST_WINDUP_MS,
  mobAutoAttackRoll,
  mobAutoIsMagic,
  mobEngageRange,
  mobMpForJob,
  resolveMobJob,
  tryMobJobAbility,
  type PendingMobCastResolve,
} from "./mob-job-ai";
import type {
  AbilityId,
  Equipment,
  EquipSlot,
  InventorySlot,
  ServerMessage,
  SnapshotMessage,
  UnitSnapshot,
} from "@bellgrave/protocol";
import { emptyBuffs, parseClientMessage } from "@bellgrave/protocol";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { handleOpsHttp } from "./ops-health";
import {
  clearKnightBuffs,
  findInterposeGuard,
  resolveKnightAbility,
} from "./knight-abilities";
import { clearRogueBuffs, resolveRogueAbility } from "./rogue-abilities";
import {
  clearFighterBuffs,
  fighterCritBonus,
  fighterDefenseMul,
  fighterDoubleAttackChance,
  fighterEvaPenalty,
  fighterKillingStorm,
  fighterTpGainMul,
  resolveFighterAbility,
} from "./fighter-abilities";
import { resolveWeaponTpAbility } from "./weapon-tp-abilities";
import { clearSorcererBuffs, resolveSorcererAbility } from "./sorcerer-abilities";
import { clearClericBuffs, absorbHealShield, resolveClericAbility } from "./cleric-abilities";
import { gearHealPotency, gearRegen, meleeAtkBonus } from "./gear-combat";
import {
  absorbStoneskin,
  battleMageEnSpellBonus,
  clearBattleMageBuffs,
  resolveBattleMageAbility,
} from "./battlemage-abilities";
import { playerStance, resolveTimAbility } from "./tim-abilities";
import { hasKit } from "./support-job";
import {
  autoAttackFStr,
  autoAttackFighterAccBonus,
  autoAttackFighterAttackMul,
} from "./auto-attack-traits";
import { pickDotKillCredit } from "./dot-credit";
import { pendingHitDtMul, physDtMul } from "./incoming-dt";
import { loadLokEnv } from "./lok-chain";
import { applySettlementDeployFile } from "./settlement-deploy";
import {
  ahEscrowAddress,
  ahEscrowClientConfig,
  listingRoleKey,
  startAskFilledWatcher,
  type AskFilledApplied,
} from "./ah-escrow";
import { reconcileOpenAsksFromChain } from "./ah-escrow-reconcile";
import { cancelAskOnchain, openAskOnchain } from "./ah-escrow-tx";
import {
  acceptedMintWallets,
  configureMintClaimNonceStore,
  consumeMintClaimNonce,
} from "./mint-claim";
import { join as pathJoin } from "node:path";
import {
  characterMintEnvConfigured,
  ensureLocalRuleset,
  faucetAnvilEth,
  loadCharacterMintClientConfig,
  linkCharacterNftWithRetry,
  readCharacterNftOwner,
  resolveListSellerPayout,
  serverMintCharacterFor,
  verifyCharacterNftOwner,
  type CharacterMintClientConfig,
} from "./lok-vault";
import {
  enqueuePendingCancel,
  startNftTransferAskCancelWatcher,
} from "./nft-transfer-ask-cancel";
import { sessionOwnsCharacter, nftOwnerCache } from "./nft-owner-cache";
import {
  clearListingOpened,
  consumeCancelBudget,
  consumeListBudget,
  listingMinLifetimeOk,
  noteListingOpened,
} from "./lok-list-rate";
import { startListingBalanceProbe } from "./listing-balance-probe";
import { migrateCharacterWalletsToNftOwners } from "./nft-wallet-migrate";
import {
  assertProductionContractsLive,
  assertProductionEnvShape,
  isProductionSettlementChain,
} from "./production-boot";
import {
  WS_AUTH_DEADLINE_MS,
  WS_MAX_PAYLOAD,
  clearWsMessageBudget,
  consumeWsMessage,
  noteWsConnect,
  noteWsDisconnect,
  wsIpExemptFromCaps,
} from "./ws-limits";
import {
  envSettlementChainId,
  refreshSettlementChainIdFromRpc,
  settlementExampleAskHuman,
  settlementUnitSymbol,
} from "./settlement-chain";
import { loadEezClientConfig, type EezSyncBuyClientConfig } from "./eez-sync";
import { guardedKekMove, withPlayerCharge } from "./kek-guard";
import { characterNameKey, normalizeCharacterName } from "./character-name";
import { randomBytes } from "node:crypto";
import { authAllowlist, authVerifyClient, clientAddress, dropAuthConnection, issueAuthChallenge, resolveAuthOrigin, verifyAuthLogin, isEthAddress } from "./wallet-auth";
import { defaultLokDir, LokWorld } from "./lok-world";
import { readPlayerProgress, reconcileCharacterProgress, playerProgressPath, rememberLedger, chargeSkillRespec, RESPEC_GOLD_COST, shouldChargeForAbility, type PlayerProgress } from "./player-progress";
import { debugCheatsEnabled } from "./debug-cheats";
import {
  PARTY_INVITE_RANGE,
  PARTY_SHARE_RANGE,
  acceptInvite,
  buildInviteView,
  buildPartySnapshot,
  declineInvite,
  disbandParty,
  invitePlayer,
  kickMember,
  leaveParty,
  onPlayerDisconnect,
  partyAllyWallets,
} from "./party";

type Player = {
  wallet: string;
  /** Stable character slot id within the account (multi-char). */
  charId: string;
  name: string;
  job: JobId;
  gender: "male" | "female" | "pepeka";
  /** Support job — abilities/stats at floor(mainLevel/2). Sprite stays main. */
  subjob: JobId | null;
  level: number;
  xp: number;
  dust: number;
  claimedStarter: boolean;
  inventory: InventorySlot[];
  equip: Equipment;
  x: number;
  y: number;
  z: number;
  zoneId: string;
  baseMats: Record<string, number>;
  /** Craft skill ranks — keys are CraftSkill. */
  craftSkills: Record<string, { level: number; xp: number }>;
  facing: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  tp: number;
  targetId: string | null;
  moveTo: { x: number; z: number } | null;
  anim: UnitSnapshot["anim"];
  flux: boolean;
  aether: boolean;
  quickenUntil: number;
  slowUntil: number;
  levelUpUntil: number;
  hasteUntil: number;
  hastePct: number;
  moveUntil: number;
  movePct: number;
  overclockUntil: number;
  timeSealUntil: number;
  perpetualUntil: number;
  lastEnfeeble: TimAbilityId | null;
  /** Abilities purchased from the Trainer (persists across jobs). */
  learned: AbilityId[];
  /** Master skill tree unlocked nodes (includes free main hub). */
  skillUnlocked: string[];
  /** Unspent skill-tree points (bank; grant on level-up / echoes, spend on unlock). */
  skillPoints: number;
  /** Gather in progress; the item is granted when the channel completes (#67). */
  gathering?: GatherChannel | null;
  /** Prestige points after max level (0â€“100). */
  skillPrestige: number;
  freeStatPoints: number;
  freeStats: Record<AttrKey, number>;
  /** Knight tank buffs */
  bulwarkUntil: number;
  sentinelUntil: number;
  rampartUntil: number;
  coverUntil: number;
  /** Interpose bodyguard window (caster only, not persisted) — see knight-abilities (#79). */
  coverGuardUntil?: number;
  fealtyUntil: number;
  guardianUntil: number;
  protectUntil: number;
  protectPhysMul: number;
  shellUntil: number;
  shellMagMul: number;
  bulwarkFlashUntil: number;
  enmity: number;
  ghostStepUntil: number;
  backbladeUntil: number;
  killEdgeUntil: number;
  shadowPassUntil: number;
  killingStormUntil: number;
  berserkUntil: number;
  defenderUntil: number;
  aggressorUntil: number;
  restraintUntil: number;
  brazenRushUntil: number;
  warcryUntil: number;
  bloodRageUntil: number;
  fighterRageFlashUntil: number;
  arcaneFloodUntil: number;
  elementalSealUntil: number;
  manaWallUntil: number;
  manawellReady: boolean;
  cascadeUntil: number;
  focalNeveUntil: number;
  lastScElement: import("@bellgrave/combat").SorcererElement | null;
  scCastFlashUntil: number;
  divineSealCharges: number;
  divineSealUntil: number;
  solaceRite: boolean;
  miseryRite: boolean;
  miseryEmpowerUntil: number;
  martyrReadyUntil: number;
  devotionReadyUntil: number;
  asylumUntil: number;
  regenUntil: number;
  regenTick: number;
  reraiseUntil: number;
  healAbsorbUntil: number;
  healAbsorbHp: number;
  sacredLightUntil: number;
  blindUntil: number;
  spellbladeUntil: number;
  spellbladeFlashUntil: number;
  focusWeave: boolean;
  corruptReady: boolean;
  spontaneityReady: boolean;
  lockspellReady: boolean;
  widenReady: boolean;
  enSpellUntil: number;
  enSpellBonus: number;
  phalanxUntil: number;
  phalanxPhysMul: number;
  stoneskinUntil: number;
  stoneskinAbsorb: number;
  refreshUntil: number;
  /** MP restored each second while Refresh is active. */
  refreshTick: number;
  nextSwingAt: number;
  animUntil: number;
  /** Keep walk pose briefly after a waypoint so WASD/net gaps don't flicker idle. */
  walkUntil: number;
  /** Cached unlocked abilities (job + weapon skills). */
  unlockCacheKey: string;
  unlockCache: AbilityId[];
  recasts: Partial<Record<AbilityId, number>>;
  lastLog: string[];
  ws: WebSocket;
};

type Mob = {
  id: string;
  name: string;
  x: number;
  z: number;
  facing: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  tp: number;
  targetId: string | null;
  anim: UnitSnapshot["anim"];
  flux: boolean;
  quickenUntil: number;
  slowUntil: number;
  swingPenalty: number;
  gravityUntil: number;
  gravityPct: number;
  bindUntil: number;
  petrifyUntil: number;
  tdImpactUntil: number;
  stunUntil: number;
  distractUntil: number;
  /** Accuracy penalty while distracted (Distract / Distract II). */
  distractAcc: number;
  frazzleUntil: number;
  addleUntil: number;
  silenceUntil: number;
  paraUntil: number;
  blindUntil: number;
  falseGuardUntil: number;
  sleepUntil: number;
  /** Battle Mage Dia — defense eroded */
  diaUntil: number;
  /** Battle Mage Bio — poison DoT */
  bioUntil: number;
  bioTick: number;
  /** Wallet that applied Bio, for DoT kill credit (#69). */
  bioSourceWallet: string | null;
  scImpactUntil: number;
  scImpactElement: import("@bellgrave/combat").SorcererElement | null;
  /** Weapon skill Attack Down */
  atkDownUntil: number;
  atkDownMul: number;
  nextSwingAt: number;
  animUntil: number;
  alive: boolean;
  respawnAt: number;
  /** Unix ms when HP hit 0 — corpse fades then vanishes before respawn timer. */
  deathAt: number;
  /** Home position — respawn here, not at death spot. */
  spawnX: number;
  spawnZ: number;
  y: number;
  aggro: "safe" | "proximity" | "sight" | "sound";
  aggroRange: number;
  linkRange: number;
  fleeUntil: number;
  drops: string[];
  rareDrops: { slug: string; chance: number }[];
  archetype: string;
  /** Player-shared job id — drives AI abilities / engage range / attack curves. */
  job: JobId;
  level: number;
  nextAbilityAt: number;
  /** Unix ms when pending cast resolves (0 = none). Tell leads the hit. */
  pendingCastHitAt: number;
  pendingCastTarget: string | null;
  pendingCastKind: "" | "damage" | "slow" | "miss";
  pendingCastDmg: number;
  pendingCastLog: string;
  pendingCastSlowMs: number;
  pendingCastMovePct: number;
  /** Pending hit is magic (cast auto / bolt) — resolves through mag DT (#55). */
  pendingCastMagic: boolean;
  atkBuffUntil: number;
  atkBuffMul: number;
  /** Idle wander waypoint (NaN = none). */
  roamTx: number;
  roamTz: number;
  /** Next time we may pick a new roam point / leave pause. */
  roamUntil: number;
  /** Brief stand-still between hops/walks. */
  roamPauseUntil: number;
  /** Shiny HQ — promoted on respawn (3%). Non-aggro until player pulls. */
  shiny: boolean;
  /** Ephemeral army clone — not a respawn slot; no chain-summon / no shiny loot. */
  shinyClone: boolean;
  /** Parent HQ id when this is a clone. */
  hqId: string | null;
  /** Living clone ids owned by a shiny HQ. */
  cloneIds: string[];
  /** HQ has already summoned its army (once per life). */
  shinySummoned: boolean;
  /** Wallets that damaged this mob (party kill credit). */
  hitBy: Set<string>;
};

const PORT = Number(process.env.PORT ?? 8787);
/** Cached at boot — snapshot is sync. null until first load finishes (L5). */
let cachedCharacterMint: CharacterMintClientConfig | null = null;
let mintConfigReady = false;
/** M-B: mint env set but load failed — fail closed until a retry succeeds. */
let mintConfigLoadFailed = false;
/** EEZ sync buy after local gate + on-chain mock verify (M-D). */
let cachedEezSyncBuy: EezSyncBuyClientConfig | null = null;
/** Dev cheats (Max Lv). Off unless ALLOW_DEBUG_CHEATS=1. Not implied by a dev NODE_ENV. */
const DEBUG_CHEATS_ENABLED = debugCheatsEnabled();
const players = new Map<string, Player>();
const walletToPlayer = new Map<string, string>();
/** Per-wallet character roster — live progress objects (same refs as active when online). */
const accountRoster = new Map<string, Map<string, Player>>();
/** char/nameCheck rate limits (wallet + IP; maps are pruned each consume). */
const nameCheckBudgetByWallet = new Map<string, { count: number; resetAt: number }>();
const nameCheckBudgetByIp = new Map<string, { count: number; resetAt: number }>();
const NAME_CHECK_MAX_PER_WALLET_PER_MIN = 30;
const NAME_CHECK_MAX_PER_IP_PER_MIN = 120;
const NAME_CHECK_BUDGET_MAP_MAX = 5000;

function pruneNameCheckBudget(map: Map<string, { count: number; resetAt: number }>, now: number): void {
  for (const [key, row] of map) {
    if (now >= row.resetAt) map.delete(key);
  }
  if (map.size <= NAME_CHECK_BUDGET_MAP_MAX) return;
  const sorted = [...map.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  const drop = sorted.length - NAME_CHECK_BUDGET_MAP_MAX;
  for (let i = 0; i < drop; i++) map.delete(sorted[i]![0]);
}

function consumeRateBucket(
  map: Map<string, { count: number; resetAt: number }>,
  key: string,
  maxPerMin: number,
  now: number,
): boolean {
  const row = map.get(key);
  if (!row || now >= row.resetAt) {
    map.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (row.count >= maxPerMin) return false;
  row.count += 1;
  return true;
}

function consumeNameCheckBudget(wallet: string, clientIp: string | undefined): boolean {
  const now = Date.now();
  pruneNameCheckBudget(nameCheckBudgetByWallet, now);
  pruneNameCheckBudget(nameCheckBudgetByIp, now);
  const ip = clientIp?.trim();
  if (ip && !consumeRateBucket(nameCheckBudgetByIp, ip, NAME_CHECK_MAX_PER_IP_PER_MIN, now)) {
    return false;
  }
  return consumeRateBucket(
    nameCheckBudgetByWallet,
    wallet.toLowerCase(),
    NAME_CHECK_MAX_PER_WALLET_PER_MIN,
    now,
  );
}

/** Unlimited roster until onchain mint-fee gating is enforced. */
let tick = 0;
/** Pale Hollow Segment A field mobs. */
let mobs: Mob[] = spawnSegmentAPack();
let fieldNodes: FieldNode[] = createPaleHollowNodes();

function kickWalletSessions(wallet: string, reason: string): void {
  const w = wallet.trim().toLowerCase();
  if (!w) return;
  for (const [id, p] of [...players.entries()]) {
    if (p.wallet?.toLowerCase() !== w && id !== w) continue;
    try {
      pushLog(p, reason);
      send(p.ws, { type: "error", message: reason });
      p.ws.close(4001, "ownership");
    } catch {
      /* ignore */
    }
    rememberPlayer(p);
    players.delete(id);
    walletToPlayer.delete(id);
  }
}

/**
 * #271: drop a character from every accountRoster so the new NFT owner can adopt
 * and the seller cannot char/enter after Transfer.
 */
function releaseCharacterFromRoster(charId: string, reason?: string): Player | undefined {
  let found: Player | undefined;
  for (const [wallet, slots] of [...accountRoster.entries()]) {
    const p = slots.get(charId);
    if (!p) continue;
    found = p;
    slots.delete(charId);
    if (slots.size === 0) accountRoster.delete(wallet);
    rememberPlayer(p);
    for (const [id, live] of [...players.entries()]) {
      if (live.charId !== charId) continue;
      try {
        if (reason) {
          pushLog(live, reason);
          send(live.ws, { type: "error", message: reason });
        }
        live.ws.close(4001, "ownership");
      } catch {
        /* ignore */
      }
      players.delete(id);
      walletToPlayer.delete(id);
    }
  }
  return found;
}

/** Live NFT ownership gate for session-bound character actions (#252 / #274). */
async function requireLiveCharacterOwner(p: Player): Promise<boolean> {
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required.");
    return false;
  }
  const token = lok.tokenFor(p.charId);
  if (!token) return true;
  const owned = await sessionOwnsCharacter(p.wallet, token, { preferLive: true });
  if (owned.ok) return true;
  pushLog(p, owned.error);
  try {
    send(p.ws, { type: "error", message: owned.error });
  } catch {
    /* ignore */
  }
  releaseCharacterFromRoster(p.charId, owned.error);
  return false;
}

const lok: LokWorld = await (async (): Promise<LokWorld> => {
  try {
    loadLokEnv();
    applySettlementDeployFile();
    const bootShape = assertProductionEnvShape(process.env);
    if (!bootShape.ok) {
      console.error("[bellgrave] FATAL production boot: " + bootShape.error);
      process.exit(1);
    }
    const bootLive = await assertProductionContractsLive(process.env);
    if (!bootLive.ok) {
      console.error("[bellgrave] FATAL production contracts: " + bootLive.error);
      process.exit(1);
    }
    const world = LokWorld.open(defaultLokDir());
    configureMintClaimNonceStore(pathJoin(defaultLokDir(), "mint-claim-nonces.json"));
    console.log(
      "[bellgrave] lok log " + world.logPath + " entries=" + world.length + ". " + world.chainNote,
    );
    void refreshSettlementChainIdFromRpc(process.env).catch((err) =>
      console.warn("[bellgrave] settlement chain id refresh failed", err),
    );
    startAskFilledWatcher(world, {
      onFilled: (fill) => {
        notifyAhEscrowFill(fill);
      },
    });
    startNftTransferAskCancelWatcher(world, {
      onOwnershipChange: (change) => {
        if (change.from && change.from !== change.to) {
          const reason =
            "Character NFT #" +
            change.tokenId +
            " transferred to " +
            change.to +
            ". Session control released.";
          // #271: release roster by charId so buyer adoptOrphanLogs can bind.
          if (change.charId) {
            releaseCharacterFromRoster(change.charId, reason);
          }
          kickWalletSessions(change.from, reason);
        }
      },
    });
    // Block sessions until C-1 rebind finishes (no pre-migration logins).
    try {
      const migrated = await migrateCharacterWalletsToNftOwners(world);
      console.log(
        "[bellgrave] C-1 wallet migration checked=" +
          migrated.checked +
          " rebound=" +
          migrated.rebound +
          " errors=" +
          migrated.errors.length,
      );
    } catch (err) {
      console.error("[bellgrave] C-1 wallet migration failed", err);
    }
    startListingBalanceProbe();
    if (ahEscrowAddress() && !listingRoleKey()) {
      console.error(
        "[bellgrave] AhEscrow is configured but LOK_LISTING_KEY is missing. " +
          "Set LOK_LISTING_KEY to the LISTING_ROLE key from Deploy; owner-key fallback is disabled.",
      );
    }
    void reconcileOpenAsksFromChain(world).catch((err) =>
      console.error("[bellgrave] ask reconcile failed", err),
    );
    const moved = reconcilePlayers(world);
    if (moved > 0) console.log("[bellgrave] moved " + moved + " log item stack(s) into character bags");
    void ensureLocalRuleset().catch(() => {
      console.error("[bellgrave] ruleset check failed");
    });
    const refreshMintConfig = () => {
      void loadCharacterMintClientConfig(process.env, {
        logNextTokenId: world.nextTokenId(),
      })
        .then((loaded) => {
          if (loaded.status === "ready") {
            cachedCharacterMint = loaded.config;
            mintConfigReady = true;
            mintConfigLoadFailed = false;
            if (!loaded.config.supportsCreateFor) {
              console.warn(
                "[bellgrave] CharacterFactory has no createCharacterFor (pre-4cf0bce deploy). " +
                  "Client uses createCharacter; set LOK_DEV_FAUCET (default on with owner key) or " +
                  "LOK_DEV_SERVER_MINT=1 after a factory upgrade. Do not redeploy the shared anvil ad-hoc.",
              );
            }
            return;
          }
          if (loaded.status === "disabled") {
            cachedCharacterMint = null;
            mintConfigReady = true;
            mintConfigLoadFailed = false;
            return;
          }
          // M-B: env configured but RPC/read failed — refuse free creates and retry.
          cachedCharacterMint = null;
          mintConfigReady = true;
          mintConfigLoadFailed = true;
          console.error(
            "[bellgrave] character mint config failed (fail-closed until reload): " + loaded.error,
          );
          setTimeout(refreshMintConfig, 5_000).unref?.();
        })
        .catch((err) => {
          if (characterMintEnvConfigured(process.env)) {
            cachedCharacterMint = null;
            mintConfigReady = true;
            mintConfigLoadFailed = true;
            console.error("[bellgrave] character mint config failed (fail-closed until reload)", err);
            setTimeout(refreshMintConfig, 5_000).unref?.();
          } else {
            mintConfigReady = true;
            mintConfigLoadFailed = false;
            console.error("[bellgrave] character mint config failed", err);
          }
        });
    };
    refreshMintConfig();
    void loadEezClientConfig(process.env)
      .then((cfg) => {
        cachedEezSyncBuy = cfg;
        if (cfg?.syncBuyEnabled) {
          console.log(
            "[bellgrave] EEZ local mock sync buy enabled zone=" +
              (cfg.zoneId ?? "?") +
              " mock=" +
              (cfg.mockSyncBuy ?? "?"),
          );
        }
      })
      .catch((err) => console.error("[bellgrave] EEZ sync buy config failed", err));
    return world;
  } catch (err) {
    console.error("[bellgrave] lok log failed to open; refusing to start.", err);
    process.exit(1);
  }
})();

function reconcilePlayers(world: LokWorld): number {
  const rows = reconcileCharacterProgress({
    dir: defaultLokDir(),
    chars: world.boundChars(),
    levelOf: (id) => world.levelOf(id),
    itemsOf: (id) => world.view(id).items,
    abilitiesOf: (id) => world.abilitiesOf(id),
    isLearnedAbility: (id) => isAbilityId(id),
    isSkillNode: (id) => isSkillNodeId(id),
    // Same cost table as unlocks: hearts are free, other nodes cost 1 (#75).
    isFreeNode: (id) => skillNodeCost(id) === 0,
    craftSkillsOf: (id) => world.craftSkillsOf(id),
    droppedOf: (id) => world.droppedSkillsOf(id),
    recordNode: (id, nodeId) => world.learnAbility(id, nodeId),
    recordCraft: (id, skillId, level) => world.craftSkill(id, skillId, level),
    freeHubsOf: (charId, progress) => {
      const row = world.boundChars().find((c) => c.charId === charId);
      const jobId = row ? JOB_IDS[row.job] : undefined;
      const job = jobId && isJobId(jobId) && JOBS[jobId].playable ? jobId : "time_mage";
      const sub = progress.subjob && isJobId(progress.subjob) ? progress.subjob : null;
      return freeSkillHubs(job, sub, progress.skillUnlocked);
    },
    exportItem: (id, itemId, amount) => world.exportItem(id, itemId, amount),
    skillPointsForLevel: (level) => skillPointsGrantedForLevels(0, level),
    skillUnlocked: (charId) => {
      const row = world.boundChars().find((c) => c.charId === charId);
      const jobId = row ? JOB_IDS[row.job] : undefined;
      const job = jobId && isJobId(jobId) && JOBS[jobId].playable ? jobId : "time_mage";
      return initialUnlockedForJob(job);
    },
    slugOf: (id) => {
      const def = getItem(id);
      return def && def.kind === "base" ? def.slug : null;
    },
    craftSkills: () => emptyCraftSkills(),
    equip: () => ({ ...emptyEquipment() }),
  });
  return rows.reduce((sum, row) => sum + row.moved, 0);
}

function applySaved(p: Player, saved: PlayerProgress) {
  p.level = saved.level;
  p.xp = saved.xp;
  p.inventory = saved.inventory.map((row) => ({ ...row }));
  p.baseMats = { ...saved.baseMats };
  p.equip = { ...emptyEquipment(), ...saved.equip };
  p.craftSkills = saved.craftSkills as Player["craftSkills"];
  p.learned = [...saved.learned] as AbilityId[];
  p.skillUnlocked = [...saved.skillUnlocked];
  p.skillPoints = saved.skillPoints;
  p.skillPrestige = saved.skillPrestige;
  p.freeStats = { str: 0, dex: 0, vit: 0, agi: 0, int: 0, mnd: 0, ...saved.freeStats };
  p.freeStatPoints = saved.freeStatPoints;
  p.claimedStarter = saved.claimedStarter;
  p.dust = saved.dust;
  if (saved.subjob && isJobId(saved.subjob)) p.subjob = saved.subjob;
  syncVitals(p, true);
}

function rememberPlayer(p: Player) {
  try {
    const path = playerProgressPath(defaultLokDir(), p.charId);
    rememberLedger(path, (flags) => ({
      version: 1,
      level: p.level,
      xp: p.xp,
      inventory: p.inventory.map((row) => ({
        tokenId: row.tokenId,
        amount: row.amount,
        ...(row.starter ? { starter: true } : {}),
      })),
      baseMats: { ...p.baseMats },
      equip: { ...p.equip },
      craftSkills: p.craftSkills,
      learned: [...p.learned],
      skillUnlocked: [...p.skillUnlocked],
      skillPoints: skillPointsRemaining(p),
      skillPrestige: p.skillPrestige,
      freeStats: { ...p.freeStats },
      freeStatPoints: p.freeStatPoints,
      claimedStarter: p.claimedStarter,
      dust: p.dust,
      subjob: p.subjob,
      logItemsMoved: flags.logItemsMoved,
      logItemsCopied: flags.logItemsCopied,
      ...(flags.logCopied ? { logCopied: { ...flags.logCopied } } : {}),
    }));
  } catch {
    console.error("[bellgrave] character save failed");
  }
}

function lokToken(p: Player): string {
  const existing = lok.tokenFor(p.charId);
  if (existing) return existing;
  const job = JOB_IDS.indexOf(p.job);
  const res = lok.spawn(p.charId, p.name, job < 0 ? 0 : job, p.wallet);
  return res.ok ? res.tokenId : "";
}

function logLokAbility(p: Player, abilityId: string) {
  const token = lokToken(p);
  if (!token || !abilityId) return;
  const res = lok.learnAbility(token, abilityId);
  if (!res.ok && !/already known/i.test(res.error)) {
    pushLog(p, "Ability was not written to your log: " + res.error);
  }
}

function syncLokLevel(p: Player) {
  const token = lokToken(p);
  if (!token) return;
  let logged = lok.levelOf(token);
  if (logged <= 0) return;
  while (logged < p.level) {
    const next = logged + 1;
    const res = lok.levelUp(token, next);
    if (!res.ok) {
      pushLog(p, "Level was not written to your log: " + res.error);
      return;
    }
    logged = next;
  }
}

function logLokCraft(p: Player, itemId: number, amount: number): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(itemId) || itemId <= 0 || amount <= 0) {
    return { ok: false, error: "bad craft args" };
  }
  const token = lokToken(p);
  if (!token) return { ok: false, error: "no log identity" };
  const res = lok.craft(token, String(itemId), String(amount));
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

function logLokHarvest(p: Player, materialId: string, amount: number) {
  if (!materialId || amount <= 0) return;
  const token = lokToken(p);
  if (!token) return;
  const res = lok.harvest(token, materialId, String(amount));
  if (!res.ok) pushLog(p, "Gather was not written to your log: " + res.error);
  else {
    // Placeholder harvest faucet until E5 budget sheet lands (10 gold per unit).
    earnLogGold(p, "harvest", amount * 10);
  }
}

function logLokDrop(p: Player, itemId: number, amount: number) {
  if (!Number.isInteger(itemId) || itemId <= 0 || amount <= 0) return;
  const token = lokToken(p);
  if (!token) return;
  // LootDrop is a counter like Harvest. It does not mint; ItemDrop is closed for new appends.
  const res = lok.lootDrop(token, String(itemId), String(amount));
  if (!res.ok) pushLog(p, "Loot was not written to your log: " + res.error);
}

function itemLabel(tokenId: number): string {
  return getItem(tokenId)?.name ?? "item " + tokenId;
}

function tellToken(tokenId: string, message: string) {
  for (const slots of accountRoster.values()) {
    for (const pl of slots.values()) {
      if (lok.tokenFor(pl.charId) !== tokenId) continue;
      if (pl.ws.readyState !== pl.ws.OPEN) continue;
      pushLog(pl, message);
    }
  }
}

/** Native settlement unit label — prefers RPC eth_chainId cache, else LOK_CHAIN_ID. */
function settlementUnit(): string {
  return settlementUnitSymbol();
}

function settlementExampleAsk(): string {
  return settlementExampleAskHuman();
}

/** After AhEscrow AskFilled → chainFill: notify buyer/seller and refresh snapshots. */
function notifyAhEscrowFill(fill: AskFilledApplied) {
  const item = itemLabel(Number(fill.itemId));
  const unit = settlementUnit();
  tellToken(
    fill.buyerTokenId,
    "Bought " +
      item +
      " x" +
      fill.amount +
      " for " +
      fill.priceWei +
      " wei " +
      unit +
      " on-chain. It is in your Provisioner inbox.",
  );
  if (fill.sellerTokenId && fill.sellerTokenId !== fill.buyerTokenId) {
    tellToken(
      fill.sellerTokenId,
      "Your " +
        item +
        " ask #" +
        fill.listingId +
        " sold for " +
        fill.priceWei +
        " wei " +
        unit +
        " (paid on-chain).",
    );
  }
  broadcastSnapshots();
}

function handleLokImport(p: Player, tokenId: number, amount: number) {
  void requireLiveCharacterOwner(p).then((ok) => {
    if (!ok) return;
    const starter = starterAmount(p.inventory, tokenId);
    const plain = stackAmount(p.inventory, tokenId) - starter;
    if (starter > 0 && amount > plain) {
      pushLog(
        p,
        "Starter gear cannot be imported, listed, traded, or exported. Discard it from your bag if you do not want it. Nothing was moved.",
      );
      return;
    }
    if (!Number.isInteger(amount) || amount <= 0 || plain < amount) {
      pushLog(p, "You do not have that many to import. Nothing was moved.");
      return;
    }
    const token = lokToken(p);
    if (!token) {
      pushLog(p, "Could not open your log identity.");
      return;
    }
    const def = getItem(tokenId);
    if (def && def.kind === "base") {
      if (!takeMat(p, def.slug, amount)) {
        pushLog(p, "You do not have that many to import. Nothing was moved.");
        return;
      }
    } else if (!takeItem(p.inventory, tokenId, amount)) {
      pushLog(p, "You do not have that many to import. Nothing was moved.");
      return;
    }
    // Persist the bag before the log append so a crash cannot restore a bag that still has the stack.
    rememberPlayer(p);
    const res = lok.importFromBag(token, String(tokenId), String(amount));
    if (!res.ok) {
      if (def && def.kind === "base") grantBaseMat(p, def.slug, amount);
      else addItem(p.inventory, tokenId, amount);
      rememberPlayer(p);
      pushLog(p, res.error);
      return;
    }
    pushLog(p, "Imported " + itemLabel(tokenId) + " x" + amount + " from your bag into the log.");
    send(p.ws, snapshotFor(p));
  });
}

function handleLokExport(p: Player, tokenId: number, amount: number) {
  void requireLiveCharacterOwner(p).then((ok) => {
    if (!ok) return;
    const token = lokToken(p);
    if (!token) {
      pushLog(p, "Could not open your log identity.");
      return;
    }
    // Log-bag export uses the catalog id. Launch fungibles also resolve a chain id for
    // operators (mint/withdraw path not wired yet). Equipment has no unique Items id.
    const chainFungible = isLaunchExportableFungible(tokenId) ? catalogIdToChainFungibleId(tokenId) : null;
    const res = lok.exportItem(token, String(tokenId), String(amount));
    if (!res.ok) {
      pushLog(p, res.error);
      return;
    }
    addItem(p.inventory, tokenId, amount);
    const exported = getItem(tokenId);
    if (exported && exported.kind === "base") {
      p.baseMats[exported.slug] = (p.baseMats[exported.slug] ?? 0) + amount;
    }
    rememberPlayer(p);
    const chainNote =
      chainFungible != null
        ? " Chain fungible id 0x" + chainFungible.toString(16) + " (Items mint not submitted)."
        : " No chain withdrawal was submitted.";
    pushLog(p, "Exported " + itemLabel(tokenId) + " x" + amount + " to your bag." + chainNote);
    send(p.ws, snapshotFor(p));
  });
}

function playerByCharId(charId: string): Player | undefined {
  for (const slots of accountRoster.values()) {
    const pl = slots.get(charId);
    if (pl) return pl;
  }
  return undefined;
}

function rosterNameTaken(name: string, exceptCharId?: string): boolean {
  const key = characterNameKey(name);
  if (!key) return false;
  for (const slots of accountRoster.values()) {
    for (const pl of slots.values()) {
      if (pl.charId === exceptCharId) continue;
      if (characterNameKey(pl.name) === key) return true;
    }
  }
  return false;
}

function resolveSendTarget(
  p: Player,
  to: string,
  selfToken: string,
): { ok: true; tokenId: string; name: string } | { ok: false; error: string } {
  const direct = lok.resolveRecipient(to, selfToken);
  if (direct.ok || /yourself|ambiguous/i.test(direct.error)) return direct;
  const found = playerByCharId(to.trim());
  if (!found) return direct;
  if (found.charId === p.charId) return { ok: false, error: "You cannot send to yourself." };
  const tokenId = lokToken(found);
  if (!tokenId) return { ok: false, error: "That character is not on the log." };
  if (tokenId === selfToken) return { ok: false, error: "You cannot send to yourself." };
  return { ok: true, tokenId, name: found.name };
}

function handleLokSendItem(p: Player, to: string, tokenId: number, amount: number) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required to send items.");
    return;
  }
  void sessionOwnsCharacter(p.wallet, token).then((owned) => {
    if (!owned.ok) {
      pushLog(p, owned.error);
      return;
    }
    const dest = resolveSendTarget(p, to, token);
    if (!dest.ok) {
      pushLog(p, dest.error);
      return;
    }
    const res = lok.sendInbox(token, dest.tokenId, String(tokenId), String(amount));
    if (!res.ok) {
      pushLog(p, res.error);
      return;
    }
    pushLog(p, "Sent " + itemLabel(tokenId) + " x" + amount + " to " + dest.name + ". It is in their Provisioner inbox.");
    tellToken(dest.tokenId, p.name + " sent you " + itemLabel(tokenId) + " x" + amount + ". Take it from the Provisioner inbox.");
    send(p.ws, snapshotFor(p));
  });
}

function handleLokSendKek(p: Player, _to: string, _amount: string) {
  refuseFundCustody(p, "Send ETH");
}

function failAction(p: Player, label: string): void {
  console.error("[bellgrave] " + label + " failed");
  try {
    pushLog(p, label + " failed before it finished.");
    send(p.ws, snapshotFor(p));
  } catch {
    /* the socket may already be gone */
  }
}

/** UTC day id stamped on GoldEarn / GoldSell (engine daily caps). */
function serverGoldDay(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 86_400_000);
}

/** Spend in-game gold (trainer, craft, respec). Not vault KEK / WETH. */
function spendLogGold(
  p: Player,
  amount: number,
  sink: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isSafeInteger(amount) || amount < 0) return Promise.resolve({ ok: false, error: "Bad gold cost." });
  if (amount === 0) return Promise.resolve({ ok: true });
  return requireLiveCharacterOwner(p).then((ok) => {
    if (!ok) return { ok: false as const, error: "Character NFT ownership required." };
    const token = lokToken(p);
    if (!token) return { ok: false as const, error: "Could not open your log identity." };
    return guardedKekMove(token, async () => {
      let bal: bigint;
      let cost: bigint;
      try {
        bal = BigInt(lok.goldOf(token));
        cost = BigInt(amount);
      } catch {
        return { ok: false as const, error: "Bad gold balance." };
      }
      if (bal < cost) return { ok: false as const, error: "Need " + amount + " gold (you have " + bal.toString() + ")." };
      return lok.goldSpend(token, sink, String(amount));
    });
  });
}

function earnLogGold(p: Player, source: string, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  const token = lokToken(p);
  if (!token) return;
  const res = lok.goldEarn(token, source, String(amount), serverGoldDay());
  if (!res.ok) pushLog(p, "Gold was not written to your log: " + res.error);
}

/** Small gold drip on mob kills (5–25). */
function mobKillGoldDrop(): number {
  return 5 + Math.floor(Math.random() * 21);
}

function refuseFundCustody(p: Player, action: string) {
  pushLog(
    p,
    action +
      " is closed. The log does not hold " +
      settlementUnit() +
      " — auction house and PvP pay on-chain via EEZ. Nothing was changed.",
  );
  send(p.ws, snapshotFor(p));
}

function handleLokDeposit(p: Player, _amount: string) {
  refuseFundCustody(p, "Deposit");
}

function handleLokWithdrawKek(p: Player, _amount: string) {
  refuseFundCustody(p, "Withdrawal");
}

function handleLokClaim(p: Player, _id: string) {
  refuseFundCustody(p, "Claim");
}

function handleLokList(
  p: Player,
  tokenId: number,
  amount: number,
  minPrice: string,
  _clientSellerPayout?: string,
) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  // minPrice is wei (client parseEther). Cap length so we stay under uint256.
  const unit = settlementUnit();
  if (!/^[1-9][0-9]{0,76}$/.test(minPrice)) {
    pushLog(p, "Enter a minimum price greater than 0 (" + unit + "). Nothing was listed.");
    return;
  }
  // Reject KEK-era unit sizes mistaken for wei (live #7 was 5000). Floor = 1 gwei.
  try {
    if (BigInt(minPrice) < 1_000_000_000n) {
      pushLog(
        p,
        "Ask price is below 1 gwei. Enter a " +
          unit +
          " price (e.g. " +
          settlementExampleAsk() +
          "). Nothing was listed.",
      );
      return;
    }
  } catch {
    pushLog(p, "Enter a minimum price greater than 0 (" + unit + "). Nothing was listed.");
    return;
  }
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required to list for " + unit + ". Nothing was listed.");
    return;
  }
  if (!ahEscrowAddress()) {
    pushLog(p, "AhEscrow is not configured on this server. Nothing was listed.");
    return;
  }
  // Ownership + per-char/wallet first; global LISTING budget is charged in openAskOnchain.
  void (async () => {
    const ctrl = await sessionOwnsCharacter(p.wallet!, token);
    if (!ctrl.ok) {
      pushLog(p, ctrl.error);
      return;
    }
    const listBudget = consumeListBudget({ charId: p.charId, wallet: p.wallet! });
    if (!listBudget.ok) {
      pushLog(p, listBudget.error);
      return;
    }
    const owned = await readCharacterNftOwner(token);
    const resolved = resolveListSellerPayout(owned.ok ? owned.holder : null);
    if (!resolved.ok) {
      pushLog(p, resolved.error);
      return;
    }
    const ownerAtList = resolved.payout;
    nftOwnerCache().set(token, ownerAtList, 0);
    const listedAt = Math.floor(Date.now() / 1000);
    const res = lok.ask(token, String(tokenId), String(amount), minPrice, listedAt);
    if (!res.ok || !res.listingId) {
      pushLog(p, res.ok ? "Listing id missing." : res.error);
      return;
    }
    const listingId = res.listingId;
    noteListingOpened(listingId);
    const chain = await openAskOnchain({
      listingId,
      sellerTokenId: token,
      itemId: String(tokenId),
      amount: String(amount),
      priceWei: minPrice,
    });
    if (!chain.ok) {
      // N4: if the ask mined despite a receipt/RPC error, keep the log listing.
      if (chain.chainOpen) {
        // Still re-check ownership — a Transfer may have raced the openAsk.
        const raced = await readCharacterNftOwner(token);
        if (!raced.ok || raced.holder !== ownerAtList) {
          const pulled = await cancelAskOnchain({ listingId });
          if (pulled.ok && !("alreadyClosed" in pulled && pulled.alreadyClosed)) {
            lok.cancelAsk(listingId, token);
            clearListingOpened(listingId);
          }
          pushLog(
            p,
            "Character NFT owner changed while listing #" +
              listingId +
              ". The ask was cancelled.",
          );
          send(p.ws, snapshotFor(p));
          return;
        }
        pushLog(
          p,
          "On-chain ask open for #" +
            listingId +
            " but confirmation failed (" +
            chain.error +
            "). The log listing was left open.",
        );
        send(p.ws, snapshotFor(p));
        return;
      }
      const undone = lok.cancelAsk(listingId, token);
      clearListingOpened(listingId);
      pushLog(
        p,
        "On-chain ask failed (" +
          chain.error +
          "). " +
          (undone.ok ? "The log listing was cancelled." : "The log listing could not be cancelled: " + undone.error),
      );
      send(p.ws, snapshotFor(p));
      return;
    }
    // List/transfer race: Transfer scanned before this ask was open would miss it.
    // Re-check ownerOf after openAsk confirms; cancel if ownership changed.
    const after = await readCharacterNftOwner(token);
    if (!after.ok || after.holder !== ownerAtList) {
      const pulled = await cancelAskOnchain({ listingId });
      if (pulled.ok && !("alreadyClosed" in pulled && pulled.alreadyClosed)) {
        const undone = lok.cancelAsk(listingId, token);
        clearListingOpened(listingId);
        if (!undone.ok) {
          enqueuePendingCancel({ listingId, sellerTokenId: token });
        }
        pushLog(
          p,
          "Character NFT owner changed while listing #" +
            listingId +
            ". " +
            (undone.ok
              ? "The ask was cancelled."
              : "On-chain cancel ok; log cancel failed: " +
                undone.error +
                ". Queued for the transfer-cancel watcher to retry."),
        );
      } else if (!pulled.ok) {
        enqueuePendingCancel({ listingId, sellerTokenId: token });
        pushLog(
          p,
          "Character NFT owner changed while listing #" +
            listingId +
            ", but cancel failed (" +
            pulled.error +
            "). Queued for the transfer-cancel watcher to retry.",
        );
      } else {
        // On-chain already closed — if log cancel was needed it would be in the cancel branch.
        // Still queue so ambiguous closed-asks get classified on the next watcher tick.
        enqueuePendingCancel({ listingId, sellerTokenId: token, ambiguous: true });
        pushLog(
          p,
          "Character NFT owner changed while listing #" +
            listingId +
            ". On-chain ask was already closed; queued for watcher classify/retry.",
        );
      }
      send(p.ws, snapshotFor(p));
      return;
    }
    pushLog(
      p,
      "Listed " +
        itemLabel(tokenId) +
        " x" +
        amount +
        " as #" +
        listingId +
        " for " +
        minPrice +
        " wei " +
        settlementUnit() +
        " on AhEscrow. The auction house is holding the item.",
    );
    send(p.ws, snapshotFor(p));
  })();
}

function handleLokBuy(p: Player, _itemId: number, _qty?: number) {
  const token = lokToken(p);
  if (!token || !p.wallet || !isEthAddress(p.wallet)) {
    refuseFundCustody(p, "Log-balance buy");
    return;
  }
  void sessionOwnsCharacter(p.wallet, token, { preferLive: true }).then((owned) => {
    if (!owned.ok) {
      pushLog(p, owned.error);
      return;
    }
    refuseFundCustody(p, "Log-balance buy");
  });
}

function handleLokBid(p: Player, _itemId: number, _amount: string) {
  const token = lokToken(p);
  if (!token || !p.wallet || !isEthAddress(p.wallet)) {
    refuseFundCustody(p, "Log-balance bid");
    return;
  }
  void sessionOwnsCharacter(p.wallet, token, { preferLive: true }).then((owned) => {
    if (!owned.ok) {
      pushLog(p, owned.error);
      return;
    }
    refuseFundCustody(p, "Log-balance bid");
  });
}

function handleLokCancel(p: Player, listingId: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required to cancel a listing.");
    return;
  }
  const lifetime = listingMinLifetimeOk(listingId);
  if (!lifetime.ok) {
    pushLog(p, lifetime.error);
    return;
  }
  const row = lok.view(token).listings.find((l) => l.id === listingId);
  if (!row) {
    pushLog(p, "Unknown listing. Nothing was cancelled.");
    return;
  }
  // Ownership + listing exist first; global budget charged only in cancelAskOnchain broadcast.
  void (async () => {
    const ctrl = await sessionOwnsCharacter(p.wallet!, token, { preferLive: true });
    if (!ctrl.ok) {
      pushLog(p, ctrl.error);
      send(p.ws, snapshotFor(p));
      return;
    }
    const cancelBudget = consumeCancelBudget({ charId: p.charId, wallet: p.wallet! });
    if (!cancelBudget.ok) {
      pushLog(p, cancelBudget.error);
      send(p.ws, snapshotFor(p));
      return;
    }
    if (!row.book) {
      const res = lok.cancel(listingId, token);
      if (!res.ok) pushLog(p, res.error);
      else {
        clearListingOpened(listingId);
        pushLog(p, "Cancelled listing #" + listingId + ". Escrow returned.");
      }
      send(p.ws, snapshotFor(p));
      return;
    }
    if (!ahEscrowAddress()) {
      pushLog(p, "AhEscrow is not configured; cannot cancel an on-chain ask safely.");
      send(p.ws, snapshotFor(p));
      return;
    }
    pushLog(p, "Cancel pending for listing #" + listingId + " (waiting for finality)…");
    send(p.ws, snapshotFor(p));
    const chain = await cancelAskOnchain({ listingId });
    if (!chain.ok) {
      pushLog(p, "On-chain cancel failed (" + chain.error + "). The log listing was left open.");
      send(p.ws, snapshotFor(p));
      return;
    }
    if (chain.alreadyClosed && !chain.serverCancelled) {
      pushLog(
        p,
        "On-chain ask #" +
          listingId +
          " was already closed (likely filled). Waiting for AskFilled to mirror the item. Log listing left open.",
      );
      send(p.ws, snapshotFor(p));
      return;
    }
    // neverOpened / serverCancelled: cancel on the log.
    const res = lok.cancelAsk(listingId, token);
    clearListingOpened(listingId);
    if (!res.ok) {
      pushLog(
        p,
        chain.neverOpened
          ? "Log cancel failed: " + res.error
          : "On-chain ask cancelled, but the log cancel failed: " + res.error,
      );
    } else {
      pushLog(
        p,
        chain.neverOpened
          ? "Cancelled pre-AhEscrow listing #" + listingId + ". The stack is in your Provisioner inbox."
          : "Cancelled listing #" + listingId + ". The stack is in your Provisioner inbox.",
      );
    }
    send(p.ws, snapshotFor(p));
  })();
}

function handleLokReclaim(p: Player, listingId: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required to reclaim a listing.");
    return;
  }
  const lifetime = listingMinLifetimeOk(listingId);
  if (!lifetime.ok) {
    pushLog(p, lifetime.error);
    return;
  }
  if (!ahEscrowAddress()) {
    pushLog(p, "AhEscrow is not configured; cannot reclaim an on-chain ask safely.");
    return;
  }
  void (async () => {
    const ctrl = await sessionOwnsCharacter(p.wallet!, token, { preferLive: true });
    if (!ctrl.ok) {
      pushLog(p, ctrl.error);
      send(p.ws, snapshotFor(p));
      return;
    }
    const cancelBudget = consumeCancelBudget({ charId: p.charId, wallet: p.wallet! });
    if (!cancelBudget.ok) {
      pushLog(p, cancelBudget.error);
      send(p.ws, snapshotFor(p));
      return;
    }
    pushLog(p, "Reclaim pending for listing #" + listingId + " (waiting for finality)…");
    send(p.ws, snapshotFor(p));
    const chain = await cancelAskOnchain({ listingId });
    if (!chain.ok) {
      pushLog(p, "On-chain cancel before reclaim failed (" + chain.error + "). Nothing was reclaimed.");
      send(p.ws, snapshotFor(p));
      return;
    }
    if (chain.alreadyClosed && !chain.serverCancelled) {
      pushLog(
        p,
        "On-chain ask #" + listingId + " was already closed (likely filled). Waiting for AskFilled; nothing reclaimed on the log.",
      );
      send(p.ws, snapshotFor(p));
      return;
    }
    const res = lok.reclaim(listingId, token, Math.floor(Date.now() / 1000));
    clearListingOpened(listingId);
    if (!res.ok) pushLog(p, res.error);
    else {
      pushLog(
        p,
        chain.neverOpened
          ? "Reclaimed pre-AhEscrow listing #" + listingId + " into your Provisioner inbox."
          : "Reclaimed listing #" + listingId + " into your Provisioner inbox.",
      );
    }
    send(p.ws, snapshotFor(p));
  })();
}

function handleLokNpcSell(p: Player, tokenId: number, amount: number) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required to sell to the Provisioner.");
    return;
  }
  if (!Number.isSafeInteger(amount) || amount < 1) {
    pushLog(p, "Enter a positive amount to sell.");
    return;
  }
  const unit = npcSellUnitGold(tokenId);
  const gold = npcSellTotalGold(tokenId, amount);
  if (unit == null || gold == null) {
    pushLog(p, "That stack has no NPC buyback price yet.");
    return;
  }
  void sessionOwnsCharacter(p.wallet, token).then((owned) => {
    if (!owned.ok) {
      pushLog(p, owned.error);
      return;
    }
    const res = lok.goldSell(token, String(tokenId), String(amount), String(gold), serverGoldDay());
    if (!res.ok) {
      pushLog(p, res.error);
      send(p.ws, snapshotFor(p));
      return;
    }
    pushLog(p, "Sold " + itemLabel(tokenId) + " x" + amount + " to the Provisioner for " + gold + " gold.");
    send(p.ws, snapshotFor(p));
  });
}

function handleLokTakeInbox(p: Player, tokenId: number, amount: number) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required to take from the inbox.");
    return;
  }
  void sessionOwnsCharacter(p.wallet, token, { preferLive: true }).then((owned) => {
    if (!owned.ok) {
      pushLog(p, owned.error);
      return;
    }
    const res = lok.takeInbox(token, String(tokenId), String(amount));
    if (!res.ok) {
      pushLog(p, res.error);
      return;
    }
    addItem(p.inventory, tokenId, amount);
    const taken = getItem(tokenId);
    if (taken && taken.kind === "base") {
      p.baseMats[taken.slug] = (p.baseMats[taken.slug] ?? 0) + amount;
    }
    rememberPlayer(p);
    pushLog(p, "Took " + itemLabel(tokenId) + " x" + amount + " out of the Provisioner inbox.");
    send(p.ws, snapshotFor(p));
  });
}

function handleSkillRespec(p: Player) {
  ensureMainHub(p);
  const free = () => new Set(freeSkillHubs(p.job, p.subjob, p.skillUnlocked));
  void chargeSkillRespec({
    charId: p.charId,
    paidNodes: () => p.skillUnlocked.filter((id) => isSkillNodeId(id) && !free().has(id)),
    earnedPoints: skillPointsEarned(p.level, p.skillPrestige),
    kept: (clearIds) => {
      const skip = new Set(clearIds);
      const hubs = free();
      const unlocked: string[] = [];
      for (const id of p.skillUnlocked) {
        if (skip.has(id) && !hubs.has(id)) continue;
        if (!unlocked.includes(id)) unlocked.push(id);
      }
      for (const id of hubs) {
        if (!unlocked.includes(id)) unlocked.push(id);
      }
      return unlocked;
    },
    payAndClear: async (amount, nodeIds) => {
      const token = lokToken(p);
      if (!token) return { ok: false, error: "Could not open your log identity." };
      return guardedKekMove(token, async () => {
        let bal: bigint;
        let cost: bigint;
        try {
          bal = BigInt(lok.goldOf(token));
          cost = BigInt(amount);
        } catch {
          return { ok: false, error: "Bad gold balance." };
        }
        if (bal < cost) return { ok: false, error: "Need " + amount + " gold (you have " + bal.toString() + ")." };
        if (nodeIds.length === 0) return { ok: false, error: "No paid skill nodes to respec." };
        return lok.goldPaidRespec(token, String(amount), nodeIds);
      });
    },
    apply: (unlocked, skillPoints) => {
      p.skillUnlocked = unlocked;
      p.skillPoints = skillPoints;
      ensureMainHub(p);
      rememberPlayer(p);
    },
  }).then((result) => {
    if (!result.ok) pushLog(p, result.error === "no longer available" ? "No paid skill nodes to respec." : result.error);
    else pushLog(p, "Respec paid " + RESPEC_GOLD_COST + " gold. The tree was cleared and the points were refunded.");
    syncVitals(p, false);
    send(p.ws, snapshotFor(p));
  }).catch(() => failAction(p, "Respec"));
}

function handleLokExplore(
  p: Player,
  scope: "yours" | "everyone",
  q: string | undefined,
  beforeSeq: number | undefined,
  req: number | undefined,
) {
  const query = (q ?? "").trim();
  const token = scope === "yours" ? lok.tokenFor(p.charId) : null;
  const reply = (events: { seq: number; hash: string; kind: string; character: string; text: string }[], total: number, hasMore: boolean) => {
    send(p.ws, {
      type: "lok/events",
      scope,
      q: query,
      ...(beforeSeq != null ? { beforeSeq } : {}),
      ...(req != null ? { req } : {}),
      events,
      total,
      hasMore,
    });
  };
  if (scope === "yours" && !token) {
    reply([], 0, false);
    return;
  }
  const page = lok.explore({
    tokenId: scope === "yours" ? token : null,
    q: query,
    beforeSeq: beforeSeq ?? null,
  });
  reply(page.events, page.total, page.hasMore);
}

function handleLokSettle(p: Player, listingId: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  if (!p.wallet || !isEthAddress(p.wallet)) {
    pushLog(p, "A wallet is required to settle a listing.");
    return;
  }
  void sessionOwnsCharacter(p.wallet, token, { preferLive: true }).then((owned) => {
    if (!owned.ok) {
      pushLog(p, owned.error);
      return;
    }
    const row = lok.view(token).listings.find((l) => l.id === listingId);
    const res = lok.settle(listingId);
    if (!res.ok) {
      pushLog(p, res.error);
      return;
    }
    pushLog(p, "Settled listing #" + listingId + ".");
    if (row?.highBidder) {
      tellToken(
        row.highBidder,
        "You won listing #" + listingId + " (" + itemLabel(row.itemId) + " x" + row.amount + ").",
      );
      if (row.seller !== token) {
        tellToken(row.seller, "Listing #" + listingId + " settled for " + row.highBid + " (legacy bid).");
      }
    }
    send(p.ws, snapshotFor(p));
  });
}


const JOB_MASTER = {
  id: "npc-ph-job-master",
  name: "Job Master",
  x: 3.5,
  z: 2.5,
  facing: -Math.PI / 2,
} as const;

/** Pale Hollow Trainer (stable id npc-ph-chronomancer — rename is player-facing). */
const TRAINER = {
  id: "npc-ph-chronomancer",
  name: "Trainer",
  x: -3.2,
  z: 4.8,
  facing: Math.PI,
} as const;

const NPC_INTERACT_RANGE = 3.5;


/** Town hub pad (hub_indoor) — interact from anywhere in the same room. */
function inHubRoom(x: number, z: number): boolean {
  return x >= PH_HUB.minX && x <= PH_HUB.maxX && z >= PH_HUB.minZ && z <= PH_HUB.maxZ;
}

/** Town NPCs: same hub room OR legacy proximity. Field NPCs keep proximity. */
function canReachTownNpc(px: number, pz: number, nx: number, nz: number): boolean {
  if (inHubRoom(px, pz) && inHubRoom(nx, nz)) return true;
  return dist(px, pz, nx, nz) <= NPC_INTERACT_RANGE;
}


function emptyCombatFields() {
  return {
    mp: 40,
    maxMp: 40,
    tp: 0,
    targetId: null as string | null,
    anim: "idle" as const,
    flux: false,
    quickenUntil: 0,
    slowUntil: 0,
    swingPenalty: 0,
    gravityUntil: 0,
    gravityPct: 0,
    bindUntil: 0,
    petrifyUntil: 0,
    tdImpactUntil: 0,
    stunUntil: 0,
    distractUntil: 0,
    distractAcc: 0,
    frazzleUntil: 0,
    addleUntil: 0,
    silenceUntil: 0,
    paraUntil: 0,
    blindUntil: 0,
    falseGuardUntil: 0,
    sleepUntil: 0,
    diaUntil: 0,
    bioUntil: 0,
    bioTick: 0,
    bioSourceWallet: null as string | null,
    scImpactUntil: 0,
    scImpactElement: null as import("@bellgrave/combat").SorcererElement | null,
    atkDownUntil: 0,
    atkDownMul: 1,
    nextSwingAt: 0,
    animUntil: 0,
    alive: true,
    respawnAt: 0,
    deathAt: 0,
    fleeUntil: 0,
    roamTx: Number.NaN,
    roamTz: Number.NaN,
    roamUntil: 0,
    roamPauseUntil: 0,
  };
}

function spawnFieldMob(
  id: string,
  name: string,
  x: number,
  z: number,
  hp: number,
  opts: {
    aggro: Mob["aggro"];
    aggroRange: number;
    linkRange?: number;
    drops: string[];
    rareDrops?: { slug: string; chance: number }[];
    archetype: string;
    job?: JobId | string;
    level?: number;
    shiny?: boolean;
    shinyClone?: boolean;
    hqId?: string | null;
    cloneIds?: string[];
    shinySummoned?: boolean;
  },
): Mob {
  const level = Math.max(1, opts.level ?? 1);
  const job = resolveMobJob(opts.archetype, opts.job as JobId | undefined);
  const mpPool = mobMpForJob(job, level);
  const base = emptyCombatFields();
  const shinyBits = emptyShinyFields();
  return {
    id,
    name,
    x,
    y: paleHollowStandHeight(x, z),
    z,
    spawnX: x,
    spawnZ: z,
    facing: Math.PI,
    hp,
    maxHp: hp,
    ...base,
    mp: mpPool.mp,
    maxMp: mpPool.maxMp,
    aggro: opts.aggro,
    aggroRange: opts.aggroRange,
    linkRange: opts.linkRange ?? 0,
    drops: [...opts.drops],
    rareDrops: [...(opts.rareDrops ?? [])],
    archetype: opts.archetype,
    job,
    level,
    nextAbilityAt: 0,
    pendingCastHitAt: 0,
    pendingCastTarget: null,
    pendingCastKind: "",
    pendingCastDmg: 0,
    pendingCastLog: "",
    pendingCastSlowMs: 0,
    pendingCastMovePct: 0,
    pendingCastMagic: false,
    atkBuffUntil: 0,
    atkBuffMul: 1,
    roamTx: Number.NaN,
    roamTz: Number.NaN,
    // Stagger first wander so packs don't sync-step
    roamUntil: Date.now() + 400 + Math.floor(Math.random() * 1800),
    roamPauseUntil: 0,
    shiny: opts.shiny ?? shinyBits.shiny,
    shinyClone: opts.shinyClone ?? shinyBits.shinyClone,
    hqId: opts.hqId ?? shinyBits.hqId,
    cloneIds: opts.cloneIds ? [...opts.cloneIds] : [...shinyBits.cloneIds],
    shinySummoned: opts.shinySummoned ?? shinyBits.shinySummoned,
    hitBy: new Set(),
  };
}

function spawnSegmentAPack(): Mob[] {
  return createPaleHollowMobs().map((f) =>
    spawnFieldMob(f.id, f.name, f.spawnX, f.spawnZ, f.maxHp, {
      aggro: f.aggro,
      aggroRange: f.aggroRange,
      linkRange: f.linkRange,
      drops: f.drops,
      rareDrops: f.rareDrops,
      archetype: f.archetype,
      job: f.job,
      level: f.level,
    }),
  );
}

/** Summon up to 4 non-shiny clones around the HQ (once per HQ life). */
function ensureShinyArmy(hq: Mob, wallet: string | null, now: number) {
  if (!hq.shiny || hq.shinyClone || hq.shinySummoned || !hq.alive) return;
  hq.shinySummoned = true;
  const pl = wallet ? players.get(wallet) : undefined;
  const ids: string[] = [];
  for (let i = 0; i < SHINY_CLONE_COUNT; i++) {
    const off = formationOffset(hq.facing, i);
    let x = hq.x + off.dx;
    let z = hq.z + off.dz;
    const placed = paleHollowPlaceOnDryLand(x, z);
    x = placed.x;
    z = placed.z;
    const id = `${hq.id}-clone-${i}`;
    const stale = mobs.findIndex((m) => m.id === id);
    if (stale >= 0) mobs.splice(stale, 1);
    const clone = spawnFieldMob(id, hq.name.replace(/^HQ /, "") + " Clone", x, z, hq.maxHp, {
      aggro: "safe",
      aggroRange: 0,
      linkRange: 0,
      drops: [],
      rareDrops: [],
      archetype: hq.archetype,
      job: hq.job,
      level: hq.level,
      shiny: false,
      shinyClone: true,
      hqId: hq.id,
      shinySummoned: true,
    });
    if (wallet) {
      clone.targetId = wallet;
      if (pl) clone.facing = facingTo(clone.x, clone.z, pl.x, pl.z);
    }
    mobs.push(clone);
    ids.push(id);
  }
  hq.cloneIds = ids;
  if (wallet) {
    const p = players.get(wallet);
    if (p) pushLog(p, `${hq.name} summons an army!`);
  }
}

function despawnShinyClones(hq: Mob, now: number) {
  for (const cid of hq.cloneIds) {
    const clone = findMob(cid);
    if (!clone) continue;
    clone.alive = false;
    clone.hp = 0;
    clone.anim = "dead";
    clone.deathAt = now;
    clone.respawnAt = now;
    clone.targetId = null;
  }
  hq.cloneIds = [];
}

/** After killing a player, shiny HQ relocates and clears the fight. */
function shinyFleeAfterPlayerKill(hq: Mob, now: number) {
  if (!hq.shiny || hq.shinyClone) return;
  despawnShinyClones(hq, now);
  hq.targetId = null;
  hq.roamTx = Number.NaN;
  hq.roamTz = Number.NaN;
  let bestX = hq.spawnX;
  let bestZ = hq.spawnZ;
  for (let i = 0; i < 12; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = 18 + Math.random() * 28;
    const tx = hq.x + Math.sin(ang) * r;
    const tz = hq.z + Math.cos(ang) * r;
    const dry = paleHollowPlaceOnDryLand(tx, tz);
    if (paleHollowInBuildingClearing(dry.x, dry.z)) continue;
    bestX = dry.x;
    bestZ = dry.z;
    break;
  }
  hq.spawnX = bestX;
  hq.spawnZ = bestZ;
  hq.facing = facingTo(hq.x, hq.z, bestX, bestZ);
  hq.fleeUntil = now + SHINY_FLEE_RELOCATE_MS;
  hq.anim = "walk";
  const mid = paleHollowPlaceOnDryLand(
    hq.x + (bestX - hq.x) * 0.45,
    hq.z + (bestZ - hq.z) * 0.45,
  );
  hq.x = mid.x;
  hq.z = mid.z;
  syncUnitY(hq);
}

function respawnFieldMobFromDef(slotId: string, defName: string, spawnX: number, spawnZ: number): Mob {
  const def = lookupMobDef(slotId);
  const promote = !!def && rollShinyPromotion();
  if (!def) {
    return spawnFieldMob(slotId, defName, spawnX, spawnZ, 50, {
      aggro: "proximity",
      aggroRange: 4,
      drops: [],
      archetype: "pale_slime",
      level: 1,
    });
  }
  const mob = spawnFieldMob(def.id, def.name, spawnX, spawnZ, def.hp, {
    aggro: def.aggro,
    aggroRange: def.aggroRange,
    linkRange: def.linkRange,
    drops: def.drops,
    rareDrops: def.rareDrops,
    archetype: def.archetype,
    job: def.job,
    level: def.level,
  });
  mob.spawnX = spawnX;
  mob.spawnZ = spawnZ;
  mob.x = spawnX;
  mob.z = spawnZ;
  syncUnitY(mob);
  if (promote) applyShinyPromotion(mob, def);
  return mob;
}


function findMob(id: string | null | undefined): Mob | undefined {
  if (!id) return undefined;
  return mobs.find((m) => m.id === id);
}

function clampToHall(x: number, z: number): { x: number; z: number } {
  return clampPaleHollow(x, z);
}

/** Bounds + walkability (no water / river walls except on bridges). */
function clampPlayerMove(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): { x: number; z: number } {
  return paleHollowClampMove(fromX, fromZ, toX, toZ);
}

function syncUnitY(u: { x: number; y: number; z: number }) {
  u.y = paleHollowStandHeight(u.x, u.z);
}

function pullMobOn(mob: Mob, wallet: string, now: number) {
  if (!mob.alive || now < (mob.fleeUntil ?? 0)) return;
  mob.targetId = wallet;
  mob.roamTx = Number.NaN;
  mob.roamTz = Number.NaN;
  const pl = players.get(wallet);
  if (pl) mob.facing = facingTo(mob.x, mob.z, pl.x, pl.z);
  // Shiny HQ summons its army on first player pull (engage / damage).
  if (mob.shiny && !mob.shinyClone) ensureShinyArmy(mob, wallet, now);
  // Link clone pack to the same fight (they stay aggro:safe for auto-pull).
  if (mob.shiny && !mob.shinyClone) {
    for (const cid of mob.cloneIds) {
      const clone = findMob(cid);
      if (!clone || !clone.alive) continue;
      clone.targetId = wallet;
      clone.roamTx = Number.NaN;
      clone.roamTz = Number.NaN;
      if (pl) clone.facing = facingTo(clone.x, clone.z, pl.x, pl.z);
    }
  } else if (mob.shinyClone && mob.hqId) {
    const hq = findMob(mob.hqId);
    if (hq && hq.alive && !hq.targetId) {
      hq.targetId = wallet;
      if (pl) hq.facing = facingTo(hq.x, hq.z, pl.x, pl.z);
      ensureShinyArmy(hq, wallet, now);
    }
  }
  const link = mob.linkRange ?? 0;
  if (link <= 0) return;
  for (const ally of mobs) {
    if (!ally.alive || ally.id === mob.id) continue;
    if (ally.archetype !== mob.archetype) continue;
    if (ally.targetId) continue;
    if (dist(mob.x, mob.z, ally.x, ally.z) > link) continue;
    ally.targetId = wallet;
    ally.roamTx = Number.NaN;
    ally.roamTz = Number.NaN;
    if (pl) ally.facing = facingTo(ally.x, ally.z, pl.x, pl.z);
  }
}

/** Idle wander near spawn — used by hares always, and by other mobs when not aggroed. */
function tickMobRoam(mob: Mob, now: number, dt: number) {
  if (
    now < mob.stunUntil ||
    now < mob.petrifyUntil ||
    now < mob.bindUntil ||
    now < mob.sleepUntil
  ) {
    mob.anim = "idle";
    return;
  }
  if (now < (mob.roamPauseUntil ?? 0)) {
    mob.anim = "idle";
    return;
  }

  const homeR = mob.aggro === "safe" ? 5.8 : 4.5;
  const homeDist = dist(mob.x, mob.z, mob.spawnX, mob.spawnZ);
  const speed =
    mob.archetype === "dust_hare"
      ? 1.65
      : mob.archetype === "pale_slime"
        ? 0.9
        : mob.archetype === "seam_golem"
          ? 0.75
          : 1.2;

  const pickWaypoint = (towardHome: boolean) => {
    if (towardHome) {
      const dry = paleHollowPlaceOnDryLand(mob.spawnX, mob.spawnZ);
      mob.roamTx = dry.x;
      mob.roamTz = dry.z;
    } else {
      const ang = Math.random() * Math.PI * 2;
      const r = 1.4 + Math.random() * homeR;
      let tx = mob.spawnX + Math.sin(ang) * r;
      let tz = mob.spawnZ + Math.cos(ang) * r;
      const dry = paleHollowPlaceOnDryLand(tx, tz);
      tx = dry.x;
      tz = dry.z;
      if (paleHollowInBuildingClearing(tx, tz) || paleHollowInOpenWater(tx, tz)) {
        const home = paleHollowPlaceOnDryLand(mob.spawnX, mob.spawnZ);
        tx = home.x;
        tz = home.z;
      }
      const c = clampToHall(tx, tz);
      mob.roamTx = c.x;
      mob.roamTz = c.z;
    }
    mob.roamUntil = now + 3500 + Math.floor(Math.random() * 4500);
  };

  const hasWp = Number.isFinite(mob.roamTx) && Number.isFinite(mob.roamTz);
  const atWp = hasWp && dist(mob.x, mob.z, mob.roamTx, mob.roamTz) < 0.55;

  if (homeDist > homeR + 1.8) {
    pickWaypoint(true);
  } else if (!hasWp || atWp || now >= (mob.roamUntil ?? 0)) {
    if (atWp) {
      mob.roamPauseUntil = now + 700 + Math.floor(Math.random() * 2400);
      mob.roamTx = Number.NaN;
      mob.roamTz = Number.NaN;
      mob.anim = "idle";
      return;
    }
    pickWaypoint(false);
  }

  if (!Number.isFinite(mob.roamTx) || !Number.isFinite(mob.roamTz)) {
    mob.anim = "idle";
    return;
  }

  mob.facing = facingTo(mob.x, mob.z, mob.roamTx, mob.roamTz);
  const step = speed * dt;
  const nx = mob.x + Math.sin(mob.facing) * step;
  const nz = mob.z + Math.cos(mob.facing) * step;
  const c = clampPlayerMove(mob.x, mob.z, nx, nz);
  // Don't walk into water, river walls, or buildings while roaming
  if (!paleHollowWalkable(c.x, c.z) || paleHollowInBuildingClearing(c.x, c.z)) {
    pickWaypoint(false);
    mob.anim = "idle";
    return;
  }
  mob.x = c.x;
  mob.z = c.z;
  syncUnitY(mob);
  mob.anim = "walk";
}

function warnSoftGate(p: Player, z: number) {
  const soft = paleHollowGateSoftLevel(z);
  if (soft == null) return;
  if (p.level >= soft) return;
  const stamp = ((p as Player & { gateWarnAt?: Record<string, number> }).gateWarnAt ??= {});
  const key = `gate:${soft}:${Math.floor(z / 4)}`;
  const now = Date.now();
  if ((stamp[key] ?? 0) + 12_000 > now) return;
  stamp[key] = now;
  pushLog(p, `This crossing recommends level ${soft} (you are ${p.level}).`);
}

function matDisplayName(matId: string): string {
  return CATALOG_BY_SLUG[matId]?.name ?? matId.replace(/-/g, " ");
}

/** Track mats for craft math and mirror catalog items into the bag. */
function grantBaseMat(p: Player, matId: string, amount = 1) {
  p.baseMats[matId] = (p.baseMats[matId] ?? 0) + amount;
  const def = CATALOG_BY_SLUG[matId];
  if (def) addItem(p.inventory, def.id, amount);
  rememberPlayer(p);
}

function ensureCraftSkills(p: Player) {
  if (!p.craftSkills || typeof p.craftSkills !== "object") {
    p.craftSkills = emptyCraftSkills();
    return;
  }
  const defaults = emptyCraftSkills();
  for (const [k, v] of Object.entries(defaults)) {
    if (!p.craftSkills[k]) p.craftSkills[k] = { ...v };
  }
}

function setMatAmount(p: Player, slug: string, amount: number) {
  const def = CATALOG_BY_SLUG[slug];
  if (amount <= 0) {
    delete p.baseMats[slug];
    if (def) {
      const row = p.inventory.find((i) => i.tokenId === def.id);
      if (row) {
        const idx = p.inventory.indexOf(row);
        if (idx >= 0) p.inventory.splice(idx, 1);
      }
    }
    rememberPlayer(p);
    return;
  }
  p.baseMats[slug] = amount;
  if (def) {
    const row = p.inventory.find((i) => i.tokenId === def.id);
    if (row) row.amount = amount;
    else p.inventory.push({ tokenId: def.id, amount });
  }
  rememberPlayer(p);
}

function takeMat(p: Player, slug: string, amount: number): boolean {
  const have = ownedMatQty(slug, p.inventory, p.baseMats);
  if (have < amount) return false;
  setMatAmount(p, slug, have - amount);
  return true;
}

function grantCraftXp(p: Player, skill: CraftSkill, amount: number) {
  ensureCraftSkills(p);
  const prev = p.craftSkills[skill] ?? { level: 1, xp: 0 };
  const row = { level: prev.level, xp: prev.xp + Math.max(1, amount) };
  let guard = 0;
  while (row.xp >= craftXpToNext(row.level) && guard++ < 50) {
    row.xp -= craftXpToNext(row.level);
    row.level += 1;
  }
  p.craftSkills[skill] = row;
  if (row.level > prev.level) logCraftSkill(p, skill, row.level);
}

function logCraftSkill(p: Player, skill: string, level: number) {
  if (level <= 1) return;
  const token = lokToken(p);
  if (!token) return;
  const res = lok.craftSkill(token, skill, level);
  if (!res.ok && !/not higher/i.test(res.error)) {
    pushLog(p, "Craft level was not written to your log: " + res.error);
  }
}

/** Push progress craft ranks into the log (idempotent — engine rejects non-increasing). */
function syncCraftSkillsToLog(p: Player) {
  ensureCraftSkills(p);
  for (const [skill, row] of Object.entries(p.craftSkills)) {
    if (row && row.level > 1) logCraftSkill(p, skill, row.level);
  }
}

/** Backfill bag slots for mats granted before inventory mirroring existed. */
function syncBaseMatsToInventory(p: Player) {
  for (const [slug, amount] of Object.entries(p.baseMats ?? {})) {
    if (amount <= 0) continue;
    const def = CATALOG_BY_SLUG[slug];
    if (!def) continue;
    const have = invAmount(p.inventory, def.id);
    if (have < amount) addItem(p.inventory, def.id, amount - have);
  }
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}
function noteMobHit(mob: Mob, wallet: string) {
  if (!mob.hitBy) mob.hitBy = new Set();
  mob.hitBy.add(wallet.toLowerCase());
}

/** Beneficial AoE / ally heals: self + party members only (solo = self). */
function partyAllies(caster: Player): Player[] {
  const ids = partyAllyWallets(caster.wallet);
  const out: Player[] = [];
  for (const id of ids) {
    const pl = players.get(id);
    if (pl) out.push(pl);
  }
  if (out.length === 0) out.push(caster);
  return out;
}

function playerByIdOrName(raw: string): Player | undefined {
  const key = raw.trim();
  if (!key) return undefined;
  const byId = players.get(key.toLowerCase());
  if (byId) return byId;
  const lower = key.toLowerCase();
  for (const pl of players.values()) {
    if (pl.name.toLowerCase() === lower) return pl;
  }
  return undefined;
}

function partyLookup(id: string) {
  const pl = players.get(id);
  if (!pl) return null;
  return {
    name: pl.name,
    level: pl.level,
    job: pl.job,
    hp: pl.hp,
    maxHp: pl.maxHp,
    mp: pl.mp,
    maxMp: pl.maxMp,
    online: true,
  };
}

function partyNameOf(id: string): string {
  return players.get(id)?.name ?? id.slice(0, 10);
}

function syncPartyState(wallets: string[]) {
  for (const w of new Set(wallets.map((x) => x.toLowerCase()))) {
    const pl = players.get(w);
    if (pl) send(pl.ws, snapshotFor(pl));
  }
}

function handlePartyInvite(p: Player, targetId: string) {
  const target = playerByIdOrName(targetId);
  if (!target) {
    pushLog(p, "No player found to invite.");
    return;
  }
  if (target.wallet === p.wallet) {
    pushLog(p, "You cannot invite yourself.");
    return;
  }
  const d = dist(p.x, p.z, target.x, target.z);
  if (d > PARTY_INVITE_RANGE) {
    pushLog(p, `${target.name} is too far to invite (range ${PARTY_INVITE_RANGE}).`);
    return;
  }
  const res = invitePlayer(p.wallet, target.wallet);
  if (!res.ok || !res.invite) {
    pushLog(p, res.message);
    return;
  }
  pushLog(p, `Invited ${target.name} to the party.`);
  pushLog(target, `${p.name} invited you to a party.`);
  send(target.ws, {
    type: "party/invite",
    fromId: p.wallet,
    fromName: p.name,
    partyId: res.invite.partyId ?? "",
    expiresAt: res.invite.expiresAt,
  });
  send(target.ws, snapshotFor(target));
}

function handlePartyAccept(p: Player) {
  const res = acceptInvite(p.wallet);
  pushLog(p, res.message);
  if (!res.ok) return;
  for (const id of res.affected) {
    if (id === p.wallet.toLowerCase()) continue;
    const ally = players.get(id);
    if (ally) pushLog(ally, `${p.name} joined the party.`);
  }
  syncPartyState(res.affected);
}

function handlePartyDecline(p: Player) {
  const res = declineInvite(p.wallet);
  pushLog(p, res.message);
  if (res.ok && res.fromId) {
    const leader = players.get(res.fromId);
    if (leader) pushLog(leader, `${p.name} declined the party invite.`);
  }
  send(p.ws, snapshotFor(p));
}

function handlePartyLeave(p: Player) {
  const res = leaveParty(p.wallet);
  pushLog(p, res.message);
  if (!res.ok) return;
  for (const id of res.affected) {
    if (id === p.wallet.toLowerCase()) continue;
    const ally = players.get(id);
    if (ally) pushLog(ally, `${p.name} left the party.`);
  }
  syncPartyState(res.affected);
}

function handlePartyKick(p: Player, targetId: string) {
  const target = playerByIdOrName(targetId);
  const tid = target?.wallet ?? targetId;
  const res = kickMember(p.wallet, tid);
  pushLog(p, res.message);
  if (!res.ok) return;
  const name = target?.name ?? tid.slice(0, 10);
  for (const id of res.affected) {
    const ally = players.get(id);
    if (ally) pushLog(ally, `${name} was removed from the party.`);
  }
  syncPartyState(res.affected);
}

function handlePartyDisband(p: Player) {
  const res = disbandParty(p.wallet);
  pushLog(p, res.message);
  if (!res.ok) return;
  for (const id of res.affected) {
    const ally = players.get(id);
    if (ally) pushLog(ally, "The party was disbanded.");
  }
  syncPartyState(res.affected);
}


function facingTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

/** Point just inside melee range of the target, along the player→target line. */
function meleeApproach(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  stopDist = MELEE_RANGE * 0.85,
): { x: number; z: number } | null {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const d = Math.hypot(dx, dz);
  if (d <= stopDist) return null;
  return clampPlayerMove(fromX, fromZ, toX - (dx / d) * stopDist, toZ - (dz / d) * stopDist);
}

/** Keep closing on engaged target until in swing range. */
function chaseEngaged(p: Player) {
  const mob = findMob(p.targetId);
  if (!mob || !mob.alive) return;
  const d = dist(p.x, p.z, mob.x, mob.z);
  if (d <= MELEE_RANGE) return;
  const pt = meleeApproach(p.x, p.z, mob.x, mob.z);
  if (pt) p.moveTo = pt;
}

/** How far to look for the next fight after a kill. */
const AUTO_ENGAGE_RANGE = 14;

function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Nearest alive mob — prefers what the player is facing. */
function findNextHostile(p: Player, excludeId?: string): Mob | null {
  let best: Mob | null = null;
  let bestScore = Infinity;
  for (const m of mobs) {
    if (!m.alive || m.id === excludeId) continue;
    const d = dist(p.x, p.z, m.x, m.z);
    if (d > AUTO_ENGAGE_RANGE) continue;
    const toMob = facingTo(p.x, p.z, m.x, m.z);
    const face = Math.abs(angleDelta(toMob, p.facing));
    // In front of you beats a closer mob behind your back.
    const score = d + face * 3;
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/** After a kill, keep fighting if another hostiles is nearby. */
function autoEngageNext(p: Player, deadId: string) {
  const next = findNextHostile(p, deadId);
  if (!next) return;
  p.targetId = next.id;
  chaseEngaged(p);
  pushLog(
    p,
    dist(p.x, p.z, next.x, next.z) > MELEE_RANGE
      ? `Engaged ${next.name} — closing in.`
      : `Engaged ${next.name}.`,
  );
}

function pushLog(p: Player, message: string) {
  p.lastLog.push(message);
  if (p.lastLog.length > 40) p.lastLog.shift();
  send(p.ws, { type: "log", message });
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function invAmount(inv: InventorySlot[], tokenId: number): number {
  return stackAmount(inv, tokenId);
}

function addItem(inv: InventorySlot[], tokenId: number, amount: number) {
  addStack(inv, tokenId, amount, false);
}

function takeItem(inv: InventorySlot[], tokenId: number, amount: number): boolean {
  return takeStack(inv, tokenId, amount);
}

function playerBuffs(p: Player): UnitSnapshot["buffs"] {
  const now = Date.now();
  return {
    ...emptyBuffs(),
    flux: p.flux,
    aether: p.aether,
    quickenUntil: p.quickenUntil,
    slowUntil: p.slowUntil,
    levelUpUntil: p.levelUpUntil,
    hasteUntil: p.hasteUntil,
    hastePct: now < p.hasteUntil ? p.hastePct : 0,
    moveUntil: p.moveUntil,
    movePct: now < p.moveUntil ? p.movePct : 0,
    timeSealUntil: p.timeSealUntil,
    overclockUntil: p.overclockUntil,
    perpetualUntil: p.perpetualUntil,
    petrifyUntil: 0,
    tdImpactUntil: 0,
    bulwarkUntil: p.bulwarkUntil,
    sentinelUntil: p.sentinelUntil,
    rampartUntil: p.rampartUntil,
    coverUntil: p.coverUntil,
    fealtyUntil: p.fealtyUntil,
    guardianUntil: p.guardianUntil,
    protectUntil: p.protectUntil,
    protectPhysMul: now < p.protectUntil ? p.protectPhysMul : 1,
    shellUntil: p.shellUntil,
    shellMagMul: now < p.shellUntil ? p.shellMagMul : 1,
    bulwarkFlashUntil: p.bulwarkFlashUntil,
    ghostStepUntil: p.ghostStepUntil,
    backbladeUntil: p.backbladeUntil,
    killEdgeUntil: p.killEdgeUntil,
    shadowPassUntil: p.shadowPassUntil,
    killingStormUntil: p.killingStormUntil,
    berserkUntil: p.berserkUntil,
    defenderUntil: p.defenderUntil,
    aggressorUntil: p.aggressorUntil,
    restraintUntil: p.restraintUntil,
    brazenRushUntil: p.brazenRushUntil,
    warcryUntil: p.warcryUntil,
    bloodRageUntil: p.bloodRageUntil,
    fighterRageFlashUntil: p.fighterRageFlashUntil,
    arcaneFloodUntil: p.arcaneFloodUntil,
    elementalSealUntil: p.elementalSealUntil,
    manaWallUntil: p.manaWallUntil,
    manawellReady: p.manawellReady,
    cascadeUntil: p.cascadeUntil,
    focalNeveUntil: p.focalNeveUntil,
    scCastFlashUntil: p.scCastFlashUntil,
    spellbladeUntil: p.spellbladeUntil,
    spellbladeFlashUntil: p.spellbladeFlashUntil,
    focusWeave: p.focusWeave,
    enSpellUntil: p.enSpellUntil,
    phalanxUntil: p.phalanxUntil,
    stoneskinUntil: p.stoneskinUntil,
    refreshUntil: p.refreshUntil,
    sacredLightUntil: p.sacredLightUntil,
    solaceRite: p.solaceRite,
    miseryRite: p.miseryRite,
    divineSealReady: p.divineSealCharges > 0 && now < p.divineSealUntil,
    asylumUntil: p.asylumUntil,
    healAbsorbUntil: p.healAbsorbUntil,
    healAbsorbHp: now < p.healAbsorbUntil ? p.healAbsorbHp : 0,
    regenUntil: p.regenUntil,
    blindUntil: p.blindUntil,
  };
}

function mobBuffs(m: Mob): UnitSnapshot["buffs"] {
  const now = Date.now();
  return {
    ...emptyBuffs(),
    quickenUntil: m.quickenUntil,
    slowUntil: m.slowUntil,
    hasteUntil: 0,
    hastePct: 0,
    moveUntil: m.gravityUntil,
    movePct: now < m.gravityUntil ? -m.gravityPct : 0,
    bindUntil: m.bindUntil,
    gravityUntil: m.gravityUntil,
    gravityPct: now < m.gravityUntil ? m.gravityPct : 0,
    petrifyUntil: m.petrifyUntil,
    stunUntil: m.stunUntil,
    tdImpactUntil: m.tdImpactUntil,
    distractUntil: m.distractUntil,
    frazzleUntil: m.frazzleUntil,
    addleUntil: m.addleUntil,
    silenceUntil: m.silenceUntil,
    paraUntil: m.paraUntil,
    blindUntil: m.blindUntil,
    falseGuardUntil: m.falseGuardUntil,
    sleepUntil: m.sleepUntil,
    diaUntil: m.diaUntil,
    bioUntil: m.bioUntil,
    scImpactUntil: m.scImpactUntil,
    atkDownUntil: m.atkDownUntil,
    atkDownMul: now < m.atkDownUntil ? m.atkDownMul : 1,
  };
}


/** Recompute / return unlocked abilities for a player (job + Trainer purchases + weapon skills). */
function ensurePlayerUnlocked(p: Player): AbilityId[] {
  const learned = Array.isArray(p.learned) ? p.learned : [];
  const unlockKey = `${p.job}|${p.subjob ?? ""}|${p.level}|${p.equip.main ?? ""}|${learned.length}`;
  if (p.unlockCacheKey !== unlockKey || !p.unlockCache) {
    const jobUnlocked = abilitiesUnlockedDual(p.job, p.level, p.subjob, learned) as AbilityId[];
    const wsUnlocked = weaponTpUnlocked(
      weaponTypeFromTokenId(p.equip.main),
      p.level,
    ) as AbilityId[];
    p.unlockCache = Array.from(new Set<AbilityId>([...jobUnlocked, ...wsUnlocked]));
    p.unlockCacheKey = unlockKey;
  }
  return p.unlockCache;
}

function snapshotFor(p: Player): SnapshotMessage {
  const units: UnitSnapshot[] = [];
  /** Only stream nearby field content — full corridor would flood client. */
  const INTEREST = 72;
  const inInterest = (x: number, z: number) => dist(p.x, p.z, x, z) <= INTEREST;

  for (const pl of players.values()) {
    if (pl.wallet !== p.wallet && !inInterest(pl.x, pl.z)) continue;
    units.push({
      id: pl.wallet,
      kind: "player",
      characterId: pl.charId,
      name: pl.name,
      x: pl.x,
      y: pl.y,
      z: pl.z,
      facing: pl.facing,
      hp: pl.hp,
      maxHp: pl.maxHp,
      mp: pl.mp,
      maxMp: pl.maxMp,
      tp: pl.tp,
      anim: pl.anim,
      animUntil: pl.animUntil,
      targetId: pl.targetId,
      job: pl.job,
      gender: pl.gender ?? "male",
      buffs: playerBuffs(pl),
    });
  }
  // Corpses only while fading — then they vanish until MOB_RESPAWN_MS later.
  for (const mob of mobs) {
    const nowMob = Date.now();
    if (!mob.alive) {
      if (!mob.deathAt || nowMob >= mob.deathAt + MOB_DEATH_FADE_MS) continue;
    }
    // Always include engaged target / self-target even if slightly outside bubble
    const engaged =
      p.targetId === mob.id || mob.targetId === p.wallet;
    if (!engaged && !inInterest(mob.x, mob.z)) continue;
    units.push({
      id: mob.id,
      name: mob.name,
      kind: "mob",
      x: mob.x,
      y: mob.y,
      z: mob.z,
      facing: mob.facing,
      hp: mob.alive ? mob.hp : 0,
      maxHp: mob.maxHp,
      mp: mob.mp,
      maxMp: mob.maxMp,
      tp: mob.tp,
      anim: mob.alive ? mob.anim : "dead",
      animUntil: mob.alive ? mob.animUntil : 0,
      targetId: mob.alive ? mob.targetId : null,
      buffs: mobBuffs(mob),
      archetype: mob.archetype,
      job: mob.job,
      level: mob.level,
      shiny: mob.shiny || undefined,
      deathAt: mob.alive ? undefined : mob.deathAt,
    });
  }

  const hubNpcs = [
    ...PH_HUB_NPCS,
    {
      id: TRAINER.id,
      name: TRAINER.name,
      x: TRAINER.x,
      z: TRAINER.z,
      facing: TRAINER.facing,
      role: "spell_trainer" as const,
    },
  ];
  for (const npc of hubNpcs) {
    if (!inInterest(npc.x, npc.z)) continue;
    units.push({
      id: npc.id,
      kind: "npc",
      name: npc.name,
      x: npc.x,
      y: paleHollowHeight(npc.x, npc.z),
      z: npc.z,
      facing: npc.facing,
      hp: 1,
      maxHp: 1,
      mp: 0,
      maxMp: 0,
      tp: 0,
      anim: "idle",
      animUntil: 0,
      targetId: null,
      buffs: emptyBuffs(),
      npcRole: npc.role,
    });
  }

  const nowSnap = Date.now();
  for (const node of fieldNodes) {
    if (!inInterest(node.x, node.z)) continue;
    const ready = nowSnap >= node.readyAt;
    // Depleted nodes stay hidden until they pop back (often at a new spawn)
    if (!ready) continue;
    units.push({
      id: node.id,
      kind: "npc",
      name: node.name,
      x: node.x,
      y: paleHollowHeight(node.x, node.z),
      z: node.z,
      facing: 0,
      hp: 1,
      maxHp: 1,
      mp: 0,
      maxMp: 0,
      tp: 0,
      anim: "idle",
      animUntil: 0,
      targetId: null,
      buffs: emptyBuffs(),
      gatherNode: true,
      gatherYield: node.yields[0],
    });
  }

  const learned = Array.isArray(p.learned) ? p.learned : [];
  const unlockKey = `${p.job}|${p.subjob ?? ""}|${p.level}|${p.equip.main ?? ""}|${learned.length}`;
  if (p.unlockCacheKey !== unlockKey || !p.unlockCache) {
    const jobUnlocked = abilitiesUnlockedDual(p.job, p.level, p.subjob, learned) as AbilityId[];
    const wsUnlocked = weaponTpUnlocked(
      weaponTypeFromTokenId(p.equip.main),
      p.level,
    ) as AbilityId[];
    p.unlockCache = Array.from(new Set<AbilityId>([...jobUnlocked, ...wsUnlocked]));
    p.unlockCacheKey = unlockKey;
  }
  const unlocked = p.unlockCache;
  // Skill hubs only need a check on job change — cheap no-op if already present.
  if (tick % (TICK_HZ * 2) === 0) {
    ensureSkillPointBank(p);
    ensureJobHubs(p);
  }
  syncBaseMatsToInventory(p);
  ensureCraftSkills(p);

  return {
    type: "snapshot",
    tick,
    you: {
      wallet: p.wallet,
      characterId: p.charId,
      name: p.name,
      job: p.job,
      gender: p.gender ?? "male",
      subjob: p.subjob,
      subLevel: p.subjob && p.level >= SUBJOB_UNLOCK_LEVEL ? subjobLevel(p.level) : 0,
      level: p.level,
      xp: p.xp,
      dust: p.dust,
      claimedStarter: p.claimedStarter,
      inventory: p.inventory,
      equip: p.equip,
      baseMats: { ...p.baseMats },
      craftSkills: cloneCraftSkills(p.craftSkills),
      zoneId: p.zoneId,
      recasts: { ...p.recasts },
      unlocked,
      learned: learned as AbilityId[],
      skillUnlocked: [...p.skillUnlocked],
      skillPoints: skillPointsRemaining(p),
      skillPrestige: p.skillPrestige,
      freeStatPoints: p.freeStatPoints,
      freeStats: { ...p.freeStats },
      lok: (() => {
        const view = lok.view(lokToken(p));
        return {
          ...view,
          ahEscrow: ahEscrowClientConfig(),
          eezSyncBuy: cachedEezSyncBuy,
          characterMint: cachedCharacterMint,
          withdrawDelaySec: null,
          queues: [],
        };
      })(),
    },
    units,
    log: p.lastLog.slice(-12),
    party: buildPartySnapshot(p.wallet, partyLookup),
    partyInvite: buildInviteView(p.wallet, partyNameOf),
  };
}

function broadcastSnapshots() {
  for (const p of players.values()) send(p.ws, snapshotFor(p));
}

function ensurePlayer(wallet: string, ws: WebSocket): Player | undefined {
  const id = walletToPlayer.get(wallet);
  if (!id) return undefined;
  const p = players.get(id);
  if (!p) return undefined;
  p.ws = ws;
  if (!Array.isArray(p.learned)) p.learned = [];
  if (!p.charId) p.charId = `c_${wallet.slice(-8)}_${Date.now().toString(36)}`;
  if (p.gender !== "male" && p.gender !== "female" && p.gender !== "pepeka") p.gender = "male";
  if (!Array.isArray(p.unlockCache)) p.unlockCache = [];
  if (typeof p.unlockCacheKey !== "string") p.unlockCacheKey = "";
  if (typeof p.y !== "number") p.y = paleHollowStandHeight(p.x, p.z);
  if (!p.zoneId) p.zoneId = "pale_hollow";
  if (!p.baseMats || typeof p.baseMats !== "object") p.baseMats = {};
  ensureCraftSkills(p);
  p.equip = { ...emptyEquipment(), ...(p.equip ?? {}) };
  ensureSkillPointBank(p);
  registerAccountChar(p);
  return p;
}

function registerAccountChar(p: Player) {
  let slots = accountRoster.get(p.wallet);
  if (!slots) {
    slots = new Map();
    accountRoster.set(p.wallet, slots);
  }
  slots.set(p.charId, p);
}

function accountPreviews(wallet: string): {
  id: string;
  name: string;
  job: JobId;
  level: number;
  gender: "male" | "female" | "pepeka";
  tokenId?: string;
}[] {
  const slots = accountRoster.get(wallet);
  if (!slots) return [];
  return [...slots.values()].map((p) => {
    const tokenId = lok.tokenFor(p.charId);
    return {
      id: p.charId,
      name: p.name,
      job: p.job,
      level: p.level,
      gender: p.gender ?? "male",
      ...(tokenId ? { tokenId } : {}),
    };
  });
}

function activateCharacter(wallet: string, charId: string, ws: WebSocket): Player | undefined {
  const slots = accountRoster.get(wallet);
  const p = slots?.get(charId);
  if (!p) return undefined;
  p.ws = ws;
  players.set(wallet, p);
  walletToPlayer.set(wallet, wallet);
  return p;
}

function createPlayer(
  wallet: string,
  name: string,
  ws: WebSocket,
  job: JobId = "time_mage",
  gender: "male" | "female" | "pepeka" = "male",
  existingCharId?: string,
): Player {
  // Replace only this wallet's live session — other players stay in the world (multiplayer).
  const prev = players.get(wallet);
  if (prev && prev.ws !== ws) {
    try {
      prev.ws.close();
    } catch {
      /* ignore */
    }
  }
  const vitals = combinedJobVitals(job, 1, null);
  const charId = existingCharId ?? `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const p: Player = {
    wallet,
    charId,
    name,
    job,
    gender,
    subjob: null,
    level: 1,
    xp: 0,
    dust: 0,
    claimedStarter: false,
    inventory: [],
    equip: emptyEquipment(),
    x: PH_HUB_SPAWN.x,
    y: paleHollowHeight(PH_HUB_SPAWN.x, PH_HUB_SPAWN.z),
    z: PH_HUB_SPAWN.z,
    zoneId: "pale_hollow",
    baseMats: {},
    craftSkills: emptyCraftSkills(),
    facing: PH_HUB_SPAWN.facing,
    hp: vitals.maxHp,
    maxHp: vitals.maxHp,
    mp: vitals.maxMp,
    maxMp: vitals.maxMp,
    tp: 0,
    targetId: null,
    moveTo: null,
    anim: "idle",
    flux: false,
    aether: false,
    quickenUntil: 0,
    slowUntil: 0,
    levelUpUntil: 0,
    hasteUntil: 0,
    hastePct: 0,
    moveUntil: 0,
    movePct: 0,
    overclockUntil: 0,
    timeSealUntil: 0,
    perpetualUntil: 0,
    lastEnfeeble: null,
    learned: [],
    skillUnlocked: initialUnlockedForJob(job),
    skillPoints: skillPointsGrantedForLevels(0, 1),
    skillPrestige: 0,
    freeStatPoints: FREE_STAT_POINTS,
    freeStats: { str: 0, dex: 0, vit: 0, agi: 0, int: 0, mnd: 0 },
    bulwarkUntil: 0,
    sentinelUntil: 0,
    rampartUntil: 0,
    coverUntil: 0,
    fealtyUntil: 0,
    guardianUntil: 0,
    protectUntil: 0,
    protectPhysMul: 1,
    shellUntil: 0,
    shellMagMul: 1,
    bulwarkFlashUntil: 0,
    enmity: 0,
    ghostStepUntil: 0,
    backbladeUntil: 0,
    killEdgeUntil: 0,
    shadowPassUntil: 0,
    killingStormUntil: 0,
    berserkUntil: 0,
    defenderUntil: 0,
    aggressorUntil: 0,
    restraintUntil: 0,
    brazenRushUntil: 0,
    warcryUntil: 0,
    bloodRageUntil: 0,
    fighterRageFlashUntil: 0,
    arcaneFloodUntil: 0,
    elementalSealUntil: 0,
    manaWallUntil: 0,
    manawellReady: false,
    cascadeUntil: 0,
    focalNeveUntil: 0,
    lastScElement: null,
    scCastFlashUntil: 0,
    spellbladeUntil: 0,
    spellbladeFlashUntil: 0,
    focusWeave: false,
    corruptReady: false,
    spontaneityReady: false,
    lockspellReady: false,
    widenReady: false,
    enSpellUntil: 0,
    enSpellBonus: 0,
    phalanxUntil: 0,
    phalanxPhysMul: 1,
    stoneskinUntil: 0,
    stoneskinAbsorb: 0,
    refreshUntil: 0,
    refreshTick: 0,
    divineSealCharges: 0,
    divineSealUntil: 0,
    solaceRite: false,
    miseryRite: false,
    miseryEmpowerUntil: 0,
    martyrReadyUntil: 0,
    devotionReadyUntil: 0,
    asylumUntil: 0,
    regenUntil: 0,
    regenTick: 0,
    reraiseUntil: 0,
    healAbsorbUntil: 0,
    healAbsorbHp: 0,
    sacredLightUntil: 0,
    blindUntil: 0,
    nextSwingAt: 0,
    animUntil: 0,
    walkUntil: 0,
    unlockCacheKey: "",
    unlockCache: [],
    recasts: {},
    lastLog: [`Welcome to Bellgrave, ${name}.`],
    ws,
  };
  if (existingCharId) {
    const saved = readPlayerProgress(playerProgressPath(defaultLokDir(), existingCharId));
    if (saved) applySaved(p, saved);
  }
  registerAccountChar(p);
  players.set(wallet, p);
  walletToPlayer.set(wallet, wallet);
  for (const abilityId of p.skillUnlocked) logLokAbility(p, abilityId);
  syncCraftSkillsToLog(p);
  rememberPlayer(p);
  return p;
}

function playerEquipmentStats(p: Player) {
  return aggregateEquipmentStats(p.equip);
}

/** Recompute max HP/MP from job, skill-tree, and equipped catalog bonuses. */
function syncVitals(p: Player, refill = true) {
  const v = combinedJobVitals(p.job, p.level, p.subjob);
  const tree = aggregateSkillBonuses(p.skillUnlocked);
  const gear = playerEquipmentStats(p);
  p.maxHp = v.maxHp + tree.maxHp + (gear.hp ?? 0);
  p.maxMp = v.maxMp === 0 ? 0 : v.maxMp + tree.maxMp + (gear.mp ?? 0);
  if (refill) {
    p.hp = p.maxHp;
    p.mp = p.maxMp;
  } else {
    p.hp = Math.min(p.hp, p.maxHp);
    p.mp = Math.min(p.mp, p.maxMp);
  }
}

function playerCombatStats(p: Player) {
  const derived = deriveCharacterAttributes(
    p.job,
    p.level,
    p.subjob,
    p.skillUnlocked,
    p.freeStats,
  );
  const gear = playerEquipmentStats(p);
  return {
    str: derived.total.str + (gear.str ?? 0),
    dex: derived.total.dex + (gear.dex ?? 0),
    vit: derived.total.vit + (gear.vit ?? 0),
    agi: derived.total.agi + (gear.agi ?? 0),
    int: derived.total.int + (gear.int ?? 0),
    mnd: derived.total.mnd + (gear.mnd ?? 0),
  };
}

function playerTreeBonuses(p: Player) {
  return aggregateSkillBonuses(p.skillUnlocked);
}

/**
 * Unspent tree points. Always recomputed from level, echoes, and the owned
 * nodes priced by skillNodeCost, so the bank, the UI, and respec agree and a
 * heart can never burn a point (#75). Also repairs older saves.
 */
function skillPointsRemaining(p: Player): number {
  p.skillPoints = skillPointsAvailable(p.level, p.skillPrestige, p.skillUnlocked);
  return p.skillPoints;
}

/** Backfill / repair the bank for older sessions. */
function ensureSkillPointBank(p: Player) {
  skillPointsRemaining(p);
}

/** Level-ups and echoes raise lifetime points; the bank follows from them. */
function grantSkillPoints(p: Player, amount: number) {
  if (amount <= 0) return;
  skillPointsRemaining(p);
}

function ensureMainHub(p: Player) {
  ensureJobHubs(p);
}

/** Free heart nodes for main and support. Never removes existing unlocks. */
function ensureJobHubs(p: Player) {
  const need = [skillHubForJob(p.job)];
  if (p.subjob && p.subjob !== p.job) need.push(skillHubForJob(p.subjob));
  for (const hub of need) {
    if (!p.skillUnlocked.includes(hub)) {
      p.skillUnlocked.push(hub);
      logLokAbility(p, hub);
    }
  }
}

/** Main job, or an active support job (L10+, half level). */
function playerHasJob(p: Player, job: JobId): boolean {
  return hasKit(p, job);
}

/** Spend XP into levels; after max, spend XP into skill echoes (extra tree points). */
function tryLevelUp(p: Player) {
  ensureSkillPointBank(p);
  let gained = 0;
  const levelBefore = p.level;
  while (p.level < MAX_LEVEL) {
    const need = xpToNextLevel(p.level);
    if (p.xp < need) break;
    p.xp -= need;
    p.level += 1;
    gained += 1;
  }
  if (gained > 0) {
    grantSkillPoints(p, skillPointsGrantedForLevels(levelBefore, p.level));
    syncVitals(p, true);
    p.levelUpUntil = Date.now() + 2400;
    pushLog(
      p,
      gained === 1
        ? `Level up! You are now level ${p.level} (+${SKILL_POINTS_PER_LEVEL} skill point).`
        : `Level up ×${gained}! You are now level ${p.level} (+${gained * SKILL_POINTS_PER_LEVEL} skill points banked).`,
    );
    syncLokLevel(p);
  }

  let echoes = 0;
  while (p.level >= MAX_LEVEL && p.skillPrestige < SKILL_PRESTIGE_CAP) {
    const need = xpToNextLevel(MAX_LEVEL);
    if (p.xp < need) break;
    p.xp -= need;
    p.skillPrestige += 1;
    grantSkillPoints(p, 1);
    echoes += 1;
  }
  if (echoes > 0) {
    pushLog(
      p,
      echoes === 1
        ? `Skill echo! +1 tree point banked (${p.skillPrestige}/${SKILL_PRESTIGE_CAP}).`
        : `Skill echo ×${echoes}! Tree points banked (${p.skillPrestige}/${SKILL_PRESTIGE_CAP}).`,
    );
  }
  rememberPlayer(p);
}

function rewardMobKill(p: Player, mob: Mob, now: number) {
  if (!mob.alive) return;
  mob.hp = 0;
  mob.alive = false;
  mob.anim = "dead";
  clearMobPendingCast(mob);
  mob.deathAt = now;
  const participants = new Set<string>([...(mob.hitBy ?? []), p.wallet.toLowerCase()]);
  for (const pl of players.values()) {
    if (pl.targetId === mob.id) participants.add(pl.wallet.toLowerCase());
  }
  if (mob.hitBy) mob.hitBy.clear();
  // Fade out, then wait MOB_RESPAWN_MS after vanishing before returning.
  mob.respawnAt = now + MOB_DEATH_FADE_MS + MOB_RESPAWN_MS;
  const wasTarget = p.targetId === mob.id;
  if (wasTarget) p.targetId = null;
  const shareRecipients: Player[] = [p];
  for (const id of partyAllyWallets(p.wallet)) {
    if (id === p.wallet.toLowerCase()) continue;
    if (!participants.has(id)) continue;
    const ally = players.get(id);
    if (!ally) continue;
    if (dist(ally.x, ally.z, mob.x, mob.z) > PARTY_SHARE_RANGE && ally.targetId !== mob.id) continue;
    shareRecipients.push(ally);
  }
  let killXp = 0;
  let killGold = 0;
  for (const recip of shareRecipients) {
    const goldDrop = mobKillGoldDrop();
    earnLogGold(recip, "drop", goldDrop);
    const xpGain = Math.max(
      0,
      Math.min(200, Math.floor((200 * mob.level) / Math.max(1, recip.level))),
    );
    recip.xp += xpGain;
    tryLevelUp(recip);
    if (recip.wallet === p.wallet) {
      killXp = xpGain;
      killGold = goldDrop;
    } else pushLog(recip, `Party credit — ${mob.name} down. +${goldDrop} gold, +${xpGain} XP.`);
  }
  const dropNotes: string[] = [];
  for (const mat of mob.drops ?? []) {
    if (Math.random() < 0.65) {
      grantBaseMat(p, mat, 1);
      const def = CATALOG_BY_SLUG[mat];
      if (def) logLokDrop(p, def.id, 1);
      dropNotes.push(matDisplayName(mat));
    }
  }
  for (const rare of mob.rareDrops ?? []) {
    if (Math.random() < rare.chance) {
      const def = CATALOG_BY_SLUG[rare.slug];
      if (def) {
        addItem(p.inventory, def.id, 1);
        logLokDrop(p, def.id, 1);
        dropNotes.push(def.name);
      } else {
        grantBaseMat(p, rare.slug, 1);
        const rareDef = CATALOG_BY_SLUG[rare.slug];
        if (rareDef) logLokDrop(p, rareDef.id, 1);
        dropNotes.push(matDisplayName(rare.slug));
      }
    }
  }
  // Shiny HQ only — 10% for 1 high mat from the archetype table (clones never roll this).
  if (mob.shiny && !mob.shinyClone) {
    const shinyMat = rollShinyMat(mob.archetype);
    if (shinyMat) {
      grantBaseMat(p, shinyMat, 1);
      const def = CATALOG_BY_SLUG[shinyMat];
      if (def) logLokDrop(p, def.id, 1);
      dropNotes.push(matDisplayName(shinyMat));
    }
    despawnShinyClones(mob, now);
  } else if (mob.shinyClone && mob.hqId) {
    const hq = findMob(mob.hqId);
    if (hq) hq.cloneIds = hq.cloneIds.filter((id) => id !== mob.id);
  }
  rememberPlayer(p);
  pushLog(
    p,
    dropNotes.length
      ? `${mob.name} defeated. +${killGold} gold, +${killXp} XP. Loot: ${dropNotes.join(", ")}.`
      : `${mob.name} defeated. +${killGold} gold, +${killXp} XP.`,
  );
  if (wasTarget) autoEngageNext(p, mob.id);
}

function claimStarter(p: Player) {
  if (p.claimedStarter) return;
  const weapon = STARTER_WEAPON[p.job];
  addStack(p.inventory, weapon.tokenId, 1, true);
  addStack(p.inventory, STARTER_POTION_ID, STARTER_POTION_AMOUNT, true);
  p.claimedStarter = true;
  p.equip.main = weapon.tokenId;
  // #273: persist before the 15s save loop so a crash cannot re-grant.
  rememberPlayer(p);
  // Not written to the log. A later real drop of the same id is a separate, sellable stack.
  pushLog(
    p,
    "Starter kit: " + weapon.name + " and Potion x" + STARTER_POTION_AMOUNT + ". You can discard it. It cannot be imported, listed, traded, or exported.",
  );
}

function handleDiscard(p: Player, tokenId: number, starter: boolean) {
  const removed = discardStack(p.inventory, tokenId, starter);
  if (removed <= 0) {
    pushLog(p, "Nothing to discard.");
    return;
  }
  // Base mats are tracked twice (bag row + baseMats for craft math), and
  // syncBaseMatsToInventory refills the bag from baseMats on every snapshot.
  // Without this the discarded stack came straight back and stayed craftable.
  const discarded = getItem(tokenId);
  if (!starter && discarded && discarded.kind === "base") {
    const left = stackAmount(p.inventory, tokenId) - starterAmount(p.inventory, tokenId);
    if (left > 0) p.baseMats[discarded.slug] = left;
    else delete p.baseMats[discarded.slug];
  }
  rememberPlayer(p);
  if (invAmount(p.inventory, tokenId) <= 0) {
    for (const slot of EQUIP_SLOTS) {
      if (p.equip[slot] === tokenId) p.equip[slot] = null;
    }
  }
  pushLog(p, "Discarded " + itemLabel(tokenId) + " x" + removed + ".");
  send(p.ws, snapshotFor(p));
}

function stopRest(p: Player, reason?: string) {
  if (p.anim !== "rest") return;
  p.anim = "idle";
  p.animUntil = 0;
  if (reason) pushLog(p, reason);
  else pushLog(p, "You stop resting.");
}

function respawnAtHub(p: Player, reason = "You fallâ€¦ and wake in the Shard Dwellings.") {
  stopRest(p);
  clearJobBuffs(p);
  p.hp = Math.max(1, Math.floor(p.maxHp * 0.3));
  p.x = PH_HUB_SPAWN.x;
  p.z = PH_HUB_SPAWN.z;
  syncUnitY(p);
  p.moveTo = null;
  p.targetId = null;
  p.anim = "idle";
  p.animUntil = 0;
  p.nextSwingAt = 0;
  // Mob hate: drop this player as a target when they warp home.
  for (const m of mobs) {
    if (m.targetId === p.wallet) m.targetId = null;
  }
  pushLog(p, reason);
}

function clearJobBuffs(p: Player) {
  p.flux = false;
  p.aether = false;
  p.hasteUntil = 0;
  p.hastePct = 0;
  p.moveUntil = 0;
  p.movePct = 0;
  p.quickenUntil = 0;
  p.overclockUntil = 0;
  p.timeSealUntil = 0;
  p.perpetualUntil = 0;
  p.lastEnfeeble = null;
  p.recasts = {};
  clearKnightBuffs(p);
  clearRogueBuffs(p);
  clearFighterBuffs(p);
  clearSorcererBuffs(p as import("./sorcerer-abilities").SorcererPlayer);
  clearClericBuffs(p as import("./cleric-abilities").ClericPlayer);
  clearBattleMageBuffs(p);
}

function playerPhysDtMul(p: Player, now: number): number {
  // Bulwark / Sentinel / Cover / Rampart / Guardian / Protect / Phalanx + tree physDt.
  return physDtMul(p, now, playerTreeBonuses(p).physDt ?? 0);
}

/** Mana Wall — pay remaining damage with MP instead of HP. */
function absorbManaWall(p: Player, now: number, raw: number): { dmg: number; bled: number } {
  if (raw <= 0 || now >= p.manaWallUntil) return { dmg: raw, bled: 0 };
  const bled = Math.min(p.mp, raw);
  p.mp -= bled;
  return { dmg: Math.max(0, raw - bled), bled };
}

/**
 * Melee Attack: (main-hand Atk or 10) + gear Atk from other slots except ranged/ammo.
 * Casters with a no-Atk staff keep the 10 baseline; rings/mittens still add.
 */
function playerWeaponBonus(p: Player): number {
  return meleeAtkBonus(p);
}

function handleAbility(p: Player, id: AbilityId, targetId?: string) {
  const now = Date.now();
  if (isWeaponTpAbilityId(id)) {
    resolveWeaponTpAbility(p, id as WeaponTpAbilityId, targetId, now, {
      pushLog: (pl, msg) => pushLog(pl as Player, msg),
      stopRest: (pl, reason) => stopRest(pl as Player, reason),
      facingTo,
      findMob: (tid) => findMob(tid ?? null) ?? null,
      onMobKill: (pl, m) => {
        const mob = findMob(m.id);
        if (mob) rewardMobKill(pl as Player, mob, now);
      },
      dist,
      meleeRange: MELEE_RANGE,
      playerWeaponBonus: (pl) => playerWeaponBonus(pl as Player),
      playerCombatStats: (pl) => playerCombatStats(pl as Player),
      playerTreeAtk: (pl) => playerTreeBonuses(pl as Player).atk,
    });
    return;
  }
  {
    const unlocked = ensurePlayerUnlocked(p);
    if (!unlocked.includes(id)) {
      pushLog(p, `You have not learned ${abilityLabel(id)}. Visit the Trainer.`);
      return;
    }
  }
    // Dispatch by kit ownership — main or support job may grant the ability
  if (isRogueAbilityId(id) && playerHasJob(p, "rogue")) {
    resolveRogueAbility(p, id, targetId, now, {
      pushLog: (pl, msg) => pushLog(pl as Player, msg),
      stopRest: (pl, reason) => stopRest(pl as Player, reason),
      facingTo,
      findMob: (tid) => findMob(tid ?? null) ?? null,
      allMobs: () => mobs,
      onMobKill: (pl, m) => {
        const mob = findMob(m.id);
        if (mob) rewardMobKill(pl as Player, mob, now);
      },
      dist,
      playerCombatStats: (pl) => playerCombatStats(pl as Player),
      earnGold: (pl, amount) => earnLogGold(pl as Player, "drop", amount),
    });
    return;
  }
  if (isKnightAbilityId(id) && playerHasJob(p, "knight")) {
    resolveKnightAbility(p, id, targetId, now, {
      pushLog: (pl, msg) => pushLog(pl as Player, msg),
      stopRest: (pl, reason) => stopRest(pl as Player, reason),
      facingTo,
      findMob: (tid) => findMob(tid ?? null) ?? null,
      allMobs: () => mobs,
      allPlayers: () => partyAllies(p),
      onMobKill: (pl, m) => {
        const mob = findMob(m.id);
        if (mob) rewardMobKill(pl as Player, mob, now);
      },
      dist,
      playerCombatStats: (pl) => playerCombatStats(pl as Player),
    });
    return;
  }
  if (isFighterAbilityId(id) && playerHasJob(p, "fighter")) {
    resolveFighterAbility(p, id, targetId, now, {
      pushLog: (pl, msg) => pushLog(pl as Player, msg),
      stopRest: (pl, reason) => stopRest(pl as Player, reason),
      facingTo,
      findMob: (tid) => findMob(tid ?? null) ?? null,
      allPlayers: () => partyAllies(p),
      dist,
    });
    return;
  }
  if (isSorcererAbilityId(id) && playerHasJob(p, "sorcerer")) {
    resolveSorcererAbility(p as import("./sorcerer-abilities").SorcererPlayer & { wallet: string }, id, targetId, now, {
      pushLog: (pl, msg) => pushLog(pl as Player, msg),
      stopRest: (pl, reason) => stopRest(pl as Player, reason),
      facingTo,
      findMob: (tid) => (findMob(tid ?? null) ?? null) as import("./sorcerer-abilities").SorcererMob | null,
      allMobs: () => mobs as import("./sorcerer-abilities").SorcererMob[],
      onMobKill: (pl, m) => {
        const mob = findMob(m.id);
        if (mob) rewardMobKill(pl as Player, mob, now);
      },
      dist,
      playerCombatStats: (pl) => playerCombatStats(pl as Player),
    });
    return;
  }
  if (isBattleMageAbilityId(id) && playerHasJob(p, "battle_mage")) {
    resolveBattleMageAbility(p, id, targetId, now, {
      pushLog: (pl, msg) => pushLog(pl as Player, msg),
      stopRest: (pl, reason) => stopRest(pl as Player, reason),
      facingTo,
      findMob: (tid) => findMob(tid ?? null) ?? null,
      allMobs: () => mobs,
      allPlayers: () => partyAllies(p),
      onMobKill: (pl, m) => {
        const mob = findMob(m.id);
        if (mob) rewardMobKill(pl as Player, mob, now);
      },
      dist,
      playerCombatStats: (pl) => playerCombatStats(pl as Player),
    });
    return;
  }
  if (isClericAbilityId(id) && playerHasJob(p, "cleric")) {
    {
      const cleric = p as import("./cleric-abilities").ClericPlayer;
      cleric.gearHealPotency = gearHealPotency(p);
      resolveClericAbility(cleric, id, targetId, now, {
        pushLog: (pl, msg) => pushLog(pl as unknown as Player, msg),
        stopRest: (pl, reason) => stopRest(pl as unknown as Player, reason),
        facingTo,
        findMob: (tid) => findMob(tid ?? null) ?? null,
        allMobs: () => mobs,
        allPlayers: () => partyAllies(p),
        onMobKill: (pl, m) => {
          const mob = findMob(m.id);
          if (mob) rewardMobKill(pl as unknown as Player, mob, now);
        },
        dist,
        playerCombatStats: (pl) => playerCombatStats(pl as unknown as Player),
      });
    }
    return;
  }
  if (isTimAbilityId(id) && playerHasJob(p, "time_mage")) {
    resolveTimAbility(p, id, targetId, mobs, now, {
      pushLog: (msg) => pushLog(p, msg),
      stopRest: (reason) => stopRest(p, reason),
      facingTo,
      onMobKill: (m) => {
        const mob = findMob(m.id);
        if (mob) rewardMobKill(p, mob, now);
      },
      allPlayers: () => partyAllies(p),
      dist,
      playerCombatStats: (pl) => playerCombatStats(pl as Player),
    });
    return;
  }
  pushLog(p, "You cannot use that ability.");
}

function handleNpcInteract(p: Player, npcId: string) {
  // Party storage chest — stub until bank/storage inventory ships.
  if (npcId === PH_STORAGE_CHEST.id) {
    if (!canReachTownNpc(p.x, p.z, PH_STORAGE_CHEST.x, PH_STORAGE_CHEST.z)) {
      pushLog(p, "Enter the camp to use the storage chest.");
      return;
    }
    p.facing = facingTo(p.x, p.z, PH_STORAGE_CHEST.x, PH_STORAGE_CHEST.z);
    pushLog(p, "Storage — coming soon");
    return;
  }

  if (npcId === JOB_MASTER.id) {
    if (!canReachTownNpc(p.x, p.z, JOB_MASTER.x, JOB_MASTER.z)) {
      pushLog(p, "Enter the camp to speak with the Job Master.");
      return;
    }
    p.facing = facingTo(p.x, p.z, JOB_MASTER.x, JOB_MASTER.z);
    const playable = (Object.keys(JOBS) as JobId[]).filter((j) => JOBS[j].playable);
    const canSub = p.level >= SUBJOB_UNLOCK_LEVEL;
    send(p.ws, {
      type: "npc/dialog",
      npcId: JOB_MASTER.id,
      title: canSub ? "Job Master — Support Job" : "Job Master",
      body: canSub
        ? `Main: ${JOBS[p.job].name} L${p.level}. Pick a support job (effective L${subjobLevel(p.level)}), or change your main below. Sprite stays your main.`
        : `Change your main job. Support jobs unlock at level ${SUBJOB_UNLOCK_LEVEL} and stay available through max level.`,
      jobs: playable,
      subjobMode: canSub,
      subLevel: canSub ? subjobLevel(p.level) : 0,
    });
    return;
  }

  if (npcId === TRAINER.id) {
    if (!canReachTownNpc(p.x, p.z, TRAINER.x, TRAINER.z)) {
      pushLog(p, "Enter the camp to speak with the Trainer.");
      return;
    }
    p.facing = facingTo(p.x, p.z, TRAINER.x, TRAINER.z);
    const subLv =
      p.subjob && p.level >= SUBJOB_UNLOCK_LEVEL ? subjobLevel(p.level) : 0;
    const offers = trainerOffersForJobs(p.job, p.level, p.subjob, subLv, p.learned);
    const jobNote = p.subjob
      ? `${JOBS[p.job].name} L${p.level} (main) + ${JOBS[p.subjob].name} L${subLv} (support half level)`
      : `${JOBS[p.job].name} L${p.level} (main - all abilities up to your level)`;
    send(p.ws, {
      type: "npc/dialog",
      npcId: TRAINER.id,
      title: "Trainer",
      body: `Buy job abilities with gold (${jobNote}). Main: up to your level; support: up to floor(level/2). Costs scale 500-10000 by unlock level. Starter kit (Rest + L1 signature) is free.`,
      spells: offers,
    });
    return;
  }

  const hub = PH_HUB_NPCS.find((n) => n.id === npcId);
  if (hub) {
    if (!canReachTownNpc(p.x, p.z, hub.x, hub.z)) {
      pushLog(p, `Enter the camp to speak with ${hub.name}.`);
      return;
    }
    p.facing = facingTo(p.x, p.z, hub.x, hub.z);
    if (hub.role === "job_master") {
      handleNpcInteract(p, JOB_MASTER.id);
      return;
    }
    const bodies: Record<string, string> = {
      guide:
        "This little camp is all we hold for now. North, the Hollow Steps terraces — gather Dustgrain, mind the river slimes.",
      quest_giver:
        "The corridor runs Ashbeam Reach, Chalkworks, then Pale Marches. Soft level signs mark each bridge — underleveled may still pass.",
      crafter:
        "Bring base mats from the field. Synth at my bench — I'll rank your crafts as you work.",
      vendor:
        "The camp ledger is here. Send or list what the log already holds. Items enter only from field play — I cannot mint them, and this counter cannot.",
    };
    send(p.ws, {
      type: "npc/dialog",
      npcId: hub.id,
      title: hub.name,
      body: bodies[hub.role] ?? "â€¦",
      craftOpen: hub.role === "crafter",
      lokOpen: hub.role === "vendor",
    });
    return;
  }

  pushLog(p, "Nothing happens.");
}

async function handleSpellBuy(p: Player, id: AbilityId) {
  if (!canReachTownNpc(p.x, p.z, TRAINER.x, TRAINER.z)) {
    pushLog(p, "You must speak with the Trainer to buy abilities.");
    return;
  }
  if (isTrainerFreeAbility(id)) {
    pushLog(p, "That ability is part of your free starter kit.");
    return;
  }
  const subLv =
    p.subjob && p.level >= SUBJOB_UNLOCK_LEVEL ? subjobLevel(p.level) : 0;
  const onMain = abilityIdsForJob(p.job).includes(id);
  const onSub = !!(p.subjob && subLv > 0 && abilityIdsForJob(p.subjob).includes(id));
  if (!onMain && !onSub) {
    pushLog(p, "That ability is not available for your current jobs.");
    return;
  }
  const unlockLevel = abilityUnlockLevel(id);
  // Caps: main <= player level; support <= floor(level/2). Never sell above.
  if (!canTrainAbility(p.job, p.level, p.subjob, subLv, id)) {
    if (onSub && !onMain) {
      pushLog(p, `${abilityLabel(id)} requires support level ${unlockLevel} (support is L${subLv}).`);
    } else {
      pushLog(p, `${abilityLabel(id)} requires level ${unlockLevel}.`);
    }
    return;
  }
  const cost = trainerAbilityGoldCost(unlockLevel);
  const token = lokToken(p);
  const logKnows = !!(token && lok.hasAbility(token, id));
  if (!shouldChargeForAbility(p.learned, logKnows, id)) {
    if (!p.learned.includes(id)) {
      p.learned.push(id);
      rememberPlayer(p);
    }
    pushLog(p, "You already know " + abilityLabel(id) + ".");
    send(p.ws, snapshotFor(p));
    handleNpcInteract(p, TRAINER.id);
    return;
  }
  const charged = await withPlayerCharge(
    p.charId,
    () => shouldChargeForAbility(p.learned, !!(token && lok.hasAbility(token, id)), id),
    () => {
      if (p.learned.includes(id)) return null;
      p.learned.push(id);
      return () => {
        const at = p.learned.lastIndexOf(id);
        if (at >= 0) p.learned.splice(at, 1);
      };
    },
    () => spendLogGold(p, cost, "trainer"),
    () => {
      logLokAbility(p, id);
      rememberPlayer(p);
      pushLog(p, "Learned " + abilityLabel(id) + " (-" + cost + " gold).");
      send(p.ws, snapshotFor(p));
      handleNpcInteract(p, TRAINER.id);
    },
  );
  if (!charged.ok) {
    if (charged.error === "no longer available") {
      pushLog(p, "You already know " + abilityLabel(id) + ".");
    } else {
      pushLog(p, "Need " + cost + " gold for " + abilityLabel(id) + ". " + charged.error);
    }
  }
}

/** Dev/test helper — instant L75 + all TIM spells learned. */
function handleSkillUnlock(p: Player, nodeId: string) {
  ensureMainHub(p);
  if (!isSkillNodeId(nodeId)) {
    pushLog(p, "Unknown skill node.");
    return;
  }
  const unlocked = new Set(p.skillUnlocked);
  if (unlocked.has(nodeId)) {
    pushLog(p, "Already unlocked.");
    return;
  }
  if (!canUnlockSkillNode(nodeId, unlocked)) {
    pushLog(p, "That node is not connected to your path yet.");
    return;
  }
  // One cost table for server and UI (#75): hearts are free, other nodes cost 1.
  const cost = skillNodeCost(nodeId);
  if (cost > skillPointsRemaining(p)) {
    pushLog(p, "No skill points left. Level up or earn echoes after max level.");
    return;
  }
  p.skillUnlocked.push(nodeId);
  // Deduct by recomputing from the same table, in the same synchronous step.
  skillPointsRemaining(p);
  logLokAbility(p, nodeId);
  syncVitals(p, false);
  const node = SKILL_NODES[nodeId]!;
  pushLog(
    p,
    `Skill: ${node.label} — ${node.blurb} (${skillPointsRemaining(p)} points left).`,
  );
}

function handleFreeStat(p: Player, attr: AttrKey, delta: 1 | -1 = 1) {
  if (delta === 1) {
    if (p.freeStatPoints <= 0) {
      pushLog(p, "No free attribute points remaining.");
      return;
    }
    p.freeStats[attr] = (p.freeStats[attr] ?? 0) + 1;
  } else {
    if ((p.freeStats[attr] ?? 0) <= 0) {
      pushLog(p, `No free points on ${attr.toUpperCase()} to remove.`);
      return;
    }
    p.freeStats[attr] = (p.freeStats[attr] ?? 0) - 1;
  }
  p.freeStatPoints = Math.max(0, FREE_STAT_POINTS - freeStatsSpent(p.freeStats));
  syncVitals(p, false);
  pushLog(
    p,
    delta === 1
      ? `+1 ${attr.toUpperCase()} (free points left: ${p.freeStatPoints}).`
      : `âˆ’1 ${attr.toUpperCase()} (free points left: ${p.freeStatPoints}).`,
  );
}

function handleDebugMaxLevel(p: Player) {
  if (!DEBUG_CHEATS_ENABLED) {
    pushLog(p, "Debug cheats are disabled on this server.");
    return;
  }
  ensureSkillPointBank(p);
  const from = p.level;
  if (from < MAX_LEVEL) {
    p.level = MAX_LEVEL;
    p.xp = 0;
    grantSkillPoints(p, skillPointsGrantedForLevels(from, MAX_LEVEL));
  }
  syncVitals(p, true);
  p.levelUpUntil = Date.now() + 2400;
  syncLokLevel(p);

  const learnedSet = new Set(p.learned);
  let added = 0;
  const jobsToGrant: JobId[] = [p.job];
  if (p.subjob && p.subjob !== p.job) jobsToGrant.push(p.subjob);
  for (const job of jobsToGrant) {
    for (const id of abilityIdsForJob(job)) {
      if (isTrainerFreeAbility(id)) continue;
      if (learnedSet.has(id)) continue;
      p.learned.push(id);
      learnedSet.add(id);
      logLokAbility(p, id);
      added += 1;
    }
  }
  // Leave skillPrestige alone — post-max echoes come from EXP.
  ensureMainHub(p);
  pushLog(
    p,
    from >= MAX_LEVEL
      ? `Debug: already L${MAX_LEVEL}. Learned ${added} Trainer abilit(ies). Gold ${lok.goldOf(lokToken(p) ?? "")}.`
      : `Debug: L${from} → L${MAX_LEVEL}. Learned ${added} Trainer abilit(ies). Gold ${lok.goldOf(lokToken(p) ?? "")}.`,
  );
  pushLog(
    p,
    `Skill tree: ${skillPointsRemaining(p)} points banked (${skillPointsEarned(p.level, p.skillPrestige)} lifetime, echoes ${p.skillPrestige}/${SKILL_PRESTIGE_CAP}).`,
  );
  if (p.level >= SUBJOB_UNLOCK_LEVEL) {
    pushLog(
      p,
      `Support job unlocked (L${SUBJOB_UNLOCK_LEVEL}+). Speak with the Job Master to pick one — effective L${subjobLevel(p.level)}.`,
    );
  }
  send(p.ws, snapshotFor(p));
  const nearJm = canReachTownNpc(p.x, p.z, JOB_MASTER.x, JOB_MASTER.z);
  if (nearJm && p.level >= SUBJOB_UNLOCK_LEVEL) {
    handleNpcInteract(p, JOB_MASTER.id);
  }
}

function handleJobChange(p: Player, job: JobId) {
  if (!canReachTownNpc(p.x, p.z, JOB_MASTER.x, JOB_MASTER.z)) {
    pushLog(p, "You must speak with the Job Master to change jobs.");
    return;
  }
  if (!isJobId(job)) {
    pushLog(p, "Unknown job.");
    return;
  }
  const def = JOBS[job];
  if (!def.playable) {
    pushLog(p, `${def.name} is not ready yet.`);
    return;
  }
  if (p.job === job) {
    pushLog(p, `You are already a ${def.name}.`);
    return;
  }
  stopRest(p);
  clearJobBuffs(p);
  if (p.subjob === job) p.subjob = null;
  // Keep skillUnlocked as-is — main swap never strips nodes; new main heart is granted free.
  p.job = job;
  p.targetId = null;
  // Auto-swap / grant starter loadout for the new job
  if (job === "knight") {
    if (invAmount(p.inventory, ITEM.SWORD_IRON) <= 0) addItem(p.inventory, ITEM.SWORD_IRON, 1);
    if (invAmount(p.inventory, ITEM.MAIL_IRON) <= 0) addItem(p.inventory, ITEM.MAIL_IRON, 1);
    p.equip.main = ITEM.SWORD_IRON;
    p.equip.body = ITEM.MAIL_IRON;
  } else if (job === "rogue") {
    if (invAmount(p.inventory, ITEM.DAGGER_IRON) <= 0) addItem(p.inventory, ITEM.DAGGER_IRON, 1);
    if (invAmount(p.inventory, ITEM.LEATHER_VEST) <= 0) addItem(p.inventory, ITEM.LEATHER_VEST, 1);
    p.equip.main = ITEM.DAGGER_IRON;
    p.equip.body = ITEM.LEATHER_VEST;
  } else if (job === "fighter") {
    if (invAmount(p.inventory, ITEM.GREATSWORD_IRON) <= 0) addItem(p.inventory, ITEM.GREATSWORD_IRON, 1);
    if (invAmount(p.inventory, ITEM.SCALE_HARNESS) <= 0) addItem(p.inventory, ITEM.SCALE_HARNESS, 1);
    p.equip.main = ITEM.GREATSWORD_IRON;
    p.equip.body = ITEM.SCALE_HARNESS;
  } else if (job === "time_mage" || job === "sorcerer" || job === "cleric") {
    if (invAmount(p.inventory, ITEM.STAFF_ASHBEAM) <= 0) addItem(p.inventory, ITEM.STAFF_ASHBEAM, 1);
    if (invAmount(p.inventory, ITEM.ROBE_LINEN) <= 0) addItem(p.inventory, ITEM.ROBE_LINEN, 1);
    p.equip.main = ITEM.STAFF_ASHBEAM;
    p.equip.body = ITEM.ROBE_LINEN;
  } else if (job === "battle_mage") {
    if (invAmount(p.inventory, ITEM.SWORD_IRON) <= 0) addItem(p.inventory, ITEM.SWORD_IRON, 1);
    if (invAmount(p.inventory, ITEM.MAIL_IRON) <= 0) addItem(p.inventory, ITEM.MAIL_IRON, 1);
    p.equip.main = ITEM.SWORD_IRON;
    p.equip.body = ITEM.MAIL_IRON;
  }
  syncVitals(p, true);
  ensureJobHubs(p);
  pushLog(p, `Main job — you are now a ${def.name}.`);
  rememberPlayer(p);
  send(p.ws, snapshotFor(p));
}

function handleSubjob(p: Player, job: JobId | null) {
  if (!canReachTownNpc(p.x, p.z, JOB_MASTER.x, JOB_MASTER.z)) {
    pushLog(p, "You must speak with the Job Master to set a support job.");
    return;
  }
  if (p.level < SUBJOB_UNLOCK_LEVEL) {
    pushLog(p, `Support jobs unlock at level ${SUBJOB_UNLOCK_LEVEL}.`);
    return;
  }
  if (job === null) {
    p.subjob = null;
    syncVitals(p, false);
    send(p.ws, snapshotFor(p));
    pushLog(p, "Support job cleared.");
    handleNpcInteract(p, JOB_MASTER.id);
    return;
  }
  if (!isJobId(job)) {
    pushLog(p, "Unknown job.");
    return;
  }
  if (!JOBS[job].playable) {
    pushLog(p, `${JOBS[job].name} is not ready yet.`);
    return;
  }
  if (job === p.job) {
    pushLog(p, "Support job must differ from your main.");
    return;
  }
  p.subjob = job;
  ensureJobHubs(p);
  // Support toggles must not refill HP/MP (was a free full heal exploit).
  syncVitals(p, false);
  const subLv = subjobLevel(p.level);
  pushLog(
    p,
    `Support job set — ${JOBS[job].name} L${subLv} (half of main L${p.level}). ${JOBS[job].name} Heart unlocked on the skill tree. Sprite remains ${JOBS[p.job].name}.`,
  );
  rememberPlayer(p);
  send(p.ws, snapshotFor(p));
  handleNpcInteract(p, JOB_MASTER.id);
}

function itemJobKey(job: JobId): string {
  if (job === "time_mage") return "tim";
  if (job === "battle_mage") return "battlemage";
  return job;
}

function canJobEquip(p: Player, def: ItemDef): boolean {
  if (!def.jobRestrict || def.jobRestrict === "all") return true;
  const jobs = new Set(def.jobRestrict);
  return jobs.has(itemJobKey(p.job) as never) || (!!p.subjob && jobs.has(itemJobKey(p.subjob) as never));
}

function handleEquip(p: Player, slot: EquipSlot, tokenId: number | null) {
  if (tokenId === null) {
    p.equip[slot] = null;
    if (slot === "main") {
      p.equip.grip = null;
      p.flux = false;
      p.aether = false;
    }
    syncVitals(p, false);
    pushLog(p, `Unequipped ${slot}.`);
    rememberPlayer(p);
    return;
  }
  if (invAmount(p.inventory, tokenId) <= 0) {
    pushLog(p, "You do not own that item.");
    return;
  }
  const def = getItem(tokenId);
  if (!def || def.kind !== "equipment" || def.slot !== slot) {
    pushLog(p, `That item cannot equip in ${slot}.`);
    return;
  }
  if (!canJobEquip(p, def)) {
    pushLog(p, `${def.name} cannot be equipped by your main or support job.`);
    return;
  }

  const main = slot === "main" ? def : p.equip.main ? getItem(p.equip.main) : undefined;
  if (slot === "sub" && main?.twoHand) {
    pushLog(p, "A two-handed main weapon cannot be used with a sub item.");
    return;
  }
  if (slot === "grip" && !main?.twoHand) {
    pushLog(p, "A grip requires a two-handed main weapon.");
    return;
  }
  if (slot === "main") {
    if (def.twoHand) p.equip.sub = null;
    else p.equip.grip = null;
  }

  p.equip[slot] = tokenId;
  syncVitals(p, false);
  pushLog(p, `Equipped ${def.name} on ${slot}.`);
  rememberPlayer(p);
}

function handleUseItem(p: Player, tokenId: number) {
  const def = getItem(tokenId);
  const consume = def?.consume;
  if (!def || def.kind !== "consumable" || !consume) {
    pushLog(p, "That item cannot be used.");
    return;
  }
  const hasEffect =
    (consume.hp ?? 0) > 0 ||
    (consume.mp ?? 0) > 0 ||
    !!consume.statusClear ||
    (consume.foodDurationSec ?? 0) > 0;
  if (!hasEffect) {
    pushLog(p, `${def.name} has no usable effect.`);
    return;
  }
  // Scrolls need a cast pipeline; reject until wired.
  if (
    consume.scrollSpellId &&
    !(consume.hp || consume.mp || consume.statusClear || consume.foodDurationSec)
  ) {
    pushLog(p, "Scrolls are not usable yet.");
    return;
  }
  if (!takeItem(p.inventory, tokenId, 1)) {
    pushLog(p, `No ${def.name} left.`);
    return;
  }
  const parts: string[] = [];
  if (consume.hp && consume.hp > 0) {
    p.hp = Math.min(p.maxHp, p.hp + consume.hp);
    parts.push(`+${consume.hp} HP`);
  }
  if (consume.mp && consume.mp > 0) {
    p.mp = Math.min(p.maxMp, p.mp + consume.mp);
    parts.push(`+${consume.mp} MP`);
  }
  if (consume.statusClear) {
    // Clear common player ailment timers when catalog asks for a status wipe.
    const key = consume.statusClear.toLowerCase();
    const now = Date.now();
    if (key === "all" || key === "poison" || key === "ailments") {
      p.slowUntil = Math.min(p.slowUntil, now);
      p.blindUntil = Math.min(p.blindUntil, now);
      if (p.movePct < 0) p.moveUntil = Math.min(p.moveUntil, now);
    }
    parts.push("cleared ailments");
  }
  if (consume.foodDurationSec && consume.foodDurationSec > 0) {
    // Food buff stats are not simulated yet; still spend the item + any hp/mp.
    parts.push(`meal (${consume.foodDurationSec}s)`);
  }
  pushLog(
    p,
    parts.length ? `Used ${def.name}: ${parts.join(", ")}.` : `Used ${def.name}.`,
  );
}

function playerHastePct(p: Player, now: number): number {
  let haste = now < p.hasteUntil ? p.hastePct : 0;
  if (now < p.overclockUntil) haste = Math.min(0.8, haste + 0.15);
  haste += playerTreeBonuses(p).hastePct;
  return Math.min(0.85, haste);
}

function playerMoveSpeed(p: Player, now: number): number {
  let speed = p.flux ? PLAYER_SPEED_FLUX : PLAYER_SPEED;
  // Haste buffs use positive movePct; enemy Slow writes negative movePct (+ moveUntil).
  if (now < p.moveUntil && p.movePct !== 0) {
    speed *= Math.max(0.2, 1 + p.movePct);
  } else if (now < p.slowUntil) {
    // Fallback if slowUntil is set without a movePct drag.
    speed *= 0.78;
  }
  const treeMove = playerTreeBonuses(p).movePct;
  if (treeMove > 0) speed *= 1 + treeMove;
  if (p.zoneId === "pale_hollow") {
    speed *= paleHollowMoveMul(p.x, p.z);
  }
  return speed;
}

function playerSwing(p: Player, now: number) {
  if (p.anim === "rest") return;
  if (p.aether) return;
  const mob = findMob(p.targetId);
  if (!mob || !mob.alive) return;
  const d = dist(p.x, p.z, mob.x, mob.z);
  if (d > MELEE_RANGE) return;
  if (now < p.nextSwingAt) return;

  const haste = playerHastePct(p, now);
  const weaponDelay = p.equip.main ? getItem(p.equip.main)?.delayMs : undefined;
  let delay = resolveSwingDelayMs(weaponDelay, haste);
  // Enemy Slow: swingDelayMs clamps haste>=0, so apply attack-speed drag here.
  if (now < p.slowUntil) {
    const slowAmt =
      now < p.moveUntil && p.movePct < 0 ? -p.movePct : 0.22;
    delay = Math.floor(delay * (1 + slowAmt));
  }
  p.nextSwingAt = now + delay;
  p.facing = facingTo(p.x, p.z, mob.x, mob.z);
  p.anim = "melee";
  // Cover most of the swing window so haste still shows a punch each hit.
  p.animUntil = now + Math.max(160, Math.min(delay * 0.9, 520));

  // Enemy Blind / Shield Bash daze — same wild-swing chance as mob Blind.
  if (now < p.blindUntil && Math.random() < 0.45) {
    pushLog(p, "You swing wild (Blind)!");
    return;
  }

  const stance = playerStance(p);
  const stats = playerCombatStats(p);
  // Time Mage keeps Flux / suppressed swings. Sorcerer and Cleric use a STR
  // staff chip (autoAttackFStr floors the glance). Other jobs are full melee.
  const physical =
    p.job !== "time_mage" && p.job !== "sorcerer" && p.job !== "cleric";
  let att = attackFromStats(stats, stance, playerWeaponBonus(p), {
    physical: meleeUsesWeaponAttack(p.job),
  });
  const tree = playerTreeBonuses(p);
  att += tree.atk;
  // Fighter support counts too (#88): Berserk's attack comes with its defense penalty.
  if (physical || playerHasJob(p, "fighter")) {
    att = Math.max(1, Math.floor(att * autoAttackFighterAttackMul(p, now, physical)));
  }
  const mobStats = jobStatsAtLevel(mob.job, mob.level);
  let def = defenseFromVit(mobStats.vit);
  if (now < mob.diaUntil) def = Math.max(1, Math.floor(def * 0.7));
  let acc = stats.dex + 40 + tree.acc + (playerEquipmentStats(p).acc ?? 0) - (now < mob.distractUntil ? mob.distractAcc : 0);
  acc += autoAttackFighterAccBonus(p, now);
  let eva = evasionFromAgi(mobStats.agi);
  if (now < mob.falseGuardUntil) eva = Math.max(0, eva - 18);
  if (Math.random() > hitChance(acc, eva)) {
    pushLog(p, "You miss.");
    return;
  }
  const backbladeReady = now < p.backbladeUntil;
  const killEdgeReady = now < p.killEdgeUntil;
  const shadowPassReady = now < p.shadowPassUntil;
  const stormReady = playerHasJob(p, "fighter") && fighterKillingStorm(p, now);
  let critChance = physical ? 0.08 : stance === "flux" ? 0.12 : 0.05;
  critChance += critFromAgi(stats.agi);
  if (now < p.perpetualUntil) critChance += 0.05;
  critChance += fighterCritBonus(p, now);
  critChance += tree.crit;
  const crit = backbladeReady || killEdgeReady || stormReady || Math.random() < critChance;
  let dmg = physicalDamage(
    att,
    def,
    autoAttackFStr(p, stats, mobStats.vit, stance),
    crit,
  );
  if (backbladeReady) {
    p.backbladeUntil = 0;
    dmg += Math.floor(stats.dex * 0.6);
  }
  if (killEdgeReady) {
    p.killEdgeUntil = 0;
    p.tp = Math.min(3000, p.tp + 300);
  }
  if (shadowPassReady) {
    p.shadowPassUntil = 0;
    p.enmity = 0;
    for (const m of mobs) {
      if (m.targetId === p.wallet) m.targetId = null;
    }
    let best: Player | null = null;
    let bestD = Infinity;
    for (const ally of players.values()) {
      if (ally.wallet === p.wallet) continue;
      const ad = dist(p.x, p.z, ally.x, ally.z);
      if (ad <= 12 && ad < bestD) {
        best = ally;
        bestD = ad;
      }
    }
    if (best) {
      best.enmity = Math.min(10_000, best.enmity + 500);
      pushLog(p, `Shadow Pass — hate slips to ${best.name}.`);
    }
  }
  if (now < p.perpetualUntil) dmg = Math.floor(dmg * 1.15);
  if (playerHasJob(p, "battle_mage")) {
    dmg += battleMageEnSpellBonus(p, now, playerCombatStats(p).int);
  }
  mob.hp -= dmg;
  noteMobHit(mob, p.wallet);
  if (now < mob.sleepUntil) mob.sleepUntil = 0;
  // Hitting a shiny HQ/clone counts as a pull (summon + fight); they stay non-auto-aggro.
  if ((mob.shiny || mob.shinyClone) && mob.hp > 0) {
    pullMobOn(mob, p.wallet, now);
  }
  if (mob.archetype === "dust_hare" && !mob.shiny && !mob.shinyClone && mob.hp > 0) {
    mob.fleeUntil = now + 2800;
    mob.targetId = null;
    mob.roamTx = Number.NaN;
    mob.roamTz = Number.NaN;
    mob.roamPauseUntil = 0;
    // Face the flee direction (away from attacker) so client mirror/hop stay stable.
    mob.facing = facingTo(mob.x, mob.z, p.x, p.z) + Math.PI;
    mob.anim = "walk";
  }
  const tpGain = Math.floor(80 * (playerHasJob(p, "fighter") ? fighterTpGainMul(p, now) : 1));
  p.tp = Math.min(3000, p.tp + tpGain);
  if (physical && (playerHasJob(p, "fighter") || playerHasJob(p, "rogue") || playerHasJob(p, "knight"))) {
    p.enmity = Math.min(10_000, p.enmity + Math.floor(dmg * (playerHasJob(p, "rogue") ? 0.08 : 0.15)));
  }
  let hitNote = crit ? " (Critical!)" : "";
  if (stormReady && crit) hitNote += " (Killing Storm!)";
  if (backbladeReady) hitNote += " (Backblade!)";
  if (killEdgeReady) hitNote += " (Kill Edge!)";
  pushLog(p, `You hit ${mob.name} for ${dmg}${hitNote}.`);

  const doubleChance = playerHasJob(p, "fighter") ? fighterDoubleAttackChance(p, now) : 0;
  if (mob.hp > 0 && doubleChance > 0 && Math.random() < doubleChance) {
    const dmg2 = Math.max(1, Math.floor(dmg * 0.85));
    mob.hp -= dmg2;
    p.tp = Math.min(3000, p.tp + Math.floor(tpGain * 0.6));
    pushLog(p, `Double attack! ${dmg2} on ${mob.name}.`);
  }

  if (mob.hp <= 0) {
    rewardMobKill(p, mob, now);
  }
}


function clearMobPendingCast(mob: Mob) {
  mob.pendingCastHitAt = 0;
  mob.pendingCastTarget = null;
  mob.pendingCastKind = "";
  mob.pendingCastDmg = 0;
  mob.pendingCastLog = "";
  mob.pendingCastSlowMs = 0;
  mob.pendingCastMovePct = 0;
  mob.pendingCastMagic = false;
}

function scheduleMobPendingCast(
  mob: Mob,
  now: number,
  targetWallet: string,
  resolve: PendingMobCastResolve,
) {
  mob.pendingCastHitAt = now + MOB_CAST_WINDUP_MS;
  mob.pendingCastTarget = targetWallet;
  mob.pendingCastKind = resolve.type;
  mob.pendingCastDmg = resolve.type === "damage" ? resolve.dmg : 0;
  mob.pendingCastLog = resolve.log;
  mob.pendingCastSlowMs = resolve.type === "slow" ? resolve.durationMs : 0;
  mob.pendingCastMovePct = resolve.type === "slow" ? resolve.movePct : 0;
  mob.pendingCastMagic = resolve.type !== "slow" && resolve.magic === true;
}

/**
 * Apply pending cast damage with the same absorbs as a live swing.
 * Magic casts (autos / bolts) use mag DT; physical pending hits keep phys DT (#55).
 */
function applyPendingMobDamage(
  mob: Mob,
  target: Player,
  now: number,
  rawDmg: number,
  hitLog: string,
  magic: boolean,
) {
  let dmg = rawDmg;
  if (target.zoneId === "pale_hollow") {
    const b = paleHollowBiome(mob.x, mob.z);
    if (mob.archetype === "pale_slime" && (b === "river" || b === "riverbank")) {
      dmg = Math.max(1, Math.floor(dmg * 1.25));
    }
    if (mob.archetype === "cliff_adder" && b === "vine_cliff") {
      dmg = Math.max(1, Math.floor(dmg * 1.15));
    }
  }
  // Magic → Asylum / Fealty / Shell / Mana Wall + tree magDt; physical → phys DT.
  dmg = Math.max(0, Math.floor(dmg * pendingHitDtMul(target, now, magic, playerTreeBonuses(target))));
  dmg = absorbStoneskin(target, now, dmg);
  const beforeShield = target.healAbsorbHp;
  dmg = absorbHealShield(target, now, dmg);
  const soaked = Math.max(0, beforeShield - target.healAbsorbHp);
  dmg = Math.max(0, Math.floor(dmg * fighterDefenseMul(target, now)));
  const wall = absorbManaWall(target, now, dmg);
  dmg = wall.dmg;
  if (dmg <= 0) {
    pushLog(
      target,
      soaked > 0
        ? `${mob.name}'s blow is swallowed by your Solace shield!`
        : wall.bled > 0
          ? `${mob.name}'s blow bleeds ${wall.bled} MP through Mana Wall!`
          : `${mob.name}'s blow glances off your ward!`,
    );
    return;
  }
  if (now < mob.addleUntil) dmg = Math.max(1, Math.floor(dmg * 0.65));
  target.hp = Math.max(0, target.hp - dmg);
  if (target.miseryRite) {
    target.miseryEmpowerUntil = now + 15_000;
  }
  stopRest(target, `${mob.name}'s blow breaks your rest!`);
  const notes: string[] = [];
  if (soaked > 0) notes.push(`${soaked} absorbed`);
  if (wall.bled > 0) notes.push(`${wall.bled} MP`);
  if (now < mob.addleUntil) notes.push("Addled");
  const base = hitLog.endsWith(".") ? hitLog.slice(0, -1) : hitLog;
  pushLog(target, notes.length > 0 ? `${base} (${notes.join(", ")}).` : `${base}.`);
}

/**
 * Resolve a cast that finished wind-up. Self-contained so chase / CC early
 * returns cannot skip the hit after the tell has played.
 */
function resolveMobPendingCast(mob: Mob, now: number) {
  if (!mob.pendingCastHitAt || now < mob.pendingCastHitAt) return;
  if (!mob.alive) {
    clearMobPendingCast(mob);
    return;
  }
  const targetWallet = mob.pendingCastTarget;
  const kind = mob.pendingCastKind;
  const dmg = mob.pendingCastDmg;
  const log = mob.pendingCastLog;
  const slowMs = mob.pendingCastSlowMs;
  const movePct = mob.pendingCastMovePct;
  const magic = mob.pendingCastMagic;
  clearMobPendingCast(mob);

  if (!targetWallet) return;
  const target = players.get(targetWallet);
  if (!target || target.hp <= 0) return;

  if (kind === "miss") {
    pushLog(target, log);
    return;
  }
  if (kind === "slow") {
    target.slowUntil = Math.max(target.slowUntil, now + slowMs);
    target.moveUntil = Math.max(target.moveUntil, now + slowMs);
    target.movePct = Math.min(target.movePct, movePct);
    pushLog(target, log);
    return;
  }
  if (kind === "damage") {
    applyPendingMobDamage(mob, target, now, dmg, log, magic);
    if (target.hp <= 0) {
      if (now < target.reraiseUntil) {
        target.reraiseUntil = 0;
        target.hp = Math.max(1, Math.floor(target.maxHp * 0.25));
        target.sacredLightUntil = now + 2200;
        pushLog(target, "Ember Vigil — you rise in sacred light!");
      } else {
        respawnAtHub(target);
        if (mob.shiny && !mob.shinyClone) {
          shinyFleeAfterPlayerKill(mob, now);
          pushLog(target, mob.name + " flees into the Hollow...");
        }
      }
    }
  }
}

function mobSwing(mob: Mob, now: number) {
  if (!mob.alive) return;
  if (now < (mob.fleeUntil ?? 0)) return;
  // Non-aggro field critters never auto-fight. Shiny HQ/clones are also aggro:safe
  // (no auto-pull) but WILL fight after the player engages them (targetId set).
  if (mob.aggro === "safe") {
    if (!(mob.shiny || mob.shinyClone) || !mob.targetId) return;
  }
  // Cast wind-up resolve first so the tell always leads the hit.
  resolveMobPendingCast(mob, now);
  if (
    now < mob.stunUntil ||
    now < mob.petrifyUntil ||
    now < mob.bindUntil ||
    now < mob.sleepUntil
  ) {
    clearMobPendingCast(mob);
    mob.anim = "idle";
    mob.targetId = null;
    return;
  }
  // Silence / Mute — interrupt cast wind-up only; keep hate and melee.
  if (now < mob.silenceUntil) {
    clearMobPendingCast(mob);
  }

  let nearest: Player | null = null;
  let bestScore = -Infinity;
  for (const p of players.values()) {
    // Ghost Step — invisible to chase / aggro
    if (now < p.ghostStepUntil) continue;
    const d = dist(mob.x, mob.z, p.x, p.z);
    if (d > 16) continue;
    // Prefer current target + high enmity (Knight Provoke/Flash)
    let score = -d + (p.enmity || 0) * 0.02;
    if (mob.targetId === p.wallet) score += 8;
    if (score > bestScore) {
      bestScore = score;
      nearest = p;
    }
  }
  if (!nearest) {
    mob.targetId = null;
    // Leave anim alone — idle roam drives walk/idle when not fighting.
    return;
  }
  mob.targetId = nearest.wallet;
  mob.facing = facingTo(mob.x, mob.z, nearest.x, nearest.z);

  const d = dist(mob.x, mob.z, nearest.x, nearest.z);
  const engage = mobEngageRange(mob.job);
  if (d > engage) {
    // Shiny clones march in formation with the HQ — don't freestyle-chase.
    if (mob.shinyClone) {
      if (now >= mob.animUntil) mob.anim = "walk";
      return;
    }
    if (now >= mob.animUntil) {
      const swingSlow = now < mob.slowUntil ? mob.swingPenalty : 0;
      const grav = now < mob.gravityUntil ? mob.gravityPct : 0;
      const speed = 2.2 * (1 - Math.max(swingSlow, grav));
      const step = (speed * TICK_MS) / 1000;
      // Walkability-aware chase (#73): slide along banks instead of crossing water.
      const s = steerMobStep(mob.x, mob.z, nearest.x, nearest.z, step);
      if (s.moved) {
        mob.x = s.x;
        mob.z = s.z;
        mob.facing = s.heading;
        syncUnitY(mob);
        mob.anim = "walk";
      } else {
        mob.anim = "idle";
      }
    }
    return;
  }

  if (now < mob.nextSwingAt) {
    if (now >= mob.animUntil && mob.anim !== "walk" && !mob.pendingCastHitAt) mob.anim = "idle";
    return;
  }
  // Don't start a new swing while a cast tell is still winding up.
  if (mob.pendingCastHitAt) return;
  if (now < mob.paraUntil && Math.random() < 0.35) {
    mob.nextSwingAt = now + 800;
    pushLog(nearest, `${mob.name} seizes up (Paralyze).`);
    return;
  }
  if (now < mob.blindUntil && Math.random() < 0.45) {
    mob.nextSwingAt = now + 900;
    pushLog(nearest, `${mob.name} swings wild (Blind)!`);
    return;
  }
  if (now < nearest.ghostStepUntil) {
    mob.nextSwingAt = now + 900;
    pushLog(nearest, `${mob.name} passes through violet smoke — miss!`);
    return;
  }

  const vitalsOf = (pl: Player) => {
    const defStats = playerCombatStats(pl);
    return {
      vit: defStats.vit,
      agi: Math.max(0, defStats.agi - fighterEvaPenalty(pl, now)),
      // Gear armor counts against physical hits, same as the character sheet (#52).
      def: playerDefense(defStats.vit, playerEquipmentStats(pl).def ?? 0),
    };
  };
  const vitals = vitalsOf(nearest);

  /** `victim` is the mob's target unless a Knight interposed (#79). */
  const applyMobDamage = (rawDmg: number, hitLog: string, victim: Player = nearest) => {
    let dmg = rawDmg;
    if (victim.zoneId === "pale_hollow") {
      const b = paleHollowBiome(mob.x, mob.z);
      if (mob.archetype === "pale_slime" && (b === "river" || b === "riverbank")) {
        dmg = Math.max(1, Math.floor(dmg * 1.25));
      }
      if (mob.archetype === "cliff_adder" && b === "vine_cliff") {
        dmg = Math.max(1, Math.floor(dmg * 1.15));
      }
    }
    dmg = Math.max(0, Math.floor(dmg * playerPhysDtMul(victim, now)));
    dmg = absorbStoneskin(victim, now, dmg);
    const beforeShield = victim.healAbsorbHp;
    dmg = absorbHealShield(victim, now, dmg);
    const soaked = Math.max(0, beforeShield - victim.healAbsorbHp);
    dmg = Math.max(0, Math.floor(dmg * fighterDefenseMul(victim, now)));
    const wall = absorbManaWall(victim, now, dmg);
    dmg = wall.dmg;
    if (dmg <= 0) {
      pushLog(
        victim,
        soaked > 0
          ? `${mob.name}'s blow is swallowed by your Solace shield!`
          : wall.bled > 0
            ? `${mob.name}'s blow bleeds ${wall.bled} MP through Mana Wall!`
            : `${mob.name}'s blow glances off your ward!`,
      );
      return;
    }
    if (now < mob.addleUntil) dmg = Math.max(1, Math.floor(dmg * 0.65));
    victim.hp = Math.max(0, victim.hp - dmg);
    if (victim.miseryRite) {
      victim.miseryEmpowerUntil = now + 15_000;
    }
    stopRest(victim, `${mob.name}'s blow breaks your rest!`);
    const notes: string[] = [];
    if (soaked > 0) notes.push(`${soaked} absorbed`);
    if (wall.bled > 0) notes.push(`${wall.bled} MP`);
    if (now < mob.addleUntil) notes.push("Addled");
    const base = hitLog.endsWith(".") ? hitLog.slice(0, -1) : hitLog;
    pushLog(victim, notes.length > 0 ? `${base} (${notes.join(", ")}).` : `${base}.`);
  };

  const ability = tryMobJobAbility(mob, {
    now,
    dist: d,
    player: nearest,
    vitals,
    pushLog: (msg) => pushLog(nearest, msg),
    applyPlayerDamage: (raw, note) => applyMobDamage(raw, note),
  });

  // Interpose (#79): a Knight bodyguard takes physical autos aimed at a nearby ally.
  let guard: Player | null = null;
  if (ability.ok) {
    if (ability.pending) scheduleMobPendingCast(mob, now, nearest.wallet, ability.pending);
  } else {
    const swingSlow = now < mob.slowUntil ? mob.swingPenalty : 0;
    mob.nextSwingAt = now + swingDelayMs(2400, -swingSlow);
    // Picked once per swing and resolved straight on the Knight (their own
    // evasion, armor and DT incl. Interpose's 0.75) — never re-redirected.
    guard = mobAutoIsMagic(mob, now) ? null : findInterposeGuard(nearest, players.values(), now, dist);
    const roll = mobAutoAttackRoll(mob, guard ? vitalsOf(guard) : vitals, now);
    mob.anim = roll.anim;
    if (roll.anim === "cast") {
      // Magic auto — cast anim + circle first; damage (or miss) after wind-up.
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      if (!roll.hit) {
        scheduleMobPendingCast(mob, now, nearest.wallet, {
          type: "miss",
          log: `${mob.name} misses you.`,
          magic: true,
        });
      } else {
        scheduleMobPendingCast(mob, now, nearest.wallet, {
          type: "damage",
          dmg: roll.dmg,
          log: `${mob.name} strikes you with magic for ${roll.dmg}.`,
          magic: true,
        });
      }
    } else {
      mob.animUntil = now + 480;
      if (guard) {
        pushLog(nearest, `${guard.name} interposes and takes ${mob.name}'s blow!`);
        if (!roll.hit) {
          pushLog(guard, `You interpose for ${nearest.name} — ${mob.name} misses you.`);
          return;
        }
        applyMobDamage(
          roll.dmg,
          `You interpose for ${nearest.name} — ${mob.name} hits you for ${roll.dmg}`,
          guard,
        );
      } else {
        if (!roll.hit) {
          pushLog(nearest, `${mob.name} misses you.`);
          return;
        }
        applyMobDamage(roll.dmg, `${mob.name} hits you for ${roll.dmg}`);
      }
    }
  }

  // A redirected hit lands on (and can drop) the Knight instead of the target.
  for (const downed of guard ? [nearest, guard] : [nearest]) {
    if (downed.hp > 0) continue;
    if (now < downed.reraiseUntil) {
      downed.reraiseUntil = 0;
      downed.hp = Math.max(1, Math.floor(downed.maxHp * 0.25));
      downed.sacredLightUntil = now + 2200;
      pushLog(downed, "Ember Vigil — you rise in sacred light!");
    } else {
      const killer = mob;
      respawnAtHub(downed);
      if (killer.shiny && !killer.shinyClone) {
        shinyFleeAfterPlayerKill(killer, now);
        pushLog(downed, killer.name + " flees into the Hollow...");
      }
    }
  }
}

function tickSim() {
  tick += 1;
  const now = Date.now();
  const dt = TICK_MS / 1000;

  // Remove faded shiny clones (ephemeral — never respawn).
  for (let i = mobs.length - 1; i >= 0; i--) {
    const m = mobs[i]!;
    if (m.shinyClone && !m.alive && m.deathAt && now >= m.deathAt + MOB_DEATH_FADE_MS) {
      if (m.hqId) {
        const hq = findMob(m.hqId);
        if (hq) hq.cloneIds = hq.cloneIds.filter((id) => id !== m.id);
      }
      mobs.splice(i, 1);
    }
  }

  for (const mob of mobs) {
    if (!mob.alive && !mob.shinyClone && now >= mob.respawnAt) {
      const idx = mobs.indexOf(mob);
      // Drop any leftover clones from a prior shiny life before resetting the slot.
      if (mob.shiny) despawnShinyClones(mob, now);
      mobs[idx] = respawnFieldMobFromDef(mob.id, mob.name, mob.spawnX, mob.spawnZ);
    }
    if (now >= mob.slowUntil) mob.swingPenalty = 0;
    if (now >= mob.gravityUntil) mob.gravityPct = 0;
    if (mob.alive && now < mob.bioUntil && mob.bioTick > 0 && tick % TICK_HZ === 0) {
      mob.hp = Math.max(0, mob.hp - mob.bioTick);
      if (mob.hp <= 0) {
        // #69: credit the Bio caster (or another wallet that hit it), not whoever happens to target it.
        const credited = pickDotKillCredit(mob.bioSourceWallet, mob.hitBy, players.values());
        if (credited) rewardMobKill(credited, mob, now);
        else {
          mob.alive = false;
          mob.anim = "dead";
          mob.deathAt = now;
          mob.respawnAt = now + MOB_DEATH_FADE_MS + MOB_RESPAWN_MS;
          mob.targetId = null;
        }
      }
    }
  }

  for (const p of players.values()) {
    // Catch overcapped XP (e.g. earned before leveling existed)
    tryLevelUp(p);

    // Regain TP while Flux
    if (p.flux && tick % 20 === 0) p.tp = Math.min(3000, p.tp + 5);

    // Auto-close to melee while engaged
    chaseEngaged(p);

    // Gather channel (#67): grant only after interactMs, break on move/damage/engage
    tickGathering(p, now);

    if (p.moveTo) {
      stopRest(p, "You stand and break your rest.");
      const speed = playerMoveSpeed(p, now);
      const dx = p.moveTo.x - p.x;
      const dz = p.moveTo.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        p.moveTo = null;
        syncUnitY(p);
        p.walkUntil = now + 150;
        if (now >= p.animUntil) p.anim = "walk";
      } else {
        const step = Math.min(d, speed * dt);
        const nx = p.x + (dx / d) * step;
        const nz = p.z + (dz / d) * step;
        const c = clampPlayerMove(p.x, p.z, nx, nz);
        // Blocked by water/wall — cancel path instead of skating along the barrier
        if (Math.hypot(c.x - p.x, c.z - p.z) < 1e-4 && !paleHollowWalkable(nx, nz)) {
          p.moveTo = null;
        } else {
          p.x = c.x;
          p.z = c.z;
          // Ignore tiny residual heading noise near the waypoint
          if (d > 0.35) p.facing = facingTo(0, 0, dx, dz);
          p.walkUntil = now + 200;
          // Don't stomp an active swing/cast pose
          if (now >= p.animUntil) p.anim = "walk";
        }
        syncUnitY(p);
      }
    } else if (p.anim === "walk" && now >= p.walkUntil) {
      if (now >= p.animUntil) p.anim = "idle";
    }

    if (p.anim === "rest") {
      // Once per second: recover HP/MP, bleed TP
      if (tick % TICK_HZ === 0) {
        const beforeHp = p.hp;
        const beforeMp = p.mp;
        const tree = playerTreeBonuses(p);
        p.hp = Math.min(p.maxHp, p.hp + REST_TICK.hp + tree.restHp);
        p.mp = Math.min(p.maxMp, p.mp + REST_TICK.mp + tree.restMp);
        p.tp = Math.max(0, p.tp - REST_TICK.tpDrain);
        if (p.hp !== beforeHp || p.mp !== beforeMp) {
          pushLog(
            p,
            `Restingâ€¦ HP ${p.hp}/${p.maxHp} Â· MP ${p.mp}/${p.maxMp} Â· TP ${p.tp}`,
          );
        }
        if (p.hp >= p.maxHp && p.mp >= p.maxMp && p.tp <= 0) {
          stopRest(p, "Fully recovered — you rise.");
        }
      }
    } else if ((p.anim === "melee" || p.anim === "cast") && now >= p.animUntil) {
      p.anim = "idle";
    }

    // Regen / Refresh tick on their own schedule — anim locks must not suppress them (#66).
    if (p.anim !== "rest" && tick % TICK_HZ === 0) {
      if (now < p.refreshUntil) {
        const tickMp = Math.max(1, p.refreshTick || 4);
        p.mp = Math.min(p.maxMp, p.mp + tickMp);
      }
      if (now < p.regenUntil && p.regenTick > 0) {
        p.hp = Math.min(p.maxHp, p.hp + p.regenTick);
      }
      // Passive gear regen (Heart Ring, etc.) — once per second, replay-safe (catalog only).
      const gearHp = gearRegen(p);
      if (gearHp > 0 && p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + gearHp);
      }
    }

    playerSwing(p, now);
  }

  // Pale Hollow field AI — safe / proximity / sight / sound + link
  for (const mob of mobs) {
    if (!mob.alive) continue;
    syncUnitY(mob);
    if (now < (mob.fleeUntil ?? 0)) {
      const step = 2.2 * dt;
      const nx = mob.x + Math.sin(mob.facing) * step;
      const nz = mob.z + Math.cos(mob.facing) * step;
      const c = clampPlayerMove(mob.x, mob.z, nx, nz);
      if (!paleHollowWalkable(c.x, c.z) || paleHollowInBuildingClearing(c.x, c.z)) {
        // Nudge off obstacles instead of snapping against bounds each tick.
        mob.facing += (Math.random() > 0.5 ? 1 : -1) * (0.55 + Math.random() * 0.5);
      } else if (Math.hypot(c.x - mob.x, c.z - mob.z) < 1e-4) {
        mob.facing += (Math.random() > 0.5 ? 1 : -1) * 0.8;
      } else {
        mob.x = c.x;
        mob.z = c.z;
        syncUnitY(mob);
      }
      mob.anim = "walk";
      continue;
    }
    // Shiny clones: hold formation on the HQ (little army) when the pack is out.
    if (mob.shinyClone && mob.hqId) {
      const hq = findMob(mob.hqId);
      if (!hq || !hq.alive) {
        // Orphaned clone — despawn next fade cycle.
        mob.alive = false;
        mob.hp = 0;
        mob.anim = "dead";
        mob.deathAt = now;
        mob.respawnAt = now;
        continue;
      }
      const living = hq.cloneIds.filter((id) => {
        const c = findMob(id);
        return !!(c && c.alive);
      }).length;
      const armyReady = living >= SHINY_CLONE_COUNT;
      // Share the HQ's current fight target once pulled (still never auto-aggro).
      if (hq.targetId && !mob.targetId) mob.targetId = hq.targetId;
      if (armyReady || hq.targetId) {
        const slot = Math.max(0, hq.cloneIds.indexOf(mob.id));
        const off = formationOffset(hq.facing, slot);
        const tx = hq.x + off.dx;
        const tz = hq.z + off.dz;
        const dForm = dist(mob.x, mob.z, tx, tz);
        if (dForm > 0.35) {
          const step = Math.min(dForm, 3.4 * dt);
          const nx = mob.x + ((tx - mob.x) / dForm) * step;
          const nz = mob.z + ((tz - mob.z) / dForm) * step;
          const c = clampPlayerMove(mob.x, mob.z, nx, nz);
          mob.x = c.x;
          mob.z = c.z;
          syncUnitY(mob);
          mob.facing = facingTo(mob.x, mob.z, hq.x + Math.sin(hq.facing), hq.z + Math.cos(hq.facing));
          mob.anim = "walk";
        } else if (!mob.targetId) {
          mob.anim = "idle";
          mob.facing = hq.facing;
        }
        // When fighting, fall through to mobSwing via targetId; skip roam.
        if (!mob.targetId) continue;
        // Keep formation while chasing — don't run independent aggro roam.
        continue;
      }
    }
    // Shiny HQ stays passive (safe) until pulled — roam like hares, never auto-aggro.
    if (mob.aggro === "safe") {
      if (!(mob.shiny || mob.shinyClone) || !mob.targetId) {
        mob.targetId = null;
        tickMobRoam(mob, now, dt);
        continue;
      }
      // Pulled shiny HQ: skip auto-aggro acquisition; chase handled in mobSwing.
    }
    if (!mob.targetId) {
      let nearest: Player | null = null;
      let best = mob.aggroRange ?? 4;
      for (const pl of players.values()) {
        if (now < pl.ghostStepUntil) continue;
        const d = dist(mob.x, mob.z, pl.x, pl.z);
        if (d > best) continue;
        if (mob.aggro === "sight") {
          const toPl = facingTo(mob.x, mob.z, pl.x, pl.z);
          if (Math.abs(angleDelta(mob.facing, toPl)) > 1.15) continue;
        } else if (mob.aggro === "sound") {
          const noisy =
            pl.anim === "walk" ||
            pl.anim === "melee" ||
            pl.anim === "cast" ||
            !!pl.targetId;
          if (!noisy) continue;
        } else if (mob.aggro !== "proximity") {
          continue;
        }
        best = d;
        nearest = pl;
      }
      if (nearest) {
        pullMobOn(mob, nearest.wallet, now);
      } else {
        tickMobRoam(mob, now, dt);
      }
    }
  }

  for (const mob of mobs) mobSwing(mob, now);
  broadcastSnapshots();
}

function handleGather(p: Player, nodeId: string) {
  const node = fieldNodes.find((n) => n.id === nodeId);
  if (!node) {
    pushLog(p, "Nothing to gather there.");
    return;
  }
  if (p.gathering?.nodeId === nodeId) {
    pushLog(p, `Already gathering ${node.name}.`);
    return;
  }
  const d = dist(p.x, p.z, node.x, node.z);
  if (d > GATHER_RANGE) {
    pushLog(p, "Move closer to gather.");
    p.moveTo = clampPlayerMove(p.x, p.z, node.x, node.z);
    return;
  }
  const now = Date.now();
  if (now < node.readyAt) {
    pushLog(p, `${node.name} is depleted. Wait for regrowth.`);
    return;
  }
  stopRest(p, "You break rest to gather.");
  p.targetId = null;
  p.moveTo = null;
  p.facing = facingTo(p.x, p.z, node.x, node.z);
  // Channel: the yield is granted by tickGathering once interactMs has elapsed.
  p.gathering = beginGatherChannel(node, p, now);
  p.anim = "cast";
  p.animUntil = p.gathering.readyAt;
  pushLog(p, `Gathering ${node.name}...`);
  send(p.ws, snapshotFor(p));
}

/** Finish or break an in-progress gather channel. Runs every sim tick. */
function tickGathering(p: Player, now: number) {
  const ch = p.gathering;
  if (!ch) return;
  const step = tickGatherChannel(ch, { x: p.x, z: p.z, hp: p.hp, engaged: !!p.targetId }, now);
  if (step.kind === "pending") return;
  p.gathering = null;
  if (step.kind === "cancel") {
    if (p.anim === "cast" && p.animUntil > now) p.animUntil = now;
    pushLog(p, step.reason);
    return;
  }
  const node = fieldNodes.find((n) => n.id === ch.nodeId);
  if (!node || node.spawnPointId !== ch.spawnPointId || now < node.readyAt) {
    pushLog(p, `Someone else gathered ${ch.nodeName} first.`);
    return;
  }
  if (dist(p.x, p.z, node.x, node.z) > GATHER_RANGE) {
    pushLog(p, "Move closer to gather.");
    return;
  }
  const yieldId = node.yields[Math.floor(Math.random() * node.yields.length)] ?? node.yields[0];
  grantBaseMat(p, yieldId, 1);
  logLokHarvest(p, yieldId, 1);
  node.readyAt = now + node.respawnMs;
  relocateGatherNode(fieldNodes, node);
  pushLog(p, `Got ${matDisplayName(yieldId)} ×1.`);
  send(p.ws, snapshotFor(p));
}

async function handleCraft(p: Player, itemId: number) {
  const crafter = PH_HUB_NPCS.find((n) => n.role === "crafter");
  if (!crafter || !canReachTownNpc(p.x, p.z, crafter.x, crafter.z)) {
    pushLog(p, "You must be near the Craft Master to craft.");
    return;
  }
  const def = getCraftableItem(itemId);
  if (!def || !def.craftSkill || def.craftLevel == null) {
    pushLog(p, "That cannot be crafted.");
    return;
  }
  ensureCraftSkills(p);
  const skill = def.craftSkill;
  const skillLv = p.craftSkills[skill]?.level ?? 1;
  if (skillLv < def.craftLevel) {
    pushLog(p, `${def.name} needs ${skill} level ${def.craftLevel} (you have ${skillLv}).`);
    return;
  }
  if (!recipeMaterialsComplete(def)) {
    pushLog(p, "Recipe materials unknown or incomplete — cannot craft.");
    return;
  }
  const goldCost = craftGoldCost(def.craftLevel ?? 0);
  const outQty = craftOutputQty(def);
  const charged = await withPlayerCharge(
    p.charId,
    () => {
      const now = pickAffordableMaterials(def, p.inventory, p.baseMats);
      return !!now && now.length > 0;
    },
    () => {
      const now = pickAffordableMaterials(def, p.inventory, p.baseMats);
      if (!now || now.length === 0) return null;
      const taken: { slug: string; qty: number }[] = [];
      for (const mat of now) {
        if (!takeMat(p, mat.slug, mat.qty)) {
          for (const prev of taken) grantBaseMat(p, prev.slug, prev.qty);
          return null;
        }
        taken.push({ slug: mat.slug, qty: mat.qty });
      }
      return () => {
        for (const prev of taken) grantBaseMat(p, prev.slug, prev.qty);
      };
    },
    () => spendLogGold(p, goldCost, "craft"),
    () => {
      const logged = logLokCraft(p, def.id, outQty);
      if (!logged.ok) {
        return { ok: false as const, error: "Craft was not written to your log: " + logged.error };
      }
      if (def.kind === "base") grantBaseMat(p, def.slug, outQty);
      else addItem(p.inventory, def.id, outQty);
      const prevLv = p.craftSkills[skill]?.level ?? 1;
      grantCraftXp(p, skill, craftXpForRecipe(def.craftLevel ?? skillLv, skillLv));
      const nextLv = p.craftSkills[skill]?.level ?? prevLv;
      const levelNote = nextLv > prevLv ? " " + skill + " rose to " + nextLv + "!" : "";
      const qtyNote = outQty > 1 ? " x" + outQty : "";
      rememberPlayer(p);
      pushLog(p, "Crafted " + def.name + qtyNote + "." + levelNote);
      send(p.ws, snapshotFor(p));
      return { ok: true as const };
    },
    () => {
      if (goldCost > 0) earnLogGold(p, "craft_refund", goldCost);
    },
  );
  if (!charged.ok) {
    if (charged.error === "no longer available") {
      const preview = recipeMaterials(def);
      if (preview.length === 0) pushLog(p, "Recipe materials unknown.");
      else pushLog(p, "Need materials: " + preview.map((m) => m.name + " x" + m.qty).join(", ") + ".");
    } else if (charged.error.startsWith("Craft was not written")) {
      pushLog(p, charged.error);
    } else {
      pushLog(p, "Need " + goldCost + " gold to craft " + def.name + ". " + charged.error);
    }
  }
}

function adoptOrphanLogs(wallet: string, ws: WebSocket) {
  const owner = wallet.toLowerCase();
  const owned = lok.charsForWallet(owner);
  if (owned.length === 0) return;
  // #271: only block adopt when another roster still holds a live-owned slot.
  // releaseCharacterFromRoster clears sold characters so buyers can bind.
  const taken = new Set<string>();
  for (const [rosterWallet, slots] of accountRoster.entries()) {
    for (const id of slots.keys()) {
      if (rosterWallet === owner) {
        taken.add(id);
        continue;
      }
      const tok = lok.tokenFor(id);
      const cached = tok ? nftOwnerCache().get(tok) : null;
      if (cached && cached === rosterWallet) taken.add(id);
      else if (!cached) taken.add(id);
      else releaseCharacterFromRoster(id);
    }
  }
  const rows = owned.filter((row) => !taken.has(row.charId));
  if (rows.length === 0) return;
  const counts = new Map<string, number>();
  for (const row of lok.boundChars()) {
    const key = characterNameKey(row.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    const jobId = JOB_IDS[row.job];
    const job = jobId && isJobId(jobId) && JOBS[jobId].playable ? jobId : "time_mage";
    const crowded = (counts.get(characterNameKey(row.name)) ?? 0) > 1;
    // Space plus token id stays inside the ASCII name alphabet. A hash would be rejected.
    const renamed = (crowded ? row.name + " " + row.tokenId : row.name).slice(0, 16);
    if (renamed !== row.name) {
      const named = lok.setBoundName(row.charId, renamed);
      if (!named.ok) {
        console.error("[bellgrave] rename on adopt failed:", named.error);
      }
    }
    const bound = lok.boundChars().find((c) => c.charId === row.charId)?.name ?? renamed;
    const norm = normalizeCharacterName(bound);
    createPlayer(owner, norm.ok ? norm.name : bound, ws, job, "male", row.charId);
  }
  players.delete(owner);
  walletToPlayer.delete(owner);
}

function onMessage(ws: WebSocket, data: string) {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    send(ws, { type: "error", message: "Invalid JSON" });
    return;
  }
  const msg = parseClientMessage(json);
  if (!msg) {
    send(ws, { type: "error", message: "Invalid message" });
    return;
  }

  if (msg.type === "ping") {
    send(ws, { type: "pong", t: msg.t ?? Date.now() });
    return;
  }

  if (msg.type === "auth/hello") {
    const sock = ws as WebSocket & {
      authConnId?: string;
      authDomain?: string;
      authIp?: string;
      authUri?: string;
    };
    const challenged = issueAuthChallenge(msg.wallet, {
      connectionId: sock.authConnId,
      domain: sock.authDomain,
      uri: sock.authUri,
      clientIp: sock.authIp,
      chainId: envSettlementChainId(),
    });
    if (!challenged.ok) {
      send(ws, { type: "error", message: challenged.error });
      return;
    }
    send(ws, {
      type: "auth/challenge",
      wallet: msg.wallet.toLowerCase(),
      nonce: challenged.nonce,
      issuedAt: challenged.issuedAt,
      message: challenged.message,
    });
    return;
  }

  if (msg.type === "auth") {
    const sock = ws as WebSocket & { authConnId?: string; authDeadline?: ReturnType<typeof setTimeout> };
    void verifyAuthLogin({
      wallet: msg.wallet,
      signature: msg.signature,
      nonce: msg.nonce,
      message: msg.message,
      connectionId: sock.authConnId,
    }).then((verified) => {
      if (!verified.ok) {
        send(ws, { type: "error", message: verified.error });
        return;
      }
      // Clear auth deadline only on success — a failed auth must not keep the socket forever.
      if (sock.authDeadline) {
        clearTimeout(sock.authDeadline);
        sock.authDeadline = undefined;
      }
      const wallet = verified.wallet;
      (ws as WebSocket & { wallet?: string }).wallet = wallet;
      adoptOrphanLogs(wallet, ws);

      // Park any live character — keep roster, leave the world until char/enter or char/create.
      // Signed auth is required before an online session can be taken over.
      const live = players.get(wallet);
      if (live) {
        live.ws = ws;
        registerAccountChar(live);
        players.delete(wallet);
      }
      walletToPlayer.delete(wallet);

      const characters = accountPreviews(wallet);
      const primary = characters[0];
      send(ws, {
        type: "auth/ok",
        wallet,
        hasCharacter: characters.length > 0,
        characters,
        character: primary,
        characterMint: cachedCharacterMint,
      });
    }).catch((err) => {
      // A throw after the signature check (for example a corrupt save read by
      // adoptOrphanLogs/createPlayer) used to be an unhandled rejection, which
      // terminates the whole Node process and drops every connected player.
      console.error("[bellgrave] auth handler failed", err);
      send(ws, { type: "error", message: "Login failed on the server. Nothing was changed; try again." });
    });
    return;
  }

  const wallet = (ws as WebSocket & { wallet?: string }).wallet;
  if (!wallet) {
    send(ws, { type: "error", message: "Authenticate first." });
    return;
  }

  if (msg.type === "char/nameCheck") {
    if (!isEthAddress(wallet)) {
      send(ws, {
        type: "char/nameCheck",
        available: false,
        error: "Authenticate with a signed wallet first.",
      });
      return;
    }
    const sock = ws as WebSocket & { authIp?: string };
    if (!consumeNameCheckBudget(wallet, sock.authIp)) {
      send(ws, {
        type: "char/nameCheck",
        available: false,
        error: "Too many name checks. Wait a moment.",
      });
      return;
    }
    const named = normalizeCharacterName(msg.name);
    if (!named.ok) {
      send(ws, { type: "char/nameCheck", available: false, error: named.error });
      return;
    }
    if (lok.nameTaken(named.name) || rosterNameTaken(named.name)) {
      send(ws, {
        type: "char/nameCheck",
        available: false,
        name: named.name,
        error: "That name is already on the log. Pick another.",
      });
      return;
    }
    send(ws, { type: "char/nameCheck", available: true, name: named.name });
    return;
  }

  if (msg.type === "char/create") {
    void (async () => {
      if (!isEthAddress(wallet)) {
        send(ws, { type: "error", message: "Authenticate with a signed wallet first." });
        return;
      }
      // L5: wait until mint config has loaded so we do not skip the fee gate.
      if (!mintConfigReady) {
        send(ws, {
          type: "error",
          message: "Character mint config is still loading. Try create again in a moment.",
        });
        return;
      }
      // M-B: factory/NFT env set but config failed to load — never create free.
      if (mintConfigLoadFailed) {
        send(ws, {
          type: "error",
          message:
            "Character mint config is unavailable (RPC or factory read failed). " +
            "Creates are blocked until it reloads. Try again in a moment.",
        });
        return;
      }
      const named = normalizeCharacterName(msg.name);
      if (!named.ok) {
        send(ws, { type: "error", message: named.error });
        return;
      }
      if (lok.nameTaken(named.name) || rosterNameTaken(named.name)) {
        send(ws, { type: "error", message: "That name is already on the log. Pick another." });
        return;
      }
      const capped = lok.ensureWalletCapacity(wallet);
      if (!capped.ok) {
        send(ws, { type: "error", message: capped.error });
        return;
      }
      const job = isJobId(msg.job) && JOBS[msg.job].playable ? msg.job : "time_mage";
      const jobIndex = JOB_IDS.indexOf(job);
      const gender =
        msg.gender === "female" ? "female" : msg.gender === "pepeka" ? "pepeka" : "male";

      // L6: only accept a client tokenId when mint is configured (verified on-chain).
      let bindToken: string | undefined;
      let acceptedWallets = [wallet.toLowerCase()];
      let pendingMintNonce: { mintWallet: string; nonce: string } | undefined;
      if (cachedCharacterMint) {
        bindToken =
          typeof msg.tokenId === "string" && /^[1-9][0-9]{0,77}$/.test(msg.tokenId)
            ? msg.tokenId
            : undefined;
        if (!bindToken) {
          send(ws, {
            type: "error",
            message:
              "Pay the character mint fee (native " +
              (cachedCharacterMint.currency?.symbol ?? settlementUnit()) +
              ") first, then create with the minted token id." +
              (cachedCharacterMint.devFaucet
                ? " Dev faucet is available (dev/faucet)."
                : " Set LOK_DEV_FAUCET=1 or LOK_DEV_SERVER_MINT=1 for local testing."),
          });
          return;
        }
        if (
          typeof msg.mintWallet === "string" &&
          msg.mintWallet.toLowerCase() !== wallet.toLowerCase()
        ) {
          // C-1: on Gnosis/Chiado the session wallet must be the NFT owner — no separate mint wallet.
          if (isProductionSettlementChain(process.env) || cachedCharacterMint.chainId === 100 || cachedCharacterMint.chainId === 10200) {
            send(ws, {
              type: "error",
              message:
                "On Gnosis/Chiado the wallet that pays the mint must be the same wallet that signs into the game. " +
                "Connect the NFT owner and try again.",
            });
            return;
          }
          if (typeof msg.mintChainId === "number" && msg.mintChainId !== cachedCharacterMint.chainId) {
            send(ws, { type: "error", message: "Mint claim chain id does not match this server." });
            return;
          }
          if (typeof msg.mintCharId === "string" && msg.mintCharId !== named.name) {
            send(ws, { type: "error", message: "Mint claim char id does not match the character name." });
            return;
          }
        }
        const wallets = await acceptedMintWallets({
          authWallet: wallet,
          mintWallet: typeof msg.mintWallet === "string" ? msg.mintWallet : undefined,
          tokenId: bindToken,
          chainId:
            typeof msg.mintChainId === "number"
              ? msg.mintChainId
              : cachedCharacterMint.chainId,
          charId: typeof msg.mintCharId === "string" ? msg.mintCharId : named.name,
          mintNonce: typeof msg.mintNonce === "string" ? msg.mintNonce : undefined,
          mintExpiry: typeof msg.mintExpiry === "number" ? msg.mintExpiry : undefined,
          mintSignature: typeof msg.mintSignature === "string" ? msg.mintSignature : undefined,
        });
        if (!wallets.ok) {
          send(ws, { type: "error", message: wallets.error });
          return;
        }
        acceptedWallets = wallets.wallets;
        pendingMintNonce = wallets.pendingNonce;
        const verified = await verifyCharacterNftOwner(bindToken, acceptedWallets);
        if (!verified.ok) {
          if (process.env.LOK_DEV_SERVER_MINT === "1") {
            if (!cachedCharacterMint.supportsCreateFor) {
              send(ws, {
                type: "error",
                message:
                  "LOK_DEV_SERVER_MINT needs createCharacterFor on the factory. " +
                  "This anvil factory predates that method — use the faucet + client createCharacter, " +
                  "or wait for the batched redeploy. " +
                  verified.error,
              });
              return;
            }
            const minted = await serverMintCharacterFor(
              bindToken,
              jobIndex < 0 ? 0 : jobIndex,
              acceptedWallets[0]!,
            );
            if (!minted.ok) {
              send(ws, { type: "error", message: verified.error + " " + minted.error });
              return;
            }
          } else {
            send(ws, { type: "error", message: verified.error });
            return;
          }
        }
      }

      // Resolve NFT owner before claiming the name so a wrong-wallet create cannot burn the name.
      let bindWallet = wallet.toLowerCase();
      if (bindToken) {
        const owned = await readCharacterNftOwner(bindToken);
        if (owned.ok) {
          const holder = owned.holder.toLowerCase();
          nftOwnerCache().set(bindToken, holder, 0);
          if (holder !== bindWallet) {
            send(ws, {
              type: "error",
              message:
                "Character NFT #" +
                bindToken +
                " is owned by " +
                holder +
                ". Sign in with that wallet to create.",
            });
            return;
          }
          bindWallet = holder;
        }
      }
      const charId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const claimed = lok.claimName(charId, named.name, bindWallet);
      if (!claimed.ok) {
        send(ws, { type: "error", message: claimed.error });
        return;
      }
      const spawned = lok.spawn(charId, claimed.name, jobIndex < 0 ? 0 : jobIndex, bindWallet, {
        ...(bindToken ? { tokenId: bindToken } : {}),
      });
      if (!spawned.ok) {
        send(ws, { type: "error", message: spawned.error });
        return;
      }
      if (bindWallet !== wallet.toLowerCase()) {
        lok.rebindWallet(charId, bindWallet);
      }
      // Consume mint-claim nonce only after a successful spawn (retry-safe on failure).
      if (pendingMintNonce) {
        consumeMintClaimNonce(pendingMintNonce.mintWallet, pendingMintNonce.nonce);
      }
      // Session must match the NFT owner — if bindWallet differs, refuse to enter as auth wallet.
      if (bindWallet !== wallet.toLowerCase()) {
        send(ws, {
          type: "error",
          message:
            "Character was bound to NFT owner " +
            bindWallet +
            ". Sign in with that wallet to play.",
        });
        return;
      }
      const p = createPlayer(wallet, claimed.name, ws, job, gender, charId);
      claimStarter(p);
      if (cachedCharacterMint) {
        void linkCharacterNftWithRetry(spawned.tokenId, jobIndex < 0 ? 0 : jobIndex, wallet, {
          acceptedWallets,
          attempts: 8,
          delayMs: 750,
        })
          .then((res) => {
            if (p.ws.readyState !== p.ws.OPEN) return;
            if (res.ok) {
              pushLog(p, "Linked character NFT #" + res.tokenId + " on the local checkpoint.");
            } else if (res.needsPlayerMint) {
              pushLog(
                p,
                "Pay the mint fee for NFT #" +
                  spawned.tokenId +
                  " from your wallet, then the link will retry. " +
                  res.error,
              );
            } else {
              pushLog(p, res.error);
            }
            send(p.ws, snapshotFor(p));
          })
          .catch((err) => console.error("[bellgrave] character NFT link failed", err));
      }
      pushLog(
        p,
        `${JOBS[job].name} created. At L${SUBJOB_UNLOCK_LEVEL}+ the Job Master sets a support job (half level).`,
      );
      send(ws, snapshotFor(p));
    })().catch((err) => {
      console.error("[bellgrave] char/create failed", err);
      send(ws, { type: "error", message: "Character create failed on the server." });
    });
    return;
  }

  if (msg.type === "dev/faucet") {
    // L7: only the caller's verified wallet; ignore client-supplied `to`.
    const to = wallet.toLowerCase();
    void faucetAnvilEth(to, process.env, { callerWallet: wallet }).then((res) => {
      if (res.ok) {
        send(ws, {
          type: "log",
          message: "Dev faucet sent " + (Number(res.amountWei) / 1e18).toFixed(4) + " ETH to " + to + ".",
        });
      } else if (!/disabled/i.test(res.error)) {
        send(ws, { type: "log", message: "Faucet: " + res.error });
      }
    });
    return;
  }

  if (msg.type === "char/enter") {
    let p: Player | undefined;
    if (msg.characterId) {
      p = activateCharacter(wallet, msg.characterId, ws);
      if (!p) {
        send(ws, { type: "error", message: "Character not found." });
        return;
      }
    } else {
      p = ensurePlayer(wallet, ws);
      if (!p) {
        const slots = accountRoster.get(wallet);
        const first = slots ? [...slots.values()][0] : undefined;
        if (first) p = activateCharacter(wallet, first.charId, ws);
      }
    }
    if (!p) {
      send(ws, { type: "error", message: "Create a character first." });
      return;
    }
    // #271: refuse enter when session wallet no longer owns the character NFT.
    const entered = p;
    void requireLiveCharacterOwner(entered).then((ok) => {
      if (!ok) return;
      pushLog(entered, "Welcome back to the Shard Dwellings.");
      send(entered.ws, snapshotFor(entered));
    });
    return;
  }

  const p = ensurePlayer(wallet, ws);
  if (!p) {
    send(ws, { type: "error", message: "Create a character first." });
    return;
  }

  // #274: live ownership gate for character-mutating play (after Transfer kick window).
  const needsOwnerGate =
    msg.type !== "move" &&
    msg.type !== "disengage" &&
    msg.type !== "lok/explore" &&
    !String(msg.type).startsWith("party/");
  const runPlayerMessage = () => {
  switch (msg.type) {
    case "claim/starter":
      claimStarter(p);
      break;
    case "move":
      // Manual move cancels engage so chase doesn't overwrite the click/WASD
      if (p.targetId) p.targetId = null;
      p.moveTo = clampPlayerMove(p.x, p.z, msg.x, msg.z);
      warnSoftGate(p, p.moveTo.z);
      break;
    case "gather":
      handleGather(p, msg.nodeId);
      break;
    case "craft":
      void handleCraft(p, msg.itemId).catch(() => failAction(p, "Craft"));
      break;
    case "engage": {
      const mob = findMob(msg.targetId);
      if (mob && mob.alive && !withinEngageRange(p.x, p.z, mob.x, mob.z)) {
        // #62: no pulling or hate on mobs across the map.
        pushLog(p, `${mob.name} is too far away to engage.`);
      } else if (mob && mob.alive) {
        stopRest(p, "You break rest to engage.");
        p.targetId = mob.id;
        pullMobOn(mob, p.wallet, Date.now());
        noteMobHit(mob, p.wallet);
        chaseEngaged(p);
        pushLog(
          p,
          dist(p.x, p.z, mob.x, mob.z) > MELEE_RANGE
            ? `Engaged ${mob.name} — closing in.`
            : `Engaged ${mob.name}.`,
        );
      } else if (msg.targetId === JOB_MASTER.id) {
        handleNpcInteract(p, JOB_MASTER.id);
      } else if (msg.targetId === TRAINER.id) {
        handleNpcInteract(p, TRAINER.id);
      }
      break;
    }
    case "disengage":
      p.targetId = null;
      break;
    case "ability":
      handleAbility(p, msg.id, msg.targetId);
      break;
    case "equip":
      handleEquip(p, msg.slot, msg.tokenId);
      break;
    case "item/use":
      stopRest(p);
      handleUseItem(p, msg.tokenId);
      break;
    case "item/discard":
      handleDiscard(p, msg.tokenId, !!msg.starter);
      break;
    case "npc/interact":
      handleNpcInteract(p, msg.npcId);
      break;
    case "job/change":
      handleJobChange(p, msg.job);
      break;
    case "job/subjob":
      handleSubjob(p, msg.job);
      break;
    case "spell/buy":
      void handleSpellBuy(p, msg.id).catch(() => failAction(p, "Ability buy"));
      break;
    case "debug/maxlevel":
      handleDebugMaxLevel(p);
      break;
    case "skill/unlock":
      handleSkillUnlock(p, msg.nodeId);
      break;
    case "skill/respec":
      handleSkillRespec(p);
      break;
    case "skill/freestat":
      handleFreeStat(p, msg.attr, msg.delta === -1 ? -1 : 1);
      break;
    case "party/invite":
      handlePartyInvite(p, msg.targetId);
      break;
    case "party/accept":
      handlePartyAccept(p);
      break;
    case "party/decline":
      handlePartyDecline(p);
      break;
    case "party/leave":
      handlePartyLeave(p);
      break;
    case "party/kick":
      handlePartyKick(p, msg.targetId);
      break;
    case "party/disband":
      handlePartyDisband(p);
      break;
    case "lok/import":
      handleLokImport(p, msg.tokenId, msg.amount);
      break;
    case "lok/export":
      handleLokExport(p, msg.tokenId, msg.amount);
      break;
    case "lok/sendItem":
      handleLokSendItem(p, msg.to, msg.tokenId, msg.amount);
      break;
    case "lok/sendKek":
      handleLokSendKek(p, msg.to, msg.amount);
      break;
    case "lok/withdrawKek":
      handleLokWithdrawKek(p, msg.amount);
      break;
    case "lok/deposit":
      handleLokDeposit(p, msg.amount);
      break;
    case "lok/claimKek":
      handleLokClaim(p, msg.id);
      break;
    case "lok/list":
      handleLokList(p, msg.tokenId, msg.amount, msg.minPrice, msg.sellerPayout);
      break;
    case "lok/bid":
      handleLokBid(p, msg.itemId, msg.amount);
      break;
    case "lok/buy":
      handleLokBuy(p, msg.itemId, msg.qty);
      break;
    case "lok/cancel":
      handleLokCancel(p, msg.listingId);
      break;
    case "lok/reclaim":
      handleLokReclaim(p, msg.listingId);
      break;
    case "lok/takeInbox":
      handleLokTakeInbox(p, msg.tokenId, msg.amount);
      break;
    case "lok/npcSell":
      handleLokNpcSell(p, msg.tokenId, msg.amount);
      break;
    case "lok/settle":
      handleLokSettle(p, msg.listingId);
      break;
    case "lok/explore":
      handleLokExplore(p, msg.scope, msg.q, msg.beforeSeq, msg.req);
      break;
    default:
      break;
  }
  };
  if (needsOwnerGate) {
    void requireLiveCharacterOwner(p).then((ok) => {
      if (ok) runPlayerMessage();
    });
    return;
  }
  runPlayerMessage();
}

const AUTH_ORIGINS = authAllowlist();
const OPS_STARTED_AT = Date.now();
const httpServer = createServer((req, res) => {
  if (
    handleOpsHttp(req, res, {
      lokReady: () => !!lok,
      startedAtMs: OPS_STARTED_AT,
    })
  ) {
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: WS_MAX_PAYLOAD,
  verifyClient: (info: { origin: string; req: import("node:http").IncomingMessage }) => {
    if (!authVerifyClient(info)) return false;
    const ip = clientAddress(info.req);
    if (wsIpExemptFromCaps(ip)) return true;
    const capped = noteWsConnect(ip);
    if (!capped.ok) return false;
    (info.req as { __wsIpCounted?: string }).__wsIpCounted = ip;
    return true;
  },
});
wss.on("connection", (ws, req) => {
  const sock = ws as WebSocket & {
    authConnId?: string;
    authDomain?: string;
    authIp?: string;
    authUri?: string;
    authDeadline?: ReturnType<typeof setTimeout>;
    wallet?: string;
  };
  const originHeader = req.headers.origin;
  const originValue = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  const origin = resolveAuthOrigin(originValue, AUTH_ORIGINS);
  if (!origin.ok) {
    ws.close(1008, "Origin");
    return;
  }
  sock.authConnId = randomBytes(8).toString("hex");
  sock.authDomain = origin.domain;
  sock.authUri = origin.origin;
  sock.authIp = clientAddress(req);
  const countedIp =
    (req as { __wsIpCounted?: string }).__wsIpCounted ??
    (wsIpExemptFromCaps(sock.authIp) ? "" : sock.authIp);
  sock.authDeadline = setTimeout(() => {
    if (!sock.wallet) {
      try {
        ws.close(4002, "auth timeout");
      } catch {
        /* ignore */
      }
    }
  }, WS_AUTH_DEADLINE_MS);
  sock.authDeadline.unref?.();
  ws.on("message", (buf) => {
    if (!consumeWsMessage(sock)) {
      try {
        ws.close(4029, "rate limit");
      } catch {
        /* ignore */
      }
      return;
    }
    onMessage(ws, buf.toString());
  });
  ws.on("close", () => {
    clearWsMessageBudget(sock);
    if (sock.authDeadline) clearTimeout(sock.authDeadline);
    if (countedIp) noteWsDisconnect(countedIp);
    if (sock.authConnId) dropAuthConnection(sock.authConnId);
    const wallet = sock.wallet;
    if (!wallet) return;
    const p = players.get(wallet);
    // Drop from the live interest set so peers stop rendering ghosts; roster keeps the char.
    if (p && p.ws === ws) {
      rememberPlayer(p);
      registerAccountChar(p);
      const affected = onPlayerDisconnect(wallet);
      players.delete(wallet);
      walletToPlayer.delete(wallet);
      for (const id of affected) {
        if (id === wallet.toLowerCase()) continue;
        const ally = players.get(id);
        if (ally) {
          pushLog(ally, `${p.name} left the party (disconnected).`);
          send(ally.ws, snapshotFor(ally));
        }
      }
    }
  });
});

setInterval(tickSim, TICK_MS);
const SAVE_INTERVAL_MS = 15_000;
setInterval(() => {
  for (const p of players.values()) rememberPlayer(p);
}, SAVE_INTERVAL_MS);
httpServer.listen(PORT, () => {
  console.log(`[bellgrave] game server on ws://localhost:${PORT}`);
  console.log(
    `[bellgrave] ops probes http://localhost:${PORT}/health|/ready|/status`,
  );
});