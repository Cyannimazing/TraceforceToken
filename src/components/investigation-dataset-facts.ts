import type { EvidenceRecord, InvestigationReport } from "@/domain/investigations/types";
import { fundingSearchCounts, reportParticipants } from "./investigation-report-facts";

const ZERO = `0x${"0".repeat(40)}`;

function acquisitionScope(records: EvidenceRecord[]) {
  const times = records.map((record) => record.provenance.observedAt).sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    records: records.length,
    transactions: new Set(records.map((record) => record.transactionHash)).size,
    providers: [...new Set(records.map((record) => record.provenance.provider))].sort(),
    retrieved: times.length ? { from: times[0], to: times[times.length - 1] } : null,
  };
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
