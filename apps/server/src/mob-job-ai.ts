/**
 * Enemy job AI — Pale Hollow mobs share player JobIds.
 * NPC-safe stubs: job drives engage range, auto-attack stats, and occasional
 * ability picks (not full player kit resolvers).
 */
import {
  JOB_WEAPON,
  attackFromStats,
  defenseFromVit,
  evasionFromAgi,
  fStr,
  hitChance,
  jobStatsAtLevel,
  jobVitalsAtLevel,
  magicDefenseFromMnd,
  meleeFStr,
  physicalDamage,
  swingDelayMs,
  type JobId,
  type Stats,
} from "@bellgrave/combat";
import {
  ABILITY_RANGE,
  MELEE_RANGE,
  paleHollowMobJob,
  type PaleHollowArchetype,
  type PaleHollowMobJob,
} from "@bellgrave/config";
import { rollIndex, rollUnit } from "./game-roll";

export type MobJobCombatant = {
  id: string;
  name: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  job: JobId;
  level: number;
  archetype: string;
  anim: string;
  animUntil: number;
  nextSwingAt: number;
  nextAbilityAt: number;
  atkBuffUntil: number;
  atkBuffMul: number;
  protectUntil?: number;
  protectPhysMul?: number;
  shellUntil?: number;
  shellMagMul?: number;
  hasteUntil?: number;
  hastePct?: number;
  stoneskinUntil?: number;
  stoneskinAbsorb?: number;
  atkDownUntil: number;
  atkDownMul: number;
  addleUntil: number;
  silenceUntil: number;
  slowUntil: number;
  swingPenalty: number;
};

/** Live player ref — abilities may write CC fields. */
export type MobJobPlayer = {
  wallet: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  slowUntil: number;
  moveUntil: number;
  movePct: number;
  blindUntil: number;
};

export type MobJobVitals = {
  vit: number;
  agi: number;
  /** Total physical defense (VIT + gear def). Falls back to VIT only. */
  def?: number;
};

/** Defense a mob's physical hit is rolled against (#52: includes gear def). */
export function targetPhysDef(v: MobJobVitals): number {
  return typeof v.def === "number" && Number.isFinite(v.def)
    ? Math.max(1, Math.floor(v.def))
    : defenseFromVit(v.vit);
}

/** Re-export helper for spawn path. */
export function resolveMobJob(
  archetype: PaleHollowArchetype | string,
  job?: PaleHollowMobJob | JobId | null,
): JobId {
  return paleHollowMobJob({
    archetype: archetype as PaleHollowArchetype,
    job: (job ?? undefined) as PaleHollowMobJob | undefined,
  }) as JobId;
}

/** Soft MP pool from job grades — keeps authored HP intact. */
export function mobMpForJob(job: JobId, level: number): { mp: number; maxMp: number } {
  const v = jobVitalsAtLevel(job, level);
  if (v.maxMp <= 0) return { mp: 0, maxMp: 0 };
  const maxMp = Math.max(16, Math.floor(v.maxMp * 0.55));
  return { mp: maxMp, maxMp };
}

export function mobCombatStats(job: JobId, level: number): Stats {
  return jobStatsAtLevel(job, Math.max(1, level));
}

/** Preferred stop distance before attacking. Casters kite; melee close in. */
export function mobEngageRange(job: JobId): number {
  if (job === "sorcerer" || job === "time_mage") return Math.min(ABILITY_RANGE - 1.5, 9.5);
  if (job === "cleric") return 7.5;
  if (job === "battle_mage") return 5.2;
  return MELEE_RANGE + 0.35;
}

export function mobUsesMagicAuto(job: JobId): boolean {
  return job === "sorcerer" || job === "cleric" || job === "time_mage";
}

/** Jobs that pick a spell target instead of sticking to whoever is closest. */
export function mobCastsSpells(job: JobId): boolean {
  return mobUsesMagicAuto(job) || job === "battle_mage";
}

/** Innate magic defense a mob consults when a player spell lands. */
export function mobMagicDefense(job: JobId, level: number): number {
  return magicDefenseFromMnd(jobStatsAtLevel(job, level).mnd);
}

export function mobWeaponBonus(job: JobId): number {
  return JOB_WEAPON[job] === "staff" ? 5 : 7;
}

export type MobAbilityId =
  | "mob_power_strike"
  | "mob_ember_bolt"
  | "mob_cinder_burst"
  | "mob_berserk"
  | "mob_slow"
  | "mob_mend"
  | "mob_shield_bash"
  | "mob_backstab"
  | "mob_arc_blade"
  | "mob_protect"
  | "mob_shell"
  | "mob_haste"
  | "mob_stoneskin";

/** Cinder Burst splash radius (world units). Modest — inside cast range. */
export const MOB_CINDER_RADIUS = 5.2;

type AbilityPick = {
  id: MobAbilityId;
  label: string;
  mp: number;
  recastMs: number;
  /** Prefer casting when distance >= this (0 = melee ok). */
  minRange: number;
  maxRange: number;
};

const JOB_ABILITIES: Record<JobId, AbilityPick[]> = {
  fighter: [
    { id: "mob_berserk", label: "Berserk", mp: 0, recastMs: 18_000, minRange: 0, maxRange: 14 },
    { id: "mob_power_strike", label: "Power Strike", mp: 0, recastMs: 7_000, minRange: 0, maxRange: MELEE_RANGE + 0.6 },
  ],
  knight: [
    { id: "mob_protect", label: "Protect", mp: 0, recastMs: 18_000, minRange: 0, maxRange: 14 },
    { id: "mob_shield_bash", label: "Shield Bash", mp: 0, recastMs: 10_000, minRange: 0, maxRange: MELEE_RANGE + 0.6 },
    { id: "mob_power_strike", label: "Shield Smash", mp: 0, recastMs: 8_000, minRange: 0, maxRange: MELEE_RANGE + 0.6 },
  ],
  rogue: [
    { id: "mob_backstab", label: "Backstab", mp: 0, recastMs: 9_000, minRange: 0, maxRange: MELEE_RANGE + 0.5 },
  ],
  sorcerer: [
    { id: "mob_shell", label: "Shell", mp: 12, recastMs: 18_000, minRange: 0, maxRange: ABILITY_RANGE },
    { id: "mob_cinder_burst", label: "Cinder Burst", mp: 14, recastMs: 16_000, minRange: 0, maxRange: ABILITY_RANGE },
    { id: "mob_ember_bolt", label: "Ember Lance", mp: 8, recastMs: 5_500, minRange: 0, maxRange: ABILITY_RANGE },
  ],
  cleric: [
    { id: "mob_protect", label: "Protect", mp: 12, recastMs: 18_000, minRange: 0, maxRange: 14 },
    { id: "mob_mend", label: "Ashmend", mp: 10, recastMs: 12_000, minRange: 0, maxRange: 14 },
    { id: "mob_ember_bolt", label: "Sacred Bolt", mp: 8, recastMs: 6_500, minRange: 0, maxRange: ABILITY_RANGE },
  ],
  time_mage: [
    { id: "mob_haste", label: "Haste", mp: 10, recastMs: 18_000, minRange: 0, maxRange: ABILITY_RANGE },
    { id: "mob_slow", label: "Slow", mp: 10, recastMs: 14_000, minRange: 0, maxRange: ABILITY_RANGE },
    { id: "mob_ember_bolt", label: "Chrono Spark", mp: 8, recastMs: 6_000, minRange: 0, maxRange: ABILITY_RANGE },
  ],
  battle_mage: [
    { id: "mob_stoneskin", label: "Stoneskin", mp: 14, recastMs: 18_000, minRange: 0, maxRange: ABILITY_RANGE },
    { id: "mob_arc_blade", label: "Arc Blade", mp: 6, recastMs: 7_000, minRange: 0, maxRange: MELEE_RANGE + 1.2 },
    { id: "mob_ember_bolt", label: "Rune Bolt", mp: 8, recastMs: 6_500, minRange: 2.5, maxRange: ABILITY_RANGE },
  ],
};

const SELF_BUFFS: ReadonlySet<MobAbilityId> = new Set([
  "mob_protect",
  "mob_shell",
  "mob_haste",
  "mob_stoneskin",
  "mob_berserk",
]);

function selfBuffUp(mob: MobJobCombatant, id: MobAbilityId, now: number): boolean {
  switch (id) {
    case "mob_protect":
      return (mob.protectUntil ?? 0) > now;
    case "mob_shell":
      return (mob.shellUntil ?? 0) > now;
    case "mob_haste":
      return (mob.hasteUntil ?? 0) > now;
    case "mob_stoneskin":
      return (mob.stoneskinUntil ?? 0) > now && (mob.stoneskinAbsorb ?? 0) > 0;
    case "mob_berserk":
      return mob.atkBuffUntil > now;
    default:
      return false;
  }
}

function pace(mob: MobJobCombatant, now: number, baseMs: number): void {
  const haste = (mob.hasteUntil ?? 0) > now ? mob.hastePct ?? 0 : 0;
  mob.nextSwingAt = now + swingDelayMs(baseMs, haste);
}

/** Cast tell duration before damage / Slow resolve (ms). */
export const MOB_CAST_WINDUP_MS = 550;
/** Full cast anim window — covers wind-up + resolve flash. */
export const MOB_CAST_ANIM_MS = 1000;

/** `magic` routes the resolved hit through the target's mag DT, not phys DT (#55). */
export type PendingMobCastResolve =
  | { type: "damage"; dmg: number; log: string; magic?: boolean }
  | { type: "aoe"; dmg: number; radius: number; log: string; magic: true }
  | { type: "slow"; durationMs: number; movePct: number; log: string }
  | { type: "miss"; log: string; magic?: boolean };

export type MobAbilityResult =
  | { ok: false }
  | { ok: true; pending?: PendingMobCastResolve };

export type MobAbilityHooks = {
  now: number;
  dist: number;
  player: MobJobPlayer;
  vitals: MobJobVitals;
  pushLog: (msg: string) => void;
  applyPlayerDamage: (dmg: number, note: string) => void;
  /** Living players standing in Cinder Burst range of the focus. 1 = solo. */
  nearby?: number;
};

/**
 * Try a job ability. Returns true if it consumed the swing/cast slot
 * (caller should skip auto-attack).
 */
export function tryMobJobAbility(mob: MobJobCombatant, hooks: MobAbilityHooks): MobAbilityResult {
  const { now, dist, player, vitals, pushLog, applyPlayerDamage } = hooks;
  if (now < (mob.nextAbilityAt ?? 0)) return { ok: false };
  // ~35% chance each ready swing to spend an ability instead of auto
  if (rollUnit("mob.ai.spend") > 0.38) return { ok: false };

  const picks = JOB_ABILITIES[mob.job] ?? [];
  const silenced = now < mob.silenceUntil;
  const packed = (hooks.nearby ?? 1) >= 2;
  // Spells are muted; melee JAs / Berserk still fire.
  const CAST_IDS: ReadonlySet<MobAbilityId> = new Set([
    "mob_ember_bolt",
    "mob_cinder_burst",
    "mob_slow",
    "mob_mend",
    "mob_protect",
    "mob_shell",
    "mob_haste",
    "mob_stoneskin",
  ]);
  const ready = picks.filter(
    (a) =>
      dist >= a.minRange &&
      dist <= a.maxRange &&
      mob.mp >= a.mp &&
      !selfBuffUp(mob, a.id, now) &&
      !(silenced && CAST_IDS.has(a.id)) &&
      !(a.id === "mob_cinder_burst" && !packed),
  );
  if (ready.length === 0) return { ok: false };
  // Prefer self-heal when hurt
  let choice = ready[rollIndex("mob.ai.pick", ready.length)]!;
  if (mob.hp < mob.maxHp * 0.45) {
    const mend = ready.find((a) => a.id === "mob_mend");
    if (mend) choice = mend;
  } else if (mob.hp >= mob.maxHp * 0.7) {
    const ward = ready.find((a) => SELF_BUFFS.has(a.id));
    if (ward) choice = ward;
  }
  if (packed && !SELF_BUFFS.has(choice.id) && choice.id !== "mob_mend") {
    const burst = ready.find((a) => a.id === "mob_cinder_burst");
    if (burst) choice = burst;
  }

  mob.mp = Math.max(0, mob.mp - choice.mp);
  mob.nextAbilityAt = now + choice.recastMs;
  const stats = mobCombatStats(mob.job, mob.level);
  const atkMul = now < mob.atkBuffUntil ? mob.atkBuffMul || 1 : 1;
  const downMul = now < mob.atkDownUntil ? mob.atkDownMul || 1 : 1;

  switch (choice.id) {
    case "mob_berserk": {
      mob.atkBuffUntil = now + 12_000;
      mob.atkBuffMul = 1.35;
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 900);
      pushLog(`${mob.name} flies into a Berserk rage!`);
      return { ok: true };
    }
    case "mob_protect": {
      mob.protectUntil = now + 20_000;
      mob.protectPhysMul = 0.75;
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 1100);
      pushLog(`${mob.name} casts Protect.`);
      return { ok: true };
    }
    case "mob_shell": {
      mob.shellUntil = now + 20_000;
      mob.shellMagMul = 0.75;
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 1100);
      pushLog(`${mob.name} casts Shell.`);
      return { ok: true };
    }
    case "mob_haste": {
      mob.hasteUntil = now + 20_000;
      mob.hastePct = 0.25;
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 1100);
      pushLog(`${mob.name} casts Haste.`);
      return { ok: true };
    }
    case "mob_stoneskin": {
      mob.stoneskinUntil = now + 24_000;
      mob.stoneskinAbsorb = Math.max(16, mob.level * 3);
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 1100);
      pushLog(`${mob.name} casts Stoneskin.`);
      return { ok: true };
    }
    case "mob_mend": {
      const heal = Math.max(8, Math.floor(mob.maxHp * 0.18 + stats.mnd * 1.2));
      mob.hp = Math.min(mob.maxHp, mob.hp + heal);
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 1100);
      pushLog(`${mob.name} mends for ${heal} HP.`);
      return { ok: true };
    }
    case "mob_slow": {
      // Wind-up first — Slow resolves after MOB_CAST_WINDUP_MS so the tell leads.
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 2200);
      return {
        ok: true,
        pending: {
          type: "slow",
          durationMs: 8_000,
          movePct: -0.22,
          log: `${mob.name} casts Slow — your tempo drags!`,
        },
      };
    }
    case "mob_shield_bash": {
      const att = Math.max(1, Math.floor(attackFromStats(stats, false, mobWeaponBonus(mob.job), { physical: true }) * atkMul * downMul));
      const def = targetPhysDef(vitals);
      let dmg = physicalDamage(att, def, fStr(stats.str, vitals.vit), false);
      dmg = Math.max(1, Math.floor(dmg * 1.15));
      if (rollUnit("mob.ai.bash-daze") < 0.4) {
        player.blindUntil = Math.max(player.blindUntil, now + 1600);
        pushLog(`${mob.name}'s Shield Bash dazes you!`);
      }
      mob.anim = "melee";
      mob.animUntil = now + 480;
      pace(mob, now, 2600);
      applyPlayerDamage(dmg, `${mob.name} Shield Bashes you for ${dmg}.`);
      return { ok: true };
    }
    case "mob_backstab": {
      const att = Math.max(1, Math.floor(attackFromStats(stats, false, mobWeaponBonus(mob.job), { physical: true }) * atkMul * downMul));
      const def = targetPhysDef(vitals);
      const crit = rollUnit("mob.ai.backstab-crit") < 0.55;
      let dmg = physicalDamage(att, def, meleeFStr("rogue", stats, vitals.vit, "none"), crit);
      dmg = Math.max(1, Math.floor(dmg * (crit ? 1.4 : 1.15)));
      mob.anim = "melee";
      mob.animUntil = now + 420;
      pace(mob, now, 2200);
      applyPlayerDamage(dmg, crit ? `${mob.name} Backstabs you for ${dmg} (Critical)!` : `${mob.name} Backstabs you for ${dmg}.`);
      return { ok: true };
    }
    case "mob_power_strike": {
      const att = Math.max(1, Math.floor(attackFromStats(stats, false, mobWeaponBonus(mob.job) + 2, { physical: true }) * atkMul * downMul));
      const def = targetPhysDef(vitals);
      let dmg = physicalDamage(att, def, fStr(stats.str, vitals.vit), false);
      dmg = Math.max(1, Math.floor(dmg * 1.3));
      mob.anim = "melee";
      mob.animUntil = now + 500;
      pace(mob, now, 2500);
      applyPlayerDamage(dmg, `${mob.name} uses ${choice.label} for ${dmg}.`);
      return { ok: true };
    }
    case "mob_arc_blade": {
      const att = Math.max(
        1,
        Math.floor(
          (attackFromStats(stats, false, mobWeaponBonus(mob.job), { physical: true }) + stats.int * 0.35) *
            atkMul *
            downMul,
        ),
      );
      const def = targetPhysDef(vitals);
      let dmg = physicalDamage(att, def, fStr(stats.str, vitals.vit), false);
      dmg = Math.max(1, Math.floor(dmg * 1.2));
      mob.anim = "melee";
      mob.animUntil = now + 460;
      pace(mob, now, 2300);
      applyPlayerDamage(dmg, `${mob.name}'s Arc Blade hits for ${dmg}.`);
      return { ok: true };
    }
    case "mob_ember_bolt": {
      // Raw spell power. MND/MDB resistance is applied when the hit lands.
      const power = Math.max(1, Math.floor((stats.int * 1.4 + stats.mnd * 0.4 + mob.level * 1.5) * atkMul * downMul));
      const dmg = Math.max(1, power + 6);
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 2400);
      return {
        ok: true,
        pending: {
          type: "damage",
          dmg,
          log: `${mob.name} casts ${choice.label} for ${dmg}.`,
          magic: true,
        },
      };
    }
    case "mob_cinder_burst": {
      // Modest ember AoE — less than the lance, splashes anyone on the focus.
      const power = Math.max(1, Math.floor((stats.int * 1.05 + stats.mnd * 0.25 + mob.level) * atkMul * downMul));
      const dmg = Math.max(1, power + 4);
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      pace(mob, now, 2600);
      return {
        ok: true,
        pending: {
          type: "aoe",
          dmg,
          radius: MOB_CINDER_RADIUS,
          log: `${mob.name} casts Cinder Burst for ${dmg}.`,
          magic: true,
        },
      };
    }
    default:
      return { ok: false };
  }
}

/** True when this mob's next auto-attack is a magic auto (caster job, not silenced). */
export function mobAutoIsMagic(
  mob: Pick<MobJobCombatant, "job" | "silenceUntil">,
  now: number,
): boolean {
  return mobUsesMagicAuto(mob.job) && !(now < mob.silenceUntil);
}

/** Auto-attack numbers for the given job (replaces flat GUARD_L1). */
export function mobAutoAttackRoll(
  mob: MobJobCombatant,
  target: MobJobVitals,
  now: number,
): { hit: boolean; dmg: number; anim: "melee" | "cast" } {
  const stats = mobCombatStats(mob.job, mob.level);
  // Silenced casters still swing — mute magic autos only.
  const magic = mobAutoIsMagic(mob, now);
  const atkMul = (now < mob.atkBuffUntil ? mob.atkBuffMul || 1 : 1) * (now < mob.atkDownUntil ? mob.atkDownMul || 1 : 1);
  const mobAcc = stats.dex + 40;
  const playerEva = evasionFromAgi(target.agi);
  if (rollUnit("mob.ai.auto-hit") > hitChance(mobAcc, playerEva)) {
    return { hit: false, dmg: 0, anim: magic ? "cast" : "melee" };
  }
  if (magic) {
    // Raw magic auto. Resistance is applied on resolve, not baked in here.
    const power = Math.max(1, Math.floor((stats.int * 1.15 + stats.mnd * 0.35 + 4) * atkMul));
    return { hit: true, dmg: Math.max(1, power), anim: "cast" };
  }
  const att = Math.max(
    1,
    Math.floor(attackFromStats(stats, false, mobWeaponBonus(mob.job), { physical: true }) * atkMul),
  );
  const def = targetPhysDef(target);
  let dmg = physicalDamage(att, def, meleeFStr(mob.job, stats, target.vit, "none"), false);
  return { hit: true, dmg, anim: "melee" };
}

/** Melee stickiness. Casters use a smaller one so they can look past the tank. */
export const MELEE_FOCUS_STICK = 8;
export const CASTER_FOCUS_STICK = 3;
export const MELEE_HATE_WEIGHT = 0.02;
export const CASTER_HATE_WEIGHT = 0.012;
export const CASTER_WOUND_WEIGHT = 8;
export const CASTER_BACKLINE_BONUS = 4.5;
export const CASTER_TANK_PENALTY = 3;

const CASTER_BACKLINE: ReadonlySet<string> = new Set(["cleric", "sorcerer", "time_mage"]);

export type MobFocusCandidate = {
  id: string;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  enmity: number;
  job: string;
};

export type MobFocusMob = {
  x: number;
  z: number;
  job: JobId;
  targetId: string | null;
};

function woundFraction(c: MobFocusCandidate): number {
  if (!(c.maxHp > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - c.hp / c.maxHp));
}

/**
 * Who this mob is fighting.
 * Melee: distance, hate, and a hard stick to the current target.
 * Casters: the same hate still holds a provoked tank, but a wounded
 * backliner outscores a healthy knight when hate is only modest.
 * Ties break on id so the pick never needs a roll.
 */
export function mobFocusScore(mob: MobFocusMob, c: MobFocusCandidate): number {
  const d = Math.hypot(mob.x - c.x, mob.z - c.z);
  const current = mob.targetId === c.id;
  if (!mobCastsSpells(mob.job)) {
    return -d + (c.enmity || 0) * MELEE_HATE_WEIGHT + (current ? MELEE_FOCUS_STICK : 0);
  }
  let score = -d + (c.enmity || 0) * CASTER_HATE_WEIGHT + (current ? CASTER_FOCUS_STICK : 0);
  const wound = woundFraction(c);
  score += wound * CASTER_WOUND_WEIGHT;
  if (mob.job === "sorcerer" || mob.job === "time_mage") {
    if (CASTER_BACKLINE.has(c.job)) score += CASTER_BACKLINE_BONUS;
    if (c.job === "knight") score -= CASTER_TANK_PENALTY;
  } else if (mob.job === "cleric") {
    score += wound * 3;
  }
  return score;
}

export function pickMobFocus<T extends MobFocusCandidate>(
  mob: MobFocusMob,
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const score = mobFocusScore(mob, c);
    if (!best || score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && c.id < best.id)) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
