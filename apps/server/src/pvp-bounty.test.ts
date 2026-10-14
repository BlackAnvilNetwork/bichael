import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pvpBountyAddress, pvpSyntheticReceiptsAllowed } from "./pvp-bounty";

describe("pvp bounty env gate", () => {
  it("allows synthetic on anvil / default chain", () => {
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "31337" }), true);
    assert.equal(pvpSyntheticReceiptsAllowed({}), true);
  });

  it("refuses synthetic on Gnosis / Chiado", () => {
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "100" }), false);
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "10200" }), false);
  });

  it("honors LOK_PVP_SYNTHETIC override", () => {
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "100", LOK_PVP_SYNTHETIC: "1" }), true);
    assert.equal(pvpSyntheticReceiptsAllowed({ LOK_CHAIN_ID: "31337", LOK_PVP_SYNTHETIC: "0" }), false);
  });

  it("parses LOK_PVP_BOUNTY", () => {
    assert.equal(pvpBountyAddress({}), null);
    assert.equal(
      pvpBountyAddress({ LOK_PVP_BOUNTY: "0x" + "ab".repeat(20) }),
      ("0x" + "ab".repeat(20)).toLowerCase(),
    );
  });
});
