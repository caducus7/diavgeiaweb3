// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ActRegistry} from "../src/ActRegistry.sol";
import {PaymentGate, IEuroRail} from "../src/PaymentGate.sol";
import {ProcurementGraph} from "../src/ProcurementGraph.sol";
import {MockRail} from "../src/MockRail.sol";

/// Scenario built from two real Municipality of Athens acts (Nov 2025):
///   9ΓΒΝΩ6Μ-Λ4Η  paints, 25,462.16 EUR to AFM 166758607, contract 24SYMV015873979
///   ΨΟΣΝΩ6Μ-Θ6Ε  1,860.00 EUR to AFM 043247900, later voided
contract DiavgeiaTest is Test {
    uint64 constant ATHENS = 90025537; // AFM 090025537
    uint64 constant PAINTS_PAYEE = 166758607;
    uint64 constant VOID_PAYEE = 43247900;

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address signerAthens = makeAddr("signer-100089761");
    address signerOther = makeAddr("signer-other-org");
    address stranger = makeAddr("stranger");

    ActRegistry reg;
    PaymentGate gate;
    ProcurementGraph graph;
    MockRail rail;

    bytes32 adaPaints;
    bytes32 adaVoid;
    bytes32 contractPaints;

    bytes32 hashPaintsV1 = keccak256("paints v1");
    bytes32 hashVoidV1 = keccak256("void v1 (original)");
    bytes32 hashVoidV2 = keccak256("void v2 (AKYRO XRIMATIKO ENTALMA)");

    function setUp() public {
        reg = new ActRegistry(admin);
        rail = new MockRail();
        gate = new PaymentGate(reg, rail, treasury);
        graph = new ProcurementGraph(reg);

        vm.startPrank(admin);
        reg.setSigner(signerAthens, ATHENS);
        reg.setSigner(signerOther, 999999999);
        vm.stopPrank();

        adaPaints = reg.adaKey(unicode"9ΓΒΝΩ6Μ-Λ4Η");
        adaVoid = reg.adaKey(unicode"ΨΟΣΝΩ6Μ-Θ6Ε");
        contractPaints = reg.adaKey("24SYMV015873979");
    }

    function _paymentAnchor(bytes32 h, uint64 payee, uint128 cents, bytes32 prev, bytes32 cref, bool voided)
        internal
        pure
        returns (ActRegistry.Anchor memory)
    {
        return ActRegistry.Anchor({
            actHash: h,
            actType: bytes8("B.2.2"),
            payerVat: ATHENS,
            payeeVat: payee,
            amountCents: cents,
            issueDate: 20420, // 2025-11-28
            prevAnchor: prev,
            contractRef: cref,
            signer: address(0),
            anchoredAt: 0,
            voided: voided
        });
    }

    // ---------- ActRegistry ----------

    function test_adaKey_roundtrips_greek() public view {
        bytes32 k = reg.adaKey(unicode"9ΓΒΝΩ6Μ-Λ4Η");
        assertTrue(k != bytes32(0));
        assertTrue(k != reg.adaKey(unicode"ΨΟΣΝΩ6Μ-Θ6Ε"));
    }

    function test_anchor_first_version() public {
        vm.prank(signerAthens);
        uint32 v = reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
        assertEq(v, 1);
        ActRegistry.Anchor memory a = reg.latest(adaPaints);
        assertEq(a.actHash, hashPaintsV1);
        assertEq(a.signer, signerAthens);
        assertEq(a.amountCents, 2546216);
    }

    function test_anchor_rejects_signer_of_other_org() public {
        vm.prank(signerOther);
        vm.expectRevert(ActRegistry.SignerNotOfPayer.selector);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
    }

    function test_anchor_rejects_stranger() public {
        vm.prank(stranger);
        vm.expectRevert(ActRegistry.SignerNotOfPayer.selector);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
    }

    function test_first_version_must_have_no_prev() public {
        vm.prank(signerAthens);
        vm.expectRevert(ActRegistry.FirstVersionHasPrev.selector);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, keccak256("x"), contractPaints, false));
    }

    function test_correction_chain_is_linked_and_ordered() public {
        vm.startPrank(signerAthens);
        reg.anchor(adaVoid, _paymentAnchor(hashVoidV1, VOID_PAYEE, 186000, 0, 0, false));

        // wrong prev: rejected
        vm.expectRevert(ActRegistry.PrevMustBeLatest.selector);
        reg.anchor(adaVoid, _paymentAnchor(hashVoidV2, VOID_PAYEE, 186000, keccak256("bogus"), 0, true));

        // right prev: accepted, history is two versions
        uint32 v = reg.anchor(adaVoid, _paymentAnchor(hashVoidV2, VOID_PAYEE, 186000, hashVoidV1, 0, true));
        vm.stopPrank();

        assertEq(v, 2);
        assertEq(reg.versionCount(adaVoid), 2);
        assertEq(reg.versionAt(adaVoid, 0).actHash, hashVoidV1);
        assertEq(reg.versionAt(adaVoid, 1).actHash, hashVoidV2);
        assertTrue(reg.latest(adaVoid).voided);
        assertFalse(reg.versionAt(adaVoid, 0).voided);
    }

    function test_cannot_append_after_void() public {
        vm.startPrank(signerAthens);
        reg.anchor(adaVoid, _paymentAnchor(hashVoidV1, VOID_PAYEE, 186000, 0, 0, false));
        reg.anchor(adaVoid, _paymentAnchor(hashVoidV2, VOID_PAYEE, 186000, hashVoidV1, 0, true));
        vm.expectRevert(ActRegistry.AlreadyVoided.selector);
        reg.anchor(adaVoid, _paymentAnchor(keccak256("v3"), VOID_PAYEE, 186000, hashVoidV2, 0, false));
        vm.stopPrank();
    }

    function test_latest_reverts_when_unanchored() public {
        vm.expectRevert(ActRegistry.NotAnchored.selector);
        reg.latest(adaPaints);
    }

    // ---------- PaymentGate ----------

    function test_release_succeeds_for_anchored_matching_act() public {
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));

        vm.prank(treasury);
        gate.release(adaPaints, PAINTS_PAYEE, 2546216);

        assertEq(rail.count(), 1);
        (uint64 payer, uint64 payee, uint128 cents, bytes32 ada) = rail.settlements(0);
        assertEq(payer, ATHENS);
        assertEq(payee, PAINTS_PAYEE);
        assertEq(cents, 2546216);
        assertEq(ada, adaPaints);
        assertTrue(gate.released(adaPaints));
    }

    function test_release_refuses_unpublished_act() public {
        vm.prank(treasury);
        vm.expectRevert(ActRegistry.NotAnchored.selector);
        gate.release(adaPaints, PAINTS_PAYEE, 2546216);
        assertEq(rail.count(), 0);
    }

    function test_release_refuses_amount_mismatch() public {
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
        vm.prank(treasury);
        vm.expectRevert(PaymentGate.AmountMismatch.selector);
        gate.release(adaPaints, PAINTS_PAYEE, 2546217);
    }

    function test_release_refuses_payee_mismatch() public {
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
        vm.prank(treasury);
        vm.expectRevert(PaymentGate.PayeeMismatch.selector);
        gate.release(adaPaints, VOID_PAYEE, 2546216);
    }

    function test_release_refuses_voided_act() public {
        vm.startPrank(signerAthens);
        reg.anchor(adaVoid, _paymentAnchor(hashVoidV1, VOID_PAYEE, 186000, 0, 0, false));
        reg.anchor(adaVoid, _paymentAnchor(hashVoidV2, VOID_PAYEE, 186000, hashVoidV1, 0, true));
        vm.stopPrank();
        vm.prank(treasury);
        vm.expectRevert(PaymentGate.ActVoided.selector);
        gate.release(adaVoid, VOID_PAYEE, 186000);
    }

    function test_release_refuses_self_payment() public {
        // 61Θ6Ω6Μ-2ΑΗ: typed with payer and payee swapped, so anchored with Athens as both
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, ATHENS, 139792853, 0, 0, false));
        vm.prank(treasury);
        vm.expectRevert(PaymentGate.SelfPayment.selector);
        gate.release(adaPaints, ATHENS, 139792853);
        assertEq(rail.count(), 0);
    }

    function test_release_refuses_double_pay() public {
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
        vm.startPrank(treasury);
        gate.release(adaPaints, PAINTS_PAYEE, 2546216);
        vm.expectRevert(PaymentGate.AlreadyReleased.selector);
        gate.release(adaPaints, PAINTS_PAYEE, 2546216);
        vm.stopPrank();
        assertEq(rail.count(), 1);
    }

    function test_release_refuses_non_treasury() public {
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
        vm.prank(stranger);
        vm.expectRevert(PaymentGate.NotTreasury.selector);
        gate.release(adaPaints, PAINTS_PAYEE, 2546216);
    }

    // ---------- ProcurementGraph ----------

    function test_link_payment_and_overrun() public {
        vm.prank(signerAthens);
        graph.registerAward(contractPaints, 3_000_000, 44810000, 6261); // 30,000 EUR ceiling

        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));

        vm.prank(stranger); // permissionless
        graph.linkPayment(adaPaints);

        (uint128 ceiling, uint128 paid, uint32 n) = graph.spentAgainst(contractPaints);
        assertEq(ceiling, 3_000_000);
        assertEq(paid, 2546216);
        assertEq(n, 1);

        // second payment order pushes over the ceiling: Overrun fires
        bytes32 ada2 = reg.adaKey("SECOND-ORDER");
        vm.prank(signerAthens);
        reg.anchor(ada2, _paymentAnchor(keccak256("second"), PAINTS_PAYEE, 600_000, 0, contractPaints, false));

        vm.expectEmit(true, false, false, true);
        emit ProcurementGraph.Overrun(contractPaints, 3_000_000, 3_146_216);
        graph.linkPayment(ada2);
    }

    function test_link_refuses_double_count() public {
        vm.prank(signerAthens);
        graph.registerAward(contractPaints, 3_000_000, 44810000, 6261);
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
        graph.linkPayment(adaPaints);
        vm.expectRevert(ProcurementGraph.AlreadyCounted.selector);
        graph.linkPayment(adaPaints);
    }

    function test_link_refuses_self_payment() public {
        vm.prank(signerAthens);
        graph.registerAward(contractPaints, 1_000_000, 44810000, 6261);
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, ATHENS, 2546216, 0, contractPaints, false));
        vm.expectRevert(ProcurementGraph.SelfPayment.selector);
        graph.linkPayment(adaPaints);
        (, uint128 paid, uint32 n) = graph.spentAgainst(contractPaints);
        assertEq(paid, 0);
        assertEq(n, 0);
    }

    function test_link_refuses_unknown_award() public {
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, 2546216, 0, contractPaints, false));
        vm.expectRevert(ProcurementGraph.UnknownAward.selector);
        graph.linkPayment(adaPaints);
    }

    function test_register_award_requires_signer() public {
        vm.prank(stranger);
        vm.expectRevert(ProcurementGraph.SignerNotOfPayer.selector);
        graph.registerAward(contractPaints, 1, 1, 1);
    }

    // ---------- fuzz ----------

    function testFuzz_release_only_with_exact_amount(uint128 anchored, uint128 asked) public {
        vm.assume(anchored != asked);
        vm.prank(signerAthens);
        reg.anchor(adaPaints, _paymentAnchor(hashPaintsV1, PAINTS_PAYEE, anchored, 0, contractPaints, false));
        vm.prank(treasury);
        vm.expectRevert(PaymentGate.AmountMismatch.selector);
        gate.release(adaPaints, PAINTS_PAYEE, asked);
    }
}
