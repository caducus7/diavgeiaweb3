/**
 * Canonical form of a Diavgeia act, and its hash.
 *
 * The spec (v1):
 *  - Only the fields below are hashed. Portal bookkeeping (publishTimestamp,
 *    submissionTimestamp, url, documentUrl, warnings, attachments,
 *    documentChecksum, privateData, thematicCategoryIds, unitIds) is excluded:
 *    it describes the upload, not the act.
 *  - Strings are Unicode NFC. Amounts are integers in cents. Dates are unix
 *    days. Keys are sorted. JSON is serialised with no whitespace.
 *  - The hash is keccak256 of the UTF-8 bytes of that JSON.
 *
 * Anyone with the OpenData record can recompute this and compare it with the
 * on-chain anchor; that is the whole point.
 */
import { keccak256, stringToHex, toHex, type Hex } from "viem";

export const CANONICAL_VERSION = 1;

export interface DiavgeiaDecision {
  ada: string;
  versionId: string;
  correctedVersionId: string | null;
  protocolNumber?: string | null;
  subject: string;
  issueDate: number; // ms since epoch
  organizationId: string;
  signerIds: string[];
  decisionTypeId: string;
  extraFieldValues: {
    org?: { afm?: string; name?: string };
    sponsor?: Array<{
      sponsorAFMName?: { afm?: string; name?: string; afmCountry?: string };
      expenseAmount?: { amount?: number; currency?: string };
    }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface CanonicalAct {
  v: number;
  ada: string;
  versionId: string;
  prevVersionId: string | null;
  actType: string;
  protocolNumber: string | null;
  subject: string;
  issueDay: number;
  payerVat: string;
  payerName: string;
  signerIds: string[];
  payees: Array<{ vat: string; name: string; country: string; amountCents: string; currency: string }>;
}

const nfc = (s: string | null | undefined): string => (s ?? "").normalize("NFC");

/** Above about 2^46 (7e13) EUR adjacent doubles are more than a cent apart, so the two-decimal check below
 *  stops being exact. 1e12 EUR is far above any public act and well inside the exact range. */
export const MAX_AMOUNT = 1e12;

/** Why the canonical form cannot represent this amount, or null (SPEC §2: rejected, never rounded). Seen live
 *  in 2025: credit lines (Thessaloniki -1,267.94, Larissa -63.88, Patras -0.01) and a float residue where
 *  0.00 was meant (Heraklion 5.68434e-14). A JSON number written with at most two decimals parses to the
 *  same double as its own toFixed(2), so the decimals comparison is exact for API input. */
export function amountProblem(v: number): string | null {
  if (v < 0) return `negative amount ${v}`;
  if (v > MAX_AMOUNT) return `amount ${v} above ${MAX_AMOUNT}; refusing rather than risking inexact cents`;
  if (Number(v.toFixed(2)) !== v) return `amount ${v} has more than two decimals (SPEC §2)`;
  return null;
}

export class UnsupportedAmountError extends Error {}

/** Why this record cannot be hashed or anchored because of an amount, or null. Scoped to its act (SPEC §6). */
export function unsupportedAmount(d: DiavgeiaDecision): string | null {
  const sponsors = d.extraFieldValues?.sponsor ?? [];
  for (let i = 0; i < sponsors.length; i++) {
    const v = sponsors[i]?.expenseAmount?.amount;
    const why = v === undefined || v === null ? null : amountProblem(v);
    if (why) return `payee ${i + 1}: ${why}`;
  }
  return null;
}

export function toCents(amount: number | undefined | null): bigint {
  if (amount === undefined || amount === null) return 0n;
  // Never a garbage hash or a rounded total: toFixed would turn 5.68e-14 into 0 and -1267.94 into -126606.
  const why = amountProblem(amount);
  if (why) throw new UnsupportedAmountError(why);
  // Avoid float drift: 25462.16 -> "25462.16" -> 2546216
  const s = amount.toFixed(2);
  const [whole, frac = "00"] = s.split(".");
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

export const unixDay = (ms: number): number => Math.floor(ms / 86_400_000);

/** A line's currency as the canonical form reads it: absent or empty is EUR. */
export const currencyOf = (s: { expenseAmount?: { currency?: string } }): string => nfc(s.expenseAmount?.currency) || "EUR";

/** The payee and amount the anchor exposes (SPEC §4). Lines that all carry one payee VAT in one currency are
 *  summed: an itemised bill to one payee (942 multi-line acts in five municipalities in 2025), or, when no line
 *  names a payee (`noPayee`), a lump such as payroll or withholding remittances (994). Lines naming different
 *  payees, or mixing currencies, are a split payment the anchor cannot express: it carries the first line, and
 *  `split` says so (5). Every line stays in actHash either way. Payees are compared as the anchor stores them
 *  (vatToUint). Throws UnsupportedAmountError like toCents. */
export function anchorPayment(d: DiavgeiaDecision): { payeeVat: bigint; amountCents: bigint; split: boolean; noPayee: boolean } {
  const lines = d.extraFieldValues?.sponsor ?? [];
  if (!lines.length) return { payeeVat: 0n, amountCents: 0n, split: false, noPayee: true };
  const payee = vatToUint(lines[0].sponsorAFMName?.afm ?? "");
  const currency = currencyOf(lines[0]);
  const split = lines.some((s) => vatToUint(s.sponsorAFMName?.afm ?? "") !== payee || currencyOf(s) !== currency);
  const counted = split ? lines.slice(0, 1) : lines;
  return { payeeVat: payee, amountCents: counted.reduce((t, s) => t + toCents(s.expenseAmount?.amount), 0n), split, noPayee: payee === 0n };
}

export function canonicalise(d: DiavgeiaDecision): CanonicalAct {
  const org = d.extraFieldValues?.org ?? {};
  const sponsors = d.extraFieldValues?.sponsor ?? [];
  return {
    v: CANONICAL_VERSION,
    ada: nfc(d.ada),
    versionId: d.versionId,
    prevVersionId: d.correctedVersionId ?? null,
    actType: nfc(d.decisionTypeId),
    protocolNumber: d.protocolNumber ? nfc(d.protocolNumber) : null,
    subject: nfc(d.subject),
    issueDay: unixDay(d.issueDate),
    payerVat: nfc(org.afm),
    payerName: nfc(org.name),
    signerIds: [...(d.signerIds ?? [])].sort(),
    payees: sponsors.map((s) => ({
      vat: nfc(s.sponsorAFMName?.afm),
      name: nfc(s.sponsorAFMName?.name),
      country: nfc(s.sponsorAFMName?.afmCountry),
      amountCents: toCents(s.expenseAmount?.amount).toString(),
      currency: nfc(s.expenseAmount?.currency) || "EUR",
    })),
  };
}

/** Deterministic JSON: sorted keys at every level, no whitespace. */
export function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(stableStringify).join(",") + "]";
  const o = x as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(o[k]))
      .join(",") +
    "}"
  );
}

export function actHash(d: DiavgeiaDecision): Hex {
  return keccak256(stringToHex(stableStringify(canonicalise(d))));
}

/** ADA (<= 32 UTF-8 bytes) packed into bytes32, matching ActRegistry.adaKey. */
export function adaKey(ada: string): Hex {
  const bytes = new TextEncoder().encode(ada.normalize("NFC"));
  if (bytes.length > 32) throw new Error(`ADA longer than 32 bytes: ${ada}`);
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return toHex(padded);
}

/** bytes8 for the act type, e.g. "B.2.2". The Greek Β (U+0392) is mapped to
 *  Latin B so the on-chain constant is ASCII. */
export function actTypeKey(t: string): Hex {
  const ascii = t.normalize("NFC").replace(/Β/g, "B");
  const bytes = new TextEncoder().encode(ascii);
  if (bytes.length > 8) throw new Error(`act type longer than 8 bytes: ${t}`);
  const padded = new Uint8Array(8);
  padded.set(bytes);
  return toHex(padded);
}

/** KIMDIS contract reference pulled out of the free-text subject, if any.
 *  Pattern: 2 digits year + SYMV + 9 digits, e.g. 24SYMV015873979. */
export function contractRefFromSubject(subject: string): string | null {
  const m = subject.match(/\b(\d{2}SYMV\d{9})\b/);
  return m ? m[1] : null;
}

export function contractRefKey(ref: string | null): Hex {
  if (!ref) return ("0x" + "00".repeat(32)) as Hex;
  return adaKey(ref);
}

/** Heuristic for a voiding version: Diavgeia has no structured flag, the
 *  accounts office prepends it to the subject. */
export function isVoid(subject: string): boolean {
  return /^\s*ΑΚΥΡ(Ο|ΩΤΙΚ)/u.test(subject.normalize("NFC"));
}

export const vatToUint = (vat: string): bigint => (vat ? BigInt(vat.replace(/\D/g, "") || "0") : 0n);
