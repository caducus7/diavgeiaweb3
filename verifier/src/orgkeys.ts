/**
 * One anchoring key per Diavgeia organisation, derived from a single seed.
 *
 * This is the Phase 1 stand-in for keys held by the signing bodies themselves (CONTEXT decision 4). Anyone
 * with the seed can sign for every organisation, so the seed is the trust root of a civic deployment and must
 * be kept like one. Derivation is deterministic so a crawler restarted with the same seed signs with the same
 * keys, and the registry's signer set is reproducible.
 *
 *   key(org) = keccak256(seed || "diavgeiaweb3/org-key/v1/" || uid), re-hashed with a counter in the
 *              negligible case that it is not a valid secp256k1 scalar.
 */
import { concat, keccak256, stringToBytes, toBytes, hexToBigInt, numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Public on purpose: a development seed for local Anvil only. Never accepted against a non-local RPC. */
export const DEV_SEED = keccak256(stringToBytes("diavgeiaweb3 development seed, not secret, local Anvil only"));

export function deriveOrgKey(seed: Hex, uid: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new Error("signer seed must be 32 bytes of hex (0x + 64 hex digits)");
  if (!/^\d+$/.test(uid)) throw new Error(`organisation uid must be digits, got ${JSON.stringify(uid)}`);
  for (let i = 0; ; i++) {
    const k = keccak256(concat([toBytes(seed), stringToBytes(`diavgeiaweb3/org-key/v1/${uid}`), ...(i ? [toBytes(numberToHex(i))] : [])]));
    const n = hexToBigInt(k);
    if (n > 0n && n < SECP256K1_N) return k;
  }
}

export const orgSignerAddress = (seed: Hex, uid: string) => privateKeyToAccount(deriveOrgKey(seed, uid)).address;

/** The seed from DIAVGEIA_SIGNER_SEED, or the development seed when, and only when, the chain is local. */
export function resolveSeed(env: NodeJS.ProcessEnv, localRpc: boolean): Hex {
  const s = env.DIAVGEIA_SIGNER_SEED;
  if (s) {
    if (s.toLowerCase() === DEV_SEED.toLowerCase() && !localRpc) throw new Error("the development seed is public; refusing it for a non-local RPC");
    return s as Hex;
  }
  if (!localRpc) throw new Error("set DIAVGEIA_SIGNER_SEED (32 bytes hex) to anchor on a non-local chain");
  return DEV_SEED;
}
