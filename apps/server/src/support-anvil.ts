/**
 * Shared throwaway-anvil helpers for support e2e tests.
 * Does not touch the shared :8545 anvil.
 */
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SUPPORT_LOK = join(SUPPORT_ROOT, "contracts", "lok-log");
export const SUPPORT_ANVIL_K0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export function resolveAnvilBin(): string | null {
  for (const candidate of [
    process.env.ANVIL_PATH,
    "anvil",
    join(process.env.HOME || "", ".foundry/bin/anvil"),
    "/home/ubuntu/.foundry/bin/anvil",
  ]) {
    if (!candidate) continue;
    try {
      if (candidate === "anvil") {
        execFileSync("anvil", ["--version"], { stdio: "ignore" });
        return "anvil";
      }
      if (existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function forgeLibsPresent(lokDir: string = SUPPORT_LOK): boolean {
  return (
    existsSync(join(lokDir, "lib", "forge-std")) &&
    existsSync(join(lokDir, "foundry.toml"))
  );
}

export function resolveForgeBin(): string | null {
  for (const candidate of [
    process.env.FORGE_PATH,
    "forge",
    join(process.env.HOME || "", ".foundry/bin/forge"),
    "/home/ubuntu/.foundry/bin/forge",
  ]) {
    if (!candidate) continue;
    try {
      if (candidate === "forge") {
        execFileSync("forge", ["--version"], { stdio: "ignore" });
        return "forge";
      }
      if (existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitRpc(rpc: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error("anvil did not start");
}

export type ThrowawayAnvil = {
  rpc: string;
  proc: ChildProcess;
  stop: () => void;
};

export async function startThrowawayAnvil(): Promise<ThrowawayAnvil> {
  const bin = resolveAnvilBin();
  if (!bin) throw new Error("anvil not found");
  const port = await freePort();
  const rpc = "http://127.0.0.1:" + port;
  const proc = spawn(bin, ["--port", String(port), "--chain-id", "31337"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitRpc(rpc);
  return {
    rpc,
    proc,
    stop: () => {
      proc.kill("SIGTERM");
    },
  };
}

/** Refuse forge --broadcast against anything but loopback (never public/mainnet RPCs). */
export function assertLocalRpc(rpc: string): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(rpc.trim())) {
    throw new Error("support fixture refuses non-local RPC: " + rpc);
  }
}

/**
 * Run `forge script … --broadcast` with an isolated cache + broadcast dir.
 *
 * Parallel node:test suites otherwise collide on the shared
 * `contracts/lok-log/cache/<Script>/31337/run-latest.json.recovery.json`
 * (CI flake: "another process is already modifying recovery state").
 */
export function runForgeScriptBroadcast(
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; maxBuffer?: number },
): string {
  const forge = resolveForgeBin();
  if (!forge) throw new Error("forge not found");
  if (!forgeLibsPresent()) throw new Error("contracts/lok-log/lib missing");
  const root = mkdtempSync(join(tmpdir(), "bellgrave-forge-"));
  const cachePath = join(root, "cache");
  const broadcastPath = join(root, "broadcast");
  try {
    return execFileSync(
      forge,
      [...args, "--cache-path", cachePath, "--broadcast"],
      {
        cwd: SUPPORT_LOK,
        encoding: "utf8",
        maxBuffer: opts?.maxBuffer,
        env: {
          ...process.env,
          ...opts?.env,
          FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
          // Isolate script recovery + broadcast artifacts from other parallel forge runs.
          FOUNDRY_CACHE_PATH: cachePath,
          FOUNDRY_BROADCAST: broadcastPath,
        },
      },
    );
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Deploy AhEscrow with deployer (= key 0) holding LISTING_ROLE. */
export function deployMintFixture(rpc: string): { nft: string; factory: string } {
  assertLocalRpc(rpc);
  const out = runForgeScriptBroadcast([
    "script",
    "script/MintFixture.s.sol:MintFixture",
    "--rpc-url",
    rpc,
    "--private-key",
    SUPPORT_ANVIL_K0,
    "-vv",
  ]);
  const nftMatch = /NFT\s+(0x[a-fA-F0-9]{40})/.exec(out);
  const factoryMatch = /FACTORY\s+(0x[a-fA-F0-9]{40})/.exec(out);
  if (!nftMatch || !factoryMatch) {
    throw new Error("MintFixture did not print NFT/FACTORY\n" + out.slice(-800));
  }
  return { nft: nftMatch[1]!, factory: factoryMatch[1]! };
}

/** Deploy MockEezSyncBuy wired to an AhEscrow on the same anvil. */
export function deployMockEezSyncBuy(rpc: string, escrow: string, zoneId = 31337): string {
  assertLocalRpc(rpc);
  if (zoneId !== 31337) throw new Error("EezMockFixture only supports zoneId 31337");
  const out = runForgeScriptBroadcast(
    [
      "script",
      "script/EezMockFixture.s.sol:EezMockFixture",
      "--rpc-url",
      rpc,
      "--private-key",
      SUPPORT_ANVIL_K0,
      "-vv",
    ],
    { env: { ETH_RPC_URL: rpc, EEZ_ESCROW: escrow } },
  );
  const m = /MOCK\s+(0x[a-fA-F0-9]{40})/.exec(out);
  if (!m) throw new Error("EezMockFixture did not print MOCK\n" + out.slice(-800));
  return m[1]!;
}

export function deployAhEscrowFixture(rpc: string): string {
  assertLocalRpc(rpc);
  const out = runForgeScriptBroadcast([
    "script",
    "script/AhEscrowFixture.s.sol:AhEscrowFixture",
    "--rpc-url",
    rpc,
    "--private-key",
    SUPPORT_ANVIL_K0,
    "-vv",
  ]);
  const m = /ESCROW\s+(0x[a-fA-F0-9]{40})/.exec(out);
  if (!m) throw new Error("AhEscrowFixture did not print ESCROW\n" + out.slice(-800));
  return m[1]!;
}

/** Public Gnosis RPC for `anvil --fork-url` (never broadcast to this URL). */
export function gnosisForkUrl(): string | null {
  const raw = (process.env.GNOSIS_RPC_URL ?? process.env.FORK_URL ?? "").trim();
  if (raw) return raw;
  // Default public endpoint — tests skip only when anvil/forge missing.
  return "https://rpc.gnosischain.com";
}

export type GnosisForkAnvil = ThrowawayAnvil & { forkUrl: string; chainId: number };

/**
 * Local anvil forked from Gnosis tip (chain id stays 100).
 * All broadcasts must use the returned local `rpc` — never the fork URL.
 */
export async function startGnosisForkAnvil(opts?: {
  forkUrl?: string;
}): Promise<GnosisForkAnvil> {
  const bin = resolveAnvilBin();
  if (!bin) throw new Error("anvil not found");
  const forkUrl = (opts?.forkUrl ?? gnosisForkUrl())?.trim();
  if (!forkUrl) throw new Error("GNOSIS_RPC_URL / FORK_URL required for Gnosis fork");
  const port = await freePort();
  const rpc = "http://127.0.0.1:" + port;
  const proc = spawn(bin, ["--fork-url", forkUrl, "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitRpc(rpc, 80);
  return {
    rpc,
    proc,
    forkUrl,
    chainId: 100,
    stop: () => {
      proc.kill("SIGTERM");
    },
  };
}

export type GnosisForkMintAh = {
  nft: string;
  factory: string;
  escrow: string;
  mintFeeWei: bigint;
};

/** Deploy 1 xDAI mint factory + AhEscrow onto a local Gnosis fork RPC. */
export function deployGnosisForkMintAhFixture(
  rpc: string,
  privateKey: string = SUPPORT_ANVIL_K0,
): GnosisForkMintAh {
  assertLocalRpc(rpc);
  const pk = privateKey.startsWith("0x") ? privateKey : "0x" + privateKey;
  const out = runForgeScriptBroadcast(
    [
      "script",
      "script/GnosisForkMintAhFixture.s.sol:GnosisForkMintAhFixture",
      "--rpc-url",
      rpc,
      "--private-key",
      pk,
      "-vv",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const nftMatch = /NFT\s+(0x[a-fA-F0-9]{40})/.exec(out);
  const factoryMatch = /FACTORY\s+(0x[a-fA-F0-9]{40})/.exec(out);
  const escrowMatch = /ESCROW\s+(0x[a-fA-F0-9]{40})/.exec(out);
  if (!nftMatch || !factoryMatch || !escrowMatch) {
    throw new Error("GnosisForkMintAhFixture did not print NFT/FACTORY/ESCROW\n" + out.slice(-1200));
  }
  return {
    nft: nftMatch[1]!,
    factory: factoryMatch[1]!,
    escrow: escrowMatch[1]!,
    mintFeeWei: 10n ** 18n,
  };
}

export const supportAnvilAvailable = !!(
  resolveAnvilBin() &&
  resolveForgeBin() &&
  forgeLibsPresent()
);

/** Probe public fork URL once (skip suite when unreachable — do not fail CI). */
export async function gnosisForkRpcReachable(forkUrl?: string): Promise<boolean> {
  const url = (forkUrl ?? gnosisForkUrl())?.trim();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: string };
    return typeof body.result === "string" && body.result.length > 0;
  } catch {
    return false;
  }
}

/** Foundry present for Gnosis fork e2e (broadcasts stay on local anvil). */
export const gnosisForkAvailable = supportAnvilAvailable && !!gnosisForkUrl();
