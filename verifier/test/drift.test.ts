import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureClient } from "../src/diavgeia.js";
import { snapshot, drift, DRIFT_ALARM, type Manifest } from "../src/drift.js";

const FIXTURE = new URL("../fixtures/athens-2025-11.json", import.meta.url).pathname;
const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
const Q = { org: "6013", type: "Β.2.2", from: "2025-11-24", to: "2025-11-30" };
const quiet = () => {};

function clientWith(edit: (f: typeof fx) => void): FixtureClient {
  const copy = JSON.parse(JSON.stringify(fx));
  edit(copy);
  const p = join(mkdtempSync(join(tmpdir(), "dv-drift-")), "fx.json");
  writeFileSync(p, JSON.stringify(copy));
  return new FixtureClient(p);
}
const base = (): Promise<Manifest> => snapshot(new FixtureClient(FIXTURE), Q, "2026-11-04", quiet);
const kinds = (fs: Array<{ ada: string; kind: string }>) => fs.map((f) => `${f.ada} ${f.kind}`).sort();

describe("snapshot", () => {
  it("records every version's hash, oldest first, and nothing personal", async () => {
    const m = await base();
    expect(Object.keys(m.acts).length).toBe(4);
    expect(m.acts["ΨΟΣΝΩ6Μ-Θ6Ε"].map((v) => v.versionId.slice(0, 8))).toEqual(["303d2b3a", "87e590cb"]);
    expect(m.acts["9ΓΒΝΩ6Μ-Λ4Η"][0].hash).toBe("0xce473bfba3290809b737ace729a0000ad6166df0a6a8d400a4c66f6832ad4b8d");
    const text = JSON.stringify(m);
    for (const d of fx.decisions) {
      expect(text).not.toContain(d.extraFieldValues.sponsor[0].sponsorAFMName.afm);
      expect(text).not.toContain(d.extraFieldValues.sponsor[0].sponsorAFMName.name);
    }
  });
});

describe("drift", () => {
  it("finds nothing when the portal is unchanged", async () => {
    expect(await drift(new FixtureClient(FIXTURE), await base(), quiet)).toEqual([]);
  });

  it("flags an edited version, a removed act and a lost version; notes a new act and a new version", async () => {
    const m = await base();
    const c = clientWith((f) => {
      f.decisions.find((d: { ada: string }) => d.ada === "9ΓΒΝΩ6Μ-Λ4Η").extraFieldValues.sponsor[0].expenseAmount.amount = 1;
      f.decisions = f.decisions.filter((d: { ada: string }) => d.ada !== "ΨΨ9ΣΩ6Μ-1ΕΦ");
      const nw = JSON.parse(JSON.stringify(f.decisions[0])); nw.ada = "NEW-1"; nw.versionId = "new-1"; f.decisions.push(nw);
      const v1 = f.decisions.find((d: { ada: string }) => d.ada === "9Ε9ΔΩ6Μ-Ξ7Ρ");
      const v2 = { ...JSON.parse(JSON.stringify(v1)), versionId: "later-2", correctedVersionId: v1.versionId };
      f.decisions.push(v2);
      f.versionlog["9Ε9ΔΩ6Μ-Ξ7Ρ"] = { ada: "9Ε9ΔΩ6Μ-Ξ7Ρ", versions: [
        { versionId: v1.versionId, versionTimestamp: 1, correctedVersionId: null, status: "PUBLISHED" },
        { versionId: "later-2", versionTimestamp: 2, correctedVersionId: v1.versionId, status: "PUBLISHED" }] };
      // the void act's first version vanishes from its history
      f.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions = f.versionlog["ΨΟΣΝΩ6Μ-Θ6Ε"].versions.slice(1);
    });
    const out = await drift(c, m, quiet);
    expect(kinds(out)).toEqual([
      "9ΓΒΝΩ6Μ-Λ4Η changed", "9Ε9ΔΩ6Μ-Ξ7Ρ new-version", "NEW-1 new-act", "ΨΟΣΝΩ6Μ-Θ6Ε version-lost", "ΨΨ9ΣΩ6Μ-1ΕΦ gone",
    ]);
    expect(out.filter((f) => DRIFT_ALARM.has(f.kind)).length).toBe(3);
  });

  it("an amount that became unhashable is a change, not a crash", async () => {
    const m = await base();
    const c = clientWith((f) => { f.decisions[0].extraFieldValues.sponsor[0].expenseAmount.amount = -1; });
    expect(kinds(await drift(c, m, quiet))).toEqual(["9ΓΒΝΩ6Μ-Λ4Η changed"]);
  });

  it("refuses a manifest from another canonical version", async () => {
    await expect(drift(new FixtureClient(FIXTURE), { ...(await base()), canonicalVersion: 99 }, quiet)).rejects.toThrow(/re-snapshot/);
  });
});
