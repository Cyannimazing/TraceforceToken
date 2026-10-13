"use client";

import { InvestigationPanel } from "./investigation-panel";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Clock3, Copy, ExternalLink, GitBranch, Hexagon, Layers, Network, RotateCcw, ScanLine, Terminal, Users } from "lucide-react";
import type { Address, EvidenceRecord, ExplainedInvestigationReport, InvestigationReport } from "@/domain/investigations/types";
import { normalizeTokenWebsite } from "@/domain/investigations/token-web-presence";
import { assessInvestigationReport } from "@/domain/investigations/report-assessment";
import { deriveHolderTableDistribution } from "@/domain/investigations/holder-table-distribution";
import { deriveHolderPopulationBreakdown } from "@/domain/investigations/holder-population";
import { deriveInvestigationLeads, type InvestigationLead } from "@/domain/investigations/investigation-leads";
import { InvestigationChat } from "./investigation-chat";
import { InvestigationBubbleGraph } from "./investigation-bubble-graph";
import { InvestigationClusters, InvestigationContract, InvestigationDeployerDNA, InvestigationRuleBreakdown, InvestigationScoreGauge, InvestigationVerdictScore, reportReviewLabel } from "./investigation-verdict";
import { InvestigationExclusions } from "./investigation-exclusions";
import { InvestigationTimeMachine } from "./investigation-time-machine";
import { InvestigationDatasets } from "./investigation-datasets";
import { InvestigationMarketSummary } from "./investigation-market-summary";
import { InvestigationShare } from "./investigation-share";
import { compactHoldingShare, supplyShare, tokenAmount } from "./investigation-amounts";
import { buildWalletDisplayFacts, type WalletDisplayFacts } from "./investigation-wallet-facts";
import { InvestigationWalletFlags } from "./investigation-wallet-flags";
import { buildSaleDisplayProofs, retainedFundingRecords, type SaleDisplayProof } from "./investigation-evidence-facts";
import { coveragePercentage, fundingSearchCounts as fundingCounts, goalCardFinding, reportParticipants } from "./investigation-report-facts";
import { BentoGrid, BentoGridItem } from "./ui/bento-grid";
import { GlowingEffect } from "./ui/glowing-effect";

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const time = (seconds: number) => new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
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
  const presence = report.token.webPresence;
  const market = report.token.marketSnapshot;
  const pair = market?.status === "reported" && market.pairAddress && /^0x[0-9a-fA-F]{40}$/.test(market.pairAddress) ? market.pairAddress : null;
  const urls = presence?.status === "reported" ? presence.websites.flatMap((website) => { const url = normalizeTokenWebsite(website.url); return url ? [url] : []; }) : [];
  return <div className="flex flex-wrap items-center gap-x-4 text-xs text-muted">{urls.length ? <>{urls.map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 max-w-full items-center gap-2 break-all text-foreground underline decoration-border underline-offset-4"><ExternalLink size={13} aria-hidden="true" />{new URL(url).hostname}</a>)}<span className="text-[10px]">Source-reported · ownership unverified</span></> : <span className="inline-flex min-h-11 items-center">{!presence ? "Website not checked" : presence.status === "unavailable" ? "Website unavailable" : "Website not found in source"}</span>}<a href={`https://base.blockscout.com/token/${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-foreground underline decoration-border underline-offset-4">Explorer<ArrowUpRight size={11} aria-hidden="true" /></a>{pair && <a href={`https://dexscreener.com/base/${pair}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-foreground underline decoration-border underline-offset-4">DEX Screener<ArrowUpRight size={11} aria-hidden="true" /></a>}</div>;
}

function TokenWebPresence({ report }: { report: InvestigationReport }) {
  const presence = report.token.webPresence;
  if (!presence) return <p className="text-xs leading-6 text-muted">Website metadata was not checked for this snapshot.</p>;
  const source = normalizeTokenWebsite(presence.sourceUrl);
  return <section aria-labelledby="token-website-title" className="border-t border-border px-5 py-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="token-website-title" className={eyebrow}>Token website</h3><span className="font-mono text-[9px] tracking-wider text-muted">OWNERSHIP UNVERIFIED</span></div>
    {presence.status === "reported" ? <><ul className="mt-2 flex flex-wrap gap-x-4">{presence.websites.map((website) => { const url = normalizeTokenWebsite(website.url); return <li key={website.url} className="min-w-0">{url ? <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 max-w-full items-center gap-2 break-all font-mono text-xs text-foreground">{url}<ExternalLink size={12} aria-hidden="true" /></a> : <p className="text-xs leading-6 text-muted">This source link could not be displayed safely.</p>}<details><summary className="min-h-11 cursor-pointer content-center font-mono text-[10px] text-muted">Source pair references ({website.pairAddresses.length})</summary><ul className="mb-2 space-y-1">{website.pairAddresses.map((pair) => <li key={pair} className="break-all font-mono text-[10px] leading-5 text-muted">{pair}</li>)}</ul></details></li>; })}</ul><p className="mt-2 text-xs leading-6 text-muted">A listing does not verify who controls the website or the token.</p></> : <p className="mt-3 text-xs leading-6 text-muted">{presence.status === "not_listed" ? "No usable website link was included from the matched source data. This does not establish that the token has no website." : "Website metadata was unavailable. The token's website is unknown in this report."}</p>}
    <p className="mt-2 break-words font-mono text-[10px] leading-5 text-muted">{source ? <a href={source} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center underline underline-offset-4">DEX Screener token-pair metadata</a> : "DEX Screener token-pair metadata"} / {presence.matchedPairs} matched pairs / checked <time dateTime={presence.checkedAt}>{presence.checkedAt}</time></p>
    {presence.reason && <p className="mt-2 text-xs leading-6 text-muted">{presence.reason}</p>}
  </section>;
}

function HumanExplanation({ report, onReveal }: { report: ExplainedInvestigationReport; onReveal: (id: string) => void }) {
  const explanation = report.explanation;
  const reviewed = explanation.grounding?.mode === "canonical-finding-selection";
  return <InvestigationPanel aria-labelledby="explanation-title" className={panel}>
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4"><h2 id="judge-output-title" className="font-mono text-xs font-semibold"><span aria-hidden="true" className="text-muted">{"// "}</span>Report summary</h2><span className="text-[11px] text-muted">{reviewed ? "AI reviewed" : "AI summary"}</span></div>
    <div className="space-y-4 p-5">
      <h3 id="explanation-title" className="sr-only">{reviewed ? "AI-reviewed findings" : "Explanation in plain English"}</h3>
      <p className="text-sm leading-7 text-foreground/90">{explanation.overview.text}</p>
      <details className="border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-xs text-muted">Supporting observations ({explanation.observations.length})</summary>
        <div className="pb-3"><EvidenceLinks ids={explanation.overview.evidenceIds} onReveal={onReveal} /></div>
        <ul className="space-y-4 pb-3">{explanation.observations.map((observation, index) => <li key={`${observation.category}-${index}`} className="min-w-0"><h4 className={`${eyebrow} uppercase`}>{observation.category}</h4><p className="mt-1 text-sm leading-6 text-foreground/90">{observation.claim}</p><p className="mt-1 text-xs leading-6 text-muted">{observation.caveat}</p><EvidenceLinks ids={observation.evidenceIds} onReveal={onReveal} /></li>)}</ul>
      </details>
      <InvestigationLeads report={report} onReveal={onReveal} />
      <details className="border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-xs text-muted">Report details</summary>
      <dl aria-label="Engine and LLM roles" className="grid min-w-0 gap-3 border-y border-border py-3 text-xs leading-6 sm:grid-cols-2">
        <div className="min-w-0"><dt className="font-medium text-foreground">TraceForce Engine</dt><dd className="text-muted">Checks on-chain evidence and calculates balances, wallet links and rule-based flags.</dd></div>
        <div className="min-w-0"><dt className="break-words font-medium text-foreground">{explanation.model.startsWith("gemini/") ? "Gemini LLM" : "Local LLM"} · {explanation.model}</dt><dd className="text-muted">{reviewed ? "Reviews supplied findings and highlights uncertainty through supported caveats. Missing evidence stays unknown." : "Provides commentary on supplied evidence. Legacy commentary needs review against the cited facts."}</dd></div>
      </dl>
      <p className="py-3 text-[10px] leading-5 text-muted">{reviewed ? "The model selected canonical statements and caveats. Verify the cited evidence." : "AI interpretation · verify with cited evidence."}</p>
      <div className="border-t border-border pt-4"><h3 className={eyebrow}>AI review receipt</h3><dl aria-label="AI review receipt" className="mt-3 grid min-w-0 gap-x-6 gap-y-3 text-[11px] sm:grid-cols-2 lg:grid-cols-3">{[
        { label: "Model", value: explanation.model },
        { label: "Profile", value: `${explanation.profileId} / v${explanation.profileVersion}` },
        { label: "Grounding", value: reviewed ? "Canonical finding selection" : "Legacy AI commentary" },
        { label: "Evidence supplied", value: `${explanation.context.suppliedEvidence} of ${report.evidence.length} records` },
        { label: "Evidence omitted", value: `${explanation.context.omittedEvidence} records` },
      ].map((entry) => <div key={entry.label} className="min-w-0"><dt className="text-muted">{entry.label}</dt><dd className="mt-1 break-all font-mono text-[10px] leading-5">{entry.value}</dd></div>)}<div className="min-w-0"><dt className="text-muted">Generated</dt><dd className="mt-1 break-all font-mono text-[10px] leading-5"><time dateTime={explanation.generatedAt}>{explanation.generatedAt}</time></dd></div></dl><p className="mt-3 text-[11px] leading-6 text-muted">One model review covers the supplied evidence. Its generated time is separate from the finalized data-through time.</p></div>
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

function ExplanationPending({ pending }: { pending: boolean }) {
  return <InvestigationPanel aria-labelledby="pending-explanation-title" className={panel}>
    <PanelTitle icon={<Terminal size={15} aria-hidden="true" />} eyebrow="AI INTERPRETATION" title="AI explanation" id="pending-explanation-title" />
    <p role={pending ? "status" : undefined} className="p-5 text-xs leading-6 text-muted">{pending ? "Verified analysis is ready. AI is reviewing the supported findings." : "This analysis is incomplete: the AI explanation was not produced."}</p>
  </InvestigationPanel>;
}

function EvidenceAssessment({ report }: { report: InvestigationReport }) {
  const counts = fundingCounts(report), incomplete = report.coverage.transfers !== "complete" || counts.partial + counts.unavailable + counts.not_examined > 0 || (report.holderSnapshot !== undefined && (report.holderSnapshot.discovery.status !== "complete" || report.holderSnapshot.balances.status !== "complete"));
  const available = counts.complete + counts.partial, percentage = coveragePercentage(available, report.coverage.eligibleWallets);
  const snapshot = report.holderSnapshot, ranked = snapshot?.holders.filter((holder) => report.wallets.some((wallet) => wallet.address === holder.address) && holder.status === "verified" && holder.balanceRaw !== null).sort((a, b) => BigInt(a.balanceRaw!) > BigInt(b.balanceRaw!) ? -1 : BigInt(a.balanceRaw!) < BigInt(b.balanceRaw!) ? 1 : a.address.localeCompare(b.address));
  const topShare = snapshot && ranked?.length ? supplyShare(ranked.slice(0, 10).reduce((total, holder) => total + BigInt(holder.balanceRaw!), 0n).toString(), snapshot.totalSupplyRaw) : null;
  return <InvestigationPanel aria-labelledby="assessment-title" className={panel}><PanelTitle icon={<ScanLine size={15} aria-hidden="true" />} eyebrow="EVIDENCE ASSESSMENT" title={incomplete ? "Limited coverage" : "Bounded coverage"} id="assessment-title" /><div className="p-5"><div className="flex items-center gap-5"><div className="relative size-28 shrink-0"><svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="3" className="text-border" /><circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={`${(percentage ?? 0) / 100 * 314.159} 314.159`} className="text-foreground" /></svg><div className="absolute inset-0 flex flex-col items-center justify-center"><span className="font-mono text-2xl">{percentage === null ? "—" : `${percentage}%`}</span><span className="mt-1 font-mono text-[8px] tracking-wider text-muted">FUNDING SEARCHES</span></div></div><div><p className="text-xs leading-6 text-foreground">{available} of {report.coverage.eligibleWallets} funding searches examined</p><p className="mt-2 text-[11px] leading-6 text-muted">{counts.complete} complete · {counts.partial} partial<br />{counts.unavailable} unavailable · {counts.not_examined} not examined</p></div></div><dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs"><div><dt className="text-[10px] leading-5 text-muted">{snapshot ? "Verified balances" : "Retained evidence"}</dt><dd className="mt-2 font-mono text-lg">{snapshot ? snapshot.balances.verifiedWallets : report.evidence.length}</dd></div><div><dt className="text-[10px] leading-5 text-muted">{snapshot ? "Top 10 examined / supply" : "Findings"}</dt><dd className="mt-2 font-mono text-lg">{snapshot ? topShare ?? "—" : report.findings.length}</dd></div></dl></div></InvestigationPanel>;
}

function CreationEvidenceDetails({ item }: { item: EvidenceRecord }) {
  if (!item.creation) return null;
  return <div className="mt-3 border-l-2 border-accent pl-3 text-xs leading-6"><p className="font-medium">Verified direct contract deployment</p><p className="mt-1 break-all text-muted">Creator: <span className="font-mono text-foreground">{item.creation.creator}</span><br />Receipt created: <span className="font-mono text-foreground">{item.creation.contractAddress}</span></p><p className="mt-1 text-muted">The successful creation transaction has no destination and created this exact token. Its sender is the deploying address; present control and personal identity are not established.</p></div>;
}

function SaleEvidenceDetails({ proof, decimals, onReveal }: { proof: SaleDisplayProof; decimals: number | null; onReveal: (id: string) => void }) {
  const event = proof.event, sale = event.sale!;
  return <section aria-label="Sale consideration proof" className="mt-4 border-t border-border pt-4 text-xs leading-6">
    <h4 className="font-medium">Supported sale · {sale.protocol === "uniswap-v2" ? "Uniswap v2" : "Uniswap v3"}</h4>
    <dl className="mt-2 space-y-2 text-muted">
      <div><dt>Pool</dt><dd className="break-all font-mono">{sale.pool}</dd></div>
      <div><dt>Investigated token sent to pool</dt><dd>{tokenAmount(event.amountRaw, decimals)} token units <span className="break-all font-mono">({event.amountRaw} raw units)</span></dd></div>
      <div><dt>Quote received by seller</dt><dd className="break-all font-mono">{sale.quoteAmountRaw} raw units · {sale.quoteAsset}</dd></div>
      <div><dt>Authenticated factory</dt><dd className="break-all font-mono">{sale.factory}</dd></div>
    </dl>
    <p className="mt-2 text-muted">Quote decimals were not acquired. The retained same-transaction transfers support this direct route; they do not establish coordinated intent.</p>
    <p className="mt-3 font-medium">Complete supporting transfer proof ({proof.supportingEvidence.length})</p>
    <EvidenceLinks ids={proof.supportingEvidence.map((record) => record.id)} onReveal={onReveal} />
  </section>;
}

function NativeFundingList({ report, onReveal }: { report: InvestigationReport; onReveal: (id: string) => void }) {
  const [limit, setLimit] = useState(10), funding = retainedFundingRecords(report);
  const counts = fundingCounts(report);
  return <InvestigationPanel aria-labelledby="native-funding-title" className={panel}>
    <PanelTitle icon={<ArrowDownRight size={15} aria-hidden="true" />} eyebrow="RETAINED NATIVE ETH / SEPARATE FUNDING WINDOWS" title="Native funding" id="native-funding-title"><span className="font-mono text-[10px] text-muted">{funding.length} RECORDS</span></PanelTitle>
    {funding.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b border-border text-muted"><tr>{["Funder", "Recipient", "Amount ETH", "Observed", "Proof"].map((label) => <th key={label} className="whitespace-nowrap px-5 py-3 font-normal">{label}</th>)}</tr></thead><tbody>{funding.slice(0, limit).map((record) => <tr key={record.id} className="border-b border-border last:border-0"><td className="px-5 font-mono" title={record.from}>{short(record.from)}</td><td className="px-5 font-mono" title={record.to}>{short(record.to)}</td><td className="whitespace-nowrap px-5 font-mono" title={`${record.amountRaw} raw wei`}>{tokenAmount(record.amountRaw, 18)}</td><td className="whitespace-nowrap px-5 font-mono text-[10px]">{time(record.timestamp)}<br />Block {record.blockNumber}</td><td className="px-5"><EvidenceLinks ids={[record.id]} onReveal={onReveal} /></td></tr>)}</tbody></table></div> : <p className="px-5 py-4 text-xs leading-6 text-muted">No qualifying native funding record was retained. {counts.complete} searches were complete, {counts.partial} partial, {counts.unavailable} unavailable and {counts.not_examined} not examined. This does not establish an absence of funding.</p>}
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
      <tbody>{rows.slice(0, limit).map((holder) => <tr key={holder.address} className="border-b border-border last:border-0"><td><button type="button" onClick={() => onSelect(holder.address)} title={holder.address} className="min-h-11 font-mono text-xs font-semibold">{short(holder.address)}</button></td><td className="whitespace-nowrap px-3 text-right font-mono" title="Share of pinned total supply; not the wallet table's Float.">{supplyShare(holder.balanceRaw, report.holderSnapshot?.totalSupplyRaw ?? null) ?? "—"}</td><td className="whitespace-nowrap px-3 text-right font-mono text-[10px]" title={`Exact raw balance: ${holder.balanceRaw}`}>{tokenAmount(holder.balanceRaw!, report.token.decimals)}</td></tr>)}</tbody>
    </table></div>
    {limit < rows.length && <button type="button" onClick={() => setLimit((value) => value + 25)} className="mt-3 min-h-11 text-xs text-muted underline underline-offset-4">Show more {isContract ? "contracts" : "addresses"} ({limit} of {rows.length})</button>}
  </section>;
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
  return <InvestigationPanel aria-labelledby="holders-title" className={panel}>
    <PanelTitle icon={<Users size={15} aria-hidden="true" />} eyebrow={`BLOCK ${snapshot.block.number}`} title="Top holders" id="holders-title"><span className="font-mono text-[10px] text-muted">{holders.length} shown{distribution.holdingDenominatorLabel === "total supply" && <span className="ml-3 text-[9px] normal-case" title={distribution.definition}>Total supply</span>}</span></PanelTitle>
    <div className="border-b border-border px-5 py-3 text-[10px] leading-5 text-muted"><p>{deriveHolderPopulationBreakdown(report).label}{report.token.securitySnapshot?.status === "reported" && report.token.securitySnapshot.holderCount !== null ? report.token.securitySnapshot.holderCount === 0 && (holders.length + distribution.contractHolders.length + distribution.unclassifiedHolders.length) > 0 ? " · GoPlus count inconsistent" : ` · ${report.token.securitySnapshot.holderCount} source-reported total` : ""}.</p>
      {distribution.contractHolders.length > 0 && <p className="mt-1 text-foreground">{distribution.contractHolders.length} {distribution.contractHolders.length === 1 ? "contract holds" : "contracts hold"} {contractShare === null ? "a verified balance" : `${contractShare} of total supply`}. Shown below; excluded from this table’s {distribution.holdingDenominatorLabel === "float" ? "Float" : "wallet rows"}. Risk checks include these balances.</p>}
      {distribution.unclassifiedHolders.length > 0 && <p className="mt-1">{distribution.unclassifiedHolders.length} addresses have unverified account type; shown below. Wallet Float is unavailable.</p>}
      {distribution.unverifiedBalanceAddresses.length > 0 && <p className="mt-1">Float unavailable: {distribution.unverifiedBalanceAddresses.length} candidate balances unread.</p>}
      <p className="mt-1">Shares use {distribution.holdingDenominatorRaw === null ? "an unavailable denominator" : <span className="font-mono text-foreground" title={`Exact raw denominator: ${distribution.holdingDenominatorRaw}`}>{tokenAmount(distribution.holdingDenominatorRaw, report.token.decimals)} {distribution.holdingDenominatorLabel}</span>} at <time dateTime={new Date(snapshot.block.timestamp * 1000).toISOString()}>{time(snapshot.block.timestamp)}</time>.</p></div>
    <div role="region" aria-label="Holder table" tabIndex={0} className="overflow-x-auto px-3 focus-visible:outline-accent"><table aria-label="Top holders" className="w-full min-w-[44rem] text-left text-xs">
      <thead className="border-b border-border font-mono text-[9px] uppercase tracking-wider text-muted"><tr>{["#", "Wallet", distribution.holdingDenominatorLabel === "float" ? "Float" : "%", "Entry", "Txs", "Flags", "Swarm"].map((label) => <th key={label} className={label === "Float" || label === "%" || label === "Txs" ? "whitespace-nowrap px-3 py-4 text-right font-normal" : "whitespace-nowrap px-3 py-4 font-normal"} title={label === "Float" || label === "%" ? distribution.definition : label === "Txs" ? "Outgoing transaction count at the pinned block, when acquired." : undefined}>{label}</th>)}</tr></thead>
      <tbody>{holders.slice(0, limit).map((holder, index) => {
        const wallet = facts.get(holder.address)!;
        return <tr key={holder.address} className="border-b border-border last:border-0">
          <td className="px-3 font-mono text-xs text-muted">{index + 1}</td>
          <td className="px-3"><button type="button" onClick={() => onSelect(holder.address)} title={`${holder.address}\nPinned balance: ${holder.balanceRaw ?? "unknown"} raw units · ${holder.status.replace("_", " ")}\nFunding: ${wallet.fundingStatus.replace("_", " ")} · ${wallet.nativeFunders.length} retained funders`} className="min-h-11 whitespace-nowrap font-mono text-[13px] font-semibold">{short(holder.address)}</button></td>
          <td className="whitespace-nowrap px-3 text-right font-mono text-[13px] font-semibold" title={`${tokenAmount(holder.balanceRaw!, report.token.decimals)} tokens at block ${snapshot.block.number}. ${distribution.definition}`}>{compactHoldingShare(holder.balanceRaw, distribution.holdingDenominatorRaw, true) ?? "—"}</td>
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
      <p>{snapshot.balances.verifiedWallets} / {snapshot.balances.requestedWallets} candidate balances verified at block {snapshot.block.number}. {distribution.definition}</p>
      <p>{snapshot.discovery.reason ?? "Indexed candidates are merged with observed token participants."}</p>{snapshot.balances.reason && <p>{snapshot.balances.reason}</p>}
      <p className="break-all">{snapshot.discovery.provider} · {snapshot.discovery.addresses} indexed addresses · {snapshot.discovery.sourceUrl}</p>
      <p>{snapshot.provenance.provider}: {snapshot.provenance.method}<br />Retrieved: {snapshot.provenance.observedAt}</p>
      <p>Entry describes the first retained receipt. Txs is the outgoing account nonce at the pinned block; incoming and internal transactions are not counted. Click a flag to inspect its basis. Unexamined flags stay unknown.</p>
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
    const summary = (observation?.claim ?? finding?.explanation)?.replace(/0x[0-9a-fA-F]{40}/g, short);
    const concise = summary && summary.length > 240 ? `${summary.slice(0, 237).trimEnd()}…` : summary;
    return <BentoGridItem key={category} className="relative min-w-0 justify-start space-y-0 border-border bg-surface p-5 shadow-none hover:shadow-none dark:border-border dark:bg-surface" icon={null}
      header={<div className="mb-5 flex items-center justify-between"><GlowingEffect disabled={false} blur={0} spread={40} proximity={32} /><span className="flex size-10 items-center justify-center rounded-lg border border-accent/20 bg-accent/5 text-accent">{icon}</span><span className="font-mono text-[10px] text-muted">0{index + 1} / {unassessed ? "UNASSESSED" : findings.length ? "OBSERVED" : "OPEN"}</span></div>}
      title={<h2 className="text-base font-medium tracking-tight text-foreground">{title}</h2>}
      description={<div className="flex flex-col"><p className="mt-2 text-[13px] font-medium leading-6 text-foreground">{unassessed ? "Not assessed" : ambiguous ? "Observed relationships" : finding?.title ?? "Not established"}</p><p className="mt-2 text-[13px] leading-6 text-muted">{concise ?? (unassessed ? "Transfer history is incomplete." : category === "selling" ? "Unsupported routes remain unknown." : "Evidence is limited to this scan.")}</p>{observation && <p className="mt-2 text-xs leading-6 text-muted">{observation.caveat}</p>}{concise && <p className="mt-2 text-[10px] leading-5 text-muted">{observation ? reviewed ? "AI-reviewed finding · inspect cited evidence" : "AI interpretation · inspect cited findings" : `${findings.length} evidence-backed ${findings.length === 1 ? "finding" : "findings"}`}</p>}<button type="button" onClick={() => onInspect(category)} className="mt-4 inline-flex min-h-11 items-center justify-between gap-3 border-t border-border pt-3 text-[11px] text-accent">Inspect findings<ArrowUpRight size={13} aria-hidden="true" /></button></div>} />;
  })}</BentoGrid></section>;
}

function ExplanationAudit({ report }: { report: ExplainedInvestigationReport }) {
  const explanation = report.explanation;
  return <div className="mt-5 border-t border-border pt-5"><h3 className="text-xs font-medium text-foreground">Coverage of this explanation</h3><p className="mt-2 text-xs leading-6 text-muted">Transfer history is {report.coverage.transfers.replace("_", " ")}. Funding history was examined for {report.coverage.examinedWallets} of {report.coverage.eligibleWallets} eligible wallets. Token activity covers blocks {report.range.from.number} through {report.range.to.number}. Native funding has separate per-wallet limits; neither establishes lifetime activity or current balances.</p><p className="mt-2 text-xs leading-6 text-muted">The explanation used {explanation.context.suppliedEvidence} of {report.evidence.length} evidence records in this report; {explanation.context.omittedEvidence} were not supplied to the model.</p><ul className="mt-3 space-y-2 text-xs leading-6 text-muted">{explanation.limitations.map((limit) => <li key={limit}>— {limit}</li>)}</ul><dl className="mt-4 space-y-2 font-mono text-[10px] leading-5 text-muted"><div className="flex flex-wrap gap-x-3"><dt>PROFILE</dt><dd>{explanation.profileId} / v{explanation.profileVersion}</dd></div><div className="flex flex-wrap gap-x-3"><dt>MODEL</dt><dd className="break-all">{explanation.model}</dd></div><div className="flex flex-wrap gap-x-3"><dt>GENERATED</dt><dd><time dateTime={explanation.generatedAt}>{explanation.generatedAt}</time></dd></div></dl><p className="mt-3 text-xs leading-6 text-muted">AI commentary is non-authoritative. Cited evidence and coverage remain the basis for each finding.</p></div>;
}

function MarketAudit({ report }: { report: InvestigationReport }) {
  const market = report.token.marketSnapshot;
  if (!market) return null;
  const source = normalizeTokenWebsite(market.sourceUrl);
  return <div className="border-t border-border px-5 py-4 text-xs leading-6 text-muted"><h3 className="font-medium text-foreground">Market data source</h3><p className="mt-2">DEX Screener metadata is source-reported and approximate. All displayed market metrics refer to the same selected pair; pair age is not token launch age. These values are not pinned to the investigation block and are not proof of ownership or safety.</p><p className="mt-2 break-all">Selected pair: {market.pairAddress ?? "unknown"}<br />Checked: {market.checkedAt}</p>{source && <a href={source} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex min-h-11 items-center gap-2 underline underline-offset-4">Inspect source response<ExternalLink size={12} aria-hidden="true" /></a>}</div>;
}

function ReportReferences({ report, onInspectEvidence }: { report: InvestigationReport; onInspectEvidence: () => void }) {
  const dex = report.token.marketSnapshot ?? report.token.webPresence, security = report.token.securitySnapshot;
  const dexSource = dex && normalizeTokenWebsite(dex.sourceUrl), transactions = new Set(report.evidence.map((item) => item.transactionHash)).size;
  const linkClass = "inline-flex min-h-11 items-center gap-2 text-xs font-medium underline decoration-border underline-offset-4";
  return <InvestigationPanel aria-labelledby="references-title" className={panel}>
    <PanelTitle icon={<ExternalLink size={15} aria-hidden="true" />} eyebrow="SOURCES / PROOF" title="References" id="references-title" />
    <ul className="grid gap-5 p-5 sm:grid-cols-2">
      <li className="min-w-0"><a href={`https://basescan.org/token/${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>BaseScan token<ArrowUpRight size={12} aria-hidden="true" /></a><p className="text-[11px] leading-6 text-muted">Token explorer and contract reference.</p></li>
      {dex && dexSource && <li className="min-w-0"><a href={dexSource} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>DEX Screener metadata<ArrowUpRight size={12} aria-hidden="true" /></a><p className="text-[11px] leading-6 text-muted">Source-reported market and listing metadata; separate from transaction proof.</p><p className="mt-1 font-mono text-[9px] leading-5 text-muted">{dex.status.replace("_", " ")} · checked <time dateTime={dex.checkedAt}>{dex.checkedAt}</time></p></li>}
      {security && <li className="min-w-0"><a href={`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>GoPlus holder and contract context<ArrowUpRight size={12} aria-hidden="true" /></a><p className="text-[11px] leading-6 text-muted">Source-reported holder count and flags; not a contract audit.</p><p className="mt-1 font-mono text-[9px] leading-5 text-muted">{security.status.replace("_", " ")} · checked <time dateTime={security.checkedAt}>{security.checkedAt}</time></p></li>}
      <li className="min-w-0">{transactions > 0 ? <a href="#evidence-title" onClick={(event) => { event.preventDefault(); onInspectEvidence(); }} className={linkClass}>Transaction evidence ({transactions} transactions)<ArrowDownRight size={12} aria-hidden="true" /></a> : <p className="py-3 text-xs font-medium">No transaction evidence retained</p>}<p className="text-[11px] leading-6 text-muted">Retained records include block hashes, transaction hashes and acquisition source references. Inspect individual transactions in the evidence ledger; coverage remains bounded.</p></li>
    </ul>
  </InvestigationPanel>;
}

function hasExplanation(report: InvestigationReport): report is ExplainedInvestigationReport { return report.explanation !== undefined; }

export function InvestigationReportView({ report, chatContext, onFreshScan, pendingExplanation = false }: { report: InvestigationReport; chatContext?: string; onFreshScan: () => void; pendingExplanation?: boolean }) {
  const [selected, setSelected] = useState<Address | null>(null), [evidenceLimit, setEvidenceLimit] = useState(25), [category, setCategory] = useState<Category>("all"), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState("");
  const [findingsOpen, setFindingsOpen] = useState(false), [evidenceOpen, setEvidenceOpen] = useState(false), [walletLimit, setWalletLimit] = useState(10);
  const [highlightedEvidence, setHighlightedEvidence] = useState<{ id: string } | null>(null);
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
  const displayVerdict = reportReviewLabel(assessment);
  const completed = hasExplanation(report) ? report : null;
  const participants = reportParticipants(report);
  function revealEvidence(id: string) {
    if (!report.evidence.some((item) => item.id === id)) return;
    setSelected(null); setEvidenceOpen(true); setEvidenceLimit(report.evidence.length);
    setHighlightedEvidence({ id });
  }
  function inspectFindings(value: Category) { setCategory(value); setFindingsOpen(true); requestAnimationFrame(() => document.getElementById("findings-title")?.scrollIntoView({ block: "start" })); }
  async function copyAddress() { try { await navigator.clipboard.writeText(report.token.address); setCopied(true); setCopyError(""); } catch { setCopyError("Copy unavailable. Select the token address to copy it."); } }
  return <div className="traceforce-report grid min-w-0 gap-4 text-foreground wrap-anywhere">
    <InvestigationPanel aria-labelledby="token-identity-title" className="traceforce-token-header overflow-hidden p-5">
      <div className="flex flex-wrap items-center justify-between gap-5 border-b border-border pb-5"><p className="text-3xl font-bold tracking-[-0.04em] sm:text-[38px]">TRACEFORCE // REPORT</p><dl className="flex flex-wrap gap-6 font-mono"><div><dt className="text-[9px] uppercase tracking-wider text-muted">Finalized block</dt><dd className="mt-1 text-xl font-semibold">{report.range.to.number}</dd></div><div><dt className="text-[9px] uppercase tracking-wider text-muted">Addresses examined</dt><dd className="mt-1 text-xl font-semibold">{participants.discovered}</dd></div><div><dt className="text-[9px] uppercase tracking-wider text-muted">Verdict</dt><dd className="mt-1 text-lg font-semibold">{displayVerdict}</dd></div></dl></div>
      <ol aria-label="Investigation workflow" className="flex flex-wrap gap-2 py-3 font-mono text-[10px] uppercase tracking-wider text-muted">{["Resolve", "Acquire", "Trace", "Link", "Review", "Verdict"].map((step, index) => <li key={step} className="flex items-center gap-2">{index > 0 && <span aria-hidden="true">›</span>}<span className={index === 5 ? "bg-accent px-1.5 py-0.5 text-on-accent" : undefined}>{step}</span></li>)}</ol>
      <div className="flex flex-wrap items-center justify-between gap-4"><div className="flex min-w-0 items-start gap-4"><div className="flex size-14 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/5 text-accent"><Hexagon size={25} strokeWidth={1} aria-hidden="true" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-x-3 gap-y-2"><h2 id="token-identity-title" className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">{report.token.name ?? "Unnamed token"}</h2>{report.token.symbol && <span className="font-mono text-sm text-muted">${report.token.symbol}</span>}<span className="border border-border px-2 py-1 font-mono text-[10px] text-muted">base</span><span className="border border-accent/30 bg-accent/10 px-2.5 py-1.5 font-mono text-[10px] font-semibold tracking-wider text-accent">{assessment.band}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-3"><p className="break-all font-mono text-[10px] text-muted">{report.token.address}</p><button type="button" onClick={copyAddress} className="inline-flex min-h-11 items-center gap-1 text-[10px] text-muted hover:text-foreground" aria-label="Copy token contract address"><Copy size={12} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button><TokenWebsiteSummary report={report} /></div></div></div><button type="button" onClick={onFreshScan} className="engine-button shrink-0 font-mono text-xs"><RotateCcw size={13} aria-hidden="true" />fresh scan</button></div>
      {copyError && <p role="status" className="px-5 pb-3 text-xs text-muted">{copyError}</p>}
      <p className="mt-3 text-xs leading-6 text-muted">On-chain snapshot: <time dateTime={new Date(report.range.to.timestamp * 1000).toISOString()} className="font-mono text-foreground">{time(report.range.to.timestamp)}</time>. Balances and TXS use this finalized block; market and source metadata may be newer.</p>
    </InvestigationPanel>
    <InvestigationMarketSummary report={report} />
    {completed ? <HumanExplanation report={completed} onReveal={revealEvidence} /> : <ExplanationPending pending={pendingExplanation} />}

    <div className="traceforce-report-overview grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      <div className="traceforce-primary-column grid min-w-0 gap-4">
        <InvestigationBubbleGraph report={report} onReveal={revealEvidence} exportReady={completed !== null} selected={selected} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} />
        <HolderSnapshotView report={report} onReveal={revealEvidence} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} />
      </div>
      <aside className="grid min-w-0 gap-4"><InvestigationScoreGauge assessment={assessment} report={report} /><InvestigationVerdictScore assessment={assessment} report={report} onReveal={revealEvidence} /><InvestigationRuleBreakdown assessment={assessment} report={report} onReveal={revealEvidence} /></aside>
    </div>

    {completed && <div className="traceforce-council grid min-w-0"><InvestigationChat report={completed} context={chatContext} onReveal={revealEvidence} onFreshScan={onFreshScan} /></div>}
    <InvestigationTimeMachine report={report} />
    <div className="grid min-w-0 gap-4 lg:gap-6 lg:grid-cols-2"><InvestigationClusters report={report} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} onReveal={revealEvidence} /><InvestigationContract report={report} /></div>
    <InvestigationExclusions report={report} onSelect={(address) => { setSelected(address); setEvidenceLimit(25); setEvidenceOpen(true); }} />
    <InvestigationDeployerDNA report={report} onReveal={revealEvidence} />
    <KeyFindings report={report} onInspect={inspectFindings} />
    <NativeFundingList report={report} onReveal={revealEvidence} />
    <EvidenceAssessment report={report} />
    <InvestigationDatasets report={report} />

    <details open={findingsOpen} onToggle={(event) => setFindingsOpen(event.currentTarget.open)} className={panel}><summary className="min-h-14 cursor-pointer content-center px-5 text-xs font-medium">All findings ({report.findings.length})</summary><section aria-labelledby="findings-title" className="border-t border-border"><PanelTitle icon={<ScanLine size={15} aria-hidden="true" />} eyebrow="DETERMINISTIC ANALYSIS / CITED OBSERVATIONS" title="Findings and their limits" id="findings-title"><label className="flex min-h-11 items-center gap-3 text-xs text-muted" htmlFor="finding-category">Show<select id="finding-category" aria-label="Finding category" className="min-h-11 border border-border bg-background px-3 text-xs capitalize text-foreground" value={category} onChange={(event) => setCategory(event.target.value as Category)}>{categoryNames.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></PanelTitle><div className="grid gap-px bg-border md:grid-cols-2">{filteredFindings.length ? filteredFindings.map((finding) => <article key={finding.id} className="min-w-0 bg-surface p-5"><p className={`${eyebrow} uppercase`}>{finding.category} / {finding.confidence} confidence</p><h3 className="mt-3 text-sm font-medium">{finding.title}</h3><p className="mt-3 text-xs leading-6 text-muted">{finding.explanation}</p><ul className="mt-3 space-y-2 text-[11px] leading-6 text-muted">{finding.limitations.map((limit) => <li key={limit}>— {limit}</li>)}</ul><EvidenceLinks ids={finding.evidenceIds} onReveal={revealEvidence} /><details className="mt-2"><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">Rule parameters</summary><dl className="space-y-2 pb-3 font-mono text-[10px] text-muted">{Object.entries(finding.rule.parameters).map(([name, value]) => <div key={name}><dt>{name}</dt><dd className="break-all text-foreground">{String(value)}</dd></div>)}</dl></details><p className="mt-2 font-mono text-[9px] leading-5 text-muted">RULE {finding.rule.name} / v{finding.rule.version}</p></article>) : <p className="bg-surface p-6 text-sm leading-7 text-muted md:col-span-2">{emptyFinding(category, report)}</p>}</div></section></details>

    <InvestigationPanel aria-labelledby="wallet-activity-title" className={panel}><PanelTitle icon={<Users size={15} aria-hidden="true" />} eyebrow="DISCOVERED ADDRESSES / WINDOW ACTIVITY" title="Wallet activity" id="wallet-activity-title"><span className="font-mono text-[10px] text-muted">{report.wallets.length} ADDRESSES</span></PanelTitle><p className="px-5 py-4 text-xs leading-6 text-muted">Observed window activity · {report.token.decimals === null ? "raw units; token decimals unknown" : "token units; … marks truncated precision"}. Current holdings are unknown. Sales cover supported routes only; 0 does not establish no selling.</p><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-y border-border bg-background font-mono text-[9px] uppercase tracking-wider text-muted"><tr>{["Wallet", "Observed inflow", "Observed outflow", "Observed net", "Supported sales", "Early window", report.holderSnapshot ? "Pinned balance" : "Current balance"].map((label) => <th key={label} className="whitespace-nowrap px-5 py-4 font-normal">{label}</th>)}</tr></thead><tbody>{report.wallets.slice(0, walletLimit).map((wallet, index) => <tr key={wallet.address} className="border-b border-border last:border-0 hover:bg-background"><td className="px-5 py-2"><button className="inline-flex min-h-11 shrink-0 items-center gap-3 whitespace-nowrap font-mono text-xs text-foreground" onClick={() => { setSelected(wallet.address); setEvidenceLimit(25); setEvidenceOpen(true); }}><span className="text-[9px] text-muted">{String(index + 1).padStart(2, "0")}</span>{short(wallet.address)}</button></td>{[wallet.observedIncomingRaw, wallet.observedOutgoingRaw, wallet.observedNetRaw, wallet.verifiedSoldRaw].map((amount, cell) => <td key={cell} title={`Exact raw amount: ${amount}`} className="whitespace-nowrap px-5 font-mono text-[11px] text-foreground/80"><span aria-label={`${tokenAmount(amount, report.token.decimals)}; exact raw amount ${amount}`}>{tokenAmount(amount, report.token.decimals)}</span></td>)}<td className="whitespace-nowrap px-5 text-[11px] text-muted">{report.coverage.transfers !== "complete" || wallet.earlyAccumulator === null ? "Not assessed" : wallet.earlyAccumulator ? "Observed accumulation" : "Not established"}</td><td className="whitespace-nowrap px-5 font-mono text-[11px] text-muted" aria-label={wallet.balanceRaw !== null && report.holderSnapshot ? `Pinned balance ${tokenAmount(wallet.balanceRaw, report.token.decimals)}` : "Current balance unknown"}>{wallet.balanceRaw !== null && report.holderSnapshot ? tokenAmount(wallet.balanceRaw, report.token.decimals) : "—"}</td></tr>)}</tbody></table>{!report.wallets.length && <p className="p-5 text-sm leading-7 text-muted">No eligible wallet activity was retained. Unexamined activity remains unknown.</p>}</div>{walletLimit < report.wallets.length && <button type="button" onClick={() => setWalletLimit((value) => value + 25)} className="mx-5 my-3 min-h-11 text-xs text-muted underline underline-offset-4">Show more addresses ({walletLimit} of {report.wallets.length})</button>}</InvestigationPanel>

    <details className={panel}><summary className="min-h-14 cursor-pointer content-center px-5 text-xs font-medium">Timeline and retained connections</summary><div className="grid min-w-0 gap-5 border-t border-border xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><InvestigationPanel aria-labelledby="timeline-title" className={panel}><PanelTitle icon={<Clock3 size={15} aria-hidden="true" />} eyebrow="CHRONOLOGY / RULE-BASED FINDINGS" title="Finding timeline" id="timeline-title" /><ol className="space-y-0 p-5">{report.story.map((event, index) => <li key={event.id} className="relative border-l border-border pb-6 pl-5 last:pb-0"><span className="absolute -left-[4px] top-1 size-[7px] rounded-full border border-muted bg-background" aria-hidden="true" /><p className="font-mono text-[10px] text-muted">{String(index + 1).padStart(2, "0")} / {time(event.timestamp)}</p><h3 className="mt-3 text-sm font-medium">{event.title}</h3><p className="mt-2 text-xs leading-6 text-muted">{event.description}</p><EvidenceLinks ids={event.evidenceIds} onReveal={revealEvidence} /></li>)}</ol>{!report.story.length && <p className="px-5 pb-5 text-sm leading-7 text-muted">No eligible finding events were produced. Transaction evidence may still contain activity.</p>}</InvestigationPanel><InvestigationPanel aria-labelledby="connections-title" className={panel}><PanelTitle icon={<GitBranch size={15} aria-hidden="true" />} eyebrow="RETAINED RELATIONSHIPS / OWNERSHIP UNKNOWN" title="All retained connections" id="connections-title"><span className="font-mono text-[10px] text-muted">{report.connections.length} EDGES</span></PanelTitle><p className="px-5 py-4 text-xs leading-6 text-muted">Only qualifying observed edges are listed. Missing data and excluded infrastructure can hide other relationships.</p><ul className="divide-y divide-border">{report.connections.map((edge) => <li key={edge.id} className="px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><span className="font-mono text-xs">{short(edge.from)} → {short(edge.to)}</span><span className="border border-border px-2 py-1 font-mono text-[9px] uppercase text-muted">{edge.kind}</span></div><p className="mt-2 font-mono text-[10px] text-muted">{time(edge.timestamp)}</p><EvidenceLinks ids={edge.evidenceIds} onReveal={revealEvidence} /></li>)}</ul>{!report.connections.length && <p className="px-5 pb-5 text-sm leading-7 text-muted">No eligible connection was established from retained data. This does not establish that the wallets are unrelated.</p>}</InvestigationPanel></div></details>

    <details open={evidenceOpen} onToggle={(event) => setEvidenceOpen(event.currentTarget.open)} className={panel}><summary className="min-h-14 cursor-pointer content-center px-5 text-xs font-medium">Transaction evidence ({report.evidence.length})</summary><section aria-labelledby="evidence-title" className="border-t border-border"><PanelTitle icon={<Layers size={15} aria-hidden="true" />} eyebrow="TRANSACTION LEDGER / INSPECTABLE PROVENANCE" title={`Transaction evidence${selected ? ` / ${short(selected)}` : ""}`} id="evidence-title"><span className="font-mono text-[10px] text-muted">{report.evidence.length} RETAINED RECORDS</span></PanelTitle><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3"><p className="font-mono text-[10px] leading-6 text-muted">Showing {Math.min(evidenceLimit, evidence.length)} of {evidence.length} matching records.</p>{selected && <button type="button" className="min-h-11 text-xs underline underline-offset-4" onClick={() => setSelected(null)}>Clear address filter</button>}</div><div className="divide-y divide-border">{evidence.slice(0, evidenceLimit).map((item) => <article key={item.id} id={`evidence-${item.id}`} tabIndex={-1} data-evidence-highlighted={highlightedEvidence?.id === item.id ? "true" : undefined} className="traceforce-evidence-record scroll-mt-24 min-w-0 p-5 focus-visible:outline-accent"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex flex-wrap items-center gap-3 text-xs font-medium"><span className="border border-border px-2 py-1 font-mono text-[9px] uppercase">{item.kind}</span><span className="font-mono text-[10px] text-muted">{time(item.timestamp)}</span></h3><a href={`https://base.blockscout.com/tx/${item.transactionHash}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 font-mono text-[10px] text-muted hover:text-foreground">Inspect transaction<ArrowUpRight size={12} aria-hidden="true" /></a></div><p className="mt-2 break-all font-mono text-[11px] leading-7 text-foreground/80">{item.from} → {item.to}</p><p className="mt-1 break-all font-mono text-[10px] leading-6 text-muted">Raw amount: {item.amountRaw} / Asset: {item.assetAddress ?? "native ETH"}</p>{item.creation && <CreationEvidenceDetails item={item} />}{saleProofs.has(item.id) && <SaleEvidenceDetails proof={saleProofs.get(item.id)!} decimals={report.token.decimals} onReveal={revealEvidence} />}<details className="mt-2"><summary className="min-h-11 cursor-pointer content-center font-mono text-[10px] text-muted">Evidence provenance</summary><p className="break-all border-l border-border pl-4 font-mono text-[10px] leading-6 text-muted">ID: {item.id}<br />Block: {item.blockNumber} / {item.blockHash}<br />Transaction: {item.transactionHash}<br />Log index: {item.logIndex ?? "none"} / Trace: {item.traceId ?? "none"}<br />Source: {item.provenance.provider} / {item.provenance.method}<br />Retrieved: {item.provenance.observedAt}</p></details></article>)}</div>{!evidence.length && <p className="p-5 text-sm leading-7 text-muted">No matching evidence was retained. Missing evidence does not establish no activity.</p>}{evidenceLimit < evidence.length && <button type="button" className="m-5 min-h-11 border border-border px-5 text-xs hover:bg-background" onClick={() => setEvidenceLimit((value) => value + 25)}>Show 25 more records</button>}</section></details>

    <details className={`${panel} p-5`}><summary className="min-h-11 cursor-pointer content-center text-xs font-medium">Coverage and block identity</summary><p className="mt-3 text-xs leading-6 text-muted">{report.summary}</p><p className="mt-3 break-all font-mono text-[10px] leading-6 text-muted">End block hash: {report.range.to.hash}<br />Report generated: {report.generatedAt}</p><ul className="mt-4 space-y-2 text-xs leading-6 text-muted">{report.coverage.warnings.map((warning) => <li key={warning}>— {warning}</li>)}</ul><div className="mt-5 overflow-x-auto"><table className="w-full text-left text-xs"><caption className="pb-3 text-left text-muted">Native funding coverage per wallet; internal transfers are not examined.</caption><thead className="border-b border-border font-mono text-[9px] uppercase text-muted"><tr><th className="py-3 pr-5 font-normal">Wallet</th><th className="pr-5 font-normal">Status</th><th className="font-normal">Limits</th></tr></thead><tbody>{report.coverage.funding.map((entry) => <tr key={entry.wallet} className="border-b border-border last:border-0"><td className="py-4 pr-5 font-mono">{short(entry.wallet)}</td><td className="pr-5 text-muted">{entry.status.replace("_", " ")}</td><td className="min-w-56 text-muted">{entry.reason ?? `Blocks ${entry.fromBlock}–${entry.toBlock}`}</td></tr>)}</tbody></table></div></details>
    <details className={panel}><summary className="min-h-14 cursor-pointer content-center px-5 text-xs font-medium">Website source and investigator details</summary><TokenWebPresence report={report} /><MarketAudit report={report} /><div className="px-5 pb-5">{completed && <ExplanationAudit report={completed} />}</div></details>
    <ReportReferences report={report} onInspectEvidence={() => { setSelected(null); setEvidenceLimit(25); setEvidenceOpen(true); requestAnimationFrame(() => { const first = report.evidence[0]; if (first) document.getElementById(`evidence-${first.id}`)?.focus(); }); }} />
    {completed && <InvestigationShare report={completed} />}
    <a href="#investigation-form" className="inline-flex min-h-11 items-center gap-2 font-mono text-xs text-muted hover:text-foreground">Run another fresh investigation<ArrowUpRight size={13} aria-hidden="true" /></a>
  </div>;
}
