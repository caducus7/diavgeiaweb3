#!/usr/bin/env tsx
/**
 * diavgeia-verifier
 *
 *   deploy  --org 6013 --vat 090025537
 *   anchor  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   verify  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   live-check [--fixture fixtures/athens-2025-11.json]   (first run with network: fixture vs live API)
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
import { RecordingClient } from "./record.js";
import { liveCheck, type FixtureFile } from "./livecheck.js";
import { parseDecision } from "./validate.js";
import { actHash, adaKey, toCents, isVoid } from "./canonical.js";
import { isPerActError } from "./validate.js";
import {
  deploy, loadDeployment, anchorOne, readVersions, gate, graph, ZERO32, publicClient, chainReader,
} from "./chain.js";
import { buildReport, versionsOf, formatEur, reportJson, type ReportParams } from "./report.js";
import { renderPage } from "./page.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEventLogs, type Hex } from "viem";

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    org: { type: "string", default: "6013" },
    vat: { type: "string", default: "090025537" },
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
  },
});

const cmd = positionals[0];
const RECORD = process.env.DIAVGEIA_RECORD;
if (RECORD && process.env.DIAVGEIA_FIXTURE) { console.error("DIAVGEIA_RECORD records live runs; unset DIAVGEIA_FIXTURE"); process.exit(1); }
const recorder = RECORD ? new RecordingClient(makeClient(), BASE) : null;
const client = recorder ?? makeClient();
const eur = formatEur;

async function cmdDeploy() {
  const d = await deploy(a.vat!);
  console.log(`deployed\n  ActRegistry      ${d.registry}\n  PaymentGate      ${d.gate}\n  ProcurementGraph ${d.graph}\n  MockRail         ${d.rail}\n  signer ${d.signer} -> org VAT ${d.signerOrgVat}`);
}

async function cmdAnchor() {
  const dep = loadDeployment();
  const latest = await client.search({ org: a.org!, type: a.type!, fromIssueDate: a.from!, toIssueDate: a.to! });
  console.log(`${latest.length} acts from Diavgeia (org ${a.org}, ${a.type}, ${a.from}..${a.to})`);
  let anchored = 0, skipped = 0, failed = 0;
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
    let prev: Hex = onChain.length ? onChain[onChain.length - 1].actHash : ZERO32;
    for (let i = onChain.length; i < vs.length; i++) {
      const d = vs[i];
      const v = await anchorOne(dep, d, prev);
      prev = actHash(d);
      anchored++;
      console.log(`  anchored ${d.ada} v${v} ${isVoid(d.subject) ? "[VOID] " : ""}${eur(toCents(d.extraFieldValues?.sponsor?.[0]?.expenseAmount?.amount))}  ${actHash(d).slice(0, 18)}…`);
    }
    if (vs.length <= onChain.length) skipped++;
  }
  console.log(`done: ${anchored} versions anchored, ${skipped} ADAs already current${failed ? `, ${failed} skipped on portal errors` : ""}`);
  if (failed) process.exitCode = 2;
}

const params = (): ReportParams => ({ org: a.org!, orgVat: a.vat!, type: a.type!, from: a.from!, to: a.to! });

async function cmdVerify() {
  const r = await buildReport(client, chainReader(loadDeployment()), params());
  if (a.json) { console.log(JSON.stringify(reportJson(r), null, 2)); }
  else {
    console.log(`verify: org ${a.org}, ${a.type}, ${a.from}..${a.to}`);
    for (const f of r.findings) console.log(`  ${f.status.padEnd(14)} ${f.ada.padEnd(12)} ${f.detail}`);
    console.log(`\n  portal total (non-void)  ${eur(r.portalTotal)}\n  chain total  (non-void)  ${eur(r.chainTotal)}\n  difference               ${eur(r.difference)}`);
    console.log(`  ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (r.multiPayee) console.log(`  note: ${r.multiPayee} multi-payee act(s); totals count the first payee only`);
  }
  if (r.alarm) process.exitCode = 2;
}

async function cmdPage() {
  const dep = loadDeployment();
  const r = await buildReport(client, chainReader(dep), params());
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
  const h = await graph(dep).write.registerAward([adaKey(a.ref), toCents(Number(a.ceiling)), Number(a.cpv), Number(a.kae)]);
  await publicClient.waitForTransactionReceipt({ hash: h });
  console.log(`award ${a.ref} registered, ceiling ${eur(toCents(Number(a.ceiling)))}`);
}

async function cmdLink() {
  const dep = loadDeployment();
  if (!a.ada) throw new Error("--ada required");
  const g = graph(dep);
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

const cmds: Record<string, () => Promise<void>> = { deploy: cmdDeploy, anchor: cmdAnchor, verify: cmdVerify, page: cmdPage, "live-check": cmdLiveCheck, pay: cmdPay, award: cmdAward, link: cmdLink };
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
