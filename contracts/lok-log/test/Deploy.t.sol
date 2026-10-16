// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockKEK, MockItems} from "./mocks/Mocks.sol";

/// Minimal contract so non-anvil validateConfig accepts ADMIN/EMERGENCY/GUARDIAN.
contract DummySafe {
    uint256 public threshold = 2;

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function setThreshold(uint256 t) external {
        threshold = t;
    }
}

contract DeployTest is Test {
    function _anvilConfig() internal returns (Deploy.Config memory c) {
        address admin = makeAddr("admin");
        c = Deploy.Config({
            admin: admin,
            emergency: admin,
            guardian: admin,
            feeRecipient: makeAddr("fee"),
            rotator: makeAddr("rotator"),
            proposer: makeAddr("proposer"),
            listing: makeAddr("listing"),
            items: address(new MockItems()),
            kek: address(new MockKEK()),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 0.001 ether
        });
    }

    function test_deployScript_wiresAndHandsOver() public {
        address admin = makeAddr("admin");
        address feeRecipient = makeAddr("fee");
        address proposer = makeAddr("proposer");
        address rotator = makeAddr("rotator");
        address listing = makeAddr("listing");
        MockItems items = new MockItems();
        Deploy s = new Deploy();
        Deploy.Config memory c = Deploy.Config({
            admin: admin,
            emergency: admin,
            guardian: admin,
            feeRecipient: feeRecipient,
            rotator: rotator,
            proposer: proposer,
            listing: listing,
            items: address(items),
            kek: address(new MockKEK()),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 0.001 ether
        });
        Deploy.Deployed memory d = s.deploy(c, address(s));

        bytes32 adminRole = d.checkpoint.DEFAULT_ADMIN_ROLE();
        assertTrue(d.checkpoint.hasRole(adminRole, admin));
        assertTrue(d.nft.hasRole(adminRole, admin));
        assertTrue(d.factory.hasRole(adminRole, admin));
        assertTrue(d.rulesets.hasRole(adminRole, admin));
        assertTrue(d.ahEscrow.hasRole(d.ahEscrow.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(d.checkpoint.hasRole(adminRole, address(s)));
        assertFalse(d.nft.hasRole(adminRole, address(s)));
        assertFalse(d.factory.hasRole(adminRole, address(s)));
        assertFalse(d.rulesets.hasRole(adminRole, address(s)));
        assertFalse(d.ahEscrow.hasRole(d.ahEscrow.DEFAULT_ADMIN_ROLE(), address(s)));
        assertFalse(d.ahEscrow.hasRole(d.ahEscrow.LISTING_ROLE(), address(s)));

        assertTrue(d.nft.hasRole(d.nft.MINTER_ROLE(), address(d.factory)));
        assertTrue(d.checkpoint.hasRole(d.checkpoint.FACTORY_ROLE(), address(d.factory)));
        assertTrue(d.checkpoint.hasRole(d.checkpoint.NFT_ROLE(), address(d.nft)));
        assertEq(address(d.checkpoint.rulesets()), address(d.rulesets));
        assertEq(address(d.checkpoint.items()), address(items));
        assertFalse(d.checkpoint.importsEnabled());
        assertFalse(d.checkpoint.exportsEnabled());
        assertTrue(d.ahEscrow.hasRole(d.ahEscrow.LISTING_ROLE(), listing));
        assertTrue(d.ahEscrow.hasRole(d.ahEscrow.GUARDIAN_ROLE(), admin));
        assertTrue(d.factory.hasRole(d.factory.GUARDIAN_ROLE(), admin));
        assertEq(address(d.ahEscrow.characterNft()), address(d.nft));
        assertEq(d.ahEscrow.feeRecipient(), feeRecipient);
        assertEq(d.ahEscrow.FEE_BPS(), 100);
        assertEq(d.ahEscrow.VAULT_FEE_BPS(), 50);
        assertEq(d.ahEscrow.TREASURY_FEE_BPS(), 50);
        assertEq(d.ahEscrow.vaultBps(), 50);
        assertEq(d.ahEscrow.treasuryBps(), 50);
        assertEq(d.ahEscrow.SHARE_DELAY(), 1 days);
        assertEq(d.ahEscrow.guildVault().balance, 0);
        assertTrue(d.rulesets.hasRole(d.rulesets.PROPOSER_ROLE(), proposer));
        assertTrue(d.rulesets.hasRole(d.rulesets.EMERGENCY_ROLE(), admin));
        assertEq(d.rulesets.minDelay(), 48 hours);
        assertEq(d.factory.mintFee(), 0.001 ether);
        assertEq(d.nft.name(), "Black Anvil Character");
        assertEq(d.nft.symbol(), "BANV");
        assertTrue(d.nftImpl != address(0));
        assertTrue(address(d.ahEscrow) != address(0));

        assertFalse(items.minters(address(d.checkpoint)));

        vm.prank(admin);
        d.factory.setStartingJob(1, true);
        address p = makeAddr("p");
        vm.deal(p, 1 ether);
        uint256 expected = d.nft.nextTokenId() + 1;
        vm.prank(p);
        uint256 id = d.factory.createCharacterFor{value: 0.001 ether}(1, expected);
        assertEq(d.nft.ownerOf(id), p);
        assertEq(d.checkpoint.level(id), 1);
    }

    function test_deployScript_itemsZeroLeavesImportsOff() public {
        Deploy s = new Deploy();
        address admin = makeAddr("admin");
        Deploy.Config memory c = Deploy.Config({
            admin: admin,
            emergency: admin,
            guardian: admin,
            feeRecipient: makeAddr("fee"),
            rotator: makeAddr("rotator"),
            proposer: makeAddr("proposer"),
            listing: makeAddr("listing"),
            items: address(0),
            kek: address(0),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 1 ether
        });
        Deploy.Deployed memory d = s.deploy(c, address(s));
        assertEq(address(d.checkpoint.items()), address(0));
        assertFalse(d.checkpoint.importsEnabled());
    }

    function test_deployScript_sameAdminAsDeployerKeepsAdmin_onAnvil() public {
        Deploy s = new Deploy();
        address deployer = address(s);
        // Anvil allows overlapping roles for local convenience.
        Deploy.Config memory c = Deploy.Config({
            admin: deployer,
            emergency: deployer,
            guardian: deployer,
            feeRecipient: deployer,
            rotator: deployer,
            proposer: deployer,
            listing: deployer,
            items: address(new MockItems()),
            kek: address(new MockKEK()),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 1 ether
        });
        Deploy.Deployed memory d = s.deploy(c, deployer);
        bytes32 adminRole = d.nft.DEFAULT_ADMIN_ROLE();
        assertTrue(d.nft.hasRole(adminRole, deployer));
        assertTrue(d.ahEscrow.hasRole(d.ahEscrow.LISTING_ROLE(), deployer));
    }

    function test_deployScript_setsUpgradeAuthority_whenTimelockProvided() public {
        Deploy s = new Deploy();
        address timelock = address(new DummySafe());
        Deploy.Config memory c = _anvilConfig();
        c.timelock = timelock;
        Deploy.Deployed memory d = s.deploy(c, address(s));
        assertEq(d.nft.upgradeAuthority(), timelock);
        assertEq(d.factory.upgradeAuthority(), timelock);
        assertEq(d.checkpoint.upgradeAuthority(), timelock);
        assertEq(d.rulesets.upgradeAuthority(), timelock);
    }

    function test_rejectMocksOnNonAnvil() public {
        Deploy s = new Deploy();
        MockItems items = new MockItems();
        MockKEK kek = new MockKEK();
        s.rejectMocksOnNonAnvil(address(items), address(kek));

        vm.chainId(100);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MockWiredOnNonAnvil.selector, address(items)));
        s.rejectMocksOnNonAnvil(address(items), address(0));

        vm.expectRevert(abi.encodeWithSelector(Deploy.MockWiredOnNonAnvil.selector, address(kek)));
        s.rejectMocksOnNonAnvil(address(0), address(kek));

        s.rejectMocksOnNonAnvil(address(0), address(0));
    }

    function test_validateConfig_requiresDistinctServerKeys_onMainnet() public {
        Deploy s = new Deploy();
        address admin = makeAddr("admin");
        address rotator = makeAddr("rotator");
        Deploy.Config memory c = Deploy.Config({
            admin: admin,
            emergency: admin,
            guardian: admin,
            feeRecipient: makeAddr("fee"),
            rotator: rotator,
            proposer: makeAddr("proposer"),
            listing: rotator,
            items: address(0),
            kek: address(0),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 1 ether
        });
        vm.chainId(100);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadConfig.selector, "listing/rotator/proposer must be distinct"));
        s.validateConfig(c);
    }

    function test_validateConfig_feeRecipientDistinctFromAdmin_onMainnet() public {
        vm.setEnv("ALLOW_EOA_ADMIN", "0");
        Deploy s = new Deploy();
        address admin = makeAddr("admin");
        Deploy.Config memory c = Deploy.Config({
            admin: admin,
            emergency: admin,
            guardian: admin,
            feeRecipient: admin,
            rotator: makeAddr("rotator"),
            proposer: makeAddr("proposer"),
            listing: makeAddr("listing"),
            items: address(0),
            kek: address(0),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 1 ether
        });
        vm.chainId(100);
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.BadConfig.selector, "feeRecipient must be distinct from admin Safe")
        );
        s.validateConfig(c);
    }

    function test_validateConfig_allowEoaAdmin_whenFlagSet() public {
        Deploy s = new Deploy();
        address admin = makeAddr("eoaTreasury");
        Deploy.Config memory c = Deploy.Config({
            admin: admin,
            emergency: admin,
            guardian: admin,
            feeRecipient: makeAddr("fee"),
            rotator: makeAddr("rotator"),
            proposer: makeAddr("proposer"),
            listing: makeAddr("listing"),
            items: address(0),
            kek: address(0),
            timelock: address(new DummySafe()),
            baseURI: "ipfs://x/",
            mintFee: 1 ether
        });
        vm.chainId(100);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadConfig.selector, "admin must be a contract"));
        s.validateConfig(c);

        vm.setEnv("ALLOW_EOA_ADMIN", "1");
        c.feeRecipient = admin;
        s.validateConfig(c);
        vm.setEnv("ALLOW_EOA_ADMIN", "0");
    }

    function test_validateConfig_requiresContractRoles_onMainnet() public {
        vm.setEnv("ALLOW_EOA_ADMIN", "0");
        Deploy s = new Deploy();
        address eoa = makeAddr("eoaAdmin");
        Deploy.Config memory c = Deploy.Config({
            admin: eoa,
            emergency: eoa,
            guardian: eoa,
            feeRecipient: makeAddr("fee"),
            rotator: makeAddr("rotator"),
            proposer: makeAddr("proposer"),
            listing: makeAddr("listing"),
            items: address(0),
            kek: address(0),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 1 ether
        });
        vm.chainId(100);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadConfig.selector, "TIMELOCK required on Gnosis (chain 100)"));
        s.validateConfig(c);

        DummySafe safe = new DummySafe();
        DummySafe timelock = new DummySafe();
        c.admin = address(safe);
        c.emergency = address(safe);
        c.guardian = address(safe);
        c.timelock = address(timelock);
        s.validateConfig(c);

        safe.setThreshold(1);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadConfig.selector, "admin Safe threshold < 2"));
        s.validateConfig(c);

        safe.setThreshold(2);
        c.timelock = address(0);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BadConfig.selector, "TIMELOCK required on Gnosis (chain 100)"));
        s.validateConfig(c);
    }

    function test_deployOnMainnetChainId_rejectsMockItems() public {
        Deploy s = new Deploy();
        DummySafe safe = new DummySafe();
        address admin = address(safe);
        address mockItems = address(new MockItems());
        Deploy.Config memory c = Deploy.Config({
            admin: admin,
            emergency: admin,
            guardian: admin,
            feeRecipient: makeAddr("fee"),
            rotator: makeAddr("rotator"),
            proposer: makeAddr("proposer"),
            listing: makeAddr("listing"),
            items: mockItems,
            kek: address(0),
            timelock: address(0),
            baseURI: "ipfs://x/",
            mintFee: 1 ether
        });
        vm.chainId(100);
        vm.expectRevert(abi.encodeWithSelector(Deploy.MockWiredOnNonAnvil.selector, mockItems));
        s.deploy(c, address(s));
    }
}
