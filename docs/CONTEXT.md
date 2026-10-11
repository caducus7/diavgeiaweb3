# Context for a new session

What was decided, what was learned, and what is still open. Read this before touching code. Update it
when a decision changes; keep it short.

## Why this exists

diafaneia.ai (civic search over Diavgeia's 72M public acts) showed that Greek public spending is published
but unreadable. This project is the answer to "what would blockchain add": not readability, which it does
not touch, but tamper-evidence of published acts, enforcement of the publish-before-pay rule in Law
3861/2010, and a structured link from procurement contract to payment. Framed for a sceptical voter, not
a crypto audience.

## Decisions (with the reason)

1. **Hash a canonical JSON, not the PDF.** PDFs differ byte for byte between uploads; canonical JSON is
   reproducible by anyone from the OpenData API. See SPEC §2.
2. **Corrections are a linked list, never an overwrite.** The real case: ΨΟΣΝΩ6Μ-Θ6Ε was published 27 Nov
   2025 and re-submitted 4 Dec with "ΑΚΥΡΟ ΧΡΗΜΑΤΙΚΟ ΕΝΤΑΛΜΑ." prepended. Portal shows only the new
   version. The chain keeps both.
3. **Payee names stay off-chain.** VAT numbers go on-chain; names do not. Sole traders are natural persons
   and appear in the Athens data. GDPR exposure of VAT numbers is open (below).
4. **The signing body anchors, not the portal operator.** Otherwise the portal remains the trust root.
   In Phase 1 the "signing body" is a civic crawler with one key per org; that is a stand-in and is labelled so.
5. **Amounts as integer cents.** `toCents` goes through `toFixed(2)` to kill float drift. 25462.16 -> 2546216.
6. **Chain choice deferred.** Needs a legal opinion (GDPR, validator set) before a technical one. Local Anvil
   for now. Throughput is not a constraint: ~12k acts/day nationally.
7. **Phase order: Verify, Attest, Enforce.** Each useful alone. Phase 1 needs no permission. Phase 3 needs a law.
8. **Stack defaults:** Foundry + Solidity 0.8.28, TypeScript ESM + viem 2 + tsx + vitest, Node 22. Chosen for
   speed, not because they were evaluated against alternatives.

## Findings from real data (Athens, Β.2.2, Nov 2025)

- API totals for Athens 2025 Β.2.2: 2,532 (Jan to Jun) + 2,940 (Jul to 27 Dec) = 5,472. diafaneia.ai
  says 5,482; the gap is the 180-day clamp cutting 28 to 31 Dec.
- `documentChecksum` is null on every record. The integrity field exists and is unused.
- Signer 100089761 (Head of Unit, no org-level sign rights) has `activeUntil` in the year 3000. Key
  lifecycle is not modelled by the portal.
- KIMDIS contract id (24SYMV015873979) appears only in the free-text subject. KAE and CPV are absent from
  payment acts. The single highest-value change in the whole plan is a Diavgeia schema change, not a contract.
- The void prefix is unstructured text. `isVoid` is a regex and will have false negatives.

## What runs today

- 20 Foundry tests, 14 vitest tests, all green.
- `deploy / anchor / verify / pay / award / link` against Anvil with fixtures: five real versions across four
  ADAs anchor; verify shows portal = chain = 624,252.09 EUR; tampering one amount by 36 cents is caught with
  exit 2; paying the voided act is refused with `ActVoided()`; linking the paints act against a 20,000 EUR
  ceiling fires `Overrun`.
- The live API client has not been run from a sandbox (egress blocked). Fixtures were fetched by hand.
  Record 4 in the fixture (pre-void version) is reconstructed from a field dump, not verbatim.

## Open questions, in blocking order

- [ ] Chain: public L2 with daily batching vs permissioned with a mixed validator set (Court of Audit,
      KEDE, universities, journalists' union). Legal opinion first.
- [ ] VAT numbers of natural persons on a permanent public ledger: ask the Hellenic DPA before any public
      deployment. If the answer is no, the design shifts to a permissioned chain with controlled reads,
      which weakens public verifiability.
- [ ] Signer key custody: issuance, revocation, post changes. The Diavgeia signer registry is the obvious
      identity source; its accuracy is unknown.
- [ ] Multi-payee acts: the anchor exposes only the first sponsor (SPEC §4). Decide whether to hash a
      Merkle root of payees or to emit one anchor per payee.
- [ ] Who at the Ministry of Digital Governance owns the Β.2.2 field list, and what making KAE and CPV
      mandatory would take.
- [ ] Whether diafaneia.ai's team wants a verifier. A diff that is never zero is their problem first.

## Next steps

1. Run `anchor` + `verify` live for all of Athens 2025 from a machine with network. First real test of the
   180-day windowing and the version-log walk at scale. Expect surprises in `isVoid` and in multi-sponsor acts.
2. A per-municipality page: anchored total, portal total, difference. The product of Phase 1 is that one number.
3. Replace the single-org signer with per-org keys derived from `/signers/{id}.json` (still civic, still a
   stand-in, but the data model becomes right).
4. Only then: talk to anyone in government.

## People and references

- Plan document: "Diavgeia on-chain: a plan" (Claude doc, 9 Oct 2026).
- diafaneia.ai, @diafaneiaAI on X. Data source they cite: Διαύγεια OpenData API.
- Law 3861/2010 (Diavgeia), Law 4270/2014 (public accounting), KIMDIS (public procurement register).
