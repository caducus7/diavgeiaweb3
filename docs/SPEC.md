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
| payerVat | string | `extraFieldValues.org.afm`, NFC (the typed payer; the anchor struct's `payerVat`, §4, is not this) |
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
(two decimal places). Any amount that is negative, above 1e12, or has more than two decimals is outside the
canonical form and must be rejected, not rounded: `toCents` throws, so such a version is never hashed. The
verifier scopes that rejection to its act (§6, `unsupported`). Seen live in 2025: credit lines (negative) and
a float residue for 0.00 (5.68434e-14).

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
uint64  payerVat     the publishing organisation's VAT (`vatNumber` of /organizations/{uid}), numeric,
                     leading zeros dropped (090025537 -> 90025537). Not the typed payer: see below
uint64  payeeVat     first sponsor's AFM, 0 if none
uint128 amountCents  the sum of all sponsors' amounts in cents when every sponsor has the same payeeVat (as
                     stored, so 090025537 = 90025537) and currency; otherwise the first sponsor's; 0 if none
uint32  issueDate    unix day
bytes32 prevAnchor   actHash of the previous version, 0 for a first version
bytes32 contractRef  KIMDIS id packed, 0 if none found
address signer       set by the contract from msg.sender
uint64  anchoredAt   set by the contract from block.timestamp
bool    voided       true if this version voids the act
```

`payerVat` is the organisation that published the act, so the registry's signer check reads "this
organisation's key anchored this organisation's act". The payer typed into the act (`extraFieldValues.org.afm`)
is empty on most acts of some bodies (Amorgos 2025: 647 of 681 versions) and wrong on a few (Athens 2025: one
act with payer and payee swapped). It stays in `actHash` (§2), so it cannot change unnoticed, and `verify`
reports it as a data-quality note (§6). The registry does not tie an ADA to an organisation: any registered
signer can anchor any ADA under its own VAT. `verify` therefore raises an act of this organisation anchored
under another VAT (`foreign-anchor`), and `anchor` does not append to it. Before 2026-10-12 `payerVat` was the typed payer and acts without the
org's typed VAT could not be anchored; no anchors from that rule exist outside throwaway Anvil chains.

Multi-line acts (decided 2026-10-14): every sponsor line is in `actHash`. Lines that all name one payee in
one currency are one payment itemised (1,936 of 1,941 multi-line acts in five municipalities in 2025, up to
145 lines), so the anchor carries their sum and PaymentGate releases the whole bill. Known limitation: a
payment split between payees (5 acts, all Larissa 2025) exposes only its first line on-chain; `verify`
counts such acts and the amount left out. Before 2026-10-14 `amountCents` was always the first line; no
anchors from that rule exist outside throwaway Anvil chains.

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
  `NotPaymentAct`, `ActVoided`, `SelfPayment` (the anchor's payee is its payer, i.e. the publishing
  organisation: money coming in, such as an act typed with payer and payee swapped), `PayeeMismatch`,
  `AmountMismatch`, `AlreadyReleased`. On success marks
  released and calls `IEuroRail.settle(payerVat, payeeVat, amountCents, ada)`.
- `IEuroRail` is the bank-side adapter boundary. `MockRail` records calls and does nothing else.

### ProcurementGraph
- `registerAward(bytes32 contractRef, uint128 ceilingCents, uint32 cpv, uint32 kae)`: any registered signer;
  award's payer is the signer's org. One registration per ref.
- `linkPayment(bytes32 ada)`: permissionless. Requires the latest anchor to be non-void, to carry a known
  `contractRef`, to have the award's payer, and a payee other than that payer (`SelfPayment`). Counts each ADA once. Emits `PaymentLinked` and, when
  `paid > ceiling`, `Overrun`.
- `spentAgainst(contractRef) -> (ceiling, paid, payments)`.

## 6. Verifier behaviour

Signer keys (Phase 1 stand-in, `verifier/src/orgkeys.ts`): one key per Diavgeia organisation,
`keccak256(seed || "diavgeiaweb3/org-key/v1/" || uid)` (re-hashed with a counter if not a valid secp256k1
scalar). The seed is `DIAVGEIA_SIGNER_SEED`; a public development seed is used only against a local RPC and
refused otherwise. Whoever holds the seed signs for every organisation. `deploy` registers no signer. The
first `anchor`, `award` or `link` for an organisation registers its key with `setSigner(key, vat)`, where
`vat` is `vatNumber` from `/organizations/{uid}.json`, never the typed payer field. On Anvil the key is
funded by the admin; elsewhere an unfunded key is an error naming the address. `--vat` is accepted only when
the source has no organisation record, and must agree with it when there is one.

Signer checks (reported, never a gate: an act with a doubtful signer is still anchored, so later tampering
with it stays detectable): for each signer of each act's latest version, `/signers/{id}.json` must exist,
belong to the act's organisation, and be active on the issue day (`activeFrom` to `activeUntil`, compared
in days; `activeUntil` in the year 3000 means open-ended). Unit membership is not checked: directors sign
for units below their own (Athens 2025: 1,056 acts). `verify` and `page` list signers by id with act counts
and whether they hold organisation-level signing rights; names are not shown.

`anchor`: for each ADA in the search window, walk `/versionlog.json`, fetch earlier versions via
`/decisions/v/{id}.json`, anchor any versions the chain lacks, in order, chaining `prevAnchor`, each with the
organisation's VAT as `payerVat` (§4). Every earlier version must carry the latest version's `organizationId`;
otherwise the act is a `history-error`, since its anchor would claim another organisation's act.

`verify`: for each ADA the portal returns, compare chain versions against portal versions by hash,
position by position. Statuses:
`ok`, `void` (latest version voids; earlier versions still on chain), `unanchored`, `mismatch` (a version
both sides hold differs), `chain-ahead` (chain has versions the portal no longer shows), `chain-behind`
(chain holds a matching prefix of the portal's versions; the detail says whether the rest are merely not yet
anchored or blocked after a void), `foreign-anchor` (a version on chain carries another VAT than the
organisation's, §4; not counted in the chain total), `history-error`
(the portal contradicts itself about this act's history: the version log does not end with the version search
returned, a version record is for a different version, ADA or organisation, or the log or an earlier
version fails the shape checks of §8), `unsupported` (nothing anchored, and some version has an amount the
canonical form cannot hold, §2; not anchored, its amount in neither total, not an alarm). A search record
that fails §8 is not scoped to its act: it aborts the run, because the totals cannot be computed honestly
without it. An unsupported amount is not a §8 failure. It never hides tampering: when the chain already
holds the version that now carries it, the act is a `mismatch`; when it comes after the anchored versions,
`chain-behind` (blocked). Versions both sides hold are compared first, so nothing a later version carries
can hide an edit to an anchored one.
Then, for every ADA in the registry's `Anchored` logs whose latest anchor has the org's `payerVat` and an
`issueDate` inside the window but which the portal did not return: `portal-missing`. Its amount counts in
the chain total. The anchor holds the UTC day and the window is in Athens days, the same day or the next,
so UTC days `from..to-1` are inside; `from-1` and `to` are each inside or on the neighbouring day, and such an
anchor is skipped only if a one-day search of that neighbouring day returns it with the same UTC day (an
Athens-midnight act of that day, checked in its own window). Otherwise, including an act moved to another
day, it is `portal-missing`. On a recording, the neighbouring days are whatever the recording holds.
Limitation of canonical v1: the hash holds the UTC day only, so moving an act from 00:00 UTC to 21:00-23:59
UTC of the same UTC day changes its Athens day (and the window it is reported in) without changing its hash.
Prints portal and chain non-void totals and their difference. Exit 2 if any `mismatch`, `foreign-anchor`,
`chain-ahead`, `portal-missing` or `history-error` (also with `--json`). A `history-error` is scoped to its act: the run
carries on. A network or HTTP failure aborts the run (exit 1) rather than producing partial totals.
`chain-behind` and `unanchored` are lag, not disagreement.
Payer notes (reported, never a gate): how many latest versions leave the typed payer empty, and which name a
VAT other than the organisation's. `verify` prints those VATs; `page` lists the ADAs only.
A `--vat` given in place of the organisation record is the VAT every anchor carries and the key is registered
for, so `anchor`, `verify` and `page` check it against the acts that type a payer: with 3 or more, at least
half must carry it; with 1 or 2, at least one. With none, or no acts in the window, it cannot be checked and
the run is refused. The check trusts typed payers: a body that habitually types its parent's VAT would pass
with the parent's VAT, so the organisation record is the only sound source. `award` has no acts to check
against and requires the record. `anchor` registers nothing for an empty window.

The portal-missing scan reads `Anchored` logs from the registry's deployment block (`deployBlock` in
`deployment.json`; 0 if absent) to the head pinned at the start, in ranges of `LOG_BLOCK_RANGE` blocks
(default 10,000, a common hosted-RPC cap). It filters by VAT only: two Diavgeia organisations sharing a
`vatNumber` would see each other's anchors as `portal-missing`. Not seen so far; unverified.

`page`: the same reconciliation rendered as one static HTML file (no scripts, no external requests). It
shows ADAs, statuses and amounts only; subjects and payee names are left out. It states its data source
(live or fixture) and the caveats on the totals. When at least a tenth of the acts state no amount it says so beside the totals.
`verify` and `page` give the sum of the payee lines after the first (portal side, non-void, supported acts),
which neither total counts. Same exit code as `verify`.

`anchor` skips an act whose history is a `history-error`, or whose anchored versions the portal now
contradicts (verify's `mismatch`; it never appends to such a chain), with exit 2. It checks each version before sending it,
with the same rule the report uses (`anchorBlocker`): any version after a void, or with an amount the
canonical form cannot hold, is not sent, and neither is anything after it; earlier versions of that act are still
anchored. These registry refusals are logged and exit 0, since they are permanent facts about the data that
`verify` reports. Any other revert is logged per act; an RPC failure aborts.

`record --out f.json`: fetches a window and every act's history once (4 requests at a time) and saves it in
the fixture format, so `anchor`, `verify` and `page` can run offline on it.

`live-check --fixture f.json`: re-runs the search in the fixture's `_source` against the live API and
compares canonical hashes per versionId (for a record with an unhashable amount, §2: the raw amounts, and the
hash of the record with amounts removed). Reports acts missing on either side, live versions newer than the
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
  31 March. The client sends `to + 1 day`. The range is inclusive at both ends (verified 2026-10-14): for a
  body that stores `issueDate` at Athens midnight (Piraeus), 2025-03-31..2025-04-01 returns the 26 acts of 31
  March and the 25 of 1 April, which 2025-04-01..2025-04-02 returns too. The client counts an act exactly at
  the upper bound for paging and drops it: it belongs to the next day.
- `issueDate` is 00:00 UTC on all but one of 5,667 Athens 2025 versions (one at 06:54 UTC). Piraeus 2025
  stores some at Athens midnight (21:00 or 22:00 UTC the day before), which the API returns for the Athens
  day. The window check therefore uses the Athens day (§8). The canonical `issueDay` and the anchor's
  `issueDate` stay `floor(ms / 86400000)`, the UTC day, which for such acts is the day before.
- Version log `status` was `PUBLISHED` on every entry of Athens 2025.
- `/organizations/{uid}.json` has `vatNumber` (9 digits), `label`, `category`, `status`. 6013 is the
  Municipality of Athens (090025537), 6027 the Municipality of Amorgos (090256954), checked 2026-10-12.
- `/signers/{id}.json` has `organizationId`, `activeFrom`, `activeUntil`, `hasOrganizationSignRights` and
  `units[]` (uid, positionLabel), plus names. Open-ended signers have `activeUntil` in the year 3000.
- The typed payer `extraFieldValues.org` is `null` on 647 of Amorgos' 681 versions in 2025, and the payee
  VAT is often absent too. Athens fills it on 5,665 of 5,667. Do not assume other bodies type it.
- Β.2.2 acts carry no KAE or CPV. Those are on the commitment act (Β.2.1) and the KIMDIS award.

## 8. Ingestion checks (`verifier/src/validate.ts`, `diavgeia.ts`)

Every record, from the live API or a fixture, passes these before it is hashed or summed. A failure is an
error, never a default.

- Types of every field the canonical form or the anchor reads: `ada`, `versionId`, `organizationId`,
  `decisionTypeId` non-empty strings; `subject` string; `issueDate` integer; `signerIds` array of strings,
  or missing or null (hashed as `[]`);
  `correctedVersionId`, `protocolNumber`, org and payee strings or null.
- `ada` at most 32 UTF-8 bytes (it must fit `adaKey`).
- Amounts: a finite number or absent; anything else is malformed and aborts. A well-formed amount the
  canonical form cannot hold (negative, above 1e12 EUR, more than two decimals; §2) is not a shape error: its
  act is reported as `unsupported` (§6) and the run carries on. The cap matters: above about 7e13 adjacent
  doubles are more than a cent apart and the two-decimal test stops being exact. Tested by sampling the whole
  range up to the cap.
- Search: `info.actualSize` equals the number of decisions; every act has the requested `org` and `type`
  (NFC) and an `issueDate` whose Athens calendar day is inside the requested window, as the API runs it
  (§7). FixtureClient filters with the same function (`outsideQuery`), so a recorded run replays to the same
  acts.
- Paging is counted per window. A window whose distinct versions do not equal its `info.total` is an error
  (catches an ignored `page` parameter). The live client uses 90-day windows, half the observed 180-day
  clamp, so an off-by-one in the API's convention cannot drop a day.
- Version log: non-empty, for the requested ADA, and its latest entry is the version search returned.
- Organisation record: `uid` is the one asked for, `vatNumber` is 9 digits. Signer record: `uid` is the one
  asked for, `organizationId` a string, `activeFrom`/`activeUntil` integers, `hasOrganizationSignRights` a
  boolean. A malformed signer record becomes a signer issue, not an abort.
- HTTP: 404 means absent; 429, 5xx and network errors are retried 3 times with backoff; anything else, and
  a non-JSON body, is an error.
