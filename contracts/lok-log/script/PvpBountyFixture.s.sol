// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PvpBounty} from "../src/PvpBounty.sol";
import {MockOwnerNft} from "../test/mocks/MockOwnerNft.sol";

/// @dev Throwaway-anvil helper: deploy PvpBounty + MockOwnerNft with deployer as admin/operator.
contract PvpBountyFixture is Script {
    function run() external {
        vm.startBroadcast();
        MockOwnerNft nft = new MockOwnerNft();
        PvpBounty bounty = new PvpBounty(address(nft), msg.sender, msg.sender);
        vm.stopBroadcast();
        console.log("PVP_BOUNTY", address(bounty));
        console.log("NFT", address(nft));
        console.log("OPERATOR", msg.sender);
    }
}
