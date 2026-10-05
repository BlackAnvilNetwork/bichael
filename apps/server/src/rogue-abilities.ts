/**
 * Rogue ability resolution — evasion / crit kit from ROGUE_ABILITIES.
 */
import {
  ROGUE_ABILITIES,
  isRogueAbilityId,
  physicalDamage,
  fStr,
  defenseFromVit,
  jobStatsAtLevel,
  isJobId,
  type JobId,
} from "@bellgrave/combat";
import { SIGNATURE_WEAPON_IDS, signatureWeaponEquipped } from "./starter-kit";
import { kitLevel } from "./support-job";
import type { AbilityId } from "@bellgrave/protocol";

export type RoguePlayer = {
  level: number;
  job: string;
  hp: number;
  maxHp: number;
  tp: number;
  dust: number;
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
  ghostStepUntil: number;
  backbladeUntil: number;
  killEdgeUntil: number;
  shadowPassUntil: number;
  moveUntil: number;
  movePct: number;
  enmity: number;
};

export type RogueMob = {
  id: string;
  name?: string;
  alive: boolean;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  targetId: string | null;
  falseGuardUntil: number;
  /** Authored/spawn level — used for defense (Fixes #77). */
  level: number;
  job: JobId | string;
};

export type RogueHooks = {
  pushLog: (p: RoguePlayer, msg: string) => void;
  stopRest: (p: RoguePlayer, reason?: string) => void;
  facingTo: (ax: number, az: number, bx: number, bz: number) => number;
  findMob: (id: string | null | undefined) => RogueMob | null;
  allMobs: () => RogueMob[];
  onMobKill: (p: RoguePlayer, m: RogueMob, now: number) => void;
  dist: (ax: number, az: number, bx: number, bz: number) => number;
  playerCombatStats: (p: RoguePlayer) => {
    str: number;
    dex: number;
    vit: number;
    agi: number;
    int: number;
    mnd: number;
  };
};


export function daggerEquipped(p: RoguePlayer): boolean {
  return signatureWeaponEquipped(p, SIGNATURE_WEAPON_IDS.rogue);
}

export function resolveRogueAbility(
  p: RoguePlayer & { wallet: string },
  id: AbilityId,
  targetId: string | undefined,
  now: number,
  hooks: RogueHooks,
): boolean {
  if (p.job !== "rogue" && (p as { subjob?: string | null }).subjob !== "rogue") return false;
  if (!isRogueAbilityId(id)) {
    hooks.pushLog(p, "That is not a Rogue ability.");
    return true;
  }

  const def = ROGUE_ABILITIES[id];
  if (def.unlockLevel > kitLevel(p, "rogue")) {
    hooks.pushLog(p, `${def.label} unlocks at level ${def.unlockLevel}.`);
    return true;
  }

  const readyAt = p.recasts[id] ?? 0;
  if (now < readyAt) {
    hooks.pushLog(p, `${def.label} not ready.`);
    return true;
  }
  // Signature weapon only when this job is main (support dual-job skips it).
  if (def.weaponRequired && p.job === "rogue" && !daggerEquipped(p)) {
    hooks.pushLog(p, "Equip your dagger first.");
    return true;
  }

  const spend = () => {
    if (def.recastMs > 0) p.recasts[id] = now + def.recastMs;
  };

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

  if (id === "ghost_step") {
    spend();
    p.ghostStepUntil = now + (def.durationMs ?? 30_000);
    p.enmity = 0;
    p.anim = "cast";
    p.animUntil = now + 500;
    // Drop combat lock — mobs stop chasing / targeting you.
    for (const m of hooks.allMobs()) {
      if (m.targetId === p.wallet) m.targetId = null;
    }
    hooks.pushLog(p, `${def.label} — violet smoke; they lose you.`);
    return true;
  }

  if (id === "backblade") {
    spend();
    p.backbladeUntil = now + (def.durationMs ?? 30_000);
    p.anim = "melee";
    p.animUntil = now + 420;
    hooks.pushLog(p, `${def.label} — next strike from the shadows.`);
    return true;
  }

  if (id === "dust_runner") {
    spend();
    p.moveUntil = now + (def.durationMs ?? 30_000);
    p.movePct = 0.5;
    p.anim = "cast";
    p.animUntil = now + 400;
    hooks.pushLog(p, `${def.label} — you sprint through ash.`);
    return true;
  }

  if (id === "shadow_pass") {
    spend();
    p.shadowPassUntil = now + (def.durationMs ?? 30_000);
    p.anim = "cast";
    p.animUntil = now + 450;
    hooks.pushLog(p, `${def.label} — your next hit sheds hate.`);
    return true;
  }

  if (id === "kill_edge") {
    spend();
    p.killEdgeUntil = now + (def.durationMs ?? 30_000);
    p.anim = "melee";
    p.animUntil = now + 420;
    hooks.pushLog(p, `${def.label} — edge honed for a killing blow.`);
    return true;
  }

  if (id === "blame_shift") {
    spend();
    p.enmity = 0;
    p.anim = "cast";
    p.animUntil = now + 400;
    for (const m of hooks.allMobs()) {
      if (m.targetId === p.wallet) m.targetId = null;
    }
    hooks.pushLog(p, `${def.label} — hate slips away.`);
    return true;
  }

  if (id === "purse_cut") {
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
    const stolen = 8 + Math.floor(Math.random() * 13);
    p.dust += stolen;
    p.anim = "melee";
    p.animUntil = now + 480;
    hooks.pushLog(p, `${def.label} — +${stolen} Dust from ${m.name ?? "foe"}.`);
    return true;
  }

  if (id === "lifetap") {
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
    const { str, dex } = hooks.playerCombatStats(p);
    const att = Math.max(1, Math.floor(str + dex * 0.4 + 10));
    const job: JobId = isJobId(String(m.job)) ? (m.job as JobId) : "fighter";
    const level = Math.max(1, m.level ?? 1);
    const mobStats = jobStatsAtLevel(job, level);
    const mobDef = defenseFromVit(mobStats.vit);
    const dmg = physicalDamage(att, mobDef, fStr(str, mobStats.vit), false);
    m.hp -= dmg;
    const heal = Math.min(p.maxHp - p.hp, Math.floor(dmg * 0.85));
    p.hp += heal;
    p.anim = "melee";
    p.animUntil = now + 480;
    p.tp = Math.min(3000, p.tp + 60);
    hooks.pushLog(p, `${def.label} — ${dmg} damage, recover ${heal} HP.`);
    if (m.hp <= 0) hooks.onMobKill(p, m, now);
    return true;
  }

  if (id === "false_guard") {
    const tid = targetId ?? p.targetId;
    const m = hooks.findMob(tid);
    if (!m || !m.alive) {
      hooks.pushLog(p, "No target.");
      return true;
    }
    if (hooks.dist(p.x, p.z, m.x, m.z) > (def.range ?? 8)) {
      hooks.pushLog(p, "Too far.");
      return true;
    }
    spend();
    p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);
    m.falseGuardUntil = now + (def.durationMs ?? 30_000);
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} — ${m.name ?? "foe"} guard feinted open.`);
    return true;
  }

  hooks.pushLog(p, `${def.label} is not ready in this build.`);
  return true;
}

export function clearRogueBuffs(p: RoguePlayer) {
  p.ghostStepUntil = 0;
  p.backbladeUntil = 0;
  p.killEdgeUntil = 0;
  p.shadowPassUntil = 0;
  p.moveUntil = 0;
  p.movePct = 0;
  p.enmity = 0;
}
