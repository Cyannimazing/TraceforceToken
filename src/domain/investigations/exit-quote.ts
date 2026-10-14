import { z } from "@/lib/validation";
import type { Address, BlockReference, Hash, HolderSnapshot, TokenDetails, WalletActivitySnapshot } from "./types";

export const EXIT_QUOTE_V2_FACTORY = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6" as Address;
export const EXIT_QUOTE_V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd" as Address;
/** Official Base deployment: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments */
export const BASE_V3_QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a" as Address;
export const EXIT_QUOTE_ASSUMPTIONS = [
  "One selected pool at the declared finalized block; no routing across other pools.",
  "Pool swap fees are included. Transfer taxes, token restrictions, approvals and execution gas are not verified.",
  "A quote is not a successful transaction or a guarantee that this wallet can sell.",
] as const;
const MAX_UINT256 = (1n << 256n) - 1n;
const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/).transform((value) => value as Hash);
const raw = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/).refine((value) => BigInt(value) <= MAX_UINT256);
const positive = raw.refine((value) => BigInt(value) > 0n);
const block = z.object({ number: raw, hash, timestamp: z.number().int().nonnegative().safe() }).strict();

/** Exact integer calculation; the fraction is reduced to preserve Uniswap V2's uint256 overflow boundary. */
export function feeAwareV2AmountOut(amountInRaw: string, reserveInRaw: string, reserveOutRaw: string, feePips = 3000): string {
  const amountIn = BigInt(positive.parse(amountInRaw)), reserveIn = BigInt(positive.parse(reserveInRaw)), reserveOut = BigInt(positive.parse(reserveOutRaw));
  if (!Number.isInteger(feePips) || feePips < 0 || feePips >= 1_000_000 || reserveIn >= 1n << 112n || reserveOut >= 1n << 112n) throw new Error("Unsupported constant-product quote parameters.");
  let numeratorFactor = BigInt(1_000_000 - feePips), denominatorFactor = 1_000_000n;
  let left = numeratorFactor, right = denominatorFactor;
  while (right) { const remainder = left % right; left = right; right = remainder; }
  numeratorFactor /= left; denominatorFactor /= left;
  const amountWithFee = amountIn * numeratorFactor;
  const numerator = amountWithFee * reserveOut, denominator = reserveIn * denominatorFactor + amountWithFee;
  if (amountWithFee > MAX_UINT256 || numerator > MAX_UINT256 || denominator > MAX_UINT256) throw new Error("The V2 quote exceeds uint256 arithmetic.");
  return (numerator / denominator).toString();
}

export function largestVerifiedEoaHolding(holders?: HolderSnapshot, activity?: WalletActivitySnapshot, excludedAddresses: readonly Address[] = []): { wallet: Address; amountInRaw: string } | null {
  if (!holders || !activity || holders.block.number !== activity.block.number || holders.block.hash !== activity.block.hash || holders.block.timestamp !== activity.block.timestamp) return null;
  const eoa = new Set(activity.rows.filter((row) => row.code === "eoa").map((row) => row.address));
  const excluded = new Set<Address>(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", ...excludedAddresses]);
  const eligible = holders.holders.filter((row) => row.status === "verified" && row.balanceRaw !== null && BigInt(row.balanceRaw) > 0n && eoa.has(row.address) && !excluded.has(row.address));
  eligible.sort((a, b) => BigInt(a.balanceRaw!) === BigInt(b.balanceRaw!) ? a.address.localeCompare(b.address) : BigInt(a.balanceRaw!) > BigInt(b.balanceRaw!) ? -1 : 1);
  return eligible.length ? { wallet: eligible[0].address, amountInRaw: eligible[0].balanceRaw! } : null;
}

export const exitQuoteSchema = z.object({
  schemaVersion: z.literal(1), chainId: z.literal(8453), scope: z.literal("largest-verified-eoa-selected-pool"),
  tokenAddress: address, block, observedAt: z.iso.datetime(),
  pool: address.nullable(), factory: address.nullable(), wallet: address.nullable(), amountInRaw: positive.nullable(),
  quoteAsset: address.nullable(), protocol: z.enum(["uniswap-v2", "uniswap-v3"]).nullable(),
  status: z.enum(["quoted", "unknown", "unsupported"]), amountOutRaw: positive.nullable(), feePips: z.number().int().min(0).max(999_999).nullable(),
  method: z.enum(["v2-reserves-with-fee", "v3-quoter-v2"]).nullable(),
  v2: z.object({ reserveInRaw: positive, reserveOutRaw: positive }).strict().nullable(),
  v3: z.object({ quoter: z.literal(BASE_V3_QUOTER_V2), sqrtPriceX96Before: positive, sqrtPriceX96After: positive,
    initializedTicksCrossed: z.number().int().min(0).max(4_294_967_295), gasEstimateRaw: raw }).strict().nullable(),
  inputConsumption: z.enum(["assumed-full", "not-proven"]).nullable(),
  reason: z.string().min(1).max(1000).nullable(),
  assumptions: z.tuple([z.literal(EXIT_QUOTE_ASSUMPTIONS[0]), z.literal(EXIT_QUOTE_ASSUMPTIONS[1]), z.literal(EXIT_QUOTE_ASSUMPTIONS[2])]),
}).strict().superRefine((value, context) => {
  const reject = (message: string) => context.addIssue({ code: "custom", message });
  if ((value.wallet === null) !== (value.amountInRaw === null)) reject("Exit quote input must identify its wallet and positive holding together.");
  if (value.quoteAsset === value.tokenAddress || value.pool === value.tokenAddress) reject("Exit quote pool or output asset conflicts with the token.");
  if (value.protocol === "uniswap-v2" && value.factory !== EXIT_QUOTE_V2_FACTORY || value.protocol === "uniswap-v3" && value.factory !== EXIT_QUOTE_V3_FACTORY) reject("Exit quote requires the official protocol factory.");
  if (value.status !== "quoted") {
    if (value.amountOutRaw !== null || value.feePips !== null || value.method !== null || value.v2 !== null || value.v3 !== null || value.inputConsumption !== null || value.reason === null) reject("Unknown or unsupported exits cannot carry successful quote measurements.");
    return;
  }
  if (value.pool === null || value.wallet === null || value.amountInRaw === null || value.quoteAsset === null || value.reason !== null || value.amountOutRaw === null) { reject("Successful exit quote has missing identity or amounts."); return; }
  if (value.protocol === "uniswap-v2") {
    if (value.method !== "v2-reserves-with-fee" || value.feePips !== 3000 || value.v2 === null || value.v3 !== null || value.inputConsumption !== "assumed-full") { reject("Inconsistent fee-aware V2 quote."); return; }
    try {
      if (BigInt(value.v2.reserveInRaw) + BigInt(value.amountInRaw) >= 1n << 112n) reject("V2 input would overflow the pool's post-swap reserve.");
      if (feeAwareV2AmountOut(value.amountInRaw, value.v2.reserveInRaw, value.v2.reserveOutRaw, 3000) !== value.amountOutRaw) reject("V2 output does not match its exact reserves, fee and input.");
    }
    catch { reject("Invalid V2 quote arithmetic."); }
  } else if (value.protocol === "uniswap-v3") {
    if (value.method !== "v3-quoter-v2" || value.feePips === null || value.v3 === null || value.v2 !== null || value.inputConsumption !== "not-proven") { reject("Inconsistent tick-aware V3 quote."); return; }
    const before = BigInt(value.v3.sqrtPriceX96Before), after = BigInt(value.v3.sqrtPriceX96After);
    const minimum = 4_295_128_739n, maximum = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
    if (before < minimum || before >= maximum || after <= minimum || after >= maximum || BigInt(value.amountInRaw) >= 1n << 255n
      || (value.tokenAddress < value.quoteAsset ? after > before : after < before)) reject("V3 quote has invalid square-root price direction or integer bounds.");
  } else reject("Successful exit quote lacks a supported protocol.");
});
export type ExitQuoteSnapshot = z.infer<typeof exitQuoteSchema>;

export function validateExitQuote(value: unknown, token: TokenDetails, expectedBlock: BlockReference,
  holders?: HolderSnapshot, activity?: WalletActivitySnapshot, authenticatedPools?: readonly Address[]): ExitQuoteSnapshot {
  const quote = exitQuoteSchema.parse(value);
  if (quote.tokenAddress !== token.address || quote.chainId !== token.chainId || quote.block.number !== expectedBlock.number
    || quote.block.hash !== expectedBlock.hash || quote.block.timestamp !== expectedBlock.timestamp) throw new Error("Exit quote does not match the investigated token and finalized block.");
  if (holders && (holders.tokenAddress !== token.address || holders.chainId !== token.chainId || holders.block.number !== expectedBlock.number
    || holders.block.hash !== expectedBlock.hash || holders.block.timestamp !== expectedBlock.timestamp)
    || activity && (activity.block.number !== expectedBlock.number || activity.block.hash !== expectedBlock.hash || activity.block.timestamp !== expectedBlock.timestamp)) throw new Error("Exit quote inputs do not match its pinned token and block.");
  const largest = largestVerifiedEoaHolding(holders, activity, authenticatedPools);
  if (quote.wallet !== (largest?.wallet ?? null) || quote.amountInRaw !== (largest?.amountInRaw ?? null)) throw new Error("Exit quote does not match the largest verified positive EOA holding.");
  if (quote.status === "quoted" && authenticatedPools && !authenticatedPools.includes(quote.pool!)) throw new Error("Exit quote pool is not authenticated in this report.");
  return quote;
}
