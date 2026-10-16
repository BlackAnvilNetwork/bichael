// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GuildVault
/// @notice Holds the guild share of the AhEscrow fee in native xDAI.
///         It does not score epochs and it does not pay guilds.
///         There is no payout function.
contract GuildVault {
    address public immutable escrow;

    event Received(uint256 amount);

    error NotEscrow();

    constructor(address escrow_) {
        if (escrow_ == address(0)) revert NotEscrow();
        escrow = escrow_;
    }

    /// @dev Only the escrow may fund the vault. There is no withdraw.
    receive() external payable {
        if (msg.sender != escrow) revert NotEscrow();
        emit Received(msg.value);
    }
}
