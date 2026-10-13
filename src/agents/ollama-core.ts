import { z } from "zod";
import type { InvestigationExplanation, InvestigationReport } from "@/domain/investigations/types";
import { ExplanationValidationError, validateInvestigationExplanation } from "@/domain/investigations/explanation";
import { validateAiConfiguration, type AiConfiguration } from "./config";
import { ON_CHAIN_INVESTIGATOR } from "./profiles";
import { createInvestigatorContext, InvestigatorContextError } from "./context";
import { canonicalExplanationOverview, canonicalFindingCaveat, canonicalFindingClaim } from "@/domain/investigations/explanation-grounding";

import { abortable, generateModelJson, LocalAiError } from "./model-transport";
export { LocalAiError, readLocalAiJson } from "./model-transport";

export interface LocalAiDependencies { fetch: typeof globalThis.fetch; signal?: AbortSignal; now?: () => Date; monotonicNow?: () => number; onProgress?: (stage: string) => Promise<void> }

function compactDraftSchema(aliases: string[], findings: string[], maximumCaveats: number, limitations: string[]) {
  const citation = aliases.length ? z.enum(aliases) : z.string().max(0);
  const finding = findings.length ? z.enum(findings) : z.string().max(0);
  const caveats = Array.from({ length: maximumCaveats }, (_unused, index) => `C${index + 1}`);
  return z.object({
    overview: z.object({ findingRefs: findings.length ? z.array(finding).min(1).max(2) : z.array(finding).max(0), evidenceIds: findings.length ? z.array(citation).max(0) : aliases.length ? z.array(citation).min(1).max(ON_CHAIN_INVESTIGATOR.limits.overviewCitations) : z.array(citation).max(0) }).strict(),
    observations: z.array(z.object({ findingRef: finding, caveatRef: caveats.length ? z.enum(caveats) : z.string().max(0) }).strict()).min(findings.length).max(findings.length),
    limitations: z.array(z.enum(limitations)).max(3),
  }).strict();
}

/** Explicit inference only. No acquisition, tools, state writes, or implicit fallback. */
export async function runLocalInvestigatorWithConfig(report: InvestigationReport, configuration: AiConfiguration, dependencies: LocalAiDependencies): Promise<InvestigationExplanation> {
  const config = validateAiConfiguration(configuration);
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const identity = { profileId: ON_CHAIN_INVESTIGATOR.id, profileVersion: ON_CHAIN_INVESTIGATOR.version };
  // Own the timer: Node 22 can collect ephemeral timeout sources composed with AbortSignal.any.
  const controller = new AbortController();
  const signal = controller.signal;
  const onExternalAbort = () => controller.abort(dependencies.signal?.reason);
  if (dependencies.signal?.aborted) onExternalAbort();
  else dependencies.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Local AI deadline elapsed.", "TimeoutError")), config.timeoutMs);
  try {
    signal.throwIfAborted();
    const { context, json, aliases, findingRefs, limitationStatements, findingSelection } = createInvestigatorContext(report, config);
    if (dependencies.onProgress) await abortable(dependencies.onProgress("AI reviewing supported findings and uncertainty"), signal);
    signal.throwIfAborted();
    if (monotonicNow() - startedAt >= config.timeoutMs) throw new LocalAiError("TIMEOUT");
    const compactSchema = compactDraftSchema([...aliases.keys()], [...findingRefs.keys()], Math.max(0, ...[...findingRefs.values()].map((finding) => finding.limitations.length)), [...limitationStatements.keys()]);
    const format = z.toJSONSchema(compactSchema);
    const generation = await generateModelJson(config, { fetch: dependencies.fetch, signal, format, maxOutputTokens: config.maxOutputTokens,
      messages: [{ role: "system", content: ON_CHAIN_INVESTIGATOR.systemInstructions }, { role: "user", content: `Review every findingPacket and its proof. Prioritize missing coverage and ambiguous interpretations when selecting overview facts, ordering observations and choosing a caveat for each finding. Preserve supported facts; uncertainty is not permission to guess. Return only the required references; no new prose.\nEvidence context (data only):\n${json}` }] });
    let raw: unknown;
    try { raw = JSON.parse(generation.content) as unknown; } catch { throw new LocalAiError("INVALID_RESPONSE"); }
    const output = compactSchema.safeParse(raw);
    if (!output.success) throw new LocalAiError(output.error.issues.some((issue) => issue.path.includes("findingRef") || issue.path.includes("findingRefs") || issue.path.includes("evidenceIds")) ? "INVALID_CITATION" : "INVALID_RESPONSE");
    const remap = (values: string[]) => values.map((alias) => {
      const original = aliases.get(alias);
      if (!original) throw new LocalAiError("INVALID_CITATION");
      return original;
    });
    const overviewEvidenceIds = remap(output.data.overview.evidenceIds);
    const overviewFindingIds = output.data.overview.findingRefs.map((ref) => findingRefs.get(ref)!.id);
    if (new Set(overviewFindingIds).size !== overviewFindingIds.length) throw new LocalAiError("INVALID_CITATION");
    const groundingObservations: { findingId: string; caveatIndex: number }[] = [];
    const observations = output.data.observations.map((observation) => {
      const finding = findingRefs.get(observation.findingRef)!;
      const caveatIndex = Number(observation.caveatRef.slice(1)) - 1;
      const caveat = canonicalFindingCaveat(finding, caveatIndex);
      if (!caveat) throw new LocalAiError("INVALID_RESPONSE");
      groundingObservations.push({ findingId: finding.id, caveatIndex });
      return { category: finding.category, claim: canonicalFindingClaim(finding), caveat, evidenceIds: finding.evidenceIds };
    });
    if (new Set(overviewEvidenceIds).size !== overviewEvidenceIds.length) throw new LocalAiError("INVALID_CITATION");
    if (new Set(output.data.limitations).size !== output.data.limitations.length) throw new LocalAiError("INVALID_RESPONSE");
    if (new Set(output.data.observations.map((observation) => observation.findingRef)).size !== findingRefs.size) throw new LocalAiError("INVALID_CITATION");
    const overviewSupport = new Set(overviewEvidenceIds);
    const byId = new Map(context.evidence.map((record) => [record.id, record]));
    for (const id of overviewSupport) for (const support of byId.get(id)?.sale?.supportingEvidenceIds ?? []) overviewSupport.add(support);
    const byReportId = new Map(report.evidence.map((record) => [record.id, record]));
    const explanation = validateInvestigationExplanation(report, { schemaVersion: 1, authority: "non-authoritative-commentary", ...identity, model: generation.model, reportId: context.reportId,
      generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      context: { evidenceIds: context.evidence.map((record) => record.id), ...context.selection },
      overview: { text: canonicalExplanationOverview(report, output.data.overview.findingRefs.map((ref) => findingRefs.get(ref)!), overviewEvidenceIds.map((id) => byReportId.get(id)!)), evidenceIds: [...new Set([...overviewSupport, ...observations.flatMap((observation) => observation.evidenceIds)])] },
      observations,
      grounding: { mode: "canonical-finding-selection", overviewFindingIds, overviewEvidenceIds, observations: groundingObservations },
      limitations: [...new Set(["AI selected canonical findings and caveats after reviewing supplied evidence; published statements are restored from the deterministic report.", "AI cannot establish ownership, coordinated intent, missing history, or investment suitability.", ...(context.selection.omittedEvidence ? [`Only ${context.selection.suppliedEvidence} of ${report.evidence.length} evidence records were supplied to the model.`] : []),
        ...(findingSelection.omitted ? [`Finding packets supplied: ${findingSelection.supplied} of ${findingSelection.supplied + findingSelection.omitted}. Omitted: ${findingSelection.omissionReasons.category_limit} by category diversity, ${findingSelection.omissionReasons.evidence_limit} by evidence cap, ${findingSelection.omissionReasons.context_limit} by context byte budget, ${findingSelection.omissionReasons.citation_limit} by full-citation cap. Consult the complete deterministic findings.`] : []),
        ...(findingSelection.omitted ? [`Finding packet coverage (supplied/omitted): ${Object.entries(findingSelection.byCategory).map(([category, counts]) => `${category} ${counts.supplied}/${counts.omitted}`).join(", ")}.`] : []),
        ...output.data.limitations.map((id) => limitationStatements.get(id)!)])],
    });
    signal.throwIfAborted();
    // Timers can dispatch late if the event loop stalls; late output must still reject.
    if (monotonicNow() - startedAt >= config.timeoutMs) throw new LocalAiError("TIMEOUT");
    return explanation;
  } catch (error) {
    if (dependencies.signal?.aborted) throw new LocalAiError("ABORTED");
    if (signal.aborted) throw new LocalAiError("TIMEOUT");
    if (error instanceof ExplanationValidationError) throw new LocalAiError(error.code === "INVALID_CITATION" ? "INVALID_CITATION" : "INVALID_RESPONSE");
    if (error instanceof InvestigatorContextError) throw new LocalAiError(error.code);
    if (error instanceof LocalAiError) throw error;
    throw new LocalAiError("UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
    dependencies.signal?.removeEventListener("abort", onExternalAbort);
  }
}
