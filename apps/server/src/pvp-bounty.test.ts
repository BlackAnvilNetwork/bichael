import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pvpBountyAddress,
  pvpBountyClientConfig,
  pvpSyntheticReceiptsAllowed,
} from "./pvp-bounty";

describe("pvp bounty env gate", () => {
  it("allows synthetic on anvil / default chain without deploy", () => {
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "31337" }), true);
    assert.equal(pvpSyntheticReceiptsAllowed({}), true);
  });

  it("refuses synthetic when LOK_PVP_BOUNTY is wired (live escrow)", () => {
    const addr = "0x" + "ab".repeat(20);
    assert.equal(
      pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "31337", LOK_PVP_BOUNTY: addr }),
      false,
    );
    const cfg = pvpBountyClientConfig({
      LOK_CHAIN_ID: "31337",
      LOK_PVP_BOUNTY: addr,
      LOK_CHAIN_RPC: "http://127.0.0.1:8545",
    });
    assert.ok(cfg);
    assert.equal(cfg!.synthetic, false);
    assert.equal(cfg!.address, addr.toLowerCase());
    assert.equal(cfg!.bountyWei, "1000000000000000000");
  });

  it("refuses synthetic on Gnosis / Chiado", () => {
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "100" }), false);
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "10200" }), false);
  });

  it("honors LOK_PVP_SYNTHETIC override", () => {
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "100", LOK_PVP_SYNTHETIC: "1" }), true);
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "31337", LOK_PVP_SYNTHETIC: "0" }), false);
    assert.equal(
      pvpSyntheticReceiptsAllowed({
        LOK_CHAIN_ID: "31337",
        LOK_PVP_BOUNTY: "0x" + "cd".repeat(20),
        LOK_PVP_SYNTHETIC: "1",
      }),
      true,
    );
  });

  it("parses LOK_PVP_BOUNTY", () => {
    assert.equal(pvpBountyAddress({}), null);
    assert.equal(
      pvpBountyAddress({ LOK_PVP_BOUNTY: "0x" + "ab".repeat(20) }),
      ("0x" + "ab".repeat(20)).toLowerCase(),
    );
  });
});
