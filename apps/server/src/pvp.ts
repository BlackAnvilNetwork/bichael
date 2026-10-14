/**
 * Black Anvil PvP — area caps, bounty ledger helpers, synthetic escrow keys (anvil/local).
 *
 * Settlement ETH lives on-chain (PvpBounty escrow). The lok log only mirrors:
 *   pvpBountyOpen / pvpBountyCancel / pvpKill
 */

import { createHash, randomBytes } from "node:crypto";
import {
  ASH_PIT,
  PVP_BOUNTY_WEI,
  cappedMainLevel,
  pvpAreaAt,
  type PvpAreaDef,
} from "@bellgrave/config";
import {
  applyAreaLevelCap,
  abilityUsableUnderCaps,
  type AbilityId,
  type JobId,
} from "@bellgrave/combat";

export { ASH_PIT, PVP_BOUNTY_WEI };

export type PvpBountyReceipt = {
  txHash: `0x${string}`;
  logIndex: number;
  fillKey: string;
};

/**
 * Synthetic escrow receipt for local/anvil only.
 * Callers must check `pvpSyntheticReceiptsAllowed()` before using.
 */
export function syntheticPvpReceipt(tag: string): PvpBountyReceipt {
  const digest = createHash("sha256")
    .update(`lok-pvp:${tag}:`)
    .update(randomBytes(16))
    .digest();
  const txHash = (`0x${digest.toString("hex")}`) as `0x${string}`;
  const logIndex = 0;
  return { txHash, logIndex, fillKey: `${txHash}-${logIndex}` };
}

/** Center spawn for an area (join teleport). */
export function pvpAreaSpawn(area: PvpAreaDef): { x: number; z: number; facing: number } {
  return {
    x: area.spawn.x,
    z: area.spawn.z,
    facing: area.spawn.facing ?? 0,
  };
}

export function areaAtPlayer(x: number, z: number): PvpAreaDef | undefined {
  return pvpAreaAt(x, z);
}

export function effectivePvpMainLevel(actualLevel: number, area: PvpAreaDef | undefined): number {
  return applyAreaLevelCap(actualLevel, area?.levelCap ?? null);
}

export function pvpAbilityAllowed(
  main: JobId,
  actualLevel: number,
  sub: JobId | null | undefined,
  abilityId: AbilityId,
  area: PvpAreaDef | undefined,
): boolean {
  const eff = effectivePvpMainLevel(actualLevel, area);
  return abilityUsableUnderCaps(main, eff, sub, abilityId);
}

/** Both combatants must be in the same PvP area; victim must have an open bounty. */
export function canPvpStrike(
  attacker: { x: number; z: number },
  victim: { x: number; z: number },
  victimHasBounty: boolean,
): { ok: true; area: PvpAreaDef } | { ok: false; reason: string } {
  const a = areaAtPlayer(attacker.x, attacker.z);
  const b = areaAtPlayer(victim.x, victim.z);
  if (!a || !b || a.id !== b.id) {
    return { ok: false, reason: "Not in a PvP area." };
  }
  if (!victimHasBounty) {
    return { ok: false, reason: "Target has no open bounty." };
  }
  return { ok: true, area: a };
}

export function formatCapNotice(area: PvpAreaDef, actualLevel: number): string {
  const eff = cappedMainLevel(actualLevel, area.levelCap);
  const subCap = Math.max(1, Math.floor(area.levelCap / 2));
  if (actualLevel <= area.levelCap) {
    return `${area.name} — PvP. Bounty ${PVP_BOUNTY_WEI} wei. Level cap ${area.levelCap} / support ${subCap}.`;
  }
  return `${area.name} — your power is clamped to L${eff} / support L${subCap} (true level ${actualLevel}).`;
}
