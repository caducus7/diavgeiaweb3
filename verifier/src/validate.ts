/**
 * Shape checks for Diavgeia OpenData responses. Everything from the API is
 * untrusted: a field of the wrong type would otherwise hash to a different
 * canonical form, or sum into a total, without any error.
 *
 * Only the fields the canonical form, the anchor or the report read are
 * checked. Extra fields pass through untouched so the hash sees the record as
 * the API sent it.
 */
import type { DiavgeiaDecision } from "./canonical.js";
import type { VersionLog } from "./diavgeia.js";

export class DiavgeiaShapeError extends Error {
  constructor(where: string, what: string) {
    super(`diavgeia response: ${where}: ${what}`);
    this.name = "DiavgeiaShapeError";
  }
}

/** The portal contradicts itself about one act (search vs version log vs version record). Scoped to that
 *  act: callers record it and carry on with the others. */
export class PortalInconsistentError extends Error {
  constructor(public ada: string, what: string) {
    super(`${ada}: ${what}`);
    this.name = "PortalInconsistentError";
  }
}

/** Errors that concern one act and should not abort a run over many. Network and HTTP errors are not. */
export const isPerActError = (e: unknown): e is DiavgeiaShapeError | PortalInconsistentError =>
  e instanceof DiavgeiaShapeError || e instanceof PortalInconsistentError;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new DiavgeiaShapeError(`${where}.${k}`, `expected non-empty string, got ${describe(v)}`);
  return v;
}

function optStr(o: Obj, k: string, where: string): void {
  const v = o[k];
  if (v !== undefined && v !== null && typeof v !== "string") throw new DiavgeiaShapeError(`${where}.${k}`, `expected string or null, got ${describe(v)}`);
}

function int(o: Obj, k: string, where: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new DiavgeiaShapeError(`${where}.${k}`, `expected integer, got ${describe(v)}`);
  return v;
}

const describe = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "string" ? `string ${JSON.stringify(v.slice(0, 40))}` : `${typeof v} ${String(v).slice(0, 40)}`;

/** Above about 2^46 (7e13) EUR adjacent doubles are more than a cent apart, so the two-decimal check below
 *  stops being exact. 1e12 EUR is far above any public act and well inside the exact range. */
export const MAX_AMOUNT = 1e12;

/** SPEC §2: an amount with more than two decimals is rejected, not rounded.
 *  A JSON number written with at most two decimals parses to the same double as
 *  its own toFixed(2), so this comparison is exact for API input. */
export function checkAmount(v: unknown, where: string): void {
  if (v === undefined || v === null) return; // canonical form treats a missing amount as 0
  if (typeof v !== "number" || !Number.isFinite(v)) throw new DiavgeiaShapeError(where, `expected a finite number, got ${describe(v)}`);
  if (v < 0) throw new DiavgeiaShapeError(where, `negative amount ${v}`);
  if (v > MAX_AMOUNT) throw new DiavgeiaShapeError(where, `amount ${v} above ${MAX_AMOUNT}; refusing rather than risking inexact cents`);
  if (Number(v.toFixed(2)) !== v) throw new DiavgeiaShapeError(where, `amount ${v} has more than two decimals (SPEC §2)`);
}

/** Validate one decision record; returns it unchanged. */
export function parseDecision(x: unknown, where = "decision"): DiavgeiaDecision {
  if (!isObj(x)) throw new DiavgeiaShapeError(where, `expected object, got ${describe(x)}`);
  const ada = str(x, "ada", where);
  if (new TextEncoder().encode(ada.normalize("NFC")).length > 32) throw new DiavgeiaShapeError(`${where}.ada`, `longer than 32 bytes: ${ada}`);
  const w = `${where}(${ada})`;
  str(x, "versionId", w);
  optStr(x, "correctedVersionId", w);
  optStr(x, "protocolNumber", w);
  if (typeof x.subject !== "string") throw new DiavgeiaShapeError(`${w}.subject`, `expected string, got ${describe(x.subject)}`);
  int(x, "issueDate", w);
  str(x, "organizationId", w);
  str(x, "decisionTypeId", w);
  // Missing or null hashes as [] in the canonical form, so it is accepted; anything else must be strings.
  if (x.signerIds !== undefined && x.signerIds !== null && (!Array.isArray(x.signerIds) || !x.signerIds.every((s) => typeof s === "string")))
    throw new DiavgeiaShapeError(`${w}.signerIds`, "expected array of strings");

  const ef = x.extraFieldValues;
  if (ef !== undefined && ef !== null) {
    if (!isObj(ef)) throw new DiavgeiaShapeError(`${w}.extraFieldValues`, `expected object, got ${describe(ef)}`);
    if (ef.org !== undefined && ef.org !== null) {
      if (!isObj(ef.org)) throw new DiavgeiaShapeError(`${w}.extraFieldValues.org`, "expected object");
      optStr(ef.org, "afm", `${w}.extraFieldValues.org`);
      optStr(ef.org, "name", `${w}.extraFieldValues.org`);
    }
    if (ef.sponsor !== undefined && ef.sponsor !== null) {
      if (!Array.isArray(ef.sponsor)) throw new DiavgeiaShapeError(`${w}.extraFieldValues.sponsor`, "expected array");
      ef.sponsor.forEach((s: unknown, i: number) => {
        const sw = `${w}.extraFieldValues.sponsor[${i}]`;
        if (!isObj(s)) throw new DiavgeiaShapeError(sw, "expected object");
        if (s.sponsorAFMName !== undefined && s.sponsorAFMName !== null) {
          if (!isObj(s.sponsorAFMName)) throw new DiavgeiaShapeError(`${sw}.sponsorAFMName`, "expected object");
          for (const k of ["afm", "name", "afmCountry"]) optStr(s.sponsorAFMName, k, `${sw}.sponsorAFMName`);
        }
        if (s.expenseAmount !== undefined && s.expenseAmount !== null) {
          if (!isObj(s.expenseAmount)) throw new DiavgeiaShapeError(`${sw}.expenseAmount`, "expected object");
          checkAmount(s.expenseAmount.amount, `${sw}.expenseAmount.amount`);
          optStr(s.expenseAmount, "currency", `${sw}.expenseAmount`);
        }
      });
    }
  }
  return x as DiavgeiaDecision;
}

export interface SearchPage { decisions: DiavgeiaDecision[]; total: number; actualSize: number }

export function parseSearchPage(x: unknown, where = "search"): SearchPage {
  if (!isObj(x)) throw new DiavgeiaShapeError(where, `expected object, got ${describe(x)}`);
  if (!isObj(x.info)) throw new DiavgeiaShapeError(`${where}.info`, "missing");
  const total = int(x.info, "total", `${where}.info`);
  const actualSize = int(x.info, "actualSize", `${where}.info`);
  if (!Array.isArray(x.decisions)) throw new DiavgeiaShapeError(`${where}.decisions`, "expected array");
  if (x.decisions.length !== actualSize) throw new DiavgeiaShapeError(where, `info.actualSize ${actualSize} but ${x.decisions.length} decisions`);
  return { decisions: x.decisions.map((d, i) => parseDecision(d, `${where}.decisions[${i}]`)), total, actualSize };
}

export function parseVersionLog(x: unknown, ada: string): VersionLog {
  const where = `versionlog(${ada})`;
  if (!isObj(x)) throw new DiavgeiaShapeError(where, `expected object, got ${describe(x)}`);
  if (typeof x.ada === "string" && x.ada.normalize("NFC") !== ada.normalize("NFC"))
    throw new DiavgeiaShapeError(`${where}.ada`, `log is for ${x.ada}`);
  if (!Array.isArray(x.versions) || x.versions.length === 0) throw new DiavgeiaShapeError(`${where}.versions`, "expected non-empty array");
  x.versions.forEach((v: unknown, i: number) => {
    if (!isObj(v)) throw new DiavgeiaShapeError(`${where}.versions[${i}]`, "expected object");
    str(v, "versionId", `${where}.versions[${i}]`);
    int(v, "versionTimestamp", `${where}.versions[${i}]`);
    optStr(v, "correctedVersionId", `${where}.versions[${i}]`);
  });
  return x as unknown as VersionLog;
}

/** YYYY-MM-DD that is a real calendar date; returns ms at UTC midnight. */
export function parseIsoDay(s: string, name: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + "T00:00:00Z") : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) throw new Error(`${name} must be a date as YYYY-MM-DD, got ${JSON.stringify(s)}`);
  return ms;
}
