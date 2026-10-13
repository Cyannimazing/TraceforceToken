import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { ChatContextError } from "../src/agents/chat-context";
import { assertInvestigationQuestionScope, InvestigationQuestionError, type InvestigationQuestionAnswer } from "../src/agents/questions";
import { scanParametersSchema } from "../src/domain/investigations/scan";
import { questionAnswerSchema, questionRequestSchema, type InvestigationChatMessage } from "../src/domain/investigations/questions";
import { createDeadline } from "../src/lib/deadline";
import { HttpError, readSmallJson } from "../src/lib/http";
import { createScanResponse, type ScanDependencies } from "../src/services/scan-stream";
import { getScanCapacity, ScanCapacityError } from "../src/services/scan-capacity";

export function validateEngineSecret(value: string | undefined): string {
  if (!value || value.length < 32 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) throw new Error("SCAN_ENGINE_SECRET must contain 32–512 printable non-space ASCII characters.");
  return value;
}

interface EngineOptions {
  secret: string;
  dependencies: ScanDependencies;
  signal?: AbortSignal;
  ask?: (question: string, context: string, options: { signal: AbortSignal; history: InvestigationChatMessage[] }) => Promise<InvestigationQuestionAnswer>;
  validateQuestionContext?: (context: string) => void;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let listener: (() => void) | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { listener = () => reject(signal.reason); signal.addEventListener("abort", listener, { once: true }); if (signal.aborted) listener(); })]); }
  finally { if (listener) signal.removeEventListener("abort", listener); }
}

/** Private loopback HTTP boundary. No database, cookies, disk output, or history. */
export function createScanEngineServer(options: EngineOptions) {
  const expected = Buffer.from(validateEngineSecret(options.secret));
  const active = new Set<AbortController>();
  function authorized(request: IncomingMessage) {
    const count = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === "authorization").length;
    const header = request.headers.authorization;
    if (count !== 1 || !header?.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(header.slice(7));
    return supplied.length === expected.length && timingSafeEqual(expected, supplied);
  }
  function errorResponse(response: ServerResponse, status: number, message: string) {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(status === 429 ? { "retry-after": "10" } : {}) });
    response.end(JSON.stringify({ error: message }));
  }
  async function stream(response: Response, target: ServerResponse, signal: AbortSignal) {
    const headers: Record<string, string> = {}; response.headers.forEach((value, name) => { headers[name] = value; });
    target.writeHead(response.status, headers); target.flushHeaders();
    const reader = response.body?.getReader(); if (!reader) { target.end(); return; }
    let complete = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) { complete = true; target.end(); break; }
        if (!target.write(Buffer.from(result.value))) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { target.off("drain", drained); target.off("close", closed); signal.removeEventListener("abort", aborted); };
            const drained = () => { cleanup(); resolve(); };
            const closed = () => { cleanup(); reject(new Error("Client disconnected.")); };
            const aborted = () => { cleanup(); reject(signal.reason); };
            target.once("drain", drained); target.once("close", closed); signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted(); else if (target.destroyed) closed();
          });
        }
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url === "/health" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end('{"status":"ok"}'); return; }
    if (request.url !== "/scan" && request.url !== "/ask") { errorResponse(response, 404, "Not found."); return; }
    if (request.method !== "POST") { errorResponse(response, 405, "Use POST."); return; }
    if (!authorized(request)) { errorResponse(response, 401, "Unauthorized."); return; }
    if (options.signal?.aborted) { errorResponse(response, 503, "The engine is shutting down."); return; }
    const controller = new AbortController(); active.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(new Error("Client disconnected.")); };
    const requestAborted = () => controller.abort(new Error("Request aborted."));
    const destroyUnreadBody = () => { if (!request.complete) request.destroy(); };
    request.once("aborted", requestAborted); response.once("close", disconnected); controller.signal.addEventListener("abort", destroyUnreadBody, { once: true });
    try {
      const headers = new Headers();
      for (const name of ["content-type", "content-length"]) { const value = request.headers[name]; if (typeof value === "string") headers.set(name, value); }
      const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: Readable.toWeb(request) as ReadableStream<Uint8Array>, signal: controller.signal, duplex: "half" };
      const raw = await readSmallJson(new Request(`http://127.0.0.1${request.url}`, init), request.url === "/ask" ? 48 * 1024 : 2048);
      if (request.url === "/ask") {
        if (!options.ask) throw new HttpError(503, "Follow-up questions are unavailable.");
        const parsed = questionRequestSchema.safeParse(raw);
        if (!parsed.success) throw new HttpError(400, "Enter a question and valid scan context within the supported limits.");
        assertInvestigationQuestionScope(parsed.data.question, parsed.data.history);
        options.validateQuestionContext?.(parsed.data.context);
        const leave = (options.dependencies.capacity ?? getScanCapacity()).enter();
        const deadline = createDeadline(135_000, [controller.signal]); let releaseExplanation: (() => void) | undefined;
        try {
          releaseExplanation = await (options.dependencies.capacity ?? getScanCapacity()).explanation(deadline.signal);
          const answer = questionAnswerSchema.parse(await abortable(options.ask(parsed.data.question, parsed.data.context, { signal: deadline.signal, history: parsed.data.history }), deadline.signal));
          deadline.signal.throwIfAborted();
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(answer));
        } finally { releaseExplanation?.(); deadline.dispose(); leave(); }
      } else {
        const parsed = scanParametersSchema.safeParse(raw);
        if (!parsed.success) throw new HttpError(400, "Enter a valid Base token contract and supported scan limits.");
        await stream(createScanResponse(parsed.data, options.dependencies, controller.signal), response, controller.signal);
      }
    } catch (error) {
      if (error instanceof ChatContextError || error instanceof InvestigationQuestionError) {
        if (error.code === "OUT_OF_SCOPE") { errorResponse(response, 400, "Ask about this scan's funding, wallet links, accumulation, sales, evidence, or coverage."); return; }
        const status = error.code === "EXPIRED_CONTEXT" ? 410 : error.code === "INVALID_CONTEXT" || error.code === "INVALID_QUESTION" ? 400 : error.code === "CONTEXT_LIMIT" ? 413 : error.code === "TIMEOUT" ? 504 : 503;
        errorResponse(response, status, status === 410 ? "This scan context expired. Start a fresh scan." : status === 400 || status === 413 ? "The question or scan context is invalid. Start a fresh scan." : "The question could not be answered. Try again shortly.");
      } else if (!controller.signal.aborted) errorResponse(response, error instanceof HttpError ? error.status : error instanceof ScanCapacityError ? 429 : 503, error instanceof HttpError || error instanceof ScanCapacityError ? error.message : "The investigation engine could not complete this request.");
      else if (!response.writableEnded) response.destroy();
    } finally {
      active.delete(controller); controller.abort();
      request.off("aborted", requestAborted); response.off("close", disconnected); controller.signal.removeEventListener("abort", destroyUnreadBody);
    }
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, (request, response) => { void handle(request, response).catch(() => { response.destroy(); }); });
  server.maxHeadersCount = 24;
  const shutdown = () => {
    for (const controller of active) controller.abort(new Error("Engine shutdown requested."));
    server.close(); server.closeIdleConnections();
  };
  options.signal?.addEventListener("abort", shutdown, { once: true });
  server.once("close", () => options.signal?.removeEventListener("abort", shutdown));
  return server;
}

async function main() {
  if (process.argv.includes("--help")) { console.log("Private stateless engine on 127.0.0.1:SCAN_ENGINE_PORT (default8787). POST /scan and /ask require SCAN_ENGINE_SECRET. Process environment only; no env files or DB are loaded."); return; }
  const secret = validateEngineSecret(process.env.SCAN_ENGINE_SECRET);
  const port = Number(process.env.SCAN_ENGINE_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SCAN_ENGINE_PORT.");
  const [{ readProviderConfiguration }, { validateProviderDestination }, { collectInvestigationWithConfig }, { readInvestigatorAiConfiguration }, { runInvestigatorWithConfig, createInvestigatorChatContext, verifyInvestigatorChatContext, askInvestigatorQuestion }] = await Promise.all([
    import("../src/providers/base/config"), import("../src/providers/base/transport"), import("../src/providers/base/collector"), import("../src/agents/config"), import("../src/agents/inference"),
  ]);
  const provider = readProviderConfiguration(); const ai = readInvestigatorAiConfiguration();
  await validateProviderDestination(provider);
  const controller = new AbortController();
  const server = createScanEngineServer({ secret, signal: controller.signal,
    dependencies: { collect: (parameters, options) => collectInvestigationWithConfig(parameters, provider, options), explain: (report, options) => runInvestigatorWithConfig(report, ai, { fetch: globalThis.fetch, ...options }), createChatContext: (report) => createInvestigatorChatContext(report, ai, secret) },
    validateQuestionContext: (context) => { verifyInvestigatorChatContext(context, ai, secret); },
    ask: (question, context, options) => askInvestigatorQuestion(question, context, ai, secret, { fetch: globalThis.fetch, ...options }),
  });
  const shutdown = () => controller.abort(new Error("Process shutdown requested."));
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    console.info("TraceForce Engine scan service is listening on loopback.");
    await new Promise<void>((resolve) => server.once("close", resolve));
  } finally { process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); server.close(); }
}

if (basename(process.argv[1] ?? "") === "scan-engine.ts") main().catch(() => { console.error("Scan engine failed. Check runtime configuration and provider/model availability; connection details were not logged."); process.exitCode = 1; });
