/**
 * Local ruleset propose + character NFT link. Writes go through viem on the
 * shared owner-key queue (no private key on the cast argv).
 */
import { isSettlementChain, settlementCurrencyView } from "@bellgrave/config";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { durableWrite } from "./durable-write";
import { chainBoundSendGate, chainBoundXdaiSend, releaseEpochXdai } from "./root-anchor";
import { withOwnerKeyQueue } from "./owner-tx-queue";
import { resolvePublicRpcUrl } from "./public-rpc";

/**
 * sha256 of the checked-in engine bundle (contracts/lok-log/engine/pkg/lok_engine.wasm).
 * lok-ruleset-pin.test.ts fails when the checked-in wasm drifts from it. When the engine changes:
 * rebuild with contracts/lok-log/engine/scripts/check-wasm-pin.mjs --install and update this pin
 * (LOCAL_RULESET_HASH derives automatically).
 * The previous Gnosis propose (wasm 6577236d…, ruleset 0x609dbdea…, tx 0x42ff771b…,
 * deployments/gnosis.json) does not match this bundle. Re-propose before that ruleset is used.
 * This change does not submit that transaction.
 */
export const LOCAL_RULESET_WASM_SHA256 = "4d2610aa110a9f6bb163934d29a6ca7410b98530d59a700d8cd1b66cc5804178";

/**
 * SP1 verifying key of `contracts/lok-log/sp1` (sp1-zkvm 6.9.0).
 * This is the `bytes32()` digest `cargo prove vkey` prints for that guest.
 * A proof under any other key is not a batch of this world. The key changes
 * only after `RulesetRegistry.MIN_DELAY` (one day). This pin is not a proof.
 */
export const LOCAL_SP1_VERIFYING_KEY = "0x00be4fce8613fcbf00a32a17381c8f54b6632eaf74d9a35192986ce93160cf93";

/** Wasm digest and SP1 verifying key for this ruleset. The digest is not a function of the key. */
export type RulesetRecord = {
  wasmSha256: string;
  verifyingKey: string;
};

/** The pinned ruleset. `wasmSha256` is `LOCAL_RULESET_WASM_SHA256`. */
export const LOCAL_RULESET_RECORD: RulesetRecord = {
  wasmSha256: LOCAL_RULESET_WASM_SHA256,
  verifyingKey: LOCAL_SP1_VERIFYING_KEY,
};

/**
 * Ruleset id derived from the wasm pin: `keccak256(utf8(LOCAL_RULESET_WASM_SHA256))`.
 * Used for local anvil acceptance. The Gnosis propose in deployments/gnosis.json is the previous pin.
 * The verifying key is not an input to this hash.
 */
export const LOCAL_RULESET_HASH = keccak256(toBytes(LOCAL_RULESET_WASM_SHA256));

export const LOCAL_ANVIL_CHAIN_ID = 31337n;

export type VaultErr = { ok: false; error: string; uncertain?: boolean; id?: string; needsPlayerMint?: boolean };

export type CharacterMintClientConfig = {
  factory: string;
  nft: string;
  mintFee: string;
  chainId: number;
  rpcUrl: string;
  supportsCreateFor: boolean;
  /**
   * On-chain next NFT id (`nextTokenId + 1`). createCharacterFor requires this exact id —
   * never inflate from the local log bind counter (WrongTokenId / wallet sim fails).
   */
  suggestedTokenId: string;
  /** Job indexes with factory.isStartingJob(job) == true. */
  startingJobs: number[];
  devFaucet: boolean;
  devServerMint: boolean;
  currency: ReturnType<typeof settlementCurrencyView>;
};

type Env = {
  rpc: string;
  nft: string;
  factory: string;
  checkpoint: string;
  rulesets: string;
  ownerKey: string;
  proposerKey: string;
};

function envOf(env: NodeJS.ProcessEnv): Env {
  const pick = (key: string) => env[key]?.trim() ?? "";
  return {
    rpc: pick("LOK_CHAIN_RPC"),
    nft: pick("LOK_NFT"),
    factory: pick("LOK_FACTORY"),
    checkpoint: pick("LOK_CHECKPOINT"),
    rulesets: pick("LOK_RULESETS"),
    ownerKey: pick("LOK_OWNER_KEY"),
    proposerKey: pick("LOK_PROPOSER_KEY"),
  };
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 280);
}

export function writeTextAtomic(path: string, text: string): void {
  durableWrite(path, text);
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function chainOf(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: chainId === 31337 ? "Bellgrave Anvil" : "Bellgrave",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

const NFT_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "nextTokenId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const FACTORY_ABI = [
  {
    type: "function",
    name: "mintFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "isStartingJob",
    stateMutability: "view",
    inputs: [{ name: "job", type: "uint8" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "createCharacterFor",
    stateMutability: "payable",
    inputs: [
      { name: "startingJob", type: "uint8" },
      { name: "expectedTokenId", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "createCharacter",
    stateMutability: "payable",
    inputs: [{ name: "startingJob", type: "uint8" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const CHECKPOINT_ABI = [
  {
    type: "function",
    name: "summary",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Read the genesis job for a character from CharacterCheckpoint.summary(tokenId).
 * Summary format: level (bits 0-15) | job (bits 16-23) | ...
 * Returns null if the character has no genesis (not minted via factory).
 */
export async function readCharacterGenesisJob(
  tokenId: string,
  envIn: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; job: number } | VaultErr> {
  const env = envOf(envIn);
  if (!env.rpc || !env.checkpoint) {
    return { ok: false, error: "CharacterCheckpoint is not configured." };
  }
  if (!/^[1-9][0-9]{0,77}$/.test(tokenId)) {
    return { ok: false, error: "Bad character token id." };
  }
  try {
    const chainId = await chainIdOf(env.rpc);
    const pub = publicClient(env.rpc, chainId);
    const summary = await pub.readContract({
      address: env.checkpoint as `0x${string}`,
      abi: CHECKPOINT_ABI,
      functionName: "summary",
      args: [BigInt(tokenId)],
    });
    if (summary === 0n) {
      return { ok: false, error: "Character #" + tokenId + " has no on-chain genesis." };
    }
    const job = Number((summary >> 16n) & 0xFFn);
    return { ok: true, job };
  } catch (err) {
    return {
      ok: false,
      error: "Failed to read genesis job for #" + tokenId + ": " + redact(String(err), []),
    };
  }
}

/** Job indexes the factory currently accepts as starting jobs (0–15 probed). */
export async function readStartingJobs(
  rpc: string,
  factory: string,
  chainId: number,
  maxJob = 15,
): Promise<number[]> {
  const pub = publicClient(rpc, chainId);
  const addr = factory as `0x${string}`;
  const out: number[] = [];
  for (let job = 0; job <= maxJob; job++) {
    try {
      const ok = await pub.readContract({
        address: addr,
        abi: FACTORY_ABI,
        functionName: "isStartingJob",
        args: [job],
      });
      if (ok) out.push(job);
    } catch {
      break;
    }
  }
  return out;
}

/** True when RPC/factory/NFT env is set so the player mint path should load. */
export function characterMintEnvConfigured(envIn: NodeJS.ProcessEnv = process.env): boolean {
  const env = envOf(envIn);
  // Operator RPC may be keyed; client mint config needs a public URL (#272).
  const publicRpc = resolvePublicRpcUrl(envIn);
  if (!env.rpc || !env.factory || !env.nft || !publicRpc) return false;
  return publicRpc.startsWith("http://") || publicRpc.startsWith("https://");
}

function isLocalAnvilRpc(rpc: string): boolean {
  try {
    const u = new URL(rpc);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "0.0.0.0";
  } catch {
    return false;
  }
}

/**
 * Local 31337 faucet. Enabled only when chain id is explicitly 31337 (LOK_CHAIN_ID)
 * or, when unset, the RPC is clearly local. Set LOK_DEV_FAUCET=0 to disable.
 */
export function devFaucetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LOK_DEV_FAUCET === "0") return false;
  const chainRaw = env.LOK_CHAIN_ID?.trim();
  if (chainRaw) {
    if (chainRaw !== "31337") return false;
  } else {
    const rpc = env.LOK_CHAIN_RPC?.trim() || "";
    if (!isLocalAnvilRpc(rpc)) return false;
  }
  if (env.LOK_DEV_FAUCET === "1" || env.NODE_ENV === "development" || env.ALLOW_DEBUG_CHEATS === "1") {
    return true;
  }
  return !!(env.LOK_OWNER_KEY?.trim() && (env.LOK_CHAIN_RPC?.trim() || env.LOK_FACTORY?.trim()));
}

export function devServerMintEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOK_DEV_SERVER_MINT === "1";
}

/**
 * Pull structured revert `data` from a viem (or similar) error.
 * Only reads object `.data` / `.raw` fields — never scrapes free-form messages
 * (those always contain the factory address and would false-positive).
 */
function revertDataHex(err: unknown): string | null {
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 8 || v == null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    for (const key of ["data", "raw"]) {
      if (typeof o[key] === "string") {
        const s = (o[key] as string).toLowerCase().trim();
        if (s === "0x" || s === "0x0") return "0x";
        // Revert payload: empty, 4-byte selector, or ABI-encoded error.
        if (/^0x([0-9a-f]{8})([0-9a-f]{64})*$/.test(s) || /^0x[0-9a-f]{8}$/.test(s)) return s;
      }
    }
    for (const key of ["cause", "walk", "details", "error", "value"]) {
      const inner = walk(o[key], depth + 1);
      if (inner) return inner;
    }
    return null;
  };
  return walk(err, 0);
}

export async function factorySupportsCreateFor(
  rpc: string,
  factory: string,
  chainId: number,
): Promise<boolean> {
  const pub = publicClient(rpc, chainId);
  try {
    await pub.simulateContract({
      address: factory as `0x${string}`,
      abi: FACTORY_ABI,
      functionName: "createCharacterFor",
      args: [0, 1n],
      value: 0n,
      account: "0x0000000000000000000000000000000000000001",
    });
    return true;
  } catch (err) {
    const msg = String(err);
    // Named custom errors prove the selector exists (even when data parse fails).
    if (/WrongFee|WrongTokenId|BadJob/i.test(msg)) return true;
    // Prefer revert data over viem's generic "ABI encoding" prose (M-A).
    // Do NOT match bare 0x[8 hex] — messages always include the factory address.
    const data = revertDataHex(err);
    if (data === "0x" || data === "0x0") return false;
    if (data && data.length >= 10) {
      // Non-empty 4-byte selector (or longer) ⇒ function exists and reverted.
      return true;
    }
    // Only after data inspection: clear function-not-found signals (never bare "ABI").
    if (
      /Function "createCharacterFor" not found|returned no data|does not exist on (the )?contract|encoded error details:\s*0x\s*$/i.test(
        msg,
      )
    ) {
      return false;
    }
    return false;
  }
}

/** AlreadyProposed() — pending proposal is fine; do not log as failure. */
const ALREADY_PROPOSED_SELECTOR = "0x79429186";

const RULESETS_ABI = [
  {
    type: "function",
    name: "isAccepted",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "minDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "propose",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "delay", type: "uint64" },
      { name: "uri", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rulesets",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [
      { name: "activatesAt", type: "uint64" },
      { name: "retiresAt", type: "uint64" },
      { name: "cancelled", type: "bool" },
      { name: "uri", type: "string" },
    ],
  },
  { type: "error", name: "AlreadyProposed", inputs: [] },
] as const;

function publicClient(rpc: string, chainId: number) {
  return createPublicClient({
    chain: chainOf(chainId, rpc),
    transport: http(rpc),
  });
}

async function chainIdOf(rpc: string): Promise<number> {
  const pub = createPublicClient({ transport: http(rpc) });
  return Number(await pub.getChainId());
}

export type CharacterMintLoadResult =
  | { status: "disabled" }
  | { status: "ready"; config: CharacterMintClientConfig }
  | { status: "error"; error: string };

/**
 * Load browser-reachable mint config. Distinguishes "mint off" from "RPC failed"
 * so boot can fail closed and retry (M-B).
 */
export async function loadCharacterMintClientConfig(
  envIn: NodeJS.ProcessEnv = process.env,
  opts?: { logNextTokenId?: string },
): Promise<CharacterMintLoadResult> {
  if (!characterMintEnvConfigured(envIn)) return { status: "disabled" };
  const env = envOf(envIn);
  const publicRpc = resolvePublicRpcUrl(envIn);
  if (!publicRpc) return { status: "disabled" };
  try {
    const chainId = await chainIdOf(env.rpc);
    // Anvil + configured settlement chains (Gnosis 100 / Chiado 10200). Others stay off.
    if (BigInt(chainId) !== LOCAL_ANVIL_CHAIN_ID && !isSettlementChain(chainId)) {
      return { status: "disabled" };
    }
    const pub = publicClient(env.rpc, chainId);
    const fee = await pub.readContract({
      address: env.factory as `0x${string}`,
      abi: FACTORY_ABI,
      functionName: "mintFee",
    });
    const next = await pub.readContract({
      address: env.nft as `0x${string}`,
      abi: NFT_ABI,
      functionName: "nextTokenId",
    });
    // createCharacterFor requires expectedTokenId == on-chain next+1.
    const suggested = next + 1n;
    const logNext = opts?.logNextTokenId?.trim();
    if (logNext && /^[1-9][0-9]{0,77}$/.test(logNext)) {
      const logN = BigInt(logNext);
      if (logN !== suggested) {
        console.warn(
          `[bellgrave] mint suggestedTokenId chain=${suggested} log=${logN} — using chain id`,
        );
      }
    }
    const supportsCreateFor = await factorySupportsCreateFor(env.rpc, env.factory, chainId);
    const startingJobs = await readStartingJobs(env.rpc, env.factory, chainId);
    return {
      status: "ready",
      config: {
        factory: env.factory,
        nft: env.nft,
        mintFee: fee.toString(),
        chainId,
        rpcUrl: publicRpc,
        supportsCreateFor,
        suggestedTokenId: suggested.toString(),
        startingJobs,
        devFaucet: BigInt(chainId) === LOCAL_ANVIL_CHAIN_ID && devFaucetEnabled(envIn),
        devServerMint: BigInt(chainId) === LOCAL_ANVIL_CHAIN_ID && devServerMintEnabled(envIn),
        currency: settlementCurrencyView(chainId),
      },
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Browser-reachable mint config so the player can pay createCharacter{value}. */
export async function characterMintClientConfig(
  envIn: NodeJS.ProcessEnv = process.env,
  opts?: { logNextTokenId?: string },
): Promise<CharacterMintClientConfig | null> {
  const loaded = await loadCharacterMintClientConfig(envIn, opts);
  if (loaded.status === "ready") return loaded.config;
  return null;
}

/**
 * Link a log token to an on-chain NFT the **player** already minted (or move one
 * the owner still holds). Does not pay mintFee from the server key.
 *
 * `acceptedWallets` may include the burner auth address and/or the EIP-1193
 * wallet that paid `createCharacterFor` — either holder counts as linked.
 */
export async function linkCharacterNft(
  tokenId: string,
  job: number,
  playerWallet?: string,
  envIn: NodeJS.ProcessEnv = process.env,
  opts?: { acceptedWallets?: string[] },
): Promise<{ ok: true; tokenId: string; holder?: string } | VaultErr> {
  const env = envOf(envIn);
  if (!env.rpc || !env.factory || !env.nft) {
    return { ok: false, error: "Character mint is not configured. The log identity was still created." };
  }
  if (!Number.isInteger(job) || job < 0 || job > 255) return { ok: false, error: "That job cannot be minted." };
  const accepted = new Set<string>();
  if (playerWallet && isAddress(playerWallet)) accepted.add(playerWallet.toLowerCase());
  for (const w of opts?.acceptedWallets ?? []) {
    if (isAddress(w)) accepted.add(w.toLowerCase());
  }
  try {
    const chainId = await chainIdOf(env.rpc);
    if (BigInt(chainId) !== LOCAL_ANVIL_CHAIN_ID) {
      return { ok: false, error: "Character NFT link is only checked on local chain 31337." };
    }
    const pub = publicClient(env.rpc, chainId);
    const nft = env.nft as `0x${string}`;

    let held: string;
    try {
      held = (
        await pub.readContract({
          address: nft,
          abi: NFT_ABI,
          functionName: "ownerOf",
          args: [BigInt(tokenId)],
        })
      ).toLowerCase();
    } catch {
      const next = await pub.readContract({
        address: nft,
        abi: NFT_ABI,
        functionName: "nextTokenId",
      });
      if (next + 1n !== BigInt(tokenId)) {
        return {
          ok: false,
          error:
            "Refused to expect NFT " +
            tokenId +
            " because the chain next id is " +
            String(next + 1n) +
            ". Mint with createCharacterFor(job, " +
            tokenId +
            ").",
        };
      }
      return {
        ok: false,
        needsPlayerMint: true,
        error:
          "Pay the character mint fee from your wallet (createCharacterFor). NFT #" +
          tokenId +
          " is not on-chain yet.",
      };
    }

    if (accepted.size === 0 || accepted.has(held)) {
      return { ok: true, tokenId, holder: held };
    }

    if (!env.ownerKey) {
      return {
        ok: false,
        error: "NFT #" + tokenId + " is held by " + held + " and cannot be moved without the owner key.",
      };
    }
    const account = privateKeyToAccount(env.ownerKey as Hex);
    if (held !== account.address.toLowerCase()) {
      return {
        ok: false,
        error: "NFT " + tokenId + " is already minted to someone else. No second mint was sent.",
      };
    }

    const dest = [...accepted][0]!;
    const gate = chainBoundSendGate();
    if (!gate.ok) return gate;
    return withOwnerKeyQueue(async () => {
      const wallet = createWalletClient({
        account,
        chain: chainOf(chainId, env.rpc),
        transport: http(env.rpc),
      });
      const hash = await wallet.writeContract({
        address: nft,
        abi: NFT_ABI,
        functionName: "transferFrom",
        args: [account.address, dest as `0x${string}`, BigInt(tokenId)],
        account,
        chain: chainOf(chainId, env.rpc),
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return { ok: false, error: "Character NFT transfer reverted." };
      }
      return { ok: true, tokenId, holder: dest };
    });
  } catch (err) {
    return { ok: false, error: "Character NFT was not linked. " + redact(String(err), [env.ownerKey]) };
  }
}

/** Poll ownerOf until the player mint confirms, then link. */
export async function linkCharacterNftWithRetry(
  tokenId: string,
  job: number,
  playerWallet: string | undefined,
  opts?: {
    env?: NodeJS.ProcessEnv;
    acceptedWallets?: string[];
    attempts?: number;
    delayMs?: number;
  },
): Promise<{ ok: true; tokenId: string; holder?: string } | VaultErr> {
  const attempts = opts?.attempts ?? 12;
  const delayMs = opts?.delayMs ?? 1500;
  let last: { ok: true; tokenId: string; holder?: string } | VaultErr = {
    ok: false,
    needsPlayerMint: true,
    error: "Mint not confirmed yet.",
  };
  for (let i = 0; i < attempts; i++) {
    last = await linkCharacterNft(tokenId, job, playerWallet, opts?.env, {
      acceptedWallets: opts?.acceptedWallets,
    });
    if (last.ok || !last.needsPlayerMint) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

const faucetLastAt = new Map<string, number>();
const FAUCET_COOLDOWN_MS = 60_000;
/** Global faucet payouts in the current window (all wallets). */
let faucetGlobalWindowStart = 0;
let faucetGlobalCount = 0;
const FAUCET_GLOBAL_CAP = 20;
const FAUCET_GLOBAL_WINDOW_MS = 60_000;

/** Test seam — clear per-wallet + global faucet rate-limit state. */
export function resetFaucetRateLimitsForTests(): void {
  faucetLastAt.clear();
  faucetGlobalWindowStart = 0;
  faucetGlobalCount = 0;
}

/**
 * Dev-only native ETH faucet for burners on chain 31337.
 * Rate-limited per destination (slot reserved before send) and globally.
 * Caller must pass their own verified wallet.
 */
export async function faucetAnvilEth(
  to: string,
  envIn: NodeJS.ProcessEnv = process.env,
  opts?: { callerWallet?: string },
): Promise<{ ok: true; hash: Hex; amountWei: string } | VaultErr> {
  const env = envOf(envIn);
  if (!devFaucetEnabled(envIn)) return { ok: false, error: "Dev faucet is disabled." };
  if (!env.rpc || !env.ownerKey) return { ok: false, error: "Faucet needs LOK_CHAIN_RPC and LOK_OWNER_KEY." };
  if (!isAddress(to)) return { ok: false, error: "Bad faucet destination." };
  const dest = to.toLowerCase();
  if (opts?.callerWallet) {
    if (!isAddress(opts.callerWallet) || opts.callerWallet.toLowerCase() !== dest) {
      return { ok: false, error: "Faucet can only fund your own verified wallet." };
    }
  }
  const now = Date.now();
  const last = faucetLastAt.get(dest) ?? 0;
  if (now - last < FAUCET_COOLDOWN_MS) {
    return { ok: false, error: "Faucet rate limit: wait before requesting again." };
  }
  if (now - faucetGlobalWindowStart >= FAUCET_GLOBAL_WINDOW_MS) {
    faucetGlobalWindowStart = now;
    faucetGlobalCount = 0;
  }
  if (faucetGlobalCount >= FAUCET_GLOBAL_CAP) {
    return { ok: false, error: "Faucet global rate limit: try again later." };
  }
  // Reserve before the transfer so concurrent requests cannot all pass the check (L1).
  faucetLastAt.set(dest, now);
  faucetGlobalCount += 1;
  try {
    const chainId = await chainIdOf(env.rpc);
    if (BigInt(chainId) !== LOCAL_ANVIL_CHAIN_ID) {
      faucetLastAt.delete(dest);
      faucetGlobalCount = Math.max(0, faucetGlobalCount - 1);
      return { ok: false, error: "Faucet is only available on local chain 31337." };
    }
    const amount = 100_000_000_000_000_000n; // 0.1 ETH — enough for many mint fees
    const releaseReservation = () => {
      faucetLastAt.delete(dest);
      faucetGlobalCount = Math.max(0, faucetGlobalCount - 1);
    };
    try {
      return await withOwnerKeyQueue(async () => {
        const account = privateKeyToAccount(env.ownerKey as Hex);
        const pub = publicClient(env.rpc, chainId);
        const wallet = createWalletClient({
          account,
          chain: chainOf(chainId, env.rpc),
          transport: http(env.rpc),
        });
        const hash = await wallet.sendTransaction({
          account,
          chain: chainOf(chainId, env.rpc),
          to: dest as `0x${string}`,
          value: amount,
        });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          releaseReservation();
          return { ok: false, error: "Faucet transfer reverted." };
        }
        return { ok: true, hash, amountWei: amount.toString() };
      });
    } catch (err) {
      releaseReservation();
      return { ok: false, error: "Faucet failed. " + redact(String(err), [env.ownerKey]) };
    }
  } catch (err) {
    faucetLastAt.delete(dest);
    faucetGlobalCount = Math.max(0, faucetGlobalCount - 1);
    return { ok: false, error: "Faucet failed. " + redact(String(err), [env.ownerKey]) };
  }
}

/**
 * Dev-only: server pays createCharacterFor so local testing still mints when
 * burners have no ETH. Requires LOK_DEV_SERVER_MINT=1 and chain 31337.
 */
export async function serverMintCharacterFor(
  tokenId: string,
  job: number,
  toWallet: string,
  envIn: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; tokenId: string; hash: Hex } | VaultErr> {
  const env = envOf(envIn);
  if (envIn.LOK_DEV_SERVER_MINT !== "1") {
    return { ok: false, error: "Server-paid mint is disabled (set LOK_DEV_SERVER_MINT=1 for local)." };
  }
  if (!env.rpc || !env.factory || !env.ownerKey) {
    return { ok: false, error: "Server mint needs factory + owner key." };
  }
  if (!isAddress(toWallet)) return { ok: false, error: "Bad mint destination." };
  if (!Number.isInteger(job) || job < 0 || job > 255) return { ok: false, error: "That job cannot be minted." };
  const gate = chainBoundSendGate();
  if (!gate.ok) return gate;
  let mintFeeWei: bigint | null = null;
  let mintEpoch: number | null = null;
  let mintSent = false;
  try {
    const chainId = await chainIdOf(env.rpc);
    if (BigInt(chainId) !== LOCAL_ANVIL_CHAIN_ID) {
      return { ok: false, error: "Server mint is only available on local chain 31337." };
    }
    const pub = publicClient(env.rpc, chainId);
    const fee = await pub.readContract({
      address: env.factory as `0x${string}`,
      abi: FACTORY_ABI,
      functionName: "mintFee",
    });
    const admitted = chainBoundXdaiSend("mint", fee);
    if (!admitted.ok) return admitted;
    mintFeeWei = fee;
    mintEpoch = admitted.epoch;
    return withOwnerKeyQueue(async () => {
      const account = privateKeyToAccount(env.ownerKey as Hex);
      const wallet = createWalletClient({
        account,
        chain: chainOf(chainId, env.rpc),
        transport: http(env.rpc),
      });
      // Mint to the player via createCharacterFor, then transfer if needed.
      // Factory mints to msg.sender (owner), then we transfer to the player.
      const hash = await wallet.writeContract({
        address: env.factory as `0x${string}`,
        abi: FACTORY_ABI,
        functionName: "createCharacterFor",
        args: [job, BigInt(tokenId)],
        value: fee,
        account,
        chain: chainOf(chainId, env.rpc),
      });
      mintSent = true;
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        releaseEpochXdai(fee, admitted.epoch);
        mintEpoch = null;
        return { ok: false, error: "Server createCharacterFor reverted." };
      }
      const held = (
        await pub.readContract({
          address: env.nft as `0x${string}`,
          abi: NFT_ABI,
          functionName: "ownerOf",
          args: [BigInt(tokenId)],
        })
      ).toLowerCase();
      if (held !== toWallet.toLowerCase()) {
        const xfer = await wallet.writeContract({
          address: env.nft as `0x${string}`,
          abi: NFT_ABI,
          functionName: "transferFrom",
          args: [account.address, toWallet as `0x${string}`, BigInt(tokenId)],
          account,
          chain: chainOf(chainId, env.rpc),
        });
        const xReceipt = await pub.waitForTransactionReceipt({ hash: xfer });
        if (xReceipt.status !== "success") return { ok: false, error: "Server NFT transfer reverted." };
      }
      return { ok: true, tokenId, hash };
    });
  } catch (err) {
    if (mintEpoch != null && mintFeeWei != null && !mintSent) {
      releaseEpochXdai(mintFeeWei, mintEpoch);
    }
    return { ok: false, error: "Server mint failed. " + redact(String(err), [env.ownerKey]) };
  }
}

/**
 * Read `ownerOf(tokenId)` for AH list payout / transfer cancel.
 * Client-supplied payout addresses are never used (mainnet rule 2/4).
 */
export async function readCharacterNftOwner(
  tokenId: string,
  envIn: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; holder: string } | VaultErr> {
  const env = envOf(envIn);
  if (!env.rpc || !env.nft) return { ok: false, error: "Character NFT is not configured." };
  if (!/^[1-9][0-9]{0,77}$/.test(tokenId)) {
    return { ok: false, error: "Bad character token id." };
  }
  try {
    const chainId = await chainIdOf(env.rpc);
    const pub = publicClient(env.rpc, chainId);
    const holder = (
      await pub.readContract({
        address: env.nft as `0x${string}`,
        abi: NFT_ABI,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      })
    ).toLowerCase();
    if (!isAddress(holder)) {
      return { ok: false, error: "Character NFT owner is not a valid address." };
    }
    return { ok: true, holder };
  } catch (err) {
    return {
      ok: false,
      needsPlayerMint: true,
      error: "NFT #" + tokenId + " is not on-chain yet. " + redact(String(err), []),
    };
  }
}

/**
 * AH list payout: always `ownerOf(character)` at list time.
 * Ignores any client-supplied sellerPayout / preferred payout wallet.
 */
export function resolveListSellerPayout(ownerOf: string | null | undefined): {
  ok: true;
  payout: string;
} | { ok: false; error: string } {
  if (!ownerOf || !isAddress(ownerOf)) {
    return {
      ok: false,
      error: "Character NFT owner could not be read. Nothing was listed.",
    };
  }
  return { ok: true, payout: ownerOf.toLowerCase() };
}

/** Verify the player already owns tokenId on-chain (mint-first create). */
export async function verifyCharacterNftOwner(
  tokenId: string,
  wallets: string[],
  envIn: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; holder: string } | VaultErr> {
  const accepted = new Set(wallets.filter(isAddress).map((w) => w.toLowerCase()));
  if (accepted.size === 0) return { ok: false, error: "No wallet to verify against." };
  const owned = await readCharacterNftOwner(tokenId, envIn);
  if (!owned.ok) return owned;
  if (!accepted.has(owned.holder)) {
    return { ok: false, error: "NFT #" + tokenId + " is held by " + owned.holder + ", not your wallet." };
  }
  return { ok: true, holder: owned.holder };
}

export async function ensureLocalRuleset(envIn: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = envOf(envIn);
  if (!env.rpc || !env.rulesets || !env.proposerKey) return;
  try {
    const chainId = await chainIdOf(env.rpc);
    const pub = publicClient(env.rpc, chainId);
    const rulesets = env.rulesets as `0x${string}`;
    const accepted = await pub.readContract({
      address: rulesets,
      abi: RULESETS_ABI,
      functionName: "isAccepted",
      args: [LOCAL_RULESET_HASH as Hex],
    });
    if (accepted) return;
    // Pending proposal is OK — don't propose again / don't log failure.
    try {
      const row = await pub.readContract({
        address: rulesets,
        abi: RULESETS_ABI,
        functionName: "rulesets",
        args: [LOCAL_RULESET_HASH as Hex],
      });
      if (row[0] !== 0n) {
        console.log("[bellgrave] local ruleset already proposed (activatesAt=" + String(row[0]) + ").");
        return;
      }
    } catch {
      /* older ABI without rulesets() — fall through to propose */
    }
    const delay = await pub.readContract({
      address: rulesets,
      abi: RULESETS_ABI,
      functionName: "minDelay",
    });
    await withOwnerKeyQueue(async () => {
      const account = privateKeyToAccount(env.proposerKey as Hex);
      const wallet = createWalletClient({
        account,
        chain: chainOf(chainId, env.rpc),
        transport: http(env.rpc),
      });
      const hash = await wallet.writeContract({
        address: rulesets,
        abi: RULESETS_ABI,
        functionName: "propose",
        args: [LOCAL_RULESET_HASH as Hex, delay, "local"],
        account,
        chain: chainOf(chainId, env.rpc),
      });
      await pub.waitForTransactionReceipt({ hash });
    });
    console.log("[bellgrave] proposed local ruleset. It is not accepted until the registry delay elapses.");
  } catch (err) {
    const msg = String(err);
    if (
      msg.toLowerCase().includes(ALREADY_PROPOSED_SELECTOR) ||
      /AlreadyProposed/i.test(msg)
    ) {
      console.log("[bellgrave] local ruleset already proposed (AlreadyProposed).");
      return;
    }
    console.error("[bellgrave] ruleset setup failed: " + redact(msg, [env.proposerKey, env.ownerKey]));
  }
}
