// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AhEscrow} from "../src/AhEscrow.sol";
import {GuildVault} from "../src/GuildVault.sol";
import {RulesetRegistry} from "../src/RulesetRegistry.sol";
import {MockOwnerNft} from "./mocks/MockOwnerNft.sol";

/// Guild-vault slice: each fill pays 50 bps to the vault and 50 bps to the treasury.
/// A change to those shares waits out the ruleset timelock. The fee on a fill does not.
contract AhEscrowGuildVaultTest is Test {
    AhEscrow escrow;
    MockOwnerNft nft;
    address admin = makeAddr("admin");
    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address feeTo = makeAddr("feeTo");

    uint256 constant LISTING = 7;
    uint256 constant SELLER_TOKEN = 1;
    uint256 constant BUYER_TOKEN = 2;
    uint256 constant ITEM = 111;
    uint256 constant AMOUNT = 3;
    uint256 constant PRICE = 0.02 ether;

    function setUp() public {
        nft = new MockOwnerNft();
        nft.setOwner(SELLER_TOKEN, seller);
        nft.setOwner(BUYER_TOKEN, buyer);
        escrow = new AhEscrow(admin, address(nft), payable(feeTo));
        vm.deal(buyer, 10 ether);
    }

    function _open(uint256 id, uint256 price) internal {
        vm.prank(admin);
        escrow.openAsk(id, SELLER_TOKEN, ITEM, AMOUNT, price);
    }

    function test_zeroVolumeVaultHoldsZero() public view {
        assertEq(escrow.guildVault().balance, 0);
        assertEq(address(escrow).balance, 0);
        assertEq(escrow.VAULT_FEE_BPS(), 50);
        assertEq(escrow.TREASURY_FEE_BPS(), 50);
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);
        assertEq(escrow.vaultBps() + escrow.treasuryBps(), escrow.FEE_BPS());
        assertEq(escrow.FEE_BPS(), 100);
    }

    function test_buyAsk_buyerPaysOnePercent_sellerNetsNinetyNine_sharesAreFiftyBps() public {
        _open(LISTING, PRICE);
        uint256 beforeBuyer = buyer.balance;
        uint256 beforeSeller = seller.balance;

        vm.prank(buyer);
        escrow.buyAsk{value: PRICE}(LISTING, BUYER_TOKEN);

        uint256 fee = (PRICE * 100) / 10_000;
        uint256 vaultWei = (PRICE * 50) / 10_000;
        uint256 treasuryWei = (PRICE * 50) / 10_000;
        assertEq(beforeBuyer - buyer.balance, PRICE, "buyer pays the sale price, not a second fee");
        assertEq(seller.balance - beforeSeller, PRICE - fee, "seller nets 99%");
        assertEq(seller.balance - beforeSeller, (PRICE * 9900) / 10_000);
        assertEq(escrow.guildVault().balance, vaultWei, "vault receives 50 bps");
        assertEq(feeTo.balance, treasuryWei, "treasury receives 50 bps");
        assertEq(vaultWei + treasuryWei, fee, "50 + 50 = 100 bps");
        assertEq(address(escrow).balance, 0);
        assertEq(GuildVault(escrow.guildVault()).escrow(), address(escrow));
    }

    function test_quoteFeeShares_floorsLikeQuoteFee() public view {
        (uint256 fee100, uint256 net100) = escrow.quoteFee(100);
        (uint256 vault100, uint256 treasury100) = escrow.quoteFeeShares(100);
        assertEq(fee100, 1);
        assertEq(net100, 99);
        assertEq(vault100, 0);
        assertEq(treasury100, 0);
        assertEq(fee100 - (vault100 + treasury100), 1);

        (uint256 vault200, uint256 treasury200) = escrow.quoteFeeShares(200);
        assertEq(vault200, uint256(200 * 50) / 10_000);
        assertEq(treasury200, uint256(200 * 50) / 10_000);
        assertEq(vault200 + treasury200, 2);

        (uint256 vault1, uint256 treasury1) = escrow.quoteFeeShares(1);
        assertEq(vault1, 0);
        assertEq(treasury1, 0);
    }

    function test_buyAsk_dustPrice_sellerKeepsPriceWhenFeeFloorsToZero() public {
        _open(LISTING, 99);
        vm.prank(buyer);
        escrow.buyAsk{value: 99}(LISTING, BUYER_TOKEN);
        assertEq(seller.balance, 99);
        assertEq(feeTo.balance, 0);
        assertEq(escrow.guildVault().balance, 0);
    }

    function test_directSend_doesNotFundVault() public {
        address vault = escrow.guildVault();
        vm.prank(buyer);
        vm.expectRevert(GuildVault.NotEscrow.selector);
        (bool ok,) = vault.call{value: 1 ether}("");
        ok;
        assertEq(vault.balance, 0);
    }

    function test_feeShares_cannotChangeWithoutTimelock() public {
        RulesetRegistry rules = new RulesetRegistry();
        assertEq(escrow.SHARE_DELAY(), rules.MIN_DELAY(), "share delay is the ruleset timelock floor");
        assertGe(escrow.SHARE_DELAY(), 1 days);

        vm.prank(buyer);
        vm.expectRevert(AhEscrow.Unauthorized.selector);
        escrow.proposeFeeShares(80, 20);
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);

        vm.prank(admin);
        vm.expectRevert(AhEscrow.BadShares.selector);
        escrow.proposeFeeShares(80, 30);
        assertEq(escrow.vaultBps(), 50);

        vm.prank(admin);
        escrow.proposeFeeShares(80, 20);
        assertEq(escrow.vaultBps(), 50, "propose is not an immediate setter");
        assertEq(escrow.treasuryBps(), 50);
        (uint256 pendingVault, uint256 pendingTreasury, uint64 readyAt) = escrow.pendingFeeShares();
        assertEq(pendingVault, 80);
        assertEq(pendingTreasury, 20);
        assertEq(readyAt, uint64(block.timestamp) + escrow.SHARE_DELAY());

        vm.prank(admin);
        vm.expectRevert(AhEscrow.TooEarly.selector);
        escrow.executeFeeShares();
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);

        vm.warp(readyAt - 1);
        vm.prank(admin);
        vm.expectRevert(AhEscrow.TooEarly.selector);
        escrow.executeFeeShares();
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);

        vm.prank(buyer);
        vm.expectRevert(AhEscrow.Unauthorized.selector);
        escrow.executeFeeShares();

        vm.warp(readyAt);
        vm.prank(admin);
        escrow.executeFeeShares();
        assertEq(escrow.vaultBps(), 80);
        assertEq(escrow.treasuryBps(), 20);
        assertEq(escrow.vaultBps() + escrow.treasuryBps(), escrow.FEE_BPS());
    }

    function test_overwrite_resetsTheTimelock() public {
        vm.prank(admin);
        escrow.proposeFeeShares(80, 20);
        (,, uint64 firstReady) = escrow.pendingFeeShares();

        vm.warp(firstReady - 1);
        vm.prank(admin);
        escrow.proposeFeeShares(70, 30);
        assertEq(escrow.vaultBps(), 50);
        (,, uint64 secondReady) = escrow.pendingFeeShares();
        assertEq(secondReady, uint64(block.timestamp) + escrow.SHARE_DELAY());

        vm.warp(firstReady);
        vm.prank(admin);
        vm.expectRevert(AhEscrow.TooEarly.selector);
        escrow.executeFeeShares();
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);
    }

    function test_cancel_leavesLiveShares() public {
        vm.prank(admin);
        escrow.proposeFeeShares(0, 100);
        vm.prank(admin);
        escrow.cancelFeeShares();
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);
        vm.warp(block.timestamp + escrow.SHARE_DELAY());
        vm.prank(admin);
        vm.expectRevert(AhEscrow.NoPendingShares.selector);
        escrow.executeFeeShares();
        assertEq(escrow.vaultBps(), 50);
    }

    function test_setFeeRecipient_doesNotChangeShares() public {
        vm.prank(admin);
        escrow.setFeeRecipient(payable(makeAddr("next")));
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);
        assertEq(escrow.guildVault().balance, 0);
    }

    function test_shareChange_keepsPlayerFeeAtOnePercent() public {
        vm.prank(admin);
        escrow.proposeFeeShares(80, 20);
        (,, uint64 readyAt) = escrow.pendingFeeShares();
        vm.warp(readyAt);
        vm.prank(admin);
        escrow.executeFeeShares();

        _open(LISTING, PRICE);
        uint256 beforeBuyer = buyer.balance;
        uint256 beforeSeller = seller.balance;
        vm.prank(buyer);
        escrow.buyAsk{value: PRICE}(LISTING, BUYER_TOKEN);

        uint256 fee = (PRICE * escrow.FEE_BPS()) / 10_000;
        assertEq(beforeBuyer - buyer.balance, PRICE);
        assertEq(seller.balance - beforeSeller, PRICE - fee);
        assertEq(escrow.guildVault().balance, (PRICE * 80) / 10_000);
        assertEq(feeTo.balance, (PRICE * 20) / 10_000);
        assertEq(escrow.FEE_BPS(), 100);
    }

    function test_buyAsk_oneWeiRemainderStaysInEscrow() public {
        _open(LISTING, 100);
        vm.prank(buyer);
        escrow.buyAsk{value: 100}(LISTING, BUYER_TOKEN);
        assertEq(seller.balance, 99, "seller still nets price minus the 1% fee");
        assertEq(escrow.guildVault().balance, 0);
        assertEq(feeTo.balance, 0);
        assertEq(address(escrow).balance, 1, "the unpaired wei is not a third payout");

        _open(8, 300);
        uint256 sellerBefore = seller.balance;
        vm.prank(buyer);
        escrow.buyAsk{value: 300}(8, BUYER_TOKEN);
        assertEq(seller.balance - sellerBefore, 297);
        assertEq(escrow.guildVault().balance, 1);
        assertEq(feeTo.balance, 1);
        assertEq(address(escrow).balance, 2);
    }

    function test_warpWithNoQueuedChange_leavesSharesAndAlreadyPaidWei() public {
        _open(LISTING, PRICE);
        uint256 beforeSeller = seller.balance;
        vm.prank(buyer);
        escrow.buyAsk{value: PRICE}(LISTING, BUYER_TOKEN);

        uint256 vaultWei = (PRICE * 50) / 10_000;
        uint256 treasuryWei = (PRICE * 50) / 10_000;
        assertEq(escrow.guildVault().balance, vaultWei);
        assertEq(feeTo.balance, treasuryWei);
        assertEq(seller.balance - beforeSeller, PRICE - ((PRICE * 100) / 10_000));
        assertEq(seller.balance - beforeSeller, (PRICE * 9900) / 10_000);

        vm.warp(block.timestamp + 1 days);
        assertEq(escrow.VAULT_FEE_BPS(), 50);
        assertEq(escrow.TREASURY_FEE_BPS(), 50);
        assertEq(escrow.vaultBps(), 50);
        assertEq(escrow.treasuryBps(), 50);
        assertEq(escrow.guildVault().balance, vaultWei, "a warp does not pay the fill again");
        assertEq(feeTo.balance, treasuryWei);
        (uint256 pendingVault, uint256 pendingTreasury, uint64 readyAt) = escrow.pendingFeeShares();
        assertEq(pendingVault, 0);
        assertEq(pendingTreasury, 0);
        assertEq(readyAt, 0);

        (bool released,) = address(escrow).call(abi.encodeWithSignature("releaseFeeShares()"));
        assertFalse(released);
        assertEq(escrow.guildVault().balance, vaultWei);
        assertEq(feeTo.balance, treasuryWei);
    }

    function testFuzz_sharesPartitionTheOnePercentFee(uint96 price) public view {
        price = uint96(bound(price, 1, type(uint96).max));
        (uint256 fee, uint256 net) = escrow.quoteFee(price);
        (uint256 vaultWei, uint256 treasuryWei) = escrow.quoteFeeShares(price);
        assertEq(fee, (uint256(price) * 100) / 10_000);
        assertEq(net, uint256(price) - fee);
        assertEq(vaultWei, (uint256(price) * 50) / 10_000);
        assertEq(treasuryWei, (uint256(price) * 50) / 10_000);
        assertLe(vaultWei + treasuryWei, fee);
        assertLe(fee - (vaultWei + treasuryWei), 1);
    }
}
