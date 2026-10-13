export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function readSmallJson(request: Request, maxBytes = 2048): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new HttpError(415, "Use application/json.");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(413, "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new HttpError(413, "Request body is too large."); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "The request body must be valid JSON."); }
}

export function jsonError(error: unknown) {
  return Response.json({ error: error instanceof HttpError ? error.message : "The service is temporarily unavailable. No connection details were disclosed." }, { status: error instanceof HttpError ? error.status : 503 });
}
