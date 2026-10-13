interface ParallelCollection<TDataset, TMetadata> {
  signal?: AbortSignal;
  collectDataset(signal: AbortSignal, metadata: Promise<TMetadata>): Promise<TDataset>;
  collectMetadata(signal: AbortSignal): Promise<TMetadata>;
}

/** Run independent reads once, with request-owned cancellation and no detached failures. */
export async function collectChainAndMetadata<TDataset, TMetadata>(options: ParallelCollection<TDataset, TMetadata>): Promise<{ dataset: TDataset; metadata: TMetadata }> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const { signal } = controller;
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  async function run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let onAbort: (() => void) | undefined;
    // Attach both resolution handlers before invoking a dependency. A late or
    // non-cooperative promise remains handled after its abort race settles.
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); });
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
    } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  }

  const metadataTask = run(options.collectMetadata);
  const datasetTask = run((signal) => options.collectDataset(signal, metadataTask));
  try {
    const [dataset, metadata] = await Promise.all([datasetTask, metadataTask]);
    signal.throwIfAborted();
    return { dataset, metadata };
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([datasetTask, metadataTask]);
    throw error;
  } finally { options.signal?.removeEventListener("abort", forwardAbort); }
}
