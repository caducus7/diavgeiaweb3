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

export function toCents(amount: number | undefined | null): bigint {
  if (amount === undefined || amount === null) return 0n;
  // Avoid float drift: 25462.16 -> "25462.16" -> 2546216
  const s = amount.toFixed(2);
  const [whole, frac = "00"] = s.split(".");
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

export const unixDay = (ms: number): number => Math.floor(ms / 86_400_000);

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
