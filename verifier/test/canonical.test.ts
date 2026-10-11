import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  actHash, adaKey, actTypeKey, canonicalise, contractRefFromSubject, isVoid, stableStringify, toCents, unixDay,
  type DiavgeiaDecision,
} from "../src/canonical.js";
import { splitWindows, FixtureClient } from "../src/diavgeia.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/athens-2025-11.json", import.meta.url), "utf8"));
const byVersion = (id: string): DiavgeiaDecision => fx.decisions.find((d: DiavgeiaDecision) => d.versionId === id);
const paints = fx.decisions[0] as DiavgeiaDecision;
const voidV2 = byVersion("87e590cb-ac02-421b-97e3-3386b2d16fd6");
const voidV1 = byVersion("303d2b3a-90a2-4a17-a6b2-79421af7095e");

describe("toCents", () => {
  it("does not drift on the real amounts", () => {
    expect(toCents(25462.16)).toBe(2546216n);
    expect(toCents(1860.0)).toBe(186000n);
    expect(toCents(595771.73)).toBe(59577173n);
    expect(toCents(3018.2)).toBe(301820n);
    expect(toCents(0.1 + 0.2)).toBe(30n);
  });
});

describe("canonical form", () => {
  it("is deterministic regardless of key order", () => {
    const shuffled = JSON.parse(JSON.stringify(paints));
    const { subject, ...rest } = shuffled;
    const reordered = { ...rest, subject };
    expect(actHash(reordered as DiavgeiaDecision)).toBe(actHash(paints));
  });

  it("ignores portal bookkeeping fields", () => {
    const d = { ...paints, publishTimestamp: 1, submissionTimestamp: 2, documentChecksum: "x", warnings: "y" } as DiavgeiaDecision;
    expect(actHash(d)).toBe(actHash(paints));
  });

  it("changes when the subject changes", () => {
    expect(actHash(voidV1)).not.toBe(actHash(voidV2));
  });

  it("normalises Unicode (NFC vs NFD)", () => {
    const nfd = { ...paints, subject: paints.subject.normalize("NFD") } as DiavgeiaDecision;
    expect(actHash(nfd)).toBe(actHash(paints));
  });

  it("maps the Athens record to the expected fields", () => {
    const c = canonicalise(paints);
    expect(c.ada).toBe("9ΓΒΝΩ6Μ-Λ4Η");
    expect(c.payerVat).toBe("090025537");
    expect(c.payees[0].vat).toBe("166758607");
    expect(c.payees[0].amountCents).toBe("2546216");
    expect(c.issueDay).toBe(unixDay(1764288000000));
    expect(c.prevVersionId).toBeNull();
    expect(canonicalise(voidV2).prevVersionId).toBe("303d2b3a-90a2-4a17-a6b2-79421af7095e");
  });

  it("stableStringify sorts keys at every depth", () => {
    expect(stableStringify({ b: { z: 1, a: [{ y: 2, x: 1 }] }, a: null })).toBe('{"a":null,"b":{"a":[{"x":1,"y":2}],"z":1}}');
  });

  it("pins the hash of the real paints act (spec v1)", () => {
    // If this changes, the canonicalisation spec changed and every anchor is invalid.
    expect(actHash(paints)).toMatchInlineSnapshot(`"0xce473bfba3290809b737ace729a0000ad6166df0a6a8d400a4c66f6832ad4b8d"`);
  });
});

describe("keys", () => {
  it("packs Greek ADAs into bytes32 and distinguishes them", () => {
    const k = adaKey("9ΓΒΝΩ6Μ-Λ4Η");
    expect(k).toMatch(/^0x[0-9a-f]{64}$/);
    expect(k).not.toBe(adaKey("ΨΟΣΝΩ6Μ-Θ6Ε"));
    expect(k.endsWith("00")).toBe(true);
  });
  it("maps Greek Β.2.2 to ASCII B.2.2 for the on-chain constant", () => {
    expect(actTypeKey("Β.2.2")).toBe(actTypeKey("B.2.2"));
    expect(actTypeKey("Β.2.2")).toBe("0x422e322e32000000");
  });
});

describe("heuristics", () => {
  it("extracts the KIMDIS contract id from the subject", () => {
    expect(contractRefFromSubject(paints.subject)).toBe("24SYMV015873979");
    expect(contractRefFromSubject("ΔΑΠΑΝΗ ΗΛΕΚΤΡΙΚΟΥ ΡΕΥΜΑΤΟΣ")).toBeNull();
  });
  it("detects voiding versions", () => {
    expect(isVoid(voidV2.subject)).toBe(true);
    expect(isVoid(voidV1.subject)).toBe(false);
    expect(isVoid("ΑΚΥΡΩΤΙΚΟ Χ.Ε. ΜΑΖΙΚΗ ΑΚΥΡΩΣΗ")).toBe(true);
  });
});

describe("api quirks", () => {
  it("splits a year into 180-day windows", () => {
    const w = splitWindows("2025-01-01", "2025-12-31");
    expect(w.length).toBe(3);
    expect(w[0]).toEqual(["2025-01-01", "2025-06-29"]);
    expect(w[2][1]).toBe("2025-12-31");
  });
  it("fixture search returns only the latest version per ADA", async () => {
    const c = new FixtureClient(new URL("../fixtures/athens-2025-11.json", import.meta.url).pathname);
    const r = await c.search({ org: "6013", type: "Β.2.2", fromIssueDate: "2025-11-24", toIssueDate: "2025-11-30" });
    expect(r.length).toBe(4);
    expect(r.find((d) => d.ada === "ΨΟΣΝΩ6Μ-Θ6Ε")!.versionId).toBe("87e590cb-ac02-421b-97e3-3386b2d16fd6");
  });
});
