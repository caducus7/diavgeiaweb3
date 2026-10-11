# diavgeia-chain

Phase 1 of the plan in *Diavgeia on-chain: a plan*: an append-only anchor registry for Greek public acts, a
payment gate that enforces "publish before pay" in code, a procurement graph that links KIMDIS awards to the
payments made against them, and a verifier that recomputes hashes from the Diavgeia OpenData API and reports
any difference between what the portal shows and what was anchored.

Everything here runs on real Municipality of Athens payment acts (type Β.2.2, November 2025), including one
that was voided after publication.

```
contracts/            Foundry
  src/ActRegistry.sol        anchor(ada, Anchor): versions are a linked list, never overwritten
  src/PaymentGate.sol        release(ada, payee, amount): refuses unanchored, voided, mismatched, or double payments
  src/ProcurementGraph.sol   registerAward / linkPayment / spentAgainst; emits Overrun when paid > ceiling
  src/MockRail.sol           stand-in for the bank-side settlement adapter
  test/Diavgeia.t.sol        20 tests incl. fuzz, built on the real Athens acts
verifier/             TypeScript (viem, tsx, vitest)
  src/canonical.ts           canonicalisation spec v1 + keccak256; the part anyone must be able to reproduce
  src/diavgeia.ts            OpenData client (live or fixture); handles the API's 180-day window cap
  src/chain.ts               deploy, anchor, read back
  src/report.ts              portal vs chain reconciliation, shared by verify and page
  src/page.ts                static per-municipality HTML page
  src/validate.ts            shape checks on every API record (SPEC §8)
  src/livecheck.ts           fixture vs live API, hash by hash
  src/record.ts              save a live run in the fixture format
  src/cli.ts                 deploy | anchor | verify | page | live-check | pay | award | link
  fixtures/athens-2025-11.json   5 real records (4 verbatim, 1 reconstructed earlier version)
```

## Run it

Needs Foundry (forge, anvil) and Node 22.

```sh
cd contracts && forge test                      # 20 passed
cd ../verifier && npm install && npm test       # 66 passed

anvil &                                         # local chain, default accounts
export DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json   # omit to hit the live API
npx tsx src/cli.ts deploy
npx tsx src/cli.ts anchor      # 5 versions across 4 ADAs, incl. the void chain for ΨΟΣΝΩ6Μ-Θ6Ε
npx tsx src/cli.ts verify      # per-ADA status + portal total vs chain total; exit 2 on any disagreement
npx tsx src/cli.ts page        # same, as out/6013-2025-11-24-2025-11-30.html

# with network, no DIAVGEIA_FIXTURE:
npx tsx src/cli.ts live-check                     # fixture vs live API, hash by hash; exit 2 on any DIFF
DIAVGEIA_RECORD=run.json npx tsx src/cli.ts verify # also save every record fetched, as a fixture

npx tsx src/cli.ts pay --ada ΨΟΣΝΩ6Μ-Θ6Ε        # refused: ActVoided()
npx tsx src/cli.ts pay --ada 9ΓΒΝΩ6Μ-Λ4Η        # released 25,462.16 EUR
npx tsx src/cli.ts pay --ada 9ΓΒΝΩ6Μ-Λ4Η        # refused: AlreadyReleased()
npx tsx src/cli.ts award --ref 24SYMV015873979 --ceiling 20000 --cpv 44810000 --kae 6261
npx tsx src/cli.ts link  --ada 9ΓΒΝΩ6Μ-Λ4Η      # ** OVERRUN **
```

## Canonicalisation spec (v1)

Hashed: ada, versionId, prevVersionId (= correctedVersionId), actType, protocolNumber, subject, issueDay
(unix day), payerVat, payerName, signerIds (sorted), payees[{vat, name, country, amountCents, currency}].
Not hashed: anything that describes the upload rather than the act (publish/submission timestamps, URLs,
attachments, warnings, documentChecksum, privateData, unit and thematic ids).
Strings NFC, amounts in integer cents, keys sorted at every level, no whitespace, keccak256 of UTF-8.

The pinned hash of 9ΓΒΝΩ6Μ-Λ4Η under spec v1 is `0xce473bfb…ad4b8d` (verifier/test). If that test fails,
the spec changed and every existing anchor is invalid; bump `CANONICAL_VERSION`.

## What the real data taught the design

- The API returns `documentChecksum: null` on every record sampled. Integrity has to come from outside.
- ΨΟΣΝΩ6Μ-Θ6Ε was published on 27 Nov 2025 and re-submitted on 4 Dec with "ΑΚΥΡΟ ΧΡΗΜΑΤΙΚΟ ΕΝΤΑΛΜΑ."
  prepended to the subject. The portal shows only the new version; `/versionlog.json` and
  `/decisions/v/{versionId}.json` expose the old one. The registry keeps both.
- Voiding has no structured flag; it is a prefix on the subject. `isVoid()` is a heuristic and is marked as one.
- The KIMDIS contract id lives in free text (`24SYMV015873979` inside the subject). `contractRefFromSubject()`
  is a regex. Phase 2 makes it a field.
- KAE and CPV are absent from Β.2.2 acts entirely; they are on the award and the commitment act.
- Issue-date windows are capped at 180 days and default to the last six months. Year totals need three calls.

## Not done, on purpose

- Signer keys are Anvil accounts mapped to one org VAT. Real key issuance and revocation is section 7 of the plan.
- `MockRail` records a settlement; it does not move euros.
- The live client is untested against the API from this environment (egress blocked); fixtures are real
  records fetched by hand on 2026-10-11.
- No GDPR position on VAT numbers of natural persons on a public ledger. Names are kept off-chain; VAT
  numbers are not. That is the open question before any public deployment.
