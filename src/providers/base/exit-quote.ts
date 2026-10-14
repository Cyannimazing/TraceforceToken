import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, BlockReference, Hash, HolderSnapshot, LiquiditySnapshot, TokenDetails, WalletActivitySnapshot } from "@/domain/investigations/types";
import { BASE_V3_QUOTER_V2, EXIT_QUOTE_ASSUMPTIONS, EXIT_QUOTE_V2_FACTORY, EXIT_QUOTE_V3_FACTORY, feeAwareV2AmountOut,
  largestVerifiedEoaHolding, validateExitQuote, type ExitQuoteSnapshot } from "@/domain/investigations/exit-quote";
import { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "./errors";

export const exitQuoteAbi = parseAbi([
  "function factory() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
export interface AuthenticatedExitPool {
  address: Address; factory: Address; token0: Address; token1: Address; protocol: "uniswap-v2" | "uniswap-v3"; feePips: number | null;
}
export interface CollectExitQuoteOptions {
  token: TokenDetails; block: BlockReference; observedAt: string;
  holderSnapshot?: HolderSnapshot; walletActivitySnapshot?: WalletActivitySnapshot;
  selectedPool: Address | null; authenticatedPool: AuthenticatedExitPool | null;
  authenticatedPools?: readonly Address[];
  /** True only when infrastructure authentication rejected the pair's protocol/identity. */
  unsupportedPool?: boolean;
  liquiditySnapshot?: LiquiditySnapshot;
  request(method: string, params: unknown[]): Promise<unknown>;
  remainingCalls(): number;
  signal?: AbortSignal;
  throttleError?: () => UpstreamFailure | null;
}
function sameBlock(left: BlockReference, right: BlockReference) { return left.number === right.number && left.hash === right.hash && left.timestamp === right.timestamp; }

/** A bounded pool quote, never a transfer simulation. Every eth_call is charged by the collector. */
export async function collectExitQuote(options: CollectExitQuoteOptions): Promise<ExitQuoteSnapshot> {
  const checkAbort = () => options.signal?.throwIfAborted();
  checkAbort();
  if (options.token.chainId !== 8453) throw new ProviderIntegrityError("Exit quotes only support the authenticated Base deployment.");
  const pool = options.authenticatedPool;
  const authenticatedPools = options.authenticatedPools ?? (pool ? [pool.address] : []);
  const largest = largestVerifiedEoaHolding(options.holderSnapshot, options.walletActivitySnapshot, authenticatedPools);
  if (pool && (options.selectedPool !== pool.address || pool.token0 === pool.token1 || ![pool.token0, pool.token1].includes(options.token.address)
    || pool.factory !== (pool.protocol === "uniswap-v2" ? EXIT_QUOTE_V2_FACTORY : EXIT_QUOTE_V3_FACTORY))) throw new ProviderIntegrityError("Exit quote pool does not match its authenticated market identity.");
  const quoteAsset = pool ? pool.token0 === options.token.address ? pool.token1 : pool.token0 : null;
  const empty: ExitQuoteSnapshot = {
    schemaVersion: 1, chainId: 8453, scope: "largest-verified-eoa-selected-pool", tokenAddress: options.token.address,
    block: { ...options.block }, observedAt: options.observedAt,
    pool: options.selectedPool, factory: pool?.factory ?? null, wallet: largest?.wallet ?? null, amountInRaw: largest?.amountInRaw ?? null,
    quoteAsset, protocol: pool?.protocol ?? null, status: "unknown", amountOutRaw: null, feePips: null,
    method: null, v2: null, v3: null, inputConsumption: null, reason: "No selected market pool was available.", assumptions: [...EXIT_QUOTE_ASSUMPTIONS],
  };
  const complete = (value: ExitQuoteSnapshot) => validateExitQuote(value, options.token, options.block,
    options.holderSnapshot, options.walletActivitySnapshot, authenticatedPools);
  if (!options.selectedPool) return complete(empty);
  if (!pool) return complete({ ...empty, status: options.unsupportedPool ? "unsupported" : "unknown",
    reason: options.unsupportedPool ? "The selected market is not an authenticated supported Uniswap V2 or V3 pool." : "The selected pool could not be authenticated within the acquisition allocation." });
  if (!largest) return complete({ ...empty, reason: "No positive holder balance with pinned EOA classification was verified for this quote." });
  if (pool.protocol === "uniswap-v2") {
    const liquidity = options.liquiditySnapshot;
    if (!liquidity || liquidity.pool !== pool.address || liquidity.factory !== pool.factory || liquidity.token0 !== pool.token0
      || liquidity.token1 !== pool.token1 || !sameBlock(liquidity.block, options.block)) return complete({ ...empty, reason: "Pinned reserves for the selected authenticated V2 pool are unavailable." });
    const reserveInRaw = pool.token0 === options.token.address ? liquidity.reserve0Raw : liquidity.reserve1Raw;
    const reserveOutRaw = pool.token0 === options.token.address ? liquidity.reserve1Raw : liquidity.reserve0Raw;
    if (BigInt(reserveInRaw) + BigInt(largest.amountInRaw) >= 1n << 112n) return complete({ ...empty,
      reason: "The requested V2 input would exceed the pool's uint112 reserve limit; a usable exit quote is unavailable." });
    let amountOutRaw: string;
    try { amountOutRaw = feeAwareV2AmountOut(largest.amountInRaw, reserveInRaw, reserveOutRaw, 3000); }
    catch { return complete({ ...empty, reason: "The selected V2 reserves or input do not support a bounded exact quote." }); }
    if (amountOutRaw === "0") return complete({ ...empty, reason: "The fee-aware V2 calculation rounds to no output for this input; a usable exit quote is unavailable." });
    return complete({ ...empty, status: "quoted", amountOutRaw, feePips: 3000, method: "v2-reserves-with-fee",
      v2: { reserveInRaw, reserveOutRaw }, inputConsumption: "assumed-full", reason: null });
  }
  if (!Number.isInteger(pool.feePips) || pool.feePips === null || pool.feePips < 0 || pool.feePips >= 1_000_000
    || BigInt(largest.amountInRaw) >= 1n << 255n) return complete({ ...empty, reason: "The authenticated V3 fee tier or input is outside the supported quote parameters." });
  if (options.throttleError?.() || options.remainingCalls() < 3) return complete({ ...empty, reason: "The V3 quote allocation is unavailable; balance and canonical verification retain priority." });
  let reads = 0;
  const call = async (target: Address, functionName: "factory" | "slot0" | "quoteExactInputSingle", data: Hash, words: number) => {
    checkAbort();
    if (reads >= 3 || options.remainingCalls() <= 0) throw new ProviderBudgetError();
    reads++;
    const result = await options.request("eth_call", [{ to: target, data, ...(functionName === "quoteExactInputSingle" ? { gas: "0x4c4b40" } : {}) }, "0x" + BigInt(options.block.number).toString(16)]);
    checkAbort();
    if (typeof result !== "string" || !new RegExp("^0x[0-9a-fA-F]{" + words * 64 + "}$").test(result)) throw new ProviderIntegrityError("The pinned exit quote did not return the expected ABI shape.");
    return result as Hash;
  };
  try {
    const quoterFactory = decodeFunctionResult({ abi: exitQuoteAbi, functionName: "factory",
      data: await call(BASE_V3_QUOTER_V2, "factory", encodeFunctionData({ abi: exitQuoteAbi, functionName: "factory" }), 1) }).toLowerCase();
    if (quoterFactory !== EXIT_QUOTE_V3_FACTORY) throw new ProviderIntegrityError("The pinned QuoterV2 factory conflicts with its official Base deployment.");
    const [sqrtPriceX96Before] = decodeFunctionResult({ abi: exitQuoteAbi, functionName: "slot0",
      data: await call(pool.address, "slot0", encodeFunctionData({ abi: exitQuoteAbi, functionName: "slot0" }), 7) });
    const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = decodeFunctionResult({ abi: exitQuoteAbi, functionName: "quoteExactInputSingle",
      data: await call(BASE_V3_QUOTER_V2, "quoteExactInputSingle", encodeFunctionData({ abi: exitQuoteAbi, functionName: "quoteExactInputSingle",
        args: [{ tokenIn: options.token.address, tokenOut: quoteAsset!, amountIn: BigInt(largest.amountInRaw), fee: pool.feePips, sqrtPriceLimitX96: 0n }] }), 4) });
    if (amountOut <= 0n) return complete({ ...empty, reason: "The pinned V3 quote did not produce positive output; a usable exit quote is unavailable." });
    return complete({ ...empty, status: "quoted", amountOutRaw: amountOut.toString(), feePips: pool.feePips, method: "v3-quoter-v2",
      v3: { quoter: BASE_V3_QUOTER_V2, sqrtPriceX96Before: sqrtPriceX96Before.toString(), sqrtPriceX96After: sqrtPriceX96After.toString(), initializedTicksCrossed, gasEstimateRaw: gasEstimate.toString() },
      inputConsumption: "not-proven", reason: null });
  } catch (error) {
    checkAbort();
    if (error instanceof ProviderIntegrityError) throw error;
    if (error instanceof UpstreamFailure || error instanceof ProviderBudgetError) return complete({ ...empty,
      reason: error instanceof ProviderBudgetError ? "The shared V3 quote allocation ended before a result was verified." : "The pinned V3 quoter reverted or was unavailable; this does not establish whether the wallet can sell." });
    throw new ProviderIntegrityError("The pinned exit quote returned inconsistent protocol values.");
  }
}
