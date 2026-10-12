/**
 * Shared WC helpers: project id, chain ids, RPC map.
 * Connect UI must use Reown AppKit (appkit-config.ts) — not EthereumProvider
 * showQrModal (that is a QR-only modal and is hard-disabled below).
 *
 * Chain 31337 is optional only in Vite DEV or when VITE_ALLOW_ANVIL_WC=1.
 */
import { SETTLEMENT_BY_CHAIN, settlementCurrency } from "@bellgrave/config";
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import {
  createWalletClient,
  custom,
  type Account,
  type Chain,
  type WalletClient,
} from "viem";

export type WcSession = {
  account: Account;
  address: `0x${string}`;
  client: WalletClient;
  source: "walletconnect";
  provider: Awaited<ReturnType<typeof EthereumProvider.init>>;
};

let provider: Awaited<ReturnType<typeof EthereumProvider.init>> | null = null;

/** True when local anvil may appear in WalletConnect optionalChains. */
export function anvilWalletConnectAllowed(): boolean {
  return (
    import.meta.env.DEV === true ||
    import.meta.env.VITE_ALLOW_ANVIL_WC === "1" ||
    import.meta.env.VITE_ALLOW_ANVIL_WC === "true"
  );
}

/**
 * Chains WalletConnect sessions may approve for pay/mint.
 * Built from SETTLEMENT_BY_CHAIN (100 / 10200 / 31337) plus VITE_CHAIN_ID (home).
 * Anvil (31337) is omitted unless local WC anvil is allowed.
 */
export function walletConnectChainIds(): number[] {
  const ids = new Set<number>();
  for (const key of Object.keys(SETTLEMENT_BY_CHAIN)) {
    const id = Number(key);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  const viteRaw = import.meta.env.VITE_CHAIN_ID?.trim();
  if (viteRaw && /^\d+$/.test(viteRaw)) {
    const viteId = Number(viteRaw);
    if (Number.isSafeInteger(viteId) && viteId > 0) ids.add(viteId);
  }
  if (!anvilWalletConnectAllowed()) ids.delete(31337);
  return [...ids].sort((a, b) => a - b);
}

/** @deprecated Use walletConnectChainIds() — list is dynamic from SETTLEMENT_BY_CHAIN. */
export const WALLETCONNECT_CHAIN_IDS = [100, 10200, 4663, 31337] as const;

export function walletConnectProjectId(): string | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const id = env?.VITE_WALLETCONNECT_PROJECT_ID?.trim();
  return id && id.length >= 8 ? id : null;
}

export function walletConnectConfigured(): boolean {
  return !!walletConnectProjectId();
}

function chainOf(chainId: number, rpcUrl: string): Chain {
  const cur = settlementCurrency(chainId);
  const name =
    chainId === 31337
      ? "Black Anvil Local"
      : chainId === 4663
        ? "Robinhood Chain"
        : chainId === 100 || chainId === 10200
          ? cur.name
          : "Black Anvil";
  return {
    id: chainId,
    name,
    nativeCurrency: { name: cur.name, symbol: cur.symbol, decimals: cur.decimals },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/** Default public RPC when env is blank or unset. */
export function defaultRpcUrl(chainId: number): string {
  if (chainId === 31337) {
    // Phone wallets cannot reach 127.0.0.1 — set VITE_ANVIL_PUBLIC_RPC_URL (e.g. LAN IP / tunnel).
    return (
      import.meta.env.VITE_ANVIL_PUBLIC_RPC_URL?.trim() ||
      import.meta.env.VITE_ANVIL_RPC_URL?.trim() ||
      "http://127.0.0.1:8545"
    );
  }
  if (chainId === 1) {
    return import.meta.env.VITE_ETH_RPC_URL?.trim() || "https://ethereum.publicnode.com";
  }
  if (chainId === 4663) {
    return (
      import.meta.env.VITE_RPC_URL?.trim() ||
      "https://rpc.mainnet.chain.robinhood.com"
    );
  }
  if (chainId === 100) {
    return (
      import.meta.env.VITE_GNOSIS_RPC_URL?.trim() ||
      import.meta.env.VITE_RPC_URL?.trim() ||
      "https://rpc.gnosischain.com"
    );
  }
  if (chainId === 10200) {
    return (
      import.meta.env.VITE_CHIADO_RPC_URL?.trim() ||
      import.meta.env.VITE_RPC_URL?.trim() ||
      "https://rpc.chiado.gnosis.gateway.fm"
    );
  }
  return import.meta.env.VITE_RPC_URL?.trim() || "http://127.0.0.1:8545";
}

function buildWalletConnectRpcMap(primaryChainId: number, primaryRpcUrl: string): Record<number, string> {
  const map: Record<number, string> = {};
  for (const id of walletConnectChainIds()) {
    map[id] = id === primaryChainId ? primaryRpcUrl : defaultRpcUrl(id);
  }
  // Always have an entry for the requested primary so pay flows still work.
  if (!map[primaryChainId]) map[primaryChainId] = primaryRpcUrl;
  return map;
}

async function ensureProviderChain(
  wc: NonNullable<typeof provider>,
  chainId: number,
  rpcUrl: string,
): Promise<void> {
  if (chainId === 31337 && !anvilWalletConnectAllowed()) {
    throw new Error("WalletConnect anvil (31337) is disabled outside local preview.");
  }
  const hexId = "0x" + chainId.toString(16);
  const cur = settlementCurrency(chainId);
  const chainName =
    chainId === 31337
      ? "Black Anvil Local"
      : chainId === 4663
        ? "Robinhood Chain"
        : chainId === 100 || chainId === 10200
          ? cur.name
          : "Black Anvil";
  try {
    await wc.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
    return;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902 && code !== -32603) throw err;
  }
  await wc.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: hexId,
        chainName,
        nativeCurrency: { name: cur.name, symbol: cur.symbol, decimals: cur.decimals },
        rpcUrls: [rpcUrl],
      },
    ],
  });
  await wc.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: hexId }],
  });
}

/** Switch an active WalletConnect session before pay/mint on another chain. */
export async function ensureWalletConnectChain(chainId: number, rpcUrl: string): Promise<void> {
  if (!provider) return;
  await ensureProviderChain(provider, chainId, rpcUrl);
}

async function providerChainId(wc: NonNullable<typeof provider>): Promise<number> {
  try {
    const hex = (await wc.request({ method: "eth_chainId" })) as string;
    const n = Number.parseInt(hex, 16);
    if (Number.isSafeInteger(n) && n > 0) return n;
  } catch {
    /* fall through */
  }
  const fromProvider = Number((wc as { chainId?: number }).chainId);
  return Number.isSafeInteger(fromProvider) && fromProvider > 0 ? fromProvider : 4663;
}

export async function connectWalletConnect(opts: {
  chainId: number;
  rpcUrl: string;
  /**
   * When false, skip wallet_switchEthereumChain (login / sign-only).
   * Default true for pay/mint flows that must be on a specific home chain.
   */
  switchChain?: boolean;
}): Promise<WcSession> {
  void opts;
  // Raw EthereumProvider + showQrModal is a QR-only Web3Modal (the bug users hit).
  // Login/mint/pay must use Reown AppKit (appkit-config.ts / useAppKit().open).
  throw new Error(
    "Raw WalletConnect QR modal is disabled. Use Reown AppKit Connect (VITE_WALLETCONNECT_PROJECT_ID).",
  );
}

export async function disconnectWalletConnect(): Promise<void> {
  if (!provider) return;
  try {
    await provider.disconnect();
  } catch {
    /* ignore */
  }
  provider = null;
}

export function activeWalletConnectProvider(): typeof provider {
  return provider;
}
