/**

 * Fighter ability resolution — raw melee kit from FIGHTER_ABILITIES.

 * Motifs: iron sparks, blood-red rage — no magic circles.

 */

import {

  FIGHTER_ABILITIES,

  isFighterAbilityId,

} from "@bellgrave/combat";

import { SIGNATURE_WEAPON_IDS, signatureWeaponEquipped } from "./starter-kit";
import { kitLevel } from "./support-job";

import type { AbilityId } from "@bellgrave/protocol";



export type FighterPlayer = {

  level: number;

  job: string;

  subjob?: string | null;

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

  killingStormUntil: number;

  berserkUntil: number;

  defenderUntil: number;

  aggressorUntil: number;

  restraintUntil: number;

  brazenRushUntil: number;

  warcryUntil: number;

  bloodRageUntil: number;

  fighterRageFlashUntil: number;

  enmity: number;

};



export type FighterMob = {

  id: string;

  name?: string;

  alive: boolean;

  x: number;

  z: number;

  targetId: string | null;

};



export type FighterAlly = FighterPlayer & { wallet: string };



export type FighterHooks = {

  pushLog: (p: FighterPlayer, msg: string) => void;

  stopRest: (p: FighterPlayer, reason?: string) => void;

  facingTo: (ax: number, az: number, bx: number, bz: number) => number;

  findMob: (id: string | null | undefined) => FighterMob | null;

  allPlayers: () => FighterAlly[];

  dist: (ax: number, az: number, bx: number, bz: number) => number;

};






export function greatswordEquipped(p: FighterPlayer): boolean {
  return signatureWeaponEquipped(p, SIGNATURE_WEAPON_IDS.fighter);
}



function spikeEnmity(p: FighterPlayer, amount: number) {

  p.enmity = Math.min(10_000, p.enmity + amount);

}



export function fighterAttackMul(p: FighterPlayer, now: number): number {

  let mul = 1;

  if (now < p.berserkUntil) mul *= 1.25;

  if (now < p.defenderUntil) mul *= 0.75;

  if (now < p.warcryUntil) mul *= 1.15;

  return mul;

}



export function fighterDefenseMul(p: FighterPlayer, now: number): number {

  let mul = 1;

  if (now < p.berserkUntil) mul *= 0.75;

  if (now < p.defenderUntil) mul *= 1.25;

  return mul;

}



export function fighterAccBonus(p: FighterPlayer, now: number): number {

  return now < p.aggressorUntil ? 25 : 0;

}



export function fighterEvaPenalty(p: FighterPlayer, now: number): number {

  return now < p.aggressorUntil ? 25 : 0;

}



export function fighterCritBonus(p: FighterPlayer, now: number): number {

  return now < p.bloodRageUntil ? 0.12 : 0;

}



export function fighterKillingStorm(p: FighterPlayer, now: number): boolean {

  return now < p.killingStormUntil;

}



export function fighterTpGainMul(p: FighterPlayer, now: number): number {

  return now < p.restraintUntil ? 1.5 : 1;

}



export function fighterDoubleAttackChance(p: FighterPlayer, now: number): number {

  return now < p.brazenRushUntil ? 0.45 : 0;

}



export function clearFighterBuffs(p: FighterPlayer) {

  p.killingStormUntil = 0;

  p.berserkUntil = 0;

  p.defenderUntil = 0;

  p.aggressorUntil = 0;

  p.restraintUntil = 0;

  p.brazenRushUntil = 0;

  p.warcryUntil = 0;

  p.bloodRageUntil = 0;

  p.fighterRageFlashUntil = 0;

}



function buffParty(

  caster: FighterAlly,

  now: number,

  hooks: FighterHooks,

  aoe: number,

  apply: (ally: FighterAlly) => void,

) {

  for (const ally of hooks.allPlayers()) {

    if (hooks.dist(caster.x, caster.z, ally.x, ally.z) > aoe) continue;

    apply(ally);

  }

}



export function resolveFighterAbility(

  p: FighterPlayer & { wallet: string },

  id: AbilityId,

  targetId: string | undefined,

  now: number,

  hooks: FighterHooks,

): boolean {

  if (p.job !== "fighter" && p.subjob !== "fighter") return false;

  if (!isFighterAbilityId(id)) {

    hooks.pushLog(p, "That is not a Fighter ability.");

    return true;

  }



  const def = FIGHTER_ABILITIES[id];

  const effLevel = kitLevel(p, "fighter");
  if (def.unlockLevel > effLevel) {

    hooks.pushLog(p, `${def.label} unlocks at level ${def.unlockLevel}.`);

    return true;

  }



  const readyAt = p.recasts[id] ?? 0;

  if (now < readyAt) {

    hooks.pushLog(p, `${def.label} not ready.`);

    return true;

  }

  // Signature weapon only when this job is main (support dual-job skips it).

  if (def.weaponRequired && p.job === "fighter" && !greatswordEquipped(p)) {

    hooks.pushLog(p, "Equip your greatsword first.");

    return true;

  }



  const spend = () => {

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



  if (id === "killing_storm") {

    spend();

    p.killingStormUntil = now + (def.durationMs ?? 45_000);

    p.fighterRageFlashUntil = now + 2600;

    p.anim = "cast";

    p.animUntil = now + 650;

    hooks.pushLog(p, `${def.label} — iron storm; every blow finds a weak point.`);

    return true;

  }



  if (id === "berserk") {

    spend();

    p.berserkUntil = now + (def.durationMs ?? 180_000);

    p.fighterRageFlashUntil = now + 1800;

    p.anim = "cast";

    p.animUntil = now + 500;

    hooks.pushLog(p, `${def.label} — oxblood fury surges through you.`);

    return true;

  }



  if (id === "warcry") {

    spend();

    const dur = def.durationMs ?? 30_000;

    buffParty(p, now, hooks, def.aoe ?? 12, (ally) => {

      ally.warcryUntil = now + dur;

    });

    p.anim = "cast";

    p.animUntil = now + 480;

    hooks.pushLog(p, `${def.label} — the hall rings with battle hunger.`);

    return true;

  }



  if (id === "defender") {

    spend();

    p.defenderUntil = now + (def.durationMs ?? 180_000);

    p.anim = "cast";

    p.animUntil = now + 450;

    hooks.pushLog(p, `${def.label} — you set your guard behind the blade.`);

    return true;

  }



  if (id === "aggressor") {

    spend();

    p.aggressorUntil = now + (def.durationMs ?? 180_000);

    p.anim = "cast";

    p.animUntil = now + 450;

    hooks.pushLog(p, `${def.label} — you press every opening.`);

    return true;

  }



  if (id === "fi_provoke") {

    const tid = targetId ?? p.targetId;

    const m = hooks.findMob(tid);

    if (!m || !m.alive) {

      hooks.pushLog(p, "No target.");

      return true;

    }

    if (hooks.dist(p.x, p.z, m.x, m.z) > (def.range ?? 14)) {

      hooks.pushLog(p, "Too far.");

      return true;

    }

    spend();

    p.facing = hooks.facingTo(p.x, p.z, m.x, m.z);

    m.targetId = p.wallet;

    spikeEnmity(p, 750);

    p.anim = "cast";

    p.animUntil = now + 420;

    hooks.pushLog(p, `${def.label} — ${m.name ?? "enemy"} turns on you!`);

    return true;

  }



  if (id === "restraint") {

    spend();

    p.restraintUntil = now + (def.durationMs ?? 180_000);

    p.anim = "cast";

    p.animUntil = now + 420;

    hooks.pushLog(p, `${def.label} — measured cuts, faster weapon rhythm.`);

    return true;

  }



  if (id === "blood_rage") {

    spend();

    const dur = def.durationMs ?? 30_000;

    buffParty(p, now, hooks, def.aoe ?? 12, (ally) => {

      ally.bloodRageUntil = now + dur;

    });

    p.fighterRageFlashUntil = now + 2000;

    p.anim = "cast";

    p.animUntil = now + 500;

    hooks.pushLog(p, `${def.label} — shared crimson hunger.`);

    return true;

  }



  if (id === "brazen_rush") {

    spend();

    p.brazenRushUntil = now + (def.durationMs ?? 30_000);

    p.fighterRageFlashUntil = now + 2200;

    p.anim = "melee";

    p.animUntil = now + 520;

    hooks.pushLog(p, `${def.label} — steel blurs in a double-strike frenzy.`);

    return true;

  }



  hooks.pushLog(p, `${def.label} is not implemented.`);

  return true;

}


