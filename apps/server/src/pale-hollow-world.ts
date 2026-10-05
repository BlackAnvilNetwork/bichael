import {
  PH_ACTIVE_GATHER_COUNT,
  PH_ALL_MOBS,
  PH_ALL_NODES,
  PH_GATHER_RELOCATE_CHANCE,
  PH_HUB,
  clampPaleHollow,
  paleHollowHeight,
  paleHollowNodeSpawnPoints,
  paleHollowMobJob,
  paleHollowWalkable,
  type PaleHollowMobDef,
  type PaleHollowMobJob,
  type PaleHollowNodeDef,
  type PaleHollowRareDrop,
} from "@bellgrave/config";

export type FieldMob = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  spawnX: number;
  spawnZ: number;
  facing: number;
  hp: number;
  maxHp: number;
  level: number;
  archetype: PaleHollowMobDef["archetype"];
  job: PaleHollowMobJob;
  aggro: PaleHollowMobDef["aggro"];
  aggroRange: number;
  linkRange: number;
  drops: string[];
  rareDrops: PaleHollowRareDrop[];
  targetId: string | null;
  alive: boolean;
  respawnAt: number;
  fleeUntil: number;
};

export type FieldNode = PaleHollowNodeDef & {
  readyAt: number;
  /** Which authored spawn-point slot this live node currently occupies. */
  spawnPointId: string;
};

function fromDef(d: PaleHollowMobDef): FieldMob {
  return {
    id: d.id,
    name: d.name,
    x: d.x,
    y: paleHollowHeight(d.x, d.z),
    z: d.z,
    spawnX: d.x,
    spawnZ: d.z,
    facing: Math.PI,
    hp: d.hp,
    maxHp: d.hp,
    level: d.level,
    archetype: d.archetype,
    job: paleHollowMobJob(d),
    aggro: d.aggro,
    aggroRange: d.aggroRange,
    linkRange: d.linkRange ?? 0,
    drops: [...d.drops],
    rareDrops: [...(d.rareDrops ?? [])],
    targetId: null,
    alive: true,
    respawnAt: 0,
    fleeUntil: 0,
  };
}

/** @deprecated use createPaleHollowMobs */
export function createSegmentAMobs(): FieldMob[] {
  return createPaleHollowMobs();
}

export function createPaleHollowMobs(): FieldMob[] {
  return PH_ALL_MOBS.map(fromDef);
}

/** @deprecated use createPaleHollowNodes */
export function createSegmentANodes(): FieldNode[] {
  return createPaleHollowNodes();
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** How far an authored gather point may be nudged to reach dry land (#74). */
const GATHER_SPAWN_SNAP_MAX = 8;

function inBounds(x: number, z: number): boolean {
  const c = clampPaleHollow(x, z);
  return Math.abs(c.x - x) < 1e-6 && Math.abs(c.z - z) < 1e-6;
}

/**
 * Nearest walkable, in-bounds spot to an authored gather point. Some authored
 * points sit in the river or inside a river wall, where nobody can stand to
 * gather them. Returns null when no dry land is within GATHER_SPAWN_SNAP_MAX.
 */
export function snapGatherSpawn(x: number, z: number): { x: number; z: number } | null {
  if (inBounds(x, z) && paleHollowWalkable(x, z)) return { x, z };
  for (let r = 0.5; r <= GATHER_SPAWN_SNAP_MAX + 1e-9; r += 0.5) {
    const steps = Math.max(12, Math.ceil((Math.PI * 2 * r) / 0.4));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const sx = Math.round((x + Math.sin(a) * r) * 100) / 100;
      const sz = Math.round((z + Math.cos(a) * r) * 100) / 100;
      if (inBounds(sx, sz) && paleHollowWalkable(sx, sz)) return { x: sx, z: sz };
    }
  }
  return null;
}

let spawnPoolCache: PaleHollowNodeDef[] | null = null;

/** Authored gather points moved onto walkable ground; unreachable points are dropped. */
export function gatherSpawnPool(): PaleHollowNodeDef[] {
  if (spawnPoolCache) return spawnPoolCache;
  const pool: PaleHollowNodeDef[] = [];
  for (const def of PH_ALL_NODES) {
    const spot = snapGatherSpawn(def.x, def.z);
    if (!spot) {
      console.warn(`[pale-hollow] gather point ${def.id} (${def.x}, ${def.z}) has no walkable ground nearby; skipped`);
      continue;
    }
    pool.push(spot.x === def.x && spot.z === def.z ? def : { ...def, x: spot.x, z: spot.z });
  }
  spawnPoolCache = pool;
  return pool;
}

/**
 * Live gather nodes: authored PH_ALL_NODES coords are the spawn pool.
 * We activate PH_ACTIVE_GATHER_COUNT of them; gathered nodes may relocate.
 */
export function createPaleHollowNodes(): FieldNode[] {
  const pool = paleHollowNodeSpawnPoints();
  console.log(
    `[pale-hollow] gather spawn pool (${pool.length}):\n` +
      pool.map((p) => `  ${p.id.padEnd(18)} ${p.kind.padEnd(8)} (${p.x.toFixed(1)}, ${p.z.toFixed(1)})  ${p.name}`).join("\n"),
  );

  const spawnable = gatherSpawnPool();
  const count = Math.min(PH_ACTIVE_GATHER_COUNT, spawnable.length);
  const picked = shuffle(spawnable).slice(0, count);
  const nodes: FieldNode[] = picked.map((def, i) => ({
    ...def,
    id: `ph-live-${i}`,
    spawnPointId: def.id,
    readyAt: 0,
  }));

  console.log(
    `[pale-hollow] active gather nodes (${nodes.length}/${pool.length}): ` +
      nodes.map((n) => `${n.id}@${n.spawnPointId}`).join(", "),
  );
  return nodes;
}

/** Move a live node onto a free spawn point (adopts that point's template). */
export function relocateGatherNode(nodes: FieldNode[], node: FieldNode, chance = PH_GATHER_RELOCATE_CHANCE): boolean {
  if (Math.random() > chance) return false;
  const occupied = new Set(nodes.map((n) => n.spawnPointId));
  const candidates = gatherSpawnPool().filter((s) => !occupied.has(s.id));
  if (candidates.length === 0) return false;
  const next = candidates[Math.floor(Math.random() * candidates.length)]!;
  const prev = node.spawnPointId;
  node.spawnPointId = next.id;
  node.x = next.x;
  node.z = next.z;
  node.name = next.name;
  node.kind = next.kind;
  node.yields = [...next.yields];
  node.interactMs = next.interactMs;
  node.respawnMs = next.respawnMs;
  console.log(`[pale-hollow] gather relocate ${node.id}: ${prev} → ${next.id} (${next.x}, ${next.z}) ${next.name}`);
  return true;
}

export function isInHub(x: number, z: number): boolean {
  return x >= PH_HUB.minX && x <= PH_HUB.maxX && z >= PH_HUB.minZ && z <= PH_HUB.maxZ;
}
