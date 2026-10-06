import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Single-writer guard for a lok data directory.
 *
 * Two processes that open the same data dir (for example a `tsx watch` dev
 * server started while the `start` server is still up, or a maintenance
 * script) each hold their own in-memory engine and both append to
 * lok-world.jsonl and rewrite lok-world.json / lok-bind.json. The second
 * writer forks the hash chain on disk and the next restart either refuses the
 * journal or silently loses one side. This lock makes the second open fail
 * loudly instead.
 *
 * The lock is advisory: a file `lok-world.lock` holding `{pid, host, startedAt}`
 * created with O_EXCL. A lock whose pid is no longer alive on this host is
 * stale and is taken over. The same pid may re-open its own directory (tests
 * reopen a dir to check replay). Set LOK_ALLOW_SHARED_DATA_DIR=1 to bypass.
 */
export const DATA_DIR_LOCK_FILE = "lok-world.lock";

export type DataDirLockInfo = { pid: number; host: string; startedAt: string };

const held = new Set<string>();
let exitHookInstalled = false;

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function readDataDirLock(dataDir: string): DataDirLockInfo | null {
  const path = join(dataDir, DATA_DIR_LOCK_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DataDirLockInfo>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      host: typeof parsed.host === "string" ? parsed.host : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return { pid: -1, host: "", startedAt: "" };
  }
}

/** True when another live process on this host (or an unknown host) holds the lock. */
export function dataDirLockedByOther(dataDir: string): DataDirLockInfo | null {
  const info = readDataDirLock(dataDir);
  if (!info) return null;
  if (info.host && info.host !== hostname()) return info;
  if (info.pid === process.pid) return null;
  return pidAlive(info.pid) ? info : null;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const path of held) {
      try {
        const info = JSON.parse(readFileSync(path, "utf8")) as Partial<DataDirLockInfo>;
        if (info.pid === process.pid) unlinkSync(path);
      } catch {
        // Best effort: a stale lock is taken over on the next start.
      }
    }
  });
}

/**
 * Take the data-dir lock or throw. Safe to call again from the same process.
 */
export function acquireDataDirLock(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.LOK_ALLOW_SHARED_DATA_DIR === "1") return;
  const path = join(dataDir, DATA_DIR_LOCK_FILE);
  const mine: DataDirLockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(mine), { flag: "wx" });
      held.add(path);
      installExitHook();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    const other = readDataDirLock(dataDir);
    if (other && other.pid === process.pid && (!other.host || other.host === mine.host)) {
      held.add(path);
      installExitHook();
      return;
    }
    if (other && other.host && other.host !== mine.host) {
      throw new Error(
        `lok data dir ${dataDir} is locked by pid ${other.pid} on host ${other.host} (since ${other.startedAt}). ` +
          `Stop that process, or delete ${DATA_DIR_LOCK_FILE} if it is stale, or set LOK_ALLOW_SHARED_DATA_DIR=1.`,
      );
    }
    if (other && pidAlive(other.pid)) {
      throw new Error(
        `lok data dir ${dataDir} is already open by live pid ${other.pid} (since ${other.startedAt}). ` +
          `A second writer would fork the world log. Stop it first, or set LOK_ALLOW_SHARED_DATA_DIR=1.`,
      );
    }
    // Stale (dead pid or unreadable): take it over.
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`could not take the lok data dir lock in ${dataDir}`);
}
