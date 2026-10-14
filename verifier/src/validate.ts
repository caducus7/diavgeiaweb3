/**
 * Shape checks for Diavgeia OpenData responses. Everything from the API is
 * untrusted: a field of the wrong type would otherwise hash to a different
 * canonical form, or sum into a total, without any error.
 *
 * Only the fields the canonical form, the anchor or the report read are
 * checked. Extra fields pass through untouched so the hash sees the record as
 * the API sent it.
 */
import { amountProblem, MAX_AMOUNT, type DiavgeiaDecision } from "./canonical.js";
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

/** The source holds no signer registry data at all (an older recording), as opposed to "no such signer". */
export class SignerDataUnavailable extends Error {
  constructor() { super("this source has no signer records"); this.name = "SignerDataUnavailable"; }
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

export { MAX_AMOUNT };

/** The amount's type: anything but a finite number (or absent) is malformed and aborts like any shape error. */
function checkAmountType(v: unknown, where: string): void {
  if (v === undefined || v === null) return; // canonical form treats a missing amount as 0
  if (typeof v !== "number" || !Number.isFinite(v)) throw new DiavgeiaShapeError(where, `expected a finite number, got ${describe(v)}`);
}

/** Type and value. Parsing checks only the type: a well-formed amount the canonical form cannot represent
 *  (negative, sub-cent) is an `unsupported` act in the report, not a reason to drop the whole window. */
export function checkAmount(v: unknown, where: string): void {
  checkAmountType(v, where);
  const why = typeof v === "number" ? amountProblem(v) : null;
  if (why) throw new DiavgeiaShapeError(where, why);
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
          checkAmountType(s.expenseAmount.amount, `${sw}.expenseAmount.amount`);
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

const ATHENS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit" });
/** The Athens calendar day of an instant, as YYYY-MM-DD. The search API windows by Athens day (SPEC §7); most
 *  bodies store issueDate at 00:00 UTC (the same Athens day), some at Athens midnight (Piraeus 2025). */
export const athensDay = (ms: number): string => ATHENS_DAY.format(new Date(ms));
/** True when `ms` is exactly 00:00 Athens time on `day` (YYYY-MM-DD). */
export const isAthensMidnightOf = (ms: number, day: string): boolean => athensDay(ms) === day && athensDay(ms - 1) !== day;

/** The fields of `/organizations/{uid}.json` the verifier uses. */
export interface OrganizationRecord { uid: string; label: string; vatNumber: string; [k: string]: unknown }

export function parseOrganization(x: unknown, uid: string): OrganizationRecord {
  const where = `organization(${uid})`;
  if (!isObj(x)) throw new DiavgeiaShapeError(where, `expected object, got ${describe(x)}`);
  if (str(x, "uid", where) !== uid) throw new DiavgeiaShapeError(`${where}.uid`, `record is for ${x.uid}`);
  str(x, "label", where);
  if (!/^\d{9}$/.test(str(x, "vatNumber", where))) throw new DiavgeiaShapeError(`${where}.vatNumber`, `expected 9 digits, got ${describe(x.vatNumber)}`);
  return x as OrganizationRecord;
}

/** The fields of `/signers/{id}.json` the verifier uses. Names are present in the API and deliberately not read. */
export interface SignerRecord {
  uid: string;
  organizationId: string;
  activeFrom: number;
  activeUntil: number; // the API uses a date in the year 3000 for "open-ended"
  hasOrganizationSignRights: boolean;
  [k: string]: unknown;
}

export function parseSigner(x: unknown, id: string): SignerRecord {
  const where = `signer(${id})`;
  if (!isObj(x)) throw new DiavgeiaShapeError(where, `expected object, got ${describe(x)}`);
  if (str(x, "uid", where) !== id) throw new DiavgeiaShapeError(`${where}.uid`, `record is for ${x.uid}`);
  str(x, "organizationId", where);
  int(x, "activeFrom", where);
  int(x, "activeUntil", where);
  if (typeof x.hasOrganizationSignRights !== "boolean") throw new DiavgeiaShapeError(`${where}.hasOrganizationSignRights`, `expected boolean, got ${describe(x.hasOrganizationSignRights)}`);
  return x as SignerRecord;
}
