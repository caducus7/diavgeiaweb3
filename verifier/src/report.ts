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
import { actHash, isVoid, toCents, unixDay, unsupportedAmount, vatToUint, type DiavgeiaDecision } from "./canonical.js";
import type { DiavgeiaClient } from "./diavgeia.js";
import { parseIsoDay, isPerActError, PortalInconsistentError, SignerDataUnavailable, type SignerRecord } from "./validate.js";

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

export type Status = "ok" | "void" | "unanchored" | "chain-behind" | "mismatch" | "chain-ahead" | "portal-missing" | "history-error" | "foreign-anchor" | "unsupported";

/** Statuses that mean the portal and the chain disagree about published content. */
export const ALARM: ReadonlySet<Status> = new Set(["mismatch", "chain-ahead", "portal-missing", "history-error", "foreign-anchor"]);

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
  /** True when orgVat comes from Diavgeia's /organizations record, so it cannot be a typo to guard against. */
  vatFromRegistry?: boolean;
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
  /** Portal side only: the lines after the first payee of non-void multi-payee acts, which neither total
   *  counts. Itemised bills to one payee, mostly (CONTEXT, 2025 findings). */
  beyondFirstPayee: bigint;
  /** Acts the portal returned for the window. */
  acts: number;
  nonEur: number;
  noAmount: number; // acts whose first payee carries no amount (payroll, for one): invisible in both totals
  /** Every signer of the window's acts (latest versions), from Diavgeia's signer registry. Ids only, no names. */
  signers: Array<{ id: string; acts: number; orgSignRights: boolean | null }>;
  /** Signer problems: not in the registry, of another org, or not active on the issue day. Notes, not alarms. */
  signerIssues: Array<{ ada: string; signerId: string; issue: string }>;
  /** "unavailable" when the source holds no signer records, so nothing above was checked. */
  signerChecks: "done" | "unavailable";
  /** What the latest versions type in the payer field. Anchors carry the organisation's VAT whatever is typed;
   *  the typed payer stays in the hash. Notes on data quality at source, not alarms. */
  payerNotes: { empty: number; other: Array<{ ada: string; typedVat: string }> };
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
    // The anchor's payer is the publishing organisation, so every version must be that organisation's act.
    if (d && d.ada.normalize("NFC") !== latest.ada.normalize("NFC")) {
      throw new PortalInconsistentError(latest.ada, `version ${v.versionId} is of ADA ${d.ada}`);
    }
    if (d && d.organizationId !== latest.organizationId) {
      throw new PortalInconsistentError(latest.ada, `version ${v.versionId} belongs to org ${d.organizationId}, the act to org ${latest.organizationId}`);
    }
    if (d) out.push(d);
    else warn(`  ! version ${v.versionId} of ${latest.ada} not retrievable; chain will start at a later version`);
  }
  return out;
}

/** Why the registry would refuse to append a version after the chain's current `last` version, or null.
 *  Mirrors ActRegistry.anchor's per-version checks; used by `anchor` (to skip with a reason) and by the report
 *  (to say whether a lagging chain is merely behind or blocked), so the two cannot drift. The payer check always
 *  passes: the anchor carries the organisation's VAT (SPEC §4), and versionsOf rejects a version of another org. */
export function anchorBlocker(next: DiavgeiaDecision, last: { voided: boolean } | null): string | null {
  if (last?.voided) return "the registry accepts nothing after a void, and the chain holds this act as voided";
  const amount = unsupportedAmount(next);
  if (amount) return `${amount}, which the canonical form cannot hold`;
  return null;
}

/** Why an act's on-chain history is not this organisation's, or null. The registry does not tie an ADA to an
 *  organisation: any registered signer can anchor any ADA under its own VAT. An anchor of this org's act under
 *  another VAT claims another publisher, so the report raises it and `anchor` does not append to it. */
export function foreignAnchor(onChain: ReadonlyArray<{ payerVat: bigint }>, orgVat: bigint): string | null {
  const i = onChain.findIndex((v) => v.payerVat !== orgVat);
  return i < 0 ? null : `version ${i + 1} on chain is anchored under VAT ${onChain[i].payerVat}, not this organisation's`;
}

const typedPayer = (d: DiavgeiaDecision): bigint => vatToUint(d.extraFieldValues?.org?.afm ?? "");

/** A --vat given in place of the organisation record is the VAT every anchor will carry, and the VAT the org's
 *  key is registered for (never re-pointed). Check it against the acts that type a payer: most must agree.
 *  Single acts with another payer are real (Athens 2025 has one with payer and payee swapped), so a window
 *  with under 3 typed payers only needs one to agree. No typed payer at all leaves nothing to check against. */
export function checkFallbackVat(acts: DiavgeiaDecision[], org: string, vat: string): void {
  const typed = acts.map(typedPayer).filter((v) => v !== 0n);
  const fix = "use a source with the organisation record (record the window again)";
  // An empty window checks nothing, yet the VAT would still filter the portal-missing scan (or be registered).
  if (!acts.length) throw new Error(`no org ${org} acts in this window to check --vat ${vat} against; ${fix}`);
  if (!typed.length) throw new Error(`no org ${org} act in this window types a payer VAT, so --vat ${vat} cannot be checked; ${fix}`);
  const matching = typed.filter((v) => v === vatToUint(vat)).length;
  if (typed.length >= 3 ? matching * 2 < typed.length : matching === 0) {
    throw new Error(`only ${matching} of ${typed.length} org ${org} acts that type a payer carry VAT ${vat}; pass --vat with the org's VAT, or ${fix}`);
  }
}

const firstAmount = (d: DiavgeiaDecision): bigint => toCents(d.extraFieldValues?.sponsor?.[0]?.expenseAmount?.amount);

export async function buildReport(client: DiavgeiaClient, chain: ChainReader, p: ReportParams): Promise<Report> {
  const fromDay = unixDay(parseIsoDay(p.from, "from")), toDay = unixDay(parseIsoDay(p.to, "to"));
  if (fromDay > toDay) throw new Error(`from ${p.from} is after to ${p.to}`);
  const latest = await client.search({ org: p.org, type: p.type, fromIssueDate: p.from, toIssueDate: p.to });
  // The portal-missing scan filters anchors by orgVat. A wrong VAT (e.g. the Athens default with another
  // --org) would silently hide deletions, so refuse rather than report on the wrong organisation.
  const orgVat = vatToUint(p.orgVat);
  if (!p.vatFromRegistry) checkFallbackVat(latest, p.org, p.orgVat);
  const findings: Finding[] = [];
  let portalTotal = 0n, chainTotal = 0n, multiPayee = 0, nonEur = 0, noAmount = 0, beyondFirstPayee = 0n;
  const payerNotes: Report["payerNotes"] = { empty: 0, other: [] };
  // The name from Diavgeia's organisation record; the typed payer name can be another party's (a swapped act).
  let orgName: string | null = (await client.organization(p.org))?.label.normalize("NFC")
    ?? latest.find((l) => typedPayer(l) === orgVat)?.extraFieldValues?.org?.name?.normalize("NFC") ?? null;

  for (const l of latest) {
    const typed = typedPayer(l);
    if (typed === 0n) payerNotes.empty++;
    else if (typed !== orgVat) payerNotes.other.push({ ada: l.ada, typedVat: l.extraFieldValues!.org!.afm! });
    const sponsors = l.extraFieldValues?.sponsor ?? [];
    if (sponsors.length > 1) multiPayee++;
    if (sponsors.some((s) => (s.expenseAmount?.currency ?? "EUR") !== "EUR")) nonEur++;
    if (sponsors[0]?.expenseAmount?.amount == null && !isVoid(l.subject)) noAmount++;

    let vs: DiavgeiaDecision[] | null = null, historyError: string | null = null;
    try { vs = await versionsOf(client, l); }
    catch (e) {
      // One act's history is unusable; report it and carry on. Network failures still abort the run.
      if (!isPerActError(e)) throw e;
      historyError = e.message;
    }
    // An amount the canonical form cannot hold (negative, sub-cent) in some version: that version cannot be
    // hashed or anchored (SPEC §6). The latest version's amount then counts in neither total.
    const badAt = (vs ?? [l]).findIndex((v) => unsupportedAmount(v) !== null);
    const unsupported = badAt < 0 ? null : `${vs ? `v${badAt + 1}` : "the latest version"} has ${unsupportedAmount((vs ?? [l])[badAt])}`;
    if (badAt < 0 && sponsors.length > 1 && !isVoid(l.subject))
      for (const s of sponsors.slice(1)) beyondFirstPayee += toCents(s.expenseAmount?.amount);

    const onChain = await chain.versions(l.ada);
    const last = onChain.length ? onChain[onChain.length - 1] : null;
    // Reported as `unsupported` (nothing anchored): in neither total, as the page says. Otherwise the portal
    // total counts the latest version whenever its own amount can be read.
    const portalCents = unsupportedAmount(l) || (unsupported && !last && vs) ? null : firstAmount(l);
    const voided = isVoid(l.subject);
    if (!voided && portalCents !== null) portalTotal += portalCents;
    const foreign = foreignAnchor(onChain, orgVat);
    // Another organisation's anchor is not this organisation's chain total, as in the portal-missing scan.
    if (last && !last.voided && !foreign) chainTotal += last.amountCents;

    const f = (status: Status, detail: string) =>
      findings.push({ ada: l.ada, status, detail, portalCents, chainCents: last ? last.amountCents : null });

    if (!vs) { f("history-error", historyError!); continue; }
    if (!last) {
      f(unsupported ? "unsupported" : "unanchored", unsupported
        ? `${unsupported}, which the canonical form cannot hold; not anchored, and its amount is in neither total`
        : `portal has ${vs.length} version(s), chain has none`);
      continue;
    }
    if (foreign) { f("foreign-anchor", foreign); continue; }

    // Compare position by position, before anything else about later versions, so nothing a later version
    // carries (an unsupported amount, say) can hide an edit to an anchored one. The chain may lag the portal
    // but must never disagree with it on a version both hold. A held version whose amount the portal now
    // shows unhashable was hashable when anchored, so it has changed.
    const shared = Math.min(onChain.length, vs.length);
    let diverged = -1;
    for (let i = 0; i < shared; i++) {
      if (unsupportedAmount(vs[i]) || onChain[i].actHash !== actHash(vs[i])) { diverged = i; break; }
    }
    if (diverged >= 0) {
      const bad = unsupportedAmount(vs[diverged]);
      f("mismatch", bad
        ? `version ${diverged + 1} is on chain, but the portal's now has ${bad}`
        : `version ${diverged + 1} on chain ${onChain[diverged].actHash.slice(0, 12)}… but portal's hashes to ${actHash(vs[diverged]).slice(0, 12)}…`);
      continue;
    }
    if (onChain.length > vs.length) { f("chain-ahead", `chain has ${onChain.length} versions, portal shows ${vs.length}`); continue; }
    if (onChain.length < vs.length) {
      const why = anchorBlocker(vs[onChain.length], last);
      f("chain-behind", why
        ? `chain has ${onChain.length} of ${vs.length} portal versions; v${onChain.length + 1} is blocked (${why}), and every later version with it`
        : `chain has ${onChain.length} of ${vs.length} portal versions; the rest are not anchored yet`
          + (unsupported ? `, and ${unsupported}, which cannot be anchored` : ""));
      continue;
    }
    f(voided ? "void" : "ok", voided ? `voided in v${vs.length}; earlier versions still on chain` : `${vs.length} version(s) match`);
  }

  // Anchored acts for this org and window that the portal no longer returns.
  // Without this a deletion from the portal would be invisible.
  // The anchor holds the UTC day; the window is in Athens days, which are the same day or the next (an act
  // stored at Athens midnight, 21:00 or 22:00 UTC). So UTC days fromDay..toDay-1 are inside the window, while
  // fromDay-1 and toDay are each either inside or on the neighbouring day: for those, the act is missing only
  // if the portal does not return it on that neighbouring day either.
  const seen = new Set(latest.map((l) => l.ada.normalize("NFC")));
  // A neighbour-day act is skipped only if its UTC day is still the anchored one (an Athens-midnight act of the
  // neighbouring day, checked in that day's own window). One moved to another day is missing from this window.
  const neighbour = new Map<number, Promise<Map<string, DiavgeiaDecision>>>();
  const onNeighbour = async (day: number, ada: string, anchoredDay: number): Promise<boolean> => {
    if (!neighbour.has(day)) {
      const iso = new Date(day * 86_400_000).toISOString().slice(0, 10);
      neighbour.set(day, client.search({ org: p.org, type: p.type, fromIssueDate: iso, toIssueDate: iso })
        .then((ds) => new Map(ds.map((d) => [d.ada.normalize("NFC"), d]))));
    }
    const d = (await neighbour.get(day)!).get(ada.normalize("NFC"));
    return d !== undefined && unixDay(d.issueDate) === anchoredDay;
  };
  for (const ada of await chain.anchoredAdas()) {
    if (seen.has(ada.normalize("NFC"))) continue;
    const onChain = await chain.versions(ada);
    const last = onChain[onChain.length - 1];
    if (!last || last.payerVat !== orgVat || last.issueDate < fromDay - 1 || last.issueDate > toDay) continue;
    if (last.issueDate === fromDay - 1 && await onNeighbour(fromDay - 1, ada, last.issueDate)) continue;
    if (last.issueDate === toDay && await onNeighbour(toDay + 1, ada, last.issueDate)) continue;
    if (!last.voided) chainTotal += last.amountCents;
    findings.push({ ada, status: "portal-missing", detail: `anchored (${onChain.length} version(s)) but not returned by the portal`, portalCents: null, chainCents: last.amountCents });
  }

  const { signers, signerIssues, signerChecks } = await checkSigners(client, latest);

  const counts: Partial<Record<Status, number>> = {};
  for (const x of findings) counts[x.status] = (counts[x.status] ?? 0) + 1;
  return {
    params: p, orgName, findings, portalTotal, chainTotal, difference: portalTotal - chainTotal, counts, multiPayee, beyondFirstPayee, acts: latest.length, nonEur, noAmount, signers, signerIssues, signerChecks, payerNotes,
    alarm: findings.some((x) => ALARM.has(x.status)),
  };
}

/** Check each act's signers against Diavgeia's signer registry. Supplementary: no failure here may hide the
 *  tamper findings, so every lookup error becomes a signer issue instead of aborting the report.
 *  The window: activeFrom is 00:00 UTC like issueDate and is compared by day; activeUntil is Athens midnight
 *  (2999-12-31T22:00Z for open-ended) and is treated as exclusive, so its day itself is the first inactive one. */
async function checkSigners(client: DiavgeiaClient, acts: DiavgeiaDecision[]): Promise<Pick<Report, "signers" | "signerIssues" | "signerChecks">> {
  const records = new Map<string, SignerRecord | null | string>(); // string: the lookup failed
  const counts = new Map<string, number>();
  const signerIssues: Report["signerIssues"] = [];
  for (const act of acts) for (const id of act.signerIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of counts.keys()) {
    try { records.set(id, await client.signer(id)); }
    catch (e) {
      if (e instanceof SignerDataUnavailable) {
        const signers = [...counts].map(([sid, n]) => ({ id: sid, acts: n, orgSignRights: null })).sort((x, y) => y.acts - x.acts || x.id.localeCompare(y.id));
        return { signers, signerIssues: [], signerChecks: "unavailable" };
      }
      records.set(id, (e as Error).message);
    }
  }
  const lastDay = (ms: number) => new Date(ms - 1).toISOString().slice(0, 10);
  for (const act of acts) {
    for (const id of act.signerIds ?? []) {
      const s = records.get(id)!;
      const issue = (why: string) => signerIssues.push({ ada: act.ada, signerId: id, issue: why });
      if (s === null) { issue("not in Diavgeia's signer registry"); continue; }
      if (typeof s === "string") { issue(`signer record unavailable: ${s}`); continue; }
      if (s.organizationId !== act.organizationId) issue(`signer belongs to org ${s.organizationId}, act to org ${act.organizationId}`);
      if (unixDay(act.issueDate) < unixDay(s.activeFrom) || act.issueDate >= s.activeUntil)
        issue(`signer not active on the issue day (active ${new Date(s.activeFrom).toISOString().slice(0, 10)} to ${lastDay(s.activeUntil)})`);
    }
  }
  const signers = [...counts].map(([id, n]) => {
    const s = records.get(id);
    return { id, acts: n, orgSignRights: s && typeof s !== "string" ? s.hasOrganizationSignRights : null };
  }).sort((x, y) => y.acts - x.acts || x.id.localeCompare(y.id));
  return { signers, signerIssues, signerChecks: "done" };
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
