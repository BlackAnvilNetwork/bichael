/**
 * Reown AppKit bootstrap — https://docs.reown.com/appkit/overview
 * createAppKit once at module scope (outside React components).
 * projectId = VITE_WALLETCONNECT_PROJECT_ID (Reown Dashboard).
 *
 * Do NOT use @walletconnect/ethereum-provider showQrModal for Connect — that is
 * a QR-only Web3Modal and is what produced the raw-QR UX.
 */
import { createAppKit, type AppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { anvil, gnosis, gnosisChiado, type AppKitNetwork } from "@reown/appkit/networks";
import { anvilWalletConnectAllowed, defaultRpcUrl, walletConnectProjectId } from "./walletconnect";

/** Reown WalletGuide listing ids — order is respected on the Connect main view. */
const RABBY_WALLET_ID = "18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1";
const METAMASK_WALLET_ID = "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96";
const COINBASE_WALLET_ID = "d0ca99ff52b99abc48743dad0f7fc891e041be73574f7fac4afe5d4bb83845c8";

/**
 * Settlement networks only (Gnosis / Chiado / optional anvil).
 * Ethereum mainnet omitted — not needed for Gnosis settlement; EEZ ETH home can return later.
 */
function appKitNetworks(): [AppKitNetwork, ...AppKitNetwork[]] {
  const list: AppKitNetwork[] = [gnosis, gnosisChiado];
  if (anvilWalletConnectAllowed()) list.push(anvil);
  return list as [AppKitNetwork, ...AppKitNetwork[]];
}

function defaultNetwork(): AppKitNetwork {
  const raw = import.meta.env.VITE_CHAIN_ID?.trim();
  const id = raw && /^\d+$/.test(raw) ? Number(raw) : 100;
  if (id === 10200) return gnosisChiado;
  if (id === 31337 && anvilWalletConnectAllowed()) return anvil;
  return gnosis;
}

let kit: AppKit | null = null;
let initError: string | null = null;
let initialized = false;

/** Lazily create AppKit so a failed createAppKit does not break the whole bundle. */
export function ensureAppKit(): AppKit | null {
  if (initialized) return kit;
  initialized = true;
  const projectId = walletConnectProjectId();
  if (!projectId) return null;
  try {
    kit = createAppKit({
      adapters: [new EthersAdapter()],
      networks: appKitNetworks(),
      defaultNetwork: defaultNetwork(),
      projectId,
      metadata: {
        name: "Black Anvil",
        description: "Black Anvil",
        url: typeof window !== "undefined" ? window.location.origin : "https://legendofkek.com",
        icons: ["https://legendofkek.com/favicon.ico"],
      },
      customRpcUrls: {
        [`eip155:${gnosis.id}`]: [{ url: defaultRpcUrl(100) }],
        [`eip155:${gnosisChiado.id}`]: [{ url: defaultRpcUrl(10200) }],
        ...(anvilWalletConnectAllowed()
          ? { [`eip155:${anvil.id}`]: [{ url: defaultRpcUrl(31337) }] }
          : {}),
      },
      features: {
        analytics: false,
        email: false,
        socials: false,
        swaps: false,
        onramp: false,
      },
      allWallets: "SHOW",
      // Rabby first, then common desktop wallets (order respected).
      featuredWalletIds: [RABBY_WALLET_ID, METAMASK_WALLET_ID, COINBASE_WALLET_ID],
      themeMode: "dark",
    });
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
    console.error("[bellgrave] createAppKit failed — Connect will not use raw WC QR:", initError);
    kit = null;
  }
  return kit;
}

/**
 * Eager init in the browser only — node tests import ah-buy without Vite env.
 * main.tsx also imports this module so the modal is ready before Connect.
 */
if (typeof window !== "undefined") {
  ensureAppKit();
}

export function appKitConfigured(): boolean {
  return ensureAppKit() != null;
}

export function appKitInitError(): string | null {
  ensureAppKit();
  return initError;
}
