import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Accepted on the local anvil only. Not a mainnet ruleset. */
export const LOCAL_RULESET_HASH = "0x5d9ceefcea8710b7a205f925e26aecb17a3c83aa4b668d12fb76ffafeda3bd38";

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
  envIn: NodeJS.ProcessEnv = process.env,
  cast: CastFn = spawnCast(envOf(envIn).castBin),
): Promise<{ ok: true; tokenId: string } | VaultErr> {
  const env = envOf(envIn);
  if (!env.rpc || !env.factory || !env.nft || !env.ownerKey) {
    return { ok: false, error: "Character mint is not configured. The log identity was still created." };
  }
  if (!Number.isInteger(job) || job < 0 || job > 255) return { ok: false, error: "That job cannot be minted." };
  try {
    const owner = (await ownerAddress(cast, env.ownerKey)).toLowerCase();
    try {
      const held = (await call(cast, env.rpc, env.nft, "ownerOf(uint256)(address)", [tokenId])).toLowerCase();
      if (held === owner) return { ok: true, tokenId };
      return { ok: false, error: "NFT " + tokenId + " is already minted to someone else. No second mint was sent." };
    } catch {
      /* not minted yet */
    }
    const last = BigInt(await call(cast, env.rpc, env.nft, "nextTokenId()(uint256)"));
    if (last + 1n !== BigInt(tokenId)) {
      return {
        ok: false,
        error: "Refused to mint NFT " + tokenId + " because the checkpoint's next id is " + String(last + 1n) + ".",
      };
    }
    const fee = await call(cast, env.rpc, env.factory, "mintFee()(uint256)");
    await cast(sendArgs(env.factory, "createCharacter(uint8)", [String(job)], env.rpc, env.ownerKey, fee));
    return { ok: true, tokenId };
  } catch (err) {
    return { ok: false, error: "Character NFT was not minted. " + redact(String(err), [env.ownerKey]) };
  }
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

export async function queueKekWithdrawal(
  tokenId: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast?: CastFn,
  hooks?: { beforeSend?: (predictedId: string) => void },
): Promise<VaultOk | VaultErr> {
  return withVaultQueue(() => queueKekWithdrawalNow(tokenId, amount, envIn, cast, hooks));
}

async function queueKekWithdrawalNow(
  tokenId: string,
  amount: string,
  envIn: NodeJS.ProcessEnv = process.env,
  cast?: CastFn,
  hooks?: { beforeSend?: (predictedId: string) => void },
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
    const owner = await ownerAddress(cast, env.ownerKey);
    const nftOwner = await call(cast, env.rpc, env.nft, "ownerOf(uint256)(address)", [tokenId]);
    if (owner.toLowerCase() !== nftOwner.toLowerCase()) {
      return { ok: false, error: "This character NFT is not held by the local owner. No in-game KEK was spent." };
    }
    const accepted = await call(cast, env.rpc, env.rulesets, "isAccepted(bytes32)(bool)", [LOCAL_RULESET_HASH]);
    if (accepted !== "true") {
      return { ok: false, error: "The local ruleset is not accepted yet. No in-game KEK was spent." };
    }
    const now = BigInt(word((await cast(["block", "latest", "--rpc-url", env.rpc, "-f", "timestamp"])).stdout));
    const active = await call(cast, env.rpc, env.checkpoint, "isActiveSigner(address)(bool)", [owner]);
    if (active !== "true") {
      const expiry = (now + 23n * 3600n).toString();
      await cast(sendArgs(env.checkpoint, "addSigner(address,uint64)", [owner, expiry], env.rpc, env.rotatorKey));
    }
    const prevRoot = await call(cast, env.rpc, env.checkpoint, "stateRoot(uint256)(bytes32)", [tokenId]);
    const fromIndex = await call(cast, env.rpc, env.checkpoint, "logIndex(uint256)(uint64)", [tokenId]);
    const inbound = await call(cast, env.rpc, env.checkpoint, "inboundApplied(uint256)(uint64)", [tokenId]);
    const summary = await call(cast, env.rpc, env.checkpoint, "summary(uint256)(uint256)", [tokenId]);
    const version = await call(cast, env.rpc, env.checkpoint, "version(uint256)(uint32)", [tokenId]);
    const chainId = word((await cast(["chain-id", "--rpc-url", env.rpc])).stdout);
    const toIndex = (BigInt(fromIndex) + 1n).toString();
    const body: Body = {
      prevRoot,
      newRoot: prevRoot,
      fromIndex,
      toIndex,
      logHash: word((await cast(["keccak", "lok-queue-" + tokenId + "-" + toIndex + "-" + amount])).stdout),
      rulesetHash: LOCAL_RULESET_HASH,
      summary: summary || "0",
      inboundConsumed: inbound || "0",
      kekOut: amount,
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
        player: owner,
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
