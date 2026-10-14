/**
 * First thing to run from a machine that can reach Diavgeia: re-fetch what the fixture was built from and
 * compare canonical hashes record by record.
 *
 *  - A verbatim fixture record must hash the same live. If not, either the record was not verbatim or the
 *    API now returns something the canonical form reads differently; both block trusting any anchor.
 *  - A reconstructed record (`_reconstructed: true`) is expected to be at risk; a difference there says
 *    the reconstruction was wrong, and the fixture should take the live record instead.
 */
import { actHash, unsupportedAmount, type DiavgeiaDecision } from "./canonical.js";

const rawAmounts = (d: DiavgeiaDecision) => (d.extraFieldValues?.sponsor ?? []).map((s) => s.expenseAmount?.amount ?? null);
const withoutAmounts = (d: DiavgeiaDecision): DiavgeiaDecision => ({
  ...d,
  extraFieldValues: d.extraFieldValues && {
    ...d.extraFieldValues,
    sponsor: d.extraFieldValues.sponsor?.map((s) => ({ ...s, expenseAmount: s.expenseAmount && { ...s.expenseAmount, amount: undefined } })),
  },
});
import type { DiavgeiaClient } from "./diavgeia.js";
import { versionsOf } from "./report.js";
import { isPerActError } from "./validate.js";

export interface CheckLine { what: string; ok: boolean; detail: string }

/** The registry fields the verifier relies on; other fields (names, units) may change without consequence. */
const ORG_FIELDS = ["uid", "vatNumber"] as const;
const SIGNER_FIELDS = ["uid", "organizationId", "activeFrom", "activeUntil", "hasOrganizationSignRights"] as const;
const pick = (o: Record<string, unknown>, ks: readonly string[]) => JSON.stringify(ks.map((k) => o[k]));

export interface FixtureFile {
  organizations?: Record<string, Record<string, unknown>>;
  signers?: Record<string, Record<string, unknown>>;
  _query?: { org: string; type: string; from: string; to: string };
  _source?: string;
  /** Set when the fixture holds a hand-picked subset of its query: extra live acts are then expected. */
  _sample?: string;
  decisions: Array<DiavgeiaDecision & { _reconstructed?: boolean }>;
}

/** org, type and inclusive window of the query a fixture was built from. `_query` (written by `record`) is
 *  inclusive; a hand-made `_source` URL is read as the API ran it, with `to_issue_date` exclusive. */
export function queryOfFixture(fx: FixtureFile): { org: string; type: string; from: string; to: string } {
  if (fx._query) return fx._query;
  if (!fx._source) throw new Error("fixture has neither _query nor a _source search URL");
  const q = new URL(fx._source).searchParams;
  const org = q.get("org"), type = q.get("type"), from = q.get("from_issue_date"), toExcl = q.get("to_issue_date");
  if (!org || !type || !from || !toExcl) throw new Error(`fixture _source lacks org/type/from_issue_date/to_issue_date: ${fx._source}`);
  return { org, type, from, to: new Date(Date.parse(toExcl) - 86_400_000).toISOString().slice(0, 10) };
}

export async function liveCheck(client: DiavgeiaClient, fx: FixtureFile, warn = console.warn): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const q = queryOfFixture(fx);
  const live = await client.search({ org: q.org, type: q.type, fromIssueDate: q.from, toIssueDate: q.to });

  // The fixture's latest version per ADA, which is what search returns.
  const fxAdas = new Set(fx.decisions.map((d) => d.ada));
  const liveAdas = new Set(live.map((d) => d.ada));
  const missing = [...fxAdas].filter((a) => !liveAdas.has(a));
  const extra = [...liveAdas].filter((a) => !fxAdas.has(a));
  // Acts missing live are always a difference. Extra live acts are one only if the fixture claims to be the
  // whole query; for a sample they are expected and only counted.
  const extraIsDiff = extra.length > 0 && !fx._sample;
  lines.push({
    what: `search ${q.org} ${q.type} ${q.from}..${q.to}`,
    ok: missing.length === 0 && !extraIsDiff,
    detail: `${live.length} acts live, ${fxAdas.size} in fixture` + (missing.length ? `; missing live: ${missing.join(", ")}` : "")
      + (extraIsDiff ? `; not in fixture: ${extra.join(", ")}` : extra.length ? `; ${extra.length} not in fixture (sample, expected)` : ""),
  });

  // The live latest version of each act must be one the fixture holds; otherwise the portal has moved on
  // (a correction or a void) and offline runs on the fixture no longer reflect it.
  const fxVersions = new Set(fx.decisions.map((d) => d.versionId));
  for (const l of live) {
    if (fxAdas.has(l.ada) && !fxVersions.has(l.versionId))
      lines.push({ what: `${l.ada} ${l.versionId.slice(0, 8)}`, ok: false, detail: "live latest version is not in the fixture" });
  }

  // Every fixture record, matched by versionId against the live search result or the live version history.
  // A per-act failure becomes a DIFF line; the rest of the comparison still runs.
  const liveByVersion = new Map<string, DiavgeiaDecision>();
  for (const l of live) {
    if (!fxAdas.has(l.ada)) continue; // already reported above; its history is not compared
    try { for (const v of await versionsOf(client, l, warn)) liveByVersion.set(v.versionId, v); }
    catch (e) {
      if (!isPerActError(e)) throw e;
      lines.push({ what: `${l.ada} history`, ok: false, detail: e.message });
    }
  }
  for (const d of fx.decisions) {
    const tag = `${d.ada} ${d.versionId.slice(0, 8)}${d._reconstructed ? " (reconstructed)" : ""}`;
    let l: DiavgeiaDecision | null | undefined = liveByVersion.get(d.versionId);
    try { l ??= await client.decisionVersion(d.versionId); }
    catch (e) {
      if (!isPerActError(e)) throw e;
      lines.push({ what: tag, ok: false, detail: e.message });
      continue;
    }
    if (!l) { lines.push({ what: tag, ok: false, detail: "version not returned by the live API" }); continue; }
    if (unsupportedAmount(d) ?? unsupportedAmount(l)) {
      // Not hashable (SPEC §2): compare the raw amounts, and everything else by hashing with amounts removed.
      const same = JSON.stringify(rawAmounts(d)) === JSON.stringify(rawAmounts(l)) && actHash(withoutAmounts(d)) === actHash(withoutAmounts(l));
      lines.push({ what: tag, ok: same, detail: same ? `unhashable amount (${unsupportedAmount(d) ?? unsupportedAmount(l)}), otherwise matches` : "differs (record has an unhashable amount)" });
      continue;
    }
    const a = actHash(d), b = actHash(l);
    lines.push({ what: tag, ok: a === b, detail: a === b ? `hash ${a.slice(0, 18)}… matches` : `fixture ${a.slice(0, 18)}… live ${b.slice(0, 18)}…` });
  }

  // Registry records the fixture holds: the fields the verifier uses must still match the live registry.
  const registry = async (what: string, ks: readonly string[], fixture: Record<string, unknown>, get: () => Promise<unknown>) => {
    let live: unknown;
    try { live = await get(); }
    catch (e) { if (!isPerActError(e)) throw e; lines.push({ what, ok: false, detail: (e as Error).message }); return; }
    if (!live) { lines.push({ what, ok: false, detail: "not returned by the live API" }); return; }
    const same = pick(fixture, ks) === pick(live as Record<string, unknown>, ks);
    lines.push({ what, ok: same, detail: same ? `${ks.slice(1).join(", ")} match` : `fixture ${pick(fixture, ks)} live ${pick(live as Record<string, unknown>, ks)}` });
  };
  for (const [uid, o] of Object.entries(fx.organizations ?? {})) await registry(`organization ${uid}`, ORG_FIELDS, o, () => client.organization(uid));
  for (const [id, s] of Object.entries(fx.signers ?? {})) await registry(`signer ${id}`, SIGNER_FIELDS, s, () => client.signer(id));
  return lines;
}
