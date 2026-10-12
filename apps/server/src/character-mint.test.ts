import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeEventTopics, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseClientMessage } from "@bellgrave/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LokWorld } from "./lok-world";
import {
  assessCharacterMint,
  CHARACTER_CREATED_TOPIC,
  characterMintClientConfig,
  confirmCharacterMint,
  GNOSIS_CHARACTER_MINT,
} from "./character-mint";

const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FACTORY = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";
const NFT = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";

const EVENT = [
  {
    type: "event",
    name: "CharacterCreated",
    inputs: [
      { name: "player", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "startingJob", type: "uint8", indexed: false },
    ],
  },
] as const;

function mintLog(player: string, tokenId: bigint, job: number) {
  const topics = encodeEventTopics({
    abi: EVENT,
    eventName: "CharacterCreated",
    args: { player: player as Hex, tokenId },
  }).filter((topic): topic is Hex => typeof topic === "string");
  const data = encodeAbiParameters([{ type: "uint8" }], [job]);
  return { address: FACTORY, topics, data };
}

function assess(patch: Partial<Parameters<typeof assessCharacterMint>[0]> = {}) {
  return assessCharacterMint({
    wallet: PLAYER,
    job: 0,
    factory: FACTORY,
    txFrom: PLAYER,
    txTo: FACTORY,
    status: "success",
    logs: [mintLog(PLAYER, 7n, 0)],
    owner: PLAYER,
    ...patch,
  });
}

test("character mint config defaults to Gnosis and still accepts an explicit factory", () => {
  assert.deepEqual(characterMintClientConfig({}), GNOSIS_CHARACTER_MINT);
  assert.equal(GNOSIS_CHARACTER_MINT.chainId, 100);
  assert.deepEqual(
    characterMintClientConfig({
      LOK_CHAIN_RPC: "https://rpc.mainnet.chain.robinhood.com",
      LOK_CHAIN_ID: "4663",
    }),
    GNOSIS_CHARACTER_MINT,
  );
  assert.equal(
    characterMintClientConfig({
      LOK_FACTORY: FACTORY,
      LOK_NFT: NFT,
      LOK_CHAIN_RPC: "http://127.0.0.1:8545",
    }),
    null,
  );
  assert.deepEqual(
    characterMintClientConfig({
      LOK_FACTORY: FACTORY,
      LOK_NFT: NFT,
      LOK_PUBLIC_RPC: "http://127.0.0.1:8545/",
      LOK_CHAIN_ID: "31337",
    }),
    { factory: FACTORY, nft: NFT, rpcUrl: "http://127.0.0.1:8545", chainId: 31337 },
  );
});

test("a factory mint to the player is accepted", () => {
  const minted = assess();
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.equal(minted.tokenId, "7");
  assert.equal(mintLog(PLAYER, 7n, 0).topics[0]?.toLowerCase(), CHARACTER_CREATED_TOPIC);
});

test("mint checks reject the wrong sender, factory, job, owner, and a revert", () => {
  assert.equal(assess({ txFrom: OTHER }).ok, false);
  assert.equal(assess({ txTo: OTHER }).ok, false);
  assert.equal(assess({ status: "reverted" }).ok, false);
  assert.equal(assess({ job: 2 }).ok, false);
  assert.equal(assess({ owner: OTHER }).ok, false);
  assert.equal(assess({ logs: [] }).ok, false);
  const doubled = assess({ logs: [mintLog(PLAYER, 7n, 0), mintLog(PLAYER, 8n, 0)] });
  assert.equal(doubled.ok, false);
});

test("char/create carries the mint tx and rejects a short hash", () => {
  const tx = "0x" + "ab".repeat(32);
  const ok = parseClientMessage({
    type: "char/create",
    name: "Chrona",
    job: "time_mage",
    gender: "male",
    nftTx: tx,
  });
  assert.equal(ok?.type, "char/create");
  if (ok?.type !== "char/create") return;
  assert.equal(ok.nftTx, tx);
  assert.equal(
    parseClientMessage({ type: "char/create", name: "Chrona", job: "time_mage", nftTx: "0x123" }),
    null,
  );
  const link = parseClientMessage({ type: "char/link-nft", characterId: "c_1", nftTx: tx });
  assert.equal(link?.type, "char/link-nft");
});

test("one NFT and one mint tx link to one character", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-nft-"));
  const lok = LokWorld.open(dir, undefined, {});
  const spawned = lok.spawn("char-a", "Chrona", 0, PLAYER);
  assert.equal(spawned.ok, true);
  const tx = "0x" + "11".repeat(32);
  assert.equal(lok.attachCharacterNft("missing", "7", tx).ok, false);
  assert.equal(lok.attachCharacterNft("char-a", "7", tx).ok, true);
  assert.equal(lok.nftTokenFor("char-a"), "7");
  const other = lok.spawn("char-b", "Mack", 6, OTHER);
  assert.equal(other.ok, true);
  assert.equal(lok.attachCharacterNft("char-b", "7", "0x" + "22".repeat(32)).ok, false);
  assert.equal(lok.attachCharacterNft("char-b", "8", tx).ok, false);
  assert.equal(lok.attachCharacterNft("char-a", "9", "0x" + "33".repeat(32)).ok, false);
  const reopened = LokWorld.open(dir, undefined, {});
  assert.equal(reopened.nftTokenFor("char-a"), "7");
});

const MINT_ABI = [
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
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

test("anvil createCharacter mints LOKC to the payer", { skip: process.env.LOK_MINT_E2E !== "1" }, async () => {
  const key = process.env.LOK_MINT_KEY;
  const cfg = characterMintClientConfig();
  assert.ok(cfg, "character mint env");
  assert.ok(key && /^0x[0-9a-fA-F]{64}$/.test(key), "LOK_MINT_KEY");
  const account = privateKeyToAccount(key as Hex);
  const chain = {
    id: cfg!.chainId,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg!.rpcUrl] } },
  };
  const reader = createPublicClient({ chain, transport: http(cfg!.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg!.rpcUrl) });
  const fee = await reader.readContract({
    address: cfg!.factory as Hex,
    abi: MINT_ABI,
    functionName: "mintFee",
  });
  assert.equal(fee, 10n ** 15n);
  const hash = await wallet.writeContract({
    address: cfg!.factory as Hex,
    abi: MINT_ABI,
    functionName: "createCharacter",
    args: [0],
    value: fee,
    account,
    chain,
  });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  const confirmed = await confirmCharacterMint(
    { txHash: hash, wallet: account.address, job: 0 },
    process.env,
  );
  assert.equal(confirmed.ok, true, confirmed.ok ? "" : confirmed.error);
  if (!confirmed.ok) return;
  const owner = await reader.readContract({
    address: cfg!.nft as Hex,
    abi: MINT_ABI,
    functionName: "ownerOf",
    args: [BigInt(confirmed.tokenId)],
  });
  assert.equal(owner.toLowerCase(), account.address.toLowerCase());
  const wrongJob = await confirmCharacterMint(
    { txHash: hash, wallet: account.address, job: 2 },
    process.env,
  );
  assert.equal(wrongJob.ok, false);
});
