import type { UnitSnapshot } from "@bellgrave/protocol";
import {
  MOB_DEATH_FADE_MS,
  PH_HUB,
  paleHollowClampMove,
  paleHollowStandHeight,
  paleHollowWaterSurfaceY,
} from "@bellgrave/config";
import { Html, useTexture } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  FLUX_AURA_URL,
  applyArtFacing,
  facingPick,
  jobSpriteBase,
  pickMeleeVariant,
  spriteSlug,
  walkFrameAt,
  mobHasMeleeSprite,
  mobSpriteUrl,
  npcSpriteUrl,
  playerSpriteUrl,
  type AnimKey,
  type Gender,
} from "./facing";
import { GatherNodeMarkers, PaleHollowTerrain, isoSortOrder, paleHollowSunDir } from "./PaleHollowMap";
import { PaleHollowHorizon } from "./PaleHollowHorizon";
import { PaleHollowRivers } from "./PaleHollowRivers";
import { PaleHollowRiverBanks } from "./PaleHollowRiverBanks";
import { PaleHollowPaths } from "./PaleHollowPaths";
import { peekSpriteTexture, putSpriteTexture, requestSpriteTexture, subscribeSpriteLoads } from "./spriteCache";
import { send } from "./net";
import {
  clearKeyboardMove,
  getMoveKeys,
  setKeyboardMoveKey,
  type MoveKeys,
} from "./moveInput";
import { useGame } from "./state";
import { playEnemySwing, playJobSwing, playTemporalDistortion } from "./combatSfx";
import { UnitStatusIcons } from "./UnitStatusIcons";
import { QuarksVfxLayer, spawnVfx } from "./vfx";
import { WorldPostFx } from "./worldPostFx";
import { worldHtmlPortalRef } from "./worldHtml";
import { NpcInteractMenu } from "./NpcInteractMenu";

const QUICKEN_ORBS_PER_BELT = 3;
const QUICKEN_BELT_COUNT = 2;
const QUICKEN_ORB_TOTAL = QUICKEN_ORBS_PER_BELT * QUICKEN_BELT_COUNT;
const QUICKEN_TRAIL_LEN = 2;
const QUICKEN_BURST_MS = 480;
const LEVEL_UP_RINGS = 5;
const LEVEL_UP_SPARKS = 10;
const TD_DEBRIS = 10;

function makeGlowOrbTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const ctx = c.getContext("2d")!;
  // Soft outer halo
  const halo = ctx.createRadialGradient(48, 48, 8, 48, 48, 46);
  halo.addColorStop(0, "rgba(180, 240, 230, 0)");
  halo.addColorStop(0.35, "rgba(120, 210, 200, 0.2)");
  halo.addColorStop(0.65, "rgba(232, 200, 90, 0.35)");
  halo.addColorStop(1, "rgba(232, 200, 90, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 96, 96);
  // Core â€” pale chrona gold with teal fringe
  const core = ctx.createRadialGradient(48, 48, 0, 48, 48, 22);
  core.addColorStop(0, "rgba(255, 252, 235, 1)");
  core.addColorStop(0.3, "rgba(255, 230, 150, 0.95)");
  core.addColorStop(0.55, "rgba(120, 220, 210, 0.7)");
  core.addColorStop(0.8, "rgba(62, 180, 170, 0.25)");
  core.addColorStop(1, "rgba(62, 180, 170, 0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(48, 48, 22, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Multi-spoke enemy cast circle (transparent, animated via mesh rotation). */
function makeEnemyCastCircleTexture(variant: "outer" | "inner" = "outer"): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d")!;
  const cx = 256;
  const cy = 256;
  const isInner = variant === "inner";

  // Soft outer glow — blue / white / black flashy magic (no orange/gold)
  const glow = ctx.createRadialGradient(cx, cy, isInner ? 90 : 110, cx, cy, isInner ? 220 : 248);
  glow.addColorStop(0, "rgba(10, 20, 40, 0)");
  glow.addColorStop(0.45, isInner ? "rgba(120, 190, 255, 0.2)" : "rgba(40, 100, 220, 0.42)");
  glow.addColorStop(0.72, isInner ? "rgba(200, 230, 255, 0.16)" : "rgba(160, 210, 255, 0.28)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, isInner ? 220 : 248, 0, Math.PI * 2);
  ctx.fill();

  // Concentric ornate rings
  const rings = isInner
    ? ([[170, 4, 0.8], [140, 2.5, 0.55], [105, 3.5, 0.85]] as const)
    : ([[210, 6, 0.92], [185, 3, 0.55], [155, 4.5, 0.78], [120, 2.5, 0.62]] as const);
  for (const [r, w, a] of rings) {
    ctx.strokeStyle = `rgba(170, 215, 255, ${a})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Dashed arc segments — reads as multi-frame when the decal spins
  const dashR = isInner ? 155 : 198;
  const dashCount = isInner ? 10 : 14;
  for (let i = 0; i < dashCount; i++) {
    const a0 = (i / dashCount) * Math.PI * 2 + (isInner ? 0.08 : 0);
    const a1 = a0 + (Math.PI * 2) / dashCount * 0.55;
    ctx.strokeStyle = i % 2 === 0 ? "rgba(245, 250, 255, 0.95)" : "rgba(50, 120, 255, 0.78)";
    ctx.lineWidth = i % 2 === 0 ? 5 : 3;
    ctx.beginPath();
    ctx.arc(cx, cy, dashR, a0, a1);
    ctx.stroke();
  }

  // Spoke ticks / rune shafts
  const spokeN = isInner ? 12 : 18;
  for (let i = 0; i < spokeN; i++) {
    const a = (i / spokeN) * Math.PI * 2 + (isInner ? Math.PI / spokeN : 0);
    const inner = isInner ? (i % 2 === 0 ? 70 : 85) : i % 2 === 0 ? 95 : 115;
    const outer = isInner ? (i % 2 === 0 ? 165 : 148) : i % 2 === 0 ? 215 : 195;
    ctx.strokeStyle = i % 3 === 0 ? "rgba(255, 255, 255, 0.96)" : "rgba(70, 150, 255, 0.82)";
    ctx.lineWidth = i % 3 === 0 ? 3.6 : 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
  }

  // Geometric "runes" around the mid ring (triangles / diamonds / chevrons)
  const runeR = isInner ? 125 : 168;
  const runeN = isInner ? 8 : 12;
  for (let i = 0; i < runeN; i++) {
    const a = (i / runeN) * Math.PI * 2 + Math.PI / runeN;
    const x = cx + Math.cos(a) * runeR;
    const y = cy + Math.sin(a) * runeR;
    const kind = i % 3;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    ctx.strokeStyle = kind === 0 ? "rgba(255, 255, 255, 0.96)" : "rgba(130, 190, 255, 0.88)";
    ctx.fillStyle = "rgba(20, 50, 120, 0.35)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    if (kind === 0) {
      // diamond
      ctx.moveTo(0, -10);
      ctx.lineTo(7, 0);
      ctx.lineTo(0, 10);
      ctx.lineTo(-7, 0);
      ctx.closePath();
    } else if (kind === 1) {
      // triangle
      ctx.moveTo(0, -9);
      ctx.lineTo(8, 7);
      ctx.lineTo(-8, 7);
      ctx.closePath();
    } else {
      // chevron
      ctx.moveTo(-8, -6);
      ctx.lineTo(0, 6);
      ctx.lineTo(8, -6);
    }
    ctx.stroke();
    if (kind !== 2) ctx.fill();
    ctx.restore();
  }

  // Clear center so the caster's feet stay readable through the ring
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, isInner ? 58 : 78, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.anisotropy = 4;
  return tex;
}

const CAST_RIBBON_COUNT = 8;

/** Vertical magical-wave ribbon — extruded upward from the ground cast circle. */
function makeEnemyCastRibbonTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);

  // Soft column envelope (black void edges, blue body) — seamless in V for UV scroll
  for (let y = 0; y < h; y++) {
    const v = y / h;
    const g = ctx.createLinearGradient(0, y, w, y);
    const pulse = 0.55 + 0.45 * Math.sin(v * Math.PI * 4);
    g.addColorStop(0, "rgba(0, 0, 0, 0)");
    g.addColorStop(0.18, `rgba(8, 20, 48, ${0.15 * pulse})`);
    g.addColorStop(0.5, `rgba(50, 130, 255, ${0.38 * pulse})`);
    g.addColorStop(0.82, `rgba(8, 20, 48, ${0.15 * pulse})`);
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y, w, 1);
  }

  // Undulating energy filaments (wave ribbon look)
  const filaments: Array<[number, number, string, number, number]> = [
    [28, 14, "rgba(30, 90, 220, 0.55)", 0.0, 2],
    [22, 8, "rgba(90, 170, 255, 0.75)", 1.1, 2],
    [16, 4.5, "rgba(210, 235, 255, 0.9)", 2.2, 3],
    [10, 2.2, "rgba(255, 255, 255, 0.95)", 0.7, 3],
    [18, 3.5, "rgba(40, 80, 160, 0.7)", 3.4, 1],
  ];
  for (const [amp, thick, color, phase, turns] of filaments) {
    ctx.beginPath();
    for (let y = 0; y <= h; y++) {
      const v = y / h;
      const x =
        w * 0.5 +
        Math.sin(v * Math.PI * 2 * turns + phase) * amp +
        Math.sin(v * Math.PI * 2 * (turns + 1) + phase * 1.7) * amp * 0.28;
      if (y === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = thick;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // Horizontal spark streaks (flashy magic bands)
  for (let i = 0; i < 7; i++) {
    const y = ((i + 0.5) / 7) * h;
    const band = ctx.createLinearGradient(0, y, w, y);
    band.addColorStop(0, "rgba(255, 255, 255, 0)");
    band.addColorStop(0.35, "rgba(160, 210, 255, 0.15)");
    band.addColorStop(0.5, "rgba(255, 255, 255, 0.55)");
    band.addColorStop(0.65, "rgba(80, 150, 255, 0.2)");
    band.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = band;
    ctx.fillRect(0, y - 1.5, w, 3);
  }

  // Soft horizontal edge fade so ribbons blend into the ground circle / air
  const edgeFade = ctx.createLinearGradient(0, 0, 0, h);
  edgeFade.addColorStop(0, "rgba(0, 0, 0, 0.85)");
  edgeFade.addColorStop(0.08, "rgba(0, 0, 0, 0)");
  edgeFade.addColorStop(0.92, "rgba(0, 0, 0, 0)");
  edgeFade.addColorStop(1, "rgba(0, 0, 0, 0.9)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = edgeFade;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  tex.anisotropy = 4;
  return tex;
}

/** Soft ring for resonance pulses / cast burst. */
function makeResonanceRingTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const cx = 64;
  const cy = 64;
  for (const [r0, r1, a] of [
    [28, 40, 0.55],
    [42, 52, 0.28],
  ] as const) {
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    g.addColorStop(0, `rgba(180, 240, 230, 0)`);
    g.addColorStop(0.45, `rgba(255, 230, 150, ${a})`);
    g.addColorStop(0.7, `rgba(100, 210, 200, ${a * 0.7})`);
    g.addColorStop(1, "rgba(100, 210, 200, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r1, 0, Math.PI * 2);
    ctx.fill();
  }
  // Clear center so it's a ring, not a disc
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Ground clock-crack / earth burst ring (Temporal Distortion). */
function makeEarthChronaRingTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const cx = 128;
  const cy = 128;
  // Outer earth dust
  const dust = ctx.createRadialGradient(cx, cy, 40, cx, cy, 120);
  dust.addColorStop(0, "rgba(120, 90, 50, 0)");
  dust.addColorStop(0.45, "rgba(160, 110, 55, 0.55)");
  dust.addColorStop(0.75, "rgba(90, 70, 40, 0.35)");
  dust.addColorStop(1, "rgba(60, 45, 30, 0)");
  ctx.fillStyle = dust;
  ctx.beginPath();
  ctx.arc(cx, cy, 120, 0, Math.PI * 2);
  ctx.fill();
  // Crack spokes (earth brown + chrona teal)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + (i % 2) * 0.12;
    ctx.strokeStyle = i % 3 === 0 ? "rgba(90, 220, 200, 0.85)" : "rgba(180, 130, 70, 0.9)";
    ctx.lineWidth = i % 3 === 0 ? 3.5 : 2.2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 28, cy + Math.sin(a) * 28);
    ctx.lineTo(cx + Math.cos(a) * (95 + (i % 4) * 8), cy + Math.sin(a) * (95 + (i % 4) * 8));
    ctx.stroke();
  }
  // Inner chrona clock tick ring
  ctx.strokeStyle = "rgba(255, 220, 120, 0.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 52, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 44, cy + Math.sin(a) * 44);
    ctx.lineTo(cx + Math.cos(a) * 58, cy + Math.sin(a) * 58);
    ctx.stroke();
  }
  // Punch center hole so it reads as a ring on the floor
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Vertical chrona crack / hourglass shatter for TD impact. */
function makeChronaCrackTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 192;
  const ctx = c.getContext("2d")!;
  // Soft teal glow plate
  const g = ctx.createRadialGradient(64, 96, 10, 64, 96, 80);
  g.addColorStop(0, "rgba(200, 255, 240, 0.55)");
  g.addColorStop(0.4, "rgba(90, 210, 190, 0.35)");
  g.addColorStop(1, "rgba(40, 120, 110, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 192);
  // Crack lines
  ctx.strokeStyle = "rgba(255, 230, 140, 0.95)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(64, 20);
  ctx.lineTo(58, 70);
  ctx.lineTo(72, 110);
  ctx.lineTo(55, 160);
  ctx.lineTo(64, 180);
  ctx.stroke();
  ctx.strokeStyle = "rgba(120, 230, 210, 0.9)";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(64, 50);
  ctx.lineTo(40, 95);
  ctx.moveTo(64, 50);
  ctx.lineTo(90, 100);
  ctx.moveTo(58, 120);
  ctx.lineTo(35, 150);
  ctx.moveTo(72, 115);
  ctx.lineTo(98, 145);
  ctx.stroke();
  // Sand motes
  ctx.fillStyle = "rgba(232, 200, 90, 0.9)";
  for (const [x, y, r] of [
    [48, 80, 2.5],
    [78, 88, 2],
    [55, 130, 2.2],
    [82, 140, 1.8],
    [60, 100, 1.5],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Stone crack overlay while Petrify lasts. */
function makePetrifyCrackTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 160;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 160);
  ctx.strokeStyle = "rgba(50, 45, 40, 0.85)";
  ctx.lineWidth = 2;
  const cracks: [number, number, number, number][] = [
    [30, 20, 50, 70],
    [50, 70, 40, 120],
    [40, 120, 55, 150],
    [70, 25, 85, 80],
    [85, 80, 70, 130],
    [45, 55, 75, 60],
    [55, 95, 90, 110],
  ];
  for (const [x0, y0, x1, y1] of cracks) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(180, 170, 150, 0.45)";
  ctx.lineWidth = 1;
  for (const [x0, y0, x1, y1] of cracks) {
    ctx.beginPath();
    ctx.moveTo(x0 + 1, y0);
    ctx.lineTo(x1 + 1, y1);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function quickenOrbPose(
  ang: number,
  radius: number,
  baseY: number,
  tilt: number,
  flipped: boolean,
): { x: number; y: number; z: number } {
  const x = Math.cos(ang) * radius;
  const z = Math.sin(ang) * radius * 0.78;
  const y = baseY + (flipped ? Math.cos(ang) : Math.sin(ang)) * tilt;
  return { x, y, z };
}

/** Billboard-local Z: >0 toward camera (in front of sprite), <0 behind. */
function depthVsBillboard(x: number, z: number, faceYaw: number): number {
  const s = Math.sin(faceYaw);
  const c = Math.cos(faceYaw);
  return -x * s + z * c;
}

type SmoothPos = { x: number; y: number; z: number; primed: boolean };

/** Local player display pose — camera follows this so chase doesn't hitch with 20Hz snaps. */
const localVisual = {
  x: 0,
  y: 0,
  z: 0,
  facing: 0,
  primed: false,
};

/** Ease poses toward 20Hz snapshots so walk/chase/flee don't hitch. */
function stepSmoothPos(
  smooth: SmoothPos,
  target: { x: number; y: number; z: number },
  dt: number,
  snap: boolean,
  rate = 18,
): void {
  if (snap || !smooth.primed) {
    smooth.x = target.x;
    smooth.y = target.y;
    smooth.z = target.z;
    smooth.primed = true;
    return;
  }
  const dx = target.x - smooth.x;
  const dz = target.z - smooth.z;
  if (dx * dx + dz * dz > 16) {
    smooth.x = target.x;
    smooth.y = target.y;
    smooth.z = target.z;
    return;
  }
  const a = 1 - Math.exp(-rate * Math.max(0.001, dt));
  smooth.x += dx * a;
  smooth.y += (target.y - smooth.y) * a;
  smooth.z += dz * a;
}

/** Shortest-path yaw ease — keeps chase facing from flipping every tick. */
function stepSmoothFacing(prev: number | null, target: number, dt: number, rate = 14): number {
  if (prev == null) return target;
  let d = target - prev;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return prev + d * (1 - Math.exp(-rate * Math.max(0.001, dt)));
}

/** Sticky SE-only mob mirror — avoid frame-flip thrash near the camera plane. */
function stickyMobMirror(facing: number, toCamera: number, prev: boolean | null): boolean {
  const s = Math.sin(facing - toCamera);
  if (prev == null) return s < 0;
  if (prev) return s > 0.28 ? false : true;
  return s < -0.28 ? true : false;
}

const _camFwd = new THREE.Vector3();

/**
 * Screen-aligned Y-up billboard — same orientation as the local player.
 *
 * Yaw is the camera's horizontal facing (plane normal points back at the lens
 * in XZ). A per-object atan2(camera − sprite) turns off-center quads so their
 * width axis is no longer screen-horizontal; the player stays level only
 * because the camera looks at them.
 *
 * Euler order is YXZ and the full rotation is rewritten every frame. Default
 * XYZ plus quaternion.setFromEuler() decomposes |yaw| > π/2 into ±π pitch/roll,
 * and a later write of `.y` alone bakes that tilt in. Pitch and roll stay 0.
 */
function yawBillboardToCamera(obj: THREE.Object3D, camera: THREE.Camera): number {
  camera.getWorldDirection(_camFwd);
  const yaw = Math.atan2(-_camFwd.x, -_camFwd.z);
  if (obj.rotation.order !== "YXZ") obj.rotation.order = "YXZ";
  obj.rotation.set(0, yaw, 0);
  return yaw;
}

/** Identity orientation. Facing flips use scale.x, never mesh roll. */
function lockUpright(obj: THREE.Object3D): void {
  if (obj.rotation.order !== "YXZ") obj.rotation.order = "YXZ";
  obj.rotation.set(0, 0, 0);
}

function SheetBillboard({ unitId, isMe }: { unitId: string; isMe: boolean }) {
  // Identity-only sig — HP/MP/pos update in useFrame so hit ticks don't remount meshes/Html.
  const sig = useGame((s) => {
    const u = s.snapshot?.units.find((x) => x.id === unitId);
    if (!u) return "";
    return [
      u.name,
      u.kind,
      u.job ?? "",
      u.gender ?? "",
      u.archetype ?? "",
      u.maxHp,
      u.maxMp,
      u.deathAt ?? 0,
    ].join("|");
  });
  const unit = useMemo(() => {
    void sig;
    return useGame.getState().snapshot?.units.find((x) => x.id === unitId);
  }, [sig, unitId]);
  if (!unit) return null;
  // Remote players: slim sprite path — full FX stack is too costly with 3–6 peers in view.
  if (!isMe && unit.kind === "player") {
    return <RemotePlayerBillboard unitId={unitId} unit={unit} />;
  }
  // Mobs use the slim path too — full Quicken/TD tree is wasteful and hitchy on hit.
  if (!isMe && unit.kind === "mob") {
    return <MobBillboard unitId={unitId} unit={unit} />;
  }
  return <SheetBillboardInner unitId={unitId} unit={unit} isMe={isMe} />;
}

/**
 * Player billboard world size — identical to the local player in SheetBillboardInner.
 * Height is the shared 2.5 plane stretched 15%; width follows art aspect at the
 * unstretched base so the quad stays the same shape and the feet stay on the ground.
 */
function playerSpriteWorldSize(tex: THREE.Texture | null | undefined): {
  spriteW: number;
  spriteH: number;
} {
  const BASE_SPRITE_H = 2.5;
  const PLAYER_H_MUL = 1.15;
  const image = tex?.image as { width?: number; height?: number } | undefined;
  const iw = image?.width ?? 3;
  const ih = image?.height ?? 4;
  const aspect = iw / Math.max(1, ih);
  return {
    spriteW: BASE_SPRITE_H * aspect,
    spriteH: BASE_SPRITE_H * PLAYER_H_MUL,
  };
}

/** Cheap remote peer: one billboard sprite, no Quicken/TD/Html/bars unless selected. */
function RemotePlayerBillboard({ unitId, unit }: { unitId: string; unit: UnitSnapshot }) {
  const root = useRef<THREE.Group>(null);
  const billboard = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const lastUrl = useRef("");
  const lastFacing = useRef<ReturnType<typeof facingPick> | null>(null);
  const lastMeleeAnimUntil = useRef(0);
  const meleeVariant = useRef(1);
  const smooth = useRef<SmoothPos>({ x: unit.x, y: unit.y ?? 0, z: unit.z, primed: false });
  const unitRef = useRef(unit);
  unitRef.current = unit;
  const { camera } = useThree();
  const selectedTarget = useGame((s) => s.selectedTarget);
  const isSelected = selectedTarget === unitId;

  const jobKey = unit.job ?? "time_mage";
  const gender: Gender = unit.gender ?? "male";
  const seedUrl = useMemo(
    () => playerSpriteUrl(jobKey, "idle", "se", 0, gender),
    [jobKey, gender],
  );
  const seedRaw = useTexture(seedUrl);
  const seedTex = useMemo(() => putSpriteTexture(seedUrl, seedRaw), [seedUrl, seedRaw]);
  const seedSize = useMemo(() => playerSpriteWorldSize(seedTex), [seedTex]);

  useEffect(() => {
    return subscribeSpriteLoads((url, tex) => {
      if (url === lastUrl.current && mat.current) {
        mat.current.map = tex;
        mat.current.needsUpdate = true;
      }
    });
  }, []);

  useFrame((_, dt) => {
    const live = useGame.getState().snapshot?.units.find((u) => u.id === unitId);
    if (live) unitRef.current = live;
    const u = unitRef.current;
    if (!root.current || !billboard.current || !mat.current || !meshRef.current) return;

    stepSmoothPos(smooth.current, { x: u.x, y: u.y ?? 0, z: u.z }, dt, false);
    const px = smooth.current.x;
    const py = smooth.current.y;
    const pz = smooth.current.z;
    root.current.position.set(px, py, pz);
    const sort = isoSortOrder(px, pz);
    root.current.renderOrder = sort;
    meshRef.current.renderOrder = sort + 2;

    lockUpright(root.current);
    const toCamera = yawBillboardToCamera(billboard.current, camera);
    lockUpright(meshRef.current);

    const cp = camera.position;
    const camDist = Math.hypot(cp.x - px, cp.z - pz);
    if (camDist > 36) {
      root.current.visible = camDist < 48;
      return;
    }
    root.current.visible = true;

    const anim = u.anim as AnimKey;
    if (anim === "melee" && u.animUntil > lastMeleeAnimUntil.current) {
      lastMeleeAnimUntil.current = u.animUntil;
      const slug = spriteSlug(jobSpriteBase(u.job), u.gender ?? "male");
      meleeVariant.current = pickMeleeVariant(slug);
    } else if (anim !== "melee") {
      lastMeleeAnimUntil.current = 0;
    }
    const pick = facingPick(u.facing, toCamera, lastFacing.current);
    lastFacing.current = pick;
    const slug = spriteSlug(jobSpriteBase(u.job), u.gender ?? "male");
    const draw = applyArtFacing(slug, pick);
    const wf = anim === "walk" ? walkFrameAt(performance.now()) : 0;
    const url = playerSpriteUrl(
      u.job,
      anim,
      draw.key,
      wf,
      u.gender ?? "male",
      anim === "melee" ? meleeVariant.current : undefined,
    );
    const tex = requestSpriteTexture(url) ?? peekSpriteTexture(url) ?? seedTex;
    if (url !== lastUrl.current) lastUrl.current = url;
    if (tex && mat.current.map !== tex) {
      mat.current.map = tex;
      mat.current.needsUpdate = true;
    }
    // Same world size as the local player. Facing = SE flip only (never mesh.rotation).
    const { spriteW, spriteH } = playerSpriteWorldSize(tex);
    lockUpright(meshRef.current);
    meshRef.current.position.y = spriteH * 0.5;
    meshRef.current.scale.set(draw.mirror ? -spriteW : spriteW, spriteH, 1);
  });

  return (
    <group
      ref={root}
      onClick={(e) => {
        e.stopPropagation();
        useGame.getState().setSelectedTarget(unitId);
        // Ash Pit — engage marked bounty players for PvP.
        if (unitRef.current.pvpBounty) {
          send({ type: "engage", targetId: unitId });
        }
      }}
    >
      {/* Bounty mark — gold ring under marked PvP fighters */}
      {unit.pvpBounty && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} renderOrder={2}>
          <ringGeometry args={[0.5, 0.72, 36]} />
          <meshBasicMaterial
            color="#d4a017"
            transparent
            opacity={0.75}
            depthWrite={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      <group ref={billboard}>
        <mesh
          ref={meshRef}
          position={[0, seedSize.spriteH * 0.5, 0]}
          renderOrder={2}
          scale={[seedSize.spriteW, seedSize.spriteH, 1]}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={mat}
            map={seedTex}
            transparent
            alphaTest={0.08}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
        {isSelected && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} renderOrder={2}>
            <ringGeometry args={[0.55, 0.72, 24]} />
            <meshBasicMaterial color="#e8c878" transparent opacity={0.7} depthWrite={false} />
          </mesh>
        )}
      </group>
    </group>
  );
}

/**
 * Field mobs: sprite + bars + hop only. Avoids remounting the full Quicken/TD
 * tree on every HP tick and interpolates 20Hz flee snaps.
 */
function ShinySparkles({ height }: { height: number }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!group.current) return;
    const t = performance.now() / 1000;
    group.current.children.forEach((ch, i) => {
      const a = t * (1.6 + i * 0.35) + i * 1.7;
      const r = 0.35 + (i % 3) * 0.12;
      ch.position.set(
        Math.cos(a) * r,
        height * (0.35 + 0.45 * ((Math.sin(a * 1.3) + 1) * 0.5)),
        Math.sin(a) * r,
      );
      const mat = (ch as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (mat) mat.opacity = 0.35 + 0.45 * ((Math.sin(a * 2) + 1) * 0.5);
    });
  });
  return (
    <group ref={group} renderOrder={6}>
      {Array.from({ length: 6 }).map((_, i) => (
        <mesh key={i} renderOrder={6}>
          <sphereGeometry args={[0.045, 6, 6]} />
          <meshBasicMaterial
            color={i % 2 === 0 ? "#ffe29a" : "#fff6a8"}
            transparent
            opacity={0.7}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function MobBillboard({ unitId, unit }: { unitId: string; unit: UnitSnapshot }) {
  const root = useRef<THREE.Group>(null);
  const billboard = useRef<THREE.Group>(null);
  /** Separate Y-yaw group so HP bars never inherit sprite mesh mistakes. */
  const barsBillboard = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const hpFill = useRef<THREE.Mesh>(null);
  const barsRoot = useRef<THREE.Group>(null);
  const targetRing = useRef<THREE.Mesh>(null);
  const castTelegraph = useRef<THREE.Mesh>(null);
  const castCircleGround = useRef<THREE.Mesh>(null);
  const castCircleInner = useRef<THREE.Mesh>(null);
  const castCircleMat = useRef<THREE.MeshBasicMaterial>(null);
  const castInnerMat = useRef<THREE.MeshBasicMaterial>(null);
  const castRibbonGroup = useRef<THREE.Group>(null);
  const castRibbonMeshes = useRef<(THREE.Mesh | null)[]>([]);
  const castRibbonMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const lastUrl = useRef("");
  const lastMirror = useRef<boolean | null>(null);
  const lastAnimUntil = useRef(0);
  const lastCastAnimUntil = useRef(0);
  const swingLocalStart = useRef(0);
  const swingLocalDur = useRef(280);
  const castLocalStart = useRef(0);
  const castLocalDur = useRef(700);
  const hopDist = useRef(0);
  const smooth = useRef<SmoothPos>({ x: unit.x, y: unit.y ?? 0, z: unit.z, primed: false });
  const unitRef = useRef(unit);
  unitRef.current = unit;
  const { camera } = useThree();
  const selectedTarget = useGame((s) => s.selectedTarget);
  const isSelected = selectedTarget === unitId;

  const enemyCastTex = useMemo(() => makeEnemyCastCircleTexture("outer"), []);
  const enemyCastInnerTex = useMemo(() => makeEnemyCastCircleTexture("inner"), []);
  const enemyCastRibbonTex = useMemo(() => makeEnemyCastRibbonTexture(), []);
  useEffect(
    () => () => {
      enemyCastTex.dispose();
      enemyCastInnerTex.dispose();
      enemyCastRibbonTex.dispose();
    },
    [enemyCastTex, enemyCastInnerTex, enemyCastRibbonTex],
  );

  const seedUrl = useMemo(() => mobSpriteUrl(unit.archetype, "idle"), [unit.archetype]);
  const seedRaw = useTexture(seedUrl);
  const seedTex = useMemo(() => putSpriteTexture(seedUrl, seedRaw), [seedUrl, seedRaw]);

  const { spriteW0, spriteH0 } = useMemo(() => {
    const iw = (seedTex.image as { width?: number })?.width ?? 3;
    const ih = (seedTex.image as { height?: number })?.height ?? 4;
    const aspect = iw / Math.max(1, ih);
    let mul = 1;
    const arch = unit.archetype ?? "";
    if (arch === "dust_hare" || arch === "pale_slime") mul = 0.58;
    else if (arch === "cliff_adder") mul = 0.62;
    else if (arch === "ashbeam_boar") mul = 0.78;
    else if (arch === "seam_golem") mul = 1.15;
    const h = 2.5 * mul;
    return { spriteW0: h * aspect, spriteH0: h };
  }, [seedTex, unit.archetype]);

  useEffect(() => {
    return subscribeSpriteLoads((url, tex) => {
      if (url === lastUrl.current && mat.current) {
        mat.current.map = tex;
        mat.current.needsUpdate = true;
      }
    });
  }, []);

  useFrame((_, dt) => {
    const live = useGame.getState().snapshot?.units.find((u) => u.id === unitId);
    if (live) unitRef.current = live;
    const u = unitRef.current;
    if (!root.current || !billboard.current || !mat.current || !meshRef.current) return;

    const prevX = smooth.current.x;
    const prevZ = smooth.current.z;
    stepSmoothPos(smooth.current, { x: u.x, y: u.y ?? 0, z: u.z }, dt, false);
    const px = smooth.current.x;
    const pz = smooth.current.z;
    // Analytic field bows above the coarse terrain triangles on hills, so a
    // smoothed server Y leaves feet (and the HP bar) floating. Sample the same
    // mesh each frame at the eased XZ. Bridge decks stay at deck Y. Hop is
    // sprite-local only — it must not lift this root.
    const py = paleHollowStandHeight(px, pz);
    smooth.current.y = py;
    if (smooth.current.primed) {
      const moved = Math.hypot(px - prevX, pz - prevZ);
      if (moved < 1.5) hopDist.current += moved;
    }

    root.current.position.set(px, py, pz);
    lockUpright(root.current);
    const sort = isoSortOrder(px, pz);
    root.current.renderOrder = sort;
    meshRef.current.renderOrder = sort + 2;
    if (barsRoot.current) barsRoot.current.renderOrder = sort + 3;

    // Locked Y-up billboards — same camera yaw as the player, even when far.
    const toCamera = yawBillboardToCamera(billboard.current, camera);
    if (barsBillboard.current) yawBillboardToCamera(barsBillboard.current, camera);
    lockUpright(meshRef.current);
    if (barsRoot.current) lockUpright(barsRoot.current);

    const cp = camera.position;
    const camDist = Math.hypot(cp.x - px, cp.z - pz);
    if (camDist > 32) {
      root.current.visible = camDist < 52;
      return;
    }
    root.current.visible = true;

    if (targetRing.current) {
      const selected = useGame.getState().selectedTarget === u.id;
      targetRing.current.visible = selected;
      if (selected) {
        const pulse = 0.55 + 0.2 * Math.sin(performance.now() / 220);
        (targetRing.current.material as THREE.MeshBasicMaterial).opacity = pulse;
        // Ground ring only — keep pitch from JSX; spin in its local flat plane.
        targetRing.current.rotation.x = -Math.PI / 2;
        targetRing.current.rotation.y = 0;
        targetRing.current.rotation.z = performance.now() / 1800;
        const s = 1 + 0.06 * Math.sin(performance.now() / 280);
        targetRing.current.scale.set(s, s, 1);
      }
    }

    const anim = u.anim as AnimKey;

    // Cast tell — rising edge starts a local window so clock skew / lag still shows the circle.
    // Hero VFX is a ground-plane magic ring under/around the caster's feet (not a floating billboard).
    if (anim === "cast" && u.animUntil > lastCastAnimUntil.current) {
      lastCastAnimUntil.current = u.animUntil;
      castLocalStart.current = performance.now();
      const remain = u.animUntil - Date.now();
      castLocalDur.current = Math.max(550, Math.min(1100, Number.isFinite(remain) ? remain + 80 : 700));
      spawnVfx("castBurst", { x: px, y: py, z: pz });
    } else if (anim !== "cast") {
      lastCastAnimUntil.current = 0;
    }
    const castLocalOn =
      castLocalStart.current > 0 &&
      performance.now() - castLocalStart.current < castLocalDur.current;
    const casting = anim === "cast" && (u.animUntil > Date.now() || castLocalOn);
    // Cinder Burst reuses the same ground circle, drawn wider so the splash reads.
    const aoeMul = (u.castAoe ?? 0) > 0 ? 1.75 : 1;

    if (castTelegraph.current) {
      // Soft under-glow ring — support layer centered on feet
      castTelegraph.current.visible = casting;
      if (casting) {
        const life = Math.min(
          1,
          (performance.now() - castLocalStart.current) / Math.max(1, castLocalDur.current),
        );
        const t = performance.now() / 1000;
        const sc = (0.85 + life * 0.55 + Math.sin(t * 6) * 0.04) * aoeMul;
        castTelegraph.current.position.set(0, 0.04, 0);
        castTelegraph.current.rotation.x = -Math.PI / 2;
        castTelegraph.current.rotation.y = 0;
        castTelegraph.current.scale.set(sc, sc, 1);
        castTelegraph.current.rotation.z = t * 0.7;
        const matC = castTelegraph.current.material as THREE.MeshBasicMaterial;
        matC.opacity = 0.28 + (1 - life) * 0.22 + Math.sin(t * 9) * 0.05;
      }
    }
    if (castCircleGround.current && castCircleMat.current) {
      // Outer ornate ground circle — primary tell, feet-anchored
      castCircleGround.current.visible = casting;
      if (casting) {
        const t = performance.now() / 1000;
        const life = Math.min(
          1,
          (performance.now() - castLocalStart.current) / Math.max(1, castLocalDur.current),
        );
        const pulse = (1.05 + Math.sin(t * 7) * 0.06 + life * 0.28) * aoeMul;
        castCircleGround.current.position.set(0, 0.055, 0);
        castCircleGround.current.rotation.x = -Math.PI / 2;
        castCircleGround.current.rotation.y = 0;
        castCircleGround.current.scale.set(pulse, pulse, 1);
        castCircleGround.current.rotation.z = t * 1.35;
        // Frame-like opacity flicker so the spun decal reads as a multi-frame cast anim
        const frameFlicker = Math.sin(t * 14) * 0.06 + Math.sin(t * 23) * 0.03;
        castCircleMat.current.opacity = 0.62 + (1 - life) * 0.22 + frameFlicker;
      }
    }
    if (castCircleInner.current && castInnerMat.current) {
      // Inner counter-spin rune ring — sells the multi-frame magic-circle motion
      castCircleInner.current.visible = casting;
      if (casting) {
        const t = performance.now() / 1000;
        const life = Math.min(
          1,
          (performance.now() - castLocalStart.current) / Math.max(1, castLocalDur.current),
        );
        const pulse = (0.78 + Math.sin(t * 9) * 0.05 + life * 0.18) * aoeMul;
        castCircleInner.current.position.set(0, 0.07, 0);
        castCircleInner.current.rotation.x = -Math.PI / 2;
        castCircleInner.current.rotation.y = 0;
        castCircleInner.current.scale.set(pulse, pulse, 1);
        castCircleInner.current.rotation.z = -t * 2.55;
        const frameFlicker = Math.sin(t * 17) * 0.07;
        castInnerMat.current.opacity = 0.7 + (1 - life) * 0.18 + frameFlicker;
      }
    }

    // Rising magical-wave ribbons — extrude upward from the ground circle
    if (castRibbonGroup.current) {
      castRibbonGroup.current.visible = casting;
      if (casting) {
        const t = performance.now() / 1000;
        const life = Math.min(
          1,
          (performance.now() - castLocalStart.current) / Math.max(1, castLocalDur.current),
        );
        // Spin with the outer circle so ribbons feel grown from it
        castRibbonGroup.current.rotation.y = t * 1.35;
        const grow = 0.22 + life * 0.78;
        const radius = (0.95 + life * 0.2 + Math.sin(t * 5) * 0.03) * aoeMul;
        // Shared ribbon map — one UV scroll for the whole curtain
        if (enemyCastRibbonTex) {
          enemyCastRibbonTex.offset.y = (t * 0.85) % 1;
        }
        for (let i = 0; i < CAST_RIBBON_COUNT; i++) {
          const mesh = castRibbonMeshes.current[i];
          const rMat = castRibbonMats.current[i];
          if (!mesh || !rMat) continue;
          const a = (i / CAST_RIBBON_COUNT) * Math.PI * 2;
          const und = Math.sin(t * 6.5 + i * 1.1) * 0.07;
          const h = (1.6 + und) * grow;
          mesh.position.set(Math.cos(a) * radius, h * 0.5 + 0.04, Math.sin(a) * radius);
          // Face outward (radial) so the curtain reads from the side
          mesh.rotation.set(0, -a + Math.PI / 2, Math.sin(t * 4 + i) * 0.08);
          mesh.scale.set(0.85 + Math.sin(t * 8 + i * 0.7) * 0.12, grow, 1);
          const flicker = Math.sin(t * 16 + i * 2.1) * 0.08;
          rMat.opacity = 0.45 + (1 - life) * 0.28 + flicker + life * 0.15;
        }
      }
    }

    // Melee rising edge — punch + SFX (sprite swap when assets exist).
    if (anim === "melee" && u.animUntil > lastAnimUntil.current) {
      lastAnimUntil.current = u.animUntil;
      swingLocalStart.current = performance.now();
      const remain = u.animUntil - Date.now();
      swingLocalDur.current = Math.max(160, Math.min(420, Number.isFinite(remain) ? Math.max(remain, 160) : 280));
      const dist = Math.hypot(cp.x - px, cp.z - pz);
      const vol = Math.max(0.15, Math.min(0.6, 1.1 - dist / 28));
      playEnemySwing(vol);
    } else if (anim !== "melee") {
      lastAnimUntil.current = 0;
    }

    const wf = anim === "walk" ? walkFrameAt(performance.now()) : 0;
    const url = mobSpriteUrl(u.archetype, anim, wf);
    if (url !== lastUrl.current) {
      lastUrl.current = url;
      const tex = requestSpriteTexture(url) ?? peekSpriteTexture(url) ?? seedTex;
      if (tex && mat.current.map !== tex) {
        mat.current.map = tex;
        mat.current.needsUpdate = true;
      }
    }

    // Facing = SE mirror via scale.x only (never mesh.rotation).
    const mirror = stickyMobMirror(u.facing, toCamera, lastMirror.current);
    lastMirror.current = mirror;

    let hopY = 0;
    if (anim === "walk") {
      if (u.archetype === "dust_hare") {
        // Distance-driven hop so 20Hz snaps don't reset the arc.
        const phase = (hopDist.current / 0.55) % 1;
        hopY = phase < 0.55 ? Math.sin((phase / 0.55) * Math.PI) * 0.16 : 0;
      } else if (u.archetype === "pale_slime") {
        hopY = Math.abs(Math.sin((performance.now() / 1000) * Math.PI * 2.4)) * 0.09;
      }
    }

    let lunge = 0;
    let attackFlash = false;
    if (anim === "melee") {
      const elapsed = performance.now() - swingLocalStart.current;
      const tSwing = Math.min(1, elapsed / Math.max(1, swingLocalDur.current));
      const punch = tSwing < 0.35 ? tSwing / 0.35 : Math.max(0, 1 - (tSwing - 0.35) / 0.65);
      lunge = 0.06 + punch * 0.22;
      // No authored melee PNG — brief warm flash so the swing still reads.
      if (!mobHasMeleeSprite(u.archetype) && tSwing < 0.85) attackFlash = true;
    }

    // Hop is position.y only. Mirror is scale.x only — never roll the quad.
    lockUpright(meshRef.current);
    meshRef.current.position.set(0, spriteH0 * 0.5 + hopY, lunge);
    const squash = attackFlash ? 1.06 : 1;
    meshRef.current.scale.set(mirror ? -spriteW0 * squash : spriteW0 * squash, spriteH0 * squash, 1);
    if (barsRoot.current) barsRoot.current.position.y = spriteH0 + 0.32;

    if (u.buffs.petrifyUntil > Date.now()) {
      const pulse = 0.85 + Math.sin(performance.now() / 220) * 0.08;
      mat.current.color.setRGB(0.62 * pulse, 0.6 * pulse, 0.58 * pulse);
    } else if (u.buffs.scImpactUntil > Date.now()) {
      const pulse = 0.85 + Math.sin(performance.now() / 55) * 0.15;
      mat.current.color.setRGB(0.95 * pulse, 0.55 * pulse, 0.35 * pulse);
    } else if (casting) {
      // Subtle cast tint — cool blue to match ground/ribbon palette.
      const pulse = 0.94 + Math.sin(performance.now() / 110) * 0.06;
      mat.current.color.setRGB(0.72 * pulse, 0.86 * pulse, 1.0 * pulse);
    } else if (attackFlash) {
      const pulse = 0.92 + Math.sin(performance.now() / 40) * 0.08;
      mat.current.color.setRGB(1.0 * pulse, 0.78 * pulse, 0.55 * pulse);
    } else if (u.shiny) {
      // HQ shiny: warm gold pulse on the same sprite.
      const pulse = 0.88 + Math.sin(performance.now() / 280) * 0.12;
      mat.current.color.setRGB(1.0 * pulse, 0.86 * pulse, 0.42 * pulse);
    } else {
      mat.current.color.set("#ffffff");
    }

    if (u.anim === "dead" || u.hp <= 0) {
      const deathAt = u.deathAt ?? Date.now();
      const fade = Math.max(0, 1 - (Date.now() - deathAt) / MOB_DEATH_FADE_MS);
      mat.current.opacity = fade;
      mat.current.transparent = true;
      root.current.visible = fade > 0.04;
      if (barsRoot.current) barsRoot.current.visible = false;
      if (castTelegraph.current) castTelegraph.current.visible = false;
      if (castCircleGround.current) castCircleGround.current.visible = false;
      if (castCircleInner.current) castCircleInner.current.visible = false;
      if (castRibbonGroup.current) castRibbonGroup.current.visible = false;
    } else {
      mat.current.opacity = 1;
      if (barsRoot.current) barsRoot.current.visible = true;
    }

    const BAR_W = 0.8;
    const hp = Math.max(0, Math.min(1, u.hp / Math.max(1, u.maxHp)));
    if (hpFill.current) {
      hpFill.current.scale.set(Math.max(0.02, hp), 1, 1);
      hpFill.current.position.x = (-BAR_W / 2) * (1 - hp);
      hpFill.current.position.z = 0.002;
    }
  });

  return (
    <group
      ref={root}
      onClick={(e) => {
        e.stopPropagation();
        useGame.getState().setSelectedTarget(unitId);
        send({ type: "engage", targetId: unitId });
      }}
    >
      <mesh
        ref={targetRing}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.04, 0]}
        visible={isSelected}
        renderOrder={2}
      >
        <ringGeometry args={[0.55, 0.78, 40]} />
        <meshBasicMaterial
          color="#e8c060"
          transparent
          opacity={0.7}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Cast under-glow — soft feet-anchored support ring during enemy cast wind-up */}
      <mesh
        ref={castTelegraph}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.04, 0]}
        visible={false}
        renderOrder={2}
      >
        <ringGeometry args={[0.45, 1.35, 56]} />
        <meshBasicMaterial
          color="#4080ff"
          transparent
          opacity={0.35}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Enemy cast tell hero — dual-layer ground magic circle under/around caster feet */}
      <mesh
        ref={castCircleGround}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.055, 0]}
        visible={false}
        renderOrder={3}
      >
        <planeGeometry args={[2.8, 2.8]} />
        <meshBasicMaterial
          ref={castCircleMat}
          map={enemyCastTex}
          color="#a0d0ff"
          transparent
          opacity={0.7}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        ref={castCircleInner}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.07, 0]}
        visible={false}
        renderOrder={4}
      >
        <planeGeometry args={[2.1, 2.1]} />
        <meshBasicMaterial
          ref={castInnerMat}
          map={enemyCastInnerTex}
          color="#e8f4ff"
          transparent
          opacity={0.75}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Rising magical-wave ribbon curtain — extrudes upward from the ground circle */}
      <group ref={castRibbonGroup} visible={false}>
        {Array.from({ length: CAST_RIBBON_COUNT }, (_, i) => (
          <mesh
            key={`cast-ribbon-${i}`}
            ref={(m) => {
              castRibbonMeshes.current[i] = m;
            }}
            position={[0, 0.9, 0]}
            visible
            renderOrder={5}
          >
            <planeGeometry args={[0.55, 2.0]} />
            <meshBasicMaterial
              ref={(m) => {
                castRibbonMats.current[i] = m;
              }}
              map={enemyCastRibbonTex}
              color="#c0e0ff"
              transparent
              opacity={0.55}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>

      {unit.shiny && <ShinySparkles height={spriteH0} />}
      <group ref={billboard}>
        <mesh ref={meshRef} position={[0, spriteH0 * 0.5, 0]} renderOrder={2}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={mat}
            map={seedTex}
            transparent
            alphaTest={0.08}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      </group>
      {/* Bars on their own Y-up billboard — never inherit sprite scale/rotation. */}
      <group ref={barsBillboard}>
        <group ref={barsRoot} position={[0, spriteH0 + 0.32, 0.08]} renderOrder={30}>
          {isSelected && (
            <Html
              center
              transform
              distanceFactor={10}
              position={[0, 0.2, 0]}
              portal={worldHtmlPortalRef}
              zIndexRange={[8, 1]}
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: unit.shiny ? "#ffe29a" : "#efe8dc",
                  textShadow: unit.shiny
                    ? "0 1px 3px #000, 0 0 8px #c9a227"
                    : "0 1px 3px #000, 0 0 6px #3a2a18",
                  whiteSpace: "nowrap",
                  fontFamily: "Cinzel, Georgia, serif",
                  textAlign: "center",
                  lineHeight: 1.1,
                }}
              >
                {unit.name}
              </div>
            </Html>
          )}
          {isSelected && <UnitStatusIcons unit={unit} />}
          <group position={[0, isSelected ? -0.02 : 0, 0]}>
            <mesh renderOrder={30}>
              <planeGeometry args={[0.92, 0.14]} />
              <meshBasicMaterial
                color="#6a4a28"
                transparent
                opacity={0.92}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh position={[0, 0, 0.001]} renderOrder={31}>
              <planeGeometry args={[0.86, 0.1]} />
              <meshBasicMaterial
                color="#1a0e0a"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh ref={hpFill} position={[0, 0, 0.0015]} renderOrder={32}>
              <planeGeometry args={[0.8, 0.07]} />
              <meshBasicMaterial
                color="#c44a3a"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  );
}


function SheetBillboardInner({
  unitId,
  unit,
  isMe,
}: {
  unitId: string;
  unit: UnitSnapshot;
  isMe: boolean;
}) {
  const root = useRef<THREE.Group>(null);
  const billboard = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const legsRef = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const legsMat = useRef<THREE.MeshBasicMaterial>(null);
  const clipLegs = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), []);
  const clipTorso = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const underTint = useMemo(() => new THREE.Color(0.55, 0.72, 0.88), []);
  const aura = useRef<THREE.Mesh>(null);
  const auraMat = useRef<THREE.MeshBasicMaterial>(null);
  const auraFringe = useRef<THREE.Mesh>(null);
  const auraFringeMat = useRef<THREE.MeshBasicMaterial>(null);
  const orbGroup = useRef<THREE.Group>(null);
  const orbMeshes = useRef<(THREE.Mesh | null)[]>([]);
  const pulseMeshes = useRef<(THREE.Mesh | null)[]>([]);
  const trailMeshes = useRef<(THREE.Mesh | null)[]>([]);
  const burstMesh = useRef<THREE.Mesh>(null);
  const burstMat = useRef<THREE.MeshBasicMaterial>(null);
  const levelUpGroup = useRef<THREE.Group>(null);
  const levelUpRings = useRef<(THREE.Mesh | null)[]>([]);
  const levelUpSparks = useRef<(THREE.Mesh | null)[]>([]);
  const tdGroup = useRef<THREE.Group>(null);
  const tdGround = useRef<THREE.Mesh>(null);
  const tdGroundMat = useRef<THREE.MeshBasicMaterial>(null);
  const tdCrack = useRef<THREE.Mesh>(null);
  const tdCrackMat = useRef<THREE.MeshBasicMaterial>(null);
  const tdDebris = useRef<(THREE.Mesh | null)[]>([]);
  const tdPetrify = useRef<THREE.Mesh>(null);
  const tdPetrifyMat = useRef<THREE.MeshBasicMaterial>(null);
  const quickenWasOn = useRef(false);
  const burstUntil = useRef(0);
  const activateAt = useRef(0);
  const hpFill = useRef<THREE.Mesh>(null);
  const mpFill = useRef<THREE.Mesh>(null);
  const hpRow = useRef<THREE.Group>(null);
  const mpTrack = useRef<THREE.Group>(null);
  const barsRoot = useRef<THREE.Group>(null);
  const targetRing = useRef<THREE.Mesh>(null);
  const castTelegraph = useRef<THREE.Mesh>(null);
  const castCircleGround = useRef<THREE.Mesh>(null);
  const castCircleInner = useRef<THREE.Mesh>(null);
  const castCircleMat = useRef<THREE.MeshBasicMaterial>(null);
  const castInnerMat = useRef<THREE.MeshBasicMaterial>(null);
  const castRibbonGroup = useRef<THREE.Group>(null);
  const castRibbonMeshes = useRef<(THREE.Mesh | null)[]>([]);
  const castRibbonMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const lastUrl = useRef("");
  const lastFacing = useRef<ReturnType<typeof facingPick> | null>(null);
  const lastAnimUntil = useRef(0);
  const lastCastAnimUntil = useRef(0);
  const lastTdImpactUntil = useRef(0);
  const swingLocalStart = useRef(0);
  const swingLocalDur = useRef(280);
  const meleeVariant = useRef(1);
  const smooth = useRef<SmoothPos>({ x: unit.x, y: unit.y ?? 0, z: unit.z, primed: false });
  const smoothFacing = useRef<number | null>(null);
  const unitRef = useRef(unit);
  unitRef.current = unit;
  const { camera } = useThree();
  const selectedTarget = useGame((s) => s.selectedTarget);
  const isSelected = selectedTarget === unit.id;

  const orbTex = useMemo(() => makeGlowOrbTexture(), []);
  const pulseTex = useMemo(() => makeResonanceRingTexture(), []);
  const enemyCastTex = useMemo(() => makeEnemyCastCircleTexture("outer"), []);
  const enemyCastInnerTex = useMemo(() => makeEnemyCastCircleTexture("inner"), []);
  const enemyCastRibbonTex = useMemo(() => makeEnemyCastRibbonTexture(), []);
  const tdRingTex = useMemo(() => makeEarthChronaRingTexture(), []);
  const tdCrackTex = useMemo(() => makeChronaCrackTexture(), []);
  const petrifyTex = useMemo(() => makePetrifyCrackTexture(), []);
  useEffect(
    () => () => {
      orbTex.dispose();
      pulseTex.dispose();
      enemyCastTex.dispose();
      enemyCastInnerTex.dispose();
      enemyCastRibbonTex.dispose();
      tdRingTex.dispose();
      tdCrackTex.dispose();
      petrifyTex.dispose();
    },
    [orbTex, pulseTex, enemyCastTex, enemyCastInnerTex, enemyCastRibbonTex, tdRingTex, tdCrackTex, petrifyTex],
  );

  const jobKey = unit.kind === "player" ? (unit.job ?? "time_mage") : "mob";
  const gender: Gender = unit.kind === "player" ? (unit.gender ?? "male") : "male";
  // Seed only â€” do NOT Suspense-load the full job sheet (all dirs + walk + actions).
  const seedUrl = useMemo(() => {
    if (unit.kind === "mob") return mobSpriteUrl(unit.archetype, "idle");
    return playerSpriteUrl(jobKey, "idle", "se", 0, gender);
  }, [unit.kind, unit.archetype, jobKey, gender]);
  const seedRaw = useTexture(seedUrl);
  const seedTex = useMemo(() => putSpriteTexture(seedUrl, seedRaw), [seedUrl, seedRaw]);

  useEffect(() => {
    return subscribeSpriteLoads((url, tex) => {
      if (url === lastUrl.current) {
        if (mat.current) {
          mat.current.map = tex;
          mat.current.needsUpdate = true;
        }
        if (legsMat.current) {
          legsMat.current.map = tex;
          legsMat.current.needsUpdate = true;
        }
      }
    });
  }, []);

  useFrame((_, dt) => {
    const live = useGame.getState().snapshot?.units.find((u) => u.id === unitId);
    if (live) unitRef.current = live;
    const u = unitRef.current;
    if (!root.current || !billboard.current || !mat.current || !meshRef.current) return;

    // Ease everyone (incl. local chase) toward 20Hz snapshots — never hard-snap each tick.
    // Local player uses a slightly snappier rate so combat close-in still feels responsive.
    stepSmoothPos(smooth.current, { x: u.x, y: u.y ?? 0, z: u.z }, dt, false, isMe ? 26 : 18);
    const px = smooth.current.x;
    const py = smooth.current.y;
    const pz = smooth.current.z;
    const face = stepSmoothFacing(smoothFacing.current, u.facing, dt, isMe ? 16 : 12);
    smoothFacing.current = face;
    if (isMe) {
      localVisual.x = px;
      localVisual.y = py;
      localVisual.z = pz;
      localVisual.facing = face;
      localVisual.primed = true;
    }
    // Drive transform only here â€” never also via React position props (that caused jitter)
    root.current.position.set(px, py, pz);
    lockUpright(root.current);
    // Same iso key as medium/tall props â€” behind tree = lower order, in front = higher
    const sort = isoSortOrder(px, pz);
    root.current.renderOrder = sort;
    if (meshRef.current) meshRef.current.renderOrder = sort + 2;
    if (legsRef.current) legsRef.current.renderOrder = sort + 1;
    if (barsRoot.current) barsRoot.current.renderOrder = sort + 3;
    if (billboard.current) billboard.current.renderOrder = sort;

    const cp = camera.position;
    const toCamera = yawBillboardToCamera(billboard.current, camera);
    lockUpright(meshRef.current);
    if (legsRef.current) lockUpright(legsRef.current);
    if (barsRoot.current) lockUpright(barsRoot.current);

    // Far units: pose only — skip sprite/VFX work
    const camDist = Math.hypot(cp.x - px, cp.z - pz);
    if (!isMe && camDist > 32) {
      root.current.visible = camDist < 52;
      return;
    }
    root.current.visible = true;

    if (targetRing.current) {
      const selected = useGame.getState().selectedTarget === u.id;
      targetRing.current.visible = selected && u.kind === "mob";
      if (selected) {
        const pulse = 0.55 + 0.2 * Math.sin(performance.now() / 220);
        const matR = targetRing.current.material as THREE.MeshBasicMaterial;
        matR.opacity = pulse;
        targetRing.current.rotation.x = -Math.PI / 2;
        targetRing.current.rotation.y = 0;
        targetRing.current.rotation.z = performance.now() / 1800;
        const s = 1 + 0.06 * Math.sin(performance.now() / 280);
        targetRing.current.scale.set(s, s, 1);
      }
    }

    const casting = u.anim === "cast" && u.animUntil > Date.now();
    // Player cast telegraph still sits slightly forward; enemy hero is feet-anchored ground circle.
    const faceAng = u.facing ?? 0;
    const fwdX = Math.sin(faceAng);
    const fwdZ = Math.cos(faceAng);
    const castFwd = u.kind === "mob" ? 0 : 0.15;
    const aoeMul = u.kind === "mob" && (u.castAoe ?? 0) > 0 ? 1.75 : 1;

    if (castTelegraph.current) {
      castTelegraph.current.visible = casting;
      if (casting) {
        const remain = Math.max(0, u.animUntil - Date.now());
        const dur = Math.max(800, Math.min(1200, remain + 50));
        const life = 1 - Math.min(1, remain / dur);
        const t = performance.now() / 1000;
        const sc = (u.kind === "mob" ? 0.85 + life * 0.55 + Math.sin(t * 6) * 0.04 : 0.7 + life * 1.4) * aoeMul;
        castTelegraph.current.position.set(fwdX * castFwd, 0.04, fwdZ * castFwd);
        castTelegraph.current.rotation.x = -Math.PI / 2;
        castTelegraph.current.rotation.y = 0;
        castTelegraph.current.scale.set(sc, sc, 1);
        castTelegraph.current.rotation.z = u.kind === "mob" ? t * 0.7 : performance.now() / 900;
        const matC = castTelegraph.current.material as THREE.MeshBasicMaterial;
        matC.opacity = u.kind === "mob" ? 0.28 + (1 - life) * 0.22 + Math.sin(t * 9) * 0.05 : 0.25 + (1 - life) * 0.45;
        matC.color.set(u.kind === "mob" ? "#4080ff" : "#70c0e8");
      }
    }

    // Enemy cast tell hero — dual-layer ground magic circle under/around caster feet.
    if (castCircleGround.current && castCircleMat.current) {
      const show = casting && u.kind === "mob";
      castCircleGround.current.visible = show;
      if (show) {
        const t = performance.now() / 1000;
        const remain = Math.max(0, u.animUntil - Date.now());
        const life = 1 - Math.min(1, remain / 1000);
        const pulse = (1.05 + Math.sin(t * 7) * 0.06 + life * 0.28) * aoeMul;
        castCircleGround.current.position.set(0, 0.055, 0);
        castCircleGround.current.rotation.x = -Math.PI / 2;
        castCircleGround.current.rotation.y = 0;
        castCircleGround.current.scale.set(pulse, pulse, 1);
        castCircleGround.current.rotation.z = t * 1.35;
        const frameFlicker = Math.sin(t * 14) * 0.06 + Math.sin(t * 23) * 0.03;
        castCircleMat.current.opacity = 0.62 + (1 - life) * 0.22 + frameFlicker;
      }
    }
    if (castCircleInner.current && castInnerMat.current) {
      const show = casting && u.kind === "mob";
      castCircleInner.current.visible = show;
      if (show) {
        const t = performance.now() / 1000;
        const remain = Math.max(0, u.animUntil - Date.now());
        const life = 1 - Math.min(1, remain / 1000);
        const pulse = (0.78 + Math.sin(t * 9) * 0.05 + life * 0.18) * aoeMul;
        castCircleInner.current.position.set(0, 0.07, 0);
        castCircleInner.current.rotation.x = -Math.PI / 2;
        castCircleInner.current.rotation.y = 0;
        castCircleInner.current.scale.set(pulse, pulse, 1);
        castCircleInner.current.rotation.z = -t * 2.55;
        const frameFlicker = Math.sin(t * 17) * 0.07;
        castInnerMat.current.opacity = 0.7 + (1 - life) * 0.18 + frameFlicker;
      }
    }

    // Rising magical-wave ribbons — extrude upward from the ground circle (mob only)
    if (castRibbonGroup.current) {
      const show = casting && u.kind === "mob";
      castRibbonGroup.current.visible = show;
      if (show) {
        const t = performance.now() / 1000;
        const remain = Math.max(0, u.animUntil - Date.now());
        const life = 1 - Math.min(1, remain / 1000);
        castRibbonGroup.current.rotation.y = t * 1.35;
        const grow = 0.22 + life * 0.78;
        const radius = (0.95 + life * 0.2 + Math.sin(t * 5) * 0.03) * aoeMul;
        if (enemyCastRibbonTex) {
          enemyCastRibbonTex.offset.y = (t * 0.85) % 1;
        }
        for (let i = 0; i < CAST_RIBBON_COUNT; i++) {
          const mesh = castRibbonMeshes.current[i];
          const rMat = castRibbonMats.current[i];
          if (!mesh || !rMat) continue;
          const a = (i / CAST_RIBBON_COUNT) * Math.PI * 2;
          const und = Math.sin(t * 6.5 + i * 1.1) * 0.07;
          const h = (1.6 + und) * grow;
          mesh.position.set(Math.cos(a) * radius, h * 0.5 + 0.04, Math.sin(a) * radius);
          mesh.rotation.set(0, -a + Math.PI / 2, Math.sin(t * 4 + i) * 0.08);
          mesh.scale.set(0.85 + Math.sin(t * 8 + i * 0.7) * 0.12, grow, 1);
          const flicker = Math.sin(t * 16 + i * 2.1) * 0.08;
          rMat.opacity = 0.45 + (1 - life) * 0.28 + flicker + life * 0.15;
        }
      }
    }

    // Quarks cast burst — rising edge for players AND enemy casters.
    if (u.anim === "cast" && u.animUntil > lastCastAnimUntil.current) {
      lastCastAnimUntil.current = u.animUntil;
      spawnVfx("castBurst", { x: u.x, y: u.y ?? 0, z: u.z });
    } else if (u.anim !== "cast") {
      lastCastAnimUntil.current = 0;
    }

    // Restart punch + pick attack sprite each time server bumps animUntil.
    if (u.anim === "melee" && u.animUntil > lastAnimUntil.current) {
      lastAnimUntil.current = u.animUntil;
      swingLocalStart.current = performance.now();
      swingLocalDur.current = Math.max(140, Math.min(420, u.animUntil - Date.now()));
      if (u.kind === "player") {
        const slug = spriteSlug(jobSpriteBase(u.job), u.gender ?? "male");
        meleeVariant.current = pickMeleeVariant(slug);
      }
      const dist = Math.hypot(cp.x - u.x, cp.z - u.z);
      const vol = Math.max(0.15, Math.min(0.6, 1.1 - dist / 28));
      if (u.kind === "mob") playEnemySwing(vol);
      else if (u.kind === "player") playJobSwing(u.job, vol);
    } else if (u.anim !== "melee") {
      lastAnimUntil.current = 0;
    }

    const anim = u.anim as AnimKey;
    let url: string;
    let mirror = false;
    const bodyFacing = face;
    if (u.kind === "mob") {
      const wf = anim === "walk" ? walkFrameAt(performance.now()) : 0;
      url = mobSpriteUrl(u.archetype, anim, wf);
      mirror = stickyMobMirror(bodyFacing, toCamera, lastFacing.current?.mirror ?? null);
      lastFacing.current = { key: "se", mirror };
    } else {
      const pick = facingPick(bodyFacing, toCamera, lastFacing.current);
      lastFacing.current = pick;
      const slug = spriteSlug(jobSpriteBase(u.job), u.gender ?? "male");
      const draw = applyArtFacing(slug, pick);
      const wf = anim === "walk" ? walkFrameAt(performance.now()) : 0;
      url = playerSpriteUrl(
        u.job,
        anim,
        draw.key,
        wf,
        u.gender ?? "male",
        anim === "melee" ? meleeVariant.current : undefined,
      );
      mirror = draw.mirror;
    }

    if (url !== lastUrl.current) {
      lastUrl.current = url;
    }
    const tex = requestSpriteTexture(lastUrl.current) ?? peekSpriteTexture(lastUrl.current) ?? seedTex;
    if (tex && mat.current.map !== tex) {
      mat.current.map = tex;
      mat.current.needsUpdate = true;
    }
    if (tex && legsMat.current && legsMat.current.map !== tex) {
      legsMat.current.map = tex;
      legsMat.current.needsUpdate = true;
    }

    let spriteW = 1.8;
    let spriteH = 2.5;
    let lunge = 0;
    if (tex) {
      if (u.kind === "player" && u.buffs.levelUpUntil > Date.now()) {
        const flash = 0.55 + Math.sin(performance.now() / 60) * 0.45;
        mat.current.color.setRGB(1, 0.92 + flash * 0.08, 0.55 + flash * 0.2);
      } else if (u.kind === "mob" && u.buffs.petrifyUntil > Date.now()) {
        // Stone shell on hit targets only â€” never the caster
        const pulse = 0.85 + Math.sin(performance.now() / 220) * 0.08;
        mat.current.color.setRGB(0.62 * pulse, 0.6 * pulse, 0.58 * pulse);
      } else if (u.kind === "player" && u.buffs.bulwarkFlashUntil > Date.now()) {
        const pulse = 0.88 + Math.sin(performance.now() / 70) * 0.12;
        mat.current.color.setRGB(0.91 * pulse, 0.816 * pulse, 0.784 * pulse);
      } else if (u.kind === "player" && u.buffs.spellbladeFlashUntil > Date.now()) {
        const pulse = 0.86 + Math.sin(performance.now() / 52) * 0.12;
        mat.current.color.setRGB(0.38 * pulse, 0.72 * pulse, 0.68 * pulse);
      } else if (u.kind === "player" && u.buffs.spellbladeUntil > Date.now()) {
        mat.current.color.set("#9ec4bc");
      } else if (u.kind === "player" && u.buffs.enSpellUntil > Date.now()) {
        const pulse = 0.9 + Math.sin(performance.now() / 110) * 0.07;
        mat.current.color.setRGB(0.52 * pulse, 0.68 * pulse, 0.62 * pulse);
      } else if (
        u.kind === "player" &&
        (u.buffs.bulwarkUntil > Date.now() || u.buffs.sentinelUntil > Date.now())
      ) {
        mat.current.color.set("#e8d0c8");
      } else if (u.kind === "player" && u.buffs.sacredLightUntil > Date.now()) {
        const pulse = 0.9 + Math.sin(performance.now() / 65) * 0.1;
        mat.current.color.setRGB(0.95 * pulse, 0.97 * pulse, 1.0 * pulse);
      } else if (u.kind === "player" && u.buffs.asylumUntil > Date.now()) {
        const pulse = 0.88 + Math.sin(performance.now() / 80) * 0.08;
        mat.current.color.setRGB(0.82 * pulse, 0.9 * pulse, 0.98 * pulse);
      } else if (u.kind === "player" && u.buffs.ghostStepUntil > Date.now()) {
        const pulse = 0.82 + Math.sin(performance.now() / 90) * 0.1;
        mat.current.color.setRGB(0.72 * pulse, 0.55 * pulse, 0.95 * pulse);
      } else if (
        u.kind === "player" &&
        (u.buffs.fighterRageFlashUntil > Date.now() ||
          u.buffs.killingStormUntil > Date.now() ||
          u.buffs.berserkUntil > Date.now())
      ) {
        const pulse = 0.86 + Math.sin(performance.now() / 65) * 0.14;
        mat.current.color.setRGB(0.95 * pulse, 0.42 * pulse, 0.38 * pulse);
      } else if (u.kind === "player" && u.buffs.warcryUntil > Date.now()) {
        const pulse = 0.9 + Math.sin(performance.now() / 120) * 0.06;
        mat.current.color.setRGB(0.78 * pulse, 0.72 * pulse, 0.68 * pulse);
      } else if (u.kind === "player" && u.buffs.arcaneFloodUntil > Date.now()) {
        const pulse = 0.88 + Math.sin(performance.now() / 75) * 0.12;
        mat.current.color.setRGB(0.62 * pulse, 0.52 * pulse, 0.98 * pulse);
      } else if (u.kind === "player" && u.buffs.focalNeveUntil > Date.now()) {
        const pulse = 0.9 + Math.sin(performance.now() / 85) * 0.08;
        mat.current.color.setRGB(0.55 * pulse, 0.48 * pulse, 0.95 * pulse);
      } else if (u.kind === "player" && u.buffs.scCastFlashUntil > Date.now()) {
        const pulse = 0.92 + Math.sin(performance.now() / 60) * 0.06;
        mat.current.color.setRGB(0.7 * pulse, 0.65 * pulse, 1 * pulse);
      } else if (u.kind === "mob" && u.buffs.scImpactUntil > Date.now()) {
        const pulse = 0.85 + Math.sin(performance.now() / 55) * 0.15;
        mat.current.color.setRGB(0.95 * pulse, 0.55 * pulse, 0.35 * pulse);
      } else if (u.kind === "player" && u.buffs.flux) mat.current.color.set("#c8fff9");
      else if (u.kind === "player" && u.buffs.aether) mat.current.color.set("#d4c8ff");
      else if (u.kind === "player" && u.buffs.quickenUntil > Date.now()) mat.current.color.set("#fff2c4");
      else {
        mat.current.color.set("#ffffff");
        // Hub campfire rim: warm orange toward fire, cool ambient opposite (still 2D).
        const inHubRim =
          u.x >= PH_HUB.minX - 2 &&
          u.x <= PH_HUB.maxX + 2 &&
          u.z >= PH_HUB.minZ - 2 &&
          u.z <= PH_HUB.maxZ + 4;
        if (inHubRim) {
          const fx = 0 - u.x;
          const fz = 0.4 - u.z;
          const toCamX = cp.x - u.x;
          const toCamZ = cp.z - u.z;
          const cross = fx * toCamZ - fz * toCamX;
          const warm = 0.5 + 0.5 * Math.tanh(cross * 0.15);
          const flicker = 1 + Math.sin(performance.now() / 130) * 0.035 + Math.sin(performance.now() / 70) * 0.025;
          mat.current.color.setRGB(
            (0.86 + warm * 0.28) * flicker,
            (0.88 + warm * 0.08) * flicker,
            (1.0 - warm * 0.32) * flicker,
          );
        }
      }

      // Dead mobs fade out, then the server drops them from the snapshot.
      if (u.kind === "mob" && (u.anim === "dead" || u.hp <= 0)) {
        const deathAt = u.deathAt ?? Date.now();
        const fade = Math.max(0, 1 - (Date.now() - deathAt) / MOB_DEATH_FADE_MS);
        mat.current.opacity = fade;
        mat.current.transparent = true;
        if (legsMat.current) {
          legsMat.current.opacity = fade;
          legsMat.current.transparent = true;
        }
        if (root.current) root.current.visible = fade > 0.04;
        if (barsRoot.current) barsRoot.current.visible = false;
      } else {
        mat.current.opacity = 1;
        if (legsMat.current) legsMat.current.opacity = 1;
        if (root.current) root.current.visible = true;
        if (barsRoot.current) barsRoot.current.visible = true;
        if (u.kind === "player" && u.hp <= 0) {
          mat.current.color.setRGB(0.45, 0.5, 0.58);
        }
      }

      // Mobs: size from idle seed only — walk/melee PNGs are differently cropped
      // and would resize the billboard every frame if we used the current tex.
      const sizeTex = u.kind === "mob" ? seedTex : tex;
      if (u.kind === "player") {
        const sized = playerSpriteWorldSize(sizeTex);
        spriteW = sized.spriteW;
        spriteH = sized.spriteH;
      } else {
        const iw = (sizeTex.image as { width?: number })?.width ?? 3;
        const ih = (sizeTex.image as { height?: number })?.height ?? 4;
        const aspect = iw / Math.max(1, ih);
        const BASE_SPRITE_H = 2.5;
        spriteH = BASE_SPRITE_H;
        spriteW = BASE_SPRITE_H * aspect;
        if (u.kind === "mob") {
          const arch = u.archetype ?? "";
          let mul = 1;
          if (arch === "dust_hare" || arch === "pale_slime") mul = 0.58;
          else if (arch === "cliff_adder") mul = 0.62;
          else if (arch === "ashbeam_boar") mul = 0.78;
          else if (arch === "seam_golem") mul = 1.15;
          spriteW *= mul;
          spriteH *= mul;
        }
      }
      // Restart punch each time server bumps animUntil (stays "melee" under haste).
      // Variant + SFX already handled earlier in this frame when animUntil rose.
      if (u.anim === "melee") {
        const elapsed = performance.now() - swingLocalStart.current;
        const tSwing = Math.min(1, elapsed / Math.max(1, swingLocalDur.current));
        // Ease out: snappy forward, settle back before next hit.
        const punch = tSwing < 0.35 ? tSwing / 0.35 : Math.max(0, 1 - (tSwing - 0.35) / 0.65);
        lunge = 0.06 + punch * 0.2;
      } else {
        lunge = 0;
      }
      // Dust Hare hop bob + slime bounce while moving
      let hopY = 0;
      if (u.kind === "mob" && u.anim === "walk") {
        const t = performance.now() / 1000;
        if (u.archetype === "dust_hare") {
          // Arc hop: up quick, hang, down — ~2.2 hops/sec
          const phase = (t * 2.2) % 1;
          hopY = phase < 0.55 ? Math.sin((phase / 0.55) * Math.PI) * 0.16 : 0;
        } else if (u.archetype === "pale_slime") {
          hopY = Math.abs(Math.sin(t * Math.PI * 2.4)) * 0.09;
        }
      }
      lockUpright(meshRef.current);
      meshRef.current.position.y = spriteH * 0.5 + hopY;
      meshRef.current.position.z = lunge;
      meshRef.current.scale.set(mirror ? -spriteW : spriteW, spriteH, 1);
      if (legsRef.current) {
        lockUpright(legsRef.current);
        legsRef.current.position.y = spriteH * 0.5 + hopY;
        legsRef.current.position.z = lunge;
        legsRef.current.scale.set(mirror ? -spriteW : spriteW, spriteH, 1);
      }
      // Nameplate + bars share one root so mob names stay aligned with HP
      if (barsRoot.current) {
        barsRoot.current.position.y = spriteH + 0.32;
      }
    } else if (barsRoot.current) {
      barsRoot.current.position.y = 2.95;
    }

    // Wade: legs under water, torso always above (water renderOrder is 5)
    const waterY = paleHollowWaterSurfaceY(u.x, u.z);
    const feetY = u.y ?? 0;
    // Cap dunk line at shin so we never clip the whole billboard
    const shinCap = feetY + Math.min(0.55, (spriteH || 2.5) * 0.22);
    const wading = waterY != null && feetY < waterY - 0.02;
    const clipY = wading && waterY != null ? Math.min(waterY, shinCap) : null;
    if (legsRef.current && legsMat.current && mat.current && meshRef.current) {
      // Transparent water draws after order <5; keep torso above always
      meshRef.current.renderOrder = 12;
      if (clipY != null) {
        clipLegs.constant = clipY;
        clipTorso.constant = -clipY;
        legsMat.current.clippingPlanes = [clipLegs];
        mat.current.clippingPlanes = [clipTorso];
        legsRef.current.visible = true;
        legsRef.current.renderOrder = 1;
        legsMat.current.color.copy(mat.current.color).multiply(underTint);
      } else {
        legsMat.current.clippingPlanes = [];
        mat.current.clippingPlanes = [];
        legsRef.current.visible = false;
      }
    }

    const BAR_W = 0.8;
    const hp = Math.max(0, Math.min(1, u.hp / Math.max(1, u.maxHp)));
    const hasMp = u.maxMp > 0;
    const mp = hasMp ? Math.max(0, Math.min(1, u.mp / u.maxMp)) : 0;
    if (hpRow.current) {
      // Mob name shares this plate â€” HP stays under the label
      hpRow.current.position.y = u.kind === "mob" ? -0.02 : hasMp ? 0.06 : 0;
    }
    if (hpFill.current) {
      hpFill.current.visible = true;
      hpFill.current.scale.set(Math.max(0.02, hp), 1, 1);
      hpFill.current.position.x = (-BAR_W / 2) * (1 - hp);
      hpFill.current.position.z = 0.002;
    }
    if (mpTrack.current) {
      mpTrack.current.visible = hasMp;
      mpTrack.current.position.y = u.kind === "mob" ? -0.14 : -0.08;
    }
    if (mpFill.current) {
      mpFill.current.scale.set(Math.max(0.02, mp), 1, 1);
      mpFill.current.position.x = (-BAR_W / 2) * (1 - mp);
      mpFill.current.position.z = 0.002;
    }

    // Non-self (mobs / etc.): sprite+bars done — skip Quicken/TD/aura/level-up CPU.
    if (!isMe) return;

    const t = performance.now() / 1000;
    const fluxOn = u.kind === "player" && u.buffs.flux;
    const quickenOn = u.kind === "player" && u.buffs.quickenUntil > Date.now();
    const leveling = u.kind === "player" && u.buffs.levelUpUntil > Date.now();

    // Level-up column: rising rings + sparks
    if (levelUpGroup.current) {
      levelUpGroup.current.visible = leveling;
      if (leveling) {
        const face = Math.atan2(cp.x - u.x, cp.z - u.z);
        const until = u.buffs.levelUpUntil;
        const dur = 2400;
        const life = Math.max(0, Math.min(1, 1 - (until - performance.now()) / dur));
        for (let i = 0; i < LEVEL_UP_RINGS; i++) {
          const ring = levelUpRings.current[i];
          if (!ring) continue;
          const phase = (life + i / LEVEL_UP_RINGS) % 1;
          ring.position.set(0, 0.3 + phase * 2.6, 0);
          ring.rotation.y = face;
          ring.scale.setScalar(0.4 + phase * 1.8 + i * 0.05);
          const matR = ring.material as THREE.MeshBasicMaterial;
          matR.opacity = Math.max(0, (1 - phase) * 0.85);
          ring.visible = matR.opacity > 0.03;
        }
        for (let i = 0; i < LEVEL_UP_SPARKS; i++) {
          const spark = levelUpSparks.current[i];
          if (!spark) continue;
          const ang = (i / LEVEL_UP_SPARKS) * Math.PI * 2 + t * 1.5;
          const rise = ((life * 1.4 + i * 0.07) % 1);
          const rad = 0.35 + rise * 0.55;
          spark.position.set(Math.cos(ang) * rad, 0.4 + rise * 2.8, Math.sin(ang) * rad * 0.75);
          spark.rotation.y = face;
          spark.scale.setScalar(0.18 + (1 - rise) * 0.12);
          const matS = spark.material as THREE.MeshBasicMaterial;
          matS.opacity = Math.max(0, (1 - rise) * 0.9);
          spark.visible = matS.opacity > 0.04;
        }
      }
    }

    // Flux: body silhouette + wavy abstract fringe
    if (aura.current && auraMat.current) {
      aura.current.visible = fluxOn && !!tex;
      if (fluxOn && tex) {
        if (auraMat.current.map !== tex) {
          auraMat.current.map = tex;
          auraMat.current.needsUpdate = true;
        }
        const waveX = 1 + Math.sin(t * 3.4) * 0.035 + Math.sin(t * 5.1) * 0.02;
        const waveY = 1 + Math.cos(t * 2.9) * 0.04 + Math.sin(t * 4.2 + 1) * 0.02;
        const inflate = 1.14;
        const ah = spriteH * inflate * waveY;
        const aw = spriteW * inflate * waveX;
        aura.current.position.set(
          Math.sin(t * 2.1) * 0.02,
          spriteH * 0.5 + Math.sin(t * 2.7) * 0.02,
          lunge - 0.03,
        );
        aura.current.scale.set(mirror ? -aw : aw, ah, 1);
        auraMat.current.opacity = 0.78 + Math.sin(t * 3.1) * 0.1;
        const hue = (0.48 + t * 0.07 + Math.sin(t * 0.9) * 0.04) % 1;
        const sat = 0.78 + Math.sin(t * 1.6) * 0.08;
        const lit = 0.76 + Math.sin(t * 2.2) * 0.06;
        auraMat.current.color.setHSL(hue, sat, lit);
      }
    }
    if (auraFringe.current && auraFringeMat.current) {
      auraFringe.current.visible = fluxOn;
      if (fluxOn) {
        const fringeTex = requestSpriteTexture(FLUX_AURA_URL);
        if (fringeTex && auraFringeMat.current.map !== fringeTex) {
          auraFringeMat.current.map = fringeTex;
          auraFringeMat.current.needsUpdate = true;
        }
        const fw = (2.9 + Math.sin(t * 2.2) * 0.12) * (1 + Math.sin(t * 4.5) * 0.04);
        const fh = (3.3 + Math.cos(t * 1.9) * 0.14) * (1 + Math.cos(t * 3.7) * 0.05);
        auraFringe.current.position.set(
          Math.sin(t * 1.7 + 0.5) * 0.04,
          1.32 + Math.cos(t * 2.3) * 0.03,
          lunge - 0.06,
        );
        auraFringe.current.scale.set(fw, fh, 1);
        auraFringe.current.rotation.z = Math.sin(t * 0.8) * 0.06;
        auraFringeMat.current.opacity = 0.42 + Math.sin(t * 2.6) * 0.1;
        const hue2 = (0.52 + t * 0.09 + Math.sin(t * 1.1) * 0.05) % 1;
        auraFringeMat.current.color.setHSL(hue2, 0.7, 0.7);
      }
    }

    // Quicken: dual belts + trails + occlusion + cast burst
    if (orbGroup.current) {
      const nowMs = performance.now();
      if (quickenOn && !quickenWasOn.current) {
        burstUntil.current = nowMs + QUICKEN_BURST_MS;
        activateAt.current = nowMs;
        spawnVfx("castBurst", { x: u.x, y: u.y ?? 0, z: u.z });
      }
      quickenWasOn.current = quickenOn;
      orbGroup.current.visible = quickenOn || nowMs < burstUntil.current;

      if (quickenOn || nowMs < burstUntil.current) {
        const face = Math.atan2(cp.x - u.x, cp.z - u.z);
        const baseY = 1.62;
        const fullRadius = 0.82;
        const speed = 2.7;
        // Snap out from chest on activate
        const sinceActivate = (nowMs - activateAt.current) / 1000;
        const emerge = quickenOn ? Math.min(1, sinceActivate / 0.32) : 0;
        const emergeEased = emerge * emerge * (3 - 2 * emerge);
        const radius = fullRadius * emergeEased;

        // Cast burst ring from chest
        if (burstMesh.current && burstMat.current) {
          const bursting = nowMs < burstUntil.current;
          burstMesh.current.visible = bursting;
          if (bursting) {
            const life = 1 - (burstUntil.current - nowMs) / QUICKEN_BURST_MS;
            burstMesh.current.position.set(0, baseY, 0);
            burstMesh.current.rotation.y = face;
            burstMesh.current.scale.setScalar(0.35 + life * 2.4);
            burstMat.current.opacity = Math.max(0, (1 - life) * (1 - life) * 0.95);
          }
        }

        for (let belt = 0; belt < QUICKEN_BELT_COUNT; belt++) {
          const flipped = belt === 1;
          const tilt = flipped ? -0.16 : 0.16;
          const dir = flipped ? -1 : 1;
          const spin = t * speed * dir;

          for (let j = 0; j < QUICKEN_ORBS_PER_BELT; j++) {
            const i = belt * QUICKEN_ORBS_PER_BELT + j;
            const mesh = orbMeshes.current[i];
            if (!mesh) continue;

            const ang =
              spin + (j / QUICKEN_ORBS_PER_BELT) * Math.PI * 2 + (flipped ? Math.PI / QUICKEN_ORBS_PER_BELT : 0);
            const { x, y, z } = quickenOrbPose(ang, radius, baseY, tilt, flipped);
            const depth = depthVsBillboard(x, z, face);
            const behind = depth < -0.04;
            const front = depth > 0.06;

            mesh.position.set(x, y, z);
            mesh.rotation.y = face;
            mesh.scale.setScalar(behind ? 0.2 : 0.26);
            mesh.renderOrder = front ? 12 : behind ? 1 : 8;
            const matOrb = mesh.material as THREE.MeshBasicMaterial;
            const baseOp = behind ? 0.22 : 0.9 + Math.sin(t * 2.4 + i) * 0.05;
            matOrb.opacity = baseOp * Math.max(0.15, emergeEased);

            // Motion trails â€” ghost samples along orbit behind the orb
            for (let k = 1; k <= QUICKEN_TRAIL_LEN; k++) {
              const ti = i * QUICKEN_TRAIL_LEN + (k - 1);
              const trail = trailMeshes.current[ti];
              if (!trail) continue;
              const trailAng = ang - dir * k * 0.15;
              const tp = quickenOrbPose(trailAng, radius, baseY, tilt, flipped);
              const tDepth = depthVsBillboard(tp.x, tp.z, face);
              const tBehind = tDepth < -0.04;
              const fade = 1 - k / (QUICKEN_TRAIL_LEN + 1);
              trail.position.set(tp.x, tp.y, tp.z);
              trail.rotation.y = face;
              trail.scale.setScalar(0.26 * fade * 0.85);
              trail.renderOrder = tDepth > 0.06 ? 11 : tBehind ? 0 : 7;
              const matTrail = trail.material as THREE.MeshBasicMaterial;
              matTrail.opacity = (tBehind ? 0.08 : 0.42) * fade * emergeEased;
              trail.visible = matTrail.opacity > 0.02 && emergeEased > 0.05;
            }

            const pulse = pulseMeshes.current[i];
            if (pulse) {
              const period = 1.15;
              const life = ((t * 1.05 + i * 0.17) % period) / period;
              pulse.position.set(x, y, z);
              pulse.rotation.y = face;
              pulse.scale.setScalar(0.18 + life * 0.7);
              pulse.renderOrder = front ? 11 : 6;
              const matPulse = pulse.material as THREE.MeshBasicMaterial;
              const pOp = Math.max(0, (1 - life) * (1 - life) * (behind ? 0.18 : 0.5) * emergeEased);
              matPulse.opacity = pOp;
              pulse.visible = pOp > 0.02;
            }
          }
        }
      } else if (burstMesh.current) {
        burstMesh.current.visible = false;
      }
    }

    // Temporal Distortion â€” earth + chrona impact on hit *enemies* only (never the caster)
    const nowHit = Date.now();
    const isHitTarget = u.kind === "mob";
    const tdUntil = u.buffs.tdImpactUntil ?? 0;
    const tdImpacting = isHitTarget && tdUntil > nowHit;
    const petrified = isHitTarget && (u.buffs.petrifyUntil ?? 0) > nowHit;
    if (tdImpacting) {
      playTemporalDistortion(tdUntil);
      // Quarks hit spark — once per impact wave edge on this mob
      if (tdUntil > lastTdImpactUntil.current) {
        lastTdImpactUntil.current = tdUntil;
        spawnVfx("hitSpark", { x: u.x, y: u.y ?? 0, z: u.z });
      }
    } else if (!tdImpacting) {
      lastTdImpactUntil.current = 0;
    }
    if (tdGroup.current) {
      tdGroup.current.visible = tdImpacting || petrified;
      if (tdImpacting || petrified) {
        const until = tdUntil;
        const life = tdImpacting ? Math.min(1, Math.max(0, 1 - (until - nowHit) / 1400)) : 1;

        if (tdGround.current && tdGroundMat.current) {
          tdGround.current.visible = tdImpacting;
          if (tdImpacting) {
            const grow = 0.6 + life * 3.8;
            tdGround.current.scale.set(grow, grow, 1);
            tdGround.current.rotation.z = life * 0.35;
            tdGroundMat.current.opacity = Math.max(0, (1 - life) * 0.95);
          }
        }

        if (tdCrack.current && tdCrackMat.current) {
          tdCrack.current.visible = tdImpacting;
          if (tdImpacting) {
            tdCrack.current.position.set(0, 1.15 + life * 0.35, 0.08);
            const sy = 1.4 + life * 1.1;
            const sx = 1.1 + life * 0.6;
            tdCrack.current.scale.set(sx, sy, 1);
            tdCrackMat.current.opacity = Math.max(0, (1 - life * 0.85) * 0.95);
          }
        }

        for (let i = 0; i < TD_DEBRIS; i++) {
          const chunk = tdDebris.current[i];
          if (!chunk) continue;
          chunk.visible = tdImpacting;
          if (!tdImpacting) continue;
          const ang = (i / TD_DEBRIS) * Math.PI * 2 + life * 1.4;
          const rad = 0.25 + life * (1.1 + (i % 3) * 0.25);
          const y = 0.35 + life * (1.6 + (i % 4) * 0.2) - life * life * 0.8;
          chunk.position.set(Math.cos(ang) * rad, y, Math.sin(ang) * rad * 0.7);
          const sz = 0.12 + (i % 3) * 0.04;
          chunk.scale.setScalar(sz * (1.2 - life * 0.5));
          const matChunk = chunk.material as THREE.MeshBasicMaterial;
          matChunk.opacity = Math.max(0, (1 - life) * (i % 2 === 0 ? 0.95 : 0.7));
          matChunk.color.set(i % 3 === 0 ? "#7ecfc0" : "#c4a060");
        }

        if (tdPetrify.current && tdPetrifyMat.current && meshRef.current) {
          tdPetrify.current.visible = petrified;
          if (petrified) {
            tdPetrify.current.position.copy(meshRef.current.position);
            tdPetrify.current.position.z += 0.03;
            const s = meshRef.current.scale;
            tdPetrify.current.scale.set(Math.abs(s.x) * 1.02, s.y * 1.02, 1);
            const shimmer = 0.35 + Math.sin(performance.now() / 280) * 0.12;
            tdPetrifyMat.current.opacity = shimmer;
          }
        }
      } else {
        // Ensure caster / non-targets never keep leftover TD meshes
        if (tdGround.current) tdGround.current.visible = false;
        if (tdCrack.current) tdCrack.current.visible = false;
        if (tdPetrify.current) tdPetrify.current.visible = false;
        for (const chunk of tdDebris.current) {
          if (chunk) chunk.visible = false;
        }
      }
    }
  });

  const showName =
    unit.kind === "mob"
      ? isSelected
      : !isMe && isSelected; // remote player labels only when targeted — Html is expensive at scale

  return (
    <group
      ref={root}
      onClick={(e) => {
        e.stopPropagation();
        if (unitRef.current.kind === "mob" || unitRef.current.kind === "player") {
          useGame.getState().setSelectedTarget(unitRef.current.id);
          if (
            unitRef.current.kind === "mob" ||
            (unitRef.current.kind === "player" && unitRef.current.pvpBounty)
          ) {
            send({ type: "engage", targetId: unitRef.current.id });
          }
        }
      }}
    >
      {/* Selected-target ring (mobs + marked PvP players) */}
      <mesh
        ref={targetRing}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.04, 0]}
        visible={
          isSelected && (unit.kind === "mob" || (unit.kind === "player" && !!unit.pvpBounty))
        }
        renderOrder={2}
      >
        <ringGeometry args={[0.55, 0.78, 40]} />
        <meshBasicMaterial
          color="#e8c060"
          transparent
          opacity={0.7}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Cast telegraph — soft under-glow (enemy feet-anchored; player slight forward) */}
      <mesh
        ref={castTelegraph}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.04, 0]}
        visible={false}
        renderOrder={2}
      >
        <ringGeometry args={[0.45, 1.35, 56]} />
        <meshBasicMaterial
          color="#4080ff"
          transparent
          opacity={0.35}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Enemy cast tell hero — dual-layer ground magic circle under/around caster feet */}
      <mesh
        ref={castCircleGround}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.055, 0]}
        visible={false}
        renderOrder={3}
      >
        <planeGeometry args={[2.8, 2.8]} />
        <meshBasicMaterial
          ref={castCircleMat}
          map={enemyCastTex}
          color="#a0d0ff"
          transparent
          opacity={0.7}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        ref={castCircleInner}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.07, 0]}
        visible={false}
        renderOrder={4}
      >
        <planeGeometry args={[2.1, 2.1]} />
        <meshBasicMaterial
          ref={castInnerMat}
          map={enemyCastInnerTex}
          color="#e8f4ff"
          transparent
          opacity={0.75}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Rising magical-wave ribbon curtain — extrudes upward from the ground circle */}
      <group ref={castRibbonGroup} visible={false}>
        {Array.from({ length: CAST_RIBBON_COUNT }, (_, i) => (
          <mesh
            key={`cast-ribbon-inner-${i}`}
            ref={(m) => {
              castRibbonMeshes.current[i] = m;
            }}
            position={[0, 0.9, 0]}
            visible
            renderOrder={5}
          >
            <planeGeometry args={[0.55, 2.0]} />
            <meshBasicMaterial
              ref={(m) => {
                castRibbonMats.current[i] = m;
              }}
              map={enemyCastRibbonTex}
              color="#c0e0ff"
              transparent
              opacity={0.55}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>

      {/* Temporal Distortion â€” earth + chrona hit (ground + debris); crack/petrify on billboard */}
      <group ref={tdGroup} visible={false}>
        <mesh
          ref={tdGround}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.04, 0]}
          visible={false}
          renderOrder={4}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={tdGroundMat}
            map={tdRingTex}
            transparent
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            opacity={0}
            side={THREE.DoubleSide}
          />
        </mesh>
        {Array.from({ length: TD_DEBRIS }, (_, i) => (
          <mesh
            key={`td-debris-${i}`}
            ref={(m) => {
              tdDebris.current[i] = m;
            }}
            visible={false}
            renderOrder={12}
          >
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              map={orbTex}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              opacity={0}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>

      {/* Level-up VFX â€” rising gold/teal rings + sparks */}
      <group ref={levelUpGroup} visible={false}>
        {Array.from({ length: LEVEL_UP_RINGS }, (_, i) => (
          <mesh
            key={`lu-ring-${i}`}
            ref={(m) => {
              levelUpRings.current[i] = m;
            }}
            visible={false}
            renderOrder={14}
          >
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              map={pulseTex}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              color="#ffe08a"
              opacity={0}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
        {Array.from({ length: LEVEL_UP_SPARKS }, (_, i) => (
          <mesh
            key={`lu-spark-${i}`}
            ref={(m) => {
              levelUpSparks.current[i] = m;
            }}
            visible={false}
            renderOrder={15}
          >
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              map={orbTex}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              color="#fff6c8"
              opacity={0}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>

      {/* Quicken â€” dual belts, trails, cast burst */}
      <group ref={orbGroup} visible={false}>
        <mesh ref={burstMesh} position={[0, 1.62, 0]} visible={false} renderOrder={13}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={burstMat}
            map={pulseTex}
            transparent
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            opacity={0}
            side={THREE.DoubleSide}
          />
        </mesh>
        {Array.from({ length: QUICKEN_ORB_TOTAL * QUICKEN_TRAIL_LEN }, (_, i) => (
          <mesh
            key={`trail-${i}`}
            ref={(m) => {
              trailMeshes.current[i] = m;
            }}
            visible={false}
            renderOrder={6}
          >
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              map={orbTex}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              opacity={0}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
        {Array.from({ length: QUICKEN_ORB_TOTAL }, (_, i) => (
          <mesh
            key={`orb-${i}`}
            ref={(m) => {
              orbMeshes.current[i] = m;
            }}
            renderOrder={8}
          >
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              map={orbTex}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              opacity={0.85}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
        {Array.from({ length: QUICKEN_ORB_TOTAL }, (_, i) => (
          <mesh
            key={`pulse-${i}`}
            ref={(m) => {
              pulseMeshes.current[i] = m;
            }}
            visible={false}
            renderOrder={7}
          >
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial
              map={pulseTex}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
              opacity={0}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>

      <group ref={billboard}>
        {/* Flux fringe â€” abstract wavy energy behind the silhouette */}
        <mesh ref={auraFringe} position={[0, 1.32, -0.06]} visible={false} renderOrder={0}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={auraFringeMat}
            transparent
            depthWrite={false}
            toneMapped={false}
            color="#ffffff"
            opacity={0.45}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* Flux silhouette â€” player-shaped core with soft wave */}
        <mesh ref={aura} position={[0, 1.25, -0.03]} visible={false} renderOrder={1}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={auraMat}
            transparent
            alphaTest={0.12}
            depthWrite={false}
            toneMapped={false}
            color="#ffffff"
            opacity={0.85}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* Legs under water (sort); water (5); torso just above legs in same iso band */}
        <mesh ref={legsRef} position={[0, 1.25, 0]} visible={false} renderOrder={1}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={legsMat}
            map={seedTex}
            transparent
            alphaTest={0.08}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
            clippingPlanes={[]}
          />
        </mesh>

        <mesh ref={meshRef} position={[0, 1.25, 0]} renderOrder={2}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={mat}
            map={seedTex}
            transparent
            alphaTest={0.08}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
            clippingPlanes={[]}
          />
        </mesh>

        {/* TD chrona crack (impact) + petrify stone overlay */}
        <mesh ref={tdCrack} position={[0, 1.2, 0.05]} visible={false} renderOrder={8}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={tdCrackMat}
            map={tdCrackTex}
            transparent
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            opacity={0}
            side={THREE.DoubleSide}
          />
        </mesh>
        <mesh ref={tdPetrify} position={[0, 1.25, 0.03]} visible={false} renderOrder={3}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={tdPetrifyMat}
            map={petrifyTex}
            transparent
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
            opacity={0}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* Nameplate + HP/MP â€” single root so name aligns with bars */}
        <group ref={barsRoot} position={[0, 2.9, 0.08]} renderOrder={30}>
          {showName && (
            <Html
              center
              transform={unit.kind === "mob"}
              distanceFactor={unit.kind === "mob" ? 10 : undefined}
              position={[0, unit.kind === "mob" ? 0.2 : 0.28, 0]}
              portal={worldHtmlPortalRef}
              zIndexRange={[8, 1]}
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              <div
                style={{
                  fontSize: unit.kind === "mob" ? 11 : 12,
                  color: "#efe8dc",
                  textShadow: "0 1px 3px #000, 0 0 6px #3a2a18",
                  whiteSpace: "nowrap",
                  fontFamily: "Cinzel, Georgia, serif",
                  textAlign: "center",
                  lineHeight: 1.1,
                }}
              >
                {unit.name}
              </div>
            </Html>
          )}
          {/* HP */}
          <group ref={hpRow} position={[0, showName && unit.kind === "mob" ? -0.02 : 0.06, 0]}>
            <mesh renderOrder={30}>
              <planeGeometry args={[0.92, 0.14]} />
              <meshBasicMaterial
                color="#6a4a28"
                transparent
                opacity={0.92}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh position={[0, 0, 0.001]} renderOrder={31}>
              <planeGeometry args={[0.86, 0.1]} />
              <meshBasicMaterial
                color="#1a0e0a"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh position={[0, 0, 0.0015]} renderOrder={31}>
              <planeGeometry args={[0.8, 0.07]} />
              <meshBasicMaterial
                color="#3a1515"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh ref={hpFill} position={[0, 0, 0.002]} renderOrder={32}>
              <planeGeometry args={[0.8, 0.07]} />
              <meshBasicMaterial
                color="#4ecf6a"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
                toneMapped={false}
              />
            </mesh>
          </group>

          {/* MP â€” only when maxMp > 0 */}
          <group
            ref={mpTrack}
            position={[0, showName && unit.kind === "mob" ? -0.14 : -0.08, 0]}
            visible={false}
          >
            <mesh renderOrder={30}>
              <planeGeometry args={[0.92, 0.12]} />
              <meshBasicMaterial
                color="#4a5870"
                transparent
                opacity={0.92}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh position={[0, 0, 0.001]} renderOrder={31}>
              <planeGeometry args={[0.86, 0.08]} />
              <meshBasicMaterial
                color="#0c1420"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh position={[0, 0, 0.0015]} renderOrder={31}>
              <planeGeometry args={[0.8, 0.055]} />
              <meshBasicMaterial
                color="#152238"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh ref={mpFill} position={[0, 0, 0.002]} renderOrder={32}>
              <planeGeometry args={[0.8, 0.055]} />
              <meshBasicMaterial
                color="#5ab0ff"
                transparent
                opacity={1}
                depthTest={false}
                depthWrite={false}
                side={THREE.DoubleSide}
                toneMapped={false}
              />
            </mesh>
          </group>
        </group>
      </group>

      {(isMe || isSelected) && <UnitStatusIcons unit={unit} />}
    </group>
  );
}

function WasdController() {
  const accum = useRef(0);

  useFrame((_, dt) => {
    accum.current += dt;
    // Faster than arrive-at-short-waypoint so walk anim doesn't drop to idle mid-strafe
    if (accum.current < 0.05) return;
    accum.current = 0;
    const g = useGame.getState();
    const me = g.wallet
      ? g.snapshot?.units.find((u) => u.id === g.wallet)
      : undefined;
    if (!me) return;
    const { w, a, s, d } = getMoveKeys();
    if (!w && !a && !s && !d) return;
    const up = new THREE.Vector3(-1, 0, -1).normalize();
    const right = new THREE.Vector3(1, 0, -1).normalize();
    const dir = new THREE.Vector3();
    if (w) dir.add(up);
    if (s) dir.sub(up);
    if (d) dir.add(right);
    if (a) dir.sub(right);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize().multiplyScalar(4.5);
    const c = paleHollowClampMove(me.x, me.z, me.x + dir.x, me.z + dir.z);
    if (Math.hypot(c.x - me.x, c.z - me.z) < 1e-4) return;
    send({ type: "move", x: c.x, z: c.z });
  });

  useEffect(() => {
    const isMoveKey = (k: string): k is keyof MoveKeys =>
      k === "w" || k === "a" || k === "s" || k === "d";
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (isMoveKey(k)) {
        setKeyboardMoveKey(k, true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (isMoveKey(k)) setKeyboardMoveKey(k, false);
    };
    const blur = () => clearKeyboardMove();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      clearKeyboardMove();
    };
  }, []);

  return null;
}


function NpcWorldMenu({ npcId }: { npcId: string }) {
  const open = useGame((s) => s.npcDialog?.npcId === npcId);
  if (!open) return null;
  // Anchor at feet; CSS/transform drops the card just under the sprite.
  return (
    <Html
      position={[0, 0.02, 0]}
      center={false}
      portal={worldHtmlPortalRef}
      zIndexRange={[60, 50]}
      style={{ pointerEvents: "auto", transform: "translate(-50%, 0)" }}
      distanceFactor={11}
    >
      <NpcInteractMenu />
    </Html>
  );
}

function HallNpc({ unitId }: { unitId: string }) {
  const sig = useGame((s) => {
    const u = s.snapshot?.units.find((x) => x.id === unitId);
    if (!u) return "";
    return `${u.name}|${u.npcRole ?? ""}|${u.x.toFixed(1)}|${u.z.toFixed(1)}`;
  });
  const unit = useMemo(() => {
    void sig;
    return useGame.getState().snapshot?.units.find((x) => x.id === unitId);
  }, [sig, unitId]);
  if (!unit) return null;
  const spriteUrl = npcSpriteUrl(unit.id);
  if (!spriteUrl) return <HallNpcCapsule unit={unit} />;
  return <HallNpcSprite unit={unit} spriteUrl={spriteUrl} />;
}

function HallNpcCapsule({ unit }: { unit: UnitSnapshot }) {
  const role = unit.npcRole;
  const robe = role === "spell_trainer" ? "#3a4a58" : "#6a5a48";
  return (
    <group
      position={[unit.x, unit.y ?? 0, unit.z]}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: "npc/interact", npcId: unit.id });
      }}
    >
      <mesh position={[0, 1.1, 0]}>
        <capsuleGeometry args={[0.35, 1.2, 6, 10]} />
        <meshStandardMaterial color={robe} roughness={0.75} metalness={0.05} />
      </mesh>
      <mesh position={[0, 2.05, 0]}>
        <sphereGeometry args={[0.28, 12, 12]} />
        <meshStandardMaterial color="#c8b090" roughness={0.7} />
      </mesh>
      <Html
        position={[0, 2.6, 0]}
        center
        distanceFactor={14}
        portal={worldHtmlPortalRef}
        zIndexRange={[8, 1]}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            fontFamily: "Cinzel, Georgia, serif",
            fontSize: 11,
            color: "#efe8dc",
            textShadow: "0 1px 3px #000",
            whiteSpace: "nowrap",
          }}
        >
          {unit.name}
        </div>
      </Html>
      <NpcWorldMenu npcId={unit.id} />
    </group>
  );
}

function HallNpcSprite({ unit, spriteUrl }: { unit: UnitSnapshot; spriteUrl: string }) {
  const { camera } = useThree();
  const billboard = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const lastFacing = useRef<ReturnType<typeof facingPick> | null>(null);
  const unitRef = useRef(unit);
  unitRef.current = unit;

  const rawTex = useTexture(spriteUrl);
  const tex = useMemo(() => putSpriteTexture(spriteUrl, rawTex), [spriteUrl, rawTex]);

  const { spriteW, spriteH } = useMemo(() => {
    const iw = (tex.image as { width?: number })?.width ?? 3;
    const ih = (tex.image as { height?: number })?.height ?? 4;
    const aspect = iw / Math.max(1, ih);
    const h = 2.5 * 1.1;
    return { spriteW: h * aspect, spriteH: h };
  }, [tex]);

  useFrame(() => {
    const u = unitRef.current;
    if (!billboard.current || !meshRef.current) return;
    const cp = camera.position;
    const toCamera = yawBillboardToCamera(billboard.current, camera);
    const pick = facingPick(u.facing, toCamera, lastFacing.current);
    lastFacing.current = pick;
    const slug =
      u.kind === "player"
        ? spriteSlug(jobSpriteBase(u.job), (u.gender as Gender | undefined) ?? "male")
        : "";
    const draw = slug ? applyArtFacing(slug, pick) : pick;
    lockUpright(meshRef.current);
    meshRef.current.scale.set(draw.mirror ? -spriteW : spriteW, spriteH, 1);
    // Warm fire rim when standing in the hub encampment.
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    if (mat && !Array.isArray(mat)) {
      const fx = 0 - u.x;
      const fz = 0.4 - u.z;
      const toCamX = cp.x - u.x;
      const toCamZ = cp.z - u.z;
      const cross = fx * toCamZ - fz * toCamX;
      const warm = 0.5 + 0.5 * Math.tanh(cross * 0.15);
      const flicker = 1 + Math.sin(performance.now() / 130) * 0.035 + Math.sin(performance.now() / 70) * 0.025;
      mat.color.setRGB(
        (0.88 + warm * 0.24) * flicker,
        (0.9 + warm * 0.06) * flicker,
        (1.0 - warm * 0.26) * flicker,
      );
    }
  });

  return (
    <group
      position={[unit.x, unit.y ?? 0, unit.z]}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: "npc/interact", npcId: unit.id });
      }}
    >
      <group ref={billboard}>
        <mesh ref={meshRef} position={[0, spriteH * 0.5, 0]} renderOrder={10}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={tex} transparent depthWrite={false} toneMapped={false} />
        </mesh>
        <Html
          position={[0, spriteH + 0.28, 0]}
          center
          distanceFactor={14}
          portal={worldHtmlPortalRef}
          zIndexRange={[8, 1]}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              fontFamily: "Cinzel, Georgia, serif",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              color: "#f0e6d2",
              whiteSpace: "nowrap",
              padding: "3px 10px",
              background: "rgba(18, 14, 10, 0.78)",
              border: "1px solid #c4a868",
              boxShadow: "0 0 0 1px rgba(50,40,20,0.85), 0 2px 6px rgba(0,0,0,0.45)",
              borderRadius: 2,
              textShadow: "0 1px 2px #000",
              pointerEvents: "none",
              userSelect: "none",
            }}
          >
            {unit.name}
          </div>
        </Html>
      </group>
      <NpcWorldMenu npcId={unit.id} />
    </group>
  );
}

export function WorldScene() {
  const wallet = useGame((s) => s.wallet);
  // Stable id lists — avoid remounting the whole scene tree on every 20Hz snapshot.
  const combatUnitIds = useGame((s) => {
    const units = s.snapshot?.units;
    if (!units) return "" as string;
    return units
      .filter((u) => u.kind === "player" || u.kind === "mob")
      .map((u) => u.id)
      .join("\0");
  });
  const npcIds = useGame((s) => {
    const units = s.snapshot?.units;
    if (!units) return "" as string;
    return units
      .filter((u) => u.kind === "npc" && !u.gatherNode)
      .map((u) => u.id)
      .join("\0");
  });
  const { camera, gl } = useThree();
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const ambRef = useRef<THREE.AmbientLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const fillRef = useRef<THREE.DirectionalLight>(null);
  const camFocus = useRef<SmoothPos>({ x: 0, y: 0, z: 0, primed: false });

  // Belt-and-suspenders: hub never uses shadow maps (starburst artifacts).
  useEffect(() => {
    gl.shadowMap.enabled = false;
  }, [gl]);

  const combatIds = useMemo(
    () => (combatUnitIds ? combatUnitIds.split("\0") : []),
    [combatUnitIds],
  );
  const npcIdList = useMemo(() => (npcIds ? npcIds.split("\0") : []), [npcIds]);

  useFrame((_, dt) => {
    const g = useGame.getState();
    const me = g.wallet
      ? g.snapshot?.units.find((u) => u.id === g.wallet && u.kind === "player")
      : undefined;
    // Prefer the billboard's eased pose so camera tracks the visible chase, not tick snaps.
    const tx = localVisual.primed ? localVisual.x : (me?.x ?? 0);
    const ty = localVisual.primed ? localVisual.y : (me?.y ?? 0);
    const tz = localVisual.primed ? localVisual.z : (me?.z ?? 0);
    stepSmoothPos(camFocus.current, { x: tx, y: ty, z: tz }, dt, false, 12);
    const fx = camFocus.current.x;
    const fy = camFocus.current.y;
    const fz = camFocus.current.z;
    camera.position.set(fx + 16, fy + 14, fz + 16);
    camera.lookAt(fx, fy + 0.8, fz);

    /** Mild cool bias in hub — never crush global exposure (player boots in hub). */
    const inHub =
      fx >= PH_HUB.minX - 2 &&
      fx <= PH_HUB.maxX + 2 &&
      fz >= PH_HUB.minZ - 2 &&
      fz <= PH_HUB.maxZ + 4;
    const k = inHub ? 1 : 0;
    if (hemiRef.current) {
      hemiRef.current.color.set(k ? "#a8b8c8" : "#c8d8e8");
      hemiRef.current.groundColor.set(k ? "#5a5040" : "#6a5a48");
      hemiRef.current.intensity = k ? 0.29 : 0.33;
    }
    if (ambRef.current) ambRef.current.intensity = k ? 0.22 : 0.25;
    if (sunRef.current) {
      sunRef.current.intensity = k ? 0.57 : 0.81;
      sunRef.current.color.set(k ? "#d8e0ec" : "#fff4e0");
      paleHollowSunDir.copy(sunRef.current.position).normalize();
    }
    if (fillRef.current) {
      fillRef.current.intensity = k ? 0.21 : 0.17;
      fillRef.current.color.set(k ? "#88a0c0" : "#a8c0d8");
    }

    // Perf probe for automation / console — samples R3F clock, not throttled page RAF alone.
    const now = performance.now();
    const probe = (window as unknown as { __BELL_PERF__?: PerfProbe }).__BELL_PERF__;
    if (probe) {
      const dt = now - probe.last;
      probe.last = now;
      if (probe.n > 0) {
        probe.frames.push(dt);
        if (dt > probe.maxDt) probe.maxDt = dt;
        if (dt > 33) probe.hitches.push(Math.round(dt));
      }
      probe.n++;
      if (gl.info) {
        probe.calls = gl.info.render.calls;
        probe.tris = gl.info.render.triangles;
      }
    }
    const players = g.snapshot?.units.filter((u) => u.kind === "player").length ?? 0;
    (window as unknown as { __BELL_UNITS__?: { players: number; combat: number } }).__BELL_UNITS__ = {
      players,
      combat: g.snapshot?.units.filter((u) => u.kind === "player" || u.kind === "mob").length ?? 0,
    };
  });

  return (
    <>
      {/* Immediate: sky + lights so the canvas is never a blank black wait. */}
      <color attach="background" args={["#a8b6bc"]} />
      {/* Far pushed so rim skirt / foothills read before fog swallows them. */}
      <fog attach="fog" args={["#a8b6bc", 52, 168]} />
      <hemisphereLight ref={hemiRef} args={["#c8d8e8", "#6a5a48", 0.33]} />
      <ambientLight ref={ambRef} intensity={0.25} />
      <directionalLight ref={sunRef} position={[28, 42, 18]} intensity={0.81} color="#fff4e0" />
      <directionalLight ref={fillRef} position={[-16, 18, -10]} intensity={0.17} color="#a8c0d8" />

      {/* Screen FX + combat particle layer — never Suspense-gated; hub Fire untouched. */}
      <WorldPostFx />
      <QuarksVfxLayer />

      {/* Static low-LOD world beyond playable bounds (not streamed). */}
      <PaleHollowHorizon />

      {/* Critical path: biome terrain (heightfield). Nested Suspense isolates prop sheets. */}
      <Suspense fallback={null}>
        <PaleHollowTerrain />
      </Suspense>
      <PaleHollowPaths />
      <Suspense fallback={null}>
        <PaleHollowRivers />
      </Suspense>
      <Suspense fallback={null}>
        <PaleHollowRiverBanks />
      </Suspense>
      <GatherNodeMarkers />
      <WasdController />
      {/* Per-unit Suspense so one missing seed sprite cannot black out the world. */}
      {combatIds.map((id) => (
        <Suspense key={id} fallback={null}>
          <SheetBillboard
            unitId={id}
            isMe={id.toLowerCase() === (wallet ?? "").toLowerCase()}
          />
        </Suspense>
      ))}
      {npcIdList.map((id) => (
        <Suspense key={id} fallback={null}>
          <HallNpc unitId={id} />
        </Suspense>
      ))}
    </>
  );
}

type PerfProbe = {
  last: number;
  n: number;
  frames: number[];
  maxDt: number;
  hitches: number[];
  calls: number;
  tris: number;
};
