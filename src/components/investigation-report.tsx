"use client";

import { InvestigationPanel } from "./investigation-panel";
import { canonicalFindingClaim } from "@/domain/investigations/explanation-grounding";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Clock3, Copy, ExternalLink, GitBranch, Hexagon, Layers, Network, RotateCcw, ScanLine, Terminal, Users } from "lucide-react";
import type { Address, EvidenceRecord, ExplainedInvestigationReport, InvestigationReport } from "@/domain/investigations/types";
import { normalizeTokenWebsite } from "@/domain/investigations/token-web-presence";
import { assessInvestigationReport } from "@/domain/investigations/report-assessment";
import { derivePrimaryAssessment } from "@/domain/investigations/primary-assessment";
import { deriveHolderTableDistribution } from "@/domain/investigations/holder-table-distribution";
import { deriveHolderPopulationBreakdown } from "@/domain/investigations/holder-population";
import { deriveInvestigationLeads, type InvestigationLead } from "@/domain/investigations/investigation-leads";
import { InvestigationChat } from "./investigation-chat";
import { InvestigationBubbleGraph } from "./investigation-bubble-graph";
import { InvestigationClusters, InvestigationContract, InvestigationDeployerDNA, InvestigationRuleBreakdown, InvestigationScoreGauge, InvestigationVerdictScore } from "./investigation-verdict";
import { InvestigationExclusions } from "./investigation-exclusions";
import { InvestigationTimeMachine } from "./investigation-time-machine";
import { InvestigationExitCheck } from "./investigation-exit-check";
import { InvestigationDatasets } from "./investigation-datasets";
import { readableCoverageNotes } from "./investigation-dataset-facts";

import { InvestigationMarketSummary } from "./investigation-market-summary";
import { InvestigationShare } from "./investigation-share";
import { InvestigationIndependentChecks, InvestigationSwarmAssessment, SwarmSourceTime } from "./investigation-swarm-assessment";
import { deriveSwarmGraphView, formatSwarmShare, swarmHolderFlags } from "./investigation-swarm-graph-source";
import { compactHoldingShare, supplyShare, tokenAmount } from "./investigation-amounts";
import { buildWalletDisplayFacts, type WalletDisplayFacts } from "./investigation-wallet-facts";
import { InvestigationWalletFlags } from "./investigation-wallet-flags";
import { buildSaleDisplayProofs, retainedFundingRecords, type SaleDisplayProof } from "./investigation-evidence-facts";
import { fundingSearchCounts as fundingCounts, goalCardFinding, reportParticipants } from "./investigation-report-facts";
import { BentoGrid, BentoGridItem } from "./ui/bento-grid";
import { GlowingEffect } from "./ui/glowing-effect";

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const time = (seconds: number) => `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(seconds * 1000))} UTC`;
const displayAmount = (raw: string, decimals: number | null) => decimals === null ? "Amount unavailable" : tokenAmount(raw, decimals);
const readableSentence = (value: string) => canonicalFindingClaim({ explanation: value.replace(/0x[0-9a-fA-F]{64}/g, "transaction reference") })
  .replace(/0x[0-9a-fA-F]{40}/g, short)
  .replace(/All balanceRaw values are null/g, "Current balances were not checked")
  .replace(/pinned balanceOf calls/g, "balance checks at the report time");
const panel = "relative isolate min-w-0 rounded-xl border border-border bg-surface/95";
const eyebrow = "font-mono text-[10px] font-medium tracking-[0.16em] text-muted";
const categoryNames = ["all", "funding", "connections", "accumulation", "selling", "coverage"] as const;
type Category = typeof categoryNames[number];
function EvidenceLinks({ ids, onReveal }: { ids: string[]; onReveal: (id: string) => void }) {
  return <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">{ids.map((id, index) => <a key={id} href={`#evidence-${encodeURIComponent(id)}`} onClick={() => onReveal(id)} className="inline-flex min-h-11 items-center gap-1 font-mono text-[11px] text-foreground/80 underline decoration-border underline-offset-4 hover:text-accent">Evidence {index + 1}<ArrowUpRight size={11} aria-hidden="true" /></a>)}</div>;
}
function PanelTitle({ icon, eyebrow: label, title, id, children }: { icon: ReactNode; eyebrow: string; title: string; id: string; children?: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><p className={eyebrow}>{label}</p><h2 id={id} className="mt-2 flex items-center gap-2 text-base font-medium tracking-tight text-foreground"><span className="text-accent">{icon}</span>{title}</h2></div>{children}</div>;
}

function TokenWebsiteSummary({ report }: { report: InvestigationReport }) {
  const primary = derivePrimaryAssessment(report);
  if (primary.authority === "swarm") return <div className="flex flex-wrap items-center gap-x-4 text-xs text-muted"><a href={primary.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-foreground underline decoration-border underline-offset-4">SWARM source<ArrowUpRight size={11} aria-hidden="true" /></a><a href={`https://base.blockscout.com/token/${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-foreground underline decoration-border underline-offset-4">Explorer<ArrowUpRight size={11} aria-hidden="true" /></a></div>;
  const presence = report.token.webPresence;
  const market = report.token.marketSnapshot;
  const pair = market?.status === "reported" && market.pairAddress && /^0x[0-9a-fA-F]{40}$/.test(market.pairAddress) ? market.pairAddress : null;
  const urls = presence?.status === "reported" ? presence.websites.flatMap((website) => { const url = normalizeTokenWebsite(website.url); return url ? [url] : []; }) : [];
  return <div className="flex flex-wrap items-center gap-x-4 text-xs text-muted">{urls.length ? <>{urls.map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 max-w-full items-center gap-2 break-all text-foreground underline decoration-border underline-offset-4"><ExternalLink size={13} aria-hidden="true" />{new URL(url).hostname}</a>)}<span className="text-[10px]">Source-reported · ownership unverified</span></> : <span className="inline-flex min-h-11 items-center">{!presence ? "Website not checked" : presence.status === "unavailable" ? "Website unavailable" : "Website not found in source"}</span>}<a href={`https://base.blockscout.com/token/${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-foreground underline decoration-border underline-offset-4">Explorer<ArrowUpRight size={11} aria-hidden="true" /></a>{pair && <a href={`https://dexscreener.com/base/${pair}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-foreground underline decoration-border underline-offset-4">DEX Screener<ArrowUpRight size={11} aria-hidden="true" /></a>}</div>;
}

function HumanExplanation({ report, onReveal }: { report: ExplainedInvestigationReport; onReveal: (id: string) => void }) {
  const explanation = report.explanation;
  const primary = derivePrimaryAssessment(report);
  const generatedText = explanation.summary?.grounding?.mode === "source-grounded-prose" ? explanation.summary.text : undefined;
  const incomplete = report.coverage.transfers !== "complete" || report.coverage.funding.some((item) => item.status !== "complete")
    || !report.holderSnapshot || report.holderSnapshot.balances.status !== "complete";
  return <InvestigationPanel aria-labelledby="explanation-title" className={panel}>
    <div className="px-5 pt-4"><h2 id="explanation-title" className="text-sm font-medium">{generatedText ? "AI explanation" : "Report assessment"}</h2></div>
    <div className="space-y-4 p-5">
      <div data-testid={explanation.summary ? "plain-language-summary" : undefined}>
        <p className="text-2xl font-semibold tracking-tight">{explanation.summary?.action ?? (primary.verdict === "INSUFFICIENT" ? "Not enough information" : primary.verdict)}</p>
        {generatedText ? <p data-testid="ai-summary-text" className="mt-3 text-sm leading-7 text-foreground">{generatedText}</p> : explanation.summary && <ul className="mt-3 space-y-3">{explanation.summary.reasons.map((reason) => <li key={reason.id}><p className="text-sm leading-6 text-foreground">{reason.reason}</p><p className="mt-1 text-sm leading-6 text-muted">{reason.meaning}</p>{reason.evidenceIds.length > 0 && <EvidenceLinks ids={reason.evidenceIds} onReveal={onReveal} />}</li>)}</ul>}
        <p className="mt-3 text-xs text-muted">{primary.authority === "swarm" ? primary.status === "reported" ? "Based on SWARM’s reported assessment. TraceForge’s independent evidence is shown separately." : "SWARM’s assessment is unavailable. Independent TraceForge evidence does not replace the missing verdict." : "Based on TraceForge’s checked evidence and assessment."}</p>
        <p className="mt-2 text-xs leading-6 text-muted">{incomplete ? "Some independent blockchain checks are incomplete; missing information remains unknown." : "Independent blockchain checks describe this scan and are available below."}</p>
      </div>
      <details className="border-t border-border" data-explanation-support="true"><summary className="min-h-11 cursor-pointer content-center text-xs text-muted">Supporting evidence</summary>
        {explanation.observations.length > 0 ? <ul className="space-y-4 pb-3">{explanation.observations.map((observation, index) => <li key={`${observation.category}-${index}`} className="min-w-0"><h3 className="text-xs font-medium capitalize">{observation.category}</h3><p className="mt-1 text-sm leading-6 text-foreground/90">{readableSentence(observation.claim)}</p><p className="mt-1 text-xs leading-6 text-muted">{readableSentence(observation.caveat)}</p><EvidenceLinks ids={observation.evidenceIds} onReveal={onReveal} /></li>)}</ul> : <><p className="py-3 text-xs leading-6 text-muted">{readableSentence(explanation.overview.text)}</p><div className="pb-3"><EvidenceLinks ids={explanation.overview.evidenceIds} onReveal={onReveal} /></div></>}
      </details>
      <details className="border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-xs text-muted">What was checked</summary>
        <p className="pb-3 text-xs leading-6 text-muted">{primary.authority === "swarm" ? "AI explains SWARM’s reported assessment and the separately supplied TraceForge findings. The two sources retain their own observation times and coverage." : "TraceForge checks blockchain balances, funding and transaction relationships. AI explains the supplied findings."}</p>
        {explanation.summary?.limitations.map((limit) => <p key={limit} className="pb-2 text-xs leading-6 text-muted">{limit}</p>)}
      </details>
    </div>
  </InvestigationPanel>;
}
function InvestigationLeads({ report, onReveal }: { report: InvestigationReport; onReveal: (id: string) => void }) {
  const leads = useMemo(() => deriveInvestigationLeads(report), [report]);
  if (!leads.length) return null;
  const item = (lead: InvestigationLead) => <li key={lead.id} className="min-w-0 border-t border-border py-3">
    <h4 className="text-sm font-medium text-foreground">{lead.title}</h4>
    <p className="mt-1 break-words text-xs leading-6 text-foreground/90">{lead.observed}</p>
    <details><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">{lead.evidenceIds.length ? `Wallets and proof (${lead.evidenceIds.length} records)` : "Wallet and search coverage · no transaction proof"}</summary>
      <p className="mb-3 text-xs leading-6 text-muted"><span className="font-medium text-foreground">Next check: </span>{lead.nextCheck}</p>
      <ul className="space-y-1">{lead.wallets.map((wallet) => <li key={wallet} className="break-all font-mono text-[11px] leading-6">{wallet}</li>)}</ul>
      <p className="mt-2 text-[11px] leading-6 text-muted">{lead.limitation}</p>
      {lead.sourceUrl && <a href={lead.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center text-xs underline underline-offset-4">GoPlus-reported creator source<ArrowUpRight size={11} aria-hidden="true" /></a>}
      {lead.evidenceIds.length > 0 && <EvidenceLinks ids={lead.evidenceIds} onReveal={onReveal} />}
    </details>
  </li>;
  return <details className="border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-xs font-medium text-foreground">Investigative leads ({leads.length})</summary>
    <p className="pb-2 text-xs leading-6 text-muted">Suggested checks; not yet performed.</p>
    <ol aria-label="Priority investigative leads">{leads.slice(0, 3).map(item)}</ol>
    {leads.length > 3 && <details><summary className="min-h-11 cursor-pointer content-center text-xs text-muted">More leads ({leads.length - 3})</summary><ol aria-label="More investigative leads">{leads.slice(3).map(item)}</ol></details>}
  </details>;
}

function ExplanationPending({ pending, sourcePrimary = false }: { pending: boolean; sourcePrimary?: boolean }) {
  return <InvestigationPanel aria-labelledby="pending-explanation-title" className={panel}>
    <PanelTitle icon={<Terminal size={15} aria-hidden="true" />} eyebrow="AI INTERPRETATION" title="AI explanation" id="pending-explanation-title" />
    <p role={pending ? "status" : undefined} className="p-5 text-xs leading-6 text-muted">{pending ? sourcePrimary ? "The source assessment and independent evidence are ready for AI review." : "Verified analysis is ready. AI is reviewing the supported findings." : "This analysis is incomplete: the AI explanation was not produced."}</p>
  </InvestigationPanel>;
}

function ProviderContext({ report }: { report: InvestigationReport }) {
  const sources = report.providerEnrichment?.sources.filter((source) => source.candidates.length > 0) ?? [];
  if (!sources.length) return null;
  const verifiedBalances = new Set<string>(report.holderSnapshot?.holders.filter((holder) => holder.status === "verified").map((holder) => holder.address));
  return <InvestigationPanel aria-labelledby="provider-context-title" className={`${panel} p-5`}>
    <h2 id="provider-context-title" className="text-sm font-medium">Additional investigation leads</h2>
    <p className="mt-2 text-xs leading-6 text-muted">External services suggest addresses to examine. TraceForge checks their balances separately.</p>
    <ul className="mt-3 divide-y divide-border">{sources.map((source) => {
      const checked = source.candidates.filter((candidate) => verifiedBalances.has(candidate.address)).length;
      return <li key={source.provider} className="py-3" data-enrichment-provider={source.provider} data-enrichment-candidates={source.candidates.length} data-enrichment-balances-checked={checked}>
        <h3 className="text-sm font-medium">{source.provider === "bubblemaps" ? "Bubblemaps" : "Nansen"} <span className="font-normal text-muted">· source-reported leads</span></h3>
        <p className="mt-1 text-xs leading-6">{source.candidates.length} address {source.candidates.length === 1 ? "lead" : "leads"} supplied; {checked} {checked === 1 ? "balance" : "balances"} checked at the report time.</p>
        {source.coverage.limitReached && <p className="text-xs leading-6 text-muted">The source’s result limit was reached; more addresses may exist.</p>}
        {(source.relationships.length > 0 || source.candidates.some((candidate) => candidate.label)) && <p className="text-xs leading-6 text-muted">Reported labels and wallet links are leads. They do not establish a person’s identity or common ownership.</p>}
        <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center text-xs underline underline-offset-4">View source</a>
      </li>;
    })}</ul>
  </InvestigationPanel>;
}

function CreationEvidenceDetails({ item }: { item: EvidenceRecord }) {
  if (!item.creation) return null;
  return <div className="mt-3 border-l-2 border-accent pl-3 text-xs leading-6"><p className="font-medium">Token creation verified</p><p className="mt-1 text-muted">Wallet {short(item.creation.creator)} deployed this token. This confirms the deploying address, not its owner’s identity or current control.</p></div>;
}

function SaleEvidenceDetails({ proof, decimals, onReveal }: { proof: SaleDisplayProof; decimals: number | null; onReveal: (id: string) => void }) {
  const event = proof.event, sale = event.sale!;
  return <section aria-label="Sale consideration proof" className="mt-4 border-t border-border pt-4 text-xs leading-6">
    <h4 className="font-medium">Supported sale · {sale.protocol === "uniswap-v2" ? "Uniswap v2" : "Uniswap v3"}</h4>
    <dl className="mt-2 space-y-2 text-muted">
      <div><dt>Trading pool</dt><dd className="font-mono">{short(sale.pool)}</dd></div>
      <div><dt>Tokens sent to the pool</dt><dd>{decimals === null ? "Amount unavailable" : displayAmount(event.amountRaw, decimals)}</dd></div>
      <div><dt>Payment</dt><dd>Received in the same transaction.</dd></div>
    </dl>
    <p className="mt-2 text-muted">The checked transfers support this sale. They do not establish a coordinated plan. The payment’s display amount was not checked.</p>
    <p className="mt-3 font-medium">Supporting transactions ({proof.supportingEvidence.length})</p>
    <EvidenceLinks ids={proof.supportingEvidence.map((record) => record.id)} onReveal={onReveal} />
  </section>;
}

function NativeFundingList({ report, onReveal }: { report: InvestigationReport; onReveal: (id: string) => void }) {
  const [limit, setLimit] = useState(10), funding = retainedFundingRecords(report);
  const counts = fundingCounts(report);
  return <InvestigationPanel aria-labelledby="native-funding-title" className={panel}>
    <PanelTitle icon={<ArrowDownRight size={15} aria-hidden="true" />} eyebrow="RETAINED NATIVE ETH / SEPARATE FUNDING WINDOWS" title="Native funding" id="native-funding-title"><span className="font-mono text-[10px] text-muted">{funding.length} RECORDS</span></PanelTitle>
    {funding.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-border text-muted"><tr>{["Funder", "Recipient", "Amount ETH", "Observed", "Proof"].map((label) => <th key={label} className="whitespace-nowrap px-5 py-3 font-normal">{label}</th>)}</tr></thead><tbody>{funding.slice(0, limit).map((record) => <tr key={record.id} className="border-b border-border last:border-0"><td className="px-5 font-mono" title={record.from}>{short(record.from)}</td><td className="px-5 font-mono" title={record.to}>{short(record.to)}</td><td className="whitespace-nowrap px-5 font-mono" title="ETH transferred">{displayAmount(record.amountRaw, 18)}</td><td className="whitespace-nowrap px-5 font-mono text-[10px]">{time(record.timestamp)}</td><td className="px-5"><EvidenceLinks ids={[record.id]} onReveal={onReveal} /></td></tr>)}</tbody></table></div> : <p className="px-5 py-4 text-xs leading-6 text-muted">No qualifying native funding record was retained. {counts.complete} searches were complete, {counts.partial} partial, {counts.unavailable} unavailable and {counts.not_examined} not examined. This does not establish an absence of funding.</p>}
    {limit < funding.length && <button type="button" onClick={() => setLimit((value) => value + 25)} className="mx-5 min-h-11 text-xs underline underline-offset-4">Show more funding records ({limit} of {funding.length})</button>}
    <p className="border-t border-border px-5 py-3 text-[11px] leading-6 text-muted">Retained top-level ETH transfers only. Funding windows can predate this token scan; these records do not establish lifetime-first funding or common ownership.</p>
  </InvestigationPanel>;
}

function WalletFlagsCell({ facts, onReveal }: { facts: WalletDisplayFacts; onReveal: (id: string) => void }) {
  return <td className="px-4 text-[11px]"><InvestigationWalletFlags facts={facts} onReveal={onReveal} /></td>;
}

function WalletEntryCell({ facts, onReveal }: { facts: WalletDisplayFacts; onReveal: (id: string) => void }) {
  const entry = facts.entry;
  return <td className="whitespace-nowrap px-4 text-[11px]">{entry ? <button type="button" onClick={() => onReveal(entry.evidenceIds[0])} title={`First retained token receipt: ${time(entry.timestamp)}. ${entry.kind === "buy" ? "Receipt-verified purchase." : entry.kind === "mint" ? "From the zero address." : "Token transfer; purchase not established."}`} className="min-h-11 font-mono"><span className="border border-border px-2 py-1 text-[11px]">{entry.kind}</span></button> : <span className="text-muted" title="No investigated-token receipt was retained for this address.">—</span>}</td>;
}

function OtherHolderBalances({ title, rows, report, onSelect }: { title: "Contract holdings" | "Unclassified addresses"; rows: InvestigationReport["wallets"]; report: InvestigationReport; onSelect: (address: Address) => void }) {
  const [limit, setLimit] = useState(10);
  if (!rows.length) return null;
  const isContract = title === "Contract holdings";
  return <section aria-label={title} className="border-t border-border px-5 py-4">
    <h3 className="font-mono text-xs font-semibold">{title} · {rows.length}</h3>
    <p className="mt-2 text-[11px] leading-6 text-muted">{isContract ? "Contract balances remain in concentration and dump-risk checks. Contract code does not establish a pool, locker or owner." : "Account type was not verified at this block. These addresses are not treated as wallets or pools."}</p>
    <div role="region" aria-label={`${title} table`} tabIndex={0} className="mt-2 overflow-x-auto focus-visible:outline-accent"><table aria-label={title} className="w-full min-w-[24rem] text-left text-xs">
      <thead className="border-b border-border font-mono text-[9px] uppercase tracking-wider text-muted"><tr><th className="py-3 font-normal">Address</th><th className="px-3 text-right font-normal">Supply</th><th className="px-3 text-right font-normal">Amount</th></tr></thead>
      <tbody>{rows.slice(0, limit).map((holder) => <tr key={holder.address} className="border-b border-border last:border-0"><td><button type="button" onClick={() => onSelect(holder.address)} title={holder.address} className="min-h-11 font-mono text-xs font-semibold">{short(holder.address)}</button></td><td className="whitespace-nowrap px-3 text-right font-mono" title="Share of pinned total supply; not the wallet table's Float.">{supplyShare(holder.balanceRaw, report.holderSnapshot?.totalSupplyRaw ?? null) ?? "—"}</td><td className="whitespace-nowrap px-3 text-right font-mono text-[10px]" title="Checked token balance" data-balance-raw={holder.balanceRaw ?? undefined}>{displayAmount(holder.balanceRaw!, report.token.decimals)}</td></tr>)}</tbody>
    </table></div>
    {limit < rows.length && <button type="button" onClick={() => setLimit((value) => value + 25)} className="mt-3 min-h-11 text-xs text-muted underline underline-offset-4">Show more {isContract ? "contracts" : "addresses"} ({limit} of {rows.length})</button>}
  </section>;
}

function SwarmHolderSnapshotView({ report, onSelect }: { report: InvestigationReport; onSelect: (address: Address) => void }) {
  const [limit, setLimit] = useState(25);
  const view = deriveSwarmGraphView(report);
  return <InvestigationPanel aria-label="SWARM top holders" className={panel} data-holder-source="swarm">
    <PanelTitle icon={<Users size={15} aria-hidden="true" />} eyebrow="SWARM REPORTED DISTRIBUTION" title="Top holders" id="swarm-holders-title">{view && <span className="font-mono text-xs text-muted">{view.holders.length} reported</span>}</PanelTitle>
    {!view ? <p className="p-5 text-sm leading-6 text-muted">SWARM’s holder rows are unavailable for this request. Independent blockchain observations appear separately below.</p> : <>
      <div className="space-y-2 border-b border-border px-5 py-3 text-xs leading-6 text-muted"><p>The same SWARM holder cohort and reported float percentages as the graph. These are source reports, not independently verified balances.</p><SwarmSourceTime snapshot={view.source} /></div>
      <div role="region" aria-label="SWARM holder table" tabIndex={0} className="overflow-x-auto px-3 focus-visible:outline-accent"><table aria-label="SWARM top holders" className="w-full min-w-[40rem] text-left text-xs"><thead className="border-b border-border font-mono text-[9px] uppercase tracking-wider text-muted"><tr>{["#", "Wallet", "Float", "Entry", "Txs", "Flags", "Group"].map((label) => <th key={label} className={label === "Float" || label === "Txs" ? "whitespace-nowrap px-3 py-4 text-right font-normal" : "whitespace-nowrap px-3 py-4 font-normal"}>{label}</th>)}</tr></thead><tbody>{view.holders.slice(0, limit).map((holder, index) => {
        const flags = swarmHolderFlags(holder);
        return <tr key={holder.address} data-source-holder-address={holder.address} data-source-share={holder.share ?? undefined} className="border-b border-border last:border-0"><td className="px-3 font-mono text-xs text-muted">{index + 1}</td><td className="px-3"><button type="button" onClick={() => onSelect(holder.address)} title={holder.address} aria-label={`Select SWARM holder ${short(holder.address)}`} className="min-h-11 whitespace-nowrap font-mono text-[13px] font-semibold">{short(holder.address)}</button></td><td className="whitespace-nowrap px-3 text-right font-mono text-[13px] font-semibold">{formatSwarmShare(holder.share)}</td><td className="px-3 text-xs">{holder.entryKind === null ? "Unknown" : <span className="inline-flex border border-border px-2 py-1">{holder.entryKind}</span>}</td><td className="px-3 text-right font-mono text-xs">{holder.transactionCount ?? "Unknown"}</td><td className="px-3"><span className="flex flex-wrap gap-1">{flags.length ? flags.map((flag) => <span key={flag} className="border border-border px-2 py-1 text-[10px]">{flag}</span>) : <span className="text-muted">—</span>}</span></td><td className="px-3 font-mono text-xs text-muted">{holder.clusterId === null ? "—" : `#${holder.clusterId}`}</td></tr>;
      })}</tbody></table>{view.holders.length === 0 && <p className="p-5 text-sm leading-6 text-muted">SWARM returned no holder rows. This is not proof of zero holders.</p>}</div>
      {limit < view.holders.length && <button type="button" onClick={() => setLimit((value) => value + 25)} className="mx-5 my-3 min-h-11 text-xs text-muted underline underline-offset-4">Show more holders ({limit} of {view.holders.length})</button>}
      <details className="border-t border-border px-5"><summary className="min-h-11 cursor-pointer content-center text-xs text-muted">Holder source and limits</summary><p className="pb-3 text-xs leading-6 text-muted">Entry, transaction counts, flags and group IDs are SWARM-reported. Group membership does not prove common ownership. Unknown values are not zero.{view.truncated ? " The source holder list reached its limit; additional holders may exist." : " This is the returned report cohort, not a verified holder census."}</p></details>
    </>}
  </InvestigationPanel>;
}

function HolderSnapshotView({ report, onSelect, onReveal }: { report: InvestigationReport; onSelect: (address: Address) => void; onReveal: (id: string) => void }) {
  const [limit, setLimit] = useState(25), snapshot = report.holderSnapshot;
  const facts = buildWalletDisplayFacts(report);
  if (!snapshot) return <InvestigationPanel aria-labelledby="holders-title" className={panel}><PanelTitle icon={<Users size={15} aria-hidden="true" />} eyebrow="PINNED BALANCES" title="Top holders" id="holders-title" /><p className="p-5 text-xs leading-6 text-muted">Not assessed. No pinned holder balances were acquired.</p></InvestigationPanel>;
  const distribution = deriveHolderTableDistribution(report);
  const contractShare = distribution.contractSupplySharePercent === null ? null
    : supplyShare(distribution.excludedContractBalanceRaw, snapshot.totalSupplyRaw);
  const holders = distribution.holders.map((wallet) => snapshot.holders.find((holder) => holder.address === wallet.address)!);
  const unread = snapshot.holders.filter((holder) => holder.status !== "verified");
  return <InvestigationPanel aria-labelledby="holders-title" className={panel} data-holding-denominator-raw={distribution.holdingDenominatorRaw ?? undefined}>
    <PanelTitle icon={<Users size={15} aria-hidden="true" />} eyebrow="WALLET DISTRIBUTION" title="Top holders" id="holders-title"><span className="font-mono text-[10px] text-muted">{holders.length} shown{distribution.holdingDenominatorLabel === "total supply" && <span className="ml-3 text-[9px] normal-case" title={distribution.definition}>Total supply</span>}</span></PanelTitle>
    <div className="border-b border-border px-5 py-3 text-[10px] leading-5 text-muted"><p>{deriveHolderPopulationBreakdown(report).label}{report.token.securitySnapshot?.status === "reported" && report.token.securitySnapshot.holderCount !== null ? report.token.securitySnapshot.holderCount === 0 && (holders.length + distribution.contractHolders.length + distribution.unclassifiedHolders.length) > 0 ? " · GoPlus count inconsistent" : ` · ${report.token.securitySnapshot.holderCount} source-reported total` : ""}.</p>
      {distribution.contractHolders.length > 0 && <p className="mt-1 text-foreground">{distribution.contractHolders.length} {distribution.contractHolders.length === 1 ? "contract holds" : "contracts hold"} {contractShare === null ? "a verified balance" : `${contractShare} of total supply`}. Shown below; excluded from this table’s {distribution.holdingDenominatorLabel === "float" ? "Float" : "wallet rows"}. Risk checks include these balances.</p>}
      {distribution.unclassifiedHolders.length > 0 && <p className="mt-1">{distribution.unclassifiedHolders.length} addresses have unverified account type; shown below. Wallet Float is unavailable.</p>}
      {distribution.unverifiedBalanceAddresses.length > 0 && <p className="mt-1">Float unavailable: {distribution.unverifiedBalanceAddresses.length} candidate balances unread.</p>}
      <p className="mt-1">Shares use {distribution.holdingDenominatorRaw === null ? "an unavailable denominator" : <span className="font-mono text-foreground" title="Supply used for these percentages" data-holding-denominator-raw={distribution.holdingDenominatorRaw}>{displayAmount(distribution.holdingDenominatorRaw, report.token.decimals)} {distribution.holdingDenominatorLabel}</span>} at <time dateTime={new Date(snapshot.block.timestamp * 1000).toISOString()}>{time(snapshot.block.timestamp)}</time>.</p></div>
    <div role="region" aria-label="Holder table" tabIndex={0} className="overflow-x-auto px-3 focus-visible:outline-accent"><table aria-label="Top holders" className="w-full min-w-[44rem] text-left text-xs">
      <thead className="border-b border-border font-mono text-[9px] uppercase tracking-wider text-muted"><tr>{["#", "Wallet", distribution.holdingDenominatorLabel === "float" ? "Float" : "%", "Entry", "Txs", "Flags", "Swarm"].map((label) => <th key={label} className={label === "Float" || label === "%" || label === "Txs" ? "whitespace-nowrap px-3 py-4 text-right font-normal" : "whitespace-nowrap px-3 py-4 font-normal"} title={label === "Float" || label === "%" ? distribution.definition : label === "Txs" ? "Outgoing transaction count at the pinned block, when acquired." : undefined}>{label}</th>)}</tr></thead>
      <tbody>{holders.slice(0, limit).map((holder, index) => {
        const wallet = facts.get(holder.address)!;
        return <tr key={holder.address} className="border-b border-border last:border-0">
          <td className="px-3 font-mono text-xs text-muted">{index + 1}</td>
          <td className="px-3"><button type="button" onClick={() => onSelect(holder.address)} title={holder.address} data-balance-raw={holder.balanceRaw ?? undefined} className="min-h-11 whitespace-nowrap font-mono text-[13px] font-semibold">{short(holder.address)}</button></td>
          <td className="whitespace-nowrap px-3 text-right font-mono text-[13px] font-semibold" title={`${displayAmount(holder.balanceRaw!, report.token.decimals)} tokens at block ${snapshot.block.number}. ${distribution.definition}`}>{compactHoldingShare(holder.balanceRaw, distribution.holdingDenominatorRaw, true) ?? "—"}</td>
          <WalletEntryCell facts={wallet} onReveal={onReveal} />
          <td className="px-3 text-right font-mono text-[13px]" title={`Outgoing account nonce at pinned block ${snapshot.block.number}; incoming/internal transactions are not counted.`}>{wallet.outgoingTransactionCountRaw ?? "—"}</td>
          <WalletFlagsCell facts={wallet} onReveal={onReveal} />
          <td className="whitespace-nowrap px-3 font-mono text-xs text-muted" title="Evidence-linked swarm; common ownership is not established.">{wallet.groups.length ? wallet.groups.map((group) => `#${group}`).join(", ") : "—"}</td>
        </tr>;
      })}</tbody>
    </table>{!holders.length && <p className="p-5 text-xs leading-6 text-muted">No verified wallet rows. Other retained addresses appear below.</p>}</div>
    {limit < holders.length && <button type="button" onClick={() => setLimit((value) => value + 25)} className="mx-5 my-3 min-h-11 text-xs text-muted underline underline-offset-4">Show more candidates ({limit} of {holders.length})</button>}
    <OtherHolderBalances title="Contract holdings" rows={distribution.contractHolders} report={report} onSelect={onSelect} />
    <OtherHolderBalances title="Unclassified addresses" rows={distribution.unclassifiedHolders} report={report} onSelect={onSelect} />
    {unread.length > 0 && <details className="border-t border-border px-5"><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">Unread balances ({unread.length})</summary><ul className="divide-y divide-border pb-3">{unread.map((holder) => <li key={holder.address} className="flex flex-wrap items-center justify-between gap-x-3"><button type="button" onClick={() => onSelect(holder.address)} title={holder.address} className="min-h-11 font-mono text-[11px]">{short(holder.address)}</button><span className="border border-border px-2 py-1 font-mono text-[10px]">unread</span></li>)}</ul></details>}
    <details className="border-t border-border px-5"><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">Holder data sources and limits</summary><div className="space-y-2 pb-5 text-xs leading-6 text-muted">
      <p>{snapshot.balances.verifiedWallets} of {snapshot.balances.requestedWallets} candidate balances were checked at the report time. {snapshot.discovery.status !== "complete" ? "Holder discovery is incomplete; additional holders may exist." : "Discovery covered the requested source query."}</p>
      <p>Wallet percentages exclude verified pools, burn addresses and separately listed contract holdings when that supply can be established. Otherwise they use total supply.</p>
      <p>Entry is the first token receipt found in this scan. Txs counts outgoing transactions. Click a flag to see its supporting evidence.</p>
    </div></details>
  </InvestigationPanel>;
}
function emptyFinding(category: Category, report: InvestigationReport): string {
  if (category === "accumulation" && report.coverage.transfers !== "complete") return `Early-window accumulation was not assessed because transfer coverage is ${report.coverage.transfers.replace("_", " ")}. Missing transfers could change the result.`;
  if (category === "selling") return "No linked-selling finding was established from retained evidence. Unsupported routes and unobserved sales remain unclassified; this does not rule out selling or coordination.";
  if (category === "funding") return "No qualifying native funding record was retained for this finding view. Funding outside the examined wallets, blocks and top-level transfers remains unknown.";
  if (category === "connections") return "No eligible relationship was established from retained evidence. Missing or excluded relationships remain unknown.";
  return "No finding in this category was established from the retained evidence. Check coverage before interpreting absence.";
}

function KeyFindings({ report, onInspect }: { report: InvestigationReport; onInspect: (category: Category) => void }) {
  const categories = [{ category: "funding", title: "Who funded?", icon: <ArrowDownRight size={16} aria-hidden="true" /> }, { category: "connections", title: "Wallet links", icon: <Network size={16} aria-hidden="true" /> }, { category: "accumulation", title: "Early accumulation", icon: <Clock3 size={16} aria-hidden="true" /> }, { category: "selling", title: "Linked selling", icon: <Activity size={16} aria-hidden="true" /> }] as const;
  return <section aria-label="Key findings"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className={eyebrow}>THE TOKEN STORY / FOUR LINES OF INQUIRY</p><span className="font-mono text-[9px] text-muted">EVIDENCE FIRST</span></div><BentoGrid className="max-w-none gap-4 sm:grid-cols-2 md:auto-rows-auto md:grid-cols-2 xl:grid-cols-4">{categories.map(({ category, title, icon }, index) => {
    const { findings, finding, observation, reviewed, ambiguous } = goalCardFinding(report, category), unassessed = category === "accumulation" && report.coverage.transfers !== "complete";
    const sourceSummary = observation?.claim ?? finding?.explanation;
    const summary = sourceSummary ? readableSentence(sourceSummary) : undefined;
    const concise = summary && summary.length > 240 ? `${summary.slice(0, 237).trimEnd()}…` : summary;
    return <BentoGridItem key={category} className="relative min-w-0 justify-start space-y-0 border-border bg-surface p-5 shadow-none hover:shadow-none dark:border-border dark:bg-surface" icon={null}
      header={<div className="mb-5 flex items-center justify-between"><GlowingEffect disabled={false} blur={0} spread={40} proximity={32} /><span className="flex size-10 items-center justify-center rounded-lg border border-accent/20 bg-accent/5 text-accent">{icon}</span><span className="font-mono text-[10px] text-muted">0{index + 1} / {unassessed ? "UNASSESSED" : findings.length ? "OBSERVED" : "OPEN"}</span></div>}
      title={<h2 className="text-base font-medium tracking-tight text-foreground">{title}</h2>}
      description={<div className="flex flex-col"><p className="mt-2 text-[13px] font-medium leading-6 text-foreground">{unassessed ? "Not assessed" : ambiguous ? "Observed relationships" : finding?.title ?? "Not established"}</p><p className="mt-2 text-[13px] leading-6 text-muted">{concise ?? (unassessed ? "Transfer history is incomplete." : category === "selling" ? "Unsupported routes remain unknown." : "Evidence is limited to this scan.")}</p>{observation && <p className="mt-2 text-xs leading-6 text-muted">{readableSentence(observation.caveat)}</p>}{concise && <p className="mt-2 text-[10px] leading-5 text-muted">{observation ? reviewed ? "AI-reviewed finding · inspect cited evidence" : "AI interpretation · inspect cited findings" : `${findings.length} evidence-backed ${findings.length === 1 ? "finding" : "findings"}`}</p>}<button type="button" onClick={() => onInspect(category)} className="mt-4 inline-flex min-h-11 items-center justify-between gap-3 border-t border-border pt-3 text-[11px] text-accent">Inspect findings<ArrowUpRight size={13} aria-hidden="true" /></button></div>} />;
  })}</BentoGrid></section>;
}

function ReportReferences({ report, onInspectEvidence }: { report: InvestigationReport; onInspectEvidence: () => void }) {
  const dex = report.token.marketSnapshot ?? report.token.webPresence, security = report.token.securitySnapshot;
  const dexSource = dex && normalizeTokenWebsite(dex.sourceUrl), transactions = new Set(report.evidence.map((item) => item.transactionHash)).size;
  const linkClass = "inline-flex min-h-11 items-center gap-2 text-xs font-medium underline decoration-border underline-offset-4";
  return <InvestigationPanel aria-labelledby="references-title" className={panel}>
    <PanelTitle icon={<ExternalLink size={15} aria-hidden="true" />} eyebrow="SOURCES / PROOF" title="References" id="references-title" />
    <ul className="grid gap-5 p-5 sm:grid-cols-2">
      {report.swarmAssessment && <li className="min-w-0"><a href={report.swarmAssessment.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>SWARM assessment<ArrowUpRight size={12} aria-hidden="true" /></a><p className="text-xs leading-6 text-muted">Source-reported score, verdict, market context and wallet cohort.</p><SwarmSourceTime snapshot={report.swarmAssessment} /></li>}
      <li className="min-w-0"><a href={`https://basescan.org/token/${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>BaseScan token<ArrowUpRight size={12} aria-hidden="true" /></a><p className="text-[11px] leading-6 text-muted">Token explorer and contract reference.</p></li>
      {dex && dexSource && <li className="min-w-0"><a href={dexSource} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>DEX Screener metadata<ArrowUpRight size={12} aria-hidden="true" /></a><p className="text-[11px] leading-6 text-muted">Source-reported market and listing metadata; separate from transaction proof.</p><p className="mt-1 font-mono text-[9px] leading-5 text-muted">{dex.status.replace("_", " ")} · checked <time dateTime={dex.checkedAt}>{dex.checkedAt}</time></p></li>}
      {security && <li className="min-w-0"><a href={`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>GoPlus holder and contract context<ArrowUpRight size={12} aria-hidden="true" /></a><p className="text-[11px] leading-6 text-muted">Source-reported holder count and flags; not a contract audit.</p><p className="mt-1 font-mono text-[9px] leading-5 text-muted">{security.status.replace("_", " ")} · checked <time dateTime={security.checkedAt}>{security.checkedAt}</time></p></li>}
      <li className="min-w-0">{transactions > 0 ? <a href="#evidence-title" onClick={(event) => { event.preventDefault(); onInspectEvidence(); }} className={linkClass}>Transaction evidence ({transactions} transactions)<ArrowDownRight size={12} aria-hidden="true" /></a> : <p className="py-3 text-xs font-medium">No transaction evidence retained</p>}<p className="text-[11px] leading-6 text-muted">Read the checked transfers and open their original transactions in the explorer.</p></li>
    </ul>
  </InvestigationPanel>;
}

function hasExplanation(report: InvestigationReport): report is ExplainedInvestigationReport { return report.explanation !== undefined; }

export function InvestigationReportView({ report, chatContext, onFreshScan, pendingExplanation = false }: { report: InvestigationReport; chatContext?: string; onFreshScan: () => void; pendingExplanation?: boolean }) {
  const [selected, setSelected] = useState<Address | null>(null), [evidenceLimit, setEvidenceLimit] = useState(25), [category, setCategory] = useState<Category>("all"), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState("");
  const [investigationDetailsOpen, setInvestigationDetailsOpen] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false), [evidenceOpen, setEvidenceOpen] = useState(false), [walletLimit, setWalletLimit] = useState(10);
  const [highlightedEvidence, setHighlightedEvidence] = useState<{ id: string } | null>(null);
  const [sourceSelected, setSourceSelected] = useState<Address | null>(null);
  useEffect(() => {
    if (!highlightedEvidence) return;
    const target = document.getElementById(`evidence-${highlightedEvidence.id}`);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: "instant" });
    const timeout = setTimeout(() => setHighlightedEvidence(null), 4000);
    return () => clearTimeout(timeout);
  }, [highlightedEvidence]);
  const evidence = report.evidence.filter((item) => !selected || item.from === selected || item.to === selected);
  const saleProofs = buildSaleDisplayProofs(report);
  const filteredFindings = report.findings.filter((finding) => category === "all" || finding.category === category);
  const assessment = assessInvestigationReport(report);
  const primary = derivePrimaryAssessment(report);
  const sourcePrimary = primary.authority === "swarm";
  const displayVerdict = primary.status === "unavailable" ? "Unavailable" : primary.verdict;
  const displayName = primary.status === "reported" ? primary.snapshot.header.name ?? report.token.name : report.token.name;
  const displaySymbol = primary.status === "reported" ? primary.snapshot.header.symbol ?? report.token.symbol : report.token.symbol;
  const completed = hasExplanation(report) ? report : null;
  const participants = reportParticipants(report);
  function revealEvidence(id: string) {
    if (!report.evidence.some((item) => item.id === id)) return;
    setSelected(null); setEvidenceOpen(true); setEvidenceLimit(report.evidence.length);
    setHighlightedEvidence({ id });
  }
  function inspectFindings(value: Category) { setInvestigationDetailsOpen(true); setCategory(value); setFindingsOpen(true); requestAnimationFrame(() => document.getElementById("findings-title")?.scrollIntoView({ block: "start" })); }
  function inspectDatasets() { setInvestigationDetailsOpen(true); requestAnimationFrame(() => { const target = document.getElementById("dataset-comparison-title"); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "start", behavior: "instant" }); }); }
  async function copyAddress() { try { await navigator.clipboard.writeText(report.token.address); setCopied(true); setCopyError(""); } catch { setCopyError("Copy unavailable. Select the token address to copy it."); } }
  return <div className="traceforce-report grid min-w-0 gap-4 text-foreground wrap-anywhere">
    <InvestigationPanel aria-labelledby="token-identity-title" className="traceforce-token-header overflow-hidden p-5">
      <div className="flex flex-wrap items-center justify-between gap-5 border-b border-border pb-5"><div><p className="text-3xl font-bold tracking-[-0.04em] sm:text-[38px]">TraceForge / Report</p>{sourcePrimary && <p className="mt-2 text-xs text-muted">Primary assessment · SWARM</p>}</div><dl className="flex flex-wrap gap-6 font-mono"><div><dt className="text-[9px] uppercase tracking-wider text-muted">{sourcePrimary ? "SWARM report time" : "Checked at"}</dt><dd className="mt-1 text-sm font-medium">{primary.dataThrough ? <time dateTime={primary.dataThrough}>{time(Date.parse(primary.dataThrough) / 1000)}</time> : "Unavailable"}</dd></div><div><dt className="text-[9px] uppercase tracking-wider text-muted">{sourcePrimary ? "Holders reported" : "Addresses discovered"}</dt><dd className="mt-1 text-xl font-semibold">{primary.status === "reported" ? primary.snapshot.header.holders_count ?? "—" : sourcePrimary ? "Unavailable" : participants.discovered}</dd></div><div><dt className="text-[9px] uppercase tracking-wider text-muted">Verdict</dt><dd className="mt-1 text-lg font-semibold" data-primary-verdict={displayVerdict}>{displayVerdict}</dd></div></dl></div>
      <ol aria-label="Investigation workflow" className="flex flex-wrap gap-2 py-3 font-mono text-[10px] uppercase tracking-wider text-muted">{["Resolve", "Acquire", "Trace", "Link", "Review", "Verdict"].map((step, index) => <li key={step} className="flex items-center gap-2">{index > 0 && <span aria-hidden="true">›</span>}<span className={index === 5 ? "bg-accent px-1.5 py-0.5 text-on-accent" : undefined}>{step}</span></li>)}</ol>
      <div className="flex flex-wrap items-center justify-between gap-4"><div className="flex min-w-0 items-start gap-4"><div className="flex size-14 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/5 text-accent"><Hexagon size={25} strokeWidth={1} aria-hidden="true" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-x-3 gap-y-2"><h2 id="token-identity-title" className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">{displayName ?? "Unnamed token"}</h2>{displaySymbol && <span className="font-mono text-sm text-muted">${displaySymbol}</span>}<span className="border border-border px-2 py-1 font-mono text-[10px] text-muted">base</span><span className="border border-accent/30 bg-accent/10 px-2.5 py-1.5 font-mono text-[10px] font-semibold tracking-wider text-accent">{primary.status === "unavailable" ? "Unavailable" : primary.band}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-3"><p className="font-mono text-xs text-muted" title={report.token.address}>{short(report.token.address)}</p><button type="button" onClick={copyAddress} className="inline-flex min-h-11 items-center gap-1 text-[10px] text-muted hover:text-foreground" aria-label="Copy token contract address"><Copy size={12} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button><TokenWebsiteSummary report={report} /></div></div></div><button type="button" onClick={onFreshScan} className="engine-button shrink-0 font-mono text-xs"><RotateCcw size={13} aria-hidden="true" />fresh scan</button></div>
      {copyError && <p role="status" className="px-5 pb-3 text-xs text-muted">{copyError}</p>}
      {primary.status === "unavailable" ? <div role="status" aria-label="SWARM assessment status" data-primary-source-status="unavailable" data-source-unavailable-reason={report.swarmAvailability?.reason ?? "unavailable"} className="mt-4 border-t border-border pt-3 text-sm leading-6"><p className="font-medium">SWARM assessment unavailable</p><p className="mt-1 text-muted">{primary.unavailableReason}</p><p className="mt-1 text-muted">Independent blockchain checks are shown below.</p></div> : sourcePrimary ? <p className="mt-3 text-xs leading-6 text-muted">SWARM supplies the main score, verdict, category points and reported market context. Independent blockchain checks follow below.</p> : <p className="mt-3 text-xs leading-6 text-muted">On-chain snapshot: <time dateTime={new Date(report.range.to.timestamp * 1000).toISOString()} className="font-mono text-foreground">{time(report.range.to.timestamp)}</time>. Balances and transaction counts use this observation time. Market listings may be newer.</p>}
    </InvestigationPanel>
    {completed ? <HumanExplanation report={completed} onReveal={revealEvidence} /> : <ExplanationPending pending={pendingExplanation} sourcePrimary={sourcePrimary} />}
    <InvestigationMarketSummary report={report} />

    <div className="traceforce-report-overview grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      <div className="traceforce-primary-column grid min-w-0 gap-4">
        <InvestigationBubbleGraph report={report} onReveal={revealEvidence} onCompareDatasets={inspectDatasets} exportReady={completed !== null} selected={sourcePrimary ? sourceSelected : selected} onSelect={(address) => { if (sourcePrimary) { setSourceSelected(address); return; } setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} />
        {!sourcePrimary && <HolderSnapshotView report={report} onReveal={revealEvidence} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} />}
      </div>
      <aside className={sourcePrimary ? "grid min-w-0 gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1" : "grid min-w-0 gap-4"}><InvestigationScoreGauge assessment={assessment} report={report} /><InvestigationVerdictScore assessment={assessment} report={report} onReveal={revealEvidence} /><InvestigationRuleBreakdown assessment={assessment} report={report} onReveal={revealEvidence} /></aside>
      {sourcePrimary && <div className="min-w-0 lg:col-start-1"><SwarmHolderSnapshotView report={report} onSelect={setSourceSelected} /></div>}
    </div>

    {completed && <div className="traceforce-council grid min-w-0"><InvestigationChat report={completed} context={chatContext} onReveal={revealEvidence} onFreshScan={onFreshScan} /></div>}
    {sourcePrimary && <><InvestigationIndependentChecks report={report} assessment={assessment} /><details className={panel} data-independent-holder-details="true"><summary className="min-h-14 cursor-pointer content-center px-5 text-sm font-medium">Independent blockchain graph and holders</summary><div className="grid min-w-0 gap-4 border-t border-border p-4"><p className="text-xs leading-6 text-muted">TraceForge observations at <time dateTime={new Date(report.range.to.timestamp * 1000).toISOString()}>{time(report.range.to.timestamp)}</time>. This candidate cohort is separate from SWARM’s reported holders.</p><InvestigationBubbleGraph sourceMode="local" report={report} onReveal={revealEvidence} onCompareDatasets={inspectDatasets} exportReady={completed !== null} selected={selected} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} /><HolderSnapshotView report={report} onReveal={revealEvidence} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} /></div></details></>}
    {!sourcePrimary && report.swarmAssessment && <InvestigationSwarmAssessment snapshot={report.swarmAssessment} assessment={assessment} />}
    <details open={investigationDetailsOpen} onToggle={(event) => setInvestigationDetailsOpen(event.currentTarget.open)} className={panel} data-investigation-details="true"><summary className="min-h-14 cursor-pointer content-center px-5 text-sm font-medium">Investigation details</summary><div className="grid min-w-0 gap-4 border-t border-border p-4">
    {sourcePrimary && <p className="text-sm leading-6 text-muted">Independent TraceForge findings from this scan’s retained blockchain records. Their coverage and observation time are separate from SWARM’s assessment.</p>}
    <InvestigationTimeMachine report={report} />
    <InvestigationExitCheck report={report} />
    <ProviderContext report={report} />
    <div className="grid min-w-0 gap-4 lg:gap-6 lg:grid-cols-2"><InvestigationClusters report={report} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} onReveal={revealEvidence} /><InvestigationContract report={report} /></div>
    <InvestigationExclusions report={report} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} />
    <InvestigationDeployerDNA report={report} onReveal={revealEvidence} />
    <KeyFindings report={report} onInspect={inspectFindings} />
    <NativeFundingList report={report} onReveal={revealEvidence} />
    <InvestigationLeads report={report} onReveal={revealEvidence} />
    <InvestigationDatasets report={report} />


    <details open={findingsOpen} onToggle={(event) => setFindingsOpen(event.currentTarget.open)} className={panel}><summary className="min-h-14 cursor-pointer content-center px-5 text-xs font-medium">All findings ({report.findings.length})</summary><section aria-labelledby="findings-title" className="border-t border-border"><PanelTitle icon={<ScanLine size={15} aria-hidden="true" />} eyebrow="DETERMINISTIC ANALYSIS / CITED OBSERVATIONS" title="Findings and their limits" id="findings-title"><label className="flex min-h-11 items-center gap-3 text-xs text-muted" htmlFor="finding-category">Show<select id="finding-category" aria-label="Finding category" className="min-h-11 border border-border bg-background px-3 text-xs capitalize text-foreground" value={category} onChange={(event) => setCategory(event.target.value as Category)}>{categoryNames.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></PanelTitle><div className="grid gap-px bg-border md:grid-cols-2">{filteredFindings.length ? filteredFindings.map((finding) => <article key={finding.id} className="min-w-0 bg-surface p-5"><p className={`${eyebrow} uppercase`}>{finding.category} / {finding.confidence} confidence</p><h3 className="mt-3 text-sm font-medium">{finding.title}</h3><p className="mt-3 text-xs leading-6 text-muted">{readableSentence(finding.explanation)}</p><ul className="mt-3 space-y-2 text-[11px] leading-6 text-muted">{finding.limitations.map((limit) => <li key={limit}>— {readableSentence(limit)}</li>)}</ul><EvidenceLinks ids={finding.evidenceIds} onReveal={revealEvidence} /></article>) : <p className="bg-surface p-6 text-sm leading-7 text-muted md:col-span-2">{emptyFinding(category, report)}</p>}</div></section></details>

    <InvestigationPanel aria-labelledby="wallet-activity-title" className={panel}><PanelTitle icon={<Users size={15} aria-hidden="true" />} eyebrow="DISCOVERED ADDRESSES / WINDOW ACTIVITY" title="Wallet activity" id="wallet-activity-title"><span className="font-mono text-[10px] text-muted">{report.wallets.length} ADDRESSES</span></PanelTitle><p className="px-5 py-4 text-xs leading-6 text-muted">Observed window activity · {report.token.decimals === null ? "display amounts unavailable" : "token units; … marks truncated precision"}. Current holdings are unknown. Sales cover supported routes only; 0 does not establish no selling.</p><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-y border-border bg-background font-mono text-[9px] uppercase tracking-wider text-muted"><tr>{["Wallet", "Observed inflow", "Observed outflow", "Observed net", "Supported sales", "Early window", report.holderSnapshot ? "Pinned balance" : "Current balance"].map((label) => <th key={label} className="whitespace-nowrap px-5 py-4 font-normal">{label}</th>)}</tr></thead><tbody>{report.wallets.slice(0, walletLimit).map((wallet, index) => <tr key={wallet.address} className="border-b border-border last:border-0 hover:bg-background"><td className="px-5 py-2"><button className="inline-flex min-h-11 shrink-0 items-center gap-3 whitespace-nowrap font-mono text-xs text-foreground" onClick={() => { setSelected(wallet.address); setEvidenceLimit(25); setEvidenceOpen(true); }}><span className="text-[9px] text-muted">{String(index + 1).padStart(2, "0")}</span>{short(wallet.address)}</button></td>{[wallet.observedIncomingRaw, wallet.observedOutgoingRaw, wallet.observedNetRaw, wallet.verifiedSoldRaw].map((amount, cell) => <td key={cell} data-amount-raw={amount} title="Observed token amount" className="whitespace-nowrap px-5 font-mono text-[11px] text-foreground/80"><span aria-label={`${report.token.decimals === null ? "Amount unavailable" : displayAmount(amount, report.token.decimals)} tokens`}>{displayAmount(amount, report.token.decimals)}</span></td>)}<td className="whitespace-nowrap px-5 text-[11px] text-muted">{report.coverage.transfers !== "complete" || wallet.earlyAccumulator === null ? "Not assessed" : wallet.earlyAccumulator ? "Observed accumulation" : "Not established"}</td><td className="whitespace-nowrap px-5 font-mono text-[11px] text-muted" aria-label={wallet.balanceRaw !== null && report.holderSnapshot ? `Pinned balance ${displayAmount(wallet.balanceRaw, report.token.decimals)}` : "Current balance unknown"}>{wallet.balanceRaw !== null && report.holderSnapshot ? displayAmount(wallet.balanceRaw, report.token.decimals) : "—"}</td></tr>)}</tbody></table>{!report.wallets.length && <p className="p-5 text-sm leading-7 text-muted">No eligible wallet activity was retained. Unexamined activity remains unknown.</p>}</div>{walletLimit < report.wallets.length && <button type="button" onClick={() => setWalletLimit((value) => value + 25)} className="mx-5 my-3 min-h-11 text-xs text-muted underline underline-offset-4">Show more addresses ({walletLimit} of {report.wallets.length})</button>}</InvestigationPanel>

    <details className={panel}><summary className="min-h-14 cursor-pointer content-center px-5 text-xs font-medium">Timeline and retained connections</summary><div className="grid min-w-0 gap-5 border-t border-border xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><InvestigationPanel aria-labelledby="timeline-title" className={panel}><PanelTitle icon={<Clock3 size={15} aria-hidden="true" />} eyebrow="CHRONOLOGY / RULE-BASED FINDINGS" title="Finding timeline" id="timeline-title" /><ol className="space-y-0 p-5">{report.story.map((event, index) => <li key={event.id} className="relative border-l border-border pb-6 pl-5 last:pb-0"><span className="absolute -left-[4px] top-1 size-[7px] rounded-full border border-muted bg-background" aria-hidden="true" /><p className="font-mono text-[10px] text-muted">{String(index + 1).padStart(2, "0")} / {time(event.timestamp)}</p><h3 className="mt-3 text-sm font-medium">{event.title}</h3><p className="mt-2 text-xs leading-6 text-muted">{readableSentence(event.description)}</p><EvidenceLinks ids={event.evidenceIds} onReveal={revealEvidence} /></li>)}</ol>{!report.story.length && <p className="px-5 pb-5 text-sm leading-7 text-muted">No eligible finding events were produced. Transaction evidence may still contain activity.</p>}</InvestigationPanel><InvestigationPanel aria-labelledby="connections-title" className={panel}><PanelTitle icon={<GitBranch size={15} aria-hidden="true" />} eyebrow="RETAINED RELATIONSHIPS / OWNERSHIP UNKNOWN" title="All retained connections" id="connections-title"><span className="font-mono text-[10px] text-muted">{report.connections.length} EDGES</span></PanelTitle><p className="px-5 py-4 text-xs leading-6 text-muted">Only qualifying observed edges are listed. Missing data and excluded infrastructure can hide other relationships.</p><ul className="divide-y divide-border">{report.connections.map((edge) => <li key={edge.id} className="px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><span className="font-mono text-xs">{short(edge.from)} → {short(edge.to)}</span><span className="border border-border px-2 py-1 font-mono text-[9px] uppercase text-muted">{edge.kind}</span></div><p className="mt-2 font-mono text-[10px] text-muted">{time(edge.timestamp)}</p><EvidenceLinks ids={edge.evidenceIds} onReveal={revealEvidence} /></li>)}</ul>{!report.connections.length && <p className="px-5 pb-5 text-sm leading-7 text-muted">No eligible connection was established from retained data. This does not establish that the wallets are unrelated.</p>}</InvestigationPanel></div></details>

    </div></details>
    <details open={evidenceOpen} onToggle={(event) => setEvidenceOpen(event.currentTarget.open)} className={panel}>
      <summary className="min-h-14 cursor-pointer content-center px-5 text-sm font-medium">Transaction evidence ({report.evidence.length})</summary>
      <section aria-labelledby="evidence-title" className="border-t border-border">
        <PanelTitle icon={<Layers size={15} aria-hidden="true" />} eyebrow={sourcePrimary ? "INDEPENDENT TRACEFORGE TRANSACTIONS" : "CHECKED TRANSACTIONS"} title={`Transaction evidence${selected ? ` / ${short(selected)}` : ""}`} id="evidence-title" />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3"><p className="text-xs leading-6 text-muted">Showing {Math.min(evidenceLimit, evidence.length)} of {evidence.length} matching records.</p>{selected && <button type="button" className="min-h-11 text-xs underline underline-offset-4" onClick={() => setSelected(null)}>Clear address filter</button>}</div>
        <div className="divide-y divide-border">{evidence.slice(0, evidenceLimit).map((item) => <article key={item.id} id={`evidence-${item.id}`} tabIndex={-1} data-evidence-highlighted={highlightedEvidence?.id === item.id ? "true" : undefined} className="traceforce-evidence-record scroll-mt-24 min-w-0 p-5 focus-visible:outline-accent">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-medium">{item.kind === "funding" ? "Wallet funding" : item.kind === "sale" ? "Verified sale" : "Token transfer"}</h3><time className="text-xs text-muted" dateTime={new Date(item.timestamp * 1000).toISOString()}>{time(item.timestamp)}</time></div>
          <p className="mt-2 text-sm leading-7">{item.kind === "funding" ? `${short(item.from)} sent ${displayAmount(item.amountRaw, 18)} ETH to ${short(item.to)}.` : item.from === `0x${"0".repeat(40)}` ? `New tokens were issued to ${short(item.to)}.` : `${short(item.from)} sent tokens to ${short(item.to)}.`}</p>
          {item.creation && <CreationEvidenceDetails item={item} />}
          {saleProofs.has(item.id) && <SaleEvidenceDetails proof={saleProofs.get(item.id)!} decimals={report.token.decimals} onReveal={revealEvidence} />}
          <a href={`https://base.blockscout.com/tx/${item.transactionHash}`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center gap-2 text-xs underline underline-offset-4">Inspect transaction<ArrowUpRight size={12} aria-hidden="true" /></a>
        </article>)}</div>
        {!evidence.length && <p className="p-5 text-sm leading-7 text-muted">No matching transaction was retained in this scan.</p>}
        {evidenceLimit < evidence.length && <button type="button" className="m-5 min-h-11 border border-border px-5 text-xs hover:bg-background" onClick={() => setEvidenceLimit((value) => value + 25)}>Show 25 more records</button>}
      </section>
    </details>
    <details className={`${panel} px-5`} data-report-checks="true"><summary className="min-h-14 cursor-pointer content-center text-sm font-medium">What was checked</summary>
      <div className="space-y-3 border-t border-border py-4 text-sm leading-6 text-muted">
        <p>{report.holderSnapshot ? `${report.holderSnapshot.balances.verifiedWallets} of ${report.holderSnapshot.balances.requestedWallets} candidate balances were checked.` : "Current holder balances could not be checked."}</p>
        <p>{report.coverage.transfers === "complete" ? "The requested token transfer history was checked." : "Some requested transaction history could not be read. Missing transactions can change the findings."}</p>
        <p>Funding was examined for {report.coverage.examinedWallets} of {report.coverage.eligibleWallets} eligible addresses.</p>
        <p>{fundingCounts(report).complete} complete · {fundingCounts(report).partial} partial · {fundingCounts(report).unavailable} unavailable · {fundingCounts(report).not_examined} not checked.</p>
        <p>Blockchain observations end at <time dateTime={new Date(report.range.to.timestamp * 1000).toISOString()}>{time(report.range.to.timestamp)}</time>. Market listings and external checks have their own update times.</p>
        <p>This report describes public addresses and transactions. It cannot identify the people behind the wallets.</p>
        {readableCoverageNotes(report).length > 0 && <div><p className="font-medium text-foreground">Limits that affect this report</p><ul className="mt-2 list-disc space-y-2 pl-5">{readableCoverageNotes(report).map((note) => <li key={note}>{note}</li>)}</ul></div>}
      </div>
    </details>    <ReportReferences report={report} onInspectEvidence={() => { setSelected(null); setEvidenceLimit(25); setEvidenceOpen(true); requestAnimationFrame(() => { const first = report.evidence[0]; if (first) document.getElementById(`evidence-${first.id}`)?.focus(); }); }} />
    {completed && <InvestigationShare report={completed} />}
    <a href="#investigation-form" className="inline-flex min-h-11 items-center gap-2 font-mono text-xs text-muted hover:text-foreground">Run another fresh investigation<ArrowUpRight size={13} aria-hidden="true" /></a>
  </div>;
}
