/**
 * Server-side support-job helpers shared by every kit resolver.
 * Main kit: full player level. Support kit: floor(level/2), only from L10.
 */
import { effectiveJobLevel, isJobId, type JobId } from "@bellgrave/combat";

export type DualJobPlayer = { job: string; level: number; subjob?: string | null };

/** Level this player's `job` kit runs at: main = level, support = floor(level/2), else 0. */
export function kitLevel(p: DualJobPlayer, job: JobId): number {
  if (!isJobId(p.job)) return 0;
  const sub = p.subjob && isJobId(p.subjob) ? p.subjob : null;
  return effectiveJobLevel(p.job, p.level, sub, job);
}

/** True when `job` is this player's main or an active (L10+) support job. */
export function hasKit(p: DualJobPlayer, job: JobId): boolean {
  return kitLevel(p, job) > 0;
}
