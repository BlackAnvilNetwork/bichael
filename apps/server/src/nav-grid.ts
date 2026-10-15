import {
  PALE_HOLLOW_BOUNDS,
  clampPaleHollow,
  paleHollowClampMove,
  paleHollowWalkable,
} from "@bellgrave/config";

/**
 * Grid A* over `paleHollowWalkable` (#120).
 *
 * Pale Hollow is a small basin, but a click must not scan it without a cap.
 * If the destination is inside an obstacle, or the search budget runs out
 * before a route is found, the path stops at the closest reachable cell
 * (euclidean to the click, tie-broken by the shorter walk). The caller must
 * not rubber-band through the blocker to the original point.
 */

export type NavPoint = { x: number; z: number };

const CELL = 1;
const MAX_EXPAND = 8000;
/** Local snap when the click itself is unwalkable (wall, water). */
const GOAL_SNAP_RADIUS = 12;
const KEY_STRIDE = 4096;
const SQRT2 = Math.SQRT2;

const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

type HeapNode = { f: number; g: number; ix: number; iz: number };

class MinHeap {
  private a: HeapNode[] = [];
  get size() {
    return this.a.length;
  }
  push(n: HeapNode) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.f <= a[i]!.f) break;
      const tmp = a[p]!;
      a[p] = a[i]!;
      a[i] = tmp;
      i = p;
    }
  }
  pop(): HeapNode | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l]!.f < a[s]!.f) s = l;
        if (r < a.length && a[r]!.f < a[s]!.f) s = r;
        if (s === i) break;
        const tmp = a[s]!;
        a[s] = a[i]!;
        a[i] = tmp;
        i = s;
      }
    }
    return top;
  }
}

function cellKey(ix: number, iz: number): number {
  return (ix + 1024) * KEY_STRIDE + (iz + 1024);
}

function lineClear(ax: number, az: number, bx: number, bz: number): boolean {
  const c = paleHollowClampMove(ax, az, bx, bz);
  return Math.hypot(c.x - bx, c.z - bz) < 0.25;
}

function simplify(points: NavPoint[]): NavPoint[] {
  if (points.length <= 2) return points;
  const out: NavPoint[] = [points[0]!];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = anchor + 1;
    for (let i = points.length - 1; i > anchor + 1; i--) {
      if (lineClear(points[anchor]!.x, points[anchor]!.z, points[i]!.x, points[i]!.z)) {
        next = i;
        break;
      }
    }
    out.push(points[next]!);
    anchor = next;
  }
  return out;
}

/**
 * Path from (fromX, fromZ) to (toX, toZ), or to the closest reachable cell
 * when the click is blocked. Empty when already there. Waypoints do not
 * include the start point.
 */
export function paleHollowFindPath(fromX: number, fromZ: number, toX: number, toZ: number): NavPoint[] {
  const from = clampPaleHollow(fromX, fromZ);
  const to = clampPaleHollow(toX, toZ);
  const walkMemo = new Map<number, boolean>();
  const walkCell = (ix: number, iz: number): boolean => {
    const k = cellKey(ix, iz);
    const hit = walkMemo.get(k);
    if (hit !== undefined) return hit;
    const x = ix * CELL;
    const z = iz * CELL;
    const ok =
      x >= PALE_HOLLOW_BOUNDS.minX &&
      x <= PALE_HOLLOW_BOUNDS.maxX &&
      z >= PALE_HOLLOW_BOUNDS.minZ &&
      z <= PALE_HOLLOW_BOUNDS.maxZ &&
      paleHollowWalkable(x, z);
    walkMemo.set(k, ok);
    return ok;
  };

  const nearest = (
    ix: number,
    iz: number,
    wx: number,
    wz: number,
    radius: number,
  ): { ix: number; iz: number } | null => {
    if (walkCell(ix, iz)) return { ix, iz };
    let best: { ix: number; iz: number } | null = null;
    let bestD = Infinity;
    let bestFrom = Infinity;
    for (let r = 1; r <= radius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = ix + dx;
          const cz = iz + dz;
          if (!walkCell(cx, cz)) continue;
          const x = cx * CELL;
          const z = cz * CELL;
          const d = Math.hypot(x - wx, z - wz);
          const fromD = Math.hypot(x - from.x, z - from.z);
          if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && fromD < bestFrom)) {
            bestD = d;
            bestFrom = fromD;
            best = { ix: cx, iz: cz };
          }
        }
      }
    }
    return best;
  };

  const start = nearest(Math.round(from.x / CELL), Math.round(from.z / CELL), from.x, from.z, 3);
  if (!start) return [];

  const exactWalk = paleHollowWalkable(to.x, to.z);
  const goalCell = exactWalk
    ? nearest(Math.round(to.x / CELL), Math.round(to.z / CELL), to.x, to.z, 2) ?? {
        ix: Math.round(to.x / CELL),
        iz: Math.round(to.z / CELL),
      }
    : nearest(Math.round(to.x / CELL), Math.round(to.z / CELL), to.x, to.z, GOAL_SNAP_RADIUS);
  if (!goalCell || !walkCell(goalCell.ix, goalCell.iz)) return [];

  const goalPoint: NavPoint = exactWalk
    ? { x: to.x, z: to.z }
    : { x: goalCell.ix * CELL, z: goalCell.iz * CELL };

  if (Math.hypot(goalPoint.x - from.x, goalPoint.z - from.z) < 0.2) return [];
  if (lineClear(from.x, from.z, goalPoint.x, goalPoint.z)) return [goalPoint];

  const goalK = cellKey(goalCell.ix, goalCell.iz);
  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const open = new MinHeap();
  const startK = cellKey(start.ix, start.iz);
  gScore.set(startK, 0);
  const h0 = Math.hypot(start.ix - goalCell.ix, start.iz - goalCell.iz);
  open.push({ f: h0, g: 0, ix: start.ix, iz: start.iz });

  let bestK = startK;
  let bestDist = Math.hypot(start.ix * CELL - to.x, start.iz * CELL - to.z);
  let bestG = 0;
  let expanded = 0;
  let found = false;

  while (open.size > 0 && expanded < MAX_EXPAND) {
    const node = open.pop()!;
    const nk = cellKey(node.ix, node.iz);
    const known = gScore.get(nk);
    if (known === undefined || node.g > known + 1e-9) continue;
    expanded++;
    if (nk === goalK) {
      found = true;
      bestK = nk;
      break;
    }
    for (const [dx, dz, cost] of DIRS) {
      const ix = node.ix + dx;
      const iz = node.iz + dz;
      if (!walkCell(ix, iz)) continue;
      if (dx !== 0 && dz !== 0 && (!walkCell(node.ix + dx, node.iz) || !walkCell(node.ix, node.iz + dz))) {
        continue;
      }
      const mx = ((node.ix + ix) / 2) * CELL;
      const mz = ((node.iz + iz) / 2) * CELL;
      if (!paleHollowWalkable(mx, mz)) continue;
      const nk2 = cellKey(ix, iz);
      const g2 = node.g + cost;
      const prev = gScore.get(nk2);
      if (prev !== undefined && g2 >= prev - 1e-9) continue;
      gScore.set(nk2, g2);
      came.set(nk2, nk);
      const dist = Math.hypot(ix * CELL - to.x, iz * CELL - to.z);
      if (dist < bestDist - 1e-6 || (Math.abs(dist - bestDist) <= 1e-6 && g2 < bestG)) {
        bestDist = dist;
        bestG = g2;
        bestK = nk2;
      }
      const h = Math.hypot(ix - goalCell.ix, iz - goalCell.iz);
      open.push({ f: g2 + h, g: g2, ix, iz });
    }
  }

  const endK = found ? goalK : bestK;
  const chain: NavPoint[] = [];
  let cursor: number | undefined = endK;
  const guard = new Set<number>();
  while (cursor !== undefined && !guard.has(cursor)) {
    guard.add(cursor);
    const ix = Math.floor(cursor / KEY_STRIDE) - 1024;
    const iz = (cursor % KEY_STRIDE) - 1024;
    chain.push({ x: ix * CELL, z: iz * CELL });
    if (cursor === startK) break;
    cursor = came.get(cursor);
  }
  chain.reverse();

  if (found && exactWalk) {
    const tail = chain[chain.length - 1];
    if (tail && lineClear(tail.x, tail.z, to.x, to.z)) {
      chain[chain.length - 1] = { x: to.x, z: to.z };
    } else if (lineClear(from.x, from.z, to.x, to.z)) {
      return [{ x: to.x, z: to.z }];
    }
  } else if (!found) {
    // Budget ended or the snapped cell was never reached: keep the closest
    // cell we actually expanded. Do not append the original blocked click.
    const ix = Math.floor(endK / KEY_STRIDE) - 1024;
    const iz = (endK % KEY_STRIDE) - 1024;
    const end = { x: ix * CELL, z: iz * CELL };
    if (!chain.length || chain[chain.length - 1]!.x !== end.x || chain[chain.length - 1]!.z !== end.z) {
      chain.push(end);
    }
  }

  const withStart = [{ x: from.x, z: from.z }, ...chain.filter((p) => Math.hypot(p.x - from.x, p.z - from.z) > 0.3)];
  const smooth = simplify(withStart);
  return smooth.slice(1).filter((p) => paleHollowWalkable(p.x, p.z));
}
