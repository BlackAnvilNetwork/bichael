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
  trainerAbilityDustCost,
  trainerOffersForJobs,
  canTrainAbility,
  isTrainerFreeAbility,
  aggregateSkillBonuses,
  attackFromStats,
  canUnlockSkillNode,
  combinedJobVitals,
  deriveCharacterAttributes,
  defenseFromVit,
  evasionFromAgi,
  critFromAgi,
  freeSkillHubs,
  freeStatsSpent,
  fStr,
  meleeFStr,
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
  cloneCraftSkills,
  craftXpForRecipe,
  craftXpToNext,
  emptyCraftSkills,
  emptyEquipment,
  getCraftableItem,
  EQUIP_SLOTS,
  getItem,
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
import {
  MOB_CAST_ANIM_MS,
  MOB_CAST_WINDUP_MS,
  mobAutoAttackRoll,
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
import { WebSocketServer, type WebSocket } from "ws";
import {
  clearKnightBuffs,
  resolveKnightAbility,
} from "./knight-abilities";
import { clearRogueBuffs, resolveRogueAbility } from "./rogue-abilities";
import {
  clearFighterBuffs,
  fighterAccBonus,
  fighterAttackMul,
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
import {
  absorbStoneskin,
  battleMageEnSpellBonus,
  clearBattleMageBuffs,
  resolveBattleMageAbility,
} from "./battlemage-abilities";
import { playerStance, resolveTimAbility } from "./tim-abilities";
import { loadLokEnv, startKekDepositWatcher } from "./lok-chain";
import {
  claimQueuedWithdrawal,
  depositKekOnchain,
  ensureLocalRuleset,
  linkCharacterNft,
  loadQueues,
  queueKekWithdrawal,
  queuesFor,
  readWithdrawDelay,
  vaultDelaySec,
  vaultWithdrawalMatches,
  withdrawalById,
} from "./lok-vault";
import { endClaim, guardedKekMove, guardedWithdraw, prepareClaim, readWithdrawIntents, reconcileWithdrawIntents, removeWithdrawIntent, reservedOf, upsertWithdrawIntent, withPlayerCharge, withdrawIntentPath, writeWithdrawIntents } from "./kek-guard";
import { characterNameKey, normalizeCharacterName } from "./character-name";
import { issueAuthChallenge, verifyAuthLogin, isEthAddress } from "./wallet-auth";
import { defaultLokDir, LokWorld } from "./lok-world";
import { readPlayerProgress, reconcileCharacterProgress, playerProgressPath, rememberLedger, chargeSkillRespec, RESPEC_KEK_COST, shouldChargeForAbility, type PlayerProgress } from "./player-progress";
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
  /** Prestige points after max level (0â€“100). */
  skillPrestige: number;
  freeStatPoints: number;
  freeStats: Record<AttrKey, number>;
  /** Knight tank buffs */
  bulwarkUntil: number;
  sentinelUntil: number;
  rampartUntil: number;
  coverUntil: number;
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
/** Dev cheats (Max Lv). Off unless ALLOW_DEBUG_CHEATS=1. Not implied by a dev NODE_ENV. */
const DEBUG_CHEATS_ENABLED = debugCheatsEnabled();
const players = new Map<string, Player>();
const walletToPlayer = new Map<string, string>();
/** Per-wallet character roster — live progress objects (same refs as active when online). */
const accountRoster = new Map<string, Map<string, Player>>();
/** Unlimited roster until onchain KEK mint gating. */
let tick = 0;
/** Pale Hollow Segment A field mobs. */
let mobs: Mob[] = spawnSegmentAPack();
let fieldNodes: FieldNode[] = createPaleHollowNodes();

async function reconcileQueuedWithdrawals(world: LokWorld): Promise<void> {
  const path = withdrawIntentPath(defaultLokDir());
  const intents = readWithdrawIntents(path);
  if (intents.length === 0) return;
  const left = await reconcileWithdrawIntents({
    intents,
    existsOnChain: (intent) =>
      intent.id ? vaultWithdrawalMatches(intent.id, intent.token, intent.amount) : false,
    debit: (token, amount) => world.withdrawKek(token, amount),
  });
  writeWithdrawIntents(path, left);
  console.log("[bellgrave] withdraw intents reconciled=" + (intents.length - left.length) + " still open=" + left.length);
}

const lok: LokWorld = await (async (): Promise<LokWorld> => {
  try {
    loadLokEnv();
    const world = LokWorld.open(defaultLokDir());
    console.log(
      "[bellgrave] lok log " + world.logPath + " entries=" + world.length + ". " + world.chainNote,
    );
    startKekDepositWatcher(world);
    loadQueues(defaultLokDir());
    await reconcileQueuedWithdrawals(world);
    const moved = reconcilePlayers(world);
    if (moved > 0) console.log("[bellgrave] moved " + moved + " log item stack(s) into character bags");
    void readWithdrawDelay().catch(() => {
      console.error("[bellgrave] withdraw delay read failed");
    });
    void ensureLocalRuleset().catch(() => {
      console.error("[bellgrave] ruleset check failed");
    });
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
      skillPoints: p.skillPoints,
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

function logLokCraft(p: Player, itemId: number, amount: number) {
  if (!Number.isInteger(itemId) || itemId <= 0 || amount <= 0) return;
  const token = lokToken(p);
  if (!token) return;
  const res = lok.craft(token, String(itemId), String(amount));
  if (!res.ok) pushLog(p, "Craft was not written to your log: " + res.error);
}

function logLokHarvest(p: Player, materialId: string, amount: number) {
  if (!materialId || amount <= 0) return;
  const token = lokToken(p);
  if (!token) return;
  const res = lok.harvest(token, materialId, String(amount));
  if (!res.ok) pushLog(p, "Gather was not written to your log: " + res.error);
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

function handleLokImport(p: Player, tokenId: number, amount: number) {
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
  const res = lok.itemDrop(token, String(tokenId), String(amount));
  if (!res.ok) {
    if (def && def.kind === "base") grantBaseMat(p, def.slug, amount);
    else addItem(p.inventory, tokenId, amount);
    rememberPlayer(p);
    pushLog(p, res.error);
    return;
  }
  pushLog(p, "Imported " + itemLabel(tokenId) + " x" + amount + " from your bag into the log.");
  send(p.ws, snapshotFor(p));
}

function handleLokExport(p: Player, tokenId: number, amount: number) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
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
  pushLog(
    p,
    "Exported " + itemLabel(tokenId) + " x" + amount + " to your bag. No chain withdrawal was submitted.",
  );
  send(p.ws, snapshotFor(p));
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
}

function handleLokSendKek(p: Player, to: string, amount: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  const dest = resolveSendTarget(p, to, token);
  if (!dest.ok) {
    pushLog(p, dest.error);
    return;
  }
  void guardedKekMove(token, () => {
    let free = 0n;
    let cost = 0n;
    try {
      free = BigInt(lok.kekOf(token)) - reservedOf(token);
      cost = BigInt(amount);
    } catch {
      pushLog(p, "Bad KEK amount. Nothing was sent.");
      send(p.ws, snapshotFor(p));
      return;
    }
    if (free < cost) {
      pushLog(p, "Need " + amount + " KEK (you have " + free.toString() + " spendable). Nothing was sent.");
      send(p.ws, snapshotFor(p));
      return;
    }
    const res = lok.sendKek(token, dest.tokenId, amount);
    if (!res.ok) pushLog(p, res.error);
    else {
      pushLog(p, "Sent " + amount + " KEK to " + dest.name + ".");
      tellToken(dest.tokenId, p.name + " sent you " + amount + " KEK.");
    }
    send(p.ws, snapshotFor(p));
  }).catch(() => failAction(p, "KEK send"));
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

function spendLogKek(p: Player, amount: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isSafeInteger(amount) || amount < 0) return Promise.resolve({ ok: false, error: "Bad KEK cost." });
  if (amount === 0) return Promise.resolve({ ok: true });
  const token = lokToken(p);
  if (!token) return Promise.resolve({ ok: false, error: "Could not open your log identity." });
  return guardedKekMove(token, () => {
    let bal: bigint;
    let cost: bigint;
    try {
      bal = BigInt(lok.kekOf(token)) - reservedOf(token);
      cost = BigInt(amount);
    } catch {
      return { ok: false, error: "Bad KEK balance." };
    }
    if (bal < cost) return { ok: false, error: "Need " + amount + " KEK (you have " + bal.toString() + ")." };
    return lok.spendKek(token, String(amount));
  });
}

function handleLokDeposit(p: Player, amount: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  void depositKekOnchain(token, amount).then((res) => {
    if (!res.ok) pushLog(p, res.error);
    else {
      pushLog(
        p,
        "Submitted a MockKEK deposit of " + amount + ". The watcher credits it when the nonce is applied. Nothing was minted.",
      );
    }
    send(p.ws, snapshotFor(p));
  }).catch(() => failAction(p, "KEK deposit"));
}

function handleLokWithdrawKek(p: Player, amount: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  void guardedWithdraw({
    token,
    amount,
    balanceOf: () => lok.kekOf(token),
    debit: () => lok.withdrawKek(token, amount),
    noteIntent: (intent) => upsertWithdrawIntent(withdrawIntentPath(defaultLokDir()), intent),
    clearIntent: () => removeWithdrawIntent(withdrawIntentPath(defaultLokDir()), token),
    queue: () =>
      queueKekWithdrawal(token, amount, process.env, undefined, {
        beforeSend: (id) => upsertWithdrawIntent(withdrawIntentPath(defaultLokDir()), { token, amount, id }),
      }),
    confirm: (id) => vaultWithdrawalMatches(id, token, amount),
  }).then((res) => {
    if (!res.ok) pushLog(p, res.error);
    else {
      const delay = vaultDelaySec();
      const wait = delay ? Math.round(delay / 3600) + "h" : "the vault delay";
      pushLog(
        p,
        "Queued vault withdrawal #" + res.id + " for " + amount + " KEK. It is not paid out before " + wait + ". That KEK was reserved before the vault call and debited once the queue existed.",
      );
    }
    send(p.ws, snapshotFor(p));
  }).catch(() => failAction(p, "KEK withdrawal"));
}

function handleLokClaim(p: Player, id: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  const row = withdrawalById(id);
  const gate = prepareClaim(token, row && row.status === "pending" ? row : undefined, Date.now());
  if (!gate.ok) {
    pushLog(p, gate.error);
    return;
  }
  void claimQueuedWithdrawal(id)
    .then((res) => {
      if (!res.ok) pushLog(p, res.error);
      else pushLog(p, "Claimed vault withdrawal #" + id + ". It was already debited from spendable KEK when it was queued.");
      send(p.ws, snapshotFor(p));
    })
    .catch(() => failAction(p, "KEK claim"))
    .finally(() => endClaim(token));
}

function handleLokList(p: Player, tokenId: number, amount: number, minPrice: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  if (!/^[1-9][0-9]{0,18}$/.test(minPrice)) {
    pushLog(p, "Enter a minimum price greater than 0. Nothing was listed.");
    return;
  }
  const listedAt = Math.floor(Date.now() / 1000);
  const res = lok.ask(token, String(tokenId), String(amount), minPrice, listedAt);
  if (!res.ok) {
    pushLog(p, res.error);
    return;
  }
  pushLog(
    p,
    "Listed " + itemLabel(tokenId) + " x" + amount + " as #" + res.listingId + " for at least " + minPrice + " KEK. The auction house is holding it.",
  );
  send(p.ws, snapshotFor(p));
}

function handleLokBid(p: Player, itemId: number, amount: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  void guardedKekMove(token, () => {
    let free = 0n;
    let cost = 0n;
    try {
      free = BigInt(lok.kekOf(token)) - reservedOf(token);
      cost = BigInt(amount);
    } catch {
      pushLog(p, "Bad KEK amount. Nothing was bid.");
      return;
    }
    if (free < cost) {
      pushLog(p, "Need " + amount + " KEK (you have " + free.toString() + " spendable). Nothing was bid.");
      return;
    }
    const res = lok.fill(token, String(itemId), amount);
    if (!res.ok) pushLog(p, res.error);
    else {
      pushLog(p, "Bought the lowest " + itemLabel(itemId) + " ask for " + amount + " KEK. It is in your Provisioner inbox.");
      if (res.seller && res.seller !== token) {
        tellToken(res.seller, "Your " + itemLabel(itemId) + " ask sold for " + amount + " KEK.");
      }
    }
    send(p.ws, snapshotFor(p));
  }).catch(() => failAction(p, "KEK bid"));
}

function handleLokCancel(p: Player, listingId: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  const row = lok.view(token).listings.find((l) => l.id === listingId);
  const res = lok.cancel(listingId, token);
  if (!res.ok) {
    pushLog(p, res.error);
    return;
  }
  pushLog(
    p,
    row?.book
      ? "Cancelled listing #" + listingId + ". The stack is in your Provisioner inbox."
      : "Cancelled listing #" + listingId + ". Escrow returned.",
  );
  send(p.ws, snapshotFor(p));
}

function handleLokReclaim(p: Player, listingId: string) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
    return;
  }
  const res = lok.reclaim(listingId, token, Math.floor(Date.now() / 1000));
  if (!res.ok) {
    pushLog(p, res.error);
    return;
  }
  pushLog(p, "Reclaimed listing #" + listingId + " into your Provisioner inbox.");
  send(p.ws, snapshotFor(p));
}

function handleLokTakeInbox(p: Player, tokenId: number, amount: number) {
  const token = lokToken(p);
  if (!token) {
    pushLog(p, "Could not open your log identity.");
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
      return guardedKekMove(token, () => {
        let bal: bigint;
        let cost: bigint;
        try {
          bal = BigInt(lok.kekOf(token)) - reservedOf(token);
          cost = BigInt(amount);
        } catch {
          return { ok: false, error: "Bad KEK balance." };
        }
        if (bal < cost) return { ok: false, error: "Need " + amount + " KEK (you have " + bal.toString() + ")." };
        return lok.paidRespecSkills(token, String(amount), nodeIds);
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
    else pushLog(p, "Respec paid " + RESPEC_KEK_COST + " KEK. The tree was cleared and the points were refunded.");
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
      tellToken(row.seller, "Listing #" + listingId + " settled for " + row.highBid + " KEK.");
    }
  }
  send(p.ws, snapshotFor(p));
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
      skillPoints: p.skillPoints,
      skillPrestige: p.skillPrestige,
      freeStatPoints: p.freeStatPoints,
      freeStats: { ...p.freeStats },
      lok: (() => {
        const view = lok.view(lokToken(p));
        return { ...view, withdrawDelaySec: vaultDelaySec(), queues: queuesFor(view.tokenId) };
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
}[] {
  const slots = accountRoster.get(wallet);
  if (!slots) return [];
  return [...slots.values()].map((p) => ({
    id: p.charId,
    name: p.name,
    job: p.job,
    level: p.level,
    gender: p.gender ?? "male",
  }));
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

function skillPointsRemaining(p: Player): number {
  ensureSkillPointBank(p);
  return Math.max(0, p.skillPoints);
}

/** Backfill bank for older sessions that only tracked level/spent. */
function ensureSkillPointBank(p: Player) {
  if (typeof p.skillPoints === "number" && Number.isFinite(p.skillPoints)) return;
  const spent = skillPointsSpentOnTree(p.skillUnlocked, p.job, p.subjob);
  p.skillPoints = Math.max(0, skillPointsEarned(p.level, p.skillPrestige) - spent);
}

function grantSkillPoints(p: Player, amount: number) {
  if (amount <= 0) return;
  ensureSkillPointBank(p);
  p.skillPoints += amount;
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

function playerHasJob(p: Player, job: JobId): boolean {
  return p.job === job || p.subjob === job;
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
  for (const recip of shareRecipients) {
    recip.dust += 25;
    const xpGain = Math.max(
      0,
      Math.min(200, Math.floor((200 * mob.level) / Math.max(1, recip.level))),
    );
    recip.xp += xpGain;
    tryLevelUp(recip);
    if (recip.wallet === p.wallet) killXp = xpGain;
    else pushLog(recip, `Party credit — ${mob.name} down. +25 Dust, +${xpGain} XP.`);
  }
  const dropNotes: string[] = [];
  for (const mat of mob.drops ?? []) {
    if (Math.random() < 0.65) {
      grantBaseMat(p, mat, 1);
      const def = CATALOG_BY_SLUG[mat];
      dropNotes.push(matDisplayName(mat));
    }
  }
  for (const rare of mob.rareDrops ?? []) {
    if (Math.random() < rare.chance) {
      const def = CATALOG_BY_SLUG[rare.slug];
      if (def) {
        addItem(p.inventory, def.id, 1);
        dropNotes.push(def.name);
      } else {
        grantBaseMat(p, rare.slug, 1);
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
      ? `${mob.name} defeated. +25 Dust, +${killXp} XP. Loot: ${dropNotes.join(", ")}.`
      : `${mob.name} defeated. +25 Dust, +${killXp} XP.`,
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
  const tree = 1 - playerTreeBonuses(p).physDt;
  // Bulwark — true physical immunity (bypass DT floor)
  if (now < p.bulwarkUntil) return 0;

  // Buff fields apply to whoever carries them (Rampart/Guardian/Protect party)
  let mul = 1;
  if (now < p.sentinelUntil) mul *= 0.5;
  if (now < p.coverUntil) mul *= 0.75;
  if (now < p.rampartUntil) mul *= 0.75;
  if (now < p.guardianUntil) mul *= 0.65;
  if (now < p.protectUntil) mul *= p.protectPhysMul;
  if (now < p.phalanxUntil) mul *= p.phalanxPhysMul;
  // Soft floor so Sentinel + Protect/Rampart/Guardian still stack (#49).
  // Was hard-capped at 0.5 which made further mitigation a no-op.
  return Math.max(0.15, mul * Math.max(0.7, tree));
}

/** Mana Wall — pay remaining damage with MP instead of HP. */
function absorbManaWall(p: Player, now: number, raw: number): { dmg: number; bled: number } {
  if (raw <= 0 || now >= p.manaWallUntil) return { dmg: raw, bled: 0 };
  const bled = Math.min(p.mp, raw);
  p.mp -= bled;
  return { dmg: Math.max(0, raw - bled), bled };
}

function playerWeaponBonus(p: Player): number {
  if (!p.equip.main) return 0;
  return playerEquipmentStats(p).atk ?? 10;
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
    resolveClericAbility(p as import("./cleric-abilities").ClericPlayer, id, targetId, now, {
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
      body: `Buy job abilities with deposited KEK (${jobNote}). Main: up to your level; support: up to floor(level/2). Costs scale 500-10000 by unlock level. Starter kit (Rest + L1 signature) is free. Dust is no longer the spend currency.`,
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
        "The camp ledger is here. Send or list what the log already holds. Items and KEK enter only from a custody nonce the server recorded — I cannot mint them, and this counter cannot.",
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
  const cost = trainerAbilityDustCost(unlockLevel);
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
    () => spendLogKek(p, cost),
    () => {
      logLokAbility(p, id);
      rememberPlayer(p);
      pushLog(p, "Learned " + abilityLabel(id) + " (-" + cost + " KEK).");
      send(p.ws, snapshotFor(p));
      handleNpcInteract(p, TRAINER.id);
    },
  );
  if (!charged.ok) {
    if (charged.error === "no longer available") {
      pushLog(p, "You already know " + abilityLabel(id) + ".");
    } else {
      pushLog(p, "Need " + cost + " KEK for " + abilityLabel(id) + ". " + charged.error);
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
  if (skillPointsRemaining(p) <= 0) {
    pushLog(p, "No skill points left. Level up or earn echoes after max level.");
    return;
  }
  p.skillPoints -= 1;
  p.skillUnlocked.push(nodeId);
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
  p.dust = Math.max(p.dust, 5000);
  // Leave skillPrestige alone — post-max echoes come from EXP.
  ensureMainHub(p);
  pushLog(
    p,
    from >= MAX_LEVEL
      ? `Debug: already L${MAX_LEVEL}. Learned ${added} Trainer abilit(ies). Dust ${p.dust}.`
      : `Debug: L${from} → L${MAX_LEVEL}. Learned ${added} Trainer abilit(ies). Dust ${p.dust}.`,
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
  // staff chip (meleeFStr floors the glance). Other jobs are full melee.
  const physical =
    p.job !== "time_mage" && p.job !== "sorcerer" && p.job !== "cleric";
  let att = attackFromStats(stats, stance, playerWeaponBonus(p), {
    physical: meleeUsesWeaponAttack(p.job),
  });
  const tree = playerTreeBonuses(p);
  att += tree.atk;
  if (physical) {
    att = Math.max(1, Math.floor(att * fighterAttackMul(p, now)));
  }
  const mobStats = jobStatsAtLevel(mob.job, mob.level);
  let def = defenseFromVit(mobStats.vit);
  if (now < mob.diaUntil) def = Math.max(1, Math.floor(def * 0.7));
  let acc = stats.dex + 40 + tree.acc + (playerEquipmentStats(p).acc ?? 0) - (now < mob.distractUntil ? mob.distractAcc : 0);
  if (physical && playerHasJob(p, "fighter")) acc += fighterAccBonus(p, now);
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
    meleeFStr(p.job, stats, mobStats.vit, stance),
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
}

/** Apply pending cast damage with the same absorbs as a live swing. */
function applyPendingMobDamage(mob: Mob, target: Player, now: number, rawDmg: number, hitLog: string) {
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
  dmg = Math.max(0, Math.floor(dmg * playerPhysDtMul(target, now)));
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
    applyPendingMobDamage(mob, target, now, dmg, log);
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
      const ang = mob.facing;
      mob.x += Math.sin(ang) * step;
      mob.z += Math.cos(ang) * step;
      const c = clampToHall(mob.x, mob.z);
      mob.x = c.x;
      mob.z = c.z;
      syncUnitY(mob);
      mob.anim = "walk";
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

  const defStats = playerCombatStats(nearest);
  const vitals = {
    vit: defStats.vit,
    agi: Math.max(0, defStats.agi - fighterEvaPenalty(nearest, now)),
  };

  const applyMobDamage = (rawDmg: number, hitLog: string) => {
    let dmg = rawDmg;
    if (nearest.zoneId === "pale_hollow") {
      const b = paleHollowBiome(mob.x, mob.z);
      if (mob.archetype === "pale_slime" && (b === "river" || b === "riverbank")) {
        dmg = Math.max(1, Math.floor(dmg * 1.25));
      }
      if (mob.archetype === "cliff_adder" && b === "vine_cliff") {
        dmg = Math.max(1, Math.floor(dmg * 1.15));
      }
    }
    dmg = Math.max(0, Math.floor(dmg * playerPhysDtMul(nearest, now)));
    dmg = absorbStoneskin(nearest, now, dmg);
    const beforeShield = nearest.healAbsorbHp;
    dmg = absorbHealShield(nearest, now, dmg);
    const soaked = Math.max(0, beforeShield - nearest.healAbsorbHp);
    dmg = Math.max(0, Math.floor(dmg * fighterDefenseMul(nearest, now)));
    const wall = absorbManaWall(nearest, now, dmg);
    dmg = wall.dmg;
    if (dmg <= 0) {
      pushLog(
        nearest,
        soaked > 0
          ? `${mob.name}'s blow is swallowed by your Solace shield!`
          : wall.bled > 0
            ? `${mob.name}'s blow bleeds ${wall.bled} MP through Mana Wall!`
            : `${mob.name}'s blow glances off your ward!`,
      );
      return;
    }
    if (now < mob.addleUntil) dmg = Math.max(1, Math.floor(dmg * 0.65));
    nearest.hp = Math.max(0, nearest.hp - dmg);
    if (nearest.miseryRite) {
      nearest.miseryEmpowerUntil = now + 15_000;
    }
    stopRest(nearest, `${mob.name}'s blow breaks your rest!`);
    const notes: string[] = [];
    if (soaked > 0) notes.push(`${soaked} absorbed`);
    if (wall.bled > 0) notes.push(`${wall.bled} MP`);
    if (now < mob.addleUntil) notes.push("Addled");
    const base = hitLog.endsWith(".") ? hitLog.slice(0, -1) : hitLog;
    pushLog(nearest, notes.length > 0 ? `${base} (${notes.join(", ")}).` : `${base}.`);
  };

  const ability = tryMobJobAbility(mob, {
    now,
    dist: d,
    player: nearest,
    vitals,
    pushLog: (msg) => pushLog(nearest, msg),
    applyPlayerDamage: (raw, note) => applyMobDamage(raw, note),
  });

  if (ability.ok) {
    if (ability.pending) scheduleMobPendingCast(mob, now, nearest.wallet, ability.pending);
  } else {
    const swingSlow = now < mob.slowUntil ? mob.swingPenalty : 0;
    mob.nextSwingAt = now + swingDelayMs(2400, -swingSlow);
    const roll = mobAutoAttackRoll(mob, vitals, now);
    mob.anim = roll.anim;
    if (roll.anim === "cast") {
      // Magic auto — cast anim + circle first; damage (or miss) after wind-up.
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      if (!roll.hit) {
        scheduleMobPendingCast(mob, now, nearest.wallet, {
          type: "miss",
          log: `${mob.name} misses you.`,
        });
      } else {
        scheduleMobPendingCast(mob, now, nearest.wallet, {
          type: "damage",
          dmg: roll.dmg,
          log: `${mob.name} strikes you with magic for ${roll.dmg}.`,
        });
      }
    } else {
      mob.animUntil = now + 480;
      if (!roll.hit) {
        pushLog(nearest, `${mob.name} misses you.`);
        return;
      }
      applyMobDamage(roll.dmg, `${mob.name} hits you for ${roll.dmg}`);
    }
  }

  if (nearest.hp <= 0) {
    if (now < nearest.reraiseUntil) {
      nearest.reraiseUntil = 0;
      nearest.hp = Math.max(1, Math.floor(nearest.maxHp * 0.25));
      nearest.sacredLightUntil = now + 2200;
      pushLog(nearest, "Ember Vigil — you rise in sacred light!");
    } else {
      const killer = mob;
      respawnAtHub(nearest);
      if (killer.shiny && !killer.shinyClone) {
        shinyFleeAfterPlayerKill(killer, now);
        pushLog(nearest, killer.name + " flees into the Hollow...");
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
        let credited: Player | null = null;
        for (const p of players.values()) {
          if (p.targetId === mob.id) {
            credited = p;
            break;
          }
        }
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
  const d = dist(p.x, p.z, node.x, node.z);
  if (d > 3.2) {
    pushLog(p, "Move closer to gather.");
    p.moveTo = clampPlayerMove(p.x, p.z, node.x, node.z);
    return;
  }
  const now = Date.now();
  if (now < node.readyAt) {
    pushLog(p, `${node.name} is depleted — wait for regrowth.`);
    return;
  }
  stopRest(p, "You break rest to gather.");
  p.targetId = null;
  p.moveTo = null;
  p.facing = facingTo(p.x, p.z, node.x, node.z);
  p.anim = "cast";
  p.animUntil = now + Math.min(node.interactMs, 1200);
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
  const kekCost = def.recipe?.kek ?? 0;
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
    () => spendLogKek(p, kekCost),
    () => {
      if (def.kind === "base") grantBaseMat(p, def.slug, 1);
      else addItem(p.inventory, def.id, 1);
      logLokCraft(p, def.id, 1);
      const prevLv = p.craftSkills[skill]?.level ?? 1;
      grantCraftXp(p, skill, craftXpForRecipe(def.craftLevel ?? skillLv, skillLv));
      const nextLv = p.craftSkills[skill]?.level ?? prevLv;
      const levelNote = nextLv > prevLv ? " " + skill + " rose to " + nextLv + "!" : "";
      rememberPlayer(p);
      pushLog(p, "Crafted " + def.name + "." + levelNote);
      send(p.ws, snapshotFor(p));
    },
  );
  if (!charged.ok) {
    if (charged.error === "no longer available") {
      const preview = recipeMaterials(def);
      if (preview.length === 0) pushLog(p, "Recipe materials unknown.");
      else pushLog(p, "Need materials: " + preview.map((m) => m.name + " x" + m.qty).join(", ") + ".");
    } else {
      pushLog(p, "Need " + kekCost + " KEK to craft " + def.name + ". " + charged.error);
    }
  }
}

function adoptOrphanLogs(wallet: string, ws: WebSocket) {
  const owner = wallet.toLowerCase();
  const owned = lok.charsForWallet(owner);
  if (owned.length === 0) return;
  const taken = new Set<string>();
  for (const slots of accountRoster.values()) {
    for (const id of slots.keys()) taken.add(id);
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
    const renamed = (crowded ? row.name + " #" + row.tokenId : row.name).slice(0, 16);
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
    const challenged = issueAuthChallenge(msg.wallet);
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
    void verifyAuthLogin({
      wallet: msg.wallet,
      signature: msg.signature,
      nonce: msg.nonce,
      message: msg.message,
    }).then((verified) => {
      if (!verified.ok) {
        send(ws, { type: "error", message: verified.error });
        return;
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
      });
    });
    return;
  }

  const wallet = (ws as WebSocket & { wallet?: string }).wallet;
  if (!wallet) {
    send(ws, { type: "error", message: "Authenticate first." });
    return;
  }

  if (msg.type === "char/create") {
    if (!isEthAddress(wallet)) {
      send(ws, { type: "error", message: "Authenticate with a signed wallet first." });
      return;
    }
    const named = normalizeCharacterName(msg.name);
    if (!named.ok) {
      send(ws, { type: "error", message: named.error });
      return;
    }
    if (rosterNameTaken(named.name)) {
      send(ws, { type: "error", message: "That name is already on the log. Pick another." });
      return;
    }
    const capped = lok.ensureWalletCapacity(wallet);
    if (!capped.ok) {
      send(ws, { type: "error", message: capped.error });
      return;
    }
    const charId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const claimed = lok.claimName(charId, named.name, wallet);
    if (!claimed.ok) {
      send(ws, { type: "error", message: claimed.error });
      return;
    }
    const job = isJobId(msg.job) && JOBS[msg.job].playable ? msg.job : "time_mage";
    const gender =
      msg.gender === "female" ? "female" : msg.gender === "pepeka" ? "pepeka" : "male";
    const p = createPlayer(wallet, claimed.name, ws, job, gender, charId);
    claimStarter(p);
    const minted = lok.tokenFor(p.charId);
    if (minted) {
      void linkCharacterNft(minted, JOB_IDS.indexOf(job)).then((res) => {
        if (p.ws.readyState !== p.ws.OPEN) return;
        pushLog(p, res.ok ? "Linked character NFT #" + res.tokenId + " on the local checkpoint." : res.error);
        send(p.ws, snapshotFor(p));
      });
    }
    pushLog(
      p,
      `${JOBS[job].name} created. At L${SUBJOB_UNLOCK_LEVEL}+ the Job Master sets a support job (half level).`,
    );
    send(ws, snapshotFor(p));
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
    pushLog(p, "Welcome back to the Shard Dwellings.");
    send(p.ws, snapshotFor(p));
    return;
  }

  const p = ensurePlayer(wallet, ws);
  if (!p) {
    send(ws, { type: "error", message: "Create a character first." });
    return;
  }

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
      if (mob && mob.alive) {
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
      handleLokList(p, msg.tokenId, msg.amount, msg.minPrice);
      break;
    case "lok/bid":
      handleLokBid(p, msg.itemId, msg.amount);
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
    case "lok/settle":
      handleLokSettle(p, msg.listingId);
      break;
    case "lok/explore":
      handleLokExplore(p, msg.scope, msg.q, msg.beforeSeq, msg.req);
      break;
    default:
      break;
  }
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  ws.on("message", (buf) => onMessage(ws, buf.toString()));
  ws.on("close", () => {
    const wallet = (ws as WebSocket & { wallet?: string }).wallet;
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
console.log(`[bellgrave] game server on ws://localhost:${PORT}`);