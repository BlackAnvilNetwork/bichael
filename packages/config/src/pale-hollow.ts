/**
 * Pale Hollow — open basin with northbound segment bands.
 * Wider playable field (Reisenjima-style room to roam); soft mountains on the fringe.
 * Server + client share `paleHollowHeight`.
 */

export const PALE_HOLLOW_BOUNDS = {
  minX: -88,
  maxX: 88,
  minZ: -24,
  maxZ: 268,
} as const;

/** Scout encampment pad — flat packed ground (south-central). Playable bounds unchanged. */
export const PH_HUB = {
  minX: -14,
  maxX: 14,
  minZ: -6,
  maxZ: 10,
  floorY: 3.0,
} as const;

/**
 * Impassable footprint of the visual `HubRearRockWall` in PaleHollowMap
 * (mossy chalk cliff on the camp's north rear). The mesh runs about x -9..9,
 * z 7.4..10.5; this rect is that body with a small pad so a point-mover
 * cannot clip the boxes.
 *
 * It does not span the hub. The camp stays enterable:
 *   - south face of the camp (spawn at z 2) is open
 *   - west gap: x < minX (hub continues to -14, apron further)
 *   - east gap: x > maxX (the east trail already leaves near x 10, z 6)
 * North of the cliff (outdoor spawn at z 14) connects through those side gaps.
 */
export const PH_HUB_REAR_WALL = {
  minX: -9.4,
  maxX: 9.4,
  minZ: 7.15,
  maxZ: 10.85,
} as const;

export function paleHollowInHubRearWall(x: number, z: number): boolean {
  return (
    x >= PH_HUB_REAR_WALL.minX &&
    x <= PH_HUB_REAR_WALL.maxX &&
    z >= PH_HUB_REAR_WALL.minZ &&
    z <= PH_HUB_REAR_WALL.maxZ
  );
}

/**
 * Shared hub apron beyond `PH_HUB` — single source for height ramp, tree/prop
 * clearings, and placement. Rect SDF (not a circle) so diagonals don't seam.
 */
export const PH_HUB_APRON = {
  padX: 4,
  padZSouth: 4,
  padZNorth: 8,
  /** Soft height falloff distance outside the apron (world units). */
  softRadius: 22,
} as const;

export function paleHollowHubApronRect(): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  return {
    minX: PH_HUB.minX - PH_HUB_APRON.padX,
    maxX: PH_HUB.maxX + PH_HUB_APRON.padX,
    minZ: PH_HUB.minZ - PH_HUB_APRON.padZSouth,
    maxZ: PH_HUB.maxZ + PH_HUB_APRON.padZNorth,
  };
}

/** Distance outside the hub apron rect (0 = inside or on edge). */
export function paleHollowHubApronDistance(x: number, z: number): number {
  const r = paleHollowHubApronRect();
  return Math.max(0, Math.max(r.minX - x, x - r.maxX, r.minZ - z, z - r.maxZ));
}

export function paleHollowInHubApron(x: number, z: number): boolean {
  return paleHollowHubApronDistance(x, z) <= 0;
}

/**
 * Party storage chest (hub) — interact stub only; full storage inventory later.
 * Visual prop lives in PaleHollowMap HubEncampment.
 */
export const PH_STORAGE_CHEST = {
  id: "npc-ph-storage",
  name: "Storage Chest",
  x: 3.2,
  z: -1.5,
} as const;

/** Soft level bands — content focus, not hard walls. */
export const PH_SEGMENT_A = { minX: -70, maxX: 70, minZ: 10, maxZ: 58 } as const;
export const PH_SEGMENT_B = { minX: -74, maxX: 74, minZ: 52, maxZ: 118 } as const;
export const PH_SEGMENT_C = { minX: -78, maxX: 78, minZ: 112, maxZ: 182 } as const;
export const PH_SEGMENT_D = { minX: -82, maxX: 82, minZ: 176, maxZ: 255 } as const;

/** Soft gates — wider crossings, recommend level, still crossable. */
export const PH_TIMBER_BRIDGE = {
  minX: -8,
  maxX: 8,
  minZ: 48,
  maxZ: 58,
  softLevel: 5,
  blocked: false,
} as const;

export const PH_QUARRY_CUT = {
  minX: -10,
  maxX: 10,
  minZ: 108,
  maxZ: 120,
  softLevel: 10,
  blocked: false,
} as const;

export const PH_SEAM_TUNNEL = {
  minX: -8,
  maxX: 8,
  minZ: 170,
  maxZ: 182,
  softLevel: 15,
  blocked: false,
} as const;

export const PH_ASH_ROAD = {
  minX: -10,
  maxX: 10,
  minZ: 252,
  maxZ: 268,
  softLevel: 18,
  blocked: true,
} as const;

/** River channel / bank-wall metrics — shared by water ribbon, walls, bridges, walkability. */
export const PH_RIVER_MAIN = {
  bankDist: 4.55,
  /** Reaches the inner wall face so the ribbon fills the channel, not a center thread. */
  waterHalf: 4.48,
  bridgeHalfSpan: 5.8,
  z0: 14,
  z1: 238,
} as const;

export const PH_RIVER_TRIB = {
  bankDist: 2.85,
  waterHalf: 2.78,
  bridgeHalfSpan: 4.0,
  z0: 42,
  z1: 152,
} as const;

/** Modular bank-wall body — keep in sync with PaleHollowRiverBanks visuals. */
export const PH_RIVER_WALL = {
  thick: 0.48,
  h: 1.05,
  lift: 0.28,
  copeH: 0.12,
  /** Extra radius so locomotion can't clip the coping. */
  collidePad: 0.35,
} as const;

/**
 * Stone deck width along flow (local X in bridge mesh).
 * Slightly wider than the rails so bank landings clear the wall annulus.
 */
export const PH_BRIDGE_DECK_W = 3.9;

/** Walk footprint pad beyond mesh half-width (forgives wall/water thresholds). */
export const PH_BRIDGE_WALK_PAD = 0.65;

/** Span extends past each bank-wall outer face onto dry grass (per side). */
export const PH_BRIDGE_SPAN_LANDING = 2.75;

/** Deck centerline clearance above the water surface at mid-span. */
export const PH_BRIDGE_DECK_CLEARANCE = 1.05;

/** Extra centerline height above wall coping where the span crosses a bank wall. */
export const PH_BRIDGE_WALL_CLEAR = 0.65;

/** Half thickness of the visual deck slab (underside = curve − this). */
export const PH_BRIDGE_DECK_HALF_T = 0.11;

/**
 * Mid-span deck Y — at least water + clearance. Ends use bank stand heights.
 */
export function paleHollowComputeBridgeDeckY(bankStandAvg: number, waterY: number): number {
  return Math.max(bankStandAvg, waterY + PH_BRIDGE_DECK_CLEARANCE);
}

/**
 * Smooth arch from left grass (t=0) to right grass (t=1).
 * `arch` is the extra height at mid-span above the straight lerp (0 at both ends).
 */
export function paleHollowBridgeCurveY(
  leftY: number,
  rightY: number,
  arch: number,
  t: number,
): number {
  const u = Math.max(0, Math.min(1, t));
  const base = leftY * (1 - u) + rightY * u;
  return base + Math.max(0, arch) * 4 * u * (1 - u);
}

export type PaleHollowRiverKind = "main" | "tributary";

export type PaleHollowBridgeSite = {
  id: string;
  river: PaleHollowRiverKind;
  /** Channel sample Z — bank→bank span is built here. */
  z: number;
};

/**
 * Stone masonry crossings at natural outbound routes from the hub encampment
 * and along the north corridor — few good spans, not mid-channel clutter.
 */
export const PH_BRIDGE_SITES: readonly PaleHollowBridgeSite[] = [
  // West farm / clay exit — chalk run west of the pad (outbound NW)
  { id: "hub-west-farm", river: "main", z: 22 },
  // North corridor — primary outbound across the chalk run into Hollow Steps
  { id: "hub-north", river: "main", z: 34 },
  // Ashbeam Reach — north corridor where the chalk run crosses center again
  { id: "ashbeam-corridor", river: "main", z: 81 },
  // Chalkworks approach — corridor crossing mid-basin
  { id: "chalkworks-corridor", river: "main", z: 150 },
  // Pale Marches — north corridor toward Ash Road
  { id: "marches-corridor", river: "main", z: 195 },
  // Hub-side east tributary — outbound toward east ashbeam / meadows
  { id: "hub-east-trib", river: "tributary", z: 72 },
  // East ashbeam tributary crossing
  { id: "ashbeam-east-trib", river: "tributary", z: 110 },
] as const;

export function paleHollowBridgeCrossings(river: PaleHollowRiverKind): number[] {
  return PH_BRIDGE_SITES.filter((s) => s.river === river).map((s) => s.z);
}

export type PaleHollowBiome =
  | "hub_indoor"
  | "terrace"
  | "farm"
  | "river"
  | "riverbank"
  | "bridge"
  | "ashbeam"
  | "scrub"
  | "quarry"
  | "vine_cliff"
  | "ore_seam"
  | "crypt"
  | "ash_road"
  | "grass"
  | "mountain"
  | "meadow";

export type PaleHollowSegmentId = "hub" | "a" | "b" | "c" | "d";

export function paleHollowSegment(x: number, z: number): PaleHollowSegmentId {
  if (z <= PH_HUB.maxZ && x >= PH_HUB.minX && x <= PH_HUB.maxX) return "hub";
  if (z < 55) return "a";
  if (z < 115) return "b";
  if (z < 178) return "c";
  return "d";
}

function inRect(
  x: number,
  z: number,
  r: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

function smooth01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** Mountain / ridge peaks for open-world silhouette (ring around the basin). */
export const PH_MOUNTAINS: { x: number; z: number; r: number; h: number }[] = [
  { x: -62, z: 30, r: 18, h: 7.5 },
  { x: 58, z: 42, r: 16, h: 6.8 },
  { x: -78, z: 70, r: 15, h: 6.2 },
  { x: 74, z: 65, r: 14, h: 5.8 },
  { x: -70, z: 95, r: 20, h: 8.2 },
  { x: 68, z: 88, r: 18, h: 7.0 },
  { x: -75, z: 130, r: 16, h: 7.4 },
  { x: 72, z: 125, r: 15, h: 6.9 },
  { x: -55, z: 155, r: 22, h: 9.0 },
  { x: 60, z: 160, r: 20, h: 8.5 },
  { x: -48, z: 220, r: 18, h: 7.2 },
  { x: 52, z: 230, r: 16, h: 6.5 },
  { x: 0, z: -14, r: 22, h: 5.5 },
  { x: -40, z: 250, r: 14, h: 6.0 },
  { x: 38, z: 255, r: 14, h: 5.8 },
];

function riverCenterX(z: number): number {
  return -22 + Math.sin((z - 20) * 0.11) * 28 + Math.sin((z - 40) * 0.05) * 12;
}

/** East tributary — thinner stream that joins the chalk run mid-basin. */
function tributaryCenterX(z: number): number {
  return 34 + Math.sin((z - 60) * 0.09) * 10;
}

/** Shared with client water ribbon / shore foam. */
export function paleHollowRiverCenterX(z: number): number {
  return riverCenterX(z);
}

export function paleHollowTributaryCenterX(z: number): number {
  return tributaryCenterX(z);
}

/** Soft-gate / terrain biomes — excludes river stone-bridge footprints. */
function paleHollowBiomeCore(x: number, z: number): PaleHollowBiome {
  if (x >= PH_HUB.minX && x <= PH_HUB.maxX && z >= PH_HUB.minZ && z <= PH_HUB.maxZ) {
    return "hub_indoor";
  }
  if (inRect(x, z, PH_TIMBER_BRIDGE) || inRect(x, z, PH_QUARRY_CUT) || inRect(x, z, PH_SEAM_TUNNEL)) {
    return "bridge";
  }
  if (inRect(x, z, PH_ASH_ROAD)) return "ash_road";

  for (const m of PH_MOUNTAINS) {
    if (Math.hypot(x - m.x, z - m.z) < m.r * 0.55) return "mountain";
  }

  // Main chalk run — wide meander with soft banks
  {
    const dx = Math.abs(x - riverCenterX(z));
    if (z > 12 && z < 242 && dx < 6.8) return "river";
    if (z > 12 && z < 242 && dx < 14.5) return "riverbank";
  }
  // East tributary
  {
    const dx = Math.abs(x - tributaryCenterX(z));
    if (z > 55 && z < 150 && dx < 4.2) return "river";
    if (z > 55 && z < 150 && dx < 9.5) return "riverbank";
  }

  // Segment A — wide farm terraces + meadow flanks (room to roam east/west)
  if (z > 10 && z < 50) {
    if (Math.abs(x) < 32) return "farm";
    if (Math.abs(x) < 58) return "meadow";
    return "grass";
  }

  // Segment B — scattered ashbeam groves in open grassland
  if (z >= 50 && z < 112) {
    const groveA = Math.hypot(x + 6, z - 82);
    const groveB = Math.hypot(x - 38, z - 70);
    const groveC = Math.hypot(x + 42, z - 98);
    if (groveA < 28 || groveB < 18 || groveC < 16) return "ashbeam";
    if (Math.abs(x) > 62) return "scrub";
    return "grass";
  }

  // Segment C — quarry bowl is a landmark; meadows fill the rest
  if (z >= 112 && z < 178) {
    const qd = Math.hypot(x, z - 145);
    if (qd < 26) return "quarry";
    if (Math.abs(x) > 60) return "vine_cliff";
    if (qd < 38) return "scrub";
    if (Math.hypot(x - 36, z - 130) < 14) return "ashbeam";
    return "grass";
  }

  // Segment D — ore pockets in scrub/grass marches
  if (Math.hypot(x + 18, z - 210) < 14) return "crypt";
  if (z > 240) return "ash_road";
  if (Math.abs(x) < 38 && z > 185) return "ore_seam";
  if (Math.abs(x) < 55) return "grass";
  return "scrub";
}

export function paleHollowBiome(x: number, z: number): PaleHollowBiome {
  if (paleHollowOnBridge(x, z)) return "bridge";
  return paleHollowBiomeCore(x, z);
}

type BridgeFrame = {
  id: string;
  river: PaleHollowRiverKind;
  z: number;
  cx: number;
  cz: number;
  sx: number;
  sz: number;
  fx: number;
  fz: number;
  spanHalf: number;
  deckHalfW: number;
  leftY: number;
  rightY: number;
  waterY: number;
  /** Extra mid-span height above the left→right lerp. */
  arch: number;
  /** Mid curve sample — not the stand height along the span. */
  deckY: number;
};

function riverParams(river: PaleHollowRiverKind) {
  return river === "main" ? PH_RIVER_MAIN : PH_RIVER_TRIB;
}

function riverCenterFn(river: PaleHollowRiverKind): (z: number) => number {
  return river === "main" ? riverCenterX : tributaryCenterX;
}

/** Bank midline sample — same geometry as PaleHollowRiverBanks.bankPoint. */
export function paleHollowBankPoint(
  river: PaleHollowRiverKind,
  z: number,
  side: 1 | -1,
): { x: number; z: number } {
  const centerX = riverCenterFn(river);
  const bankDist = riverParams(river).bankDist;
  const eps = 0.85;
  const c0 = centerX(z - eps);
  const c1 = centerX(z + eps);
  const tx = c1 - c0;
  const tz = eps * 2;
  const tLen = Math.hypot(tx, tz) || 1;
  const px = -tz / tLen;
  const pz = tx / tLen;
  return {
    x: centerX(z) + side * bankDist * px,
    z: z + side * bankDist * pz,
  };
}

/** Shared bridge layout — visuals and walk/stand must agree. */
export type PaleHollowBridgeGeom = {
  id: string;
  river: PaleHollowRiverKind;
  z: number;
  x: number;
  zWorld: number;
  span: number;
  spanHalf: number;
  deckHalfW: number;
  /** Mid-span curve height (arch / legacy). Stand height varies — see `paleHollowBridgeCurveY`. */
  deckY: number;
  /** Left grass stand height (t=0). */
  leftY: number;
  /** Right grass stand height (t=1). */
  rightY: number;
  /** Extra height at mid-span above the straight lerp. */
  arch: number;
  waterY: number;
  spanDir: { x: number; z: number };
  flowDir: { x: number; z: number };
  postL: { x: number; z: number; y: number };
  postR: { x: number; z: number; y: number };
};

function isBridgeLandingDry(x: number, z: number): boolean {
  if (paleHollowWaterSurfaceY(x, z) != null) return false;
  if (paleHollowBiomeCore(x, z) === "river") return false;
  return true;
}

/**
 * Walk outward from a bank wall midline onto dry grass well outside the wall.
 * The deck ends here so the arch can rise before it crosses the coping.
 */
function findBankLanding(
  river: PaleHollowRiverKind,
  z: number,
  side: 1 | -1,
  ux: number,
  uz: number,
): { x: number; z: number; y: number } {
  const wall = paleHollowBankPoint(river, z, side);
  const wallY = paleHollowHeightField(wall.x, wall.z);
  /** Past the wall midline onto the grass apron. */
  const minOut = 2.5;
  let best = {
    x: wall.x + ux * minOut,
    z: wall.z + uz * minOut,
    y: paleHollowHeightField(wall.x + ux * minOut, wall.z + uz * minOut),
  };

  for (let t = minOut; t <= 9; t += 0.25) {
    const x = wall.x + ux * t;
    const z = wall.z + uz * t;
    if (!isBridgeLandingDry(x, z)) continue;
    if (paleHollowRiverWallBand(x, z)) continue;
    const y = paleHollowHeightField(x, z);
    if (y < wallY - 0.55) continue;
    best = { x, z, y };
    const bio = paleHollowBiomeCore(x, z);
    if (bio === "farm" || bio === "meadow" || bio === "grass" || bio === "ashbeam") break;
  }
  return best;
}

/** Coping top at a bank-wall midline. */
function riverWallTopY(x: number, z: number): number {
  return paleHollowHeightField(x, z) + PH_RIVER_WALL.lift + PH_RIVER_WALL.h + PH_RIVER_WALL.copeH;
}

/**
 * Arch lift so the deck center clears water at mid-span and coping at each wall crossing.
 * Shape is `lerp + arch * 4 t (1-t)` (0 at the grass ends).
 */
function bridgeArchLift(
  leftY: number,
  rightY: number,
  checks: { t: number; minY: number }[],
): number {
  let arch = 1.05;
  for (const c of checks) {
    const u = Math.max(0.06, Math.min(0.94, c.t));
    const bump = 4 * u * (1 - u);
    const base = leftY * (1 - u) + rightY * u;
    const need = (c.minY - base) / bump;
    if (need > arch) arch = need;
  }
  return arch;
}

/**
 * Authoritative bridge geometry for a site (deck Y, footprint, bank→bank axes).
 * RiverBanks meshes and walk frames both derive from this.
 */
export function paleHollowBridgeGeom(site: PaleHollowBridgeSite): PaleHollowBridgeGeom {
  const params = riverParams(site.river);
  const centerX = riverCenterFn(site.river);
  const left = paleHollowBankPoint(site.river, site.z, -1);
  const right = paleHollowBankPoint(site.river, site.z, 1);
  let sx = right.x - left.x;
  let sz = right.z - left.z;
  const bankSep = Math.hypot(sx, sz) || 1;
  sx /= bankSep;
  sz /= bankSep;

  const eps = 1.2;
  const tx = centerX(site.z + eps) - centerX(site.z - eps);
  const tz = eps * 2;

  // Outward from channel through each bank (along span axis)
  let landL = findBankLanding(site.river, site.z, -1, -sx, -sz);
  let landR = findBankLanding(site.river, site.z, 1, sx, sz);

  // Ends ARE the landings — never overshoot past dry grass into wall/channel
  let lsx = landR.x - landL.x;
  let lsz = landR.z - landL.z;
  let span = Math.hypot(lsx, lsz) || bankSep;
  lsx /= span;
  lsz /= span;

  const minSpan = Math.max(
    params.bridgeHalfSpan * 2,
    bankSep + 2 * (PH_RIVER_WALL.thick * 0.5 + PH_BRIDGE_SPAN_LANDING),
  );
  // Only widen toward minSpan if the extended ends stay dry / elevated
  if (span < minSpan - 0.05) {
    const midX = (landL.x + landR.x) * 0.5;
    const midZ = (landL.z + landR.z) * 0.5;
    const half = minSpan * 0.5;
    const candL = { x: midX - lsx * half, z: midZ - lsz * half };
    const candR = { x: midX + lsx * half, z: midZ + lsz * half };
    const yL = paleHollowHeightField(candL.x, candL.z);
    const yR = paleHollowHeightField(candR.x, candR.z);
    const okL =
      isBridgeLandingDry(candL.x, candL.z) &&
      !paleHollowRiverWallBand(candL.x, candL.z) &&
      yL >= landL.y - 0.55;
    const okR =
      isBridgeLandingDry(candR.x, candR.z) &&
      !paleHollowRiverWallBand(candR.x, candR.z) &&
      yR >= landR.y - 0.55;
    if (okL && okR) {
      landL = { ...candL, y: yL };
      landR = { ...candR, y: yR };
      span = minSpan;
    }
  }

  const spanHalf = span * 0.5;
  const deckHalfW = PH_BRIDGE_DECK_W * 0.5 + PH_BRIDGE_WALK_PAD;
  const cx = (landL.x + landR.x) * 0.5;
  const cz = (landL.z + landR.z) * 0.5;
  const lx = landL.x;
  const lz = landL.z;
  const rx = landR.x;
  const rz = landR.z;

  // Along-flow from span axis, matched to channel tangent
  let nfx = -lsz;
  let nfz = lsx;
  if (nfx * tx + nfz * tz < 0) {
    nfx = -nfx;
    nfz = -nfz;
  }
  const nfLen = Math.hypot(nfx, nfz) || 1;
  nfx /= nfLen;
  nfz /= nfLen;

  const waterY =
    paleHollowWaterSurfaceY(cx, cz) ?? paleHollowHeightField(cx, cz) + PALE_HOLLOW_WATER_CLEARANCE;
  const standL = landL.y;
  const standR = landR.y;
  const tOf = (x: number, z: number) => {
    const along = (x - cx) * lsx + (z - cz) * lsz;
    return span > 1e-4 ? along / span + 0.5 : 0.5;
  };
  const undersidePad = PH_BRIDGE_DECK_HALF_T + PH_BRIDGE_WALL_CLEAR;
  const checks: { t: number; minY: number }[] = [
    { t: 0.5, minY: waterY + PH_BRIDGE_DECK_CLEARANCE },
  ];
  const tL = tOf(left.x, left.z);
  const tR = tOf(right.x, right.z);
  if (tL > 0.04 && tL < 0.96) {
    checks.push({ t: tL, minY: riverWallTopY(left.x, left.z) + undersidePad });
  }
  if (tR > 0.04 && tR < 0.96) {
    checks.push({ t: tR, minY: riverWallTopY(right.x, right.z) + undersidePad });
  }
  const arch = bridgeArchLift(standL, standR, checks);
  const deckY = paleHollowBridgeCurveY(standL, standR, arch, 0.5);

  return {
    id: site.id,
    river: site.river,
    z: site.z,
    x: cx,
    zWorld: cz,
    span,
    spanHalf,
    deckHalfW,
    deckY,
    leftY: standL,
    rightY: standR,
    arch,
    waterY,
    spanDir: { x: lsx, z: lsz },
    flowDir: { x: nfx, z: nfz },
    postL: { x: lx, z: lz, y: standL },
    postR: { x: rx, z: rz, y: standR },
  };
}

export const PH_TRAIL_WIDTH = 3.3;
export const PH_TRAIL_STONE_WIDTH = 3.45;

export type PaleHollowTrail = {
  id: string;
  surface: "dirt" | "stone";
  bridgeId?: string;
  points: { x: number; z: number }[];
};

function trailBridge(id: string): PaleHollowBridgeGeom {
  const site = PH_BRIDGE_SITES.find((s) => s.id === id);
  if (!site) throw new Error(`missing bridge ${id}`);
  return paleHollowBridgeGeom(site);
}

/** Point on the grass just outside a landing, away from the channel. */
function trailApproach(post: { x: number; z: number }, center: { x: number; z: number }, dist = 3.6) {
  let dx = post.x - center.x;
  let dz = post.z - center.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const clear = (ux: number, uz: number) => {
    for (let t = 0.7; t <= dist; t += 0.35) {
      if (!paleHollowWalkable(post.x + ux * t, post.z + uz * t)) return false;
    }
    return true;
  };
  const angles = [0, 28, -28, 55, -55, 85, -85, 120, -120, 160, 180];
  for (const deg of angles) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ux = dx * c - dz * s;
    const uz = dx * s + dz * c;
    if (clear(ux, uz)) return { x: post.x + ux * dist, z: post.z + uz * dist };
  }
  return { x: post.x + dx * 1.2, z: post.z + dz * 1.2 };
}

/** Stay on the same bank as `anchorX` while walking toward a goal. */
function dryTrail(points: { x: number; z: number }[]): { x: number; z: number }[] {
  const bankOf = (x: number, z: number, anchorX: number) => {
    const main = riverCenterX(z);
    const trib = tributaryCenterX(z);
    const useTrib = z > 54 && z < 150 && Math.abs(anchorX - trib) < Math.abs(anchorX - main);
    const rx = useTrib ? trib : main;
    const sign = anchorX >= rx ? 1 : -1;
    const edge = rx + sign * 8;
    let nx = x;
    if (sign > 0 && nx < edge) nx = edge;
    if (sign < 0 && nx > edge) nx = edge;
    if (!paleHollowWalkable(nx, z)) {
      for (let k = 1; k <= 10; k++) {
        const tryX = nx + sign * k * 1.2;
        if (paleHollowWalkable(tryX, z)) return { x: tryX, z };
      }
    }
    return paleHollowWalkable(nx, z) ? { x: nx, z } : null;
  };

  const chordOk = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(2, Math.ceil(dist / 0.45));
    for (let s = 1; s < n; s++) {
      const u = s / n;
      if (!paleHollowWalkable(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u)) return false;
    }
    return true;
  };

  const out: { x: number; z: number }[] = [];
  const push = (p: { x: number; z: number }) => {
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      return;
    }
    if (Math.hypot(last.x - p.x, last.z - p.z) < 0.9) return;
    if (!chordOk(last, p)) return;
    out.push(p);
  };

  let cursor = points[0]!;
  if (!paleHollowWalkable(cursor.x, cursor.z)) {
    const fixed = bankOf(cursor.x, cursor.z, cursor.x);
    if (fixed) cursor = fixed;
  }
  push(cursor);

  const stepTo = (from: { x: number; z: number }, x: number, z: number) => {
    const hit = bankOf(x, z, from.x);
    if (hit && chordOk(from, hit)) return hit;
    return null;
  };

  for (let i = 1; i < points.length; i++) {
    const goal = points[i]!;
    for (let guard = 0; guard < 80; guard++) {
      const dx = goal.x - cursor.x;
      const dz = goal.z - cursor.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.6 && paleHollowWalkable(goal.x, goal.z) && chordOk(cursor, goal)) {
        push(goal);
        cursor = goal;
        break;
      }
      const step = Math.min(1.25, dist);
      const ux = dx / (dist || 1);
      const uz = dz / (dist || 1);
      const ahead = stepTo(cursor, cursor.x + ux * step, cursor.z + uz * step);
      if (ahead) {
        push(ahead);
        cursor = ahead;
        continue;
      }
      const zStep = stepTo(cursor, cursor.x, cursor.z + Math.sign(dz || 1) * 1.1);
      if (zStep) {
        push(zStep);
        cursor = zStep;
        continue;
      }
      const main = riverCenterX(cursor.z);
      const sign = cursor.x >= main ? 1 : -1;
      const side = stepTo(cursor, cursor.x + sign * 1.3, cursor.z + Math.sign(dz || 1) * 0.6);
      if (side) {
        push(side);
        cursor = side;
        continue;
      }
      break;
    }
  }
  return out.length >= 2 ? out : points;
}

function stoneApproach(id: string, end: "L" | "R", g: PaleHollowBridgeGeom): PaleHollowTrail {
  const post = end === "L" ? g.postL : g.postR;
  let outer = trailApproach(post, { x: g.x, z: g.zWorld });
  for (let k = 0; k < 8; k++) {
    let ok = true;
    for (let s = 1; s < 14; s++) {
      const u = s / 14;
      const x = outer.x + (post.x - outer.x) * u;
      const z = outer.z + (post.z - outer.z) * u;
      if (!paleHollowWalkable(x, z)) {
        ok = false;
        break;
      }
    }
    if (ok) break;
    outer = {
      x: outer.x + (post.x - outer.x) * 0.22,
      z: outer.z + (post.z - outer.z) * 0.22,
    };
  }
  return {
    id: `${id}-stone-${end}`,
    surface: "stone",
    bridgeId: id,
    points: [outer, { x: post.x, z: post.z }],
  };
}

/**
 * Packed-dirt corridors from the scout encampment onto each bridge landing,
 * then onward along the north and east corridors. Stone stubs meet the decks.
 */
export function paleHollowTrails(): PaleHollowTrail[] {
  const west = trailBridge("hub-west-farm");
  const north = trailBridge("hub-north");
  const ash = trailBridge("ashbeam-corridor");
  const chalk = trailBridge("chalkworks-corridor");
  const marches = trailBridge("marches-corridor");
  const east = trailBridge("hub-east-trib");
  const eastAsh = trailBridge("ashbeam-east-trib");

  const near = (g: PaleHollowBridgeGeom, end: "L" | "R") =>
    trailApproach(end === "L" ? g.postL : g.postR, { x: g.x, z: g.zWorld });

  const raw: PaleHollowTrail[] = [
    {
      id: "camp-to-north",
      surface: "dirt",
      points: [
        { x: 0, z: 8 },
        { x: 3, z: 16 },
        { x: 8, z: 24 },
        near(north, "L"),
      ],
    },
    {
      id: "camp-to-west-farm",
      surface: "dirt",
      points: [
        { x: -4, z: 8 },
        { x: -14, z: 11 },
        { x: -20, z: 13 },
        near(west, "L"),
      ],
    },
    {
      id: "west-farm-onward",
      surface: "dirt",
      points: [near(west, "R"), { x: -34, z: 38 }, { x: -46, z: 44 }],
    },
    {
      id: "north-to-ashbeam",
      surface: "dirt",
      points: [near(north, "R"), { x: -16, z: 58 }, { x: -18, z: 78 }, near(ash, "R")],
    },
    {
      id: "ashbeam-to-chalkworks",
      surface: "dirt",
      points: [near(ash, "L"), { x: 16, z: 108 }, { x: 18, z: 132 }, near(chalk, "L")],
    },
    {
      id: "chalkworks-to-marches",
      surface: "dirt",
      points: [near(chalk, "R"), { x: -24, z: 168 }, { x: -20, z: 188 }, near(marches, "R")],
    },
    {
      id: "marches-to-ash-road",
      surface: "dirt",
      points: [near(marches, "L"), { x: 14, z: 214 }, { x: 10, z: 232 }, { x: 6, z: 246 }],
    },
    {
      id: "camp-to-east-trib",
      surface: "dirt",
      points: [
        { x: 10, z: 6 },
        { x: 20, z: 24 },
        { x: 24, z: 44 },
        near(east, "R"),
      ],
    },
    {
      id: "east-trib-to-ashbeam",
      surface: "dirt",
      points: [near(east, "L"), { x: 46, z: 90 }, near(eastAsh, "L")],
    },
    {
      id: "east-ashbeam-grove",
      surface: "dirt",
      points: [near(eastAsh, "R"), { x: 10, z: 116 }],
    },
    stoneApproach("hub-north", "L", north),
    stoneApproach("hub-north", "R", north),
    stoneApproach("hub-west-farm", "L", west),
    stoneApproach("hub-west-farm", "R", west),
    stoneApproach("ashbeam-corridor", "L", ash),
    stoneApproach("ashbeam-corridor", "R", ash),
    stoneApproach("chalkworks-corridor", "L", chalk),
    stoneApproach("chalkworks-corridor", "R", chalk),
    stoneApproach("marches-corridor", "L", marches),
    stoneApproach("marches-corridor", "R", marches),
    stoneApproach("hub-east-trib", "L", east),
    stoneApproach("hub-east-trib", "R", east),
    stoneApproach("ashbeam-east-trib", "L", eastAsh),
    stoneApproach("ashbeam-east-trib", "R", eastAsh),
  ];
  return raw.map((t) => (t.surface === "dirt" ? { ...t, points: dryTrail(t.points) } : t));
}

function buildBridgeFrame(site: PaleHollowBridgeSite): BridgeFrame {
  const g = paleHollowBridgeGeom(site);
  return {
    id: g.id,
    river: g.river,
    z: g.z,
    cx: g.x,
    cz: g.zWorld,
    sx: g.spanDir.x,
    sz: g.spanDir.z,
    fx: g.flowDir.x,
    fz: g.flowDir.z,
    spanHalf: g.spanHalf,
    deckHalfW: g.deckHalfW,
    leftY: g.leftY,
    rightY: g.rightY,
    waterY: g.waterY,
    arch: g.arch,
    deckY: g.deckY,
  };
}

let bridgeFrameCache: BridgeFrame[] | null = null;
let bridgeFramesBuilding = false;

function bridgeFrames(): BridgeFrame[] {
  if (bridgeFrameCache) return bridgeFrameCache;
  if (bridgeFramesBuilding) return [];
  bridgeFramesBuilding = true;
  try {
    bridgeFrameCache = PH_BRIDGE_SITES.map(buildBridgeFrame);
  } finally {
    bridgeFramesBuilding = false;
  }
  return bridgeFrameCache;
}

function bridgeLocal(f: BridgeFrame, x: number, z: number): { along: number; across: number } {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return {
    along: dx * f.sx + dz * f.sz,
    across: dx * f.fx + dz * f.fz,
  };
}

/** True when standing on a stone bridge deck (bank→bank footprint). */
export function paleHollowOnBridge(x: number, z: number): boolean {
  for (const f of bridgeFrames()) {
    const { along, across } = bridgeLocal(f, x, z);
    if (Math.abs(along) <= f.spanHalf && Math.abs(across) <= f.deckHalfW) return true;
  }
  return false;
}

/**
 * Expanded bridge footprint for carving water ribbon gaps (slightly larger than walk).
 * Prefer punching water under decks so the mesh never draws through the crossing.
 */
export function paleHollowInBridgeWaterGap(
  x: number,
  z: number,
  river?: PaleHollowRiverKind,
): boolean {
  const padAlong = 0.5;
  const padAcross = 0.6;
  for (const f of bridgeFrames()) {
    if (river && f.river !== river) continue;
    const { along, across } = bridgeLocal(f, x, z);
    if (Math.abs(along) <= f.spanHalf + padAlong && Math.abs(across) <= f.deckHalfW + padAcross) {
      return true;
    }
  }
  return false;
}

/**
 * Wall mesh opens only where the deck underside still cuts the coping.
 * A span that clears the wall keeps the wall continuous.
 */
export function paleHollowInBridgeWallVisualGap(
  x: number,
  z: number,
  river?: PaleHollowRiverKind,
): boolean {
  const halfAcross = PH_BRIDGE_DECK_W * 0.5 + 0.08;
  for (const f of bridgeFrames()) {
    if (river && f.river !== river) continue;
    const { along, across } = bridgeLocal(f, x, z);
    if (Math.abs(across) > halfAcross || Math.abs(along) > f.spanHalf) continue;
    const t = f.spanHalf > 1e-4 ? (along / f.spanHalf + 1) * 0.5 : 0.5;
    const underside =
      paleHollowBridgeCurveY(f.leftY, f.rightY, f.arch, t) - PH_BRIDGE_DECK_HALF_T;
    const coping =
      paleHollowHeightField(x, z) + PH_RIVER_WALL.lift + PH_RIVER_WALL.h + PH_RIVER_WALL.copeH;
    if (underside < coping + 0.08) return true;
  }
  return false;
}

/** Deck world Y if on a bridge, else null. Varies along the span (bank → arch → bank). */
export function paleHollowBridgeDeckY(x: number, z: number): number | null {
  for (const f of bridgeFrames()) {
    const { along, across } = bridgeLocal(f, x, z);
    if (Math.abs(along) <= f.spanHalf && Math.abs(across) <= f.deckHalfW) {
      const t = f.spanHalf > 1e-4 ? (along / f.spanHalf + 1) * 0.5 : 0.5;
      return paleHollowBridgeCurveY(f.leftY, f.rightY, f.arch, t);
    }
  }
  return null;
}

/**
 * Wall annulus around a channel, ignoring bridge decks.
 * Landings use this so a span cannot stop inside the coping.
 */
function paleHollowRiverWallBand(x: number, z: number): boolean {
  const solid = PH_RIVER_WALL.thick * 0.5 + PH_RIVER_WALL.collidePad;
  const hit = (river: PaleHollowRiverKind, z0: number, z1: number) => {
    if (z < z0 - 2 || z > z1 + 2) return false;
    const centerX = riverCenterFn(river);
    const bankDist = riverParams(river).bankDist;
    const eps = 0.85;
    const cx = centerX(z);
    const tx = centerX(z + eps) - centerX(z - eps);
    const tz = eps * 2;
    const tLen = Math.hypot(tx, tz) || 1;
    const fx = tx / tLen;
    const fz = tz / tLen;
    const rx = x - cx;
    const along = rx * fx;
    const qx = cx + along * fx;
    const qz = z + along * fz;
    const dist = Math.hypot(x - qx, z - qz);
    return Math.abs(dist - bankDist) <= solid;
  };
  if (hit("main", PH_RIVER_MAIN.z0, PH_RIVER_MAIN.z1)) return true;
  if (hit("tributary", PH_RIVER_TRIB.z0, PH_RIVER_TRIB.z1)) return true;
  if (culdesacWall(riverCenterX, PH_RIVER_MAIN.z0, PH_RIVER_MAIN.bankDist, -1, x, z)) return true;
  if (culdesacWall(riverCenterX, PH_RIVER_MAIN.z1, PH_RIVER_MAIN.bankDist, 1, x, z)) return true;
  if (culdesacWall(tributaryCenterX, PH_RIVER_TRIB.z0, PH_RIVER_TRIB.bankDist, -1, x, z)) return true;
  if (culdesacWall(tributaryCenterX, PH_RIVER_TRIB.z1, PH_RIVER_TRIB.bankDist, 1, x, z)) return true;
  return false;
}

/** Rounded end wall: semicircle of radius `bankDist` bulging out of the channel. */
function culdesacWall(
  centerX: (z: number) => number,
  zEnd: number,
  bankDist: number,
  outward: 1 | -1,
  x: number,
  z: number,
): boolean {
  const solid = PH_RIVER_WALL.thick * 0.5 + PH_RIVER_WALL.collidePad;
  const eps = 0.85;
  const tx = centerX(zEnd + eps) - centerX(zEnd - eps);
  const tz = eps * 2;
  const tLen = Math.hypot(tx, tz) || 1;
  const fx = (tx / tLen) * outward;
  const fz = (tz / tLen) * outward;
  const cx = centerX(zEnd);
  const dx = x - cx;
  const dz = z - zEnd;
  const out = dx * fx + dz * fz;
  if (out < -0.4) return false;
  const radial = Math.hypot(dx, dz);
  return Math.abs(radial - bankDist) <= solid;
}

/**
 * True when overlapping a modular river bank wall (not on a bridge deck).
 * Walls sit at `bankDist` from the local channel centerline at this Z.
 */
export function paleHollowInRiverWall(x: number, z: number): boolean {
  if (paleHollowOnBridge(x, z)) return false;
  return paleHollowRiverWallBand(x, z);
}

/**
 * Clear walkable check: dry land OR on-bridge; reject open water and river walls.
 * Soft-gate landmark "bridge" biomes are dry land and remain walkable.
 */
export function paleHollowWalkable(x: number, z: number): boolean {
  if (paleHollowInHubRearWall(x, z)) return false;
  if (paleHollowOnBridge(x, z)) return true;
  if (paleHollowInOpenWater(x, z)) return false;
  if (paleHollowInRiverWall(x, z)) return false;
  if (paleHollowBiomeCore(x, z) === "river") return false;
  return true;
}

/**
 * Clamp a desired move so the path cannot enter water or river walls.
 * Stops at the last walkable sample along the segment (bridges remain passable).
 */
export function paleHollowClampMove(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): { x: number; z: number } {
  const end = clampPaleHollow(toX, toZ);
  const fromWalk = paleHollowWalkable(fromX, fromZ);
  if (!fromWalk && paleHollowWalkable(end.x, end.z)) {
    return end;
  }
  const dist = Math.hypot(end.x - fromX, end.z - fromZ);
  if (dist < 1e-4) return { x: fromX, z: fromZ };
  const steps = Math.max(1, Math.ceil(dist / 0.3));
  let last = { x: fromX, z: fromZ };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const c = clampPaleHollow(fromX + (end.x - fromX) * t, fromZ + (end.z - fromZ) * t);
    if (!paleHollowWalkable(c.x, c.z)) return last;
    last = c;
  }
  return last;
}

/**
 * Open height field — continuous soft hills; no hard canyon clamps.
 * (Hard Math.min river floors caused the canal cliffs in-game.)
 * Does not apply stone-bridge deck elevation (see `paleHollowHeight`).
 */
function paleHollowHeightField(x: number, z: number): number {
  const biome = paleHollowBiomeCore(x, z);
  if (biome === "hub_indoor") return PH_HUB.floorY;

  // Long, gentle ramp off the dwellings into the basin (both Z and shared apron SDF)
  const fromHubZ = smooth01((z - PH_HUB.maxZ + 2) / 40);
  const fromHubPad = smooth01(paleHollowHubApronDistance(x, z) / PH_HUB_APRON.softRadius);
  const leaveHub = Math.max(fromHubZ, fromHubPad);
  let y = PH_HUB.floorY * (1 - leaveHub) + 1.05 * leaveHub;

  // Multi-octave rolling basin — readable hills without stair walls
  y += Math.sin(x * 0.026) * 0.62 + Math.cos(z * 0.021) * 0.48;
  y += Math.sin(x * 0.062 + z * 0.048) * 0.28;
  y += Math.sin(x * 0.14 - z * 0.11) * 0.1;
  y += Math.sin(x * 0.31 + z * 0.27) * 0.035;

  // Channel distances before hills, so a lobe cannot lift the bed the water sits on.
  // `|x - centerX(z)|` misses the north meander (flow runs east-west around z 224–236).
  const mainNear = nearestOnCenterline(riverCenterX, PH_RIVER_MAIN.z0, PH_RIVER_MAIN.z1, x, z);
  const tribNear = nearestOnCenterline(tributaryCenterX, PH_RIVER_TRIB.z0, PH_RIVER_TRIB.z1, x, z);
  const mountainKeep = (dist: number, bankDist: number) => {
    const inner = bankDist + 0.6;
    const outer = inner + 8;
    if (dist <= inner) return 0;
    if (dist >= outer) return 1;
    return smooth01((dist - inner) / (outer - inner));
  };
  let mountainScale = 1;
  if (mainNear) mountainScale = Math.min(mountainScale, mountainKeep(mainNear.dist, PH_RIVER_MAIN.bankDist));
  if (tribNear) mountainScale = Math.min(mountainScale, mountainKeep(tribNear.dist, PH_RIVER_TRIB.bankDist));

  // Soft mountain lobes — faded inside the channel so water does not ride the hillside.
  if (mountainScale > 0) {
    for (const m of PH_MOUNTAINS) {
      const d = Math.hypot(x - m.x, z - m.z);
      const R = m.r * 1.2;
      if (d < R) {
        const t = 1 - d / R;
        y += smooth01(t) * smooth01(t) * m.h * 0.82 * mountainScale;
      }
    }
  }

  // Gentle world rim
  const rim = Math.min(
    x - PALE_HOLLOW_BOUNDS.minX,
    PALE_HOLLOW_BOUNDS.maxX - x,
    z - PALE_HOLLOW_BOUNDS.minZ,
    PALE_HOLLOW_BOUNDS.maxZ - z,
  );
  if (rim < 18) {
    y += (1 - smooth01(rim / 18)) ** 2 * 2.2;
  }

  // Smooth channel trough (not a hard floor). Deepest on the centerline, gone
  // before the wall footing, so arches have a bed under them and banks stay grass.
  const channelTrough = (rd: number, bankDist: number, depth: number) => {
    const lip = bankDist * 0.9;
    if (rd >= lip) return 0;
    const s = smooth01(1 - rd / lip);
    return s * s * depth;
  };
  if (mainNear) {
    y -= channelTrough(mainNear.dist, PH_RIVER_MAIN.bankDist, 1.35);
    const bank = 1 - Math.min(1, mainNear.dist / 14);
    y -= smooth01(bank) * 0.1;
  }
  if (tribNear) {
    y -= channelTrough(tribNear.dist, PH_RIVER_TRIB.bankDist, 1.15);
    const bank = 1 - Math.min(1, tribNear.dist / 9.5);
    y -= smooth01(bank) * 0.08;
  }

  // Micro-detail — continuous weights only (hard biome branches made thin border creases)
  {
    const tw = paleHollowTerrainWeights(x, z);
    y +=
      Math.sin(x * 0.18) * 0.055 +
      Math.cos(z * 0.14) * 0.04 +
      Math.sin(x * 0.31 + z * 0.22) * 0.02;
    y += (Math.sin(x * 0.22) * 0.04 + Math.cos(z * 0.18) * 0.03) * Math.max(tw.farm, tw.meadow);
    y += Math.sin(x * 0.2) * 0.06 * tw.scrub;
    y += Math.sin(x * 0.18 + z * 0.1) * 0.12 * tw.ore;
    y -= tw.quarry * tw.quarry * 1.6;
    const oreBump = Math.hypot(x - 14, z - 200);
    if (oreBump < 14) y += smooth01(1 - oreBump / 14) * 0.85 * tw.ore;
  }

  if (biome === "bridge") {
    if (z >= PH_QUARRY_CUT.minZ && z <= PH_QUARRY_CUT.maxZ) y += 0.55;
    else if (z >= PH_SEAM_TUNNEL.minZ && z <= PH_SEAM_TUNNEL.maxZ) y += 0.35;
    else y += 0.4;
  } else if (biome === "vine_cliff") {
    y += 0.85 + Math.sin(z * 0.15) * 0.2;
  } else if (biome === "crypt") {
    y -= 0.55 + Math.sin(x * 0.35) * 0.04;
  } else if (biome === "ash_road") {
    y = Math.max(y, 0.85);
  }

  // Copper outcrop — soft bump
  {
    const d = Math.hypot(x - 18, z - 26);
    if (d < 7) y += smooth01(1 - d / 7) ** 1.5 * 0.7;
  }

  return y;
}

/** Terrain and bank footings. Never the stone deck — the deck is a span over this bed. */
export function paleHollowGroundHeight(x: number, z: number): number {
  return paleHollowHeightField(x, z);
}

/** Stand height — stone bridge decks sit at bank wall-tops; elsewhere the terrain field. */
export function paleHollowHeight(x: number, z: number): number {
  const deck = paleHollowBridgeDeckY(x, z);
  if (deck != null) return deck;
  return paleHollowHeightField(x, z);
}

/**
 * Terrain PlaneGeometry segments in PaleHollowMap (`widthSegments`, `heightSegments`).
 * `paleHollowStandHeight` barycentric-samples this same grid.
 */
export const PALE_HOLLOW_TERRAIN_SEG_X = 72;
export const PALE_HOLLOW_TERRAIN_SEG_Z = Math.floor(PALE_HOLLOW_TERRAIN_SEG_X * 1.35);

/**
 * Height of the rendered terrain triangle at (x, z).
 * The mesh is piecewise-linear; `paleHollowHeight` bows above those chords on hills.
 */
export function paleHollowTerrainMeshY(x: number, z: number): number {
  const { minX, maxX, minZ, maxZ } = PALE_HOLLOW_BOUNDS;
  const segX = PALE_HOLLOW_TERRAIN_SEG_X;
  const segZ = PALE_HOLLOW_TERRAIN_SEG_Z;
  const dx = (maxX - minX) / segX;
  const dz = (maxZ - minZ) / segZ;
  const u = Math.max(0, Math.min(segX - 1e-6, (x - minX) / dx));
  const v = Math.max(0, Math.min(segZ - 1e-6, (z - minZ) / dz));
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const x0 = minX + i * dx;
  const z0 = minZ + j * dz;
  const h00 = paleHollowGroundHeight(x0, z0);
  const h10 = paleHollowGroundHeight(x0 + dx, z0);
  const h01 = paleHollowGroundHeight(x0, z0 + dz);
  const h11 = paleHollowGroundHeight(x0 + dx, z0 + dz);
  // PlaneGeometry triangles: (ix,iy)-(ix,iy+1)-(ix+1,iy) and the opposite corner.
  if (fu + fv <= 1) {
    return h00 * (1 - fu - fv) + h10 * fu + h01 * fv;
  }
  return h11 * (fu + fv - 1) + h10 * (1 - fv) + h01 * (1 - fu);
}

/**
 * Feet height. On a stone deck, the flat bridge Y (not the riverbed triangles).
 * Elsewhere the visible terrain mesh, so slopes and hills don't leave a gap under the sprite.
 */
export function paleHollowStandHeight(x: number, z: number): number {
  const deck = paleHollowBridgeDeckY(x, z);
  if (deck != null) return deck;
  return paleHollowTerrainMeshY(x, z);
}

export function clampPaleHollow(x: number, z: number): { x: number; z: number } {
  let cx = Math.max(PALE_HOLLOW_BOUNDS.minX + 1, Math.min(PALE_HOLLOW_BOUNDS.maxX - 1, x));
  let cz = Math.max(PALE_HOLLOW_BOUNDS.minZ + 1, Math.min(PALE_HOLLOW_BOUNDS.maxZ - 1, z));
  if (PH_ASH_ROAD.blocked && cx >= PH_ASH_ROAD.minX && cx <= PH_ASH_ROAD.maxX && cz >= PH_ASH_ROAD.minZ) {
    cz = Math.min(cz, PH_ASH_ROAD.minZ - 0.5);
  }
  return { x: cx, z: cz };
}

/**
 * Shared with the client water ribbon — height above the centerline bed.
 * Bed carve is ~1.35, so this keeps the table above the old shallow sheet
 * and still under the arch (deck center is water + PH_BRIDGE_DECK_CLEARANCE).
 */
export const PALE_HOLLOW_WATER_CLEARANCE = 2.55;

/**
 * Continuous 0–1 bank/mud weight from river distance (not discrete biome).
 * Used to soft-blend grass → dirt → mud without sawtooth ID edges.
 */
export function paleHollowBankBlend(x: number, z: number): number {
  let w = 0;
  if (z > 10 && z < 245) {
    const rd = Math.abs(x - riverCenterX(z));
    w = Math.max(w, 1 - smooth01(rd / 36));
  }
  if (z > 52 && z < 152) {
    const td = Math.abs(x - tributaryCenterX(z));
    w = Math.max(w, 1 - smooth01(td / 24));
  }
  return w;
}

/**
 * Soft visual blend weights (0–1) for terrain shading — independent of discrete biomes.
 * Spans hard grove circles, scrub rims, farm bands, quarry, etc.
 */
export function paleHollowTerrainWeights(x: number, z: number): {
  bank: number;
  ash: number;
  scrub: number;
  farm: number;
  meadow: number;
  quarry: number;
  mountain: number;
  ore: number;
} {
  const bank = paleHollowBankBlend(x, z);

  // Ashbeam groves — soft disks past the hard gameplay radii
  let ash = 0;
  ash = Math.max(ash, 1 - smooth01(Math.hypot(x + 6, z - 82) / 36));
  ash = Math.max(ash, 1 - smooth01(Math.hypot(x - 38, z - 70) / 26));
  ash = Math.max(ash, 1 - smooth01(Math.hypot(x + 42, z - 98) / 24));
  ash = Math.max(ash, 1 - smooth01(Math.hypot(x - 36, z - 130) / 22));

  // Outer scrub rim + soft quarry scrub ring
  let scrub = smooth01((Math.abs(x) - 52) / 16);
  const qd = Math.hypot(x, z - 145);
  const scrubRing = smooth01((qd - 24) / 12) * (1 - smooth01((qd - 44) / 10));
  scrub = Math.max(scrub, scrubRing);
  // Segment D scrub flanks
  if (z > 175) {
    scrub = Math.max(scrub, smooth01((Math.abs(x) - 48) / 14));
  }

  // Farm / meadow — soft rect + bleed across segment A→B seam (z≈50)
  let farm = 0;
  let meadow = 0;
  if (z > 4 && z < 62) {
    const zBand = smooth01((z - 4) / 10) * (1 - smooth01((z - 48) / 14));
    farm = (1 - smooth01((Math.abs(x) - 26) / 12)) * zBand;
    meadow =
      smooth01((Math.abs(x) - 26) / 12) * (1 - smooth01((Math.abs(x) - 54) / 12)) * zBand;
  }

  // Quarry bowl
  const quarry = 1 - smooth01(qd / 32);

  // Soft mountain lobes (visual; core mountain biome stays for gameplay)
  let mountain = 0;
  for (const m of PH_MOUNTAINS) {
    const d = Math.hypot(x - m.x, z - m.z);
    mountain = Math.max(mountain, 1 - smooth01(d / (m.r * 0.9)));
  }

  // Ore seam + crypt pocket
  let ore = 0;
  if (z > 178) {
    ore = (1 - smooth01((Math.abs(x) - 30) / 14)) * smooth01((z - 182) / 12);
  }
  ore = Math.max(ore, 1 - smooth01(Math.hypot(x + 18, z - 210) / 20));

  return { bank, ash, scrub, farm, meadow, quarry, mountain, ore };
}

/**
 * Distance from (x,z) to the nearest point on a channel centerline.
 * An east-west meander is not `|x - centerX(z)|` — that test misses the
 * north bend and leaves a dry gap between the banks.
 */
function nearestOnCenterline(
  centerX: (z: number) => number,
  z0: number,
  z1: number,
  x: number,
  z: number,
): { dist: number; cx: number; cz: number } | null {
  if (z < z0 - 6 || z > z1 + 6) return null;
  let bestD = Infinity;
  let bestCx = 0;
  let bestCz = z;
  const a = Math.max(z0, z - 16);
  const b = Math.min(z1, z + 16);
  for (let zz = a; zz <= b; zz += 1) {
    const cx = centerX(zz);
    const d = Math.hypot(x - cx, z - zz);
    if (d < bestD) {
      bestD = d;
      bestCx = cx;
      bestCz = zz;
    }
  }
  for (let zz = bestCz - 1; zz <= bestCz + 1; zz += 0.25) {
    if (zz < z0 || zz > z1) continue;
    const cx = centerX(zz);
    const d = Math.hypot(x - cx, z - zz);
    if (d < bestD) {
      bestD = d;
      bestCx = cx;
      bestCz = zz;
    }
  }
  return { dist: bestD, cx: bestCx, cz: bestCz };
}

/**
 * World Y of the water surface at (x,z), or null if not in a waterbody.
 * Used to clip billboards: legs under water, torso above.
 */
export function paleHollowWaterSurfaceY(x: number, z: number): number | null {
  const main = nearestOnCenterline(riverCenterX, PH_RIVER_MAIN.z0, PH_RIVER_MAIN.z1, x, z);
  if (main && main.dist <= PH_RIVER_MAIN.waterHalf) {
    return paleHollowHeightField(main.cx, main.cz) + PALE_HOLLOW_WATER_CLEARANCE;
  }
  const trib = nearestOnCenterline(tributaryCenterX, PH_RIVER_TRIB.z0, PH_RIVER_TRIB.z1, x, z);
  if (trib && trib.dist <= PH_RIVER_TRIB.waterHalf) {
    return paleHollowHeightField(trib.cx, trib.cz) + PALE_HOLLOW_WATER_CLEARANCE;
  }
  return null;
}

/**
 * True when standing in the river/tributary channel (not bridge decks / docks).
 * Use to keep non-water structures and trees out of the waterbody.
 */
export function paleHollowInOpenWater(x: number, z: number): boolean {
  if (paleHollowOnBridge(x, z)) return false;
  if (paleHollowBiomeCore(x, z) === "bridge") return false;
  return paleHollowWaterSurfaceY(x, z) != null || paleHollowBiomeCore(x, z) === "river";
}

/**
 * Landmark / building footprints where trees & large props should not spawn.
 * Hub apron is handled by `paleHollowInHubApron` — do not duplicate a hub circle here.
 */
export const PH_BUILDING_CLEARINGS: readonly { x: number; z: number; r: number }[] = [
  // Dustgrain silos
  { x: -16, z: 20, r: 4 },
  { x: -26, z: -6, r: 4 },
  { x: -13, z: 38, r: 4 },
  { x: 36, z: 40, r: 4 },
  { x: -44, z: 36, r: 4 },
  // Ashbeam stump / quarry / crypt / ore / north gate set pieces
  { x: 0, z: 92, r: 5 },
  { x: 0, z: 114, r: 7 },
  { x: -8, z: 137, r: 5 },
  { x: 0, z: 177, r: 7 },
  { x: -12, z: 210, r: 7 },
  { x: 0, z: 236, r: 5 },
  { x: 0, z: 244, r: 7 },
];

/** True if (x,z) is inside a building / landmark clearing. */
export function paleHollowInBuildingClearing(x: number, z: number): boolean {
  if (paleHollowInHubApron(x, z)) return true;
  for (const c of PH_BUILDING_CLEARINGS) {
    if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
  }
  return false;
}

/**
 * Nudge a point onto dry land (not open water, not hub interior).
 * Returns the original point if already dry. Prefer staying near the source.
 */
export function paleHollowPlaceOnDryLand(
  x: number,
  z: number,
  maxRadius = 36,
): { x: number; z: number } {
  const ok = (px: number, pz: number) => {
    if (paleHollowBiomeCore(px, pz) === "hub_indoor") return false;
    return paleHollowWalkable(px, pz);
  };
  if (ok(x, z)) return { x, z };
  for (let r = 2; r <= maxRadius; r += 2) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const px = x + Math.cos(ang) * r;
      const pz = z + Math.sin(ang) * r;
      if (ok(px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/** Terrain move modifiers — rivers slow; banks soft slow. */
export function paleHollowMoveMul(x: number, z: number): number {
  const b = paleHollowBiome(x, z);
  if (b === "river") return 0.55;
  if (b === "riverbank") return 0.82;
  if (b === "quarry" && Math.hypot(x, z - 145) < 18) return 0.88;
  return 1;
}

export function paleHollowGateSoftLevel(z: number): number | null {
  if (z >= PH_ASH_ROAD.minZ) return PH_ASH_ROAD.softLevel;
  if (z >= PH_SEAM_TUNNEL.minZ && z <= PH_SEAM_TUNNEL.maxZ) return PH_SEAM_TUNNEL.softLevel;
  if (z >= PH_QUARRY_CUT.minZ && z <= PH_QUARRY_CUT.maxZ) return PH_QUARRY_CUT.softLevel;
  if (z >= PH_TIMBER_BRIDGE.minZ && z <= PH_TIMBER_BRIDGE.maxZ) return PH_TIMBER_BRIDGE.softLevel;
  return null;
}

export const PH_HUB_SPAWN = { x: 0, z: 2, facing: 0 } as const;
export const PH_OUTDOOR_SPAWN = { x: 0, z: 14, facing: 0 } as const;

export type GatherNodeKind = "harvest" | "mine" | "fish";

export type PaleHollowNodeDef = {
  id: string;
  name: string;
  x: number;
  z: number;
  kind: GatherNodeKind;
  yields: string[];
  interactMs: number;
  respawnMs: number;
};

export const PH_SEGMENT_A_NODES: PaleHollowNodeDef[] = [
  { id: "ph-farm-a", name: "Dustgrain Patch", x: -10, z: 20, kind: "harvest", yields: ["dustgrain", "pale-dust"], interactMs: 2500, respawnMs: 55_000 },
  { id: "ph-farm-b", name: "Dustgrain Patch", x: 8, z: 22, kind: "harvest", yields: ["dustgrain", "pale-dust"], interactMs: 2500, respawnMs: 55_000 },
  { id: "ph-farm-c", name: "Dustgrain Patch", x: 22, z: 28, kind: "harvest", yields: ["dustgrain"], interactMs: 2500, respawnMs: 50_000 },
  { id: "ph-farm-d", name: "Dustgrain Patch", x: -28, z: 32, kind: "harvest", yields: ["dustgrain", "pale-dust"], interactMs: 2500, respawnMs: 55_000 },
  { id: "ph-farm-e", name: "Dustgrain Patch", x: 48, z: 38, kind: "harvest", yields: ["dustgrain", "pale-dust"], interactMs: 2500, respawnMs: 55_000 },
  { id: "ph-farm-f", name: "Dustgrain Patch", x: -52, z: 42, kind: "harvest", yields: ["dustgrain"], interactMs: 2500, respawnMs: 55_000 },
  { id: "ph-flax-a", name: "Pale Flax Stand", x: -14, z: 26, kind: "harvest", yields: ["pale-flax", "dead-fiber"], interactMs: 2800, respawnMs: 60_000 },
  { id: "ph-flax-b", name: "Pale Flax Stand", x: 18, z: 34, kind: "harvest", yields: ["pale-flax", "pale-dust"], interactMs: 2800, respawnMs: 60_000 },
  { id: "ph-sand-a", name: "River Sand Bar", x: -22, z: 38, kind: "harvest", yields: ["river-sand", "pale-dust"], interactMs: 2500, respawnMs: 65_000 },
  { id: "ph-clay-a", name: "Clay Bank", x: -20, z: 34, kind: "harvest", yields: ["potters-clay", "clay-crab", "river-sand"], interactMs: 2500, respawnMs: 65_000 },
  { id: "ph-fish-a", name: "Chalk Pool", x: -18, z: 36, kind: "fish", yields: ["fossil-minnow"], interactMs: 4000, respawnMs: 75_000 },
  { id: "ph-fish-b", name: "Chalk Pool", x: 36, z: 72, kind: "fish", yields: ["fossil-minnow"], interactMs: 4000, respawnMs: 75_000 },
  { id: "ph-copper-nugget", name: "Copper Nugget Vein", x: 18, z: 26, kind: "mine", yields: ["copper-ore"], interactMs: 4000, respawnMs: 120_000 },
];

export const PH_SEGMENT_B_NODES: PaleHollowNodeDef[] = [
  { id: "ph-ash-a", name: "Ashbeam Log", x: -8, z: 78, kind: "harvest", yields: ["ashbeam-log", "bark-strip"], interactMs: 3000, respawnMs: 70_000 },
  { id: "ph-ash-b", name: "Ashbeam Log", x: 10, z: 88, kind: "harvest", yields: ["ashbeam-log"], interactMs: 3000, respawnMs: 70_000 },
  { id: "ph-ash-c", name: "Ashbeam Log", x: -24, z: 96, kind: "harvest", yields: ["ashbeam-log", "bark-strip"], interactMs: 3000, respawnMs: 70_000 },
  { id: "ph-ash-d", name: "Ashbeam Log", x: 40, z: 96, kind: "harvest", yields: ["ashbeam-log"], interactMs: 3000, respawnMs: 70_000 },
  { id: "ph-ash-e", name: "Ashbeam Log", x: -40, z: 68, kind: "harvest", yields: ["ashbeam-log", "bark-strip"], interactMs: 3000, respawnMs: 70_000 },
  { id: "ph-fiber-a", name: "Dead Fiber Thicket", x: -36, z: 92, kind: "harvest", yields: ["dead-fiber", "pale-flax", "pale-dust"], interactMs: 2800, respawnMs: 60_000 },
  { id: "ph-fiber-b", name: "Dead Fiber Thicket", x: 50, z: 84, kind: "harvest", yields: ["dead-fiber", "pale-flax"], interactMs: 2800, respawnMs: 60_000 },
  { id: "ph-root-a", name: "Antidote Root", x: 32, z: 100, kind: "harvest", yields: ["antidote-root", "pale-dust"], interactMs: 3200, respawnMs: 90_000 },
];

export const PH_SEGMENT_C_NODES: PaleHollowNodeDef[] = [
  { id: "ph-cobble-a", name: "Cobble Heap", x: -6, z: 140, kind: "mine", yields: ["cobble", "pale-dust"], interactMs: 3500, respawnMs: 80_000 },
  { id: "ph-lime-a", name: "Limestone Face", x: 16, z: 150, kind: "mine", yields: ["limestone", "rock-salt"], interactMs: 4000, respawnMs: 100_000 },
  { id: "ph-lime-b", name: "Limestone Face", x: -18, z: 158, kind: "mine", yields: ["limestone", "cobble", "rock-salt"], interactMs: 4000, respawnMs: 100_000 },
  { id: "ph-cord-a", name: "Climbing Cord", x: 48, z: 148, kind: "harvest", yields: ["climbing-cord"], interactMs: 3500, respawnMs: 110_000 },
  { id: "ph-cord-b", name: "Climbing Cord", x: -50, z: 155, kind: "harvest", yields: ["climbing-cord"], interactMs: 3500, respawnMs: 110_000 },
];

export const PH_SEGMENT_D_NODES: PaleHollowNodeDef[] = [
  { id: "ph-cu-a", name: "Copper Seam", x: 14, z: 200, kind: "mine", yields: ["copper-ore"], interactMs: 4500, respawnMs: 130_000 },
  { id: "ph-sn-a", name: "Tin Seam", x: -10, z: 205, kind: "mine", yields: ["tin-ore"], interactMs: 4500, respawnMs: 130_000 },
  { id: "ph-cu-b", name: "Copper Seam", x: 8, z: 220, kind: "mine", yields: ["copper-ore", "pale-dust"], interactMs: 4500, respawnMs: 140_000 },
  { id: "ph-crystal-a", name: "Pale Dust Crystal", x: -28, z: 215, kind: "harvest", yields: ["pale-dust"], interactMs: 5000, respawnMs: 160_000 },
  { id: "ph-crystal-b", name: "Pale Dust Crystal", x: 30, z: 228, kind: "harvest", yields: ["pale-dust"], interactMs: 5000, respawnMs: 160_000 },
];

export const PH_ALL_NODES: PaleHollowNodeDef[] = [
  ...PH_SEGMENT_A_NODES,
  ...PH_SEGMENT_B_NODES,
  ...PH_SEGMENT_C_NODES,
  ...PH_SEGMENT_D_NODES,
];

/** How many gather nodes are live in the world at once (drawn from PH_ALL_NODES spawn points). */
export const PH_ACTIVE_GATHER_COUNT = 20;

/** Chance a node relocates to another free spawn point when gathered / refreshing. */
export const PH_GATHER_RELOCATE_CHANCE = 0.6;

/** All authored gather coordinates — spawn pool for live nodes. */
export function paleHollowNodeSpawnPoints(): { id: string; name: string; x: number; z: number; kind: GatherNodeKind }[] {
  return PH_ALL_NODES.map((n) => ({ id: n.id, name: n.name, x: n.x, z: n.z, kind: n.kind }));
}

export type PaleHollowArchetype =
  | "dust_hare"
  | "pale_slime"
  | "hollow_scavenger"
  | "ashbeam_boar"
  | "ruin_dweller"
  | "cliff_adder"
  | "seam_golem"
  | "shard_wight";

export type PaleHollowAggro = "safe" | "proximity" | "sight" | "sound";

export type PaleHollowRareDrop = {
  slug: string;
  /** Absolute drop chance in [0, 1] (independent of the flat 65% mat roll). */
  chance: number;
};

/**
 * Same ids as player `JobId` — kept local so `@bellgrave/config` stays free of a combat dep.
 * Job drives mob AI ability choice, engage range, and attack stat curves.
 */
export type PaleHollowMobJob =
  | "time_mage"
  | "knight"
  | "rogue"
  | "cleric"
  | "sorcerer"
  | "fighter"
  | "battle_mage";

/**
 * Default job per archetype (theme match).
 * Spawn defs may override with `job` for variants (e.g. knight dweller).
 *
 * Follow-ups: weighted job tables per segment, UI nameplate job glyph,
 * and richer kit reuse beyond the NPC-safe ability stubs in mob-job-ai.
 */
export const PH_ARCHETYPE_DEFAULT_JOB: Record<PaleHollowArchetype, PaleHollowMobJob> = {
  dust_hare: "fighter",
  pale_slime: "battle_mage",
  hollow_scavenger: "rogue",
  ashbeam_boar: "fighter",
  ruin_dweller: "sorcerer",
  cliff_adder: "rogue",
  seam_golem: "knight",
  shard_wight: "time_mage",
};

export type PaleHollowMobDef = {
  id: string;
  name: string;
  x: number;
  z: number;
  level: number;
  archetype: PaleHollowArchetype;
  /** Optional job override — defaults via `PH_ARCHETYPE_DEFAULT_JOB`. */
  job?: PaleHollowMobJob;
  aggro: PaleHollowAggro;
  aggroRange: number;
  linkRange?: number;
  hp: number;
  drops: string[];
  /** Optional rare gear — rolled once per kill at the given chance. */
  rareDrops?: PaleHollowRareDrop[];
};

export function paleHollowMobJob(
  d: Pick<PaleHollowMobDef, "archetype" | "job">,
): PaleHollowMobJob {
  return d.job ?? PH_ARCHETYPE_DEFAULT_JOB[d.archetype];
}


export const PH_SEGMENT_A_MOBS: PaleHollowMobDef[] = [
  // Extra level-1 cluster flanking the encampment (west/east sides, outside hub apron so roam/flee can walk).
  { id: "ph-hare-hub-1", name: "Dust Hare", x: -24, z: 0, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-hub-2", name: "Dust Hare", x: -27, z: 4, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-hub-3", name: "Dust Hare", x: -23, z: 8, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-hub-4", name: "Dust Hare", x: -26, z: 12, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-hub-5", name: "Dust Hare", x: 24, z: 0, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-hub-6", name: "Dust Hare", x: 27, z: 4, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-hub-7", name: "Dust Hare", x: 23, z: 8, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-hub-8", name: "Dust Hare", x: 26, z: 12, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-1", name: "Dust Hare", x: -8, z: 18, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-2", name: "Dust Hare", x: 6, z: 20, level: 1, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 45, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-3", name: "Dust Hare", x: 24, z: 30, level: 2, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 55, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-4", name: "Dust Hare", x: -30, z: 36, level: 2, archetype: "dust_hare", job: "rogue", aggro: "safe", aggroRange: 0, hp: 55, drops: ["soft-pelt", "horn", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-5", name: "Dust Hare", x: 40, z: 44, level: 2, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 50, drops: ["soft-pelt", "desiccated-hide"] },
  { id: "ph-hare-6", name: "Dust Hare", x: -50, z: 28, level: 2, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 50, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-7", name: "Dust Hare", x: 54, z: 34, level: 2, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 52, drops: ["soft-pelt", "desiccated-hide"] },
  { id: "ph-slime-1", name: "Pale Slime", x: -18, z: 35, level: 3, archetype: "pale_slime", aggro: "proximity", aggroRange: 4, hp: 80, drops: ["slime-oil", "pale-dust"] },
  { id: "ph-slime-2", name: "Pale Slime", x: -16, z: 42, level: 4, archetype: "pale_slime", job: "sorcerer", aggro: "proximity", aggroRange: 4, hp: 95, drops: ["slime-oil", "pale-dust"] },
  { id: "ph-slime-3", name: "Pale Slime", x: -36, z: 48, level: 3, archetype: "pale_slime", aggro: "proximity", aggroRange: 3.5, hp: 80, drops: ["slime-oil", "pale-dust"] },
  { id: "ph-slime-4", name: "Pale Slime", x: 34, z: 70, level: 4, archetype: "pale_slime", aggro: "proximity", aggroRange: 3.5, hp: 90, drops: ["slime-oil"] },
];

export const PH_SEGMENT_B_MOBS: PaleHollowMobDef[] = [
  { id: "ph-hare-b1", name: "Dust Hare", x: -40, z: 68, level: 5, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 70, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-hare-b2", name: "Dust Hare", x: 42, z: 74, level: 5, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 70, drops: ["soft-pelt", "desiccated-hide"] },
  { id: "ph-hare-b3", name: "Dust Hare", x: -55, z: 88, level: 5, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 68, drops: ["soft-pelt", "desiccated-hide"] },
  { id: "ph-hare-b4", name: "Dust Hare", x: 58, z: 102, level: 6, archetype: "dust_hare", aggro: "safe", aggroRange: 0, hp: 75, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-scav-1", name: "Hollow Scavenger", x: -6, z: 82, level: 6, archetype: "hollow_scavenger", aggro: "sight", aggroRange: 9, linkRange: 7, hp: 140, drops: ["linen-scrap", "pale-dust"] },
  { id: "ph-scav-2", name: "Hollow Scavenger", x: 8, z: 90, level: 6, archetype: "hollow_scavenger", aggro: "sight", aggroRange: 9, linkRange: 7, hp: 140, drops: ["linen-scrap", "bone-chip"] },
  { id: "ph-scav-3", name: "Hollow Scavenger", x: -20, z: 100, level: 7, archetype: "hollow_scavenger", aggro: "sight", aggroRange: 9, linkRange: 7, hp: 160, drops: ["linen-scrap", "pale-dust"] },
  { id: "ph-scav-4", name: "Hollow Scavenger", x: 28, z: 104, level: 7, archetype: "hollow_scavenger", aggro: "sight", aggroRange: 9, linkRange: 7, hp: 160, drops: ["linen-scrap"] },
  { id: "ph-boar-1", name: "Ashbeam Boar", x: 18, z: 88, level: 8, archetype: "ashbeam_boar", aggro: "sound", aggroRange: 7, hp: 200, drops: ["soft-pelt", "horn", "desiccated-hide"] },
  { id: "ph-boar-2", name: "Ashbeam Boar", x: -28, z: 108, level: 9, archetype: "ashbeam_boar", aggro: "sound", aggroRange: 7, hp: 220, drops: ["soft-pelt", "horn", "pale-dust", "desiccated-hide"] },
  { id: "ph-boar-3", name: "Ashbeam Boar", x: 40, z: 96, level: 8, archetype: "ashbeam_boar", aggro: "sound", aggroRange: 7, hp: 210, drops: ["soft-pelt", "horn", "desiccated-hide"] },
];

export const PH_SEGMENT_C_MOBS: PaleHollowMobDef[] = [
  { id: "ph-dwell-1", name: "Ruin Dweller", x: -4, z: 132, level: 11, archetype: "ruin_dweller", aggro: "sight", aggroRange: 10, linkRange: 8, hp: 260, drops: ["cracked-brick", "pale-dust"], rareDrops: [{ slug: "chainmail", chance: 0.01 }] },
  { id: "ph-dwell-2", name: "Ruin Dweller", x: 12, z: 142, level: 11, archetype: "ruin_dweller", aggro: "sight", aggroRange: 10, linkRange: 8, hp: 260, drops: ["cracked-brick"], rareDrops: [{ slug: "chainmail", chance: 0.01 }] },
  { id: "ph-dwell-3", name: "Ruin Dweller", x: -16, z: 156, level: 12, archetype: "ruin_dweller", aggro: "sight", aggroRange: 10, linkRange: 8, hp: 290, drops: ["cracked-brick", "bone-chip"], rareDrops: [{ slug: "chainmail", chance: 0.01 }] },
  { id: "ph-dwell-4", name: "Ruin Dweller", x: 22, z: 164, level: 13, archetype: "ruin_dweller", aggro: "sight", aggroRange: 11, linkRange: 8, hp: 310, drops: ["cracked-brick", "pale-dust"], rareDrops: [{ slug: "chainmail", chance: 0.01 }] },
  { id: "ph-adder-1", name: "Cliff Adder", x: 54, z: 142, level: 12, archetype: "cliff_adder", aggro: "proximity", aggroRange: 3.2, hp: 180, drops: ["soft-pelt", "pale-dust", "desiccated-hide"] },
  { id: "ph-adder-2", name: "Cliff Adder", x: -56, z: 155, level: 13, archetype: "cliff_adder", aggro: "proximity", aggroRange: 3.2, hp: 190, drops: ["soft-pelt", "desiccated-hide"] },
  { id: "ph-adder-3", name: "Cliff Adder", x: 50, z: 170, level: 14, archetype: "cliff_adder", aggro: "proximity", aggroRange: 3.5, hp: 210, drops: ["soft-pelt", "bone-chip", "desiccated-hide"] },
  { id: "ph-scav-c1", name: "Hollow Scavenger", x: 0, z: 148, level: 12, archetype: "hollow_scavenger", job: "fighter", aggro: "sight", aggroRange: 9, linkRange: 6, hp: 240, drops: ["linen-scrap"] },
];

export const PH_SEGMENT_D_MOBS: PaleHollowMobDef[] = [
  { id: "ph-golem-1", name: "Seam Golem", x: 12, z: 198, level: 16, archetype: "seam_golem", aggro: "sight", aggroRange: 8, hp: 420, drops: ["copper-ore", "cracked-brick"] },
  { id: "ph-golem-2", name: "Seam Golem", x: -8, z: 218, level: 17, archetype: "seam_golem", aggro: "sight", aggroRange: 8, hp: 460, drops: ["tin-ore", "cracked-brick"] },
  { id: "ph-wight-1", name: "Shard Wight", x: -18, z: 208, level: 16, archetype: "shard_wight", aggro: "sight", aggroRange: 9, linkRange: 6, hp: 340, drops: ["bone-chip", "pale-dust"] },
  { id: "ph-wight-2", name: "Shard Wight", x: -14, z: 216, level: 17, archetype: "shard_wight", aggro: "sight", aggroRange: 9, linkRange: 6, hp: 360, drops: ["bone-chip"] },
  { id: "ph-wight-3", name: "Shard Wight", x: -24, z: 212, level: 18, archetype: "shard_wight", job: "sorcerer", aggro: "sight", aggroRange: 9, linkRange: 6, hp: 380, drops: ["bone-chip", "pale-dust"] },
  { id: "ph-dwell-d1", name: "Ruin Dweller", x: 6, z: 206, level: 15, archetype: "ruin_dweller", aggro: "sight", aggroRange: 10, linkRange: 7, hp: 320, drops: ["cracked-brick"], rareDrops: [{ slug: "chainmail", chance: 0.01 }] },
  { id: "ph-dwell-d2", name: "Ruin Dweller", x: 28, z: 228, level: 16, archetype: "ruin_dweller", job: "knight", aggro: "sight", aggroRange: 10, hp: 340, drops: ["cracked-brick", "linen-scrap"], rareDrops: [{ slug: "chainmail", chance: 0.01 }] },
];

export const PH_ALL_MOBS: PaleHollowMobDef[] = [
  ...PH_SEGMENT_A_MOBS,
  ...PH_SEGMENT_B_MOBS,
  ...PH_SEGMENT_C_MOBS,
  ...PH_SEGMENT_D_MOBS,
];

/** Hub NPCs — clustered around the small camp core (fire at ~0, 0.5). */
export const PH_HUB_NPCS = [
  { id: "npc-shard-elder", name: "Shard Elder", x: -2.2, z: 2.8, facing: Math.PI / 2, role: "guide" as const },
  { id: "npc-ph-herald", name: "Campaign Herald", x: 0.4, z: 5.0, facing: Math.PI, role: "quest_giver" as const },
  { id: "npc-ph-job-master", name: "Job Master", x: 3.5, z: 2.5, facing: -Math.PI / 2, role: "job_master" as const },
  { id: "npc-ph-crafter", name: "Craft Master", x: 3.8, z: -0.2, facing: -Math.PI / 2, role: "crafter" as const },
  { id: "npc-ph-vendor", name: "Provisioner", x: -3.8, z: -0.2, facing: Math.PI / 2, role: "vendor" as const },
] as const;
