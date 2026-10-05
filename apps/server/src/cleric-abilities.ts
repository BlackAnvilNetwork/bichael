/**
 * Cleric ability resolution — primary healer kit.
 * Motifs: white / sky-blue / soft gold light columns (not Knight pale-gold, not TIM teal).
 */
import {
  CLERIC_ABILITIES,
  isClericAbilityId,
  type ClericAbilityId,
} from "@bellgrave/combat";
import { SIGNATURE_WEAPON_IDS, signatureWeaponEquipped } from "./starter-kit";
import { kitLevel } from "./support-job";
import type { AbilityId } from "@bellgrave/protocol";

export type ClericPlayer = {
  level: number;
  job: string;
  wallet: string;
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
  protectUntil: number;
  protectPhysMul: number;
  shellUntil: number;
  shellMagMul: number;
  hasteUntil: number;
  hastePct: number;
  /** Divine Seal — next cure/banish ×2 */
  divineSealCharges: number;
  divineSealUntil: number;
  solaceRite: boolean;
  miseryRite: boolean;
  miseryEmpowerUntil: number;
  martyrReadyUntil: number;
  devotionReadyUntil: number;
  asylumUntil: number;
  regenUntil: number;
  regenTick: number;
  reraiseUntil: number;
  healAbsorbUntil: number;
  healAbsorbHp: number;
  sacredLightUntil: number;
  blindUntil: number;
};

export type ClericMob = {
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
  slowUntil: number;
  swingPenalty: number;
  silenceUntil: number;
  paraUntil: number;
};

export type ClericHooks = {
  pushLog: (p: ClericPlayer, msg: string) => void;
  stopRest: (p: ClericPlayer, reason?: string) => void;
  facingTo: (ax: number, az: number, bx: number, bz: number) => number;
  findMob: (id: string | null | undefined) => ClericMob | null;
  allMobs: () => ClericMob[];
  allPlayers: () => ClericPlayer[];
  onMobKill: (p: ClericPlayer, m: ClericMob, now: number) => void;
  dist: (ax: number, az: number, bx: number, bz: number) => number;
  playerCombatStats: (p: ClericPlayer) => {
    str: number;
    dex: number;
    vit: number;
    agi: number;
    int: number;
    mnd: number;
  };
};


export function staffEquipped(p: ClericPlayer): boolean {
  return signatureWeaponEquipped(p, SIGNATURE_WEAPON_IDS.cleric);
}

export function clericMagDtMul(p: ClericPlayer, now: number): number {
  let mul = 1;
  if (now < p.asylumUntil) mul *= 0.7;
  if (now < p.shellUntil) mul *= p.shellMagMul;
  return Math.max(0.1, Math.min(1, mul));
}

export function clericPhysDtMul(p: ClericPlayer, now: number): number {
  let mul = 1;
  if (now < p.protectUntil) mul *= p.protectPhysMul;
  return Math.max(0.1, Math.min(1, mul));
}

/** Solace Rite absorb — soak incoming damage while healAbsorbHp remains. */
export function absorbHealShield(p: ClericPlayer, now: number, raw: number): number {
  if (raw <= 0) return raw;
  if (now >= p.healAbsorbUntil || p.healAbsorbHp <= 0) {
    if (now >= p.healAbsorbUntil) {
      p.healAbsorbHp = 0;
      p.healAbsorbUntil = 0;
    }
    return raw;
  }
  const soaked = Math.min(p.healAbsorbHp, raw);
  p.healAbsorbHp -= soaked;
  if (p.healAbsorbHp <= 0) {
    p.healAbsorbHp = 0;
    p.healAbsorbUntil = 0;
  }
  return Math.max(0, raw - soaked);
}

function healPower(p: ClericPlayer, base: number, double: boolean, stats: { mnd: number }): number {
  const { mnd } = stats;
  let amt = Math.floor(base + mnd * 2.8);
  if (double) amt *= 2;
  return Math.max(1, amt);
}

function divineNuke(p: ClericPlayer, potency: number, double: boolean, stats: { mnd: number }): number {
  const { mnd } = stats;
  let dmg = Math.max(1, Math.floor(potency * 0.4 + mnd * 2.5));
  if (double) dmg *= 2;
  return dmg;
}

function resolveAlly(
  p: ClericPlayer,
  targetId: string | undefined,
  hooks: ClericHooks,
  range: number,
): ClericPlayer {
  const tid = targetId ?? p.targetId;
  if (tid) {
    const ally = hooks.allPlayers().find((pl) => pl.wallet === tid);
    if (ally && hooks.dist(p.x, p.z, ally.x, ally.z) <= range) return ally;
  }
  return p;
}

function applyHeal(
  caster: ClericPlayer,
  target: ClericPlayer,
  amount: number,
  now: number,
  hooks: ClericHooks,
  label: string,
) {
  target.hp = Math.min(target.maxHp, target.hp + amount);
  if (caster.solaceRite) {
    const shield = Math.max(1, Math.floor(amount * 0.35));
    target.healAbsorbUntil = now + 20_000;
    target.healAbsorbHp = Math.max(target.healAbsorbHp, shield);
    hooks.pushLog(
      caster,
      `${label} — ${target.wallet === caster.wallet ? "you" : "ally"} +${amount} HP · Solace shield ${shield}.`,
    );
  } else {
    hooks.pushLog(
      caster,
      `${label} — ${target.wallet === caster.wallet ? "you" : "ally"} +${amount} HP.`,
    );
  }
  caster.sacredLightUntil = Math.max(caster.sacredLightUntil, now + 900);
  target.sacredLightUntil = Math.max(target.sacredLightUntil, now + 900);
}

function consumeDivineSeal(p: ClericPlayer): boolean {
  if (p.divineSealCharges <= 0) return false;
  p.divineSealCharges = 0;
  p.divineSealUntil = 0;
  return true;
}

export function resolveClericAbility(
  p: ClericPlayer,
  id: AbilityId,
  targetId: string | undefined,
  now: number,
  hooks: ClericHooks,
): boolean {
  if (p.job !== "cleric" && (p as { subjob?: string | null }).subjob !== "cleric") return false;
  if (!isClericAbilityId(id)) {
    hooks.pushLog(p, "That is not a Cleric ability.");
    return true;
  }

  const def = CLERIC_ABILITIES[id];
  const combatStats = hooks.playerCombatStats(p);
  const effLevel = kitLevel(p, "cleric");
  if (def.unlockLevel > effLevel) {
    hooks.pushLog(p, `${def.label} unlocks at level ${def.unlockLevel}.`);
    return true;
  }

  if (def.toggle) {
    if (id === "solace_rite") {
      p.solaceRite = !p.solaceRite;
      hooks.pushLog(p, p.solaceRite ? `${def.label} engaged.` : `${def.label} released.`);
      return true;
    }
    if (id === "misery_rite") {
      p.miseryRite = !p.miseryRite;
      hooks.pushLog(p, p.miseryRite ? `${def.label} engaged.` : `${def.label} released.`);
      return true;
    }
  }

  const readyAt = p.recasts[id] ?? 0;
  if (now < readyAt) {
    hooks.pushLog(p, `${def.label} not ready.`);
    return true;
  }
  if (p.mp < def.mp) {
    hooks.pushLog(p, "Not enough MP.");
    return true;
  }
  // Signature staff only when this job is main (support dual-job skips it).
  if (def.staffRequired && p.job === "cleric" && !staffEquipped(p)) {
    hooks.pushLog(p, "Equip your club or staff first.");
    return true;
  }

  const spend = () => {
    p.mp -= def.mp;
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

  if (id === "sacred_mercy") {
    spend();
    const r = def.aoe ?? 14;
    let count = 0;
    for (const ally of hooks.allPlayers()) {
      if (hooks.dist(p.x, p.z, ally.x, ally.z) > r) continue;
      ally.hp = ally.maxHp;
      ally.regenUntil = 0;
      ally.sacredLightUntil = now + 2500;
      count++;
    }
    p.sacredLightUntil = now + 2500;
    p.anim = "cast";
    p.animUntil = now + 800;
    hooks.pushLog(p, `${def.label} — ${count} restored in the light column!`);
    return true;
  }

  if (id === "divine_seal") {
    spend();
    p.divineSealCharges = 1;
    p.divineSealUntil = now + (def.durationMs ?? 60_000);
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} — next mend or ray doubled.`);
    return true;
  }

  if (id === "martyr") {
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    if (p.hp <= 20) {
      hooks.pushLog(p, "Too weak to offer blood.");
      return true;
    }
    spend();
    p.martyrReadyUntil = now + (def.durationMs ?? 30_000);
    const sacrifice = Math.floor(p.maxHp * 0.15);
    p.hp = Math.max(1, p.hp - sacrifice);
    const heal = sacrifice + Math.floor(combatStats.mnd * 2);
    applyHeal(p, ally, heal, now, hooks, def.label);
    p.anim = "cast";
    p.animUntil = now + 600;
    return true;
  }

  if (id === "devotion") {
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    if (p.hp <= 30) {
      hooks.pushLog(p, "Not enough vitality to share.");
      return true;
    }
    spend();
    p.devotionReadyUntil = now + 5_000;
    const hpCost = Math.floor(p.maxHp * 0.1);
    p.hp = Math.max(1, p.hp - hpCost);
    const mpGain = Math.floor(hpCost * 0.8 + combatStats.mnd * 0.5);
    ally.mp = Math.min(ally.maxMp, ally.mp + mpGain);
    p.anim = "cast";
    p.animUntil = now + 550;
    hooks.pushLog(p, `${def.label} — ally +${mpGain} MP.`);
    return true;
  }

  if (id === "asylum") {
    spend();
    const dur = def.durationMs ?? 30_000;
    const r = def.aoe ?? 14;
    for (const ally of hooks.allPlayers()) {
      if (hooks.dist(p.x, p.z, ally.x, ally.z) <= r) {
        ally.asylumUntil = now + dur;
      }
    }
    p.sacredLightUntil = now + 1800;
    p.anim = "cast";
    p.animUntil = now + 650;
    hooks.pushLog(p, `${def.label} — bell sanctuary for the party!`);
    return true;
  }

  // Single-target cures
  if (
    id === "cl_cure" ||
    id === "cl_cure_ii" ||
    id === "cl_cure_iii" ||
    id === "cl_cure_iv" ||
    id === "cl_cure_v"
  ) {
    spend();
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    const double = consumeDivineSeal(p);
    const heal = healPower(p, def.heal ?? 58, double, combatStats);
    applyHeal(p, ally, heal, now, hooks, def.label);
    p.anim = "cast";
    p.animUntil = now + 520;
    return true;
  }

  // Curaga
  if (id === "cl_curaga" || id === "cl_curaga_ii" || id === "cl_curaga_iii") {
    spend();
    const r = def.aoe ?? 10;
    const base = def.heal ?? 90;
    let hit = 0;
    for (const ally of hooks.allPlayers()) {
      if (hooks.dist(p.x, p.z, ally.x, ally.z) > r) continue;
      const amt = healPower(p, base, false, combatStats);
      applyHeal(p, ally, amt, now, hooks, def.label);
      hit++;
    }
    p.anim = "cast";
    p.animUntil = now + 600;
    if (!hit) hooks.pushLog(p, `${def.label} — no allies nearby.`);
    return true;
  }

  // Regen
  if (id === "cl_regen" || id === "cl_regen_ii" || id === "cl_regen_iii") {
    spend();
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    ally.regenUntil = now + (def.durationMs ?? 75_000);
    ally.regenTick = def.regenTick ?? 12;
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} on ${ally.wallet === p.wallet ? "you" : "ally"}.`);
    return true;
  }

  // Protect / Shell single
  if (
    id === "cl_protect" ||
    id === "cl_protect_ii" ||
    id === "cl_protect_iii" ||
    id === "cl_shell" ||
    id === "cl_shell_ii" ||
    id === "cl_shell_iii"
  ) {
    spend();
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    const dur = def.durationMs ?? 180_000;
    if (id.startsWith("cl_protect")) {
      ally.protectUntil = now + dur;
      ally.protectPhysMul = def.physDt ?? 0.88;
    } else {
      ally.shellUntil = now + dur;
      ally.shellMagMul = def.magDt ?? 0.88;
    }
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} on ${ally.wallet === p.wallet ? "you" : "ally"}.`);
    return true;
  }

  // Mass protect/shell
  if (id === "cl_protectra" || id === "cl_shellra") {
    spend();
    const dur = def.durationMs ?? 180_000;
    const r = def.aoe ?? 10;
    for (const ally of hooks.allPlayers()) {
      if (hooks.dist(p.x, p.z, ally.x, ally.z) > r) continue;
      if (id === "cl_protectra") {
        ally.protectUntil = now + dur;
        ally.protectPhysMul = def.physDt ?? 0.75;
      } else {
        ally.shellUntil = now + dur;
        ally.shellMagMul = def.magDt ?? 0.75;
      }
    }
    p.anim = "cast";
    p.animUntil = now + 550;
    hooks.pushLog(p, `${def.label} — party warded.`);
    return true;
  }

  if (id === "cl_haste") {
    spend();
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    ally.hasteUntil = now + (def.durationMs ?? 180_000);
    ally.hastePct = Math.max(ally.hastePct, def.haste ?? 0.22);
    p.anim = "cast";
    p.animUntil = now + 500;
    hooks.pushLog(p, `${def.label} on ${ally.wallet === p.wallet ? "you" : "ally"}.`);
    return true;
  }

  // -na / erase — MVP clears one debuff category on ally
  if (
    id === "cl_poisona" ||
    id === "cl_paralyna" ||
    id === "cl_blindna" ||
    id === "cl_silena" ||
    id === "cl_viruna" ||
    id === "cl_stona" ||
    id === "cl_cursna" ||
    id === "cl_erase"
  ) {
    spend();
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    if (id === "cl_blindna" || id === "cl_erase") ally.blindUntil = 0;
    p.anim = "cast";
    p.animUntil = now + 450;
    hooks.pushLog(p, `${def.label} — ailments eased.`);
    return true;
  }

  if (id === "cl_raise" || id === "cl_raise_ii") {
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    spend();
    const heal = healPower(p, def.heal ?? 200, false, combatStats);
    ally.hp = Math.min(ally.maxHp, Math.max(1, heal));
    ally.sacredLightUntil = now + 2200;
    p.sacredLightUntil = now + 2200;
    p.anim = "cast";
    p.animUntil = now + 700;
    hooks.pushLog(p, `${def.label} — light recalls ${ally.wallet === p.wallet ? "you" : "ally"}!`);
    return true;
  }

  if (id === "cl_reraise") {
    const ally = resolveAlly(p, targetId, hooks, def.range ?? 12);
    spend();
    ally.reraiseUntil = now + (def.durationMs ?? 600_000);
    p.anim = "cast";
    p.animUntil = now + 600;
    hooks.pushLog(p, `${def.label} — ember vigil set.`);
    return true;
  }

  if (id === "cl_flash") {
    spend();
    const r = def.aoe ?? 8;
    let hit = 0;
    for (const m of hooks.allMobs()) {
      if (!m.alive) continue;
      if (hooks.dist(p.x, p.z, m.x, m.z) > r) continue;
      m.blindUntil = now + (def.durationMs ?? 12_000);
      hit++;
    }
    p.sacredLightUntil = now + 1200;
    p.anim = "cast";
    p.animUntil = now + 550;
    hooks.pushLog(p, hit ? `${def.label} — ${hit} blinded.` : `${def.label} — nothing nearby.`);
    return true;
  }

  if (id === "cl_banish" || id === "cl_banish_ii" || id === "cl_holy") {
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
    const double = consumeDivineSeal(p);
    const dmg = divineNuke(p, def.potency ?? 65, double, combatStats);
    m.hp -= dmg;
    p.sacredLightUntil = now + 800;
    p.anim = "cast";
    p.animUntil = now + 600;
    hooks.pushLog(p, `${def.label} — ${dmg} holy damage!`);
    if (m.hp <= 0) hooks.onMobKill(p, m, now);
    return true;
  }

  if (id === "cl_slow" || id === "cl_paralyze" || id === "cl_silence") {
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
    const dur = def.durationMs ?? 30_000;
    const emp = p.miseryRite && now < p.miseryEmpowerUntil ? 1.35 : 1;
    if (id === "cl_slow") {
      m.slowUntil = now + Math.floor(dur * emp);
      m.swingPenalty = Math.max(m.swingPenalty, 0.28 * emp);
    }
    if (id === "cl_paralyze") m.paraUntil = now + Math.floor(dur * emp);
    if (id === "cl_silence") m.silenceUntil = now + Math.floor(dur * emp);
    p.anim = "cast";
    p.animUntil = now + 520;
    hooks.pushLog(p, `${def.label} lands.`);
    return true;
  }

  hooks.pushLog(p, `${def.label} is not ready in this build.`);
  return true;
}

/** Clear Cleric-specific buffs on job change. */
export function clearClericBuffs(p: ClericPlayer) {
  p.divineSealCharges = 0;
  p.divineSealUntil = 0;
  p.solaceRite = false;
  p.miseryRite = false;
  p.miseryEmpowerUntil = 0;
  p.martyrReadyUntil = 0;
  p.devotionReadyUntil = 0;
  p.asylumUntil = 0;
  p.regenUntil = 0;
  p.regenTick = 0;
  p.reraiseUntil = 0;
  p.healAbsorbUntil = 0;
  p.healAbsorbHp = 0;
  p.sacredLightUntil = 0;
}
