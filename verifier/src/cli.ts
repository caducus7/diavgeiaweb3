#!/usr/bin/env tsx
/**
 * diavgeia-verifier
 *
 *   deploy  --org 6013 --vat 090025537
 *   anchor  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   verify  --org 6013 --type Β.2.2 --from 2025-11-24 --to 2025-11-30
 *   pay     --ada 9ΓΒΝΩ6Μ-Λ4Η            (simulate treasury release through PaymentGate)
 *   award   --ref 24SYMV015873979 --ceiling 30000.00 --cpv 44810000 --kae 6261
 *   link    --ada 9ΓΒΝΩ6Μ-Λ4Η            (link an anchored payment to its award)
 *
 * Set DIAVGEIA_FIXTURE=fixtures/athens-2025-11.json to run without network.
 */
import { parseArgs } from "node:util";
import { makeClient } from "./diavgeia.js";
import { actHash, adaKey, toCents, isVoid, contractRefFromSubject, type DiavgeiaDecision } from "./canonical.js";
import {
  deploy, loadDeployment, anchorOne, readVersions, gate, graph, registry, ZERO32, publicClient, type AnchorStruct,
} from "./chain.js";
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
  },
});

const cmd = positionals[0];
const client = makeClient();
const eur = (c: bigint) => (Number(c) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 }) + " EUR";

/** All versions of an ADA, oldest first, using the version log where the API has one. */
async function versionsOf(latest: DiavgeiaDecision): Promise<DiavgeiaDecision[]> {
  const log = await client.versionLog(latest.ada);
  if (!log || log.versions.length <= 1) return [latest];
  const ordered = [...log.versions].sort((x, y) => x.versionTimestamp - y.versionTimestamp);
  const out: DiavgeiaDecision[] = [];
  for (const v of ordered) {
    if (v.versionId === latest.versionId) { out.push(latest); continue; }
    const d = await client.decisionVersion(v.versionId);
    if (d) out.push(d);
    else console.warn(`  ! version ${v.versionId} of ${latest.ada} not retrievable; chain will start at a later version`);
  }
  return out;
}

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
    const vs = await versionsOf(l);
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

interface Finding { ada: string; status: "ok" | "unanchored" | "mismatch" | "chain-ahead" | "void"; detail: string }

async function cmdVerify() {
  const dep = loadDeployment();
  const latest = await client.search({ org: a.org!, type: a.type!, fromIssueDate: a.from!, toIssueDate: a.to! });
  const findings: Finding[] = [];
  let portalTotal = 0n, chainTotal = 0n;

  for (const l of latest) {
    const vs = await versionsOf(l);
    const onChain = await readVersions(dep, l.ada);
    const amount = toCents(l.extraFieldValues?.sponsor?.[0]?.expenseAmount?.amount);
    const voided = isVoid(l.subject);
    if (!voided) portalTotal += amount;

    if (onChain.length === 0) { findings.push({ ada: l.ada, status: "unanchored", detail: `portal has ${vs.length} version(s), chain has none` }); continue; }

    const last = onChain[onChain.length - 1];
    if (!last.voided) chainTotal += last.amountCents;

    const expected = actHash(l);
    if (last.actHash !== expected) {
      findings.push({ ada: l.ada, status: "mismatch", detail: `chain v${onChain.length} ${last.actHash.slice(0, 12)}… but portal's current version hashes to ${expected.slice(0, 12)}…` });
      continue;
    }
    if (onChain.length > vs.length) { findings.push({ ada: l.ada, status: "chain-ahead", detail: `chain has ${onChain.length} versions, portal shows ${vs.length}` }); continue; }
    // every earlier version must match too
    let bad = false;
    for (let i = 0; i < vs.length - 1; i++) {
      if (onChain[i].actHash !== actHash(vs[i])) { findings.push({ ada: l.ada, status: "mismatch", detail: `version ${i + 1} differs from what was anchored` }); bad = true; break; }
    }
    if (bad) continue;
    findings.push({ ada: l.ada, status: voided ? "void" : "ok", detail: voided ? `voided in v${vs.length}; original v1 still on chain` : `${vs.length} version(s) match` });
  }

  if (a.json) { console.log(JSON.stringify({ findings, portalTotal: portalTotal.toString(), chainTotal: chainTotal.toString() }, null, 2)); return; }

  const counts = findings.reduce((m, f) => (m[f.status] = (m[f.status] ?? 0) + 1, m), {} as Record<string, number>);
  console.log(`verify: org ${a.org}, ${a.type}, ${a.from}..${a.to}`);
  for (const f of findings) console.log(`  ${f.status.padEnd(10)} ${f.ada.padEnd(12)} ${f.detail}`);
  console.log(`\n  portal total (non-void)  ${eur(portalTotal)}\n  chain total  (non-void)  ${eur(chainTotal)}\n  difference               ${eur(portalTotal - chainTotal)}`);
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  if ((counts.mismatch ?? 0) + (counts["chain-ahead"] ?? 0) > 0) process.exitCode = 2;
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

const cmds: Record<string, () => Promise<void>> = { deploy: cmdDeploy, anchor: cmdAnchor, verify: cmdVerify, pay: cmdPay, award: cmdAward, link: cmdLink };
if (!cmd || !cmds[cmd]) { console.error(`usage: cli <${Object.keys(cmds).join("|")}> [options]`); process.exit(1); }
cmds[cmd]().catch((e) => { console.error(e); process.exit(1); });
