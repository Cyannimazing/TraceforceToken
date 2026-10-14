import type { ExplainedInvestigationReport, InvestigationReport } from "../../src/domain/investigations/types";
import { validateSwarmAssessmentSnapshot, type SwarmAssessmentSnapshot } from "../../src/domain/investigations/swarm-assessment";
import { buildPlainLanguagePacket, restorePlainLanguageSummary } from "../../src/domain/investigations/plain-language-summary";
import { canonicalExplanationOverview, canonicalFindingCaveat, canonicalFindingClaim } from "../../src/domain/investigations/explanation-grounding";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import { getBrowserWalletFlagsFixture } from "./report";

/** Fabricated source response for browser validation; never a live SWARM read. */
export function getBrowserSwarmAssessmentFixture(report: InvestigationReport): SwarmAssessmentSnapshot {
  return validateSwarmAssessmentSnapshot({
    source: "swarm", status: "reported", chainId: 8453, tokenAddress: report.token.address,
    sourceUrl: `https://swarmengine.tech/t/base/${report.token.address}`,
    requestedAt: "2026-10-13T00:00:00.000Z", checkedAt: "2026-10-13T00:00:02.000Z", scannedAt: "2026-10-13T00:00:01.000Z", freshRequested: true,
    score: 45, band: "DANGER", parts: { swarm: 0, fresh: 20, insiders: 15, concentration: 0, snipers: 0.6, dev: 9.2 },
    gates: ["biggest holding could lower price 97% (13.6% of float)", "liquidity too thin ($0.01)"],
    metrics: { hands: 12, wallets: 12, impact: 0.9720276564733474, biggest: 0.1359582017907644, fresh: 0, insiders: 0, snipers: 0.23651291260644525, concentration: 0.963, dev: 0.029 },
    header: { name: "Synthetic source fixture", symbol: "TEST", decimals: 18, supply: 100000, holders_count: 14, price_usd: 0.01, mcap: 1, liquidity_usd: 0.01, vol24h: 1800, change24h: -99.98, age_h: 2.6, dex: null, pair: null },
    judge: { model: "synthetic-swarm-judge-fixture", decision: "AVOID", confidence: 0.757, p: { avoid: 0.757, caution: 0.239, ok: 0.004 },
      evidence: [{ k: "base avoid - score 45", avoid: 0.61, caution: 0.35, ok: 0.01 }, { k: "hard rule: DANGER band", avoid: 0.6 }, { k: "one holding can lower price 97%", avoid: 0.4, caution: 0.15 }],
      features: { liquidity_usd: 0.01 }, why: ["Synthetic source warning"], receipt: "synthetic-source-receipt", bar: 0.7, escalate: false, route: "act", latency_ms: 0.079, cost_usd: 0 },
  }, report.token.address);
}

/** Profile 1.5 canonical summary plus one complete synthetic funding finding.
 * No LLM or provider participates in constructing this browser-only fixture. */
export function getBrowserSwarmSummaryFixture(): ExplainedInvestigationReport {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  report.assessmentAuthority = "swarm";
  report.swarmAssessment = getBrowserSwarmAssessmentFixture(report);
  const packet = buildPlainLanguagePacket(report);
  const finding = report.findings.find((value) => value.category === "funding" && value.limitations.length > 0)!;
  const evidenceIds = [...finding.evidenceIds];
  report.explanation = {
    ...report.explanation, profileVersion: "1.5.0", model: "synthetic-summary-selector-fixture",
    summary: restorePlainLanguageSummary(report, { reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id) }),
    overview: { text: canonicalExplanationOverview(report, [finding], []), evidenceIds },
    observations: [{ category: "funding", claim: canonicalFindingClaim(finding), caveat: canonicalFindingCaveat(finding, 0)!, evidenceIds }],
    grounding: { mode: "canonical-finding-selection", overviewFindingIds: [finding.id], overviewEvidenceIds: [], observations: [{ findingId: finding.id, caveatIndex: 0 }] },
    context: { evidenceIds, suppliedEvidence: evidenceIds.length, omittedEvidence: report.evidence.length - evidenceIds.length },
  };
  return validateExplainedReport(report);
}
