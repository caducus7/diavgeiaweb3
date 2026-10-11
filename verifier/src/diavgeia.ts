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
import { parseDecision, parseSearchPage, parseVersionLog, parseIsoDay, PortalInconsistentError } from "./validate.js";

export const BASE = process.env.DIAVGEIA_BASE ?? "https://diavgeia.gov.gr/opendata";

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

/** Window size the live client uses. The API clamps issue-date ranges at 180 days (inferred from one
 *  observation, CONTEXT.md); 90 leaves a margin so an off-by-one in its convention cannot drop a day. */
export const LIVE_WINDOW_DAYS = 90;
const MAX_PAGES_PER_WINDOW = 200;
const DAY = 86_400_000;

export interface LiveOptions {
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** Delay before retry n (0-based), ms. Overridable so tests do not sleep. */
  backoff?: (n: number) => number;
}

export class LiveClient implements DiavgeiaClient {
  private base: string;
  private f: typeof fetch;
  private timeoutMs: number;
  private retries: number;
  private backoff: (n: number) => number;

  constructor(o: LiveOptions = {}) {
    this.base = o.base ?? BASE;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.retries = o.retries ?? 3;
    this.backoff = o.backoff ?? ((n) => 1000 * 2 ** n);
  }

  /** GET JSON. 404 -> null. 429, 5xx and network errors (including a timeout while reading the body) are
   *  retried; anything else throws. */
  private async get(url: URL | string): Promise<unknown | null> {
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      let text: string | null = null;
      try {
        r = await this.f(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (r.ok) text = await r.text();
      } catch (e) {
        if (attempt >= this.retries) {
          // fetch's own message is just "fetch failed"; the cause code (ENOTFOUND, ECONNRESET, ...) is the useful part
          const cause = (e as { cause?: { code?: string; message?: string } }).cause;
          throw new Error(`diavgeia unreachable after ${attempt + 1} attempts: ${url}: ${(e as Error).message}${cause ? ` (${cause.code ?? cause.message})` : ""}`);
        }
        await sleep(this.backoff(attempt));
        continue;
      }
      if (text !== null) {
        try { return JSON.parse(text); }
        catch { throw new Error(`diavgeia returned non-JSON for ${url}: ${text.slice(0, 80)}`); }
      }
      // Release the connection of a response we will not read. Not awaited: a cancel must never block a retry.
      r.body?.cancel().catch(() => {});
      if (r.status === 404) return null;
      if ((r.status === 429 || r.status >= 500) && attempt < this.retries) { await sleep(this.backoff(attempt)); continue; }
      throw new Error(`diavgeia ${r.status} for ${url}`);
    }
  }

  async search(p: SearchParams): Promise<DiavgeiaDecision[]> {
    const out: DiavgeiaDecision[] = [];
    for (const [from, to] of splitWindows(p.fromIssueDate, p.toIssueDate, LIVE_WINDOW_DAYS)) {
      // Counted per window: info.total is the total of this window's query, not of the whole range.
      const windowVersions = new Set<string>();
      let total: number | null = null;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES_PER_WINDOW) throw new Error(`diavgeia: more than ${MAX_PAGES_PER_WINDOW} pages for ${from}..${to}; refusing to continue`);
        const u = new URL(`${this.base}/search.json`);
        u.searchParams.set("org", p.org);
        u.searchParams.set("type", p.type);
        u.searchParams.set("from_issue_date", from);
        // The API's to_issue_date excludes that day: it runs the query up to Athens midnight at the start of `to`,
        // and issueDate is stored as UTC midnight (verified 2026-10-11: 2025-03-31..2025-03-31 returns 0 acts,
        // 2025-03-31..2025-04-01 returns the 25 of 31 March). Ask for the day after to keep `to` inclusive.
        u.searchParams.set("to_issue_date", iso(Date.parse(to) + DAY));
        // submissionTimestamp defaults to a 6-month window too; widen it
        u.searchParams.set("from_date", from);
        u.searchParams.set("size", String(p.size ?? 500));
        u.searchParams.set("page", String(page));
        const body = await this.get(u);
        if (body === null) throw new Error(`diavgeia 404 for ${u}`);
        const j = parseSearchPage(body, `search ${from}..${to} page ${page}`);
        total ??= j.total;
        const before = windowVersions.size;
        for (const d of j.decisions) {
          const why = outsideQuery(d, p, from, to);
          if (why) throw new Error(`diavgeia: ${why}`);
          windowVersions.add(d.versionId);
          out.push(d);
        }
        if (j.actualSize === 0 || windowVersions.size >= total) break;
        // A non-empty page with nothing new means paging is not advancing; stop now, the check below reports it.
        if (windowVersions.size === before) break;
      }
      // A page parameter the API ignores, or a total that moved, would otherwise look like a short year.
      if (windowVersions.size !== total) {
        throw new Error(`diavgeia: ${from}..${to} reported ${total} acts but returned ${windowVersions.size} distinct versions`);
      }
    }
    return dedupeByVersion(out);
  }

  async versionLog(ada: string): Promise<VersionLog | null> {
    const body = await this.get(`${this.base}/decisions/${encodeURIComponent(ada)}/versionlog.json`);
    return body === null ? null : parseVersionLog(body, ada);
  }

  async decisionVersion(versionId: string): Promise<DiavgeiaDecision | null> {
    const body = await this.get(`${this.base}/decisions/v/${encodeURIComponent(versionId)}.json`);
    if (body === null) return null;
    const d = parseDecision(body, `version ${versionId}`);
    if (d.versionId !== versionId) throw new PortalInconsistentError(d.ada, `asked for version ${versionId}, got ${d.versionId}`);
    return d;
  }
}

/** The API must return only what was asked for. If it ignored a filter (for example a Greek Β in `type`
 *  that did not match), every act would be summed into the totals without this. The window is checked
 *  exactly as FixtureClient filters it, so a recorded run replays to the same acts. If the API turns out
 *  to store `issueDate` as Athens midnight rather than UTC, this is where the first live run says so. */
export function outsideQuery(d: DiavgeiaDecision, p: SearchParams, from: string, to: string): string | null {
  if (d.organizationId !== p.org) return `asked for org ${p.org}, got ${d.ada} of org ${d.organizationId}`;
  if (d.decisionTypeId.normalize("NFC") !== p.type.normalize("NFC")) return `asked for type ${p.type}, got ${d.ada} of type ${d.decisionTypeId}`;
  const lo = parseIsoDay(from, "from"), hi = parseIsoDay(to, "to") + DAY;
  if (d.issueDate < lo || d.issueDate >= hi)
    return `asked for ${from}..${to} (UTC days), got ${d.ada} issued ${new Date(d.issueDate).toISOString()}; if this is Athens midnight, the API's date convention differs from the one assumed`;
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FixtureClient implements DiavgeiaClient {
  private data: { decisions: DiavgeiaDecision[]; versionlog?: Record<string, VersionLog> };

  constructor(path: string) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw?.decisions)) throw new Error(`${path}: no decisions array`);
    raw.decisions.forEach((d: unknown, i: number) => parseDecision(d, `${path} decisions[${i}]`));
    for (const [ada, log] of Object.entries(raw.versionlog ?? {})) parseVersionLog(log, ada);
    this.data = raw;
  }

  async search(p: SearchParams): Promise<DiavgeiaDecision[]> {
    if (parseIsoDay(p.fromIssueDate, "from") > parseIsoDay(p.toIssueDate, "to")) throw new Error(`from ${p.fromIssueDate} is after to ${p.toIssueDate}`);
    // The search endpoint returns only the latest version of each ADA. Same filter as the live check.
    const latest = new Map<string, DiavgeiaDecision>();
    for (const d of this.data.decisions) {
      if (outsideQuery(d, p, p.fromIssueDate, p.toIssueDate)) continue;
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

/** Split [from, to] into windows of at most `days` days, inclusive. Throws on a malformed or reversed range
 *  rather than returning no windows, which would read as "no acts". */
export function splitWindows(from: string, to: string, days = 180): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = parseIsoDay(from, "from");
  const end = parseIsoDay(to, "to");
  if (start > end) throw new Error(`from ${from} is after to ${to}`);
  if (!Number.isInteger(days) || days < 1) throw new Error(`window must be a positive integer of days, got ${days}`);
  while (start <= end) {
    const stop = Math.min(start + (days - 1) * DAY, end);
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
