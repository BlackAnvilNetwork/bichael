import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placePvpBountyWithWallet } from "./pvp-place";

describe("placePvpBountyWithWallet", () => {
  it("never requests burner when AppKit is available (no injected)", async () => {
    let sawAllowBurner: boolean | undefined;
    const res = await placePvpBountyWithWallet({
      escrow: {
        address: "0x" + "ab".repeat(20),
        bountyWei: "1000000000000000000",
        currency: "xDAI",
        synthetic: false,
        rpcUrl: "https://rpc.gnosischain.com",
        chainId: 100,
      },
      tokenId: "1",
      forceWalletFlags: {
        hasInjected: false,
        appKitConfigured: true,
        burnerAllowed: true,
      },
      getSession: async (opts) => {
        sawAllowBurner = opts.allowBurnerFallback;
        throw new Error("Connect an injected wallet or Reown AppKit to pay.");
      },
    });
    assert.equal(sawAllowBurner, false);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /AppKit|wallet/i);
  });

  it("skips wallet when synthetic", async () => {
    const res = await placePvpBountyWithWallet({
      escrow: {
        address: "0x" + "ab".repeat(20),
        bountyWei: "1000000000000000000",
        currency: "xDAI",
        synthetic: true,
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 31337,
      },
      tokenId: "1",
      getSession: async () => {
        throw new Error("should not open wallet");
      },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /Synthetic/i);
  });

  it("refuses burner on non-anvil even when AppKit is not configured", async () => {
    const res = await placePvpBountyWithWallet({
      escrow: {
        address: "0x" + "ab".repeat(20),
        bountyWei: "1000000000000000000",
        currency: "xDAI",
        synthetic: false,
        rpcUrl: "https://rpc.gnosischain.com",
        chainId: 100,
      },
      tokenId: "1",
      forceWalletFlags: {
        hasInjected: false,
        appKitConfigured: false,
        burnerAllowed: false,
      },
      getSession: async () => {
        throw new Error("Connect an injected wallet or Reown AppKit to pay.");
      },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /AppKit|wallet/i);
  });
});
