import "server-only";
import { fetchOptionalProviderEnrichment as acquire, readProviderEnrichmentConfig } from "./core";

export { readProviderEnrichmentConfig, type ProviderEnrichmentConfig } from "./core";
export { EnrichmentProviderError } from "./transport";

export async function fetchOptionalProviderEnrichment(tokenAddress: string, signal: AbortSignal) {
  return acquire(tokenAddress, signal, readProviderEnrichmentConfig(process.env));
}
