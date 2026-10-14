/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  /**
   * Reown / WalletConnect project id — enables AppKit picker.
   * Required for production builds on gnosis/chiado (audit L-8). Local DEV can use injected MetaMask without it.
   */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Public RPC for WalletConnect / pay flows (Gnosis default in .env.example). */
  readonly VITE_RPC_URL?: string;
  /** Ethereum L1 RPC for AppKit home-chain network. */
  readonly VITE_ETH_RPC_URL?: string;
  /** Gnosis mainnet RPC override for WC rpcMap. */
  readonly VITE_GNOSIS_RPC_URL?: string;
  /** Chiado testnet RPC override for WC rpcMap. */
  readonly VITE_CHIADO_RPC_URL?: string;
  /** Anvil RPC on the dev machine (defaults to 127.0.0.1:8545). */
  readonly VITE_ANVIL_RPC_URL?: string;
  /** Reachable anvil RPC for mobile WalletConnect (LAN IP, ngrok, etc.). */
  readonly VITE_ANVIL_PUBLIC_RPC_URL?: string;
  /** When "1", allow WalletConnect optionalChains to include anvil 31337 outside Vite DEV. */
  readonly VITE_ALLOW_ANVIL_WC?: string;
  /** Home / login chain id (default 100 Gnosis). Use 31337 for local anvil mint pay. */
  readonly VITE_CHAIN_ID?: string;
  /** Named settlement profile: gnosis | chiado | anvil (see @bellgrave/config NETWORK_PROFILES). */
  readonly VITE_NETWORK?: string;
  /** Optional AhEscrow address pin — refuse pay if server snapshot disagrees (#265). */
  readonly VITE_AH_ESCROW?: string;
  /** Optional CharacterFactory address pin — refuse mint if server snapshot disagrees (#265). */
  readonly VITE_FACTORY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
