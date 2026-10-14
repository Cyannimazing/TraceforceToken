import { randomUUID } from "node:crypto";
import type { Address, ExplainedInvestigationReport, InvestigationDataset, InvestigationExplanation, InvestigationReport, ScanParameters } from "@/domain/investigations/types";
import { AI_RATE_LIMIT_SCAN_MESSAGE, MAX_SCAN_REPORT_BYTES, MAX_SCAN_STREAM_BYTES, SCAN_RESPONSE_HEADERS, type ScanEvent } from "@/domain/investigations/scan";
import { LocalAiError } from "@/agents/model-transport";
import { analyzeInvestigation } from "@/domain/investigations/analyze";
import { validateBaseInvestigationReport, validateExplainedReport } from "@/domain/investigations/report-validation";
import { createDeadline } from "@/lib/deadline";
import { getScanCapacity, type ScanCapacity } from "./scan-capacity";
import { ProviderDeadlineError, ProviderIntegrityError, TokenContractNotFoundError, UpstreamFailure } from "@/providers/base/errors";
import { validateSwarmAssessmentSnapshot, type SwarmAssessmentSnapshot } from "@/domain/investigations/swarm-assessment";
import { validateProviderEnrichmentBundle, type ProviderEnrichmentBundle } from "@/domain/investigations/provider-enrichment";
import { resolveInvestigationNetwork } from "@/domain/investigations/networks";
import { SwarmProviderError } from "@/providers/swarm/core";

interface OperationOptions { signal: AbortSignal; onProgress: (stage: string) => Promise<void>; candidateAddresses?: Promise<readonly Address[]> }
export interface ScanDependencies {
  collect: (parameters: ScanParameters, options: OperationOptions) => Promise<InvestigationDataset>;
  explain: (report: InvestigationReport, options: OperationOptions) => Promise<InvestigationExplanation>;
  assess?: (token: ScanParameters["token"], signal: AbortSignal) => Promise<SwarmAssessmentSnapshot>;
  enrich?: (token: ScanParameters["token"], signal: AbortSignal) => Promise<ProviderEnrichmentBundle>;
  capacity?: ScanCapacity;
  deadlineMilliseconds?: number;
  heartbeatMilliseconds?: number;
  createChatContext?: (report: ExplainedInvestigationReport) => string;
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }),
      new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); }),
    ]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

/** Fresh acquisition and mandatory inference for this response. No persistence dependency. */
export function createScanResponse(parameters: ScanParameters, dependencies: ScanDependencies, parent?: AbortSignal): Response {
  parent?.throwIfAborted();
  resolveInvestigationNetwork(parameters.chain);
  const capacity = dependencies.capacity ?? getScanCapacity();
  const leave = capacity.enter();
  const disconnected = new AbortController();
  const deadline = createDeadline(dependencies.deadlineMilliseconds ?? 270_000, [disconnected.signal, ...(parent ? [parent] : [])]);
  const { signal } = deadline;
  const encoder = new TextEncoder();
  let bytes = 0;
  let ended = false;
  let stage = "Starting a fresh Base investigation";
  let explanationStarted = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      function emit(event: ScanEvent) {
        if (ended || disconnected.signal.aborted) return;
        const chunk = encoder.encode(`${JSON.stringify(event)}\n`);
        bytes += chunk.byteLength;
        if (bytes > MAX_SCAN_STREAM_BYTES) throw new Error("Scan response budget exceeded.");
        controller.enqueue(chunk);
      }
      const progress = async (next: string) => {
        signal.throwIfAborted();
        if (!next.trim() || next.length > 120 || /[^\x20-\x7e]/.test(next)) throw new Error("Invalid scan stage.");
        stage = next;
        emit({ type: "progress", stage });
      };
      const heartbeat = setInterval(() => { try { emit({ type: "progress", stage }); } catch { disconnected.abort(); } }, dependencies.heartbeatMilliseconds ?? 10_000);
      heartbeat.unref();
      void (async () => {
        let releaseExplanation: (() => void) | undefined;
        let swarmAvailability: InvestigationReport["swarmAvailability"];
        try {
          await progress(stage);
          const external = Promise.all([
            dependencies.assess ? abortable(async () => {
              try { return validateSwarmAssessmentSnapshot(await dependencies.assess!(parameters.token, signal), parameters.token); }
              catch (error) {
                signal.throwIfAborted();
                const reasons: Partial<Record<SwarmProviderError["code"], NonNullable<InvestigationReport["swarmAvailability"]>["reason"]>> = {
                  TIMEOUT: "timeout", RATE_LIMITED: "rate_limited", ACCESS_DENIED: "access_denied", STALE_RESULT: "stale_result",
                  INVALID_RESPONSE: "invalid_response", IDENTITY_MISMATCH: "identity_mismatch", JOB_FAILED: "job_failed",
                };
                swarmAvailability = { status: "unavailable", reason: error instanceof SwarmProviderError ? reasons[error.code] ?? "unavailable" : "unavailable", checkedAt: new Date().toISOString() };
                return undefined;
              }
            }, signal) : undefined,
            dependencies.enrich ? abortable(async () => {
              try { return validateProviderEnrichmentBundle(await dependencies.enrich!(parameters.token, signal), parameters.token); }
              catch { signal.throwIfAborted(); return undefined; }
            }, signal) : undefined,
          ]);
          const candidateAddresses = external.then(([source, enrichment]) => [...new Set([
            ...(source?.candidates?.map((candidate) => candidate.address) ?? []),
            ...(enrichment?.sources.flatMap((provider) => provider.candidates.map((candidate) => candidate.address)) ?? []),
          ])].slice(0, 512) as Address[]).catch(() => [] as Address[]);
          const [dataset, [swarmAssessment, providerEnrichment]] = await Promise.all([
            abortable(() => dependencies.collect(parameters, { signal, onProgress: progress, candidateAddresses }), signal), external,
          ]);
          await progress("Analyzing the freshly collected evidence");
          const report = validateBaseInvestigationReport({ ...analyzeInvestigation(dataset, { id: randomUUID(), generatedAt: new Date().toISOString() }),
            ...(dependencies.assess ? { assessmentAuthority: "swarm" as const } : {}), ...(swarmAssessment ? { swarmAssessment } : {}),
            ...(swarmAvailability ? { swarmAvailability } : {}), ...(providerEnrichment ? { providerEnrichment } : {}) });
          if (dependencies.assess && !swarmAssessment) report.coverage.warnings.push("SWARM context was unavailable for this scan. TraceForge assessed the acquired on-chain records.");
          if (new Set([...(swarmAssessment?.candidates?.map((candidate) => candidate.address) ?? []), ...(providerEnrichment?.sources.flatMap((source) => source.candidates.map((candidate) => candidate.address)) ?? [])]).size > 512)
            report.coverage.warnings.push("External discovery was limited to 512 candidate addresses; additional source candidates were not independently checked.");
          if (swarmAssessment?.candidatesTruncated || providerEnrichment?.sources.some((source) => source.coverage.limitReached))
            report.coverage.warnings.push("An external source limited its candidate list. Additional addresses may be missing from this scan.");
          if (report.token.address !== parameters.token) throw new Error("Mismatched scan token.");
          // Keep the existing aggregate response cap and reserve room for the
          // largest final report, signed chat context, progress and error frames.
          const previewBytes = encoder.encode(`${JSON.stringify({ type: "analysis", report })}\n`).byteLength;
          if (bytes + previewBytes <= MAX_SCAN_STREAM_BYTES - MAX_SCAN_REPORT_BYTES - 65_536) emit({ type: "analysis", report });
          await progress("Waiting for the AI explanation slot");
          explanationStarted = true;
          releaseExplanation = await capacity.explanation(signal);
          await progress("Writing the plain English investigation explanation");
          const explanation = await abortable(() => dependencies.explain(report, { signal, onProgress: progress }), signal);
          signal.throwIfAborted();
          const result = validateExplainedReport({ ...report, explanation });
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SCAN_REPORT_BYTES) throw new Error("Scan report budget exceeded.");
          const chatContext = dependencies.createChatContext?.(result);
          emit({ type: "report", report: result, ...(chatContext ? { chatContext } : {}) });
        } catch (error) {
          const aiRateLimited = !signal.aborted && explanationStarted && error instanceof LocalAiError && error.code === "RATE_LIMITED";
          emit({ type: "error", error: signal.aborted && !parent?.aborted && !disconnected.signal.aborted
            ? "This scan exceeded its time limit. Try a smaller block window."
            : error instanceof ProviderDeadlineError
              ? "The blockchain checks took too long. Try again or choose a recent history window in Scan settings."
            : error instanceof TokenContractNotFoundError
              ? "No contract found on Base at the finalized block. Check the network and address. New tokens may need time to finalize."
              : aiRateLimited ? AI_RATE_LIMIT_SCAN_MESSAGE : explanationStarted
                ? "The evidence is ready, but the AI explanation could not finish. Please retry this scan."
                : error instanceof ProviderIntegrityError
                  ? "The returned blockchain data could not be verified. Please retry this scan."
                  : error instanceof UpstreamFailure
                    ? "The blockchain data provider is unavailable. Please try again shortly."
                    : "The investigation could not finish. Please try again shortly.", ...(aiRateLimited ? { code: "AI_RATE_LIMITED" as const } : {}) });
        } finally {
          releaseExplanation?.();
          ended = true;
          clearInterval(heartbeat);
          const wasDisconnected = disconnected.signal.aborted;
          // Cancel sibling acquisition if the other source or inference failed.
          disconnected.abort();
          deadline.dispose();
          leave();
          if (!wasDisconnected) controller.close();
        }
      })().catch(() => { disconnected.abort(); });
    },
    cancel(reason) { ended = true; disconnected.abort(reason); },
  });
  return new Response(body, { headers: SCAN_RESPONSE_HEADERS });
}
