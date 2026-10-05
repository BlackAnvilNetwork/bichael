import { isTrainerFreeAbility, trainerAbilityDustCost } from "./trainer";
/**
 * Full Time Mage ability kit (design §9), with MVP-feel numbers where noted.
 * Non-starter abilities are bought from the Trainer (deposited KEK 500–10000). Dust is no longer the spend currency.
 * Free starter: Rest, Flux, Temporal Distortion (see trainer.ts).
 */

import { SHARED_ABILITY_ICON } from "./shared-icons";

export const TIM_ABILITY_IDS = [
  // stances / utility
  "flux",
  "aether",
  "rest",
  // time magic — quicken line
  "quicken",
  "quicken_ii",
  "tempo",
  "tempo_ii",
  "allegro",
  "allegro_ii",
  // enhancing
  "haste",
  "hastega",
  // enfeebling
  "slow",
  "gravity",
  "bind",
  "dispel",
  "slow_ii",
  "gravity_ii",
  "distract",
  "frazzle",
  "slowga",
  "addle",
  "bindga",
  "paralyga",
  "silencega",
  "gravityga",
  "dispelga",
  "distract_ii",
  // healing
  "cure",
  "cure_ii",
  "cure_iii",
  "cure_iv",
  // job abilities
  "temporal_distortion",
  "metronome",
  "split_second",
  "overclock",
  "time_seal",
  "clockwind",
  "perpetual_motion",
] as const;

export type TimAbilityId = (typeof TIM_ABILITY_IDS)[number];

export type AbilityCategory =
  | "stance"
  | "utility"
  | "time"
  | "enhance"
  | "enfeeble"
  | "heal"
  | "ja";

export type TimAbilityDef = {
  id: TimAbilityId;
  label: string;
  /** Short text fallback when icon fails to load. */
  glyph: string;
  /**
   * Ability icon URL under /icons/abilities/.
   * Defaults to `/icons/abilities/{id}.png` via `abilityIconUrl`.
   * Icons are fantasy art gens with #FF00FF chroma, then baked to alpha.
   */
  icon?: string;
  unlockLevel: number;
  mp: number;
  recastMs: number;
  category: AbilityCategory;
  /** Self magical haste fraction (attack speed). */
  haste?: number;
  /** Self/ally move speed bonus fraction. */
  move?: number;
  durationMs?: number;
  heal?: number;
  /** Enemy move penalty (gravity/slow family). */
  movePenalty?: number;
  /** Enemy swing haste penalty. */
  swingPenalty?: number;
  range?: number;
  /** AoE radius (ga spells / allegro / TD). */
  aoe?: number;
  needsTarget?: boolean;
  staffRequired?: boolean;
};

export const TIM_ABILITIES: Record<TimAbilityId, TimAbilityDef> = {
  flux: {
    id: "flux",
    label: "Flux",
    glyph: "Fx",
    unlockLevel: 1,
    mp: 0,
    recastMs: 30_000,
    category: "stance",
    staffRequired: true,
  },
  aether: {
    id: "aether",
    label: "Aether",
    glyph: "Ae",
    unlockLevel: 15,
    mp: 0,
    recastMs: 30_000,
    category: "stance",
    staffRequired: true,
  },
  rest: {
    id: "rest",
    label: "Rest",
    glyph: "Rs",
    unlockLevel: 1,
    mp: 0,
    recastMs: 0,
    category: "utility",
  },

  quicken: {
    id: "quicken",
    label: "Quicken",
    glyph: "Qk",
    unlockLevel: 5,
    mp: 12,
    recastMs: 15_000,
    category: "time",
    /** Burst attack-speed — short, potent. */
    haste: 0.35,
    durationMs: 90_000,
  },
  quicken_ii: {
    id: "quicken_ii",
    label: "Quicken II",
    glyph: "Q2",
    unlockLevel: 20,
    mp: 24,
    recastMs: 18_000,
    category: "time",
    haste: 0.42,
    durationMs: 120_000,
  },
  tempo: {
    id: "tempo",
    label: "Tempo",
    glyph: "Tp",
    unlockLevel: 33,
    mp: 36,
    recastMs: 20_000,
    category: "time",
    /** Mobility chrona — milder haste, stronger move. */
    haste: 0.22,
    move: 0.18,
    durationMs: 150_000,
  },
  tempo_ii: {
    id: "tempo_ii",
    label: "Tempo II",
    glyph: "T2",
    unlockLevel: 50,
    mp: 48,
    recastMs: 20_000,
    category: "time",
    haste: 0.28,
    move: 0.24,
    durationMs: 180_000,
  },
  allegro: {
    id: "allegro",
    label: "Allegro",
    glyph: "Al",
    unlockLevel: 55,
    mp: 60,
    recastMs: 30_000,
    category: "time",
    /** Party chrona (solo: self) — balanced haste + move, AoE radius. */
    haste: 0.35,
    move: 0.12,
    durationMs: 180_000,
    aoe: 10,
  },
  allegro_ii: {
    id: "allegro_ii",
    label: "Allegro II",
    glyph: "A2",
    unlockLevel: 75,
    mp: 75,
    recastMs: 35_000,
    category: "time",
    haste: 0.42,
    move: 0.2,
    durationMs: 150_000,
    aoe: 10,
  },

  haste: {
    id: "haste",
    label: "Haste",
    glyph: "Ha",
    unlockLevel: 40,
    mp: 40,
    recastMs: 20_000,
    category: "enhance",
    /** Long sustain — weaker than Quicken, lasts much longer. */
    haste: 0.28,
    durationMs: 300_000,
  },
  hastega: {
    id: "hastega",
    label: "Hastega",
    glyph: "Hg",
    unlockLevel: 60,
    mp: 80,
    recastMs: 45_000,
    category: "enhance",
    haste: 0.28,
    durationMs: 300_000,
    aoe: 10,
  },

  slow: {
    id: "slow",
    label: "Slow",
    glyph: "Sl",
    unlockLevel: 8,
    mp: 15,
    recastMs: 20_000,
    category: "enfeeble",
    durationMs: 30_000,
    swingPenalty: 0.25,
    needsTarget: true,
    range: 14,
  },
  gravity: {
    id: "gravity",
    label: "Gravity",
    glyph: "Gv",
    unlockLevel: 15,
    mp: 24,
    recastMs: 45_000,
    category: "enfeeble",
    durationMs: 45_000,
    movePenalty: 0.26,
    needsTarget: true,
    range: 14,
  },
  bind: {
    id: "bind",
    label: "Bind",
    glyph: "Bd",
    unlockLevel: 18,
    mp: 20,
    recastMs: 30_000,
    category: "enfeeble",
    durationMs: 20_000,
    needsTarget: true,
    range: 14,
  },
  dispel: {
    id: "dispel",
    label: "Dispel",
    glyph: "Dp",
    unlockLevel: 32,
    mp: 25,
    recastMs: 10_000,
    category: "enfeeble",
    /** Chrona shatter — interrupt + MND damage (does not strip your enfeebles). */
    needsTarget: true,
    range: 14,
  },
  slow_ii: {
    id: "slow_ii",
    label: "Slow II",
    glyph: "S2",
    unlockLevel: 35,
    mp: 28,
    recastMs: 20_000,
    category: "enfeeble",
    durationMs: 40_000,
    swingPenalty: 0.35,
    needsTarget: true,
    range: 14,
  },
  gravity_ii: {
    id: "gravity_ii",
    label: "Gravity II",
    glyph: "G2",
    unlockLevel: 38,
    mp: 36,
    recastMs: 50_000,
    category: "enfeeble",
    durationMs: 50_000,
    movePenalty: 0.35,
    needsTarget: true,
    range: 14,
  },
  distract: {
    id: "distract",
    label: "Distract",
    glyph: "Di",
    unlockLevel: 42,
    mp: 30,
    recastMs: 20_000,
    category: "enfeeble",
    /** Accuracy down — you hit more often. */
    durationMs: 60_000,
    needsTarget: true,
    range: 14,
  },
  frazzle: {
    id: "frazzle",
    label: "Frazzle",
    glyph: "Fz",
    unlockLevel: 42,
    mp: 30,
    recastMs: 20_000,
    category: "enfeeble",
    /** Magic vuln — Temporal Distortion and chrona nukes hit harder. */
    durationMs: 60_000,
    needsTarget: true,
    range: 14,
  },
  slowga: {
    id: "slowga",
    label: "Slowga",
    glyph: "Sg",
    unlockLevel: 45,
    mp: 48,
    recastMs: 45_000,
    category: "enfeeble",
    durationMs: 30_000,
    swingPenalty: 0.25,
    aoe: 10,
    range: 14,
  },
  addle: {
    id: "addle",
    label: "Addle",
    glyph: "Ad",
    unlockLevel: 48,
    mp: 35,
    recastMs: 20_000,
    category: "enfeeble",
    /** Time-muddled strikes — enemy physical damage down. */
    durationMs: 60_000,
    needsTarget: true,
    range: 14,
  },
  bindga: {
    id: "bindga",
    label: "Bindga",
    glyph: "Bg",
    unlockLevel: 52,
    mp: 45,
    recastMs: 60_000,
    category: "enfeeble",
    durationMs: 18_000,
    aoe: 10,
    range: 14,
  },
  paralyga: {
    id: "paralyga",
    label: "Paralyga",
    glyph: "Pg",
    unlockLevel: 55,
    mp: 50,
    recastMs: 45_000,
    category: "enfeeble",
    /** AoE seize — chance to skip swings. */
    durationMs: 30_000,
    aoe: 10,
    range: 14,
  },
  silencega: {
    id: "silencega",
    label: "Silencega",
    glyph: "Si",
    unlockLevel: 55,
    mp: 50,
    recastMs: 45_000,
    category: "enfeeble",
    /** Temporal mute — interrupt + drop aggro (pack control). */
    durationMs: 12_000,
    aoe: 10,
    range: 14,
  },
  gravityga: {
    id: "gravityga",
    label: "Gravityga",
    glyph: "Gg",
    unlockLevel: 58,
    mp: 60,
    recastMs: 75_000,
    category: "enfeeble",
    durationMs: 45_000,
    movePenalty: 0.3,
    aoe: 10,
    range: 14,
  },
  dispelga: {
    id: "dispelga",
    label: "Dispelga",
    glyph: "Dg",
    unlockLevel: 65,
    mp: 55,
    recastMs: 60_000,
    category: "enfeeble",
    /** AoE chrona shatter — interrupt + damage. */
    aoe: 10,
    range: 14,
  },
  distract_ii: {
    id: "distract_ii",
    label: "Distract II",
    glyph: "D2",
    unlockLevel: 70,
    mp: 40,
    recastMs: 20_000,
    category: "enfeeble",
    durationMs: 90_000,
    needsTarget: true,
    range: 14,
  },

  cure: {
    id: "cure",
    label: "Cure",
    glyph: "Cu",
    unlockLevel: 5,
    mp: 8,
    recastMs: 6_000,
    category: "heal",
    heal: 45,
  },
  cure_ii: {
    id: "cure_ii",
    label: "Cure II",
    glyph: "C2",
    unlockLevel: 16,
    mp: 24,
    recastMs: 8_000,
    category: "heal",
    heal: 110,
  },
  cure_iii: {
    id: "cure_iii",
    label: "Cure III",
    glyph: "C3",
    unlockLevel: 30,
    mp: 46,
    recastMs: 10_000,
    category: "heal",
    heal: 220,
  },
  cure_iv: {
    id: "cure_iv",
    label: "Cure IV",
    glyph: "C4",
    unlockLevel: 55,
    mp: 88,
    recastMs: 12_000,
    category: "heal",
    heal: 400,
  },

  temporal_distortion: {
    id: "temporal_distortion",
    label: "T. Distortion",
    glyph: "TD",
    unlockLevel: 1,
    mp: 0,
    /** TEMP: 20s for playtest — restore 2h for ship. */
    recastMs: 20_000,
    category: "ja",
    aoe: 15,
    range: 15,
  },
  metronome: {
    id: "metronome",
    label: "Metronome",
    glyph: "Mt",
    unlockLevel: 20,
    mp: 0,
    recastMs: 3 * 60 * 1000,
    category: "ja",
  },
  split_second: {
    id: "split_second",
    label: "Split Second",
    glyph: "SS",
    unlockLevel: 30,
    mp: 0,
    recastMs: 60_000,
    category: "ja",
    durationMs: 6_000,
    needsTarget: true,
    range: 12,
  },
  overclock: {
    id: "overclock",
    label: "Overclock",
    glyph: "Oc",
    unlockLevel: 40,
    mp: 0,
    recastMs: 5 * 60 * 1000,
    category: "ja",
    haste: 0.8,
    durationMs: 10_000,
  },
  time_seal: {
    id: "time_seal",
    label: "Time Seal",
    glyph: "TS",
    unlockLevel: 50,
    mp: 0,
    recastMs: 10 * 60 * 1000,
    category: "ja",
    durationMs: 60_000,
  },
  clockwind: {
    id: "clockwind",
    label: "Clockwind",
    glyph: "Cw",
    unlockLevel: 55,
    mp: 0,
    recastMs: 5 * 60 * 1000,
    category: "ja",
  },
  perpetual_motion: {
    id: "perpetual_motion",
    label: "P. Motion",
    glyph: "PM",
    unlockLevel: 75,
    mp: 0,
    recastMs: 20 * 60 * 1000,
    category: "ja",
    durationMs: 90_000,
  },
};

/** Clockwind (#68): 10 TP per MP, up to 150 MP, never past max MP. Only the TP actually converted is spent. */
export const CLOCKWIND_TP_PER_MP = 10;
export const CLOCKWIND_MAX_MP = 150;
export function clockwindConversion(
  tp: number,
  mp: number,
  maxMp: number,
): { mpGained: number; tpSpent: number } {
  const room = Math.max(0, Math.floor(maxMp - mp));
  const fromTp = Math.floor(Math.max(0, tp) / CLOCKWIND_TP_PER_MP);
  const mpGained = Math.max(0, Math.min(CLOCKWIND_MAX_MP, fromTp, room));
  return { mpGained, tpSpent: mpGained * CLOCKWIND_TP_PER_MP };
}

export function isTimAbilityId(id: string): id is TimAbilityId {
  return Object.prototype.hasOwnProperty.call(TIM_ABILITIES, id);
}

/** Public URL for a Time Mage ability icon (baked PNG under /icons/abilities). */
export function timAbilityIconUrl(id: TimAbilityId | string): string {
  const shared = SHARED_ABILITY_ICON[id];
  if (shared) return shared;
  if (isTimAbilityId(id) && TIM_ABILITIES[id].icon) return TIM_ABILITIES[id].icon!;
  return `/icons/abilities/${id}.png`;
}

/** Category helper — scroll-style TIM spells (legacy; Trainer now sells all non-free). */
export function isTimSpell(id: TimAbilityId): boolean {
  const cat = TIM_ABILITIES[id].category;
  return cat === "time" || cat === "enhance" || cat === "enfeeble" || cat === "heal";
}

/** KEK cost to learn a spell scroll. Dust is no longer the spend currency. */
export function timSpellDustCost(id: TimAbilityId): number {
  return trainerAbilityDustCost(TIM_ABILITIES[id].unlockLevel);
}

/**
 * Abilities the player can use: level-gated innates + learned spells (also level-gated).
 */
export function timAbilitiesUnlocked(
  level: number,
  learned: readonly string[] = [],
): TimAbilityId[] {
  const learnedSet = new Set(learned);
  return TIM_ABILITY_IDS.filter((id) => {
    const def = TIM_ABILITIES[id];
    if (def.unlockLevel > level) return false;
    if (isTrainerFreeAbility(id)) return true;
    return learnedSet.has(id);
  });
}

export function timSpellsForSale(level: number, learned: readonly string[]): TimAbilityId[] {
  const learnedSet = new Set(learned);
  return TIM_ABILITY_IDS.filter((id) => {
    if (isTrainerFreeAbility(id)) return false;
    if (learnedSet.has(id)) return false;
    return TIM_ABILITIES[id].unlockLevel <= level;
  });
}

/**
 * Default hotbar priority — one pick per combat role, then lower-tier fallbacks.
 * UI slices to ~10 keys; full kit lives in the spellbook tabs.
 */
export function timHotbarOrder(unlocked: readonly TimAbilityId[]): TimAbilityId[] {
  const set = new Set(unlocked);
  const preferred: TimAbilityId[] = [
    // always-on tools
    "flux",
    "aether",
    "temporal_distortion",
    "overclock",
    // haste line (best first)
    "hastega",
    "allegro_ii",
    "haste",
    "allegro",
    "tempo_ii",
    "quicken_ii",
    "tempo",
    "quicken",
    // heal / enfeeble / utility (best first)
    "cure_iv",
    "cure_iii",
    "cure_ii",
    "cure",
    "slow_ii",
    "slow",
    "gravity_ii",
    "gravity",
    "metronome",
    "split_second",
    "time_seal",
    "clockwind",
    "perpetual_motion",
    "bind",
    "dispel",
    "distract_ii",
    "distract",
    "frazzle",
    "addle",
    "slowga",
    "bindga",
    "paralyga",
    "silencega",
    "gravityga",
    "dispelga",
  ];

  // Prefer a single ability from each "line" so L75 doesn't fill the bar with every haste tier.
  const LINE: Partial<Record<TimAbilityId, string>> = {
    hastega: "haste",
    allegro_ii: "haste",
    haste: "haste",
    allegro: "haste",
    tempo_ii: "haste",
    quicken_ii: "haste",
    tempo: "haste",
    quicken: "haste",
    cure_iv: "cure",
    cure_iii: "cure",
    cure_ii: "cure",
    cure: "cure",
    slow_ii: "slow",
    slow: "slow",
    gravity_ii: "gravity",
    gravity: "gravity",
  };

  const out: TimAbilityId[] = [];
  const usedLines = new Set<string>();
  for (const id of preferred) {
    if (!set.has(id)) continue;
    const line = LINE[id];
    if (line) {
      if (usedLines.has(line)) continue;
      usedLines.add(line);
    }
    out.push(id);
  }
  return out;
}

/** Spellbook tab order (matches AbilityCategory). */
export const ABILITY_CATEGORY_TABS: { id: AbilityCategory; label: string }[] = [
  { id: "stance", label: "Stance" },
  { id: "time", label: "Time" },
  { id: "enhance", label: "Enhance" },
  { id: "enfeeble", label: "Enfeeble" },
  { id: "heal", label: "Heal" },
  { id: "ja", label: "JA" },
  { id: "utility", label: "Utility" },
];

/** Short player-facing description for tooltips / trainer. */
export const TIM_ABILITY_BLURBS: Record<TimAbilityId, string> = {
  flux: "Staff stance: melee scales from MND, slight move bonus. Cancels Aether.",
  aether: "Staff stance: magic potency up, melee suppressed. Cancels Flux.",
  rest: "Kneel to recover HP/MP over time. Drains TP. Breaks if you move or are hit.",

  quicken: "Burst attack-speed chrona. Short, potent self haste.",
  quicken_ii: "Stronger Quicken — higher haste, longer duration.",
  tempo: "Mobility chrona: mild haste with a strong move-speed bonus.",
  tempo_ii: "Stronger Tempo — more haste and move for a long window.",
  allegro: "Party tempo (solo: self). Haste + move in an area around you.",
  allegro_ii: "Stronger Allegro — top-tier party haste and move.",

  haste: "Long sustain haste. Weaker than Quicken, lasts much longer.",
  hastega: "Long party haste (solo: self). Same potency as Haste, AoE, 5 min.",

  slow: "Single target: crush enemy attack speed.",
  slow_ii: "Stronger Slow — heavier swing penalty, longer duration.",
  slowga: "AoE Slow — pack-wide attack-speed crush.",
  gravity: "Single target: weigh down enemy movement.",
  gravity_ii: "Stronger Gravity — heavier move penalty.",
  gravityga: "AoE Gravity — slow the whole pack’s footwork.",
  bind: "Root a target in place — they cannot move or chase.",
  bindga: "AoE Bind — root the pack briefly.",
  dispel: "Chrona shatter: MND damage + interrupt their next swing. Does not strip your enfeebles.",
  dispelga: "AoE chrona shatter — interrupt and damage nearby enemies.",
  distract: "Lower enemy accuracy so your swings connect more often.",
  distract_ii: "Stronger Distract — deeper accuracy penalty, longer duration.",
  frazzle: "Magic vulnerability — Temporal Distortion hits this target much harder.",
  addle: "Time-muddled strikes — enemy physical damage is reduced.",
  paralyga: "AoE seize — enemies periodically fail to swing.",
  silencega: "Temporal mute — interrupt, drop aggro, pack stands idle until it fades.",

  cure: "Restore a small amount of HP (scales with MND).",
  cure_ii: "Moderate self heal.",
  cure_iii: "Large self heal.",
  cure_iv: "Very large self heal.",

  temporal_distortion: "2-hour ability: AoE earth + time damage. Petrifies hits. Stronger in Aether; Frazzle amps it.",
  metronome: "Free re-cast of your last enfeeble (no MP, ignores that spell’s recast).",
  split_second: "Stun a target for a few seconds.",
  overclock: "Extreme short haste burst (JA).",
  time_seal: "Your next enfeeble or chrona shatter bites harder, then Seal fades.",
  clockwind: "Convert TP into MP (10 TP per MP, up to 150 MP). TP you don't need is kept.",
  perpetual_motion: "For a while, your attacks crit more often and hit harder.",
};

function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export type AbilityTooltip = {
  title: string;
  body: string;
  meta: string;
};

/** Formatted tooltip for HUD / trainer. */
export function timAbilityTooltip(id: TimAbilityId): AbilityTooltip {
  const def = TIM_ABILITIES[id];
  const bits: string[] = [`Lv ${def.unlockLevel}`];
  if (def.mp > 0) bits.push(`MP ${def.mp}`);
  else if (def.category === "ja" || def.category === "stance") bits.push("No MP");
  if (def.recastMs > 0) bits.push(`CD ${formatDuration(def.recastMs)}`);
  if (def.durationMs) bits.push(`Dur ${formatDuration(def.durationMs)}`);
  if (def.haste) bits.push(`Haste +${Math.round(def.haste * 100)}%`);
  if (def.move) bits.push(`Move +${Math.round(def.move * 100)}%`);
  if (def.swingPenalty) bits.push(`Swing −${Math.round(def.swingPenalty * 100)}%`);
  if (def.movePenalty) bits.push(`Move −${Math.round(def.movePenalty * 100)}%`);
  if (def.heal) bits.push(`Heal ${def.heal}+`);
  if (def.aoe) bits.push(`AoE ${def.aoe}`);
  if (def.needsTarget) bits.push("Target");
  if (def.staffRequired) bits.push("Staff (main)");
  return {
    title: def.label,
    body: TIM_ABILITY_BLURBS[id],
    meta: bits.join(" · "),
  };
}
