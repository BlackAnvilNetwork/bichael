/**
 * Incoming damage-taken (DT) multipliers for players hit by mobs.
 * Pure helpers (no server boot) so combat tests can import them.
 *
 * Buff fields apply to whoever carries them (party Protect / Shell etc.), so
 * these consolidate every job's wards in one place instead of chaining the
 * per-job helpers, which would double-count shared buffs like Shell.
 */

export type PhysDtUnit = {
  bulwarkUntil: number;
  sentinelUntil: number;
  coverUntil: number;
  rampartUntil: number;
  guardianUntil: number;
  protectUntil: number;
  protectPhysMul: number;
  phalanxUntil: number;
  phalanxPhysMul: number;
};

export type MagDtUnit = {
  asylumUntil: number;
  fealtyUntil: number;
  shellUntil: number;
  shellMagMul: number;
  manaWallUntil: number;
};

/** Lowest DT multiplier stacked wards can reach. */
export const DT_FLOOR = 0.15;
/** Skill-tree DT can shave at most 30% on its own. */
export const TREE_DT_FLOOR = 0.7;

/** Cleric Asylum magic DT. */
export const ASYLUM_MAG_MUL = 0.7;
/** Knight Fealty magic DT. */
export const FEALTY_MAG_MUL = 0.5;
/** Sorcerer Mana Wall magic DT (MP bleed still applies after). */
export const MANA_WALL_MAG_MUL = 0.55;

/** Physical DT: Bulwark immunity, Sentinel / Cover / Rampart / Guardian / Protect / Phalanx + tree physDt. */
export function physDtMul(p: PhysDtUnit, now: number, treePhysDt: number): number {
  const tree = 1 - treePhysDt;
  // Bulwark — true physical immunity (bypass DT floor)
  if (now < p.bulwarkUntil) return 0;

  let mul = 1;
  if (now < p.sentinelUntil) mul *= 0.5;
  if (now < p.coverUntil) mul *= 0.75;
  if (now < p.rampartUntil) mul *= 0.75;
  if (now < p.guardianUntil) mul *= 0.65;
  if (now < p.protectUntil) mul *= p.protectPhysMul;
  if (now < p.phalanxUntil) mul *= p.phalanxPhysMul;
  // Soft floor so Sentinel + Protect/Rampart/Guardian still stack (#49).
  // Was hard-capped at 0.5 which made further mitigation a no-op.
  return Math.max(DT_FLOOR, mul * Math.max(TREE_DT_FLOOR, tree));
}

/** Magic DT: Asylum / Fealty / Shell / Mana Wall + tree magDt (#55). */
export function playerMagDtMul(p: MagDtUnit, now: number, treeMagDt: number): number {
  const tree = 1 - treeMagDt;
  let mul = 1;
  if (now < p.asylumUntil) mul *= ASYLUM_MAG_MUL;
  if (now < p.fealtyUntil) mul *= FEALTY_MAG_MUL;
  if (now < p.shellUntil) mul *= p.shellMagMul;
  if (now < p.manaWallUntil) mul *= MANA_WALL_MAG_MUL;
  // Same soft floor as physical so stacked wards keep helping.
  return Math.max(DT_FLOOR, mul * Math.max(TREE_DT_FLOOR, tree));
}

/** DT for a mob's pending (wound-up) hit: magic casts use mag DT, the rest phys DT. */
export function pendingHitDtMul(
  p: PhysDtUnit & MagDtUnit,
  now: number,
  magic: boolean,
  tree: { physDt?: number; magDt?: number },
): number {
  return magic ? playerMagDtMul(p, now, tree.magDt ?? 0) : physDtMul(p, now, tree.physDt ?? 0);
}
