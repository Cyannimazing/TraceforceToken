import { z } from "@/lib/validation";
import { ENRICHMENT_MAX_CANDIDATES, providerEnrichmentSnapshotSchema, type ProviderEnrichmentSnapshot } from "@/domain/investigations/provider-enrichment";
import { EnrichmentProviderError, requestEnrichmentJson, type EnrichmentRequestOptions } from "./transport";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const wireNode = z.object({
  address,
  address_details: z.object({ label: z.string().max(200).nullable().optional(), is_paid_label: z.boolean().optional() }).nullable().optional(),
});
const relationship = z.object({
  from_address: address, to_address: address,
  rel_type: z.literal("GROUPED_TRANSFER").optional(),
  data: z.object({
    total_transfers: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    token_key: z.object({ chain: z.string().max(30), address: z.string().max(100) }),
  }),
});
const wireMap = z.object({
  metadata: z.object({ dt_update: z.string().max(100), ts_update: z.number().int().min(0).max(253402300799) }),
  nodes: z.object({
    top_holders: z.array(wireNode).max(80),
    magic_nodes: z.array(wireNode).max(1000).nullable().optional(),
    time_nodes: z.array(z.object({ address, relationships: z.array(relationship).max(5000) })).max(1000).nullable().optional(),
  }),
  relationships: z.array(relationship).max(5000).nullable().optional(),
});

/** Official v0.3.1 map endpoint. Indexed balances/share units are deliberately not promoted to chain facts. */
export async function fetchBubblemapsEnrichment(tokenAddress: string, apiKey: string, signal: AbortSignal,
  options: EnrichmentRequestOptions & { now?: () => Date } = {}): Promise<ProviderEnrichmentSnapshot> {
  signal.throwIfAborted();
  const token = address.parse(tokenAddress), now = options.now ?? (() => new Date()), requestedAt = now().toISOString();
  const path = `/v0/tokens/map/base/${token}?limit=80&refresh=true&use_magic_nodes=true&use_time_nodes=true&return_nodes=true&return_relationships=true&return_clusters=false`;
  const raw = await requestEnrichmentJson("bubblemaps", path, apiKey, signal, undefined, options);
  try {
    const map = wireMap.parse(raw), candidates: ProviderEnrichmentSnapshot["candidates"] = [];
    const seen = new Set<string>();
    let truncated = false;
    const add = (node: z.infer<typeof wireNode>, role: "holder" | "context") => {
      if (seen.has(node.address)) return;
      if (candidates.length === ENRICHMENT_MAX_CANDIDATES) { truncated = true; return; }
      seen.add(node.address);
      const label = node.address_details?.is_paid_label ? null : node.address_details?.label?.trim() || null;
      candidates.push({ address: node.address, role, label, reportedSharePercent: null });
    };
    map.nodes.top_holders.forEach((node) => add(node, "holder"));
    (map.nodes.magic_nodes ?? []).forEach((node) => add(node, "context"));
    const timeNodes = map.nodes.time_nodes ?? [];
    timeNodes.forEach((node) => add(node, "context"));
    const wireRelationships = [...(map.relationships ?? []), ...timeNodes.flatMap((node) => node.relationships)];
    const relationships: ProviderEnrichmentSnapshot["relationships"] = [], seenRelationships = new Map<string, number>();
    for (const relation of wireRelationships) {
      // Other-chain links cannot become Base transfer leads. The source may expose context for several chains.
      if (relation.data.token_key.chain !== "base" || relation.from_address === relation.to_address) continue;
      if (!address.safeParse(relation.data.token_key.address).success) throw new EnrichmentProviderError("invalid-response");
      add({ address: relation.from_address }, "context"); add({ address: relation.to_address }, "context");
      if (!seen.has(relation.from_address) || !seen.has(relation.to_address)) { truncated = true; continue; }
      const key = `${relation.from_address}:${relation.to_address}:${relation.data.token_key.address.toLowerCase()}`;
      const previousCount = seenRelationships.get(key);
      if (previousCount !== undefined) {
        if (previousCount !== relation.data.total_transfers) throw new EnrichmentProviderError("invalid-response");
        continue;
      }
      if (relationships.length === 5000) { truncated = true; break; }
      seenRelationships.set(key, relation.data.total_transfers);
      relationships.push({ from: relation.from_address, to: relation.to_address, kind: "transfer",
        reportedTokenAddress: relation.data.token_key.address.toLowerCase(), reportedTransferCount: relation.data.total_transfers });
    }
    return providerEnrichmentSnapshotSchema.parse({
      provider: "bubblemaps", authority: "source-reported", chainId: 8453, tokenAddress: token,
      requestedAt, checkedAt: now().toISOString(), sourceObservedAt: new Date(map.metadata.ts_update * 1000).toISOString(),
      sourceUrl: `https://v2.bubblemaps.io/map?chain=base&address=${token}`, candidates, relationships,
      coverage: { scope: "top-holders-and-context", returnedCandidates: candidates.length, limitReached: truncated || map.nodes.top_holders.length === 80 },
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof EnrichmentProviderError) throw error;
    throw new EnrichmentProviderError("invalid-response");
  }
}
