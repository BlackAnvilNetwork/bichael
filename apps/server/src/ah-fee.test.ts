import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AH_FEE_BPS, AH_TREASURY_FEE_BPS, AH_VAULT_FEE_BPS, ahFeeSplit, ahGuildFeeShares } from "@bellgrave/protocol";

describe("ahFeeSplit (1% floor)", () => {
  it("matches AhEscrow rounding cases", () => {
    assert.equal(AH_FEE_BPS, 100);
    assert.deepEqual(ahFeeSplit(1n), { feeWei: 0n, sellerNetWei: 1n });
    assert.deepEqual(ahFeeSplit(99n), { feeWei: 0n, sellerNetWei: 99n });
    assert.deepEqual(ahFeeSplit(100n), { feeWei: 1n, sellerNetWei: 99n });
    assert.deepEqual(ahFeeSplit(101n), { feeWei: 1n, sellerNetWei: 100n });
    assert.deepEqual(ahFeeSplit(199n), { feeWei: 1n, sellerNetWei: 198n });
    assert.deepEqual(ahFeeSplit(200n), { feeWei: 2n, sellerNetWei: 198n });
  });

  it("partitions price for larger amounts", () => {
    const price = 10n ** 18n; // 1 ETH
    const { feeWei, sellerNetWei } = ahFeeSplit(price);
    assert.equal(feeWei, 10n ** 16n); // 0.01 ETH
    assert.equal(sellerNetWei, price - feeWei);
    assert.equal(feeWei + sellerNetWei, price);
  });

  it("splits the 1% fee into 50 bps vault and 50 bps treasury, floored", () => {
    assert.equal(AH_VAULT_FEE_BPS + AH_TREASURY_FEE_BPS, AH_FEE_BPS);
    assert.equal(AH_FEE_BPS, 100);
    assert.deepEqual(ahGuildFeeShares(0n), { feeWei: 0n, vaultWei: 0n, treasuryWei: 0n });
    assert.deepEqual(ahGuildFeeShares(1n), { feeWei: 0n, vaultWei: 0n, treasuryWei: 0n });
    assert.deepEqual(ahGuildFeeShares(99n), { feeWei: 0n, vaultWei: 0n, treasuryWei: 0n });
    assert.deepEqual(ahGuildFeeShares(100n), { feeWei: 1n, vaultWei: 0n, treasuryWei: 0n });
    assert.deepEqual(ahGuildFeeShares(200n), { feeWei: 2n, vaultWei: 1n, treasuryWei: 1n });
    assert.deepEqual(ahGuildFeeShares(300n), { feeWei: 3n, vaultWei: 1n, treasuryWei: 1n });
    const dust = ahGuildFeeShares(300n);
    assert.equal(dust.feeWei - (dust.vaultWei + dust.treasuryWei), 1n);
    const price = 10n ** 18n;
    const shares = ahGuildFeeShares(price);
    assert.equal(shares.feeWei, 10n ** 16n);
    assert.equal(shares.vaultWei, 5n * 10n ** 15n);
    assert.equal(shares.treasuryWei, 5n * 10n ** 15n);
    assert.equal(shares.vaultWei + shares.treasuryWei, shares.feeWei);
  });
});
