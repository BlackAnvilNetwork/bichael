// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title KekVault
/// @notice Custody for KEK that backs the in-game KEK counter. The engine tracks each character's internal balance in
///         the state tree; this vault holds the real tokens. Solvency invariant, checkable by anyone:
///             vault KEK balance >= sum of all in-game KEK counters
///         Deposits are pulled from the player and enter the log as an inbound event. Withdrawals are decreases the
///         verifier attested in a checkpoint. Because a withdrawal moves real tokens (a compromised signer would be
///         theft, not just inflation), they are delayed and freezable:
///           - queueWithdrawal refuses to queue more than this token deposited, minus withdrawals already reserved
///             (pending or claimed). Another character's KEK in the same vault cannot be queued.
///           - queueWithdrawal also refuses to queue more than the vault holds
///           - claims wait `withdrawDelay`, during which the guardian can cancel
///           - cancelled funds stay in the vault and release that token's reservation; admin can restore a false positive
contract KekVault is Initializable, AccessControlUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");     // CharacterCheckpoint
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE"); // pause + cancel

    uint64 public constant MIN_WITHDRAW_DELAY = 1 hours;
    uint64 public constant MAX_WITHDRAW_DELAY = 30 days;

    // NOTE: append-only.
    enum Status {
        None,
        Pending,
        Claimed,
        Cancelled
    }

    struct Withdrawal {
        address to;
        uint64 availableAt;
        Status status;
        uint256 amount;
    }

    IERC20 public kek;
    uint64 public withdrawDelay;
    uint256 public nextWithdrawalId;
    uint256 public pendingTotal; // sum of Pending withdrawals
    mapping(uint256 => Withdrawal) public withdrawals;
    /// KEK deposited for a character. Append-only storage.
    mapping(uint256 => uint256) public depositedOf;
    /// Pending plus claimed withdrawals for a character. Cancelled withdrawals are not reserved.
    mapping(uint256 => uint256) public reservedOf;
    /// Character a withdrawal id was queued for. Needed so cancel and restore adjust the right cap.
    mapping(uint256 => uint256) public withdrawalToken;

    event Deposited(uint256 indexed tokenId, address indexed from, uint256 amount);
    event WithdrawalQueued(uint256 indexed id, uint256 indexed tokenId, address indexed to, uint256 amount, uint64 availableAt);
    event WithdrawalClaimed(uint256 indexed id, address indexed to, uint256 amount);
    event WithdrawalCancelled(uint256 indexed id);
    event WithdrawalRestored(uint256 indexed id, uint64 availableAt);
    event WithdrawDelaySet(uint64 delay);
    event KekReassigned(uint256 indexed fromToken, uint256 indexed toToken, uint256 amount);
    event KekSunk(uint256 indexed tokenId, uint256 amount);

    error BadAmount();
    error BadDelay();
    error TransferMismatch();
    error InsufficientVault();
    error ExceedsTokenDeposits();
    error NotPending();
    error NotCancelled();
    error NotYet();

    /// Spent KEK is sent here. It is not a withdrawal and not a player.
    address public constant KEK_BURN = 0x000000000000000000000000000000000000dEaD;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address kek_, address guardian, uint64 withdrawDelay_) external initializer {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        if (withdrawDelay_ < MIN_WITHDRAW_DELAY || withdrawDelay_ > MAX_WITHDRAW_DELAY) revert BadDelay();
        _grantRole(DEFAULT_ADMIN_ROLE, admin); // multisig
        _grantRole(GUARDIAN_ROLE, guardian);
        kek = IERC20(kek_);
        withdrawDelay = withdrawDelay_;
        emit WithdrawDelaySet(withdrawDelay_);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function setWithdrawDelay(uint64 d) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (d < MIN_WITHDRAW_DELAY || d > MAX_WITHDRAW_DELAY) revert BadDelay();
        withdrawDelay = d;
        emit WithdrawDelaySet(d);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------- bridge
    function deposit(address from, uint256 tokenId, uint256 amount)
        external
        onlyRole(BRIDGE_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert BadAmount();
        uint256 before = kek.balanceOf(address(this));
        kek.safeTransferFrom(from, address(this), amount);
        // fee-on-transfer / rebasing tokens would desync the in-game counter from custody
        if (kek.balanceOf(address(this)) - before != amount) revert TransferMismatch();
        depositedOf[tokenId] += amount;
        emit Deposited(tokenId, from, amount);
    }

    function queueWithdrawal(address to, uint256 tokenId, uint256 amount)
        external
        onlyRole(BRIDGE_ROLE)
        whenNotPaused
        returns (uint256 id)
    {
        if (amount == 0 || to == address(0)) revert BadAmount();
        if (pendingTotal + amount > kek.balanceOf(address(this))) revert InsufficientVault();
        // A signer cannot queue another character's KEK, even when the vault still holds it.
        if (reservedOf[tokenId] + amount > depositedOf[tokenId]) revert ExceedsTokenDeposits();
        uint64 at = uint64(block.timestamp) + withdrawDelay;
        unchecked {
            id = ++nextWithdrawalId;
        }
        withdrawals[id] = Withdrawal(to, at, Status.Pending, amount);
        withdrawalToken[id] = tokenId;
        reservedOf[tokenId] += amount;
        pendingTotal += amount;
        emit WithdrawalQueued(id, tokenId, to, amount, at);
    }

    /// Move free deposit credit to the character who received the KEK in game.
    /// Credit that is already reserved or claimed cannot move, so one deposit cannot be withdrawn twice.
    function reassign(uint256 fromToken, uint256 toToken, uint256 amount)
        external
        onlyRole(BRIDGE_ROLE)
        whenNotPaused
    {
        if (amount == 0 || fromToken == toToken) revert BadAmount();
        uint256 free = depositedOf[fromToken] - reservedOf[fromToken];
        if (amount > free) revert ExceedsTokenDeposits();
        depositedOf[fromToken] -= amount;
        depositedOf[toToken] += amount;
        emit KekReassigned(fromToken, toToken, amount);
    }

    /// Take spent KEK out of the spender's withdrawable credit and out of the vault.
    function sink(uint256 tokenId, uint256 amount) external onlyRole(BRIDGE_ROLE) whenNotPaused {
        if (amount == 0) revert BadAmount();
        uint256 free = depositedOf[tokenId] - reservedOf[tokenId];
        if (amount > free) revert ExceedsTokenDeposits();
        depositedOf[tokenId] -= amount;
        kek.safeTransfer(KEK_BURN, amount);
        emit KekSunk(tokenId, amount);
    }

    // ------------------------------------------------------------- claims
    /// Anyone may trigger a claim; funds always go to the recorded recipient.
    function claim(uint256 id) external whenNotPaused nonReentrant {
        Withdrawal storage w = withdrawals[id];
        if (w.status != Status.Pending) revert NotPending();
        if (block.timestamp < w.availableAt) revert NotYet();
        w.status = Status.Claimed;
        pendingTotal -= w.amount;
        kek.safeTransfer(w.to, w.amount);
        emit WithdrawalClaimed(id, w.to, w.amount);
    }

    function cancel(uint256 id) external onlyRole(GUARDIAN_ROLE) {
        Withdrawal storage w = withdrawals[id];
        if (w.status != Status.Pending) revert NotPending();
        w.status = Status.Cancelled;
        pendingTotal -= w.amount;
        reservedOf[withdrawalToken[id]] -= w.amount;
        emit WithdrawalCancelled(id);
    }

    /// Admin resolves a false-positive cancel: back to Pending with a fresh delay.
    function restore(uint256 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Withdrawal storage w = withdrawals[id];
        if (w.status != Status.Cancelled) revert NotCancelled();
        uint256 tokenId = withdrawalToken[id];
        if (reservedOf[tokenId] + w.amount > depositedOf[tokenId]) revert ExceedsTokenDeposits();
        if (pendingTotal + w.amount > kek.balanceOf(address(this))) revert InsufficientVault();
        w.status = Status.Pending;
        w.availableAt = uint64(block.timestamp) + withdrawDelay;
        reservedOf[tokenId] += w.amount;
        pendingTotal += w.amount;
        emit WithdrawalRestored(id, w.availableAt);
    }
}
