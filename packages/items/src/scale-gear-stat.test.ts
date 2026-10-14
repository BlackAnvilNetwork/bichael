import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scaleGearStat } from "./types";
import { aggregateEquipmentStatsScaled, getItem } from "./index";

/**
 * Tests for gear stat scaling by player level vs item level (#103).
 * Formula: effective = floor(catalogStat * playerLevel / itemIlvl)
 * Full stats apply when playerLevel >= itemIlvl.
 */

describe("scaleGearStat helper", () => {
  it("returns full stat when player level equals item level", () => {
    assert.equal(scaleGearStat(20, 28, 28), 20);
    assert.equal(scaleGearStat(7, 28, 28), 7);
    assert.equal(scaleGearStat(29, 28, 28), 29);
  });

  it("returns full stat when player level exceeds item level", () => {
    assert.equal(scaleGearStat(20, 50, 28), 20);
    assert.equal(scaleGearStat(7, 100, 28), 7);
    assert.equal(scaleGearStat(29, 99, 28), 29);
  });

  it("scales stat down when player level is below item level", () => {
    assert.equal(scaleGearStat(20, 14, 28), 10);
    assert.equal(scaleGearStat(7, 14, 28), 3);
    assert.equal(scaleGearStat(29, 14, 28), 14);
  });

  it("floors fractional results", () => {
    assert.equal(scaleGearStat(20, 2, 28), 1);
    assert.equal(scaleGearStat(7, 2, 28), 0);
    assert.equal(scaleGearStat(29, 2, 28), 2);
  });

  it("matches the issue example table for iLv 28 piece", () => {
    const ilv = 28;
    const def = 20;
    const vit = 7;
    const hp = 29;

    assert.equal(scaleGearStat(def, 2, ilv), 1, "level 2: def");
    assert.equal(scaleGearStat(vit, 2, ilv), 0, "level 2: vit");
    assert.equal(scaleGearStat(hp, 2, ilv), 2, "level 2: hp");

    assert.equal(scaleGearStat(def, 14, ilv), 10, "level 14: def");
    assert.equal(scaleGearStat(vit, 14, ilv), 3, "level 14: vit");
    assert.equal(scaleGearStat(hp, 14, ilv), 14, "level 14: hp");

    assert.equal(scaleGearStat(def, 28, ilv), 20, "level 28: def");
    assert.equal(scaleGearStat(vit, 28, ilv), 7, "level 28: vit");
    assert.equal(scaleGearStat(hp, 28, ilv), 29, "level 28: hp");

    assert.equal(scaleGearStat(def, 50, ilv), 20, "level 50+: def");
    assert.equal(scaleGearStat(vit, 50, ilv), 7, "level 50+: vit");
    assert.equal(scaleGearStat(hp, 50, ilv), 29, "level 50+: hp");
  });

  it("handles edge cases gracefully", () => {
    assert.equal(scaleGearStat(0, 10, 20), 0, "zero stat");
    assert.equal(scaleGearStat(-5, 10, 20), 0, "negative stat");
    assert.equal(scaleGearStat(10, 0, 20), 0, "zero player level");
    assert.equal(scaleGearStat(10, -5, 20), 0, "negative player level");
    assert.equal(scaleGearStat(10, 20, 0), 10, "zero item level (use full)");
    assert.equal(scaleGearStat(10, 20, -5), 10, "negative item level (use full)");
    assert.equal(scaleGearStat(Number.NaN, 10, 20), 0, "NaN stat");
    assert.equal(scaleGearStat(10, Number.NaN, 20), 0, "NaN player level");
    assert.equal(scaleGearStat(10, 20, Number.NaN), 10, "NaN item level (use full)");
  });
});

describe("aggregateEquipmentStatsScaled", () => {
  const IRON_MAIL = 5;

  it("catalog Iron Mail fixture has expected values", () => {
    const mail = getItem(IRON_MAIL);
    assert.ok(mail, "Iron Mail exists in catalog");
    assert.equal(mail.craftLevel, 28);
    assert.equal(mail.stats?.def, 20);
    assert.equal(mail.stats?.vit, 7);
    assert.equal(mail.stats?.hp, 29);
    assert.equal(mail.slot, "body");
  });

  it("returns full stats at item level", () => {
    const stats = aggregateEquipmentStatsScaled({ body: IRON_MAIL }, 28);
    assert.equal(stats.def, 20);
    assert.equal(stats.vit, 7);
    assert.equal(stats.hp, 29);
  });

  it("returns full stats above item level", () => {
    const stats = aggregateEquipmentStatsScaled({ body: IRON_MAIL }, 50);
    assert.equal(stats.def, 20);
    assert.equal(stats.vit, 7);
    assert.equal(stats.hp, 29);
  });

  it("scales stats at level 14 (half of 28)", () => {
    const stats = aggregateEquipmentStatsScaled({ body: IRON_MAIL }, 14);
    assert.equal(stats.def, 10);
    assert.equal(stats.vit, 3);
    assert.equal(stats.hp, 14);
  });

  it("scales stats at level 2 (minimal)", () => {
    const stats = aggregateEquipmentStatsScaled({ body: IRON_MAIL }, 2);
    assert.equal(stats.def, 1);
    assert.equal(stats.vit, 0);
    assert.equal(stats.hp, 2);
  });

  it("aggregates multiple items with different iLevels", () => {
    const BRONZE_CAP = 104;
    const cap = getItem(BRONZE_CAP);
    assert.ok(cap, "Bronze Cap exists");
    const capIlv = cap.craftLevel ?? 1;

    const stats = aggregateEquipmentStatsScaled({ body: IRON_MAIL, head: BRONZE_CAP }, 10);

    const mailDef = scaleGearStat(20, 10, 28);
    const capDef = scaleGearStat(cap.stats?.def ?? 0, 10, capIlv);
    assert.equal(stats.def, mailDef + capDef, "aggregates scaled def from both items");
  });

  it("ignores items in wrong slots", () => {
    const stats = aggregateEquipmentStatsScaled({ head: IRON_MAIL }, 28);
    assert.equal(stats.def ?? 0, 0, "body armor in head slot is ignored");
    assert.equal(stats.vit ?? 0, 0);
    assert.equal(stats.hp ?? 0, 0);
  });

  it("returns empty stats for empty equipment", () => {
    const stats = aggregateEquipmentStatsScaled({}, 50);
    assert.equal(stats.def ?? 0, 0);
    assert.equal(stats.str ?? 0, 0);
  });
});
