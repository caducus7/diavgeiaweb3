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

## Findings from the first live run (Athens 2025, Β.2.2, recorded 2026-10-11)

- 5,515 acts, 5,667 versions. Monthly `info.total` sums agree exactly, and two recordings taken minutes apart
  hold the identical 5,667 versions. Older figures (5,472 here, 5,482 at
  diafaneia.ai) were taken earlier or with clamped windows. Portal non-void total 236,634,270.09 EUR.
- `live-check`: all five fixture records hash identically live, including the reconstructed pre-void
  version, so the reconstruction was right and canonical form v1 is stable against live data.
- Two client bugs would have corrupted the year silently: the shared paging counter (kept 3,060 of 5,515)
  and the API's exclusive `to_issue_date` (SPEC §7). Both fixed with regression tests.
- **1,578 of the 5,480 non-void acts (29%) carry no amount** (payroll orders among them). Both totals are blind to them,
  so the headline number covers payments that state an amount, and the page says so.
- 61Θ6Ω6Μ-2ΑΗ, 1,397,928.53 EUR, 5th payment for the new Panathinaikos stadium: payer and payee are swapped
  (payer is the TERNA, AKTOR and METKA consortium, payee is the municipality). The registry cannot anchor it
  under Athens' key, so it is the whole of the 2025 difference. A data-quality finding at source.
- 63ΓΕΩ6Μ-ΧΟ1: v3 of 4 is an empty correction (no payer, payee or amount) between two valid versions. The
  registry refuses v3, so v4 is blocked behind it.
- 6Γ5ΛΩ6Μ-ΔΒΡ (April 2025 payroll): voided in v2, un-voided in v3. The registry accepts nothing after a void,
  so the chain keeps it voided while the portal shows it live. 1 of 35 voided acts. Open question below.
- No multi-payee and no non-EUR acts in 2025. The multi-payee question is not urgent for Athens Β.2.2.

## What runs today

- 20 Foundry tests, 79 vitest tests, all green.
- `deploy / anchor / verify / pay / award / link` against Anvil with fixtures: five real versions across four
  ADAs anchor; verify shows portal = chain = 624,252.09 EUR; tampering one amount by 36 cents is caught with
  exit 2; paying the voided act is refused with `ActVoided()`; linking the paints act against a 20,000 EUR
  ceiling fires `Overrun`.
- `page` renders the same reconciliation as a static HTML page (next step 2, fixture only so far). `verify`
  now also catches an anchored act that the portal stops returning (`portal-missing`, found from `Anchored`
  logs) and no longer reports a chain that merely lags the portal as `mismatch` (`chain-behind`).
- The live client has run the whole of Athens 2025 (above). SPEC §8 lists its checks.
- Fixtures were fetched by hand. Record 4 in the fixture (pre-void version) is reconstructed from a field dump, not verbatim.

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
- [ ] Un-voiding: the registry treats a void as final (`AlreadyVoided`), but the portal un-voided one 2025
      act. Keep the rule (the chain then disagrees with the portal for that act, visibly), or allow a version
      after a void? Changes the contract and SPEC §5.
- [ ] Payer field: the anchor's `payerVat` comes from the free-entered `extraFieldValues.org.afm`, which is
      wrong or empty on two 2025 acts. Diavgeia's `organizationId` is authoritative. Should the signer's
      authority be checked against the org rather than the typed VAT? Changes the anchor semantics.
- [x] Version log `status`: only `PUBLISHED` in all of Athens 2025. Unknown statuses stay a `history-error`.
- [ ] Whether diafaneia.ai's team wants a verifier. A diff that is never zero is their problem first.

## Next steps

1. Done for Athens 2025 on 2026-10-11 (findings above). To repeat for another org or year, in this order:
   a. `npx tsx src/cli.ts live-check`: must print no `DIFF`. A verbatim record that differs means the fixture
      or the canonical form is wrong; stop there. A difference on the reconstructed record means the
      reconstruction was wrong: replace it with the live record.
   b. `DIAVGEIA_RECORD=fixtures/athens-2025.json npx tsx src/cli.ts anchor --from 2025-01-01 --to 2025-12-31`,
      then `verify` and `page` on the same range. Expect 5,472 acts (CONTEXT findings) unless the clamp moved.
      The first real test of the windowing and the version-log walk at scale. Expect surprises in `isVoid`,
      multi-sponsor acts, and the issueDate time zone (SPEC §8 throws on an Athens-midnight date).
   c. Commit the recorded fixture only after checking its size and that it holds no `privateData`.
2. A per-municipality page: anchored total, portal total, difference. The product of Phase 1 is that one number.
   Built (`cli page`) and checked on fixtures only. Still to do: run it on live data, and pass the registry's
   deployment block to `chainReader` on any chain but Anvil (it scans `Anchored` logs from block 0).
3. Replace the single-org signer with per-org keys derived from `/signers/{id}.json` (still civic, still a
   stand-in, but the data model becomes right).
4. Only then: talk to anyone in government.

## People and references

- Plan document: "Diavgeia on-chain: a plan" (Claude doc, 9 Oct 2026).
- diafaneia.ai, @diafaneiaAI on X. Data source they cite: Διαύγεια OpenData API.
- Law 3861/2010 (Diavgeia), Law 4270/2014 (public accounting), KIMDIS (public procurement register).
