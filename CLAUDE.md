# diavgeiaweb3

Tamper-evidence and enforcement layer under Greece's Diavgeia public-acts portal. Read `docs/CONTEXT.md`
first in any new session: it holds the decisions already made and the open questions. `docs/SPEC.md` is
the normative spec for the canonical hash and the contract interfaces. The original plan lives in the
Claude doc "Diavgeia on-chain: a plan"; `docs/CONTEXT.md` summarises it.

## Layout

- `contracts/` Foundry. `src/` has ActRegistry, PaymentGate, ProcurementGraph, MockRail. `test/Diavgeia.t.sol`.
  `lib/forge-std` is vendored on purpose (see Environment).
- `verifier/` TypeScript, ESM, Node 22. `src/canonical.ts` is the spec implementation; `src/diavgeia.ts` the
  OpenData client; `src/chain.ts` viem glue; `src/report.ts` the portal vs chain reconciliation (pure, tested
  without Anvil); `src/page.ts` the static page; `src/cli.ts` the commands. `fixtures/` holds real records.
- `docs/` SPEC.md (normative), CONTEXT.md (decisions, findings, open questions).

## Commands

```sh
cd contracts && forge test                         # must stay green: 20 tests
cd verifier && npm ci && npm test && npm run typecheck
anvil &  # then, from verifier/:
DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json npx tsx src/cli.ts deploy
DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json npx tsx src/cli.ts anchor
DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json npx tsx src/cli.ts verify   # exit 2 on any disagreement
DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json npx tsx src/cli.ts page     # writes out/<org>-<from>-<to>.html
```

Unset `DIAVGEIA_FIXTURE` to use the live API at https://diavgeia.gov.gr/opendata.

## Environment notes (cloud sandboxes)

- Foundry: `foundry.paradigm.xyz` may be blocked. The GitHub release works:
  `https://github.com/foundry-rs/foundry/releases/download/stable/foundry_stable_linux_amd64.tar.gz`.
- solc: `binaries.soliditylang.org` may be blocked. Download
  `https://github.com/ethereum/solidity/releases/download/v0.8.28/solc-static-linux`, `chmod +x`, then run
  `FOUNDRY_SOLC=/abs/path/solc-0.8.28 forge test`. Don't commit a local path into `foundry.toml`.
- `diavgeia.gov.gr` may be blocked from the shell. Check with `curl -sI https://diavgeia.gov.gr/opendata/organizations/6013.json`
  before assuming the live client works. If blocked, work from fixtures and say so.
- Anvil default account 0 key ends in `...d7bf4f2ff80`. A typo here cost an hour once.

## Rules

- `forge test` and `npm test` green before any commit. The pinned hash test in `verifier/test/canonical.test.ts`
  is the spec: if it fails, you changed the canonical form. Either revert, or bump `CANONICAL_VERSION`,
  update `docs/SPEC.md`, and say in the commit that all prior anchors are invalidated.
- Contracts are append-only by design. Never add an overwrite, delete, or admin override of an anchor.
  Admin can only set signers.
- Amounts are integer cents (`uint128`) on-chain and `bigint` in TS. Never a float past `toCents()`.
- Keep payee names off-chain. VAT numbers are on-chain; whether that survives GDPR review is open
  (CONTEXT.md). Do not add more personal data to the anchor struct.
- Diavgeia data is untrusted input: validate shape, never `eval`, and treat subjects as free text.
- Fixture records are real public acts. Do not edit them except to add more verbatim records; if a record is
  reconstructed rather than verbatim, mark it `_reconstructed: true`.
- Greek text: NFC everywhere. The act type is `Β.2.2` with a Greek Β (U+0392) in the API and ASCII `B.2.2`
  on-chain; `actTypeKey()` maps it. Don't "fix" one side.
- No em dashes in prose. British spelling in docs.

## Where things are headed

Phase 1 (this repo): civic verifier, no permission needed. Phase 2: signer keys issued to staff, bodies
anchor at signing, KAE/CPV on payment acts, KIMDIS award events. Phase 3: Treasury routes disbursement through
PaymentGate; needs an amendment to Law 3861/2010. Details and gates in CONTEXT.md.
