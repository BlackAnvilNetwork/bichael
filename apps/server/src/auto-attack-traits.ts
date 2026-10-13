/**
 * Auto-attack job traits resolved across main + support kits (#86, #88).
 *
 * Main job traits apply at full strength. An active support job (L10+, see
 * support-job.ts) contributes its auto-attack trait at SUPPORT_TRAIT_SCALE.
 * Main and support are always different jobs, so a trait is never counted twice.
 *
 * With no active support job, autoAttackFStr matches meleeFStr exactly.
 */
import { fStr, isJobId, type Stance, type Stats } from "@bellgrave/combat";
import { hasKit, type DualJobPlayer } from "./support-job";
import { fighterAccBonus, fighterAttackMul, type FighterPlayer } from "./fighter-abilities";

/** Share of a job's auto-attack trait that a support kit contributes. */
export const SUPPORT_TRAIT_SCALE = 0.5;

/** Main Rogue dagger trait: a quarter of DEX adds to the fSTR stat. */
export const ROGUE_DEX_FSTR_SHARE = 0.25;

/** The player's active support job, or null when none is active. */
function activeSupport(p: DualJobPlayer): string | null {
  const sub = p.subjob && isJobId(p.subjob) ? p.subjob : null;
  if (!sub || sub === p.job) return null;
  return hasKit(p, sub) ? sub : null;
}

/**
 * Auto-attack fSTR for a player, aggregating main and support traits.
 * - Rogue DEX trait: main adds floor(DEX * 0.25); support adds floor(DEX * 0.125).
 * - Time Mage Flux: main swings with MND; support (in Flux) adds half of
 *   MND's lead over STR, never lowering the STR base.
 * - Sorcerer / Cleric staff floor (-1) stays a main-job trait.
 */
export function autoAttackFStr(
  p: DualJobPlayer,
  stats: Pick<Stats, "str" | "dex" | "mnd">,
  targetVit: number,
  stance: Stance,
): number {
  const main = p.job;
  const support = activeSupport(p);

  let base = stats.str;
  if (stance === "flux") {
    if (main === "time_mage") base = stats.mnd;
    else if (support === "time_mage") {
      base = stats.str + Math.floor(Math.max(0, stats.mnd - stats.str) * SUPPORT_TRAIT_SCALE);
    }
  }

  if (main === "rogue") base += Math.floor(stats.dex * ROGUE_DEX_FSTR_SHARE);
  else if (support === "rogue") {
    base += Math.floor(stats.dex * ROGUE_DEX_FSTR_SHARE * SUPPORT_TRAIT_SCALE);
  }

  const f = fStr(base, targetVit);
  if (main === "sorcerer" || main === "cleric") return Math.max(-1, f);
  return f;
}

/**
 * Fighter attack multiplier for an auto-attack. Applies to physical mains and
 * to any player with a Fighter kit, so a caster main with Fighter support gets
 * Berserk / Warcry attack alongside Berserk's defense penalty.
 */
export function autoAttackFighterAttackMul(
  p: FighterPlayer,
  now: number,
  physicalMain: boolean,
): number {
  if (!physicalMain && !hasKit(p, "fighter")) return 1;
  return fighterAttackMul(p, now);
}

/** Fighter accuracy bonus (Aggressor) for any player with a Fighter kit. */
export function autoAttackFighterAccBonus(p: FighterPlayer, now: number): number {
  return hasKit(p, "fighter") ? fighterAccBonus(p, now) : 0;
}
