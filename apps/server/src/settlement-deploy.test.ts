import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applySettlementDeployFile } from "./settlement-deploy";

describe("applySettlementDeployFile", () => {
  it("fills blank LOK_* from deploy JSON on chain 100 and skips MockItems", () => {
    const dir = mkdtempSync(join(tmpdir(), "lok-deploy-"));
    const path = join(dir, "gnosis.json");
    writeFileSync(
      path,
      JSON.stringify({
        chainId: 100,
        deployBlock: 42_000_000,
        contracts: {
          CharacterNFT: "0x1111111111111111111111111111111111111111",
          CharacterFactory: "0x2222222222222222222222222222222222222222",
          AhEscrow: "0x3333333333333333333333333333333333333333",
          CharacterCheckpoint: "0x4444444444444444444444444444444444444444",
          RulesetRegistry: "0x5555555555555555555555555555555555555555",
          MockItems: "0x6666666666666666666666666666666666666666",
          Items: "0x7777777777777777777777777777777777777777",
        },
      }),
    );
    const env: NodeJS.ProcessEnv = {
      LOK_CHAIN_ID: "100",
      LOK_DEPLOY_JSON: path,
    };
    applySettlementDeployFile(env);
    assert.equal(env.LOK_NFT, "0x1111111111111111111111111111111111111111");
    assert.equal(env.LOK_FACTORY, "0x2222222222222222222222222222222222222222");
    assert.equal(env.LOK_AH_ESCROW, "0x3333333333333333333333333333333333333333");
    assert.equal(env.LOK_ITEMS, "0x7777777777777777777777777777777777777777");
    assert.equal(env.LOK_CHECKPOINT, "0x4444444444444444444444444444444444444444");
    assert.ok(env.LOK_CHAIN_RPC?.includes("gnosis"));
    assert.equal(env.LOK_DEPLOY_BLOCK, "42000000");
    assert.ok(env.LOK_CHAIN_RPC_URLS?.includes(","));
  });

  it("NETWORK=gnosis selects chain 100 + confirmations + explorer without LOK_CHAIN_ID", () => {
    const env: NodeJS.ProcessEnv = { NETWORK: "gnosis" };
    applySettlementDeployFile(env);
    assert.equal(env.LOK_CHAIN_ID, "100");
    assert.equal(env.LOK_CONFIRMATIONS, "30");
    assert.equal(env.LOK_EXPLORER, "https://gnosisscan.io");
    assert.ok(env.LOK_CHAIN_RPC?.includes("gnosis"));
  });

  it("does not override existing env on anvil", () => {
    const env: NodeJS.ProcessEnv = {
      NETWORK: "anvil",
      LOK_NFT: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    applySettlementDeployFile(env);
    assert.equal(env.LOK_CHAIN_ID, "31337");
    assert.equal(env.LOK_NFT, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(env.LOK_AH_ESCROW, undefined);
  });

  it("NETWORK=anvil fills PvpBounty + deployer K0 from deployments/anvil.json", () => {
    const env: NodeJS.ProcessEnv = { NETWORK: "anvil" };
    applySettlementDeployFile(env);
    assert.equal(env.LOK_CHAIN_ID, "31337");
    assert.equal(env.LOK_PVP_BOUNTY, "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0");
    assert.equal(env.LOK_NFT, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
    assert.equal(
      env.LOK_LISTING_KEY,
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    assert.equal(
      env.LOK_OWNER_KEY,
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    assert.ok(env.LOK_CHAIN_RPC?.includes("8545"));
  });

  it("refuses address fill from dry-run-only deploy files unless opted in", () => {
    const dir = mkdtempSync(join(tmpdir(), "lok-deploy-"));
    const path = join(dir, "gnosis-dry.json");
    writeFileSync(
      path,
      JSON.stringify({
        chainId: 100,
        status: "dry-run-only",
        contracts: {
          CharacterNFT: "0x1111111111111111111111111111111111111111",
          CharacterFactory: "0x2222222222222222222222222222222222222222",
          AhEscrow: "0x3333333333333333333333333333333333333333",
          CharacterCheckpoint: "0x4444444444444444444444444444444444444444",
          MockItems: "0x6666666666666666666666666666666666666666",
        },
      }),
    );
    const blocked: NodeJS.ProcessEnv = {
      LOK_CHAIN_ID: "100",
      LOK_DEPLOY_JSON: path,
    };
    applySettlementDeployFile(blocked);
    assert.equal(blocked.LOK_NFT, undefined);
    assert.equal(blocked.LOK_CHECKPOINT, undefined);
    assert.equal(blocked.LOK_ITEMS, undefined);
    assert.ok(blocked.LOK_CHAIN_RPC?.includes("gnosis"));

    const allowed: NodeJS.ProcessEnv = {
      LOK_CHAIN_ID: "100",
      LOK_DEPLOY_JSON: path,
      LOK_ALLOW_DRY_RUN_DEPLOY: "1",
    };
    applySettlementDeployFile(allowed);
    assert.equal(allowed.LOK_NFT, "0x1111111111111111111111111111111111111111");
    assert.equal(allowed.LOK_CHECKPOINT, "0x4444444444444444444444444444444444444444");
    assert.equal(allowed.LOK_ITEMS, undefined, "MockItems must never become LOK_ITEMS");
  });
});
