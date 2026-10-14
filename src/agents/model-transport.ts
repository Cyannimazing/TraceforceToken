import { z } from "zod";
import { aiModelIdentifier, aiModelMatchesConfiguration, validateAiConfiguration, type AiConfiguration } from "./config";

export class LocalAiError extends Error {
  constructor(public readonly code: "INVALID_CONTEXT" | "CONTEXT_LIMIT" | "UNAVAILABLE" | "RATE_LIMITED" | "RESPONSE_LIMIT" | "INVALID_RESPONSE" | "INVALID_CITATION" | "ABORTED" | "TIMEOUT") {
    super(`AI request could not complete (${code}).`); this.name = "LocalAiError";
  }
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
export async function readLocalAiJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => undefined); throw new LocalAiError(!response.redirected && response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE"); }
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") { void response.body?.cancel().catch(() => undefined); throw new LocalAiError("INVALID_RESPONSE"); }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximum)) { void response.body?.cancel().catch(() => undefined); throw new LocalAiError("RESPONSE_LIMIT"); }
  const reader = response.body?.getReader();
  if (!reader) throw new LocalAiError("INVALID_RESPONSE");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw new LocalAiError("RESPONSE_LIMIT");
      chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new LocalAiError("INVALID_RESPONSE"); }
}

interface GenerationRequest {
  messages: { role: "system" | "user"; content: string }[];
  format: unknown;
  maxOutputTokens: number;
  maxResponseBytes?: number;
  signal: AbortSignal;
  fetch: typeof globalThis.fetch;
}
/** Fixed destinations, bounded JSON-only output, no tools, uploads or upstream error prose. */
export async function generateModelJson(configuration: AiConfiguration, request: GenerationRequest): Promise<{ content: string; model: string }> {
  request.signal.throwIfAborted();
  const config = validateAiConfiguration(configuration);
  const maximum = Math.min(config.maxResponseBytes, request.maxResponseBytes ?? config.maxResponseBytes);
  const outputTokens = Math.min(config.maxOutputTokens, request.maxOutputTokens);
  if ("provider" in config && config.provider === "openrouter") {
    if (!Number.isInteger(outputTokens) || outputTokens < 1) throw new LocalAiError("INVALID_CONTEXT");
    const response = await abortable(request.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", redirect: "error", cache: "no-store", signal: request.signal,
      headers: { "content-type": "application/json", accept: "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: request.messages, temperature: 0, n: 1, stream: false, max_tokens: outputTokens,
        response_format: { type: "json_schema", json_schema: { name: "traceforge_investigator", strict: true, schema: request.format } },
        provider: { require_parameters: true, data_collection: config.allowDataCollection ? "allow" : "deny", allow_fallbacks: false,
          ...(config.freeOnly ? { max_price: { prompt: 0, completion: 0, request: 0 } } : {}) },
        // Free selectors need their small output budget for the JSON answer.
        // Paid operators retain the reviewed model's reasoning configuration.
        reasoning: config.freeOnly ? { enabled: false, exclude: true }
          : { ...(config.model === "google/gemini-3.5-flash-lite" ? { effort: "minimal" } : {}), exclude: true },
      }),
    }), request.signal);
    const raw = await readLocalAiJson(response, maximum, request.signal);
    const emptyReasoning = z.literal("").nullable().optional();
    const noDetails = z.array(z.never()).max(0).nullable().optional();
    const actualModel = z.string().min(3).max(117).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?::free)?$/)
      .refine((value) => !value.includes("..") && aiModelMatchesConfiguration(config, `openrouter/${value}`));
    const envelope = z.object({
      model: actualModel, object: z.literal("chat.completion").optional(), error: z.null().optional(),
      usage: z.object({ cost: z.number().finite().nonnegative().refine((value) => !config.freeOnly || value === 0).nullable().optional() }).optional(),
      choices: z.array(z.object({ index: z.literal(0).optional(), finish_reason: z.literal("stop"), error: z.null().optional(),
        message: z.object({ role: z.literal("assistant"), content: z.string().min(1).max(maximum).refine((value) => Boolean(value.trim())),
          tool_calls: noDetails, function_call: z.null().optional(), refusal: z.null().optional(), error: z.null().optional(),
          reasoning: emptyReasoning, reasoning_content: emptyReasoning, reasoning_details: noDetails,
          annotations: noDetails,
        }).strict(),
      })).length(1),
    }).safeParse(raw);
    if (!envelope.success) throw new LocalAiError("INVALID_RESPONSE");
    request.signal.throwIfAborted();
    return { content: envelope.data.choices[0].message.content, model: `openrouter/${envelope.data.model}` };
  }
  const gemini = "provider" in config;
  const endpoint = gemini ? new URL(`/v1beta/models/${config.model}:generateContent`, config.baseUrl) : new URL("/api/chat", config.baseUrl);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (gemini) headers["x-goog-api-key"] = config.apiKey;
  const body = gemini ? {
    systemInstruction: { parts: request.messages.filter((message) => message.role === "system").map((message) => ({ text: message.content })) },
    contents: request.messages.filter((message) => message.role === "user").map((message) => ({ role: "user", parts: [{ text: message.content }] })),
    generationConfig: { temperature: 0, candidateCount: 1, maxOutputTokens: outputTokens,
      responseMimeType: "application/json", responseJsonSchema: request.format,
      thinkingConfig: { thinkingLevel: config.model === "gemini-3.5-flash-lite" ? "minimal" : "low", includeThoughts: false } },
  } : { model: config.model, stream: false, keep_alive: config.keepAliveSeconds === 0 ? 0 : `${config.keepAliveSeconds ?? 300}s`, think: false,
    format: request.format, options: { temperature: 0, num_predict: outputTokens, num_ctx: config.contextTokens, num_thread: config.threads, num_gpu: config.gpuLayers }, messages: request.messages };
  const response = await abortable(request.fetch(endpoint, { method: "POST", redirect: "error", cache: "no-store", signal: request.signal, headers, body: JSON.stringify(body) }), request.signal);
  const raw = await readLocalAiJson(response, maximum, request.signal);
  if (gemini) {
    const envelope = z.object({ candidates: z.array(z.object({ finishReason: z.literal("STOP"), content: z.object({ role: z.literal("model"), parts: z.array(z.object({ text: z.string().max(maximum), thought: z.literal(false).optional(), thoughtSignature: z.string().min(1).max(maximum).regex(/^[A-Za-z0-9+/=_-]+$/).optional() }).strict()).min(1).max(8) }) })).length(1),
      promptFeedback: z.object({ blockReason: z.never().optional() }).optional() }).safeParse(raw);
    if (!envelope.success) throw new LocalAiError("INVALID_RESPONSE");
    return { content: envelope.data.candidates[0].content.parts.map((part) => part.text).join(""), model: aiModelIdentifier(config) };
  }
  const envelope = z.object({ done: z.literal(true), done_reason: z.literal("stop").optional(), message: z.object({ role: z.literal("assistant"), content: z.string().max(maximum), tool_calls: z.array(z.unknown()).max(0).optional() }) }).safeParse(raw);
  if (!envelope.success) throw new LocalAiError("INVALID_RESPONSE");
  return { content: envelope.data.message.content, model: aiModelIdentifier(config) };
}
