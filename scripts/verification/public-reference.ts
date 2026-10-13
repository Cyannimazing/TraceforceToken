import { z } from "zod";
import type { InvestigationReport } from "../../src/domain/investigations/types";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { deriveHolderTableDistribution } from "../../src/domain/investigations/holder-table-distribution";
import { exactPercent } from "../../src/domain/investigations/report-distribution";
import { createDeadline } from "../../src/lib/deadline";

const shareSchema = z.number().finite().min(0).max(1);
const cachedReferenceSchema = z.object({ result: z.object({
  scanned_at: z.number().int().nonnegative(), score: z.number().finite().min(0).max(100),
  metrics: z.object({ biggest: shareSchema, snipers: shareSchema, dev: shareSchema }),
  holders: z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), share: shareSchema })).max(500),
}).nullable() });
const MAX_REFERENCE_BYTES = 1_048_576;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Reference body unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_REFERENCE_BYTES) { await reader.cancel(); throw new Error("Reference body exceeds limit"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** One public cached GET; a different block or scoring policy is not ground truth.
 * Raw cache data remains in process memory and is never archived. */
export async function verifyPublicReference(report: InvestigationReport, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  signal.throwIfAborted();
  const deadline = createDeadline(15_000, [signal]);
  try {
    const response = await fetcher(`https://swarmengine.tech/api/token/base/${report.token.address}`, {
      method: "GET", signal: deadline.signal, redirect: "error", cache: "no-store",
    });
    if (!response.ok) return { status: "unavailable" as const, reason: "public-cache-unavailable", freshScanRequested: false };
    const parsed = cachedReferenceSchema.safeParse(await boundedJson(response));
    if (!parsed.success || !parsed.data.result) return { status: "unavailable" as const, reason: "public-cache-shape-unavailable", freshScanRequested: false };
    const reference = parsed.data.result, table = deriveHolderTableDistribution(report), assessment = assessInvestigationReport(report);
    const holders = new Map(reference.holders.map((holder) => [holder.address.toLowerCase(), holder.share]));
    const localAddresses = new Set<string>(table.holders.map((holder) => holder.address));
    const walletsMissingFromReference = [...localAddresses].filter((address) => !holders.has(address)).length;
    const walletsMissingFromLocal = [...holders.keys()].filter((address) => !localAddresses.has(address)).length;
    const duplicateReferenceWallets = reference.holders.length - holders.size;
    const walletSetsMatch = walletsMissingFromReference === 0 && walletsMissingFromLocal === 0 && duplicateReferenceWallets === 0;
    const tolerancePercent = 0.05; // Half a one-decimal percentage display step.
    const delta = (local: string | null, fractionalReference: number) => local === null ? null : Math.abs(Number(local) - fractionalReference * 100);
    const metrics = {
      largest: { localPercent: assessment.metrics.largestSharePercent, referencePercent: reference.metrics.biggest * 100, absoluteDeltaPercent: delta(assessment.metrics.largestSharePercent, reference.metrics.biggest) },
      snipers: { localPercent: assessment.metrics.sniperSharePercent, referencePercent: reference.metrics.snipers * 100, absoluteDeltaPercent: delta(assessment.metrics.sniperSharePercent, reference.metrics.snipers) },
      creator: { localPercent: assessment.metrics.creatorSharePercent, referencePercent: reference.metrics.dev * 100, absoluteDeltaPercent: delta(assessment.metrics.creatorSharePercent, reference.metrics.dev) },
    };
    let comparedWallets = 0, matchedWallets = 0, maximumWalletDeltaPercent = 0;
    if (table.holdingDenominatorRaw !== null) for (const holder of table.holders) {
      const referenceShare = holders.get(holder.address);
      if (referenceShare === undefined) continue;
      const local = exactPercent(BigInt(holder.balanceRaw!), BigInt(table.holdingDenominatorRaw));
      if (local === null) continue;
      const difference = Math.abs(Number(local) - referenceShare * 100);
      comparedWallets++;
      maximumWalletDeltaPercent = Math.max(maximumWalletDeltaPercent, difference);
      if (difference <= tolerancePercent + 1e-10) matchedWallets++;
    }
    const metricDifferences = Object.values(metrics).map((metric) => metric.absoluteDeltaPercent);
    const matched = walletSetsMatch && comparedWallets > 0 && comparedWallets === table.holders.length
      && comparedWallets === reference.holders.length && comparedWallets === matchedWallets
      && metricDifferences.every((difference) => difference !== null && difference <= tolerancePercent + 1e-10);
    return {
      status: matched ? "matched-at-reference-display-precision" as const : "different-snapshots-or-definitions" as const,
      checkedAt: new Date().toISOString(), referenceScannedAt: new Date(reference.scanned_at * 1000).toISOString(), localSnapshotAt: new Date(report.range.to.timestamp * 1000).toISOString(),
      cachedReferenceScore: reference.score, localEarnedScore: assessment.displayedScore, scorePolicyComparable: false,
      referenceWallets: reference.holders.length, localWallets: table.holders.length, comparedWallets, matchedWallets, maximumWalletDeltaPercent, tolerancePercent,
      walletSetsMatch, walletsMissingFromReference, walletsMissingFromLocal, duplicateReferenceWallets,
      metrics, freshScanRequested: false, rawCacheArchived: false,
      limitation: "The public cache and local scan can describe different blocks. Agreement is a display cross-check, not an independent same-block verification, holder census, or proof of equal scoring policy.",
    };
  } catch {
    signal.throwIfAborted();
    return { status: "unavailable" as const, reason: "public-cache-read-failed", freshScanRequested: false };
  } finally { deadline.dispose(); }
}
