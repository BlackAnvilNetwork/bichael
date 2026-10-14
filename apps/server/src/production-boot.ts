/**
 * Fail-closed boot gates for Gnosis / Chiado production.
 * Missing contracts or dry-run addresses → refuse to listen.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { findDryRunEnvHits, dryRunDeployAllowed } from "./dry-run-denylist";
import { listingRoleKey, ahEscrowAddress } from "./ah-escrow";
import { characterMintEnvConfigured } from "./lok-vault";
import { envSettlementChainId } from "./settlement-chain";

/** Pinned production LISTING EOA (docs/gnosis-launch.md). */
export const PINNED_GNOSIS_LISTING_ADDRESS = "0xbfa29a6ee3d1188aa0a9e0c783e5da620b859e76";

export type ProductionBootResult =
  | { ok: true }
  | { ok: false; error: string };

const ESCROW_ABI = parseAbi([
  "function characterNft() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function LISTING_ROLE() view returns (bytes32)",
]);
const PVP_BOUNTY_ABI = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function OPERATOR_ROLE() view returns (bytes32)",
]);
const FACTORY_ABI = parseAbi(["function mintFee() view returns (uint256)"]);

export function isProductionSettlementChain(env: NodeJS.ProcessEnv = process.env): boolean {
  const named = (env.NETWORK ?? env.LOK_NETWORK)?.trim().toLowerCase();
  if (named === "gnosis" || named === "chiado") return true;
  const id = envSettlementChainId(env);
  return id === 100 || id === 10200;
}

/**
 * Synchronous env shape check (no RPC). Call after applySettlementDeployFile.
 */
export function assertProductionEnvShape(env: NodeJS.ProcessEnv = process.env): ProductionBootResult {
  if (!isProductionSettlementChain(env)) return { ok: true };

  const hits = findDryRunEnvHits(env);
  if (hits.length > 0 && !dryRunDeployAllowed(env)) {
    return {
      ok: false,
      error:
        "dry-run denylist hit: " +
        hits.map((h) => h.key + "=" + h.address).join(", ") +
        " — refuse production boot (see deployments/gnosis-dryrun.json)",
    };
  }

  const nft = env.LOK_NFT?.trim();
  const factory = env.LOK_FACTORY?.trim();
  const escrow = env.LOK_AH_ESCROW?.trim() || ahEscrowAddress(env);
  const rpc = env.LOK_CHAIN_RPC?.trim() || env.LOK_PUBLIC_RPC?.trim();
  const listingKey = env.LOK_LISTING_KEY?.trim() || listingRoleKey(env);
  const ownerKey = env.LOK_OWNER_KEY?.trim() || env.PRIVATE_KEY?.trim() || "";
  const pvpBounty = env.LOK_PVP_BOUNTY?.trim() || "";
  const statusToken = env.LOK_OPS_STATUS_TOKEN?.trim();

  const missing: string[] = [];
  if (!nft) missing.push("LOK_NFT");
  if (!factory) missing.push("LOK_FACTORY");
  if (!escrow) missing.push("LOK_AH_ESCROW");
  if (!rpc) missing.push("LOK_CHAIN_RPC");
  // AH needs LOK_LISTING_KEY (pinned LISTING EOA). PvpBounty claim/cancel can use
  // LOK_OWNER_KEY when that address holds OPERATOR_ROLE (admin interim on Gnosis).
  if (!listingKey && !(pvpBounty && /^0x[0-9a-fA-F]{64}$/.test(ownerKey))) {
    missing.push("LOK_LISTING_KEY");
  }
  if (!statusToken && (env.NETWORK ?? "").toLowerCase() === "gnosis") {
    missing.push("LOK_OPS_STATUS_TOKEN");
  }
  if (missing.length) {
    return {
      ok: false,
      error:
        "production settlement chain requires " +
        missing.join(", ") +
        " (mint must not fail open). Dry-run deploy JSON is not used for auto-fill.",
    };
  }
  if (!characterMintEnvConfigured(env)) {
    return { ok: false, error: "character mint env incomplete on production chain" };
  }
  return { ok: true };
}

/**
 * On-chain smoke: bytecode present, mintFee > 0, escrow.characterNft == NFT,
 * LISTING key holds LISTING_ROLE when readable.
 */
export async function assertProductionContractsLive(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProductionBootResult> {
  if (!isProductionSettlementChain(env)) return { ok: true };
  const shape = assertProductionEnvShape(env);
  if (!shape.ok) return shape;

  const nft = env.LOK_NFT!.trim() as `0x${string}`;
  const factory = env.LOK_FACTORY!.trim() as `0x${string}`;
  const escrow = (env.LOK_AH_ESCROW?.trim() || ahEscrowAddress(env)) as `0x${string}`;
  const rpc = (env.LOK_CHAIN_RPC?.trim() || env.LOK_PUBLIC_RPC!.trim()) as string;
  const listing = listingRoleKey(env);
  const chainId = envSettlementChainId(env);

  try {
    const pub = createPublicClient({
      chain: {
        id: chainId,
        name: "settlement",
        nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      },
      transport: http(rpc),
    });
    for (const [label, addr] of [
      ["NFT", nft],
      ["Factory", factory],
      ["AhEscrow", escrow],
    ] as const) {
      const code = await pub.getBytecode({ address: addr });
      if (!code || code === "0x") {
        return { ok: false, error: label + " has no bytecode at " + addr };
      }
    }
    const fee = await pub.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "mintFee",
    });
    if (fee <= 0n) {
      return { ok: false, error: "CharacterFactory.mintFee is 0 — refuse free mint" };
    }
    const escrowNft = (
      await pub.readContract({
        address: escrow,
        abi: ESCROW_ABI,
        functionName: "characterNft",
      })
    ).toLowerCase();
    if (escrowNft !== nft.toLowerCase()) {
      return {
        ok: false,
        error: "AhEscrow.characterNft (" + escrowNft + ") != LOK_NFT (" + nft.toLowerCase() + ")",
      };
    }
    if (listing) {
      try {
        const role = await pub.readContract({
          address: escrow,
          abi: ESCROW_ABI,
          functionName: "LISTING_ROLE",
        });
        const acct = privateKeyToAccount(
          (listing.startsWith("0x") ? listing : "0x" + listing) as `0x${string}`,
        );
        const named = (env.NETWORK ?? env.LOK_NETWORK)?.trim().toLowerCase();
        if (
          (named === "gnosis" || chainId === 100) &&
          acct.address.toLowerCase() !== PINNED_GNOSIS_LISTING_ADDRESS
        ) {
          return {
            ok: false,
            error:
              "LOK_LISTING_KEY address " +
              acct.address +
              " != pinned Gnosis LISTING " +
              PINNED_GNOSIS_LISTING_ADDRESS,
          };
        }
        const ok = await pub.readContract({
          address: escrow,
          abi: ESCROW_ABI,
          functionName: "hasRole",
          args: [role, acct.address],
        });
        if (!ok) {
          return {
            ok: false,
            error: "LOK_LISTING_KEY address " + acct.address + " lacks LISTING_ROLE on AhEscrow",
          };
        }
      } catch (err) {
        return {
          ok: false,
          error:
            "LISTING_ROLE check failed: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    } else {
      // No LISTING key — AhEscrow openAsk/cancelAsk disabled. PvpBounty still needs an OPERATOR.
      const ownerRaw = env.LOK_OWNER_KEY?.trim() || env.PRIVATE_KEY?.trim() || "";
      const bounty = env.LOK_PVP_BOUNTY?.trim();
      if (!bounty || !/^0x[0-9a-fA-F]{40}$/.test(bounty)) {
        return {
          ok: false,
          error:
            "LOK_LISTING_KEY missing and LOK_PVP_BOUNTY unset — cannot operate AhEscrow or PvpBounty",
        };
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(ownerRaw)) {
        return {
          ok: false,
          error: "LOK_LISTING_KEY missing — set it, or LOK_OWNER_KEY with PvpBounty OPERATOR_ROLE",
        };
      }
      try {
        const acct = privateKeyToAccount(ownerRaw as `0x${string}`);
        const opRole = await pub.readContract({
          address: bounty as `0x${string}`,
          abi: PVP_BOUNTY_ABI,
          functionName: "OPERATOR_ROLE",
        });
        const isOp = await pub.readContract({
          address: bounty as `0x${string}`,
          abi: PVP_BOUNTY_ABI,
          functionName: "hasRole",
          args: [opRole, acct.address],
        });
        if (!isOp) {
          return {
            ok: false,
            error:
              "LOK_OWNER_KEY address " +
              acct.address +
              " lacks OPERATOR_ROLE on PvpBounty (and LOK_LISTING_KEY is unset)",
          };
        }
        console.warn(
          "[bellgrave] LOK_LISTING_KEY unset — AhEscrow listing txs disabled; " +
            "PvpBounty claim/cancel via LOK_OWNER_KEY " +
            acct.address,
        );
      } catch (err) {
        return {
          ok: false,
          error:
            "PvpBounty OPERATOR_ROLE check failed: " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: "production contract smoke failed: " + (err instanceof Error ? err.message : String(err)),
    };
  }
}
