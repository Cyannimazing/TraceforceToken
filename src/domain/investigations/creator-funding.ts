import { z } from "@/lib/validation";
import type { Address, CreatorFundingCoverage, InvestigationDataset } from "./types";
import { deriveCreatorAttribution } from "./creator-attribution";

const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
const block = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const creatorFundingCoverageSchema: z.ZodType<CreatorFundingCoverage> = z.object({
  creator: address, source: z.literal("alchemy-transfers"), scope: z.literal("direct-creator-external-native"),
  status: z.enum(["complete", "partial", "unavailable", "not_examined"]), fromBlock: block, toBlock: block,
  cohort: z.array(address).max(2000), evidenceIds: z.array(z.string().min(1).max(255)).max(200),
  paginationExhausted: z.boolean(), internalTransfers: z.literal("not_examined"), reason: z.string().min(1).max(2000),
}).strict();

type Context = Pick<InvestigationDataset, "token" | "range" | "evidence" | "walletActivitySnapshot">;
export function validateCreatorFundingCoverage(value: unknown, context: Context): CreatorFundingCoverage {
  const coverage = creatorFundingCoverageSchema.parse(value);
  const creator = deriveCreatorAttribution(context);
  if (!creator || creator.address !== coverage.creator || creator.kind !== "direct-contract-creation"
    || coverage.fromBlock !== context.range.from.number || coverage.toBlock !== context.range.to.number
    || BigInt(coverage.fromBlock) > BigInt(coverage.toBlock)
    || (coverage.status === "complete") !== coverage.paginationExhausted
    || new Set(coverage.cohort).size !== coverage.cohort.length || coverage.cohort.includes(coverage.creator)
    || new Set(coverage.evidenceIds).size !== coverage.evidenceIds.length
    || (["not_examined", "unavailable"].includes(coverage.status) && coverage.evidenceIds.length > 0)) throw new Error("Invalid creator funding coverage.");
  const snapshot = context.walletActivitySnapshot;
  if (!snapshot || snapshot.block.number !== context.range.to.number || snapshot.block.hash !== context.range.to.hash || snapshot.block.timestamp !== context.range.to.timestamp
    || coverage.cohort.some((wallet) => !snapshot.rows.some((row) => row.address === wallet && row.code === "eoa"))) throw new Error("Creator funding cohort lacks pinned EOA classification.");
  const records = new Map(context.evidence.map((event) => [event.id, event]));
  for (const id of coverage.evidenceIds) {
    const event = records.get(id);
    if (!event || event.kind !== "funding" || event.assetAddress !== null || event.traceId !== null || event.from !== coverage.creator
      || !coverage.cohort.includes(event.to) || BigInt(event.amountRaw) <= 0n || BigInt(event.blockNumber) < BigInt(coverage.fromBlock)
      || BigInt(event.blockNumber) > BigInt(coverage.toBlock)) throw new Error("Creator funding proof is outside its query.");
  }
  return coverage;
}
