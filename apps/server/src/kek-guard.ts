/** In-process reserve and per-token lock for spendable KEK. Not a mint. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const reserved = new Map<string, bigint>();
const tails = new Map<string, Promise<void>>();
const playerTails = new Map<string, Promise<void>>();
const claimBusy = new Set<string>();
const claimNotBefore = new Map<string, number>();

/** One claim cast at a time per character, and not more than once per five seconds. */
export const CLAIM_GAP_MS = 5_000;

export type WithdrawIntent = { token: string; amount: string; id: string | null };

export function withdrawIntentPath(dataDir: string): string {
  return join(dataDir, "lok-withdraw-intents.json");
}

export function reservedOf(token: string): bigint {
  return reserved.get(token) ?? 0n;
}

export function withKekLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(token) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    token,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** One craft or trainer buy at a time for this character. The lock covers the check and the spend. */
export function withPlayerAction<T>(playerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = playerTails.get(playerId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  playerTails.set(
    playerId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Serialize a KEK spend and the grant that follows it.
 * A second overlapping call waits, re-checks, and does not spend when the first already took the cost.
 */
export async function withPlayerCharge(
  playerId: string,
  stillOk: () => boolean,
  reserve: () => (() => void) | null,
  spend: () => Promise<{ ok: true } | { ok: false; error: string }>,
  grant: () => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withPlayerAction(playerId, async () => {
    if (!stillOk()) return { ok: false, error: "no longer available" };
    const undo = reserve();
    if (!undo) return { ok: false, error: "no longer available" };
    const paid = await spend();
    if (!paid.ok) {
      undo();
      return paid;
    }
    grant();
    return { ok: true };
  });
}

export function reserveKek(
  token: string,
  amount: bigint,
  balance: bigint,
): { ok: true } | { ok: false; error: string } {
  if (amount <= 0n) return { ok: false, error: "Bad KEK amount. Nothing was reserved." };
  const hold = reservedOf(token);
  if (balance < hold + amount) {
    const free = balance > hold ? balance - hold : 0n;
    return { ok: false, error: "Need " + amount.toString() + " KEK (you have " + free.toString() + " spendable). Nothing was queued." };
  }
  reserved.set(token, hold + amount);
  return { ok: true };
}

export function releaseKek(token: string, amount: bigint): { ok: true } | { ok: false; error: string } {
  const hold = reservedOf(token);
  if (amount < 0n || hold < amount) return { ok: false, error: "Reserved KEK could not be returned." };
  const next = hold - amount;
  if (next === 0n) reserved.delete(token);
  else reserved.set(token, next);
  return { ok: true };
}

function atomicWrite(path: string, text: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function isIntent(value: unknown): value is WithdrawIntent {
  if (!value || typeof value !== "object") return false;
  const row = value as { token?: unknown; amount?: unknown; id?: unknown };
  if (typeof row.token !== "string" || row.token.length === 0 || row.token.length > 80) return false;
  if (typeof row.amount !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.amount)) return false;
  if (row.id === null) return true;
  return typeof row.id === "string" && /^[0-9]+$/.test(row.id);
}

/** Read intents. A missing file is an empty list. A partial or corrupt file throws so boot does not forget a debit. */
export function readWithdrawIntents(path: string): WithdrawIntent[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("lok-withdraw-intents.json could not be read. Refusing to start with an empty intent list.");
  }
  if (!Array.isArray(parsed) || !parsed.every(isIntent)) {
    throw new Error("lok-withdraw-intents.json is not a list of withdrawal intents.");
  }
  return parsed;
}

export function writeWithdrawIntents(path: string, intents: WithdrawIntent[]): void {
  atomicWrite(path, JSON.stringify(intents));
}

/** One open intent per token. The per-token KEK lock allows only one withdrawal attempt at a time. */
export function upsertWithdrawIntent(path: string, intent: WithdrawIntent): void {
  const next = readWithdrawIntents(path).filter((row) => row.token !== intent.token);
  next.push(intent);
  writeWithdrawIntents(path, next);
}

export function removeWithdrawIntent(path: string, token: string): void {
  writeWithdrawIntents(
    path,
    readWithdrawIntents(path).filter((row) => row.token !== token),
  );
}

/**
 * Boot reconcile. An id that exists on chain is debited. An id that does not, or a null id
 * (the queue never returned), is released. A chain check that cannot be answered keeps the intent.
 */
export async function reconcileWithdrawIntents(args: {
  intents: WithdrawIntent[];
  existsOnChain: (intent: WithdrawIntent) => Promise<boolean | null> | boolean | null;
  debit: (token: string, amount: string) => { ok: true } | { ok: false; error: string };
}): Promise<WithdrawIntent[]> {
  const keep: WithdrawIntent[] = [];
  for (const intent of args.intents) {
    if (intent.id == null) continue;
    let exists: boolean | null;
    try {
      exists = await args.existsOnChain(intent);
    } catch {
      exists = null;
    }
    if (exists === null) {
      keep.push(intent);
      continue;
    }
    if (!exists) continue;
    const spent = args.debit(intent.token, intent.amount);
    if (!spent.ok) keep.push(intent);
  }
  return keep;
}

type VaultOk = { ok: true; id: string; availableAt: number };
type VaultErr = { ok: false; error: string; uncertain?: boolean; id?: string };

/**
 * Reserve spendable KEK, write the intent, then queue. The log debit runs only after the queue exists.
 * A failed queue releases the reserve and drops the intent. The per-token lock is held for the whole attempt
 * so a transfer cannot spend the same deposit while the vault call is in flight.
 * If the queue exists but the log debit fails, the reserve and the intent stay so a restart can debit.
 */
export async function guardedWithdraw(args: {
  token: string;
  amount: string;
  balanceOf: () => string;
  debit: () => { ok: true } | { ok: false; error: string };
  queue: () => Promise<VaultOk | VaultErr>;
  noteIntent?: (intent: WithdrawIntent) => void;
  clearIntent?: () => void;
  /** After a send that threw or timed out, true means this withdrawal is the one on chain. */
  confirm?: (id: string) => Promise<boolean | null>;
}): Promise<VaultOk | VaultErr> {
  return withKekLock(args.token, async () => {
    let cost: bigint;
    let bal: bigint;
    try {
      cost = BigInt(args.amount);
      bal = BigInt(args.balanceOf());
    } catch {
      return { ok: false, error: "Bad KEK amount. Nothing was spent." };
    }
    const held = reserveKek(args.token, cost, bal);
    if (!held.ok) return held;
    const release = () => releaseKek(args.token, cost);
    try {
      args.noteIntent?.({ token: args.token, amount: args.amount, id: null });
    } catch {
      const back = release();
      if (!back.ok) return { ok: false, error: "Withdrawal intent could not be saved and the reserve could not be returned." };
      return { ok: false, error: "Withdrawal intent could not be saved. Nothing was queued." };
    }
    let queued: VaultOk | VaultErr;
    try {
      queued = await args.queue();
    } catch {
      return {
        ok: false,
        uncertain: true,
        error: "Withdrawal threw after it was reserved. Spendable KEK stays reserved until the chain is checked.",
      };
    }
    if (!queued.ok && queued.uncertain) {
      if (queued.id) {
        try {
          args.noteIntent?.({ token: args.token, amount: args.amount, id: queued.id });
        } catch {
          /* the predicted id from before the send is enough for boot */
        }
      }
      if (queued.id && args.confirm) {
        let found: boolean | null = null;
        try {
          found = await args.confirm(queued.id);
        } catch {
          found = null;
        }
        if (found === true) {
          const spent = args.debit();
          if (!spent.ok) {
            return {
              ok: false,
              error: "The vault withdrawal is on chain, but spendable KEK was not debited. It stays reserved. " + spent.error,
            };
          }
          try {
            args.clearIntent?.();
          } catch {
            /* a leftover intent retries and the engine rejects a second debit */
          }
          const back = release();
          if (!back.ok) return { ok: false, error: "Withdrawal was debited, but the reservation could not be cleared." };
          return { ok: true, id: queued.id, availableAt: 0 };
        }
        if (found === false) {
          const back = release();
          try {
            args.clearIntent?.();
          } catch {
            /* boot will see the id is not this withdrawal */
          }
          if (!back.ok) return { ok: false, error: "Withdrawal was not on chain and the reserve could not be returned." };
          return { ok: false, error: "Withdrawal was not queued. Reserved KEK was returned." };
        }
      }
      return queued;
    }
    if (!queued.ok) {
      const back = release();
      try {
        args.clearIntent?.();
      } catch {
        /* a predicted id stays until boot sees it is not on chain */
      }
      if (!back.ok) return { ok: false, error: queued.error + " Reserved KEK could not be returned." };
      return queued;
    }
    try {
      args.noteIntent?.({ token: args.token, amount: args.amount, id: queued.id });
    } catch {
      return {
        ok: false,
        error: "The vault withdrawal was queued, but the intent id was not saved. Spendable KEK stays reserved.",
      };
    }
    const spent = args.debit();
    if (!spent.ok) {
      return {
        ok: false,
        error: "The vault withdrawal was queued, but spendable KEK was not debited. It stays reserved. " + spent.error,
      };
    }
    try {
      args.clearIntent?.();
    } catch {
      /* the debit landed; a leftover intent retries and the engine rejects a second debit */
    }
    const back = release();
    if (!back.ok) return { ok: false, error: "Withdrawal was debited, but the reservation could not be cleared." };
    return queued;
  });
}

/** Serialize any other spend of this character's KEK behind an in-flight withdrawal. */
export function guardedKekMove<T>(token: string, fn: () => T | Promise<T>): Promise<T> {
  return withKekLock(token, async () => await fn());
}

export function beginClaim(token: string, now: number): { ok: true } | { ok: false; error: string } {
  if (claimBusy.has(token)) return { ok: false, error: "A claim is already in progress." };
  const notBefore = claimNotBefore.get(token) ?? 0;
  if (now < notBefore) return { ok: false, error: "Wait a moment before claiming again." };
  claimBusy.add(token);
  claimNotBefore.set(token, now + CLAIM_GAP_MS);
  return { ok: true };
}

export function endClaim(token: string): void {
  claimBusy.delete(token);
}

/** Reject before any cast. A foreign id does not start a vault claim. */
export function prepareClaim(
  callerToken: string,
  row: { tokenId: string } | undefined,
  now: number,
): { ok: true } | { ok: false; error: string } {
  const gate = beginClaim(callerToken, now);
  if (!gate.ok) return gate;
  if (!row) {
    endClaim(callerToken);
    return { ok: false, error: "That withdrawal is not queued on this server." };
  }
  if (row.tokenId !== callerToken) {
    endClaim(callerToken);
    return { ok: false, error: "That withdrawal belongs to another character." };
  }
  return { ok: true };
}
