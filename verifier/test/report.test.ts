import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actHash, anchorPayment, isVoid, unixDay, vatToUint, adaKey, type DiavgeiaDecision } from "../src/canonical.js";
import { FixtureClient } from "../src/diavgeia.js";
import { buildReport, checkFallbackVat, formatEur, versionsOf, type ChainReader, type ChainVersion, type ReportParams } from "../src/report.js";
import { renderPage } from "../src/page.js";
import { adaFromKey, blockRanges, toAnchor, ZERO32 } from "../src/chain.js";

const FIXTURE = new URL("../fixtures/athens-2025-11.json", import.meta.url).pathname;
const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
const P: ReportParams = { org: "6013", orgVat: "090025537", type: "Β.2.2", from: "2025-11-24", to: "2025-11-30" };
const quiet = () => {};

const anchorOf = (d: DiavgeiaDecision): ChainVersion => ({
  actHash: actHash(d),
  payerVat: vatToUint(P.orgVat), // as `anchor` writes it: the org's VAT, whatever the act types
  amountCents: anchorPayment(d).amountCents, // as `anchor` writes it
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

/** 61Θ6Ω6Μ-2ΑΗ as Athens published it: payer and payee swapped. */
function swappedAct(template: DiavgeiaDecision): DiavgeiaDecision {
  const s = JSON.parse(JSON.stringify(template));
  s.ada = "61Θ6Ω6Μ-2ΑΗ"; s.versionId = "swapped-1";
  s.extraFieldValues.org = { afm: "996607880", name: "ΚΟΙΝΟΠΡΑΞΙΑ" };
  s.extraFieldValues.sponsor[0].sponsorAFMName.afm = "090025537";
  s.extraFieldValues.sponsor[0].expenseAmount.amount = 1397928.53;
  return s;
}

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

  it("an act whose typed payer is not the org (Athens 2025: payer and payee swapped) is anchored under the org's VAT and noted", async () => {
    const c = clientWith((f) => { f.decisions.push(swappedAct(f.decisions[0])); });
    const r = await buildReport(c, reader(await fullyAnchored(c)), P);
    expect(r.findings.find((x) => x.ada === "61Θ6Ω6Μ-2ΑΗ")!.status).toBe("ok");
    expect(r.difference).toBe(0n);
    expect(r.payerNotes).toEqual({ empty: 0, other: [{ ada: "61Θ6Ω6Μ-2ΑΗ", typedVat: "996607880" }] });
    expect(r.orgName).toBe("ΔΗΜΟΣ ΑΘΗΝΑΙΩΝ"); // from the organisation record, not the typed payer name
    expect(r.alarm).toBe(false);
  });

  it("an act with no payer at all is anchored and counted as an empty payer", async () => {
    const c = clientWith((f) => {
      const empty = JSON.parse(JSON.stringify(f.decisions[0]));
      empty.ada = "63ΓΕΩ6Μ-ΧΟ1"; empty.versionId = "empty-1";
      empty.extraFieldValues.org = { enterName: false };
      empty.extraFieldValues.sponsor = [{ expenseAmount: { currency: "EUR" } }];
      f.decisions.push(empty);
    });
    const r = await buildReport(c, reader(await fullyAnchored(c)), P);
    expect(r.findings.find((x) => x.ada === "63ΓΕΩ6Μ-ΧΟ1")!.status).toBe("ok");
    expect(r.payerNotes.empty).toBe(1);
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

  it("a correction that drops the payer is not blocked: the chain is merely behind (Athens 2025 HIV centre act)", async () => {
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
    const r = await buildReport(c, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η")!;
    expect(f.status).toBe("chain-behind");
    expect(f.detail).toMatch(/the rest are not anchored yet/);
  });

  it("an act anchored under another organisation's VAT is an alarm, and not in this organisation's chain total", async () => {
    const c = new FixtureClient(FIXTURE);
    const chain = await fullyAnchored(c);
    chain.set("ΨΨ9ΣΩ6Μ-1ΕΦ", chain.get("ΨΨ9ΣΩ6Μ-1ΕΦ")!.map((v) => ({ ...v, payerVat: 90256954n })));
    const r = await buildReport(c, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "ΨΨ9ΣΩ6Μ-1ΕΦ")!;
    expect(f.status).toBe("foreign-anchor");
    expect(f.detail).toMatch(/version 1 on chain is anchored under VAT 90256954/);
    expect(r.difference).toBe(59577173n);
    expect(r.alarm).toBe(true);
  });

  it("a version record of another ADA is a history-error", async () => {
    const c = clientWith((f) => {
      for (const d of f.decisions) if (d.versionId !== "87e590cb-ac02-421b-97e3-3386b2d16fd6" && d.ada === "ΨΟΣΝΩ6Μ-Θ6Ε") d.ada = "9ΓΒΝΩ6Μ-Λ4Η";
    });
    const r = await buildReport(c, reader(new Map()), P);
    expect(r.findings.find((x) => x.ada === "ΨΟΣΝΩ6Μ-Θ6Ε")!.detail).toMatch(/is of ADA 9ΓΒΝΩ6Μ-Λ4Η/);
  });

  it("an act with a negative amount and nothing anchored is unsupported: reported, in neither total, no alarm (Thessaloniki 2025)", async () => {
    const c = clientWith((f) => { f.decisions[0].extraFieldValues.sponsor.push({ ...f.decisions[0].extraFieldValues.sponsor[0], expenseAmount: { amount: -1267.94, currency: "EUR" } }); });
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    chain.delete("9ΓΒΝΩ6Μ-Λ4Η");
    const r = await buildReport(c, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η")!;
    expect(f.status).toBe("unsupported");
    expect(f.detail).toMatch(/v1 has payee 2: negative amount -1267.94/);
    expect(f.portalCents).toBeNull();
    expect(r.difference).toBe(0n);
    expect(r.alarm).toBe(false);
  });

  it("an earlier unsupported version keeps the whole act out of both totals while nothing is anchored", async () => {
    const c = clientWith((f) => {
      const v1 = f.decisions[0];
      const v2 = { ...JSON.parse(JSON.stringify(v1)), versionId: "fixed-2", correctedVersionId: v1.versionId };
      v1.extraFieldValues.sponsor[0].expenseAmount.amount = 5.68434e-14; // Heraklion 2025
      f.decisions.push(v2);
      f.versionlog[v1.ada] = { ada: v1.ada, versions: [
        { versionId: v1.versionId, versionTimestamp: 1, correctedVersionId: null, status: "PUBLISHED" },
        { versionId: "fixed-2", versionTimestamp: 2, correctedVersionId: v1.versionId, status: "PUBLISHED" }] };
    });
    const r = await buildReport(c, reader(new Map()), P);
    const f = r.findings.find((x) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η")!;
    expect(f.status).toBe("unsupported");
    expect(f.detail).toMatch(/^v1 has payee 1: amount 5.68434e-14 has more than two decimals/);
    expect(r.portalTotal).toBe(62425209n - 2546216n);
  });

  it("an unsupported amount never hides tampering: an anchored version the portal now shows negative is a mismatch", async () => {
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    const c = clientWith((f) => { f.decisions[0].extraFieldValues.sponsor[0].expenseAmount.amount = -25462.16; });
    const r = await buildReport(c, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η")!;
    expect(f.status).toBe("mismatch");
    expect(f.detail).toMatch(/version 1 is on chain, but the portal's now has payee 1: negative amount/);
    expect(r.alarm).toBe(true);
    expect(r.difference).toBe(-2546216n); // the chain still counts what was anchored
  });

  it("a later unsupported version cannot hide an edit to an anchored one (review 2026-10-14)", async () => {
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    chain.set("ΨΟΣΝΩ6Μ-Θ6Ε", chain.get("ΨΟΣΝΩ6Μ-Θ6Ε")!.slice(0, 1)); // chain holds v1 only
    const c = clientWith((f) => {
      for (const d of f.decisions) if (d.ada === "ΨΟΣΝΩ6Μ-Θ6Ε") {
        if (d.versionId === "87e590cb-ac02-421b-97e3-3386b2d16fd6") d.extraFieldValues.sponsor[0].expenseAmount.amount = -0.01; // v2
        else d.extraFieldValues.sponsor[0].expenseAmount.amount = 99999.99; // v1, edited after anchoring
      }
    });
    const r = await buildReport(c, reader(chain), P);
    const f = r.findings.find((x) => x.ada === "ΨΟΣΝΩ6Μ-Θ6Ε")!;
    expect(f.status).toBe("mismatch");
    expect(f.detail).toMatch(/^version 1 on chain/);
    expect(r.alarm).toBe(true);
  });

  it("an anchored act moved to the neighbouring day is portal-missing, not skipped (review 2026-10-14)", async () => {
    const c = clientWith((f) => {
      const moved = { ...JSON.parse(JSON.stringify(f.decisions[0])), ada: "MOVED-1", versionId: "MOVED-1-v1", issueDate: Date.parse("2025-12-01T00:00:00Z") };
      moved.extraFieldValues.sponsor[0].expenseAmount.amount = 1;
      f.decisions.push(moved);
    });
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    chain.set("MOVED-1", [{ ...anchorOf(fx.decisions[0]), issueDate: unixDay(Date.parse("2025-11-30")) }]);
    const r = await buildReport(c, reader(chain), P);
    expect(r.findings.find((x) => x.ada === "MOVED-1")?.status).toBe("portal-missing");
    expect(r.alarm).toBe(true);
  });

  it("the multi-payee sum leaves out an act reported unsupported", async () => {
    const c = clientWith((f) => {
      const v1 = f.decisions[0];
      const v2 = { ...JSON.parse(JSON.stringify(v1)), versionId: "two-lines-2", correctedVersionId: v1.versionId };
      v2.extraFieldValues.sponsor.push({ sponsorAFMName: { afm: "999999999", name: "B" }, expenseAmount: { amount: 50, currency: "EUR" } });
      v1.extraFieldValues.sponsor[0].expenseAmount.amount = -1;
      f.decisions.push(v2);
      f.versionlog[v1.ada] = { ada: v1.ada, versions: [
        { versionId: v1.versionId, versionTimestamp: 1, correctedVersionId: null, status: "PUBLISHED" },
        { versionId: "two-lines-2", versionTimestamp: 2, correctedVersionId: v1.versionId, status: "PUBLISHED" }] };
    });
    const r = await buildReport(c, reader(new Map()), P);
    expect(r.findings.find((x) => x.ada === "9ΓΒΝΩ6Μ-Λ4Η")!.status).toBe("unsupported");
    expect(r.multiPayee).toBe(1);
    expect(r.splitPayee).toBe(0);
    expect(r.splitUncounted).toBe(0n);
  });

  it("portal-missing at the window's edges reads the anchor's UTC day as either Athens day (Piraeus 2025 stores Athens midnight)", async () => {
    const day = (iso: string) => unixDay(Date.parse(iso));
    const c = clientWith((f) => {
      const at = (ada: string, iso: string) => ({ ...JSON.parse(JSON.stringify(f.decisions[0])), ada, versionId: `${ada}-v1`, issueDate: Date.parse(iso) });
      f.decisions.push(at("NEXT-1", "2025-11-30T22:00:00Z")); // Athens 1 December: outside, but on the portal
      f.decisions.push(at("PREV-1", "2025-11-23T00:00:00Z")); // Athens 23 November: outside, but on the portal
    });
    const chain = await fullyAnchored(new FixtureClient(FIXTURE));
    const base = anchorOf(fx.decisions[0]);
    chain.set("NEXT-1", [{ ...base, issueDate: day("2025-11-30") }]);
    chain.set("PREV-1", [{ ...base, issueDate: day("2025-11-23") }]);
    chain.set("GONE-END", [{ ...base, issueDate: day("2025-11-30") }]);   // gone from the portal entirely
    chain.set("GONE-START", [{ ...base, issueDate: day("2025-11-23") }]); // could be an Athens-midnight act of the 24th
    chain.set("FAR-1", [{ ...base, issueDate: day("2025-11-22") }]);      // outside on either reading
    const r = await buildReport(c, reader(chain), P);
    const missing = r.findings.filter((x) => x.status === "portal-missing").map((x) => x.ada).sort();
    expect(missing).toEqual(["GONE-END", "GONE-START"]);
  });

  it("an earlier version of another organisation is a history-error, since the anchor would claim it for this org", async () => {
    const c = clientWith((f) => {
      for (const d of f.decisions) if (d.versionId !== "87e590cb-ac02-421b-97e3-3386b2d16fd6" && d.ada === "ΨΟΣΝΩ6Μ-Θ6Ε") d.organizationId = "6027";
    });
    const r = await buildReport(c, reader(new Map()), P);
    const f = r.findings.find((x) => x.ada === "ΨΟΣΝΩ6Μ-Θ6Ε")!;
    expect(f.status).toBe("history-error");
    expect(f.detail).toMatch(/belongs to org 6027, the act to org 6013/);
    expect(r.alarm).toBe(true);
  });

  it("an itemised bill (every line one payee) counts in full; anchored, portal = chain (Thessaloniki, Larissa 2025)", async () => {
    const c = clientWith((f) => {
      const s = f.decisions[0].extraFieldValues.sponsor;
      s.push({ ...s[0], expenseAmount: { amount: 100.5, currency: "EUR" } }, { ...s[0], expenseAmount: { amount: 0.25, currency: "EUR" } });
    });
    const r = await buildReport(c, reader(await fullyAnchored(c)), P);
    expect(r.multiPayee).toBe(1);
    expect(r.splitPayee).toBe(0);
    expect(r.acts).toBe(4);
    expect(r.portalTotal).toBe(62425209n + 10075n);
    expect(r.difference).toBe(0n);
  });

  it("a payment split between payees counts its first line and reports the rest (Larissa 2025: 5 acts)", async () => {
    const c = clientWith((f) => {
      f.decisions[0].extraFieldValues.sponsor.push({ sponsorAFMName: { afm: "999999999", name: "B" }, expenseAmount: { amount: 100.5, currency: "EUR" } });
    });
    const r = await buildReport(c, reader(await fullyAnchored(c)), P);
    expect(r.splitPayee).toBe(1);
    expect(r.splitUncounted).toBe(10050n);
    expect(r.portalTotal).toBe(62425209n);
    expect(r.difference).toBe(0n);
  });

  it("counts non-void acts with no amount, which neither total can see", async () => {
    const c = clientWith((f) => {
      delete f.decisions[0].extraFieldValues.sponsor[0].expenseAmount.amount; // live act: counted
      for (const d of f.decisions) if (d.ada === "ΨΟΣΝΩ6Μ-Θ6Ε") delete d.extraFieldValues.sponsor[0].expenseAmount.amount; // voided: not
    });
    const r = await buildReport(c, reader(new Map()), P);
    expect(r.noAmount).toBe(1);
  });

  it("with the VAT from Diavgeia's organisation record, acts without a typed payer are notes; a fallback --vat cannot be checked against them (Amorgos 2025)", async () => {
    const c = clientWith((f) => { for (const d of f.decisions) d.extraFieldValues.org = null; });
    await expect(buildReport(c, reader(new Map()), P)).rejects.toThrow(/cannot be checked/);
    const r = await buildReport(c, reader(new Map()), { ...P, vatFromRegistry: true });
    expect(r.counts).toEqual({ unanchored: 4 });
    expect(r.payerNotes).toEqual({ empty: 4, other: [] });
  });

  it("a fallback --vat must agree with at least one typed payer in a small window", async () => {
    const c = clientWith((f) => {
      f.decisions = [f.decisions[0]];
      f.decisions[0].extraFieldValues.org = { afm: "996607880", name: "ΚΟΙΝΟΠΡΑΞΙΑ" };
    });
    await expect(buildReport(c, reader(new Map()), P)).rejects.toThrow(/only 0 of 1/);
    const r = await buildReport(c, reader(new Map()), { ...P, vatFromRegistry: true });
    expect(r.counts).toEqual({ unanchored: 1 });
  });

  it("nothing anchored: every act unanchored, chain total zero, no alarm", async () => {
    const r = await buildReport(new FixtureClient(FIXTURE), reader(new Map()), P);
    expect(r.counts).toEqual({ unanchored: 4 });
    expect(r.chainTotal).toBe(0n);
    expect(r.alarm).toBe(false);
  });
});

describe("checkFallbackVat", () => {
  const acts = (fx.decisions as DiavgeiaDecision[]).filter((d) => d.ada !== "ΨΟΣΝΩ6Μ-Θ6Ε");
  it("accepts a --vat most typed payers carry, even with one swapped act", () => {
    expect(() => checkFallbackVat([...acts, swappedAct(acts[0])], "6013", "090025537")).not.toThrow();
  });
  it("refuses a --vat no typed payer carries", () => {
    expect(() => checkFallbackVat(acts, "6013", "090256954")).toThrow(/only 0 of 3/);
  });
  it("refuses an empty window: nothing to check against, yet the VAT would filter the portal-missing scan", () => {
    expect(() => checkFallbackVat([], "6013", "090025537")).toThrow(/no org 6013 acts/);
  });
});

describe("blockRanges", () => {
  it("covers from..to inclusively in ranges of at most size blocks, with no gap or overlap", () => {
    expect(blockRanges(5n, 24n, 10n)).toEqual([[5n, 14n], [15n, 24n]]);
    expect(blockRanges(5n, 25n, 10n)).toEqual([[5n, 14n], [15n, 24n], [25n, 25n]]);
    expect(blockRanges(7n, 7n, 10n)).toEqual([[7n, 7n]]);
    expect(blockRanges(8n, 7n, 10n)).toEqual([]);
    expect(() => blockRanges(0n, 1n, 0n)).toThrow(/at least 1/);
  });
});

describe("toAnchor", () => {
  it("carries the org's VAT, not the typed payer, while the hash still commits to the typed payer", () => {
    const swapped = swappedAct(fx.decisions[0]);
    const a = toAnchor(swapped, ZERO32, "090025537");
    expect(a.payerVat).toBe(90025537n);
    expect(a.payeeVat).toBe(90025537n); // the swap stays visible on-chain
    const retyped = { ...swapped, extraFieldValues: { ...swapped.extraFieldValues, org: { afm: "090025537", name: "ΔΗΜΟΣ ΑΘΗΝΑΙΩΝ" } } };
    expect(toAnchor(retyped, ZERO32, "090025537").actHash).not.toBe(a.actHash);
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
  it("says beside the totals when acts state no amount (Piraeus 2025: 3,772 of 3,779)", async () => {
    const c = clientWith((f) => { for (const d of f.decisions) delete d.extraFieldValues.sponsor[0].expenseAmount.amount; });
    const r = await buildReport(c, reader(new Map()), P);
    const html = renderPage(r, { source: "fixture", fixturePath: "x.json", generatedAt: new Date(0), registry: "0xabc", chainId: 31337 });
    expect(html).toContain("<strong>3 of 4 acts state no amount</strong>, so these totals cover only the rest.");
  });

  it("escapes Diavgeia-sourced text and leaves out subjects and payee names", async () => {
    const c = clientWith((f) => {
      f.organizations["6013"].label = `<script>alert(1)</script>`;
      f.decisions.push(swappedAct(f.decisions[0]));
    });
    const r = await buildReport(c, reader(new Map()), P);
    const html = renderPage(r, { source: "fixture", fixturePath: "x.json", generatedAt: new Date(0), registry: "0xabc", chainId: 31337 });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    for (const d of fx.decisions as DiavgeiaDecision[]) {
      expect(html).not.toContain(d.subject.slice(0, 20));
      expect(html).not.toContain(d.extraFieldValues.sponsor![0].sponsorAFMName!.name!);
    }
    expect(html).toContain("not the live portal");
    expect(html).toContain("0 act(s) leave the payer field empty and 1 name a payer other than this organisation");
    expect(html).toContain(">61Θ6Ω6Μ-2ΑΗ</a></td></tr>");
    expect(html).not.toContain("996607880"); // the other party's VAT stays on the portal
    expect(html).not.toContain("state no amount</strong>"); // every act here states one
  });
});
