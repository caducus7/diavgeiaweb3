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
export const SIGNER_KEY = (process.env.SIGNER_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex; // account 1
export const TREASURY_KEY = (process.env.TREASURY_KEY ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a") as Hex; // account 2

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(OUT, `${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

// viem polls for receipts every 4s by default. Anvil mines on submission, so locally that is pure waiting
// (4s per anchor, over 6 hours for a year of Athens). Poll fast only against a local node.
const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: LOCAL_RPC ? 50 : 4_000 });
export const wallet = (key: Hex) =>
  createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(key) });

export interface Deployment {
  registry: Address;
  gate: Address;
  graph: Address;
  rail: Address;
  signer: Address;
  signerOrgVat: string;
}

export async function deploy(orgVat: string): Promise<Deployment> {
  const admin = wallet(ADMIN_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY).address;
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

  const reg = getContract({ address: registry, abi: artifact("ActRegistry").abi, client: admin });
  const h = await reg.write.setSigner([signer, vatToUint(orgVat)]);
  await publicClient.waitForTransactionReceipt({ hash: h });

  const d: Deployment = { registry, gate, graph, rail, signer, signerOrgVat: orgVat };
  writeFileSync(DEPLOY_FILE, JSON.stringify(d, null, 2));
  return d;
}

export function loadDeployment(): Deployment {
  if (!existsSync(DEPLOY_FILE)) throw new Error("no deployment.json; run `deploy` first");
  return JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));
}

export interface AnchorStruct {
  actHash: Hex; actType: Hex; payerVat: bigint; payeeVat: bigint; amountCents: bigint; issueDate: number;
  prevAnchor: Hex; contractRef: Hex; signer: Address; anchoredAt: bigint; voided: boolean;
}

export function toAnchor(d: DiavgeiaDecision, prevAnchor: Hex): AnchorStruct {
  const sponsor = d.extraFieldValues?.sponsor?.[0];
  return {
    actHash: actHash(d),
    actType: actTypeKey(d.decisionTypeId),
    payerVat: vatToUint(d.extraFieldValues?.org?.afm ?? ""),
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

export function registry(dep: Deployment, key: Hex = SIGNER_KEY) {
  return getContract({ address: dep.registry, abi: artifact("ActRegistry").abi, client: { public: publicClient, wallet: wallet(key) } });
}
export function gate(dep: Deployment, key: Hex = TREASURY_KEY) {
  return getContract({ address: dep.gate, abi: artifact("PaymentGate").abi, client: { public: publicClient, wallet: wallet(key) } });
}
export function graph(dep: Deployment, key: Hex = SIGNER_KEY) {
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
export async function anchorOne(dep: Deployment, d: DiavgeiaDecision, prevAnchor: Hex): Promise<number> {
  const reg = registry(dep);
  const h = await reg.write.anchor([adaKey(d.ada), toAnchor(d, prevAnchor)]);
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
