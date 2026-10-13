/** Keep a distributed visitor lease for the complete streaming response. */
export async function runVisitorScan(
  execute: (signal: AbortSignal) => Response | Promise<Response>,
  release: () => Promise<void>,
  parent: AbortSignal,
  timeoutMilliseconds = 300_000,
): Promise<Response> {
  const operation = new AbortController();
  let finished = false;
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const finish = async (reason?: unknown) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    operation.abort(reason);
    if (reason !== undefined) void reader?.cancel(reason).catch(() => undefined);
    // An unavailable release leaves a bounded expiring lease, never a permanent lock.
    await release().catch(() => undefined);
  };
  const abort = () => { void finish(parent.reason); };
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { void finish(new Error("Visitor scan deadline exceeded.")); }, timeoutMilliseconds);
  timer.unref();
  try {
    parent.throwIfAborted();
    const response = await execute(operation.signal);
    if (operation.signal.aborted) { await response.body?.cancel().catch(() => undefined); operation.signal.throwIfAborted(); }
    if (!response.body) { await finish(); return response; }
    reader = response.body.getReader();
    const source = reader;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await source.read();
          operation.signal.throwIfAborted();
          if (chunk.done) { await finish(); source.releaseLock(); if (!cancelled) controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) { await finish(error); source.releaseLock(); if (!cancelled) controller.error(error); }
      },
      async cancel(reason) {
        cancelled = true;
        await finish(reason);
        try { await source.cancel(reason).catch(() => undefined); } finally { source.releaseLock(); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { await finish(error); throw error; }
}
