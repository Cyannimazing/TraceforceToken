import { z } from "@/lib/validation";
import type { BlockReference, EvidenceRecord, LiquiditySnapshot, WalletActivitySnapshot } from "./types";

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const raw = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => BigInt(value) < 2n ** 256n);
const block = z.object({ number: raw, hash: z.string().regex(/^0x[0-9a-f]{64}$/), timestamp: z.number().int().nonnegative().safe() }).strict();
export const walletActivitySnapshotSchema = z.object({ block, rows: z.array(z.object({ address, outgoingTransactionCountRaw: raw.nullable(), code: z.enum(["eoa", "contract", "unavailable"]) }).strict()).max(2000) }).strict();
export const liquiditySnapshotSchema = z.object({ protocol: z.literal("uniswap-v2"), pool: address, factory: z.literal("0x8909dc15e40173ff4699343b6eb8132c65e18ec6"), token0: address, token1: address,
  reserve0Raw: raw.refine((value) => BigInt(value) > 0n && BigInt(value) < 2n ** 112n), reserve1Raw: raw.refine((value) => BigInt(value) > 0n && BigInt(value) < 2n ** 112n), block,
  provenance: z.object({ provider: z.string().min(1).max(128), method: z.string().min(1).max(128), observedAt: z.iso.datetime() }).strict(),
}).strict();
const support = z.array(z.string().min(1).max(255)).min(1).max(1000);
export const purchaseSchema = z.object({ pool: address, factory: address, protocol: z.enum(["uniswap-v2", "uniswap-v3"]), quoteAsset: address, quoteAmountRaw: raw.refine((value) => BigInt(value) > 0n), swapLogIndex: z.number().int().nonnegative().safe(), supportingEvidenceIds: support, nativeInputRaw: raw.optional() }).strict();
export const initialLiquiditySchema = z.object({ pool: address, factory: z.literal("0x8909dc15e40173ff4699343b6eb8132c65e18ec6"), protocol: z.literal("uniswap-v2"), mintLogIndex: z.number().int().nonnegative().safe(), initial: z.literal(true), supportingEvidenceIds: support }).strict();

/** An annotation cannot survive with a trimmed or unrelated receipt proof. */
export function validateMarketAnnotations(records: EvidenceRecord[], token: string) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const zero = `0x${"0".repeat(40)}`;
  const net = (proof: EvidenceRecord[], wallet: string, asset: string) => proof.filter((record) => record.assetAddress === asset).reduce((value, record) => value + (record.to === wallet ? BigInt(record.amountRaw) : 0n) - (record.from === wallet ? BigInt(record.amountRaw) : 0n), 0n);
  const direct = (proof: EvidenceRecord[], from: string, to: string, asset: string) => proof.filter((record) => record.assetAddress === asset && record.from === from && record.to === to).reduce((value, record) => value + BigInt(record.amountRaw), 0n);
  for (const event of records) for (const metadata of [event.purchase, event.liquidity]) {
    if (!metadata) continue;
    const ids = metadata.supportingEvidenceIds, proof = ids.map((id) => byId.get(id));
    if (event.kind !== "transfer" || event.assetAddress !== token || BigInt(event.amountRaw) <= 0n || !ids.includes(event.id) || new Set(ids).size !== ids.length
      || proof.some((record) => !record || record.kind !== "transfer" || record.transactionHash !== event.transactionHash || record.blockHash !== event.blockHash || record.blockNumber !== event.blockNumber || record.transactionIndex !== event.transactionIndex || record.timestamp !== event.timestamp)) throw new Error("Incomplete market receipt proof.");
    const transfers = proof as EvidenceRecord[];
    if ("quoteAsset" in metadata) {
      const factory = metadata.protocol === "uniswap-v2" ? "0x8909dc15e40173ff4699343b6eb8132c65e18ec6" : "0x33128a8fc17869897dce68ed026d694621f6fdfd";
      const quote = BigInt(metadata.quoteAmountRaw), walletQuote = net(transfers, event.to, metadata.quoteAsset);
      const nativeRouterQuote = transfers.filter((record) => record.assetAddress === metadata.quoteAsset && record.from === "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24" && record.to === metadata.pool).reduce((sum, record) => sum + BigInt(record.amountRaw), 0n);
      const complete = records.filter((record) => record.kind === "transfer" && record.transactionHash === event.transactionHash && (record.assetAddress === token || record.assetAddress === metadata.quoteAsset));
      if (complete.length !== transfers.length || complete.some((record) => !ids.includes(record.id))) throw new Error("Omitted market receipt transfers.");
      if (metadata.factory !== factory || event.from !== metadata.pool || event.to === zero || [token, zero, metadata.pool].includes(metadata.quoteAsset) || net(transfers, event.to, token) !== BigInt(event.amountRaw) || net(transfers, metadata.pool, token) !== -BigInt(event.amountRaw) || direct(transfers, metadata.pool, event.to, token) !== BigInt(event.amountRaw) || net(transfers, metadata.pool, metadata.quoteAsset) !== quote
        || !(metadata.nativeInputRaw === undefined && walletQuote === -quote && direct(transfers, event.to, metadata.pool, metadata.quoteAsset) === quote || walletQuote === 0n && metadata.nativeInputRaw === metadata.quoteAmountRaw && metadata.protocol === "uniswap-v2" && metadata.quoteAsset === "0x4200000000000000000000000000000000000006" && nativeRouterQuote === quote)
        || transfers.some((record) => record.logIndex === null || record.logIndex >= metadata.swapLogIndex)) throw new Error("Invalid purchase consideration proof.");
    } else {
      const quotes = new Set(transfers.filter((record) => record.assetAddress !== token && record.assetAddress !== metadata.pool && record.assetAddress !== zero && record.to === metadata.pool && BigInt(record.amountRaw) > 0n).map((record) => record.assetAddress));
      const complete = records.filter((record) => record.kind === "transfer" && record.transactionHash === event.transactionHash && [token, metadata.pool, ...quotes].includes(record.assetAddress));
      if (event.to !== metadata.pool || !transfers.some((record) => record.assetAddress === metadata.pool && record.from === zero && record.to === zero && record.amountRaw === "1000")
        || net(transfers, metadata.pool, token) <= 0n || quotes.size !== 1 || complete.length !== transfers.length || complete.some((record) => !ids.includes(record.id))
        || transfers.some((record) => record.logIndex === null || record.logIndex >= metadata.mintLogIndex)) throw new Error("Invalid first-liquidity proof.");
    }
  }
}
function pinned(actual: { number: string; hash: string; timestamp: number }, expected: BlockReference) { if (actual.number !== expected.number || actual.hash !== expected.hash || actual.timestamp !== expected.timestamp) throw new Error("Snapshot does not match the pinned block."); }
export function validateWalletActivitySnapshot(value: unknown, expected: BlockReference): WalletActivitySnapshot {
  const snapshot = walletActivitySnapshotSchema.parse(value); pinned(snapshot.block, expected);
  if (new Set(snapshot.rows.map((row) => row.address)).size !== snapshot.rows.length) throw new Error("Duplicate wallet activity row.");
  return snapshot as WalletActivitySnapshot;
}
export function validateLiquiditySnapshot(value: unknown, token: string, expected: BlockReference): LiquiditySnapshot {
  const snapshot = liquiditySnapshotSchema.parse(value); pinned(snapshot.block, expected);
  if (snapshot.token0 === snapshot.token1 || ![snapshot.token0, snapshot.token1].includes(token)) throw new Error("Invalid reserve asset identity.");
  return snapshot as LiquiditySnapshot;
}
