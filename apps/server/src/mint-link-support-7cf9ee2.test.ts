/**
 * F1: player-paid mint must bind to the intended log token (createCharacterFor).
 * Spins a throwaway anvil + MintFixture; does not touch the shared :8545 anvil.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { linkCharacterNft } from "./lok-vault";
import {
  deployMintFixture,
  startThrowawayAnvil,
  supportAnvilAvailable,
  type ThrowawayAnvil,
} from "./support-anvil";

/** Skip cleanly when foundry libs are not checked out (no hard fail). */
const SKIP_MINT_ANVIL = !supportAnvilAvailable;
// anvil default keys 2 (A), 3 (B)
const A_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const B_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;

const CREATE_FOR = [
  {
    type: "function",
    name: "createCharacterFor",
    stateMutability: "payable",
    inputs: [
      { name: "startingJob", type: "uint8" },
      { name: "expectedTokenId", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
const CREATE = [
  {
    type: "function",
    name: "createCharacter",
    stateMutability: "payable",
    inputs: [{ name: "startingJob", type: "uint8" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const FEE = [
  { type: "function", name: "mintFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const OWNER = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

describe("support 7cf9ee2: player-paid character mint (throwaway anvil)", {
  skip: SKIP_MINT_ANVIL,
}, () => {
  let owned: ThrowawayAnvil | undefined;
  let rpc = "";
  let factory = "";
  let nft = "";

  before(async () => {
    owned = await startThrowawayAnvil();
    rpc = owned.rpc;
    const deployed = deployMintFixture(rpc);
    nft = deployed.nft;
    factory = deployed.factory;
  });

  after(() => {
    owned?.stop();
  });

  it("createCharacterFor binds payment to the expected token; wrong id reverts", async () => {
    const chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    };
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const a = privateKeyToAccount(A_KEY);
    const b = privateKeyToAccount(B_KEY);
    const fee = await pub.readContract({
      address: factory as Hex,
      abi: FEE,
      functionName: "mintFee",
    });
    const wa = createWalletClient({ account: a, chain, transport: http(rpc) });
    const wb = createWalletClient({ account: b, chain, transport: http(rpc) });

    // A mints token 1 for themselves.
    const h1 = await wa.writeContract({
      address: factory as Hex,
      abi: CREATE_FOR,
      functionName: "createCharacterFor",
      args: [0, 1n],
      value: fee,
    });
    await pub.waitForTransactionReceipt({ hash: h1 });

    // B cannot claim token 1 (already minted) or skip to token 3.
    await assert.rejects(
      wb.writeContract({
        address: factory as Hex,
        abi: CREATE_FOR,
        functionName: "createCharacterFor",
        args: [0, 3n],
        value: fee,
      }),
    );

    // B mints exactly token 2.
    const h2 = await wb.writeContract({
      address: factory as Hex,
      abi: CREATE_FOR,
      functionName: "createCharacterFor",
      args: [0, 2n],
      value: fee,
    });
    await pub.waitForTransactionReceipt({ hash: h2 });

    const owner1 = (
      await pub.readContract({ address: nft as Hex, abi: OWNER, functionName: "ownerOf", args: [1n] })
    ).toLowerCase();
    const owner2 = (
      await pub.readContract({ address: nft as Hex, abi: OWNER, functionName: "ownerOf", args: [2n] })
    ).toLowerCase();
    assert.equal(owner1, a.address.toLowerCase());
    assert.equal(owner2, b.address.toLowerCase());

    const env = {
      LOK_CHAIN_RPC: rpc,
      LOK_FACTORY: factory,
      LOK_NFT: nft,
    } as NodeJS.ProcessEnv;
    const linkA = await linkCharacterNft("1", 0, a.address, env);
    const linkB = await linkCharacterNft("2", 0, b.address, env);
    assert.equal(linkA.ok, true);
    assert.equal(linkB.ok, true);
  });

  it("legacy createCharacter is disabled (L-6)", async () => {
    const chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    };
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const a = privateKeyToAccount(A_KEY);
    const fee = await pub.readContract({
      address: factory as Hex,
      abi: FEE,
      functionName: "mintFee",
    });
    const wa = createWalletClient({ account: a, chain, transport: http(rpc) });
    await assert.rejects(
      () =>
        wa.writeContract({
          address: factory as Hex,
          abi: CREATE,
          functionName: "createCharacter",
          args: [0],
          value: fee,
        }),
      /CreateCharacterDisabled|0x7462bebc|reverted/i,
    );
  });
});
