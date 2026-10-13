import type { ExplainedInvestigationReport, InvestigationDataset, InvestigationExplanation, InvestigationReport, ScanParameters } from "@/domain/investigations/types";
import { analyzeInvestigation } from "@/domain/investigations/analyze";
import { validateInvestigationExplanation } from "@/domain/investigations/explanation";
import type { InvestigationRepository } from "@/repositories/investigations";
import { createDeadline } from "@/lib/deadline";

type Collector = (parameters: ScanParameters, options: { signal: AbortSignal; onProgress: (stage: string) => Promise<void> }) => Promise<InvestigationDataset>;

/** Cancel the orchestration even if an adapter ignores its signal. Promise.race
 * retains a rejection handler on abandoned work, avoiding unhandled rejections. */
async function untilAborted<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    });
    return await Promise.race([pending, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function runNextInvestigation(options: {
  repository: InvestigationRepository;
  collect: Collector;
  explain: (report: InvestigationReport, options: { signal: AbortSignal; onProgress: (stage: string) => Promise<void> }) => Promise<InvestigationExplanation>;
  analyze?: (dataset: InvestigationDataset, context: { id: string; generatedAt: string }) => InvestigationReport;
  signal?: AbortSignal;
  heartbeatMilliseconds?: number;
  deadlineMilliseconds?: number;
}) {
  const { repository } = options;
  const claimed = await repository.claimNext({ leaseSeconds: 120, maxAttempts: 3 });
  if (!claimed) return { status: "idle" as const };
  const { job, leaseToken } = claimed;
  const controller = new AbortController();
  const deadline = createDeadline(options.deadlineMilliseconds ?? 270_000, [controller.signal, ...(options.signal ? [options.signal] : [])]);
  const { signal } = deadline;
  let leaseLost = false;
  let stage = "Collecting finalized Base evidence";
  let pendingHeartbeat: Promise<void> | null = null;
  const heartbeat = async (nextStage = stage) => {
    // An expired/cancelled attempt must stop extending ownership even if an
    // acquisition promise has not yet observed cancellation.
    signal.throwIfAborted();
    stage = nextStage;
    try {
      if (!await repository.heartbeat(job.id, leaseToken, stage, 120)) {
        leaseLost = true;
        controller.abort(new Error("Job lease was lost."));
      }
    } catch {
      leaseLost = true;
      controller.abort(new Error("Job lease could not be renewed."));
    }
    signal.throwIfAborted();
  };
  const timer = setInterval(() => {
    if (pendingHeartbeat) return;
    pendingHeartbeat = heartbeat().catch(() => undefined).finally(() => { pendingHeartbeat = null; });
  }, options.heartbeatMilliseconds ?? 20_000);
  timer.unref();
  const stopHeartbeat = () => clearInterval(timer);
  signal.addEventListener("abort", stopHeartbeat, { once: true });
  if (signal.aborted) stopHeartbeat();
  try {
    await heartbeat();
    const dataset = await untilAborted(() => options.collect(job.parameters, { signal, onProgress: heartbeat }), signal);
    signal.throwIfAborted();
    await heartbeat("Analyzing evidence and coverage");
    const report = (options.analyze ?? analyzeInvestigation)(dataset, { id: job.id, generatedAt: new Date().toISOString() });
    signal.throwIfAborted();
    await heartbeat("Rewriting evidence in plain English");
    const explanation = await untilAborted(() => options.explain(report, { signal, onProgress: heartbeat }), signal);
    signal.throwIfAborted();
    await heartbeat("Saving evidence and explanation");
    const explainedReport: ExplainedInvestigationReport = { ...report, explanation: validateInvestigationExplanation(report, explanation) };
    if (!await repository.complete(job.id, leaseToken, explainedReport)) return { status: "lost_lease" as const, jobId: job.id };
    return { status: "completed" as const, jobId: job.id };
  } catch {
    if (leaseLost) return { status: "lost_lease" as const, jobId: job.id };
    const accepted = await repository.fail(job.id, leaseToken, "Investigation could not be completed. Check provider availability and configuration.");
    if (!accepted) return { status: "lost_lease" as const, jobId: job.id };
    const updated = await repository.get(job.id);
    return { status: updated?.status === "failed" ? "failed" as const : "retrying" as const, jobId: job.id };
  } finally {
    stopHeartbeat();
    signal.removeEventListener("abort", stopHeartbeat);
    // The timer already owns a catch handler. Do not prolong cancellation by
    // waiting for an in-flight database renewal that cannot itself be aborted.
    try { if (pendingHeartbeat && !signal.aborted) await pendingHeartbeat; }
    finally { deadline.dispose(); }
  }
}
