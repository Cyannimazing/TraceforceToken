import { z } from "@/lib/validation";
import { AI_RATE_LIMIT_SCAN_MESSAGE } from "@/domain/investigations/scan";
import type { ExplainedInvestigationReport, InvestigationReport } from "@/domain/investigations/types";
import { sameInvestigationAnalysis, validateBaseInvestigationReport, validateExplainedReport } from "@/domain/investigations/report-validation";

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const safeText = (maximum: number) => z.string().min(1).max(maximum).regex(/^[\x20-\x7e]+$/).refine((value) => Boolean(value.trim()));
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), stage: safeText(120) }).strict(),
  z.object({ type: z.literal("analysis"), report: z.unknown() }).strict(),
  z.object({ type: z.literal("report"), report: z.unknown(), chatContext: z.string().min(1).max(32768).regex(/^[\x21-\x7e]+$/).optional() }).strict(),
  z.object({ type: z.literal("error"), error: safeText(240), code: z.literal("AI_RATE_LIMITED").optional() }).strict(),
]);

export class InvestigationStreamError extends Error {
  constructor(message = "The investigation response was incomplete or invalid. Start a fresh investigation.", public readonly code?: "AI_RATE_LIMITED") { super(message); this.name = "InvestigationStreamError"; }
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

/** The current request is the only source of results. Nothing is persisted or recovered here. */
export async function readInvestigationStream(response: Response, options: { signal: AbortSignal; onProgress: (stage: string) => void; onAnalysis?: (report: InvestigationReport) => void }): Promise<{ report: ExplainedInvestigationReport; chatContext?: string }> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_STREAM_BYTES)) { void response.body?.cancel().catch(() => undefined); throw new InvestigationStreamError("The investigation response exceeded its size limit."); }
  const reader = response.body?.getReader();
  if (!reader) throw new InvestigationStreamError();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, buffered = "", messages = 0;
  let analysis: InvestigationReport | undefined;
  const consume = (line: string): { report: ExplainedInvestigationReport; chatContext?: string } | undefined => {
    if (!line.trim()) return;
    if (++messages > 2048) throw new InvestigationStreamError("The investigation response exceeded its event limit.");
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new InvestigationStreamError(); }
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) throw new InvestigationStreamError();
    if (parsed.data.type === "progress") { options.onProgress(parsed.data.stage); return; }
    if (parsed.data.type === "error") throw new InvestigationStreamError(parsed.data.code === "AI_RATE_LIMITED" ? AI_RATE_LIMIT_SCAN_MESSAGE : parsed.data.error, parsed.data.code);
    try {
      if (parsed.data.type === "analysis") {
        if (analysis) throw new Error();
        analysis = validateBaseInvestigationReport(parsed.data.report);
        options.onAnalysis?.(analysis);
        return;
      }
      const report = validateExplainedReport(parsed.data.report);
      if (analysis && !sameInvestigationAnalysis(analysis, report)) throw new Error();
      return { report, ...(parsed.data.chatContext ? { chatContext: parsed.data.chatContext } : {}) };
    } catch { throw new InvestigationStreamError("The investigation report could not be validated. Start a fresh investigation."); }
  };
  try {
    if (!response.ok) {
      for (;;) {
        const chunk = await readChunk(reader, options.signal); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > 4096) throw new InvestigationStreamError("The investigation could not start. Please try again.");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      buffered += decoder.decode();
      let value: unknown;
      try { value = JSON.parse(buffered); } catch { throw new InvestigationStreamError("The investigation could not start. Please try again."); }
      const error = z.object({ error: safeText(240) }).strict().safeParse(value);
      throw new InvestigationStreamError(error.success ? error.data.error : "The investigation could not start. Please try again.");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-ndjson") throw new InvestigationStreamError();
    for (;;) {
      const chunk = await readChunk(reader, options.signal);
      if (chunk.done) {
        buffered += decoder.decode();
        const result = consume(buffered); if (result) return result;
        throw new InvestigationStreamError();
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new InvestigationStreamError("The investigation response exceeded its size limit.");
      buffered += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf("\n"); if (newline < 0) break;
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        const result = consume(line); if (result) return result;
      }
    }
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (error instanceof InvestigationStreamError) throw error;
    throw new InvestigationStreamError();
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
