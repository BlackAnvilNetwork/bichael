// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {CharacterCheckpoint} from "../src/CharacterCheckpoint.sol";
import {KekVault} from "../src/KekVault.sol";
import {ItemIds} from "../src/libraries/ItemIds.sol";
import {ReentrantPlayer} from "./mocks/Mocks.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract CharacterCheckpointTest is Base {
    // ============================================================ checkpoints
    function test_checkpoint_commitsRootAndState() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c);

        vm.expectEmit(true, true, false, true, address(cp));
        emit CharacterCheckpoint.Checkpointed(tokenId, c.newRoot, c.prevRoot, c.fromIndex, c.toIndex, c.logHash, c.rulesetHash);
        vm.prank(player);
        cp.checkpoint(tokenId, c, a);

        assertEq(cp.stateRoot(tokenId), c.newRoot);
        assertEq(cp.summary(tokenId), c.summary);
        assertEq(cp.level(tokenId), 5);
        assertEq(cp.logIndex(tokenId), 10);
        assertEq(cp.revision(tokenId), 1);
        assertEq(cp.version(tokenId), 0, "checkpoints do not bump version");
        (bytes32 root,, CharacterCheckpoint.Meta memory m,) = cp.getCheckpointState(tokenId);
        assertEq(root, c.newRoot);
        assertEq(m.checkpointedAt, block.timestamp);
    }

    function test_checkpoint_chainsSequentially() public {
        CharacterCheckpoint.Checkpoint memory c1 = _submitNext();
        CharacterCheckpoint.Checkpoint memory c2 = _next();
        assertEq(c2.prevRoot, c1.newRoot);
        assertEq(c2.fromIndex, c1.toIndex);
        _submit(c2);
        assertEq(cp.logIndex(tokenId), 20);
        assertEq(cp.revision(tokenId), 2);
    }

    function test_checkpoint_rejectsReplay() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c);
        vm.startPrank(player);
        cp.checkpoint(tokenId, c, a);
        vm.expectRevert(CharacterCheckpoint.StaleRoot.selector);
        cp.checkpoint(tokenId, c, a);
        vm.stopPrank();
    }

    /// Two valid signatures from the same root: only one branch can ever land.
    function test_checkpoint_rejectsFork() public {
        CharacterCheckpoint.Checkpoint memory c1 = _next();
        CharacterCheckpoint.Checkpoint memory c2 = _next();
        c2.newRoot = keccak256("other branch");
        CharacterCheckpoint.Auth memory a1 = _auth(c1);
        CharacterCheckpoint.Auth memory a2 = _auth(c2);
        vm.startPrank(player);
        cp.checkpoint(tokenId, c1, a1);
        vm.expectRevert(CharacterCheckpoint.StaleRoot.selector);
        cp.checkpoint(tokenId, c2, a2);
        vm.stopPrank();
        assertEq(cp.stateRoot(tokenId), c1.newRoot);
    }

    function test_checkpoint_rejectsWrongPrevRoot() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.prevRoot = keccak256("not the head");
        _expectRevert(c, CharacterCheckpoint.StaleRoot.selector);
    }

    function test_checkpoint_rejectsLogGap() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.fromIndex += 1;
        c.toIndex += 1;
        _expectRevert(c, CharacterCheckpoint.BadRange.selector);
    }

    function test_checkpoint_rejectsLogOverlap() public {
        _submitNext();
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.fromIndex = 5; // rewinds into already-committed entries
        _expectRevert(c, CharacterCheckpoint.BadRange.selector);
    }

    function test_checkpoint_rejectsEmptyRange() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.toIndex = c.fromIndex;
        _expectRevert(c, CharacterCheckpoint.BadRange.selector);
    }

    function test_checkpoint_rejectsNonOwner() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(signerPk, other, tokenId, c, 0, block.timestamp + 120);
        vm.prank(other);
        vm.expectRevert(CharacterCheckpoint.NotOwner.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_checkpoint_signatureBindsPlayer() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(signerPk, other, tokenId, c, 0, block.timestamp + 120);
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadSignature.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_checkpoint_signatureBindsToken() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(signerPk, player, tokenId + 1, c, 0, block.timestamp + 120);
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadSignature.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_checkpoint_rejectsExpiredDeadline() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c);
        vm.warp(block.timestamp + 121);
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.Expired.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_checkpoint_rejectsUnregisteredSigner() public {
        (, uint256 badPk) = makeAddrAndKey("rogue");
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(badPk, player, tokenId, c, 0, block.timestamp + 120);
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadSignature.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_checkpoint_rejectsExpiredSigner() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(signerPk, player, tokenId, c, 0, block.timestamp + 8 hours);
        vm.warp(block.timestamp + 7 hours); // signer expired at +6h, deadline still valid
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadSignature.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_checkpoint_rejectsTamperedBody() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c);
        c.summary = uint256(99); // player bumps their own level after signing
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadSignature.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_checkpoint_rejectsTamperedExportsAndKek() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c);

        CharacterCheckpoint.Checkpoint memory withExport = _next();
        withExport.exports = _export(ITEM_SWORD, 1);
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadSignature.selector);
        cp.checkpoint(tokenId, withExport, a);

        CharacterCheckpoint.Checkpoint memory withKek = _next();
        withKek.kekOut = 1 ether;
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadSignature.selector);
        cp.checkpoint(tokenId, withKek, a);
    }

    function testFuzz_checkpoint_rejectsAnyWrongFromIndex(uint64 badFrom) public {
        vm.assume(badFrom != 0 && badFrom != type(uint64).max);
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.fromIndex = badFrom;
        c.toIndex = badFrom + 1;
        _expectRevert(c, CharacterCheckpoint.BadRange.selector);
    }

    function testFuzz_checkpoint_summaryRoundtrip(uint256 s) public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.summary = s;
        _submit(c);
        assertEq(cp.summary(tokenId), s);
        assertEq(cp.level(tokenId), uint16(s));
    }

    function testFuzz_checkpoint_chainKeepsHead(uint8 n) public {
        n = uint8(bound(n, 1, 8));
        CharacterCheckpoint.Checkpoint memory last;
        for (uint256 i; i < n; ++i) {
            last = _submitNext();
        }
        assertEq(cp.stateRoot(tokenId), last.newRoot);
        assertEq(cp.logIndex(tokenId), uint64(n) * 10);
        assertEq(cp.revision(tokenId), uint32(n));
    }

    // ================================================================ rulesets
    function test_ruleset_unknownRejected() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.rulesetHash = keccak256("never proposed");
        _expectRevert(c, CharacterCheckpoint.RulesetNotAccepted.selector);
    }

    function test_ruleset_notYetActiveRejected() public {
        bytes32 v2 = keccak256("ruleset-v2");
        vm.prank(proposer);
        rulesets.propose(v2, 48 hours, "ipfs://v2");
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.rulesetHash = v2;
        _expectRevert(c, CharacterCheckpoint.RulesetNotAccepted.selector);

        vm.warp(block.timestamp + 48 hours); // now active
        vm.prank(rotator);
        cp.addSigner(signer, uint64(block.timestamp + 6 hours));
        _submit(c);
        assertEq(cp.logIndex(tokenId), 10);
    }

    function test_ruleset_retiredRejected() public {
        vm.prank(admin);
        rulesets.retire(RULESET, uint64(block.timestamp + 1 hours));
        _submitNext(); // grace period still open
        vm.warp(block.timestamp + 1 hours);
        vm.prank(rotator);
        cp.addSigner(signer, uint64(block.timestamp + 6 hours));
        CharacterCheckpoint.Checkpoint memory c = _next();
        _expectRevert(c, CharacterCheckpoint.RulesetNotAccepted.selector);
    }

    function test_ruleset_unconfigured() public {
        vm.prank(admin);
        cp.setRulesets(address(0));
        CharacterCheckpoint.Checkpoint memory c = _next();
        _expectRevert(c, CharacterCheckpoint.NotConfigured.selector);
    }

    // ================================================================= exports
    function test_export_mintsToOwnerOnce() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.exports = _export(ITEM_SWORD, 1);
        CharacterCheckpoint.Auth memory a = _auth(c);

        vm.expectEmit(true, true, false, true, address(cp));
        emit CharacterCheckpoint.ItemExported(tokenId, ITEM_SWORD, 1, player);
        vm.prank(player);
        cp.checkpoint(tokenId, c, a);
        assertEq(items.balanceOf(player, ITEM_SWORD), 1);

        // replaying the signed export cannot mint twice
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.StaleRoot.selector);
        cp.checkpoint(tokenId, c, a);
        assertEq(items.balanceOf(player, ITEM_SWORD), 1);
    }

    function test_export_multipleItems() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.exports = new CharacterCheckpoint.Export[](2);
        c.exports[0] = CharacterCheckpoint.Export(ITEM_SWORD, 1);
        c.exports[1] = CharacterCheckpoint.Export(ITEM_ORE, 40);
        _submit(c);
        assertEq(items.balanceOf(player, ITEM_SWORD), 1);
        assertEq(items.balanceOf(player, ITEM_ORE), 40);
    }

    function test_export_uniqueAndFungibleIds() public {
        uint256 sword = ItemIds.unique("iron_sword", 42);
        uint256 ore = ItemIds.fungible("iron_ore");
        assertTrue(sword != ore);
        assertTrue(ItemIds.unique("iron_sword", 42) != ItemIds.unique("iron_sword", 43));
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.exports = new CharacterCheckpoint.Export[](2);
        c.exports[0] = CharacterCheckpoint.Export(sword, 1);
        c.exports[1] = CharacterCheckpoint.Export(ore, 12);
        _submit(c);
        assertEq(items.balanceOf(player, sword), 1);
        assertEq(items.balanceOf(player, ore), 12);
    }

    function test_export_rejectsZeroAmount() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.exports = _export(ITEM_SWORD, 0);
        _expectRevert(c, CharacterCheckpoint.BadExport.selector);
    }

    function test_export_itemsUnconfigured() public {
        vm.prank(admin);
        cp.setItems(address(0));
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.exports = _export(ITEM_SWORD, 1);
        _expectRevert(c, CharacterCheckpoint.NotConfigured.selector);
        // a checkpoint with no exports does not need the items contract
        _submitNext();
    }

    function test_export_failureRollsBackRoot() public {
        items.setMinter(address(cp), false); // mint will revert
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.exports = _export(ITEM_SWORD, 1);
        CharacterCheckpoint.Auth memory a = _auth(c);
        bytes32 before = cp.stateRoot(tokenId);
        vm.prank(player);
        vm.expectRevert();
        cp.checkpoint(tokenId, c, a);
        assertEq(cp.stateRoot(tokenId), before);
        assertEq(cp.logIndex(tokenId), 0);
    }

    function test_export_reentrancyViaMintReceiverBlocked() public {
        ReentrantPlayer atk = new ReentrantPlayer();
        vm.deal(address(atk), 1 ether);
        bytes memory ret = atk.call(address(factory), 0.001 ether, abi.encodeCall(factory.createCharacter, (1)));
        uint256 atkToken = abi.decode(ret, (uint256));

        CharacterCheckpoint.Checkpoint memory c = _next(atkToken);
        c.exports = _export(ITEM_SWORD, 1);
        CharacterCheckpoint.Auth memory a = _auth(signerPk, address(atk), atkToken, c, 0, block.timestamp + 120);
        bytes memory call_ = abi.encodeCall(cp.checkpoint, (atkToken, c, a));
        atk.arm(address(cp), call_); // when the 1155 lands, call checkpoint again

        vm.expectRevert(ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector);
        atk.call(address(cp), 0, call_);
        assertEq(cp.logIndex(atkToken), 0, "whole tx rolled back");
        assertEq(items.balanceOf(address(atk), ITEM_SWORD), 0);
    }

    // ================================================================= imports
    function test_import_burnsAndQueues() public {
        items.mint(player, ITEM_SWORD, 2);
        vm.expectEmit(true, true, false, true, address(cp));
        emit CharacterCheckpoint.ItemImportRequested(tokenId, 1, ITEM_SWORD, 1, player);
        vm.prank(player);
        cp.importItem(tokenId, ITEM_SWORD, 1);
        assertEq(items.balanceOf(player, ITEM_SWORD), 1);
        assertEq(cp.inboundCount(tokenId), 1);
        assertEq(cp.inboundApplied(tokenId), 0);
    }

    function test_import_rejections() public {
        vm.startPrank(other);
        vm.expectRevert(CharacterCheckpoint.NotOwner.selector);
        cp.importItem(tokenId, ITEM_SWORD, 1);
        vm.stopPrank();

        vm.startPrank(player);
        vm.expectRevert(CharacterCheckpoint.BadImport.selector);
        cp.importItem(tokenId, ITEM_SWORD, 0);
        vm.expectRevert(); // does not hold the item
        cp.importItem(tokenId, ITEM_SWORD, 1);
        vm.stopPrank();
        assertEq(cp.inboundCount(tokenId), 0, "failed imports do not consume nonces");
    }

    function test_inbound_checkpointMustConsumeWithinBounds() public {
        items.mint(player, ITEM_SWORD, 3);
        vm.startPrank(player);
        cp.importItem(tokenId, ITEM_SWORD, 1);
        cp.importItem(tokenId, ITEM_SWORD, 1);
        vm.stopPrank();

        CharacterCheckpoint.Checkpoint memory c = _next();
        c.inboundConsumed = 3; // claims to have applied an import that was never requested
        _expectRevert(c, CharacterCheckpoint.BadInbound.selector);

        c = _next();
        c.inboundConsumed = 1; // partial consumption is fine
        _submit(c);
        assertEq(cp.inboundApplied(tokenId), 1);

        c = _next();
        c.inboundConsumed = 0; // cannot un-apply
        _expectRevert(c, CharacterCheckpoint.BadInbound.selector);

        c = _next();
        c.inboundConsumed = 2;
        _submit(c);
        assertEq(cp.inboundApplied(tokenId), 2);
    }

    function test_import_pendingTravelsWithTokenOnTransfer() public {
        items.mint(player, ITEM_SWORD, 1);
        vm.prank(player);
        cp.importItem(tokenId, ITEM_SWORD, 1);
        vm.prank(player);
        nft.transferFrom(player, other, tokenId);
        assertEq(cp.inboundCount(tokenId), 1);

        CharacterCheckpoint.Checkpoint memory c = _next();
        c.inboundConsumed = 1;
        CharacterCheckpoint.Auth memory a = _auth(signerPk, other, tokenId, c, 1, block.timestamp + 120);
        vm.prank(other);
        cp.checkpoint(tokenId, c, a);
        assertEq(cp.inboundApplied(tokenId), 1);
    }

    // ===================================================================== KEK
    function _fundAndApprove(uint256 amt) internal {
        kek.mint(player, amt);
        vm.prank(player);
        kek.approve(address(vault), type(uint256).max);
    }

    function test_kek_depositQueuesInbound() public {
        _fundAndApprove(100 ether);
        vm.expectEmit(true, true, false, true, address(cp));
        emit CharacterCheckpoint.KekDepositRequested(tokenId, 1, 60 ether, player);
        vm.prank(player);
        cp.depositKek(tokenId, 60 ether);
        assertEq(kek.balanceOf(address(vault)), 60 ether);
        assertEq(kek.balanceOf(player), 40 ether);
        assertEq(cp.inboundCount(tokenId), 1);
    }

    function test_kek_depositRejections() public {
        _fundAndApprove(10 ether);
        vm.prank(other);
        vm.expectRevert(CharacterCheckpoint.NotOwner.selector);
        cp.depositKek(tokenId, 1 ether);
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.BadDeposit.selector);
        cp.depositKek(tokenId, 0);
        vm.prank(player);
        vm.expectRevert(); // more than the player holds
        cp.depositKek(tokenId, 11 ether);
        assertEq(cp.inboundCount(tokenId), 0);
    }

    function test_kek_depositAndWithdrawFlow() public {
        _fundAndApprove(100 ether);
        vm.prank(player);
        cp.depositKek(tokenId, 100 ether);

        CharacterCheckpoint.Checkpoint memory c = _next();
        c.inboundConsumed = 1;
        c.kekOut = 40 ether; // engine decreased the in-game counter by 40
        CharacterCheckpoint.Auth memory a = _auth(c);
        vm.expectEmit(true, true, false, true, address(cp));
        emit CharacterCheckpoint.KekWithdrawalQueued(tokenId, 1, 40 ether, player);
        vm.prank(player);
        cp.checkpoint(tokenId, c, a);

        (address to, uint64 availableAt, KekVault.Status st, uint256 amt) = vault.withdrawals(1);
        assertEq(to, player);
        assertEq(amt, 40 ether);
        assertEq(uint8(st), uint8(KekVault.Status.Pending));
        assertEq(availableAt, block.timestamp + WITHDRAW_DELAY);
        assertEq(vault.pendingTotal(), 40 ether);

        vm.expectRevert(KekVault.NotYet.selector);
        vault.claim(1);

        vm.warp(block.timestamp + WITHDRAW_DELAY);
        vault.claim(1);
        assertEq(kek.balanceOf(player), 40 ether);
        assertEq(kek.balanceOf(address(vault)), 60 ether);
        assertEq(vault.pendingTotal(), 0);
    }

    function test_checkpoint_relayerPaysTheNftOwnerNotTheSigner() public {
        _fundAndApprove(50 ether);
        vm.prank(player);
        cp.depositKek(tokenId, 50 ether);
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.inboundConsumed = 1;
        c.kekOut = 20 ether;
        CharacterCheckpoint.Auth memory a = _auth(c);
        vm.prank(signer);
        cp.checkpoint(tokenId, c, a);
        (address to,, , uint256 amt) = vault.withdrawals(1);
        assertEq(to, player);
        assertTrue(to != signer);
        assertEq(amt, 20 ether);
    }

    function test_kek_withdrawalCannotExceedVault() public {
        _fundAndApprove(100 ether);
        vm.prank(player);
        cp.depositKek(tokenId, 100 ether);
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.inboundConsumed = 1;
        c.kekOut = 100 ether + 1; // a compromised signer attesting more than custody holds
        _expectRevert(c, KekVault.InsufficientVault.selector);
        assertEq(cp.logIndex(tokenId), 0, "checkpoint rolled back");
    }

    function test_kek_vaultUnconfigured() public {
        vm.prank(admin);
        cp.setVault(address(0));
        CharacterCheckpoint.Checkpoint memory c = _next();
        c.kekOut = 1 ether;
        _expectRevert(c, CharacterCheckpoint.NotConfigured.selector);
        vm.prank(player);
        vm.expectRevert(CharacterCheckpoint.NotConfigured.selector);
        cp.depositKek(tokenId, 1 ether);
    }

    // ============================================================== transfers
    function test_transfer_bumpsVersionAndKillsSignature() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c); // issued to player at version 0
        vm.prank(player);
        nft.transferFrom(player, other, tokenId);
        assertEq(cp.version(tokenId), 1);
        assertEq(cp.revision(tokenId), 1);

        vm.prank(other);
        vm.expectRevert(CharacterCheckpoint.StaleVersion.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_transfer_midFlight_ownerCannotSubmitAfterSale() public {
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c);
        vm.prank(player);
        nft.transferFrom(player, other, tokenId);
        vm.prank(player); // seller submits after selling
        vm.expectRevert(CharacterCheckpoint.NotOwner.selector);
        cp.checkpoint(tokenId, c, a);
    }

    function test_transfer_newOwnerContinuesFromCommittedRoot() public {
        CharacterCheckpoint.Checkpoint memory c1 = _submitNext();
        vm.prank(player);
        nft.transferFrom(player, other, tokenId);
        CharacterCheckpoint.Checkpoint memory c2 = _next();
        assertEq(c2.prevRoot, c1.newRoot);
        CharacterCheckpoint.Auth memory a = _auth(signerPk, other, tokenId, c2, 1, block.timestamp + 120);
        vm.prank(other);
        cp.checkpoint(tokenId, c2, a);
        assertEq(cp.logIndex(tokenId), 20);
    }

    function test_mint_doesNotBumpVersion() public view {
        assertEq(cp.version(tokenId), 0);
        assertEq(cp.revision(tokenId), 0);
    }

    function test_onTransfer_onlyNft() public {
        vm.prank(other);
        vm.expectRevert();
        cp.onTransfer(tokenId);
    }

    // ============================================================ initCharacter
    function test_init_genesisRootAndSummary() public view {
        assertEq(cp.stateRoot(tokenId), keccak256(abi.encode(cp.GENESIS_TAG(), tokenId, uint8(1))));
        assertEq(cp.level(tokenId), 1);
        assertEq(uint8(cp.summary(tokenId) >> 16), 1);
        assertEq(cp.logIndex(tokenId), 0);
    }

    function test_init_cannotReseed() public {
        vm.prank(address(factory));
        vm.expectRevert(CharacterCheckpoint.AlreadyInit.selector);
        cp.initCharacter(tokenId, 1);
    }

    function test_init_onlyFactory() public {
        vm.prank(other);
        vm.expectRevert();
        cp.initCharacter(999, 1);
    }

    // ================================================ signer registry / guardian
    function test_addSigner_bounds() public {
        vm.startPrank(rotator);
        vm.expectRevert(CharacterCheckpoint.BadSigner.selector);
        cp.addSigner(address(0), uint64(block.timestamp + 1 hours));
        vm.expectRevert(CharacterCheckpoint.BadSigner.selector);
        cp.addSigner(other, uint64(block.timestamp));
        vm.expectRevert(CharacterCheckpoint.BadSigner.selector);
        cp.addSigner(other, uint64(block.timestamp + 24 hours + 1));
        cp.addSigner(other, uint64(block.timestamp + 24 hours));
        vm.stopPrank();
        assertTrue(cp.isActiveSigner(other));
    }

    function test_addSigner_onlyRotator() public {
        vm.prank(guardian);
        vm.expectRevert();
        cp.addSigner(other, uint64(block.timestamp + 1 hours));
    }

    function test_rotation_overlapKeepsOldKeyValid() public {
        (address next, uint256 nextPk) = makeAddrAndKey("next");
        vm.prank(rotator);
        cp.addSigner(next, uint64(block.timestamp + 12 hours));
        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(nextPk, player, tokenId, c, 0, block.timestamp + 120);
        vm.prank(player);
        cp.checkpoint(tokenId, c, a);
        _submitNext(); // old key still signs
        assertEq(cp.logIndex(tokenId), 20);
    }

    function test_revokeSigner() public {
        vm.prank(guardian);
        cp.revokeSigner(signer);
        _expectRevert(_next(), CharacterCheckpoint.BadSignature.selector);
    }

    function test_revokeAllSigners_thenReAdd() public {
        vm.prank(guardian);
        cp.revokeAllSigners();
        assertFalse(cp.isActiveSigner(signer));
        vm.prank(rotator);
        cp.addSigner(signer, uint64(block.timestamp + 1 hours));
        assertTrue(cp.isActiveSigner(signer));
    }

    function test_pause_blocksEverything() public {
        vm.prank(guardian);
        cp.pause();

        CharacterCheckpoint.Checkpoint memory c = _next();
        CharacterCheckpoint.Auth memory a = _auth(c);
        vm.startPrank(player);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        cp.checkpoint(tokenId, c, a);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        cp.importItem(tokenId, ITEM_SWORD, 1);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        cp.depositKek(tokenId, 1);
        vm.stopPrank();

        vm.prank(rotator);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        cp.addSigner(other, uint64(block.timestamp + 1 hours));
    }

    function test_guardian_cannotUnpauseOrUpgrade() public {
        vm.prank(guardian);
        cp.pause();
        bytes32 adminRole = cp.DEFAULT_ADMIN_ROLE();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole));
        cp.unpause();

        address newImpl = address(new CharacterCheckpoint());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole));
        UUPSUpgradeable(address(cp)).upgradeToAndCall(newImpl, "");

        vm.prank(admin);
        cp.unpause();
        assertFalse(cp.paused());
    }

    function test_config_adminOnly() public {
        vm.startPrank(other);
        vm.expectRevert();
        cp.setRulesets(address(1));
        vm.expectRevert();
        cp.setItems(address(1));
        vm.expectRevert();
        cp.setVault(address(1));
        vm.stopPrank();
    }

    function test_upgrade_adminOnly_andPreservesState() public {
        CharacterCheckpoint.Checkpoint memory c = _submitNext();
        address newImpl = address(new CharacterCheckpoint());
        vm.prank(other);
        vm.expectRevert();
        UUPSUpgradeable(address(cp)).upgradeToAndCall(newImpl, "");

        vm.prank(admin);
        UUPSUpgradeable(address(cp)).upgradeToAndCall(newImpl, "");
        assertEq(cp.stateRoot(tokenId), c.newRoot);
        assertEq(cp.logIndex(tokenId), 10);
        assertEq(address(cp.vault()), address(vault));
    }

    function test_implementation_cannotBeInitialized() public {
        CharacterCheckpoint impl = new CharacterCheckpoint();
        vm.expectRevert();
        impl.initialize(admin, address(nft), rotator, guardian);
    }

    // ---------------------------------------------------------------- helpers
    function _expectRevert(CharacterCheckpoint.Checkpoint memory c, bytes4 err) internal {
        CharacterCheckpoint.Auth memory a = _auth(c);
        vm.prank(player);
        vm.expectRevert(err);
        cp.checkpoint(tokenId, c, a);
    }
}
