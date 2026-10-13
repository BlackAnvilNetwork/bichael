/**
 * #79 — Knight Interpose / Hall Aegis redirect physical autos to the Knight.
 * Pure helpers only; no server boot, no data dir.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTERPOSE_RANGE,
  clearKnightBuffs,
  findInterposeGuard,
  isInterposing,
  resolveKnightAbility,
  type InterposeUnit,
} from "./knight-abilities";
import { mobAutoIsMagic } from "./mob-job-ai";

const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

function unit(wallet: string, x: number, extra: Partial<InterposeUnit> = {}): InterposeUnit {
  return { wallet, hp: 100, x, z: 0, zoneId: "pale_hollow", coverGuardUntil: 0, ...extra };
}

function knight(extra: Record<string, unknown> = {}) {
  return {
    wallet: "0xknight",
    job: "knight",
    subjob: null,
    level: 75,
    mp: 999,
    maxMp: 999,
    hp: 500,
    maxHp: 500,
    tp: 0,
    x: 0,
    z: 0,
    recasts: {},
    enmity: 0,
    anim: "idle",
    animUntil: 0,
    coverUntil: 0,
    guardianUntil: 0,
    coverGuardUntil: 0,
    ...extra,
  };
}

function hooks(players: unknown[] = []) {
  const logs: string[] = [];
  return {
    logs,
    h: {
      pushLog: (_p: unknown, m: string) => logs.push(m),
      stopRest: () => {},
      playerCombatStats: () => ({ str: 10, dex: 10, vit: 10, agi: 10, int: 10, mnd: 10 }),
      allPlayers: () => players,
      dist,
    } as never,
  };
}

test("Interpose arms the bodyguard window on the casting Knight", () => {
  const p = knight();
  const { h } = hooks();
  assert.equal(resolveKnightAbility(p as never, "cover", undefined, 10_000, h), true);
  assert.equal(p.coverUntil, 25_000);
  assert.equal(p.coverGuardUntil, 25_000);
  assert.equal(isInterposing(p as never, 24_999), true);
  assert.equal(isInterposing(p as never, 25_000), false);
});

test("Hall Aegis: caster bodyguards; allies only get the DT cover, not the redirect", () => {
  const p = knight();
  const ally = { ...knight({ wallet: "0xally", job: "cleric" }), x: 3 };
  const { h } = hooks([p, ally]);
  assert.equal(resolveKnightAbility(p as never, "guardian", undefined, 1_000, h), true);
  assert.equal(p.coverGuardUntil, 21_000);
  assert.equal(ally.coverUntil, 21_000);
  assert.equal(ally.coverGuardUntil, 0);
});

test("clearKnightBuffs drops the bodyguard window", () => {
  const p = knight({ coverUntil: 9e9, coverGuardUntil: 9e9 });
  clearKnightBuffs(p as never);
  assert.equal(p.coverGuardUntil, 0);
});

test("active Interpose in range redirects to the Knight", () => {
  const ally = unit("0xally", 0);
  const kn = unit("0xknight", INTERPOSE_RANGE - 0.5, { coverGuardUntil: 5_000 });
  assert.equal(findInterposeGuard(ally, [ally, kn], 1_000, dist), kn);
  // Exactly at the edge still counts.
  const edge = unit("0xedge", INTERPOSE_RANGE, { coverGuardUntil: 5_000 });
  assert.equal(findInterposeGuard(ally, [ally, edge], 1_000, dist), edge);
});

test("no redirect when expired, out of range, dead, or in another zone", () => {
  const ally = unit("0xally", 0);
  const expired = unit("0xa", 1, { coverGuardUntil: 1_000 });
  const far = unit("0xb", INTERPOSE_RANGE + 0.01, { coverGuardUntil: 5_000 });
  const dead = unit("0xc", 1, { coverGuardUntil: 5_000, hp: 0 });
  const elsewhere = unit("0xd", 1, { coverGuardUntil: 5_000, zoneId: "other_zone" });
  const idle = unit("0xe", 1);
  assert.equal(findInterposeGuard(ally, [ally, expired, far, dead, elsewhere, idle], 1_000, dist), null);
});

test("never redirects a hit to its own target, and a downed target gets no cover", () => {
  const kn = unit("0xknight", 0, { coverGuardUntil: 5_000 });
  assert.equal(findInterposeGuard(kn, [kn], 1_000, dist), null);
  const ally = unit("0xally", 1, { hp: 0 });
  assert.equal(findInterposeGuard(ally, [ally, kn], 1_000, dist), null);
});

test("nearest guard wins; ties break on wallet", () => {
  const ally = unit("0xally", 0);
  const near = unit("0xnear", 2, { coverGuardUntil: 5_000 });
  const farther = unit("0xfar", 5, { coverGuardUntil: 5_000 });
  assert.equal(findInterposeGuard(ally, [ally, farther, near], 1_000, dist), near);
  const b = unit("0xbb", -3, { coverGuardUntil: 5_000 });
  const a = unit("0xaa", 3, { coverGuardUntil: 5_000 });
  assert.equal(findInterposeGuard(ally, [ally, b, a], 1_000, dist), a);
});

test("one hop only: a guard covered by another guard does not chain the redirect", () => {
  // B guards A; C guards B (in range of B, out of range of A).
  const a = unit("0xa", 0);
  const b = unit("0xb", 6, { coverGuardUntil: 5_000 });
  const c = unit("0xc", 12, { coverGuardUntil: 5_000 });
  const all = [a, b, c];
  const guard = findInterposeGuard(a, all, 1_000, dist);
  assert.equal(guard, b);
  // The server resolves the hit on `guard` directly; C would only matter if
  // the lookup ran again, which mobSwing never does for a redirected hit.
  assert.notEqual(guard, c);
});

test("only physical autos are eligible: magic autos stay on their target", () => {
  assert.equal(mobAutoIsMagic({ job: "sorcerer", silenceUntil: 0 }, 1_000), true);
  assert.equal(mobAutoIsMagic({ job: "cleric", silenceUntil: 0 }, 1_000), true);
  // Silenced casters swing in melee — physical, so Interpose can take it.
  assert.equal(mobAutoIsMagic({ job: "sorcerer", silenceUntil: 2_000 }, 1_000), false);
  assert.equal(mobAutoIsMagic({ job: "knight", silenceUntil: 0 }, 1_000), false);
  assert.equal(mobAutoIsMagic({ job: "fighter", silenceUntil: 0 }, 1_000), false);
});
