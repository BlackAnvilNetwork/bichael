/**
 * Chase replanning (#445). A running route only replans when the goal moves
 * far; a route that already ended short of the goal replans as soon as the
 * goal moves at all, so a sidestep inside 1.25 does not leave the player
 * standing out of melee range.
 */

export type ChaseRouteState = {
  navGoal: { x: number; z: number } | null;
  moveTo: { x: number; z: number } | null;
  navHold: boolean;
};

/** While a route is still running, keep it until the goal moves this far. */
export const CHASE_REPLAN_SHIFT = 1.25;

/** A held (finished, short) route re-plans once the goal moves more than this. */
export const CHASE_HOLD_SHIFT = 0.2;

export function chaseNeedsReplan(s: ChaseRouteState, gx: number, gz: number): boolean {
  if (!s.navGoal) return true;
  const shift = Math.hypot(s.navGoal.x - gx, s.navGoal.z - gz);
  if (s.moveTo) return shift > CHASE_REPLAN_SHIFT;
  // Route ended short of an unreachable goal. Same goal: hold, no A* per tick.
  if (s.navHold) return shift > CHASE_HOLD_SHIFT;
  return true;
}

/**
 * After a kill, do not chase the next hostile while the player is steering
 * with held movement keys; the key's own route keeps control.
 */
export function shouldAutoEngage(moveInputHeld: boolean): boolean {
  return !moveInputHeld;
}
