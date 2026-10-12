import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { deriveOrgKey, resolveSeed, DEV_SEED, orgSignerAddress } from "../src/orgkeys.js";
import { FixtureClient } from "../src/diavgeia.js";
import { buildReport, type ChainReader, type ReportParams } from "../src/report.js";
import { parseOrganization, parseSigner } from "../src/validate.js";

const FIXTURE = new URL("../fixtures/athens-2025-11.json", import.meta.url).pathname;
const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
const P: ReportParams = { org: "6013", orgVat: "090025537", type: "Β.2.2", from: "2025-11-24", to: "2025-11-30" };
const none: ChainReader = { versions: async () => [], anchoredAdas: async () => [] };
const SEED = ("0x" + "ab".repeat(32)) as `0x${string}`;

function clientWith(edit: (f: typeof fx) => void): FixtureClient {
  const copy = JSON.parse(JSON.stringify(fx));
  edit(copy);
  const p = join(mkdtempSync(join(tmpdir(), "dv-sig-")), "fx.json");
  writeFileSync(p, JSON.stringify(copy));
  return new FixtureClient(p);
}

describe("per-organisation keys", () => {
  it("are deterministic, distinct per organisation and per seed, and valid secp256k1 keys", () => {
    expect(deriveOrgKey(SEED, "6013")).toBe(deriveOrgKey(SEED, "6013"));
    expect(deriveOrgKey(SEED, "6013")).not.toBe(deriveOrgKey(SEED, "6027"));
    expect(deriveOrgKey(SEED, "6013")).not.toBe(deriveOrgKey(DEV_SEED, "6013"));
    for (const uid of ["6013", "6027", "99220730", "1"]) expect(() => privateKeyToAccount(deriveOrgKey(SEED, uid))).not.toThrow();
    expect(orgSignerAddress(SEED, "6013")).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("pin the derivation: changing it would silently re-key every organisation", () => {
    expect(orgSignerAddress(SEED, "6013")).toBe("0x199cC1EaD33dd017C362bB71F823ab6e7e041e1C");
    expect(orgSignerAddress(DEV_SEED, "6013")).toBe("0x1aa10Ca61f601c34a1cE44597EBfc4bC162A62fc");
  });

  it("reject malformed seeds and uids", () => {
    expect(() => deriveOrgKey("0x1234" as `0x${string}`, "6013")).toThrow(/32 bytes/);
    expect(() => deriveOrgKey(SEED, "60 13")).toThrow(/digits/);
  });

  it("the public development seed is only accepted against a local chain", () => {
    expect(resolveSeed({}, true)).toBe(DEV_SEED);
    expect(() => resolveSeed({}, false)).toThrow(/DIAVGEIA_SIGNER_SEED/);
    expect(() => resolveSeed({ DIAVGEIA_SIGNER_SEED: DEV_SEED }, false)).toThrow(/public/);
    expect(resolveSeed({ DIAVGEIA_SIGNER_SEED: SEED }, false)).toBe(SEED);
  });
});

describe("registry records", () => {
  it("accept the verbatim fixture records", () => {
    expect(parseOrganization(fx.organizations["6013"], "6013").vatNumber).toBe("090025537");
    for (const id of Object.keys(fx.signers)) expect(parseSigner(fx.signers[id], id).organizationId).toBe("6013");
  });

  it("reject a record for another id, a malformed VAT, a non-boolean rights flag", () => {
    expect(() => parseOrganization(fx.organizations["6013"], "6027")).toThrow(/record is for 6013/);
    expect(() => parseOrganization({ ...fx.organizations["6013"], vatNumber: "90025537" }, "6013")).toThrow(/9 digits/);
    expect(() => parseSigner({ ...fx.signers["126213"], hasOrganizationSignRights: "false" }, "126213")).toThrow(/boolean/);
  });
});

describe("signer checks in the report", () => {
  it("#1 a source without signer records reports the checks as not run, not as 'unknown signer'", async () => {
    const c = clientWith((f) => { delete f.signers; });
    const r = await buildReport(c, none, P);
    expect(r.signerChecks).toBe("unavailable");
    expect(r.signerIssues).toEqual([]);
    expect(r.signers.every((s) => s.orgSignRights === null)).toBe(true);
  });

  it("#7 activeUntil is exclusive: active through the day before, inactive from that day (Athens-midnight values)", async () => {
    const issue = fx.decisions[0].issueDate; // 2025-11-28 00:00Z, signer 100089761
    const athensMidnight = (day: number) => day - 2 * 3600_000; // EET, as the API stores activeUntil
    const until = (ms: number) => clientWith((f) => { f.signers["100089761"].activeUntil = ms; });
    const sameDay = await buildReport(until(athensMidnight(issue)), none, P);           // ended at the start of the issue day
    const nextDay = await buildReport(until(athensMidnight(issue + 86_400_000)), none, P); // ended at the start of the next day
    expect(sameDay.signerIssues.some((i) => i.ada === fx.decisions[0].ada && /active .* to 2025-11-27/.test(i.issue))).toBe(true);
    expect(nextDay.signerIssues.filter((i) => i.ada === fx.decisions[0].ada)).toEqual([]);
  });

  it("the real fixture: two signers, both of Athens, active, neither with organisation-level rights, no issues", async () => {
    const r = await buildReport(new FixtureClient(FIXTURE), none, P);
    expect(r.signerIssues).toEqual([]);
    expect(r.signers.map((s) => s.orgSignRights)).toEqual([false, false]);
    expect(r.signers.reduce((n, s) => n + s.acts, 0)).toBe(4);
  });

  it("flags a signer who was not yet active on the issue day", async () => {
    const c = clientWith((f) => { f.signers["100089761"].activeFrom = Date.parse("2025-12-01"); });
    const r = await buildReport(c, none, P);
    expect(r.signerIssues.length).toBeGreaterThan(0);
    expect(r.signerIssues[0].issue).toMatch(/not active on the issue day \(active 2025-12-01/);
    expect(r.alarm).toBe(false);
  });

  it("a signer active from the issue day itself is fine (days, not milliseconds)", async () => {
    const c = clientWith((f) => { for (const d of f.decisions) if (d.signerIds.includes("100089761")) f.signers["100089761"].activeFrom = d.issueDate + 6 * 3600_000; });
    const r = await buildReport(c, none, P);
    expect(r.signerIssues.filter((i) => i.issue.includes("not active"))).toEqual([]);
  });

  it("flags a signer of another organisation, and one missing from the registry", async () => {
    const c = clientWith((f) => { f.signers["126213"].organizationId = "6027"; delete f.signers["100089761"]; });
    const r = await buildReport(c, none, P);
    expect(r.signerIssues.some((i) => /belongs to org 6027/.test(i.issue))).toBe(true);
    expect(r.signerIssues.some((i) => /not in Diavgeia's signer registry/.test(i.issue))).toBe(true);
    expect(r.signers.find((s) => s.id === "100089761")!.orgSignRights).toBeNull();
  });
});
