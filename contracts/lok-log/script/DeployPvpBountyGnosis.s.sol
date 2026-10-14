// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PvpBounty} from "../src/PvpBounty.sol";

/// @dev Additive Gnosis / Chiado deploy: PvpBounty against an existing CharacterNFT.
/// Admin = Safe/EOA admin; OPERATOR = LISTING (server claim/cancel).
/// Fixed bounty is **1 xDAI** (`BOUNTY_WEI = 1 ether` wei).
///
/// Defaults match `deployments/gnosis.json` (2026-10-13 official stack).
///
///   NFT=0x… ADMIN=0x… LISTING=0x… \
///     forge script script/DeployPvpBountyGnosis.s.sol:DeployPvpBountyGnosis \
///     --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast
contract DeployPvpBountyGnosis is Script {
    address constant GNOSIS_NFT = 0x48aFeC17A56c5Bd32ABDbcAD57f16d3859b1289F;
    address constant GNOSIS_ADMIN = 0x08cDab8b049D2A42125C3A2bf1bF1E2f619C4e01;
    address constant GNOSIS_LISTING = 0xbFa29a6EE3d1188aa0A9e0c783E5Da620b859E76;

    function run() external {
        uint256 chainId = block.chainid;
        require(chainId == 100 || chainId == 10200, "DeployPvpBountyGnosis: gnosis/chiado only");

        address nft = vm.envOr("NFT", GNOSIS_NFT);
        address admin = vm.envOr("ADMIN", GNOSIS_ADMIN);
        address operator = vm.envOr("LISTING", GNOSIS_LISTING);
        require(nft != address(0) && admin != address(0) && operator != address(0), "bad addresses");

        vm.startBroadcast();
        PvpBounty bounty = new PvpBounty(nft, admin, operator);
        vm.stopBroadcast();

        console.log("PVP_BOUNTY", address(bounty));
        console.log("NFT", nft);
        console.log("ADMIN", admin);
        console.log("OPERATOR", operator);
        console.log("BOUNTY_WEI", bounty.BOUNTY_WEI());
    }
}
