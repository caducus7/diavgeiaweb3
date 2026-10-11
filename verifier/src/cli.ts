#!/usr/bin/env tsx
/**
 * diavgeia-verifier
 *
 *   deploy  --org 6013 --vat 090025537
 *   anchor  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   verify  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   page    --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30 --out out/6013.html
 *   pay     --ada 9ΓΒΝΩ6Μ-Λ4Η            (simulate treasury release through PaymentGate)
 *   award   --ref 24SYMV015873979 --ceiling 30000.00 --cpv 44810000 --kae 6261
 *   link    --ada 9ΓΒΝΩ6Μ-Λ4Η            (link an anchored payment to its award)
 *
 * Set DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json to run without network.
 */
import { parseArgs } from "node:util";
import { makeClient } from "./diavgeia.js";
import { actHash, adaKey, toCents, isVoid } from "./canonical.js";
import {
  deploy, loadDeployment, anchorOne, readVersions, gate, graph, ZERO32, publicClient, chainReader,
} from "./chain.js";
import { buildReport, versionsOf, formatEur, reportJson, type ReportParams } from "./report.js";
import { renderPage } from "./page.js";
import { mkdirSync, writeFileSync } from "node:fs";
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
  },
});

const cmd = positionals[0];
const client = makeClient();
const eur = formatEur;

async function cmdDeploy() {
  const d = await deploy(a.vat!);
  console.log(`deployed\n  ActRegistry      ${d.registry}\n  PaymentGate      ${d.gate}\n  ProcurementGraph ${d.graph}\n  MockRail         ${d.rail}\n  signer ${d.signer} -> org VAT ${d.signerOrgVat}`);
}

async function cmdAnchor() {
  const dep = loadDeployment();
  const latest = await client.search({ org: a.org!, type: a.type!, fromIssueDate: a.from!, toIssueDate: a.to! });
  console.log(`${latest.length} acts from Diavgeia (org ${a.org}, ${a.type}, ${a.from}..${a.to})`);
  let anchored = 0, skipped = 0;
  for (const l of latest) {
    const vs = await versionsOf(client, l);
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
  console.log(`done: ${anchored} versions anchored, ${skipped} ADAs already current`);
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

const cmds: Record<string, () => Promise<void>> = { deploy: cmdDeploy, anchor: cmdAnchor, verify: cmdVerify, page: cmdPage, pay: cmdPay, award: cmdAward, link: cmdLink };
if (!cmd || !cmds[cmd]) { console.error(`usage: cli <${Object.keys(cmds).join("|")}> [options]`); process.exit(1); }
cmds[cmd]().catch((e) => { console.error(e); process.exit(1); });
