/**
 * Client-side pay trust boundary (#265 / #272).
 * Prefer build-time public RPC and optional address pins over raw server snapshot values.
 */
import { networkProfile } from "@bellgrave/config";

function looksSecretRpc(url: string): boolean {
  const raw = url.trim();
  if (!raw) return true;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return true;
    if (u.searchParams.has("api_key") || u.searchParams.has("apikey") || u.searchParams.has("key")) {
      return true;
    }
    return /\/v\d+\/[A-Za-z0-9_-]{16,}/.test(u.pathname);
  } catch {
    return /\/v\d+\/[A-Za-z0-9_-]{16,}/.test(raw);
  }
}

function viteString(key: string): string | undefined {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
    const raw = env?.[key];
    return typeof raw === "string" ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** RPC used for wallet pay: pinned Vite/public profile first for known chains. */
export function payRpcUrl(chainId: number, serverRpcUrl: string): string {
  if (chainId === 100) {
    return (
      viteString("VITE_GNOSIS_RPC_URL") ||
      viteString("VITE_RPC_URL") ||
      networkProfile("gnosis").rpcUrls[0]!
    );
  }
  if (chainId === 10200) {
    return (
      viteString("VITE_CHIADO_RPC_URL") ||
      viteString("VITE_RPC_URL") ||
      networkProfile("chiado").rpcUrls[0]!
    );
  }
  if (chainId === 31337) {
    return (
      viteString("VITE_ANVIL_PUBLIC_RPC_URL") ||
      viteString("VITE_ANVIL_RPC_URL") ||
      networkProfile("anvil").rpcUrls[0]!
    );
  }
  if (serverRpcUrl && !looksSecretRpc(serverRpcUrl)) return serverRpcUrl.replace(/\/$/, "");
  return viteString("VITE_RPC_URL") || networkProfile("anvil").rpcUrls[0]!;
}

export function pinnedAhEscrowAddress(): string | null {
  const raw = viteString("VITE_AH_ESCROW");
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
}

export function pinnedFactoryAddress(): string | null {
  const raw = viteString("VITE_FACTORY");
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
}

export function assertPayAddress(
  kind: "escrow" | "factory",
  address: string,
): { ok: true } | { ok: false; error: string } {
  const pin = kind === "escrow" ? pinnedAhEscrowAddress() : pinnedFactoryAddress();
  if (!pin) return { ok: true };
  if (pin.toLowerCase() !== address.trim().toLowerCase()) {
    return {
      ok: false,
      error:
        kind === "escrow"
          ? "AhEscrow address does not match VITE_AH_ESCROW pin."
          : "Factory address does not match VITE_FACTORY pin.",
    };
  }
  return { ok: true };
}
