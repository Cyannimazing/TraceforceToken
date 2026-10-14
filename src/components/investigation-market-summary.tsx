import { ArrowUpRight } from "lucide-react";
import type { InvestigationReport } from "@/domain/investigations/types";
import { deriveHolderPopulationBreakdown } from "@/domain/investigations/holder-population";
import { derivePrimaryAssessment } from "@/domain/investigations/primary-assessment";
import { SwarmSourceTime } from "./investigation-swarm-assessment";

const dollars = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);

export function InvestigationMarketSummary({ report }: { report: InvestigationReport }) {
  const primary = derivePrimaryAssessment(report);
  if (primary.status === "reported") {
    const snapshot = primary.snapshot, source = snapshot.header;
    const metrics = [
      { label: "Price (reported)", value: source.price_usd === null ? "—" : `$${source.price_usd}`, change: source.change24h === null ? null : `${source.change24h > 0 ? "+" : ""}${source.change24h}%` },
      { label: "MCAP", value: dollars(source.mcap), change: null },
      { label: "Liquidity", value: dollars(source.liquidity_usd), change: null },
      { label: "24H Vol", value: dollars(source.vol24h), change: null },
      { label: "Age (SWARM)", value: source.age_h === null ? "—" : source.age_h < 1 ? "<1h" : source.age_h < 24 ? `${Math.floor(source.age_h)}h` : `${Math.floor(source.age_h / 24)}d`, change: null },
      { label: "Holders (SWARM)", value: source.holders_count === null ? "—" : String(source.holders_count), change: null },
    ];
    return <section aria-labelledby="market-title" className="traceforce-market-strip overflow-hidden border border-border bg-surface" data-market-source="swarm" data-market-price={source.price_usd ?? undefined}>
      <h3 id="market-title" className="sr-only">Market snapshot</h3><dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">{metrics.map((metric) => <div key={metric.label} className={metric.label === "Price (reported)" ? "col-span-2 min-w-0 border-border px-4 py-3 sm:col-span-1" : "min-w-0 border-border px-4 py-3"}><dt className="font-mono text-[9px] uppercase tracking-wider text-muted">{metric.label}</dt><dd className="mt-1 flex flex-wrap items-baseline gap-x-2 break-all font-mono text-lg font-semibold text-foreground"><span className={metric.label === "Price (reported)" ? "text-sm sm:text-lg" : undefined}>{metric.value}</span>{metric.change !== null && <span className="text-[10px] font-normal text-muted" aria-label={`24-hour price change ${metric.change}`}>24h {metric.change}</span>}</dd></div>)}</dl>
      <div className="space-y-2 border-t border-border px-4 py-3 text-xs leading-5 text-muted"><div className="flex flex-wrap items-center justify-between gap-2"><SwarmSourceTime snapshot={snapshot} /><a href={snapshot.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 underline underline-offset-4">SWARM market source<ArrowUpRight size={11} aria-hidden="true" /></a></div><p>Market values and the total holder count are source-reported. The report’s filtered wallet rows can have a different count.</p>{source.price_usd !== null && (source.liquidity_usd === null || source.liquidity_usd < 10_000) && <p className="font-medium text-warning">{source.liquidity_usd === null ? "Liquidity was not reported; sale value remains unknown." : "Low liquidity: the displayed quote is not a guaranteed selling price."}</p>}</div>
    </section>;
  }
  const market = report.token.marketSnapshot;
  const reported = market?.status === "reported" ? market : null;
  const security = report.token.securitySnapshot;
  const sourceHolderCount = security?.status === "reported" ? security.holderCount : null;
  const population = deriveHolderPopulationBreakdown(report);
  const inconsistentZeroCount = sourceHolderCount === 0 && (population.verifiedPositiveCandidates ?? 0) > 0;
  const elapsed = !reported || reported.pairCreatedAt === null ? null : Date.parse(reported.checkedAt) - reported.pairCreatedAt;
  const pairAge = elapsed === null || elapsed < 0 ? "—" : elapsed < 3_600_000 ? "<1h" : elapsed < 86_400_000 ? `${Math.floor(elapsed / 3_600_000)}h` : `${Math.floor(elapsed / 86_400_000)}d`;
  const change = reported?.priceChange24hPercent;
  const priceNotice = reported?.priceUsd == null ? null : reported.liquidityUsd === null
    ? "Quote liquidity unavailable; sale value is unverified."
    : reported.liquidityUsd < 1
      ? "Negligible liquidity: this pool quote is not a reliable sale price."
      : reported.liquidityUsd < 10_000
        ? "Low liquidity: this pool quote is not a reliable sale price."
        : null;
  const metrics = [
    { label: "Price (reported)", value: reported?.priceUsd == null ? "—" : `$${reported.priceUsd}`, change: change == null ? null : `${change > 0 ? "+" : ""}${change}%`, description: "DEX Screener's selected-pool USD quote, preserved at its reported precision. Not a guaranteed execution price." },
    { label: "MCAP", value: dollars(reported?.marketCapUsd ?? null), description: "Source-reported market cap for the selected pair; not an independently verified valuation." },
    { label: "Liquidity", value: dollars(reported?.liquidityUsd ?? null) },
    { label: "24H Vol", value: dollars(reported?.volume24hUsd ?? null) },
    { label: "Pool age", value: pairAge, description: "Age of the selected pool. Token launch age is unverified." },
    { label: "Wallets shown", value: population.verifiedPositiveCandidates === null ? "—" : String(population.walletRows), description: "Verified positive EOA rows in the wallet table. Contracts, pools and unclassified addresses are separate. This is not a complete holder census." },
  ];
  return <section aria-labelledby="market-title" className="traceforce-market-strip overflow-hidden border border-border bg-surface">
    <h3 id="market-title" className="sr-only">Market snapshot</h3>
    {primary.authority === "swarm" && <p className="border-b border-border px-4 py-3 text-xs font-medium text-muted">Independent market context · DEX Screener. SWARM market data is unavailable.</p>}
    <dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">{metrics.map((metric) => <div key={metric.label} className={metric.label === "Price (reported)" ? "col-span-2 min-w-0 border-border px-4 py-3 sm:col-span-1" : "min-w-0 border-border px-4 py-3"}>
      <dt title={metric.description} className="font-mono text-[9px] uppercase tracking-wider text-muted">{metric.label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-x-2 break-all font-mono text-lg font-semibold text-foreground"><span className={metric.label === "Price (reported)" ? "text-sm sm:text-lg" : undefined} title={metric.label === "Price (reported)" ? metric.value : undefined}>{metric.value}</span>{metric.change && <span className="text-[10px] font-normal text-muted" title="24-hour price change" aria-label={`24-hour price change ${metric.change}`}>24h {metric.change}</span>}{metric.description && <span className="sr-only">{metric.description}</span>}</dd>
    </div>)}</dl>
    <div className="space-y-1 border-t border-border px-4 py-2 text-[11px] leading-5 text-muted">
      {priceNotice && <p className="font-medium text-warning">{priceNotice}</p>}
      <p className="flex flex-wrap items-center gap-x-3">{reported?.pairAddress ? <a href={`https://dexscreener.com/base/${reported.pairAddress}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 underline underline-offset-4">DEX Screener · selected pool<ArrowUpRight size={11} aria-hidden="true" /></a> : <span>{market ? market.status === "unavailable" ? "Market metadata unavailable" : "No usable market pair in source" : "Market metadata not checked"}</span>}{market && <span>Checked <time dateTime={market.checkedAt}>{market.checkedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</time></span>}</p>
      {population.verifiedPositiveCandidates !== null && <p>{population.label}.{(population.unknownBalanceCandidates ?? 0) > 0 && <> {population.unknownBalanceCandidates} candidate balances unread.</>}</p>}
      {sourceHolderCount !== null && <p>{inconsistentZeroCount ? `GoPlus reported 0 holders; the pinned snapshot verifies ${population.verifiedPositiveCandidates} positive addresses. Its reported zero is not used as a total.` : `GoPlus reports ${sourceHolderCount} holders; this separate source count is not pinned to the scan block.`}</p>}
    </div>
  </section>;
}
