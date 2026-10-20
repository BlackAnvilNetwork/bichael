/**
 * Server walk pose (#436). The pose follows movement and held input, not a
 * long timer, so it neither drops to idle while a key is held nor keeps
 * walking after the body has stopped.
 */

/** A WASD packet arrives every 50ms while a key is held; allow one late packet. */
export const HELD_MOVE_WINDOW_MS = 120;

/** After a real step, keep the walk pose just past one 50ms tick. */
export const WALK_STEP_GRACE_MS = 60;

/** True while move packets keep arriving (a key is held). */
export function moveInputHeld(now: number, lastMoveInputAt: number): boolean {
  return lastMoveInputAt > 0 && now - lastMoveInputAt < HELD_MOVE_WINDOW_MS;
}

/** walkUntil after a tick that actually moved the body. */
export function walkUntilAfterStep(now: number): number {
  return now + WALK_STEP_GRACE_MS;
}

/**
 * walkUntil when the route ends this tick. Held input keeps the pose until
 * the next packet replans; a click-move that arrived ends now.
 */
export function walkUntilAtArrival(now: number, lastMoveInputAt: number): number {
  return moveInputHeld(now, lastMoveInputAt) ? now + HELD_MOVE_WINDOW_MS : now;
}

/** Idle branch: drop walk once the grace has passed and no key is held. */
export function shouldDropWalk(now: number, walkUntil: number, lastMoveInputAt: number): boolean {
  return now >= walkUntil && !moveInputHeld(now, lastMoveInputAt);
}
