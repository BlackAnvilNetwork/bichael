/**
 * Player-signed CharacterFactory.createCharacter. The ERC-721 is minted to the
 * connected wallet. The server checks the receipt before it keeps the character.
 */
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import type { CharacterMintClientConfig } from "@bellgrave/protocol";
import { ensureWalletChain, injectedTransport, linkedWallet } from "./wallet";

const CREATE_ABI = [
  {
    type: "function",
    name: "mintFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "createCharacter",
    stateMutability: "payable",
    inputs: [{ name: "startingJob", type: "uint8" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

function chainOf(cfg: CharacterMintClientConfig) {
  if (cfg.chainId === 100) {
    return {
      id: 100,
      name: "Gnosis Chain",
      nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    };
  }
  const name = cfg.chainId === 4663 ? "Robinhood Chain" : cfg.chainId === 31337 ? "Bellgrave Anvil" : "Bellgrave";
  return {
    id: cfg.chainId,
    name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  };
}

export function mintFeeUnit(chainId: number): string {
  return chainId === 100 ? "xDAI" : "ETH";
}

export function shortChainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/user rejected|user denied|rejected the request/i.test(msg)) return "Wallet rejected the mint.";
  const first = msg.split("\n")[0] ?? msg;
  return first.slice(0, 180);
}

export async function readMintFee(cfg: CharacterMintClientConfig): Promise<bigint> {
  const client = createPublicClient({ chain: chainOf(cfg), transport: http(cfg.rpcUrl) });
  return client.readContract({
    address: cfg.factory as Hex,
    abi: CREATE_ABI,
    functionName: "mintFee",
  });
}

/** Switch to the factory chain and mint LOKC to the connected wallet. Returns the tx hash. */
export async function mintCharacterNft(cfg: CharacterMintClientConfig, job: number): Promise<Hex> {
  if (!Number.isInteger(job) || job < 0 || job > 255) throw new Error("That job cannot be minted.");
  const address = linkedWallet();
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Connect your wallet first.");
  const transport = injectedTransport();
  if (!transport) throw new Error("Connect your wallet first.");
  await ensureWalletChain(cfg.chainId, cfg.rpcUrl);
  const chain = chainOf(cfg);
  const account = address as Hex;
  const wallet = createWalletClient({ account, chain, transport });
  const reader = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const fee = await reader.readContract({
    address: cfg.factory as Hex,
    abi: CREATE_ABI,
    functionName: "mintFee",
  });
  const hash = await wallet.writeContract({
    address: cfg.factory as Hex,
    abi: CREATE_ABI,
    functionName: "createCharacter",
    args: [job],
    value: fee,
    chain,
    account,
  });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Character mint reverted.");
  return hash;
}
