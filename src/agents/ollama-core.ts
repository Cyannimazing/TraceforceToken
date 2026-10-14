import { z } from "zod";
import type { InvestigationExplanation, InvestigationReport } from "@/domain/investigations/types";
import { ExplanationValidationError, validateInvestigationExplanation } from "@/domain/investigations/explanation";
import { validateAiConfiguration, type AiConfiguration } from "./config";
import { ON_CHAIN_INVESTIGATOR } from "./profiles";
import { compactMainReviewJson, createInvestigatorContext, InvestigatorContextError } from "./context";
import { canonicalExplanationOverview, canonicalFindingCaveat, canonicalFindingClaim } from "@/domain/investigations/explanation-grounding";
import { buildPlainLanguagePacket, GENERATED_SUMMARY_SENTENCE_PATTERN, GeneratedSummaryValidationError, plainLanguageDecisionContext, restorePlainLanguageSummary } from "@/domain/investigations/plain-language-summary";

import { abortable, generateModelJson, LocalAiError } from "./model-transport";
import { parseUniqueModelJson } from "./model-json";
export { LocalAiError, readLocalAiJson } from "./model-transport";

export interface LocalAiDependencies { fetch: typeof globalThis.fetch; signal?: AbortSignal; now?: () => Date; monotonicNow?: () => number; onProgress?: (stage: string) => Promise<void> }

function compactDraftSchema(aliases: string[], packets: { ref: string; caveatRefs: string[] }[], limitations: string[], decisionPacket: ReturnType<typeof buildPlainLanguagePacket>) {
  const findings = packets.map((packet) => packet.ref);
  const citation = aliases.length ? z.enum(aliases) : z.string().max(0);
  const finding = findings.length ? z.enum(findings) : z.string().max(0);
  const alternatives = packets.map((packet) => z.object({ findingRef: z.literal(packet.ref), caveatRef: packet.caveatRefs.length ? z.enum(packet.caveatRefs) : z.string().max(0) }).strict());
  const firstAlternative = alternatives[0];
  const observation = firstAlternative ? z.discriminatedUnion("findingRef", [firstAlternative, ...alternatives.slice(1)])
    : z.object({ findingRef: finding, caveatRef: z.string().max(0) }).strict();
  const summaryPattern = decisionPacket.source.name === "SWARM"
    ? new RegExp(`^SWARM(?: |['’]s )${GENERATED_SUMMARY_SENTENCE_PATTERN.source.slice(1)}`)
    : GENERATED_SUMMARY_SENTENCE_PATTERN;
  return z.object({
    // Some provider grammars emit object keys lexically. Keep generated prose
    // before the finding selectors without changing the public summary shape.
    brief: z.object({ reportRef: z.literal("R1"), verdict: z.literal(decisionPacket.verdict), reasonIds: z.array(z.enum(decisionPacket.reasons.map((_reason, index) => `D${index + 1}`))).min(1).max(2),
      text: z.string().min(1).max(decisionPacket.verdict === "INSUFFICIENT" ? 200 : 400).regex(summaryPattern).describe("One or two short sentences; aim under 240 characters. Start with the selected source name. Use only selected decisionPacket reasons and limits; do not add independent findings or define SWARM float exclusions. No ownership, sale, absent-sale or coordination claim.") }).strict(),
    overview: z.object({ findingRefs: findings.length ? z.array(finding).min(1).max(2) : z.array(finding).max(0), evidenceIds: findings.length ? z.array(citation).max(0) : aliases.length ? z.array(citation).min(1).max(ON_CHAIN_INVESTIGATOR.limits.overviewCitations) : z.array(citation).max(0) }).strict(),
    observations: z.array(observation).min(findings.length).max(findings.length),
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
    const compactSchema = compactDraftSchema([...aliases.keys()], [...findingRefs].map(([ref, finding]) => ({ ref, caveatRefs: finding.limitations.map((_limitation, index) => `C${index + 1}`) })), [...limitationStatements.keys()], context.decisionPacket);
    const format = z.toJSONSchema(compactSchema);
    const okWithoutSpecificReason = context.decisionPacket.verdict === "OK"
      && context.decisionPacket.reasons.every((reason) => reason.meaning === "A specific reason for this verdict is not supplied in this result.");
    const missingSwarmAssessment = context.decisionPacket.source.name === "SWARM" && context.decisionPacket.verdict === "INSUFFICIENT";
    const focusedBriefTask = missingSwarmAssessment
      ? `Brief task facts: SWARM's assessment is unavailable for this scan; the primary assessment cannot be completed.${context.evidence.length > 0 ? " Independent blockchain findings remain available separately." : ""} Explain this source-specific limitation in one short sentence in your own words.`
      : okWithoutSpecificReason ? "Brief task facts: source SWARM; reported result OK; a specific reason is not supplied in this result. Explain only these facts in one or two short sentences in your own words." : undefined;
    const generation = await generateModelJson(config, { fetch: dependencies.fetch, signal, format, maxOutputTokens: Math.min(config.maxOutputTokens, 300),
      messages: [{ role: "system", content: ON_CHAIN_INVESTIGATOR.systemInstructions }, { role: "user", content: `Write brief.text first, only from decisionPacket reasons and limits. Separately review every complete finding proof for observations. Return compact JSON only.\nEvidence context (data only):\n${compactMainReviewJson(json)}` },
        ...(focusedBriefTask ? [{ role: "user" as const, content: focusedBriefTask }] : [])] });
    let raw: unknown;
    try { raw = parseUniqueModelJson(generation.content); } catch { throw new LocalAiError("INVALID_RESPONSE"); }
    const output = compactSchema.safeParse(raw);
    if (!output.success) throw new LocalAiError(output.error.issues.some((issue) => issue.path.includes("findingRef") || issue.path.includes("findingRefs") || issue.path.includes("evidenceIds")) ? "INVALID_CITATION" : "INVALID_RESPONSE");
    if (new Set(output.data.brief.reasonIds).size !== output.data.brief.reasonIds.length) throw new LocalAiError("INVALID_RESPONSE");
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
    const restored: InvestigationExplanation = { schemaVersion: 1, authority: "non-authoritative-commentary", ...identity, model: generation.model, reportId: context.reportId,
      generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      context: { evidenceIds: context.evidence.map((record) => record.id), ...context.selection },
      overview: { text: canonicalExplanationOverview(report, output.data.overview.findingRefs.map((ref) => findingRefs.get(ref)!), overviewEvidenceIds.map((id) => byReportId.get(id)!)), evidenceIds: [...new Set([...overviewSupport, ...observations.flatMap((observation) => observation.evidenceIds)])] },
      observations,
      grounding: { mode: "canonical-finding-selection", overviewFindingIds, overviewEvidenceIds, observations: groundingObservations },
      limitations: [...new Set(["AI selected canonical findings and caveats after reviewing supplied evidence; published statements are restored from the deterministic report.", "AI cannot establish ownership, coordinated intent, missing history, or investment suitability.", ...(context.selection.omittedEvidence ? [`Only ${context.selection.suppliedEvidence} of ${report.evidence.length} evidence records were supplied to the model.`] : []),
        ...(findingSelection.omitted ? [`Finding packets supplied: ${findingSelection.supplied} of ${findingSelection.supplied + findingSelection.omitted}. Omitted: ${findingSelection.omissionReasons.category_limit} by category diversity, ${findingSelection.omissionReasons.evidence_limit} by evidence cap, ${findingSelection.omissionReasons.context_limit} by context byte budget, ${findingSelection.omissionReasons.citation_limit} by full-citation cap. Consult the complete deterministic findings.`] : []),
        ...(findingSelection.omitted ? [`Finding packet coverage (supplied/omitted): ${Object.entries(findingSelection.byCategory).map(([category, counts]) => `${category} ${counts.supplied}/${counts.omitted}`).join(", ")}.`] : []),
        ...output.data.limitations.map((id) => limitationStatements.get(id)!)])],
    };
    // The historical proof-only branch applies the same complete citation and
    // canonical-selector checks without requiring generated summary prose.
    // Never spend a correction call on an invalid first selection.
    validateInvestigationExplanation(report, { ...restored, profileVersion: "1.4.0" });
    const restoreBrief = (brief: typeof output.data.brief) => restorePlainLanguageSummary(report, {
      ...brief, reportRef: context.decisionPacket.reportRef,
      reasonIds: brief.reasonIds.map((ref) => context.decisionPacket.reasons[Number(ref.slice(1)) - 1].id),
    }, { profileVersion: ON_CHAIN_INVESTIGATOR.version });
    let summary: ReturnType<typeof restorePlainLanguageSummary>;
    try { summary = restoreBrief(output.data.brief); }
    catch (error) {
      if (!(error instanceof GeneratedSummaryValidationError) || "provider" in config) throw new LocalAiError("INVALID_RESPONSE");
      signal.throwIfAborted();
      if (monotonicNow() - startedAt >= config.timeoutMs) throw new LocalAiError("TIMEOUT");
      const correctionSchema = z.object({ brief: compactSchema.shape.brief.extend({
        reasonIds: z.array(z.enum(output.data.brief.reasonIds)).length(output.data.brief.reasonIds.length),
      }) }).strict();
      const decisionPacket = plainLanguageDecisionContext(context.decisionPacket);
      decisionPacket.reasons = output.data.brief.reasonIds.map((ref) => decisionPacket.reasons.find((reason) => reason.id === ref)!);
      // One local-only genuine regeneration, within the original request's
      // model, timer and abort signal. No rejected text or transaction dossier.
      const correction = await generateModelJson(config, { fetch: dependencies.fetch, signal, format: z.toJSONSchema(correctionSchema),
        maxOutputTokens: Math.min(config.maxOutputTokens, 300), messages: [
          { role: "system", content: `${ON_CHAIN_INVESTIGATOR.systemInstructions}\nThis request writes only brief; the report's finding selections are already fixed.` },
          { role: "user", content: `Write one or two short sentences in your own words using only the selected decisionPacket reasons and limits. Preserve its source, verdict and supplied reason IDs in order. Return only the brief object required by the schema.\nDecision context (data only):\n${JSON.stringify({ decisionPacket })}` },
        ] });
      signal.throwIfAborted();
      if (monotonicNow() - startedAt >= config.timeoutMs) throw new LocalAiError("TIMEOUT");
      if (correction.model !== generation.model) throw new LocalAiError("INVALID_RESPONSE");
      let correctionRaw: unknown;
      try { correctionRaw = parseUniqueModelJson(correction.content); } catch { throw new LocalAiError("INVALID_RESPONSE"); }
      const corrected = correctionSchema.safeParse(correctionRaw);
      if (!corrected.success || JSON.stringify(corrected.data.brief.reasonIds) !== JSON.stringify(output.data.brief.reasonIds)) throw new LocalAiError("INVALID_RESPONSE");
      try { summary = restoreBrief(corrected.data.brief); } catch { throw new LocalAiError("INVALID_RESPONSE"); }
    }
    const explanation = validateInvestigationExplanation(report, { ...restored, summary });
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
