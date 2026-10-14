import { z } from "@/lib/validation";
import type { Address } from "./types";

export const SWARM_ORIGIN = "https://swarmengine.tech" as const;
export const SWARM_CATEGORY_WEIGHTS = { swarm: 30, fresh: 20, insiders: 15, concentration: 15, snipers: 10, dev: 10 } as const;
export const SWARM_MAX_CANDIDATES = 256;

const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
const fraction = z.number().min(0).max(1);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sourceNumber = z.number().min(0).max(1e100);
const text = (maximum: number) => z.string().max(maximum).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "Unsupported control characters.");
const parts = z.object({
  swarm: z.number().min(0).max(30).nullable(), fresh: z.number().min(0).max(20).nullable(),
  insiders: z.number().min(0).max(15).nullable(), concentration: z.number().min(0).max(15).nullable(),
  snipers: z.number().min(0).max(10).nullable(), dev: z.number().min(0).max(10).nullable(),
}).strict();
const metrics = z.object({
  hands: count.nullable(), wallets: count.nullable(), impact: fraction.nullable(), biggest: fraction.nullable(),
  fresh: fraction.nullable(), insiders: fraction.nullable(), snipers: fraction.nullable(),
  concentration: fraction.nullable(), dev: fraction.nullable(),
}).strict().refine((value) => value.hands === null || value.wallets === null || value.hands <= value.wallets, "Source group count exceeds its wallet count.");
const header = z.object({
  name: text(256).nullable(), symbol: text(64).nullable(), decimals: z.number().int().min(0).max(255).nullable(),
  // These are source JSON numbers, not exact on-chain quantities or verified prices.
  supply: sourceNumber.nullable(), holders_count: count.nullable(), price_usd: sourceNumber.nullable(),
  mcap: sourceNumber.nullable(), liquidity_usd: sourceNumber.nullable(), vol24h: sourceNumber.nullable(),
  change24h: z.number().min(-100).max(1e12).nullable(), age_h: sourceNumber.nullable(),
  dex: text(128).nullable(),
  // A source pool identifier can be an EVM address or a 32-byte pool ID.
  // It is context from SWARM, never an address for an RPC contract call.
  pair: z.string().regex(/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/).transform((value) => value.toLowerCase()).nullable(),
}).strict();
const probabilities = z.object({ avoid: fraction, caution: fraction, ok: fraction }).strict()
  // Three independently rounded source values can differ from one by 0.001.
  .refine((value) => Math.abs(value.avoid + value.caution + value.ok - 1) <= 0.001001, "Source probabilities must sum to one within rounding precision.");
const contribution = z.object({ k: text(500), avoid: z.number().min(0).max(1e6).optional(), caution: z.number().min(0).max(1e6).optional(), ok: z.number().min(0).max(1e6).optional() }).strict();
const judge = z.object({
  model: text(128).min(1), decision: z.enum(["AVOID", "CAUTION", "OK"]), confidence: fraction,
  p: probabilities, evidence: z.array(contribution).max(64),
  features: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.number().min(-1e100).max(1e100).nullable())
    .refine((value) => Object.keys(value).length <= 64, "Too many source features."),
  why: z.array(text(500)).max(32), receipt: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  bar: fraction, escalate: z.boolean(), route: text(256), latency_ms: sourceNumber, cost_usd: sourceNumber,
}).strict().superRefine((value, context) => {
  const selected = value.p[value.decision.toLowerCase() as "avoid" | "caution" | "ok"];
  if (Math.abs(value.confidence - selected) > 0.001001)
    context.addIssue({ code: "custom", message: "Source confidence does not match its selected decision." });
});

const clockStamp = z.object({
  requestedAt: z.iso.datetime(), receivedAt: z.iso.datetime(), sourceDate: z.iso.datetime().nullable(),
  // Durations use a monotonic clock; local wall-clock offsets do not determine freshness.
  elapsedMs: z.number().min(0).max(180_000), observedAfterMs: z.number().min(0).max(180_000),
}).strict().refine((value) => value.observedAfterMs >= value.elapsedMs, "Invalid source clock timing.");
const transport = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), start: clockStamp, result: clockStamp,
  freshness: z.enum(["source-window-verified", "unverified"]),
  reason: z.enum(["matching-source-clock-window", "missing-source-clock", "inconsistent-source-clock"]),
}).strict();
export type SwarmTransport = z.infer<typeof transport>;

const swarmGraphSchema = z.object({
  holders: z.array(z.object({
    address, share: fraction.nullable(), shareSupply: fraction.nullable(),
    isContract: z.boolean().nullable(), label: text(128).nullable(),
    clusterId: z.string().min(1).max(64).nullable(), entryKind: text(32).nullable(),
    transactionCount: count.nullable(), fresh: z.boolean().nullable(),
    sniper: z.boolean().nullable(), insider: z.boolean().nullable(),
    dev: z.boolean().nullable(), fromDev: z.boolean().nullable(),
  }).strict()).max(SWARM_MAX_CANDIDATES),
  links: z.array(z.object({ a: address, b: address, kind: text(32).nullable(), level: text(32).nullable() }).strict()).max(2048),
  clusters: z.array(z.object({
    id: z.string().min(1).max(64), wallets: z.array(address).min(1).max(SWARM_MAX_CANDIDATES), share: fraction.nullable(),
  }).strict()).max(SWARM_MAX_CANDIDATES),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  const addresses = new Set(value.holders.map((row) => row.address));
  const clusters = new Set(value.clusters.map((row) => row.id));
  if (addresses.size !== value.holders.length || clusters.size !== value.clusters.length)
    context.addIssue({ code: "custom", message: "Source graph identifiers must be unique." });
  if (value.clusters.some((row) => new Set(row.wallets).size !== row.wallets.length || row.wallets.some((wallet) => !addresses.has(wallet))))
    context.addIssue({ code: "custom", message: "Source clusters must reference unique retained holders." });
  if (value.holders.some((row) => row.clusterId !== null && !value.clusters.find((cluster) => cluster.id === row.clusterId)?.wallets.includes(row.address)))
    context.addIssue({ code: "custom", message: "Source holder cluster membership is inconsistent." });
  const holderClusters = new Map(value.holders.map((row) => [row.address, row.clusterId]));
  const memberships = new Set<Address>();
  for (const cluster of value.clusters) for (const wallet of cluster.wallets) {
    if (holderClusters.get(wallet) !== cluster.id)
      context.addIssue({ code: "custom", message: "Source cluster membership must match its holder's cluster identifier." });
    if (memberships.has(wallet))
      context.addIssue({ code: "custom", message: "Source holders cannot belong to multiple declared clusters." });
    memberships.add(wallet);
  }
});

/** HTTP Date establishes a source-clock window, not blockchain verification. */
export function inspectSwarmFreshness(value: Pick<SwarmTransport, "start" | "result">, scannedAt: string): {
  freshness: SwarmTransport["freshness"]; reason: SwarmTransport["reason"]; stale: boolean;
} {
  const { start, result } = value;
  if (start.sourceDate === null || result.sourceDate === null)
    return { freshness: "unverified", reason: "missing-source-clock", stale: false };
  const first = Date.parse(start.sourceDate), last = Date.parse(result.sourceDate);
  // Each Date header is rounded to one second and was generated somewhere inside
  // its measured round trip. The intersection permits arbitrary host clock skew.
  const lower = Math.max(first - start.observedAfterMs, last - result.observedAfterMs);
  const upper = Math.min(first + 1000 - (start.observedAfterMs - start.elapsedMs), last + 1000 - (result.observedAfterMs - result.elapsedMs));
  if (last < first || lower >= upper)
    return { freshness: "unverified", reason: "inconsistent-source-clock", stale: false };
  const scanned = Date.parse(scannedAt);
  return {
    freshness: "source-window-verified", reason: "matching-source-clock-window",
    stale: scanned < Math.floor(lower / 1000) * 1000 || scanned > last,
  };
}

/** SWARM-reported assessment only. No field gains chain verification by validation. */
export const swarmAssessmentSnapshotSchema = z.object({
  source: z.literal("swarm"), status: z.literal("reported"), chainId: z.literal(8453), tokenAddress: address,
  sourceUrl: z.string().regex(/^https:\/\/swarmengine\.tech\/t\/base\/0x[0-9a-f]{40}$/),
  requestedAt: z.iso.datetime(), checkedAt: z.iso.datetime(), scannedAt: z.iso.datetime(), freshRequested: z.literal(true),
  score: z.number().min(0).max(100).nullable(), band: z.enum(["DANGER", "RISKY", "OK", "CLEAN", "UNKNOWN", "TOO_EARLY"]),
  parts, gates: z.array(text(500)).max(64), metrics, header, judge,
  transport: transport.optional(),
  graph: swarmGraphSchema.optional(),
  candidates: z.array(z.object({ address, roles: z.array(z.enum(["holder", "creator", "link", "funder", "entry-source"])).min(1).max(5) }).strict())
    .max(SWARM_MAX_CANDIDATES).optional(),
  candidatesTruncated: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceUrl !== `${SWARM_ORIGIN}/t/base/${value.tokenAddress}`)
    context.addIssue({ code: "custom", message: "Source assessment URL does not match its token." });
  const requested = Date.parse(value.requestedAt), checked = Date.parse(value.checkedAt), scanned = Date.parse(value.scannedAt);
  if (checked < requested) context.addIssue({ code: "custom", message: "Source assessment has inconsistent local request timestamps." });
  if (value.transport) {
    const inspection = inspectSwarmFreshness(value.transport, value.scannedAt);
    if (inspection.stale || inspection.freshness !== value.transport.freshness || inspection.reason !== value.transport.reason)
      context.addIssue({ code: "custom", message: "Source assessment freshness does not match its source clock window." });
    if (value.transport.start.requestedAt !== value.requestedAt || value.transport.result.receivedAt > value.checkedAt)
      context.addIssue({ code: "custom", message: "Source assessment transport does not match its request timestamps." });
  } else if (scanned < Math.floor(requested / 1000) * 1000 || scanned > checked + 1000) {
    // Legacy snapshots predate source-clock metadata and retain their original boundary.
    context.addIssue({ code: "custom", message: "Legacy source assessment does not fit its request time window." });
  }
  if (value.candidates && new Set(value.candidates.map((row) => row.address)).size !== value.candidates.length)
    context.addIssue({ code: "custom", message: "Source candidates must have unique addresses." });
  if (value.candidates?.some((row) => new Set(row.roles).size !== row.roles.length))
    context.addIssue({ code: "custom", message: "Source candidate roles must be unique." });
});

export type SwarmAssessmentSnapshot = z.infer<typeof swarmAssessmentSnapshotSchema>;

export function validateSwarmAssessmentSnapshot(value: unknown, tokenAddress: string): SwarmAssessmentSnapshot {
  const token = address.parse(tokenAddress.toLowerCase());
  const snapshot = swarmAssessmentSnapshotSchema.parse(value);
  if (snapshot.tokenAddress !== token) throw new Error("SWARM assessment token does not match the requested Base token.");
  return snapshot;
}
