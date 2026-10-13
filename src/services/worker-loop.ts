export interface WorkerAttemptResult {
  status: "idle" | "completed" | "retrying" | "failed" | "lost_lease";
  jobId?: string;
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** One awaited attempt at a time. Cancellation also wakes an idle poll promptly. */
export async function runInvestigationWorkerLoop(options: {
  runOnce: (signal: AbortSignal) => Promise<WorkerAttemptResult>;
  signal: AbortSignal;
  pollMilliseconds?: number;
  onResult?: (result: WorkerAttemptResult) => void;
}): Promise<void> {
  const pollMilliseconds = options.pollMilliseconds ?? 5000;
  if (!Number.isInteger(pollMilliseconds) || pollMilliseconds < 1000 || pollMilliseconds > 60_000) {
    throw new Error("Worker polling must be between 1000 and 60000 milliseconds.");
  }
  while (!options.signal.aborted) {
    const result = await options.runOnce(options.signal);
    options.onResult?.(result);
    if (options.signal.aborted) return;
    await waitForPoll(pollMilliseconds, options.signal);
  }
}
