/**
 * Phase 0 baseline. Times LokWorld applies, a background snapshot, and one
 * coalesced tick. Prints JSON. Does not start the game server.
 *
 *   pnpm --filter @bellgrave/server exec tsx scripts/phase0-bench.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { LOG_SNAPSHOT_EVERY, LokWorld } from "../src/lok-world.ts";
import { percentile, SLO_GAME_TICK_MS, SLO_LEDGER_OP_P99_MS } from "../src/phase0-slo.ts";

const OPS = 200;
const BOTS = 8;

function openWorld(): LokWorld {
  return LokWorld.open(mkdtempSync(join(tmpdir(), "phase0-bench-")), undefined, {});
}

function msSince(start: number): number {
  return performance.now() - start;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function main() {
  const applyMs = benchApplies();
  const tickMs = benchCoalescedTick();
  const snapshotMs = await benchSnapshot();
  const applyP50 = percentile(applyMs, 50);
  const applyP99 = percentile(applyMs, 99);
  const report = {
    bots: BOTS,
    ledgerOps: OPS,
    ledgerOpP50Ms: round(applyP50),
    ledgerOpP99Ms: round(applyP99),
    snapshotMs: round(snapshotMs),
    tickMs: round(tickMs),
    slo: {
      ledgerOpP99Ms: SLO_LEDGER_OP_P99_MS,
      gameTickMs: SLO_GAME_TICK_MS,
      ledgerOk: applyP99 < SLO_LEDGER_OP_P99_MS,
      tickOk: tickMs < SLO_GAME_TICK_MS,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.slo.ledgerOk || !report.slo.tickOk) {
    console.error("[phase0-bench] SLO miss (baseline recorded; job stays green)");
  }
}

function benchApplies(): number[] {
  const lok = openWorld();
  const spawned = lok.spawn("bench", "Bench", 0);
  if (!spawned.ok) throw new Error(spawned.error);
  const samples: number[] = [];
  for (let i = 0; i < OPS; i++) {
    const t0 = performance.now();
    const res = lok.goldEarn(spawned.tokenId, "bench", "1", 1);
    samples.push(msSince(t0));
    if (!res.ok) throw new Error(res.error);
  }
  return samples;
}

function benchCoalescedTick(): number {
  const lok = openWorld();
  const tokens: string[] = [];
  for (let i = 0; i < BOTS; i++) {
    const spawned = lok.spawn("bot-" + i, "Bot" + i, i % 7);
    if (!spawned.ok) throw new Error(spawned.error);
    tokens.push(spawned.tokenId);
  }
  const t0 = performance.now();
  lok.beginTick();
  for (const token of tokens) {
    const killed = lok.kill(token, token);
    if (!killed.ok) throw new Error(killed.error);
    for (let n = 0; n < 20; n++) {
      const harvested = lok.harvest(token, "ore", "1");
      if (!harvested.ok) throw new Error(harvested.error);
      const dropped = lok.lootDrop(token, "7", "1", token);
      if (!dropped.ok) throw new Error(dropped.error);
      const earned = lok.goldEarn(token, "drop", "1", 2);
      if (!earned.ok) throw new Error(earned.error);
    }
  }
  const flushed = lok.endTick();
  const tickMs = msSince(t0);
  if (!flushed.ok) throw new Error(flushed.errors.join("; "));
  return tickMs;
}

async function benchSnapshot(): Promise<number> {
  const lok = openWorld();
  const spawned = lok.spawn("bench", "Bench", 0);
  if (!spawned.ok) throw new Error(spawned.error);
  lok.beginTick();
  for (let i = 0; i < LOG_SNAPSHOT_EVERY; i++) {
    const res = lok.goldEarn(spawned.tokenId, "src" + i, "1", 4);
    if (!res.ok) throw new Error(res.error);
  }
  const flushed = lok.endTick();
  if (!flushed.ok) throw new Error(flushed.errors.join("; "));
  const t0 = performance.now();
  await waitImmediate();
  return msSince(t0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
