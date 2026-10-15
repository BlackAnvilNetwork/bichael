/** Shared combat helpers + Time Mage full kit */

import type { JobId } from "./jobs";

export type Stats = {
  str: number;
  dex: number;
  vit: number;
  agi: number;
  int: number;
  mnd: number;
};

export const GUARD_L1: Stats = {
  str: 10,
  dex: 8,
  vit: 12,
  agi: 6,
  int: 4,
  mnd: 4,
};

export function defenseFromVit(vit: number): number {
  return Math.floor(vit * 1.5);
}

/**
 * Physical defense used when a mob hits a player: VIT defense plus the
 * equipped catalog `def`. The character sheet shows this same number (#52).
 * It feeds `physicalDamage`, whose 0.1 attack/defense ratio floor and
 * 1-damage minimum keep heavy armor from ever zeroing a hit.
 */
export function playerDefense(vit: number, gearDef = 0): number {
  const gear = Number.isFinite(gearDef) ? Math.max(0, Math.floor(gearDef)) : 0;
  return defenseFromVit(vit) + gear;
}

/**
 * Magic defense from Mind. Incoming spells consult this the way physical
 * hits consult defenseFromVit. 10 MND = 12 defense.
 */
export function magicDefenseFromMnd(mnd: number): number {
  if (!Number.isFinite(mnd) || mnd <= 0) return 0;
  return Math.floor(mnd * 1.2);
}

/**
 * Magic defense a spell is rolled against: MND plus catalog `mdb`.
 * Gear MDB is the magic counterpart of armor `def` (#81).
 */
export function playerMagicDefense(mnd: number, gearMdb = 0): number {
  const gear = Number.isFinite(gearMdb) ? Math.max(0, Math.floor(gearMdb)) : 0;
  return magicDefenseFromMnd(mnd) + gear;
}

/** Incoming magic never drops below this fraction from resistance alone. */
export const MAGIC_RESIST_FLOOR = 0.55;
/** Softness of the resist curve. Higher defense shaves def / (def + K). */
export const MAGIC_RESIST_K = 180;

/**
 * Multiplier for incoming magic from magic defense.
 * 0 defense = 1. Stacked MND/MDB approaches MAGIC_RESIST_FLOOR and never hits 0.
 */
export function magicResistMul(magDef: number): number {
  const def = Number.isFinite(magDef) ? Math.max(0, magDef) : 0;
  if (def <= 0) return 1;
  const shaved = def / (def + MAGIC_RESIST_K);
  return Math.max(MAGIC_RESIST_FLOOR, 1 - shaved);
}

/** Apply magic resistance. A positive hit stays at least 1. */
export function mitigateMagicDamage(raw: number, magDef: number): number {
  if (!(raw > 0)) return 0;
  return Math.max(1, Math.floor(raw * magicResistMul(magDef)));
}

/** Gear Magic Attack Bonus: each point of `mab` is +1% spell damage. */
export const MAB_PCT_PER_POINT = 0.01;
/** Gear MAB caps at +100% spell damage. */
export const MAB_MAX_BONUS = 1;

/** Spell damage multiplier from gear MAB (1 = no bonus, never below 1). */
export function magicAttackMul(mab = 0): number {
  const m = Number.isFinite(mab) ? Math.max(0, mab) : 0;
  return 1 + Math.min(MAB_MAX_BONUS, m * MAB_PCT_PER_POINT);
}

/** Scale finished spell damage by gear MAB. Always at least 1. */
export function applyMagicAttackBonus(dmg: number, mab = 0): number {
  return Math.max(1, Math.floor(dmg * magicAttackMul(mab)));
}

export function evasionFromAgi(agi: number): number {
  return Math.floor(agi / 2);
}

/** Physical-swing crit from Agility: +0.1% per point (10 AGI = +1%), on top of base crit. */
export function critFromAgi(agi: number): number {
  return Math.max(0, agi) * 0.001;
}

export type Stance = "flux" | "aether" | "none";

export function attackFromStats(
  stats: Stats,
  stance: Stance | boolean,
  weaponBonus = 8,
  opts?: { physical?: boolean },
): number {
  // Weapon jobs and staff chip (Sorcerer / Cleric): full STR + weapon.
  // Time Mage passes physical: false and uses Flux / the 10% lock below.
  if (opts?.physical) {
    return Math.max(1, Math.floor(stats.str + weaponBonus));
  }
  // Legacy boolean: true = flux
  const s: Stance = typeof stance === "boolean" ? (stance ? "flux" : "none") : stance;
  if (s === "flux") {
    return Math.max(1, Math.floor(stats.mnd + weaponBonus));
  }
  // Aether + unstanced TIM: melee suppressed
  return Math.max(1, Math.floor((stats.str + weaponBonus) * 0.1));
}

export function hitChance(acc: number, eva: number): number {
  return Math.min(0.95, Math.max(0.2, 0.75 + (acc - eva) / 200));
}

export function physicalDamage(
  att: number,
  def: number,
  fStr: number,
  crit: boolean,
): number {
  const ratio = Math.max(0.1, Math.min(2.5, att / Math.max(1, def)));
  let dmg = Math.floor((8 + fStr) * ratio);
  if (crit) dmg = Math.floor(dmg * 1.25);
  return Math.max(1, dmg);
}

/**
 * Auto-attack delay after haste.
 * Formula: floor(baseDelay * (1 - clamp(hastePct, 0, 0.8)))
 * Prefer `resolveSwingDelayMs` so catalog weapon delayMs drives the base.
 */
export function swingDelayMs(baseDelay: number, hastePct: number): number {
  const haste = Math.min(0.8, Math.max(0, hastePct));
  return Math.floor(baseDelay * (1 - haste));
}

export function fStr(attackerStr: number, targetVit: number): number {
  return Math.max(-10, Math.min(20, attackerStr - targetVit));
}

/** Time Mage is the only job whose autos use the Flux / 10% stance formula. */
export function meleeUsesWeaponAttack(job: JobId): boolean {
  return job !== "time_mage";
}

/**
 * Auto-attack fSTR.
 * Flux Time Mage uses MND. Rogue daggers add a quarter of DEX so a level-1
 * hit lands just under Knight and well under Fighter. Sorcerer and Cleric
 * swing with STR, but a deep STR deficit is floored at -1 — otherwise
 * (8 + fSTR) collapses and the staff hits for 1.
 */
export function meleeFStr(
  job: JobId,
  stats: Pick<Stats, "str" | "dex" | "mnd">,
  targetVit: number,
  stance: Stance | boolean,
): number {
  const s: Stance = typeof stance === "boolean" ? (stance ? "flux" : "none") : stance;
  if (job === "time_mage" && s === "flux") return fStr(stats.mnd, targetVit);
  if (job === "rogue") return fStr(stats.str + Math.floor(stats.dex * 0.25), targetVit);
  if (job === "sorcerer" || job === "cleric") return Math.max(-1, fStr(stats.str, targetVit));
  return fStr(stats.str, targetVit);
}

/** @deprecated Use TIM_ABILITIES — kept for older imports. */
export const ABILITIES = {
  flux: { mp: 0, recastMs: 30_000 },
  quicken: { mp: 12, recastMs: 15_000, durationMs: 90_000, haste: 0.35 },
  slow: { mp: 15, recastMs: 20_000, durationMs: 30_000, hastePenalty: 0.25 },
  cure: { mp: 8, recastMs: 6_000, heal: 45 },
  rest: { mp: 0, recastMs: 0 },
} as const;

/** Fallback auto-attack delay (ms) when no weapon delayMs is equipped. */
export const SWING_BASE_MS = 1600;

/**
 * Resolve swing delay from catalog weapon `delayMs` + haste.
 * Missing/invalid delay falls back to SWING_BASE_MS.
 */
export function resolveSwingDelayMs(
  weaponDelayMs: number | null | undefined,
  hastePct: number,
): number {
  const base =
    typeof weaponDelayMs === "number" && weaponDelayMs > 0 ? weaponDelayMs : SWING_BASE_MS;
  return swingDelayMs(base, hastePct);
}

/** Per-second rest tick (server applies once per second while resting). */
export const REST_TICK = {
  hp: 8,
  mp: 6,
  tpDrain: 40,
} as const;

/**
 * XP needed to go from `level` to `level + 1`.
 * One entry per level 1-75. Levels 1-74 buy the next level (the cap stays 75).
 * Level 75's cost is only the existing post-cap skill echo. It does not create a level 76.
 *
 * Design bands (cost low-high, cumulative XP after paying that band):
 * 1-10 500-2400 -> 13350; 11-20 2600-4400 -> 48350; 21-30 4600-5700 -> 100550;
 * 31-40 5800-6700 -> 163050; 41-50 6800-7700 -> 235550; 51-60 7800-17600 -> 358550;
 * 61-70 18800-32000 -> 611350; 71-75 34000-44000 -> 845350.
 *
 * Endpoints are exact. Interior levels are the rounded linear step from low to high.
 * The pure line does not hit the band sums, so the integer remainder (plus or minus)
 * is spread evenly across interior levels, with any leftover +/-1 on the later interiors.
 * Band 71-75 is 39000 short of its total on that line, so levels 72-74 sit above the
 * level-75 endpoint. That dip is what keeps both endpoints and the band total.
 */
const XP_TO_NEXT: readonly number[] = [
  500, 567, 778, 989, 1200, 1412, 1623, 1835, 2046, 2400,
  2600, 2800, 3000, 3200, 3400, 3600, 3800, 4000, 4200, 4400,
  4600, 4809, 4931, 5054, 5176, 5299, 5421, 5544, 5666, 5700,
  5800, 5900, 6000, 6100, 6200, 6300, 6400, 6500, 6600, 6700,
  6800, 6900, 7000, 7100, 7200, 7300, 7400, 7500, 7600, 7700,
  7800, 8389, 9478, 10567, 11656, 12744, 13833, 14922, 16011, 17600,
  18800, 20117, 21583, 23050, 24517, 25983, 27450, 28917, 30383, 32000,
  34000, 49500, 52000, 54500, 44000,
];

export function xpToNextLevel(level: number): number {
  const lv = Math.max(1, Math.min(XP_TO_NEXT.length, Math.floor(level)));
  return XP_TO_NEXT[lv - 1]!;
}

/** @deprecated Vitals come from jobVitalsAtLevel — kept for older imports. */
export const LEVEL_UP_BONUS = {
  maxHp: 10,
  maxMp: 6,
} as const;

export const MAX_LEVEL = 75;

export * from "./jobs";
export * from "./grades";
export * from "./tim-kit";
export * from "./knight-kit";
export * from "./rogue-kit";
export * from "./sorcerer-kit";
export * from "./fighter-kit";
export * from "./battlemage-kit";
export * from "./cleric-kit";
export * from "./shared-icons";
export * from "./dual-job";
export * from "./skill-tree";
export * from "./weapon-tp";
export * from "./abilities";
export * from "./derived-stats";

export * from "./trainer";
