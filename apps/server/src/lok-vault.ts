import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Accepted on the local anvil only. Not a mainnet ruleset. */
export const LOCAL_RULESET_HASH = "0x5d9ceefcea8710b7a205f925e26aecb17a3c83aa4b668d12fb76ffafeda3bd38";

/**
 * sha256 of the checked-in engine bundle (contracts/lok-log/engine/pkg/lok_engine.wasm) that
 * checkpoints signed under LOCAL_RULESET_HASH are computed with. LOCAL_RULESET_HASH is an opaque id
 * registered on the local anvil; it is not derived from the wasm, so this pin is the binding.
 * lok-ruleset-pin.test.ts fails when the checked-in wasm drifts from it. When the engine changes on
 * purpose: rebuild the wasm, run contracts/lok-log/engine/scripts/check-wasm-pin.mjs, update this pin,
 * and on any non-local network propose a new ruleset hash for the new bundle.
 */
export const LOCAL_RULESET_WASM_SHA256 = "ee51c9a825f974715f4fa34d6d45137c88a9e44df676e624dd5298c850805fd2";

const CHECKPOINT_TUPLE =
  "(bytes32,bytes32,uint64,uint64,bytes32,bytes32,uint256,uint64,uint256,(uint256,uint32)[])";

export type CastResult = { stdout: string; stderr: string };
export type CastFn = (args: string[]) => Promise<CastResult>;

export type VaultOk = { ok: true; id: string; availableAt: number };
export type VaultErr = { ok: false; error: string; uncertain?: boolean; id?: string };
export type QueuedWithdrawal = {
  id: string;
  tokenId: string;
  amount: string;
  availableAt: number;
  status: "pending" | "claimed";
};

type Env = {
  rpc: string;
  checkpoint: string;
  vault: string;
  kek: string;
  nft: string;
  factory: string;
  rulesets: string;
  ownerKey: string;
  rotatorKey: string;
  proposerKey: string;
  castBin: string;
};

function envOf(env: NodeJS.ProcessEnv): Env {
  const pick = (key: string) => env[key]?.trim() ?? "";
  return {
    rpc: pick("LOK_CHAIN_RPC"),
    checkpoint: pick("LOK_CHECKPOINT"),
    vault: pick("LOK_VAULT"),
    kek: pick("LOK_KEK"),
    nft: pick("LOK_NFT"),
    factory: pick("LOK_FACTORY"),
    rulesets: pick("LOK_RULESETS"),
    ownerKey: pick("LOK_OWNER_KEY"),
    rotatorKey: pick("LOK_ROTATOR_KEY"),
    proposerKey: pick("LOK_PROPOSER_KEY"),
    castBin: pick("LOK_CAST") || "cast",
  };
}

export function spawnCast(bin: string): CastFn {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: 90_000, windowsHide: true, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
        if (err) {
          const wrapped = new Error(String(stderr || err.message || "cast failed"));
          reject(wrapped);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

function word(stdout: string): string {
  return stdout.trim().split(/\s+/)[0] ?? "";
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 280);
}

async function call(cast: CastFn, rpc: string, to: string, sig: string, args: string[] = []): Promise<string> {
  const res = await cast(["call", to, sig, ...args, "--rpc-url", rpc]);
  return word(res.stdout);
}

function sendArgs(to: string, sig: string, args: string[], rpc: string, key: string, value?: string): string[] {
  const out = ["send", to, sig, ...args, "--rpc-url", rpc, "--private-key", key];
  if (value) out.push("--value", value);
  return out;
}

export const LOCAL_ANVIL_CHAIN_ID = 31337n;
/** Anvil's first default MockKEK. Player deposits refuse any other token, including real KEK. */
export const LOCAL_MOCK_KEK = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Per player-initiated deposit. Local test only. */
export const PLAYER_DEPOSIT_CAP = 10_000n;
export const PLAYER_DEPOSIT_GAP_MS = 10_000;

const nextPlayerDeposit = new Map<string, number>();

export function playerDepositGate(input: {
  chainId: bigint;
  token: string;
  amount: bigint;
}): { ok: true } | { ok: false; error: string } {
  if (input.chainId !== LOCAL_ANVIL_CHAIN_ID) {
    return { ok: false, error: "Deposits are only available on local chain 31337. Nothing was minted." };
  }
  if (input.token.toLowerCase() !== LOCAL_MOCK_KEK.toLowerCase()) {
    return { ok: false, error: "Deposits are only available for the local MockKEK token. Nothing was minted." };
  }
  if (input.amount <= 0n || input.amount > PLAYER_DEPOSIT_CAP) {
    return { ok: false, error: "Deposit cap is " + PLAYER_DEPOSIT_CAP.toString() + " KEK. Nothing was minted." };
  }
  return { ok: true };
}

export function allowPlayerDeposit(tokenId: string, now: number): { ok: true } | { ok: false; error: string } {
  const at = nextPlayerDeposit.get(tokenId) ?? 0;
  if (now < at) return { ok: false, error: "Wait a moment before depositing again. Nothing was minted." };
  nextPlayerDeposit.set(tokenId, now + PLAYER_DEPOSIT_GAP_MS);
  return { ok: true };
}

/** Approve the vault and deposit. Never mints. */
export function depositCastArgs(env: Env, tokenId: string, amount: string): string[][] {
  return [
    sendArgs(env.kek, "approve(address,uint256)", [env.vault, amount], env.rpc, env.ownerKey),
    sendArgs(env.checkpoint, "depositKek(uint256,uint256)", [tokenId, amount], env.rpc, env.ownerKey),
  ];
}

export async function debitAfterQueue(
  queue: () => Promise<VaultOk | VaultErr>,
  debit: () => { ok: true } | { ok: false; error: string },
  credit: () => { ok: true } | { ok: false; error: string },
): Promise<(VaultOk & { debited: true }) | (VaultErr & { debited: boolean })> {
  const spent = debit();
  if (!spent.ok) return { ok: false, error: spent.error, debited: false };
  let queued: VaultOk | VaultErr;
  try {
    queued = await queue();
  } catch (err) {
    const back = credit();
    if (!back.ok) {
      return { ok: false, error: "Withdrawal threw and the debit could not be returned. " + back.error, debited: true };
    }
    return { ok: false, error: "Withdrawal was not queued. The debit was returned.", debited: false };
  }
  if (!queued.ok) {
    const back = credit();
    if (!back.ok) {
      return {
        ok: false,
        error: "The vault withdrawal was not queued and the debit could not be returned. " + back.error,
        debited: true,
      };
    }
    return { ok: false, error: queued.error, debited: false };
  }
  return { ...queued, debited: true };
}

let delaySec: number | null = null;
let queues: QueuedWithdrawal[] = [];
let queuePath = "";

export function vaultDelaySec(): number | null {
  return delaySec;
}

export function withdrawalById(id: string): QueuedWithdrawal | undefined {
  return queues.find((row) => row.id === id);
}

export function queuesFor(tokenId: string): { id: string; amount: string; availableAt: number }[] {
  return queues
    .filter((row) => row.tokenId === tokenId && row.status === "pending")
    .map((row) => ({ id: row.id, amount: row.amount, availableAt: row.availableAt }));
}

export function loadQueues(dataDir: string): void {
  queuePath = join(dataDir, "lok-queues.json");
  if (!existsSync(queuePath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(queuePath, "utf8"));
  } catch {
    throw new Error("lok-queues.json could not be read. Refusing to start with an empty queue list.");
  }
  if (Array.isArray(parsed)) queues = parsed as QueuedWithdrawal[];
}

export function writeTextAtomic(path: string, text: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function saveQueues() {
  if (!queuePath) return;
  writeTextAtomic(queuePath, JSON.stringify(queues));
}

function remember(row: QueuedWithdrawal) {
  const idx = queues.findIndex((q) => q.id === row.id);
  if (idx >= 0) queues[idx] = row;
  else queues.push(row);
  saveQueues();
}

export async function readWithdrawDelay(envIn: NodeJS.ProcessEnv = process.env, cast: CastFn = spawnCast(envOf(envIn).castBin)): Promise<void> {
  const env = envOf(envIn);
  if (!env.rpc || !env.vault) return;
  try {
    const raw = await call(cast, env.rpc, env.vault, "withdrawDelay()(uint64)");
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) delaySec = n;
  } catch {
    delaySec = null;
  }
}

export async function depositKekOnchain(
  tokenId: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<{ ok: true } | VaultErr> {
  const env = envOf(envIn);
  if (!env.rpc || !env.checkpoint || !env.vault || !env.kek || !env.ownerKey) {
    return { ok: false, error: "Deposit is not configured on this server. Nothing was minted." };
  }
  if (!/^[1-9][0-9]{0,18}$/.test(amount)) return { ok: false, error: "Bad deposit amount." };
  const amountN = BigInt(amount);
  if (env.kek.toLowerCase() !== LOCAL_MOCK_KEK.toLowerCase()) {
    return { ok: false, error: "Deposits are only available for the local MockKEK token. Nothing was minted." };
  }
  if (amountN > PLAYER_DEPOSIT_CAP) {
    return { ok: false, error: "Deposit cap is " + PLAYER_DEPOSIT_CAP.toString() + " KEK. Nothing was minted." };
  }
  try {
    const chainRaw = word((await cast(["chain-id", "--rpc-url", env.rpc])).stdout);
    const gate = playerDepositGate({ chainId: BigInt(chainRaw), token: env.kek, amount: amountN });
    if (!gate.ok) return gate;
    const paced = allowPlayerDeposit(tokenId, Date.now());
    if (!paced.ok) return paced;
    const balance = BigInt(await call(cast, env.rpc, env.kek, "balanceOf(address)(uint256)", [
      await ownerAddress(cast, env.ownerKey),
    ]));
    if (balance < amountN) {
      return { ok: false, error: "The local depositor does not have enough MockKEK. Nothing was minted." };
    }
    for (const args of depositCastArgs(env, tokenId, amount)) {
      await cast(args);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Deposit was not submitted. " + redact(String(err), [env.ownerKey]) };
  }
}

async function ownerAddress(cast: CastFn, key: string): Promise<string> {
  const res = await cast(["wallet", "address", "--private-key", key]);
  return word(res.stdout);
}

export async function linkCharacterNft(
  tokenId: string,
  job: number,
  playerWallet?: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<{ ok: true; tokenId: string } | VaultErr> {
  const env = envOf(envIn);
  if (!env.rpc || !env.factory || !env.nft || !env.ownerKey) {
    return { ok: false, error: "Character mint is not configured. The log identity was still created." };
  }
  if (!Number.isInteger(job) || job < 0 || job > 255) return { ok: false, error: "That job cannot be minted." };
  const player = playerWallet && isAddress(playerWallet) ? playerWallet.toLowerCase() : "";
  try {
    const chainId = word((await cast(["chain-id", "--rpc-url", env.rpc])).stdout);
    if (BigInt(chainId) !== LOCAL_ANVIL_CHAIN_ID) {
      return { ok: false, error: "Character mint is only submitted on local chain 31337." };
    }
    const owner = (await ownerAddress(cast, env.ownerKey)).toLowerCase();
    const dest = player && player !== owner ? player : owner;
    const give = async (held: string) => {
      if (held === dest) return;
      if (held !== owner) throw new Error("already minted");
      if (dest !== owner) {
        await cast(sendArgs(env.nft, "transferFrom(address,address,uint256)", [owner, dest, tokenId], env.rpc, env.ownerKey));
      }
    };
    let exists = false;
    try {
      const held = (await call(cast, env.rpc, env.nft, "ownerOf(uint256)(address)", [tokenId])).toLowerCase();
      exists = true;
      await give(held);
      return { ok: true, tokenId };
    } catch (err) {
      if (exists) {
        const message = String(err).includes("already minted")
          ? "NFT " + tokenId + " is already minted to someone else. No second mint was sent."
          : "Character NFT could not be moved to the player wallet. " + redact(String(err), [env.ownerKey]);
        return { ok: false, error: message };
      }
    }
    const last = BigInt(await call(cast, env.rpc, env.nft, "nextTokenId()(uint256)"));
    if (last + 1n !== BigInt(tokenId)) {
      return {
        ok: false,
        error: "Refused to mint NFT " + tokenId + " because the checkpoint next id is " + String(last + 1n) + ".",
      };
    }
    const fee = await call(cast, env.rpc, env.factory, "mintFee()(uint256)");
    await cast(sendArgs(env.factory, "createCharacter(uint8)", [String(job)], env.rpc, env.ownerKey, fee));
    await give(owner);
    return { ok: true, tokenId };
  } catch (err) {
    return { ok: false, error: "Character NFT was not minted. " + redact(String(err), [env.ownerKey]) };
  }
}

async function localVaultReady(
  envIn: NodeJS.ProcessEnv,
  cast: CastFn,
): Promise<{ env: ReturnType<typeof envOf>; cast: CastFn } | undefined> {
  const env = envOf(envIn);
  if (!env.rpc || !env.checkpoint || !env.ownerKey || !env.rotatorKey) return undefined;
  if (env.kek && env.kek.toLowerCase() !== LOCAL_MOCK_KEK.toLowerCase()) return undefined;
  try {
    const chainId = word((await cast(["chain-id", "--rpc-url", env.rpc])).stdout);
    if (BigInt(chainId) !== LOCAL_ANVIL_CHAIN_ID) return undefined;
    const server = await ownerAddress(cast, env.ownerKey);
    const active = await call(cast, env.rpc, env.checkpoint, "isActiveSigner(address)(bool)", [server]);
    if (active !== "true") {
      const now = BigInt(word((await cast(["block", "latest", "--rpc-url", env.rpc, "-f", "timestamp"])).stdout));
      await cast(
        sendArgs(env.checkpoint, "addSigner(address,uint64)", [server, (now + 23n * 3600n).toString()], env.rpc, env.rotatorKey),
      );
    }
    return { env, cast };
  } catch (err) {
    console.error("[bellgrave] vault credit was not moved: " + redact(String(err), [env.ownerKey, env.rotatorKey]));
    return undefined;
  }
}

export async function reassignKekOnchain(
  fromId: string,
  toId: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<{ ok: true } | { ok: false; error: string; paused?: boolean }> {
  if (!/^[1-9][0-9]{0,18}$/.test(amount) || fromId === toId) {
    return { ok: false, error: "bad reassign" };
  }
  const ready = await localVaultReady(envIn, cast);
  if (!ready) return { ok: false, error: "vault not ready" };
  try {
    await withKeyQueue(ready.env.ownerKey, () =>
      cast(
        sendArgs(ready.env.checkpoint, "reassignKek(uint256,uint256,uint256)", [fromId, toId, amount], ready.env.rpc, ready.env.ownerKey),
      ),
    );
    return { ok: true };
  } catch (err) {
    const text = redact(String(err), [ready.env.ownerKey, ready.env.rotatorKey]);
    console.error("[bellgrave] vault reassign was not submitted: " + text);
    return { ok: false, error: text, paused: isPausedError(text) };
  }
}

export async function sinkKekOnchain(
  tokenId: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<{ ok: true } | { ok: false; error: string; paused?: boolean }> {
  if (!/^[1-9][0-9]{0,18}$/.test(amount)) return { ok: false, error: "bad sink" };
  const ready = await localVaultReady(envIn, cast);
  if (!ready) return { ok: false, error: "vault not ready" };
  try {
    await withKeyQueue(ready.env.ownerKey, () =>
      cast(sendArgs(ready.env.checkpoint, "sinkKek(uint256,uint256)", [tokenId, amount], ready.env.rpc, ready.env.ownerKey)),
    );
    return { ok: true };
  } catch (err) {
    const text = redact(String(err), [ready.env.ownerKey, ready.env.rotatorKey]);
    console.error("[bellgrave] vault sink was not submitted: " + text);
    return { ok: false, error: text, paused: isPausedError(text) };
  }
}

export type VaultSyncOp =
  | {
      id: string;
      kind: "sink";
      tokenId: string;
      amount: string;
      status: "pending" | "stranded";
      attempts: number;
      lastError?: string;
      updatedAt: number;
    }
  | {
      id: string;
      kind: "reassign";
      fromId: string;
      toId: string;
      amount: string;
      status: "pending" | "stranded";
      attempts: number;
      lastError?: string;
      updatedAt: number;
    };

const STRAND_AFTER = 12;
const keyQueues = new Map<string, Promise<unknown>>();
let pendingOps: VaultSyncOp[] = [];
let pendingPath = "";
let syncBusy = false;
let syncTimer: ReturnType<typeof setInterval> | null = null;

function isPausedError(text: string): boolean {
  return /EnforcedPause|Pausable:\s*paused|contract is paused/i.test(text);
}

/** Serialize cast sends that share one private key so nonces never race. */
export function withKeyQueue<T>(keyId: string, task: () => Promise<T>): Promise<T> {
  const prev = keyQueues.get(keyId) ?? Promise.resolve();
  const next = prev.then(task, task);
  keyQueues.set(
    keyId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function vaultPendingPath(dataDir: string): string {
  return join(dataDir, "lok-vault-pending.json");
}

export function loadVaultPending(path: string): VaultSyncOp[] {
  pendingPath = path;
  if (!existsSync(path)) {
    pendingOps = [];
    return pendingOps;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ops?: VaultSyncOp[] };
    pendingOps = Array.isArray(parsed.ops) ? parsed.ops : [];
  } catch {
    pendingOps = [];
  }
  return pendingOps;
}

function saveVaultPending(): void {
  if (!pendingPath) return;
  writeTextAtomic(pendingPath, JSON.stringify({ ops: pendingOps }));
}

export function listVaultPending(): VaultSyncOp[] {
  return pendingOps.slice();
}

export function enqueueVaultSync(
  op:
    | { kind: "sink"; tokenId: string; amount: string }
    | { kind: "reassign"; fromId: string; toId: string; amount: string },
  dataDir?: string,
): VaultSyncOp {
  if (dataDir && !pendingPath) loadVaultPending(vaultPendingPath(dataDir));
  if (!pendingPath && dataDir) pendingPath = vaultPendingPath(dataDir);
  const row: VaultSyncOp =
    op.kind === "sink"
      ? {
          id: "sink-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
          kind: "sink",
          tokenId: op.tokenId,
          amount: op.amount,
          status: "pending",
          attempts: 0,
          updatedAt: Date.now(),
        }
      : {
          id: "reassign-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
          kind: "reassign",
          fromId: op.fromId,
          toId: op.toId,
          amount: op.amount,
          status: "pending",
          attempts: 0,
          updatedAt: Date.now(),
        };
  pendingOps.push(row);
  saveVaultPending();
  void flushVaultPending();
  return row;
}

async function runOneVaultOp(op: VaultSyncOp): Promise<"done" | "retry" | "strand"> {
  const res =
    op.kind === "sink"
      ? await sinkKekOnchain(op.tokenId, op.amount)
      : await reassignKekOnchain(op.fromId, op.toId, op.amount);
  op.attempts += 1;
  op.updatedAt = Date.now();
  if (res.ok) return "done";
  op.lastError = res.error;
  if (res.paused) return "retry";
  if (op.attempts >= STRAND_AFTER) {
    op.status = "stranded";
    return "strand";
  }
  return "retry";
}

export async function flushVaultPending(
  envIn: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (syncBusy) return;
  syncBusy = true;
  try {
    let i = 0;
    while (i < pendingOps.length) {
      const op = pendingOps[i]!;
      if (op.status === "stranded") {
        i += 1;
        continue;
      }
      const outcome = await runOneVaultOp(op);
      if (outcome === "done") {
        pendingOps.splice(i, 1);
        saveVaultPending();
        continue;
      }
      saveVaultPending();
      if (outcome === "strand") {
        console.error(
          "[bellgrave] vault sync stranded " + op.id + ": " + (op.lastError ?? "unknown"),
        );
      }
      i += 1;
    }
  } finally {
    syncBusy = false;
  }
}

/** Resume persisted sink/reassign ops after restart. Retries until confirmed or stranded. */
export function startVaultSyncWorker(dataDir: string, envIn: NodeJS.ProcessEnv = process.env): void {
  loadVaultPending(vaultPendingPath(dataDir));
  if (pendingOps.length) {
    console.log("[bellgrave] vault pending ops=" + pendingOps.length);
  }
  void flushVaultPending(envIn).catch((err) => console.error("[bellgrave] vault sync", err));
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    void flushVaultPending(envIn).catch((err) => console.error("[bellgrave] vault sync", err));
  }, 5000);
  syncTimer.unref?.();
}

/** True when the checkpoint is paused (or unknown). Callers should not advance vault_claim further. */
export async function checkpointPaused(
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<boolean | null> {
  const env = envOf(envIn);
  if (!env.rpc || !env.checkpoint) return null;
  try {
    const out = await call(cast, env.rpc, env.checkpoint, "paused()(bool)");
    return out === "true";
  } catch {
    return null;
  }
}

/** Refuse in-engine claim when the chain is paused or a stranded sync still needs operator review. */
export async function vaultClaimBlocked(
  envIn: NodeJS.ProcessEnv = process.env,
): Promise<{ blocked: false } | { blocked: true; error: string }> {
  if (pendingOps.some((op) => op.status === "stranded")) {
    return {
      blocked: true,
      error: "A vault sink/reassign is stranded. Operator review is required before more vault claims.",
    };
  }
  const paused = await checkpointPaused(envIn);
  if (paused === true) {
    return {
      blocked: true,
      error: "The vault is paused. In-game KEK claims that need chain sync are held until it unpauses.",
    };
  }
  return { blocked: false };
}

export async function ensureLocalRuleset(
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<void> {
  const env = envOf(envIn);
  if (!env.rpc || !env.rulesets || !env.proposerKey) return;
  try {
    const accepted = await call(cast, env.rpc, env.rulesets, "isAccepted(bytes32)(bool)", [LOCAL_RULESET_HASH]);
    if (accepted === "true") return;
    const delay = await call(cast, env.rpc, env.rulesets, "minDelay()(uint64)");
    await cast(
      sendArgs(env.rulesets, "propose(bytes32,uint64,string)", [LOCAL_RULESET_HASH, delay, "local"], env.rpc, env.proposerKey),
    );
    console.log("[bellgrave] proposed local ruleset. It is not accepted until the registry delay elapses.");
  } catch (err) {
    console.error("[bellgrave] ruleset setup failed: " + redact(String(err), [env.proposerKey, env.ownerKey]));
  }
}

type Body = {
  prevRoot: string;
  newRoot: string;
  fromIndex: string;
  toIndex: string;
  logHash: string;
  rulesetHash: string;
  summary: string;
  inboundConsumed: string;
  kekOut: string;
};

function tupleOf(body: Body): string {
  return `(${body.prevRoot},${body.newRoot},${body.fromIndex},${body.toIndex},${body.logHash},${body.rulesetHash},${body.summary},${body.inboundConsumed},${body.kekOut},[])`;
}

let vaultQueueTail: Promise<void> = Promise.resolve();

function withVaultQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = vaultQueueTail.then(fn, fn);
  vaultQueueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export type LogCheckpoint = {
  player: string;
  prevRoot: string;
  newRoot: string;
  fromIndex: string;
  toIndex: string;
  logHash: string;
  summary: string;
  inboundConsumed: string;
  kekOut: string;
};

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isWord(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Refuse a made-up checkpoint. The body has to name a real log span and the player's wallet. */
export function checkpointReady(
  body: LogCheckpoint | undefined,
  amount: string,
  server: string,
): { ok: true } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "Withdrawal needs a checkpoint from the log. No in-game KEK was spent." };
  if (!isAddress(body.player)) return { ok: false, error: "Withdrawal needs the player's wallet." };
  if (!isAddress(server) || body.player.toLowerCase() === server.toLowerCase()) {
    return { ok: false, error: "The server key cannot stand in as the player." };
  }
  if (!isWord(body.prevRoot) || !isWord(body.newRoot) || !isWord(body.logHash)) {
    return { ok: false, error: "Checkpoint is missing a real log hash." };
  }
  if (body.prevRoot.toLowerCase() === body.newRoot.toLowerCase()) {
    return { ok: false, error: "Checkpoint root was not taken from the log." };
  }
  if (!/^\d+$/.test(body.fromIndex) || !/^\d+$/.test(body.toIndex) || !/^\d+$/.test(body.kekOut)) {
    return { ok: false, error: "Checkpoint index is not a log position." };
  }
  if (BigInt(body.toIndex) <= BigInt(body.fromIndex)) {
    return { ok: false, error: "Checkpoint does not cover a real log position." };
  }
  if (body.kekOut !== amount) return { ok: false, error: "Checkpoint kekOut does not match the withdrawal." };
  return { ok: true };
}

export type WithdrawHooks = {
  beforeSend?: (predictedId: string) => void;
  body?: LogCheckpoint;
  /** Build the body after the on-chain log index is known. A missing body is refused. */
  prepare?: (chain: { fromIndex: string; prevRoot: string }) => LogCheckpoint | undefined;
};

export async function queueKekWithdrawal(
  tokenId: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast?: CastFn,
  hooks?: WithdrawHooks,
): Promise<VaultOk | VaultErr> {
  return withVaultQueue(() => queueKekWithdrawalNow(tokenId, amount, envIn, cast, hooks));
}

async function queueKekWithdrawalNow(
  tokenId: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast?: CastFn,
  hooks?: WithdrawHooks,
): Promise<VaultOk | VaultErr> {
  if (!cast) cast = spawnCast(envOf(envIn).castBin);
  const env = envOf(envIn);
  const secrets = [env.ownerKey, env.rotatorKey, env.proposerKey];
  if (!env.rpc || !env.checkpoint || !env.vault || !env.nft || !env.rulesets || !env.ownerKey || !env.rotatorKey) {
    return { ok: false, error: "Withdrawal is not configured. No in-game KEK was spent." };
  }
  if (!/^[1-9][0-9]{0,18}$/.test(amount)) return { ok: false, error: "Bad withdrawal amount." };
  let broadcast = false;
  let predicted = "";
  try {
    const chainId = word((await cast(["chain-id", "--rpc-url", env.rpc])).stdout);
    if (BigInt(chainId) !== LOCAL_ANVIL_CHAIN_ID) {
      return { ok: false, error: "Withdrawals are only submitted on local chain 31337. No in-game KEK was spent." };
    }
    const server = (await ownerAddress(cast, env.ownerKey)).toLowerCase();
    const prevRoot = (await call(cast, env.rpc, env.checkpoint, "stateRoot(uint256)(bytes32)", [tokenId])).toLowerCase();
    const fromIndex = await call(cast, env.rpc, env.checkpoint, "logIndex(uint256)(uint64)", [tokenId]);
    const version = await call(cast, env.rpc, env.checkpoint, "version(uint256)(uint32)", [tokenId]);
    const drafted = hooks?.body ?? hooks?.prepare?.({ fromIndex, prevRoot });
    const ready = checkpointReady(drafted, amount, server);
    if (!ready.ok) return ready;
    const bodyIn = drafted!;
    const player = bodyIn.player.toLowerCase();
    let nftOwner = (await call(cast, env.rpc, env.nft, "ownerOf(uint256)(address)", [tokenId])).toLowerCase();
    if (nftOwner === server && player !== server) {
      await cast(sendArgs(env.nft, "transferFrom(address,address,uint256)", [server, player, tokenId], env.rpc, env.ownerKey));
      nftOwner = (await call(cast, env.rpc, env.nft, "ownerOf(uint256)(address)", [tokenId])).toLowerCase();
    }
    if (nftOwner !== player) {
      return { ok: false, error: "This character NFT is not held by the player wallet. No in-game KEK was spent." };
    }
    const accepted = await call(cast, env.rpc, env.rulesets, "isAccepted(bytes32)(bool)", [LOCAL_RULESET_HASH]);
    if (accepted !== "true") {
      return { ok: false, error: "The local ruleset is not accepted yet. No in-game KEK was spent." };
    }
    const now = BigInt(word((await cast(["block", "latest", "--rpc-url", env.rpc, "-f", "timestamp"])).stdout));
    const active = await call(cast, env.rpc, env.checkpoint, "isActiveSigner(address)(bool)", [server]);
    if (active !== "true") {
      const expiry = (now + 23n * 3600n).toString();
      await cast(sendArgs(env.checkpoint, "addSigner(address,uint64)", [server, expiry], env.rpc, env.rotatorKey));
    }
    if (prevRoot !== bodyIn.prevRoot.toLowerCase() || fromIndex !== bodyIn.fromIndex) {
      return { ok: false, error: "On-chain log position does not match this checkpoint. Nothing was invented." };
    }
    const body: Body = {
      prevRoot: bodyIn.prevRoot,
      newRoot: bodyIn.newRoot,
      fromIndex: bodyIn.fromIndex,
      toIndex: bodyIn.toIndex,
      logHash: bodyIn.logHash,
      rulesetHash: LOCAL_RULESET_HASH,
      summary: bodyIn.summary,
      inboundConsumed: bodyIn.inboundConsumed,
      kekOut: bodyIn.kekOut,
    };
    const encoded = word(
      (await cast(["abi-encode", "x(" + CHECKPOINT_TUPLE + ")", tupleOf(body)])).stdout,
    );
    const bodyHash = word((await cast(["keccak", encoded])).stdout);
    const deadline = (now + 3600n).toString();
    const typed = JSON.stringify({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Checkpoint: [
          { name: "tokenId", type: "uint256" },
          { name: "player", type: "address" },
          { name: "version", type: "uint32" },
          { name: "deadline", type: "uint256" },
          { name: "bodyHash", type: "bytes32" },
        ],
      },
      primaryType: "Checkpoint",
      domain: {
        name: "CharacterCheckpoint",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: env.checkpoint,
      },
      message: {
        tokenId: Number(tokenId),
        player: player,
        version: Number(version),
        deadline: Number(deadline),
        bodyHash,
      },
    });
    const sig = word((await cast(["wallet", "sign", "--data", typed, "--private-key", env.ownerKey])).stdout);
    const before = BigInt(await call(cast, env.rpc, env.vault, "nextWithdrawalId()(uint256)"));
    predicted = (before + 1n).toString();
    hooks?.beforeSend?.(predicted);
    broadcast = true;
    await cast(
      sendArgs(
        env.checkpoint,
        "checkpoint(uint256," + CHECKPOINT_TUPLE + ",(uint32,uint256,bytes))",
        [tokenId, tupleOf(body), `(${version},${deadline},${sig})`],
        env.rpc,
        env.ownerKey,
      ),
    );
    const after = BigInt(await call(cast, env.rpc, env.vault, "nextWithdrawalId()(uint256)"));
    if (after !== before + 1n) {
      return {
        ok: false,
        uncertain: true,
        id: predicted,
        error: "The vault withdrawal may already be queued. Spendable KEK stays reserved until the chain is checked.",
      };
    }
    const id = after.toString();
    const packed = (await cast(["call", env.vault, "withdrawals(uint256)(address,uint64,uint8,uint256)", id, "--rpc-url", env.rpc])).stdout;
    const availableAt = Number(packed.trim().split(/\s+/)[1] ?? "0");
    remember({ id, tokenId, amount, availableAt, status: "pending" });
    return { ok: true, id, availableAt };
  } catch (err) {
    if (broadcast) {
      return {
        ok: false,
        uncertain: true,
        id: predicted,
        error: "The vault send did not finish. Spendable KEK stays reserved until the chain is checked. " + redact(String(err), secrets),
      };
    }
    return { ok: false, error: "Withdrawal was not queued. No in-game KEK was spent. " + redact(String(err), secrets) };
  }
}

export async function claimQueuedWithdrawal(
  id: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<{ ok: true } | VaultErr> {
  const env = envOf(envIn);
  const row = queues.find((q) => q.id === id && q.status === "pending");
  if (!row) return { ok: false, error: "That withdrawal is not queued on this server." };
  if (!env.rpc || !env.vault || !env.ownerKey) return { ok: false, error: "Claim is not configured." };
  try {
    await cast(sendArgs(env.vault, "claim(uint256)", [id], env.rpc, env.ownerKey));
    row.status = "claimed";
    saveQueues();
    return { ok: true };
  } catch (err) {
    const text = String(err);
    if (/NotYet|0x0d3f7776/i.test(text)) {
      return { ok: false, error: "That withdrawal is still inside the vault delay. Nothing was paid out." };
    }
    return { ok: false, error: "Claim was not paid. " + redact(text, [env.ownerKey]) };
  }
}

/** True only when this id is this character's withdrawal for this amount. Null if the chain cannot be read. No private key. */
export async function vaultWithdrawalMatches(
  id: string,
  token: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast?: CastFn,
): Promise<boolean | null> {
  const env = envOf(envIn);
  if (!env.rpc || !env.vault) return null;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(token) || !/^\d+$/.test(amount)) return null;
  const run = cast ?? spawnCast(env.castBin);
  try {
    const owner = word((await run(["call", env.vault, "withdrawalToken(uint256)(uint256)", id, "--rpc-url", env.rpc])).stdout);
    if (!owner || BigInt(owner) !== BigInt(token)) return false;
    const packed = (await run(["call", env.vault, "withdrawals(uint256)(address,uint64,uint8,uint256)", id, "--rpc-url", env.rpc])).stdout;
    const got = packed.trim().split(/\s+/)[3] ?? "0";
    return BigInt(got) === BigInt(amount) && BigInt(got) > 0n;
  } catch {
    return null;
  }
}
