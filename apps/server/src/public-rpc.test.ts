import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPublicRpcSafe, resolvePublicRpcUrl, rpcUrlLooksSecret } from "./public-rpc";

describe("public-rpc (#272)", () => {
  it("detects secret-looking RPC URLs", () => {
    assert.equal(rpcUrlLooksSecret("https://rpc.gnosischain.com"), false);
    assert.equal(
      rpcUrlLooksSecret("https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY_HERE_AB"),
      true,
    );
    assert.equal(rpcUrlLooksSecret("https://mainnet.infura.io/v3/abcdef0123456789abcdef"), true);
    assert.equal(rpcUrlLooksSecret("https://example.com/?apikey=sekret"), true);
  });

  it("prefers LOK_PUBLIC_RPC when safe", () => {
    const url = resolvePublicRpcUrl({
      LOK_PUBLIC_RPC: "https://gnosis-rpc.publicnode.com",
      LOK_CHAIN_RPC: "https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY_HERE_AB",
      NETWORK: "gnosis",
      LOK_CHAIN_ID: "100",
    });
    assert.equal(url, "https://gnosis-rpc.publicnode.com");
  });

  it("does not fall back to secret LOK_CHAIN_RPC", () => {
    const url = resolvePublicRpcUrl({
      LOK_CHAIN_RPC: "https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY_HERE_AB",
      NETWORK: "gnosis",
      LOK_CHAIN_ID: "100",
    });
    assert.equal(url, "https://rpc.gnosischain.com");
  });

  it("assertPublicRpcSafe refuses secret public override", () => {
    const r = assertPublicRpcSafe({
      NETWORK: "gnosis",
      LOK_CHAIN_ID: "100",
      LOK_PUBLIC_RPC: "https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY_HERE_AB",
      LOK_CHAIN_RPC: "https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY_HERE_AB",
    });
    assert.equal(r.ok, false);
  });
});
