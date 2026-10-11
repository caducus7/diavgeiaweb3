/**
 * Portal vs chain reconciliation for one organisation, act type and issue-date
 * window. Pure over its two inputs (a Diavgeia client and a chain reader) so it
 * runs in tests without Anvil. `verify` prints it; `page` renders it.
 *
 * Totals use the first sponsor only, matching what the anchor exposes (SPEC §4).
 * Acts with more than one sponsor are counted in `multiPayee` so a reader knows
 * the totals understate them.
 */
import type { Hex } from "viem";
import { actHash, isVoid, toCents, unixDay, vatToUint, type DiavgeiaDecision } from "./canonical.js";
import type { DiavgeiaClient } from "./diavgeia.js";
import { parseIsoDay, isPerActError, PortalInconsistentError } from "./validate.js";

/** The fields of an on-chain anchor the report reads. */
export interface ChainVersion {
  actHash: Hex;
  payerVat: bigint;
  amountCents: bigint;
  issueDate: number;
  voided: boolean;
}

export interface ChainReader {
  versions(ada: string): Promise<ChainVersion[]>;
  /** Every ADA ever anchored on this registry, in any order. */
  anchoredAdas(): Promise<string[]>;
}

export type Status = "ok" | "void" | "unanchored" | "chain-behind" | "mismatch" | "chain-ahead" | "portal-missing" | "history-error";

/** Statuses that mean the portal and the chain disagree about published content. */
export const ALARM: ReadonlySet<Status> = new Set(["mismatch", "chain-ahead", "portal-missing", "history-error"]);

export interface Finding {
  ada: string;
  status: Status;
  detail: string;
  portalCents: bigint | null; // null when the portal does not show the act
  chainCents: bigint | null;  // null when nothing is anchored
}

export interface ReportParams {
  org: string;
  orgVat: string;
  type: string;
  from: string; // YYYY-MM-DD, inclusive
  to: string;   // YYYY-MM-DD, inclusive
}

export interface Report {
  params: ReportParams;
  orgName: string | null;
  findings: Finding[];
  portalTotal: bigint;
  chainTotal: bigint;
  difference: bigint; // portalTotal - chainTotal
  counts: Partial<Record<Status, number>>;
  multiPayee: number;
  nonEur: number;
  alarm: boolean;
}

/** All versions of an ADA, oldest first, using the version log where the API has one.
 *  The search result is the latest version, so the log must contain it and end with it; otherwise the
 *  portal is inconsistent with itself and comparing against it would be meaningless. */
export async function versionsOf(client: DiavgeiaClient, latest: DiavgeiaDecision, warn = console.warn): Promise<DiavgeiaDecision[]> {
  const log = await client.versionLog(latest.ada);
  if (!log) return [latest];
  const ordered = [...log.versions].sort((x, y) => x.versionTimestamp - y.versionTimestamp);
  const last = ordered[ordered.length - 1];
  if (last.versionId !== latest.versionId) {
    throw new PortalInconsistentError(latest.ada, `search returned version ${latest.versionId} but the version log's latest is ${last.versionId}`);
  }
  const out: DiavgeiaDecision[] = [];
  for (const v of ordered) {
    if (v.versionId === latest.versionId) { out.push(latest); continue; }
    const d = await client.decisionVersion(v.versionId);
    if (d) out.push(d);
    else warn(`  ! version ${v.versionId} of ${latest.ada} not retrievable; chain will start at a later version`);
  }
  return out;
}

const firstAmount = (d: DiavgeiaDecision): bigint => toCents(d.extraFieldValues?.sponsor?.[0]?.expenseAmount?.amount);

export async function buildReport(client: DiavgeiaClient, chain: ChainReader, p: ReportParams): Promise<Report> {
  const fromDay = unixDay(parseIsoDay(p.from, "from")), toDay = unixDay(parseIsoDay(p.to, "to"));
  if (fromDay > toDay) throw new Error(`from ${p.from} is after to ${p.to}`);
  const latest = await client.search({ org: p.org, type: p.type, fromIssueDate: p.from, toIssueDate: p.to });
  // The portal-missing scan filters anchors by orgVat. A wrong VAT (e.g. the Athens default with another
  // --org) would silently hide deletions, so refuse rather than report on the wrong organisation.
  const orgVat = vatToUint(p.orgVat);
  const wrong = latest.find((l) => vatToUint(l.extraFieldValues?.org?.afm ?? "") !== orgVat);
  if (wrong) throw new Error(`org ${p.org} acts carry VAT ${wrong.extraFieldValues?.org?.afm}, not ${p.orgVat}; pass --vat`);
  const findings: Finding[] = [];
  let portalTotal = 0n, chainTotal = 0n, multiPayee = 0, nonEur = 0;
  let orgName: string | null = null;

  for (const l of latest) {
    orgName ??= l.extraFieldValues?.org?.name?.normalize("NFC") ?? null;
    const sponsors = l.extraFieldValues?.sponsor ?? [];
    if (sponsors.length > 1) multiPayee++;
    if (sponsors.some((s) => (s.expenseAmount?.currency ?? "EUR") !== "EUR")) nonEur++;

    const portalCents = firstAmount(l);
    const voided = isVoid(l.subject);
    if (!voided) portalTotal += portalCents;
    const onChain = await chain.versions(l.ada);
    const last = onChain.length ? onChain[onChain.length - 1] : null;
    if (last && !last.voided) chainTotal += last.amountCents;

    const f = (status: Status, detail: string) =>
      findings.push({ ada: l.ada, status, detail, portalCents, chainCents: last ? last.amountCents : null });

    let vs: DiavgeiaDecision[];
    try { vs = await versionsOf(client, l); }
    catch (e) {
      // One act's history is unusable; report it and carry on. Network failures still abort the run.
      if (!isPerActError(e)) throw e;
      f("history-error", e.message);
      continue;
    }

    if (!last) { f("unanchored", `portal has ${vs.length} version(s), chain has none`); continue; }

    // Compare position by position. The chain may lag the portal (a version not
    // yet anchored) but must never disagree with it on a version both hold.
    const shared = Math.min(onChain.length, vs.length);
    let diverged = -1;
    for (let i = 0; i < shared; i++) {
      if (onChain[i].actHash !== actHash(vs[i])) { diverged = i; break; }
    }
    if (diverged >= 0) {
      f("mismatch", `version ${diverged + 1} on chain ${onChain[diverged].actHash.slice(0, 12)}… but portal's hashes to ${actHash(vs[diverged]).slice(0, 12)}…`);
      continue;
    }
    if (onChain.length > vs.length) { f("chain-ahead", `chain has ${onChain.length} versions, portal shows ${vs.length}`); continue; }
    if (onChain.length < vs.length) { f("chain-behind", `chain has ${onChain.length} of ${vs.length} portal versions; the rest are not anchored yet`); continue; }
    f(voided ? "void" : "ok", voided ? `voided in v${vs.length}; earlier versions still on chain` : `${vs.length} version(s) match`);
  }

  // Anchored acts for this org and window that the portal no longer returns.
  // Without this a deletion from the portal would be invisible.
  const seen = new Set(latest.map((l) => l.ada.normalize("NFC")));
  for (const ada of await chain.anchoredAdas()) {
    if (seen.has(ada.normalize("NFC"))) continue;
    const onChain = await chain.versions(ada);
    const last = onChain[onChain.length - 1];
    if (!last || last.payerVat !== orgVat || last.issueDate < fromDay || last.issueDate > toDay) continue;
    if (!last.voided) chainTotal += last.amountCents;
    findings.push({ ada, status: "portal-missing", detail: `anchored (${onChain.length} version(s)) but not returned by the portal`, portalCents: null, chainCents: last.amountCents });
  }

  const counts: Partial<Record<Status, number>> = {};
  for (const x of findings) counts[x.status] = (counts[x.status] ?? 0) + 1;
  return {
    params: p, orgName, findings, portalTotal, chainTotal, difference: portalTotal - chainTotal, counts, multiPayee, nonEur,
    alarm: findings.some((x) => ALARM.has(x.status)),
  };
}

/** Integer cents to "1,234.56 EUR" without passing through a float. */
export function formatEur(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac} EUR`;
}

/** JSON-safe copy of a report (bigints as decimal strings). */
export function reportJson(r: Report): unknown {
  return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
