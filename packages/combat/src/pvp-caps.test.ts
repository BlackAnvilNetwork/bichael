import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abilityUsableUnderCaps, applyAreaLevelCap } from "./dual-job.ts";

describe("pvp level caps", () => {
  it("clamps main level", () => {
    assert.equal(applyAreaLevelCap(50, 30), 30);
    assert.equal(applyAreaLevelCap(12, 30), 12);
  });

  it("blocks high unlock abilities under L30/L15", () => {
    assert.equal(abilityUsableUnderCaps("knight", 30, null, "provoke"), true);
    // Support at L15: early rogue kit ok; unlock 60 blocked.
    assert.equal(abilityUsableUnderCaps("knight", 30, "rogue", "ghost_step"), true);
    assert.equal(abilityUsableUnderCaps("knight", 30, "rogue", "kill_edge"), false);
  });
});

