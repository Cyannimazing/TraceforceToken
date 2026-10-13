import { z } from "zod";
import type { Address, Hash } from "@/domain/investigations/types";
import type { FundingHistoryPage } from "./core";
import { ProviderIntegrityError } from "./errors";

export type AlchemyFundingHistoryReader = (
  wallet: Address,
  cursor: Record<string, string | number> | null,
  range: { fromBlock: string; toBlock: string },
) => Promise<FundingHistoryPage>;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hash);
const decimalBlockSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(24);
const quantitySchema = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66);
const pageKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,512}$/);
const querySchema = z.object({
  wallet: addressSchema,
  cursor: z.object({ pageKey: pageKeySchema }).strict().nullable(),
  range: z.object({ fromBlock: decimalBlockSchema, toBlock: decimalBlockSchema }).strict(),
});
const resultSchema = z.object({
  transfers: z.array(z.object({
    hash: hashSchema,
    blockNum: quantitySchema,
    from: addressSchema,
    to: addressSchema,
    category: z.literal("external"),
    rawContract: z.object({ address: z.null() }),
    uniqueId: z.string().max(80).optional(),
  })).max(100),
  pageKey: z.union([pageKeySchema, z.literal(""), z.null()]).optional(),
});

/** Recipient-filtered top-level native transaction identities only. Index amounts
 * are discarded; core verifies the exact canonical transaction, successful
 * receipt and historical recipient code before publishing funding evidence.
 * Keep the injected RPC on one configured Alchemy lane for all page keys.
 * https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers */
export function createAlchemyFundingHistoryReader(
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  direction: "inbound" | "outbound" = "inbound",
): AlchemyFundingHistoryReader {
  return async (wallet, cursor, range) => {
    const query = querySchema.safeParse({ wallet, cursor, range });
    if (!query.success || BigInt(query.data.range.fromBlock) > BigInt(query.data.range.toBlock)) {
      throw new ProviderIntegrityError("The indexed funding query was invalid.");
    }
    const recipient = query.data.wallet;
    const fromBlock = BigInt(query.data.range.fromBlock), toBlock = BigInt(query.data.range.toBlock);
    const raw = await rpc("alchemy_getAssetTransfers", [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      ...(direction === "inbound" ? { toAddress: recipient } : { fromAddress: recipient }),
      category: ["external"],
      excludeZeroValue: true,
      order: "desc",
      maxCount: "0x64",
      withMetadata: false,
      ...(query.data.cursor ? { pageKey: query.data.cursor.pageKey } : {}),
    }]);
    const result = resultSchema.safeParse(raw);
    if (!result.success) throw new ProviderIntegrityError("The indexed funding page was malformed.");

    const items: FundingHistoryPage["items"] = [];
    const seen = new Map<Hash, { blockNumber: string; from: Address }>();
    let previousBlock = toBlock;
    for (const transfer of result.data.transfers) {
      const block = BigInt(transfer.blockNum), blockNumber = block.toString();
      if ((direction === "inbound" ? transfer.to : transfer.from) !== recipient || block < fromBlock || block > toBlock || block > previousBlock
        || (transfer.uniqueId !== undefined && transfer.uniqueId.toLowerCase() !== `${transfer.hash}:external`)) {
        throw new ProviderIntegrityError("The indexed funding page disagreed with the recipient, range, ordering or transaction identity.");
      }
      previousBlock = block;
      const prior = seen.get(transfer.hash);
      const counterpart = direction === "inbound" ? transfer.from : transfer.to;
      if (prior && (prior.blockNumber !== blockNumber || prior.from !== counterpart)) {
        throw new ProviderIntegrityError("An indexed funding transaction had conflicting identities.");
      }
      if (!prior) items.push({ hash: transfer.hash, blockNumber });
      seen.set(transfer.hash, { blockNumber, from: counterpart });
    }
    return { items, nextCursor: result.data.pageKey ? { pageKey: result.data.pageKey } : null };
  };
}
