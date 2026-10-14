import type { EvidenceRecord, InvestigationReport } from "@/domain/investigations/types";
import { fundingSearchCounts, reportParticipants } from "./investigation-report-facts";

const ZERO = `0x${"0".repeat(40)}`;

/** Human coverage notes use fixed copy; upstream error text, addresses and raw amounts stay out of the UI. */
export function readableCoverageNotes(report: InvestigationReport): string[] {
  const notes = new Set<string>();
  for (const warning of report.coverage.warnings) {
    if (/^Detailed summaries cover \d+ of \d+ qualifying token transfers/i.test(warning)) notes.add("Only a selection of transfers has individual summaries. All retained transfer evidence and wallet links remain available.");
    if (/SWARM context was unavailable/i.test(warning)) notes.add("SWARM's external assessment was unavailable. This report uses TraceForge's acquired evidence.");
    if (/external discovery was limited|external source limited its candidate list/i.test(warning)) notes.add("An external address-list limit was reached. Additional addresses may be missing or unchecked.");
    if (/token-transfer (record|page) limit|transfer-verification call allocation|bounded log limit|supporting-evidence limit/i.test(warning)) notes.add("A transaction-reading limit was reached. Missing history or swap evidence can change the findings.");
    if (/token-transfer (page or receipt was unavailable|range could not be retrieved)|log RPC refused|pagination repeated a cursor|omitted ERC-20 transfers/i.test(warning)) notes.add("Some transaction history could not be obtained. Verified records were retained; missing transactions remain unknown.");
    if (/pool verification limit|pool contracts could not be authenticated|swap checks could not be completed|sale-enrichment allocation/i.test(warning)) notes.add("Some possible swaps could not be verified. The report's selling observations cover only supported, checked transactions.");
    if (/RPC throttling stopped|RPC throttle remains active|Recognized RPC throttling/i.test(warning)) notes.add("A blockchain provider restricted additional requests. Some optional checks could not finish.");
    if (/wallet-activity row limit|wallet code or outgoing-transaction nonce reads were unavailable/i.test(warning)) notes.add("Some wallet activity or account-type checks were unavailable. Missing observations remain unknown.");
    if (/ERC-20 .*metadata|ERC-20 totalSupply/i.test(warning)) notes.add("Some token metadata or supply details could not be verified. Any affected amounts or percentages remain unavailable.");
    if (/selected-pool reserves could not be verified/i.test(warning)) notes.add("Selected-pool balances could not be verified, so the related price-impact estimate is unavailable.");
  }
  for (const capability of report.providerEnrichment?.capabilities ?? []) {
    if (capability.provider !== "bubblemaps" && capability.provider !== "nansen") continue;
    const name = capability.provider === "bubblemaps" ? "Bubblemaps" : "Nansen";
    if (["access-denied", "rate-limited", "timeout", "invalid-response", "unavailable"].includes(capability.status)) notes.add(`${name}'s additional address discovery could not complete. The report does not assume its missing data.`);
  }
  return [...notes];
}

function acquisitionScope(records: EvidenceRecord[]) {
  const times = records.map((record) => record.provenance.observedAt).sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    records: records.length,
    transactions: new Set(records.map((record) => record.transactionHash)).size,
    providers: [...new Set(records.map((record) => record.provenance.provider))].sort(),
    retrieved: times.length ? { from: times[0], to: times[times.length - 1] } : null,
  };
}

function missingDiscoveryRanges(report: InvestigationReport) {
  const crawl = report.coverage.transferCrawl;
  if (!crawl) return null;
  const end = BigInt(report.range.to.number), start = crawl.scope === "full" ? 0n : BigInt(report.range.from.number);
  let cursor = start;
  const gaps: { fromBlock: string; toBlock: string }[] = [];
  for (const range of [...crawl.completedRanges].sort((left, right) => BigInt(left.fromBlock) < BigInt(right.fromBlock) ? -1 : 1)) {
    const from = BigInt(range.fromBlock), to = BigInt(range.toBlock);
    if (from > cursor) gaps.push({ fromBlock: cursor.toString(), toBlock: (from - 1n).toString() });
    if (to >= cursor) cursor = to + 1n;
  }
  if (cursor <= end) gaps.push({ fromBlock: cursor.toString(), toBlock: end.toString() });
  return gaps;
}

/** Separate cohorts and anchors: these datasets do not establish independent consensus. */
export function buildDatasetComparison(report: InvestigationReport) {
  const transfers = report.evidence.filter((record) => record.kind === "transfer" && record.assetAddress === report.token.address);
  const funding = report.evidence.filter((record) => record.kind === "funding" && record.assetAddress === null);
  const snapshot = report.holderSnapshot;
  const security = report.token.securitySnapshot;
  const market = report.token.marketSnapshot;
  const counts = fundingSearchCounts(report);
  const positive = snapshot?.holders.filter((holder) => holder.status === "verified" && holder.balanceRaw !== null && BigInt(holder.balanceRaw) > 0n).length ?? null;
  const zero = snapshot?.holders.filter((holder) => holder.status === "verified" && holder.balanceRaw === "0").length ?? null;

  return {
    tokenActivity: {
      ...acquisitionScope(transfers),
      participants: new Set(transfers.flatMap((record) => [record.from, record.to]).filter((address) => address !== ZERO)).size,
      eligibleParticipants: reportParticipants(report).retainedTokenParticipants,
      status: report.coverage.transfers,
      crawl: report.coverage.transferCrawl ?? null,
      missingRanges: missingDiscoveryRanges(report),
      range: report.range,
    },
    nativeFunding: { ...acquisitionScope(funding), searches: counts, eligibleWallets: report.coverage.eligibleWallets },
    holders: snapshot ? {
      discovery: snapshot.discovery,
      retainedCandidates: snapshot.holders.length,
      requested: snapshot.balances.requestedWallets,
      verified: snapshot.balances.verifiedWallets,
      positive: positive!, zero: zero!,
      unavailable: snapshot.holders.filter((holder) => holder.status === "unavailable").length,
      notExamined: snapshot.holders.filter((holder) => holder.status === "not_examined").length,
      status: snapshot.balances.status,
      block: snapshot.block,
      provenance: snapshot.provenance,
    } : null,
    security: security ? { ...security, holderCount: security.status === "reported" ? security.holderCount : null } : null,
    market: market ?? null,
  };
}

export type DatasetComparison = ReturnType<typeof buildDatasetComparison>;
