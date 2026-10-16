// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RootAnchor} from "../src/RootAnchor.sol";

contract RootAnchorTest is Test {
    RootAnchor anchor;
    bytes32 root = keccak256("next-root");
    bytes certificate = hex"01020304";

    function setUp() public {
        anchor = new RootAnchor();
    }

    function test_nothing_is_anchored_until_a_post() public view {
        assertFalse(anchor.hasAnchor());
        assertEq(anchor.lastAnchoredHeight(), 0);
        assertFalse(anchor.isAnchored(0, root));
    }

    function test_post_records_height_root_and_certificate() public {
        anchor.post(0, root, certificate);
        assertTrue(anchor.hasAnchor());
        assertEq(anchor.lastAnchoredHeight(), 0);
        assertTrue(anchor.isAnchored(0, root));
        assertFalse(anchor.isAnchored(0, bytes32(uint256(1))));

        (bytes32 stored, bytes memory cert) = anchor.anchoredRoot(0);
        assertEq(stored, root);
        assertEq(cert, certificate);
    }

    function test_empty_certificate_does_not_anchor() public {
        vm.expectRevert(RootAnchor.EmptyCertificate.selector);
        anchor.post(1, root, "");
        assertFalse(anchor.hasAnchor());
    }

    function test_a_later_height_advances_and_an_older_one_does_not() public {
        anchor.post(4, root, certificate);
        assertEq(anchor.lastAnchoredHeight(), 4);

        bytes32 later = keccak256("later");
        anchor.post(9, later, hex"aa");
        assertEq(anchor.lastAnchoredHeight(), 9);
        assertTrue(anchor.isAnchored(4, root));
        assertTrue(anchor.isAnchored(9, later));
        assertFalse(anchor.isAnchored(5, root));

        vm.expectRevert(abi.encodeWithSelector(RootAnchor.HeightNotAfterAnchor.selector, uint64(9), uint64(9)));
        anchor.post(9, later, hex"bb");
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.HeightNotAfterAnchor.selector, uint64(3), uint64(9)));
        anchor.post(3, root, certificate);
    }

    function test_a_zero_root_is_still_an_anchor() public {
        anchor.post(1, bytes32(0), certificate);
        assertTrue(anchor.hasAnchor());
        assertEq(anchor.lastAnchoredHeight(), 1);
        assertTrue(anchor.isAnchored(1, bytes32(0)));
        (bytes32 stored,) = anchor.anchoredRoot(1);
        assertEq(stored, bytes32(0));
    }

    function test_a_batch_post_does_not_record_a_blob() public {
        anchor.post(4, root, certificate);
        assertTrue(anchor.isAnchored(4, root));
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.CheckpointBlobMissing.selector, bytes32(uint256(1))));
        anchor.checkpointBlob(bytes32(uint256(1)));
    }

    function test_postCheckpointBlob_stores_commitment_and_keccak() public {
        bytes memory commitment = new bytes(48);
        commitment[0] = 0xab;
        commitment[47] = 0xcd;
        bytes32 checkpointKeccak = keccak256("checkpoint-bytes");

        _useBlob(commitment);
        vm.expectEmit(true, false, false, true);
        emit RootAnchor.CheckpointBlobPosted(checkpointKeccak, commitment);
        anchor.postCheckpointBlob(commitment, checkpointKeccak);

        (bytes memory storedCommitment, bytes32 storedKeccak) = anchor.checkpointBlob(checkpointKeccak);
        assertEq(storedCommitment, commitment);
        assertEq(storedKeccak, checkpointKeccak);
        assertEq(anchor.lastAnchoredHeight(), 0);
        assertFalse(anchor.hasAnchor());

        _useBlob(commitment);
        anchor.postCheckpointBlob(commitment, checkpointKeccak);
        (storedCommitment, storedKeccak) = anchor.checkpointBlob(checkpointKeccak);
        assertEq(storedCommitment, commitment);
        assertEq(storedKeccak, checkpointKeccak);
    }

    function test_versioned_hash_is_the_eip4844_rule() public {
        bytes memory commitment =
            hex"8d11423a504d39e6b3a36f4c1e72932fc104a4f7edc5087f07b8433e975a2593ac6937b9a08f379d12568d774a63b411";
        bytes32 versioned = hex"01f63dba6fe23bbe500c0921a48221d15507f5cf0148612203597f57c3c1dbd3";
        bytes32 checkpointKeccak = keccak256("vector");
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = versioned;
        vm.blobhashes(hashes);
        anchor.postCheckpointBlob(commitment, checkpointKeccak);
        (bytes memory stored,) = anchor.checkpointBlob(checkpointKeccak);
        assertEq(stored, commitment);
        assertEq(stored.length, 48);
    }

    function test_a_commitment_that_does_not_match_the_blob_is_not_stored() public {
        bytes memory commitment = new bytes(48);
        commitment[0] = 0xab;
        bytes32 checkpointKeccak = keccak256("checkpoint-bytes");
        bytes32 versioned = _versioned(commitment);

        vm.blobhashes(new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.BlobHashMismatch.selector, bytes32(0), versioned));
        anchor.postCheckpointBlob(commitment, checkpointKeccak);

        bytes32[] memory wrong = new bytes32[](1);
        wrong[0] = bytes32(uint256(0x02));
        vm.blobhashes(wrong);
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.BlobHashMismatch.selector, wrong[0], versioned));
        anchor.postCheckpointBlob(commitment, checkpointKeccak);

        vm.expectRevert(abi.encodeWithSelector(RootAnchor.CheckpointBlobMissing.selector, checkpointKeccak));
        anchor.checkpointBlob(checkpointKeccak);
    }

    function test_a_different_commitment_for_the_same_keccak_is_refused() public {
        bytes memory commitment = new bytes(48);
        commitment[0] = 0x11;
        bytes32 checkpointKeccak = keccak256("checkpoint-bytes");
        _useBlob(commitment);
        anchor.postCheckpointBlob(commitment, checkpointKeccak);

        bytes memory other = new bytes(48);
        other[0] = 0x22;
        _useBlob(other);
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.CheckpointBlobConflict.selector, checkpointKeccak));
        anchor.postCheckpointBlob(other, checkpointKeccak);

        (bytes memory storedCommitment,) = anchor.checkpointBlob(checkpointKeccak);
        assertEq(storedCommitment, commitment);
    }

    function _useBlob(bytes memory commitment) internal {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = _versioned(commitment);
        vm.blobhashes(hashes);
    }

    function _versioned(bytes memory commitment) internal pure returns (bytes32) {
        bytes32 digest = sha256(commitment);
        uint256 mask = uint256(0x00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
        return bytes32((uint256(digest) & mask) | (uint256(0x01) << 248));
    }

    function test_a_commitment_must_be_48_bytes() public {
        bytes32 checkpointKeccak = keccak256("checkpoint-bytes");
        vm.expectRevert(RootAnchor.EmptyCommitment.selector);
        anchor.postCheckpointBlob("", checkpointKeccak);
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.BadCommitmentLength.selector, uint256(32)));
        anchor.postCheckpointBlob(new bytes(32), checkpointKeccak);
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.BadCommitmentLength.selector, uint256(49)));
        anchor.postCheckpointBlob(new bytes(49), checkpointKeccak);
        vm.expectRevert(abi.encodeWithSelector(RootAnchor.CheckpointBlobMissing.selector, checkpointKeccak));
        anchor.checkpointBlob(checkpointKeccak);
    }
}
