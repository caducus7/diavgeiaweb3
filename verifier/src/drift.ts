/**
 * Off-chain tamper check against a committed manifest: the canonical hash of every version of every act in a
 * window, as recorded once (`snapshot`), compared later with what the portal serves (`drift`). It gives Phase 1's
 * main guarantee (a published act does not change silently) without a chain, so it can run on a schedule.
 *
 * A manifest holds ADAs, versionIds and hashes only: no VAT numbers, names or amounts (the repo is public; the
 * hash commits to them without revealing them).
 */
import { actHash, CANONICAL_VERSION, unsupportedAmount, type DiavgeiaDecision } from "./canonical.js";
import type { DiavgeiaClient } from "./diavgeia.js";
import { versionsOf } from "./report.js";
import { isPerActError } from "./validate.js";

export interface ManifestVersion { versionId: string; hash: string | null } // null: amount the canonical form cannot hold
export interface Manifest {
  v: 1;
  canonicalVersion: number;
  query: { org: string; type: string; from: string; to: string };
  created: string; // YYYY-MM-DD
  acts: Record<string, ManifestVersion[]>; // ADA -> versions, oldest first
  historyErrors: Record<string, string>; // ADAs whose portal history contradicted itself when recorded
}

const hashOf = (d: DiavgeiaDecision): string | null => (unsupportedAmount(d) ? null : actHash(d));

export async function snapshot(client: DiavgeiaClient, q: Manifest["query"], created: string, warn = console.warn): Promise<Manifest> {
  const latest = await client.search({ org: q.org, type: q.type, fromIssueDate: q.from, toIssueDate: q.to });
  const acts: Manifest["acts"] = {}, historyErrors: Manifest["historyErrors"] = {};
  for (const l of [...latest].sort((a, b) => a.ada.localeCompare(b.ada))) {
    try { acts[l.ada] = (await versionsOf(client, l, warn)).map((v) => ({ versionId: v.versionId, hash: hashOf(v) })); }
    catch (e) { if (!isPerActError(e)) throw e; historyErrors[l.ada] = e.message; }
  }
  return { v: 1, canonicalVersion: CANONICAL_VERSION, query: q, created, acts, historyErrors };
}

export type DriftKind = "changed" | "version-lost" | "gone" | "history-error" | "new-version" | "new-act";
/** Kinds that mean published content differs from what was recorded. The others are growth, not tampering. */
export const DRIFT_ALARM: ReadonlySet<DriftKind> = new Set(["changed", "version-lost", "gone", "history-error"]);
export interface DriftFinding { ada: string; kind: DriftKind; detail: string }

export async function drift(client: DiavgeiaClient, m: Manifest, warn = console.warn, concurrency = 4): Promise<DriftFinding[]> {
  if (m.canonicalVersion !== CANONICAL_VERSION) {
    throw new Error(`manifest uses canonical form v${m.canonicalVersion}, this verifier v${CANONICAL_VERSION}; re-snapshot`);
  }
  const q = m.query;
  const latest = await client.search({ org: q.org, type: q.type, fromIssueDate: q.from, toIssueDate: q.to });
  const live = new Map(latest.map((l) => [l.ada, l]));
  const out: DriftFinding[] = [];
  // Version histories are fetched `concurrency` at a time, as in `record`; findings are sorted at the end.
  const histories = new Map<string, DiavgeiaDecision[] | string>();
  const todo = Object.keys(m.acts).filter((ada) => live.has(ada));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const ada = todo[next++];
      try { const vs = await versionsOf(client, live.get(ada)!, warn); histories.set(ada, vs); }
      catch (e) { if (!isPerActError(e)) throw e; histories.set(ada, e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  for (const [ada, recorded] of Object.entries(m.acts)) {
    if (!live.has(ada)) { out.push({ ada, kind: "gone", detail: `recorded with ${recorded.length} version(s), no longer returned for ${q.from}..${q.to}` }); continue; }
    const h0 = histories.get(ada)!;
    if (typeof h0 === "string") { out.push({ ada, kind: "history-error", detail: h0 }); continue; }
    const vs = h0;
    const byId = new Map(vs.map((v, i) => [v.versionId, { v, i }]));
    let bad = false;
    recorded.forEach((r, i) => {
      if (bad) return;
      const now = byId.get(r.versionId);
      if (!now) { out.push({ ada, kind: "version-lost", detail: `v${i + 1} (${r.versionId.slice(0, 8)}) no longer in the portal's history` }); bad = true; return; }
      const h = hashOf(now.v);
      if (h !== r.hash || now.i !== i) {
        out.push({ ada, kind: "changed", detail: now.i !== i ? `v${i + 1} moved to position ${now.i + 1}` : `v${i + 1} (${r.versionId.slice(0, 8)}) hash ${String(r.hash).slice(0, 12)}… is now ${String(h).slice(0, 12)}…` });
        bad = true;
      }
    });
    if (!bad && vs.length > recorded.length) out.push({ ada, kind: "new-version", detail: `${vs.length - recorded.length} version(s) published since the snapshot` });
  }
  for (const ada of live.keys()) {
    if (!(ada in m.acts) && !(ada in m.historyErrors)) out.push({ ada, kind: "new-act", detail: "published in the window since the snapshot" });
  }
  return out.sort((x, y) => x.ada.localeCompare(y.ada) || x.kind.localeCompare(y.kind));
}
