import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASH_PIT,
  PVP_BOUNTY_WEI,
  cappedMainLevel,
  cappedSubjobLevel,
  pvpAreaAt,
} from "./pvp-areas.ts";

describe("pvp areas", () => {
  it("Ash Pit is level-30 PvP with 1e18 bounty", () => {
    assert.equal(ASH_PIT.pvp, true);
    assert.equal(ASH_PIT.levelCap, 30);
    assert.equal(PVP_BOUNTY_WEI, "1000000000000000000");
    assert.ok(pvpAreaAt(-60, -5)?.id === "ash_pit");
    assert.ok(pvpAreaAt(ASH_PIT.spawn.x, ASH_PIT.spawn.z)?.id === "ash_pit");
    assert.equal(pvpAreaAt(0, 0), undefined);
  });

  it("caps main and support levels", () => {
    assert.equal(cappedMainLevel(50, 30), 30);
    assert.equal(cappedMainLevel(20, 30), 20);
    assert.equal(cappedSubjobLevel(50, 30), 15);
    assert.equal(cappedSubjobLevel(8, 30), 0);
  });
});
