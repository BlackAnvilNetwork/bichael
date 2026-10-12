import { applyChainInbound, type ChainInbound } from "./lok-chain";
import { dataDirLockedByOther } from "./data-dir-lock";
import { DepositQuarantine, depositQuarantinePath } from "./lok-deposit-quarantine";
import { LokWorld } from "./lok-world";

type InboundTarget = Pick<LokWorld, "noteCustodyInbound" | "depositKek" | "importItem">;

/**
 * Operator replay of one quarantined chain inbound, once its cause is fixed.
 * Refuses while another process (the game server) holds the data-dir lock, and
 * refuses a nonce while a lower nonce for the same token is still quarantined.
 * Removes the entry only after the engine credited it. The engine's own nonce
 * check means a second run, or a run after a crash between credit and removal,
 * is refused instead of crediting twice.
 */
export function replayQuarantinedInbound(opts: {
  dataDir: string;
  id: string;
  /** Test hook. Defaults to opening the log in dataDir (which also takes the lock). */
  open?: () => InboundTarget;
}): { ok: true; inbound: ChainInbound } | { ok: false; error: string } {
  const holder = dataDirLockedByOther(opts.dataDir);
  if (holder) {
    return {
      ok: false,
      error:
        "A server (pid " + holder.pid + ", since " + holder.startedAt + ") has this data dir open. Stop it first. Nothing was replayed.",
    };
  }
  const quarantine = new DepositQuarantine(depositQuarantinePath(opts.dataDir));
  const entry = quarantine.list().find((row) => row.id === opts.id);
  if (!entry) return { ok: false, error: "No quarantined inbound with id " + opts.id + ". Nothing was replayed." };
  if (!entry.inbound) {
    return { ok: false, error: "Entry " + opts.id + " did not decode, so it cannot be replayed. Review it and remove it by hand." };
  }
  if (quarantine.hasLowerNonce(entry.inbound.tokenId, entry.inbound.nonce)) {
    return {
      ok: false,
      error:
        "Token " + entry.inbound.tokenId + " has a lower nonce still quarantined. Replay that one first. Nothing was replayed.",
    };
  }
  const lok = (opts.open ?? (() => LokWorld.open(opts.dataDir)))();
  const res = applyChainInbound(lok, entry.inbound);
  if (!res.ok) {
    const hint = /already consumed/i.test(res.error)
      ? " This nonce is already on the log; if it was credited by an earlier replay, remove the entry by hand."
      : "";
    return { ok: false, error: "The engine refused " + opts.id + ": " + res.error + "." + hint + " The entry was kept." };
  }
  quarantine.remove(opts.id);
  return { ok: true, inbound: entry.inbound };
}
