import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { SLO_GAME_TICK_MS } from "./phase0-slo";
import { PHASE0_PUBLISHED_TICK_MS, installedGameMode } from "./installed-game-mode";

test("a fresh start is a validator, a failed self-check stays one, and both checks opt into a replica", async () => {
  assert.equal(PHASE0_PUBLISHED_TICK_MS, 19.768);
  assert.ok(PHASE0_PUBLISHED_TICK_MS < SLO_GAME_TICK_MS);

  const fresh = await installedGameMode({});
  assert.deepEqual(fresh, { mode: "validator" });
  assert.equal("combatBonus" in fresh, false);
  assert.equal("secondGuild" in fresh, false);
  assert.equal("listingKey" in fresh, false);

  let at = 0;
  const slowClock = mock.method(performance, "now", () => {
    const value = at;
    at += SLO_GAME_TICK_MS;
    return value;
  });
  try {
    const refused = await installedGameMode({ LOK_REPLICA: "1" });
    assert.deepEqual(refused, { mode: "validator" });
    assert.equal("combatBonus" in refused, false);
  } finally {
    slowClock.mock.restore();
  }

  const replica = await installedGameMode({ LOK_REPLICA: "1" });
  assert.deepEqual(replica, { mode: "replica" });
  assert.equal("combatBonus" in replica, false);
  assert.equal("secondGuild" in replica, false);
  assert.equal("listingKey" in replica, false);
});
