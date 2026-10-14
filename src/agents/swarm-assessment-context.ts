import { z } from "zod";
import type { InvestigationReport } from "@/domain/investigations/types";
import { SWARM_CATEGORY_WEIGHTS, swarmAssessmentSnapshotSchema, validateSwarmAssessmentSnapshot } from "@/domain/investigations/swarm-assessment";
import { swarmPlainLanguageReasons } from "@/domain/investigations/primary-assessment";

const text = (maximum: number) => z.string().min(1).max(maximum).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const category = z.enum(["swarm", "fresh", "insiders", "concentration", "snipers", "dev"]);

/** A bounded copy of source facts, distinct from the local rule ledger. */
export const swarmAssessmentContextSchema = z.object({
  source: z.literal("SWARM"), authority: z.literal("source-reported"),
  tokenAddress: swarmAssessmentSnapshotSchema.shape.tokenAddress,
  sourceUrl: swarmAssessmentSnapshotSchema.shape.sourceUrl,
  checkedAt: z.iso.datetime(), scannedAt: z.iso.datetime(),
  model: text(128), score: swarmAssessmentSnapshotSchema.shape.score,
  band: swarmAssessmentSnapshotSchema.shape.band,
  verdict: z.enum(["AVOID", "CAUTION", "OK"]), confidence: z.number().min(0).max(1),
  weights: swarmAssessmentSnapshotSchema.shape.judge.shape.p,
  receipt: swarmAssessmentSnapshotSchema.shape.judge.shape.receipt,
  categories: z.array(z.object({ id: category, points: z.number().min(0).max(30).nullable(), possiblePoints: z.number().int().min(1).max(30) }).strict()).length(6),
  metrics: swarmAssessmentSnapshotSchema.shape.metrics,
  liquidityUsd: swarmAssessmentSnapshotSchema.shape.header.shape.liquidity_usd,
  // Optional for historical signed capsules; new primary-source questions use
  // the same reported market/count fields as the report header.
  header: swarmAssessmentSnapshotSchema.shape.header.pick({ holders_count: true, price_usd: true, mcap: true, liquidity_usd: true, vol24h: true }).optional(),
  reasons: z.array(z.object({ reason: text(400), meaning: text(400) }).strict()).min(1).max(2),
}).strict().superRefine((value, context) => {
  if (value.sourceUrl !== `https://swarmengine.tech/t/base/${value.tokenAddress}`
    || new Set(value.categories.map((row) => row.id)).size !== 6
    || value.categories.some((row) => row.possiblePoints !== SWARM_CATEGORY_WEIGHTS[row.id] || row.points !== null && row.points > row.possiblePoints)
    || Math.abs(value.confidence - value.weights[value.verdict.toLowerCase() as "avoid" | "caution" | "ok"]) > 0.001001) {
    context.addIssue({ code: "custom", message: "Inconsistent source assessment metadata." });
  }
});
export type SwarmAssessmentContext = z.infer<typeof swarmAssessmentContextSchema>;

export function createSwarmAssessmentContext(report: InvestigationReport): SwarmAssessmentContext {
  const source = validateSwarmAssessmentSnapshot(report.swarmAssessment, report.token.address);
  const reasons = swarmPlainLanguageReasons(source, { detailed: report.explanation?.profileVersion === "1.6.0" });
  return swarmAssessmentContextSchema.parse({
    source: "SWARM", authority: "source-reported", tokenAddress: source.tokenAddress,
    sourceUrl: source.sourceUrl, checkedAt: source.checkedAt, scannedAt: source.scannedAt,
    model: source.judge.model, score: source.score, band: source.band,
    verdict: source.judge.decision, confidence: source.judge.confidence, weights: source.judge.p, receipt: source.judge.receipt,
    categories: Object.entries(SWARM_CATEGORY_WEIGHTS).map(([id, possiblePoints]) => ({ id, points: source.parts[id as keyof typeof SWARM_CATEGORY_WEIGHTS], possiblePoints })),
    metrics: source.metrics, liquidityUsd: source.header.liquidity_usd,
    header: { holders_count: source.header.holders_count, price_usd: source.header.price_usd, mcap: source.header.mcap, liquidity_usd: source.header.liquidity_usd, vol24h: source.header.vol24h },
    reasons,
  });
}
