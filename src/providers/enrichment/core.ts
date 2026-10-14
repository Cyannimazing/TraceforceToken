import { z } from "@/lib/validation";
import { validateProviderEnrichmentBundle, type ProviderCapability, type ProviderEnrichmentBundle, type ProviderEnrichmentSnapshot } from "@/domain/investigations/provider-enrichment";
import { fetchBubblemapsEnrichment } from "./bubblemaps";
import { fetchNansenEnrichment } from "./nansen";
import { EnrichmentProviderError, type EnrichmentRequestOptions } from "./transport";

export interface ProviderEnrichmentConfig { bubblemapsApiKey?: string; nansenApiKey?: string; timeoutMs?: number }
const credential = z.string().regex(/^[\x21-\x7e]{1,2048}$/);
const configSchema = z.object({
  bubblemapsApiKey: credential.optional(), nansenApiKey: credential.optional(), timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();

/** Private keys belong on the protected engine, never public/Vercel web configuration. */
export function readProviderEnrichmentConfig(environment: Record<string, string | undefined>): ProviderEnrichmentConfig {
  for (const key of ["BUBBLEMAPS_API_KEY", "NANSEN_API_KEY"]) {
    if (environment[`NEXT_PUBLIC_${key}`]?.trim() || (environment.VERCEL && environment[key]?.trim())) throw new Error("Optional provider credentials belong only on the protected scan engine.");
  }
  try {
    return configSchema.parse({
      ...(environment.BUBBLEMAPS_API_KEY?.trim() ? { bubblemapsApiKey: environment.BUBBLEMAPS_API_KEY.trim() } : {}),
      ...(environment.NANSEN_API_KEY?.trim() ? { nansenApiKey: environment.NANSEN_API_KEY.trim() } : {}),
      ...(environment.ENRICHMENT_TIMEOUT_MS?.trim() ? { timeoutMs: Number(environment.ENRICHMENT_TIMEOUT_MS) } : {}),
    });
  } catch { throw new Error("Optional provider enrichment configuration is invalid."); }
}

export async function fetchOptionalProviderEnrichment(tokenAddress: string, signal: AbortSignal, config: ProviderEnrichmentConfig = {},
  options: EnrichmentRequestOptions & { now?: () => Date } = {}): Promise<ProviderEnrichmentBundle> {
  signal.throwIfAborted();
  const token = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(tokenAddress).toLowerCase(), parsed = configSchema.parse(config);
  const sources: ProviderEnrichmentSnapshot[] = [];
  const capabilities: ProviderCapability[] = [];
  const requestOptions = { ...options, timeoutMs: options.timeoutMs ?? parsed.timeoutMs };
  const requests = [
    { provider: "bubblemaps" as const, key: parsed.bubblemapsApiKey, acquire: fetchBubblemapsEnrichment },
    { provider: "nansen" as const, key: parsed.nansenApiKey, acquire: fetchNansenEnrichment },
  ];
  const outcomes = await Promise.allSettled(requests.map(async (request) => request.key
    ? request.acquire(token, request.key, signal, requestOptions) : null));
  signal.throwIfAborted();
  for (let index = 0; index < requests.length; index++) {
    const outcome = outcomes[index], provider = requests[index].provider;
    if (outcome.status === "fulfilled") {
      capabilities.push({ provider, status: outcome.value ? "available" : "not-configured" });
      if (outcome.value) sources.push(outcome.value);
    } else {
      capabilities.push({ provider, status: outcome.reason instanceof EnrichmentProviderError ? outcome.reason.code : "unavailable" });
    }
  }
  capabilities.push({ provider: "arkham", status: "rights-required" }, { provider: "rugcheck", status: "unsupported-chain" });
  return validateProviderEnrichmentBundle({ schemaVersion: 1, chainId: 8453, tokenAddress: token,
    checkedAt: (options.now ?? (() => new Date()))().toISOString(), sources, capabilities }, token);
}
