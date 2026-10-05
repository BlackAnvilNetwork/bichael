/**
 * Server-side engage range (#62).
 *
 * `engage` used to accept any alive mob id, so a client could pull and set hate
 * on mobs anywhere in the world. The server now rejects targets beyond
 * ENGAGE_MAX_RANGE. That is about twice the longest spell range (15) and the
 * play-bot's 26-unit hunt radius, and well inside the 72-unit snapshot interest
 * bubble, so anything a player can see and reasonably click still engages.
 */
export const ENGAGE_MAX_RANGE = 30;

export function withinEngageRange(px: number, pz: number, mx: number, mz: number): boolean {
  const d = Math.hypot(mx - px, mz - pz);
  return Number.isFinite(d) && d <= ENGAGE_MAX_RANGE;
}
