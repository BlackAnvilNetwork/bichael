// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DevCharacterMint} from "../src/DevCharacterMint.sol";

/// Local anvil only. Mints LOKC to the player who calls createCharacter.
///   anvil
///   forge script script/DevMint.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $ANVIL_KEY
contract DevMint is Script {
    function run() external returns (DevCharacterMint mint) {
        vm.startBroadcast();
        mint = new DevCharacterMint(0.001 ether);
        vm.stopBroadcast();
        console.log("DevCharacterMint", address(mint));
    }
}
