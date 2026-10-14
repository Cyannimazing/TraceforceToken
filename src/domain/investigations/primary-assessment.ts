import type { InvestigationReport } from "./types";
import { assessInvestigationReport, type ReportAssessment } from "./report-assessment";
import { SWARM_ORIGIN, validateSwarmAssessmentSnapshot, type SwarmAssessmentSnapshot } from "./swarm-assessment";

interface PrimarySource {
  sourceName: "SWARM" | "TraceForge";
  sourceUrl: string | null;
  checkedAt: string;
  dataThrough: string | null;
}
type SwarmUnavailableReason = NonNullable<InvestigationReport["swarmAvailability"]>["reason"];

const swarmUnavailableReasons: Record<SwarmUnavailableReason, string> = {
  timeout: "SWARM did not finish within this request’s time limit.",
  rate_limited: "SWARM is limiting scan requests. Try again later.",
  access_denied: "SWARM denied access to this request.",
  stale_result: "SWARM returned an older result. It was not used as this request’s assessment.",
  invalid_response: "SWARM returned data that did not pass the response checks.",
  identity_mismatch: "SWARM returned an assessment that did not match this token and network.",
  job_failed: "SWARM’s scan did not complete successfully.",
  unavailable: "SWARM could not provide an assessment for this request.",
};

/** Finite, public source-status copy; never include upstream response bodies. */
export function swarmUnavailableReason(reason?: SwarmUnavailableReason): string {
  if (reason === undefined) return "SWARM's assessment is unavailable for this scan.";
  if (!Object.hasOwn(swarmUnavailableReasons, reason)) throw new Error("Unknown SWARM availability reason.");
  return swarmUnavailableReasons[reason];
}
export type PrimaryAssessment =
  | PrimarySource & { authority: "swarm"; status: "reported"; sourceName: "SWARM"; sourceUrl: string; dataThrough: string;
    verdict: SwarmAssessmentSnapshot["judge"]["decision"]; score: number | null; band: SwarmAssessmentSnapshot["band"]; snapshot: SwarmAssessmentSnapshot }
  | PrimarySource & { authority: "swarm"; status: "unavailable"; sourceName: "SWARM"; sourceUrl: string; dataThrough: null;
    verdict: "INSUFFICIENT"; score: null; band: "UNKNOWN"; unavailableReason: string }
  | PrimarySource & { authority: "traceforge"; status: "local"; sourceName: "TraceForge"; sourceUrl: null; dataThrough: string;
    verdict: ReportAssessment["verdict"]; score: number; band: ReportAssessment["band"]; assessment: ReportAssessment };

/** One explicit presentation authority; local verification never manufactures
 * source scores, and unavailable SWARM data never falls back to local points.
 * Reports predating the authority flag retain their original local assessment. */
export function derivePrimaryAssessment(report: InvestigationReport): PrimaryAssessment {
  if (report.assessmentAuthority === "swarm") {
    if (!report.swarmAssessment) return {
      authority: "swarm", status: "unavailable", sourceName: "SWARM", sourceUrl: `${SWARM_ORIGIN}/t/base/${report.token.address}`,
      checkedAt: report.swarmAvailability?.checkedAt ?? report.generatedAt, dataThrough: null, verdict: "INSUFFICIENT", score: null, band: "UNKNOWN",
      unavailableReason: swarmUnavailableReason(report.swarmAvailability?.reason),
    };
    const snapshot = validateSwarmAssessmentSnapshot(report.swarmAssessment, report.token.address);
    return { authority: "swarm", status: "reported", sourceName: "SWARM", sourceUrl: snapshot.sourceUrl,
      checkedAt: snapshot.checkedAt, dataThrough: snapshot.scannedAt, verdict: snapshot.judge.decision,
      score: snapshot.score, band: snapshot.band, snapshot };
  }
  if (report.assessmentAuthority !== undefined && report.assessmentAuthority !== "traceforge") throw new Error("Unknown primary assessment authority.");
  const assessment = assessInvestigationReport(report);
  return { authority: "traceforge", status: "local", sourceName: "TraceForge", sourceUrl: null,
    checkedAt: report.generatedAt, dataThrough: new Date(report.range.to.timestamp * 1000).toISOString(),
    verdict: assessment.verdict, score: assessment.displayedScore, band: assessment.band, assessment };
}

/** Structured reported measurements only. Upstream narrative is never factual
 * authority, and a source model's sale scenario is not proof of an actual sale. */
export function swarmPlainLanguageReasons(source: SwarmAssessmentSnapshot, options: { detailed?: boolean } = {}): { reason: string; meaning: string }[] {
  const dollars = (amount: number) => amount > 0 && amount < 0.01 ? "less than $0.01"
    : `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const liquidity = source.header.liquidity_usd !== null && source.header.liquidity_usd < 10_000
    ? `${dollars(source.header.liquidity_usd)} in the trading pool` : null;
  const impact = source.metrics.impact !== null && source.metrics.impact >= 0.5
    ? `${(source.metrics.impact * 100).toFixed(2)}%` : null;
  const reasons: { reason: string; meaning: string }[] = [];
  if (impact || liquidity) reasons.push({
    reason: `SWARM ${liquidity ? `reports ${liquidity}${impact ? " and " : "."}` : ""}${impact ? `models a ${impact} pool-price drop if its largest reported holding is sold.` : ""}`,
    meaning: impact ? "Selling could move the price heavily; this is a hypothetical calculation, not a sale or an executable price."
      : "Selling may be difficult, and even a small sale could move the price.",
  });
  if (options.detailed) {
    // These are independent source measures. Equal percentages do not prove
    // that the creator-linked wallets and largest group contain the same people
    // or addresses; choose one warning rather than inventing their intersection.
    const creatorShare = source.metrics.dev !== null && source.metrics.dev >= 0.1 ? source.metrics.dev : null;
    const groupShare = source.metrics.biggest !== null && source.metrics.biggest >= 0.1 ? source.metrics.biggest : null;
    if (creatorShare !== null && (groupShare === null || creatorShare >= groupShare)) reasons.push({
      reason: `SWARM reports wallets linked to the creator hold ${(creatorShare * 100).toFixed(2)}% of the holdings used in its analysis (its float).`,
      meaning: "If those tokens are sold, the price could move sharply; links do not prove one owner or that a sale will happen.",
    });
    else if (groupShare !== null) reasons.push({
      reason: `SWARM reports its largest wallet group holds ${(groupShare * 100).toFixed(2)}% of the holdings used in its analysis (its float).`,
      meaning: "A large sale from that group could move the price; the links do not prove one owner.",
    });
    if (!reasons.length && source.metrics.concentration !== null && source.metrics.concentration >= 0.5) reasons.push({
      reason: `SWARM reports a ${(source.metrics.concentration * 100).toFixed(2)}% concentration measure for its holder cohort.`,
      meaning: "Holdings are concentrated in the source's examined cohort; this does not establish who controls those addresses.",
    });
    if (!reasons.length) return [{ reason: `SWARM reports ${source.judge.decision} for this token.`,
      meaning: "A specific reason for this verdict is not supplied in this result." }];
  }
  if (reasons.length) return reasons.slice(0, 2);
  return [{ reason: `SWARM reports ${source.judge.decision} for this token.`,
    meaning: "This is the source's assessment; its private decision formula has not been independently reproduced." }];
}
