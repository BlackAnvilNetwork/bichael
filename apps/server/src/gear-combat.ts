/**
 * Catalog gear stats that feed server combat math (#52).
 * Weapon attack, attributes, HP/MP and accuracy already come from
 * aggregateEquipmentStats in index.ts. This adds armor `def` (mob hits on
 * players) and `mab` (player spell damage).
 */
import { applyMagicAttackBonus, playerDefense } from "@bellgrave/combat";
import { aggregateEquipmentStats } from "@bellgrave/items";

type GearEquip = Parameters<typeof aggregateEquipmentStats>[0];
type Geared = { equip?: GearEquip | null };

/** Summed `def` from equipped catalog gear. */
export function gearDef(p: Geared): number {
  return aggregateEquipmentStats(p.equip ?? {}).def ?? 0;
}

/** Summed `mab` from equipped catalog gear. */
export function gearMab(p: Geared): number {
  return aggregateEquipmentStats(p.equip ?? {}).mab ?? 0;
}

/** VIT defense plus gear `def`; the same number the character sheet shows. */
export function playerDefenseWithGear(p: Geared, vit: number): number {
  return playerDefense(vit, gearDef(p));
}

/** Apply the caster's gear MAB to finished spell damage. */
export function withGearMab(p: Geared, dmg: number): number {
  return applyMagicAttackBonus(dmg, gearMab(p));
}
