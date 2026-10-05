/**
 * Knight ability resolution — shield tank kit from KNIGHT_ABILITIES.
 * Motifs: silver flash, crimson shield, pale-gold divine.
 */
import {
  KNIGHT_ABILITIES,
  isKnightAbilityId,
  type KnightAbilityId,
} from "@bellgrave/combat";
import { SIGNATURE_WEAPON_IDS, signatureWeaponEquipped } from "./starter-kit";
import { kitLevel } from "./support-job";
import type { AbilityId } from "@bellgrave/protocol";

export type KnightPlayer = {
  level: number;
  job: string;
  mp: number;
  maxMp: number;
  hp: number;
  maxHp: number;
  tp: number;
  equip: import("@bellgrave/items").Equipment;
  inventory: { tokenId: number; amount: number }[];
  anim: string;
  animUntil: number;
  moveTo: { x: number; z: number } | null;
  targetId: string | null;
  facing: number;
  x: number;
  z: number;
  recasts: Partial<Record<AbilityId, number>>;
  bulwarkUntil: number;
  sentinelUntil: number;
  rampartUntil: number;
  coverUntil: number;
  fealtyUntil: number;
  guardianUntil: number;
  protectUntil: number;
  protectPhysMul: number;
  shellUntil: number;
  shellMagMul: number;
  bulwarkFlashUntil: number;
  /** Enmity scalar for mob targeting preference. */
  enmity: number;
};

export type KnightMob = {
  id: string;
  name?: string;
  alive: boolean;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  targetId: string | null;
  nextSwingAt: number;
  stunUntil: number;
  blindUntil: number;
};

export type KnightHooks = {
  pushLog: (p: KnightPlayer, msg: string) => void;
  stopRest: (p: KnightPlayer, reason?: string) => void;
  facingTo: (ax: number, az: number, bx: number, bz: number) => number;
  findMob: (id: string | null | undefined) => KnightMob | null;
  allMobs: () => KnightMob[];
  allPlayers: () => KnightPlayer[];
  onMobKill: (p: KnightPlayer, m: KnightMob, now: number) => void;
  dist: (ax: number, az: number, bx: number, bz: number) => number;
  playerCombatStats: (p: KnightPlayer) => {
    str: number;
    dex: number;
    vit: number;
    agi: number;
    int: number;
    mnd: number;
  };
};


export function swordEquipped(p: KnightPlayer): boolean {
  return signatureWeaponEquipped(p, SIGNATURE_WEAPON_IDS.knight);
}

/** Combined physical damage-taken multiplier from Knight DT buffs. */
export function knightPhysDtMul(p: KnightPlayer, now: number): number {
  let mul = 1;
  if (now < p.bulwarkUntil) mul = 0;
  else {
    if (now < p.sentinelUntil) mul *= 0.5;
    if (now < p.coverUntil) mul *= 0.75;
    if (now < p.rampartUntil) mul *= 0.75;
    if (now < p.guardianUntil) mul *= 0.65;
    if (now < p.protectUntil) mul *= p.protectPhysMul;
  }
  return Math.max(0, Math.min(1, mul));
}

export function knightMagDtMul(p: KnightPlayer, now: number): number {
  let mul = 1;
  if (now < p.fealtyUntil) mul *= 0.5;
  if (now < p.shellUntil) mul *= p.shellMagMul;
  return Math.max(0.1, Math.min(1, mul));
}

function spikeEnmity(p: KnightPlayer, amount: number) {
  p.enmity = Math.min(10_000, p.enmity + amount);
}

function pullMob(p: KnightPlayer, m: KnightMob, amount: number) {
  spikeEnmity(p, amount);
  m.targetId = (p as { wallet?: string }).wallet ?? m.targetId;
}

function divineNuke(p: KnightPlayer, potency: number, stats: { mnd: number; str: number }): number {
  const { mnd, str } = stats;
  return Math.max(1, Math.floor(potency * 0.35 + mnd * 2.2 + str * 0.4));
}

/**
 * Resolve a Knight ability. Returns true if handled (including failures with log).
 */
export function resolveKnightAbility(
  p: KnightPlayer & { wallet: string },
  id: AbilityId,
  targetId: string | undefined,
  now: number,
  hooks: KnightHooks,
): boolean {
  if (p.job !== "knight" && (p as { subjob?: string | null }).subjob !== "knight") return false;
  if (!isKnightAbilityId(id)) {
    hooks.pushLog(p, "That is not a Knight ability.");
    return true;
  }

  const def = KNIGHT_ABILITIES[id];
  if (def.unlockLevel > kitLevel(p, "knight")) {
    hooks.pushLog(p, `${def.label} unlocks at level ${def.unlockLevel}.`);
    return true;
  }

  const combatStats = hooks.playerCombatStats(p);

  const readyAt = p.recasts[id] ?? 0;
  if (now < readyAt) {
    hooks.pushLog(p, `${def.label} not ready.`);
    return true;
  }
  if (p.mp < def.mp) {
    hooks.pushLog(p, "Not enough MP.");
    return true;
  }
  // Signature weapon only when this job is main (support dual-job skips it).
  if (def.weaponRequired && p.job === "knight" && !swordEquipped(p)) {
    hooks.pushLog(p, "Equip your sword first.");
    return true;
  }

  const spend = () => {
    p.mp -= def.mp;
    if (def.recastMs > 0) p.recasts[id] = now + def.recastMs;
  };

  // —— Rest ——
  if (id === "rest") {
    if (p.anim === "rest") {
      hooks.stopRest(p);
      hooks.pushLog(p, "You stand.");
      return true;
    }
    p.moveTo = null;
    p.targetId = null;
    p.anim = "rest";
    p.animUntil = now + 60_000;
    hooks.pushLog(p, "You kneel and recover.");
    return true;
  }

  hooks.stopRest(p);

  // —— Bulwark ——
  if (id === "bulwark") {
    spend();
    p.bulwarkUntil = now + (def.durationMs ?? 30_000);
    p.bulwarkFlashUntil = now + 2200;
    spikeEnmity(p, 400);
    p.anim = "cast";
    p.animUntil = now + 600;
    hooks.pushLog(p, `${def.label} — no steel shall pass.`);
    return true;
  }

  // —— Warhorn ——
  if (id === "provoke") {
    const tid = targetId ?? p.targetId;
    const m = hooks.findMob(tid);
    if (!m || !m.alive) {
      hooks.pushLog(p, "No target.");
      return true;
    }
    if (hooks.dist(p.x, p.z, m.x, m.z) > (def.range ?? 14)) {
      hooks.pushLog(p, "Too far.");
      return true;
    }
    spend();
    p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);
    m.targetId = p.wallet;
    spikeEnmity(p, 800);
    p.anim = "cast";
    p.animUntil = now + 400;
    hooks.pushLog(p, `${def.label} — ${(m.name ?? "enemy")} turns on you!`);
    return true;
  }

  // —— Buckler Crash ——
  if (id === "shield_bash") {
    const tid = targetId ?? p.targetId;
    const m = hooks.findMob(tid);
    if (!m || !m.alive) {
      hooks.pushLog(p, "No target.");
      return true;
    }
    if (hooks.dist(p.x, p.z, m.x, m.z) > (def.range ?? 3)) {
      hooks.pushLog(p, "Too far.");
      return true;
    }
    spend();
    p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);
    const { str, vit } = combatStats;
    const dmg = Math.max(1, Math.floor((def.potency ?? 28) + str * 0.8 + vit * 0.3));
    m.hp -= dmg;
    m.stunUntil = now + (def.durationMs ?? 5_000);
    m.targetId = p.wallet;
    spikeEnmity(p, 350);
    p.anim = "melee";
    p.animUntil = now + 480;
    p.tp = Math.min(3000, p.tp + 100);
    hooks.pushLog(p, `${def.label} — ${dmg} and stun!`);
    if (m.hp <= 0) hooks.onMobKill(p, m, now);
    return true;
  }

  // —— Interpose / Holdfast / Oathbound / Bastion / Hall Aegis ——
  if (id === "cover") {
    spend();
    p.coverUntil = now + (def.durationMs ?? 15_000);
    spikeEnmity(p, 200);
    p.anim = "cast";
    p.animUntil = now + 450;
    hooks.pushLog(p, `${def.label} — you take the blow.`);
    return true;
  }
  if (id === "sentinel") {
    spend();
    p.sentinelUntil = now + (def.durationMs ?? 30_000);
    spikeEnmity(p, 500);
    p.bulwarkFlashUntil = now + 1800;
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} — hold the line!`);
    return true;
  }
  if (id === "fealty") {
    spend();
    p.fealtyUntil = now + (def.durationMs ?? 60_000);
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} — magic falters against your vow.`);
    return true;
  }
  if (id === "rampart") {
    spend();
    const dur = def.durationMs ?? 30_000;
    const r = def.aoe ?? 10;
    for (const ally of hooks.allPlayers()) {
      if (hooks.dist(p.x, p.z, ally.x, ally.z) <= r) {
        ally.rampartUntil = now + dur;
      }
    }
    spikeEnmity(p, 300);
    p.anim = "cast";
    p.animUntil = now + 550;
    hooks.pushLog(p, `${def.label} — the wall rises!`);
    return true;
  }
  if (id === "guardian") {
    spend();
    const dur = def.durationMs ?? 20_000;
    const r = def.aoe ?? 12;
    for (const ally of hooks.allPlayers()) {
      if (hooks.dist(p.x, p.z, ally.x, ally.z) <= r) {
        ally.guardianUntil = now + dur;
        ally.coverUntil = Math.max(ally.coverUntil, now + dur);
      }
    }
    spikeEnmity(p, 600);
    p.bulwarkFlashUntil = now + 2000;
    p.anim = "cast";
    p.animUntil = now + 600;
    hooks.pushLog(p, `${def.label} — none shall fall!`);
    return true;
  }

  // —— Valor Tithe ——
  if (id === "chivalry") {
    if (p.tp < 500) {
      hooks.pushLog(p, "Need more TP.");
      return true;
    }
    spend();
    const converted = Math.min(p.tp, 1500);
    const mpGain = Math.floor(converted / 10);
    p.tp -= converted;
    p.mp = Math.min(p.maxMp, p.mp + mpGain);
    p.anim = "cast";
    p.animUntil = now + 450;
    hooks.pushLog(p, `${def.label} — +${mpGain} MP from fighting spirit.`);
    return true;
  }

  // —— Cures ——
  if (id === "kn_cure" || id === "kn_cure_ii" || id === "kn_cure_iii" || id === "kn_cure_iv") {
    spend();
    const heal = Math.floor((def.heal ?? 45) + combatStats.mnd * 1.5);
    p.hp = Math.min(p.maxHp, p.hp + heal);
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} — recover ${heal} HP.`);
    return true;
  }

  // —— Protect / Shell ——
  if (
    id === "kn_protect" ||
    id === "kn_protect_ii" ||
    id === "kn_protect_iii"
  ) {
    spend();
    p.protectUntil = now + (def.durationMs ?? 180_000);
    p.protectPhysMul = def.physDt ?? 0.9;
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} — physical ward.`);
    return true;
  }
  if (id === "kn_shell" || id === "kn_shell_ii" || id === "kn_shell_iii") {
    spend();
    p.shellUntil = now + (def.durationMs ?? 180_000);
    p.shellMagMul = def.magDt ?? 0.9;
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} — magic ward.`);
    return true;
  }

  // —— Flash ——
  if (id === "kn_flash") {
    spend();
    const r = def.aoe ?? 8;
    let hit = 0;
    for (const m of hooks.allMobs()) {
      if (!m.alive) continue;
      if (hooks.dist(p.x, p.z, m.x, m.z) > r) continue;
      m.blindUntil = now + (def.durationMs ?? 12_000);
      m.targetId = p.wallet;
      hit++;
    }
    spikeEnmity(p, 900 + hit * 100);
    p.anim = "cast";
    p.animUntil = now + 550;
    hooks.pushLog(p, hit ? `${def.label} — ${hit} blinded!` : `${def.label} — nothing nearby.`);
    return true;
  }

  // —— Ashlight / Pale Judgment ——
  if (id === "kn_banish" || id === "kn_banish_ii" || id === "kn_holy") {
    const tid = targetId ?? p.targetId;
    const m = hooks.findMob(tid);
    if (!m || !m.alive) {
      hooks.pushLog(p, "No target.");
      return true;
    }
    if (hooks.dist(p.x, p.z, m.x, m.z) > (def.range ?? 12)) {
      hooks.pushLog(p, "Too far.");
      return true;
    }
    spend();
    p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);
    const dmg = divineNuke(p, def.potency ?? 55, combatStats);
    m.hp -= dmg;
    m.targetId = p.wallet;
    spikeEnmity(p, id === "kn_holy" ? 1200 : 450);
    p.anim = "cast";
    p.animUntil = now + 600;
    hooks.pushLog(p, `${def.label} — ${dmg} ashlight damage!`);
    if (m.hp <= 0) hooks.onMobKill(p, m, now);
    return true;
  }

  hooks.pushLog(p, `${def.label} is not ready in this build.`);
  return true;
}

/** Clear Knight-specific buffs on job change. */
export function clearKnightBuffs(p: KnightPlayer) {
  p.bulwarkUntil = 0;
  p.sentinelUntil = 0;
  p.rampartUntil = 0;
  p.coverUntil = 0;
  p.fealtyUntil = 0;
  p.guardianUntil = 0;
  p.protectUntil = 0;
  p.protectPhysMul = 1;
  p.shellUntil = 0;
  p.shellMagMul = 1;
  p.bulwarkFlashUntil = 0;
  p.enmity = 0;
}
