
import { InvestigationPanel } from "./investigation-panel";
import { ArrowUpRight, Fingerprint, GitBranch, ShieldQuestion } from "lucide-react";
import type { Address, InvestigationReport } from "@/domain/investigations/types";
import type { ReportAssessment } from "@/domain/investigations/report-assessment";
import { deriveDecisionXray, deriveRuleWeightedJudge } from "@/domain/investigations/report-judge";
import { deriveReportDistribution } from "@/domain/investigations/report-distribution";
import { deriveHolderPopulationPresentation, deriveWalletLinkPresentation } from "@/domain/investigations/holder-population";
import { deriveHolderTableDistribution } from "@/domain/investigations/holder-table-distribution";
import { supplyShare, tokenAmount } from "./investigation-amounts";
import { deriveSupplementalReportFacts, type ReportConcernSignal } from "@/domain/investigations/report-facts";

const panel = "relative isolate min-w-0 overflow-hidden rounded-xl border border-border bg-surface/95";
const eyebrow = "font-mono text-[9px] uppercase tracking-[0.16em] text-muted";
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
type Reveal = (id: string) => void;

function GoPlusLogo() {
  // eslint-disable-next-line @next/next/no-img-element -- Unmodified local attribution asset; explicit dimensions preserve layout without inline styles under CSP.
  return <img src="/providers/goplus-logo.png" width={388} height={78} alt="" className="h-5 w-auto shrink-0 brightness-0 dark:invert" loading="lazy" />;
}

function Citations({ ids, onReveal }: { ids: string[]; onReveal: Reveal }) {
  return <div className="flex flex-wrap gap-x-4">{ids.map((id, index) => <a key={id} href={`#evidence-${encodeURIComponent(id)}`} onClick={() => onReveal(id)} className="inline-flex min-h-11 items-center gap-1 font-mono text-[10px] underline decoration-border underline-offset-4">Evidence {index + 1}<ArrowUpRight size={11} aria-hidden="true" /></a>)}</div>;
}

function SourceSignal({ signal }: { signal: Exclude<ReportConcernSignal, { kind: "concentration" }> }) {
  return <li className="py-3"><p className="text-xs font-medium leading-6">{signal.kind === "thin-liquidity" ? `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(signal.liquidityUsd)} reported liquidity in the selected pair` : signal.label}</p><p className="mt-1 text-[10px] leading-5 text-muted">{signal.kind === "thin-liquidity" ? "DEX Screener · selected pair only" : "GoPlus · source-reported flag"} · {signal.checkedAt}</p><a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-2 text-[11px] underline underline-offset-4">Inspect source<ArrowUpRight size={11} aria-hidden="true" /></a><details><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">Basis and limits</summary>{signal.limitations.map((limit) => <p key={limit} className="pb-2 text-[11px] leading-6 text-muted">{limit}</p>)}</details></li>;
}

/** Shared labels keep the header, gauge and detailed verdict consistent. */
export function reportReviewLabel(assessment: ReportAssessment): ReportAssessment["verdict"] { return assessment.verdict; }

export function reportScoreLabel(assessment: ReportAssessment): string {
  return String(assessment.displayedScore);
}
const percent = (value: string | null) => value === null ? "—" : `${value.replace(/%$/, "")}%`;

export function InvestigationScoreGauge({ assessment, report }: { assessment: ReportAssessment; report: InvestigationReport }) {
  const distribution = deriveReportDistribution(report);
  const population = deriveHolderPopulationPresentation(report);
  const links = deriveWalletLinkPresentation(report);
  const score = reportScoreLabel(assessment);
  const upperBound = assessment.overallScore === null;
  return <InvestigationPanel aria-labelledby="score-gauge-title" className="traceforce-gauge-panel p-5 text-center">
    <h2 id="score-gauge-title" className="sr-only">Score</h2>
    <div className="relative mx-auto size-44"><svg viewBox="0 0 180 180" className="size-full -rotate-90" aria-hidden="true"><circle cx="90" cy="90" r="72" fill="none" stroke="currentColor" strokeWidth="12" className="text-border" />{assessment.displayedScore > 0 && <circle cx="90" cy="90" r="72" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${assessment.displayedScore / 100 * 452.389} 452.389`} className={assessment.band === "DANGER" ? "text-amber" : "text-accent"} />}</svg><div className="absolute inset-0 flex flex-col items-center justify-center"><span className={score.length > 4 ? "font-mono text-4xl font-semibold" : "font-mono text-5xl font-semibold"}>{score}</span><span className="mt-1 font-mono text-[10px] text-muted">/ 100{upperBound ? " · PARTIAL" : ""}</span></div></div>
    <span className={assessment.band === "DANGER" ? "mt-2 inline-flex border border-amber/40 bg-amber/10 px-3 py-1.5 font-mono text-[11px] font-semibold tracking-wider text-amber" : "mt-2 inline-flex border border-accent/30 bg-accent/10 px-3 py-1.5 font-mono text-[11px] font-semibold tracking-wider text-accent"}>{assessment.band}</span>
    <p className="mt-4 text-lg font-semibold tracking-tight">{links.walletCount > 0 ? links.summaryLabel : population.shownLabel}</p>
    {links.linkedGroupCount > 0 && <p className="mt-1 text-xs leading-5 text-muted">{links.membershipLabel}.<br />Links do not prove the same owner.</p>}
    <p className="mt-2 text-xs leading-6 text-muted">{assessment.metrics.dumpImpactPercent !== null ? `Biggest ${assessment.holdingBasis.kind === "wallets" ? "wallet" : "address"} modeled dump −${percent(assessment.metrics.dumpImpactPercent)} (${percent(assessment.metrics.largestSharePercent)} of ${assessment.holdingBasis.denominatorLabel})` : `Largest holder: ${percent(assessment.metrics.largestSharePercent)} of ${distribution.holdingDenominatorLabel}`}</p>
    <details className="mt-2 text-left"><summary className="min-h-11 cursor-pointer content-center text-center text-[10px] text-muted">Details</summary><p aria-label="Score range" className="pb-2 text-xs text-muted">Possible score: {assessment.scoreRange.minimum}–{assessment.scoreRange.maximum}{upperBound ? " · incomplete" : " · assessed"}</p><p className="pb-2 text-[11px] text-muted">{population.shownLabel}. Linked groups contain wallets connected by retained transactions, including paths through other addresses. They do not establish common ownership. Contract holdings have separate risk warnings.</p><p className="pb-3 text-[11px] leading-6 text-muted">{assessment.assessedPoints} earned points; {assessment.assessedPossiblePoints}/100 weighted points assessed. The gauge rounds the capped subtotal to the nearest integer. Unassessed categories earn 0 without establishing that their risks are absent. {assessment.metrics.dumpImpactPercent !== null && "Dump impact uses a no-fee constant-product model for the largest examined wallet against pinned pool reserves; it is not an executable trade quote."} {deriveHolderTableDistribution(report).definition}</p></details>
  </InvestigationPanel>;
}

export function InvestigationVerdictScore({ assessment, report, onReveal }: { assessment: ReportAssessment; report: InvestigationReport; onReveal: Reveal }) {
  const snapshot = report.holderSnapshot;
  const xray = deriveDecisionXray(assessment);
  const judge = deriveRuleWeightedJudge(assessment);
  const sourceSignals = deriveSupplementalReportFacts(report).signals.filter((signal): signal is Exclude<ReportConcernSignal, { kind: "concentration" }> => signal.kind !== "concentration");
  const receipt = JSON.stringify({ model: judge.modelId, decision: assessment.verdict, confidence: null, weight_kind: "normalized-rule-weights", p: judge.weights, raw_mass: judge.masses, total_mass: judge.totalMass, score: assessment.displayedScore, earned_points: assessment.assessedPoints, score_range: assessment.scoreRange });
  return <InvestigationPanel aria-labelledby="verdict-score-title" className={panel}>
    <div className="flex flex-wrap items-center gap-3 px-5 pt-5"><h2 id="verdict-score-title" className="font-mono text-xs font-semibold tracking-wider"><span aria-hidden="true" className="text-muted">{"// "}</span>VERDICT OUTPUT</h2><span className="font-mono text-[10px] text-muted">rule weights</span></div>
    <div className="p-5">
      <p className="font-mono text-5xl font-semibold tracking-wider text-foreground">{assessment.verdict}</p>
      <InvestigationVerdictWeights assessment={assessment} />
      <section aria-labelledby="decision-xray-title" className="mt-4 border-t border-dashed border-border pt-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h3 id="decision-xray-title" className="font-mono text-[10px] font-semibold tracking-wider">DECISION X-RAY</h3><span className="font-mono text-[10px] text-muted">raw {judge.selectedWeight} mass → normalized</span></div>
        <div className="mt-3 space-y-2 font-mono text-[10px]">
          {judge.contributions.map((row, index) => {
            const mass = row.masses[judge.selectedWeight];
            const label = row.id === "base" ? `base ${judge.selectedWeight} · score ${assessment.displayedScore}` : row.label;
            return <div key={row.id} data-mass-id={row.id} data-decision-mass={mass} className="grid grid-cols-[minmax(0,1.4fr)_minmax(3rem,1fr)_3rem] items-center gap-2"><span className="text-muted">{index > 0 ? "+ " : ""}{label}</span><svg viewBox="0 0 100 5" className="h-1.5 w-full" aria-hidden="true"><rect width="100" height="5" className="fill-border" /><rect width={mass / judge.totalMass * 100} height="5" className="fill-foreground" /></svg><span className="whitespace-nowrap text-right tabular-nums">+{mass.toFixed(2)}</span></div>;
          })}
          <div data-total-mass={judge.totalMass} data-selected-mass={judge.masses[judge.selectedWeight]} className="grid grid-cols-[minmax(0,1.4fr)_minmax(3rem,1fr)_3rem] items-center gap-2 border-t border-dashed border-border pt-2 font-semibold"><span>= {judge.selectedWeight} {judge.masses[judge.selectedWeight].toFixed(2)} / total {judge.totalMass.toFixed(2)}</span><svg viewBox="0 0 100 5" className="h-1.5 w-full" aria-hidden="true"><rect width="100" height="5" className="fill-border" /><rect width={judge.decisionWeight * 100} height="5" className="fill-foreground" /></svg><span className="whitespace-nowrap text-right tabular-nums">{judge.displayPercentages[judge.selectedWeight]}</span></div>
        </div>
      </section>
      <details className="mt-3 border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">Details</summary>
      <p className="pb-3 text-xs leading-6 text-muted">{snapshot ? `${snapshot.balances.verifiedWallets}/${snapshot.balances.requestedWallets} candidate balances checked at block ${snapshot.block.number}.` : "No pinned balance snapshot was acquired."}</p>
      {assessment.gates.length > 0 && <ul aria-label="Observed warnings" className="divide-y divide-border">{assessment.gates.map((gate) => <li key={gate.id} className="py-3"><p className="text-xs font-medium leading-6">{gate.label}</p><p className="text-[11px] leading-6 text-muted">{gate.basis}</p><Citations ids={gate.evidenceIds} onReveal={onReveal} />{gate.sourceUrl && <a href={gate.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-xs underline underline-offset-4">Inspect source<ArrowUpRight size={11} aria-hidden="true" /></a>}</li>)}</ul>}
      <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10px]"><span className="border border-border px-2 py-1">rule assessment</span><span className="border border-border px-2 py-1">score {reportScoreLabel(assessment)}</span></div>
      <p className="mt-2 break-all font-mono text-[10px] text-muted">receipt <span className="text-foreground">{report.id}</span></p>
      <pre aria-label="Verdict receipt" className="mt-3 max-w-full whitespace-pre-wrap break-all border border-border bg-background p-3 font-mono text-[10px] leading-5">{receipt}</pre>
      <p className="mt-3 font-mono text-[10px] leading-5 text-muted">{assessment.triggeredRules.length} triggered rules · {assessment.assessedPossiblePoints}/100 points assessed{snapshot ? ` · ${snapshot.balances.verifiedWallets}/${snapshot.balances.requestedWallets} balances` : ""}</p>
      <div className="mt-3 border-t border-border pt-3"><p className="pb-3 text-xs leading-6 text-muted">{assessment.judge.label}. {assessment.judge.summary} Supported category deductions: {xray.totalKnownDeduction}/100. Decision percentages are normalized rule weights, not calibrated probabilities or confidence.</p><ul aria-label="Decision weight policy" className="space-y-2 pb-3 text-xs leading-6 text-muted">{judge.policy.map((line) => <li key={line}>{line}</li>)}</ul><dl className="mb-4 grid grid-cols-2 gap-4">{[
        { label: "Largest holder", value: percent(assessment.metrics.largestSharePercent) },
        { label: "Creator holds", value: percent(assessment.metrics.creatorSharePercent) },
        { label: "Examined top 10", value: percent(assessment.metrics.topTenSharePercent) },
        { label: "Dump impact", value: assessment.metrics.dumpImpactPercent === null ? "—" : `−${percent(assessment.metrics.dumpImpactPercent)}` },
      ].map((metric) => <div key={metric.label}><dt className="text-[10px] text-muted">{metric.label}</dt><dd className="mt-1 font-mono text-base">{metric.value}</dd></div>)}</dl></div>
      {sourceSignals.length > 0 && <div className="mt-3 border-t border-border pt-3"><h3 className="text-xs font-medium">Market and contract context</h3><ul className="divide-y divide-border">{sourceSignals.map((signal) => <SourceSignal key={signal.id} signal={signal} />)}</ul></div>}
      </details>
    </div>
  </InvestigationPanel>;
}

export function InvestigationVerdictWeights({ assessment }: { assessment: ReportAssessment }) {
  const judge = deriveRuleWeightedJudge(assessment);
  return <dl aria-label="Verdict decision weights" className="mt-5 space-y-2 font-mono text-xs">{(["avoid", "caution", "ok"] as const).map((label) => {
    const percent = judge.weights[label] * 100;
    return <div key={label} className="grid grid-cols-[4rem_minmax(0,1fr)_3rem] items-center gap-2"><dt>{label}</dt><dd className="contents" aria-label={`${label} rule weight ${judge.displayPercentages[label]}`}><svg viewBox="0 0 100 3" preserveAspectRatio="none" aria-hidden="true" className="block h-1.5 w-full overflow-hidden rounded-full"><rect width="100" height="3" className="fill-border" /><rect width={percent} height="3" className={label === "avoid" ? "fill-foreground" : "fill-muted"} /></svg><span className="text-right font-semibold tabular-nums">{judge.displayPercentages[label]}</span></dd></div>;
  })}</dl>;
}

export { InvestigationRuleBreakdown } from "./investigation-score-breakdown";

export function InvestigationClusters({ report, onSelect, onReveal }: { report: InvestigationReport; onSelect: (address: Address) => void; onReveal: Reveal }) {
  const holdings = new Map(deriveSupplementalReportFacts(report).groups.map((group) => [group.id, group.holding]));
  const distribution = deriveReportDistribution(report);
  return <InvestigationPanel aria-labelledby="clusters-title" className={panel}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><h2 id="clusters-title" className="flex items-center gap-2 text-sm font-medium"><GitBranch size={15} aria-hidden="true" />Clusters</h2><span className="font-mono text-[10px] text-muted">{report.groups.length} SWARMS</span></div>
    {report.groups.length ? <ul className="grid gap-px bg-border md:grid-cols-2">{report.groups.map((group, index) => {
      const holding = holdings.get(group.id);
      const links = report.connections.filter((edge) => group.wallets.includes(edge.from) && group.wallets.includes(edge.to));
      const transfers = links.filter((edge) => edge.kind === "transfer").length, funding = links.filter((edge) => edge.kind === "funding").length;
      return <li key={group.id} className="min-w-0 bg-surface p-5 md:last:odd:col-span-2">
        <div className="flex items-center justify-between gap-3"><h3 className="font-mono text-xs">SWARM {index + 1}</h3><span className="text-[10px] text-muted">{group.wallets.length} linked wallets</span></div>
        <p className="mt-2 text-[11px] leading-6 text-muted">{transfers} token {transfers === 1 ? "link" : "links"} · {funding} funding {funding === 1 ? "link" : "links"}</p>
        {holding && <div className="mt-3 border-y border-border py-3"><p className="font-mono text-base">{holding.knownBalanceRaw !== null ? `${holding.isLowerBound ? "≥ " : ""}${supplyShare(holding.knownBalanceRaw, distribution.holdingDenominatorRaw) ?? "—"}` : "—"}<span className="ml-2 text-[10px] uppercase text-muted">OF {distribution.holdingDenominatorLabel}</span></p><p className="mt-2 text-[10px] text-muted">{holding.verifiedAddresses} / {holding.totalAddresses} balances · block {holding.block.number}</p></div>}
        <div className="mt-2 flex flex-wrap gap-x-4">{group.wallets.map((address) => <button key={address} type="button" onClick={() => onSelect(address)} title={address} className="min-h-11 font-mono text-[10px] underline decoration-border underline-offset-4">{short(address)}</button>)}</div>
        <details className="border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">Why these wallets are linked</summary><p className="text-xs leading-6 text-muted">{group.explanation}</p><p className="mt-2 text-[11px] leading-6 text-muted">These transaction links do not establish that the wallets belong to the same person.</p><ul className="mt-3 divide-y divide-border">{links.map((edge) => <li key={edge.id} className="py-2"><p className="font-mono text-[10px]">{short(edge.from)} → {short(edge.to)} · {edge.kind === "funding" ? "native funding" : "token transfer"}</p><Citations ids={edge.evidenceIds} onReveal={onReveal} /></li>)}</ul>{!links.length && <Citations ids={group.evidenceIds} onReveal={onReveal} />}</details>
      </li>;
    })}</ul> : <p className="p-5 text-xs leading-6 text-muted">No swarm established from retained transactions.</p>}
  </InvestigationPanel>;
}
export function InvestigationContract({ report }: { report: InvestigationReport }) {
  const security = report.token.securitySnapshot;
  const facts = [{ label: "Network", value: "Base · 8453" }, { label: "Decimals", value: report.token.decimals?.toString() ?? "—" }, { label: "Pinned total supply", value: report.token.totalSupplyRaw === null ? "—" : tokenAmount(report.token.totalSupplyRaw, report.token.decimals) }];
  const checkLabels = [
    ["is_honeypot", "Honeypot flag"], ["is_proxy", "Proxy flag"], ["is_mintable", "Mintable flag"],
    ["hidden_owner", "Hidden owner flag"], ["can_take_back_ownership", "Ownership recovery flag"],
    ["owner_change_balance", "Owner balance control flag"], ["transfer_pausable", "Transfer pause flag"],
    ["is_blacklisted", "Blacklist flag"], ["is_open_source", "Open source flag"],
  ] as const;
  const values = new Map(security?.status === "reported" ? security.checks.map((check) => [check.id, check.value]) : []);
  return <InvestigationPanel aria-labelledby="contract-title" className={panel}><div className="border-b border-border px-5 py-4"><h2 id="contract-title" className="flex items-center gap-2 text-sm font-medium"><ShieldQuestion size={15} aria-hidden="true" />Contract</h2>{security?.status === "reported" && <a href="https://gopluslabs.io/" target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex min-h-11 items-center gap-2 text-[10px] text-muted underline underline-offset-4"><GoPlusLogo />Powered by GoPlus<ArrowUpRight size={11} aria-hidden="true" /></a>}</div><a href={`https://basescan.org/address/${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className="m-5 inline-flex min-h-11 max-w-[calc(100%-2.5rem)] items-center gap-2 break-all font-mono text-[11px] underline decoration-border underline-offset-4">{report.token.address}<ArrowUpRight size={12} className="shrink-0" aria-hidden="true" /></a><dl className="divide-y divide-border border-t border-border">{facts.map((fact) => <div key={fact.label} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3 text-xs"><dt className="text-muted">{fact.label}</dt><dd className="break-all font-mono text-[11px]">{fact.value}</dd></div>)}{(security ? ["Ownership / renouncement"] : ["Ownership / renouncement", "Mint, freeze and proxy controls", "Transfer tax / sell restrictions"]).map((label) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3 text-xs"><dt className="text-muted">{label}</dt><dd>Not assessed</dd></div>)}</dl>{security && <div className="border-t border-border p-5"><h3 className={eyebrow}>GoPlus · source-reported checks</h3>{security.status === "reported" ? <><dl className="mt-3 divide-y divide-border">{checkLabels.map(([id, label]) => <div key={id} className="flex items-baseline justify-between gap-4 py-2.5 text-xs"><dt className="text-muted">{label}</dt><dd className="font-mono text-[11px]">{values.get(id) === "yes" ? "Yes" : values.get(id) === "no" ? "No" : "Unknown"}</dd></div>)}</dl>{security.creatorAddress && <div className="mt-3 text-xs"><p className="text-muted">Source-reported creator</p><a href={`https://basescan.org/address/${security.creatorAddress}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 max-w-full items-center gap-2 break-all font-mono text-[11px] underline decoration-border underline-offset-4">{security.creatorAddress}<ArrowUpRight size={12} className="shrink-0" aria-hidden="true" /></a></div>}<p className="mt-2 text-[11px] leading-6 text-muted">Source flags are not a guarantee of safety, renounced ownership or creator identity.</p></> : <p className="mt-3 text-xs leading-6 text-muted">{security.status === "unavailable" ? "Contract checks unavailable from the source." : "No usable contract checks were included in the source."}</p>}<p className="mt-3 text-[10px] leading-6 text-muted">Checked <time dateTime={security.checkedAt}>{security.checkedAt}</time></p><a href={`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-2 text-[11px] underline decoration-border underline-offset-4">GoPlus source<ArrowUpRight size={12} aria-hidden="true" /></a></div>}</InvestigationPanel>;
}

export function InvestigationDeployerDNA({ report, onReveal }: { report: InvestigationReport; onReveal: Reveal }) {
  const creator = deriveSupplementalReportFacts(report).creator;
  const directCreation = creator?.attribution.kind === "direct-contract-creation";
  const holding = creator?.holding, share = holding?.shareOfSupply;
  const proof = creator ? [
    { label: "Native funding received", ids: creator.evidence.nativeReceivedIds },
    { label: "Native funding sent", ids: creator.evidence.nativeSentIds },
    { label: "Token receipts", ids: creator.evidence.tokenReceivedIds },
    { label: "Token transfers sent", ids: creator.evidence.tokenSentIds },
  ] : [];
  return <InvestigationPanel aria-labelledby="deployer-dna-title" className={panel}>
    <div className="border-b border-border px-5 py-4"><h2 id="deployer-dna-title" className="flex items-center gap-2 text-sm font-medium"><Fingerprint size={15} aria-hidden="true" />Deployer DNA</h2></div>
    {creator ? <div className="p-5"><p className={eyebrow}>{directCreation ? "Receipt-backed creator · Base RPC" : "Source-reported creator · GoPlus"}</p><a href={`https://basescan.org/address/${creator.address}`} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex min-h-11 max-w-full items-center gap-2 break-all font-mono text-xs underline underline-offset-4">{creator.address}<ArrowUpRight className="shrink-0" size={12} aria-hidden="true" /></a>{directCreation && <div className="mt-3 border-t border-border pt-3"><h3 className="text-xs font-medium">Creation proof · block {creator.attribution.blockNumber}</h3><Citations ids={creator.attribution.evidenceIds} onReveal={onReveal} /></div>}<dl className="mt-3 grid grid-cols-2 gap-4 border-y border-border py-4"><div><dt className="text-xs text-muted">Pinned token balance</dt><dd className="mt-2 font-mono text-sm">{holding?.status === "verified" && holding.balanceRaw !== null ? tokenAmount(holding.balanceRaw, report.token.decimals) : "Unknown"}</dd></div><div><dt className="text-xs text-muted">Share of total supply</dt><dd className="mt-2 font-mono text-sm">{share ? supplyShare(share.amountRaw, share.totalSupplyRaw) : "Unknown"}</dd></div></dl>{holding && <p className="mt-3 font-mono text-[10px] text-muted">Finalized block {holding.block.number} · balance {holding.status.replace("_", " ")}</p>}<div className="mt-4 space-y-3">{proof.map((entry) => <div key={entry.label}><h3 className="text-xs font-medium">{entry.label}: {entry.ids.length} retained records</h3>{entry.ids.length > 0 ? <Citations ids={entry.ids} onReveal={onReveal} /> : <p className="mt-1 text-[11px] leading-6 text-muted">No record retained in this scan; earlier activity remains unknown.</p>}</div>)}</div><p className="mt-4 text-[11px] leading-6 text-muted">{creator.qualification}</p><a href={creator.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex min-h-11 items-center gap-2 text-[11px] underline underline-offset-4">Creator source<ArrowUpRight size={11} aria-hidden="true" /></a><p className="font-mono text-[10px] text-muted">Checked {creator.checkedAt}</p></div> : <p className="p-5 text-xs leading-6 text-muted">No creation transaction or usable source-reported creator was retained for this scan.</p>}
    <dl className="divide-y divide-border border-t border-border"><div className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3 text-xs"><dt className="text-muted">Contract creation transaction</dt><dd>{directCreation ? <a href={creator!.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 underline underline-offset-4">Verified at block {creator!.attribution.blockNumber}<ArrowUpRight size={11} aria-hidden="true" /></a> : "Not assessed"}</dd></div>{["Earlier deployments", "Lifetime creator history"].map((label) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3 text-xs"><dt className="text-muted">{label}</dt><dd>Not assessed</dd></div>)}</dl>
  </InvestigationPanel>;
}
