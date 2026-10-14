// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ActRegistry} from "./ActRegistry.sol";

/// @notice Settlement adapter. In production this instructs a bank transfer and
///         records its reference; here it is whatever the deployer wires in.
interface IEuroRail {
    function settle(uint64 payerVat, uint64 payeeVat, uint128 amountCents, bytes32 ada) external;
}

/// @title PaymentGate
/// @notice "Publish before pay" as code: a disbursement executes only if the
///         ADA is anchored by the publishing organisation (the payer, SPEC §4),
///         is a B.2.2 act, names a payee other than that organisation, matches
///         payee and amount, has not been voided, and has not already been paid.
contract PaymentGate {
    ActRegistry public immutable registry;
    IEuroRail public immutable rail;
    address public immutable treasury;

    bytes8 public constant PAYMENT_ACT = bytes8("B.2.2");

    mapping(bytes32 => bool) public released;

    event Released(bytes32 indexed ada, uint64 payerVat, uint64 payeeVat, uint128 amountCents);

    error NotTreasury();
    error NotPaymentAct();
    error PayeeMismatch();
    error AmountMismatch();
    error ActVoided();
    error SelfPayment();
    error AlreadyReleased();

    constructor(ActRegistry _registry, IEuroRail _rail, address _treasury) {
        registry = _registry;
        rail = _rail;
        treasury = _treasury;
    }

    function release(bytes32 ada, uint64 payeeVat, uint128 amountCents) external {
        if (msg.sender != treasury) revert NotTreasury();

        // reverts NotAnchored() if the act was never published on-chain
        ActRegistry.Anchor memory a = registry.latest(ada);

        if (a.actType != PAYMENT_ACT) revert NotPaymentAct();
        if (a.voided) revert ActVoided();
        // An act whose payee is its own publisher is money coming in (Athens 2025: a payment typed with payer
        // and payee swapped). The anchor's payer is the publisher, not the typed payer, so refuse it here.
        if (a.payeeVat == a.payerVat) revert SelfPayment();
        if (a.payeeVat != payeeVat) revert PayeeMismatch();
        if (a.amountCents != amountCents) revert AmountMismatch();
        if (released[ada]) revert AlreadyReleased();

        released[ada] = true;
        rail.settle(a.payerVat, payeeVat, amountCents, ada);
        emit Released(ada, a.payerVat, payeeVat, amountCents);
    }
}
