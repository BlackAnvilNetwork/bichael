/**
 * Master skill tree — shared web across all jobs.
 * 600 nodes: ~85 per job district (heart + core ring + pods + travel) + corridor gems.
 * Layout: spaced job islands with geometric pods and thin corridors between them.
 * Spend 1 point/level (75 at max) + up to 100 more from post-max EXP = 175 max spent.
 */
import { JOB_IDS, type JobId } from "./jobs";

/** Keep in sync with MAX_LEVEL in index.ts */
const TREE_MAX_LEVEL = 75;

export const SKILL_TREE_NODE_COUNT = 600;
export const SKILL_POINTS_PER_LEVEL = 1;
/** Extra points from post-max EXP (skill echoes). */
export const SKILL_PRESTIGE_CAP = 100;
export const SKILL_POINTS_CAP =
  TREE_MAX_LEVEL * SKILL_POINTS_PER_LEVEL + SKILL_PRESTIGE_CAP; // 175
/** One-time free attribute points every character may assign. */
export const FREE_STAT_POINTS = 5;

export type AttrKey = "str" | "dex" | "vit" | "agi" | "int" | "mnd";

export type SkillNodeBonus = {
  str?: number;
  dex?: number;
  vit?: number;
  agi?: number;
  int?: number;
  mnd?: number;
  maxHp?: number;
  maxMp?: number;
  /** Extra HP restored per Rest tick. */
  restHp?: number;
  /** Extra MP restored per Rest tick. */
  restMp?: number;
  /** Flat melee/magic attack add. */
  atk?: number;
  /** Hit chance bonus (percentage points). */
  acc?: number;
  /** Permanent haste fraction (e.g. 0.01 = +1%). */
  hastePct?: number;
  /** Crit chance add (fraction). */
  crit?: number;
  /** Physical DT reduction (e.g. 0.01 = −1% damage taken). */
  physDt?: number;
  /** Magic DT reduction. */
  magDt?: number;
  /** Move speed bonus fraction. */
  movePct?: number;
};

export type SkillNodeRarity = "common" | "uncommon" | "rare" | "gem";

export type SkillNode = {
  id: string;
  /** Owning job cluster (flavor + starting region). */
  job: JobId;
  label: string;
  blurb: string;
  rarity: SkillNodeRarity;
  /** Layout position in tree space. */
  x: number;
  y: number;
  /** Hub for this job — auto-unlocked for matching main. */
  hub?: boolean;
  bonus: SkillNodeBonus;
  /** Neighbor node ids (undirected; stored both ways). */
  edges: string[];
};

export type AggregatedSkillBonuses = Required<{
  [K in keyof SkillNodeBonus]-?: number;
}>;

const ATTRS: AttrKey[] = ["str", "dex", "vit", "agi", "int", "mnd"];

/** Primary attrs each job cluster emphasizes. */
const JOB_FOCUS: Record<JobId, AttrKey[]> = {
  time_mage: ["mnd", "int", "agi"],
  knight: ["vit", "str", "mnd"],
  rogue: ["dex", "agi", "str"],
  cleric: ["mnd", "vit", "int"],
  sorcerer: ["int", "mnd", "agi"],
  fighter: ["str", "vit", "dex"],
  battle_mage: ["int", "str", "mnd"],
};

const JOB_LABEL: Record<JobId, string> = {
  time_mage: "Chrona",
  knight: "Bulwark",
  rogue: "Shade",
  cleric: "Mercy",
  sorcerer: "Neve",
  fighter: "Storm",
  battle_mage: "Rune",
};

function emptyAgg(): AggregatedSkillBonuses {
  return {
    str: 0,
    dex: 0,
    vit: 0,
    agi: 0,
    int: 0,
    mnd: 0,
    maxHp: 0,
    maxMp: 0,
    restHp: 0,
    restMp: 0,
    atk: 0,
    acc: 0,
    hastePct: 0,
    crit: 0,
    physDt: 0,
    magDt: 0,
    movePct: 0,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickRarity(i: number, hub: boolean): SkillNodeRarity {
  if (hub) return "uncommon";
  const r = i % 20;
  if (r === 0) return "gem";
  if (r <= 3) return "rare";
  if (r <= 8) return "uncommon";
  return "common";
}

function bonusFor(
  job: JobId,
  index: number,
  rarity: SkillNodeRarity,
  hub: boolean,
): { bonus: SkillNodeBonus; label: string; blurb: string } {
  const focus = JOB_FOCUS[job];
  const tag = JOB_LABEL[job];
  const h = hash(`${job}:${index}:${rarity}`);

  if (hub) {
    return {
      label: `${tag} Heart`,
      blurb: `Home of the ${job.replace("_", " ")} path. Connecting here opens every linked skill.`,
      bonus: { [focus[0]!]: 1, maxHp: 5 },
    };
  }

  if (rarity === "gem") {
    const gems: { label: string; blurb: string; bonus: SkillNodeBonus }[] = [
      { label: `${tag} Quicken`, blurb: "A rare chrona spark — permanent haste.", bonus: { hastePct: 0.012 } },
      { label: `${tag} Eye`, blurb: "Steady aim — accuracy gem.", bonus: { acc: 3 } },
      { label: `${tag} Edge`, blurb: "Sharpened strikes — attack gem.", bonus: { atk: 4 } },
      { label: `${tag} Vein`, blurb: "Crit spark nestled in the web.", bonus: { crit: 0.015 } },
      { label: `${tag} Stride`, blurb: "Fleet footing across the hall.", bonus: { movePct: 0.02 } },
      { label: `${tag} Plate`, blurb: "Shrug a fraction of steel.", bonus: { physDt: 0.012 } },
      { label: `${tag} Veil`, blurb: "Shrug a fraction of magic.", bonus: { magDt: 0.012 } },
    ];
    return gems[h % gems.length]!;
  }

  if (rarity === "rare") {
    const kind = h % 6;
    if (kind === 0) {
      return {
        label: `${tag} Vitality`,
        blurb: "Deep reserves of life.",
        bonus: { maxHp: 18 + (h % 8), vit: 1 },
      };
    }
    if (kind === 1) {
      return {
        label: `${tag} Well`,
        blurb: "Aether pool expands.",
        bonus: { maxMp: 14 + (h % 8), [focus[1] ?? "int"]: 1 },
      };
    }
    if (kind === 2) {
      return {
        label: `${tag} Repose`,
        blurb: "Rest restores more.",
        bonus: { restHp: 2 + (h % 3), restMp: 1 + (h % 2) },
      };
    }
    if (kind === 3) {
      return {
        label: `${tag} Might`,
        blurb: "Harder hits.",
        bonus: { atk: 2 + (h % 3), [focus[0]!]: 1 },
      };
    }
    if (kind === 4) {
      return {
        label: `${tag} Focus`,
        blurb: "Keener accuracy.",
        bonus: { acc: 2, dex: 1 },
      };
    }
    return {
      label: `${tag} Temper`,
      blurb: "Slight haste tempering.",
      bonus: { hastePct: 0.005, agi: 1 },
    };
  }

  // common / uncommon — mostly mundane
  const attr = focus[index % focus.length]!;
  const amt = rarity === "uncommon" ? 2 : 1;
  const roll = h % 5;
  if (roll === 0) {
    return {
      label: `${tag} ${attr.toUpperCase()}`,
      blurb: `+${amt} ${attr.toUpperCase()}.`,
      bonus: { [attr]: amt },
    };
  }
  if (roll === 1) {
    const hp = rarity === "uncommon" ? 10 : 6;
    return { label: `${tag} Flesh`, blurb: `+${hp} Max HP.`, bonus: { maxHp: hp } };
  }
  if (roll === 2) {
    const mp = rarity === "uncommon" ? 8 : 5;
    return { label: `${tag} Breath`, blurb: `+${mp} Max MP.`, bonus: { maxMp: mp } };
  }
  if (roll === 3) {
    return {
      label: `${tag} Ease`,
      blurb: "Slightly better Rest.",
      bonus: { restHp: 1, restMp: 1 },
    };
  }
  return {
    label: `${tag} ${attr.toUpperCase()}+`,
    blurb: `+${amt} ${attr.toUpperCase()}, minor fortitude.`,
    bonus: { [attr]: amt, maxHp: rarity === "uncommon" ? 4 : 2 },
  };
}

/**
 * Layout: PoE-style districts — geometric pods around a job heart, with
 * sparse travel corridors between districts. Positions only; rarity/bonus
 * generation stays index-driven so unlocks/gameplay stay stable.
 *
 * Per job (85): 1 hub + 10 core ring + 6 pods×11 + 8 corridor travel nodes.
 */
function buildTree(): { nodes: Record<string, SkillNode>; hubs: Record<JobId, string> } {
  const nodes: Record<string, SkillNode> = {};
  const hubs: Record<JobId, string> = {} as Record<JobId, string>;
  const perJob = Math.floor(SKILL_TREE_NODE_COUNT / JOB_IDS.length); // 85
  const remainder = SKILL_TREE_NODE_COUNT - perJob * JOB_IDS.length; // 5

  const CORE_COUNT = 10;
  const POD_COUNT = 6;
  const POD_SIZE = 11; // 1 notable + 10 minors
  const TRAVEL_COUNT = 8; // corridor approaches toward neighbors
  // 1 + 10 + 66 + 8 = 85

  const hubPos: Record<JobId, { x: number; y: number }> = {} as Record<
    JobId,
    { x: number; y: number }
  >;
  // Wide ring — significant empty space between job islands
  const R = 1720;
  JOB_IDS.forEach((job, i) => {
    const a = (i / JOB_IDS.length) * Math.PI * 2 - Math.PI / 2;
    hubPos[job] = { x: Math.cos(a) * R, y: Math.sin(a) * R };
  });

  const clusterIds: Record<JobId, string[]> = {} as Record<JobId, string[]>;
  /** Outermost travel node ids facing each adjacent neighbor (for corridor links). */
  const travelOut: Record<JobId, { prev: string[]; next: string[] }> = {} as Record<
    JobId,
    { prev: string[]; next: string[] }
  >;

  for (const job of JOB_IDS) {
    clusterIds[job] = [];
    travelOut[job] = { prev: [], next: [] };
    const origin = hubPos[job]!;
    const jobIndex = JOB_IDS.indexOf(job);
    const districtAng = (jobIndex / JOB_IDS.length) * Math.PI * 2 - Math.PI / 2;

    for (let i = 0; i < perJob; i++) {
      const id = `${job}_${i}`;
      const isHub = i === 0;
      const rarity = pickRarity(i, isHub);
      const { bonus, label, blurb } = bonusFor(job, i, rarity, isHub);

      let lx = 0;
      let ly = 0;

      if (isHub) {
        lx = 0;
        ly = 0;
      } else if (i <= CORE_COUNT) {
        // Inner core ring — breathing room around the heart
        const slot = i - 1;
        const rad = 128;
        const ang = (slot / CORE_COUNT) * Math.PI * 2 + districtAng * 0.15;
        lx = Math.cos(ang) * rad;
        ly = Math.sin(ang) * rad;
      } else if (i < 1 + CORE_COUNT + POD_COUNT * POD_SIZE) {
        // Satellite pods: ring/constellation islands around the hub
        const local = i - 1 - CORE_COUNT;
        const pod = Math.floor(local / POD_SIZE);
        const slot = local % POD_SIZE;
        const podAng = districtAng + (pod / POD_COUNT) * Math.PI * 2 + Math.PI / POD_COUNT;
        const podOrbit = 325;
        const px = Math.cos(podAng) * podOrbit;
        const py = Math.sin(podAng) * podOrbit;
        if (slot === 0) {
          // Notable sits at pod center
          lx = px;
          ly = py;
        } else {
          const orbit = 64;
          const oAng = podAng + ((slot - 1) / (POD_SIZE - 1)) * Math.PI * 2;
          const jitter = ((hash(id) % 7) - 3) * 1.1;
          lx = px + Math.cos(oAng) * orbit + jitter;
          ly = py + Math.sin(oAng) * (orbit * 0.92) + jitter * 0.5;
        }
      } else {
        // Travel nodes along corridors toward adjacent districts
        const t = i - (1 + CORE_COUNT + POD_COUNT * POD_SIZE);
        const towardPrev = t < TRAVEL_COUNT / 2;
        const step = towardPrev ? t : t - TRAVEL_COUNT / 2;
        const steps = TRAVEL_COUNT / 2; // 4
        const neighborOffset = towardPrev ? -1 : 1;
        const nJob = JOB_IDS[(jobIndex + neighborOffset + JOB_IDS.length) % JOB_IDS.length]!;
        const target = hubPos[nJob]!;
        const dx = target.x - origin.x;
        const dy = target.y - origin.y;
        const len = Math.hypot(dx, dy) || 1;
        // Sit between district rim (~420) and mid-corridor (~0.42 of hub distance)
        const t0 = 420 / len;
        const t1 = 0.42;
        const u = t0 + ((step + 0.5) / steps) * (t1 - t0);
        const side = ((hash(id) % 5) - 2) * 14;
        const nx = -dy / len;
        const ny = dx / len;
        lx = dx * u + nx * side;
        ly = dy * u + ny * side;
        if (towardPrev) travelOut[job]!.prev.push(id);
        else travelOut[job]!.next.push(id);
      }

      const node: SkillNode = {
        id,
        job,
        label,
        blurb,
        rarity,
        hub: isHub,
        x: origin.x + lx,
        y: origin.y + ly,
        bonus,
        edges: [],
      };
      nodes[id] = node;
      clusterIds[job]!.push(id);
      if (isHub) hubs[job] = id;
    }
  }

  // Remainder: bridge gems sit mid-corridor BETWEEN districts
  for (let i = 0; i < remainder; i++) {
    const id = `nexus_${i}`;
    const jobA = JOB_IDS[i % JOB_IDS.length]!;
    const jobB = JOB_IDS[(i + 1) % JOB_IDS.length]!;
    const a = hubPos[jobA]!;
    const b = hubPos[jobB]!;
    nodes[id] = {
      id,
      job: jobA,
      label: `Pass ${JOB_LABEL[jobA]}–${JOB_LABEL[jobB]}`,
      blurb: `Corridor between ${JOB_LABEL[jobA]} and ${JOB_LABEL[jobB]} districts.`,
      rarity: "gem",
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5,
      bonus: { atk: 2, acc: 1, hastePct: 0.004, maxHp: 8 },
      edges: [],
    };
  }

  function link(a: string, b: string) {
    const na = nodes[a];
    const nb = nodes[b];
    if (!na || !nb) return;
    if (!na.edges.includes(b)) na.edges.push(b);
    if (!nb.edges.includes(a)) nb.edges.push(a);
  }

  // Intra-district: hub ↔ core; core ring; pods as constellations; travel spokes
  for (const job of JOB_IDS) {
    const ids = clusterIds[job]!;
    const hubId = ids[0]!;

    // Core ring around heart
    for (let s = 0; s < CORE_COUNT; s++) {
      const id = ids[1 + s]!;
      link(hubId, id);
      link(id, ids[1 + ((s + 1) % CORE_COUNT)]!);
    }

    // Pods: notable at center, orbit ring, spoke from nearest core node
    for (let p = 0; p < POD_COUNT; p++) {
      const base = 1 + CORE_COUNT + p * POD_SIZE;
      const notable = ids[base]!;
      const coreSpoke = ids[1 + (p % CORE_COUNT)]!;
      link(coreSpoke, notable);
      // Also bridge from a second nearby core for non-linear pathing
      link(ids[1 + ((p + 1) % CORE_COUNT)]!, notable);

      for (let s = 1; s < POD_SIZE; s++) {
        const id = ids[base + s]!;
        link(notable, id);
        const next = base + 1 + (s % (POD_SIZE - 1));
        if (next < base + POD_SIZE) link(id, ids[next]!);
      }
      // Light chord inside pod for alternate routes
      if (POD_SIZE > 5) {
        link(ids[base + 2]!, ids[base + 6]!);
      }
    }

    // Travel corridor nodes: chain from the pod facing each neighbor
    const travelStart = 1 + CORE_COUNT + POD_COUNT * POD_SIZE;
    const origin = hubPos[job]!;
    const jobIndex = JOB_IDS.indexOf(job);
    for (let t = 0; t < TRAVEL_COUNT; t++) {
      const id = ids[travelStart + t]!;
      const towardPrev = t < TRAVEL_COUNT / 2;
      const step = towardPrev ? t : t - TRAVEL_COUNT / 2;
      const nJob =
        JOB_IDS[(jobIndex + (towardPrev ? -1 : 1) + JOB_IDS.length) % JOB_IDS.length]!;
      const angTo = Math.atan2(hubPos[nJob]!.y - origin.y, hubPos[nJob]!.x - origin.x);
      let facingPod = 0;
      let best = Infinity;
      for (let p = 0; p < POD_COUNT; p++) {
        const notable = nodes[ids[1 + CORE_COUNT + p * POD_SIZE]!]!;
        const pang = Math.atan2(notable.y - origin.y, notable.x - origin.x);
        let d = Math.abs(pang - angTo);
        if (d > Math.PI) d = Math.PI * 2 - d;
        if (d < best) {
          best = d;
          facingPod = p;
        }
      }
      const podNotable = ids[1 + CORE_COUNT + facingPod * POD_SIZE]!;
      const podOuter = ids[1 + CORE_COUNT + facingPod * POD_SIZE + Math.min(5, POD_SIZE - 1)]!;
      if (step === 0) {
        link(podNotable, id);
        link(podOuter, id);
      } else {
        const prevTravel = ids[travelStart + (towardPrev ? step - 1 : TRAVEL_COUNT / 2 + step - 1)]!;
        link(prevTravel, id);
      }
    }
  }

  // Adjacent district bridges via travel tips + nexus (readable corridors)
  for (let i = 0; i < JOB_IDS.length; i++) {
    const a = JOB_IDS[i]!;
    const b = JOB_IDS[(i + 1) % JOB_IDS.length]!;
    const nextA = travelOut[a]!.next;
    const prevB = travelOut[b]!.prev;
    // Connect outermost travel nodes across the gap (thin corridor edges)
    if (nextA[nextA.length - 1] && prevB[prevB.length - 1]) {
      link(nextA[nextA.length - 1]!, prevB[prevB.length - 1]!);
    }
    if (nextA[Math.max(0, nextA.length - 2)] && prevB[Math.max(0, prevB.length - 2)]) {
      link(nextA[Math.max(0, nextA.length - 2)]!, prevB[Math.max(0, prevB.length - 2)]!);
    }
  }

  // Long-range bridges: sparse tip links (avoid spaghetti across the map)
  const longPairs: [JobId, JobId][] = [
    ["fighter", "rogue"],
    ["fighter", "knight"],
    ["rogue", "time_mage"],
    ["cleric", "knight"],
    ["cleric", "time_mage"],
    ["sorcerer", "battle_mage"],
    ["battle_mage", "fighter"],
    ["sorcerer", "time_mage"],
  ];
  for (const [a, b] of longPairs) {
    const ca = clusterIds[a]!;
    const cb = clusterIds[b]!;
    link(ca[ca.length - 1]!, cb[cb.length - 1]!);
  }

  // Nexus gems stitch corridor tips — not direct hub-to-hub lines
  for (let i = 0; i < remainder; i++) {
    const id = `nexus_${i}`;
    const jobA = JOB_IDS[i % JOB_IDS.length]!;
    const jobB = JOB_IDS[(i + 1) % JOB_IDS.length]!;
    const nextA = travelOut[jobA]!.next;
    const prevB = travelOut[jobB]!.prev;
    for (const tip of nextA.slice(-2)) link(id, tip);
    for (const tip of prevB.slice(-2)) link(id, tip);
  }

  return { nodes, hubs };
}

const BUILT = buildTree();

export const SKILL_NODES: Record<string, SkillNode> = BUILT.nodes;
export const SKILL_HUBS: Record<JobId, string> = BUILT.hubs;

export function isSkillNodeId(id: string): boolean {
  return id in SKILL_NODES;
}

export function skillHubForJob(job: JobId): string {
  return SKILL_HUBS[job];
}

/** Points available from level + prestige (lifetime earned, capped). */
export function skillPointsEarned(level: number, prestige: number): number {
  const fromLevel = Math.min(TREE_MAX_LEVEL, Math.max(0, level)) * SKILL_POINTS_PER_LEVEL;
  const fromPrestige = Math.min(SKILL_PRESTIGE_CAP, Math.max(0, prestige));
  return Math.min(SKILL_POINTS_CAP, fromLevel + fromPrestige);
}

/** Unspent points granted when rising from `fromLevel` → `toLevel` (hubs free; bank these). */
export function skillPointsGrantedForLevels(fromLevel: number, toLevel: number): number {
  const a = Math.min(TREE_MAX_LEVEL, Math.max(0, Math.floor(fromLevel)));
  const b = Math.min(TREE_MAX_LEVEL, Math.max(0, Math.floor(toLevel)));
  return Math.max(0, b - a) * SKILL_POINTS_PER_LEVEL;
}

/** @deprecated Use skillPointsSpentOnTree — same cost table. */
export function skillPointsSpent(unlocked: readonly string[]): number {
  return skillPointsSpentOnTree(unlocked);
}

/** Points a normal (non-heart) node costs. */
export const SKILL_NODE_COST = 1;

/**
 * The one skill-tree cost table (#75). Server unlocks, the bank, respec,
 * log hydration, and the UI all read node prices from here.
 * Hearts (job hubs) are always free: the main and support hearts are granted,
 * and any other heart opens once you own a linked skill. Every other node
 * costs SKILL_NODE_COST. Unknown ids cost nothing.
 */
export function skillNodeCost(nodeId: string): number {
  const node = SKILL_NODES[nodeId];
  if (!node) return 0;
  return node.hub ? 0 : SKILL_NODE_COST;
}

/** Unspent points: lifetime earned minus what the owned nodes cost. Never negative. */
export function skillPointsAvailable(
  level: number,
  prestige: number,
  unlocked: readonly string[],
): number {
  return Math.max(0, skillPointsEarned(level, prestige) - skillPointsSpentOnTree(unlocked));
}

export function aggregateSkillBonuses(unlocked: readonly string[]): AggregatedSkillBonuses {
  const agg = emptyAgg();
  for (const id of unlocked) {
    const n = SKILL_NODES[id];
    if (!n) continue;
    const b = n.bonus;
    for (const k of Object.keys(agg) as (keyof AggregatedSkillBonuses)[]) {
      const v = b[k];
      if (typeof v === "number") agg[k] += v;
    }
  }
  return agg;
}

/** True if the player has reached this heart (owns it, or owns any node linked to it). */
export function hasHeartAccess(hubId: string, unlocked: ReadonlySet<string>): boolean {
  const hub = SKILL_NODES[hubId];
  if (!hub?.hub) return false;
  if (unlocked.has(hubId)) return true;
  for (const e of hub.edges) {
    if (unlocked.has(e)) return true;
  }
  return false;
}

/**
 * Can unlock `nodeId` if:
 * - adjacent to an unlocked node, or
 * - linked to a heart the player has connected to (owning the heart or any of its spokes
 *   opens every skill connected to that heart).
 */
export function canUnlockSkillNode(
  nodeId: string,
  unlocked: ReadonlySet<string>,
): boolean {
  if (unlocked.has(nodeId)) return false;
  const node = SKILL_NODES[nodeId];
  if (!node) return false;

  for (const e of node.edges) {
    if (unlocked.has(e)) return true;
  }

  // Heart spoke: touching a heart opens all of its connected skills.
  for (const e of node.edges) {
    const other = SKILL_NODES[e];
    if (other?.hub && hasHeartAccess(e, unlocked)) return true;
  }

  // Heart itself: reachable once any spoke is owned (covered by adjacency above),
  // or once another path has heart access via nexus — still adjacency.

  return false;
}

export function initialUnlockedForJob(job: JobId): string[] {
  return [skillHubForJob(job)];
}

/**
 * Hearts the player has (or is granted) for free: current main + support,
 * plus any heart already unlocked (survives main/support swaps — never strip
 * progress). Every heart costs 0 in skillNodeCost, so this agrees with it.
 */
export function freeSkillHubs(
  main: JobId,
  sub?: JobId | null,
  unlocked: readonly string[] = [],
): string[] {
  const hubs = new Set<string>([skillHubForJob(main)]);
  if (sub && sub !== main) hubs.add(skillHubForJob(sub));
  for (const id of unlocked) {
    if (SKILL_NODES[id]?.hub) hubs.add(id);
  }
  return [...hubs];
}

/** Points spent on the owned nodes, priced by skillNodeCost. Duplicates count once. */
export function skillPointsSpentOnTree(
  unlocked: readonly string[],
  _main?: JobId | string,
  _sub?: JobId | string | null,
): number {
  let spent = 0;
  const seen = new Set<string>();
  for (const id of unlocked) {
    if (seen.has(id)) continue;
    seen.add(id);
    spent += skillNodeCost(id);
  }
  return spent;
}

export type FreeStatAlloc = Partial<Record<AttrKey, number>>;

export function freeStatsSpent(alloc: FreeStatAlloc): number {
  let n = 0;
  for (const k of ATTRS) n += alloc[k] ?? 0;
  return n;
}

export function applyFreeStats<T extends Record<AttrKey, number>>(
  stats: T,
  alloc: FreeStatAlloc,
): T {
  const out = { ...stats };
  for (const k of ATTRS) {
    out[k] = (out[k] ?? 0) + (alloc[k] ?? 0);
  }
  return out;
}

/** Compact client catalog (no edges duplicated payload — edges included). */
export function skillTreeCatalog(): SkillNode[] {
  return Object.values(SKILL_NODES);
}
