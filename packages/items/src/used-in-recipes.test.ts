import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG, CATALOG_BY_SLUG } from "./catalog.generated";
import {
  getCraftableItem,
  recipeMaterialGroups,
  recipesUsingMaterial,
  usedInRecipes,
} from "./craft";
import { craftOutputQty } from "./types";

/** Recipe "Used in" lookup for the auction house and bag tooltips (#211). */

const craftable = CATALOG.filter((def) => getCraftableItem(def.id) === def);

function ingredientSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const def of craftable) {
    for (const g of recipeMaterialGroups(def)) for (const o of g.options) slugs.add(o.slug);
  }
  return slugs;
}

describe("recipesUsingMaterial", () => {
  it("lists every craftable recipe for each ingredient, matching the craft data exactly", () => {
    assert.ok(craftable.length > 0, "catalog has craftable recipes");
    for (const slug of ingredientSlugs()) {
      const expected = craftable
        .filter((def) => recipeMaterialGroups(def).some((g) => g.options.some((o) => o.slug === slug)))
        .map((d) => d.id)
        .sort((a, b) => a - b);
      const got = recipesUsingMaterial(slug)
        .map((d) => d.id)
        .sort((a, b) => a - b);
      assert.deepEqual(got, expected, slug);
    }
  });

  it("returns nothing for an item no recipe uses", () => {
    const used = ingredientSlugs();
    const unused = CATALOG.find((def) => !used.has(def.slug));
    assert.ok(unused, "catalog has at least one item no recipe uses");
    assert.deepEqual(recipesUsingMaterial(unused.slug), []);
    assert.deepEqual(usedInRecipes(unused.slug, [], {}), []);
    assert.deepEqual(recipesUsingMaterial("no-such-slug"), []);
  });

  it("returns a copy so callers can't corrupt the index", () => {
    const slug = [...ingredientSlugs()][0]!;
    const first = recipesUsingMaterial(slug);
    first.length = 0;
    assert.ok(recipesUsingMaterial(slug).length > 0);
  });
});

describe("usedInRecipes", () => {
  const recipe = craftable.find((def) => recipeMaterialGroups(def).length >= 2)!;
  const groups = recipeMaterialGroups(recipe);
  const mat = groups[0]!.options[0]!;

  it("reports have/need per ingredient and the recipe yield and skill", () => {
    const rows = usedInRecipes(mat.slug, [], {});
    const row = rows.find((r) => r.def.id === recipe.id)!;
    assert.ok(row, "recipe appears under its ingredient");
    assert.equal(row.outputQty, craftOutputQty(recipe));
    assert.equal(row.craftSkill, recipe.craftSkill);
    assert.equal(row.needLevel, recipe.craftLevel);
    assert.equal(row.skillLevel, 1);
    assert.equal(row.haveAllMaterials, false);
    assert.equal(row.matFrac, 0);
    assert.equal(row.groups.length, groups.length);
    for (const g of row.groups) for (const o of g.options) {
      assert.equal(o.have, 0);
      assert.equal(o.ok, false);
    }
  });

  it("counts bag and gathered base materials like the crafting panel", () => {
    const baseMats: Record<string, number> = {};
    for (const g of groups) baseMats[g.options[0]!.slug] = g.options[0]!.qty;
    const rows = usedInRecipes(mat.slug, [], baseMats, { [recipe.craftSkill!]: { level: 7, xp: 0 } });
    const row = rows.find((r) => r.def.id === recipe.id)!;
    assert.equal(row.haveAllMaterials, true);
    assert.equal(row.matFrac, 1);
    assert.equal(row.skillLevel, 7);
    assert.equal(rows[0]!.haveAllMaterials, true, "ready recipes sort first");

    const bagDef = CATALOG_BY_SLUG[mat.slug]!;
    const partial = usedInRecipes(mat.slug, [{ tokenId: bagDef.id, amount: mat.qty }], {});
    const prow = partial.find((r) => r.def.id === recipe.id)!;
    assert.equal(prow.groups[0]!.options[0]!.have, mat.qty);
    assert.equal(prow.groups[0]!.ok, true);
    assert.equal(prow.haveAllMaterials, false);
    assert.ok(prow.matFrac > 0 && prow.matFrac < 1);
  });

  it("sorts closer recipes ahead of untouched ones", () => {
    const bagDef = CATALOG_BY_SLUG[mat.slug]!;
    const rows = usedInRecipes(mat.slug, [{ tokenId: bagDef.id, amount: 999 }], {});
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1]!;
      const b = rows[k]!;
      assert.ok(
        Number(a.haveAllMaterials) > Number(b.haveAllMaterials) ||
          (a.haveAllMaterials === b.haveAllMaterials && a.matFrac >= b.matFrac),
        "row " + k + " out of order",
      );
    }
  });
});
