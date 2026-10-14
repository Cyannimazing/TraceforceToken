import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import type { Address, Hash, HolderSnapshot, LiquiditySnapshot, TokenDetails, WalletActivitySnapshot } from "../../src/domain/investigations/types";
import { BASE_V3_QUOTER_V2, EXIT_QUOTE_V2_FACTORY, EXIT_QUOTE_V3_FACTORY, feeAwareV2AmountOut, largestVerifiedEoaHolding, validateExitQuote } from "../../src/domain/investigations/exit-quote";
import { collectExitQuote, exitQuoteAbi, type CollectExitQuoteOptions } from "../../src/providers/base/exit-quote";
import { collectBaseInvestigation, type CollectorDependencies } from "../../src/providers/base/core";
import { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "../../src/providers/base/errors";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { validateBaseInvestigationReport } from "../../src/domain/investigations/report-validation";

const address = (value: number) => ("0x" + value.toString(16).padStart(40, "0")) as Address;
const token = address(1), quote = address(2), wallet = address(3), otherWallet = address(4), pool = address(5), contract = address(6);
const dead = "0x000000000000000000000000000000000000dead" as Address;
const block = { number: "100", hash: ("0x" + "a".repeat(64)) as Hash, timestamp: 200 };
const observedAt = "2026-10-13T12:00:00.000Z", Q96 = 1n << 96n;
const details: TokenDetails = { address: token, chainId: 8453, name: "Quote fixture", symbol: "QF", decimals: 18, totalSupplyRaw: "10000" };
function holders(): HolderSnapshot {
  return { chainId: 8453, tokenAddress: token, block, totalSupplyRaw: "10000",
    discovery: { provider: "Blockscout", sourceUrl: "https://base.blockscout.com/api/v2/tokens/" + token + "/holders", observedAt, status: "complete", pages: 1, addresses: 2, finalizedCensus: false, reason: null },
    balances: { status: "complete", requestedWallets: 2, verifiedWallets: 2, reason: null },
    holders: [{ address: wallet, status: "verified", balanceRaw: "1000", discoveredBy: "indexed" }, { address: otherWallet, status: "verified", balanceRaw: "20", discoveredBy: "indexed" }],
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt } };
}
function activity(): WalletActivitySnapshot { return { block, rows: [wallet, otherWallet].map((address) => ({ address, code: "eoa", outgoingTransactionCountRaw: "1" })) }; }
function baseOptions(): CollectExitQuoteOptions {
  return { token: details, block, observedAt, holderSnapshot: holders(), walletActivitySnapshot: activity(), selectedPool: pool,
    authenticatedPool: { address: pool, factory: EXIT_QUOTE_V2_FACTORY, token0: token, token1: quote, protocol: "uniswap-v2", feePips: 3000 },
    liquiditySnapshot: { protocol: "uniswap-v2", pool, factory: EXIT_QUOTE_V2_FACTORY, token0: token, token1: quote, reserve0Raw: "10000", reserve1Raw: "10000", block,
      provenance: { provider: "Base RPC", method: "pinned fixture", observedAt } },
    request: async () => { throw new Error("V2 should reuse pinned reserves without more calls"); }, remainingCalls: () => 0 };
}
function v3Options(feePips = 3000) {
  const calls: { method: string; params: unknown[] }[] = [];
  const options: CollectExitQuoteOptions = { ...baseOptions(), liquiditySnapshot: undefined,
    authenticatedPool: { address: pool, factory: EXIT_QUOTE_V3_FACTORY, token0: token, token1: quote, protocol: "uniswap-v3", feePips }, remainingCalls: () => 3 - calls.length,
    request: async (method, params) => {
      calls.push({ method, params });
      const target = params[0] as { to: Address; data: Hash };
      if (target.data === encodeFunctionData({ abi: exitQuoteAbi, functionName: "factory" })) return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "factory", result: EXIT_QUOTE_V3_FACTORY });
      if (target.data === encodeFunctionData({ abi: exitQuoteAbi, functionName: "slot0" })) return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "slot0", result: [Q96, 0, 0, 1, 1, 0, true] });
      return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "quoteExactInputSingle", result: [700n, Q96 * 9n / 10n, 12, 120000n] });
    } };
  return { options, calls };
}

test("fee-aware V2 quotes preserve exact integers, include fee loss and respect uint256/uint112 protocol limits", () => {
  assert.equal(feeAwareV2AmountOut("1000", "10000", "10000"), "906");
  assert.equal(feeAwareV2AmountOut("1000", "10000", "5000"), "453");
  assert.equal(feeAwareV2AmountOut("1000000", "1000000", "1000000", 0), "500000");
  assert.equal(feeAwareV2AmountOut("1000000", "1000000", "1000000", 3000), "499248");
  assert.equal(feeAwareV2AmountOut("1000000", "1000000", "1000000", 10000), "497487");
  assert.equal(feeAwareV2AmountOut("1", "1000000000000", "1"), "0");
  for (const fee of [-1, 1_000_000, 1.5]) assert.throws(() => feeAwareV2AmountOut("1", "2", "3", fee));
  assert.throws(() => feeAwareV2AmountOut(((1n << 256n) - 1n).toString(), "10", "10"), /uint256/);
  assert.throws(() => feeAwareV2AmountOut("1", (1n << 112n).toString(), "1"));
});

test("largest verified EOA excludes unread balances, contracts, burns and authenticated pools, with deterministic ties", () => {
  const snapshot = holders(), accounts = activity();
  snapshot.holders.push({ address: contract, balanceRaw: "5000", status: "verified", discoveredBy: "external" },
    { address: dead, balanceRaw: "9000", status: "verified", discoveredBy: "indexed" },
    { address: pool, balanceRaw: "8000", status: "verified", discoveredBy: "observed" },
    { address: address(7), balanceRaw: null, status: "not_examined", discoveredBy: "external" });
  accounts.rows.push({ address: contract, code: "contract", outgoingTransactionCountRaw: null }, { address: dead, code: "eoa", outgoingTransactionCountRaw: "0" },
    { address: pool, code: "eoa", outgoingTransactionCountRaw: "0" });
  assert.deepEqual(largestVerifiedEoaHolding(snapshot, accounts, [pool]), { wallet, amountInRaw: "1000" });
  snapshot.holders[1].balanceRaw = "1000";
  assert.equal(largestVerifiedEoaHolding(snapshot, accounts, [pool])?.wallet, wallet);
  assert.equal(largestVerifiedEoaHolding(snapshot, { ...accounts, block: { ...block, hash: ("0x" + "b".repeat(64)) as Hash } }), null);
});

test("V2 quote reuses the exact pinned reserves and reverses their direction for token1 input", async () => {
  const options = baseOptions(), result = await collectExitQuote(options);
  assert.equal(result.status, "quoted"); assert.equal(result.amountInRaw, "1000"); assert.equal(result.amountOutRaw, "906");
  assert.equal(result.feePips, 3000); assert.equal(result.inputConsumption, "assumed-full");
  assert.match(result.assumptions.join(" "), /not a successful transaction/);
  const reversed: LiquiditySnapshot = { ...options.liquiditySnapshot!, token0: quote, token1: token, reserve0Raw: "5000", reserve1Raw: "10000" };
  const reverse = await collectExitQuote({ ...options, authenticatedPool: { ...options.authenticatedPool!, token0: quote, token1: token }, liquiditySnapshot: reversed });
  assert.equal(reverse.amountOutRaw, "453"); assert.deepEqual(reverse.v2, { reserveInRaw: "10000", reserveOutRaw: "5000" });
});

test("V3 quoter uses the authenticated actual fee, pinned state and returned initialized ticks instead of a V2 approximation", async () => {
  for (const fee of [0, 500, 3000, 10000]) {
    const { options, calls } = v3Options(fee), result = await collectExitQuote(options);
    assert.equal(result.status, "quoted"); assert.equal(result.amountOutRaw, "700"); assert.equal(result.feePips, fee);
    assert.equal(result.v3?.initializedTicksCrossed, 12); assert.equal(result.v3?.gasEstimateRaw, "120000");
    assert.equal(result.v2, null); assert.equal(result.inputConsumption, "not-proven");
    assert.equal(calls.length, 3); assert.ok(calls.every((call) => call.method === "eth_call" && call.params[1] === "0x64"));
    const quoteCall = calls[2].params[0] as { to: Address; data: Hash; gas: string };
    assert.equal(quoteCall.to, BASE_V3_QUOTER_V2); assert.equal(quoteCall.gas, "0x4c4b40");
    const decoded = decodeFunctionData({ abi: exitQuoteAbi, data: quoteCall.data });
    assert.equal(decoded.functionName, "quoteExactInputSingle");
    assert.deepEqual(decoded.args?.[0], { tokenIn: token, tokenOut: quote, amountIn: 1000n, fee, sqrtPriceLimitX96: 0n });
  }
});

test("budget, upstream revert and missing state remain unknown without manufactured zero output", async () => {
  const { options, calls } = v3Options();
  const noBudget = await collectExitQuote({ ...options, remainingCalls: () => 2 });
  assert.equal(noBudget.status, "unknown"); assert.equal(noBudget.amountOutRaw, null); assert.equal(calls.length, 0);
  for (const error of [new UpstreamFailure(false, { rpcCode: 3 }), new ProviderBudgetError()]) {
    const failed = await collectExitQuote({ ...options, request: async () => { throw error; }, remainingCalls: () => 3 });
    assert.equal(failed.status, "unknown"); assert.equal(failed.amountOutRaw, null); assert.equal(failed.feePips, null);
  }
  const missing = await collectExitQuote({ ...baseOptions(), liquiditySnapshot: undefined });
  assert.equal(missing.status, "unknown"); assert.equal(missing.amountOutRaw, null);
  const tiny = baseOptions(); tiny.holderSnapshot!.holders[0].balanceRaw = "1"; tiny.holderSnapshot!.holders[1].balanceRaw = "0";
  tiny.liquiditySnapshot!.reserve0Raw = "1000000000000"; tiny.liquiditySnapshot!.reserve1Raw = "1";
  const zero = await collectExitQuote(tiny); assert.equal(zero.status, "unknown"); assert.equal(zero.amountOutRaw, null); assert.match(zero.reason!, /rounds/);
  const overflow = baseOptions(); overflow.liquiditySnapshot!.reserve0Raw = ((1n << 112n) - 1n).toString();
  const unexecutable = await collectExitQuote(overflow); assert.equal(unexecutable.status, "unknown"); assert.equal(unexecutable.amountOutRaw, null); assert.match(unexecutable.reason!, /uint112/);
});

test("wrong factory, selected identity, malformed ABI and reversed V3 price direction fail integrity validation", async () => {
  await assert.rejects(collectExitQuote({ ...baseOptions(), token: { ...details, chainId: 1 as 8453 } }), ProviderIntegrityError);
  await assert.rejects(collectExitQuote({ ...baseOptions(), selectedPool: address(99) }), ProviderIntegrityError);
  await assert.rejects(collectExitQuote({ ...baseOptions(), authenticatedPool: { ...baseOptions().authenticatedPool!, factory: address(98) } }), ProviderIntegrityError);
  const { options } = v3Options();
  await assert.rejects(collectExitQuote({ ...options, request: async () => "0x" }), ProviderIntegrityError);
  await assert.rejects(collectExitQuote({ ...options, request: async () => encodeFunctionResult({ abi: exitQuoteAbi, functionName: "factory", result: EXIT_QUOTE_V2_FACTORY }) }), ProviderIntegrityError);
  let reads = 0;
  const badPrice = v3Options().options;
  await assert.rejects(collectExitQuote({ ...badPrice, request: async (method, params) => ++reads === 3
    ? encodeFunctionResult({ abi: exitQuoteAbi, functionName: "quoteExactInputSingle", result: [700n, Q96 * 2n, 1, 1n] }) : badPrice.request(method, params), remainingCalls: () => 3 }), ProviderIntegrityError);
});

test("shared quote validation binds token/block, exact holding, authenticated pool and fee arithmetic", async () => {
  const options = baseOptions(), result = await collectExitQuote(options);
  const validate = (value: unknown) => validateExitQuote(value, details, block, options.holderSnapshot, options.walletActivitySnapshot, [pool]);
  assert.deepEqual(validate(result), result);
  for (const value of [{ ...result, amountOutRaw: "907" }, { ...result, amountInRaw: "999" }, { ...result, wallet: otherWallet },
    { ...result, feePips: 500 }, { ...result, tokenAddress: quote }, { ...result, block: { ...block, timestamp: 201 } }, { ...result, unexpected: "reject" }]) assert.throws(() => validate(value));
  assert.throws(() => validateExitQuote(result, details, block, options.holderSnapshot, options.walletActivitySnapshot, []));
  assert.throws(() => validateExitQuote(result, details, block, { ...holders(), tokenAddress: quote }, options.walletActivitySnapshot, [pool]));
});

test("unsupported pools and cancellation do not initiate an untrusted protocol call", async () => {
  const options = baseOptions(), unsupported = await collectExitQuote({ ...options, authenticatedPool: null, unsupportedPool: true });
  assert.equal(unsupported.status, "unsupported"); assert.equal(unsupported.amountOutRaw, null);
  const controller = new AbortController(), reason = new Error("request cancelled"); controller.abort(reason);
  await assert.rejects(collectExitQuote({ ...v3Options().options, signal: controller.signal }), (error) => error === reason);
});

const tokenAbi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const poolAbi = parseAbi(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function getPool(address,address,uint24) view returns (address)"]);
function collectorFixture(budget = 100) {
  const calls: { method: string; params: unknown[] }[] = [];
  const dependency: CollectorDependencies = { now: () => new Date(observedAt), limits: { callBudget: budget }, poolCandidates: async () => [pool],
    candidateAddresses: async () => [wallet], holderPage: async () => ({ items: [], nextCursor: null }),
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBlockByNumber") return { number: "0x64", hash: block.hash, timestamp: "0xc8", parentHash: "0x" + "b".repeat(64), transactions: [] };
      if (method === "eth_getCode") return params[0] === token ? "0x6000" : "0x";
      if (method === "eth_getTransactionCount") return "0x1";
      if (method === "eth_getLogs") return [];
      if (method === "eth_call") {
        const target = params[0] as { to: Address; data: Hash };
        if (target.to === token) {
          const decoded = decodeFunctionData({ abi: tokenAbi, data: target.data });
          if (decoded.functionName === "name") return encodeFunctionResult({ abi: tokenAbi, functionName: "name", result: "Quote fixture" });
          if (decoded.functionName === "symbol") return encodeFunctionResult({ abi: tokenAbi, functionName: "symbol", result: "QF" });
          if (decoded.functionName === "decimals") return encodeFunctionResult({ abi: tokenAbi, functionName: "decimals", result: 18 });
          return encodeFunctionResult({ abi: tokenAbi, functionName: decoded.functionName, result: decoded.functionName === "balanceOf" ? 1000n : 10000n });
        }
        if (target.to === BASE_V3_QUOTER_V2) {
          if (target.data === encodeFunctionData({ abi: exitQuoteAbi, functionName: "factory" })) return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "factory", result: EXIT_QUOTE_V3_FACTORY });
          return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "quoteExactInputSingle", result: [700n, Q96 * 9n / 10n, 12, 120000n] });
        }
        if (target.data === encodeFunctionData({ abi: exitQuoteAbi, functionName: "slot0" })) return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "slot0", result: [Q96, 0, 0, 1, 1, 0, true] });
        const decoded = decodeFunctionData({ abi: poolAbi, data: target.data });
        if (decoded.functionName === "factory") return encodeFunctionResult({ abi: poolAbi, functionName: "factory", result: EXIT_QUOTE_V3_FACTORY });
        if (decoded.functionName === "token0") return encodeFunctionResult({ abi: poolAbi, functionName: "token0", result: token });
        if (decoded.functionName === "token1") return encodeFunctionResult({ abi: poolAbi, functionName: "token1", result: quote });
        if (decoded.functionName === "fee") return encodeFunctionResult({ abi: poolAbi, functionName: "fee", result: 500 });
        return encodeFunctionResult({ abi: poolAbi, functionName: "getPool", result: pool });
      }
      throw new Error("Unexpected fixture read");
    } };
  return { dependency, calls };
}

test("collector verifies external candidates and acquires a real quote before the reserved canonical recheck", async () => {
  const { dependency, calls } = collectorFixture();
  const result = await collectBaseInvestigation({ token, lookbackBlocks: 1 }, dependency);
  assert.equal(result.holderSnapshot?.holders[0].discoveredBy, "external"); assert.equal(result.holderSnapshot?.discovery.addresses, 0);
  assert.equal(result.evidence.length, 0, "an external suggestion is not an observed token event");
  assert.equal(result.exitQuote?.status, "quoted"); assert.equal(result.exitQuote?.amountOutRaw, "700"); assert.equal(result.exitQuote?.feePips, 500);
  const balanceRead = calls.findIndex((call) => call.method === "eth_call" && (call.params[0] as { data: string }).data.startsWith("0x70a08231"));
  const quoterRead = calls.findIndex((call) => call.method === "eth_call" && (call.params[0] as { to: Address }).to === BASE_V3_QUOTER_V2);
  assert.ok(balanceRead >= 0 && quoterRead > balanceRead);
  assert.equal(calls.at(-1)?.method, "eth_getBlockByNumber"); assert.equal(calls.at(-1)?.params[0], "0x64");
});

test("tight collector allocations preserve balance/final checks and report missing exit measurements as unknown", async () => {
  for (const budget of [20, 21, 22]) {
    const { dependency, calls } = collectorFixture(budget), result = await collectBaseInvestigation({ token, lookbackBlocks: 1 }, dependency);
    assert.ok(calls.length <= budget); assert.equal(calls.at(-1)?.method, "eth_getBlockByNumber");
    if (result.exitQuote?.status !== "quoted") assert.equal(result.exitQuote?.amountOutRaw, null);
  }
});

test("fee-aware quotes survive analysis and report JSON round-trips; identity mutations reject at both boundaries", async () => {
  const { dependency } = collectorFixture();
  const dataset = await collectBaseInvestigation({ token, lookbackBlocks: 1 }, dependency);
  const options = { id: "00000000-0000-4000-8000-000000000081", generatedAt: observedAt };
  const report = analyzeInvestigation(dataset, options);
  assert.deepEqual(report.exitQuote, dataset.exitQuote, "analysis must not silently drop the acquired quote");
  const restored = validateBaseInvestigationReport(JSON.parse(JSON.stringify(report)));
  assert.deepEqual(restored.exitQuote, dataset.exitQuote, "shared report validation must preserve exact input/output and source state");
  assert.equal(restored.exitQuote?.v3?.initializedTicksCrossed, 12);
  assert.equal(restored.holderSnapshot?.holders[0].discoveredBy, "external");
  assert.equal(restored.holderSnapshot?.discovery.addresses, 0);
  for (const change of [
    { pool: address(99) }, { wallet: otherWallet }, { amountInRaw: "999" }, { tokenAddress: quote },
    { block: { ...block, hash: ("0x" + "b".repeat(64)) as Hash } },
  ]) {
    assert.throws(() => analyzeInvestigation({ ...dataset, exitQuote: { ...dataset.exitQuote!, ...change } }, options));
    assert.throws(() => validateBaseInvestigationReport({ ...report, exitQuote: { ...report.exitQuote!, ...change } }));
  }
});
