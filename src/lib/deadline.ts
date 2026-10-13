/** An owned timer keeps the deadline alive even when Node garbage-collects
 * ephemeral AbortSignal.timeout sources. Always dispose in the caller's finally. */
export function createDeadline(milliseconds: number, parents: readonly AbortSignal[] = []): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) {
    throw new RangeError("Deadline must be a supported nonnegative timer duration.");
  }
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; forward: () => void }[] = [];
  const timer = setTimeout(() => controller.abort(new DOMException("The operation exceeded its deadline.", "TimeoutError")), milliseconds);
  function dispose() {
    clearTimeout(timer);
    for (const { signal, forward } of listeners) signal.removeEventListener("abort", forward);
    listeners.length = 0;
    controller.signal.removeEventListener("abort", dispose);
  }
  controller.signal.addEventListener("abort", dispose, { once: true });
  for (const signal of parents) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const forward = () => controller.abort(signal.reason);
    listeners.push({ signal, forward });
    signal.addEventListener("abort", forward, { once: true });
  }
  return { signal: controller.signal, dispose };
}
