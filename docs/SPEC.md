# Specification

Status: v1, implemented. Normative for `verifier/src/canonical.ts` and `contracts/src/*.sol`.

## 1. Scope

One on-chain anchor per published version of a Diavgeia act. The anchor commits to a canonical form of
the act and carries the few fields a payment contract or a procurement join needs to check without
fetching anything. Everything else is off-chain and bound by the hash.

## 2. Canonical form (CANONICAL_VERSION = 1)

Input: one decision object from the Diavgeia OpenData API (`/opendata/search.json`, `/opendata/decisions/{ada}.json`
or `/opendata/decisions/v/{versionId}.json`).

Output object, keys in this order after sorting (sorting is part of the spec, listing is for readers):

| key | type | from |
| --- | --- | --- |
| actType | string | `decisionTypeId`, NFC |
| ada | string | `ada`, NFC |
| issueDay | integer | `floor(issueDate_ms / 86400000)` |
| payees | array | one per `extraFieldValues.sponsor[i]`, in API order |
| payees[].amountCents | string | `toCents(expenseAmount.amount)` as decimal string |
| payees[].country | string | `sponsorAFMName.afmCountry`, NFC, "" if absent |
| payees[].currency | string | `expenseAmount.currency`, NFC, "EUR" if absent |
| payees[].name | string | `sponsorAFMName.name`, NFC |
| payees[].vat | string | `sponsorAFMName.afm`, NFC |
| payerName | string | `extraFieldValues.org.name`, NFC |
| payerVat | string | `extraFieldValues.org.afm`, NFC |
| prevVersionId | string or null | `correctedVersionId` |
| protocolNumber | string or null | `protocolNumber`, NFC |
| signerIds | string[] | `signerIds`, sorted ascending as strings |
| subject | string | `subject`, NFC, otherwise byte-exact (newlines kept) |
| v | integer | 1 |
| versionId | string | `versionId` |

Excluded on purpose: `publishTimestamp`, `submissionTimestamp`, `url`, `documentUrl`, `documentChecksum`,
`attachments`, `warnings`, `privateData`, `unitIds`, `thematicCategoryIds`, `status`, `documentType`,
`relatedDecisions`, `relatedEkgrisiDapanis`, `skipVatReason`, `afmType`, `enterName`. These describe the
upload or the portal's bookkeeping, not what was decided.

Serialisation: JSON, keys sorted lexicographically by UTF-16 code unit at every nesting level, no whitespace,
strings escaped per RFC 8259 as `JSON.stringify` does. Hash: keccak256 over the UTF-8 bytes.

`toCents(x)`: `x.toFixed(2)` split on `.`; `whole * 100 + frac`. Defined for the floats the API emits
(two decimal places). Any amount with more than two decimals is a spec violation and must be rejected, not
rounded.

Pinned test vector: ADA 9ΓΒΝΩ6Μ-Λ4Η, versionId 0ad4da70-6ebc-4c46-b82a-f61143cd56a7 hashes to
`0xce473bfba3290809b737ace729a0000ad6166df0a6a8d400a4c66f6832ad4b8d`.

Changing anything above requires `v: 2`, a new pinned vector, and a note that v1 anchors remain valid under
v1 only.

## 3. Keys

- `adaKey(ada)`: UTF-8 bytes of the NFC ADA, left-aligned in bytes32, zero-padded. Reverts if > 32 bytes.
  Matches `ActRegistry.adaKey(string)`.
- `actTypeKey(t)`: Greek capital beta U+0392 replaced by ASCII `B`, then UTF-8 left-aligned in bytes8.
  `Β.2.2` and `B.2.2` give `0x422e322e32000000`.
- `contractRefKey(ref)`: same packing as adaKey, or bytes32(0) if no ref.

## 4. Anchor struct (on-chain)

```
bytes32 actHash      keccak256 of canonical form
bytes8  actType      see 3
uint64  payerVat     numeric AFM, leading zeros dropped (090025537 -> 90025537)
uint64  payeeVat     first sponsor's AFM, 0 if none
uint128 amountCents  first sponsor's amount in cents, 0 if none
uint32  issueDate    unix day
bytes32 prevAnchor   actHash of the previous version, 0 for a first version
bytes32 contractRef  KIMDIS id packed, 0 if none found
address signer       set by the contract from msg.sender
uint64  anchoredAt   set by the contract from block.timestamp
bool    voided       true if this version voids the act
```

Known limitation: acts with more than one sponsor commit to all of them in `actHash` but expose only the
first on-chain. PaymentGate therefore handles single-payee acts only. Multi-payee support is an open item.

## 5. Contracts

### ActRegistry
- `setSigner(address, uint64 orgVat)` admin only. `orgVat = 0` revokes.
- `anchor(bytes32 ada, Anchor a)`: caller must be a signer of `a.payerVat`; first version needs
  `prevAnchor == 0`; later versions need `prevAnchor == latest.actHash`; nothing may follow a voided version.
  Emits `Anchored(ada, actHash, version, signer, voided)`.
- Views: `versionCount`, `versionAt`, `latest` (reverts `NotAnchored`), `isAnchored`, `adaKey`.
- No function removes or alters a stored anchor. This is a property, not an omission.

### PaymentGate
- `release(bytes32 ada, uint64 payeeVat, uint128 amountCents)`: treasury only. Reverts `NotAnchored`,
  `NotPaymentAct`, `ActVoided`, `PayeeMismatch`, `AmountMismatch`, `AlreadyReleased`. On success marks
  released and calls `IEuroRail.settle(payerVat, payeeVat, amountCents, ada)`.
- `IEuroRail` is the bank-side adapter boundary. `MockRail` records calls and does nothing else.

### ProcurementGraph
- `registerAward(bytes32 contractRef, uint128 ceilingCents, uint32 cpv, uint32 kae)`: any registered signer;
  award's payer is the signer's org. One registration per ref.
- `linkPayment(bytes32 ada)`: permissionless. Requires the latest anchor to be non-void, to carry a known
  `contractRef`, and to have the award's payer. Counts each ADA once. Emits `PaymentLinked` and, when
  `paid > ceiling`, `Overrun`.
- `spentAgainst(contractRef) -> (ceiling, paid, payments)`.

## 6. Verifier behaviour

`anchor`: for each ADA in the search window, walk `/versionlog.json`, fetch earlier versions via
`/decisions/v/{id}.json`, anchor any versions the chain lacks, in order, chaining `prevAnchor`.

`verify`: for each ADA the portal returns, compare chain versions against portal versions by hash,
position by position. Statuses:
`ok`, `void` (latest version voids; earlier versions still on chain), `unanchored`, `mismatch` (a version
both sides hold differs), `chain-ahead` (chain has versions the portal no longer shows), `chain-behind`
(chain holds a matching prefix of the portal's versions; the detail says whether the rest are merely not yet
anchored or blocked: after a void, or behind a version whose payer is not the org), `unanchorable` (nothing
anchored and the act's payer VAT is not the org's, so the org's signer cannot anchor it), `history-error`
(the portal contradicts itself about this act's history: the version log does not end with the version search
returned, a version record is for a different version, or the log or an earlier version fails the shape
checks of §8). A search record that fails §8 is not scoped to its act: it aborts the run, because the totals
cannot be computed honestly without it.
Then, for every ADA in the registry's `Anchored` logs whose latest anchor has the org's `payerVat` and an
`issueDate` inside the window but which the portal did not return: `portal-missing`. Its amount counts in
the chain total.
Prints portal and chain non-void totals and their difference. Exit 2 if any `mismatch`, `chain-ahead`,
`portal-missing` or `history-error` (also with `--json`). A `history-error` is scoped to its act: the run
carries on. A network or HTTP failure aborts the run (exit 1) rather than producing partial totals.
`--vat` is checked against the acts: it is an error only when fewer than half carry it (a wrong `--vat`);
single acts with another payer are `unanchorable` findings. `chain-behind` and `unanchored` are lag, not disagreement.

`page`: the same reconciliation rendered as one static HTML file (no scripts, no external requests). It
shows ADAs, statuses and amounts only; subjects and payee names are left out. It states its data source
(live or fixture) and the caveats on the totals. Same exit code as `verify`.

`anchor` skips an act whose history is a `history-error` (exit 2). It checks each version before sending it,
with the same rule the report uses (`anchorBlocker`): a version whose payer is not the signer's org, or any
version after a void, is not sent, and neither is anything after it; earlier versions of that act are still
anchored. These registry refusals are logged and exit 0, since they are permanent facts about the data that
`verify` reports. Any other revert is logged per act; an RPC failure aborts.

`record --out f.json`: fetches a window and every act's history once (4 requests at a time) and saves it in
the fixture format, so `anchor`, `verify` and `page` can run offline on it.

`live-check --fixture f.json`: re-runs the search in the fixture's `_source` against the live API and
compares canonical hashes per versionId. Reports acts missing on either side, live versions newer than the
fixture, and per-act errors as `DIFF` lines. Exit 2 on any difference.

`DIAVGEIA_RECORD=f.json` on a live run saves every record and version log fetched, in the fixture format.

Heuristics, flagged as such in code:
- `isVoid(subject)`: subject starts with `ΑΚΥΡΟ` or `ΑΚΥΡΩΤΙΚ`. Diavgeia has no structured void flag.
- `contractRefFromSubject(subject)`: regex `\d{2}SYMV\d{9}`. KIMDIS ids are free text on Β.2.2 acts.

## 7. Diavgeia OpenData API facts (verified 2026-10-09 and 2026-10-11)

- Base `https://diavgeia.gov.gr/opendata`. JSON when `Accept: application/json` or `.json` suffix.
- `search.json?org=&type=&from_issue_date=&to_issue_date=&from_date=&size=&page=`; `info.total`,
  `info.actualSize`, `info.query` (the Lucene query actually run, useful to see what was clamped).
- Issue-date window clamped to 180 days. With no issue-date filter, defaults to the last six months.
  `from_date` (submission) also defaults to six months; set it explicitly.
- Municipality of Athens is org `6013`, VAT `090025537`. Org `6027` is Amorgos. Check, don't assume.
- `documentChecksum` was `null` on every record sampled.
- `/decisions/{ada}/versionlog.json` lists versions with `correctedVersionId` links.
  `/decisions/v/{versionId}.json` returns an earlier version's content.
- `/signers/{id}.json` returns name, org, position, `activeFrom`, `activeUntil`, `hasOrganizationSignRights`.
- `to_issue_date` excludes that day (verified 2026-10-11). `info.query` shows the range is run as
  `issueDate:[DT(from 00:00 Athens) TO DT(to 00:00 Athens)]` while `issueDate` is stored at 00:00 UTC, so acts
  issued on `to` fall outside: 2025-03-31..2025-03-31 returns 0 acts, 2025-03-31..2025-04-01 returns the 25 of
  31 March. The client sends `to + 1 day`.
- `issueDate` is 00:00 UTC on all but one of 5,667 Athens 2025 versions (one at 06:54 UTC).
- Version log `status` was `PUBLISHED` on every entry of Athens 2025.
- Β.2.2 acts carry no KAE or CPV. Those are on the commitment act (Β.2.1) and the KIMDIS award.

## 8. Ingestion checks (`verifier/src/validate.ts`, `diavgeia.ts`)

Every record, from the live API or a fixture, passes these before it is hashed or summed. A failure is an
error, never a default.

- Types of every field the canonical form or the anchor reads: `ada`, `versionId`, `organizationId`,
  `decisionTypeId` non-empty strings; `subject` string; `issueDate` integer; `signerIds` array of strings,
  or missing or null (hashed as `[]`);
  `correctedVersionId`, `protocolNumber`, org and payee strings or null.
- `ada` at most 32 UTF-8 bytes (it must fit `adaKey`).
- Amounts: finite, non-negative, at most 1e12 EUR, and at most two decimals (§2: rejected, not rounded).
  The cap matters: above about 7e13 adjacent doubles are more than a cent apart and the two-decimal test
  stops being exact. Tested by sampling the whole range up to the cap.
- Search: `info.actualSize` equals the number of decisions; every act has the requested `org` and `type`
  (NFC) and an `issueDate` inside the requested window, in UTC days. FixtureClient filters with the same
  function (`outsideQuery`), so a recorded run replays to the same acts.
- Paging is counted per window. A window whose distinct versions do not equal its `info.total` is an error
  (catches an ignored `page` parameter). The live client uses 90-day windows, half the observed 180-day
  clamp, so an off-by-one in the API's convention cannot drop a day.
- Version log: non-empty, for the requested ADA, and its latest entry is the version search returned.
- HTTP: 404 means absent; 429, 5xx and network errors are retried 3 times with backoff; anything else, and
  a non-JSON body, is an error.
