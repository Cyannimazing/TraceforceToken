import { z } from "zod";

export interface LocalAiConfiguration {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxContextBytes: number;
  maxEvidenceRecords: number;
  maxOutputTokens: number;
  contextTokens: number;
  threads: number;
  gpuLayers: number;
  keepAliveSeconds?: number;
}

function loopbackOrigin(value: string): string {
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/i.test(value)) throw new Error("LOCAL_AI_BASE_URL must be a loopback HTTP(S) origin without credentials, a path, query, or fragment.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("LOCAL_AI_BASE_URL must be a valid loopback origin."); }
  // Avoid resolving a localhost hostname through DNS or a modified hosts file.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

const configurationSchema = z.object({
  baseUrl: z.string(), model: z.string().min(1).max(128),
  timeoutMs: z.number().int().min(1000).max(120_000),
  maxResponseBytes: z.number().int().min(1024).max(262_144),
  maxContextBytes: z.number().int().min(4096).max(262_144),
  maxEvidenceRecords: z.number().int().min(1).max(200),
  maxOutputTokens: z.number().int().min(128).max(4096),
  contextTokens: z.number().int().min(1024).max(8192),
  threads: z.number().int().min(1).max(8),
  gpuLayers: z.number().int().min(0).max(128),
  keepAliveSeconds: z.number().int().min(0).max(900).default(300),
}).strict();

/** Revalidate injected configuration at the inference boundary as well as env reads. */
export function validateLocalAiConfiguration(value: unknown): LocalAiConfiguration {
  const result = configurationSchema.safeParse(value);
  if (!result.success) throw new Error("Local AI configuration contains an invalid setting or budget.");
  const config = result.data;
  const baseUrl = loopbackOrigin(config.baseUrl);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(config.model) || /(?:^|[-/:])cloud(?:$|[-/:])/i.test(config.model)) throw new Error("LOCAL_AI_MODEL must identify a local model, without cloud routing or control characters.");
  return { ...config, baseUrl };
}

export function readLocalAiConfiguration(env: Record<string, string | undefined> = process.env): LocalAiConfiguration {
  if (!env.LOCAL_AI_MODEL?.trim()) throw new Error("LOCAL_AI_MODEL must be configured for the required investigator explanation.");
  const number = (name: string, fallback: number) => env[name]?.trim() ? Number(env[name]) : fallback;
  return validateLocalAiConfiguration({
    baseUrl: env.LOCAL_AI_BASE_URL?.trim() || "http://127.0.0.1:11434",
    model: env.LOCAL_AI_MODEL.trim(),
    timeoutMs: number("LOCAL_AI_TIMEOUT_MS", 120_000),
    maxResponseBytes: number("LOCAL_AI_MAX_RESPONSE_BYTES", 65_536),
    maxContextBytes: number("LOCAL_AI_MAX_CONTEXT_BYTES", 8000),
    maxEvidenceRecords: number("LOCAL_AI_MAX_EVIDENCE_RECORDS", 12),
    maxOutputTokens: number("LOCAL_AI_MAX_OUTPUT_TOKENS", 800),
    contextTokens: number("LOCAL_AI_CONTEXT_TOKENS", 4096),
    threads: number("LOCAL_AI_THREADS", 2),
    gpuLayers: number("LOCAL_AI_GPU_LAYERS", 0),
    keepAliveSeconds: number("LOCAL_AI_KEEP_ALIVE_SECONDS", 300),
  });
}

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
export const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"] as const;
export interface GeminiAiConfiguration extends Omit<LocalAiConfiguration, "model" | "baseUrl"> {
  provider: "gemini";
  baseUrl: typeof GEMINI_ORIGIN;
  model: typeof GEMINI_MODELS[number];
  apiKey: string;
}
export type AiConfiguration = LocalAiConfiguration | GeminiAiConfiguration;
export interface InvestigatorAiConfiguration { local?: LocalAiConfiguration; gemini?: GeminiAiConfiguration }
const geminiSchema = configurationSchema.omit({ baseUrl: true, model: true }).extend({
  provider: z.literal("gemini"), baseUrl: z.literal(GEMINI_ORIGIN), model: z.enum(GEMINI_MODELS),
  apiKey: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export function validateAiConfiguration(value: unknown): AiConfiguration {
  if (typeof value === "object" && value !== null && "provider" in value) {
    const result = geminiSchema.safeParse(value);
    if (!result.success) throw new Error("Gemini AI configuration contains an invalid setting or budget.");
    return result.data;
  }
  return validateLocalAiConfiguration(value);
}
export function aiModelIdentifier(config: AiConfiguration): string {
  return "provider" in config ? `gemini/${config.model}` : config.model;
}
export function readInvestigatorAiConfiguration(env: Record<string, string | undefined> = process.env): InvestigatorAiConfiguration {
  if (env.NEXT_PUBLIC_GEMINI_API_KEY?.trim()) throw new Error("Inference credentials must remain server-only.");
  if (env.VERCEL === "1") throw new Error("Configure inference credentials on the protected engine, not Vercel.");
  const local = env.LOCAL_AI_MODEL?.trim() ? readLocalAiConfiguration(env) : undefined;
  let gemini: GeminiAiConfiguration | undefined;
  if (env.GEMINI_API_KEY?.trim()) {
    // Shared conservative budgets do not require configuring a local model.
    const budgets = readLocalAiConfiguration({ ...env, LOCAL_AI_MODEL: "traceforce-investigator", LOCAL_AI_BASE_URL: "http://127.0.0.1:11434" });
    const validated = validateAiConfiguration({ ...budgets, provider: "gemini", baseUrl: GEMINI_ORIGIN,
      model: env.GEMINI_MODEL?.trim() || GEMINI_MODELS[0], apiKey: env.GEMINI_API_KEY.trim() });
    if (!("provider" in validated)) throw new Error("Invalid Gemini configuration.");
    gemini = validated;
  }
  if (!local && !gemini) throw new Error("Configure LOCAL_AI_MODEL or a server-only GEMINI_API_KEY for investigator review.");
  return { local, gemini };
}
