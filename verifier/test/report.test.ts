import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actHash, isVoid, toCents, unixDay, vatToUint, adaKey, type DiavgeiaDecision } from "../src/canonical.js";
import { FixtureClient } from "../src/diavgeia.js";
import { buildReport, formatEur, versionsOf, type ChainReader, type ChainVersion, type ReportParams } from "../src/report.js";
import { renderPage } from "../src/page.js";
import { adaFromKey } from "../src/chain.js";

const FIXTURE = new URL("../fixtures/athens-2025-11.json", import.meta.url).pathname;
const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
const P: ReportParams = { org: "6013", orgVat: "090025537", type: "Β.2.2", from: "2025-11-24", to: "2025-11-30" };
const quiet = () => {};

const anchorOf = (d: DiavgeiaDecision): ChainVersion => ({
  actHash: actHash(d),
  payerVat: vatToUint(d.extraFieldValues?.org?.afm ?? ""),
  amountCents: toCents(d.extraFieldValues?.sponsor?.[0]?.expenseAmount?.amount),
  issueDate: unixDay(d.issueDate),
  voided: isVoid(d.subject),
});

/** A chain that has anchored every version the portal shows, as `anchor` would. */
async function fullyAnchored(client: FixtureClient): Promise<Map<string, ChainVersion[]>> {
  const m = new Map<string, ChainVersion[]>();
  for (const l of await client.search({ org: P.org, type: P.type, fromIssueDate: P.from, toIssueDate: P.to })) {
    m.set(l.ada, (await versionsOf(client, l, quiet)).map(anchorOf));
  }
  return m;
}

const reader = (m: Map<string, ChainVersion[]>): ChainReader => ({
  versions: async (ada) => m.get(ada) ?? [],
  anchoredAdas: async () => [...m.keys()],
});

/** Write a modified copy of the fixture and return a client over it. */
function clientWith(edit: (f: typeof fx) => void): FixtureClient {
  const copy = JSON.parse(JSON.stringify(fx));
  edit(copy);
  const p = join(mkdtempSync(join(tmpdir(), "dv-")), "fx.json");
  writeFileSync(p, JSON.stringify(copy));
  return new FixtureClient(p);
}

describe("buildReport", () => {
  it("fully anchored fixture: portal = chain, no alarm", async () => {
    const c = new FixtureClient(FIXTURE);
    const r = await buildReport(c, reader(await fullyAnchored(c)), P);
    expect(r.counts).toEqual({ ok: 3, void: 1 });
    // 25,462.16 + 3,018.20 + 595,771.73; the voided 1,860.00 is excluded
    expect(r.portalTotal).toBe(62425209n);
    expect(r.chainTotal).toBe(62425209n);
    expect(r.difference).toBe(0n);
    expect(r.alarm).toBe(false);
    expect(r.orgName).toBe("ΔΗΜΟΣ ΑΘΗΝΑΙΩΝ");
  });

  it("portal edits an amount after anchoring: mismatch, alarm, difference shows it", async () => {
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    const c = clientWith((f) => { f.decisions[0].extraFieldValues.sponsor[0].expenseAmount.amount = 25462.52; });
    const r = await buildReport(c, reader(chain), P);
    expect(r.findings.find((x) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η")!.status).toBe("mismatch");
    expect(r.difference).toBe(36n);
    expect(r.alarm).toBe(true);
  });

  it("act removed from the portal after anchoring: portal-missing, alarm, chain total keeps it", async () => {
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    const c = clientWith((f) => { f.decisions = f.decisions.filter((d: DiavgeiaDecision) => d.ada !== "ΨΨ9ΣΩ6Μ-1ΕΦ"); });
    const r = await buildReport(c, reader(chain), P);
    const gone = r.findings.find((x) => x.ada === "ΨΨ9ΣΩ6Μ-1ΕΦ")!;
    expect(gone.status).toBe("portal-missing");
    expect(gone.chainCents).toBe(59577173n);
    expect(r.difference).toBe(-59577173n);
    expect(r.alarm).toBe(true);
  });

  it("portal-missing ignores anchors of other orgs and other windows", async () => {
    const c = new FixtureClient(FIXTURE);
    const chain = await fullyAnchored(c);
    const base = anchorOf(fx.decisions[0]);
    chain.set("OTHERORG-1", [{ ...base, payerVat: 1n }]);
    chain.set("OUTSIDE-1", [{ ...base, issueDate: unixDay(Date.parse("2025-12-01")) }]);
    const r = await buildReport(c, reader(chain), P);
    expect(r.findings.map((x) => x.ada)).not.toContain("OTHERORG-1");
    expect(r.findings.map((x) => x.ada)).not.toContain("OUTSIDE-1");
    expect(r.alarm).toBe(false);
  });

  it("void not yet anchored: chain-behind, not an alarm", async () => {
    const c = new FixtureClient(FIXTURE);
    const chain = await fullyAnchored(c);
    chain.set("ΨΟΣΝΩ6Μ-Θ6Ε", chain.get("ΨΟΣΝΩ6Μ-Θ6Ε")!.slice(0, 1));
    const r = await buildReport(c, reader(chain), P);
    expect(r.findings.find((x) => x.ada === "ΨΟΣΝΩ6Μ-Θ6Ε")!.status).toBe("chain-behind");
    // chain still counts the original 1,860.00; the portal has voided it
    expect(r.difference).toBe(-186000n);
    expect(r.alarm).toBe(false);
  });

  it("portal silently rewrites an earlier version: mismatch even though the latest matches", async () => {
    const c = new FixtureClient(FIXTURE);
    const chain = await fullyAnchored(c);
    const v = chain.get("ΨΟΣΝΩ6Μ-Θ6Ε")!;
    chain.set("ΨΟΣΝΩ6Μ-Θ6Ε", [{ ...v[0], actHash: ("0x" + "11".repeat(32)) as `0x${string}` }, v[1]]);
    const r = await buildReport(c, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "ΨΟΣΝΩ6Μ-Θ6Ε")!;
    expect(f.status).toBe("mismatch");
    expect(f.detail).toMatch(/^version 1 /);
  });

  it("refuses an orgVat that does not match the portal's acts", async () => {
    await expect(buildReport(new FixtureClient(FIXTURE), reader(new Map()), { ...P, orgVat: "1" })).rejects.toThrow(/pass --vat/);
  });

  it("an act whose payer is not the org (Athens 2025: payer and payee swapped) is unanchorable, not a run-wide error", async () => {
    const c = clientWith((f) => {
      const swapped = JSON.parse(JSON.stringify(f.decisions[0]));
      swapped.ada = "61Θ6Ω6Μ-2ΑΗ"; swapped.versionId = "swapped-1";
      swapped.extraFieldValues.org = { afm: "996607880", name: "ΚΟΙΝΟΠΡΑΞΙΑ" };
      swapped.extraFieldValues.sponsor[0].sponsorAFMName.afm = "090025537";
      swapped.extraFieldValues.sponsor[0].expenseAmount.amount = 1397928.53;
      f.decisions.push(swapped);
    });
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    const r = await buildReport(c, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "61Θ6Ω6Μ-2ΑΗ")!;
    expect(f.status).toBe("unanchorable");
    expect(f.detail).toMatch(/payer VAT 996607880/);
    expect(r.difference).toBe(139792853n); // portal counts it, the chain cannot hold it
    expect(r.alarm).toBe(false);
  });

  it("an act with no payer at all is unanchorable", async () => {
    const c = clientWith((f) => {
      const empty = JSON.parse(JSON.stringify(f.decisions[0]));
      empty.ada = "63ΓΕΩ6Μ-ΧΟ1"; empty.versionId = "empty-1";
      empty.extraFieldValues.org = { enterName: false };
      empty.extraFieldValues.sponsor = [{ expenseAmount: { currency: "EUR" } }];
      f.decisions.push(empty);
    });
    const r = await buildReport(c, reader(await fullyAnchored(new FixtureClient(FIXTURE))), P);
    expect(r.findings.find((x) => x.ada === "63ΓΕΩ6Μ-ΧΟ1")!.detail).toMatch(/^v1: payer VAT \(none\)/);
  });

  it("un-voided after a void (Athens 2025 payroll): chain-behind, explained, not an alarm", async () => {
    const c = new FixtureClient(FIXTURE);
    const chain = await fullyAnchored(c);
    // Portal now shows a v3 that drops the void prefix again
    const c3 = clientWith((f) => {
      const v2 = f.decisions.find((d: DiavgeiaDecision) => d.versionId === "87e590cb-ac02-421b-97e3-3386b2d16fd6");
      const v3 = { ...JSON.parse(JSON.stringify(v2)), versionId: "unvoid-3", correctedVersionId: v2.versionId, subject: "ΠΡΟΜΗΘΕΙΑ ΥΛΙΚΩΝ ΒΡΑΒΕΙΟΥ" };
      f.decisions.push(v3);
      f.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions.push({ versionId: "unvoid-3", versionTimestamp: 1764900000000, correctedVersionId: v2.versionId, status: "PUBLISHED" });
    });
    const r = await buildReport(c3, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "ΨΟΣΝΩ6Μ-Θ6Ε")!;
    expect(f.status).toBe("chain-behind");
    expect(f.detail).toMatch(/v3 is blocked \(the registry accepts nothing after a void/);
    expect(r.difference).toBe(186000n);
    expect(r.alarm).toBe(false);
  });

  it("a correction that drops the payer blocks every later version, and the detail says so (Athens 2025 HIV centre act)", async () => {
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    const c = clientWith((f) => {
      const v1 = f.decisions[0];
      const v2 = { ...JSON.parse(JSON.stringify(v1)), versionId: "nopayer-2", correctedVersionId: v1.versionId };
      v2.extraFieldValues.org = { enterName: false };
      f.decisions.push(v2);
      f.versionlog[v1.ada] = { ada: v1.ada, versions: [
        { versionId: v1.versionId, versionTimestamp: 1, correctedVersionId: null, status: "PUBLISHED" },
        { versionId: "nopayer-2", versionTimestamp: 2, correctedVersionId: v1.versionId, status: "PUBLISHED" }] };
    });
    const r = await buildReport(c, reader(chain), P).catch((e) => e);
    // The latest version has no payer, so 1 of 4 acts disagrees with --vat: still a per-act finding
    const f = r.findings.find((x: { ada: string }) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η");
    expect(f.status).toBe("chain-behind");
    expect(f.detail).toMatch(/v2 is blocked \(payer VAT \(none\) is not the org's/);
  });

  it("counts non-void acts with no amount, which neither total can see", async () => {
    const c = clientWith((f) => {
      delete f.decisions[0].extraFieldValues.sponsor[0].expenseAmount.amount; // live act: counted
      for (const d of f.decisions) if (d.ada === "ΨΟΣΝΩ6Μ-Θ6Ε") delete d.extraFieldValues.sponsor[0].expenseAmount.amount; // voided: not
    });
    const r = await buildReport(c, reader(new Map()), P);
    expect(r.noAmount).toBe(1);
  });

  it("an act anchorable at v1 is unanchored, not unanchorable, even if its latest version has no payer", async () => {
    const c = clientWith((f) => {
      const v1 = f.decisions[0];
      const v2 = { ...JSON.parse(JSON.stringify(v1)), versionId: "nopayer-2", correctedVersionId: v1.versionId };
      v2.extraFieldValues.org = { enterName: false };
      f.decisions.push(v2);
      f.versionlog[v1.ada] = { ada: v1.ada, versions: [
        { versionId: v1.versionId, versionTimestamp: 1, correctedVersionId: null, status: "PUBLISHED" },
        { versionId: "nopayer-2", versionTimestamp: 2, correctedVersionId: v1.versionId, status: "PUBLISHED" }] };
    });
    const r = await buildReport(c, reader(new Map()), P);
    expect(r.findings.find((x) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η")!.status).toBe("unanchored");
  });

  it("with the VAT from Diavgeia's organisation record, many acts without a payer are findings, not a --vat error (Amorgos 2025)", async () => {
    const c = clientWith((f) => { for (const d of f.decisions) d.extraFieldValues.org = null; });
    await expect(buildReport(c, reader(new Map()), P)).rejects.toThrow(/pass --vat/);
    const r = await buildReport(c, reader(new Map()), { ...P, vatFromRegistry: true });
    expect(r.counts).toEqual({ unanchorable: 4 });
  });

  it("a one-act window whose act has another payer is a finding, not a --vat error", async () => {
    const c = clientWith((f) => {
      f.decisions = [f.decisions[0]];
      f.decisions[0].extraFieldValues.org = { afm: "996607880", name: "ΚΟΙΝΟΠΡΑΞΙΑ" };
    });
    const r = await buildReport(c, reader(new Map()), P);
    expect(r.counts).toEqual({ unanchorable: 1 });
  });

  it("nothing anchored: every act unanchored, chain total zero, no alarm", async () => {
    const r = await buildReport(new FixtureClient(FIXTURE), reader(new Map()), P);
    expect(r.counts).toEqual({ unanchored: 4 });
    expect(r.chainTotal).toBe(0n);
    expect(r.alarm).toBe(false);
  });
});

describe("formatEur", () => {
  it("formats integer cents without a float", () => {
    expect(formatEur(62425209n)).toBe("624,252.09 EUR");
    expect(formatEur(5n)).toBe("0.05 EUR");
    expect(formatEur(-186000n)).toBe("-1,860.00 EUR");
    expect(formatEur(0n)).toBe("0.00 EUR");
    expect(formatEur(2n ** 63n)).toBe("92,233,720,368,547,758.08 EUR");
  });
});

describe("adaFromKey", () => {
  it("round-trips Greek ADAs through adaKey", () => {
    for (const ada of ["9ΓΒΝΩ6Μ-Λ4Η", "ΨΟΣΝΩ6Μ-Θ6Ε", "ΨΨ9ΣΩ6Μ-1ΕΦ"]) expect(adaFromKey(adaKey(ada))).toBe(ada);
  });
});

describe("renderPage", () => {
  it("escapes Diavgeia-sourced text and leaves out subjects and payee names", async () => {
    const c = clientWith((f) => { for (const d of f.decisions) d.extraFieldValues.org.name = `<script>alert(1)</script>`; });
    const r = await buildReport(c, reader(new Map()), P);
    const html = renderPage(r, { source: "fixture", fixturePath: "x.json", generatedAt: new Date(0), registry: "0xabc", chainId: 31337 });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    for (const d of fx.decisions as DiavgeiaDecision[]) {
      expect(html).not.toContain(d.subject.slice(0, 20));
      expect(html).not.toContain(d.extraFieldValues.sponsor![0].sponsorAFMName!.name!);
    }
    expect(html).toContain("not the live portal");
  });
});
