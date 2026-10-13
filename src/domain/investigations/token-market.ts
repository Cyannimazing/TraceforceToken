import { z } from "@/lib/validation";
import type { Address, TokenMarketSnapshot } from "./types";

export const MAX_MARKET_USD = 1e18;
export const MIN_PAIR_CREATED_AT = 946_684_800_000; // 2000-01-01, Unix milliseconds.
const PRICE_USD = /^(?:0|[1-9]\d{0,35})(?:\.\d{1,60})?$/;

/** Preserve the source's decimal spelling; never round a price through Number. */
export function normalizeMarketPrice(value: unknown): string | null {
  return typeof value === "string" && value.length <= 100 && PRICE_USD.test(value) ? value : null;
}

export function normalizeMarketUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MARKET_USD ? value : null;
}

export function normalizeMarketChange(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= -100 && value <= 1e9 ? value : null;
}

export function normalizePairCreatedAt(value: unknown, checkedAt: number): number | null {
  // Reject second-scale, future, and implausible dates rather than inventing age.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_PAIR_CREATED_AT && value <= checkedAt ? value : null;
}

const usd = z.number().min(0).max(MAX_MARKET_USD).nullable();
const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
export const tokenMarketSnapshotSchema: z.ZodType<TokenMarketSnapshot> = z.object({
  source: z.literal("dexscreener"),
  status: z.enum(["reported", "not_listed", "unavailable"]),
  checkedAt: z.iso.datetime(),
  sourceUrl: z.string().regex(/^https:\/\/api\.dexscreener\.com\/token-pairs\/v1\/base\/0x[0-9a-f]{40}$/),
  pairAddress: address.nullable(),
  priceUsd: z.string().refine((value) => normalizeMarketPrice(value) === value).nullable(),
  marketCapUsd: usd,
  liquidityUsd: usd,
  volume24hUsd: usd,
  priceChange24hPercent: z.number().min(-100).max(1e9).nullable(),
  pairCreatedAt: z.number().int().min(MIN_PAIR_CREATED_AT).nullable(),
}).strict().superRefine((value, context) => {
  const metrics = [value.priceUsd, value.marketCapUsd, value.liquidityUsd, value.volume24hUsd, value.priceChange24hPercent, value.pairCreatedAt];
  if ((value.status === "reported") !== (value.pairAddress !== null)
    || (value.status !== "reported" && metrics.some((metric) => metric !== null))
    || !Number.isFinite(Date.parse(value.checkedAt))
    || (value.pairCreatedAt !== null && normalizePairCreatedAt(value.pairCreatedAt, Date.parse(value.checkedAt)) === null)) {
    context.addIssue({ code: "custom", message: "Inconsistent source-reported market metadata." });
  }
});
