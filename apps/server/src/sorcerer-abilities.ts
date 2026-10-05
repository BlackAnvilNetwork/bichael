/**
 * Sorcerer ability resolution â€” elemental nuker kit.
 * Motifs: violet/blue cast windows + per-element impact colors (not TIM teal).
 */
import {
  SORCERER_ABILITIES,
  isSorcererAbilityId,
  type SorcererAbilityId,
  type SorcererElement,
} from "@bellgrave/combat";
import { PH_HUB_SPAWN, paleHollowStandHeight } from "@bellgrave/config";
import { SIGNATURE_WEAPON_IDS, signatureWeaponEquipped } from "./starter-kit";
import { kitLevel } from "./support-job";
import { withGearMab } from "./gear-combat";
import type { AbilityId } from "@bellgrave/protocol";

export type SorcererPlayer = {
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
  y: number;
  z: number;
  recasts: Partial<Record<AbilityId, number>>;
  arcaneFloodUntil: number;
  elementalSealUntil: number;
  manaWallUntil: number;
  manawellReady: boolean;
  cascadeUntil: number;
  focalNeveUntil: number;
  enmity: number;
  /** Last elemental nuke element â€” for client VFX hue. */
  lastScElement: SorcererElement | null;
  scCastFlashUntil: number;
};

export type SorcererMob = {
  id: string;
  name?: string;
  alive: boolean;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  mp?: number;
  targetId: string | null;
  nextSwingAt: number;
  stunUntil: number;
  blindUntil: number;
  bindUntil: number;
  sleepUntil: number;
  falseGuardUntil?: number;
  scImpactUntil: number;
  scImpactElement: SorcererElement | null;
};

export type SorcererHooks = {
  pushLog: (p: SorcererPlayer, msg: string) => void;
  stopRest: (p: SorcererPlayer, reason?: string) => void;
  facingTo: (ax: number, az: number, bx: number, bz: number) => number;
  findMob: (id: string | null | undefined) => SorcererMob | null;
  allMobs: () => SorcererMob[];
  onMobKill: (p: SorcererPlayer, m: SorcererMob, now: number) => void;
  dist: (ax: number, az: number, bx: number, bz: number) => number;
  playerCombatStats: (p: SorcererPlayer) => {
    str: number;
    dex: number;
    vit: number;
    agi: number;
    int: number;
    mnd: number;
  };
};


export function staffEquipped(p: SorcererPlayer): boolean {
  return signatureWeaponEquipped(p, SIGNATURE_WEAPON_IDS.sorcerer);
}


function elementalDamage(
  p: SorcererPlayer,
  potency: number,
  now: number,
  cascadeBonus: boolean,
  combatStats: { int: number; mnd: number },
): number {
  const { int, mnd } = combatStats;
  let base = potency * 0.52 + int * 2.85 + mnd * 0.35;
  if (now < p.elementalSealUntil) base *= 1.45;
  if (now < p.focalNeveUntil) base *= 1.22;
  if (cascadeBonus) base *= 1.35;
  return withGearMab(p, Math.max(1, Math.floor(base)));
}

function spendMp(p: SorcererPlayer, cost: number, now: number): boolean {
  if (now < p.arcaneFloodUntil) return true;
  if (p.manawellReady && cost > 0) {
    p.manawellReady = false;
    return true;
  }
  if (p.mp < cost) return false;
  p.mp -= cost;
  return true;
}

function mobsInRadius(mobs: SorcererMob[], x: number, z: number, r: number): SorcererMob[] {
  return mobs.filter((m) => m.alive && Math.hypot(m.x - x, m.z - z) <= r);
}

function applyNukeHit(
  p: SorcererPlayer,
  m: SorcererMob,
  dmg: number,
  element: SorcererElement,
  now: number,
) {
  m.hp = Math.max(0, m.hp - dmg);
  m.scImpactUntil = now + 900;
  m.scImpactElement = element;
  p.enmity = Math.min(10_000, p.enmity + Math.floor(dmg * 0.35));
}

export function clearSorcererBuffs(p: SorcererPlayer) {
  p.arcaneFloodUntil = 0;
  p.elementalSealUntil = 0;
  p.manaWallUntil = 0;
  p.manawellReady = false;
  p.cascadeUntil = 0;
  p.focalNeveUntil = 0;
  p.lastScElement = null;
  p.scCastFlashUntil = 0;
}

export function resolveSorcererAbility(
  p: SorcererPlayer & { wallet: string },
  id: AbilityId,
  targetId: string | undefined,
  now: number,
  hooks: SorcererHooks,
): boolean {
  if (p.job !== "sorcerer" && (p as { subjob?: string | null }).subjob !== "sorcerer") return false;
  if (!isSorcererAbilityId(id)) {
    hooks.pushLog(p, "That is not a Sorcerer ability.");
    return true;
  }

  const def = SORCERER_ABILITIES[id];
  const combatStats = hooks.playerCombatStats(p);
  const effLevel = kitLevel(p, "sorcerer");
  if (effLevel < def.unlockLevel) {
    hooks.pushLog(p, `${def.label} unlocks at level ${def.unlockLevel}.`);
    return true;
  }

  const readyAt = p.recasts[id] ?? 0;
  if (now < readyAt) {
    hooks.pushLog(p, `${def.label} not ready.`);
    return true;
  }

  // Signature staff only when this job is main (support dual-job skips it).
  if (def.staffRequired && p.job === "sorcerer" && !staffEquipped(p)) {
    hooks.pushLog(p, "Equip your staff first.");
    return true;
  }

  const payRecast = () => {
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
    hooks.pushLog(p, "You kneel among the runes and recover.");
    return true;
  }

  hooks.stopRest(p);

  const mpCost = def.mp;
  if (mpCost > 0 && now >= p.arcaneFloodUntil && !p.manawellReady && p.mp < mpCost) {
    hooks.pushLog(p, "Not enough MP.");
    return true;
  }

  // â€”â€” Job abilities â€”â€”
  if (id === "arcane_flood") {
    payRecast();
    p.arcaneFloodUntil = now + (def.durationMs ?? 60_000);
    p.scCastFlashUntil = now + 1200;
    p.anim = "cast";
    p.animUntil = now + 700;
    hooks.pushLog(p, `${def.label} â€” the neve opens; cast without cost!`);
    return true;
  }
  if (id === "elemental_seal") {
    payRecast();
    p.elementalSealUntil = now + (def.durationMs ?? 60_000);
    p.anim = "cast";
    p.animUntil = now + 550;
    hooks.pushLog(p, `${def.label} â€” the next element obeys.`);
    return true;
  }
  if (id === "mana_wall") {
    payRecast();
    p.manaWallUntil = now + (def.durationMs ?? 60_000);
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} â€” mana becomes your bulwark.`);
    return true;
  }
  if (id === "manawell") {
    payRecast();
    p.manawellReady = true;
    p.anim = "cast";
    p.animUntil = now + 450;
    hooks.pushLog(p, `${def.label} â€” the next spell is free.`);
    return true;
  }
  if (id === "enmity_douse") {
    payRecast();
    p.enmity = 0;
    for (const m of hooks.allMobs()) {
      if (m.targetId === p.wallet) m.targetId = null;
    }
    p.anim = "cast";
    p.animUntil = now + 400;
    hooks.pushLog(p, `${def.label} â€” hate washes away.`);
    return true;
  }
  if (id === "cascade") {
    payRecast();
    p.cascadeUntil = now + (def.durationMs ?? 30_000);
    p.anim = "cast";
    p.animUntil = now + 450;
    hooks.pushLog(p, `${def.label} â€” chain the next burst!`);
    return true;
  }
  if (id === "focal_neve") {
    payRecast();
    p.focalNeveUntil = now + (def.durationMs ?? 60_000);
    p.scCastFlashUntil = now + 1000;
    p.anim = "cast";
    p.animUntil = now + 600;
    hooks.pushLog(p, `${def.label} â€” INT surges through the neve.`);
    return true;
  }

  if (id === "sc_phase_warp" || id === "sc_ash_escape") {
    if (!spendMp(p, mpCost, now)) {
      hooks.pushLog(p, "Not enough MP.");
      return true;
    }
    payRecast();
    // Pale Hollow hub spawn (not leftover hall coords).
    p.x = PH_HUB_SPAWN.x;
    p.z = PH_HUB_SPAWN.z;
    p.y = paleHollowStandHeight(p.x, p.z);
    p.facing = PH_HUB_SPAWN.facing;
    p.moveTo = null;
    p.targetId = null;
    p.enmity = 0;
    for (const m of hooks.allMobs()) {
      if (m.targetId === p.wallet) m.targetId = null;
    }
    p.anim = "cast";
    p.animUntil = now + (id === "sc_phase_warp" ? 800 : 500);
    hooks.pushLog(
      p,
      id === "sc_phase_warp"
        ? `${def.label} — you blink to the Pale Hollow encampment.`
        : `${def.label} — ash takes you back to the encampment.`,
    );
    return true;
  }


  // â€”â€” Elemental nukes â€”â€”
  if (def.category === "elemental" && def.potency != null && def.element) {
    const cascadeBonus = now < p.cascadeUntil;
    // Clear Cascade only after the cast validates (target/range/MP) (#54).

    if (def.isGa && def.aoe) {
      const tid = targetId ?? p.targetId;
      const anchor = hooks.findMob(tid);
      if (!anchor || !anchor.alive) {
        hooks.pushLog(p, "No target.");
        return true;
      }
      if (hooks.dist(p.x, p.z, anchor.x, anchor.z) > (def.range ?? 12)) {
        hooks.pushLog(p, "Too far.");
        return true;
      }
      const cx = anchor.x;
      const cz = anchor.z;
      if (!spendMp(p, mpCost, now)) {
        hooks.pushLog(p, "Not enough MP.");
        return true;
      }
      if (cascadeBonus) p.cascadeUntil = 0;
      payRecast();
      p.facing = hooks.facingTo(p.x, p.z, anchor.x, anchor.z);
      p.lastScElement = def.element;
      p.scCastFlashUntil = now + 650;
      p.anim = "cast";
      p.animUntil = now + 620;
      const dmg = elementalDamage(p, def.potency, now, cascadeBonus, combatStats);
      p.elementalSealUntil = 0;
      let hits = 0;
      for (const m of mobsInRadius(hooks.allMobs(), cx, cz, def.aoe)) {
        applyNukeHit(p, m, dmg, def.element, now);
        hits += 1;
        if (m.hp <= 0) hooks.onMobKill(p, m, now);
      }
      hooks.pushLog(p, `${def.label} â€” ${dmg} on ${hits} foe(s)!`);
      return true;
    }

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
    if (!spendMp(p, mpCost, now)) {
      hooks.pushLog(p, "Not enough MP.");
      return true;
    }
    if (cascadeBonus) p.cascadeUntil = 0;
    payRecast();
    p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);
    p.lastScElement = def.element;
    p.scCastFlashUntil = now + 650;
    p.anim = "cast";
    p.animUntil = now + 580;
    const dmg = elementalDamage(p, def.potency, now, cascadeBonus, combatStats);
    p.elementalSealUntil = 0;
    applyNukeHit(p, m, dmg, def.element, now);
    hooks.pushLog(p, `${def.label} â€” ${dmg} on ${m.name ?? "foe"}!`);
    if (m.hp <= 0) hooks.onMobKill(p, m, now);
    return true;
  }

  // â€”â€” Enfeebles / dark â€”â€”
  const tid = targetId ?? p.targetId;
  const mob = hooks.findMob(tid);
  if ((def.needsTarget || def.category === "enfeeble" || def.category === "dark") && def.category !== "travel") {
    if (!mob || !mob.alive) {
      hooks.pushLog(p, "No target.");
      return true;
    }
    if (hooks.dist(p.x, p.z, mob.x, mob.z) > (def.range ?? 12)) {
      hooks.pushLog(p, "Too far.");
      return true;
    }
    if (!spendMp(p, mpCost, now)) {
      hooks.pushLog(p, "Not enough MP.");
      return true;
    }
    payRecast();
    p.facing = hooks.facingTo(p.x, p.z, mob.x, mob.z);
    p.anim = "cast";
    p.animUntil = now + 520;

    if (id === "sc_morrow_sleep") {
      mob.sleepUntil = now + (def.durationMs ?? 45_000);
      hooks.pushLog(p, `${def.label} â€” ${mob.name ?? "foe"} slumbers.`);
      return true;
    }
    if (id === "sc_morrow_slumber") {
      const r = def.aoe ?? 8;
      let n = 0;
      for (const m of mobsInRadius(hooks.allMobs(), mob.x, mob.z, r)) {
        m.sleepUntil = now + (def.durationMs ?? 30_000);
        n += 1;
      }
      hooks.pushLog(p, `${def.label} â€” ${n} foe(s) fall asleep.`);
      return true;
    }
    if (id === "sc_mist_blind") {
      mob.blindUntil = now + (def.durationMs ?? 90_000);
      hooks.pushLog(p, `${def.label} â€” ${mob.name ?? "foe"} is blinded.`);
      return true;
    }
    if (id === "sc_root_sigil") {
      mob.bindUntil = now + (def.durationMs ?? 60_000);
      hooks.pushLog(p, `${def.label} â€” roots hold ${mob.name ?? "foe"}.`);
      return true;
    }
    if (id === "sc_unweave") {
      let stripped = 0;
      if (mob.falseGuardUntil && mob.falseGuardUntil > now) {
        mob.falseGuardUntil = 0;
        stripped += 1;
      }
      // Clear residual impact flashes / defensive feints only â€” not your enfeebles
      if (mob.scImpactUntil > now) {
        mob.scImpactUntil = 0;
        mob.scImpactElement = null;
        stripped += 1;
      }
      hooks.pushLog(
        p,
        stripped > 0
          ? `${def.label} â€” buffs stripped from ${mob.name ?? "foe"}.`
          : `${def.label} â€” nothing to unravel on ${mob.name ?? "foe"}.`,
      );
      return true;
    }
    if (id === "sc_life_leech") {
      const dmg = elementalDamage(p, def.potency ?? 45, now, false, combatStats);
      mob.hp = Math.max(0, mob.hp - dmg);
      const heal = Math.floor(dmg * 0.6);
      p.hp = Math.min(p.maxHp, p.hp + heal);
      mob.scImpactUntil = now + 700;
      mob.scImpactElement = "dark";
      hooks.pushLog(p, `${def.label} â€” ${dmg} drained, +${heal} HP.`);
      if (mob.hp <= 0) hooks.onMobKill(p, mob, now);
      return true;
    }
    if (id === "sc_mana_siphon") {
      const want = Math.min(40, Math.max(8, Math.floor(combatStats.int * 0.8)));
      const available = typeof mob.mp === "number" ? mob.mp : 0;
      const drain = Math.min(want, available);
      if (drain <= 0) {
        hooks.pushLog(p, `${def.label} â€” no mana to siphon.`);
        return true;
      }
      mob.mp = available - drain;
      p.mp = Math.min(p.maxMp, p.mp + drain);
      hooks.pushLog(p, `${def.label} â€” siphoned ${drain} MP.`);
      return true;
    }
    if (id === "sc_gloom_stun") {
      const dmg = Math.floor(elementalDamage(p, 35, now, false, combatStats) * 0.5);
      mob.hp = Math.max(0, mob.hp - dmg);
      mob.stunUntil = now + (def.durationMs ?? 5_000);
      mob.scImpactUntil = now + 800;
      mob.scImpactElement = "dark";
      hooks.pushLog(p, `${def.label} â€” ${dmg} and stun!`);
      if (mob.hp <= 0) hooks.onMobKill(p, mob, now);
      return true;
    }
  }

  hooks.pushLog(p, `${def.label} is not implemented yet.`);
  return true;
}

/** Magic damage taken multiplier while Mana Wall is active. */
export function sorcererMagDtMul(p: SorcererPlayer, now: number): number {
  if (now < p.manaWallUntil) return 0.55;
  return 1;
}
