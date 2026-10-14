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
export const OPENROUTER_ORIGIN = "https://openrouter.ai";
export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
export interface OpenRouterAiConfiguration extends Omit<LocalAiConfiguration, "model" | "baseUrl"> {
  provider: "openrouter";
  baseUrl: typeof OPENROUTER_ORIGIN;
  model: string;
  apiKey: string;
  freeOnly: boolean;
  allowDataCollection: boolean;
}
export type AiConfiguration = LocalAiConfiguration | GeminiAiConfiguration | OpenRouterAiConfiguration;
export interface InvestigatorAiConfiguration { local?: LocalAiConfiguration; openrouter?: OpenRouterAiConfiguration; gemini?: GeminiAiConfiguration }
const geminiSchema = configurationSchema.omit({ baseUrl: true, model: true }).extend({
  provider: z.literal("gemini"), baseUrl: z.literal(GEMINI_ORIGIN), model: z.enum(GEMINI_MODELS),
  apiKey: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const openRouterSchema = configurationSchema.omit({ baseUrl: true, model: true }).extend({
  provider: z.literal("openrouter"), baseUrl: z.literal(OPENROUTER_ORIGIN),
  // Trusted operator configuration only. Preserve the complete provider/model ID
  // inside the existing 128-character report/capsule identity bound.
  model: z.string().min(3).max(117).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?::free)?$/)
    .refine((value) => !value.includes("..") && (value === "openrouter/free" || !value.toLowerCase().startsWith("openrouter/"))),
  apiKey: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
  freeOnly: z.boolean().default(true),
  allowDataCollection: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.freeOnly && value.model !== "openrouter/free" && !value.model.endsWith(":free"))
    context.addIssue({ code: "custom", path: ["model"], message: "Free-only inference requires the free router or a free model variant." });
});

export function validateAiConfiguration(value: unknown): AiConfiguration {
  if (typeof value === "object" && value !== null && "provider" in value) {
    if (value.provider === "openrouter") {
      const result = openRouterSchema.safeParse(value);
      if (!result.success) throw new Error("OpenRouter AI configuration contains an invalid setting or budget.");
      return result.data;
    }
    const result = geminiSchema.safeParse(value);
    if (!result.success) throw new Error("Gemini AI configuration contains an invalid setting or budget.");
    return result.data;
  }
  return validateLocalAiConfiguration(value);
}
export function aiModelIdentifier(config: AiConfiguration): string {
  return "provider" in config ? `${config.provider}/${config.model}` : config.model;
}
/** A router is the request scope; completed inference records the served model. */
export function aiModelMatchesConfiguration(config: AiConfiguration, identifier: string): boolean {
  if (!("provider" in config) || config.provider !== "openrouter" || config.model !== "openrouter/free") return identifier === aiModelIdentifier(config);
  if (!identifier.startsWith("openrouter/")) return false;
  const served = identifier.slice("openrouter/".length);
  if (served.length > 117 || served.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?::free)?$/.test(served)) return false;
  const base = served.toLowerCase().replace(/:free$/, "");
  return !["openrouter/free", "openrouter/auto", "openrouter/auto-beta", "openrouter/auto-exacto", "openrouter/fusion", "openrouter/bodybuilder", "openrouter/body-builder", "openrouter/pareto-code-router"].includes(base);
}
export function readInvestigatorAiConfiguration(env: Record<string, string | undefined> = process.env): InvestigatorAiConfiguration {
  if (env.NEXT_PUBLIC_GEMINI_API_KEY?.trim() || env.NEXT_PUBLIC_OPENROUTER_API_KEY?.trim()) throw new Error("Inference credentials must remain server-only.");
  if (env.VERCEL === "1") throw new Error("Configure inference credentials on the protected engine, not Vercel.");
  const selected = env.INVESTIGATOR_AI_PROVIDER?.trim() || "auto";
  if (!["auto", "local", "openrouter", "gemini"].includes(selected)) throw new Error("INVESTIGATOR_AI_PROVIDER must be auto, local, openrouter or gemini.");
  const local = (selected === "auto" || selected === "local") && env.LOCAL_AI_MODEL?.trim() ? readLocalAiConfiguration(env) : undefined;
  let openrouter: OpenRouterAiConfiguration | undefined;
  let gemini: GeminiAiConfiguration | undefined;
  const cloudBudgets = () => readLocalAiConfiguration({ ...env, LOCAL_AI_MODEL: "traceforce-investigator", LOCAL_AI_BASE_URL: "http://127.0.0.1:11434" });
  if ((selected === "auto" || selected === "openrouter") && env.OPENROUTER_API_KEY?.trim()) {
    const freeOnly = env.OPENROUTER_FREE_ONLY?.trim() || "true";
    if (freeOnly !== "true" && freeOnly !== "false") throw new Error("OPENROUTER_FREE_ONLY must be true or false.");
    const allowDataCollection = env.OPENROUTER_ALLOW_DATA_COLLECTION?.trim() || "false";
    if (allowDataCollection !== "true" && allowDataCollection !== "false") throw new Error("OPENROUTER_ALLOW_DATA_COLLECTION must be true or false.");
    const validated = validateAiConfiguration({ ...cloudBudgets(), provider: "openrouter", baseUrl: OPENROUTER_ORIGIN,
      model: env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL, apiKey: env.OPENROUTER_API_KEY.trim(),
      freeOnly: freeOnly === "true", allowDataCollection: allowDataCollection === "true" });
    if (!("provider" in validated) || validated.provider !== "openrouter") throw new Error("Invalid OpenRouter configuration.");
    openrouter = validated;
  }
  if ((selected === "gemini" || selected === "auto" && !openrouter?.freeOnly) && env.GEMINI_API_KEY?.trim()) {
    // Shared conservative budgets do not require configuring a local model.
    const validated = validateAiConfiguration({ ...cloudBudgets(), provider: "gemini", baseUrl: GEMINI_ORIGIN,
      model: env.GEMINI_MODEL?.trim() || GEMINI_MODELS[0], apiKey: env.GEMINI_API_KEY.trim() });
    if (!("provider" in validated) || validated.provider !== "gemini") throw new Error("Invalid Gemini configuration.");
    gemini = validated;
  }
  if (!local && !openrouter && !gemini) throw new Error("Configure the selected investigator AI provider with LOCAL_AI_MODEL, OPENROUTER_API_KEY or GEMINI_API_KEY.");
  return { local, openrouter, gemini };
}
