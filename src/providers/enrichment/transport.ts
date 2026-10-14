import { createDeadline } from "@/lib/deadline";

export type EnrichmentErrorCode = "access-denied" | "rate-limited" | "timeout" | "invalid-response" | "unavailable";
export class EnrichmentProviderError extends Error {
  constructor(readonly code: EnrichmentErrorCode) {
    super("Optional provider enrichment could not be retrieved.");
    this.name = "EnrichmentProviderError";
  }
}

export interface EnrichmentRequestOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number }
const MAX_RESPONSE_BYTES = 2_097_152;
const MAX_REQUEST_BYTES = 4096;

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Destinations are compiled-in provider origins; credentials never follow redirects. */
export async function requestEnrichmentJson(provider: "bubblemaps" | "nansen", path: string, credential: string,
  parent: AbortSignal, body: unknown, options: EnrichmentRequestOptions = {}): Promise<unknown> {
  parent.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 12_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !/^[\x21-\x7e]{1,2048}$/.test(credential)) throw new EnrichmentProviderError("access-denied");
  const origin = provider === "bubblemaps" ? "https://api.bubblemaps.io" : "https://api.nansen.ai";
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) throw new EnrichmentProviderError("invalid-response");
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw new EnrichmentProviderError("invalid-response");
  const deadline = createDeadline(timeoutMs, [parent]);
  let response: Response | undefined;
  try {
    response = await abortable((options.fetch ?? globalThis.fetch)(url.toString(), {
      method: serialized === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", credentials: "omit",
      signal: deadline.signal,
      headers: { accept: "application/json", ...(provider === "bubblemaps" ? { "X-ApiKey": credential } : { apikey: credential }),
        ...(serialized === undefined ? {} : { "content-type": "application/json" }) },
      ...(serialized === undefined ? {} : { body: serialized }),
    }), deadline.signal);
    if (!response.ok) throw new EnrichmentProviderError(response.status === 429 ? "rate-limited" : [401, 402, 403].includes(response.status) ? "access-denied" : "unavailable");
    if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
      || Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) throw new EnrichmentProviderError("invalid-response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), deadline.signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new EnrichmentProviderError("invalid-response");
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    parent.throwIfAborted();
    if (deadline.signal.aborted) throw new EnrichmentProviderError("timeout");
    if (error instanceof EnrichmentProviderError) throw error;
    throw new EnrichmentProviderError(error instanceof SyntaxError || error instanceof TypeError ? "invalid-response" : "unavailable");
  } finally {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    deadline.dispose();
  }
}
