/**
 * Wraps a client and keeps everything it returns, so a live run can be saved in the fixture format and
 * replayed offline with DIAVGEIA_FIXTURE. Records are stored as the API returned them (already validated),
 * which keeps them verbatim in the sense CLAUDE.md requires.
 */
import { writeFileSync } from "node:fs";
import type { DiavgeiaDecision } from "./canonical.js";
import type { DiavgeiaClient, SearchParams, VersionLog } from "./diavgeia.js";
import { versionsOf } from "./report.js";
import { isPerActError, type OrganizationRecord, type SignerRecord } from "./validate.js";

export class RecordingClient implements DiavgeiaClient {
  private decisions = new Map<string, DiavgeiaDecision>();
  private logs: Record<string, VersionLog> = {};
  private organizations: Record<string, OrganizationRecord> = {};
  private signers: Record<string, SignerRecord> = {};
  private searches: string[] = [];
  private query: { org: string; type: string; from: string; to: string } | null = null;

  constructor(private inner: DiavgeiaClient, private source: string) {}

  async search(p: SearchParams): Promise<DiavgeiaDecision[]> {
    const r = await this.inner.search(p);
    // The URL as the live client sends it: to_issue_date is exclusive in the API, so it carries `to` + 1 day.
    const toExcl = new Date(Date.parse(p.toIssueDate) + 86_400_000).toISOString().slice(0, 10);
    this.searches.push(`${this.source}/search.json?org=${p.org}&type=${p.type}&from_issue_date=${p.fromIssueDate}&to_issue_date=${toExcl}`);
    this.query ??= { org: p.org, type: p.type, from: p.fromIssueDate, to: p.toIssueDate };
    for (const d of r) this.decisions.set(d.versionId, d);
    return r;
  }

  async versionLog(ada: string): Promise<VersionLog | null> {
    const r = await this.inner.versionLog(ada);
    if (r) this.logs[ada] = r;
    return r;
  }

  async decisionVersion(versionId: string): Promise<DiavgeiaDecision | null> {
    const r = await this.inner.decisionVersion(versionId);
    if (r) this.decisions.set(r.versionId, r);
    return r;
  }

  async organization(uid: string): Promise<OrganizationRecord | null> {
    const r = await this.inner.organization(uid);
    if (r) this.organizations[uid] = r;
    return r;
  }

  async signer(id: string): Promise<SignerRecord | null> {
    const r = await this.inner.signer(id);
    if (r) this.signers[id] = r;
    return r;
  }

  get size(): number { return this.decisions.size; }

  /** Write in the fixture format. `_source` is the first search, which FixtureClient and live-check read.
   *  `failure` marks a partial recording of a run that failed, kept so the failure can be replayed. */
  save(path: string, fetched = new Date(), failure?: string): void {
    const out = {
      _query: this.query, // inclusive dates; what live-check re-runs
      _source: this.searches[0] ?? null,
      _searches: this.searches,
      _fetched: fetched.toISOString().slice(0, 10),
      ...(failure ? { _partial: true, _failure: failure } : {}),
      _notes: ["Recorded by DIAVGEIA_RECORD from the live OpenData API; every record is verbatim API output."],
      decisions: [...this.decisions.values()],
      versionlog: this.logs,
      organizations: this.organizations,
      signers: this.signers,
    };
    writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  }
}

export interface PrefetchResult {
  acts: number; versions: number; signers: number;
  perActErrors: Array<{ ada: string; error: string }>; missingVersions: string[];
  /** Signer records that could not be fetched. Supplementary data: noted, never fatal to the recording. */
  signerErrors: Array<{ id: string; error: string }>;
}

/** Fetch a search and the full history of every act in it, `concurrency` requests at a time, into `rec`.
 *  Per-act errors are collected, not thrown, so one bad act does not lose the rest of a long fetch. */
export async function prefetch(rec: RecordingClient, p: SearchParams, concurrency = 4, progress?: (done: number, total: number) => void): Promise<PrefetchResult> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error(`concurrency must be 1 to 8, got ${concurrency}`);
  const latest = await rec.search(p);
  const perActErrors: PrefetchResult["perActErrors"] = [];
  const missingVersions: string[] = [];
  let next = 0, done = 0, versions = 0;
  const worker = async () => {
    while (next < latest.length) {
      const l = latest[next++];
      // Await first: `versions += await ...` reads `versions` before the await and loses concurrent updates.
      try { const n = (await versionsOf(rec, l, (msg) => missingVersions.push(msg.trim()))).length; versions += n; }
      catch (e) {
        if (!isPerActError(e)) throw e;
        perActErrors.push({ ada: l.ada, error: e.message });
      }
      progress?.(++done, latest.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, latest.length) }, worker));
  // The organisation (its authoritative VAT) and every signer of the window, so offline runs can check them.
  await rec.organization(p.org);
  const signerIds = [...new Set(latest.flatMap((l) => l.signerIds ?? []))];
  const signerErrors: PrefetchResult["signerErrors"] = [];
  let si = 0;
  const signerWorker = async () => {
    while (si < signerIds.length) {
      const id = signerIds[si++];
      try { await rec.signer(id); } catch (e) { signerErrors.push({ id, error: (e as Error).message }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, signerIds.length) }, signerWorker));
  return { acts: latest.length, versions, signers: signerIds.length, perActErrors, missingVersions, signerErrors };
}
