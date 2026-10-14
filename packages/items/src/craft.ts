import { CATALOG, CATALOG_BY_ID, CATALOG_BY_SLUG } from "./catalog.generated";
import { craftOutputQty, type CraftSkill, type ItemDef } from "./types";

export const CRAFT_SKILLS: CraftSkill[] = [
  "smithing",
  "woodworking",
  "leathercraft",
  "clothcraft",
  "bonecraft",
  "goldsmithing",
  "alchemy",
  "cooking",
];

export const CRAFT_SKILL_LABEL: Record<CraftSkill, string> = {
  smithing: "Smithing",
  woodworking: "Woodworking",
  leathercraft: "Leathercraft",
  clothcraft: "Clothcraft",
  bonecraft: "Bonecraft",
  goldsmithing: "Goldsmithing",
  alchemy: "Alchemy",
  cooking: "Cooking",
};

export type RecipeMat = { slug: string; qty: number; name: string };
/** One AND-slot; `options` are OR alternatives (first affordable wins at craft time). */
export type RecipeMatGroup = { options: RecipeMat[] };

/** Display name (lowercase, stripped pack counts) → slug. */
const NAME_TO_SLUG: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const it of CATALOG) {
    const key = normalizeMatName(it.name);
    if (!m.has(key)) m.set(key, it.slug);
    // Also index without trailing ×N pack suffixes in the catalog name itself.
    const bare = key.replace(/×\d+$/u, "").trim();
    if (bare && !m.has(bare)) m.set(bare, it.slug);
  }
  return m;
})();

function normalizeMatName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/×/g, "×");
}

function parseOneMat(raw: string): RecipeMat | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(.+?)\s*[×x]\s*(\d+)\s*$/iu.exec(t);
  const name = (m ? m[1]! : t).trim();
  const qty = m ? Math.max(1, Number(m[2])) : 1;
  const slug = NAME_TO_SLUG.get(normalizeMatName(name));
  if (!slug) return null;
  const def = CATALOG_BY_SLUG[slug];
  return { slug, qty, name: def?.name ?? name };
}

/** Raw display name from a materialsText token (even if unresolved). */
function rawMatName(raw: string): string {
  const t = raw.trim();
  const m = /^(.+?)\s*[×x]\s*(\d+)\s*$/iu.exec(t);
  return (m ? m[1]! : t).trim();
}

export type ParsedMaterialGroups = {
  groups: RecipeMatGroup[];
  /** Names that appear in materialsText but are not in the catalog. */
  unresolved: string[];
  /**
   * False when any comma-separated AND-slot failed to resolve at least one option.
   * Silent drops of such slots used to let Pale Dust alone satisfy multi-mat recipes.
   */
  complete: boolean;
};

/**
 * Parse catalog `materialsText` like `Copper Ore×2, Tin Ore×1, Pale Dust×1`.
 * Supports OR alternatives per slot: `Shade Cotton×2 or Linen Scrap×3, Pale Dust×1`.
 *
 * Fail-closed: a comma-slot with zero resolvable options marks `complete: false`
 * (the slot is NOT silently omitted — callers must refuse to craft).
 */
export function parseMaterialGroupsDetailed(text: string): ParsedMaterialGroups {
  if (!text?.trim()) return { groups: [], unresolved: [], complete: false };
  const groups: RecipeMatGroup[] = [];
  const unresolved: string[] = [];
  let complete = true;
  for (const part of text.split(/,/)) {
    const raw = part.trim();
    if (!raw) continue;
    const options: RecipeMat[] = [];
    let sawAlt = false;
    for (const alt of raw.split(/\bor\b/i)) {
      const token = alt.trim();
      if (!token) continue;
      sawAlt = true;
      const mat = parseOneMat(token);
      if (mat) options.push(mat);
      else unresolved.push(rawMatName(token));
    }
    if (!sawAlt) continue;
    if (options.length === 0) {
      // AND-slot fully unresolved — do not drop it (that undercosts the recipe).
      complete = false;
      continue;
    }
    groups.push({ options });
  }
  if (groups.length === 0) complete = false;
  return { groups, unresolved, complete };
}

/** Parse catalog `materialsText` like `Copper Ore×2, Tin Ore×1, Pale Dust×1`.
 *  Supports OR alternatives per slot: `Shade Cotton×2 or Linen Scrap×3, Pale Dust×1`.
 *  Incomplete / unresolved slots are omitted from the returned groups — use
 *  `parseMaterialGroupsDetailed` / `recipeMaterialsComplete` before crafting.
 */
export function parseMaterialGroups(text: string): RecipeMatGroup[] {
  return parseMaterialGroupsDetailed(text).groups;
}

/** Parse catalog `materialsText` like `Copper Ore×2, Tin Ore×1, Pale Dust×1`. */
export function parseMaterialsText(text: string): RecipeMat[] {
  // Legacy flat view: first option of each OR group.
  return parseMaterialGroups(text).map((g) => g.options[0]!);
}

export function recipeMaterialGroups(def: ItemDef): RecipeMatGroup[] {
  const structured = def.recipe?.materials;
  if (structured?.length) {
    return structured.map((m) => ({
      options: [
        {
          slug: m.slug,
          qty: m.qty,
          name: CATALOG_BY_SLUG[m.slug]?.name ?? m.slug,
        },
      ],
    }));
  }
  if (def.recipe?.materialsText) return parseMaterialGroups(def.recipe.materialsText);
  return [];
}

/** True when every AND-slot in the recipe resolved to ≥1 catalog material. */
export function recipeMaterialsComplete(def: ItemDef): boolean {
  const structured = def.recipe?.materials;
  if (structured?.length) {
    return structured.every((m) => !!CATALOG_BY_SLUG[m.slug] && m.qty > 0);
  }
  const text = def.recipe?.materialsText;
  if (!text?.trim()) return false;
  return parseMaterialGroupsDetailed(text).complete;
}

export function recipeMaterials(def: ItemDef): RecipeMat[] {
  return recipeMaterialGroups(def).map((g) => g.options[0]!);
}

/**
 * Prefer an affordable OR option for display; else the option with the most progress.
 * Prevents "Thread 0/3" while Scrap actually satisfies the slot.
 */
export function displayMatsForRecipe(
  def: ItemDef,
  inventory: { tokenId: number; amount: number }[],
  baseMats: Record<string, number>,
): RecipeMat[] {
  return recipeMaterialGroups(def).map((group) => {
    for (const opt of group.options) {
      if (ownedMatQty(opt.slug, inventory, baseMats) >= opt.qty) return opt;
    }
    let best = group.options[0]!;
    let bestFrac = -1;
    for (const opt of group.options) {
      const have = ownedMatQty(opt.slug, inventory, baseMats);
      const frac = have / Math.max(1, opt.qty);
      if (frac > bestFrac) {
        bestFrac = frac;
        best = opt;
      }
    }
    return best;
  });
}

/** Pick one affordable option per group, or null if any group is unaffordable / recipe incomplete. */
export function pickAffordableMaterials(
  def: ItemDef,
  inventory: { tokenId: number; amount: number }[],
  baseMats: Record<string, number>,
): RecipeMat[] | null {
  if (!recipeMaterialsComplete(def)) return null;
  const groups = recipeMaterialGroups(def);
  if (groups.length === 0) return null;
  const picked: RecipeMat[] = [];
  for (const group of groups) {
    let chosen: RecipeMat | null = null;
    for (const opt of group.options) {
      if (ownedMatQty(opt.slug, inventory, baseMats) >= opt.qty) {
        chosen = opt;
        break;
      }
    }
    if (!chosen) return null;
    picked.push(chosen);
  }
  return picked;
}

export type CraftSkillState = { level: number; xp: number };

export function emptyCraftSkills(): Record<CraftSkill, CraftSkillState> {
  const out = {} as Record<CraftSkill, CraftSkillState>;
  for (const s of CRAFT_SKILLS) out[s] = { level: 1, xp: 0 };
  return out;
}

/** Deep copy craft skill ranks (snapshot / persistence safe). */
export function cloneCraftSkills(
  skills: Partial<Record<string, CraftSkillState>> | null | undefined,
): Record<CraftSkill, CraftSkillState> {
  const out = emptyCraftSkills();
  if (!skills) return out;
  for (const s of CRAFT_SKILLS) {
    const row = skills[s];
    if (row && typeof row === "object") {
      out[s] = {
        level: Math.max(1, Math.floor(Number(row.level) || 1)),
        xp: Math.max(0, Math.floor(Number(row.xp) || 0)),
      };
    }
  }
  return out;
}

/** XP to advance from `level` → level+1. */
export function craftXpToNext(level: number): number {
  return 40 + level * 20;
}

/**
 * XP granted for a successful craft.
 * Early ranks level in a handful of on-tier synths (not 60×1-XP crafts).
 * Trivial recipes (far below skill) still grant a trickle so spam isn't zero.
 */
export function craftXpForRecipe(recipeLevel: number, skillLevel: number): number {
  const need = Math.max(1, recipeLevel);
  const have = Math.max(1, skillLevel);
  const delta = have - need;
  if (delta >= 10) return 2;
  if (delta >= 5) return Math.max(4, Math.floor(need * 2));
  // On-tier or slightly above/below: ~3–5 crafts per early level-up.
  return Math.max(12, need * 12 + Math.max(0, need - have) * 6);
}

export function ownedMatQty(
  slug: string,
  inventory: { tokenId: number; amount: number }[],
  baseMats: Record<string, number>,
): number {
  const def = CATALOG_BY_SLUG[slug];
  const fromInv = def ? inventory.find((i) => i.tokenId === def.id)?.amount ?? 0 : 0;
  const fromBase = baseMats[slug] ?? 0;
  return Math.max(fromInv, fromBase);
}

export type CloseCraftCandidate = {
  def: ItemDef;
  materials: RecipeMat[];
  /** Full OR groups for UI ("Thread or Scrap"). */
  materialGroups: RecipeMatGroup[];
  /** 0–1 fraction of materials satisfied. */
  matFrac: number;
  skillLevel: number;
  needLevel: number;
  canCraft: boolean;
  score: number;
};

/**
 * Rank recipes the player is close to crafting.
 * Prefers high material readiness within a craft-level band.
 */
export function closeCraftRecipes(
  inventory: { tokenId: number; amount: number }[],
  baseMats: Record<string, number>,
  craftSkills: Partial<Record<CraftSkill, CraftSkillState>>,
  opts?: { skill?: CraftSkill | "all"; limit?: number },
): CloseCraftCandidate[] {
  const skillFilter = opts?.skill ?? "all";
  const limit = opts?.limit ?? 12;
  const scored: CloseCraftCandidate[] = [];

  for (const def of CATALOG) {
    if (!def.recipe || !def.craftSkill || def.craftLevel == null) continue;
    if (skillFilter !== "all" && def.craftSkill !== skillFilter) continue;
    if (!recipeMaterialsComplete(def)) continue;
    const groups = recipeMaterialGroups(def);
    if (groups.length === 0) continue;
    const materials = displayMatsForRecipe(def, inventory, baseMats);

    const skillLevel = craftSkills[def.craftSkill]?.level ?? 1;
    const needLevel = def.craftLevel;
    // Hide recipes far above current skill.
    if (needLevel > skillLevel + 8) continue;

    let haveParts = 0;
    for (const group of groups) {
      let best = 0;
      for (const mat of group.options) {
        const have = ownedMatQty(mat.slug, inventory, baseMats);
        best = Math.max(best, Math.min(1, have / mat.qty));
      }
      haveParts += best;
    }
    const matFrac = haveParts / groups.length;
    // Skip recipes with zero materials owned (unless skill-ready and level 1–3 starter).
    if (matFrac <= 0 && !(skillLevel >= needLevel && needLevel <= 3)) continue;

    const levelOk = skillLevel >= needLevel;
    const levelProx = levelOk ? 1 : Math.max(0, 1 - (needLevel - skillLevel) / 8);
    const canCraft = levelOk && pickAffordableMaterials(def, inventory, baseMats) != null;
    const score = matFrac * 100 + levelProx * 35 + (canCraft ? 40 : 0) - Math.max(0, needLevel - skillLevel) * 2;

    scored.push({
      def,
      materials,
      materialGroups: groups,
      matFrac,
      skillLevel,
      needLevel,
      canCraft,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.needLevel - b.needLevel);
  return scored.slice(0, limit);
}

export function getCraftableItem(id: number): ItemDef | undefined {
  const def = CATALOG_BY_ID[id];
  if (!def?.recipe || !def.craftSkill || def.craftLevel == null) return undefined;
  if (!recipeMaterialsComplete(def)) return undefined;
  if (recipeMaterialGroups(def).length === 0) return undefined;
  return def;
}

/** True when `def` is a recipe the craft command accepts (same gate as getCraftableItem). */
function isCraftableRecipe(def: ItemDef): boolean {
  if (!def.recipe || !def.craftSkill || def.craftLevel == null) return false;
  if (!recipeMaterialsComplete(def)) return false;
  return recipeMaterialGroups(def).length > 0;
}

let USED_IN_INDEX: Map<string, ItemDef[]> | null = null;

/** Ingredient slug -> craftable results that take it in any AND-slot or OR option. Built once. */
function usedInIndex(): Map<string, ItemDef[]> {
  if (USED_IN_INDEX) return USED_IN_INDEX;
  const index = new Map<string, ItemDef[]>();
  for (const def of CATALOG) {
    if (!isCraftableRecipe(def)) continue;
    const seen = new Set<string>();
    for (const group of recipeMaterialGroups(def)) {
      for (const opt of group.options) {
        if (seen.has(opt.slug)) continue;
        seen.add(opt.slug);
        const list = index.get(opt.slug);
        if (list) list.push(def);
        else index.set(opt.slug, [def]);
      }
    }
  }
  USED_IN_INDEX = index;
  return index;
}

/**
 * Craftable recipes that use `slug` as an ingredient (#211 "Used in").
 * Reads the same recipe data and craftability gate the craft command uses, so it can't drift.
 */
export function recipesUsingMaterial(slug: string): ItemDef[] {
  return usedInIndex().get(slug)?.slice() ?? [];
}

export type UsedInIngredient = RecipeMat & { have: number; ok: boolean };
export type UsedInGroup = { options: UsedInIngredient[]; ok: boolean };

export type UsedInRecipe = {
  def: ItemDef;
  /** Items produced per craft (pack yield). */
  outputQty: number;
  craftSkill: CraftSkill;
  needLevel: number;
  skillLevel: number;
  /** AND-slots with have/need per OR option. */
  groups: UsedInGroup[];
  /** Every AND-slot has at least one affordable option. */
  haveAllMaterials: boolean;
  /** 0-1 share of AND-slots satisfied (partial credit per slot). */
  matFrac: number;
};

/**
 * Recipes using `slug`, with the player's have/need per ingredient.
 * Sorted: all materials owned first, then closest to complete, then lowest craft level, then name.
 */
export function usedInRecipes(
  slug: string,
  inventory: { tokenId: number; amount: number }[],
  baseMats: Record<string, number>,
  craftSkills?: Partial<Record<CraftSkill, CraftSkillState>>,
): UsedInRecipe[] {
  const out: UsedInRecipe[] = [];
  for (const def of recipesUsingMaterial(slug)) {
    let parts = 0;
    let all = true;
    const groups: UsedInGroup[] = recipeMaterialGroups(def).map((group) => {
      let best = 0;
      const options = group.options.map((opt) => {
        const have = ownedMatQty(opt.slug, inventory, baseMats);
        best = Math.max(best, Math.min(1, have / Math.max(1, opt.qty)));
        return { ...opt, have, ok: have >= opt.qty };
      });
      const ok = options.some((o) => o.ok);
      if (!ok) all = false;
      parts += best;
      return { options, ok };
    });
    const craftSkill = def.craftSkill!;
    out.push({
      def,
      outputQty: craftOutputQty(def),
      craftSkill,
      needLevel: def.craftLevel!,
      skillLevel: craftSkills?.[craftSkill]?.level ?? 1,
      groups,
      haveAllMaterials: all,
      matFrac: groups.length ? parts / groups.length : 0,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.haveAllMaterials) - Number(a.haveAllMaterials) ||
      b.matFrac - a.matFrac ||
      a.needLevel - b.needLevel ||
      a.def.name.localeCompare(b.def.name) ||
      a.def.id - b.def.id,
  );
  return out;
}
