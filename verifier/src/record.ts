/**
 * Wraps a client and keeps everything it returns, so a live run can be saved in the fixture format and
 * replayed offline with DIAVGEIA_FIXTURE. Records are stored as the API returned them (already validated),
 * which keeps them verbatim in the sense CLAUDE.md requires.
 */
import { writeFileSync } from "node:fs";
import type { DiavgeiaDecision } from "./canonical.js";
import type { DiavgeiaClient, SearchParams, VersionLog } from "./diavgeia.js";

export class RecordingClient implements DiavgeiaClient {
  private decisions = new Map<string, DiavgeiaDecision>();
  private logs: Record<string, VersionLog> = {};
  private searches: string[] = [];

  constructor(private inner: DiavgeiaClient, private source: string) {}

  async search(p: SearchParams): Promise<DiavgeiaDecision[]> {
    const r = await this.inner.search(p);
    this.searches.push(`${this.source}/search.json?org=${p.org}&type=${p.type}&from_issue_date=${p.fromIssueDate}&to_issue_date=${p.toIssueDate}`);
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

  get size(): number { return this.decisions.size; }

  /** Write in the fixture format. `_source` is the first search, which FixtureClient and live-check read.
   *  `failure` marks a partial recording of a run that failed, kept so the failure can be replayed. */
  save(path: string, fetched = new Date(), failure?: string): void {
    const out = {
      _source: this.searches[0] ?? null,
      _searches: this.searches,
      _fetched: fetched.toISOString().slice(0, 10),
      ...(failure ? { _partial: true, _failure: failure } : {}),
      _notes: ["Recorded by DIAVGEIA_RECORD from the live OpenData API; every record is verbatim API output."],
      decisions: [...this.decisions.values()],
      versionlog: this.logs,
    };
    writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  }
}
