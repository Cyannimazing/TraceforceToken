import { z } from "@/lib/validation";
import { providerEnrichmentSnapshotSchema, type ProviderEnrichmentSnapshot } from "@/domain/investigations/provider-enrichment";
import { EnrichmentProviderError, requestEnrichmentJson, type EnrichmentRequestOptions } from "./transport";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const wireHolders = z.object({
  data: z.array(z.object({
    address, address_label: z.string().max(200).nullable().optional(),
    ownership_percentage: z.number().min(0).max(100).nullable().optional(),
  })).max(100),
  pagination: z.object({ page: z.literal(1), per_page: z.number().int().min(1).max(100), is_last_page: z.boolean() }),
});

/** Basic all-holder data only: no Smart Money filter, premium labels, leaderboard or entity aggregation. */
export async function fetchNansenEnrichment(tokenAddress: string, apiKey: string, signal: AbortSignal,
  options: EnrichmentRequestOptions & { now?: () => Date } = {}): Promise<ProviderEnrichmentSnapshot> {
  signal.throwIfAborted();
  const token = address.parse(tokenAddress), now = options.now ?? (() => new Date()), requestedAt = now().toISOString();
  const raw = await requestEnrichmentJson("nansen", "/api/v1/tgm/holders", apiKey, signal, {
    chain: "base", token_address: token, aggregate_by_entity: false, label_type: "all_holders", premium_labels: false,
    pagination: { page: 1, per_page: 100 }, filters: { value_usd: { min: 0 } },
    order_by: [{ field: "token_amount", direction: "DESC" }],
  }, options);
  try {
    const holders = wireHolders.parse(raw);
    if (new Set(holders.data.map((row) => row.address)).size !== holders.data.length) throw new EnrichmentProviderError("invalid-response");
    return providerEnrichmentSnapshotSchema.parse({
      provider: "nansen", authority: "source-reported", chainId: 8453, tokenAddress: token,
      requestedAt, checkedAt: now().toISOString(), sourceObservedAt: null, sourceUrl: "https://app.nansen.ai/",
      candidates: holders.data.map((row) => ({ address: row.address, role: "holder", label: row.address_label?.trim() || null,
        reportedSharePercent: row.ownership_percentage ?? null })),
      relationships: [],
      coverage: { scope: "top-holders", returnedCandidates: holders.data.length, limitReached: !holders.pagination.is_last_page },
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof EnrichmentProviderError) throw error;
    throw new EnrichmentProviderError("invalid-response");
  }
}
