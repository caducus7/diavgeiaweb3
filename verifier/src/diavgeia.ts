/**
 * Diavgeia OpenData client. Two modes:
 *  - live:    hits https://diavgeia.gov.gr/opendata (needs network)
 *  - fixture: reads a saved search response (DIAVGEIA_FIXTURE=path)
 *
 * Known API behaviour, learned the hard way:
 *  - issue-date windows are capped at 180 days; longer ranges are silently
 *    truncated, so year-long pulls must be split.
 *  - with no issue-date filter the API defaults to the last six months.
 *  - `size` is capped (500 in practice); page from 0.
 */
import { readFileSync } from "node:fs";
import type { DiavgeiaDecision } from "./canonical.js";

const BASE = process.env.DIAVGEIA_BASE ?? "https://diavgeia.gov.gr/opendata";

export interface SearchParams {
  org: string;
  type: string;
  fromIssueDate: string; // YYYY-MM-DD
  toIssueDate: string;
  size?: number;
}

export interface VersionLog {
  ada: string;
  versions: Array<{ versionId: string; versionTimestamp: number; correctedVersionId: string | null; status: string }>;
}

export interface DiavgeiaClient {
  search(p: SearchParams): Promise<DiavgeiaDecision[]>;
  versionLog(ada: string): Promise<VersionLog | null>;
  decisionVersion(versionId: string): Promise<DiavgeiaDecision | null>;
}

export class LiveClient implements DiavgeiaClient {
  async search(p: SearchParams): Promise<DiavgeiaDecision[]> {
    const out: DiavgeiaDecision[] = [];
    for (const [from, to] of splitWindows(p.fromIssueDate, p.toIssueDate)) {
      let page = 0;
      for (;;) {
        const u = new URL(`${BASE}/search.json`);
        u.searchParams.set("org", p.org);
        u.searchParams.set("type", p.type);
        u.searchParams.set("from_issue_date", from);
        u.searchParams.set("to_issue_date", to);
        // submissionTimestamp defaults to a 6-month window too; widen it
        u.searchParams.set("from_date", from);
        u.searchParams.set("size", String(p.size ?? 500));
        u.searchParams.set("page", String(page));
        const r = await fetch(u, { headers: { Accept: "application/json" } });
        if (!r.ok) throw new Error(`diavgeia ${r.status} for ${u}`);
        const j = (await r.json()) as { decisions: DiavgeiaDecision[]; info: { total: number; actualSize: number } };
        out.push(...j.decisions);
        if (j.info.actualSize === 0 || out.length >= j.info.total) break;
        page++;
      }
    }
    return dedupeByVersion(out);
  }

  async versionLog(ada: string): Promise<VersionLog | null> {
    const r = await fetch(`${BASE}/decisions/${encodeURIComponent(ada)}/versionlog.json`);
    if (!r.ok) return null;
    return (await r.json()) as VersionLog;
  }

  async decisionVersion(versionId: string): Promise<DiavgeiaDecision | null> {
    const r = await fetch(`${BASE}/decisions/v/${versionId}.json`);
    if (!r.ok) return null;
    return (await r.json()) as DiavgeiaDecision;
  }
}

export class FixtureClient implements DiavgeiaClient {
  private data: { decisions: DiavgeiaDecision[]; versionlog?: Record<string, VersionLog> };

  constructor(path: string) {
    this.data = JSON.parse(readFileSync(path, "utf8"));
  }

  async search(p: SearchParams): Promise<DiavgeiaDecision[]> {
    const from = Date.parse(p.fromIssueDate), to = Date.parse(p.toIssueDate) + 86_400_000;
    // The search endpoint returns only the latest version of each ADA.
    const latest = new Map<string, DiavgeiaDecision>();
    for (const d of this.data.decisions) {
      if (d.organizationId !== p.org || d.decisionTypeId !== p.type) continue;
      if (d.issueDate < from || d.issueDate >= to) continue;
      const cur = latest.get(d.ada);
      if (!cur || isLater(d, cur)) latest.set(d.ada, d);
    }
    return [...latest.values()];
  }

  async versionLog(ada: string): Promise<VersionLog | null> {
    return this.data.versionlog?.[ada] ?? null;
  }

  async decisionVersion(versionId: string): Promise<DiavgeiaDecision | null> {
    return this.data.decisions.find((d) => d.versionId === versionId) ?? null;
  }
}

function isLater(a: DiavgeiaDecision, b: DiavgeiaDecision): boolean {
  // A version that corrects another is later than it.
  if (a.correctedVersionId === b.versionId) return true;
  if (b.correctedVersionId === a.versionId) return false;
  return (a.submissionTimestamp as number) > (b.submissionTimestamp as number);
}

function dedupeByVersion(ds: DiavgeiaDecision[]): DiavgeiaDecision[] {
  const seen = new Set<string>();
  return ds.filter((d) => (seen.has(d.versionId) ? false : (seen.add(d.versionId), true)));
}

/** Split [from, to] into windows of at most 180 days, inclusive. */
export function splitWindows(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = Date.parse(from);
  const end = Date.parse(to);
  const DAY = 86_400_000;
  while (start <= end) {
    const stop = Math.min(start + 179 * DAY, end);
    out.push([iso(start), iso(stop)]);
    start = stop + DAY;
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function makeClient(): DiavgeiaClient {
  const f = process.env.DIAVGEIA_FIXTURE;
  return f ? new FixtureClient(f) : new LiveClient();
}
