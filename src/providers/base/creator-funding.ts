import { z } from "zod";
import type { Address, BlockReference, CreatorFundingCoverage, EvidenceRecord, Hash } from "@/domain/investigations/types";
import type { FundingHistoryPage } from "./core";
import { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "./errors";

const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform((value) => value as Hash);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66);
const transactionSchema = z.object({ hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity, from: address, to: address.nullable(), value: quantity });
const pageSchema = z.object({ items: z.array(z.object({ hash, blockNumber: z.string().regex(/^(0|[1-9][0-9]{0,23})$/) })).max(100), nextCursor: z.object({ pageKey: z.string().regex(/^[A-Za-z0-9._:-]{1,512}$/) }).strict().nullable() });
const code = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(131_074);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderIntegrityError("Malformed creator funding evidence.");
  return parsed.data;
}

/** Bounded source query with canonical proofs. Each completed page commits
 * atomically, and its coverage never upgrades a recipient's inbound history. */
export async function collectCreatorFunding(options: {
  creator: Address; cohort: Address[]; from: BlockReference; to: BlockReference; observedAt: string; maxEvidence: number;
  query(cursor: FundingHistoryPage["nextCursor"]): Promise<FundingHistoryPage>;
  request(method: string, params: unknown[]): Promise<unknown>;
  receipt(hash: Hash): Promise<{ transactionHash: Hash; blockHash: Hash; blockNumber: string; transactionIndex: string; status: "0x0" | "0x1" }>;
  canonicalBlock(number: string, hash: Hash): Promise<BlockReference>;
  signal?: AbortSignal;
}): Promise<{ coverage: CreatorFundingCoverage; evidence: EvidenceRecord[] }> {
  const cohort = [...new Set(options.cohort)].sort();
  const coverage: CreatorFundingCoverage = { creator: options.creator, source: "alchemy-transfers", scope: "direct-creator-external-native", status: "unavailable", fromBlock: options.from.number, toBlock: options.to.number, cohort, evidenceIds: [], paginationExhausted: false, internalTransfers: "not_examined", reason: "Creator funding query did not complete." };
  const evidence = new Map<string, EvidenceRecord>();
  const identities = new Map<Hash, string>();
  const cursors = new Set<string>();
  let next: FundingHistoryPage["nextCursor"] = null;
  let oldest = BigInt(options.to.number);
  try {
    for (let index = 0; index < 2; index++) {
      options.signal?.throwIfAborted();
      const page: z.infer<typeof pageSchema> = parse(pageSchema, await options.query(next));
      const staged = new Map<string, EvidenceRecord>();
      const stagedIdentities = new Map<Hash, string>();
      let pageOldest = oldest;
      for (const item of page.items) {
        options.signal?.throwIfAborted();
        const number = BigInt(item.blockNumber);
        if (number < BigInt(options.from.number) || number > BigInt(options.to.number) || number > pageOldest) throw new ProviderIntegrityError("Creator funding range or ordering disagreed.");
        pageOldest = number;
        const transaction = parse(transactionSchema, await options.request("eth_getTransactionByHash", [item.hash]));
        if (transaction.hash !== item.hash || BigInt(transaction.blockNumber) !== number || transaction.from !== options.creator || BigInt(transaction.value) >= 2n ** 256n) throw new ProviderIntegrityError("Creator funding transaction identity disagreed.");
        const identity = `${transaction.blockHash}:${number}:${transaction.transactionIndex}:${transaction.from}:${transaction.to}:${transaction.value}`;
        const prior = stagedIdentities.get(item.hash) ?? identities.get(item.hash);
        if (prior !== undefined && prior !== identity) throw new ProviderIntegrityError("Repeated creator funding transaction disagreed.");
        const receipt = await options.receipt(item.hash);
        if (receipt.transactionHash !== item.hash || receipt.blockHash !== transaction.blockHash || receipt.blockNumber !== transaction.blockNumber || receipt.transactionIndex !== transaction.transactionIndex) throw new ProviderIntegrityError("Creator funding receipt disagreed.");
        const block = await options.canonicalBlock(transaction.blockNumber, transaction.blockHash);
        if (block.number !== number.toString() || block.hash !== transaction.blockHash) throw new ProviderIntegrityError("Creator funding canonical block disagreed.");
        stagedIdentities.set(item.hash, identity);
        if (!transaction.to || !cohort.includes(transaction.to) || transaction.to === options.creator || BigInt(transaction.value) === 0n || receipt.status !== "0x1") continue;
        if (parse(code, await options.request("eth_getCode", [transaction.to, transaction.blockNumber])) !== "0x") continue;
        const transactionIndex = Number(BigInt(transaction.transactionIndex));
        if (!Number.isSafeInteger(transactionIndex)) throw new ProviderIntegrityError("Creator funding position exceeded its bound.");
        const id = `8453:${transaction.blockHash}:${transaction.hash}:native`;
        staged.set(id, { id, kind: "funding", chainId: 8453, blockNumber: number.toString(), blockHash: transaction.blockHash, transactionHash: transaction.hash, transactionIndex, logIndex: null, traceId: null, timestamp: block.timestamp, from: options.creator, to: transaction.to, assetAddress: null, amountRaw: BigInt(transaction.value).toString(), provenance: { provider: "Alchemy + Base RPC", method: "creator external transactions discovery + canonical transaction/receipt/historical code verification", observedAt: options.observedAt }, sale: null });
      }
      if (new Set([...evidence.keys(), ...staged.keys()]).size > options.maxEvidence) throw new ProviderBudgetError();
      options.signal?.throwIfAborted();
      for (const [key, value] of staged) evidence.set(key, value);
      for (const [key, value] of stagedIdentities) identities.set(key, value);
      oldest = pageOldest;
      coverage.status = "partial";
      if (page.nextCursor === null) {
        coverage.status = "complete";
        coverage.paginationExhausted = true;
        break;
      }
      next = page.nextCursor;
      const key = JSON.stringify(next);
      if (cursors.has(key)) throw new UpstreamFailure();
      cursors.add(key);
    }
    coverage.reason = coverage.status === "complete"
      ? "Completed indexed direct-creator external-native query for the declared cohort and range, with canonical candidate verification. Index omissions, internal transfers and recipient inbound histories remain outside this claim."
      : "Creator query reached its two-page bound; retained complete pages do not establish absence of further funding.";
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError)) throw error;
    coverage.reason = "Creator funding query or canonical verification stopped at the shared provider budget or availability limit; only fully verified pages were retained.";
  }
  coverage.evidenceIds = [...evidence.keys()].sort();
  return { coverage, evidence: [...evidence.values()] };
}
