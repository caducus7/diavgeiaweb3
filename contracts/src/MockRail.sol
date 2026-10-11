// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEuroRail} from "./PaymentGate.sol";

/// @notice Stand-in for the bank-side settlement adapter. Records what would
///         have been instructed. Not for production.
contract MockRail is IEuroRail {
    struct Settlement {
        uint64 payerVat;
        uint64 payeeVat;
        uint128 amountCents;
        bytes32 ada;
    }

    Settlement[] public settlements;

    event Settled(uint64 payerVat, uint64 payeeVat, uint128 amountCents, bytes32 indexed ada);

    function settle(uint64 payerVat, uint64 payeeVat, uint128 amountCents, bytes32 ada) external {
        settlements.push(Settlement(payerVat, payeeVat, amountCents, ada));
        emit Settled(payerVat, payeeVat, amountCents, ada);
    }

    function count() external view returns (uint256) {
        return settlements.length;
    }
}
