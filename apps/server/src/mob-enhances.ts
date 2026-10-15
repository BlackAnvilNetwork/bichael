/**
 * Enemy enhancements that Unravel and Unweave strip.
 * Protect, Shell, Haste, Stoneskin, and Berserk are cast by field mobs.
 * False Guard stays on the list because Rogue already applies it.
 * Player enfeebles (Dia, Bio, Slow, Silence, and the rest) are not enhancements.
 * Innate magResist is not an enhancement — Unravel does not strip it.
 */
import { magicResistMul } from "@bellgrave/combat";
import { asCastWindup, interruptCastOnDamage } from "./mob-cast-interrupt";

export type MobEnhanceHost = {
  protectUntil?: number;
  protectPhysMul?: number;
  shellUntil?: number;
  shellMagMul?: number;
  hasteUntil?: number;
  hastePct?: number;
  stoneskinUntil?: number;
  stoneskinAbsorb?: number;
  atkBuffUntil?: number;
  atkBuffMul?: number;
  falseGuardUntil?: number;
  /**
   * Innate magic defense (MND). Magic hits consult it before Shell.
   * Not an enhancement — stripMobEnhances leaves it alone.
   */
  magResist?: number;
};

function read(host: MobEnhanceHost, key: keyof MobEnhanceHost): number {
  const value = host[key];
  return typeof value === "number" ? value : 0;
}

export function emptyMobEnhances(): Required<MobEnhanceHost> {
  return {
    protectUntil: 0,
    protectPhysMul: 1,
    shellUntil: 0,
    shellMagMul: 1,
    hasteUntil: 0,
    hastePct: 0,
    stoneskinUntil: 0,
    stoneskinAbsorb: 0,
    atkBuffUntil: 0,
    atkBuffMul: 1,
    falseGuardUntil: 0,
    magResist: 0,
  };
}

/** Names of enhancements that are still up. Order is stable for logs. */
export function activeMobEnhances(host: MobEnhanceHost, now: number): string[] {
  const names: string[] = [];
  if (read(host, "protectUntil") > now) names.push("Protect");
  if (read(host, "shellUntil") > now) names.push("Shell");
  if (read(host, "hasteUntil") > now) names.push("Haste");
  if (read(host, "stoneskinUntil") > now && read(host, "stoneskinAbsorb") > 0) names.push("Stoneskin");
  if (read(host, "atkBuffUntil") > now) names.push("Berserk");
  if (read(host, "falseGuardUntil") > now) names.push("False Guard");
  return names;
}

/** Clear every active enhancement. Returns the names removed. */
export function stripMobEnhances(host: MobEnhanceHost, now: number): string[] {
  const names = activeMobEnhances(host, now);
  if (names.length === 0) return names;
  host.protectUntil = 0;
  host.protectPhysMul = 1;
  host.shellUntil = 0;
  host.shellMagMul = 1;
  host.hasteUntil = 0;
  host.hastePct = 0;
  host.stoneskinUntil = 0;
  host.stoneskinAbsorb = 0;
  host.atkBuffUntil = 0;
  host.atkBuffMul = 1;
  host.falseGuardUntil = 0;
  return names;
}

/**
 * Apply Protect / Shell, then Stoneskin.
 * A multiplier never reduces a positive hit to 0; Stoneskin can.
 */
export function takeMobHit(
  host: MobEnhanceHost,
  raw: number,
  kind: "physical" | "magic",
  now: number,
): number {
  if (raw <= 0) return 0;
  let dmg = raw;
  if (kind === "magic") {
    const resist = read(host, "magResist");
    if (resist > 0) dmg = Math.max(1, Math.floor(dmg * magicResistMul(resist)));
  }
  if (kind === "physical" && read(host, "protectUntil") > now) {
    dmg = Math.max(1, Math.floor(dmg * (read(host, "protectPhysMul") || 1)));
  }
  if (kind === "magic" && read(host, "shellUntil") > now) {
    dmg = Math.max(1, Math.floor(dmg * (read(host, "shellMagMul") || 1)));
  }
  const absorb = read(host, "stoneskinAbsorb");
  if (read(host, "stoneskinUntil") > now && absorb > 0) {
    const soaked = Math.min(absorb, dmg);
    host.stoneskinAbsorb = absorb - soaked;
    dmg -= soaked;
    if ((host.stoneskinAbsorb ?? 0) <= 0) {
      host.stoneskinAbsorb = 0;
      host.stoneskinUntil = 0;
    }
  }
  const dealt = Math.max(0, dmg);
  const wind = asCastWindup(host);
  if (wind && dealt > 0) interruptCastOnDamage(wind, now, dealt);
  return dealt;
}
