/**
 * Battle Mage ability resolution — hybrid blade + en-spell kit.
 * Motifs: teal-bronze blade runes — not TIM chrona orbs, not Sorcerer violet.
 */
import {
  BATTLEMAGE_ABILITIES,
  isBattleMageAbilityId,
  type BattleMageAbilityId,
} from "@bellgrave/combat";
import { SIGNATURE_WEAPON_IDS, signatureWeaponEquipped } from "./starter-kit";
import { kitLevel } from "./support-job";
import { withGearMab } from "./gear-combat";
import type { AbilityId } from "@bellgrave/protocol";

export type BattleMagePlayer = {
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
  hasteUntil: number;
  hastePct: number;
  protectUntil: number;
  protectPhysMul: number;
  shellUntil: number;
  shellMagMul: number;
  spellbladeUntil: number;
  spellbladeFlashUntil: number;
  focusWeave: boolean;
  corruptReady: boolean;
  spontaneityReady: boolean;
  lockspellReady: boolean;
  widenReady: boolean;
  enSpellUntil: number;
  enSpellBonus: number;
  phalanxUntil: number;
  phalanxPhysMul: number;
  stoneskinUntil: number;
  stoneskinAbsorb: number;
  refreshUntil: number;
  /** MP per second while refreshUntil is active. */
  refreshTick: number;
};

export type BattleMageMob = {
  id: string;
  name?: string;
  alive: boolean;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  targetId: string | null;
  nextSwingAt: number;
  slowUntil: number;
  swingPenalty: number;
  gravityUntil: number;
  gravityPct: number;
  bindUntil: number;
  silenceUntil: number;
  paraUntil: number;
  blindUntil: number;
  stunUntil: number;
  sleepUntil: number;
  frazzleUntil: number;
  addleUntil: number;
  falseGuardUntil: number;
  diaUntil: number;
  bioUntil: number;
  bioTick: number;
  /** Wallet that applied Bio, for DoT kill credit (#69). */
  bioSourceWallet?: string | null;
};

export type BattleMageHooks = {
  pushLog: (p: BattleMagePlayer, msg: string) => void;
  stopRest: (p: BattleMagePlayer, reason?: string) => void;
  facingTo: (ax: number, az: number, bx: number, bz: number) => number;
  findMob: (id: string | null | undefined) => BattleMageMob | null;
  allMobs: () => BattleMageMob[];
  allPlayers: () => BattleMagePlayer[];
  onMobKill: (p: BattleMagePlayer, m: BattleMageMob, now: number) => void;
  dist: (ax: number, az: number, bx: number, bz: number) => number;
  playerCombatStats: (p: BattleMagePlayer) => {
    str: number;
    dex: number;
    vit: number;
    agi: number;
    int: number;
    mnd: number;
  };
};


export function swordEquipped(p: BattleMagePlayer): boolean {
  return signatureWeaponEquipped(p, SIGNATURE_WEAPON_IDS.battle_mage);
}

export function battleMagePhysDtMul(p: BattleMagePlayer, now: number): number {
  let mul = 1;
  if (now < p.protectUntil) mul *= p.protectPhysMul;
  if (now < p.phalanxUntil) mul *= p.phalanxPhysMul;
  return Math.max(0, Math.min(1, mul));
}

export function battleMageMagDtMul(p: BattleMagePlayer, now: number): number {
  let mul = 1;
  if (now < p.shellUntil) mul *= p.shellMagMul;
  return Math.max(0.1, Math.min(1, mul));
}

export function absorbStoneskin(p: BattleMagePlayer, now: number, raw: number): number {
  if (now >= p.stoneskinUntil || p.stoneskinAbsorb <= 0) return raw;
  const absorbed = Math.min(p.stoneskinAbsorb, raw);
  p.stoneskinAbsorb -= absorbed;
  if (p.stoneskinAbsorb <= 0) p.stoneskinUntil = 0;
  return Math.max(0, raw - absorbed);
}


function elementalNuke(
  potency: number,
  corrupt: boolean,
  combatStats: { int: number; str: number },
): number {
  const { int, str } = combatStats;
  let base = potency * 0.45 + int * 2.4 + str * 0.25;
  if (corrupt) base *= 1.2;
  return Math.max(1, Math.floor(base));
}

function enhanceDurationMul(p: BattleMagePlayer): number {
  return p.focusWeave ? 2.2 : 1;
}

export function resolveBattleMageAbility(
  p: BattleMagePlayer & { wallet: string },
  id: AbilityId,
  targetId: string | undefined,
  now: number,
  hooks: BattleMageHooks,
): boolean {
  if (p.job !== "battle_mage" && (p as { subjob?: string | null }).subjob !== "battle_mage") {
    return false;
  }
  if (!isBattleMageAbilityId(id)) {
    hooks.pushLog(p, "That is not a Battle Mage ability.");
    return true;
  }

  const def = BATTLEMAGE_ABILITIES[id];
  const combatStats = hooks.playerCombatStats(p);
  const effLevel = kitLevel(p, "battle_mage");
  if (def.unlockLevel > effLevel) {
    hooks.pushLog(p, `${def.label} unlocks at level ${def.unlockLevel}.`);
    return true;
  }

  const spellblade = now < p.spellbladeUntil;
  const readyAt = p.recasts[id] ?? 0;
  if (!spellblade && now < readyAt) {
    hooks.pushLog(p, `${def.label} not ready.`);
    return true;
  }
  if (!spellblade && p.mp < def.mp) {
    hooks.pushLog(p, "Not enough MP.");
    return true;
  }
  // Signature weapon only when this job is main (support dual-job skips it).
  if (def.weaponRequired && p.job === "battle_mage" && !swordEquipped(p)) {
    hooks.pushLog(p, "Equip your sword first.");
    return true;
  }

  const spend = () => {
    if (!spellblade) p.mp -= def.mp;
    if (!spellblade && def.recastMs > 0) p.recasts[id] = now + def.recastMs;
  };

  const castAnimMs = p.spontaneityReady ? 120 : 520;

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

  if (id === "spellblade") {
    spend();
    p.spellbladeUntil = now + (def.durationMs ?? 60_000);
    p.spellbladeFlashUntil = now + 2500;
    p.anim = "cast";
    p.animUntil = now + 600;
    hooks.pushLog(p, `${def.label} — blade runes sing; spells flow free!`);
    return true;
  }

  if (id === "convert") {
    spend();
    const hpRatio = p.maxHp > 0 ? p.hp / p.maxHp : 0;
    const mpRatio = p.maxMp > 0 ? p.mp / p.maxMp : 0;
    p.hp = Math.max(1, Math.floor(p.maxHp * mpRatio));
    p.mp = Math.floor(p.maxMp * hpRatio);
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    hooks.pushLog(p, `${def.label} — HP and MP trade places.`);
    return true;
  }

  if (id === "corrupt") {
    spend();
    p.corruptReady = true;
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    hooks.pushLog(p, `${def.label} — next enfeeble will fester.`);
    return true;
  }

  if (id === "focus_weave") {
    p.focusWeave = !p.focusWeave;
    p.anim = "cast";
    p.animUntil = now + 350;
    hooks.pushLog(p, p.focusWeave ? `${def.label} ON — enhances linger.` : `${def.label} OFF.`);
    return true;
  }

  if (id === "spontaneity") {
    spend();
    p.spontaneityReady = true;
    p.anim = "cast";
    p.animUntil = now + 350;
    hooks.pushLog(p, `${def.label} — next spell is instant.`);
    return true;
  }

  if (id === "lockspell") {
    spend();
    p.lockspellReady = true;
    p.anim = "cast";
    p.animUntil = now + 350;
    hooks.pushLog(p, `${def.label} — next enfeeble bites true.`);
    return true;
  }

  if (id === "widen") {
    spend();
    p.widenReady = true;
    p.anim = "cast";
    p.animUntil = now + 350;
    hooks.pushLog(p, `${def.label} — next enhance spreads.`);
    return true;
  }

  if (id === "full_circle") {
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
    if (now >= p.enSpellUntil) {
      hooks.pushLog(p, "No en-spell to collapse — cast an edge first.");
      return true;
    }
    spend();
    p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);
    const bonus = p.enSpellBonus + combatStats.int * 0.5;
    const dmg = withGearMab(p, Math.max(1, Math.floor((def.potency ?? 200) + bonus * 4)));
    m.hp -= dmg;
    p.enSpellUntil = 0;
    p.enSpellBonus = 0;
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    hooks.pushLog(p, `${def.label} — ${dmg} rune burst!`);
    if (m.hp <= 0) hooks.onMobKill(p, m, now);
    return true;
  }

  // En-spells
  if (id === "bm_flame_edge" || id === "bm_frost_edge" || id === "bm_thunder_edge") {
    spend();
    const dur = Math.floor((def.durationMs ?? 180_000) * enhanceDurationMul(p));
    p.enSpellUntil = now + dur;
    p.enSpellBonus = def.enSpellBonus ?? 10;
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    if (p.spontaneityReady) p.spontaneityReady = false;
    hooks.pushLog(p, `${def.label} — blade runes ignite (${Math.round(dur / 1000)}s).`);
    return true;
  }

  // Self heals
  if (id === "bm_cure" || id === "bm_cure_ii" || id === "bm_cure_iii" || id === "bm_cure_iv") {
    spend();
    const heal = Math.floor((def.heal ?? 35) + combatStats.mnd * 1.1);
    p.hp = Math.min(p.maxHp, p.hp + heal);
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    if (p.spontaneityReady) p.spontaneityReady = false;
    hooks.pushLog(p, `${def.label} — recover ${heal} HP.`);
    return true;
  }

  const applySelfEnhance = (
    label: string,
    apply: (ally: BattleMagePlayer) => void,
    aoe?: number,
    opts?: { nativeAoe?: boolean },
  ) => {
    spend();
    if (aoe && aoe > 0) {
      if (!opts?.nativeAoe && p.widenReady) p.widenReady = false;
      let hit = 0;
      for (const ally of hooks.allPlayers()) {
        if (hooks.dist(p.x, p.z, ally.x, ally.z) <= aoe) {
          apply(ally);
          hit += 1;
        }
      }
      hooks.pushLog(p, `${label} — party weave (${hit} in ${aoe} y).`);
    } else {
      apply(p);
      hooks.pushLog(p, `${label}.`);
    }
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    if (p.spontaneityReady) p.spontaneityReady = false;
  };

  if (
    id === "bm_protect" ||
    id === "bm_shell" ||
    id === "bm_phalanx" ||
    id === "bm_stoneskin" ||
    id === "bm_haste" ||
    id === "bm_refresh" ||
    id === "bm_refresh_ii" ||
    id === "bm_refreshga"
  ) {
    const durMul = enhanceDurationMul(p);
    if (id === "bm_protect") {
      applySelfEnhance(
        def.label,
        (ally) => {
          ally.protectUntil = now + Math.floor((def.durationMs ?? 180_000) * durMul);
          ally.protectPhysMul = def.physDt ?? 0.88;
        },
        p.widenReady ? 10 : 0,
      );
      return true;
    }
    if (id === "bm_shell") {
      applySelfEnhance(
        def.label,
        (ally) => {
          ally.shellUntil = now + Math.floor((def.durationMs ?? 180_000) * durMul);
          ally.shellMagMul = def.magDt ?? 0.88;
        },
        p.widenReady ? 10 : 0,
      );
      return true;
    }
    if (id === "bm_phalanx") {
      applySelfEnhance(
        def.label,
        (ally) => {
          ally.phalanxUntil = now + Math.floor((def.durationMs ?? 120_000) * durMul);
          ally.phalanxPhysMul = def.physDt ?? 0.75;
        },
        p.widenReady ? 10 : 0,
      );
      return true;
    }
    if (id === "bm_stoneskin") {
      applySelfEnhance(
        def.label,
        (ally) => {
          ally.stoneskinUntil = now + Math.floor((def.durationMs ?? 300_000) * durMul);
          ally.stoneskinAbsorb = 80 + combatStats.int * 2;
        },
        p.widenReady ? 10 : 0,
      );
      return true;
    }
    if (id === "bm_haste") {
      applySelfEnhance(
        def.label,
        (ally) => {
          const pct = def.haste ?? 0.22;
          if (now > ally.hasteUntil || pct >= ally.hastePct) {
            ally.hastePct = pct;
            ally.hasteUntil = now + Math.floor((def.durationMs ?? 180_000) * durMul);
          } else {
            ally.hasteUntil = Math.max(ally.hasteUntil, now + Math.floor((def.durationMs ?? 180_000) * durMul));
          }
        },
        p.widenReady ? 10 : 0,
      );
      return true;
    }
    if (id === "bm_refresh" || id === "bm_refresh_ii" || id === "bm_refreshga") {
      const tick = def.refreshMp ?? 4;
      const nativeAoe = id === "bm_refreshga";
      const radius = nativeAoe ? (def.aoe ?? 10) : p.widenReady ? 10 : 0;
      applySelfEnhance(
        def.label,
        (ally) => {
          const dur = now + Math.floor((def.durationMs ?? 180_000) * durMul);
          // Keep the stronger tick if a better Refresh is already running.
          if (now < ally.refreshUntil && ally.refreshTick > tick) {
            ally.refreshUntil = Math.max(ally.refreshUntil, dur);
          } else {
            ally.refreshUntil = dur;
            ally.refreshTick = tick;
          }
        },
        radius,
        { nativeAoe },
      );
      return true;
    }
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

  p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);

  const corrupt = p.corruptReady;
  const lock = p.lockspellReady;
  const durScale = corrupt ? 1.45 : 1;
  const resistSkip = lock;

  if (def.category === "nuke") {
    spend();
    if (p.spontaneityReady) p.spontaneityReady = false;
    let dmg = withGearMab(p, elementalNuke(def.potency ?? 40, false, combatStats));
    if (id === "bm_firaga") {
      const r = def.aoe ?? 8;
      let total = 0;
      for (const hit of hooks.allMobs()) {
        if (!hit.alive) continue;
        if (hooks.dist(m.x, m.z, hit.x, hit.z) > r) continue;
        const d = Math.max(1, Math.floor(dmg * (hit.id === m.id ? 1 : 0.75)));
        hit.hp -= d;
        if (hit.sleepUntil > now) hit.sleepUntil = 0;
        total += d;
        if (hit.hp <= 0) hooks.onMobKill(p, hit, now);
      }
      p.anim = "cast";
      p.animUntil = now + castAnimMs;
      hooks.pushLog(p, `${def.label} — ${total} total ember damage!`);
      return true;
    }
    m.hp -= dmg;
    if (m.sleepUntil > now) m.sleepUntil = 0;
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    hooks.pushLog(p, `${def.label} — ${dmg} damage!`);
    if (m.hp <= 0) hooks.onMobKill(p, m, now);
    return true;
  }

  if (def.category === "enfeeble") {
    spend();
    if (corrupt) p.corruptReady = false;
    if (lock) p.lockspellReady = false;
    if (p.spontaneityReady) p.spontaneityReady = false;
    const dur = Math.floor((def.durationMs ?? 30_000) * durScale);
    const failChance = resistSkip ? 0 : 0.12;

    if (id === "bm_dia") {
      if (!resistSkip && Math.random() < failChance) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.diaUntil = now + dur;
      p.anim = "cast";
      p.animUntil = now + castAnimMs;
      hooks.pushLog(p, `${def.label} — defense frays.`);
      return true;
    }
    if (id === "bm_bio") {
      if (!resistSkip && Math.random() < failChance) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      const tick = Math.max(1, Math.floor((def.potency ?? 8) + combatStats.int * 0.15));
      m.bioUntil = now + dur;
      m.bioTick = tick;
      m.bioSourceWallet = p.wallet.toLowerCase();
      p.anim = "cast";
      p.animUntil = now + castAnimMs;
      hooks.pushLog(p, `${def.label} — spore rot (${tick}/tick).`);
      return true;
    }
    if (id === "bm_slow") {
      if (!resistSkip && Math.random() < failChance) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.slowUntil = now + dur;
      m.swingPenalty = 0.28;
      hooks.pushLog(p, `${def.label} — foe drags.`);
    } else if (id === "bm_paralyze") {
      if (!resistSkip && Math.random() < failChance + 0.08) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.paraUntil = now + dur;
      hooks.pushLog(p, `${def.label} — muscles lock.`);
    } else if (id === "bm_silence") {
      if (!resistSkip && Math.random() < failChance) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.silenceUntil = now + dur;
      hooks.pushLog(p, `${def.label} — muted.`);
    } else if (id === "bm_blind") {
      if (!resistSkip && Math.random() < failChance) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.blindUntil = now + dur;
      hooks.pushLog(p, `${def.label} — veiled.`);
    } else if (id === "bm_gravity") {
      if (!resistSkip && Math.random() < failChance) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.gravityUntil = now + dur;
      m.gravityPct = 0.35;
      m.slowUntil = Math.max(m.slowUntil, now + dur);
      m.swingPenalty = Math.max(m.swingPenalty, 0.2);
      hooks.pushLog(p, `${def.label} — weight crushes.`);
    } else if (id === "bm_bind") {
      if (!resistSkip && Math.random() < failChance + 0.05) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.bindUntil = now + dur;
      hooks.pushLog(p, `${def.label} — chained.`);
    } else if (id === "bm_sleep") {
      if (!resistSkip && Math.random() < failChance + 0.1) {
        hooks.pushLog(p, `${def.label} resisted.`);
        return true;
      }
      m.sleepUntil = now + dur;
      hooks.pushLog(p, `${def.label} — deep sleep.`);
    } else if (id === "bm_dispel") {
      let stripped = 0;
      if (m.falseGuardUntil > now) {
        m.falseGuardUntil = 0;
        stripped += 1;
      }
      hooks.pushLog(
        p,
        stripped > 0
          ? `${def.label} — buffs unraveled.`
          : `${def.label} — nothing to unravel.`,
      );
    }
    p.anim = "cast";
    p.animUntil = now + castAnimMs;
    return true;
  }

  hooks.pushLog(p, `${def.label} is not ready in this build.`);
  return true;
}

export function clearBattleMageBuffs(p: BattleMagePlayer) {
  p.spellbladeUntil = 0;
  p.spellbladeFlashUntil = 0;
  p.focusWeave = false;
  p.corruptReady = false;
  p.spontaneityReady = false;
  p.lockspellReady = false;
  p.widenReady = false;
  p.enSpellUntil = 0;
  p.enSpellBonus = 0;
  p.phalanxUntil = 0;
  p.phalanxPhysMul = 1;
  p.stoneskinUntil = 0;
  p.stoneskinAbsorb = 0;
  p.refreshUntil = 0;
  p.refreshTick = 0;
}

export function battleMageEnSpellBonus(
  p: BattleMagePlayer,
  now: number,
  intStat: number,
): number {
  if (now >= p.enSpellUntil) return 0;
  return p.enSpellBonus + Math.floor(intStat * 0.35);
}
