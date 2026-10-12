/**
 * Re-process one quarantined chain inbound (see src/lok-deposit-quarantine.ts).
 *
 * Usage (server stopped):
 *   pnpm --filter @bellgrave/server lok:replay-quarantined --list
 *   pnpm --filter @bellgrave/server lok:replay-quarantined <id> [dataDir]
 *
 * Refuses while the game server holds the data-dir lock.
 */
import { depositQuarantinePath, loadDepositQuarantine } from "../src/lok-deposit-quarantine";
import { replayQuarantinedInbound } from "../src/lok-deposit-replay";
import { defaultLokDir } from "../src/lok-world";

const id = process.argv[2]?.trim() ?? "";
const dataDir = process.argv[3]?.trim() || defaultLokDir();

if (!id || id === "--list") {
  const entries = loadDepositQuarantine(depositQuarantinePath(dataDir));
  if (entries.length === 0) console.log("No quarantined chain inbounds in " + dataDir + ".");
  for (const e of entries) {
    console.log(
      e.id + "  " + e.reason + "  token=" + e.tokenId + " nonce=" + e.nonce + " kind=" + (e.inbound?.kind ?? "?") + "  " + e.error,
    );
  }
  if (!id) console.error("Pass an id to replay it.");
  process.exit(id ? 0 : 1);
}

const res = replayQuarantinedInbound({ dataDir, id });
if (!res.ok) {
  console.error(res.error);
  process.exit(1);
}
console.log(
  "Replayed " + id + ": " + res.inbound.kind + " token=" + res.inbound.tokenId + " nonce=" + res.inbound.nonce + ". Removed from quarantine.",
);
process.exit(0);
