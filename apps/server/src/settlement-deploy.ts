/**
 * Fill blank LOK_* address/RPC env from NETWORK profile + deployments/*.json
 * when targeting Gnosis (100) or Chiado (10200). Never copies MockItems / MockKEK.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyNetworkProfileEnv,
  networkProfile,
  settlementRpcUrls,
  type NetworkProfile,
} from "@bellgrave/config";
import { findDryRunEnvHits, dryRunDeployAllowed, isDryRunAddress } from "./dry-run-denylist";
import { envSettlementChainId } from "./settlement-chain";
import { redactRpcUrl } from "./ops-redact";

const here = dirname(fileURLToPath(import.meta.url));

type DeployFile = {
  chainId?: number;
  contracts?: Record<string, string>;
  rpcUrl?: string;
  /** First contract-creation block — watchers backfill from here when set. */
  deployBlock?: number;
  status?: string;
};

function defaultDeployPath(profile: NetworkProfile): string {
  if (!profile.deployFile) return "";
  return join(here, "../../../", profile.deployFile);
}

function fill(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) return;
  if (env[key] != null && env[key] !== "") return;
  env[key] = value;
}

/**
 * Apply NETWORK / LOK_NETWORK profile (chain id, RPC list, confirmations, explorers),
 * then load contract addresses from the deploy JSON into empty LOK_* keys.
 *
 * Skips MockItems/MockKEK. Optional LOK_DEPLOY_JSON overrides the path.
 * Local anvil is profile-only (no deploy file required).
 */
export function applySettlementDeployFile(env: NodeJS.ProcessEnv = process.env): void {
  const profile = applyNetworkProfileEnv(env as Record<string, string | undefined>);
  const chainId = envSettlementChainId(env);

  if (chainId !== 100 && chainId !== 10200) {
    // Anvil / unknown: profile may have filled RPC; nothing else to load.
    return;
  }

  const path = env.LOK_DEPLOY_JSON?.trim() || defaultDeployPath(profile);
  if (!path || !existsSync(path)) {
    ensureRpcEnv(env, profile);
    return;
  }

  let parsed: DeployFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as DeployFile;
  } catch (err) {
    console.warn(
      "[bellgrave] failed to parse deploy file " + path + ":",
      err instanceof Error ? err.message : err,
    );
    ensureRpcEnv(env, profile);
    return;
  }

  if (parsed.chainId != null && parsed.chainId !== chainId) {
    console.warn(
      "[bellgrave] deploy file chainId=" +
        parsed.chainId +
        " != LOK_CHAIN_ID=" +
        chainId +
        "; skipping address fill",
    );
    ensureRpcEnv(env, profile);
    return;
  }

  if (parsed.status === "dry-run-only") {
    const allow = env.LOK_ALLOW_DRY_RUN_DEPLOY?.trim() === "1";
    console.error(
      "[bellgrave] ALERT: deploy file is dry-run-only (Checkpoint → MockItems with open setMinter; " +
        "collapsed roles). A production server must NEVER use these addresses. " +
        "See docs/gnosis-launch.md § Dry-run MockItems.",
    );
    if (!allow) {
      // Still apply RPC/profile so ops probes work; leave LOK_* addresses unset
      // until an official DeployChiado + real Items is recorded (or opt-in).
      ensureRpcEnv(env, profile);
      console.error(
        "[bellgrave] skipping address fill from " +
          path +
          " (set LOK_ALLOW_DRY_RUN_DEPLOY=1 only for explicit dry-run inspection).",
      );
      return;
    }
    console.warn(
      "[bellgrave] LOK_ALLOW_DRY_RUN_DEPLOY=1 — filling addresses from dry-run file (not for production).",
    );
  }

  const c = parsed.contracts ?? {};
  // M-7: refuse filling (and warn on already-set env) when addresses are the dry-run denylist.
  const candidateKeys: [string, string | undefined][] = [
    ["LOK_NFT", c.CharacterNFT],
    ["LOK_FACTORY", c.CharacterFactory],
    ["LOK_AH_ESCROW", c.AhEscrow],
    ["LOK_PVP_BOUNTY", c.PvpBounty],
    ["LOK_CHECKPOINT", c.CharacterCheckpoint],
    ["LOK_RULESETS", c.RulesetRegistry],
    ["LOK_ITEMS", c.Items],
  ];
  const allowDryFill = env.LOK_ALLOW_DRY_RUN_DEPLOY?.trim() === "1";
  for (const [key, value] of candidateKeys) {
    if (value && isDryRunAddress(value) && !allowDryFill) {
      console.error(
        "[bellgrave] ALERT: refusing " +
          key +
          " fill from dry-run denylist address " +
          value +
          " (see deployments/gnosis-dryrun.json)",
      );
      continue;
    }
    if (key === "LOK_ITEMS") {
      if (c.Items) fill(env, "LOK_ITEMS", c.Items);
      continue;
    }
    fill(env, key, value);
  }
  if (c.MockItems && !c.Items) {
    console.error(
      "[bellgrave] ALERT: deploy file lists MockItems but no Items — refusing LOK_ITEMS fill.",
    );
  }
  const envHits = findDryRunEnvHits(env);
  if (envHits.length > 0 && !dryRunDeployAllowed(env)) {
    console.error(
      "[bellgrave] ALERT: LOK_* env matches dry-run denylist: " +
        envHits.map((h) => h.key + "=" + h.address).join(", ") +
        " — production boot will refuse unless LOK_ALLOW_DRY_RUN_DEPLOY=1 and LOK_DRY_RUN_INSPECT=1 (H-2/M-7).",
    );
  }

  if (
    parsed.deployBlock != null &&
    Number.isSafeInteger(parsed.deployBlock) &&
    parsed.deployBlock > 0 &&
    !env.LOK_DEPLOY_BLOCK?.trim()
  ) {
    env.LOK_DEPLOY_BLOCK = String(parsed.deployBlock);
  }

  if (!env.LOK_CHAIN_RPC?.trim() && parsed.rpcUrl?.trim()) {
    env.LOK_CHAIN_RPC = parsed.rpcUrl.trim();
  }
  ensureRpcEnv(env, profile);

  console.log(
    "[bellgrave] settlement profile=" +
      profile.name +
      " deploy=" +
      path +
      " chain=" +
      chainId +
      " nft=" +
      (env.LOK_NFT ?? "") +
      " escrow=" +
      (env.LOK_AH_ESCROW ?? "") +
      " rpc=" +
      redactRpcUrl(env.LOK_CHAIN_RPC ?? ""),
  );
}

function ensureRpcEnv(env: NodeJS.ProcessEnv, profile: NetworkProfile): void {
  const urls = settlementRpcUrls(env as Record<string, string | undefined>);
  if (!env.LOK_CHAIN_RPC_URLS?.trim() && urls.length > 1) {
    env.LOK_CHAIN_RPC_URLS = urls.join(",");
  }
  if (!env.LOK_CHAIN_RPC?.trim()) {
    env.LOK_CHAIN_RPC = urls[0] || profile.rpcUrls[0] || "";
  }
  if (!env.LOK_PUBLIC_RPC?.trim() && env.LOK_CHAIN_RPC?.trim()) {
    env.LOK_PUBLIC_RPC = env.LOK_CHAIN_RPC;
  }
}

/** Active profile for the current env (after apply). */
export function activeNetworkProfile(env: NodeJS.ProcessEnv = process.env): NetworkProfile {
  return networkProfile(env as Record<string, string | undefined>);
}
