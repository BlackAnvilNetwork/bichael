/**
 * Dual-job helpers — main at full level, support at floor(main/2) from L10.
 *
 * Design (issue #56, generalized to every job):
 * - The support job is a buff for the main job, never a second full kit.
 * - Support effective level = floor(main / 2) once main >= SUBJOB_UNLOCK_LEVEL.
 * - Character stats = main job at full level + the support job's growth as if it
 *   were at the support level. Every ability (main or support) reads that one
 *   character stat pool, so a support spell never gets a separate "full level" kit.
 * - Support abilities still have to be learned (Trainer). They unlock only when
 *   their unlock level <= support level — the same cap the Trainer sells under.
 */
import type { JobId } from "./jobs";
import {
  JOB_GRADES,
  jobStatsAtLevel,
  jobVitalsAtLevel,
  type AttrStats,
  type Vitals,
} from "./grades";
import { abilitiesUnlockedForJob, type AbilityId } from "./abilities";

/** Main job level required before a support job can be set. */
export const SUBJOB_UNLOCK_LEVEL = 10;

/** Support job effective level = half main (floor). */
export function subjobLevel(mainLevel: number): number {
  return Math.max(1, Math.floor(Math.max(1, mainLevel) / 2));
}

/** True when `sub` is a real, active support job for this main/level. */
export function supportJobActive(
  main: JobId,
  level: number,
  sub: JobId | null | undefined,
): sub is JobId {
  return !!sub && sub !== main && level >= SUBJOB_UNLOCK_LEVEL;
}

/** Effective support level, or 0 when no support job is active. */
export function activeSubjobLevel(
  main: JobId,
  level: number,
  sub: JobId | null | undefined,
): number {
  return supportJobActive(main, level, sub) ? subjobLevel(level) : 0;
}

const ZERO_ATTRS: AttrStats = { str: 0, dex: 0, vit: 0, agi: 0, int: 0, mnd: 0 };

/**
 * What the support job adds to the character's six attributes: its grade growth
 * from L1 up to the support level (half main). The support job's L1 seed is not
 * added again — the main job already supplies the body's base row.
 */
export function supportJobStatContribution(
  main: JobId,
  level: number,
  sub: JobId | null | undefined,
): AttrStats {
  if (!supportJobActive(main, level, sub)) return { ...ZERO_ATTRS };
  const subNow = jobStatsAtLevel(sub, subjobLevel(level));
  const subBase = jobStatsAtLevel(sub, 1);
  return {
    str: subNow.str - subBase.str,
    dex: subNow.dex - subBase.dex,
    vit: subNow.vit - subBase.vit,
    agi: subNow.agi - subBase.agi,
    int: subNow.int - subBase.int,
    mnd: subNow.mnd - subBase.mnd,
  };
}

/**
 * Character attributes: main at full level + support contribution at half level.
 * This is the single stat pool every ability reads (main or support kit).
 */
export function combinedJobStats(
  main: JobId,
  level: number,
  sub: JobId | null | undefined,
): AttrStats {
  const primary = jobStatsAtLevel(main, level);
  const add = supportJobStatContribution(main, level, sub);
  return {
    str: primary.str + add.str,
    dex: primary.dex + add.dex,
    vit: primary.vit + add.vit,
    agi: primary.agi + add.agi,
    int: primary.int + add.int,
    mnd: primary.mnd + add.mnd,
  };
}

/**
 * Max HP/MP: main at full level + support growth at half level.
 * A main with no MP pool (Rogue, Fighter) takes the support job's whole MP pool
 * at the support level — otherwise a caster support would add only a sliver of
 * growth and its learned spells could not be cast.
 */
export function combinedJobVitals(
  main: JobId,
  level: number,
  sub: JobId | null | undefined,
): Vitals {
  const primary = jobVitalsAtLevel(main, level);
  if (!supportJobActive(main, level, sub)) return primary;
  const subLv = subjobLevel(level);
  const subNow = jobVitalsAtLevel(sub, subLv);
  const subBase = jobVitalsAtLevel(sub, 1);
  const mainHasMp = JOB_GRADES[main].mp !== "none";
  const mpAdd = mainHasMp ? subNow.maxMp - subBase.maxMp : subNow.maxMp;
  return {
    maxHp: Math.max(1, primary.maxHp + (subNow.maxHp - subBase.maxHp)),
    maxMp: Math.max(0, primary.maxMp + mpAdd),
  };
}

/** Main unlocks at full level + learned support unlocks at floor(level/2). */
export function abilitiesUnlockedDual(
  main: JobId,
  level: number,
  sub: JobId | null | undefined,
  learned: readonly string[] = [],
): AbilityId[] {
  const mainAb = abilitiesUnlockedForJob(main, level, learned);
  if (!supportJobActive(main, level, sub)) return mainAb;
  const subAb = abilitiesUnlockedForJob(sub, subjobLevel(level), learned);
  return Array.from(new Set<AbilityId>([...mainAb, ...subAb]));
}

/**
 * Effective level for a job you have as main or support (0 if neither).
 * Ability resolvers gate unlocks on this, so a support kit never uses main level.
 */
export function effectiveJobLevel(
  main: JobId,
  level: number,
  sub: JobId | null | undefined,
  job: JobId,
): number {
  if (main === job) return Math.max(1, level);
  if (sub === job && supportJobActive(main, level, sub)) return subjobLevel(level);
  return 0;
}
