// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PvpBounty} from "../src/PvpBounty.sol";

/// @dev Local anvil: deploy PvpBounty against an existing CharacterNFT (`NFT` env).
/// Deployer is admin + OPERATOR_ROLE.
///
///   NFT=0x… forge script script/DeployPvpBountyAnvil.s.sol:DeployPvpBountyAnvil \
///     --rpc-url http://127.0.0.1:8545 --private-key $ANVIL_K0 --broadcast
contract DeployPvpBountyAnvil is Script {
    function run() external {
        address nft = vm.envAddress("NFT");
        address deployer = msg.sender;
        vm.startBroadcast();
        PvpBounty bounty = new PvpBounty(nft, deployer, deployer);
        vm.stopBroadcast();
        console.log("PVP_BOUNTY", address(bounty));
        console.log("NFT", nft);
        console.log("OPERATOR", deployer);
    }
}
