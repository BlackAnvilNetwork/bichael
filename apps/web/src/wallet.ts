/**
 * Browser-wallet connect, matching Kekfun's injected path
 * (wagmi injected connector, Robinhood Chain 4663).
 * A WalletConnect project id is not required: MetaMask, Rabby, and other
 * injected providers answer eth_requestAccounts and personal_sign.
 */
import { createWalletClient, custom, type EIP1193Provider, type Hex } from "viem";

const LINK_KEY = "bellgrave.walletLinked";

/** Robinhood Chain, the network Kekfun switches to on connect. */
export const ROBINHOOD_CHAIN_ID = 4663;

const ROBINHOOD_CHAIN_HEX = "0x1237";

type Injected = EIP1193Provider & { providers?: EIP1193Provider[] };

function injectedProvider(): EIP1193Provider | null {
  const eth = (window as Window & { ethereum?: Injected }).ethereum;
  if (!eth) return null;
  return eth.providers?.[0] ?? eth;
}

export function linkedWallet(): string | null {
  try {
    return sessionStorage.getItem(LINK_KEY);
  } catch {
    return null;
  }
}

export function markWalletLinked(address: string) {
  try {
    sessionStorage.setItem(LINK_KEY, address.toLowerCase());
  } catch {
    /* ignore */
  }
}

export function clearWalletLink() {
  try {
    sessionStorage.removeItem(LINK_KEY);
  } catch {
    /* ignore */
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function chainHex(chainId: number): string {
  return "0x" + chainId.toString(16);
}

async function addChain(provider: EIP1193Provider, chainId: number, rpcUrl: string) {
  const robinhood = chainId === ROBINHOOD_CHAIN_ID;
  const anvil = chainId === 31337;
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: chainHex(chainId),
        chainName: robinhood ? "Robinhood Chain" : anvil ? "Bellgrave Anvil" : "Bellgrave",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: robinhood ? ["https://robinhoodchain.blockscout.com"] : [],
      },
    ],
  });
}

async function ensureRobinhood(provider: EIP1193Provider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ROBINHOOD_CHAIN_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) return;
    await addChain(provider, ROBINHOOD_CHAIN_ID, "https://rpc.mainnet.chain.robinhood.com");
  }
}

/** Switch the injected wallet to the chain that holds the character factory. */
export async function ensureWalletChain(chainId: number, rpcUrl: string) {
  const provider = injectedProvider();
  if (!provider) {
    throw new Error("No wallet found in this browser. Install MetaMask or Rabby, then reopen this page.");
  }
  const hex = chainHex(chainId);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await addChain(provider, chainId, rpcUrl);
  }
}

/** Accounts the wallet already shared with this page. No popup. */
export async function authorizedAccounts(): Promise<string[]> {
  const provider = injectedProvider();
  if (!provider) return [];
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return accounts.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  } catch {
    return [];
  }
}

/**
 * Ask the injected wallet for an account, then switch to Robinhood Chain
 * the way Kekfun's connect button does. A rejected chain switch still
 * returns the account — login is a signature, not a chain transaction.
 */
export async function connectInjectedWallet(): Promise<`0x${string}`> {
  const provider = injectedProvider();
  if (!provider) {
    throw new Error("No wallet found in this browser. Install MetaMask or Rabby, then reopen this page.");
  }
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  const address = accounts.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  if (!address) throw new Error("The wallet did not return an account.");
  try {
    await ensureRobinhood(provider);
  } catch {
    /* Login does not need the chain switch to succeed. */
  }
  return address as `0x${string}`;
}

export async function signWithWallet(address: string, message: string): Promise<Hex> {
  const provider = injectedProvider();
  if (!provider) throw new Error("Wallet disconnected.");
  const client = createWalletClient({
    account: address as `0x${string}`,
    transport: custom(provider),
  });
  return client.signMessage({ message });
}

export function injectedTransport() {
  const provider = injectedProvider();
  return provider ? custom(provider) : null;
}
