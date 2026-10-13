import type { InvestigationExplanation, InvestigationFinding, InvestigationReport } from "@/domain/investigations/types";

type GoalCategory = Exclude<InvestigationFinding["category"], "coverage">;
type Observation = InvestigationExplanation["observations"][number];

/** Discovered candidates are not proof that each address transacted in this window. */
export function reportParticipants(report: InvestigationReport) {
  const eligible = new Set(report.wallets.map((wallet) => wallet.address));
  const retained = new Set(report.evidence
    .filter((event) => event.kind === "transfer" && event.assetAddress === report.token.address)
    .flatMap((event) => [event.from, event.to]).filter((address) => eligible.has(address)));
  return { discovered: eligible.size, retainedTokenParticipants: retained.size };
}

/** Older snapshots may omit coverage rows; missing searches remain unexamined. */
export function fundingSearchCounts(report: InvestigationReport) {
  const counts = { complete: 0, partial: 0, unavailable: 0, not_examined: 0 };
  for (const entry of report.coverage.funding) counts[entry.status]++;
  counts.not_examined += Math.max(0, report.coverage.eligibleWallets - report.coverage.funding.length);
  return counts;
}

/** Truncate exact count ratios so incomplete acquisition can never display 100%. */
export function coveragePercentage(examined: number, eligible: number): number | null {
  if (!Number.isSafeInteger(examined) || !Number.isSafeInteger(eligible)
    || examined < 0 || eligible <= 0 || examined > eligible) return null;
  return Number(BigInt(examined) * 1000n / BigInt(eligible)) / 10;
}

function sameProof(left: readonly string[], right: readonly string[]) {
  const ids = new Set(left);
  return ids.size > 0 && ids.size === left.length && right.length === ids.size
    && new Set(right).size === right.length && right.every((id) => ids.has(id));
}

/** Keep the displayed title, commentary and caveat attached to the same complete proof. */
export function goalCardFinding(report: InvestigationReport, category: GoalCategory): {
  findings: InvestigationFinding[];
  finding: InvestigationFinding | null;
  observation: Observation | null;
  reviewed: boolean;
  ambiguous: boolean;
} {
  const findings = report.findings.filter((finding) => finding.category === category);
  const explanation = report.explanation;
  const index = explanation?.observations.findIndex((observation) => observation.category === category) ?? -1;
  const observation = index < 0 ? undefined : explanation?.observations[index];
  if (!observation) return { findings, finding: findings[0] ?? null, observation: null, reviewed: false, ambiguous: false };
  const grounding = explanation?.grounding;
  const selected = grounding?.observations[index]?.findingId;
  if (grounding && !selected) return { findings, finding: findings[0] ?? null, observation: null, reviewed: false, ambiguous: false };
  const matching = findings.filter((finding) => (!selected || finding.id === selected) && sameProof(finding.evidenceIds, observation.evidenceIds));
  if (!matching.length) return { findings, finding: findings[0] ?? null, observation: null, reviewed: false, ambiguous: false };
  return {
    findings, finding: matching[0], observation,
    reviewed: grounding?.mode === "canonical-finding-selection",
    ambiguous: !selected && matching.length > 1,
  };
}
