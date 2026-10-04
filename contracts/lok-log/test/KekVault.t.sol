// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {KekVault} from "../src/KekVault.sol";
import {MockKEK, MockFeeToken} from "./mocks/Mocks.sol";

/// Direct vault tests. The bridge role is held by this test contract in place of CharacterCheckpoint.
contract KekVaultTest is Test {
    KekVault vault;
    MockKEK kek;
    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address player = makeAddr("player");
    address other = makeAddr("other");
    uint256 constant TOKEN = 1;

    function _make(address token) internal returns (KekVault v) {
        v = KekVault(
            address(
                new ERC1967Proxy(address(new KekVault()), abi.encodeCall(KekVault.initialize, (admin, token, guardian, 24 hours)))
            )
        );
        bytes32 bridge = v.BRIDGE_ROLE(); // read before pranking: the prank applies to the next external call
        vm.prank(admin);
        v.grantRole(bridge, address(this));
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        kek = new MockKEK();
        vault = _make(address(kek));
        kek.mint(player, 1000 ether);
        vm.prank(player);
        kek.approve(address(vault), type(uint256).max);
    }

    function _deposit(uint256 amt) internal {
        vault.deposit(player, TOKEN, amt);
    }

    // ------------------------------------------------------------------ access
    function test_bridgeOnly() public {
        vm.startPrank(other);
        vm.expectRevert();
        vault.deposit(player, TOKEN, 1 ether);
        vm.expectRevert();
        vault.queueWithdrawal(other, TOKEN, 1 ether);
        vm.stopPrank();
    }

    function test_cannotPullFromArbitraryAccountWithoutBridge() public {
        // a random caller cannot use the vault's allowance from `player`
        vm.prank(other);
        vm.expectRevert();
        vault.deposit(player, TOKEN, 1 ether);
        assertEq(kek.balanceOf(player), 1000 ether);
    }

    // ----------------------------------------------------------------- deposit
    function test_deposit_custodies() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit KekVault.Deposited(TOKEN, player, 100 ether);
        _deposit(100 ether);
        assertEq(kek.balanceOf(address(vault)), 100 ether);
        assertEq(kek.balanceOf(player), 900 ether);
    }

    function test_deposit_zeroRejected() public {
        vm.expectRevert(KekVault.BadAmount.selector);
        _deposit(0);
    }

    function test_deposit_rejectsFeeOnTransferToken() public {
        MockFeeToken fee = new MockFeeToken();
        KekVault v = _make(address(fee));
        fee.mint(player, 100 ether);
        vm.prank(player);
        fee.approve(address(v), type(uint256).max);
        vm.expectRevert(KekVault.TransferMismatch.selector);
        v.deposit(player, TOKEN, 100 ether);
    }

    // --------------------------------------------------------------- withdrawal
    function test_withdraw_delayedThenClaimable_byAnyone() public {
        _deposit(100 ether);
        uint256 id = vault.queueWithdrawal(player, TOKEN, 30 ether);
        assertEq(id, 1);
        assertEq(vault.pendingTotal(), 30 ether);

        vm.prank(other);
        vm.expectRevert(KekVault.NotYet.selector);
        vault.claim(id);

        vm.warp(block.timestamp + 24 hours);
        vm.prank(other); // a third party triggers it; funds still go to the recorded recipient
        vault.claim(id);
        assertEq(kek.balanceOf(player), 930 ether);
        assertEq(kek.balanceOf(other), 0);
        assertEq(vault.pendingTotal(), 0);
    }

    function test_withdraw_cannotClaimTwice() public {
        _deposit(100 ether);
        uint256 id = vault.queueWithdrawal(player, TOKEN, 30 ether);
        vm.warp(block.timestamp + 24 hours);
        vault.claim(id);
        vm.expectRevert(KekVault.NotPending.selector);
        vault.claim(id);
    }

    function test_withdraw_cannotExceedThatTokensDeposits() public {
        kek.mint(other, 1000 ether);
        vm.prank(other);
        kek.approve(address(vault), type(uint256).max);
        vault.deposit(other, 2, 1000 ether);
        _deposit(10 ether);

        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.queueWithdrawal(player, TOKEN, 11 ether);

        uint256 id = vault.queueWithdrawal(player, TOKEN, 10 ether);
        assertEq(id, 1);
        assertEq(vault.reservedOf(TOKEN), 10 ether);
        assertEq(vault.depositedOf(TOKEN), 10 ether);
        // The other character's KEK is still in the vault, and this token is already at its cap.
        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.queueWithdrawal(player, TOKEN, 1 ether);

        vm.warp(block.timestamp + 24 hours);
        vault.claim(id);
        assertEq(vault.reservedOf(TOKEN), 10 ether, "a claimed withdrawal still counts against the cap");
        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.queueWithdrawal(player, TOKEN, 1 ether);

        uint256 otherId = vault.queueWithdrawal(other, 2, 1000 ether);
        assertEq(otherId, 2);
        assertEq(kek.balanceOf(address(vault)), 1000 ether);
    }

    function test_withdraw_cancelReleasesCap_restoreRechecksIt() public {
        kek.mint(other, 50 ether);
        vm.prank(other);
        kek.approve(address(vault), type(uint256).max);
        vault.deposit(other, 2, 50 ether);
        _deposit(40 ether);

        uint256 id = vault.queueWithdrawal(player, TOKEN, 40 ether);
        vm.prank(guardian);
        vault.cancel(id);
        assertEq(vault.reservedOf(TOKEN), 0);

        vault.queueWithdrawal(player, TOKEN, 40 ether);
        vm.prank(admin);
        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.restore(id);
    }

    function test_withdraw_cannotQueueMoreThanVaultHolds_includingPending() public {
        _deposit(100 ether);
        vault.queueWithdrawal(player, TOKEN, 60 ether);
        vm.expectRevert(KekVault.InsufficientVault.selector);
        vault.queueWithdrawal(player, TOKEN, 41 ether); // 60 pending + 41 > 100
        vault.queueWithdrawal(player, TOKEN, 40 ether); // exactly the rest is fine
    }

    function test_withdraw_badArgs() public {
        _deposit(10 ether);
        vm.expectRevert(KekVault.BadAmount.selector);
        vault.queueWithdrawal(player, TOKEN, 0);
        vm.expectRevert(KekVault.BadAmount.selector);
        vault.queueWithdrawal(address(0), TOKEN, 1 ether);
    }

    // ------------------------------------------------------- guardian / admin
    function test_guardian_cancelThenAdminRestore() public {
        _deposit(100 ether);
        uint256 id = vault.queueWithdrawal(player, TOKEN, 50 ether);

        vm.prank(guardian);
        vault.cancel(id);
        assertEq(vault.pendingTotal(), 0);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(KekVault.NotPending.selector);
        vault.claim(id);
        assertEq(kek.balanceOf(address(vault)), 100 ether, "cancelled funds stay in custody");

        vm.prank(guardian);
        vm.expectRevert(); // guardian cannot restore
        vault.restore(id);

        vm.prank(admin);
        vault.restore(id);
        assertEq(vault.pendingTotal(), 50 ether);
        vm.expectRevert(KekVault.NotYet.selector); // fresh delay
        vault.claim(id);
        vm.warp(block.timestamp + 24 hours);
        vault.claim(id);
        assertEq(kek.balanceOf(player), 950 ether);
    }

    function test_cancel_onlyGuardian_andOnlyPending() public {
        _deposit(100 ether);
        uint256 id = vault.queueWithdrawal(player, TOKEN, 10 ether);
        vm.prank(other);
        vm.expectRevert();
        vault.cancel(id);
        vm.startPrank(guardian);
        vault.cancel(id);
        vm.expectRevert(KekVault.NotPending.selector);
        vault.cancel(id);
        vm.stopPrank();
        vm.prank(admin);
        vm.expectRevert(KekVault.NotCancelled.selector);
        vault.restore(999);
    }

    function test_pause_blocksDepositQueueAndClaim() public {
        _deposit(100 ether);
        uint256 id = vault.queueWithdrawal(player, TOKEN, 10 ether);
        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        _deposit(1 ether);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.queueWithdrawal(player, TOKEN, 1 ether);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.claim(id);

        vm.prank(guardian);
        vm.expectRevert(); // only admin unpauses
        vault.unpause();
        vm.prank(admin);
        vault.unpause();
        vault.claim(id);
    }

    function test_delayBounds() public {
        vm.startPrank(admin);
        vm.expectRevert(KekVault.BadDelay.selector);
        vault.setWithdrawDelay(1 hours - 1);
        vm.expectRevert(KekVault.BadDelay.selector);
        vault.setWithdrawDelay(30 days + 1);
        vault.setWithdrawDelay(1 hours);
        vm.stopPrank();
        assertEq(vault.withdrawDelay(), 1 hours);

        vm.prank(other);
        vm.expectRevert();
        vault.setWithdrawDelay(2 hours);

        // delay cannot be initialised outside the bounds either
        address impl = address(new KekVault());
        vm.expectRevert(KekVault.BadDelay.selector);
        new ERC1967Proxy(impl, abi.encodeCall(KekVault.initialize, (admin, address(kek), guardian, 0)));
    }

    function test_upgrade_adminOnly_andPreservesState() public {
        _deposit(100 ether);
        vault.queueWithdrawal(player, TOKEN, 10 ether);
        address impl = address(new KekVault());
        vm.prank(guardian);
        vm.expectRevert();
        UUPSUpgradeable(address(vault)).upgradeToAndCall(impl, "");
        vm.prank(admin);
        UUPSUpgradeable(address(vault)).upgradeToAndCall(impl, "");
        assertEq(vault.pendingTotal(), 10 ether);
        assertEq(kek.balanceOf(address(vault)), 100 ether);
    }

    // -------------------------------------------------------------- invariants
    /// Whatever sequence of deposits, queues, cancels and claims happens, pending never exceeds custody.
    function testFuzz_pendingNeverExceedsCustody(uint96 d1, uint96 q1, uint96 q2, bool cancelFirst, bool claimSecond)
        public
    {
        d1 = uint96(bound(d1, 1, 1000 ether));
        _deposit(d1);
        uint256 id1;
        uint256 id2;
        if (q1 > 0 && q1 <= d1) id1 = vault.queueWithdrawal(player, TOKEN, q1);
        if (q2 > 0 && uint256(vault.pendingTotal()) + q2 <= kek.balanceOf(address(vault))) {
            id2 = vault.queueWithdrawal(player, TOKEN, q2);
        }
        assertLe(vault.pendingTotal(), kek.balanceOf(address(vault)));
        if (cancelFirst && id1 != 0) {
            vm.prank(guardian);
            vault.cancel(id1);
        }
        if (claimSecond && id2 != 0) {
            vm.warp(block.timestamp + 24 hours);
            vault.claim(id2);
        }
        assertLe(vault.pendingTotal(), kek.balanceOf(address(vault)));
    }

    function test_reassign_receiptIsWithdrawable_and_sentKekIsNot() public {
        _deposit(100 ether);
        vault.reassign(TOKEN, 2, 40 ether);
        assertEq(vault.depositedOf(TOKEN), 60 ether);
        assertEq(vault.depositedOf(2), 40 ether);

        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.queueWithdrawal(player, TOKEN, 61 ether);
        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.queueWithdrawal(other, 2, 41 ether);
        vault.queueWithdrawal(player, TOKEN, 60 ether);
        vault.queueWithdrawal(other, 2, 40 ether);
        vm.expectRevert(KekVault.InsufficientVault.selector);
        vault.queueWithdrawal(other, 2, 1 ether);
        vm.expectRevert(KekVault.InsufficientVault.selector);
        vault.queueWithdrawal(player, TOKEN, 1 ether);
        assertEq(vault.depositedOf(TOKEN) + vault.depositedOf(2), 100 ether);
    }

    function test_sink_removesSpentKekFromTheSpender() public {
        kek.mint(player, 10_000 ether);
        _deposit(10_000 ether);
        vault.sink(TOKEN, 10_000 ether);
        assertEq(vault.depositedOf(TOKEN), 0);
        assertEq(kek.balanceOf(address(vault)), 0);
        assertEq(kek.balanceOf(address(0x000000000000000000000000000000000000dEaD)), 10_000 ether);
        vm.expectRevert(KekVault.InsufficientVault.selector);
        vault.queueWithdrawal(player, TOKEN, 1);
    }

    function test_reassign_cannotMoveReservedOrDoubleSpend() public {
        _deposit(100 ether);
        vault.queueWithdrawal(player, TOKEN, 70 ether);
        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.reassign(TOKEN, 2, 40 ether);
        vault.reassign(TOKEN, 2, 30 ether);
        assertEq(vault.depositedOf(TOKEN), 70 ether);
        assertEq(vault.depositedOf(2), 30 ether);
        vm.expectRevert(KekVault.ExceedsTokenDeposits.selector);
        vault.queueWithdrawal(player, TOKEN, 1 ether);
    }

    function test_implementation_cannotBeInitialized() public {
        KekVault impl = new KekVault();
        vm.expectRevert();
        impl.initialize(admin, address(kek), guardian, 24 hours);
    }
}
