/**
 * Chain side: deploy the contracts from Foundry artifacts, anchor acts, read
 * anchors back. Uses a local Anvil by default.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, type Hex, type Address, type Abi,
  getContract, parseEventLogs, hexToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  actHash, adaKey, actTypeKey, contractRefFromSubject, contractRefKey, isVoid, toCents, unixDay, vatToUint,
  type DiavgeiaDecision,
} from "./canonical.js";
import type { ChainReader } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../contracts/out");
export const DEPLOY_FILE = resolve(here, "../deployment.json");

export const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// Anvil default accounts
export const ADMIN_KEY = (process.env.ADMIN_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex; // account 0
export const TREASURY_KEY = (process.env.TREASURY_KEY ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a") as Hex; // account 2

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

// viem polls for receipts every 4s by default. Anvil mines on submission, so locally that is pure waiting
// (4s per anchor, over 6 hours for a year of Athens). Poll fast only against a local node.
export const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: LOCAL_RPC ? 50 : 4_000 });

/** Anvil, by URL *and* chain id. The URL alone is not enough: a localhost port can be a tunnel to a real node,
 *  and "local" unlocks the public development seed and automatic funding of derived keys. */
let localChain: Promise<boolean> | null = null;
export const isLocalChain = (): Promise<boolean> =>
  (localChain ??= LOCAL_RPC ? publicClient.getChainId().then((id) => id === 31337) : Promise.resolve(false));
export const wallet = (key: Hex) =>
  createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(key) });

export interface Deployment {
  registry: Address;
  gate: Address;
  graph: Address;
  rail: Address;
}

export async function deploy(): Promise<Deployment> {
  const admin = wallet(ADMIN_KEY);
  const treasury = privateKeyToAccount(TREASURY_KEY).address;

  const dep = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await admin.deployContract({ abi, bytecode, args });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (!rc.contractAddress) throw new Error(`deploy ${name} failed`);
    return rc.contractAddress;
  };

  const registry = await dep("ActRegistry", [admin.account.address]);
  const rail = await dep("MockRail", []);
  const gate = await dep("PaymentGate", [registry, rail, treasury]);
  const graph = await dep("ProcurementGraph", [registry]);

  const d: Deployment = { registry, gate, graph, rail };
  writeFileSync(DEPLOY_FILE, JSON.stringify(d, null, 2));
  return d;
}

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOY_FILE)) throw new Error("no deployment.json; run `deploy` first");
  const d = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));
  if ("signerOrgVat" in d) throw new Error("deployment.json predates per-organisation keys; run `deploy` again");
  return d;
}

/** Make sure the organisation's derived key is a registry signer for `vat`, registering it (admin) if it is
 *  not a signer yet. A key already registered for a different VAT is never re-pointed: that would let one
 *  organisation's key sign for another's VAT (a mistyped --vat is enough). The chain is the only record. */
export async function ensureOrgSigner(dep: Deployment, uid: string, vat: string, orgKey: Hex): Promise<{ address: Address; registered: boolean }> {
  const address = privateKeyToAccount(orgKey).address;
  const reg = getContract({ address: dep.registry, abi: artifact("ActRegistry").abi, client: wallet(ADMIN_KEY) });
  const current = (await reg.read.signerOrg([address])) as bigint;
  let registered = false;
  // A derived key starts with no gas. Fund it from the admin on a local chain; elsewhere funding is an operator's job.
  if ((await publicClient.getBalance({ address })) === 0n) {
    if (!(await isLocalChain())) throw new Error(`org ${uid} signer ${address} has no funds for gas; fund it, then rerun`);
    const h = await wallet(ADMIN_KEY).sendTransaction({ to: address, value: 10n ** 19n });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  if (current !== 0n && current !== vatToUint(vat)) {
    throw new Error(`org ${uid} key ${address} is already a signer for VAT ${current}, not ${vat}; refusing to re-point it`);
  }
  if (current === 0n) {
    const h = await reg.write.setSigner([address, vatToUint(vat)]);
    await publicClient.waitForTransactionReceipt({ hash: h });
    registered = true;
  }
  return { address, registered };
}

export interface AnchorStruct {
  actHash: Hex; actType: Hex; payerVat: bigint; payeeVat: bigint; amountCents: bigint; issueDate: number;
  prevAnchor: Hex; contractRef: Hex; signer: Address; anchoredAt: bigint; voided: boolean;
}

/** `orgVat` is the publishing organisation's VAT (its /organizations record), not the typed payer, which acts
 *  often leave empty or get wrong. The typed payer is still in actHash (SPEC §2, §4). */
export function toAnchor(d: DiavgeiaDecision, prevAnchor: Hex, orgVat: string): AnchorStruct {
  const sponsor = d.extraFieldValues?.sponsor?.[0];
  return {
    actHash: actHash(d),
    actType: actTypeKey(d.decisionTypeId),
    payerVat: vatToUint(orgVat),
    payeeVat: vatToUint(sponsor?.sponsorAFMName?.afm ?? ""),
    amountCents: toCents(sponsor?.expenseAmount?.amount),
    issueDate: unixDay(d.issueDate),
    prevAnchor,
    contractRef: contractRefKey(contractRefFromSubject(d.subject)),
    signer: "0x0000000000000000000000000000000000000000",
    anchoredAt: 0n,
    voided: isVoid(d.subject),
  };
}

export function registry(dep: Deployment, key: Hex = ADMIN_KEY) {
  return getContract({ address: dep.registry, abi: artifact("ActRegistry").abi, client: { public: publicClient, wallet: wallet(key) } });
}
export function gate(dep: Deployment, key: Hex = TREASURY_KEY) {
  return getContract({ address: dep.gate, abi: artifact("PaymentGate").abi, client: { public: publicClient, wallet: wallet(key) } });
}
export function graph(dep: Deployment, key: Hex) {
  return getContract({ address: dep.graph, abi: artifact("ProcurementGraph").abi, client: { public: publicClient, wallet: wallet(key) } });
}

export async function readVersions(dep: Deployment, ada: string): Promise<AnchorStruct[]> {
  const reg = registry(dep);
  const key = adaKey(ada);
  const n = (await reg.read.versionCount([key])) as bigint;
  const out: AnchorStruct[] = [];
  for (let i = 0n; i < n; i++) out.push((await reg.read.versionAt([key, i])) as AnchorStruct);
  return out;
}

/** Anchor one version; returns the on-chain version number. */
export async function anchorOne(dep: Deployment, d: DiavgeiaDecision, prevAnchor: Hex, key: Hex, orgVat: string): Promise<number> {
  const reg = registry(dep, key);
  const h = await reg.write.anchor([adaKey(d.ada), toAnchor(d, prevAnchor, orgVat)]);
  const rc = await publicClient.waitForTransactionReceipt({ hash: h });
  const logs = parseEventLogs({ abi: artifact("ActRegistry").abi, logs: rc.logs, eventName: "Anchored" });
  return Number((logs[0] as unknown as { args: { version: number } }).args.version);
}

export const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

/** Inverse of adaKey: strip the zero padding and decode UTF-8. */
export function adaFromKey(key: Hex): string {
  const bytes = hexToBytes(key);
  let n = bytes.length;
  while (n > 0 && bytes[n - 1] === 0) n--;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n));
}

/** ChainReader for report.ts. Scans Anchored logs from `fromBlock` (0 on Anvil;
 *  on a real chain pass the registry's deployment block). */
export function chainReader(dep: Deployment, fromBlock = 0n): ChainReader {
  return {
    versions: (ada) => readVersions(dep, ada),
    async anchoredAdas() {
      const logs = await publicClient.getContractEvents({
        address: dep.registry, abi: artifact("ActRegistry").abi, eventName: "Anchored", fromBlock, toBlock: "latest",
      });
      const keys = new Set(logs.map((l) => (l as unknown as { args: { ada: Hex } }).args.ada));
      return [...keys].map(adaFromKey);
    },
  };
}
