// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {GuildVault} from "./GuildVault.sol";

/// @dev Minimal NFT ownership read used at fill time (CharacterNFT).
interface ICharacterOwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title AhEscrow
/// @notice First-party auction-house payment escrow. Buyers pay **native ETH**
///         (EOA, Safe, or EEZ `CrossChainProxy` with `msg.value`). At fill, ETH
///         goes to `ownerOf(sellerTokenId)` (never a client-supplied address),
///         minus a 1% marketplace fee. On each fill, the floored `VAULT_FEE_BPS`
///         (50) of the sale is sent to the guild vault and the floored
///         `TREASURY_FEE_BPS` (50) is sent to `feeRecipient`. The player-facing
///         fee stays 1%. There is no second fee and no new token. A one-wei
///         remainder of the two floors may stay in this contract and is not a
///         third payout. `SHARE_DELAY` is the ruleset timelock floor (one day,
///         `RulesetRegistry.MIN_DELAY`). It gates a change to the two share
///         parameters. It does not delay the fee on a fill, and it does not
///         release wei that a fill already paid. This contract does not hold a long-lived
///         player balance, and the character log never credits settlement ETH.
///         Upstream EEZ `periphery/Bridge.sol` is test-only; do not treat it as
///         this contract.
///
///         Flow: LISTING_ROLE opens an ask that mirrors a log listing id → buyer
///         calls `buyAsk{value}` → fee split + seller paid → `AskFilled` is emitted →
///         the game server appends a log `chainFill` (items only).
///
///         Listing ids are single-use: once opened, filled, or cancelled they
///         cannot be reopened (`used` flag). Buyers cannot name the seller's
///         character token as the recipient. Owner change cancels open listings
///         off-chain (app watcher); fill still pays whoever owns the NFT then.
///         Direct buys (`buyAsk`) require `msg.sender == ownerOf(buyerTokenId)`.
///         Relayed / EEZ buys use `buyAskFor` with an EIP-712 signature from that owner
///         authorizing this caller as the relayer.
///         GUARDIAN_ROLE can pause openAsk/buyAsk/buyAskFor; DEFAULT_ADMIN_ROLE unpauses.
///         Not upgradeable — a behavior change is a new deployment.
contract AhEscrow is Pausable, EIP712 {
    bytes32 public constant LISTING_ROLE = keccak256("LISTING_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    /// @notice EIP-712 payload authorizing `relayer` to fill `listingId` into `buyerTokenId` until `deadline`.
    bytes32 public constant BUY_ASK_FOR_TYPEHASH =
        keccak256("BuyAskFor(uint256 listingId,uint256 buyerTokenId,address relayer,uint256 deadline)");

    /// @notice 1% of sale price (fee = price * FEE_BPS / BPS_DENOM, floor).
    uint256 public constant FEE_BPS = 100;
    uint256 public constant BPS_DENOM = 10_000;
    /// @notice Starting guild-vault share of the sale, in bps. Half of `FEE_BPS`.
    ///         An immediate setter cannot change it. A queued change waits out
    ///         `SHARE_DELAY` and applies only to a later fill.
    uint256 public constant VAULT_FEE_BPS = 50;

    /// @notice Starting treasury share of the sale, in bps. Half of `FEE_BPS`.
    uint256 public constant TREASURY_FEE_BPS = 50;
    /// @notice Ruleset timelock floor (`RulesetRegistry.MIN_DELAY`, one day). Solidity cannot
    ///         copy another contract's constant into this one, so the test locks them together.
    ///         There is no setter for this delay.
    uint64 public constant SHARE_DELAY = 1 days;

    struct Ask {
        uint256 sellerTokenId;
        uint256 itemId;
        uint256 amount;
        uint256 priceWei;
        bool open;
        bool used;
    }

    struct PendingFeeShares {
        uint256 vaultBps;
        uint256 treasuryBps;
        uint64 readyAt;
    }

    ICharacterOwnerOf public immutable characterNft;
    /// @notice Treasury. Receives `treasuryBps` of the sale. Rotating the address does not change the share.
    address payable public feeRecipient;
    /// @notice Guild pool. Receives `vaultBps` of the sale and does not pay guilds in this slice.
    address payable public immutable guildVault;
    /// @notice Live vault share of the sale, in bps. Starts at 50. Changes only via `executeFeeShares`.
    uint256 public vaultBps;
    /// @notice Live treasury share of the sale, in bps. Starts at 50. `vaultBps + treasuryBps == FEE_BPS`.
    uint256 public treasuryBps;
    PendingFeeShares public pendingFeeShares;

    mapping(uint256 listingId => Ask) public asks;
    mapping(bytes32 role => mapping(address account => bool)) private _roles;
    uint256 private _locked = 1;

    event AskOpened(
        uint256 indexed listingId,
        uint256 indexed sellerTokenId,
        uint256 itemId,
        uint256 amount,
        uint256 priceWei
    );
    event AskFilled(
        uint256 indexed listingId,
        address indexed buyer,
        uint256 indexed buyerTokenId,
        address sellerPayout,
        uint256 priceWei,
        uint256 feeWei,
        uint256 itemId,
        uint256 amount
    );
    event AskCancelled(uint256 indexed listingId);
    event FeeRecipientSet(address indexed feeRecipient);
    event FeeSharesProposed(uint256 vaultBps, uint256 treasuryBps, uint64 readyAt);
    event FeeSharesSet(uint256 vaultBps, uint256 treasuryBps);
    event FeeSharesCancelled(uint256 vaultBps, uint256 treasuryBps);
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    error BadAmount();
    error BadAddress();
    error BadId();
    error AskExists();
    error AskClosed();
    error WrongPrice();
    error TransferFailed();
    error Unauthorized();
    error Reentrant();
    error NotOwner();
    error BadSignature();
    error Expired();
    error BadShares();
    error TooEarly();
    error NoPendingShares();

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @param admin Temporary admin (Deploy hands over to multisig). Also receives GUARDIAN_ROLE.
    /// @param nft_ Character NFT whose `ownerOf` receives sale proceeds at fill.
    /// @param feeRecipient_ Treasury for the treasury share of the 1% fee.
    constructor(address admin, address nft_, address payable feeRecipient_) EIP712("AhEscrow", "1") {
        if (admin == address(0) || nft_ == address(0) || feeRecipient_ == address(0)) revert BadAddress();
        characterNft = ICharacterOwnerOf(nft_);
        feeRecipient = feeRecipient_;
        guildVault = payable(address(new GuildVault(address(this))));
        vaultBps = VAULT_FEE_BPS;
        treasuryBps = TREASURY_FEE_BPS;
        _grant(DEFAULT_ADMIN_ROLE, admin);
        _grant(LISTING_ROLE, admin);
        _grant(GUARDIAN_ROLE, admin);
        emit FeeRecipientSet(feeRecipient_);
        emit FeeSharesSet(vaultBps, treasuryBps);
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grant(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    /// @notice Multisig/admin may rotate the treasury address. This does not change either share.
    function setFeeRecipient(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert BadAddress();
        feeRecipient = to;
        emit FeeRecipientSet(to);
    }

    /// @notice Schedule a new vault/treasury split. Live shares stay put until `executeFeeShares`
    ///         after `SHARE_DELAY`. The two shares must still sum to `FEE_BPS` (the player fee stays 1%).
    ///         There is no setter that applies a split in the same transaction.
    function proposeFeeShares(uint256 nextVaultBps, uint256 nextTreasuryBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (nextVaultBps > FEE_BPS || nextTreasuryBps > FEE_BPS || nextVaultBps + nextTreasuryBps != FEE_BPS) {
            revert BadShares();
        }
        uint64 readyAt = uint64(block.timestamp) + SHARE_DELAY;
        pendingFeeShares = PendingFeeShares({vaultBps: nextVaultBps, treasuryBps: nextTreasuryBps, readyAt: readyAt});
        emit FeeSharesProposed(nextVaultBps, nextTreasuryBps, readyAt);
    }

    /// @notice Apply a split that has waited out the ruleset timelock floor. Admin (the Safe) executes.
    function executeFeeShares() external onlyRole(DEFAULT_ADMIN_ROLE) {
        PendingFeeShares memory pending = pendingFeeShares;
        if (pending.readyAt == 0) revert NoPendingShares();
        if (block.timestamp < pending.readyAt) revert TooEarly();
        vaultBps = pending.vaultBps;
        treasuryBps = pending.treasuryBps;
        delete pendingFeeShares;
        emit FeeSharesSet(pending.vaultBps, pending.treasuryBps);
    }

    /// @notice Drop a scheduled split. Live shares are unchanged.
    function cancelFeeShares() external onlyRole(DEFAULT_ADMIN_ROLE) {
        PendingFeeShares memory pending = pendingFeeShares;
        if (pending.readyAt == 0) revert NoPendingShares();
        delete pendingFeeShares;
        emit FeeSharesCancelled(pending.vaultBps, pending.treasuryBps);
    }

    /// @notice Guardian pause: blocks openAsk / buyAsk. Cancel remains available.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Safe/admin only may resume trading.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Floor split: `fee = price * 100 / 10000`, `sellerNet = price - fee`.
    function quoteFee(uint256 priceWei) public pure returns (uint256 feeWei, uint256 sellerNetWei) {
        feeWei = (priceWei * FEE_BPS) / BPS_DENOM;
        sellerNetWei = priceWei - feeWei;
    }

    /// @notice Floor each share the same way `quoteFee` floors (`price * bps / BPS_DENOM`).
    ///         A zero fee is a zero vault share and a zero treasury share.
    ///         The two floors sum to the 1% fee, or to one wei less. That wei stays
    ///         in this contract and is not a third payout.
    function quoteFeeShares(uint256 priceWei) public view returns (uint256 vaultWei, uint256 treasuryWei) {
        vaultWei = (priceWei * vaultBps) / BPS_DENOM;
        treasuryWei = (priceWei * treasuryBps) / BPS_DENOM;
    }

    function _grant(bytes32 role, address account) private {
        if (account == address(0)) revert BadAddress();
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    /// @notice Register an ask the log already escrowed. `listingId` must match the engine ask id.
    ///         Ids are single-use: a filled or cancelled id cannot be reopened.
    ///         Seller payout is **not** stored — `buyAsk` pays `ownerOf(sellerTokenId)`.
    function openAsk(
        uint256 listingId,
        uint256 sellerTokenId,
        uint256 itemId,
        uint256 amount,
        uint256 priceWei
    ) external onlyRole(LISTING_ROLE) whenNotPaused {
        if (listingId == 0 || itemId == 0 || sellerTokenId == 0) revert BadId();
        if (amount == 0 || priceWei == 0) revert BadAmount();
        Ask storage ask = asks[listingId];
        if (ask.open || ask.used) revert AskExists();

        asks[listingId] = Ask({
            sellerTokenId: sellerTokenId,
            itemId: itemId,
            amount: amount,
            priceWei: priceWei,
            open: true,
            used: true
        });
        emit AskOpened(listingId, sellerTokenId, itemId, amount, priceWei);
    }

    /// @notice Pull an unsold ask (log cancel/reclaim should run after this succeeds).
    function cancelAsk(uint256 listingId) external onlyRole(LISTING_ROLE) {
        _cancelAsk(listingId);
    }

    /// @notice Batch cancel for pause/incident response. Same per-id rules as `cancelAsk`.
    function cancelAsks(uint256[] calldata listingIds) external onlyRole(LISTING_ROLE) {
        uint256 n = listingIds.length;
        for (uint256 i; i < n; ++i) {
            _cancelAsk(listingIds[i]);
        }
    }

    function _cancelAsk(uint256 listingId) private {
        Ask storage ask = asks[listingId];
        if (!ask.open) revert AskClosed();
        ask.open = false;
        emit AskCancelled(listingId);
    }

    /// @notice Pay the ask in native ETH. Excess `msg.value` is refunded to `msg.sender`.
    ///         Does not credit the log.
    /// @param listingId Engine ask id already opened on-chain.
    /// @param buyerTokenId Character that will receive the stack on the log after `AskFilled`.
    ///        Caller must own this token (`ownerOf(buyerTokenId) == msg.sender`).
    function buyAsk(uint256 listingId, uint256 buyerTokenId) external payable nonReentrant whenNotPaused {
        if (buyerTokenId == 0) revert BadId();
        // L-4: buyerTokenId must exist (ownerOf reverts for unminted ids).
        if (characterNft.ownerOf(buyerTokenId) != msg.sender) revert NotOwner();
        _fill(listingId, buyerTokenId);
    }

    /// @notice Relayed fill. `ownerSignature` is an EIP-712 `BuyAskFor` from `ownerOf(buyerTokenId)`
    ///         naming `msg.sender` as the relayer (EEZ proxy / MockEezSyncBuy). Excess refunds to the relayer.
    function buyAskFor(uint256 listingId, uint256 buyerTokenId, uint256 deadline, bytes calldata ownerSignature)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (buyerTokenId == 0) revert BadId();
        if (block.timestamp > deadline) revert Expired();
        address owner = characterNft.ownerOf(buyerTokenId);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(BUY_ASK_FOR_TYPEHASH, listingId, buyerTokenId, msg.sender, deadline))
        );
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, ownerSignature);
        if (err != ECDSA.RecoverError.NoError || signer != owner) revert BadSignature();
        _fill(listingId, buyerTokenId);
    }

    function _fill(uint256 listingId, uint256 buyerTokenId) private {
        Ask storage ask = asks[listingId];
        if (!ask.open) revert AskClosed();
        if (buyerTokenId == ask.sellerTokenId) revert BadId();
        if (msg.value < ask.priceWei) revert WrongPrice();

        uint256 price = ask.priceWei;
        uint256 itemId = ask.itemId;
        uint256 amount = ask.amount;
        uint256 sellerTokenId = ask.sellerTokenId;
        ask.open = false;

        address owner = characterNft.ownerOf(sellerTokenId);
        if (owner == address(0)) revert BadAddress();
        uint256 feeWei = _payFeeAndSeller(price, payable(owner));

        uint256 excess = msg.value - price;
        if (excess > 0) {
            (bool refunded,) = payable(msg.sender).call{value: excess}("");
            if (!refunded) revert TransferFailed();
        }

        emit AskFilled(listingId, msg.sender, buyerTokenId, owner, price, feeWei, itemId, amount);
    }

    /// @dev Pays the floored vault share and the floored treasury share, then the seller.
    ///      A one-wei remainder of the two floors stays in this contract.
    ///      Isolated so `_fill` stays under the stack limit.
    function _payFeeAndSeller(uint256 price, address payable payout) private returns (uint256 feeWei) {
        uint256 sellerNet;
        (feeWei, sellerNet) = quoteFee(price);
        (uint256 vaultWei, uint256 treasuryWei) = quoteFeeShares(price);

        if (vaultWei > 0) {
            (bool vaultPaid,) = guildVault.call{value: vaultWei}("");
            if (!vaultPaid) revert TransferFailed();
        }
        if (treasuryWei > 0) {
            (bool feePaid,) = feeRecipient.call{value: treasuryWei}("");
            if (!feePaid) revert TransferFailed();
        }
        (bool paid,) = payout.call{value: sellerNet}("");
        if (!paid) revert TransferFailed();
    }

    /// @dev Naked ETH is rejected; payment must go through `buyAsk`.
    receive() external payable {
        revert BadAmount();
    }
}
