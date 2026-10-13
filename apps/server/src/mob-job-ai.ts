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

export function mobWeaponBonus(job: JobId): number {
  return JOB_WEAPON[job] === "staff" ? 5 : 7;
}

export type MobAbilityId =
  | "mob_power_strike"
  | "mob_ember_bolt"
  | "mob_berserk"
  | "mob_slow"
  | "mob_mend"
  | "mob_shield_bash"
  | "mob_backstab"
  | "mob_arc_blade";

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
    { id: "mob_shield_bash", label: "Shield Bash", mp: 0, recastMs: 10_000, minRange: 0, maxRange: MELEE_RANGE + 0.6 },
    { id: "mob_power_strike", label: "Shield Smash", mp: 0, recastMs: 8_000, minRange: 0, maxRange: MELEE_RANGE + 0.6 },
  ],
  rogue: [
    { id: "mob_backstab", label: "Backstab", mp: 0, recastMs: 9_000, minRange: 0, maxRange: MELEE_RANGE + 0.5 },
  ],
  sorcerer: [
    { id: "mob_ember_bolt", label: "Ember Lance", mp: 8, recastMs: 5_500, minRange: 0, maxRange: ABILITY_RANGE },
  ],
  cleric: [
    { id: "mob_mend", label: "Ashmend", mp: 10, recastMs: 12_000, minRange: 0, maxRange: 14 },
    { id: "mob_ember_bolt", label: "Sacred Bolt", mp: 8, recastMs: 6_500, minRange: 0, maxRange: ABILITY_RANGE },
  ],
  time_mage: [
    { id: "mob_slow", label: "Slow", mp: 10, recastMs: 14_000, minRange: 0, maxRange: ABILITY_RANGE },
    { id: "mob_ember_bolt", label: "Chrono Spark", mp: 8, recastMs: 6_000, minRange: 0, maxRange: ABILITY_RANGE },
  ],
  battle_mage: [
    { id: "mob_arc_blade", label: "Arc Blade", mp: 6, recastMs: 7_000, minRange: 0, maxRange: MELEE_RANGE + 1.2 },
    { id: "mob_ember_bolt", label: "Rune Bolt", mp: 8, recastMs: 6_500, minRange: 2.5, maxRange: ABILITY_RANGE },
  ],
};

/** Cast tell duration before damage / Slow resolve (ms). */
export const MOB_CAST_WINDUP_MS = 550;
/** Full cast anim window — covers wind-up + resolve flash. */
export const MOB_CAST_ANIM_MS = 1000;

export type PendingMobCastResolve =
  | { type: "damage"; dmg: number; log: string }
  | { type: "slow"; durationMs: number; movePct: number; log: string }
  | { type: "miss"; log: string };

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
};

/**
 * Try a job ability. Returns true if it consumed the swing/cast slot
 * (caller should skip auto-attack).
 */
export function tryMobJobAbility(mob: MobJobCombatant, hooks: MobAbilityHooks): MobAbilityResult {
  const { now, dist, player, vitals, pushLog, applyPlayerDamage } = hooks;
  if (now < (mob.nextAbilityAt ?? 0)) return { ok: false };
  // ~35% chance each ready swing to spend an ability instead of auto
  if (Math.random() > 0.38) return { ok: false };

  const picks = JOB_ABILITIES[mob.job] ?? [];
  const silenced = now < mob.silenceUntil;
  // Spells are muted; melee JAs / Berserk still fire.
  const CAST_IDS: ReadonlySet<MobAbilityId> = new Set([
    "mob_ember_bolt",
    "mob_slow",
    "mob_mend",
  ]);
  const ready = picks.filter(
    (a) =>
      dist >= a.minRange &&
      dist <= a.maxRange &&
      mob.mp >= a.mp &&
      !(silenced && CAST_IDS.has(a.id)),
  );
  if (ready.length === 0) return { ok: false };
  // Prefer self-heal when hurt
  let choice = ready[Math.floor(Math.random() * ready.length)]!;
  if (mob.hp < mob.maxHp * 0.45) {
    const mend = ready.find((a) => a.id === "mob_mend");
    if (mend) choice = mend;
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
      mob.nextSwingAt = now + 900;
      pushLog(`${mob.name} flies into a Berserk rage!`);
      return { ok: true };
    }
    case "mob_mend": {
      const heal = Math.max(8, Math.floor(mob.maxHp * 0.18 + stats.mnd * 1.2));
      mob.hp = Math.min(mob.maxHp, mob.hp + heal);
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      mob.nextSwingAt = now + 1100;
      pushLog(`${mob.name} mends for ${heal} HP.`);
      return { ok: true };
    }
    case "mob_slow": {
      // Wind-up first — Slow resolves after MOB_CAST_WINDUP_MS so the tell leads.
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      mob.nextSwingAt = now + swingDelayMs(2200, 0);
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
      if (Math.random() < 0.4) {
        player.blindUntil = Math.max(player.blindUntil, now + 1600);
        pushLog(`${mob.name}'s Shield Bash dazes you!`);
      }
      mob.anim = "melee";
      mob.animUntil = now + 480;
      mob.nextSwingAt = now + swingDelayMs(2600, 0);
      applyPlayerDamage(dmg, `${mob.name} Shield Bashes you for ${dmg}.`);
      return { ok: true };
    }
    case "mob_backstab": {
      const att = Math.max(1, Math.floor(attackFromStats(stats, false, mobWeaponBonus(mob.job), { physical: true }) * atkMul * downMul));
      const def = targetPhysDef(vitals);
      const crit = Math.random() < 0.55;
      let dmg = physicalDamage(att, def, meleeFStr("rogue", stats, vitals.vit, "none"), crit);
      dmg = Math.max(1, Math.floor(dmg * (crit ? 1.4 : 1.15)));
      mob.anim = "melee";
      mob.animUntil = now + 420;
      mob.nextSwingAt = now + swingDelayMs(2200, 0);
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
      mob.nextSwingAt = now + swingDelayMs(2500, 0);
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
      mob.nextSwingAt = now + swingDelayMs(2300, 0);
      applyPlayerDamage(dmg, `${mob.name}'s Arc Blade hits for ${dmg}.`);
      return { ok: true };
    }
    case "mob_ember_bolt": {
      // Magic bolt — INT/MND based, ignores some physical def
      const power = Math.max(1, Math.floor((stats.int * 1.4 + stats.mnd * 0.4 + mob.level * 1.5) * atkMul * downMul));
      const resist = Math.floor(vitals.vit * 0.35);
      let dmg = Math.max(1, power - resist + 6);
      mob.anim = "cast";
      mob.animUntil = now + MOB_CAST_ANIM_MS;
      mob.nextSwingAt = now + swingDelayMs(2400, 0);
      return {
        ok: true,
        pending: {
          type: "damage",
          dmg,
          log: `${mob.name} casts ${choice.label} for ${dmg}.`,
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
  if (Math.random() > hitChance(mobAcc, playerEva)) {
    return { hit: false, dmg: 0, anim: magic ? "cast" : "melee" };
  }
  if (magic) {
    const power = Math.max(1, Math.floor((stats.int * 1.15 + stats.mnd * 0.35 + 4) * atkMul));
    const resist = Math.floor(target.vit * 0.3);
    let dmg = Math.max(1, power - resist);
    return { hit: true, dmg, anim: "cast" };
  }
  const att = Math.max(
    1,
    Math.floor(attackFromStats(stats, false, mobWeaponBonus(mob.job), { physical: true }) * atkMul),
  );
  const def = targetPhysDef(target);
  let dmg = physicalDamage(att, def, meleeFStr(mob.job, stats, target.vit, "none"), false);
  return { hit: true, dmg, anim: "melee" };
}
