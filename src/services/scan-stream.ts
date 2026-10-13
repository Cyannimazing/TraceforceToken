import { randomUUID } from "node:crypto";
import type { ExplainedInvestigationReport, InvestigationDataset, InvestigationExplanation, InvestigationReport, ScanParameters } from "@/domain/investigations/types";
import { MAX_SCAN_REPORT_BYTES, MAX_SCAN_STREAM_BYTES, SCAN_RESPONSE_HEADERS, type ScanEvent } from "@/domain/investigations/scan";
import { analyzeInvestigation } from "@/domain/investigations/analyze";
import { validateBaseInvestigationReport, validateExplainedReport } from "@/domain/investigations/report-validation";
import { createDeadline } from "@/lib/deadline";
import { getScanCapacity, type ScanCapacity } from "./scan-capacity";
import { TokenContractNotFoundError } from "@/providers/base/errors";

interface OperationOptions { signal: AbortSignal; onProgress: (stage: string) => Promise<void> }
export interface ScanDependencies {
  collect: (parameters: ScanParameters, options: OperationOptions) => Promise<InvestigationDataset>;
  explain: (report: InvestigationReport, options: OperationOptions) => Promise<InvestigationExplanation>;
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
  const capacity = dependencies.capacity ?? getScanCapacity();
  const leave = capacity.enter();
  const disconnected = new AbortController();
  const deadline = createDeadline(dependencies.deadlineMilliseconds ?? 270_000, [disconnected.signal, ...(parent ? [parent] : [])]);
  const { signal } = deadline;
  const encoder = new TextEncoder();
  let bytes = 0;
  let ended = false;
  let stage = "Starting a fresh Base investigation";
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
        try {
          await progress(stage);
          const dataset = await abortable(() => dependencies.collect(parameters, { signal, onProgress: progress }), signal);
          await progress("Analyzing the freshly collected evidence");
          const report = validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: randomUUID(), generatedAt: new Date().toISOString() }));
          if (report.token.address !== parameters.token) throw new Error("Mismatched scan token.");
          // Keep the existing aggregate response cap and reserve room for the
          // largest final report, signed chat context, progress and error frames.
          const previewBytes = encoder.encode(`${JSON.stringify({ type: "analysis", report })}\n`).byteLength;
          if (bytes + previewBytes <= MAX_SCAN_STREAM_BYTES - MAX_SCAN_REPORT_BYTES - 65_536) emit({ type: "analysis", report });
          await progress("Waiting for the AI explanation slot");
          releaseExplanation = await capacity.explanation(signal);
          await progress("Writing the plain English investigation explanation");
          const explanation = await abortable(() => dependencies.explain(report, { signal, onProgress: progress }), signal);
          signal.throwIfAborted();
          const result = validateExplainedReport({ ...report, explanation });
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SCAN_REPORT_BYTES) throw new Error("Scan report budget exceeded.");
          const chatContext = dependencies.createChatContext?.(result);
          emit({ type: "report", report: result, ...(chatContext ? { chatContext } : {}) });
        } catch (error) {
          emit({ type: "error", error: signal.aborted && !parent?.aborted && !disconnected.signal.aborted
            ? "This scan exceeded its time limit. Try a smaller block window."
            : error instanceof TokenContractNotFoundError
              ? "No contract found on Base at the finalized block. Check the network and address. New tokens may need time to finalize."
              : "The investigation could not finish. Check the token address or try again shortly." });
        } finally {
          releaseExplanation?.();
          ended = true;
          clearInterval(heartbeat);
          deadline.dispose();
          leave();
          if (!disconnected.signal.aborted) controller.close();
        }
      })().catch(() => { disconnected.abort(); });
    },
    cancel(reason) { ended = true; disconnected.abort(reason); },
  });
  return new Response(body, { headers: SCAN_RESPONSE_HEADERS });
}
