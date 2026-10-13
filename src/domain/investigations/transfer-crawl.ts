import { z } from "@/lib/validation";
import type { InvestigationDataset } from "./types";

const blockNumber = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const transferCrawlSchema = z.object({
  scope: z.enum(["full", "window"]),
  source: z.enum(["rpc-logs", "alchemy-transfers"]),
  completedRanges: z.array(z.object({ fromBlock: blockNumber, toBlock: blockNumber }).strict()).max(2000),
}).strict();

/** A completed full crawl cannot hide a missing or overlapping requested range. */
export function validateTransferCrawl(value: unknown, range: InvestigationDataset["range"], status: InvestigationDataset["coverage"]["transfers"]) {
  const crawl = transferCrawlSchema.parse(value);
  const first = BigInt(range.from.number), last = BigInt(range.to.number);
  if (first > last || (crawl.scope === "full" && first !== 0n)) throw new Error("Invalid transfer crawl range.");
  let next = first;
  const ranges = [...crawl.completedRanges].sort((a, b) => BigInt(a.fromBlock) < BigInt(b.fromBlock) ? -1 : BigInt(a.fromBlock) > BigInt(b.fromBlock) ? 1 : 0);
  for (const item of ranges) {
    const start = BigInt(item.fromBlock), end = BigInt(item.toBlock);
    if (start < first || end > last || start > end || start < next) throw new Error("Invalid completed transfer range.");
    if (status === "complete" && start !== next) throw new Error("Complete transfer coverage has a gap.");
    next = end + 1n;
  }
  if (status === "complete" && next !== last + 1n) throw new Error("Complete transfer coverage has a gap.");
  return { ...crawl, completedRanges: ranges };
}
