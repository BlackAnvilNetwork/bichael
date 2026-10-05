import {
  clampPaleHollow,
  paleHollowClampMove,
  paleHollowInBuildingClearing,
  paleHollowWalkable,
} from "@bellgrave/config";

/**
 * Chase steering for field mobs (#73).
 *
 * Mobs used to step straight at their target and only clamp to the map bounds,
 * so they walked through rivers and river walls. Each chase step now uses the
 * same walkability check as players. When the direct line is blocked, the mob
 * tries headings up to ~100 degrees off and takes whichever valid step ends
 * closest to the target, so it slides along a bank toward a bridge instead of
 * wading across.
 */

/** Heading offsets (radians) tried after the direct line, nearest first. */
const DEFLECTIONS = [0.45, 0.9, 1.35, 1.75];

export type SteerResult = { x: number; z: number; heading: number; moved: boolean };

function blockedAt(x: number, z: number, fromInClearing: boolean): boolean {
  if (!paleHollowWalkable(x, z)) return true;
  // Don't chase into building clearings, but let a mob already inside one walk out.
  return !fromInClearing && paleHollowInBuildingClearing(x, z);
}

function tryStep(x: number, z: number, heading: number, step: number, fromInClearing: boolean): { x: number; z: number } | null {
  const nx = x + Math.sin(heading) * step;
  const nz = z + Math.cos(heading) * step;
  const c = paleHollowClampMove(x, z, nx, nz);
  // Clamp stopped us short: that line runs into water or a wall.
  if (Math.hypot(c.x - x, c.z - z) < step * 0.5) return null;
  if (blockedAt(c.x, c.z, fromInClearing)) return null;
  return c;
}

/**
 * One chase step of length `step` from (x, z) toward (tx, tz), never ending on
 * an unwalkable tile. A mob that is already on bad ground (spawned or knocked
 * there) may take the direct step so it can get out.
 */
export function steerMobStep(x: number, z: number, tx: number, tz: number, step: number): SteerResult {
  const direct = Math.atan2(tx - x, tz - z);
  if (step <= 0) return { x, z, heading: direct, moved: false };

  if (!paleHollowWalkable(x, z)) {
    const c = clampPaleHollow(x + Math.sin(direct) * step, z + Math.cos(direct) * step);
    return { x: c.x, z: c.z, heading: direct, moved: true };
  }

  const fromInClearing = paleHollowInBuildingClearing(x, z);
  const straight = tryStep(x, z, direct, step, fromInClearing);
  if (straight) return { x: straight.x, z: straight.z, heading: direct, moved: true };

  let best: SteerResult | null = null;
  let bestD = Infinity;
  for (const off of DEFLECTIONS) {
    for (const sign of [1, -1]) {
      const heading = direct + off * sign;
      const c = tryStep(x, z, heading, step, fromInClearing);
      if (!c) continue;
      const d = Math.hypot(tx - c.x, tz - c.z);
      if (d < bestD - 1e-6) {
        bestD = d;
        best = { x: c.x, z: c.z, heading, moved: true };
      }
    }
    // Prefer the smallest deflection that works.
    if (best) return best;
  }
  return { x, z, heading: direct, moved: false };
}
