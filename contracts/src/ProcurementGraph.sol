// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ActRegistry} from "./ActRegistry.sol";

/// @title ProcurementGraph
/// @notice Links KIMDIS contract awards to the payment acts anchored against
///         them, and fires an event the moment paid exceeds ceiling.
contract ProcurementGraph {
    struct Award {
        uint64 payerVat;
        uint128 ceilingCents;
        uint32 cpv;
        uint32 kae;
        bool exists;
    }

    ActRegistry public immutable registry;

    mapping(bytes32 => Award) public awards;              // contractRef -> award
    mapping(bytes32 => uint128) public paidCents;         // contractRef -> running total
    mapping(bytes32 => uint32) public paymentCount;       // contractRef -> number of acts
    mapping(bytes32 => mapping(bytes32 => bool)) public counted; // contractRef -> ada -> counted

    event AwardRegistered(bytes32 indexed contractRef, uint64 payerVat, uint128 ceilingCents, uint32 cpv, uint32 kae);
    event PaymentLinked(bytes32 indexed contractRef, bytes32 indexed ada, uint128 amountCents, uint128 runningTotal);
    event Overrun(bytes32 indexed contractRef, uint128 ceilingCents, uint128 paidCents);

    error SignerNotOfPayer();
    error UnknownAward();
    error WrongContractRef();
    error WrongPayer();
    error ActVoided();
    error AlreadyCounted();
    error AwardExists();

    constructor(ActRegistry _registry) {
        registry = _registry;
    }

    /// @notice Register an award. Caller must be a registered signer of the payer.
    function registerAward(bytes32 contractRef, uint128 ceilingCents, uint32 cpv, uint32 kae) external {
        uint64 org = registry.signerOrg(msg.sender);
        if (org == 0) revert SignerNotOfPayer();
        if (awards[contractRef].exists) revert AwardExists();
        awards[contractRef] = Award(org, ceilingCents, cpv, kae, true);
        emit AwardRegistered(contractRef, org, ceilingCents, cpv, kae);
    }

    /// @notice Permissionless: anyone can link an anchored, non-voided payment
    ///         act to the award its contractRef names.
    function linkPayment(bytes32 ada) external {
        ActRegistry.Anchor memory a = registry.latest(ada);
        Award memory aw = awards[a.contractRef];
        if (!aw.exists) revert UnknownAward();
        if (a.contractRef == bytes32(0)) revert WrongContractRef();
        if (a.payerVat != aw.payerVat) revert WrongPayer();
        if (a.voided) revert ActVoided();
        if (counted[a.contractRef][ada]) revert AlreadyCounted();

        counted[a.contractRef][ada] = true;
        paymentCount[a.contractRef] += 1;
        uint128 total = paidCents[a.contractRef] + a.amountCents;
        paidCents[a.contractRef] = total;
        emit PaymentLinked(a.contractRef, ada, a.amountCents, total);
        if (total > aw.ceilingCents) emit Overrun(a.contractRef, aw.ceilingCents, total);
    }

    function spentAgainst(bytes32 contractRef)
        external
        view
        returns (uint128 ceilingCents, uint128 paid, uint32 payments)
    {
        Award memory aw = awards[contractRef];
        if (!aw.exists) revert UnknownAward();
        return (aw.ceilingCents, paidCents[contractRef], paymentCount[contractRef]);
    }
}
