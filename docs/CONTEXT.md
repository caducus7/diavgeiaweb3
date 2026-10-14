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
  (payer is the TERNA, AKTOR and METKA consortium, payee is the municipality). A data-quality finding at
  source. Under the first rule (typed payer) it could not be anchored and was the whole of the 2025
  difference; since the payer decision it is anchored under Athens' VAT and listed as a payer note.
- 63ΓΕΩ6Μ-ΧΟ1: v3 of 4 is an empty correction (no payer, payee or amount) between two valid versions. Under
  the first rule v3 was refused and v4 blocked behind it; now all four versions anchor.
- 6Γ5ΛΩ6Μ-ΔΒΡ (April 2025 payroll): voided in v2, un-voided in v3. The registry accepts nothing after a void,
  so the chain keeps it voided while the portal shows it live. 1 of 35 voided acts. Open question below.
- No multi-payee and no non-EUR acts in 2025 in Athens. Other bodies have many (see the five municipalities below).

## Findings from five more municipalities (2025, Β.2.2, recorded 2026-10-14)

Thessaloniki 6114, Piraeus 6243, Patras 6241, Heraklion (Crete) 6325 and Larissa 6167, ids from
`/organizations`. Each recorded live, anchored on its own Anvil and verified from the recording.

| Org | Acts | Portal = chain (EUR) | Statuses | Multi-payee | No amount | Typed payer empty | Signers |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| Thessaloniki | 6,800 | 143,070,102.60 vs 143,076,048.17 | 6,792 ok, 6 unsupported, 1 chain-behind, 1 history-error | 408 | 36 | 1 | 2 |
| Piraeus | 3,779 | 61,465.37 | all ok | 4 | 3,772 | 0 | 1 |
| Patras | 7,451 | 87,693,786.27 | 7,450 ok, 1 unsupported | 207 | 3,171 | 0 | 3 |
| Heraklion | 5,839 | 70,329,504.67 | 5,836 ok, 3 unsupported | 0 | 2,453 | 2 | 1 |
| Larissa | 7,635 | 76,770,812.96 | 7,632 ok, 3 unsupported | 1,333 | 1 | 7,560 | 2 |

- Before this run's fixes **every one of the five aborted at ingestion**: Athens was the clean case. Two causes:
  amounts the canonical form cannot hold (credit lines in Thessaloniki, Patras, Larissa; float residues where
  0.00 was meant in Heraklion: 5.68434e-14, 6.03961e-14, -1.42109e-14), now `unsupported` per act; and
  Piraeus storing every `issueDate` at Athens midnight, which the API's inclusive range returns in two
  adjacent windows (SPEC §7), now handled. 13 acts across 2025 are `unsupported`; none is an alarm.
- Thessaloniki's difference (-5,946.43) is two acts: ΡΙ2ΥΩΡ5-2Ρ4, whose v2 adds a -1.66 line so the chain
  stops at v1, and 6ΞΒΚΩΡ5-ΛΟΕ, whose version log names a newer version than search returns (`history-error`,
  the run's one alarm).
- **Multi-payee acts are itemised bills, not split payments.** Of 1,941 acts with more than one sponsor line
  in the five, 1,936 name the same payee VAT on every line (up to 145 lines). Only 5, all in Larissa, pay
  more than one party. The first-payee totals miss 31.8M EUR in Thessaloniki (18%), 20.5M in Larissa (21%)
  and 3.2M in Patras (3.5%): computed from the recordings, with first-payee sums that match `verify`'s portal
  totals to the cent.
- **Many bodies leave amounts out.** Piraeus fills an amount on 7 of 3,779 payment acts, so its totals say
  nothing; Patras and Heraklion leave it out on about 42%. The tamper evidence holds regardless (every act is
  anchored), but the headline number only covers acts that state an amount.
- **One or two people sign everything.** Piraeus and Heraklion: one signer for every act; Thessaloniki two;
  none of the signers in any of the seven bodies holds organisation-level signing rights. No signer issues.
- The payer decision mattered: Larissa types no payer on 7,560 of 7,635 acts.
- Anvil keeps about 2 MB of state per anchor (15 GB for Thessaloniki): one fresh Anvil per organisation-year.
- **Rerun 2026-10-14 with itemised bills summed** (SPEC §4). Totals in the table above are under the old
  first-line rule. Now, each matching an independent computation from the recording to the cent:
  Thessaloniki portal 174,831,937.86 EUR (difference -5,945.57, the same two acts: 4,029.59 counted on the
  portal side only for the history-error act, 9,975.16 on the chain side only for ΡΙ2ΥΩΡ5-2Ρ4's anchored v1);
  Piraeus 131,810.85; Patras 90,885,721.63; Larissa 97,034,335.06, with 5 acts split between payees leaving
  out 248,306.34. Portal = chain in the last three. Heraklion and Athens have no multi-line acts.

## What runs today

- 22 Foundry tests, 119 vitest tests, all green.
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
- [x] Multi-line acts. **Decided 2026-10-14 by the project owner:** when every line names one payee in one
      currency, the anchor's `amountCents` is their sum (SPEC §4). Reason: 1,936 of 1,941 multi-line acts in
      five municipalities repeat one payee, and the first-line rule missed 18-21% of the money in
      Thessaloniki and Larissa. Still open: the 5 acts that split a payment between payees (Larissa) expose
      only their first line; a Merkle root of payees or one anchor per payee would cover them.
- [x] Unsupported amounts (13 acts in 2025: negative credit lines, float residues where 0.00 was meant).
      **Decided 2026-10-14 by the project owner:** keep rejecting them, scoped to their act (`unsupported`,
      SPEC §6). No canonical v2 for now.
- [ ] Who at the Ministry of Digital Governance owns the Β.2.2 field list, and what making KAE and CPV
      mandatory would take.
- [ ] Un-voiding: the registry treats a void as final (`AlreadyVoided`), but the portal un-voided one 2025
      act. Keep the rule (the chain then disagrees with the portal for that act, visibly), or allow a version
      after a void? Changes the contract and SPEC §5. Default kept on 2026-10-11 (the project owner chose the
      defaults): a void stays final. Revisit if un-voids turn out to be common.
- [x] Payer field. **Decided 2026-10-12 by the project owner:** the anchor's `payerVat` is the publishing
      organisation's VAT from its `/organizations` record, not the free-entered `extraFieldValues.org.afm`
      (SPEC §4). The typed payer stays in the hash and is reported as a data-quality note. Reason: Amorgos
      types no payer on 647 of 681 versions, so under the earlier default (typed VAT, kept 2026-10-11) 648 of
      its 671 acts could not be anchored and its "difference" (7,396,087.80 EUR) measured only that.
- [x] Recordings of live runs are not committed (payee names of natural persons; 11.7 MB for a year). Two
      recordings of Athens 2025 were identical, so `record` rebuilds one in about 4 minutes.
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
   Done 2026-10-14. Live run: Athens September 2026 from the live API on Anvil, 857 acts and 923 versions
   anchored, portal = chain = 31,826,913.98 EUR. The log scan now starts at the registry's deployment block
   and pages in RPC-sized ranges (SPEC §6), checked on Anvil with 2-block ranges including a portal deletion.
3. Done 2026-10-12: one derived key per organisation, registered for the VAT in Diavgeia's own
   `/organizations` record, and every act's signers checked against `/signers` (SPEC §6). Athens and Amorgos
   anchor on one chain with separate keys. Athens 2025: 4 signers, none with organisation-level signing
   rights, one of them (a section head) signing 4,028 of 5,515 acts; no signer issues. Amorgos 2025: one
   signer, without organisation-level rights, signed 670 of 671 acts.
   Rerun 2026-10-12 with the payer decision (anchors carry the org's VAT), both on one Anvil from the
   recordings: Athens 2025 anchors 5,666 of 5,667 versions (only the un-voided payroll v3 refused); portal =
   chain = 236,634,270.09 EUR, difference 0.00; ok 5,479, void 35, chain-behind 1; one act types another
   payer (the stadium act). Amorgos 2025 anchors all 681 versions; portal = chain = 8,519,519.29 EUR,
   difference 0.00; ok 671; 639 acts type no payer and one (6ΤΒΕΩΨΡ-ΕΦΑ) types another VAT.
4. Only then: talk to anyone in government.

## People and references

- Plan document: "Diavgeia on-chain: a plan" (Claude doc, 9 Oct 2026).
- diafaneia.ai, @diafaneiaAI on X. Data source they cite: Διαύγεια OpenData API.
- Law 3861/2010 (Diavgeia), Law 4270/2014 (public accounting), KIMDIS (public procurement register).
