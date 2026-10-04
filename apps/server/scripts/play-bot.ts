/**
 * Headless Pale Hollow gameplay bot.
 * Connects only to a local Bellgrave game server, walks, crosses a bridge,
 * fights a nearby level-1 Dust Hare, and writes bugs it can actually see.
 *
 *   pnpm --filter @bellgrave/server exec tsx scripts/play-bot.ts
 *   pnpm --filter @bellgrave/server exec tsx scripts/play-bot.ts --job rogue --seconds 60
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
  MELEE_RANGE,
  PH_ALL_MOBS,
  PH_BRIDGE_SITES,
  PH_HUB_SPAWN,
  paleHollowBridgeGeom,
  paleHollowClampMove,
  paleHollowInOpenWater,
  paleHollowOnBridge,
  paleHollowPlaceOnDryLand,
  paleHollowRiverCenterX,
  paleHollowStandHeight,
  paleHollowTrails,
  paleHollowTributaryCenterX,
  paleHollowWalkable,
} from "@bellgrave/config";

type JobId = "sorcerer" | "cleric" | "rogue" | "fighter" | "knight";

type Unit = {
  id: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  anim: string;
  archetype?: string;
};

type Snapshot = {
  type: "snapshot";
  you: { wallet: string;
  privateKey: `0x${string}`; characterId: string; name: string; job: string; level: number };
  units: Unit[];
};

type BugKind =
  | "stuck"
  | "water"
  | "y"
  | "disconnect"
  | "server_error"
  | "zero_damage"
  | "bridge_reject";

type Bug = {
  kind: BugKind;
  x: number;
  z: number;
  y: number;
  detail: string;
  tried?: string;
};

type RoutePt = { t: number; x: number; z: number; y: number; note: string };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const reportDir = resolve(repoRoot, "tmp/bot-reports");

const HARE_LEVEL = new Map(
  PH_ALL_MOBS.filter((m) => m.archetype === "dust_hare").map((m) => [m.id, m.level]),
);

const FLEET: { id: string; job: JobId; bridge: string; biasX: number; route: TourId }[] = [
  { id: "bot-sorcerer", job: "sorcerer", bridge: "hub-north", biasX: -3, route: "north-spine" },
  { id: "bot-cleric", job: "cleric", bridge: "hub-west-farm", biasX: 3, route: "west-silo" },
  { id: "bot-rogue", job: "rogue", bridge: "hub-east-trib", biasX: -7, route: "east-trib" },
  { id: "bot-fighter", job: "fighter", bridge: "chalkworks-corridor", biasX: 7, route: "chalk-marches" },
];

type TourId = "north-spine" | "west-silo" | "east-trib" | "chalk-marches";
type Wp = { x: number; z: number; label: string };

function dryWp(x: number, z: number, label: string): Wp {
  const p = paleHollowPlaceOnDryLand(x, z, 24);
  return { x: p.x, z: p.z, label };
}

function trailWps(id: string): Wp[] {
  const t = paleHollowTrails().find((tr) => tr.id === id);
  if (!t) return [];
  return t.points.map((p, i) => ({ x: p.x, z: p.z, label: `${id} ${i + 1}/${t.points.length}` }));
}

function bridgeWps(id: string, from: { x: number; z: number }): Wp[] {
  const site = PH_BRIDGE_SITES.find((s) => s.id === id);
  if (!site) return [];
  const g = paleHollowBridgeGeom(site);
  const steps = Math.max(3, Math.ceil(g.span / 3));
  const samples: Wp[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    samples.push({
      x: g.postL.x + (g.postR.x - g.postL.x) * t,
      z: g.postL.z + (g.postR.z - g.postL.z) * t,
      label: `cross ${id} t=${i}/${steps}`,
    });
  }
  const d0 = Math.hypot(from.x - samples[0]!.x, from.z - samples[0]!.z);
  const d1 = Math.hypot(from.x - samples[samples.length - 1]!.x, from.z - samples[samples.length - 1]!.z);
  if (d1 < d0) samples.reverse();
  return samples;
}

function chalkBank(z: number, label: string, side = 1): Wp {
  return dryWp(paleHollowRiverCenterX(z) + side * 10, z, label);
}

function tribBank(z: number, label: string, side = 1): Wp {
  return dryWp(paleHollowTributaryCenterX(z) + side * 8, z, label);
}

function tourWaypoints(id: TourId): Wp[] {
  const out: Wp[] = [];
  const add = (wps: Wp[]) => {
    for (const w of wps) out.push(w);
  };
  const bridge = (bridgeId: string) => {
    const prev = out[out.length - 1] ?? { x: 0, z: 2 };
    add(bridgeWps(bridgeId, prev));
  };
  const camp = () => add([dryWp(0, 6, "encampment")]);

  if (id === "north-spine") {
    camp();
    add(trailWps("camp-to-north"));
    bridge("hub-north");
    add(trailWps("north-to-ashbeam"));
    bridge("ashbeam-corridor");
    add([dryWp(-8, 78, "ashbeam"), dryWp(10, 92, "ashbeam-grove")]);
    add(trailWps("ashbeam-to-chalkworks"));
    bridge("chalkworks-corridor");
    add([dryWp(8, 150, "chalkworks")]);
    add(trailWps("chalkworks-to-marches"));
    bridge("marches-corridor");
    add(trailWps("marches-to-ash-road"));
    add([chalkBank(230, "chalk-run-north", -1)]);
  } else if (id === "west-silo") {
    add([dryWp(-26, -6, "silo")]);
    camp();
    add(trailWps("camp-to-west-farm"));
    bridge("hub-west-farm");
    add(trailWps("west-farm-onward"));
    add([dryWp(-50, 28, "mountain-shoulder-west"), chalkBank(18, "chalk-run-south", -1)]);
  } else if (id === "east-trib") {
    camp();
    add([tribBank(39, "east-trib-end-z39", 1)]);
    add(trailWps("camp-to-east-trib"));
    bridge("hub-east-trib");
    add(trailWps("east-trib-to-ashbeam"));
    bridge("ashbeam-east-trib");
    add(trailWps("east-ashbeam-grove"));
    add([tribBank(155, "east-trib-end-z155", -1), dryWp(48, 50, "mountain-shoulder-east")]);
  } else {
    camp();
    add([chalkBank(16, "chalk-run-south", 1)]);
    add(trailWps("camp-to-north"));
    bridge("hub-north");
    add([dryWp(22, 70, "ashbeam-east-flank"), dryWp(-24, 96, "ashbeam-west-grove")]);
    bridge("chalkworks-corridor");
    add([dryWp(-28, 160, "chalkworks-west")]);
    bridge("marches-corridor");
    add([dryWp(-40, 148, "mountain-shoulder-marches"), chalkBank(220, "chalk-run-north", 1)]);
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function dist(ax: number, az: number, bx: number, bz: number) {
  return Math.hypot(ax - bx, az - bz);
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

function assertLocalWs(url: string) {
  const u = new URL(url);
  if (u.protocol !== "ws:" && u.protocol !== "wss:") {
    throw new Error(`Refusing non-websocket URL ${url}`);
  }
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    throw new Error(`Refusing non-local host ${u.hostname}`);
  }
}

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolveOpen(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 800);
  });
}

class PlayBot {
  readonly id: string;
  readonly job: JobId;
  readonly bridgeId: string;
  readonly biasX: number;
  readonly wsUrl: string;
  readonly seconds: number;
  readonly wallet: string;
  readonly privateKey: `0x${string}`;
  readonly tour: boolean;
  readonly routeId: TourId;

  private ws: WebSocket | null = null;
  private stopping = false;
  private ready = false;
  private x = PH_HUB_SPAWN.x;
  private y = 0;
  private z = PH_HUB_SPAWN.z;
  private prevX = PH_HUB_SPAWN.x;
  private prevZ = PH_HUB_SPAWN.z;
  private charName = "";
  private level = 1;
  private units: Unit[] = [];
  private bugs: Bug[] = [];
  private bugKeys = new Set<string>();
  private route: RoutePt[] = [];
  private startedAt = 0;
  private hits = 0;
  private misses = 0;
  private zeroHits = 0;
  private errors: string[] = [];
  private lastLogAt = 0;
  private sawWake = false;
  private notes: string[] = [];
  private deadline = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private lastSampleAt = -999;
  private samples: RoutePt[] = [];
  private areas = new Map<string, { t: number; x: number; y: number; z: number }>();
  private gameLog: { t: number; message: string }[] = [];
  private rejected = 0;
  private unstuckLog: { t: number; x: number; z: number; tried: string; result: string }[] = [];

  constructor(opts: {
    id: string;
    job: JobId;
    bridge: string;
    biasX: number;
    wsUrl: string;
    seconds: number;
    tour?: boolean;
    route?: TourId;
  }) {
    this.id = opts.id;
    this.job = opts.job;
    this.bridgeId = opts.bridge;
    this.biasX = opts.biasX;
    this.wsUrl = opts.wsUrl;
    this.seconds = opts.seconds;
    this.tour = opts.tour ?? false;
    this.routeId = opts.route ?? "north-spine";
    this.privateKey = generatePrivateKey();
    this.wallet = privateKeyToAccount(this.privateKey).address;
  }

  private t() {
    return (Date.now() - this.startedAt) / 1000;
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private bug(kind: BugKind, detail: string, tried?: string) {
    const key = `${kind}|${Math.round(this.x)}|${Math.round(this.z)}|${detail.slice(0, 96)}`;
    if (this.bugKeys.has(key)) return;
    this.bugKeys.add(key);
    this.bugs.push({
      kind,
      x: this.x,
      z: this.z,
      y: this.y,
      detail,
      tried,
    });
    this.pushGame(`BUG ${kind}: ${detail}`);
  }

  private pushGame(message: string) {
    if (this.gameLog.length >= 600) return;
    this.gameLog.push({ t: this.t(), message });
  }

  private noteArea() {
    let area = "basin";
    if (Math.hypot(this.x + 26, this.z + 6) < 10) area = "silo";
    else if (this.z < 12 && this.x > -18 && this.x < 18) area = "encampment";
    else if (paleHollowOnBridge(this.x, this.z)) {
      let best = "bridge";
      let bestD = 1e9;
      for (const s of PH_BRIDGE_SITES) {
        const d = Math.abs(this.z - s.z);
        if (d < bestD) {
          bestD = d;
          best = s.id;
        }
      }
      area = `bridge:${best}`;
    } else if (Math.hypot(this.x + 62, this.z - 30) < 24) area = "mountain-shoulder-west";
    else if (Math.hypot(this.x - 58, this.z - 42) < 22) area = "mountain-shoulder-east";
    else if (Math.hypot(this.x + 55, this.z - 155) < 26) area = "mountain-shoulder-marches";
    else if (this.z >= 176) area = "marches";
    else if (this.z >= 120) area = "chalkworks";
    else if (this.z >= 55) area = "ashbeam";
    else if (this.x > 18 && this.z < 55) area = "east-trib-south";
    else if (this.x > 16 && this.z >= 130 && this.z < 176) area = "east-trib-north";
    else if (this.x < -30 && this.z < 55) area = "west-farm";
    else if (this.z < 30) area = "hub-apron";
    if (!this.areas.has(area)) {
      this.areas.set(area, { t: this.t(), x: this.x, y: this.y, z: this.z });
      this.pushGame(`Entered ${area} at ${fmt(this.x)}, ${fmt(this.y)}, ${fmt(this.z)}`);
    }
  }

  private mark(note: string) {
    const last = this.route[this.route.length - 1];
    if (last && dist(last.x, last.z, this.x, this.z) < 1.2 && last.note === note) return;
    this.route.push({ t: this.t(), x: this.x, z: this.z, y: this.y, note });
  }

  private observePose() {
    if (paleHollowInOpenWater(this.x, this.z)) {
      this.bug(
        "water",
        `Standing in open water while walkability should block (walkable=${paleHollowWalkable(this.x, this.z)}, onBridge=${paleHollowOnBridge(this.x, this.z)}).`,
      );
    } else if (!paleHollowWalkable(this.x, this.z) && !paleHollowOnBridge(this.x, this.z)) {
      this.bug(
        "water",
        "Standing on a tile paleHollowWalkable rejects (river wall or channel) after a move the server applied.",
      );
    }
    const expect = paleHollowStandHeight(this.x, this.z);
    if (!Number.isFinite(this.y) || this.y < -1.5 || Math.abs(this.y - expect) > 1.25) {
      this.bug(
        "y",
        `Y ${fmt(this.y)} disagrees with stand height ${fmt(expect)} (delta ${fmt(this.y - expect)}).`,
      );
    }
  }

  private onLog(message: string) {
    this.lastLogAt = Date.now();
    if (message.includes("wake in the Shard")) {
      this.sawWake = true;
      this.pushGame(message);
    }
    const hit = /You hit .+ for (\d+)/.exec(message);
    if (hit) {
      const dmg = Number(hit[1]);
      this.pushGame(message);
      if (dmg <= 0) {
        this.zeroHits += 1;
        this.bug("zero_damage", `Combat resolved a hit for ${dmg}: "${message}"`);
      } else this.hits += 1;
    } else if (/\bfor 0\b/.test(message) && /hit|damage|strike/i.test(message)) {
      this.zeroHits += 1;
      this.pushGame(message);
      this.bug("zero_damage", `Log reported zero damage: "${message}"`);
    }
    if (message === "You miss.") {
      this.misses += 1;
      this.pushGame(message);
    } else if (!hit && !message.startsWith("Resting")) {
      const keep =
        /Engaged|misses you|hits you|fall|wake|Error|recommends level|Claimed|created/i.test(message);
      if (keep) this.pushGame(message);
    }
  }

  private onSnapshot(msg: Snapshot) {
    const me = msg.units.find((u) => u.id === msg.you.wallet || u.kind === "player" && u.name === msg.you.name);
    this.charName = msg.you.name;
    this.level = msg.you.level;
    this.units = msg.units;
    if (!me) return;
    const jumped = dist(this.x, this.z, me.x, me.z);
    this.prevX = this.x;
    this.prevZ = this.z;
    this.x = me.x;
    this.y = me.y;
    this.z = me.z;
    if (this.ready && jumped > 18 && !this.sawWake) {
      this.bug(
        "y",
        `Position jumped ${fmt(jumped)} in one snapshot without a death wake (from ${fmt(this.prevX)},${fmt(this.prevZ)}).`,
      );
    }
    this.sawWake = false;
    this.observePose();
    this.noteArea();
    if (this.t() - this.lastSampleAt >= 5) {
      this.lastSampleAt = this.t();
      this.samples.push({ t: this.t(), x: this.x, z: this.z, y: this.y, note: "sample" });
    }
    this.mark("move");
  }

  private nearestHare(): Unit | null {
    let best: Unit | null = null;
    let bestD = 26;
    for (const u of this.units) {
      if (u.kind !== "mob" || u.archetype !== "dust_hare") continue;
      if (u.anim === "dead" || u.hp <= 0) continue;
      if ((HARE_LEVEL.get(u.id) ?? 99) !== 1) continue;
      const d = dist(this.x, this.z, u.x, u.z);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private logUnstuck(tried: string, result: string) {
    this.unstuckLog.push({ t: this.t(), x: this.x, z: this.z, tried, result });
    this.pushGame(`Unstuck at ${fmt(this.x)}, ${fmt(this.z)}: tried ${tried} — ${result}`);
    this.mark(`unstuck ${tried}`);
  }

  /** One server step. Sends only a point paleHollowClampMove will actually accept. */
  private async stepLegal(tx: number, tz: number, timeoutMs: number): Promise<boolean> {
    const clamped = paleHollowClampMove(this.x, this.z, tx, tz);
    if (dist(this.x, this.z, clamped.x, clamped.z) < 0.45) return false;
    if (!paleHollowWalkable(clamped.x, clamped.z)) return false;
    const startX = this.x;
    const startZ = this.z;
    const until = Date.now() + timeoutMs;
    let stallSince = Date.now();
    let seenX = this.x;
    let seenZ = this.z;
    while (Date.now() < until) {
      if (dist(this.x, this.z, clamped.x, clamped.z) <= 0.8) return true;
      this.send({ type: "move", x: clamped.x, z: clamped.z });
      await sleep(200);
      if (dist(seenX, seenZ, this.x, this.z) > 0.3) {
        seenX = this.x;
        seenZ = this.z;
        stallSince = Date.now();
      } else if (Date.now() - stallSince > 900) {
        return dist(this.x, this.z, startX, startZ) > 0.35;
      }
    }
    return dist(this.x, this.z, startX, startZ) > 0.35;
  }

  /**
   * Straight line is a wall or the channel. Do not reissue that waypoint.
   * Slide on the tangent, back up, or take a new walkable heading.
   */
  private async escapeWall(goalX: number, goalZ: number, label: string): Promise<boolean> {
    const dx = goalX - this.x;
    const dz = goalZ - this.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const options: { x: number; z: number; tried: string }[] = [];
    for (const mag of [2.4, 4.2, 6.5]) {
      options.push({ x: this.x - uz * mag, z: this.z + ux * mag, tried: `slide left ${mag}` });
      options.push({ x: this.x + uz * mag, z: this.z - ux * mag, tried: `slide right ${mag}` });
      options.push({
        x: this.x - ux * mag * 0.85,
        z: this.z - uz * mag * 0.85,
        tried: `back up ${mag}`,
      });
    }
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      options.push({
        x: this.x + Math.sin(ang) * 4,
        z: this.z + Math.cos(ang) * 4,
        tried: `heading ${Math.round((ang * 180) / Math.PI)}°`,
      });
    }

    const goalFar = dist(this.x, this.z, goalX, goalZ) > 8;
    let aimX = goalX;
    let aimZ = goalZ;
    let aimNote = "";
    if (goalFar) {
      let bestPost: { x: number; z: number; id: string; d: number } | null = null;
      for (const site of PH_BRIDGE_SITES) {
        const g = paleHollowBridgeGeom(site);
        for (const post of [g.postL, g.postR]) {
          const opening = paleHollowClampMove(this.x, this.z, post.x, post.z);
          const opened = dist(this.x, this.z, opening.x, opening.z);
          const d = dist(this.x, this.z, post.x, post.z);
          if (d > 80) continue;
          if (opened < 0.8 && d > 6) continue;
          if (!bestPost || d < bestPost.d) bestPost = { x: post.x, z: post.z, id: site.id, d };
        }
      }
      if (bestPost && bestPost.d > 3) {
        aimX = bestPost.x;
        aimZ = bestPost.z;
        aimNote = ` repath via ${bestPost.id}`;
      }
    }

    const hereToGoal = dist(this.x, this.z, aimX, aimZ);
    let best: { x: number; z: number; tried: string; score: number } | null = null;
    for (const o of options) {
      if (paleHollowInOpenWater(o.x, o.z)) continue;
      const clamped = paleHollowClampMove(this.x, this.z, o.x, o.z);
      const moved = dist(this.x, this.z, clamped.x, clamped.z);
      if (moved < 0.7 || !paleHollowWalkable(clamped.x, clamped.z)) continue;
      const gain = hereToGoal - dist(clamped.x, clamped.z, aimX, aimZ);
      const score = gain * 3 + moved;
      if (!best || score > best.score) best = { x: clamped.x, z: clamped.z, tried: o.tried, score };
    }

    const from = `${fmt(this.x)}, ${fmt(this.z)}`;
    if (!best) {
      this.rejected += 1;
      this.logUnstuck(
        `slide, backup, and headings off ${label} at ${from} (goal ${fmt(goalX)}, ${fmt(goalZ)})`,
        "no walkable step — left this waypoint",
      );
      return false;
    }
    const ok = await this.stepLegal(best.x, best.z, 4_500);
    this.logUnstuck(
      `${best.tried} from ${from} after ${label} was blocked (goal ${fmt(goalX)}, ${fmt(goalZ)})${aimNote}`,
      ok ? `moved to ${fmt(this.x)}, ${fmt(this.z)}` : `step did not stick, still ${fmt(this.x)}, ${fmt(this.z)}`,
    );
    return ok;
  }

  private async walkTo(tx: number, tz: number, label: string, timeoutMs = 18_000) {
    this.send({ type: "disengage" });
    this.mark(label);
    const deadline = Date.now() + timeoutMs;
    let escapes = 0;
    while (Date.now() < deadline) {
      if (dist(this.x, this.z, tx, tz) <= 1.35) {
        this.mark(`arrived ${label}`);
        return true;
      }
      const clamped = paleHollowClampMove(this.x, this.z, tx, tz);
      const allowed = dist(this.x, this.z, clamped.x, clamped.z);
      const goalDist = dist(this.x, this.z, tx, tz);
      if (allowed < 0.45) {
        this.rejected += 1;
        this.pushGame(
          `Move rejected toward ${label} at ${fmt(this.x)}, ${fmt(this.y)}, ${fmt(this.z)} (clamp ${fmt(allowed)})`,
        );
        const bridgeStep = label.startsWith("cross ") && goalDist <= 4 && paleHollowWalkable(tx, tz);
        if (bridgeStep) {
          this.bug(
            "bridge_reject",
            `Short bridge step toward ${label} was refused. Goal ${fmt(tx)},${fmt(tz)} is walkable ${fmt(goalDist)} away and clamp advanced ${fmt(allowed)}.`,
            `move ${fmt(tx)},${fmt(tz)} from ${fmt(this.x)},${fmt(this.z)}`,
          );
        }
        if (escapes >= 1) {
          this.mark(`blocked ${label}`);
          return false;
        }
        escapes += 1;
        const freed = await this.escapeWall(tx, tz, label);
        if (!freed) return false;
        continue;
      }

      const startX = this.x;
      const startZ = this.z;
      this.send({ type: "move", x: clamped.x, z: clamped.z });
      const hopUntil = Math.min(deadline, Date.now() + Math.max(2_500, (allowed / 4.2) * 1000 + 800));
      let stallSince = Date.now();
      let seenX = this.x;
      let seenZ = this.z;
      let progressed = false;
      while (Date.now() < hopUntil) {
        if (dist(this.x, this.z, tx, tz) <= 1.35) {
          this.mark(`arrived ${label}`);
          return true;
        }
        if (dist(this.x, this.z, clamped.x, clamped.z) <= 0.85) {
          progressed = true;
          break;
        }
        await sleep(200);
        if (dist(seenX, seenZ, this.x, this.z) > 0.3) {
          seenX = this.x;
          seenZ = this.z;
          stallSince = Date.now();
          progressed = true;
        } else if (Date.now() - stallSince > 1100) {
          break;
        }
      }
      if (!progressed && dist(this.x, this.z, startX, startZ) < 0.3) {
        this.bug(
          "stuck",
          `Position unchanged while a clamp-legal move toward ${label} was in flight (${fmt(allowed)} allowed).`,
          `move ${fmt(clamped.x)},${fmt(clamped.z)} from ${fmt(this.x)},${fmt(this.z)}`,
        );
        if (escapes >= 1) return false;
        escapes += 1;
        const freed = await this.escapeWall(tx, tz, label);
        if (!freed) return false;
      }
    }
    this.mark(`timeout ${label}`);
    return dist(this.x, this.z, tx, tz) <= 2.2;
  }

  private async fight(maxMs: number) {
    const until = Date.now() + maxMs;
    let meleeSince = 0;
    let swingsAtMelee = this.hits + this.misses;
    let reported = false;
    while (Date.now() < until) {
      const hare = this.nearestHare();
      if (!hare) {
        if (!this.notes.some((n) => n.startsWith("No level-1 hare"))) {
          this.notes.push("No level-1 hare inside 26 units.");
        }
        return;
      }
      const d = dist(this.x, this.z, hare.x, hare.z);
      this.send({ type: "engage", targetId: hare.id });
      if (d <= MELEE_RANGE + 0.35) {
        if (meleeSince === 0) {
          meleeSince = Date.now();
          swingsAtMelee = this.hits + this.misses;
          this.mark(`melee ${hare.name} ${hare.id}`);
        }
        const swung = this.hits + this.misses > swingsAtMelee;
        if (!swung && !reported && Date.now() - meleeSince > 7000 && hare.hp > 0) {
          this.bug(
            "zero_damage",
            `In melee of level-1 ${hare.name} (${hare.id}) for 7s with no hit and no miss. Target HP ${hare.hp}/${hare.maxHp}.`,
            `engage ${hare.id} at ${fmt(hare.x)},${fmt(hare.z)}`,
          );
          reported = true;
        }
      } else {
        meleeSince = 0;
      }
      await sleep(350);
    }
    this.send({ type: "disengage" });
  }

  private async crossBridge() {
    const site = PH_BRIDGE_SITES.find((s) => s.id === this.bridgeId);
    if (!site) {
      this.bug("bridge_reject", `Unknown bridge site ${this.bridgeId}.`);
      return;
    }
    const g = paleHollowBridgeGeom(site);
    const nearFirst = dist(this.x, this.z, g.postL.x, g.postL.z) <= dist(this.x, this.z, g.postR.x, g.postR.z);
    const a = nearFirst ? g.postL : g.postR;
    const b = nearFirst ? g.postR : g.postL;
    this.notes.push(
      `Bridge ${site.id} landings (${fmt(g.postL.x)},${fmt(g.postL.z)}) → (${fmt(g.postR.x)},${fmt(g.postR.z)}) span ${fmt(g.span)}.`,
    );

    const steps = Math.max(4, Math.ceil(g.span / 2));
    const samples: { x: number; z: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      samples.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
      });
    }
    for (let i = 1; i < samples.length - 1; i++) {
      const s = samples[i]!;
      const prev = samples[i - 1]!;
      const next = samples[i + 1]!;
      if (
        !paleHollowWalkable(s.x, s.z) &&
        paleHollowWalkable(prev.x, prev.z) &&
        paleHollowWalkable(next.x, next.z)
      ) {
        this.bug(
          "bridge_reject",
          `Deck gap on ${site.id}: centerline ${fmt(s.x)},${fmt(s.z)} is not walkable between two walkable samples.`,
          `cross ${site.id}`,
        );
      }
    }

    let approached = await this.walkTo(a.x, a.z, `approach ${site.id}`, 16_000);
    if (!approached) {
      const dx = a.x - this.x;
      const dz = a.z - this.z;
      const len = Math.hypot(dx, dz) || 1;
      const px = -dz / len;
      const pz = dx / len;
      for (const mag of [8, -8, 14, -14]) {
        const sx = this.x + px * mag;
        const sz = this.z + pz * mag;
        if (!paleHollowWalkable(sx, sz)) continue;
        const side = await this.walkTo(sx, sz, `approach ${site.id} sidestep`, 8_000);
        if (!side) continue;
        approached = await this.walkTo(a.x, a.z, `approach ${site.id}`, 14_000);
        if (approached) break;
      }
    }
    const startX = this.x;
    const startZ = this.z;
    const reachedApproach = dist(startX, startZ, a.x, a.z) < 6 || paleHollowOnBridge(startX, startZ);
    if (!reachedApproach) {
      this.notes.push(
        `Could not reach ${site.id} approach ${fmt(a.x)},${fmt(a.z)}; stopped at ${fmt(startX)},${fmt(startZ)}.`,
      );
      return;
    }
    let crossed = true;
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i]!;
      if (!paleHollowWalkable(s.x, s.z)) continue;
      const ok = await this.walkTo(s.x, s.z, `cross ${site.id} t=${i}/${steps}`, 8_000);
      if (!ok && dist(this.x, this.z, s.x, s.z) > 2) {
        crossed = false;
        break;
      }
    }
    const far = dist(this.x, this.z, b.x, b.z) < 4.5;
    if (reachedApproach && (!crossed || !far)) {
      const expect = paleHollowClampMove(startX, startZ, b.x, b.z);
      this.bug(
        "bridge_reject",
        `Did not finish ${site.id}. Started ${fmt(startX)},${fmt(startZ)} ended ${fmt(this.x)},${fmt(this.z)}. Far landing ${fmt(b.x)},${fmt(b.z)}. Straight clamp would stop at ${fmt(expect.x)},${fmt(expect.z)}.`,
        `cross ${site.id} to ${fmt(b.x)},${fmt(b.z)}`,
      );
    } else if (far) {
      this.notes.push(`Crossed ${site.id} to ${fmt(this.x)},${fmt(this.z)}.`);
    } else {
      this.notes.push(
        `Did not reach ${site.id} landing ${fmt(b.x)},${fmt(b.z)}; stopped at ${fmt(this.x)},${fmt(this.z)}.`,
      );
    }
  }

  private async returnHub() {
    const site = PH_BRIDGE_SITES.find((s) => s.id === this.bridgeId);
    const hubX = PH_HUB_SPAWN.x + this.biasX * 0.2;
    const hubZ = Math.max(4, PH_HUB_SPAWN.z);
    if (site) {
      const g = paleHollowBridgeGeom(site);
      const homeSide = [g.postL, g.postR].sort(
        (p, q) => dist(p.x, p.z, hubX, hubZ) - dist(q.x, q.z, hubX, hubZ),
      )[0]!;
      if (dist(this.x, this.z, homeSide.x, homeSide.z) > 5 && dist(this.x, this.z, hubX, hubZ) > 12) {
        await this.walkTo(homeSide.x, homeSide.z, `back along ${site.id}`, 16_000);
      }
    }
    await this.walkTo(hubX, hubZ, "return hub", 18_000);
  }

  private async probeWater() {
    const site = PH_BRIDGE_SITES.find((s) => s.id === this.bridgeId);
    const z = (site?.z ?? 22) + 8;
    const cx = paleHollowRiverCenterX(z);
    if (!paleHollowInOpenWater(cx, z)) {
      this.notes.push(`Water probe skipped — river center ${fmt(cx)},${fmt(z)} is not open water.`);
      return;
    }
    this.mark("water probe");
    await this.walkTo(cx, z, "into river center", 12_000);
    if (paleHollowInOpenWater(this.x, this.z)) {
      this.bug(
        "water",
        `Move into the river center was applied. Tried ${fmt(cx)},${fmt(z)} and stopped in open water.`,
        `move ${fmt(cx)},${fmt(z)}`,
      );
    } else {
      this.notes.push(`Water probe held at ${fmt(this.x)},${fmt(this.z)} (target ${fmt(cx)},${fmt(z)}).`);
    }
  }

  private connect(): Promise<void> {
    assertLocalWs(this.wsUrl);
    return new Promise((resolveReady, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const fail = (err: Error) => {
        if (!this.ready) reject(err);
      };
      ws.on("open", () => {
        this.send({ type: "auth/hello", wallet: this.wallet });
        this.pingTimer = setInterval(() => this.send({ type: "ping", t: Date.now() }), 20_000);
      });
      ws.on("error", (err) => {
        this.errors.push(String(err.message ?? err));
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("close", () => {
        if (!this.stopping) {
          this.bug("disconnect", "Socket closed before the bot finished its route.");
          this.errors.push("unexpected disconnect");
        }
      });
      ws.on("message", (buf) => {
        let msg: { type?: string; message?: string; characters?: { id: string }[]; hasCharacter?: boolean };
        try {
          msg = JSON.parse(String(buf));
        } catch {
          this.bug("server_error", "Server sent non-JSON.");
          return;
        }
        if (msg.type === "pong" || msg.type === "npc/dialog") return;
        if (msg.type === "error") {
          const message = msg.message ?? "error";
          this.errors.push(message);
          this.bug("server_error", message);
          return;
        }
        if (msg.type === "log" && msg.message) {
          this.onLog(msg.message);
          return;
        }
        if (msg.type === "auth/challenge") {
          const key = this.privateKey;
          const account = privateKeyToAccount(key);
          if (account.address.toLowerCase() !== this.wallet.toLowerCase()) {
            this.onLog("play-bot wallet/key mismatch");
            return;
          }
          void account.signMessage({ message: msg.message }).then((signature) => {
            this.send({
              type: "auth",
              wallet: this.wallet,
              signature,
              nonce: msg.nonce,
              message: msg.message,
            });
          });
          return;
        }
        if (msg.type === "auth/ok") {
          const id = msg.characters?.[0]?.id;
          if (msg.hasCharacter && id) this.send({ type: "char/enter", characterId: id });
          else {
            const name = `${this.job.slice(0, 4)}bot`.slice(0, 16);
            this.send({ type: "char/create", name, job: this.job, gender: "male" });
          }
          return;
        }
        if (msg.type === "snapshot") {
          this.onSnapshot(msg as Snapshot);
          if (!this.ready) {
            this.ready = true;
            this.send({ type: "claim/starter" });
            resolveReady();
          }
        }
      });
      setTimeout(() => fail(new Error(`${this.id} timed out waiting for a snapshot`)), 12_000);
    });
  }

  private async runTour() {
    const points = tourWaypoints(this.routeId);
    this.notes.push(`Tour ${this.routeId}: ${points.length} waypoints.`);
    let loop = 0;
    while (Date.now() + 1500 < this.deadline) {
      loop += 1;
      this.pushGame(`Tour loop ${loop}`);
      let skipFarBlocked = false;
      for (const p of points) {
        if (Date.now() + 1500 >= this.deadline) break;
        const opening = paleHollowClampMove(this.x, this.z, p.x, p.z);
        const opened = dist(this.x, this.z, opening.x, opening.z);
        const away = dist(this.x, this.z, p.x, p.z);
        if (skipFarBlocked && opened < 0.5 && away > 8) {
          this.rejected += 1;
          continue;
        }
        skipFarBlocked = false;
        const left = this.deadline - Date.now();
        const timeout = Math.min(left, Math.max(7_000, (away / 4.2) * 1000 + 5_000));
        const ok = await this.walkTo(p.x, p.z, p.label, timeout);
        if (!ok && dist(this.x, this.z, p.x, p.z) > 6) skipFarBlocked = true;
        if (p.label === "encampment" && this.nearestHare() && this.deadline - Date.now() > 6_000) {
          await this.fight(Math.min(12_000, this.deadline - Date.now()));
        }
      }
    }
  }

  async run() {
    this.startedAt = Date.now();
    await this.connect();
    this.mark("spawn");
    await sleep(400);
    this.deadline = Date.now() + this.seconds * 1000;
    this.checkpointTimer = setInterval(() => {
      try {
        this.writeReport();
      } catch {
        /* keep playing */
      }
    }, 90_000);
    if (this.tour) {
      await this.runTour();
    } else {
      const end = this.deadline;
      const hareSpot = { x: this.biasX, z: 14 };
      await this.walkTo(hareSpot.x, hareSpot.z, "hare ground", 15_000);
      await this.fight(Math.min(22_000, Math.max(0, end - Date.now())));
      if (Date.now() < end) await this.crossBridge();
      if (Date.now() < end) await this.probeWater();
      if (Date.now() < end) await this.returnHub();
      while (Date.now() + 2500 < end) {
        const left = end - Date.now();
        await this.walkTo(hareSpot.x, hareSpot.z, "patrol hares", Math.min(12_000, left));
        if (Date.now() + 1500 >= end) break;
        await this.fight(Math.min(16_000, end - Date.now()));
        if (Date.now() + 1500 >= end) break;
        await this.walkTo(PH_HUB_SPAWN.x + this.biasX * 0.15, 6, "patrol hub", Math.min(12_000, end - Date.now()));
      }
    }
    this.mark("done");
    this.stopping = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.ws?.close();
    await sleep(200);
  }

  reportMarkdown(): string {
    const lines = [
      `# ${this.id}`,
      ``,
      `- Bot: ${this.id}`,
      `- Job: ${this.job}`,
      `- Character: ${this.charName || "(none)"} level ${this.level}`,
      `- Wallet: ${this.wallet}`,
      `- Bridge route: ${this.bridgeId}`,
      `- Duration: ${this.seconds}s (played ${fmt(this.t())}s)`,
      `- Route: ${this.tour ? this.routeId : this.bridgeId}`,
      `- Hits: ${this.hits}  Misses: ${this.misses}  Zero-damage hits: ${this.zeroHits}`,
      `- Moves rejected: ${this.rejected}`,
      `- Unstuck attempts: ${this.unstuckLog.length}`,
      ``,
      `## Areas`,
      ``,
    ];
    if (this.areas.size === 0) lines.push("(none)");
    for (const [name, p] of this.areas) {
      lines.push(`- t=${fmt(p.t)}s  ${name}  (${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})`);
    }
    lines.push(``, `## Position samples`, ``);
    if (this.samples.length === 0) lines.push("(none)");
    for (const p of this.samples) {
      lines.push(`- t=${fmt(p.t)}s  X ${fmt(p.x)}  Y ${fmt(p.y)}  Z ${fmt(p.z)}`);
    }
    lines.push(``, `## Route`, ``);
    const shown: RoutePt[] = [];
    for (const p of this.route) {
      const prev = shown[shown.length - 1];
      const interesting = p.note !== "move";
      if (!prev || interesting || dist(prev.x, prev.z, p.x, p.z) >= 3) shown.push(p);
    }
    if (shown.length === 0) lines.push("(no positions)");
    for (const p of shown) {
      lines.push(`- t=${fmt(p.t)}s  (${fmt(p.x)}, ${fmt(p.z)}) y=${fmt(p.y)}  ${p.note}`);
    }
    lines.push(``, `## Unstuck`, ``);
    if (this.unstuckLog.length === 0) lines.push("None.");
    for (const u of this.unstuckLog) {
      lines.push(`- t=${fmt(u.t)}s at (${fmt(u.x)}, ${fmt(u.z)}) — tried ${u.tried} — ${u.result}`);
    }
    lines.push(``, `## Bugs`, ``);
    if (this.bugs.length === 0) lines.push("None observed.");
    for (const b of this.bugs) {
      lines.push(`- **${b.kind}** at (${fmt(b.x)}, ${fmt(b.z)}) y=${fmt(b.y)} — ${b.detail}`);
      if (b.tried) lines.push(`  - tried: ${b.tried}`);
    }
    if (this.notes.length) {
      lines.push(``, `## Notes`, ``);
      for (const n of this.notes) lines.push(`- ${n}`);
    }
    if (this.errors.length) {
      lines.push(``, `## Server messages`, ``);
      for (const e of [...new Set(this.errors)]) lines.push(`- ${e}`);
    }
    lines.push(``, `## In-game log`, ``);
    if (this.gameLog.length === 0) lines.push("(none)");
    for (const row of this.gameLog) {
      lines.push(`- t=${fmt(row.t)}s  ${row.message}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  writeReport() {
    mkdirSync(reportDir, { recursive: true });
    const path = resolve(reportDir, `${this.id}.md`);
    writeFileSync(path, this.reportMarkdown(), "utf8");
    return path;
  }

  getBugs() {
    return this.bugs;
  }

  unstuckCount() {
    return this.unstuckLog.length;
  }
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = "true";
  }
  return out;
}

function writeSummary(bots: PlayBot[], wsUrl: string) {
  mkdirSync(reportDir, { recursive: true });
  const lines = [
    `# Gameplay bot summary`,
    ``,
    `- Server: ${wsUrl}`,
    `- Bots ran: ${bots.length}`,
    `- When: ${new Date().toISOString()}`,
    ``,
    `## Bots`,
    ``,
  ];
  for (const b of bots) {
    lines.push(`- ${b.id} (${b.job}) route ${b.routeId} — ${b.getBugs().length} bug(s), ${b.unstuckCount()} unstuck — see ${b.id}.md`);
  }
  lines.push(``, `## Bugs`, ``);
  const all = bots.flatMap((b) => b.getBugs().map((bug) => ({ bot: b.id, job: b.job, bug })));
  if (all.length === 0) lines.push("None observed.");
  for (const row of all) {
    const b = row.bug;
    lines.push(
      `- **${row.bot}** (${row.job}) **${b.kind}** at (${fmt(b.x)}, ${fmt(b.z)}) y=${fmt(b.y)} — ${b.detail}`,
    );
    if (b.tried) lines.push(`  - tried: ${b.tried}`);
  }
  lines.push("");
  const path = resolve(reportDir, "summary.md");
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wsUrl = args.ws ?? "ws://127.0.0.1:8787";
  assertLocalWs(wsUrl);
  const port = Number(new URL(wsUrl).port || 8787);
  const up = await portOpen(port);
  if (!up) {
    console.error(`[play-bot] game server is not accepting TCP on 127.0.0.1:${port}`);
    process.exitCode = 1;
    return;
  }
  const seconds = Number(args.seconds ?? 150);
  const tour = args.tour === "true" || seconds >= 600;
  const specs = args.job
    ? [
        {
          id: args.id ?? `bot-${args.job}`,
          job: args.job as JobId,
          bridge: args.bridge ?? "hub-west-farm",
          biasX: 0,
          route: (args.route as TourId) || "north-spine",
        },
      ]
    : FLEET;

  const bots = specs.map(
    (s) =>
      new PlayBot({
        id: s.id,
        job: s.job,
        bridge: s.bridge,
        biasX: s.biasX,
        wsUrl,
        seconds,
        tour,
        route: s.route,
      }),
  );

  console.log(`[play-bot] ${bots.length} bot(s) for ${seconds}s on ${wsUrl}`);
  const results = await Promise.allSettled(bots.map((b) => b.run()));
  for (let i = 0; i < bots.length; i++) {
    const r = results[i];
    if (r?.status === "rejected") {
      bots[i]!.getBugs().push({
        kind: "disconnect",
        x: 0,
        z: 0,
        y: 0,
        detail: `Bot failed before finishing: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      });
    }
    const path = bots[i]!.writeReport();
    console.log(`[play-bot] wrote ${path} (${bots[i]!.getBugs().length} bugs)`);
  }
  if (!args.job) {
    const summary = writeSummary(bots, wsUrl);
    console.log(`[play-bot] summary ${summary}`);
  } else {
    writeSummary(bots, wsUrl);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
