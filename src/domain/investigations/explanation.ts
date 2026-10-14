import { z } from "@/lib/validation";
import type { InvestigationExplanation, InvestigationReport } from "./types";
import { canonicalExplanationOverview, canonicalFindingCaveat, canonicalFindingClaim } from "./explanation-grounding";
import { plainLanguageSummarySchema, validatePlainLanguageSummary } from "./plain-language-summary";

export class ExplanationValidationError extends Error {
  constructor(public readonly code: "INVALID_EXPLANATION" | "INVALID_CITATION") { super(`Investigation explanation validation failed (${code}).`); this.name = "ExplanationValidationError"; }
}
const text = (limit: number) => z.string().min(1).max(limit).refine((value) => Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value));
const prose = (limit: number) => z.string().min(1).max(limit).refine((value) => Boolean(value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const ids = z.array(text(255)).max(20);
export const explanationDraftSchema = z.object({
  overview: z.object({ text: prose(2000), evidenceIds: z.array(text(255)).max(200) }).strict(),
  observations: z.array(z.object({ category: z.enum(["funding", "connections", "accumulation", "selling"]), claim: prose(1000), caveat: prose(500), evidenceIds: ids.min(1) }).strict()).max(12),
  limitations: z.array(prose(500)).max(12),
}).strict();
const explanationSchema = explanationDraftSchema.extend({
  limitations: z.array(prose(500)).max(20),
  schemaVersion: z.literal(1), reportId: text(255), profileId: z.literal("on-chain-investigator"), profileVersion: z.enum(["1.0.0", "1.1.0", "1.1.1", "1.1.2", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0"]),
  summary: plainLanguageSummarySchema.optional(),
  model: text(128), generatedAt: z.iso.datetime(), authority: z.literal("non-authoritative-commentary"),
  context: z.object({ evidenceIds: z.array(text(255)).max(200), suppliedEvidence: z.number().int().min(0).max(200), omittedEvidence: z.number().int().nonnegative().safe() }).strict(),
  grounding: z.object({ mode: z.literal("canonical-finding-selection"), overviewFindingIds: z.array(text(255)).max(2), overviewEvidenceIds: z.array(text(255)).max(2), observations: z.array(z.object({ findingId: text(255), caveatIndex: z.number().int().min(0).max(9) }).strict()).max(4) }).strict().optional(),
}).strict();

/** Citation integrity, not a semantic truth guarantee for generated prose. */
export function validateInvestigationExplanation(report: InvestigationReport, value: unknown): InvestigationExplanation {
  const result = explanationSchema.safeParse(value);
  if (!result.success || result.data.reportId !== report.id) throw new ExplanationValidationError("INVALID_EXPLANATION");
  const explanation = result.data;
  if (explanation.profileVersion === "1.5.0" || explanation.profileVersion === "1.6.0") {
    try { explanation.summary = validatePlainLanguageSummary(report, explanation.summary, { profileVersion: explanation.profileVersion }); }
    catch { throw new ExplanationValidationError("INVALID_EXPLANATION"); }
  } else if (explanation.summary) throw new ExplanationValidationError("INVALID_EXPLANATION");
  const retained = new Map(report.evidence.map((record) => [record.id, record]));
  const context = new Set(explanation.context.evidenceIds);
  if (context.size !== explanation.context.evidenceIds.length || context.size !== explanation.context.suppliedEvidence || explanation.context.omittedEvidence !== report.evidence.length - context.size || [...context].some((id) => !retained.has(id))) throw new ExplanationValidationError("INVALID_CITATION");
  for (const id of context) {
    const record = retained.get(id)!;
    if (record.kind === "sale" && (!record.sale || record.sale.supportingEvidenceIds.some((support) => !context.has(support)))) throw new ExplanationValidationError("INVALID_CITATION");
  }
  const citations = (values: string[]) => {
    if (new Set(values).size !== values.length || values.some((id) => !context.has(id))) throw new ExplanationValidationError("INVALID_CITATION");
  };
  citations(explanation.overview.evidenceIds);
  if (report.evidence.length > 0 && explanation.overview.evidenceIds.length === 0) throw new ExplanationValidationError("INVALID_CITATION");
  const proofBound = ["1.3.0", "1.4.0", "1.5.0", "1.6.0"].includes(explanation.profileVersion);
  if (proofBound) {
    if (explanation.observations.length > 4 || new Set(explanation.observations.map((observation) => observation.category)).size !== explanation.observations.length) throw new ExplanationValidationError("INVALID_CITATION");
    for (const id of explanation.overview.evidenceIds) if (retained.get(id)?.sale?.supportingEvidenceIds.some((support) => !explanation.overview.evidenceIds.includes(support))) throw new ExplanationValidationError("INVALID_CITATION");
  }
  for (const observation of explanation.observations) {
    citations(observation.evidenceIds);
    if (proofBound && !report.findings.some((finding) => finding.category === observation.category && finding.evidenceIds.length === observation.evidenceIds.length && finding.evidenceIds.every((id) => observation.evidenceIds.includes(id)))) throw new ExplanationValidationError("INVALID_CITATION");
    const records = observation.evidenceIds.map((id) => retained.get(id)!);
    const tokenFlow = records.some((record) => record.kind === "transfer" && record.assetAddress === report.token.address);
    const validKind = observation.category === "selling" ? records.some((record) => record.kind === "sale" && record.sale !== null) : observation.category === "funding" ? records.some((record) => record.kind === "funding") : observation.category === "accumulation" ? tokenFlow : tokenFlow || records.some((record) => record.kind === "funding");
    if (!validKind) throw new ExplanationValidationError("INVALID_CITATION");
    if (proofBound && records.some((record) => record.kind === "sale" && record.sale?.supportingEvidenceIds.some((id) => !observation.evidenceIds.includes(id)))) throw new ExplanationValidationError("INVALID_CITATION");
  }
  if (explanation.profileVersion === "1.4.0" || explanation.profileVersion === "1.5.0" || explanation.profileVersion === "1.6.0") {
    const grounding = explanation.grounding;
    if (!grounding || grounding.observations.length !== explanation.observations.length
      || new Set(grounding.observations.map((entry) => entry.findingId)).size !== grounding.observations.length
      || new Set(grounding.overviewFindingIds).size !== grounding.overviewFindingIds.length
      || new Set(grounding.overviewEvidenceIds).size !== grounding.overviewEvidenceIds.length) throw new ExplanationValidationError("INVALID_EXPLANATION");
    const findings = new Map(report.findings.filter((finding) => finding.category !== "coverage").map((finding) => [finding.id, finding]));
    grounding.observations.forEach((entry, index) => {
      const finding = findings.get(entry.findingId), observation = explanation.observations[index];
      if (!finding || observation.category !== finding.category || observation.claim !== canonicalFindingClaim(finding)
        || observation.caveat !== canonicalFindingCaveat(finding, entry.caveatIndex)) throw new ExplanationValidationError("INVALID_EXPLANATION");
      if (finding.evidenceIds.length !== observation.evidenceIds.length || finding.evidenceIds.some((id) => !observation.evidenceIds.includes(id))) throw new ExplanationValidationError("INVALID_CITATION");
    });
    const selectedIds = new Set(grounding.observations.map((entry) => entry.findingId));
    if ((selectedIds.size && (!grounding.overviewFindingIds.length || grounding.overviewEvidenceIds.length))
      || (!selectedIds.size && grounding.overviewFindingIds.length)
      || grounding.overviewFindingIds.some((id) => !selectedIds.has(id))) throw new ExplanationValidationError("INVALID_EXPLANATION");
    citations(grounding.overviewEvidenceIds);
    if (!selectedIds.size && context.size && !grounding.overviewEvidenceIds.length) throw new ExplanationValidationError("INVALID_CITATION");
    const selectedFindings = grounding.overviewFindingIds.map((id) => findings.get(id)!);
    const selectedEvidence = grounding.overviewEvidenceIds.map((id) => retained.get(id)!);
    if (explanation.overview.text !== canonicalExplanationOverview(report, selectedFindings, selectedEvidence)) throw new ExplanationValidationError("INVALID_EXPLANATION");
    const expectedCitations = new Set([...explanation.observations.flatMap((observation) => observation.evidenceIds), ...grounding.overviewEvidenceIds]);
    for (const id of expectedCitations) for (const support of retained.get(id)?.sale?.supportingEvidenceIds ?? []) expectedCitations.add(support);
    if (expectedCitations.size !== explanation.overview.evidenceIds.length || explanation.overview.evidenceIds.some((id) => !expectedCitations.has(id))) throw new ExplanationValidationError("INVALID_CITATION");
  } else if (explanation.grounding) throw new ExplanationValidationError("INVALID_EXPLANATION");
  return explanation;
}
