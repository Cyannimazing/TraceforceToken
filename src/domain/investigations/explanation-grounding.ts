import type { EvidenceRecord, InvestigationFinding, InvestigationReport } from "./types";

/** Presentation of trusted analyzer prose only; no model text enters a published fact. */
export function canonicalFindingClaim(finding: Pick<InvestigationFinding, "explanation">): string {
  return finding.explanation
    .replace(/0x[0-9a-f]{40}/g, (address) => `${address.slice(0, 6)}…${address.slice(-4)}`)
    .replace(/a net [0-9]+ raw token units/g, "a positive net token inflow")
    .replace(/starting at [0-9]+ and ending at [0-9]+/g, "inside the earliest examined interval")
    .replace(/within funding blocks [0-9]+[–-][0-9]+/g, "inside the examined funding window");
}

export function canonicalFindingCaveat(finding: Pick<InvestigationFinding, "limitations">, index: number): string | undefined {
  return finding.limitations[index];
}

export function canonicalCoverageSentence(report: InvestigationReport): string {
  const counts = { complete: 0, partial: 0, unavailable: 0, not_examined: 0 };
  for (const entry of report.coverage.funding) counts[entry.status]++;
  counts.not_examined += Math.max(0, report.coverage.eligibleWallets - report.coverage.funding.length);
  return `Token transfer coverage is ${report.coverage.transfers} within finalized blocks ${report.range.from.number}–${report.range.to.number}. Funding-history coverage: ${counts.complete} complete, ${counts.partial} partial, ${counts.unavailable} unavailable, ${counts.not_examined} not examined.`;
}

function canonicalEvidenceStatement(record: EvidenceRecord, token: string): string {
  if (record.kind === "funding") return "The retained evidence includes native ETH funding inside an examined window; this does not establish lifetime-first funding or ownership.";
  if (record.kind === "sale") return "The retained evidence includes a supported token sale with reconciled token-out and quote-in flows; intent is not established.";
  if (record.assetAddress === token) return "The retained evidence includes an investigated-token transfer; a transfer alone does not establish a purchase, sale or ownership.";
  return "The retained evidence includes another ERC-20 transfer; this alone does not establish investigated-token buying or selling.";
}

export function canonicalExplanationOverview(report: InvestigationReport, findings: Pick<InvestigationFinding, "explanation">[], evidence: EvidenceRecord[]): string {
  const statements = findings.length ? findings.map(canonicalFindingClaim) : evidence.map((record) => canonicalEvidenceStatement(record, report.token.address));
  const prose = [...new Set(statements)].join(" ") || "This scan could not establish wallet activity from retained transaction evidence. Missing observations do not establish an absence of activity.";
  return `${prose} ${canonicalCoverageSentence(report)}`;
}
