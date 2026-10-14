/**
 * Black Anvil PvP areas — bounty arenas with optional level caps.
 *
 * Bounty value is always **1 xDAI** (1×10¹⁸ wei), mirrored on the lok ledger
 * via `pvpBountyOpen` / `pvpBountyCancel` / `pvpKill`. Settlement stays on-chain.
 */

/** Fixed head-bounty in wei (matches engine `PVP_BOUNTY_WEI`). */
export const PVP_BOUNTY_WEI = "1000000000000000000" as const;

export type PvpAreaBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type PvpAreaDef = {
  id: string;
  name: string;
  /** Parent outdoor zone (heightmap / snap). */
  zoneId: string;
  /** True when players may attack each other here (requires open bounty). */
  pvp: true;
  /**
   * Cap effective main-job level while inside (stats + main abilities).
   * Subjob effective level becomes `floor(levelCap / 2)`.
   */
  levelCap: number;
  bounds: PvpAreaBounds;
  /** Join teleport / respawn pad inside the arena. */
  spawn: { x: number; z: number; facing?: number };
  /** Flavor for UI / logs. */
  blurb: string;
};

/**
 * Ash Pit — first Black Anvil PvP arena inside Pale Hollow.
 * Level 30 / subjob 15 cap. Southwest pocket off the hub apron.
 */
export const ASH_PIT: PvpAreaDef = {
  id: "ash_pit",
  name: "Ash Pit",
  zoneId: "pale_hollow",
  pvp: true,
  levelCap: 30,
  bounds: {
    minX: -72,
    maxX: -42,
    minZ: -18,
    maxZ: 8,
  },
  spawn: { x: -57, z: -5, facing: 0 },
  blurb:
    "Join with 1 xDAI on your head. Level 30 / support 15. Slain — bounty to the slayer; rejoin anytime.",
};

/** All registered PvP areas (extend as more arenas ship). */
export const PVP_AREAS: Record<string, PvpAreaDef> = {
  [ASH_PIT.id]: ASH_PIT,
};

export function pvpAreaById(id: string): PvpAreaDef | undefined {
  return PVP_AREAS[id];
}

/** First PvP area whose bounds contain (x, z), if any. */
export function pvpAreaAt(x: number, z: number): PvpAreaDef | undefined {
  for (const area of Object.values(PVP_AREAS)) {
    const { minX, maxX, minZ, maxZ } = area.bounds;
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) return area;
  }
  return undefined;
}

export function inPvpArea(x: number, z: number): boolean {
  return !!pvpAreaAt(x, z);
}

/** Effective main level under an area cap (or uncapped). */
export function cappedMainLevel(actualLevel: number, levelCap?: number | null): number {
  const lv = Math.max(1, Math.floor(actualLevel));
  if (levelCap == null || !Number.isFinite(levelCap)) return lv;
  return Math.min(lv, Math.max(1, Math.floor(levelCap)));
}

/** Effective support level = floor(cappedMain / 2), unlocked at main ≥ 10. */
export function cappedSubjobLevel(
  actualMainLevel: number,
  levelCap?: number | null,
  unlockMain = 10,
): number {
  const main = cappedMainLevel(actualMainLevel, levelCap);
  if (main < unlockMain) return 0;
  return Math.max(1, Math.floor(main / 2));
}
