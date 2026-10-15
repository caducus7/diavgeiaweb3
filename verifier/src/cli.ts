#!/usr/bin/env tsx
/**
 * diavgeia-verifier
 *
 *   deploy  --org 6013 --vat 090025537
 *   anchor  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   verify  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   live-check [--fixture fixtures/athens-2025-11.json]   (first run with network: fixture vs live API)
 *   record  --org 6013 --type Β.2.2 --from 2025-01-01 --to 2025-12-31 --out f.json [--concurrency 4]
 *   page    --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30 --out out/6013.html
 *   pay     --ada 9ΓΒΝΩ6Μ-Λ4Η            (simulate treasury release through PaymentGate)
 *   award   --ref 24SYMV015873979 --ceiling 30000.00 --cpv 44810000 --kae 6261
 *   link    --ada 9ΓΒΝΩ6Μ-Λ4Η            (link an anchored payment to its award)
 *
 * Set DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json to run without network.
 * Set DIAVGEIA_RECORD=path.json on a live run to save every record fetched, in the fixture format.
 */
import { parseArgs } from "node:util";
import { makeClient, BASE } from "./diavgeia.js";
import { RecordingClient, prefetch } from "./record.js";
import { liveCheck, type FixtureFile } from "./livecheck.js";
import { parseDecision } from "./validate.js";
import { actHash, adaKey, anchorPayment, toCents, isVoid, vatToUint, unsupportedAmount } from "./canonical.js";
import { isPerActError } from "./validate.js";
import {
  deploy, loadDeployment, anchorOne, readVersions, gate, graph, ZERO32, publicClient, chainReader, ensureOrgSigner, isLocalChain, ADMIN_KEY,
  type Deployment,
} from "./chain.js";
import { deriveOrgKey, resolveSeed } from "./orgkeys.js";
import { buildReport, versionsOf, formatEur, reportJson, anchorBlocker, checkFallbackVat, foreignAnchor, type ReportParams } from "./report.js";
import { renderPage } from "./page.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEventLogs, BaseError, ContractFunctionRevertedError, type Hex } from "viem";

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    org: { type: "string", default: "6013" },
    vat: { type: "string" }, // only when no /organizations record is available; must agree with it otherwise
    type: { type: "string", default: "Β.2.2" },
    from: { type: "string", default: "2025-11-24" },
    to: { type: "string", default: "2025-11-30" },
    ada: { type: "string" },
    ref: { type: "string" },
    ceiling: { type: "string" },
    cpv: { type: "string", default: "0" },
    kae: { type: "string", default: "0" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    fixture: { type: "string", default: "fixtures/athens-2025-11.json" },
    concurrency: { type: "string", default: "4" },
  },
});

const cmd = positionals[0];
const RECORD = process.env.DIAVGEIA_RECORD;
if (RECORD && process.env.DIAVGEIA_FIXTURE) { console.error("DIAVGEIA_RECORD records live runs; unset DIAVGEIA_FIXTURE"); process.exit(1); }
const recorder = RECORD ? new RecordingClient(makeClient(), BASE) : null;
const client = recorder ?? makeClient();
const eur = formatEur;

/** The organisation's VAT from Diavgeia's own record (`/organizations/{uid}.json`), not from what acts type in.
 *  --vat is accepted only as a fallback when there is no record (an older recording), and must agree with it. */
async function orgVatSourced(): Promise<{ vat: string; fromRegistry: boolean }> {
  const o = await client.organization(a.org!);
  if (o) {
    if (a.vat && a.vat !== o.vatNumber) throw new Error(`--vat ${a.vat} contradicts Diavgeia's record for org ${a.org} (${o.vatNumber})`);
    return { vat: o.vatNumber, fromRegistry: true };
  }
  if (a.vat) { console.warn(`  ! no organisation record for ${a.org} in this source; using --vat ${a.vat}`); return { vat: a.vat, fromRegistry: false }; }
  throw new Error(`no /organizations/${a.org} record in this source; pass --vat`);
}

/** The organisation's derived anchoring key, registered (and funded on Anvil) if it is not yet a signer. */
async function orgSigner(dep: Deployment, vat: string): Promise<Hex> {
  const key = deriveOrgKey(resolveSeed(process.env, await isLocalChain()), a.org!);
  const { address, registered } = await ensureOrgSigner(dep, a.org!, vat, key);
  if (registered) console.log(`  registered org ${a.org} signer ${address} for VAT ${vat}`);
  return key;
}

async function cmdDeploy() {
  const d = await deploy();
  console.log(`deployed\n  ActRegistry      ${d.registry}\n  PaymentGate      ${d.gate}\n  ProcurementGraph ${d.graph}\n  MockRail         ${d.rail}\n  org signers are derived and registered on first anchor`);
}

async function cmdAnchor() {
  const dep = loadDeployment();
  const { vat, fromRegistry } = await orgVatSourced();
  const latest = await client.search({ org: a.org!, type: a.type!, fromIssueDate: a.from!, toIssueDate: a.to! });
  // Every anchor will carry this VAT and the key is registered for it, so a fallback --vat is checked first.
  if (!fromRegistry) checkFallbackVat(latest, a.org!, vat);
  console.log(`${latest.length} acts from Diavgeia (org ${a.org}, ${a.type}, ${a.from}..${a.to})`);
  if (!latest.length) return; // nothing to anchor, so no reason to register a key
  const key = await orgSigner(dep, vat);
  let anchored = 0, skipped = 0, failed = 0, refused = 0, foreign = 0, mismatched = 0;
  for (const l of latest) {
    let vs;
    try { vs = await versionsOf(client, l); }
    catch (e) {
      // Do not anchor an act whose history the portal contradicts; anchor the rest.
      if (!isPerActError(e)) throw e;
      failed++;
      console.warn(`  ! skipped ${l.ada}: ${e.message}`);
      continue;
    }
    const onChain = await readVersions(dep, l.ada);
    const notOurs = foreignAnchor(onChain, vatToUint(vat));
    if (notOurs) { foreign++; console.warn(`  ! not anchored ${l.ada}: ${notOurs}; verify reports it as an alarm`); continue; }
    // Never append to a chain the portal now contradicts: verify reports that act as a mismatch.
    const differs = onChain.findIndex((c, i) => i < vs.length && (unsupportedAmount(vs[i]) !== null || c.actHash !== actHash(vs[i])));
    if (differs >= 0) { mismatched++; console.warn(`  ! not anchored ${l.ada}: version ${differs + 1} on chain differs from the portal's; verify reports it as an alarm`); continue; }
    if (vs.length <= onChain.length) { skipped++; continue; }
    let prev: Hex = onChain.length ? onChain[onChain.length - 1].actHash : ZERO32;
    let lastVoided = onChain.length ? onChain[onChain.length - 1].voided : null;
    for (let i = onChain.length; i < vs.length; i++) {
      const d = vs[i];
      // The registry's own refusals, checked per version so earlier good versions still go on chain.
      const why = anchorBlocker(d, lastVoided === null ? null : { voided: lastVoided });
      if (why) {
        refused++;
        console.warn(`  ! not anchored ${d.ada} v${i + 1}${i + 1 < vs.length ? ` (and ${vs.length - i - 1} later)` : ""}: ${why}`);
        break;
      }
      let v: number;
      try { v = await anchorOne(dep, d, prev, key, vat); }
      catch (e) {
        // A contract refusal concerns this act only; anything else (RPC down) aborts.
        if (!(e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError))) throw e;
        refused++;
        console.warn(`  ! not anchored ${d.ada} v${i + 1}: registry refused with ${revertName(e)}`);
        break;
      }
      prev = actHash(d);
      lastVoided = isVoid(d.subject);
      anchored++;
      console.log(`  anchored ${d.ada} v${v} ${isVoid(d.subject) ? "[VOID] " : ""}${eur(anchorPayment(d).amountCents)}  ${actHash(d).slice(0, 18)}…`);
    }
  }
  console.log(`done: ${anchored} versions anchored, ${skipped} ADAs already current`
    + (failed ? `, ${failed} skipped on portal errors` : "") + (refused ? `, ${refused} refused by registry rules (see above)` : "")
    + (foreign ? `, ${foreign} anchored by another organisation's key (see above)` : "")
    + (mismatched ? `, ${mismatched} whose anchored versions the portal now contradicts (see above)` : ""));
  // Registry refusals are permanent facts about the data (verify reports them, not as alarms); exit 2 is kept
  // for portal inconsistencies, which may change between runs, and for another organisation's anchors.
  if (failed || foreign || mismatched) process.exitCode = 2;
}

const params = async (): Promise<ReportParams> => {
  const { vat, fromRegistry } = await orgVatSourced();
  return { org: a.org!, orgVat: vat, vatFromRegistry: fromRegistry, type: a.type!, from: a.from!, to: a.to! };
};

async function cmdVerify() {
  const r = await buildReport(client, chainReader(loadDeployment()), await params());
  if (a.json) { console.log(JSON.stringify(reportJson(r), null, 2)); }
  else {
    console.log(`verify: org ${a.org}, ${a.type}, ${a.from}..${a.to}`);
    for (const f of r.findings) console.log(`  ${f.status.padEnd(14)} ${f.ada.padEnd(12)} ${f.detail}`);
    console.log(`\n  portal total (non-void)  ${eur(r.portalTotal)}\n  chain total  (non-void)  ${eur(r.chainTotal)}\n  difference               ${eur(r.difference)}`);
    console.log(`  ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (r.multiPayee) console.log(`  note: ${r.multiPayee} act(s) with more than one line, summed when they name one payee`);
    if (r.multiNoPayee) console.log(`  note: ${r.multiNoPayee} multi-line act(s) name no payee (payroll, remittances), ${eur(r.multiNoPayeeCents)} in both totals`);
    if (r.splitPayee) console.log(`  note: ${r.splitPayee} act(s) split between payees; totals count the first line only, missing ${eur(r.splitUncounted)} (portal side)`);
    if (r.noAmount) console.log(`  note: ${r.noAmount} of ${r.acts} act(s) state no amount; neither total sees them`);
    console.log(`  signers: ${r.signers.map((s) => `${s.id} (${s.acts} acts, org-level rights ${s.orgSignRights === null ? "unknown" : s.orgSignRights ? "yes" : "no"})`).join(", ") || "none"}`);
    for (const i of r.signerIssues) console.log(`  signer issue ${i.ada} ${i.signerId}: ${i.issue}`);
    const pn = r.payerNotes;
    if (pn.empty || pn.other.length) console.log(`  typed payer: empty on ${pn.empty} act(s), another VAT on ${pn.other.length} (anchors carry the org's VAT)`);
    for (const o of pn.other) console.log(`  typed payer ${o.ada}: ${o.typedVat}`);
  }
  if (r.alarm) process.exitCode = 2;
}

async function cmdPage() {
  const dep = loadDeployment();
  const r = await buildReport(client, chainReader(dep), await params());
  const out = a.out ?? `out/${a.org}-${a.from}-${a.to}.html`;
  mkdirSync(dirname(out), { recursive: true });
  const fixture = process.env.DIAVGEIA_FIXTURE;
  writeFileSync(out, renderPage(r, {
    source: fixture ? "fixture" : "live", fixturePath: fixture, generatedAt: new Date(),
    registry: dep.registry, chainId: await publicClient.getChainId(),
  }));
  console.log(`wrote ${out}: portal ${eur(r.portalTotal)}, chain ${eur(r.chainTotal)}, difference ${eur(r.difference)}${r.alarm ? "  ** DISAGREEMENT **" : ""}`);
  if (r.alarm) process.exitCode = 2;
}

/** Fetch a window and every act's history once, save it as a fixture, and run anchor/verify/page offline on it.
 *  Kinder to the API than three live passes, and the result is replayable. */
async function cmdRecord() {
  if (process.env.DIAVGEIA_FIXTURE) throw new Error("record fetches from the live API; unset DIAVGEIA_FIXTURE");
  if (!a.out) throw new Error("--out path.json required");
  const rec = new RecordingClient(makeClient(), BASE);
  const t0 = Date.now();
  let last = 0;
  let r;
  try {
    r = await prefetch(rec, { org: a.org!, type: a.type!, fromIssueDate: a.from!, toIssueDate: a.to! }, Number(a.concurrency), (done, total) => {
      if (done === total || Date.now() - last > 30_000) { last = Date.now(); console.error(`  ${done}/${total} acts`); }
    });
  } catch (e) {
    // Keep what was fetched, marked partial, so the failure can be replayed without refetching.
    if (rec.size) { rec.save(a.out, new Date(), String((e as Error)?.message ?? e)); console.error(`partial recording (${rec.size} records) saved to ${a.out}`); }
    throw e;
  }
  rec.save(a.out);
  console.log(`recorded ${r.acts} acts, ${r.versions} versions (${rec.size} records) to ${a.out} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const e of r.perActErrors) console.log(`  history-error ${e.ada}: ${e.error}`);
  for (const m of r.missingVersions) console.log(`  missing version ${m}`);
  for (const s of r.signerErrors) console.log(`  signer ${s.id} not recorded: ${s.error}`);
  if (r.perActErrors.length || r.missingVersions.length || r.signerErrors.length) process.exitCode = 2;
}

async function cmdLiveCheck() {
  if (process.env.DIAVGEIA_FIXTURE) throw new Error("live-check compares a fixture with the live API; unset DIAVGEIA_FIXTURE and pass --fixture");
  const fx = JSON.parse(readFileSync(a.fixture!, "utf8")) as FixtureFile;
  if (!Array.isArray(fx?.decisions)) throw new Error(`${a.fixture}: no decisions array`);
  fx.decisions.forEach((d, i) => parseDecision(d, `${a.fixture} decisions[${i}]`));
  const lines = await liveCheck(client, fx);
  console.log(`live-check: ${a.fixture} against the live API`);
  for (const l of lines) console.log(`  ${l.ok ? "ok  " : "DIFF"} ${l.what.padEnd(40)} ${l.detail}`);
  const bad = lines.filter((l) => !l.ok).length;
  console.log(bad ? `\n  ${bad} difference(s). A verbatim record that differs blocks trusting anchors; see CONTEXT.md.` : "\n  fixture matches the live API");
  if (bad) process.exitCode = 2;
}

async function cmdPay() {
  const dep = loadDeployment();
  if (!a.ada) throw new Error("--ada required");
  const vs = await readVersions(dep, a.ada);
  if (!vs.length) { console.log(`refused: ${a.ada} is not anchored (NotAnchored)`); return; }
  const last = vs[vs.length - 1];
  try {
    const h = await gate(dep).write.release([adaKey(a.ada), last.payeeVat, last.amountCents]);
    const rc = await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`released ${eur(last.amountCents)} to VAT ${last.payeeVat} for ${a.ada} (tx ${rc.transactionHash.slice(0, 12)}…, ${rc.gasUsed} gas)`);
  } catch (e) {
    console.log(`refused: ${revertName(e)}`);
  }
}

async function cmdAward() {
  const dep = loadDeployment();
  if (!a.ref || !a.ceiling) throw new Error("--ref and --ceiling required");
  // No acts to check a fallback --vat against, and the key registration it would make is permanent.
  const { vat, fromRegistry } = await orgVatSourced();
  if (!fromRegistry) throw new Error(`award needs Diavgeia's organisation record for org ${a.org}; --vat cannot be checked here`);
  const key = await orgSigner(dep, vat);
  const h = await graph(dep, key).write.registerAward([adaKey(a.ref), toCents(Number(a.ceiling)), Number(a.cpv), Number(a.kae)]);
  await publicClient.waitForTransactionReceipt({ hash: h });
  console.log(`award ${a.ref} registered, ceiling ${eur(toCents(Number(a.ceiling)))}`);
}

async function cmdLink() {
  const dep = loadDeployment();
  if (!a.ada) throw new Error("--ada required");
  // linkPayment is permissionless: any funded key will do, so no org key, seed or org record is needed
  const g = graph(dep, ADMIN_KEY);
  const h = await g.write.linkPayment([adaKey(a.ada)]);
  const rc = await publicClient.waitForTransactionReceipt({ hash: h });
  const vs = await readVersions(dep, a.ada);
  const ref = vs[vs.length - 1].contractRef;
  const [ceiling, paid, n] = (await g.read.spentAgainst([ref])) as [bigint, bigint, number];
  const overrun = parseEventLogs({ abi: g.abi, logs: rc.logs, eventName: "Overrun" }).length > 0;
  console.log(`linked ${a.ada}: ceiling ${eur(ceiling)}, paid ${eur(paid)} over ${n} payment(s)${overrun ? "  ** OVERRUN **" : ""}`);
}

function revertName(e: unknown): string {
  // viem wraps the decoded custom error a few levels down
  let cur: any = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.data?.errorName) return `${cur.data.errorName}()`;
    if (cur.name === "ContractFunctionRevertedError" && cur.reason) return cur.reason;
    cur = cur.cause;
  }
  return (e as Error).message.split("\n")[0];
}

const cmds: Record<string, () => Promise<void>> = { deploy: cmdDeploy, anchor: cmdAnchor, verify: cmdVerify, page: cmdPage, "live-check": cmdLiveCheck, record: cmdRecord, pay: cmdPay, award: cmdAward, link: cmdLink };
if (!cmd || !cmds[cmd]) { console.error(`usage: cli <${Object.keys(cmds).join("|")}> [options]`); process.exit(1); }
/** Save what a live run fetched. Never writes an empty file (deploy, pay, ... fetch nothing), and keeps a
 *  partial recording of a failed run, marked as such, so the failure can be replayed offline. */
function saveRecording(failure?: string) {
  if (!recorder || !RECORD || recorder.size === 0) return;
  recorder.save(RECORD, new Date(), failure);
  console.error(`recorded ${recorder.size} record(s) to ${RECORD}${failure ? " (partial: the run failed)" : ""}`);
}

cmds[cmd]()
  .then(() => saveRecording())
  .catch((e) => { saveRecording(String((e as Error)?.message ?? e)); console.error(e); process.exit(1); });
