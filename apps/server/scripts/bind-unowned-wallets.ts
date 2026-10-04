/**
 * Attach one wallet to lok-bind rows that have no wallet.
 * First writer wins: a row that already has a wallet is left alone.
 *
 * Usage:
 *   pnpm exec tsx scripts/bind-unowned-wallets.ts <0x-wallet> [dataDir]
 *
 * Does not open the lok log, player saves, or any env file.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type BindChar = { charId?: string; wallet?: string };
type BindFile = { chars?: BindChar[] };

const walletArg = process.argv[2]?.trim().toLowerCase() ?? "";
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.argv[3]?.trim() || join(here, "../data");
const bindPath = join(dataDir, "lok-bind.json");

if (!/^0x[0-9a-f]{40}$/.test(walletArg)) {
  console.error("Wallet must be a 0x address. Nothing was written.");
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(bindPath, "utf8")) as BindFile;
const chars = Array.isArray(parsed.chars) ? parsed.chars : [];
const attached: string[] = [];
const skipped: string[] = [];

for (const row of chars) {
  const charId = typeof row.charId === "string" ? row.charId : "";
  if (!charId) continue;
  const current = typeof row.wallet === "string" ? row.wallet.trim().toLowerCase() : "";
  if (current) {
    skipped.push(charId);
    continue;
  }
  row.wallet = walletArg;
  attached.push(charId);
}

if (attached.length > 0) {
  const tmp = bindPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(parsed, null, 2));
  renameSync(tmp, bindPath);
}

console.log("attached " + attached.length);
for (const id of attached) console.log("attached " + id);
console.log("skipped_owned " + skipped.length);
for (const id of skipped) console.log("skipped_owned " + id);
