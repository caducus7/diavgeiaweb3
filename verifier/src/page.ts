/**
 * Static per-municipality page: portal total, anchored total, difference.
 * One self-contained HTML file, no scripts, no external requests.
 *
 * Shows ADAs, statuses and amounts only. Subjects and payee names are left out:
 * subjects are free text and can name natural persons. Everything that came from
 * Diavgeia is escaped.
 */
import { formatEur, type Report, type Status } from "./report.js";
import { CANONICAL_VERSION } from "./canonical.js";
import { basename } from "node:path";

export interface PageMeta {
  source: "live" | "fixture";
  fixturePath?: string;
  generatedAt: Date;
  registry: string;
  chainId: number;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LABEL: Record<Status, string> = {
  ok: "matches",
  void: "voided, history kept",
  unanchored: "not anchored",
  "chain-behind": "newer version not anchored",
  mismatch: "portal differs from anchor",
  "chain-ahead": "portal lost a version",
  "portal-missing": "anchored, gone from portal",
  "history-error": "portal contradicts itself",
  "foreign-anchor": "anchored by another organisation",
  unsupported: "amount the anchor cannot hold",
};

const ORDER: Status[] = ["mismatch", "foreign-anchor", "chain-ahead", "portal-missing", "history-error", "unsupported", "chain-behind", "unanchored", "void", "ok"];

const cents = (c: bigint | null) => (c === null ? "&ndash;" : esc(formatEur(c)));

export function renderPage(r: Report, m: PageMeta): string {
  const p = r.params;
  const title = `${r.orgName ?? `Organisation ${p.org}`}: ${p.type}, ${p.from} to ${p.to}`;
  const rows = [...r.findings]
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.ada.localeCompare(b.ada))
    .map((f) => `<tr class="s-${f.status}"><td><a href="https://diavgeia.gov.gr/decision/view/${encodeURIComponent(f.ada)}">${esc(f.ada)}</a></td>`
      + `<td>${esc(LABEL[f.status])}</td><td class="n">${cents(f.portalCents)}</td><td class="n">${cents(f.chainCents)}</td><td>${esc(f.detail)}</td></tr>`)
    .join("\n");
  const signerRows = r.signers.map((s) =>
    `<tr><td>${esc(s.id)}</td><td class="n">${s.acts}</td><td>${s.orgSignRights === null ? "unknown" : s.orgSignRights ? "yes" : "no"}</td></tr>`).join("\n");
  const issueRows = r.signerIssues.map((i) =>
    `<tr><td>${esc(i.ada)}</td><td>${esc(i.signerId)}</td><td>${esc(i.issue)}</td></tr>`).join("\n");
  const otherPayerRows = r.payerNotes.other.map((o) => `<tr><td><a href="https://diavgeia.gov.gr/decision/view/${encodeURIComponent(o.ada)}">${esc(o.ada)}</a></td></tr>`).join("\n");
  const noRights = r.signers.filter((s) => s.orgSignRights === false).reduce((n, s) => n + s.acts, 0);
  const counts = ORDER.filter((s) => r.counts[s]).map((s) => `${esc(LABEL[s])}: ${r.counts[s]}`).join(" &middot; ");

  const caveats = [
    m.source === "fixture"
      ? `Data source: a saved fixture (${esc(basename(m.fixturePath ?? ""))}), not the live portal. The live OpenData API was not queried for this page.`
      : "Data source: the live Diavgeia OpenData API at the time shown below.",
    "Totals count what the on-chain anchor exposes: the sum of an act's lines when they all name one payee (an itemised bill), the first line otherwise."
      + (r.multiPayee ? ` ${r.multiPayee} act(s) in this window have more than one line.` : "")
      + (r.multiNoPayee ? ` ${r.multiNoPayee} of them name no payee on any line (payroll, withholding remittances); their ${esc(formatEur(r.multiNoPayeeCents))} is in both totals, but no payee is anchored.` : "")
      + (r.splitPayee ? ` <strong>${r.splitPayee} act(s) split the payment between payees; the lines after the first add ${esc(formatEur(r.splitUncounted))} that neither total shows.</strong>` : ""),
    r.nonEur ? `<strong>${r.nonEur} act(s) carry a non-EUR amount and are summed as if EUR.</strong>` : "",
    r.counts.unsupported ? `<strong>${r.counts.unsupported} act(s) carry an amount the canonical form cannot represent</strong> (negative, as on a credit line; sub-cent, as with a rounding residue; or above 1e12 EUR). They are not anchored and their amounts are in neither total.` : "",
    r.noAmount ? `${r.noAmount} act(s) carry no amount at all (payroll orders, for one) and are invisible in both totals.` : "",
    "Voided acts are excluded from both totals. Voiding is detected from the subject text (Diavgeia has no void flag), so a void can be missed.",
    `Every anchor carries this organisation's VAT (${p.vatFromRegistry ? "from Diavgeia's organisation record" : "given by the operator: this data source has no organisation record"}), not the payer typed into the act, which is often empty or wrong. The typed payer is still part of the anchored hash, so it cannot change unnoticed either.`,
    "Anchors are written by a civic crawler key, not by the municipality. This page shows that the portal has not changed since anchoring; it does not show the portal was right to begin with.",
  ].filter(Boolean).map((c) => `<li>${c}</li>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --fg:#1a1a1a; --mute:#5c5c5c; --bg:#fff; --line:#ddd; --bad:#b00020; --warn:#8a5a00; --good:#1b6e3a; }
@media (prefers-color-scheme: dark) { :root { --fg:#eee; --mute:#aaa; --bg:#141414; --line:#333; --bad:#ff6b7f; --warn:#e0b050; --good:#6fcf8f; } }
body { margin:0 auto; max-width:960px; padding:24px 16px; font:15px/1.5 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
h1 { font-size:1.4rem; margin:0 0 4px; } .sub { color:var(--mute); margin:0 0 24px; }
.big { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:16px; }
.big div { border:1px solid var(--line); border-radius:8px; padding:12px; } .big span { display:block; color:var(--mute); font-size:.85rem; }
.big b { font-size:1.3rem; font-variant-numeric:tabular-nums; }
.verdict { padding:10px 12px; border-radius:8px; border:1px solid currentColor; margin-bottom:24px; }
.verdict.bad { color:var(--bad); } .verdict.good { color:var(--good); } .verdict.warn { color:var(--warn); }
.scroll { overflow-x:auto; } table { border-collapse:collapse; width:100%; font-size:.9rem; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; } td.n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
tr.s-mismatch td:nth-child(2), tr.s-foreign-anchor td:nth-child(2), tr.s-chain-ahead td:nth-child(2), tr.s-portal-missing td:nth-child(2), tr.s-history-error td:nth-child(2) { color:var(--bad); font-weight:600; }
tr.s-chain-behind td:nth-child(2), tr.s-unanchored td:nth-child(2), tr.s-unsupported td:nth-child(2) { color:var(--warn); }
a { color:inherit; } ul { color:var(--mute); padding-left:20px; } footer { color:var(--mute); font-size:.8rem; margin-top:24px; word-break:break-all; }
</style>
</head>
<body>
<h1>${esc(r.orgName ?? `Organisation ${p.org}`)}</h1>
<p class="sub">Diavgeia org ${esc(p.org)}, VAT ${esc(p.orgVat)} &middot; act type ${esc(p.type)} &middot; issued ${esc(p.from)} to ${esc(p.to)}</p>
<div class="big">
  <div><span>Portal shows (non-void)</span><b>${esc(formatEur(r.portalTotal))}</b></div>
  <div><span>Anchored on chain (non-void)</span><b>${esc(formatEur(r.chainTotal))}</b></div>
  <div><span>Difference</span><b>${esc(formatEur(r.difference))}</b></div>
</div>
${r.noAmount * 10 >= r.acts && r.acts ? `<p class="verdict warn"><strong>${r.noAmount} of ${r.acts} acts state no amount</strong>, so these totals cover only the rest. The tamper check covers those acts like any other.</p>` : ""}
<p class="verdict ${r.alarm ? "bad" : "good"}">${r.alarm
    ? "The portal and the chain disagree on published content. See the rows marked in red."
    : "No published act in this window differs from what was anchored."}</p>
<p>${counts || "No acts in this window."}</p>
<div class="scroll"><table>
<thead><tr><th>ADA</th><th>Status</th><th class="n">Portal</th><th class="n">Chain</th><th>Detail</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<h2>Who signed</h2>
<p>${r.signers.length} signer(s) from Diavgeia's signer registry, by id (names are on the portal, not repeated here).
${noRights ? `${noRights} of the window's acts were signed by signers without organisation-level signing rights.` : ""}
${r.signerChecks === "unavailable" ? "<strong>Signer checks were not run: this data source holds no signer records.</strong>"
    : r.signerIssues.length ? `<strong>${r.signerIssues.length} signer issue(s) below.</strong>`
    : r.signers.length ? "Every signer belongs to this organisation and was active on the issue day." : "No act in this window lists a signer."}</p>
<div class="scroll"><table>
<thead><tr><th>Signer id</th><th class="n">Acts</th><th>Organisation-level rights</th></tr></thead>
<tbody>
${signerRows}
</tbody>
</table></div>
${r.signerIssues.length ? `<div class="scroll"><table>
<thead><tr><th>ADA</th><th>Signer id</th><th>Issue</th></tr></thead>
<tbody>
${issueRows}
</tbody>
</table></div>` : ""}
<h2>What the acts type as payer</h2>
<p>${r.payerNotes.empty || r.payerNotes.other.length
    ? `${r.payerNotes.empty} act(s) leave the payer field empty${r.payerNotes.other.length ? ` and ${r.payerNotes.other.length} name a payer other than this organisation (listed below; the portal shows whom)` : ""}. A data-quality note at source, not a disagreement: these acts are anchored under this organisation like any other.`
    : "Every act names this organisation as payer."}</p>
${r.payerNotes.other.length ? `<div class="scroll"><table>
<thead><tr><th>ADA with another payer typed</th></tr></thead>
<tbody>
${otherPayerRows}
</tbody>
</table></div>` : ""}
<h2>Read this before quoting the number</h2>
<ul>
${caveats}
</ul>
<footer>Generated ${esc(m.generatedAt.toISOString())} &middot; canonical form v${CANONICAL_VERSION} &middot; chain ${m.chainId} &middot; ActRegistry ${esc(m.registry)}</footer>
</body>
</html>
`;
}
