// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CharacterNFT} from "../src/CharacterNFT.sol";
import {CharacterCheckpoint} from "../src/CharacterCheckpoint.sol";
import {CharacterFactory} from "../src/CharacterFactory.sol";
import {RulesetRegistry} from "../src/RulesetRegistry.sol";
import {AhEscrow} from "../src/AhEscrow.sol";
import {PvpBounty} from "../src/PvpBounty.sol";
// KekVault.sol + CharacterCheckpoint.vault stay until a batched redeploy drops custody deposits.
// Play path AH uses AhEscrow (deployed and granted LISTING_ROLE here).
// PvP head-bounties use PvpBounty (OPERATOR_ROLE = LISTING key by default).

/// Deploys the log-model character stack behind UUPS proxies, wires roles, then hands admin to the Safe.
/// The deployer is the temporary admin and renounces at the end (when deployer != admin).
///
/// Role separation (official launch):
///   ADMIN / EMERGENCY / GUARDIAN → Safe multisig (may be the same Safe)
///   LISTING / ROTATOR / PROPOSER → distinct server EOAs
///   FEE_RECIPIENT → distinct treasury (not a server key, not the Safe)
///
/// Items: pass a real access-controlled ERC-1155, or address(0) to leave imports/exports off.
/// Never pass MockItems/MockKEK on chainid != 31337 (guarded).
///
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --sig "run()"
///   env: ADMIN, FEE_RECIPIENT, ROTATOR, GUARDIAN, PROPOSER, LISTING, BASE_URI
///        optional: EMERGENCY (default ADMIN), ITEMS (default 0), KEK (default 0), MINT_FEE
///        optional: TIMELOCK (required on chain 100), ALLOW_EOA_ADMIN=1 (documented one-off only)
///
/// After running, the Safe must still:
///   1. Items.grantRole(MINTER_ROLE, checkpoint) + registerFungible… (if ITEMS != 0; see DeployItems)
///   2. factory.setStartingJob(job, true)            (per starting job)
///   3. proposer: rulesets.propose(hash, delay, uri) (first ruleset; wait out the 48h timelock)
///   4. rotator service: checkpoint.addSigner(sessionKey, expiry)
///   5. If TIMELOCK unset: Safe setUpgradeAuthority(timelock) on NFT/Factory/Checkpoint/Rulesets
///   6. Enable imports/exports only after Items minter + policy: setImportsEnabled / setExportsEnabled
/// Then verify implementations (see script/verify-deploy.sh + docs/gnosis-launch.md).
///
/// UUPS upgrades: production must route through TimelockController via `upgradeAuthority`.

/// @dev Minimal Safe read used only for launch validation (optional threshold check).
interface ISafeThreshold {
    function getThreshold() external view returns (uint256);
}

contract Deploy is Script {
    uint64 constant RULESET_MIN_DELAY = 48 hours;
    uint256 constant ANVIL_CHAIN_ID = 31337;

    error BadConfig(string reason);
    error MockWiredOnNonAnvil(address mock);

    struct Config {
        address admin;
        address emergency;
        address guardian;
        address feeRecipient;
        address rotator;
        address proposer;
        address listing;
        address items;
        address kek;
        address timelock;
        string baseURI;
        uint256 mintFee;
    }

    struct Deployed {
        CharacterNFT nft;
        CharacterCheckpoint checkpoint;
        CharacterFactory factory;
        RulesetRegistry rulesets;
        AhEscrow ahEscrow;
        PvpBounty pvpBounty;
        address nftImpl;
        address checkpointImpl;
        address factoryImpl;
        address rulesetsImpl;
    }

    function run() external virtual returns (Deployed memory d) {
        Config memory c = loadConfig();
        vm.startBroadcast();
        d = deploy(c, msg.sender);
        vm.stopBroadcast();
        _logDeployed(d, c);
    }

    function loadConfig() public view returns (Config memory c) {
        // Prefer ADMIN; MULTISIG is a back-compat alias.
        address admin;
        try vm.envAddress("ADMIN") returns (address a) {
            admin = a;
        } catch {
            admin = vm.envAddress("MULTISIG");
        }
        c = Config({
            admin: admin,
            emergency: vm.envOr("EMERGENCY", admin),
            guardian: vm.envOr("GUARDIAN", admin),
            feeRecipient: vm.envAddress("FEE_RECIPIENT"),
            rotator: vm.envAddress("ROTATOR"),
            proposer: vm.envAddress("PROPOSER"),
            listing: vm.envAddress("LISTING"),
            items: vm.envOr("ITEMS", address(0)),
            kek: vm.envOr("KEK", address(0)),
            timelock: vm.envOr("TIMELOCK", address(0)),
            baseURI: vm.envString("BASE_URI"),
            mintFee: vm.envOr("MINT_FEE", uint256(0.001 ether))
        });
    }

    function _proxy(address impl, bytes memory init) internal returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }

    /// Reject MockItems / MockKEK outside local anvil.
    function rejectMocksOnNonAnvil(address items, address kek) public view {
        if (block.chainid == ANVIL_CHAIN_ID) return;
        if (items != address(0) && _isBellgraveTestMock(items)) revert MockWiredOnNonAnvil(items);
        if (kek != address(0) && _isBellgraveTestMock(kek)) revert MockWiredOnNonAnvil(kek);
    }

    function _isBellgraveTestMock(address target) internal view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("isBellgraveTestMock()"));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    /// Explicit, documented escape hatch for a one-off EOA admin launch (not a Safe).
    /// Requires ALLOW_EOA_ADMIN=1 in the deploy environment. Never use on anvil.
    function allowEoaAdmin() public view returns (bool) {
        if (block.chainid == ANVIL_CHAIN_ID) return false;
        try vm.envUint("ALLOW_EOA_ADMIN") returns (uint256 v) {
            return v != 0;
        } catch {
            return false;
        }
    }

    /// Distinctness rules for official launch. Anvil may reuse addresses for convenience.
    function validateConfig(Config memory c) public view {
        bool eoaAdmin = allowEoaAdmin();
        if (c.admin == address(0)) revert BadConfig("admin=0");
        if (c.emergency == address(0)) revert BadConfig("emergency=0");
        if (c.guardian == address(0)) revert BadConfig("guardian=0");
        if (c.feeRecipient == address(0)) revert BadConfig("feeRecipient=0");
        if (c.listing == address(0)) revert BadConfig("listing=0");
        if (c.rotator == address(0)) revert BadConfig("rotator=0");
        if (c.proposer == address(0)) revert BadConfig("proposer=0");
        if (bytes(c.baseURI).length == 0) revert BadConfig("baseURI empty");

        rejectMocksOnNonAnvil(c.items, c.kek);

        if (block.chainid == ANVIL_CHAIN_ID) return;

        // Server keys must be pairwise distinct and not the Safe / fee recipient.
        if (c.listing == c.rotator || c.listing == c.proposer || c.rotator == c.proposer) {
            revert BadConfig("listing/rotator/proposer must be distinct");
        }
        if (c.listing == c.admin || c.rotator == c.admin || c.proposer == c.admin) {
            revert BadConfig("server keys must not equal admin Safe");
        }
        if (c.listing == c.feeRecipient || c.rotator == c.feeRecipient || c.proposer == c.feeRecipient) {
            revert BadConfig("server keys must not equal feeRecipient");
        }
        if (!eoaAdmin && c.feeRecipient == c.admin) {
            revert BadConfig("feeRecipient must be distinct from admin Safe");
        }
        // emergency/guardian may equal admin (same Safe / EOA). They must not be server keys.
        if (c.emergency == c.listing || c.emergency == c.rotator || c.emergency == c.proposer) {
            revert BadConfig("emergency must not be a server key");
        }
        if (c.guardian == c.listing || c.guardian == c.rotator || c.guardian == c.proposer) {
            revert BadConfig("guardian must not be a server key");
        }

        if (c.timelock != address(0) && c.timelock.code.length == 0) {
            revert BadConfig("timelock must be a contract");
        }
        // Gnosis mainnet: TimelockController is required so upgrades cannot be immediate.
        if (block.chainid == 100) {
            if (c.timelock == address(0)) revert BadConfig("TIMELOCK required on Gnosis (chain 100)");
            if (c.timelock.code.length == 0) revert BadConfig("timelock must be a contract");
        }

        if (eoaAdmin) {
            // EOA admin path: admin/emergency/guardian may be the same treasury EOA.
            // UUPS upgrades still route through TIMELOCK; PROPOSER EOA schedules on the timelock.
            return;
        }

        // Launch roles must be contracts (Safe / Timelock), not bare EOAs.
        if (c.admin.code.length == 0) revert BadConfig("admin must be a contract");
        if (c.emergency.code.length == 0) revert BadConfig("emergency must be a contract");
        if (c.guardian.code.length == 0) revert BadConfig("guardian must be a contract");

        // Optional: if ADMIN looks like a Safe, require threshold >= 2.
        try ISafeThreshold(c.admin).getThreshold() returns (uint256 threshold) {
            if (threshold < 2) revert BadConfig("admin Safe threshold < 2");
        } catch {}
    }

    /// `deployer` is the account executing the calls (temporary admin).
    function deploy(Config memory c, address deployer) public returns (Deployed memory d) {
        validateConfig(c);

        address nftImpl = address(new CharacterNFT());
        address checkpointImpl = address(new CharacterCheckpoint());
        address factoryImpl = address(new CharacterFactory());
        address rulesetsImpl = address(new RulesetRegistry());
        d.nftImpl = nftImpl;
        d.checkpointImpl = checkpointImpl;
        d.factoryImpl = factoryImpl;
        d.rulesetsImpl = rulesetsImpl;

        d.nft = CharacterNFT(
            _proxy(
                nftImpl,
                abi.encodeCall(CharacterNFT.initialize, (deployer, "Black Anvil Character", "BANV", c.baseURI))
            )
        );
        d.checkpoint = CharacterCheckpoint(
            _proxy(
                checkpointImpl,
                abi.encodeCall(CharacterCheckpoint.initialize, (deployer, address(d.nft), c.rotator, c.guardian))
            )
        );
        d.factory = CharacterFactory(
            _proxy(
                factoryImpl,
                abi.encodeCall(CharacterFactory.initialize, (deployer, address(d.nft), address(d.checkpoint), c.mintFee))
            )
        );
        d.rulesets = RulesetRegistry(
            _proxy(rulesetsImpl, abi.encodeCall(RulesetRegistry.initialize, (deployer, RULESET_MIN_DELAY)))
        );
        d.ahEscrow = new AhEscrow(deployer, address(d.nft), payable(c.feeRecipient));
        // LISTING EOA is the PvP operator (claim after verified slay), same as AH listing role.
        d.pvpBounty = new PvpBounty(address(d.nft), deployer, c.listing);

        // wiring
        d.nft.setState(address(d.checkpoint));
        d.nft.grantRole(d.nft.MINTER_ROLE(), address(d.factory));
        d.checkpoint.grantRole(d.checkpoint.FACTORY_ROLE(), address(d.factory));
        d.checkpoint.grantRole(d.checkpoint.NFT_ROLE(), address(d.nft));
        d.checkpoint.setRulesets(address(d.rulesets));
        // address(0) / importsEnabled=false leave importItem off. Never wire mocks off-anvil.
        d.checkpoint.setItems(c.items);
        d.rulesets.grantRole(d.rulesets.PROPOSER_ROLE(), c.proposer);
        d.rulesets.grantRole(d.rulesets.EMERGENCY_ROLE(), c.emergency);
        d.ahEscrow.grantRole(d.ahEscrow.LISTING_ROLE(), c.listing);
        d.ahEscrow.grantRole(d.ahEscrow.GUARDIAN_ROLE(), c.guardian);
        d.pvpBounty.grantRole(d.pvpBounty.GUARDIAN_ROLE(), c.guardian);
        d.factory.grantRole(d.factory.GUARDIAN_ROLE(), c.guardian);

        // Production UUPS: pin upgrades to Timelock before admin handoff.
        if (c.timelock != address(0)) {
            d.nft.setUpgradeAuthority(c.timelock);
            d.checkpoint.setUpgradeAuthority(c.timelock);
            d.factory.setUpgradeAuthority(c.timelock);
            d.rulesets.setUpgradeAuthority(c.timelock);
        }

        // Hand over admin to Safe. If admin == deployer, do NOT renounce
        // (grant+renounce on the same address would leave zero admins).
        bytes32 adminRole = d.nft.DEFAULT_ADMIN_ROLE();
        if (c.admin != deployer) {
            d.nft.grantRole(adminRole, c.admin);
            d.checkpoint.grantRole(adminRole, c.admin);
            d.factory.grantRole(adminRole, c.admin);
            d.rulesets.grantRole(adminRole, c.admin);
            d.ahEscrow.grantRole(d.ahEscrow.DEFAULT_ADMIN_ROLE(), c.admin);
            d.pvpBounty.grantRole(d.pvpBounty.DEFAULT_ADMIN_ROLE(), c.admin);
            // Revoke temporary deployer roles before renouncing admin.
            if (c.listing != deployer) {
                d.ahEscrow.revokeRole(d.ahEscrow.LISTING_ROLE(), deployer);
            }
            if (c.guardian != deployer) {
                d.ahEscrow.revokeRole(d.ahEscrow.GUARDIAN_ROLE(), deployer);
                d.pvpBounty.revokeRole(d.pvpBounty.GUARDIAN_ROLE(), deployer);
                d.factory.revokeRole(d.factory.GUARDIAN_ROLE(), deployer);
            }
            d.ahEscrow.revokeRole(d.ahEscrow.DEFAULT_ADMIN_ROLE(), deployer);
            d.pvpBounty.revokeRole(d.pvpBounty.DEFAULT_ADMIN_ROLE(), deployer);
            d.nft.renounceRole(adminRole, deployer);
            d.checkpoint.renounceRole(adminRole, deployer);
            d.factory.renounceRole(adminRole, deployer);
            d.rulesets.renounceRole(adminRole, deployer);
        } else if (c.listing != deployer) {
            d.ahEscrow.revokeRole(d.ahEscrow.LISTING_ROLE(), deployer);
        }
    }

    function _logDeployed(Deployed memory d, Config memory c) internal view {
        console.log("CharacterNFT        ", address(d.nft));
        console.log("CharacterCheckpoint ", address(d.checkpoint));
        console.log("CharacterFactory    ", address(d.factory));
        console.log("RulesetRegistry     ", address(d.rulesets));
        console.log("AhEscrow            ", address(d.ahEscrow));
        console.log("PvpBounty           ", address(d.pvpBounty));
        console.log("nftImpl             ", d.nftImpl);
        console.log("checkpointImpl      ", d.checkpointImpl);
        console.log("factoryImpl         ", d.factoryImpl);
        console.log("rulesetsImpl        ", d.rulesetsImpl);
        console.log("admin               ", c.admin);
        console.log("feeRecipient        ", c.feeRecipient);
        console.log("listing             ", c.listing);
        console.log("items               ", c.items);
        console.log("mintFee (wei)       ", c.mintFee);
    }
}
