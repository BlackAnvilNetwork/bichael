// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {CharacterCheckpoint} from "../src/CharacterCheckpoint.sol";
import {ItemIds} from "../src/libraries/ItemIds.sol";
import {console} from "forge-std/console.sol";

/// Cross-language golden vectors. `test/golden/verify.mjs` recomputes these with viem and must match byte for byte.
/// The Rust engine must reproduce the same genesis root, item ids and checkpoint body hash.
contract GoldenTest is Base {
    function _fixed() internal pure returns (CharacterCheckpoint.Checkpoint memory c) {
        c.prevRoot = 0x1111111111111111111111111111111111111111111111111111111111111111;
        c.newRoot = 0x2222222222222222222222222222222222222222222222222222222222222222;
        c.fromIndex = 100;
        c.toIndex = 137;
        c.logHash = 0x3333333333333333333333333333333333333333333333333333333333333333;
        c.rulesetHash = 0x4444444444444444444444444444444444444444444444444444444444444444;
        c.summary = 42 | (uint256(3) << 16) | (uint256(1) << 24) | (uint256(123456) << 32) | (uint256(17) << 96);
        c.inboundConsumed = 9;
        c.exports = new CharacterCheckpoint.Export[](2);
        c.exports[0] = CharacterCheckpoint.Export(0xabc, 1);
        c.exports[1] = CharacterCheckpoint.Export(0xdef, 40);
    }

    // Domain-independent values, pinned here and recomputed independently by verify.mjs.
    bytes32 constant GOLDEN_BODY_HASH = 0x0da4d29fd8c0892590468c9b2f8fa5e402388553fa6912e3f72a8cc671ee6d19;
    bytes32 constant GOLDEN_GENESIS_ROOT = 0x0c0d7ba0dd69dcda2fe24de603679f65ae5dbdaec43f4ba9f3dfa8c6b444761c;
    uint256 constant GOLDEN_UNIQUE_ID =
        16326979768789847505458237212507241523594462770995321419559994427250918491098;
    uint256 constant GOLDEN_FUNGIBLE_ID =
        89658009947691115780873220689577698189678099276092329480841579491160997392175;

    function test_golden() public view {
        CharacterCheckpoint.Checkpoint memory c = _fixed();
        bytes32 bodyHash = keccak256(abi.encode(c));
        address who = address(0x000000000000000000000000000000000000dEaD);
        bytes32 digest = _typed(
            keccak256(abi.encode(CHECKPOINT_TYPEHASH, uint256(1), who, uint32(3), uint256(1_900_000_000), bodyHash))
        );
        bytes32 genesis = keccak256(abi.encode(cp.GENESIS_TAG(), uint256(1), uint8(3)));
        uint256 uniqueId = ItemIds.unique("iron_sword", 42);
        uint256 fungibleId = ItemIds.fungible("iron_ore");

        console.log("VERIFYING_CONTRACT", address(cp));
        console.log("CHAIN_ID", block.chainid);
        console.log("GENESIS_TAG");
        console.logBytes32(cp.GENESIS_TAG());
        console.log("BODY_HASH");
        console.logBytes32(bodyHash);
        console.log("DIGEST");
        console.logBytes32(digest);
        console.log("GENESIS_ROOT");
        console.logBytes32(genesis);
        console.log("UNIQUE_ID", uniqueId);
        console.log("FUNGIBLE_ID", fungibleId);

        assertEq(bodyHash, GOLDEN_BODY_HASH, "checkpoint encoding drifted");
        assertEq(genesis, GOLDEN_GENESIS_ROOT, "genesis root drifted");
        assertEq(uniqueId, GOLDEN_UNIQUE_ID, "unique item id drifted");
        assertEq(fungibleId, GOLDEN_FUNGIBLE_ID, "fungible item id drifted");
    }
}
