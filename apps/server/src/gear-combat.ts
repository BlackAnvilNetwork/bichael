/**
 * Catalog gear stats that feed server combat math (#52).
 * Weapon attack, attributes, HP/MP and accuracy already come from
 * aggregateEquipmentStats in index.ts. This adds armor `def` (mob hits on
 * players) and `mab` (player spell damage).
 *
 * All gear stats are scaled by player level vs item level (#103):
 * effective = floor(catalogStat * playerLevel / itemIlvl)
 * Full stats apply when playerLevel >= itemIlvl.
 */
import { applyMagicAttackBonus, playerDefense } from "@bellgrave/combat";
import {
  aggregateEquipmentStats,
  aggregateEquipmentStatsScaled,
  EQUIP_SLOTS,
  getItem,
  scaleGearStat,
} from "@bellgrave/items";

type GearEquip = Parameters<typeof aggregateEquipmentStats>[0];
type Geared = { equip?: GearEquip | null; level?: number };

/**
 * Melee Attack: (main-hand Atk or 10) + Atk from every other slot except ranged/ammo.
 * Staffs with no Atk keep the 10 baseline; rings/mittens still add. Bows never stack.
 * Stats are scaled by player level vs item level (#103).
 */
export function meleeAtkBonus(p: Geared): number {
  const equip = p.equip ?? null;
  const mainId = equip?.main;
  if (mainId == null) return 0;
  const main = getItem(mainId);
  if (!main || main.slot !== "main") return 0;
  const playerLevel = p.level ?? 100;
  const mainIlvl = main.craftLevel ?? 1;
  const weaponAtk = scaleGearStat(main.stats?.atk ?? 10, playerLevel, mainIlvl);
  let gearAtk = 0;
  for (const slot of EQUIP_SLOTS) {
    if (slot === "main" || slot === "ranged" || slot === "ammo") continue;
    const tokenId = equip?.[slot];
    if (tokenId == null) continue;
    const def = getItem(tokenId);
    if (!def || def.slot !== slot) continue;
    const slotIlvl = def.craftLevel ?? 1;
    gearAtk += scaleGearStat(def.stats?.atk ?? 0, playerLevel, slotIlvl);
  }
  return weaponAtk + gearAtk;
}

/** Summed `def` from equipped catalog gear, scaled by player level (#103). */
export function gearDef(p: Geared): number {
  const playerLevel = p.level ?? 100;
  return aggregateEquipmentStatsScaled(p.equip ?? {}, playerLevel).def ?? 0;
}

/** Summed `mab` from equipped catalog gear, scaled by player level (#103). */
export function gearMab(p: Geared): number {
  const playerLevel = p.level ?? 100;
  return aggregateEquipmentStatsScaled(p.equip ?? {}, playerLevel).mab ?? 0;
}

/** Summed `mdb` from equipped catalog gear, scaled by player level. Incoming magic consults this (#81). */
export function gearMdb(p: Geared): number {
  const playerLevel = p.level ?? 100;
  return Math.max(0, Math.floor(aggregateEquipmentStatsScaled(p.equip ?? {}, playerLevel).mdb ?? 0));
}

/** VIT defense plus gear `def`; the same number the character sheet shows. */
export function playerDefenseWithGear(p: Geared, vit: number): number {
  return playerDefense(vit, gearDef(p));
}

/** Percent healing bonus from equipped `healPotency`, scaled by player level (#103). */
export function gearHealPotency(p: Geared): number {
  const playerLevel = p.level ?? 100;
  return Math.max(0, Math.floor(aggregateEquipmentStatsScaled(p.equip ?? {}, playerLevel).healPotency ?? 0));
}

/** Apply percent `healPotency` to a finished heal amount (Cleric, TIM, Battlemage). */
export function withHealPotency(p: Geared, amount: number, potency = gearHealPotency(p)): number {
  const pct = Math.max(0, Math.floor(potency));
  const raw = pct > 0 ? Math.floor((amount * (100 + pct)) / 100) : amount;
  return Math.max(1, raw);
}

/** Flat HP/sec from equipped `regen`, scaled by player level (#103). */
export function gearRegen(p: Geared): number {
  const playerLevel = p.level ?? 100;
  return Math.max(0, Math.floor(aggregateEquipmentStatsScaled(p.equip ?? {}, playerLevel).regen ?? 0));
}

/** Apply the caster's gear MAB to finished spell damage. */
export function withGearMab(p: Geared, dmg: number): number {
  return applyMagicAttackBonus(dmg, gearMab(p));
}
