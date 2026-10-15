import {
  PH_HUB,
  PH_MOUNTAINS,
  PH_OUTDOOR_SPAWN,
  PH_STORAGE_CHEST,
  PALE_HOLLOW_BOUNDS,
  PALE_HOLLOW_TERRAIN_SEG_X,
  PALE_HOLLOW_TERRAIN_SEG_Z,
  paleHollowBiome,
  clampPaleHollow,
  paleHollowGroundHeight,
  paleHollowHeight,
  paleHollowInBuildingClearing,
  paleHollowInOpenWater,
  paleHollowPlaceOnDryLand,
  paleHollowTerrainWeights,
  type PaleHollowBiome,
} from "@bellgrave/config";
import { CATALOG_BY_SLUG } from "@bellgrave/items";
import { Billboard, Html, useTexture } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Fire, type FireRef } from "@wolffo/three-fire/react";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as THREE from "three";
import {
  ApplyForce,
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ConstantColor,
  ConstantValue,
  Gradient,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  RenderMode,
  SizeOverLife,
  SphereEmitter,
  Vector3,
  Vector4,
} from "three.quarks";
import { applyMagentaChroma } from "./chroma";
import { send } from "./net";
import { useGame } from "./state";
import { worldHtmlPortalRef } from "./worldHtml";

/**
 * Load a sprite without Suspense — parent world keeps rendering while this streams.
 * Returns null until ready (or permanently null on hard fail).
 */
function useLazyChromaTexture(url: string): THREE.Texture | null {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let live = true;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (t) => {
        if (!live) return;
        setTex(applyMagentaChroma(t));
      },
      undefined,
      () => {
        /* non-critical — leave null, mesh stays hidden */
      },
    );
    return () => {
      live = false;
    };
  }, [url]);
  return tex;
}

/** Terrain grid — shared with `paleHollowStandHeight` so feet match these triangles. */
const SEG = PALE_HOLLOW_TERRAIN_SEG_X;

/**
 * Stream / draw distance: visible ground span × this multiplier.
 * Clamped — see `computeStreamRadius`.
 * Kept tight: large radii explode PropLayer instance counts + chunk CPU.
 */
const PH_STREAM_RADIUS_MUL = 1.2;
const PH_STREAM_RADIUS_MIN = 22;
const PH_STREAM_RADIUS_MAX = 42;
/** Keep instances/chunks until this far past load radius (avoids thrashing). */
const PH_STREAM_HYSTERESIS = 10;
/** Clutter placement is built per chunk, expanding around the player. */
const PH_STREAM_CHUNK = 18;
const PH_STREAM_TICK_MS = 200;

type StreamFocus = {
  x: number;
  z: number;
  loadR: number;
  unloadR: number;
};

const streamFocusStore: {
  focus: StreamFocus;
  version: number;
  listeners: Set<() => void>;
  logged: boolean;
  lastTick: number;
} = {
  focus: {
    x: PH_OUTDOOR_SPAWN.x,
    z: PH_OUTDOOR_SPAWN.z,
    loadR: 36,
    unloadR: 36 + PH_STREAM_HYSTERESIS,
  },
  version: 0,
  listeners: new Set(),
  logged: false,
  lastTick: 0,
};

function subscribeStreamFocus(onStoreChange: () => void) {
  streamFocusStore.listeners.add(onStoreChange);
  return () => {
    streamFocusStore.listeners.delete(onStoreChange);
  };
}

function getStreamFocusSnapshot() {
  return streamFocusStore.focus;
}

function getStreamFocusVersion() {
  return streamFocusStore.version;
}

function publishStreamFocus(next: StreamFocus) {
  const prev = streamFocusStore.focus;
  if (
    Math.hypot(next.x - prev.x, next.z - prev.z) < 2.5 &&
    Math.abs(next.loadR - prev.loadR) < 1.5
  ) {
    return;
  }
  streamFocusStore.focus = next;
  streamFocusStore.version += 1;
  for (const l of streamFocusStore.listeners) l();
}

/** Visible ground span from camera FOV × distance-to-player, then × mul. */
function computeStreamRadius(
  camera: THREE.Camera,
  focusX: number,
  focusY: number,
  focusZ: number,
): number {
  const persp = camera as THREE.PerspectiveCamera;
  const fov = (((persp.fov ?? 40) * Math.PI) / 180);
  const aspect = Math.max(0.5, persp.aspect || 1.6);
  const dx = camera.position.x - focusX;
  const dy = camera.position.y - (focusY + 0.8);
  const dz = camera.position.z - focusZ;
  const dist = Math.max(12, Math.hypot(dx, dy, dz));
  const halfH = Math.tan(fov / 2) * dist;
  const halfW = halfH * aspect;
  const groundSpan = 2 * Math.max(halfW, halfH);
  const r = groundSpan * PH_STREAM_RADIUS_MUL;
  return Math.min(PH_STREAM_RADIUS_MAX, Math.max(PH_STREAM_RADIUS_MIN, r));
}

/**
 * Shared stream focus from player + camera. Any subscriber may drive;
 * `lastTick` ensures a single publish per interval.
 */
function useStreamFocus(): StreamFocus {
  const { camera } = useThree();

  useFrame(() => {
    const now = performance.now();
    if (now - streamFocusStore.lastTick < PH_STREAM_TICK_MS) return;
    streamFocusStore.lastTick = now;

    const g = useGame.getState();
    const w = g.wallet;
    const me = g.snapshot?.units.find((u) => u.id === w && u.kind === "player");
    const x = me?.x ?? streamFocusStore.focus.x;
    const y = me?.y ?? 0;
    const z = me?.z ?? streamFocusStore.focus.z;
    const loadR = computeStreamRadius(camera, x, y, z);
    if (!streamFocusStore.logged) {
      streamFocusStore.logged = true;
      console.info(
        `[PaleHollow] stream radius ${loadR.toFixed(1)} (mul=${PH_STREAM_RADIUS_MUL}, span×mul from camera FOV)`,
      );
    }
    publishStreamFocus({
      x,
      z,
      loadR,
      unloadR: loadR + PH_STREAM_HYSTERESIS,
    });
  });

  const version = useSyncExternalStore(
    subscribeStreamFocus,
    getStreamFocusVersion,
    getStreamFocusVersion,
  );
  void version;
  return getStreamFocusSnapshot();
}

function distSqXZ(ax: number, az: number, bx: number, bz: number) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

const TEX = {
  farm: "/textures/pale-hollow/acg-farm.jpg",
  clay: "/textures/pale-hollow/acg-mud.jpg",
  scrub: "/textures/pale-hollow/acg-scrub.jpg",
  ashbeam: "/textures/pale-hollow/acg-forest.jpg",
  quarry: "/textures/pale-hollow/acg-stone.jpg",
  ore: "/textures/pale-hollow/acg-rock.jpg",
  grass: "/textures/pale-hollow/acg-grass.jpg",
  mountain: "/textures/pale-hollow/acg-cliff.jpg",
  hubFloor: "/textures/pale-hollow/acg-sand.jpg",
  hubWall: "/textures/pale-hollow/acg-stone.jpg",
  timber: "/textures/pale-hollow/acg-wood.jpg",
  silo: "/textures/pale-hollow/acg-wood.jpg",
  cliff: "/textures/pale-hollow/acg-cliff.jpg",
} as const;

/**
 * Mutable sun direction for self-lit terrain (lights:false).
 * WorldScene writes from the directional sun each frame — prep for day/night.
 */
export const paleHollowSunDir = new THREE.Vector3(0.45, 1.0, 0.22).normalize();

function gatherIconUrl(yieldSlug: string | undefined): string {
  if (!yieldSlug) return "/icons/items/dustgrain.png";
  const icon = CATALOG_BY_SLUG[yieldSlug]?.icon;
  if (icon) return icon;
  return `/icons/items/${yieldSlug}.png`;
}

function makeGatherGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(255, 245, 200, 0.95)");
  g.addColorStop(0.35, "rgba(255, 210, 110, 0.55)");
  g.addColorStop(0.7, "rgba(120, 200, 190, 0.22)");
  g.addColorStop(1, "rgba(120, 200, 190, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Tiny 4-point sparkle for gather-node twinkle. */
function makeGatherSparkTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 32, 32);
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 14);
  g.addColorStop(0, "rgba(255, 255, 240, 1)");
  g.addColorStop(0.25, "rgba(255, 230, 140, 0.85)");
  g.addColorStop(0.55, "rgba(180, 230, 210, 0.35)");
  g.addColorStop(1, "rgba(180, 230, 210, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  ctx.strokeStyle = "rgba(255, 250, 220, 0.9)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(16, 2);
  ctx.lineTo(16, 30);
  ctx.moveTo(2, 16);
  ctx.lineTo(30, 16);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 245, 200, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(6, 6);
  ctx.lineTo(26, 26);
  ctx.moveTo(26, 6);
  ctx.lineTo(6, 26);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const GATHER_ICON_SIZE = 0.9;
/** Billboard Y so the icon bottom sits on the terrain. */
const GATHER_GROUND_Y = GATHER_ICON_SIZE * 0.5;

const gatherTexCache = new Map<string, THREE.Texture>();

function useGatherItemTexture(src: string): THREE.Texture | null {
  const [tex, setTex] = useState<THREE.Texture | null>(() => gatherTexCache.get(src) ?? null);

  useEffect(() => {
    const hit = gatherTexCache.get(src);
    if (hit) {
      setTex(hit);
      return;
    }
    let live = true;
    const loader = new THREE.TextureLoader();
    loader.load(
      src,
      (t) => {
        const keyed = applyMagentaChroma(t);
        gatherTexCache.set(src, keyed);
        if (live) setTex(keyed);
      },
      undefined,
      () => {
        const fb = "/icons/items/dustgrain.png";
        if (src === fb) return;
        loader.load(fb, (t) => {
          const keyed = applyMagentaChroma(t);
          gatherTexCache.set(src, keyed);
          if (live) setTex(keyed);
        });
      },
    );
    return () => {
      live = false;
    };
  }, [src]);

  return tex;
}

const BIOME_ID: Record<PaleHollowBiome, number> = {
  hub_indoor: 0,
  terrace: 0,
  farm: 1,
  river: 2,
  riverbank: 3,
  bridge: 4,
  ashbeam: 5,
  scrub: 6,
  quarry: 7,
  vine_cliff: 8,
  ore_seam: 9,
  crypt: 10,
  ash_road: 11,
  grass: 12,
  mountain: 13,
  meadow: 14,
};

function prepMap(tex: THREE.Texture, repeat: number) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function buildTerrainGeometry(): THREE.BufferGeometry {
  const depthSeg = PALE_HOLLOW_TERRAIN_SEG_Z;
  const geo = new THREE.PlaneGeometry(
    PALE_HOLLOW_BOUNDS.maxX - PALE_HOLLOW_BOUNDS.minX,
    PALE_HOLLOW_BOUNDS.maxZ - PALE_HOLLOW_BOUNDS.minZ,
    SEG,
    depthSeg,
  );
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const cx = (PALE_HOLLOW_BOUNDS.minX + PALE_HOLLOW_BOUNDS.maxX) / 2;
  const cz = (PALE_HOLLOW_BOUNDS.minZ + PALE_HOLLOW_BOUNDS.maxZ) / 2;
  const spanX = PALE_HOLLOW_BOUNDS.maxX - PALE_HOLLOW_BOUNDS.minX;
  const spanZ = PALE_HOLLOW_BOUNDS.maxZ - PALE_HOLLOW_BOUNDS.minZ;

  const ids: number[] = [];
  // aW0: farm, ash, scrub, mountain
  // aW1: quarry, ore, meadow, bank
  const w0: number[] = [];
  const w1: number[] = [];
  const uvs: number[] = [];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx;
    const z = pos.getZ(i) + cz;
    pos.setY(i, paleHollowGroundHeight(x, z));

    const primary = paleHollowBiome(x, z);
    ids.push(BIOME_ID[primary] ?? 12);

    const tw = paleHollowTerrainWeights(x, z);
    w0.push(tw.farm, tw.ash, tw.scrub, tw.mountain);
    w1.push(tw.quarry, tw.ore, tw.meadow, tw.bank);
    uvs.push((x - PALE_HOLLOW_BOUNDS.minX) / spanX, (z - PALE_HOLLOW_BOUNDS.minZ) / spanZ);
  }

  geo.setAttribute("biomeId", new THREE.Float32BufferAttribute(ids, 1));
  geo.setAttribute("aW0", new THREE.Float32BufferAttribute(w0, 4));
  geo.setAttribute("aW1", new THREE.Float32BufferAttribute(w1, 4));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.translate(cx, 0, cz);
  return geo;
}

function makeTerrainMaterial(maps: {
  farm: THREE.Texture;
  clay: THREE.Texture;
  scrub: THREE.Texture;
  timber: THREE.Texture;
  ashbeam: THREE.Texture;
  quarry: THREE.Texture;
  ore: THREE.Texture;
  grass: THREE.Texture;
  mountain: THREE.Texture;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      farmMap: { value: maps.farm },
      clayMap: { value: maps.clay },
      scrubMap: { value: maps.scrub },
      timberMap: { value: maps.timber },
      ashbeamMap: { value: maps.ashbeam },
      quarryMap: { value: maps.quarry },
      oreMap: { value: maps.ore },
      grassMap: { value: maps.grass },
      mountainMap: { value: maps.mountain },
      tileScale: { value: 14.0 },
      lightDir: { value: paleHollowSunDir.clone() },
      cameraPos: { value: new THREE.Vector3() },
    },
    lights: false,
    toneMapped: true,
    vertexShader: /* glsl */ `
      attribute float biomeId;
      attribute vec4 aW0;
      attribute vec4 aW1;
      varying float vId;
      varying vec4 vW0;
      varying vec4 vW1;
      varying vec3 vWorldN;
      varying vec3 vWorldP;
      void main() {
        vId = biomeId;
        vW0 = aW0;
        vW1 = aW1;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldP = wp.xyz;
        vWorldN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D farmMap, clayMap, scrubMap, timberMap, ashbeamMap, quarryMap, oreMap, grassMap, mountainMap;
      uniform float tileScale;
      uniform vec3 lightDir;
      uniform vec3 cameraPos;
      varying float vId;
      varying vec4 vW0;
      varying vec4 vW1;
      varying vec3 vWorldN;
      varying vec3 vWorldP;

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }
      // 2-octave fbm — soft warp without the old 4-octave tax
      float fbm2(vec2 p) {
        return 0.65 * noise(p) + 0.35 * noise(p * 2.05);
      }

      // Top-down sample (flat terrain). Slope gets one side sample only when needed.
      vec3 sampleTop(sampler2D tex, vec2 uv) {
        return texture2D(tex, uv).rgb;
      }
      vec3 sampleSlope(sampler2D tex, vec3 p, vec3 n, float scale, vec3 top) {
        if (n.y > 0.62) return top;
        vec3 blending = abs(n);
        blending.y *= 1.5;
        blending /= max(blending.x + blending.y + blending.z, 0.0001);
        vec3 side = blending.x > blending.z
          ? texture2D(tex, p.zy * scale).rgb
          : texture2D(tex, p.xy * scale).rgb;
        return mix(side, top, blending.y);
      }

      float mainRiverX(float z) {
        return -22.0 + sin((z - 20.0) * 0.11) * 28.0 + sin((z - 40.0) * 0.05) * 12.0;
      }
      float tribRiverX(float z) {
        return 34.0 + sin((z - 60.0) * 0.09) * 10.0;
      }
      float bankField(vec3 p, float warp) {
        float w = 0.0;
        if (p.z > 10.0 && p.z < 245.0) {
          float rd = abs(p.x - mainRiverX(p.z));
          float t = clamp(rd / 36.0, 0.0, 1.0);
          w = max(w, 1.0 - t * t * (3.0 - 2.0 * t));
        }
        if (p.z > 52.0 && p.z < 152.0) {
          float td = abs(p.x - tribRiverX(p.z));
          float t = clamp(td / 24.0, 0.0, 1.0);
          w = max(w, 1.0 - t * t * (3.0 - 2.0 * t));
        }
        return clamp(w + warp, 0.0, 1.0);
      }

      void main() {
        vec3 n = normalize(vWorldN);
        float slope = 1.0 - clamp(n.y, 0.0, 1.0);

        float scale = tileScale / 120.0;
        vec2 uv = vWorldP.xz * scale;
        float nLo = fbm2(vWorldP.xz * 0.035);
        float warp = (nLo - 0.5) * 0.28;

        // Cheap attribute weights — available for far-field tint without texture samples.
        float ashW = smoothstep(0.2, 0.95, vW0.y + warp * 0.8);
        float scrubW = smoothstep(0.2, 0.95, vW0.z - warp * 0.5);

        // LOD: far pixels use 2-sample grass+dirt only; gate expensive biome samples.
        float camDist = length(vWorldP - cameraPos);
        // Near/far LOD — pull cheap far tint in earlier to cut multi-texture samples.
        float farFade = smoothstep(38.0, 68.0, camDist);

        // Always-on bases (2 samples).
        vec3 grassCol = sampleTop(grassMap, uv);
        vec3 clay = sampleTop(clayMap, uv);
        vec3 dirt = mix(grassCol, clay, 0.42);
        // Darker bank mud — pale clay*0.88 read as chalk rim along rivers.
        vec3 mud = mix(dirt, clay, 0.28) * vec3(0.62, 0.56, 0.48);

        float bank = bankField(vWorldP, warp * 0.45);
        float toDirt = smoothstep(0.45, 0.92, bank);
        float toMud = smoothstep(0.62, 0.98, bank);

        vec3 farCol = mix(grassCol, dirt, 0.35);
        vec3 ground = farCol;
        float hubShade = 0.0;

        if (farFade < 0.99) {
          vec3 scrubTex = sampleTop(scrubMap, uv * 1.1);
          dirt = mix(grassCol, mix(clay, scrubTex, 0.35), 0.42);
          mud = mix(dirt, clay, 0.28) * vec3(0.62, 0.56, 0.48);

          float farmW = smoothstep(0.15, 0.95, vW0.x + warp);
          float mtnW = smoothstep(0.12, 0.9, vW0.w);
          float quarryW = smoothstep(0.1, 0.9, vW1.x);
          float oreW = smoothstep(0.12, 0.88, vW1.y);
          float meadowW = smoothstep(0.15, 0.95, vW1.z + warp * 0.4);
          float cliffW = smoothstep(0.72, 0.98, slope) * (1.0 - smoothstep(0.02, 0.35, bank));

          ground = mix(grassCol, mix(grassCol, dirt, 0.2), 0.12 + nLo * 0.1);
          if (farmW > 0.02 || meadowW > 0.02) {
            vec3 farmCol = sampleTop(farmMap, uv);
            ground = mix(ground, mix(grassCol, farmCol, 0.4), farmW * 0.35);
            ground = mix(ground, mix(grassCol, farmCol, 0.22 + nLo * 0.12), meadowW * 0.3);
          }
          if (ashW > 0.02) {
            vec3 ashTex = sampleTop(ashbeamMap, uv);
            ground = mix(ground, mix(grassCol, ashTex, 0.25), ashW * 0.4);
          }
          if (scrubW > 0.02) {
            ground = mix(ground, mix(grassCol, scrubTex, 0.28), scrubW * 0.35);
          }
          if (oreW > 0.02) {
            vec3 oreTex = sampleTop(oreMap, uv);
            ground = mix(ground, mix(oreTex, scrubTex, 0.35), oreW * 0.9);
          }
          if (quarryW > 0.02 || mtnW > 0.02 || cliffW > 0.02) {
            vec3 mountainTop = sampleTop(mountainMap, uv * 0.75);
            vec3 mountainTex = sampleSlope(mountainMap, vWorldP, n, scale * 0.75, mountainTop);
            if (quarryW > 0.02) {
              vec3 quarryTex = sampleTop(quarryMap, uv);
              ground = mix(ground, mix(quarryTex, mountainTex, 0.35), quarryW * 0.85);
            }
            ground = mix(ground, mountainTex, mtnW * 0.9);
            ground = mix(ground, mountainTex, cliffW * 0.28);
          }

          ground = mix(ground, dirt, toDirt * 0.55);
          ground = mix(ground, mud, toMud * 0.5);

          // Hub / old building pad: packed dirt, not leftover neon lawn.
          vec3 hubPacked = mix(clay, mud, 0.42) * vec3(0.78, 0.72, 0.62);
          if (vId < 0.5) {
            ground = hubPacked;
          } else if (vId > 3.5 && vId < 4.5) {
            ground = mix(ground, sampleTop(timberMap, uv * 1.4), 0.75);
          }

          // Soft noise-feathered apron — extend camp shade over residual grass lobes.
          {
            float hubR = length(vec2(vWorldP.x, vWorldP.z - 2.0));
            float rimNoise = (fbm2(vWorldP.xz * 0.11) - 0.5) * 3.4;
            float hubDirt = 1.0 - smoothstep(7.5 + rimNoise, 22.0 + rimNoise * 0.6, hubR);
            hubDirt = clamp(hubDirt, 0.0, 1.0);
            hubShade = hubDirt;
            ground = mix(ground, hubPacked, hubDirt * 0.94);
          }

          float pathX = abs(vWorldP.x - sin(vWorldP.z * 0.08) * 2.5);
          float path = smoothstep(5.0, 1.2, pathX) * smoothstep(8.0, 14.0, vWorldP.z) * smoothstep(250.0, 210.0, vWorldP.z);
          ground = mix(ground, dirt, path * 0.35);

          // Soft mid-distance blend into the cheap far tint.
          if (farFade > 0.01) {
            ground = mix(ground, farCol, farFade * 0.72);
          }
        } else {
          // Far: soft bank dirt without pale chalk mud.
          ground = mix(ground, dirt, toDirt * 0.4);
        }

        vec3 nLit = normalize(mix(n, vec3(0.0, 1.0, 0.0), clamp(toDirt * 0.88 + toMud * 0.35, 0.0, 0.95)));
        float ndl = 0.52 + 0.38 * max(dot(nLit, normalize(lightDir)), 0.0);
        float hemi = 0.18 + 0.1 * max(nLit.y, 0.0);
        // Kill the dark heightfield crease along banks
        float ao = 1.0 - slope * 0.035 * (1.0 - toDirt) * (1.0 - toMud);
        ao = mix(ao, 1.0, toDirt * 0.85);
        // Match encampment overlay tone — soft dim so leftover grass never pops neon.
        ndl = mix(ndl, ndl * 0.72, hubShade * 0.85);
        hemi = mix(hemi, hemi * 0.8, hubShade * 0.7);
        vec3 lit = ground * (ndl + hemi) * ao;
        lit *= mix(vec3(1.0), vec3(1.02, 1.04, 0.98), (1.0 - ashW) * (1.0 - toDirt) * (1.0 - scrubW) * (1.0 - hubShade));
        gl_FragColor = vec4(lit, 1.0);
      }
    `,
  });
}

function onTerrainClick(e: { stopPropagation: () => void; point: THREE.Vector3 }) {
  e.stopPropagation();
  // The server owns the route (#120). Send the clicked point, not a straight
  // slide — a pre-clamp would stop on the near face of a wall. There is no
  // client path ribbon; if one is added it must use paleHollowWalkable.
  const c = clampPaleHollow(e.point.x, e.point.z);
  send({ type: "move", x: c.x, z: c.z });
}

function hash2(i: number, j: number) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const PROP_SPRITES = {
  /** Primary long-blade meadow grass */
  longGrass: "/sprites/props/ph-long-grass.png?v=nobase3",
  longGrassB: "/sprites/props/ph-long-grass-b.png?v=nobase3",
  tallPatch: "/sprites/props/ph-tall-grass-patch.png?v=nobase3",
  tallPatchB: "/sprites/props/ph-tall-grass-patch-b.png?v=nobase3",
  fern: "/sprites/props/ph-leafy-fern.png?v=nobase3",
  fernB: "/sprites/props/ph-leafy-fern-b.png?v=nobase3",
  /** Sparse accents — not the main carpet */
  grassTuft: "/sprites/props/ph-grass-tuft.png?v=nobase4",
  bush: "/sprites/props/ph-scrub-bush.png?v=nobase4",
  bushB: "/sprites/props/ph-scrub-bush-b.png?v=nobase4",
  rock: "/sprites/props/ph-pale-rock.png?v=nobase4",
  rockB: "/sprites/props/ph-pale-rock-b.png?v=nobase4",
  stalk: "/sprites/props/ph-dustgrain-stalk.png?v=nobase4",
  reed: "/sprites/props/ph-river-reed.png?v=nobase3",
  scrub: "/sprites/props/ph-dry-scrub.png?v=nobase3",
  scrubB: "/sprites/props/ph-dry-scrub-b.png?v=nobase3",
  bloom: "/sprites/props/ph-pale-bloom.png?v=nobase3",
  sapling: "/sprites/props/ph-ashbeam-sapling.png?v=nobase4",
  ashMed: "/sprites/props/ph-ash-tree-med.png?v=base8",
  ashTall: "/sprites/props/ph-ash-tree-tall.png?v=base8",
  pine: "/sprites/props/ph-pine-tree.png?v=base8",
  spruce: "/sprites/props/ph-spruce-tree.png?v=base8",
  cypress: "/sprites/props/ph-cypress-tree.png?v=base8",
  /** Hub encampment hero props */
  campFlame: "/sprites/props/ph-campfire-flame.png?v=hub1",
  campBanner: "/sprites/props/ph-camp-banner.png?v=hub1",
  campCoals: "/sprites/props/ph-campfire-coals.png?v=hub1",
} as const;

/** Opaque tiled canvas cloth — never use magenta-keyed sprites as albedo (causes purple standees). */
function makeOpaqueCanvasCloth(base: string, shade: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 48; i++) {
    ctx.strokeStyle = shade;
    ctx.globalAlpha = 0.12 + (i % 5) * 0.03;
    ctx.lineWidth = 1 + (i % 3);
    ctx.beginPath();
    const x0 = (i * 17) % 128;
    const y0 = (i * 29) % 128;
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + 40) % 128, (y0 + 20) % 128, (x0 + 70) % 128, (y0 + 55) % 128);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = shade;
  for (let i = 0; i < 12; i++) {
    ctx.fillRect((i * 37) % 110, (i * 53) % 110, 14, 3);
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.2, 2.2);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeSmokePuffTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 36, 2, 32, 32, 28);
  g.addColorStop(0, "rgba(90,85,80,0.5)");
  g.addColorStop(0.4, "rgba(70,65,60,0.22)");
  g.addColorStop(1, "rgba(50,48,45,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Soft soot/char under the pit — dark tint only, never a bright glow disc. */
function makeCharredEarthTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(s * 0.5, s * 0.5, s * 0.12, s * 0.5, s * 0.5, s * 0.48);
  g.addColorStop(0, "rgba(28, 18, 12, 0.72)");
  g.addColorStop(0.45, "rgba(36, 24, 16, 0.42)");
  g.addColorStop(0.78, "rgba(48, 34, 22, 0.16)");
  g.addColorStop(1, "rgba(40, 30, 20, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural flame sheet: white-yellow core → orange → smoky red tips. */
function makeFlameSheetTexture(kind: "outer" | "mid" | "core"): THREE.CanvasTexture {
  const w = 96;
  const h = 160;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const cx = w * 0.5;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    // bottom = hot core, top = cool tips
    const heat = 1 - t;
    let r: number;
    let g: number;
    let b: number;
    let a: number;
    if (kind === "core") {
      r = 255;
      g = Math.floor(245 - t * 40);
      b = Math.floor(210 - t * 120);
      a = heat * (0.95 - t * 0.55);
    } else if (kind === "mid") {
      r = Math.floor(255 - t * 20);
      g = Math.floor(170 - t * 90);
      b = Math.floor(50 - t * 30);
      a = heat * (0.75 - t * 0.35);
    } else {
      r = Math.floor(220 - t * 40);
      g = Math.floor(70 - t * 40);
      b = Math.floor(28 + t * 10);
      a = heat * (0.55 - t * 0.2);
    }
    const halfW = (0.12 + heat * 0.38) * w * (kind === "core" ? 0.55 : kind === "mid" ? 0.78 : 1);
    const flicker = 1 + Math.sin(y * 0.35) * 0.04;
    const left = cx - halfW * flicker;
    const right = cx + halfW * flicker;
    ctx.fillStyle = `rgba(${r},${g},${b},${Math.max(0, a)})`;
    ctx.fillRect(left, y, Math.max(1, right - left), 1);
  }
  // Soft side falloff via destination-in radial-ish erase
  const edge = ctx.createLinearGradient(0, 0, w, 0);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(0.22, "rgba(0,0,0,1)");
  edge.addColorStop(0.78, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural packed-dirt normal: soft bumps for PBR without Suspense assets. */
function makeHubDirtNormalMap(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(s, s);
  const d = img.data;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const n1 = Math.sin(x * 0.21 + y * 0.13) * 0.5 + Math.cos(x * 0.09 - y * 0.19) * 0.35;
      const n2 = Math.sin((x + y) * 0.31) * 0.2;
      const h = n1 + n2;
      const nx = 0.5 + h * 0.12;
      const ny = 0.5 + Math.cos(x * 0.17 - y * 0.11) * 0.1;
      const i = (y * s + x) * 4;
      d[i] = Math.floor(nx * 255);
      d[i + 1] = Math.floor(ny * 255);
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.needsUpdate = true;
  return tex;
}

function makeHubDirtRoughnessMap(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const v = 160 + Math.floor((Math.sin(x * 0.4) * Math.cos(y * 0.35) + 1) * 35);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.needsUpdate = true;
  return tex;
}

/** Soft radial alpha so the dirt pad fades into grass — no hard concentric bands. */
function makeHubDirtEdgeAlphaMap(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(s, s);
  const d = img.data;
  const cx = (s - 1) * 0.5;
  const cy = (s - 1) * 0.5;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const ang = Math.atan2(dy, dx);
      // Soft irregular rim — low-frequency only (avoid sharp wedge noise).
      const wobble = 1 + Math.sin(ang * 3.0) * 0.04 + Math.sin(ang * 5.0 + 1.2) * 0.025;
      const r = Math.hypot(dx, dy) * wobble;
      // Wider opaque core + longer feather so camp shade covers grass lobes.
      let a = 1;
      if (r > 0.58) a = 1 - (r - 0.58) / 0.42;
      if (r > 1) a = 0;
      a = Math.max(0, Math.min(1, a));
      // Extra smoothstep for a gentler outer falloff (no hard polygon rim).
      a = a * a * (3 - 2 * a);
      a = a * a * (3 - 2 * a);
      const v = Math.floor(a * 255);
      const i = (y * s + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Organic dirt clearing as a GRID disc (not CircleGeometry triangle-fan).
 * Keep relief strictly above the terrain plane — negative dips fail depthTest and
 * punch hard bright grass holes through the pad (neon lawn lobes in the camp shade).
 */
function makeHubDirtGeo(radius: number, segs = 48): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(radius * 2, radius * 2, segs, segs);
  const pos = g.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    // Flatten outside the disc — alphaMap hides the rest.
    if (r > radius * 1.02) {
      pos.setZ(i, 0);
      continue;
    }
    const edge = Math.max(0, 1 - r / Math.max(0.001, radius));
    // Tiny positive micro-bumps only — never carve below the hub floor.
    const n =
      Math.sin(x * 1.6 + y * 0.6) * 0.01 +
      Math.cos(x * 0.7 - y * 1.8) * 0.008 +
      Math.sin((x + y) * 2.4) * 0.005;
    pos.setZ(i, Math.max(0, n * edge));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Mossy chalk cliff framing the camp's north rear — not a thin strip.
 * Movement blocking is `PH_HUB_REAR_WALL` (side gaps stay open); this mesh is the art.
 */
function HubRearRockWall({
  y0,
  stoneMap,
}: {
  y0: number;
  stoneMap: THREE.Texture;
}) {
  const blocks = useMemo(
    () =>
      (
        [
          [-7.5, 8.6, 2.8, 1.9, 1.4, 0.2],
          [-5.2, 9.1, 3.4, 2.4, 1.8, -0.15],
          [-2.4, 9.4, 4.2, 2.8, 2.1, 0.08],
          [0.3, 9.5, 3.8, 2.6, 2.0, 0],
          [3.0, 9.2, 3.6, 2.5, 1.9, -0.1],
          [5.6, 8.7, 3.0, 2.1, 1.6, 0.18],
          [7.8, 8.1, 2.4, 1.7, 1.3, -0.22],
          [-6.4, 8.2, 1.4, 1.1, 1.0, 0.4],
          [-3.8, 8.5, 1.6, 1.3, 1.1, -0.3],
          [-0.8, 8.6, 1.8, 1.4, 1.2, 0.25],
          [2.0, 8.5, 1.5, 1.2, 1.0, -0.35],
          [4.5, 8.3, 1.7, 1.35, 1.15, 0.15],
          [6.8, 7.9, 1.3, 1.0, 0.95, -0.4],
        ] as const
      ).map(([x, z, w, h, d, yaw]) => ({ x, z, w, h, d, yaw })),
    [],
  );
  return (
    <group>
      {blocks.map((b, i) => (
        <mesh
          key={`wall-${i}`}
          position={[b.x, y0 + b.h * 0.45, b.z]}
          rotation={[0.04 * ((i % 3) - 1), b.yaw, 0.03 * (i % 2 ? 1 : -1)]}
        >
          <boxGeometry args={[b.w, b.h, b.d]} />
          <meshStandardMaterial
            map={stoneMap}
            color={i % 2 ? "#c8b898" : "#b8a888"}
            roughness={0.92}
            metalness={0.02}
          />
        </mesh>
      ))}
      {/* Moss cushions */}
      {(
        [
          [-5.0, 9.0, 0.55],
          [-2.0, 9.3, 0.7],
          [0.8, 9.4, 0.6],
          [3.5, 9.1, 0.65],
          [6.0, 8.6, 0.5],
          [-3.5, 8.7, 0.4],
          [1.8, 8.9, 0.45],
        ] as const
      ).map(([x, z, s], i) => (
        <mesh key={`moss-${i}`} position={[x, y0 + 1.1 + (i % 3) * 0.35, z]} scale={[s * 1.4, s * 0.55, s]}>
          <sphereGeometry args={[1, 6, 5]} />
          <meshStandardMaterial color={i % 2 ? "#5a6e48" : "#4a6240"} roughness={0.98} />
        </mesh>
      ))}
    </group>
  );
}

const HUB_FIRE = { x: 0, z: 0.4 } as const;
/** Skip CPU/GPU particle updates when camera is farther than this from the hub fire. */
const HUB_ATMO_CULL_DIST = 48;

function makeHubParticleTexture(warm: boolean): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 14);
  if (warm) {
    g.addColorStop(0, "rgba(255,240,180,1)");
    g.addColorStop(0.35, "rgba(255,140,50,0.9)");
    g.addColorStop(1, "rgba(180,40,10,0)");
  } else {
    g.addColorStop(0, "rgba(220,210,190,0.9)");
    g.addColorStop(0.4, "rgba(180,170,150,0.35)");
    g.addColorStop(1, "rgba(140,130,110,0)");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function makeHubParticleMat(map: THREE.Texture, additive: boolean): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: false,
    color: 0xffffff,
  });
}

/** Rising embers + floating dust via three.quarks — distance-culled, castShadow off. */
function HubFireAtmosphere({ y0 }: { y0: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const batchRef = useRef<BatchedRenderer | null>(null);
  const systemsRef = useRef<ParticleSystem[]>([]);
  const { camera } = useThree();

  const batch = useMemo(() => new BatchedRenderer(), []);

  useEffect(() => {
    batchRef.current = batch;
    const emberTex = makeHubParticleTexture(true);
    const dustTex = makeHubParticleTexture(false);
    const emberMat = makeHubParticleMat(emberTex, true);
    const dustMat = makeHubParticleMat(dustTex, false);

    const embers = new ParticleSystem({
      duration: 2.6,
      looping: true,
      prewarm: true,
      shape: new SphereEmitter({ radius: 0.22, thickness: 1, arc: Math.PI * 2 }),
      startLife: new IntervalValue(1.4, 2.6),
      startSpeed: new IntervalValue(0.15, 0.45),
      startSize: new IntervalValue(0.04, 0.1),
      startColor: new ConstantColor(new Vector4(1, 0.85, 0.45, 0.95)),
      emissionOverTime: new ConstantValue(14),
      worldSpace: true,
      material: emberMat,
      renderMode: RenderMode.BillBoard,
      renderOrder: 12,
      behaviors: [
        new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.7, 0.35, 0), 0]])),
        new ColorOverLife(
          new Gradient(
            [
              [new Vector3(1, 0.95, 0.55), 0],
              [new Vector3(1, 0.45, 0.12), 0.55],
              [new Vector3(0.35, 0.08, 0.02), 1],
            ],
            [
              [1, 0],
              [0, 1],
            ],
          ),
        ),
        new ApplyForce(new Vector3(0, 1, 0), new ConstantValue(1.35)),
      ],
    });

    const dust = new ParticleSystem({
      duration: 4,
      looping: true,
      prewarm: true,
      shape: new SphereEmitter({ radius: 5.5, thickness: 0.85, arc: Math.PI * 2 }),
      startLife: new IntervalValue(2.5, 4.5),
      startSpeed: new IntervalValue(0.02, 0.08),
      startSize: new IntervalValue(0.03, 0.06),
      startColor: new ConstantColor(new Vector4(0.78, 0.74, 0.66, 0.28)),
      emissionOverTime: new ConstantValue(6),
      worldSpace: true,
      material: dustMat,
      renderMode: RenderMode.BillBoard,
      renderOrder: 11,
      behaviors: [
        new SizeOverLife(new PiecewiseBezier([[new Bezier(0.6, 1, 0.8, 0.2), 0]])),
        new ColorOverLife(
          new Gradient(
            [
              [new Vector3(0.82, 0.78, 0.7), 0],
              [new Vector3(0.7, 0.66, 0.58), 1],
            ],
            [
              [0.3, 0],
              [0, 1],
            ],
          ),
        ),
        new ApplyForce(new Vector3(0, 1, 0), new ConstantValue(0.12)),
      ],
    });

    for (const sys of [embers, dust]) {
      batch.addSystem(sys);
      batch.add(sys.emitter);
      sys.emitter.castShadow = false;
      sys.emitter.receiveShadow = false;
      sys.emitter.position.set(0, 0.2, 0);
      sys.play();
    }
    systemsRef.current = [embers, dust];

    return () => {
      for (const sys of systemsRef.current) {
        try {
          batch.deleteSystem(sys);
          sys.dispose();
        } catch {
          /* ignore */
        }
      }
      systemsRef.current = [];
      emberMat.dispose();
      dustMat.dispose();
      emberTex.dispose();
      dustTex.dispose();
      batchRef.current = null;
    };
  }, [batch]);

  useFrame((_, delta) => {
    const g = groupRef.current;
    if (!g) return;
    const dx = camera.position.x - g.position.x;
    const dy = camera.position.y - (g.position.y + 1);
    const dz = camera.position.z - g.position.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > HUB_ATMO_CULL_DIST * HUB_ATMO_CULL_DIST) {
      g.visible = false;
      return;
    }
    g.visible = true;
    batchRef.current?.update(delta);
  });

  return (
    <group ref={groupRef} position={[HUB_FIRE.x, y0, HUB_FIRE.z]}>
      <primitive object={batch} />
    </group>
  );
}

/**
 * Crossed multi-plane flame — fallback while THREE.Fire texture streams (no Suspense).
 */
function CampfireVolumetricFlame() {
  const groupRef = useRef<THREE.Group>(null);
  const outerTex = useMemo(() => makeFlameSheetTexture("outer"), []);
  const midTex = useMemo(() => makeFlameSheetTexture("mid"), []);
  const coreTex = useMemo(() => makeFlameSheetTexture("core"), []);
  const layers = useMemo(() => {
    const mk = (map: THREE.Texture, opacity: number, additive: boolean) => {
      const m = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        opacity,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      return m;
    };
    return [
      { yaw: 0, w: 1.55, h: 2.55, y: 1.25, mat: mk(outerTex, 0.55, false), base: 0.55 },
      { yaw: Math.PI / 3, w: 1.5, h: 2.45, y: 1.22, mat: mk(outerTex, 0.52, false), base: 0.52 },
      { yaw: (2 * Math.PI) / 3, w: 1.48, h: 2.4, y: 1.2, mat: mk(outerTex, 0.5, false), base: 0.5 },
      { yaw: Math.PI / 6, w: 1.15, h: 2.15, y: 1.05, mat: mk(midTex, 0.72, true), base: 0.72 },
      { yaw: Math.PI / 6 + Math.PI / 2, w: 1.1, h: 2.05, y: 1.02, mat: mk(midTex, 0.68, true), base: 0.68 },
      { yaw: Math.PI / 4, w: 0.72, h: 1.55, y: 0.78, mat: mk(coreTex, 0.92, true), base: 0.92 },
      { yaw: Math.PI / 4 + Math.PI / 2, w: 0.68, h: 1.48, y: 0.75, mat: mk(coreTex, 0.88, true), base: 0.88 },
    ];
  }, [outerTex, midTex, coreTex]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const swayX = 1 + Math.sin(t * 5.2) * 0.055 + Math.sin(t * 11.4) * 0.03;
    const swayY = 1 + Math.sin(t * 4.1) * 0.07 + Math.sin(t * 9.6) * 0.035;
    if (groupRef.current) {
      groupRef.current.scale.set(swayX, swayY, swayX);
      groupRef.current.rotation.y = Math.sin(t * 0.7) * 0.06;
    }
    layers.forEach((L, i) => {
      L.mat.opacity = L.base * (0.88 + Math.sin(t * (7 + i * 1.7) + i) * 0.12);
    });
  });

  return (
    <group ref={groupRef} position={[0, 0.15, 0]}>
      {layers.map((L, i) => (
        <mesh key={`fl-${i}`} position={[0, L.y, 0]} rotation={[0, L.yaw, 0]} material={L.mat}>
          <planeGeometry args={[L.w, L.h]} />
        </mesh>
      ))}
    </group>
  );
}

const FIRE_DENSITY_URL = "/textures/fx/fire-grayscale.png";

/** Lazy load without Suspense — parent world keeps rendering. */
function useLazyFireDensityTexture(url: string): THREE.Texture | null {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (t) => {
        if (cancelled) {
          t.dispose();
          return;
        }
        t.colorSpace = THREE.NoColorSpace;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.needsUpdate = true;
        setTex(t);
      },
      undefined,
      () => {
        /* keep plane fallback */
      },
    );
    return () => {
      cancelled = true;
      setTex((prev) => {
        prev?.dispose();
        return null;
      });
    };
  }, [url]);
  return tex;
}

/**
 * Hub fire volume: @wolffo/three-fire (MIT, WebGL raymarch) when density tex ready;
 * crossed-planes fallback until then / on failure. Never Suspense-gates the Canvas.
 */
function HubCampfireVolume() {
  const density = useLazyFireDensityTexture(FIRE_DENSITY_URL);
  const fireRef = useRef<FireRef>(null);

  /** Library defaults depthTest=false (always-on-top); force real depth vs brick ring. */
  const applyFireDepth = (fire: THREE.Mesh) => {
    fire.castShadow = false;
    fire.receiveShadow = false;
    fire.renderOrder = 0;
    const mat = fire.material;
    if (mat && !Array.isArray(mat)) {
      if (!mat.depthTest || mat.depthWrite) {
        mat.depthTest = true;
        mat.depthWrite = false;
        mat.transparent = true;
        mat.needsUpdate = true;
      }
    }
  };

  useLayoutEffect(() => {
    const mesh = fireRef.current?.fire;
    if (mesh) applyFireDepth(mesh);
  }, [density]);

  if (!density) return <CampfireVolumetricFlame />;
  return (
    <Fire
      ref={fireRef}
      texture={density}
      color={0xff6a28}
      magnitude={1.4}
      lacunarity={2.1}
      gain={0.55}
      iterations={8}
      octaves={2}
      noiseScale={[1, 2.15, 1, 0.32]}
      scale={[1.25, 2.35, 1.25]}
      position={[0, 1.18, 0]}
      onUpdate={(fire) => applyFireDepth(fire)}
    />
  );
}

/**
 * Iso depth key for occlusion props (trees) + characters.
 * Camera sits at +X/+Z, so larger x+z is closer and must draw later.
 * Base clears the worst SW corner (bounds min x+z ≈ -112 → ~-4500 raw)
 * so this band stays above grass/small clutter (~2–6), water (~5), and
 * gather sparkles (~9–11). Units never slip behind weeds; trees still
 * sort against characters within the same band.
 */
export const CLUTTER_RENDER_ORDER = 4;
export const OCCLUSION_SORT_BASE = 10_000;

export function isoSortOrder(x: number, z: number): number {
  return Math.floor((x + z) * 40) + OCCLUSION_SORT_BASE;
}

type PropInst = {
  x: number;
  z: number;
  s: number;
  y: number;
  /** Horizontal mirror. */
  flip?: boolean;
  /** Multiplier on layer aspectW (width/height). */
  aspectMul?: number;
  /** Extra sink into ground (fraction of height). */
  sink?: number;
};

/** Filter instances with load/unload hysteresis keyed by stable position. */
function filterPropsByStream(
  items: PropInst[],
  focus: StreamFocus,
  activeKeys: Set<string>,
): PropInst[] {
  const loadR2 = focus.loadR * focus.loadR;
  const unloadR2 = focus.unloadR * focus.unloadR;
  const next = new Set<string>();
  const out: PropInst[] = [];
  for (const g of items) {
    const key = `${g.x.toFixed(2)},${g.z.toFixed(2)}`;
    const d2 = distSqXZ(g.x, g.z, focus.x, focus.z);
    const keep = d2 <= loadR2 || (activeKeys.has(key) && d2 <= unloadR2);
    if (keep) {
      next.add(key);
      out.push(g);
    }
  }
  activeKeys.clear();
  for (const k of next) activeKeys.add(k);
  return out;
}

/** Y-axis billboard material for instanced clutter props (cheap, no per-instance JS). */
function makePropBillboardMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    transparent: true,
    depthWrite: true,
    depthTest: true,
    alphaTest: 0.08,
    side: THREE.DoubleSide,
    toneMapped: true,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 worldOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // Preserve X scale sign so instances can mirror (negative scale.x).
        vec3 xAxis = (modelMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
        vec3 yAxis = (modelMatrix * instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        float sx = length(xAxis);
        float sy = length(yAxis);
        float flipSign = sign(instanceMatrix[0][0]);
        if (abs(flipSign) < 0.001) flipSign = 1.0;
        // Optional lean baked into unused Z scale (1 + lean).
        float lean = instanceMatrix[2][2] - 1.0;
        lean = clamp(lean, -0.35, 0.35);
        vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camUp = vec3(0.0, 1.0, 0.0);
        vec3 worldPos = worldOrigin.xyz
          + camRight * (position.x * sx * flipSign + position.y * sy * lean)
          + camUp * position.y * sy;
        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(map, vUv);
        if (c.a < 0.08) discard;
        gl_FragColor = c;
      }
    `,
  });
}

function writePropInstances(
  mesh: THREE.InstancedMesh | null,
  items: PropInst[],
  aspectW: number,
  yLift = 0.5,
) {
  if (!mesh) return;
  const dummy = new THREE.Object3D();
  items.forEach((g, i) => {
    const h = g.s;
    const aspect = aspectW * (g.aspectMul ?? 1);
    const w = h * aspect;
    const sink = g.sink ?? 0;
    dummy.position.set(g.x, g.y + h * (yLift - sink), g.z);
    dummy.rotation.set(0, 0, 0);
    // scale.z encodes lean: 1 + lean (shader reads instanceMatrix[2][2])
    const lean = ((hash2(Math.floor(g.x * 17), Math.floor(g.z * 19)) - 0.5) * 0.28);
    dummy.scale.set(g.flip ? -w : w, h, 1 + lean);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.count = items.length;
}

function PropLayer({
  url,
  items,
  aspectW,
  yLift = 0.5,
  focus,
}: {
  url: string;
  items: PropInst[];
  aspectW: number;
  yLift?: number;
  focus: StreamFocus;
}) {
  const map = useTexture(url);
  const mat = useMemo(() => makePropBillboardMaterial(map), [map]);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const activeKeys = useRef(new Set<string>());
  const capacity = Math.max(1, items.length);

  useLayoutEffect(() => {
    const visible = filterPropsByStream(items, focus, activeKeys.current);
    writePropInstances(mesh.current, visible, aspectW, yLift);
    const m = mesh.current;
    if (m) {
      // Bound sphere around stream focus so frustum culling can drop off-screen layers.
      m.geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(focus.x, 0, focus.z),
        focus.unloadR + 8,
      );
      m.frustumCulled = true;
    }
  }, [items, aspectW, yLift, focus]);

  if (items.length === 0) return null;
  return (
    <instancedMesh
      key={capacity}
      ref={mesh}
      args={[undefined, undefined, capacity]}
      material={mat}
      frustumCulled
      renderOrder={CLUTTER_RENDER_ORDER}
    >
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  );
}

/**
 * Tree billboard material — Y-axis camera face like PropLayer.
 * Fragment depth is the real view-space depth of the quad so opaque mountain
 * cones occlude trees behind the silhouette. An absolute (x+z) gl_Position.z
 * bias scaled with world position and pulled northern trees through the rock.
 */
function makeTreeBillboardMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  map.colorSpace = THREE.SRGBColorSpace;
  map.needsUpdate = true;
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      tint: { value: new THREE.Color("#b8b4a8") },
    },
    transparent: true,
    depthWrite: true,
    depthTest: true,
    alphaTest: 0.08,
    side: THREE.DoubleSide,
    toneMapped: true,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 worldOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 xAxis = (modelMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
        vec3 yAxis = (modelMatrix * instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        float sx = length(xAxis);
        float sy = length(yAxis);
        float flipSign = sign(instanceMatrix[0][0]);
        if (abs(flipSign) < 0.001) flipSign = 1.0;
        vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camUp = vec3(0.0, 1.0, 0.0);
        vec3 worldPos = worldOrigin.xyz
          + camRight * (position.x * sx * flipSign)
          + camUp * position.y * sy;
        gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 tint;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(map, vUv);
        if (c.a < 0.08) discard;
        gl_FragColor = vec4(c.rgb * tint, c.a);
      }
    `,
  });
}

function TreeLayer({
  url,
  items,
  focus,
}: {
  url: string;
  items: PropInst[];
  focus: StreamFocus;
}) {
  const map = useTexture(url);
  const mat = useMemo(() => makeTreeBillboardMaterial(map), [map]);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const activeKeys = useRef(new Set<string>());
  const img = map.image as { width?: number; height?: number } | undefined;
  const aspectW = (img?.width ?? 3) / Math.max(1, img?.height ?? 4);
  const capacity = Math.max(1, items.length);

  useLayoutEffect(() => {
    const visible = filterPropsByStream(items, focus, activeKeys.current);
    writePropInstances(mesh.current, visible, aspectW, 0.5);
    const m = mesh.current;
    if (m) {
      m.geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(focus.x, 1.2, focus.z),
        focus.unloadR + 12,
      );
      m.frustumCulled = true;
    }
  }, [items, aspectW, focus]);

  if (items.length === 0) return null;
  return (
    <instancedMesh
      key={capacity}
      ref={mesh}
      args={[undefined, undefined, capacity]}
      material={mat}
      frustumCulled
      // Just above grass clutter so coplanar tufts don't cover trunks.
      // Not OCCLUSION_SORT_BASE — that band draws after all terrain. Mountains
      // are opaque and occlude these quads via the depth buffer.
      renderOrder={CLUTTER_RENDER_ORDER + 2}
    >
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  );
}

type WorldTree = { x: number; z: number; url: string; height: number };

/** Matches the peak cones in PaleHollowTerrain (scale, radii, local offsets). */
function peakRockScale(h: number): number {
  return Math.max(0.7, h / 8);
}

/**
 * Radius of a ConeGeometry (base at -height/2, apex at +height/2) where a
 * horizontal plane `centerAbove` units below the cone center cuts it.
 */
function coneRadiusAtOffset(baseR: number, height: number, centerAbove: number): number {
  const half = height * 0.5;
  const yLocal = -centerAbove;
  const t = (yLocal + half) / Math.max(height, 1e-4);
  const u = Math.max(0, Math.min(1, t));
  return baseR * (1 - u);
}

/** Trunk anchor sits inside a rendered rocky peak (not the walkable slope). */
function treeInsidePeakRock(x: number, z: number): boolean {
  for (const m of PH_MOUNTAINS) {
    if (m.z <= -8) continue;
    const scale = peakRockScale(m.h);
    const dx = x - m.x;
    const dz = z - m.z;
    const mainAbove = -1.2 + 2.4 * scale;
    const mainR = coneRadiusAtOffset(5.2 * scale, 7.2 * scale, mainAbove) + 0.35;
    if (dx * dx + dz * dz < mainR * mainR) return true;
    const sideAbove = -1.2 + 1.3 * scale;
    const sideR = coneRadiusAtOffset(2.8 * scale, 4.2 * scale, sideAbove) + 0.25;
    const dx2 = dx - 2.4 * scale;
    const dz2 = dz - 1.6 * scale;
    if (dx2 * dx2 + dz2 * dz2 < sideR * sideR) return true;
  }
  return false;
}

/** Ash near banks (not in water), pine/spruce on grass, cypress by mountains. */
function WorldTrees({ focus }: { focus: StreamFocus }) {
  const byUrl = useMemo(() => {
    const out: WorldTree[] = [];
    const blocked = (x: number, z: number) => {
      const b = paleHollowBiome(x, z);
      if (b === "river" || b === "hub_indoor" || b === "bridge" || b === "ash_road") return true;
      if (paleHollowInOpenWater(x, z)) return true;
      if (paleHollowInBuildingClearing(x, z)) return true;
      if (treeInsidePeakRock(x, z)) return true;
      return false;
    };
    const push = (x: number, z: number, url: string, height: number) => {
      if (blocked(x, z)) return;
      out.push({ x, z, url, height });
    };

    for (let ix = -78; ix <= 78; ix += 7.5) {
      for (let iz = 10; iz <= 245; iz += 8.5) {
        const jx = ix + (hash2(ix, iz) - 0.5) * 5.5;
        const jz = iz + (hash2(iz, ix) - 0.5) * 5.5;
        if (blocked(jx, jz)) continue;
        const b = paleHollowBiome(jx, jz);
        const h = hash2(Math.floor(jx * 2), Math.floor(jz * 2));
        const h2 = hash2(Math.floor(jz * 3), Math.floor(jx * 3));

        // Ash — riverbank only (near water, never in the channel)
        if (b === "riverbank" && h > 0.35) {
          if (h2 > 0.55) {
            push(jx, jz, PROP_SPRITES.ashTall, 4.6 + h * 1.2);
          } else {
            push(jx, jz, PROP_SPRITES.ashMed, 3.4 + h * 0.9);
          }
          continue;
        }

        // Pine / spruce — grassy meadows & open grass (light on farms)
        if (b === "grass" || b === "meadow" || (b === "farm" && h > 0.7)) {
          if (h < 0.42) continue;
          if (h2 > 0.5) {
            push(jx, jz, PROP_SPRITES.pine, 3.8 + h * 1.3);
          } else {
            push(jx, jz, PROP_SPRITES.spruce, 3.5 + h * 1.1);
          }
          continue;
        }

        // Cypress — mountain shoulders & quarry edges
        if (b === "mountain" || b === "quarry") {
          if (h < 0.4) continue;
          push(jx, jz, PROP_SPRITES.cypress, 4.2 + h * 1.6);
          continue;
        }

        // Scrub foothills near peaks get a few cypress too
        if (b === "scrub" && h > 0.72) {
          let nearMtn = false;
          for (const m of PH_MOUNTAINS) {
            if (Math.hypot(jx - m.x, jz - m.z) < m.r * 1.15) {
              nearMtn = true;
              break;
            }
          }
          if (nearMtn) push(jx, jz, PROP_SPRITES.cypress, 3.8 + h * 1.2);
        }
      }
    }

    const groups = new Map<string, PropInst[]>();
    for (const t of out) {
      const sink = Math.min(0.22, t.height * 0.04);
      const list = groups.get(t.url) ?? [];
      list.push({
        x: t.x,
        z: t.z,
        s: t.height,
        y: paleHollowHeight(t.x, t.z),
        sink: sink / Math.max(t.height, 0.01),
        aspectMul: 1,
      });
      groups.set(t.url, list);
    }
    return [...groups.entries()].map(([url, items]) => ({ url, items }));
  }, []);

  return (
    <group>
      {byUrl.map(({ url, items }) => (
        <Suspense key={url} fallback={null}>
          <TreeLayer url={url} items={items} focus={focus} />
        </Suspense>
      ))}
    </group>
  );
}

type ClutterLayers = {
  longGrass: PropInst[];
  longGrassB: PropInst[];
  tallPatch: PropInst[];
  tallPatchB: PropInst[];
  ferns: PropInst[];
  fernsB: PropInst[];
  tufts: PropInst[];
  bushes: PropInst[];
  bushesB: PropInst[];
  rocks: PropInst[];
  rocksB: PropInst[];
  stalks: PropInst[];
  reeds: PropInst[];
  scrub: PropInst[];
  scrubB: PropInst[];
  blooms: PropInst[];
  saplings: PropInst[];
};

function emptyClutterLayers(): ClutterLayers {
  return {
    longGrass: [],
    longGrassB: [],
    tallPatch: [],
    tallPatchB: [],
    ferns: [],
    fernsB: [],
    tufts: [],
    bushes: [],
    bushesB: [],
    rocks: [],
    rocksB: [],
    stalks: [],
    reeds: [],
    scrub: [],
    scrubB: [],
    blooms: [],
    saplings: [],
  };
}

function mergeClutterLayers(chunks: Iterable<ClutterLayers>): ClutterLayers {
  const out = emptyClutterLayers();
  for (const c of chunks) {
    (Object.keys(out) as (keyof ClutterLayers)[]).forEach((k) => {
      out[k].push(...c[k]);
    });
  }
  return out;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (
      globalThis as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === "function") {
      ric(() => resolve(), { timeout: 32 });
    } else {
      requestAnimationFrame(() => resolve());
    }
  });
}

const CLUTTER_IX0 = -82;
const CLUTTER_IZ0 = 6;
/** Wider grid = fewer billboards; still reads as meadow from iso cam. */
const CLUTTER_IX_STEP = 3.9;
const CLUTTER_IZ_STEP = 4.1;
const CLUTTER_IX_MAX = 82;
const CLUTTER_IZ_MAX = 252;

function chunkKey(cx: number, cz: number) {
  return `${cx},${cz}`;
}

function parseChunkKey(key: string): { cx: number; cz: number } {
  const [a, b] = key.split(",");
  return { cx: Number(a), cz: Number(b) };
}

/** Distance from focus to chunk AABB (0 if inside). */
function chunkDistSq(cx: number, cz: number, fx: number, fz: number) {
  const minX = cx * PH_STREAM_CHUNK;
  const maxX = minX + PH_STREAM_CHUNK;
  const minZ = cz * PH_STREAM_CHUNK;
  const maxZ = minZ + PH_STREAM_CHUNK;
  const qx = Math.max(minX, Math.min(fx, maxX));
  const qz = Math.max(minZ, Math.min(fz, maxZ));
  return distSqXZ(qx, qz, fx, fz);
}

function desiredClutterChunks(focus: StreamFocus, loaded: Set<string>): Set<string> {
  const out = new Set<string>();
  const loadR2 = focus.loadR * focus.loadR;
  const unloadR2 = focus.unloadR * focus.unloadR;
  const pad = focus.unloadR;
  const cx0 = Math.floor((focus.x - pad) / PH_STREAM_CHUNK);
  const cx1 = Math.floor((focus.x + pad) / PH_STREAM_CHUNK);
  const cz0 = Math.floor((focus.z - pad) / PH_STREAM_CHUNK);
  const cz1 = Math.floor((focus.z + pad) / PH_STREAM_CHUNK);

  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const d2 = chunkDistSq(cx, cz, focus.x, focus.z);
      const key = chunkKey(cx, cz);
      if (d2 <= loadR2 || (loaded.has(key) && d2 <= unloadR2)) {
        out.add(key);
      }
    }
  }
  return out;
}

/** Place clutter cells for one chunk using the global irregular grid. */
function placeClutterInChunk(cx: number, cz: number): ClutterLayers {
  const acc = emptyClutterLayers();
  const x0 = cx * PH_STREAM_CHUNK;
  const z0 = cz * PH_STREAM_CHUNK;
  const x1 = x0 + PH_STREAM_CHUNK;
  const z1 = z0 + PH_STREAM_CHUNK;

  const push = (arr: PropInst[], x: number, z: number, s: number, salt = 0) => {
    const hx = hash2(Math.floor(x * 13 + salt), Math.floor(z * 17));
    const hz = hash2(Math.floor(z * 19 + salt), Math.floor(x * 23));
    const hs = hash2(Math.floor(x * 29 + salt * 3), Math.floor(z * 31));
    arr.push({
      x: x + (hx - 0.5) * 0.85,
      z: z + (hz - 0.5) * 0.85,
      s: s * (0.78 + hs * 0.55),
      y: paleHollowHeight(x, z),
      flip: hx > 0.5,
      aspectMul: 0.82 + hz * 0.45,
      sink: 0.06 + hs * 0.1,
    });
  };

  const pushVariant = (
    a: PropInst[],
    b: PropInst[],
    x: number,
    z: number,
    s: number,
    salt = 0,
  ) => {
    const pick = hash2(Math.floor(x * 41 + salt), Math.floor(z * 43));
    push(pick > 0.48 ? b : a, x, z, s, salt);
  };

  const izStart =
    CLUTTER_IZ0 + Math.ceil((z0 - CLUTTER_IZ0) / CLUTTER_IZ_STEP) * CLUTTER_IZ_STEP;
  const ixStart =
    CLUTTER_IX0 + Math.ceil((x0 - CLUTTER_IX0) / CLUTTER_IX_STEP) * CLUTTER_IX_STEP;

  for (let iz = izStart; iz < z1 && iz <= CLUTTER_IZ_MAX; iz += CLUTTER_IZ_STEP) {
    if (iz < CLUTTER_IZ0) continue;
    for (let ix = ixStart; ix < x1 && ix <= CLUTTER_IX_MAX; ix += CLUTTER_IX_STEP) {
      if (ix < CLUTTER_IX0) continue;
      const jx = ix + (hash2(ix, iz) - 0.5) * 3.2;
      const jz = iz + (hash2(iz, ix) - 0.5) * 3.2;
      const b = paleHollowBiome(jx, jz);
      if (b === "hub_indoor" || b === "river" || b === "bridge" || b === "ash_road") continue;
      if (paleHollowInOpenWater(jx, jz)) continue;
      if (paleHollowInBuildingClearing(jx, jz)) continue;
      const h = hash2(Math.floor(jx * 3), Math.floor(jz * 3));
      const h2 = hash2(Math.floor(jz * 5), Math.floor(jx * 5));
      const h3 = hash2(Math.floor(jx * 7), Math.floor(jz * 11));

      // Skip more cells — density was the main GPU fill-rate killer with stream radius.
      if (h3 < 0.32) continue;

      const grassy =
        b === "grass" ||
        b === "meadow" ||
        b === "farm" ||
        b === "ashbeam" ||
        b === "scrub" ||
        b === "riverbank";

      if (grassy && h > 0.18) {
        const s = 0.85 + h * 1.05;
        if (h2 > 0.42) pushVariant(acc.longGrass, acc.longGrassB, jx, jz, s, 1);
        else pushVariant(acc.tallPatch, acc.tallPatchB, jx, jz, s * 1.05, 2);
        // Occasional second tuft only on denser rolls (was almost every grassy cell).
        if (h > 0.72 && h2 > 0.55) {
          const ox = (h2 - 0.5) * 2.4;
          const oz = (h3 - 0.5) * 2.2;
          pushVariant(acc.longGrass, acc.longGrassB, jx + ox, jz + oz, 0.65 + h * 0.55, 3);
        }
      }

      if ((b === "ashbeam" || b === "meadow" || b === "grass") && h > 0.55 && h2 > 0.45) {
        pushVariant(
          acc.ferns,
          acc.fernsB,
          jx + (h - 0.5) * 1.2,
          jz + (h2 - 0.5) * 1.2,
          0.9 + h * 0.7,
          4,
        );
      }

      if (grassy && h > 0.88 && h2 > 0.75) {
        push(acc.tufts, jx + (h3 - 0.5) * 1.5, jz + (h - 0.5) * 1.5, 0.4 + h * 0.25, 5);
      }

      if (b === "farm" && h > 0.28) {
        push(acc.stalks, jx + (h2 - 0.5) * 1.4, jz + (h3 - 0.5) * 1.2, 0.95 + h * 0.75, 6);
        if (h2 > 0.55) push(acc.stalks, jx - 0.9 + h3, jz + 0.7 - h, 0.8 + h * 0.5, 7);
      }

      if (b === "riverbank" && h > 0.22) {
        push(acc.reeds, jx, jz, 1.1 + h * 0.95, 8);
        if (h2 > 0.5)
          push(acc.reeds, jx + 0.7 + (h - 0.5), jz - 0.5 + (h3 - 0.5), 0.85 + h * 0.55, 9);
      }

      if (b === "scrub" && h > 0.35) {
        pushVariant(acc.scrub, acc.scrubB, jx, jz, 0.75 + h * 0.55, 10);
      }

      if ((b === "meadow" || b === "grass") && h > 0.9 && h2 > 0.85) {
        push(acc.blooms, jx + (h3 - 0.5) * 0.8, jz + (h - 0.5) * 0.8, 0.4 + h * 0.15, 11);
      }

      if ((b === "grass" || b === "meadow" || b === "ashbeam") && h > 0.72) {
        pushVariant(
          acc.bushes,
          acc.bushesB,
          jx + (h2 - 0.5) * 1.6,
          jz + (h3 - 0.5) * 1.6,
          0.8 + h * 0.5,
          12,
        );
      }

      if (b === "ashbeam" && h > 0.55 && h2 > 0.4) {
        push(acc.saplings, jx + (h3 - 0.5) * 1.1, jz + (h - 0.5) * 1.1, 1.1 + h * 0.55, 13);
      }

      if (b === "mountain" || b === "quarry" || (b === "riverbank" && h > 0.85)) {
        if (h2 > 0.5) pushVariant(acc.rocks, acc.rocksB, jx, jz, 0.4 + h * 0.55, 14);
      }
    }
  }

  return acc;
}

/** Dense mid-ground clutter — chunk-streamed around the player, instanced Y-billboards. */
function TerrainClutter() {
  const focus = useStreamFocus();
  const [layers, setLayers] = useState<ClutterLayers | null>(null);
  const chunkMap = useRef(new Map<string, ClutterLayers>());
  const loaded = useRef(new Set<string>());
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const syncGen = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const gen = ++syncGen.current;

    (async () => {
      // Cap + batch: building every chunk then setState was hitching walks (~100–300ms).
      const MAX_ADD = 3;
      while (!cancelled && gen === syncGen.current) {
        const live = focusRef.current;
        const desiredNow = desiredClutterChunks(live, loaded.current);

        let removedNow = false;
        for (const key of [...loaded.current]) {
          if (!desiredNow.has(key)) {
            loaded.current.delete(key);
            chunkMap.current.delete(key);
            removedNow = true;
          }
        }

        const pending = [...desiredNow]
          .filter((k) => !loaded.current.has(k))
          .sort((a, b) => {
            const pa = parseChunkKey(a);
            const pb = parseChunkKey(b);
            return (
              chunkDistSq(pa.cx, pa.cz, live.x, live.z) -
              chunkDistSq(pb.cx, pb.cz, live.x, live.z)
            );
          });

        if (pending.length === 0) {
          if (removedNow) {
            setLayers(mergeClutterLayers(chunkMap.current.values()));
          }
          break;
        }

        let added = 0;
        for (const key of pending) {
          if (cancelled || gen !== syncGen.current) return;
          if (added >= MAX_ADD) break;
          const { cx, cz } = parseChunkKey(key);
          chunkMap.current.set(key, placeClutterInChunk(cx, cz));
          loaded.current.add(key);
          added++;
          await yieldToMain();
        }
        if (!cancelled && gen === syncGen.current) {
          setLayers(mergeClutterLayers(chunkMap.current.values()));
        }
        // Yield a frame so walking stays interactive while the ring fills in.
        await new Promise<void>((r) => setTimeout(r, 48));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [focus.x, focus.z, focus.loadR, focus.unloadR]);

  return (
    <group>
      {layers ? (
        <>
          {/* Each layer has its own Suspense so grass can appear before slower textures. */}
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.longGrass} items={layers.longGrass} aspectW={0.55} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.longGrassB} items={layers.longGrassB} aspectW={0.55} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.tallPatch} items={layers.tallPatch} aspectW={0.7} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.tallPatchB} items={layers.tallPatchB} aspectW={0.7} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.fern} items={layers.ferns} aspectW={0.85} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.fernB} items={layers.fernsB} aspectW={0.85} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.reed} items={layers.reeds} aspectW={0.4} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.stalk} items={layers.stalks} aspectW={0.55} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.scrub} items={layers.scrub} aspectW={0.7} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.scrubB} items={layers.scrubB} aspectW={0.7} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.grassTuft} items={layers.tufts} aspectW={0.75} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.bloom} items={layers.blooms} aspectW={1} yLift={0.45} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.bush} items={layers.bushes} aspectW={1} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.bushB} items={layers.bushesB} aspectW={1} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.rock} items={layers.rocks} aspectW={1.05} yLift={0.42} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.rockB} items={layers.rocksB} aspectW={1.05} yLift={0.42} focus={focus} />
          </Suspense>
          <Suspense fallback={null}>
            <PropLayer url={PROP_SPRITES.sapling} items={layers.saplings} aspectW={0.72} yLift={0.48} focus={focus} />
          </Suspense>
        </>
      ) : null}
      {/* Trees: full catalog is cheap; GPU count is stream-filtered. */}
      <Suspense fallback={null}>
        <WorldTrees focus={focus} />
      </Suspense>
    </group>
  );
}


function TexturedPlane({
  map,
  w,
  d,
  y,
  x = 0,
  z = 0,
  repeat = 4,
  color = "#ffffff",
}: {
  map: THREE.Texture;
  w: number;
  d: number;
  y: number;
  x?: number;
  z?: number;
  repeat?: number;
  color?: string;
}) {
  const tex = useMemo(() => {
    const t = map.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }, [map, repeat]);
  return (
    <mesh position={[x, y, z]} rotation={[-Math.PI / 2, 0, 0]} onClick={onTerrainClick}>
      <planeGeometry args={[w, d]} />
      <meshStandardMaterial map={tex} color={color} roughness={0.88} />
    </mesh>
  );
}

/** Dark stone ring around the fire — running-bond courses, slightly rounded, no castShadow. */
function FirePitBrickRing({
  stoneMap,
  innerR = 0.95,
  courses = 3,
}: {
  stoneMap: THREE.Texture;
  innerR?: number;
  courses?: number;
}) {
  const bricks = useMemo(() => {
    const out: {
      x: number;
      y: number;
      z: number;
      yaw: number;
      w: number;
      h: number;
      d: number;
      color: string;
      round: boolean;
    }[] = [];
    const brickH = 0.2;
    const brickD = 0.34;
    const colors = ["#4a4640", "#3c3934", "#555048", "#2e2c28", "#5a564e"] as const;
    for (let course = 0; course < courses; course++) {
      const y = brickH * 0.5 + course * brickH;
      const count = course === 0 ? 16 : course === 1 ? 15 : 14;
      const r = innerR + brickD * 0.45 + course * 0.02;
      const bond = course % 2 === 1 ? Math.PI / count : 0;
      const brickW = (2 * Math.PI * r) / count - 0.04;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + bond;
        out.push({
          x: Math.cos(a) * r,
          y,
          z: Math.sin(a) * r,
          yaw: -a + Math.PI / 2,
          w: brickW * (0.92 + ((i * 3 + course) % 5) * 0.03),
          h: brickH * (0.88 + ((i + course) % 3) * 0.04),
          d: brickD * (0.9 + (i % 4) * 0.04),
          color: colors[(i + course * 3) % colors.length]!,
          round: (i + course) % 3 !== 0,
        });
      }
    }
    const capCount = 14;
    const capR = innerR + brickD * 0.42 + (courses - 1) * 0.02;
    const capY = courses * brickH + 0.05;
    const capW = (2 * Math.PI * capR) / capCount - 0.03;
    for (let i = 0; i < capCount; i++) {
      const a = (i / capCount) * Math.PI * 2 + Math.PI / capCount;
      out.push({
        x: Math.cos(a) * capR,
        y: capY,
        z: Math.sin(a) * capR,
        yaw: -a + Math.PI / 2,
        w: capW,
        h: 0.11,
        d: brickD * 1.05,
        color: colors[i % colors.length]!,
        round: true,
      });
    }
    return out;
  }, [innerR, courses]);

  return (
    <group>
      {bricks.map((b, i) => (
        <mesh
          key={`brick-${i}`}
          position={[b.x, b.y, b.z]}
          rotation={[0.08 * ((i % 5) - 2), b.yaw, 0.05 * ((i % 3) - 1)]}
          scale={b.round ? [1, 0.92, 1] : [1, 1, 1]}
          castShadow={false}
          receiveShadow={false}
        >
          {b.round ? <dodecahedronGeometry args={[Math.max(b.w, b.d) * 0.42, 0]} /> : <boxGeometry args={[b.w, b.h, b.d]} />}
          <meshStandardMaterial
            map={stoneMap}
            color={b.color}
            roughness={0.94}
            metalness={0.02}
            depthTest
            depthWrite
            transparent={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Soft circular scout camp — fire-centered, sparse stations (not a village). */
function HubEncampment({
  dirtMap: dirtAlbedoSrc,
  woodMap,
  stoneMap,
}: {
  /** Mud/dirt albedo (already Suspense-loaded with terrain). */
  dirtMap: THREE.Texture;
  woodMap: THREE.Texture;
  stoneMap: THREE.Texture;
}) {
  const y0 = PH_HUB.floorY;
  const fireRef = useRef<THREE.PointLight>(null);
  const fireFillRef = useRef<THREE.PointLight>(null);
  const emberGlowRef = useRef<THREE.Mesh>(null);
  const smokeGroupRef = useRef<THREE.Group>(null);
  // Non-Suspense — hub sprites must not gate the whole Canvas.
  const bannerTex = useLazyChromaTexture(PROP_SPRITES.campBanner);
  const coalsTex = useLazyChromaTexture(PROP_SPRITES.campCoals);
  const oliveClothMap = useMemo(() => makeOpaqueCanvasCloth("#7a8458", "#4a5238"), []);
  const beigeClothMap = useMemo(() => makeOpaqueCanvasCloth("#b5a484", "#7a6c54"), []);
  const smokeTex = useMemo(() => makeSmokePuffTexture(), []);
  const charredTex = useMemo(() => makeCharredEarthTexture(), []);
  const dirtNormal = useMemo(() => makeHubDirtNormalMap(), []);
  const dirtRough = useMemo(() => makeHubDirtRoughnessMap(), []);
  const dirtEdgeAlpha = useMemo(() => makeHubDirtEdgeAlphaMap(), []);
  // Slightly larger disc so shade covers Herald / Job Master / Craft Master lobes.
  const dirtGeo = useMemo(() => makeHubDirtGeo(12.5, 48), []);
  const dirtMap = useMemo(() => {
    const t = dirtAlbedoSrc.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4.2, 4.2);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }, [dirtAlbedoSrc]);
  const dirtMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: dirtMap,
        normalMap: dirtNormal,
        roughnessMap: dirtRough,
        alphaMap: dirtEdgeAlpha,
        color: new THREE.Color("#8a7a62"),
        roughness: 0.96,
        metalness: 0,
        transparent: true,
        depthWrite: false,
        // No alphaTest — hard discard on a disc edge reads as jagged wedges.
        alphaTest: 0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        normalScale: new THREE.Vector2(0.28, 0.28),
        flatShading: false,
      }),
    [dirtMap, dirtNormal, dirtRough, dirtEdgeAlpha],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const flicker =
      2.15 + Math.sin(t * 6.8) * 0.38 + Math.sin(t * 14.2) * 0.22 + Math.sin(t * 23) * 0.12 + Math.sin(t * 31) * 0.06;
    if (fireRef.current) {
      fireRef.current.intensity = flicker;
      fireRef.current.color.setRGB(1.0 + Math.sin(t * 9) * 0.04, 0.58 + Math.sin(t * 7) * 0.06, 0.22);
    }
    if (fireFillRef.current) {
      fireFillRef.current.intensity = 0.55 + Math.sin(t * 5.5) * 0.12 + Math.sin(t * 17) * 0.06;
    }
    if (emberGlowRef.current) {
      const s = 0.92 + Math.sin(t * 5.2) * 0.1;
      emberGlowRef.current.scale.set(s * 1.15, s * 0.55, s * 1.15);
      const mat = emberGlowRef.current.material as THREE.MeshStandardMaterial;
      if (mat && !Array.isArray(mat)) mat.emissiveIntensity = 1.2 + Math.sin(t * 8) * 0.25;
    }
    if (smokeGroupRef.current) {
      smokeGroupRef.current.children.forEach((ch, i) => {
        const phase = t * (0.28 + i * 0.06) + i * 1.7;
        const life = (phase % 4.0) / 4.0;
        ch.position.y = 1.6 + life * 3.2;
        ch.position.x = Math.sin(phase * 0.7 + i) * 0.35 * life;
        ch.position.z = Math.cos(phase * 0.55 + i) * 0.28 * life;
        ch.scale.setScalar(0.45 + life * 1.6);
        ch.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          const mat = obj.material;
          if (!mat || Array.isArray(mat)) return;
          if ("opacity" in mat) {
            // Soft dissipate — peak mid-life then fade
            const fade = life < 0.2 ? life / 0.2 : 1 - (life - 0.2) / 0.8;
            (mat as THREE.MeshBasicMaterial).opacity = 0.28 * Math.max(0, fade);
          }
        });
      });
    }
  });

  /** Weathered olive + dusty beige canvas (reference art direction) */
  const olive = "#7a8458";
  const oliveShade = "#656e48";
  const oliveDark = "#52583a";
  const beige = "#b5a484";
  const beigeShade = "#9a8a6c";
  const ashWood = "#6a5844";
  const crateWood = "#8a7a62";
  const iron = "#6a6864";

  return (
    <group>
      {/* ONE textured dirt clearing — soft alpha rim into grass (no solid color rings). */}
      <mesh
        geometry={dirtGeo}
        material={dirtMat}
        position={[0, y0 + 0.045, 0.55]}
        rotation={[-Math.PI / 2, 0, 0.08]}
        renderOrder={1}
      />

      <HubRearRockWall y0={y0} stoneMap={stoneMap} />
      <HubFireAtmosphere y0={y0} />
      {(
        [
          [2.2, 0.04, 1.8, 0.4],
          [-1.5, 0.03, 2.4, 1.1],
          [3.8, 0.035, -1.2, 0.2],
          [-3.2, 0.03, 0.8, 0.9],
          [1.1, 0.03, -2.8, 0.5],
          [-4.5, 0.04, -2.2, 1.4],
          [5.2, 0.03, 2.0, 0.3],
          [-0.8, 0.03, 4.2, 0.7],
        ] as const
      ).map(([px, py, pz, yaw], i) => (
        <mesh key={`peb-${i}`} position={[px, y0 + py, pz]} rotation={[0.2, yaw, 0.1]} scale={0.35 + (i % 3) * 0.12}>
          <dodecahedronGeometry args={[0.22, 0]} />
          <meshStandardMaterial color={i % 2 ? "#8a8070" : "#6a6050"} roughness={0.95} />
        </mesh>
      ))}

      {/* —— Main campfire (warm hero light) —— */}
      <group position={[0, y0, 0.4]}>
        {/* Soft charred earth — dark tint only, not an orange glow disc */}
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0.15]} renderOrder={2}>
          <planeGeometry args={[3.6, 3.6]} />
          <meshBasicMaterial map={charredTex} transparent depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0.2]} renderOrder={2}>
          <circleGeometry args={[1.15, 28]} />
          {coalsTex ? (
            <meshBasicMaterial map={coalsTex} transparent depthWrite={false} toneMapped={false} />
          ) : (
            <meshBasicMaterial color="#3a2818" transparent opacity={0.85} depthWrite={false} toneMapped={false} />
          )}
        </mesh>
        <FirePitBrickRing stoneMap={stoneMap} innerR={0.92} courses={3} />
        {(
          [
            [0.55, 0.16, 0.18, 0.4, 0.55],
            [-0.48, 0.15, 0.38, 1.9, 0.5],
            [0.14, 0.16, -0.55, 0.1, 0.52],
            [-0.32, 0.18, -0.32, 2.4, 0.48],
            [0.42, 0.17, -0.22, 1.2, 0.5],
            [-0.12, 0.19, 0.5, 3.0, 0.46],
          ] as const
        ).map(([lx, ly, lz, yaw, len], i) => (
          <mesh key={`log-${i}`} position={[lx, ly, lz]} rotation={[0.2, yaw, 0.45]} castShadow={false}>
            <cylinderGeometry args={[0.12, 0.15, len, 7]} />
            <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.92} />
          </mesh>
        ))}
        <mesh ref={emberGlowRef} position={[0, 0.14, 0]} castShadow={false}>
          <sphereGeometry args={[0.42, 10, 8]} />
          <meshStandardMaterial color="#2a1c16" emissive="#c05820" emissiveIntensity={1.35} roughness={0.75} />
        </mesh>
        {(
          [
            [0.22, 0.24, 0.1],
            [-0.18, 0.22, -0.15],
            [0.05, 0.26, -0.22],
            [-0.08, 0.23, 0.2],
            [0.12, 0.28, 0.05],
          ] as const
        ).map(([ex, ey, ez], i) => (
          <mesh key={`coal-${i}`} position={[ex, ey, ez]} castShadow={false}>
            <sphereGeometry args={[0.09 + i * 0.012, 6, 6]} />
            <meshStandardMaterial color="#e09040" emissive="#d07030" emissiveIntensity={1.55} roughness={0.45} />
          </mesh>
        ))}
        <HubCampfireVolume />
        <group ref={smokeGroupRef}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Billboard key={`smoke-${i}`} follow position={[0, 1.6, 0]}>
              <mesh>
                <planeGeometry args={[1.25, 1.25]} />
                <meshBasicMaterial
                  map={smokeTex}
                  transparent
                  depthTest
                  depthWrite={false}
                  opacity={0.22}
                  toneMapped={false}
                  side={THREE.DoubleSide}
                />
              </mesh>
            </Billboard>
          ))}
        </group>
        <pointLight
          ref={fireRef}
          position={[0, 1.25, 0]}
          color="#e09848"
          intensity={2.35}
          distance={26}
          decay={2}
          castShadow={false}
        />
        <pointLight
          ref={fireFillRef}
          position={[0, 0.55, 0]}
          color="#ff8040"
          intensity={0.65}
          distance={10}
          decay={2}
          castShadow={false}
        />
      </group>

      {/* —— 2 A-frame tents (olive / beige) + interiors —— */}
      {/* West — Trainer / west tent */}
      <CampTent
        x={-5.6}
        z={4.2}
        y={y0}
        yaw={0.55}
        cloth={olive}
        clothShade={oliveShade}
        clothDark={oliveDark}
        woodMap={woodMap}
        canvasMap={oliveClothMap}
        showInterior
      />
      {/* SW — Provisioner side (beige weathered) */}
      <CampTent
        x={-5.8}
        z={-1.6}
        y={y0}
        yaw={-0.25}
        cloth={beige}
        clothShade={beigeShade}
        clothDark={oliveDark}
        woodMap={woodMap}
        canvasMap={beigeClothMap}
        showInterior
      />

      {/* —— Craft lean-to / awning (east — Craft Master) —— */}
      <CraftLeanTo x={4.6} z={-0.9} y={y0} yaw={-0.35} cloth={olive} clothShade={oliveShade} woodMap={woodMap} canvasMap={oliveClothMap} ashWood={ashWood} iron={iron} />

      {/* —— Trainer desk (near -3.2, 4.8) —— */}
      <TrainerStation x={-4.35} z={3.55} y={y0} yaw={0.4} woodMap={woodMap} ashWood={ashWood} />

      {/* —— Provisioner stall (near -3.8, -0.2) —— */}
      <ProvisionerStall x={-3.5} z={-1.35} y={y0} yaw={0.15} woodMap={woodMap} ashWood={ashWood} crateWood={crateWood} iron={iron} />

      {/* —— Weapon rack near Job Master (3.5, 2.5) —— */}
      <group position={[4.6, y0, 2.85]} rotation={[0, -0.55, 0]}>
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[1.25, 0.08, 0.35]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
        <mesh position={[-0.5, 0.65, 0]}>
          <cylinderGeometry args={[0.045, 0.055, 1.3, 6]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
        <mesh position={[0.5, 0.65, 0]}>
          <cylinderGeometry args={[0.045, 0.055, 1.3, 6]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
        <mesh position={[0, 1.15, 0]}>
          <boxGeometry args={[1.1, 0.07, 0.08]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[1.1, 0.06, 0.07]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
        {([-0.32, 0, 0.32] as const).map((ox, i) => (
          <group key={`blade-${i}`} position={[ox, 0.78, 0.06]} rotation={[0.12, 0, 0.06 * (i - 1)]}>
            <mesh position={[0, 0.05, 0]}>
              <boxGeometry args={[0.045, 0.95, 0.035]} />
              <meshStandardMaterial color="#9aa0a8" metalness={0.45} roughness={0.4} />
            </mesh>
            <mesh position={[0, 0.42, 0]}>
              <boxGeometry args={[0.09, 0.06, 0.04]} />
              <meshStandardMaterial color="#c4a868" metalness={0.4} roughness={0.45} />
            </mesh>
            <mesh position={[0, -0.42, 0]}>
              <boxGeometry args={[0.12, 0.12, 0.05]} />
              <meshStandardMaterial color="#5a4838" roughness={0.85} />
            </mesh>
          </group>
        ))}
      </group>

      {/* Sparse purposeful clutter — firewood, barrel, rope coil */}
      <group position={[2.4, y0, -2.6]}>
        {([-0.15, 0.12, -0.05] as const).map((ox, i) => (
          <mesh key={`fw-${i}`} position={[ox, 0.12 + i * 0.1, i * 0.08]} rotation={[0.2, i * 0.7, 0.5]}>
            <cylinderGeometry args={[0.08, 0.09, 0.55, 6]} />
            <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.92} />
          </mesh>
        ))}
      </group>
      <mesh position={[-1.8, y0 + 0.35, -3.2]}>
        <cylinderGeometry args={[0.28, 0.3, 0.7, 10]} />
        <meshStandardMaterial map={woodMap} color="#7a6850" roughness={0.9} />
      </mesh>
      <mesh position={[-1.8, y0 + 0.72, -3.2]}>
        <cylinderGeometry args={[0.3, 0.3, 0.06, 10]} />
        <meshStandardMaterial color={iron} metalness={0.3} roughness={0.55} />
      </mesh>
      <mesh position={[1.6, y0 + 0.12, 3.8]} rotation={[Math.PI / 2, 0, 0.3]}>
        <torusGeometry args={[0.28, 0.07, 6, 12]} />
        <meshStandardMaterial color="#6a5e50" roughness={0.95} />
      </mesh>

      {/* Banner near Herald */}
      <group position={[1.05, y0, 5.45]}>
        <mesh position={[0, 1.05, 0]}>
          <cylinderGeometry args={[0.045, 0.055, 2.1, 6]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
        <mesh position={[0, 2.12, 0]}>
          <sphereGeometry args={[0.07, 6, 6]} />
          <meshStandardMaterial color="#c4a868" metalness={0.35} roughness={0.5} />
        </mesh>
        {bannerTex ? (
          <Billboard follow position={[0.35, 1.45, 0]}>
            <mesh renderOrder={5}>
              <planeGeometry args={[1.05, 1.45]} />
              <meshStandardMaterial
                map={bannerTex}
                transparent
                alphaTest={0.12}
                depthWrite={false}
                roughness={0.85}
                side={THREE.DoubleSide}
              />
            </mesh>
          </Billboard>
        ) : null}
      </group>

      <mesh position={[-1.2, y0 + 0.2, -4.2]} rotation={[0.1, 0.3, 0.05]}>
        <boxGeometry args={[0.65, 0.4, 0.48]} />
        <meshStandardMaterial map={stoneMap} color="#b0a890" roughness={0.95} />
      </mesh>

      <StorageChestProp woodMap={woodMap} />
    </group>
  );
}

function TrainerStation({
  x,
  z,
  y,
  yaw,
  woodMap,
  ashWood,
}: {
  x: number;
  z: number;
  y: number;
  yaw: number;
  woodMap: THREE.Texture;
  ashWood: string;
}) {
  return (
    <group position={[x, y, z]} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.38, 0]}>
        <boxGeometry args={[1.15, 0.08, 0.48]} />
        <meshStandardMaterial map={woodMap} color="#7a6850" roughness={0.88} />
      </mesh>
      {(
        [
          [-0.45, 0.18, -0.15],
          [0.45, 0.18, -0.15],
          [-0.45, 0.18, 0.15],
          [0.45, 0.18, 0.15],
        ] as const
      ).map(([lx, ly, lz], i) => (
        <mesh key={`dleg-${i}`} position={[lx, ly, lz]}>
          <boxGeometry args={[0.08, 0.36, 0.08]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
      ))}
      {/* Low shelf / book stack */}
      <mesh position={[-0.25, 0.55, -0.05]}>
        <boxGeometry args={[0.35, 0.28, 0.22]} />
        <meshStandardMaterial color="#6a5848" roughness={0.9} />
      </mesh>
      <mesh position={[0.15, 0.48, 0.05]} rotation={[0, 0.3, 0]}>
        <boxGeometry args={[0.22, 0.12, 0.28]} />
        <meshStandardMaterial color="#8a7058" roughness={0.88} />
      </mesh>
      {/* Scrolls + jar */}
      <mesh position={[0.38, 0.46, -0.08]} rotation={[0.2, 0, 0.4]}>
        <cylinderGeometry args={[0.04, 0.04, 0.28, 6]} />
        <meshStandardMaterial color="#c4b090" roughness={0.85} />
      </mesh>
      <mesh position={[0.28, 0.48, -0.14]} rotation={[0.1, 0.5, 0.2]}>
        <cylinderGeometry args={[0.035, 0.035, 0.24, 6]} />
        <meshStandardMaterial color="#d4c4a8" roughness={0.85} />
      </mesh>
      <mesh position={[0.42, 0.52, 0.12]}>
        <cylinderGeometry args={[0.07, 0.08, 0.18, 8]} />
        <meshStandardMaterial color="#7a9088" transparent opacity={0.75} roughness={0.35} />
      </mesh>
      <mesh position={[-0.48, 0.52, -0.08]}>
        <cylinderGeometry args={[0.055, 0.06, 0.2, 8]} />
        <meshStandardMaterial color="#6a4060" transparent opacity={0.8} roughness={0.3} emissive="#402050" emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[-0.55, 0.48, 0.08]}>
        <cylinderGeometry args={[0.045, 0.05, 0.14, 8]} />
        <meshStandardMaterial color="#406860" transparent opacity={0.75} roughness={0.3} />
      </mesh>
      {/* Extra grimoire stack */}
      <mesh position={[0.05, 0.62, -0.12]} rotation={[0, -0.25, 0]}>
        <boxGeometry args={[0.2, 0.06, 0.26]} />
        <meshStandardMaterial color="#4a3848" roughness={0.88} />
      </mesh>
      <mesh position={[0.08, 0.68, -0.1]} rotation={[0, 0.15, 0]}>
        <boxGeometry args={[0.18, 0.05, 0.24]} />
        <meshStandardMaterial color="#5a4840" roughness={0.88} />
      </mesh>
      {/* Cool chrona accent */}
      <mesh position={[-0.05, 0.58, 0.12]}>
        <sphereGeometry args={[0.09, 8, 8]} />
        <meshStandardMaterial color="#a8e8f0" emissive="#40c0e0" emissiveIntensity={1.4} roughness={0.3} />
      </mesh>
      <mesh position={[0.28, 0.44, 0.1]} rotation={[0.05, 0.2, 0]}>
        <boxGeometry args={[0.28, 0.04, 0.2]} />
        <meshStandardMaterial color="#d4c4a0" roughness={0.85} />
      </mesh>
      <mesh position={[-0.4, 0.5, 0.12]}>
        <cylinderGeometry args={[0.05, 0.06, 0.16, 8]} />
        <meshStandardMaterial color="#6a8880" transparent opacity={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0.5, 0.48, 0]} rotation={[1.2, 0, 0.3]}>
        <cylinderGeometry args={[0.015, 0.015, 0.22, 4]} />
        <meshStandardMaterial color="#2a2420" roughness={0.9} />
      </mesh>
      <pointLight position={[0, 0.85, 0.1]} color="#68c8e8" intensity={0.7} distance={5} decay={2} castShadow={false} />
      {/* Firewood + rope beside desk */}
      <mesh position={[-0.85, 0.12, 0.35]} rotation={[0.3, 0.5, 0.4]}>
        <cylinderGeometry args={[0.07, 0.08, 0.5, 6]} />
        <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.92} />
      </mesh>
      <mesh position={[-0.95, 0.2, 0.45]} rotation={[0.2, 0.8, 0.5]}>
        <cylinderGeometry args={[0.06, 0.07, 0.45, 6]} />
        <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.92} />
      </mesh>
      <mesh position={[-0.7, 0.1, 0.55]} rotation={[Math.PI / 2, 0, 0.4]}>
        <torusGeometry args={[0.18, 0.045, 5, 10]} />
        <meshStandardMaterial color="#6a5e50" roughness={0.95} />
      </mesh>
    </group>
  );
}

function ProvisionerStall({
  x,
  z,
  y,
  yaw,
  woodMap,
  ashWood,
  crateWood,
  iron,
}: {
  x: number;
  z: number;
  y: number;
  yaw: number;
  woodMap: THREE.Texture;
  ashWood: string;
  crateWood: string;
  iron: string;
}) {
  return (
    <group position={[x, y, z]} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.42, 0]}>
        <boxGeometry args={[1.4, 0.1, 0.55]} />
        <meshStandardMaterial map={woodMap} color="#7a6850" roughness={0.88} />
      </mesh>
      <mesh position={[-0.55, 0.2, 0]}>
        <boxGeometry args={[0.1, 0.4, 0.45]} />
        <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
      </mesh>
      <mesh position={[0.55, 0.2, 0]}>
        <boxGeometry args={[0.1, 0.4, 0.45]} />
        <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
      </mesh>
      {/* Back rack */}
      <mesh position={[0, 0.95, -0.22]}>
        <boxGeometry args={[1.35, 0.9, 0.08]} />
        <meshStandardMaterial map={woodMap} color="#6a5844" roughness={0.9} />
      </mesh>
      {/* Jars / pots on shelf */}
      {([-0.45, -0.15, 0.15, 0.42] as const).map((ox, i) => (
        <mesh key={`jar-${i}`} position={[ox, 0.55 + (i % 2) * 0.35, -0.12]}>
          <cylinderGeometry args={[0.09, 0.1, 0.2, 8]} />
          <meshStandardMaterial color={i % 2 === 0 ? "#8a7060" : "#6a7a68"} roughness={0.85} />
        </mesh>
      ))}
      {/* Sacks */}
      <mesh position={[-0.85, 0.22, 0.25]} rotation={[0.1, 0.3, 0]}>
        <boxGeometry args={[0.4, 0.35, 0.35]} />
        <meshStandardMaterial color="#9a8a70" roughness={0.95} />
      </mesh>
      <BandedCrate x={0.85} y={0} z={0.2} w={0.48} h={0.38} d={0.4} woodMap={woodMap} color={crateWood} iron={iron} />
      <BandedCrate x={-1.15} y={0} z={0.35} w={0.42} h={0.32} d={0.36} woodMap={woodMap} color={crateWood} iron={iron} />
      {/* Hanging meat / dried goods */}
      <mesh position={[0.45, 1.25, -0.05]} rotation={[0.15, 0, 0.1]}>
        <capsuleGeometry args={[0.07, 0.22, 4, 6]} />
        <meshStandardMaterial color="#8a5040" roughness={0.9} />
      </mesh>
      <mesh position={[0.55, 1.35, -0.02]}>
        <cylinderGeometry args={[0.01, 0.01, 0.2, 4]} />
        <meshStandardMaterial color="#5a4a38" roughness={0.95} />
      </mesh>
      <mesh position={[-0.05, 1.28, -0.08]} rotation={[-0.1, 0.2, 0]}>
        <capsuleGeometry args={[0.06, 0.18, 4, 6]} />
        <meshStandardMaterial color="#7a4838" roughness={0.92} />
      </mesh>
      {/* Cooking rack */}
      <mesh position={[-0.7, 0.55, 0.35]} rotation={[0, 0.3, 0]}>
        <boxGeometry args={[0.55, 0.04, 0.35]} />
        <meshStandardMaterial color={iron} metalness={0.35} roughness={0.55} />
      </mesh>
      <mesh position={[-0.85, 0.35, 0.35]}>
        <cylinderGeometry args={[0.025, 0.03, 0.4, 5]} />
        <meshStandardMaterial color={iron} metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh position={[-0.55, 0.35, 0.35]}>
        <cylinderGeometry args={[0.025, 0.03, 0.4, 5]} />
        <meshStandardMaterial color={iron} metalness={0.3} roughness={0.6} />
      </mesh>
      {/* Hanging pans */}
      <mesh position={[-0.35, 1.15, -0.1]} rotation={[0.2, 0, 0.15]}>
        <cylinderGeometry args={[0.12, 0.12, 0.05, 8]} />
        <meshStandardMaterial color="#6a6860" metalness={0.45} roughness={0.45} />
      </mesh>
      <mesh position={[0.2, 1.2, -0.08]} rotation={[0.1, 0, -0.2]}>
        <cylinderGeometry args={[0.1, 0.1, 0.04, 8]} />
        <meshStandardMaterial color="#5a5850" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* Secondary cook fire + pot */}
      <group position={[0.9, 0, 0.7]}>
        <mesh position={[0, 0.06, 0]}>
          <cylinderGeometry args={[0.22, 0.26, 0.12, 8]} />
          <meshStandardMaterial color="#3a342c" roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.18, 0]}>
          <sphereGeometry args={[0.1, 6, 6]} />
          <meshStandardMaterial color="#e08040" emissive="#d06020" emissiveIntensity={1.15} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.32, 0]}>
          <cylinderGeometry args={[0.14, 0.12, 0.18, 8]} />
          <meshStandardMaterial color="#4a4840" metalness={0.35} roughness={0.5} />
        </mesh>
        <pointLight position={[0, 0.4, 0]} color="#e09050" intensity={0.35} distance={3} decay={2} castShadow={false} />
      </group>
    </group>
  );
}

function CraftLeanTo({
  x,
  z,
  y,
  yaw,
  cloth,
  clothShade,
  woodMap,
  canvasMap,
  ashWood,
  iron,
}: {
  x: number;
  z: number;
  y: number;
  yaw: number;
  cloth: string;
  clothShade: string;
  woodMap: THREE.Texture;
  canvasMap: THREE.Texture;
  ashWood: string;
  iron: string;
}) {
  return (
    <group position={[x, y, z]} rotation={[0, yaw, 0]}>
      {/* Posts */}
      {(
        [
          [-1.1, 0.85, -0.55],
          [1.1, 0.85, -0.55],
          [-1.1, 0.7, 0.65],
          [1.1, 0.7, 0.65],
        ] as const
      ).map(([px, py, pz], i) => (
        <mesh key={`post-${i}`} position={[px, py, pz]}>
          <cylinderGeometry args={[0.05, 0.06, py * 2, 6]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
      ))}
      {/* Slanted awning canvas */}
      <mesh position={[0, 1.55, 0.05]} rotation={[0.28, 0, 0]}>
        <boxGeometry args={[2.4, 0.07, 1.55]} />
        <meshStandardMaterial map={canvasMap} color={cloth} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 1.48, 0.05]} rotation={[0.28, 0, 0]}>
        <boxGeometry args={[2.35, 0.04, 1.5]} />
        <meshStandardMaterial color={clothShade} roughness={0.92} side={THREE.DoubleSide} />
      </mesh>
      {/* Ridge beam */}
      <mesh position={[0, 1.72, -0.55]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.04, 0.045, 2.35, 6]} />
        <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.88} />
      </mesh>

      {/* Workbench */}
      <mesh position={[0.15, 0.38, 0.15]}>
        <boxGeometry args={[1.35, 0.1, 0.6]} />
        <meshStandardMaterial map={woodMap} color="#7a6850" roughness={0.88} />
      </mesh>
      {(
        [
          [-0.5, 0.18, -0.18],
          [0.5, 0.18, -0.18],
          [-0.5, 0.18, 0.18],
          [0.5, 0.18, 0.18],
        ] as const
      ).map(([lx, ly, lz], i) => (
        <mesh key={`wleg-${i}`} position={[lx + 0.15, ly, lz + 0.15]}>
          <boxGeometry args={[0.1, 0.36, 0.1]} />
          <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.9} />
        </mesh>
      ))}

      {/* Tool board */}
      <mesh position={[-0.15, 1.05, -0.5]}>
        <boxGeometry args={[1.1, 0.85, 0.06]} />
        <meshStandardMaterial map={woodMap} color="#5a4c3c" roughness={0.9} />
      </mesh>
      {([-0.35, -0.1, 0.15, 0.35] as const).map((ox, i) => (
        <mesh key={`tool-${i}`} position={[ox - 0.15, 1.05, -0.44]} rotation={[0, 0, 0.15 * (i - 1.5)]}>
          <boxGeometry args={[0.05, 0.45 + i * 0.05, 0.04]} />
          <meshStandardMaterial color={i % 2 ? "#8a9098" : "#5a4838"} metalness={i % 2 ? 0.4 : 0} roughness={0.5} />
        </mesh>
      ))}

      {/* Anvil on stump */}
      <mesh position={[1.15, 0.22, 0.35]}>
        <cylinderGeometry args={[0.28, 0.32, 0.44, 8]} />
        <meshStandardMaterial map={woodMap} color={ashWood} roughness={0.92} />
      </mesh>
      <mesh position={[1.15, 0.55, 0.35]}>
        <boxGeometry args={[0.45, 0.22, 0.28]} />
        <meshStandardMaterial color={iron} metalness={0.55} roughness={0.4} />
      </mesh>
      <mesh position={[1.15, 0.62, 0.5]}>
        <boxGeometry args={[0.18, 0.12, 0.22]} />
        <meshStandardMaterial color="#5a5854" metalness={0.5} roughness={0.45} />
      </mesh>

      {/* Material barrels + hide/weapon bundle */}
      <mesh position={[0.9, 0.32, -0.35]}>
        <cylinderGeometry args={[0.22, 0.24, 0.55, 10]} />
        <meshStandardMaterial map={woodMap} color="#7a6850" roughness={0.9} />
      </mesh>
      <mesh position={[-0.95, 0.22, -0.25]}>
        <boxGeometry args={[0.42, 0.35, 0.38]} />
        <meshStandardMaterial map={woodMap} color="#6a5848" roughness={0.9} />
      </mesh>
      <mesh position={[-0.95, 0.42, -0.25]}>
        <boxGeometry args={[0.38, 0.08, 0.34]} />
        <meshStandardMaterial color="#8a7060" metalness={0.15} roughness={0.7} />
      </mesh>
      {/* Ore chunks on crate */}
      {([-0.12, 0.05, 0.14] as const).map((ox, i) => (
        <mesh key={`ore-${i}`} position={[-0.95 + ox, 0.52, -0.25 + (i - 1) * 0.08]} rotation={[0.2, i, 0.3]} scale={0.12 + i * 0.02}>
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={i === 1 ? "#c07040" : "#6a6860"} metalness={0.35} roughness={0.55} />
        </mesh>
      ))}
      <mesh position={[-0.55, 0.28, 0.7]} rotation={[0.15, 0.4, 0.1]}>
        <boxGeometry args={[0.35, 0.08, 0.55]} />
        <meshStandardMaterial color="#6a5040" roughness={0.92} />
      </mesh>
      {/* Small secondary forge fire */}
      <group position={[-0.95, 0, 0.55]}>
        <mesh position={[0, 0.08, 0]}>
          <cylinderGeometry args={[0.28, 0.32, 0.16, 8]} />
          <meshStandardMaterial color="#4a4038" roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.22, 0]}>
          <sphereGeometry args={[0.12, 6, 6]} />
          <meshStandardMaterial color="#e08040" emissive="#d06020" emissiveIntensity={1.2} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.38, 0]}>
          <coneGeometry args={[0.08, 0.28, 5]} />
          <meshStandardMaterial color="#ffb060" emissive="#e07028" emissiveIntensity={1.1} transparent opacity={0.65} depthWrite={false} />
        </mesh>
        <pointLight position={[0, 0.45, 0]} color="#e09050" intensity={0.4} distance={3.5} decay={2} castShadow={false} />
      </group>
    </group>
  );
}

/**
 * Solid A-frame scout tent — thick weathered canvas, open flap, lived-in interior.
 */
function makeTentGableGeo(halfW: number, ridgeH: number, thickness: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-halfW, 0.01);
  shape.lineTo(0, ridgeH);
  shape.lineTo(halfW, 0.01);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
}

function TentRoofPanel({
  side,
  halfW,
  ridgeH,
  depth,
  thickness,
  color,
  canvasMap,
}: {
  side: "left" | "right";
  halfW: number;
  ridgeH: number;
  depth: number;
  thickness: number;
  color: string;
  canvasMap?: THREE.Texture;
}) {
  const wallLen = Math.hypot(halfW, ridgeH);
  const len = wallLen + thickness * 0.85;
  const sign = side === "left" ? -1 : 1;
  const ang = Math.atan2(sign * halfW, ridgeH);
  const midX = sign * halfW * 0.48;
  const midY = ridgeH * 0.52;

  return (
    <mesh position={[midX, midY, 0]} rotation={[0, 0, ang]}>
      <boxGeometry args={[thickness, len, depth]} />
      <meshStandardMaterial
        map={canvasMap}
        color={color}
        roughness={0.92}
        metalness={0.02}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function TentGuyLine({
  ax,
  ay,
  az,
  bx,
  by,
  bz,
  color,
}: {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  color: string;
}) {
  const { mid, len, quat } = useMemo(() => {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const dir = b.clone().sub(a);
    const length = dir.length();
    const q = new THREE.Quaternion();
    if (length > 1e-4) {
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    }
    return { mid: a.clone().lerp(b, 0.5), len: length, quat: q };
  }, [ax, ay, az, bx, by, bz]);

  return (
    <mesh position={mid} quaternion={quat}>
      <cylinderGeometry args={[0.022, 0.022, len, 5]} />
      <meshStandardMaterial color={color} roughness={0.95} />
    </mesh>
  );
}

function CampTent({
  x,
  z,
  y,
  yaw,
  cloth,
  clothShade,
  clothDark,
  woodMap,
  canvasMap,
  showInterior = false,
}: {
  x: number;
  z: number;
  y: number;
  yaw: number;
  cloth: string;
  clothShade: string;
  clothDark: string;
  woodMap: THREE.Texture;
  canvasMap?: THREE.Texture;
  showInterior?: boolean;
}) {
  const pole = "#5a4a38";
  const rope = "#6a5e4c";
  const halfW = 1.1;
  const ridgeH = 1.62;
  const depth = 2.05;
  const panelT = 0.1;
  const gableT = 0.11;

  const rearGeo = useMemo(() => makeTentGableGeo(halfW, ridgeH, gableT), [halfW, ridgeH, gableT]);
  const zFront = depth / 2;
  const zBack = -depth / 2;

  return (
    <group position={[x, y, z]} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[halfW * 2.4, depth + 0.4]} />
        <meshStandardMaterial color="#6e5e4c" roughness={0.98} />
      </mesh>

      <TentRoofPanel
        side="left"
        halfW={halfW}
        ridgeH={ridgeH}
        depth={depth}
        thickness={panelT}
        color={cloth}
        canvasMap={canvasMap}
      />
      <TentRoofPanel
        side="right"
        halfW={halfW}
        ridgeH={ridgeH}
        depth={depth}
        thickness={panelT}
        color={clothShade}
        canvasMap={canvasMap}
      />

      <mesh geometry={rearGeo} position={[0, 0, zBack - gableT * 0.5]}>
        <meshStandardMaterial
          map={canvasMap}
          color={clothDark}
          roughness={0.93}
          metalness={0.02}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Fabric wrinkles / eave folds */}
      <mesh position={[-halfW * 0.35, ridgeH * 0.35, 0.2]} rotation={[0, 0, 0.55]}>
        <boxGeometry args={[0.06, ridgeH * 0.5, depth * 0.35]} />
        <meshStandardMaterial color={clothDark} roughness={0.94} />
      </mesh>
      <mesh position={[halfW * 0.4, ridgeH * 0.3, -0.15]} rotation={[0, 0, -0.5]}>
        <boxGeometry args={[0.05, ridgeH * 0.4, depth * 0.3]} />
        <meshStandardMaterial color={clothDark} roughness={0.94} />
      </mesh>

      <mesh position={[0, ridgeH * 0.32, -0.2]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[halfW * 1.05, ridgeH * 0.65, 0.05]} />
        <meshStandardMaterial color="#2a2620" roughness={1} transparent opacity={0.4} />
      </mesh>

      {/* Open flaps */}
      <mesh position={[-halfW * 0.38, ridgeH * 0.45, zFront + 0.05]} rotation={[0.06, 0.4, 0.5]}>
        <boxGeometry args={[panelT, ridgeH * 0.9, 0.48]} />
        <meshStandardMaterial map={canvasMap} color={clothShade} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[halfW * 0.55, ridgeH * 0.4, zFront + 0.08]} rotation={[-0.05, -0.55, -0.35]}>
        <boxGeometry args={[panelT * 0.9, ridgeH * 0.75, 0.38]} />
        <meshStandardMaterial map={canvasMap} color={cloth} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-halfW * 0.7, 0.4, zFront + 0.18]} rotation={[0.25, 0.45, 1.1]}>
        <cylinderGeometry args={[0.1, 0.1, 0.8, 8]} />
        <meshStandardMaterial color={clothDark} roughness={0.88} />
      </mesh>

      <mesh position={[-halfW + 0.02, 0.06, 0]} rotation={[0, 0, 0.1]}>
        <boxGeometry args={[0.1, 0.08, depth * 0.98]} />
        <meshStandardMaterial color={clothDark} roughness={0.95} />
      </mesh>
      <mesh position={[halfW - 0.02, 0.06, 0]} rotation={[0, 0, -0.1]}>
        <boxGeometry args={[0.1, 0.08, depth * 0.98]} />
        <meshStandardMaterial color={clothDark} roughness={0.95} />
      </mesh>

      {showInterior && (
        <group>
          <BedrollProp x={0.15} z={-0.15} y={0} yaw={0.1} cloth="#5a5044" bolster="#7a6c58" />
          <mesh position={[-0.35, 0.18, -0.35]}>
            <boxGeometry args={[0.35, 0.28, 0.3]} />
            <meshStandardMaterial map={woodMap} color="#7a6c55" roughness={0.9} />
          </mesh>
        </group>
      )}

      <mesh position={[0, ridgeH - 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.048, 0.052, depth + 0.2, 7]} />
        <meshStandardMaterial map={woodMap} color={pole} roughness={0.88} />
      </mesh>
      <mesh position={[0, ridgeH - 0.02, zFront + 0.08]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.052, 0.052, 0.1, 6]} />
        <meshStandardMaterial map={woodMap} color={pole} roughness={0.88} />
      </mesh>

      {(
        [
          [-halfW + 0.06, zBack + 0.08],
          [halfW - 0.06, zBack + 0.08],
          [-halfW + 0.06, zFront - 0.08],
          [halfW - 0.06, zFront - 0.08],
        ] as const
      ).map(([px, pz], i) => (
        <mesh key={`stake-${i}`} position={[px, 0.3, pz]}>
          <cylinderGeometry args={[0.038, 0.042, 0.6, 6]} />
          <meshStandardMaterial map={woodMap} color={pole} roughness={0.9} />
        </mesh>
      ))}

      <TentGuyLine ax={-halfW + 0.05} ay={0.14} az={0.2} bx={-halfW - 0.48} by={0.04} bz={0.25} color={rope} />
      <TentGuyLine ax={halfW - 0.05} ay={0.14} az={-0.15} bx={halfW + 0.48} by={0.04} bz={-0.2} color={rope} />
      <mesh position={[-halfW - 0.48, 0.05, 0.25]}>
        <cylinderGeometry args={[0.03, 0.04, 0.1, 5]} />
        <meshStandardMaterial map={woodMap} color={pole} roughness={0.9} />
      </mesh>
      <mesh position={[halfW + 0.48, 0.05, -0.2]}>
        <cylinderGeometry args={[0.03, 0.04, 0.1, 5]} />
        <meshStandardMaterial map={woodMap} color={pole} roughness={0.9} />
      </mesh>
    </group>
  );
}

function BedrollProp({
  x,
  z,
  y,
  yaw,
  cloth,
  bolster,
}: {
  x: number;
  z: number;
  y: number;
  yaw: number;
  cloth: string;
  bolster: string;
}) {
  return (
    <group position={[x, y, z]} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.07, 0]}>
        <boxGeometry args={[0.62, 0.12, 1.25]} />
        <meshStandardMaterial color={cloth} roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.14, -0.42]} rotation={[0.15, 0, 0]}>
        <cylinderGeometry args={[0.14, 0.14, 0.55, 10]} />
        <meshStandardMaterial color={bolster} roughness={0.92} />
      </mesh>
      <mesh position={[0, 0.13, 0.48]}>
        <boxGeometry args={[0.58, 0.06, 0.18]} />
        <meshStandardMaterial color="#5a5044" roughness={0.94} />
      </mesh>
    </group>
  );
}

function BandedCrate({
  x,
  y,
  z,
  w,
  h,
  d,
  woodMap,
  color,
  iron,
}: {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  woodMap: THREE.Texture;
  color: string;
  iron: string;
}) {
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial map={woodMap} color={color} roughness={0.88} />
      </mesh>
      <mesh position={[0, h * 0.35, 0]}>
        <boxGeometry args={[w + 0.02, 0.05, d + 0.02]} />
        <meshStandardMaterial color={iron} metalness={0.4} roughness={0.55} />
      </mesh>
      <mesh position={[0, h * 0.72, 0]}>
        <boxGeometry args={[w + 0.02, 0.05, d + 0.02]} />
        <meshStandardMaterial color={iron} metalness={0.4} roughness={0.55} />
      </mesh>
      <mesh position={[0, h + 0.03, 0]}>
        <boxGeometry args={[w * 0.92, 0.06, d * 0.92]} />
        <meshStandardMaterial map={woodMap} color="#6a5844" roughness={0.9} />
      </mesh>
    </group>
  );
}

/** Party storage — click stub; server logs "Storage — coming soon". */
function StorageChestProp({ woodMap }: { woodMap: THREE.Texture }) {
  const y0 = PH_HUB.floorY;
  const { x, z } = PH_STORAGE_CHEST;
  const bodyW = 1.15;
  const bodyH = 0.72;
  const bodyD = 0.78;
  const iron = "#5a5854";
  const brass = "#c4a868";

  return (
    <group
      position={[x, y0, z]}
      rotation={[0, -0.35, 0]}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: "npc/interact", npcId: PH_STORAGE_CHEST.id });
      }}
    >
      {/* Feet */}
      {(
        [
          [-0.42, 0.06, -0.28],
          [0.42, 0.06, -0.28],
          [-0.42, 0.06, 0.28],
          [0.42, 0.06, 0.28],
        ] as const
      ).map(([fx, fy, fz], i) => (
        <mesh key={`foot-${i}`} position={[fx, fy, fz]}>
          <boxGeometry args={[0.14, 0.12, 0.14]} />
          <meshStandardMaterial color="#4a3c30" roughness={0.9} />
        </mesh>
      ))}
      {/* Body */}
      <mesh position={[0, 0.12 + bodyH / 2, 0]}>
        <boxGeometry args={[bodyW, bodyH, bodyD]} />
        <meshStandardMaterial map={woodMap} color="#7a6248" roughness={0.82} />
      </mesh>
      {/* Lid (slightly larger, arched feel via stacked boxes) */}
      <mesh position={[0, 0.12 + bodyH + 0.1, 0]}>
        <boxGeometry args={[bodyW + 0.06, 0.18, bodyD + 0.06]} />
        <meshStandardMaterial map={woodMap} color="#6a523c" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.12 + bodyH + 0.2, 0]}>
        <boxGeometry args={[bodyW * 0.88, 0.1, bodyD * 0.88]} />
        <meshStandardMaterial map={woodMap} color="#5a4834" roughness={0.78} />
      </mesh>
      {/* Iron bands */}
      <mesh position={[0, 0.12 + bodyH * 0.28, 0]}>
        <boxGeometry args={[bodyW + 0.04, 0.08, bodyD + 0.04]} />
        <meshStandardMaterial color={iron} metalness={0.5} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.12 + bodyH * 0.72, 0]}>
        <boxGeometry args={[bodyW + 0.04, 0.08, bodyD + 0.04]} />
        <meshStandardMaterial color={iron} metalness={0.5} roughness={0.45} />
      </mesh>
      <mesh position={[-bodyW * 0.28, 0.12 + bodyH * 0.5, bodyD / 2 + 0.01]}>
        <boxGeometry args={[0.07, bodyH * 0.85, 0.04]} />
        <meshStandardMaterial color={iron} metalness={0.5} roughness={0.45} />
      </mesh>
      <mesh position={[bodyW * 0.28, 0.12 + bodyH * 0.5, bodyD / 2 + 0.01]}>
        <boxGeometry args={[0.07, bodyH * 0.85, 0.04]} />
        <meshStandardMaterial color={iron} metalness={0.5} roughness={0.45} />
      </mesh>
      {/* Lock plate + hasp */}
      <mesh position={[0, 0.12 + bodyH * 0.55, bodyD / 2 + 0.03]}>
        <boxGeometry args={[0.22, 0.18, 0.06]} />
        <meshStandardMaterial color={brass} metalness={0.55} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.12 + bodyH + 0.02, bodyD / 2 + 0.04]}>
        <boxGeometry args={[0.1, 0.16, 0.05]} />
        <meshStandardMaterial color={brass} metalness={0.55} roughness={0.4} />
      </mesh>
      {/* Lid hinge strip + corner rivets */}
      <mesh position={[0, 0.12 + bodyH + 0.02, -bodyD / 2 - 0.01]}>
        <boxGeometry args={[bodyW * 0.7, 0.06, 0.05]} />
        <meshStandardMaterial color={iron} metalness={0.5} roughness={0.45} />
      </mesh>
      {(
        [
          [-bodyW * 0.42, 0.12 + bodyH * 0.28, bodyD / 2 + 0.04],
          [bodyW * 0.42, 0.12 + bodyH * 0.28, bodyD / 2 + 0.04],
          [-bodyW * 0.42, 0.12 + bodyH * 0.72, bodyD / 2 + 0.04],
          [bodyW * 0.42, 0.12 + bodyH * 0.72, bodyD / 2 + 0.04],
        ] as const
      ).map(([rx, ry, rz], i) => (
        <mesh key={`rivet-${i}`} position={[rx, ry, rz]}>
          <sphereGeometry args={[0.035, 6, 6]} />
          <meshStandardMaterial color={brass} metalness={0.55} roughness={0.4} />
        </mesh>
      ))}
      <Html
        position={[0.15, 1.15, 0.55]}
        center
        distanceFactor={14}
        portal={worldHtmlPortalRef}
        zIndexRange={[8, 1]}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            fontFamily: "Cinzel, Georgia, serif",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.04em",
            color: "#f0e6d2",
            whiteSpace: "nowrap",
            padding: "2px 8px",
            background: "rgba(18, 14, 10, 0.78)",
            border: "1px solid #c4a868",
            boxShadow: "0 0 0 1px rgba(50,40,20,0.85)",
            borderRadius: 2,
            textShadow: "0 1px 2px #000",
          }}
        >
          Storage
        </div>
      </Html>
    </group>
  );
}

/** Outdoor + hub — textured biomes; outdoor undulates; hub pad flat. */
export function PaleHollowTerrain() {
  const farm = useTexture(TEX.farm);
  const clay = useTexture(TEX.clay);
  const scrub = useTexture(TEX.scrub);
  const ashbeam = useTexture(TEX.ashbeam);
  const quarryTexMap = useTexture(TEX.quarry);
  const ore = useTexture(TEX.ore);
  const grass = useTexture(TEX.grass);
  const mountain = useTexture(TEX.mountain);
  const hubWall = useTexture(TEX.hubWall);
  const timber = useTexture(TEX.timber);
  const silo = useTexture(TEX.silo);
  const cliff = useTexture(TEX.cliff);
  const rockPropTex = useTexture(PROP_SPRITES.rock);
  const rockPropTexB = useTexture(PROP_SPRITES.rockB);
  const { camera } = useThree();
  useMemo(() => {
    rockPropTex.colorSpace = THREE.SRGBColorSpace;
    rockPropTex.needsUpdate = true;
    rockPropTexB.colorSpace = THREE.SRGBColorSpace;
    rockPropTexB.needsUpdate = true;
  }, [rockPropTex, rockPropTexB]);

  useMemo(() => {
    for (const t of [farm, clay, scrub, ashbeam, quarryTexMap, ore, grass, mountain, timber])
      prepMap(t, 1);
    prepMap(silo, 2);
    prepMap(cliff, 2);
    prepMap(hubWall, 2);
  }, [farm, clay, scrub, ashbeam, quarryTexMap, ore, grass, mountain, timber, silo, cliff, hubWall]);

  const geo = useMemo(() => buildTerrainGeometry(), []);
  const terrainMat = useMemo(
    () =>
      makeTerrainMaterial({
        farm,
        clay,
        scrub,
        timber,
        ashbeam,
        quarry: quarryTexMap,
        ore,
        grass,
        mountain,
      }),
    [farm, clay, scrub, timber, ashbeam, quarryTexMap, ore, grass, mountain],
  );

  useFrame(() => {
    terrainMat.uniforms.lightDir.value.copy(paleHollowSunDir);
    terrainMat.uniforms.cameraPos.value.copy(camera.position);
  });

  const silos = useMemo(
    () =>
      (
        [
          [-16, 20],
          [-26, -6],
          [-13, 38],
          [36, 40],
          [-44, 36],
        ] as const
      ).map(([x, z]) => {
        const dry = paleHollowPlaceOnDryLand(x, z);
        return [dry.x, dry.z] as const;
      }),
    [],
  );
  const meadowRocks = useMemo(
    () =>
      (
        [
          [48, 48],
          [-56, 52],
          [62, 78],
          [-64, 110],
          [55, 118],
          [-45, 165],
          [46, 188],
          [-20, 60],
          [28, 54],
        ] as const
      )
        .map(([x, z]) => {
          const dry = paleHollowPlaceOnDryLand(x, z);
          return [dry.x, dry.z] as const;
        })
        .filter(([x, z]) => !paleHollowInOpenWater(x, z)),
    [],
  );
  /** Fence posts around dustgrain farm cluster */
  const fencePosts = useMemo(
    () =>
      [
        // west paddock
        ...([-22, -18, -14, -10].flatMap((x) => [
          [x, 16] as const,
          [x, 30] as const,
        ])),
        ...([16, 18, 20, 22, 24, 26, 28, 30].map((z) => [-22, z] as const)),
        ...([16, 18, 20, 22, 24, 26, 28, 30].map((z) => [-10, z] as const)),
        // southwest paddock — east dustgrain run mirrored across the hub
        ...([-32, -28, -24, -20].flatMap((x) => [
          [x, -12] as const,
          [x, 2] as const,
        ])),
        ...([-12, -10, -8, -6, -4, -2, 0, 2].map((z) => [-32, z] as const)),
        ...([-12, -10, -8, -6, -4, -2, 0, 2].map((z) => [-20, z] as const)),
      ],
    [],
  );

  const cliffTex = useMemo(() => {
    const t = cliff.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 1.2);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }, [cliff]);

  const timberTex = useMemo(() => {
    const t = timber.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }, [timber]);

  const siloTex = useMemo(() => {
    const t = silo.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }, [silo]);

  return (
    <group>
      <mesh geometry={geo} material={terrainMat} onClick={onTerrainClick} />
      {/* Clutter + trees stream in — must not suspend the heightfield. */}
      <Suspense fallback={null}>
        <TerrainClutter />
      </Suspense>

      {/* Hub geometry is immediate; optional flame/banner sprites load async inside. */}
      <HubEncampment dirtMap={clay} woodMap={timber} stoneMap={hubWall} />

      {/* Hub open north — soft ridge removed; heightfield carries the silhouette */}

      {PH_MOUNTAINS.filter((m) => m.z > -8).map((m) => {
        const y = paleHollowHeight(m.x, m.z);
        const scale = peakRockScale(m.h);
        return (
          <group key={`peak-${m.x}-${m.z}`} position={[m.x, Math.max(0.2, y - 1.2), m.z]}>
            <mesh position={[0, 2.4 * scale, 0]} renderOrder={0}>
              <coneGeometry args={[5.2 * scale, 7.2 * scale, 5]} />
              <meshStandardMaterial
                map={cliffTex}
                color="#c4b8a0"
                roughness={0.95}
                depthTest
                depthWrite
              />
            </mesh>
            <mesh position={[2.4 * scale, 1.3 * scale, 1.6 * scale]} renderOrder={0}>
              <coneGeometry args={[2.8 * scale, 4.2 * scale, 5]} />
              <meshStandardMaterial
                map={cliffTex}
                color="#b0a890"
                roughness={0.95}
                depthTest
                depthWrite
              />
            </mesh>
          </group>
        );
      })}

      {/* Dustgrain silos */}
      {silos.map(([x, z]) => {
        const y = paleHollowHeight(x, z);
        return (
          <group key={`${x}-${z}`} position={[x, y, z]}>
            <mesh position={[0, 1.15, 0]}>
              <cylinderGeometry args={[0.75, 0.9, 2.3, 12]} />
              <meshStandardMaterial map={siloTex} roughness={0.88} />
            </mesh>
            <mesh position={[0, 2.45, 0]}>
              <coneGeometry args={[1.0, 0.6, 8]} />
              <meshStandardMaterial map={siloTex} color="#c4b090" roughness={0.9} />
            </mesh>
          </group>
        );
      })}

      {/* Farm fence lines — paddocks around silos (skip open water) */}
      {fencePosts
        .filter(([x, z]) => !paleHollowInOpenWater(x, z) && paleHollowBiome(x, z) !== "riverbank")
        .map(([x, z], i) => {
        const y = paleHollowHeight(x, z);
        return (
          <mesh key={`fence-${i}-${x}-${z}`} position={[x, y + 0.55, z]}>
            <boxGeometry args={[0.12, 1.1, 0.12]} />
            <meshStandardMaterial map={timberTex} color="#6a5844" roughness={0.9} />
          </mesh>
        );
      })}
      {/* Rail segments */}
      {(
        [
          [-22, 16, -10, 16],
          [-22, 30, -10, 30],
          [-22, 16, -22, 30],
          [-10, 16, -10, 30],
          [-32, -12, -20, -12],
          [-32, 2, -20, 2],
          [-32, -12, -32, 2],
          [-20, -12, -20, 2],
        ] as const
      )
        .filter(([x0, z0, x1, z1]) => {
          const mx = (x0 + x1) / 2;
          const mz = (z0 + z1) / 2;
          return !paleHollowInOpenWater(mx, mz) && paleHollowBiome(mx, mz) !== "riverbank";
        })
        .map(([x0, z0, x1, z1], i) => {
        const mx = (x0 + x1) / 2;
        const mz = (z0 + z1) / 2;
        const y = paleHollowHeight(mx, mz) + 0.75;
        const len = Math.hypot(x1 - x0, z1 - z0);
        const yaw = Math.atan2(x1 - x0, z1 - z0);
        return (
          <mesh key={`rail-${i}`} position={[mx, y, mz]} rotation={[0, yaw, 0]}>
            <boxGeometry args={[0.08, 0.1, len]} />
            <meshStandardMaterial map={timberTex} color="#7a6850" roughness={0.88} />
          </mesh>
        );
      })}

      {/* Raised dirt path overlays removed — they read as wood seams / thin borders */}

      {/* Copper / meadow rock sprites — dry land only */}
      {(
        [
          [18, 26, 1.4],
          [19.2, 25.2, 0.75],
          ...meadowRocks.map(([x, z]) => [x, z, 0.95 + (Math.abs(x * z) % 7) * 0.06] as const),
        ] as const
      )
        .map(([x, z, s]) => {
          const dry = paleHollowPlaceOnDryLand(x, z);
          return [dry.x, dry.z, s] as const;
        })
        .filter(([x, z]) => !paleHollowInOpenWater(x, z))
        .map(([x, z, s], i) => {
        const y = paleHollowHeight(x, z);
        const h = hash2(Math.floor(x * 9), Math.floor(z * 11) + i);
        const flip = h > 0.5;
        const sx = s * (0.85 + h * 0.4);
        const sy = s * 0.85 * (0.9 + (1 - h) * 0.35);
        const useB = hash2(i * 17, Math.floor(x + z)) > 0.5;
        return (
          <Billboard key={`rock-spr-${i}`} follow position={[x, y + sy * 0.42, z]}>
            <mesh renderOrder={CLUTTER_RENDER_ORDER} scale={[flip ? -sx : sx, sy, 1]}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial
                map={useB ? rockPropTexB : rockPropTex}
                transparent
                alphaTest={0.12}
                depthWrite={false}
                toneMapped
                side={THREE.DoubleSide}
              />
            </mesh>
          </Billboard>
        );
      })}

      {/* Stone bridges + bank walls live in PaleHollowRiverBanks */}

      {/* Ashbeam grove trees are sprite saplings inside TerrainClutter */}
      {(() => {
        const p = paleHollowPlaceOnDryLand(0, 92);
        return (
          <mesh position={[p.x, paleHollowHeight(p.x, p.z) + 0.35, p.z]}>
            <cylinderGeometry args={[1.1, 1.3, 0.7, 10]} />
            <meshStandardMaterial map={timberTex} roughness={0.9} />
          </mesh>
        );
      })()}

      <mesh position={[0, paleHollowHeight(0, 114) + 0.2, 114]}>
        <boxGeometry args={[8, 0.45, 7]} />
        <meshStandardMaterial map={cliffTex} color="#b0a890" roughness={0.9} />
      </mesh>
      <mesh position={[0, paleHollowHeight(0, 114) + 3.2, 114]}>
        <boxGeometry args={[0.35, 5.5, 0.35]} />
        <meshStandardMaterial map={timberTex} roughness={0.85} />
      </mesh>

      {(() => {
        // Quarry timber — keep on dry quarry floor, not in the chalk run
        const p = paleHollowPlaceOnDryLand(-8, 137);
        return (
          <mesh position={[p.x, paleHollowHeight(p.x, p.z) + 2.5, p.z]} rotation={[0, 0.4, 0.35]}>
            <boxGeometry args={[0.35, 6, 0.35]} />
            <meshStandardMaterial map={timberTex} color="#5a5040" roughness={0.9} />
          </mesh>
        );
      })()}

      <mesh position={[0, paleHollowHeight(0, 177) + 1.6, 177]}>
        <boxGeometry args={[7, 3.4, 4]} />
        <meshStandardMaterial map={cliffTex} color="#6a6558" roughness={0.95} />
      </mesh>
      <mesh position={[0, paleHollowHeight(0, 177) + 1.4, 177]}>
        <boxGeometry args={[3.2, 2.6, 4.2]} />
        <meshStandardMaterial color="#1a1814" roughness={1} />
      </mesh>

      {(() => {
        const p = paleHollowPlaceOnDryLand(-12, 210);
        return (
          <>
            <mesh position={[p.x, paleHollowHeight(p.x, p.z) + 2.2, p.z]}>
              <boxGeometry args={[8, 4.5, 1.2]} />
              <meshStandardMaterial map={cliffTex} color="#8a8898" roughness={0.92} />
            </mesh>
            <mesh position={[p.x, paleHollowHeight(p.x, p.z) + 1.5, p.z]}>
              <boxGeometry args={[3.5, 3, 1.4]} />
              <meshStandardMaterial color="#121018" roughness={1} />
            </mesh>
          </>
        );
      })()}

      <mesh position={[0, paleHollowHeight(0, 236) + 1.2, 236]}>
        <coneGeometry args={[1.4, 2.4, 5]} />
        <meshStandardMaterial map={cliffTex} color="#7a7060" roughness={0.92} />
      </mesh>
      <mesh position={[0, paleHollowHeight(0, 244) + 1.5, 244]}>
        <boxGeometry args={[9, 3.2, 1]} />
        <meshStandardMaterial map={cliffTex} color="#4a4030" roughness={0.95} />
      </mesh>
    </group>
  );
}

export function GatherNodeMarkers() {
  const focus = useStreamFocus();
  // Id list only — avoid remounting sprites every 20Hz snapshot.
  const nodeKey = useGame((s) => {
    const units = s.snapshot?.units;
    if (!units) return "";
    const unloadR2 = focus.unloadR * focus.unloadR;
    return units
      .filter(
        (u) =>
          u.gatherNode &&
          distSqXZ(u.x, u.z, focus.x, focus.z) <= unloadR2,
      )
      .map((u) => u.id)
      .join("\0");
  });
  const nodeIds = useMemo(() => (nodeKey ? nodeKey.split("\0") : []), [nodeKey]);
  const glowTex = useMemo(() => makeGatherGlowTexture(), []);
  const sparkTex = useMemo(() => makeGatherSparkTexture(), []);

  return (
    <>
      {nodeIds.map((id) => (
        <GatherNodeSpriteById key={id} unitId={id} glowTex={glowTex} sparkTex={sparkTex} />
      ))}
    </>
  );
}

function GatherNodeSpriteById({
  unitId,
  glowTex,
  sparkTex,
}: {
  unitId: string;
  glowTex: THREE.Texture;
  sparkTex: THREE.Texture;
}) {
  const sig = useGame((s) => {
    const u = s.snapshot?.units.find((x) => x.id === unitId);
    if (!u) return "";
    return `${u.hp}|${u.gatherYield ?? ""}|${u.x.toFixed(1)}|${u.z.toFixed(1)}`;
  });
  const unit = useMemo(() => {
    void sig;
    return useGame.getState().snapshot?.units.find((x) => x.id === unitId);
  }, [sig, unitId]);
  if (!unit?.gatherNode) return null;
  return <GatherNodeSprite unit={unit} glowTex={glowTex} sparkTex={sparkTex} />;
}

const GATHER_SPARK_SLOTS = [
  { ox: -0.22, oy: 0.18, phase: 0.0, speed: 2.6 },
  { ox: 0.26, oy: 0.42, phase: 1.7, speed: 3.2 },
] as const;

function GatherNodeSprite({
  unit,
  glowTex,
  sparkTex,
}: {
  unit: { id: string; x: number; y: number; z: number; hp: number; name: string; gatherYield?: string };
  glowTex: THREE.Texture;
  sparkTex: THREE.Texture;
}) {
  const iconUrl = useMemo(() => `${gatherIconUrl(unit.gatherYield)}?art=3`, [unit.gatherYield]);
  const iconTex = useGatherItemTexture(iconUrl);
  const glowRef = useRef<THREE.Mesh>(null);
  const iconMat = useRef<THREE.MeshBasicMaterial>(null);
  const glowMat = useRef<THREE.MeshBasicMaterial>(null);
  const sparkMats = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const ready = unit.hp > 0;
  const groundY = unit.y + GATHER_GROUND_Y;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const phase = t * 1.6 + unit.x * 0.27 + unit.z * 0.19;
    if (iconMat.current) {
      const shimmer = ready ? 0.92 + 0.08 * (0.5 + 0.5 * Math.sin(phase * 1.8)) : 0.4;
      iconMat.current.opacity = shimmer;
      iconMat.current.color.set(ready ? "#ffffff" : "#6a6558");
    }
    if (glowRef.current && glowMat.current) {
      glowMat.current.visible = ready;
      glowMat.current.opacity = ready ? 0.16 + 0.14 * (0.5 + 0.5 * Math.sin(phase * 1.25)) : 0;
      const s = 0.95 + 0.08 * (0.5 + 0.5 * Math.sin(phase));
      glowRef.current.scale.set(s, s * 0.7, 1);
    }
    for (let i = 0; i < GATHER_SPARK_SLOTS.length; i++) {
      const slot = GATHER_SPARK_SLOTS[i]!;
      const mat = sparkMats.current[i];
      if (!mat) continue;
      if (!ready) {
        mat.opacity = 0;
        continue;
      }
      const twinkle = 0.5 + 0.5 * Math.sin(t * slot.speed + slot.phase + unit.x);
      mat.opacity = Math.max(0, twinkle * twinkle * twinkle) * 0.9;
    }
  });

  if (!iconTex) {
    return (
      <Billboard follow position={[unit.x, groundY, unit.z]}>
        <mesh renderOrder={9} position={[0, -GATHER_GROUND_Y + 0.05, 0]}>
          <planeGeometry args={[0.7, 0.35]} />
          <meshBasicMaterial
            map={glowTex}
            transparent
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            opacity={ready ? 0.28 : 0.08}
          />
        </mesh>
      </Billboard>
    );
  }

  return (
    <Billboard follow position={[unit.x, groundY, unit.z]}>
      <mesh ref={glowRef} position={[0, -GATHER_GROUND_Y + 0.04, -0.03]} renderOrder={9}>
        <planeGeometry args={[1.15, 0.42]} />
        <meshBasicMaterial
          ref={glowMat}
          map={glowTex}
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          opacity={0.28}
          visible={ready}
        />
      </mesh>
      <mesh
        renderOrder={10}
        onClick={(e) => {
          e.stopPropagation();
          send({ type: "gather", nodeId: unit.id });
        }}
      >
        <planeGeometry args={[GATHER_ICON_SIZE, GATHER_ICON_SIZE]} />
        <meshBasicMaterial
          ref={iconMat}
          map={iconTex}
          color="#ffffff"
          transparent
          alphaTest={0.04}
          depthWrite={false}
          toneMapped={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {GATHER_SPARK_SLOTS.map((slot, i) => (
        <mesh
          key={i}
          position={[slot.ox, slot.oy - GATHER_GROUND_Y + 0.08, 0.02]}
          renderOrder={11}
        >
          <planeGeometry args={[0.16, 0.16]} />
          <meshBasicMaterial
            ref={(m) => {
              sparkMats.current[i] = m;
            }}
            map={sparkTex}
            transparent
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            opacity={0}
          />
        </mesh>
      ))}
    </Billboard>
  );
}
