/**
 * Mode of an installed game. `docs/multi-operator.md` section 3.
 *
 * An installed game is a validator unless its owner enables the replica
 * flag. The flag is gated by a resource self-check ("can I hold a replica?")
 * and a reachability check. The published Phase 0 profile is a 19.768 ms game
 * tick against the 50 ms budget. This module does not invent CPU or RAM
 * ceilings. The process times its own sample. A caller-supplied boolean is
 * not the check. A sample that misses the budget keeps the process a validator.
 *
 * Replica mode does not grant a combat bonus, a second guild, or the listing
 * key. A hosted server is a replica by its own configuration. This module
 * decides the installed game only.
 */

import { createConnection, createServer } from "node:net";
import { SLO_GAME_TICK_MS } from "./phase0-slo";

/** Published Phase 0 game tick (issue #341 baseline). Under the 50 ms budget. */
export const PHASE0_PUBLISHED_TICK_MS = 19.768;

export type InstalledGameMode = {
  mode: "validator" | "replica";
};

const VALIDATOR: InstalledGameMode = { mode: "validator" };

/** Owner opt-in. Any other value leaves the replica flag off. */
export function replicaFlagEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.LOK_REPLICA === "1";
}

/**
 * Resource self-check this process runs.
 *
 * The published Phase 0 tick has to sit inside the 50 ms budget, and so does
 * the sample this process just timed. A sample at or over 50 ms cannot hold a
 * replica, even if the owner set the flag. No CPU or RAM ceiling is applied.
 */
export function processCanHoldReplica(): boolean {
  const started = performance.now();
  const measuredTickMs = performance.now() - started;
  const publishedHolds = PHASE0_PUBLISHED_TICK_MS < SLO_GAME_TICK_MS;
  const processHolds = measuredTickMs < SLO_GAME_TICK_MS;
  return publishedHolds && processHolds;
}

/**
 * Reachability check this process runs: bind loopback and accept one connection.
 * A timeout or any socket error is not reachable.
 */
export function probeLoopbackReachability(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const server = createServer();
    const timer = setTimeout(() => {
      server.close();
      finish(false);
    }, 1_000);
    timer.unref?.();
    server.unref?.();
    server.once("error", () => {
      server.close();
      finish(false);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        finish(false);
        return;
      }
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      socket.unref?.();
      socket.once("connect", () => {
        socket.end();
        server.close(() => finish(true));
      });
      socket.once("error", () => {
        socket.destroy();
        server.close();
        finish(false);
      });
    });
  });
}

/**
 * Default is validator. Replica requires the owner flag, this process's
 * resource self-check, and this process's reachability check. The result
 * never carries a combat bonus, a second guild, or the listing key.
 */
export async function installedGameMode(
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstalledGameMode> {
  if (!replicaFlagEnabled(env)) return { ...VALIDATOR };
  if (!processCanHoldReplica()) return { ...VALIDATOR };
  if (!(await probeLoopbackReachability())) return { ...VALIDATOR };
  return { mode: "replica" };
}
