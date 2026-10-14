/**
 * Named settlement profiles — one knob for server + web.
 *
 *   NETWORK=gnosis|chiado|anvil   (server; LOK_NETWORK alias)
 *   VITE_NETWORK=gnosis|chiado|anvil  (web)
 *
 * Setting NETWORK fills blank LOK_CHAIN_ID / RPC / confirmations / explorer.
 * Explicit LOK_* / VITE_* always win over the profile defaults.
 */
import { SETTLEMENT_BY_CHAIN, type SettlementCurrency } from "./settlement";

export type NetworkName = "gnosis" | "chiado" | "anvil";

export type NetworkProfile = {
  name: NetworkName;
  chainId: number;
  /** Primary first; extras are fallbacks for RPC rotation. */
  rpcUrls: readonly string[];
  explorer: string;
  blockscout: string;
  /** Reorg-safe confirmations (blocks behind tip). */
  confirmations: number;
  /** Relative to repo root. */
  deployFile: string;
  currency: SettlementCurrency;
};

export const NETWORK_PROFILES: Record<NetworkName, NetworkProfile> = {
  gnosis: {
    name: "gnosis",
    chainId: 100,
    rpcUrls: [
      "https://rpc.gnosischain.com",
      "https://gnosis-rpc.publicnode.com",
      "https://rpc.ankr.com/gnosis",
    ],
    explorer: "https://gnosisscan.io",
    blockscout: "https://gnosis.blockscout.com",
    /** ~30 blocks (~2.5m); watchers prefer `finalized` when the RPC supports it. */
    confirmations: 30,
    /** Official stack — dry-run lives at deployments/gnosis-dryrun.json (refused unless opted in). */
    deployFile: "deployments/gnosis.json",
    currency: SETTLEMENT_BY_CHAIN[100]!,
  },
  chiado: {
    name: "chiado",
    chainId: 10200,
    rpcUrls: [
      "https://rpc.chiado.gnosis.gateway.fm",
      "https://gnosis-chiado-rpc.publicnode.com",
    ],
    explorer: "https://gnosis-chiado.blockscout.com",
    blockscout: "https://gnosis-chiado.blockscout.com",
    confirmations: 30,
    deployFile: "deployments/chiado.json",
    currency: SETTLEMENT_BY_CHAIN[10200]!,
  },
  anvil: {
    name: "anvil",
    chainId: 31337,
    rpcUrls: ["http://127.0.0.1:8545"],
    explorer: "",
    blockscout: "",
    confirmations: 1,
    /** Local CREATE addresses from MintFixture + DeployPvpBountyAnvil on a fresh anvil. */
    deployFile: "deployments/anvil.json",
    currency: SETTLEMENT_BY_CHAIN[31337]!,
  },
};

const NAME_BY_CHAIN: Record<number, NetworkName> = {
  100: "gnosis",
  10200: "chiado",
  31337: "anvil",
};

export function isNetworkName(raw: string | undefined | null): raw is NetworkName {
  return raw === "gnosis" || raw === "chiado" || raw === "anvil";
}

/** Resolve profile name from NETWORK / LOK_NETWORK / chain id env. */
export function resolveNetworkName(env: Record<string, string | undefined> = {}): NetworkName {
  const named = (env.NETWORK ?? env.LOK_NETWORK ?? env.VITE_NETWORK)?.trim().toLowerCase();
  if (isNetworkName(named)) return named;

  const chainRaw = (env.LOK_CHAIN_ID ?? env.VITE_CHAIN_ID)?.trim();
  if (chainRaw && /^\d+$/.test(chainRaw)) {
    const id = Number(chainRaw);
    const mapped = NAME_BY_CHAIN[id];
    if (mapped) return mapped;
  }
  return "anvil";
}

export function networkProfile(
  nameOrEnv?: NetworkName | Record<string, string | undefined>,
): NetworkProfile {
  if (typeof nameOrEnv === "string") return NETWORK_PROFILES[nameOrEnv];
  return NETWORK_PROFILES[resolveNetworkName(nameOrEnv ?? {})];
}

export function networkProfileByChainId(chainId: number): NetworkProfile | null {
  const name = NAME_BY_CHAIN[chainId];
  return name ? NETWORK_PROFILES[name] : null;
}

/** Address / tx explorer URLs (empty string when profile has no explorer). */
export function explorerAddressUrl(chainId: number, address: string): string {
  const p = networkProfileByChainId(chainId);
  if (!p?.explorer || !/^0x[0-9a-fA-F]{40}$/.test(address)) return "";
  return `${p.explorer}/address/${address}`;
}

export function explorerTxUrl(chainId: number, txHash: string): string {
  const p = networkProfileByChainId(chainId);
  if (!p?.explorer || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return "";
  return `${p.explorer}/tx/${txHash}`;
}

/**
 * Apply NETWORK / LOK_NETWORK into blank server env keys.
 * Does not override explicit LOK_CHAIN_ID, LOK_CHAIN_RPC, LOK_CONFIRMATIONS, etc.
 */
export function applyNetworkProfileEnv(
  env: Record<string, string | undefined>,
): NetworkProfile {
  const profile = networkProfile(env);
  if (!env.LOK_CHAIN_ID?.trim()) env.LOK_CHAIN_ID = String(profile.chainId);
  if (!env.LOK_CONFIRMATIONS?.trim()) env.LOK_CONFIRMATIONS = String(profile.confirmations);
  if (!env.LOK_EXPLORER?.trim() && profile.explorer) env.LOK_EXPLORER = profile.explorer;
  if (!env.LOK_BLOCKSCOUT?.trim() && profile.blockscout) env.LOK_BLOCKSCOUT = profile.blockscout;

  const urls = [...profile.rpcUrls];
  if (!env.LOK_CHAIN_RPC_URLS?.trim() && urls.length > 0) {
    env.LOK_CHAIN_RPC_URLS = urls.join(",");
  }
  if (!env.LOK_CHAIN_RPC?.trim() && urls[0]) {
    env.LOK_CHAIN_RPC = urls[0];
  }
  if (!env.LOK_PUBLIC_RPC?.trim() && env.LOK_CHAIN_RPC?.trim()) {
    env.LOK_PUBLIC_RPC = env.LOK_CHAIN_RPC;
  }
  return profile;
}

/** Parse LOK_CHAIN_RPC_URLS (comma) or fall back to profile + LOK_CHAIN_RPC. */
export function settlementRpcUrls(env: Record<string, string | undefined> = {}): string[] {
  const raw = env.LOK_CHAIN_RPC_URLS?.trim();
  if (raw) {
    const list = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return [...new Set(list)];
  }
  const primary = env.LOK_CHAIN_RPC?.trim();
  const profile = networkProfile(env);
  const out = primary ? [primary, ...profile.rpcUrls] : [...profile.rpcUrls];
  return [...new Set(out.filter(Boolean))];
}
