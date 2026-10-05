/**
 * Time Mage ability resolution — data-driven from TIM_ABILITIES.
 */
import {
  TIM_ABILITIES,
  type Stance,
  type TimAbilityId,
  isTimAbilityId,
    isTrainerFreeAbility,
} from "@bellgrave/combat";
import { SIGNATURE_WEAPON_IDS, signatureWeaponEquipped } from "./starter-kit";
import { kitLevel } from "./support-job";
import type { AbilityId } from "@bellgrave/protocol";

export type TimPlayer = {
  level: number;
  job: string;
  mp: number;
  maxMp: number;
  hp: number;
  maxHp: number;
  tp: number;
  flux: boolean;
  aether: boolean;
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
  moveUntil: number;
  movePct: number;
  quickenUntil: number;
  overclockUntil: number;
  timeSealUntil: number;
  perpetualUntil: number;
  lastEnfeeble: TimAbilityId | null;
  /** Abilities purchased from the Trainer. */
  learned: AbilityId[];
};

export type TimMob = {
  id: string;
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
  petrifyUntil: number;
  /** Temporal Distortion hit flash window. */
  tdImpactUntil: number;
  stunUntil: number;
  distractUntil: number;
  distractAcc: number;
  frazzleUntil: number;
  addleUntil: number;
  silenceUntil: number;
  paraUntil: number;
};


export function staffEquipped(p: TimPlayer): boolean {
  return signatureWeaponEquipped(p, SIGNATURE_WEAPON_IDS.time_mage);
}

export function playerStance(p: TimPlayer): Stance {
  if (p.flux) return "flux";
  if (p.aether) return "aether";
  return "none";
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function aetherAmp(p: TimPlayer): number {
  return p.aether ? 1.2 : 1;
}

/**
 * Temporal Distortion — 2HR earth+time nuke.
 * Scales from job MND/INT; Frazzle amplifies per-target.
 */
function temporalDistortionDamage(
  p: TimPlayer,
  target: TimMob,
  now: number,
  stats: { mnd: number; int: number },
): number {
  const { mnd, int } = stats;
  let base = 80 + mnd * 6 + int * 2;
  if (now < target.frazzleUntil) base = Math.floor(base * 1.35);
  return Math.max(1, Math.floor(base * aetherAmp(p)));
}

/** Chrona shatter — interrupt windup + MND damage. Does not strip your enfeebles. */
function chronaShatter(
  p: TimPlayer,
  m: TimMob,
  now: number,
  sealBonus: boolean,
  stats: { mnd: number },
): { dmg: number; interruptMs: number } {
  const { mnd } = stats;
  let dmg = Math.floor((28 + mnd * 2.2) * aetherAmp(p));
  if (sealBonus) dmg = Math.floor(dmg * 1.2);
  const interruptMs = sealBonus ? 2800 : 2000;
  m.hp = Math.max(0, m.hp - dmg);
  m.nextSwingAt = Math.max(m.nextSwingAt, now + interruptMs);
  return { dmg, interruptMs };
}

function applySelfHaste(p: TimPlayer, now: number, pct: number, durationMs: number, move?: number) {
  // Higher haste overwrites; equal/higher refreshes
  if (now > p.hasteUntil || pct >= p.hastePct) {
    p.hastePct = pct;
    p.hasteUntil = now + durationMs;
  } else {
    p.hasteUntil = Math.max(p.hasteUntil, now + durationMs);
  }
  p.quickenUntil = p.hasteUntil; // drives orb VFX
  if (move && move > 0) {
    if (now > p.moveUntil || move >= p.movePct) {
      p.movePct = move;
      p.moveUntil = now + durationMs;
    } else {
      p.moveUntil = Math.max(p.moveUntil, now + durationMs);
    }
  }
}

export type AbilityHooks = {
  pushLog: (msg: string) => void;
  stopRest: (reason?: string) => void;
  playerCombatStats: (p: TimPlayer) => {
    str: number;
    dex: number;
    vit: number;
    agi: number;
    int: number;
    mnd: number;
  };
  facingTo: (fx: number, fz: number, tx: number, tz: number) => number;
  /** Called when an ability kills a mob. */
  onMobKill?: (mob: TimMob) => void;
  /** Party members for Allegro / Hastega AoE. */
  allPlayers?: () => TimPlayer[];
  dist?: (ax: number, az: number, bx: number, bz: number) => number;
};

export type ResolveOpts = {
  /** Metronome: skip recast gate + MP cost. */
  free?: boolean;
};

function findMob(mobs: TimMob[], id: string | null | undefined): TimMob | undefined {
  if (!id) return undefined;
  return mobs.find((m) => m.id === id);
}

function mobsInRadius(mobs: TimMob[], x: number, z: number, radius: number): TimMob[] {
  return mobs.filter((m) => m.alive && dist(x, z, m.x, m.z) <= radius);
}

export function resolveTimAbility(
  p: TimPlayer,
  id: AbilityId,
  targetId: string | undefined,
  mobs: TimMob[],
  now: number,
  hooks: AbilityHooks,
  opts: ResolveOpts = {},
): void {
  if (p.job !== "time_mage" && (p as { subjob?: string }).subjob !== "time_mage") {
    hooks.pushLog("Only a Time Mage (main or support) can weave chrona.");
    return;
  }
  if (!isTimAbilityId(id)) {
    hooks.pushLog("Unknown ability.");
    return;
  }
  const def = TIM_ABILITIES[id];
  const effLevel = kitLevel(p, "time_mage");
  if (effLevel < def.unlockLevel) {
    hooks.pushLog(`${def.label} unlocks at level ${def.unlockLevel}.`);
    return;
  }
  if (!isTrainerFreeAbility(id) && !p.learned.includes(id)) {
    hooks.pushLog(`You have not learned ${def.label}. Visit the Trainer.`);
    return;
  }
  if (!opts.free) {
    const recastUntil = p.recasts[id] ?? 0;
    if (now < recastUntil) {
      hooks.pushLog(`${def.label} on cooldown.`);
      return;
    }
  }
  // Signature staff only when this job is main (support dual-job skips it).
  if (def.staffRequired && p.job === "time_mage" && !staffEquipped(p)) {
    hooks.pushLog(`Equip Ashbeam Staff to use ${def.label}.`);
    return;
  }
  if (!opts.free && p.mp < def.mp) {
    hooks.pushLog("Not enough MP.");
    return;
  }

  // Rest toggle
  if (id === "rest") {
    if (p.anim === "rest") {
      hooks.stopRest();
      return;
    }
    if (p.moveTo) {
      hooks.pushLog("Stop moving before you rest.");
      return;
    }
    p.targetId = null;
    p.anim = "rest";
    p.animUntil = Number.POSITIVE_INFINITY;
    hooks.pushLog("You kneel and rest — HP/MP recover, TP fades.");
    return;
  }

  hooks.stopRest();

  // Stances
  if (id === "flux") {
    p.flux = !p.flux;
    if (p.flux) p.aether = false;
    p.anim = "cast";
    p.animUntil = now + 400;
    p.recasts.flux = now + def.recastMs;
    p.recasts.aether = now + def.recastMs;
    hooks.pushLog(p.flux ? "Flux Stance: ON — MND attack, +move." : "Flux Stance: OFF");
    return;
  }
  if (id === "aether") {
    p.aether = !p.aether;
    if (p.aether) p.flux = false;
    p.anim = "cast";
    p.animUntil = now + 400;
    p.recasts.aether = now + def.recastMs;
    p.recasts.flux = now + def.recastMs;
    hooks.pushLog(p.aether ? "Aether Stance: ON — magic potency up, melee suppressed." : "Aether Stance: OFF");
    return;
  }

  // Metronome: free re-cast last enfeeble
  if (id === "metronome") {
    if (!p.lastEnfeeble) {
      hooks.pushLog("Metronome — no enfeeble to repeat.");
      return;
    }
    p.recasts.metronome = now + def.recastMs;
    p.anim = "cast";
    p.animUntil = now + 400;
    hooks.pushLog(`Metronome — repeating ${TIM_ABILITIES[p.lastEnfeeble].label} (free).`);
    resolveTimAbility(p, p.lastEnfeeble, targetId ?? p.targetId ?? undefined, mobs, now, hooks, {
      free: true,
    });
    return;
  }

  if (!opts.free) {
    p.mp -= def.mp;
    p.recasts[id] = now + def.recastMs;
  }
  p.anim = "cast";
  p.animUntil = now + 500;

  const sealBonus = now < p.timeSealUntil;
  const combatStats = hooks.playerCombatStats(p);

  // Heals
  if (def.category === "heal" && def.heal) {
    const { mnd } = combatStats;
    const heal = Math.floor((def.heal + mnd * 1.5) * (p.aether ? 1.05 : 1));
    p.hp = Math.min(p.maxHp, p.hp + heal);
    hooks.pushLog(`${def.label} restores ${heal} HP.`);
    return;
  }

  // Self time / enhance / JA buffs
  if (
    id === "quicken" ||
    id === "quicken_ii" ||
    id === "tempo" ||
    id === "tempo_ii" ||
    id === "allegro" ||
    id === "allegro_ii" ||
    id === "haste" ||
    id === "hastega" ||
    id === "overclock"
  ) {
    applySelfHaste(p, now, def.haste ?? 0.2, def.durationMs ?? 60_000, def.move);
    if (id === "overclock") p.overclockUntil = now + (def.durationMs ?? 10_000);
    if (id === "allegro" || id === "allegro_ii" || id === "hastega") {
      const radius = def.aoe ?? 10;
      const allies = hooks.allPlayers?.() ?? [];
      const dfn = hooks.dist ?? dist;
      let n = 1;
      for (const ally of allies) {
        if (ally === p) continue;
        if (dfn(p.x, p.z, ally.x, ally.z) > radius) continue;
        applySelfHaste(ally, now, def.haste ?? 0.2, def.durationMs ?? 60_000, def.move);
        n += 1;
      }
      hooks.pushLog(
        n > 1
          ? `${def.label} — chrona tempo on ${n} allies.`
          : id.startsWith("allegro")
            ? `${def.label} — party tempo (solo: self haste + move).`
            : `${def.label} — long party chrona (solo: self, 5 min).`,
      );
    } else if (id === "tempo" || id === "tempo_ii") {
      hooks.pushLog(`${def.label} — mobility chrona (move up, mild haste).`);
    } else if (id === "haste") {
      hooks.pushLog(`${def.label} — long sustain haste (weaker than Quicken, lasts longer).`);
    } else {
      hooks.pushLog(`${def.label} — haste surges through you.`);
    }
    return;
  }

  if (id === "time_seal") {
    p.timeSealUntil = now + (def.durationMs ?? 60_000);
    hooks.pushLog("Time Seal — next enfeeble/time spell bites harder.");
    return;
  }

  if (id === "clockwind") {
    const gained = Math.min(150, Math.floor(p.tp / 10));
    p.mp = Math.min(p.maxMp, p.mp + gained);
    p.tp = 0;
    hooks.pushLog(`Clockwind — converted TP into ${gained} MP.`);
    return;
  }

  if (id === "perpetual_motion") {
    p.perpetualUntil = now + (def.durationMs ?? 90_000);
    hooks.pushLog("Perpetual Motion — allegro carriers surge with attack power.");
    return;
  }

  // Targeted / AoE vs mobs
  const needsMob =
    def.needsTarget || def.category === "enfeeble" || id === "split_second" || id === "temporal_distortion";

  if (needsMob) {
    const tid = targetId ?? p.targetId;
    const range = def.range ?? 14;
    const aoe = def.aoe ?? 0;
    // Never fall back to an arbitrary alive mob elsewhere in the world (#47).
    const primary = findMob(mobs, tid);

    if (id === "temporal_distortion") {
      const radius = aoe || range;
      const hits = mobsInRadius(mobs, p.x, p.z, radius);
      if (hits.length === 0) {
        hooks.pushLog("No enemies in range of Temporal Distortion.");
        if (!opts.free) {
          p.mp += def.mp;
          delete p.recasts[id];
        }
        return;
      }
      const focus = hits.find((m) => m.id === tid) ?? hits[0]!;
      p.facing = hooks.facingTo(p.x, p.z, focus.x, focus.z);
      p.targetId = focus.id;
      let killed = 0;
      let totalDmg = 0;
      for (const m of hits) {
        const dmg = temporalDistortionDamage(p, m, now, combatStats);
        totalDmg += dmg;
        m.hp = Math.max(0, m.hp - dmg);
        m.petrifyUntil = now + 60_000;
        m.tdImpactUntil = now + 1400;
        if (m.hp <= 0) {
          m.hp = 0;
          killed += 1;
          hooks.onMobKill?.(m);
        }
      }
      const avg = Math.floor(totalDmg / hits.length);
      hooks.pushLog(
        `Temporal Distortion — ~${avg} earth + time to ${hits.length} enem${hits.length === 1 ? "y" : "ies"}${
          killed ? ` (${killed} fall)` : "; petrify!"
        }`,
      );
      return;
    }

    // AoE enfeebles (ga): hit all in radius of caster
    if (aoe > 0 && def.category === "enfeeble") {
      const hits = mobsInRadius(mobs, p.x, p.z, aoe);
      if (hits.length === 0) {
        hooks.pushLog("No enemies in range.");
        if (!opts.free) {
          p.mp += def.mp;
          delete p.recasts[id];
        }
        return;
      }
      const focus = hits.find((m) => m.id === tid) ?? hits[0]!;
      p.facing = hooks.facingTo(p.x, p.z, focus.x, focus.z);
      p.targetId = focus.id;
      p.lastEnfeeble = id;

      if (id === "dispelga") {
        let total = 0;
        let killed = 0;
        for (const m of hits) {
          const { dmg } = chronaShatter(p, m, now, sealBonus, combatStats);
          total += dmg;
          if (m.hp <= 0) {
            killed += 1;
            hooks.onMobKill?.(m);
          }
        }
        if (sealBonus) p.timeSealUntil = 0;
        hooks.pushLog(
          `Dispelga shatters chrona — ${total} damage across ${hits.length}${killed ? ` (${killed} fall)` : ""}.`,
        );
        return;
      }

      const dur = Math.floor((def.durationMs ?? 30_000) * aetherAmp(p) * (sealBonus ? 1.15 : 1));
      for (const m of hits) applyEnfeeble(m, id, def, now, dur);
      if (sealBonus) p.timeSealUntil = 0;
      hooks.pushLog(`${def.label} hits ${hits.length} enem${hits.length === 1 ? "y" : "ies"}.`);
      return;
    }

    // Single-target
    if (!primary || !primary.alive) {
      hooks.pushLog(`${def.label} needs a target.`);
      if (!opts.free) {
        p.mp += def.mp;
        delete p.recasts[id];
      }
      return;
    }
    const d = dist(p.x, p.z, primary.x, primary.z);
    if (d > range) {
      hooks.pushLog("Target out of range.");
      if (!opts.free) {
        p.mp += def.mp;
        delete p.recasts[id];
      }
      return;
    }
    p.facing = hooks.facingTo(p.x, p.z, primary.x, primary.z);
    p.targetId = primary.id;

    if (id === "split_second") {
      primary.stunUntil = now + (def.durationMs ?? 6_000);
      hooks.pushLog(`Split Second — ${primary.id} is stunned!`);
      return;
    }

    if (id === "dispel") {
      const { dmg, interruptMs } = chronaShatter(p, primary, now, sealBonus, combatStats);
      p.lastEnfeeble = id;
      if (sealBonus) p.timeSealUntil = 0;
      hooks.pushLog(`Dispel shatters chrona — ${dmg} damage, interrupt ${Math.round(interruptMs / 100) / 10}s.`);
      if (primary.hp <= 0) hooks.onMobKill?.(primary);
      return;
    }

    if (def.category === "enfeeble") p.lastEnfeeble = id;
    const dur = Math.floor((def.durationMs ?? 30_000) * aetherAmp(p) * (sealBonus ? 1.15 : 1));
    applyEnfeeble(primary, id, def, now, dur);
    if (sealBonus) p.timeSealUntil = 0;
    hooks.pushLog(enfeebleLog(id, def.label));
    return;
  }

  hooks.pushLog(`${def.label} has no effect yet.`);
}

function enfeebleLog(id: TimAbilityId, label: string): string {
  switch (id) {
    case "distract":
    case "distract_ii":
      return `${label} — enemy accuracy falters.`;
    case "frazzle":
      return `${label} — magic vulnerability (TD hits harder).`;
    case "addle":
      return `${label} — enemy blows weaken.`;
    case "silencega":
      return `${label} — temporal mute (interrupt + drop aggro).`;
    case "paralyga":
      return `${label} — seize spreads through the pack.`;
    case "bind":
    case "bindga":
      return `${label} — rooted in time.`;
    case "slow":
    case "slow_ii":
    case "slowga":
      return `${label} — attack speed crushed.`;
    case "gravity":
    case "gravity_ii":
    case "gravityga":
      return `${label} — movement weighed down.`;
    default:
      return `${label} lands.`;
  }
}

function applyEnfeeble(
  m: TimMob,
  id: TimAbilityId,
  def: (typeof TIM_ABILITIES)[TimAbilityId],
  now: number,
  dur: number,
) {
  if (def.swingPenalty) {
    m.slowUntil = now + dur;
    m.swingPenalty = Math.max(m.swingPenalty, def.swingPenalty);
  }
  if (def.movePenalty) {
    m.gravityUntil = now + dur;
    m.gravityPct = Math.max(m.gravityPct, def.movePenalty);
  }
  if (id === "bind" || id === "bindga") m.bindUntil = now + dur;
  if (id === "distract" || id === "distract_ii") {
    m.distractUntil = now + dur;
    m.distractAcc = Math.max(m.distractAcc, id === "distract_ii" ? 28 : 15);
  }
  if (id === "frazzle") m.frazzleUntil = now + dur;
  if (id === "addle") m.addleUntil = now + dur;
  if (id === "paralyga") m.paraUntil = now + dur;
  if (id === "silencega") {
    m.silenceUntil = now + dur;
    // Mute casts; brief swing hitch, but do not drop hate.
    m.nextSwingAt = Math.max(m.nextSwingAt, now + 2200);
  }
}
