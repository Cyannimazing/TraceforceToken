import { lookup } from "node:dns/promises";
import { z } from "zod";
import type { ScanEngineConfiguration } from "@/config/scan-engine";
import type { InvestigationReport, ScanParameters } from "@/domain/investigations/types";
import { AI_RATE_LIMIT_SCAN_MESSAGE, MAX_SCAN_REPORT_BYTES, MAX_SCAN_STREAM_BYTES, SCAN_RESPONSE_HEADERS, type ScanEvent } from "@/domain/investigations/scan";
import { sameInvestigationAnalysis, validateBaseInvestigationReport, validateExplainedReport } from "@/domain/investigations/report-validation";
import { createDeadline } from "@/lib/deadline";
import { HttpError } from "@/lib/http";
import { isPublicAddress } from "@/providers/base/config";

export type RemoteScanConfiguration = Extract<ScanEngineConfiguration, { mode: "remote" }>;
const envelope = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), stage: z.string().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/) }).strict(),
  z.object({ type: z.literal("analysis"), report: z.unknown() }).strict(),
  z.object({ type: z.literal("report"), report: z.unknown(), chatContext: z.string().min(1).max(32768).optional() }).strict(),
  z.object({ type: z.literal("error"), error: z.string().max(1024), code: z.literal("AI_RATE_LIMITED").optional() }).strict(),
]);

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

export async function validateScanEngineDestination(configuration: RemoteScanConfiguration) {
  if (configuration.localTest) return;
  const records = await lookup(new URL(configuration.url).hostname, { all: true });
  if (!records.length || records.some((record) => !isPublicAddress(record.address))) throw new Error("Prohibited scan engine destination.");
}

/** Validated, bounded private streaming transport; never caches a report. */
export async function proxyScanResponse(parameters: ScanParameters, configuration: RemoteScanConfiguration, parent: AbortSignal,
  dependencies: { fetch?: typeof fetch; validateDestination?: typeof validateScanEngineDestination; timeoutMilliseconds?: number } = {}): Promise<Response> {
  const disconnected = new AbortController();
  const deadline = createDeadline(dependencies.timeoutMilliseconds ?? 285_000, [parent, disconnected.signal]);
  const { signal } = deadline;
  let upstream: Response;
  try {
    await abortable((dependencies.validateDestination ?? validateScanEngineDestination)(configuration), signal);
    upstream = await abortable((dependencies.fetch ?? fetch)(configuration.url, {
      method: "POST", redirect: "error", cache: "no-store", signal,
      headers: { "content-type": "application/json", accept: "application/x-ndjson", authorization: `Bearer ${configuration.secret}` },
      body: JSON.stringify(parameters),
    }), signal);
    if (upstream.status === 429) throw new HttpError(429, "The investigation engine is busy. Please try again shortly.");
    if (!upstream.ok || upstream.redirected || !upstream.body || upstream.headers.get("content-type")?.split(";", 1)[0] !== "application/x-ndjson") throw new Error("The scan engine is unavailable.");
  } catch (error) { deadline.dispose(); disconnected.abort(); throw error; }
  const reader = upstream.body!.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let ended = false;
  let rawBytes = 0;
  let outputBytes = 0;
  let events = 0;
  let pending = "";
  let analysis: InvestigationReport | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: ScanEvent) => {
        const chunk = encoder.encode(`${JSON.stringify(event)}\n`);
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_SCAN_STREAM_BYTES) throw new Error("Scan output limit exceeded.");
        controller.enqueue(chunk);
      };
      const line = (value: string) => {
        if (!value || Buffer.byteLength(value, "utf8") > MAX_SCAN_REPORT_BYTES + 33792 || ++events > 256) throw new Error("Invalid scan frame.");
        const event = envelope.parse(JSON.parse(value));
        if (event.type === "analysis") {
          if (analysis) throw new Error("Duplicate analysis preview.");
          analysis = validateBaseInvestigationReport(event.report);
          if (analysis.token.address !== parameters.token) throw new Error("Mismatched scan preview.");
          emit({ type: "analysis", report: analysis });
        } else if (event.type === "report") {
          const report = validateExplainedReport(event.report);
          if (report.token.address !== parameters.token || (analysis && !sameInvestigationAnalysis(analysis, report))) throw new Error("Mismatched scan report.");
          emit({ type: "report", report, ...(event.chatContext ? { chatContext: event.chatContext } : {}) }); ended = true;
        } else if (event.type === "error") {
          emit(event.code === "AI_RATE_LIMITED" ? { type: "error", code: "AI_RATE_LIMITED", error: AI_RATE_LIMIT_SCAN_MESSAGE }
            : { type: "error", error: "The investigation could not finish. Please try again shortly." }); ended = true;
        } else emit(event);
      };
      void (async () => {
        try {
          while (!ended) {
            const chunk = await abortable(reader.read(), signal);
            if (chunk.done) { pending += decoder.decode(); if (pending) line(pending); if (!ended) throw new Error("Missing scan result."); break; }
            rawBytes += chunk.value.byteLength;
            if (rawBytes > MAX_SCAN_STREAM_BYTES) throw new Error("Scan input limit exceeded.");
            pending += decoder.decode(chunk.value, { stream: true });
            let boundary: number;
            while (!ended && (boundary = pending.indexOf("\n")) >= 0) { const value = pending.slice(0, boundary); pending = pending.slice(boundary + 1); line(value); }
            if (pending.length > MAX_SCAN_REPORT_BYTES + 33792) throw new Error("Scan frame limit exceeded.");
          }
        } catch {
          if (!disconnected.signal.aborted && !ended) emit({ type: "error", error: "The investigation connection ended. Please start a fresh scan." });
        } finally {
          ended = true;
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
          deadline.dispose();
          if (!disconnected.signal.aborted) controller.close();
          disconnected.abort();
        }
      })().catch(() => { disconnected.abort(); });
    },
    cancel(reason) { ended = true; disconnected.abort(reason); void reader.cancel(reason).catch(() => undefined); },
  });
  return new Response(body, { headers: SCAN_RESPONSE_HEADERS });
}
