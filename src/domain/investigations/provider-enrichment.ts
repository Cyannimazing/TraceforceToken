import { z } from "@/lib/validation";

export const ENRICHMENT_PROVIDERS = ["bubblemaps", "nansen", "arkham", "rugcheck"] as const;
export const ENRICHMENT_MAX_CANDIDATES = 1000;
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const timestamp = z.string().datetime({ offset: true });
const provider = z.enum(ENRICHMENT_PROVIDERS);
const activeProvider = z.enum(["bubblemaps", "nansen"]);

export const providerCapabilitySchema = z.object({
  provider,
  status: z.enum(["available", "not-configured", "access-denied", "rate-limited", "timeout", "invalid-response", "unavailable", "rights-required", "unsupported-chain"]),
}).strict();
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

/** External candidates and reported labels are leads, never pinned chain evidence or ownership claims. */
export const providerEnrichmentSnapshotSchema = z.object({
  provider: activeProvider,
  authority: z.literal("source-reported"),
  chainId: z.literal(8453),
  tokenAddress: address,
  requestedAt: timestamp,
  checkedAt: timestamp,
  sourceObservedAt: timestamp.nullable(),
  sourceUrl: z.string().url().max(300),
  candidates: z.array(z.object({
    address,
    role: z.enum(["holder", "context"]),
    label: z.string().min(1).max(200).nullable(),
    reportedSharePercent: z.number().min(0).max(100).nullable(),
  }).strict()).max(ENRICHMENT_MAX_CANDIDATES),
  relationships: z.array(z.object({
    from: address,
    to: address,
    kind: z.literal("transfer"),
    reportedTokenAddress: address,
    reportedTransferCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(5000),
  coverage: z.object({
    scope: z.enum(["top-holders-and-context", "top-holders"]),
    returnedCandidates: z.number().int().min(0).max(ENRICHMENT_MAX_CANDIDATES),
    limitReached: z.boolean(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: "custom", message });
  if (Date.parse(value.checkedAt) < Date.parse(value.requestedAt)) reject("Enrichment check precedes its request.");
  if (value.sourceObservedAt && Date.parse(value.sourceObservedAt) > Date.parse(value.checkedAt) + 60_000) reject("Enrichment source time is in the future.");
  const expectedUrl = value.provider === "bubblemaps"
    ? `https://v2.bubblemaps.io/map?chain=base&address=${value.tokenAddress}`
    : "https://app.nansen.ai/";
  if (value.sourceUrl !== expectedUrl) reject("Enrichment source URL does not match its provider and token.");
  if (value.coverage.returnedCandidates !== value.candidates.length) reject("Enrichment candidate count does not match.");
  const addresses = new Set(value.candidates.map((candidate) => candidate.address));
  if (addresses.size !== value.candidates.length) reject("Enrichment candidates must be unique.");
  const relationships = new Set<string>();
  for (const relationship of value.relationships) {
    if (!addresses.has(relationship.from) || !addresses.has(relationship.to) || relationship.from === relationship.to) reject("Enrichment relationship endpoints must identify distinct retained candidates.");
    const key = `${relationship.from}:${relationship.to}:${relationship.reportedTokenAddress}`;
    if (relationships.has(key)) reject("Enrichment relationships must be unique per token and direction.");
    relationships.add(key);
  }
  if (value.provider === "nansen" && (value.relationships.length || value.coverage.scope !== "top-holders")) reject("Basic Nansen holder enrichment cannot claim relationship analysis.");
});
export type ProviderEnrichmentSnapshot = z.infer<typeof providerEnrichmentSnapshotSchema>;

export const providerEnrichmentBundleSchema = z.object({
  schemaVersion: z.literal(1),
  chainId: z.literal(8453),
  tokenAddress: address,
  checkedAt: timestamp,
  sources: z.array(providerEnrichmentSnapshotSchema).max(2),
  capabilities: z.array(providerCapabilitySchema).length(4),
}).strict().superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: "custom", message });
  const capabilities = new Map(value.capabilities.map((capability) => [capability.provider, capability.status]));
  if (capabilities.size !== ENRICHMENT_PROVIDERS.length) reject("Every enrichment provider must have exactly one capability status.");
  if (capabilities.get("arkham") !== "rights-required" || capabilities.get("rugcheck") !== "unsupported-chain") reject("Unavailable integration rights or Base support cannot be upgraded by a report.");
  if (new Set(value.sources.map((source) => source.provider)).size !== value.sources.length) reject("Enrichment sources must be unique.");
  for (const source of value.sources) {
    if (source.tokenAddress !== value.tokenAddress || Date.parse(source.checkedAt) > Date.parse(value.checkedAt)) reject("Enrichment source identity/time does not match its bundle.");
    if (capabilities.get(source.provider) !== "available") reject("A retained enrichment source must be available.");
  }
  for (const capability of value.capabilities) {
    if (capability.status === "available" && !value.sources.some((source) => source.provider === capability.provider)) reject("An available enrichment provider must retain its validated response.");
  }
});
export type ProviderEnrichmentBundle = z.infer<typeof providerEnrichmentBundleSchema>;

export function validateProviderEnrichmentBundle(value: unknown, tokenAddress: string): ProviderEnrichmentBundle {
  const token = z.string().regex(/^0x[0-9a-fA-F]{40}$/).parse(tokenAddress).toLowerCase();
  const result = providerEnrichmentBundleSchema.parse(value);
  if (result.tokenAddress !== token) throw new Error("Enrichment belongs to a different token.");
  return result;
}
