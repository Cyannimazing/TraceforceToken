import { z } from "zod";
import type { Address, Hash } from "@/domain/investigations/types";
import { ProviderIntegrityError } from "./errors";

export interface TokenTransferPageQuery {
  token: Address;
  fromBlock: string;
  toBlock: string;
  cursor: string | null;
}
export interface TokenTransferPage {
  items: { hash: Hash; blockNumber: string }[];
  nextCursor: string | null;
}
export type TokenTransferPageReader = (query: TokenTransferPageQuery) => Promise<TokenTransferPage>;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hash);
const blockSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(24);
const cursorSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);
const querySchema = z.object({ token: addressSchema, fromBlock: blockSchema, toBlock: blockSchema, cursor: cursorSchema.nullable() });
const resultSchema = z.object({
  transfers: z.array(z.object({
    blockNum: z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66),
    hash: hashSchema,
    category: z.literal("erc20"),
    rawContract: z.object({ address: addressSchema }),
  })).max(1000),
  pageKey: z.union([cursorSchema, z.literal(""), z.null()]).optional(),
});

/** Indexed identities only. All published amounts and logs come from verified
 * canonical receipts, never the API's approximate value/rawContract metadata.
 * The injected RPC must stay on the configured Alchemy lane across page keys. */
export function createAlchemyTransferPageReader(rpc: (method: string, params: unknown[]) => Promise<unknown>): TokenTransferPageReader {
  return async (query) => {
    const input = querySchema.safeParse(query);
    if (!input.success || BigInt(input.data.fromBlock) > BigInt(input.data.toBlock)) throw new ProviderIntegrityError("The indexed token-transfer query was invalid.");
    const { token, fromBlock, toBlock, cursor } = input.data;
    const raw = await rpc("alchemy_getAssetTransfers", [{
      fromBlock: `0x${BigInt(fromBlock).toString(16)}`, toBlock: `0x${BigInt(toBlock).toString(16)}`,
      contractAddresses: [token], category: ["erc20"], order: "asc", excludeZeroValue: false,
      withMetadata: false, maxCount: "0x3e8", ...(cursor ? { pageKey: cursor } : {}),
    }]);
    const result = resultSchema.safeParse(raw);
    if (!result.success) throw new ProviderIntegrityError("The indexed token-transfer page was malformed.");
    const items: TokenTransferPage["items"] = [], seen = new Map<Hash, string>();
    let previousBlock = BigInt(fromBlock);
    for (const transfer of result.data.transfers) {
      const block = BigInt(transfer.blockNum), blockNumber = block.toString();
      if (transfer.rawContract.address !== token || block < BigInt(fromBlock) || block > BigInt(toBlock) || block < previousBlock) throw new ProviderIntegrityError("The indexed token-transfer page disagreed with the declared token, range or ordering.");
      previousBlock = block;
      const prior = seen.get(transfer.hash);
      if (prior !== undefined && prior !== blockNumber) throw new ProviderIntegrityError("An indexed transaction appeared at conflicting block numbers.");
      if (prior === undefined) items.push({ hash: transfer.hash, blockNumber });
      seen.set(transfer.hash, blockNumber);
    }
    return { items, nextCursor: result.data.pageKey || null };
  };
}
