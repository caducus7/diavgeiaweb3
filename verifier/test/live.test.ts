import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { type DiavgeiaDecision } from "../src/canonical.js";
import { FixtureClient, LiveClient, LIVE_WINDOW_DAYS, splitWindows, type VersionLog } from "../src/diavgeia.js";
import { buildReport, versionsOf, type ChainReader, type ReportParams } from "../src/report.js";
import { checkAmount, parseDecision, DiavgeiaShapeError, MAX_AMOUNT } from "../src/validate.js";
import { toCents } from "../src/canonical.js";
import { liveCheck, queryOfFixture } from "../src/livecheck.js";
import { RecordingClient, prefetch } from "../src/record.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = new URL("../fixtures/athens-2025-11.json", import.meta.url).pathname;
const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  decisions: DiavgeiaDecision[]; versionlog: Record<string, VersionLog>;
  organizations: Record<string, unknown>; signers: Record<string, unknown>;
};
const paints = fx.decisions[0];
const P: ReportParams = { org: "6013", orgVat: "090025537", type: "Β.2.2", from: "2025-11-24", to: "2025-11-30" };
const DAY = 86_400_000;
const quiet = () => {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface MockOpts {
  ignoreType?: boolean;
  ignorePage?: boolean;
  maxWindowDays?: number;
}

/** A Diavgeia stand-in over a list of decisions: filters by org, type and issue-date window, returns the
 *  latest version per ADA, pages with size/page, and serves versionlog and decisions/v like the API. */
function mockApi(decisions: DiavgeiaDecision[], logs: Record<string, VersionLog>, o: MockOpts = {}) {
  const calls: URL[] = [];
  const f = async (input: URL | string | Request): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(u);
    const path = decodeURIComponent(u.pathname);
    if (path.endsWith("/search.json")) {
      const q = u.searchParams;
      // Like the real API: the to_issue_date day itself is excluded (see LiveClient.search).
      const from = Date.parse(q.get("from_issue_date")!), toExcl = Date.parse(q.get("to_issue_date")!);
      if (o.maxWindowDays !== undefined && (toExcl - from) / DAY > o.maxWindowDays) throw new Error(`window over ${o.maxWindowDays} days requested`);
      const latest = new Map<string, DiavgeiaDecision>();
      for (const d of decisions) {
        if (d.organizationId !== q.get("org")) continue;
        if (!o.ignoreType && d.decisionTypeId !== q.get("type")) continue;
        if (d.issueDate < from || d.issueDate >= toExcl) continue;
        const cur = latest.get(d.ada);
        if (!cur || d.correctedVersionId === cur.versionId) latest.set(d.ada, d);
      }
      const all = [...latest.values()];
      const size = Number(q.get("size")), page = o.ignorePage ? 0 : Number(q.get("page"));
      const slice = all.slice(page * size, page * size + size);
      return json({ info: { total: all.length, actualSize: slice.length, size, page }, decisions: slice });
    }
    const vl = path.match(/\/decisions\/(.+)\/versionlog\.json$/);
    if (vl) return logs[vl[1]] ? json(logs[vl[1]]) : new Response("not found", { status: 404 });
    const org = path.match(/\/organizations\/(.+)\.json$/);
    if (org) return fx.organizations[org[1]] ? json(fx.organizations[org[1]]) : new Response("not found", { status: 404 });
    const sig = path.match(/\/signers\/(.+)\.json$/);
    if (sig) return fx.signers[sig[1]] ? json(fx.signers[sig[1]]) : new Response("not found", { status: 404 });
    const v = path.match(/\/decisions\/v\/(.+)\.json$/);
    if (v) {
      const d = decisions.find((x) => x.versionId === v[1]);
      return d ? json(d) : new Response("not found", { status: 404 });
    }
    return new Response("no route", { status: 404 });
  };
  return { f: f as unknown as typeof fetch, calls };
}

const live = (f: typeof fetch, extra = {}) => new LiveClient({ base: "https://mock/opendata", fetch: f, backoff: () => 0, ...extra });

/** Synthetic single-version acts spread over a year, cloned from a real record. In memory only. */
function yearOfActs(n: number): DiavgeiaDecision[] {
  const start = Date.parse("2025-01-01");
  return Array.from({ length: n }, (_, i) => ({
    ...paints,
    ada: `SYN-${i}`,
    versionId: `syn-${i}`,
    correctedVersionId: null,
    issueDate: start + Math.floor((i * 365) / n) * DAY,
  }));
}

describe("LiveClient.search", () => {
  it("returns every act of a year split over several windows and pages (regression: shared page counter)", async () => {
    const acts = yearOfActs(600);
    const { f, calls } = mockApi(acts, {}, { maxWindowDays: LIVE_WINDOW_DAYS });
    const r = await live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-01-01", toIssueDate: "2025-12-31", size: 50 });
    expect(r.length).toBe(600);
    expect(new Set(r.map((d) => d.ada)).size).toBe(600);
    expect(calls.length).toBeGreaterThan(5);
  });

  it("keeps acts issued on the last day of every window (regression: to_issue_date is exclusive in the API)", async () => {
    const start = Date.parse("2025-01-01");
    const acts = Array.from({ length: 365 }, (_, i) => ({ ...paints, ada: `DAY-${i}`, versionId: `day-${i}`, correctedVersionId: null, issueDate: start + i * DAY }));
    const { f } = mockApi(acts, {});
    const r = await live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-01-01", toIssueDate: "2025-12-31", size: 500 });
    expect(r.length).toBe(365);
    const one = await live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-03-31", toIssueDate: "2025-03-31" });
    expect(one.map((d) => d.ada)).toEqual(["DAY-89"]);
  });

  it("refuses results when the API ignores the type filter", async () => {
    const other = { ...paints, ada: "OTHER-1", versionId: "other-1", decisionTypeId: "Β.1.3" };
    const { f } = mockApi([...fx.decisions, other], fx.versionlog, { ignoreType: true });
    await expect(live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" }))
      .rejects.toThrow(/asked for type Β\.2\.2, got OTHER-1/);
  });

  it("refuses a short result when the API ignores the page parameter", async () => {
    const { f } = mockApi(yearOfActs(120), {}, { ignorePage: true });
    await expect(live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-01-01", toIssueDate: "2025-03-31", size: 10 }))
      .rejects.toThrow(/reported \d+ acts but returned 10 distinct versions/);
  });

  it("rejects an act outside the requested window", async () => {
    const stray = { ...paints, ada: "STRAY-1", versionId: "stray-1", issueDate: Date.parse("2025-06-01") };
    const { f: base } = mockApi(fx.decisions, fx.versionlog);
    const f = (async (u: URL) => {
      const r = await base(u);
      if (!String(u).includes("search.json")) return r;
      const b = await r.json();
      b.decisions.push(stray); b.info.total++; b.info.actualSize++;
      return json(b);
    }) as unknown as typeof fetch;
    await expect(live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" }))
      .rejects.toThrow(/STRAY-1 issued 2025-06-01/);
  });

  it("rejects a malformed record instead of hashing it", async () => {
    const bad = { ...paints, signerIds: [100089761] };
    const { f } = mockApi([bad as unknown as DiavgeiaDecision], {});
    await expect(live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" }))
      .rejects.toThrow(DiavgeiaShapeError);
  });
});

describe("LiveClient HTTP handling", () => {
  const flaky = (failures: number, status: number, then: Response | (() => Response)) => {
    let n = 0;
    return (async () => (n++ < failures ? new Response("busy", { status }) : typeof then === "function" ? then() : then.clone())) as unknown as typeof fetch;
  };

  it("retries 5xx and 429, then succeeds", async () => {
    expect(await live(flaky(2, 503, json(fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"]))).versionLog("ΨΟΣΝΩ6Μ-Θ6Ε")).not.toBeNull();
    expect(await live(flaky(1, 429, json(fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"]))).versionLog("ΨΟΣΝΩ6Μ-Θ6Ε")).not.toBeNull();
  });

  it("a persistent 5xx on the version log is an error, not 'no history'", async () => {
    await expect(live(flaky(99, 500, json({}))).versionLog("ΨΟΣΝΩ6Μ-Θ6Ε")).rejects.toThrow(/diavgeia 500/);
  });

  it("404 on the version log means no history", async () => {
    expect(await live(flaky(0, 200, new Response("nf", { status: 404 }))).versionLog("ΨΟΣΝΩ6Μ-Θ6Ε")).toBeNull();
  });

  it("network failures are retried, then reported", async () => {
    let n = 0;
    const f = (async () => { n++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(live(f).versionLog("X")).rejects.toThrow(/unreachable after 4 attempts/);
    expect(n).toBe(4);
  });

  it("a 4xx other than 404 and 429 is not retried", async () => {
    let n = 0;
    const f = (async () => { n++; return new Response("forbidden", { status: 403 }); }) as unknown as typeof fetch;
    await expect(live(f).versionLog("X")).rejects.toThrow(/diavgeia 403/);
    expect(n).toBe(1);
  });

  it("non-JSON 200 (an HTML error page) is an error", async () => {
    await expect(live(flaky(0, 200, new Response("<html>maintenance</html>", { status: 200 }))).versionLog("X")).rejects.toThrow(/non-JSON/);
  });

  it("decisionVersion refuses a record for a different version", async () => {
    await expect(live(flaky(0, 200, json(paints))).decisionVersion("303d2b3a-90a2-4a17-a6b2-79421af7095e")).rejects.toThrow(/asked for version/);
  });

  it("a version log for another ADA is rejected", async () => {
    await expect(live(flaky(0, 200, json(fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"]))).versionLog("9ΓΒΝΩ6Μ-Λ4Η")).rejects.toThrow(/log is for/);
  });
});

describe("live and fixture paths agree", () => {
  it("buildReport over LiveClient (mocked from the fixture) equals buildReport over FixtureClient", async () => {
    const chain: ChainReader = { versions: async () => [], anchoredAdas: async () => [] };
    const { f } = mockApi(fx.decisions, fx.versionlog);
    const a = await buildReport(live(f), chain, P);
    const b = await buildReport(new FixtureClient(FIXTURE), chain, P);
    const strip = (r: typeof a) => ({ ...r, findings: [...r.findings].sort((x, y) => x.ada.localeCompare(y.ada)) });
    expect(strip(a)).toEqual(strip(b));
    expect(a.portalTotal).toBe(62425209n);
  });
});

describe("versionsOf", () => {
  it("throws when the version log does not end with the version search returned", async () => {
    const latest = fx.decisions.find((d) => d.versionId === "87e590cb-ac02-421b-97e3-3386b2d16fd6")!;
    const log = { ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"], versions: [fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions[0], { ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions[1], versionId: "someone-else" }] };
    const { f } = mockApi(fx.decisions, { "ΨΟΣΝΩ6Μ-Θ6Ε": log });
    await expect(versionsOf(live(f), latest, quiet)).rejects.toThrow(/version log's latest is someone-else/);
  });

  it("walks the real void chain oldest first", async () => {
    const latest = fx.decisions.find((d) => d.versionId === "87e590cb-ac02-421b-97e3-3386b2d16fd6")!;
    const { f } = mockApi(fx.decisions, fx.versionlog);
    const vs = await versionsOf(live(f), latest, quiet);
    expect(vs.map((d) => d.versionId)).toEqual(["303d2b3a-90a2-4a17-a6b2-79421af7095e", "87e590cb-ac02-421b-97e3-3386b2d16fd6"]);
  });
});

describe("validation", () => {
  it("accepts every fixture record (real API output)", () => {
    for (const d of fx.decisions) expect(() => parseDecision(d)).not.toThrow();
  });

  it("rejects amounts the canonical form would round or mangle (SPEC §2)", () => {
    expect(() => checkAmount(25462.165, "a")).toThrow(/more than two decimals/);
    expect(() => checkAmount(0.1 + 0.2, "a")).toThrow(/more than two decimals/);
    expect(() => checkAmount("25462.16", "a")).toThrow(/finite number/);
    expect(() => checkAmount(-1, "a")).toThrow(/negative/);
    expect(() => checkAmount(Infinity, "a")).toThrow(/finite number/);
    expect(() => checkAmount(1e14, "a")).toThrow(/above/);
    expect(() => checkAmount(70368744177664.01, "a")).toThrow(/above/); // where doubles get coarser than a cent
    for (const ok of [25462.16, 1860, 595771.73, 3018.2, 0, 0.01, 999999999999.99, 1e12]) expect(() => checkAmount(ok, "a")).not.toThrow();
  });

  it("rejects an ADA longer than the bytes32 key", () => {
    expect(() => parseDecision({ ...paints, ada: "Ω".repeat(17) })).toThrow(/longer than 32 bytes/);
  });
});

describe("date ranges", () => {
  it("malformed or reversed dates throw instead of yielding no windows", () => {
    expect(() => splitWindows("2025-13-01", "2025-12-31")).toThrow(/YYYY-MM-DD/);
    expect(() => splitWindows("2025-02-30", "2025-03-01")).toThrow(/YYYY-MM-DD/);
    expect(() => splitWindows("1/1/2025", "2025-12-31")).toThrow(/YYYY-MM-DD/);
    expect(() => splitWindows("2025-12-31", "2025-01-01")).toThrow(/after/);
  });

  it("windows tile the range exactly: no gap, no overlap, none longer than the limit", () => {
    for (const [from, to, days] of [["2024-01-01", "2025-12-31", 90], ["2025-02-28", "2025-03-01", 1], ["2025-11-30", "2025-11-30", 90], ["2020-02-29", "2026-10-11", 180]] as const) {
      const w = splitWindows(from, to, days);
      expect(w[0][0]).toBe(from);
      expect(w[w.length - 1][1]).toBe(to);
      for (let i = 0; i < w.length; i++) {
        const len = (Date.parse(w[i][1]) - Date.parse(w[i][0])) / DAY + 1;
        expect(len).toBeGreaterThan(0);
        expect(len).toBeLessThanOrEqual(days);
        if (i > 0) expect(Date.parse(w[i][0]) - Date.parse(w[i - 1][1])).toBe(DAY);
      }
    }
  });

  it("buildReport rejects a bad date before querying anything", async () => {
    let searched = false;
    const client = { search: async () => { searched = true; return []; }, versionLog: async () => null, decisionVersion: async () => null, organization: async () => null, signer: async () => null };
    const chain: ChainReader = { versions: async () => [], anchoredAdas: async () => [] };
    await expect(buildReport(client, chain, { ...P, to: "2025-11-31" })).rejects.toThrow(/YYYY-MM-DD/);
    expect(searched).toBe(false);
  });
});

describe("live-check", () => {
  it("a _sample fixture expects extra live acts but still flags missing ones", async () => {
    const extra = { ...paints, ada: "NEW-1", versionId: "new-1" };
    const { f } = mockApi([...fx.decisions, extra], fx.versionlog);
    const sample = { ...fx, _sample: "subset" };
    expect((await liveCheck(live(f), sample as never, quiet)).filter((l) => !l.ok)).toEqual([]);
    const { f: f2 } = mockApi(fx.decisions.filter((d) => d.ada !== "ΨΨ9ΣΩ6Μ-1ΕΦ"), fx.versionlog);
    const bad = (await liveCheck(live(f2), sample as never, quiet)).filter((l) => !l.ok);
    expect(bad[0].detail).toMatch(/missing live: ΨΨ9ΣΩ6Μ-1ΕΦ/);
  });

  it("reads a hand-made _source URL as the API ran it (to_issue_date exclusive), and prefers _query", () => {
    expect(queryOfFixture(fx as never)).toEqual({ org: "6013", type: "Β.2.2", from: "2025-11-24", to: "2025-11-29" });
    expect(queryOfFixture({ ...fx, _query: { org: "1", type: "T", from: "2025-01-01", to: "2025-01-31" } } as never))
      .toEqual({ org: "1", type: "T", from: "2025-01-01", to: "2025-01-31" });
  });

  it("all ok when the API returns what the fixture holds", async () => {
    const { f } = mockApi(fx.decisions, fx.versionlog);
    const lines = await liveCheck(live(f), fx as never, quiet);
    expect(lines.length).toBe(1 + fx.decisions.length + Object.keys(fx.organizations).length + Object.keys(fx.signers).length);
    expect(lines.filter((l) => !l.ok)).toEqual([]);
  });

  it("flags a record whose live content differs, and a live act the fixture lacks", async () => {
    const drifted = fx.decisions.map((d, i) => (i === 2 ? { ...d, subject: d.subject + " " } : d));
    const extra = { ...paints, ada: "NEW-1", versionId: "new-1" };
    const { f } = mockApi([...drifted, extra], fx.versionlog);
    const whole = { ...fx, _sample: undefined };
    const bad = (await liveCheck(live(f), whole as never, quiet)).filter((l) => !l.ok);
    expect(bad.map((l) => l.what.split(" ")[0])).toEqual(["search", fx.decisions[2].ada]);
    expect(bad[0].detail).toMatch(/not in fixture: NEW-1/);
  });

  it("flags a reconstructed record the API disagrees with", async () => {
    const recon = fx.decisions.find((d) => (d as { _reconstructed?: boolean })._reconstructed)!;
    const real = fx.decisions.map((d) => (d === recon ? { ...d, protocolNumber: "different" } : d));
    const { f } = mockApi(real, fx.versionlog);
    const bad = (await liveCheck(live(f), fx as never, quiet)).filter((l) => !l.ok);
    expect(bad.length).toBe(1);
    expect(bad[0].what).toMatch(/\(reconstructed\)$/);
  });
});

describe("RecordingClient", () => {
  it("a recorded live run replays offline to the same report", async () => {
    const chain: ChainReader = { versions: async () => [], anchoredAdas: async () => [] };
    const { f } = mockApi(fx.decisions, fx.versionlog);
    const rec = new RecordingClient(live(f), "https://diavgeia.gov.gr/opendata");
    const a = await buildReport(rec, chain, P);
    const path = join(mkdtempSync(join(tmpdir(), "dv-rec-")), "rec.json");
    rec.save(path, new Date("2026-10-11"));
    expect(rec.size).toBe(5);
    const b = await buildReport(new FixtureClient(path), chain, P);
    expect(b).toEqual(a);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(queryOfFixture(saved)).toEqual({ org: "6013", type: "Β.2.2", from: "2025-11-24", to: "2025-11-30" });
  });
});

describe("code review fixes", () => {
  const chainNone: ChainReader = { versions: async () => [], anchoredAdas: async () => [] };

  it("#1 one act with a contradictory history is a history-error; the other acts are still reconciled", async () => {
    const badLog = { ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"], versions: [{ ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions[0], versionId: "ghost" }, { ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions[1], versionId: "ghost-2" }] };
    const { f } = mockApi(fx.decisions, { "ΨΟΣΝΩ6Μ-Θ6Ε": badLog });
    const r = await buildReport(live(f), chainNone, P);
    expect(r.counts).toEqual({ unanchored: 3, "history-error": 1 });
    expect(r.alarm).toBe(true);
    expect(r.portalTotal).toBe(62425209n); // the voided act is still excluded by its subject
  });

  it("#1 a network failure still aborts the run rather than becoming a per-act finding", async () => {
    const { f: base } = mockApi(fx.decisions, fx.versionlog);
    const f = (async (u: URL) => (String(u).includes("versionlog") ? Promise.reject(new TypeError("fetch failed")) : base(u))) as unknown as typeof fetch;
    await expect(buildReport(live(f), chainNone, P)).rejects.toThrow(/unreachable/);
  });

  it("#2 FixtureClient rejects a malformed date instead of matching every act", async () => {
    await expect(new FixtureClient(FIXTURE).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-13-01", toIssueDate: "2025-11-30" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("#3 live-check flags a newer live version of a fixture act", async () => {
    const v2 = { ...paints, versionId: "paints-v2", correctedVersionId: paints.versionId, subject: "ΑΚΥΡΟ ΧΡΗΜΑΤΙΚΟ ΕΝΤΑΛΜΑ. " + paints.subject };
    const logs = { ...fx.versionlog, [paints.ada]: { ada: paints.ada, versions: [
      { versionId: paints.versionId, versionTimestamp: 1, correctedVersionId: null, status: "PUBLISHED" },
      { versionId: "paints-v2", versionTimestamp: 2, correctedVersionId: paints.versionId, status: "PUBLISHED" }] } };
    const { f } = mockApi([...fx.decisions, v2], logs);
    const bad = (await liveCheck(live(f), fx as never, quiet)).filter((l) => !l.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0].detail).toMatch(/live latest version is not in the fixture/);
  });

  it("#4 a one-entry version log naming another version is caught", async () => {
    const { f } = mockApi(fx.decisions, { [paints.ada]: { ada: paints.ada, versions: [{ versionId: "other", versionTimestamp: 1, correctedVersionId: null, status: "PUBLISHED" }] } });
    await expect(versionsOf(live(f), paints, quiet)).rejects.toThrow(/version log's latest is other/);
  });

  it("#5 live-check reports a per-act failure as a DIFF line and keeps going", async () => {
    const { f } = mockApi(fx.decisions, { "ΨΟΣΝΩ6Μ-Θ6Ε": { ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"], versions: [{ ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions[0], versionId: "ghost" }] } });
    const lines = await liveCheck(live(f), fx as never, quiet);
    expect(lines.find((l) => l.what === "ΨΟΣΝΩ6Μ-Θ6Ε history")!.ok).toBe(false);
    expect(lines.filter((l) => l.ok).length).toBeGreaterThanOrEqual(4);
  });

  it("#6 the live window check is as strict as fixture replay (Athens-midnight dates are reported, not absorbed)", async () => {
    const athensMidnight = { ...paints, ada: "TZ-1", versionId: "tz-1", issueDate: Date.parse("2025-11-23T22:00:00Z") };
    const { f: base } = mockApi(fx.decisions, fx.versionlog);
    const f = (async (u: URL) => {
      const r = await base(u);
      if (!String(u).includes("search.json")) return r;
      const b = await r.json(); b.decisions.push(athensMidnight); b.info.total++; b.info.actualSize++;
      return json(b);
    }) as unknown as typeof fetch;
    await expect(live(f).search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" }))
      .rejects.toThrow(/TZ-1 issued 2025-11-23T22:00:00.000Z; if this is Athens midnight/);
  });

  it("#7 org: null is accepted, as the canonical form already handles it", () => {
    expect(() => parseDecision({ ...paints, extraFieldValues: { ...paints.extraFieldValues, org: null } })).not.toThrow();
  });

  it("#9 a timeout while reading the body is retried", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) return { ok: true, status: 200, text: () => Promise.reject(new DOMException("timed out", "TimeoutError")), body: null } as unknown as Response;
      return json(fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"]);
    }) as unknown as typeof fetch;
    expect(await live(f).versionLog("ΨΟΣΝΩ6Μ-Θ6Ε")).not.toBeNull();
    expect(n).toBe(2);
  });
});

describe("second review fixes", () => {
  it("#6 every two-decimal amount up to MAX_AMOUNT passes the check and converts to exactly its cents", () => {
    // Deterministic sample across the range, weighted to the top where doubles are coarsest.
    const maxCents = BigInt(MAX_AMOUNT) * 100n;
    let x = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 20000; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const cents = i % 2 ? maxCents - (x % 1000000n) : x % (maxCents + 1n);
      const text = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
      const v = JSON.parse(text) as number; // how the API's number arrives
      expect(() => checkAmount(v, text)).not.toThrow();
      expect(toCents(v)).toBe(cents);
    }
  });

  it("#2 missing or null signerIds is accepted (hashes as [])", () => {
    expect(() => parseDecision({ ...paints, signerIds: null })).not.toThrow();
    const { signerIds: _, ...rest } = paints;
    expect(() => parseDecision(rest)).not.toThrow();
    expect(() => parseDecision({ ...paints, signerIds: "100089761" })).toThrow(/signerIds/);
  });

  it("#7 fixture and live filters agree on an NFD act type", async () => {
    const nfd = { ...paints, decisionTypeId: paints.decisionTypeId.normalize("NFD") };
    const path = join(mkdtempSync(join(tmpdir(), "dv-nfd-")), "fx.json");
    writeFileSync(path, JSON.stringify({ decisions: [nfd] }));
    const q = { org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" };
    const { f } = mockApi([nfd], {}, { ignoreType: true });
    expect((await live(f).search(q)).length).toBe((await new FixtureClient(path).search(q)).length);
  });

  it("#9 live-check does not fetch histories of acts outside the fixture", async () => {
    const extra = yearOfActs(30).map((d) => ({ ...d, issueDate: Date.parse("2025-11-25") }));
    const { f, calls } = mockApi([...fx.decisions, ...extra], fx.versionlog);
    await liveCheck(live(f), fx as never, quiet);
    expect(calls.filter((u) => u.pathname.includes("versionlog") && u.pathname.includes("SYN-")).length).toBe(0);
  });

  it("#4 a failed recorded run keeps a partial, marked recording", async () => {
    const { f } = mockApi(fx.decisions, fx.versionlog);
    const rec = new RecordingClient(live(f), "https://diavgeia.gov.gr/opendata");
    await rec.search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" });
    const path = join(mkdtempSync(join(tmpdir(), "dv-part-")), "p.json");
    rec.save(path, new Date("2026-10-11"), "boom");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved._partial).toBe(true);
    expect(saved._failure).toBe("boom");
    expect(() => new FixtureClient(path)).not.toThrow();
  });
});

describe("fourth review fixes", () => {
  it("#10 live-check flags a signer whose registry record changed since the fixture", async () => {
    const changed = { ...fx, signers: { ...fx.signers, "126213": { ...(fx.signers["126213"] as object), activeUntil: 1767225600000 } } };
    const { f } = mockApi(fx.decisions, fx.versionlog);
    const bad = (await liveCheck(live(f), changed as never, quiet)).filter((l) => !l.ok);
    expect(bad.map((l) => l.what)).toEqual(["signer 126213"]);
  });

  it("#2 a signer record that cannot be fetched is noted, and the recording still completes", async () => {
    const { f: base } = mockApi(fx.decisions, fx.versionlog);
    const f = (async (u: URL) => (String(u).includes("/signers/126213") ? new Response("boom", { status: 403 }) : base(u))) as unknown as typeof fetch;
    const r = await prefetch(new RecordingClient(live(f), "x"), { org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" });
    expect(r.acts).toBe(4);
    expect(r.signerErrors.map((e) => e.id)).toEqual(["126213"]);
  });

  it("#3 a signer lookup failure in verify is a signer issue, not an abort", async () => {
    const { f: base } = mockApi(fx.decisions, fx.versionlog);
    const f = (async (u: URL) => (String(u).includes("/signers/") ? new Response("boom", { status: 403 }) : base(u))) as unknown as typeof fetch;
    const chain: ChainReader = { versions: async () => [], anchoredAdas: async () => [] };
    const r = await buildReport(live(f), chain, P);
    expect(r.portalTotal).toBe(62425209n);
    expect(r.signerIssues.every((i) => /signer record unavailable: diavgeia 403/.test(i.issue))).toBe(true);
    expect(r.signerIssues.length).toBe(4);
  });
});

describe("prefetch", () => {
  it("fetches every history with bounded concurrency and replays to the same report", async () => {
    let inFlight = 0, peak = 0;
    const { f: base } = mockApi(fx.decisions, fx.versionlog);
    const f = (async (u: URL) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); try { return await base(u); } finally { inFlight--; } }) as unknown as typeof fetch;
    const rec = new RecordingClient(live(f), "https://diavgeia.gov.gr/opendata");
    const r = await prefetch(rec, { org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" }, 2);
    expect(r).toMatchObject({ acts: 4, versions: 5, perActErrors: [], missingVersions: [] });
    expect(peak).toBeLessThanOrEqual(2);
    const path = join(mkdtempSync(join(tmpdir(), "dv-pre-")), "p.json");
    rec.save(path);
    const chain: ChainReader = { versions: async () => [], anchoredAdas: async () => [] };
    expect(await buildReport(new FixtureClient(path), chain, P)).toEqual(await buildReport(new FixtureClient(FIXTURE), chain, P));
  });

  it("reports a version it could not retrieve instead of silently recording without it", async () => {
    const { f } = mockApi(fx.decisions.filter((d) => d.versionId !== "303d2b3a-90a2-4a17-a6b2-79421af7095e"), fx.versionlog);
    const r = await prefetch(new RecordingClient(live(f), "x"), { org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" });
    expect(r.missingVersions).toHaveLength(1);
    expect(r.missingVersions[0]).toMatch(/303d2b3a/);
  });

  it("records the URL as sent (to + 1 day) and the inclusive query separately", async () => {
    const { f } = mockApi(fx.decisions, fx.versionlog);
    const rec = new RecordingClient(live(f), "https://diavgeia.gov.gr/opendata");
    await rec.search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" });
    const path = join(mkdtempSync(join(tmpdir(), "dv-q-")), "q.json");
    rec.save(path);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved._source).toMatch(/to_issue_date=2025-12-01$/);
    expect(saved._query.to).toBe("2025-11-30");
  });

  it("collects per-act errors instead of stopping", async () => {
    const { f } = mockApi(fx.decisions, { "ΨΟΣΝΩ6Μ-Θ6Ε": { ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"], versions: [{ ...fx.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions[0], versionId: "ghost" }] } });
    const r = await prefetch(new RecordingClient(live(f), "x"), { org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" });
    expect(r.acts).toBe(4);
    expect(r.perActErrors.map((e) => e.ada)).toEqual(["ΨΟΣΝΩ6Μ-Θ6Ε"]);
  });
});
