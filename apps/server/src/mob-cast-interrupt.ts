/**
 * Damage interrupt for an enemy cast that is still in its wind-up.
 * Silence and stun clear the cast on their own; this is the hit that lands
 * while the tell is still playing (#81).
 */

/** Extra lock after a damaged cast so the mob cannot immediately recast. */
export const CAST_INTERRUPT_RECOVERY_MS = 900;

export type CastWindup = {
  pendingCastHitAt: number;
  pendingCastTarget: string | null;
  pendingCastKind: string;
  pendingCastDmg: number;
  pendingCastLog: string;
  pendingCastSlowMs: number;
  pendingCastMovePct: number;
  pendingCastMagic: boolean;
  pendingCastAoe: number;
  nextSwingAt: number;
  anim: string;
  /** Set when a hit cancels the wind-up. The sim delivers it next mob tick. */
  interruptShout?: string;
  interruptShoutTo?: string | null;
};

export function castIsWindingUp(mob: { pendingCastHitAt: number }, now: number): boolean {
  return mob.pendingCastHitAt > now;
}

export function clearPendingCast(mob: CastWindup): void {
  mob.pendingCastHitAt = 0;
  mob.pendingCastTarget = null;
  mob.pendingCastKind = "";
  mob.pendingCastDmg = 0;
  mob.pendingCastLog = "";
  mob.pendingCastSlowMs = 0;
  mob.pendingCastMovePct = 0;
  mob.pendingCastMagic = false;
  mob.pendingCastAoe = 0;
}

/**
 * A positive hit during wind-up cancels the cast and pushes the next action.
 * Damage that arrives after the cast is already due does nothing — the
 * resolve tick owns that hit. Zero damage (a fully soaked blow) does not
 * interrupt.
 */
export function interruptCastOnDamage(mob: CastWindup, now: number, dmg: number): boolean {
  if (!(dmg > 0)) return false;
  if (!castIsWindingUp(mob, now)) return false;
  const hear = mob.pendingCastTarget;
  clearPendingCast(mob);
  mob.nextSwingAt = Math.max(mob.nextSwingAt, now + CAST_INTERRUPT_RECOVERY_MS);
  if (mob.anim === "cast") mob.anim = "idle";
  mob.interruptShout = "The spell unravels under the blow!";
  mob.interruptShoutTo = hear;
  return true;
}

export function asCastWindup(host: object): CastWindup | null {
  if (!("pendingCastHitAt" in host)) return null;
  const wind = host as CastWindup;
  if (typeof wind.pendingCastHitAt !== "number") return null;
  if (typeof wind.pendingCastAoe !== "number") wind.pendingCastAoe = 0;
  return wind;
}
