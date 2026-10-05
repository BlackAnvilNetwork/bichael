/**
 * Server-side gather channel (#67).
 *
 * A gather click starts a channel that lasts the node's `interactMs`. The item is
 * granted only when the channel completes, and the channel breaks if the player
 * moves, takes damage, or engages a target first.
 */

/** Max distance (world units) between a player and a gather node. */
export const GATHER_RANGE = 3.2;

/** Movement allowed during a channel before it breaks (absorbs float jitter). */
export const GATHER_MOVE_TOLERANCE = 0.25;

/** Shortest channel the server accepts, even if a node authors a smaller value. */
export const GATHER_MIN_CHANNEL_MS = 500;

export type GatherChannel = {
  nodeId: string;
  /** Spawn slot the node held when the channel started (a relocate voids the channel). */
  spawnPointId: string;
  nodeName: string;
  startedAt: number;
  readyAt: number;
  /** Player position when the channel started. */
  x: number;
  z: number;
  /** Highest HP seen during the channel; any drop below it is damage. */
  hp: number;
};

export type GatherActor = { x: number; z: number; hp: number; engaged: boolean };

export type GatherStep =
  | { kind: "pending" }
  | { kind: "cancel"; reason: string }
  | { kind: "complete" };

export function gatherChannelMs(interactMs: number): number {
  if (!Number.isFinite(interactMs)) return GATHER_MIN_CHANNEL_MS;
  return Math.max(GATHER_MIN_CHANNEL_MS, Math.floor(interactMs));
}

export function beginGatherChannel(
  node: { id: string; spawnPointId: string; name: string; interactMs: number },
  actor: { x: number; z: number; hp: number },
  now: number,
): GatherChannel {
  return {
    nodeId: node.id,
    spawnPointId: node.spawnPointId,
    nodeName: node.name,
    startedAt: now,
    readyAt: now + gatherChannelMs(node.interactMs),
    x: actor.x,
    z: actor.z,
    hp: actor.hp,
  };
}

/** Advance a channel one tick. Mutates the HP high-water mark while pending. */
export function tickGatherChannel(ch: GatherChannel, actor: GatherActor, now: number): GatherStep {
  if (actor.hp <= 0 || actor.hp < ch.hp) {
    return { kind: "cancel", reason: `Gathering ${ch.nodeName} interrupted: you took damage.` };
  }
  if (Math.hypot(actor.x - ch.x, actor.z - ch.z) > GATHER_MOVE_TOLERANCE) {
    return { kind: "cancel", reason: `Gathering ${ch.nodeName} interrupted: you moved.` };
  }
  if (actor.engaged) {
    return { kind: "cancel", reason: `Gathering ${ch.nodeName} interrupted: you engaged a target.` };
  }
  if (now < ch.readyAt) {
    ch.hp = Math.max(ch.hp, actor.hp);
    return { kind: "pending" };
  }
  return { kind: "complete" };
}
