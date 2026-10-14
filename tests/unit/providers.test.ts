import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toBytes } from "viem";
import type { Address, Hash } from "../../src/domain/investigations/types";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { BASE_V2_FACTORY, BASE_V2_ROUTER, BASE_WETH, BASE_V3_FACTORY, BASE_V3_ROUTERS, collectBaseInvestigation, ProviderBudgetError, ProviderIntegrityError, SWAP_TOPIC, V2_MINT_TOPIC, V2_SWAP_TOPIC, TRANSFER_TOPIC, UpstreamFailure, type CollectorDependencies, type FundingHistoryPage } from "../../src/providers/base/core";
import { validateBaseInvestigationReport } from "../../src/domain/investigations/report-validation";
import { deriveCreatorAttribution } from "../../src/domain/investigations/creator-attribution";
import { createInvestigatorContext } from "../../src/agents/context";
import { readLocalAiConfiguration } from "../../src/agents/config";
import { isPublicAddress, readProviderConfiguration } from "../../src/providers/base/config";
import { boundedJson, createProviderTransport } from "../../src/providers/base/transport";
import { collectNativeFundingPrefix, type NativeFundingOptions } from "../../src/providers/base/native-funding";
import { ProviderLogRangeError, TokenContractNotFoundError } from "../../src/providers/base/errors";
import type { TokenTransferPageReader } from "../../src/providers/base/alchemy-transfers";
import { BASE_V3_QUOTER_V2 } from "../../src/domain/investigations/exit-quote";
import { exitQuoteAbi } from "../../src/providers/base/exit-quote";

const address = (byte: string) => `0x${byte.repeat(40 / byte.length)}` as Address;
const hash = (byte: string) => `0x${byte.repeat(64 / byte.length)}` as Hash;
const token = address("11"), quote = address("22"), wallet = address("33"), funder = address("44"), pool = address("55"), unrelated = address("66");
const ZERO = address("00");
const mintHash = hash("aa"), saleHash = hash("bb"), fundingHash = hash("cc"), block99 = hash("99"), block100 = hash("10");
const quantity = (value: number | bigint) => `0x${value.toString(16)}`;
const blockHash = (number: number) => number === 99 ? block99 : number === 100 ? block100 : `0x${BigInt(number).toString(16).padStart(64, "0")}` as Hash;
const topicAddress = (value: Address) => `0x${value.slice(2).padStart(64, "0")}` as Hash;
const metadataAbi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
const poolAbi = parseAbi(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function getPool(address,address,uint24) view returns (address)"]);

function transferLog(transactionHash: Hash, from: Address, to: Address, amount: bigint, asset = token, block = 100, logIndex = 0) {
  return { address: asset, blockNumber: quantity(block), blockHash: block === 99 ? block99 : block100, transactionHash, transactionIndex: "0x0", logIndex: quantity(logIndex), topics: [TRANSFER_TOPIC, topicAddress(from), topicAddress(to)], data: `0x${amount.toString(16).padStart(64, "0")}`, removed: false };
}
function swapLog(logIndex = 2) {
  return { address: pool, blockNumber: "0x64", blockHash: block100, transactionHash: saleHash, transactionIndex: "0x0", logIndex: quantity(logIndex), topics: [SWAP_TOPIC, topicAddress(BASE_V3_ROUTERS[0]), topicAddress(wallet)], data: encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }], [70n, -42n, 1n, 1n, 0]), removed: false };
}

interface FixtureOptions { missingQuote?: boolean; coincidentGift?: boolean; fakePool?: boolean; noSwap?: boolean; multipleSwaps?: boolean; reorg?: boolean; failedReceipt?: boolean; mismatchedReceipt?: boolean; duplicates?: boolean; transferFailure?: boolean; badTransfer?: boolean; missingFunding?: boolean; fundingNextPage?: boolean; hugeAmount?: bigint; metadataName?: string; metadataSymbol?: string }
function fixture(options: FixtureOptions = {}): CollectorDependencies {
  const mint = transferLog(mintHash, ZERO, wallet, options.hugeAmount ?? 100n, token, 99);
  const sold = transferLog(saleHash, wallet, pool, 70n);
  const consideration = transferLog(saleHash, pool, options.missingQuote || options.coincidentGift ? unrelated : wallet, 42n, quote, 100, 1);
  const swap = swapLog();
  const saleLogs = [sold, consideration, ...(options.noSwap ? [] : [swap]), ...(options.multipleSwaps ? [swapLog(3)] : []), ...(options.coincidentGift ? [transferLog(saleHash, funder, wallet, 42n, quote, 100, 3)] : [])];
  const receipt = (transactionHash: Hash, logs: unknown[], block = 100) => ({ transactionHash, transactionIndex: "0x0", blockNumber: quantity(block), blockHash: block === 99 ? block99 : block100, status: "0x1", logs });
  return {
    now: () => new Date("2026-10-12T00:00:00.000Z"),
    ...(!options.missingFunding ? { fundingHistory: async (target: Address) => ({ items: target === wallet ? [{ hash: fundingHash, blockNumber: "99" }] : [], nextCursor: options.fundingNextPage ? { block_number: 99, index: 0, items_count: 50 } : null }) } : {}),
    async rpc(method, params) {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "finalized" ? 100 : Number(BigInt(String(params[0])));
        const transactions = number === 99 ? [{ hash: mintHash, blockNumber: "0x63", blockHash: block99, transactionIndex: "0x0", from: funder, to: ZERO, value: "0x0" }, { hash: fundingHash, blockNumber: "0x63", blockHash: block99, transactionIndex: "0x1", from: funder, to: wallet, value: "0x3e8" }] : [];
        return { number: quantity(number), hash: options.reorg && params[0] !== "finalized" ? hash("ee") : blockHash(number), parentHash: blockHash(number - 1), timestamp: quantity(number * 2), ...(params[1] ? { transactions } : {}) };
      }
      if (method === "eth_getCode") return params[0] === token ? "0x6000" : "0x";
      if (method === "eth_getLogs") {
        if (options.transferFailure) throw new UpstreamFailure();
        if (options.badTransfer) return [{ ...mint, data: "invalid" }];
        const range = params[0] as { fromBlock: string; toBlock: string };
        const entries = options.duplicates ? [sold, mint, sold] : [mint, sold];
        return entries.filter((log) => BigInt(log.blockNumber) >= BigInt(range.fromBlock) && BigInt(log.blockNumber) <= BigInt(range.toBlock));
      }
      if (method === "eth_getTransactionReceipt") {
        if (params[0] === mintHash) return receipt(mintHash, [mint], 99);
        if (params[0] === fundingHash) return { ...receipt(fundingHash, [], 99), transactionIndex: "0x1" };
        return { ...receipt(saleHash, saleLogs), ...(options.failedReceipt ? { status: "0x0" } : {}), ...(options.mismatchedReceipt ? { blockHash: hash("ff") } : {}) };
      }
      if (method === "eth_getTransactionByHash") {
        if (params[0] === fundingHash) return { hash: fundingHash, blockNumber: "0x63", blockHash: block99, transactionIndex: "0x1", from: funder, to: wallet, value: "0x3e8" };
        return { hash: saleHash, blockNumber: "0x64", blockHash: block100, transactionIndex: "0x0", from: wallet, to: BASE_V3_ROUTERS[0], value: "0x0" };
      }
      if (method === "eth_call") {
        const { to, data } = params[0] as { to: Address; data: Hash };
        if (to === token) {
          if (data === encodeFunctionData({ abi: metadataAbi, functionName: "name" })) return encodeFunctionResult({ abi: metadataAbi, functionName: "name", result: options.metadataName ?? "Fixture token" });
          if (data === encodeFunctionData({ abi: metadataAbi, functionName: "symbol" })) return encodeFunctionResult({ abi: metadataAbi, functionName: "symbol", result: options.metadataSymbol ?? "FIX" });
          if (data === encodeFunctionData({ abi: metadataAbi, functionName: "decimals" })) return encodeFunctionResult({ abi: metadataAbi, functionName: "decimals", result: 18 });
          return encodeFunctionResult({ abi: metadataAbi, functionName: "totalSupply", result: options.hugeAmount ?? 100n });
        }
        if (to === BASE_V3_FACTORY) return encodeFunctionResult({ abi: poolAbi, functionName: "getPool", result: options.fakePool ? ZERO : pool });
        if (data === encodeFunctionData({ abi: poolAbi, functionName: "factory" })) return encodeFunctionResult({ abi: poolAbi, functionName: "factory", result: BASE_V3_FACTORY });
        if (data === encodeFunctionData({ abi: poolAbi, functionName: "token0" })) return encodeFunctionResult({ abi: poolAbi, functionName: "token0", result: token });
        if (data === encodeFunctionData({ abi: poolAbi, functionName: "token1" })) return encodeFunctionResult({ abi: poolAbi, functionName: "token1", result: quote });
        return encodeFunctionResult({ abi: poolAbi, functionName: "fee", result: 3000 });
      }
      throw new Error("Unexpected fixture RPC method.");
    },
  };
}

const parameters = { token, lookbackBlocks: 2 };

function creationFixture(options: {
  contractAddress?: Address | null; omitContractAddress?: boolean; amount?: bigint; from?: Address; to?: Address;
  transaction?: Partial<{ hash: Hash; blockNumber: string; blockHash: Hash; transactionIndex: string; from: Address; to: Address | null }>;
  failedReceipt?: boolean; unavailable?: boolean; callBudget?: number;
} = {}) {
  const source = fixture(), reads: { method: string; params: unknown[] }[] = [];
  const mint = transferLog(mintHash, options.from ?? ZERO, options.to ?? wallet, options.amount ?? 100n, token, 99);
  const dependencies: CollectorDependencies = { ...source, ...(options.callBudget ? { limits: { callBudget: options.callBudget } } : {}), rpc: async (method, params) => {
    reads.push({ method, params });
    if (method === "eth_getTransactionByHash" && params[0] === mintHash) {
      if (options.unavailable) throw new UpstreamFailure();
      return { hash: mintHash, blockNumber: "0x63", blockHash: block99, transactionIndex: "0x0", from: funder, to: null, value: "0x0", ...options.transaction };
    }
    const value = await source.rpc(method, params);
    if (method === "eth_getLogs") return (value as ReturnType<typeof transferLog>[]).map((event) => event.transactionHash === mintHash ? mint : event);
    if (method === "eth_getTransactionReceipt" && params[0] === mintHash) return { ...value as object, logs: [mint], ...(options.omitContractAddress ? {} : { contractAddress: options.contractAddress === undefined ? token : options.contractAddress }), ...(options.failedReceipt ? { status: "0x0" } : {}) };
    return value;
  } };
  return { dependencies, reads };
}

test("direct contract deployment identifies the canonical sender, not the token mint recipient", async () => {
  const { dependencies, reads } = creationFixture();
  const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const dataset = await collectBaseInvestigation(parameters, { ...dependencies, holderPage: async () => ({ items: [], nextCursor: null }), rpc: async (method, params) => {
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: Address; data: Hash };
      if (to === token && data.startsWith("0x70a08231")) {
        assert.equal(params[1], "0x64");
        return encodeFunctionResult({ abi: balanceAbi, functionName: "balanceOf", result: data === encodeFunctionData({ abi: balanceAbi, functionName: "balanceOf", args: [wallet] }) ? 30n : data === encodeFunctionData({ abi: balanceAbi, functionName: "balanceOf", args: [pool] }) ? 70n : 0n });
      }
    }
    return dependencies.rpc(method, params);
  } });
  const mint = dataset.evidence.find((event) => event.creation)!;
  assert.equal(mint.to, wallet);
  assert.deepEqual(mint.creation, { creator: funder, contractAddress: token, transactionTo: null, receiptStatus: "0x1" });
  assert.match(mint.provenance.method, /eth_getTransactionByHash.*eth_getTransactionReceipt/);
  assert.equal(reads.filter((read) => read.method === "eth_getTransactionByHash" && read.params[0] === mintHash).length, 1);
  assert.deepEqual(dataset.holderSnapshot?.holders.find((holder) => holder.address === funder), { address: funder, balanceRaw: "0", status: "verified", discoveredBy: "observed" });
  assert.ok(dataset.walletActivitySnapshot?.rows.some((row) => row.address === funder));
  assert.ok(dataset.coverage.funding.some((row) => row.wallet === funder));
  const report = validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" }));
  assert.equal(deriveCreatorAttribution(report)?.address, funder);
  assert.equal(deriveCreatorAttribution(report)?.kind, "direct-contract-creation");
  assert.equal(report.wallets.find((row) => row.address === funder)?.balanceRaw, "0");
});

test("creator funding precedes busy recipient histories within the shared budget and preserves balances/final canonical check", async () => {
  const { dependencies } = creationFixture();
  const calls: { method: string; params: unknown[] }[] = [];
  const order: string[] = [];
  const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const rpc: CollectorDependencies["rpc"] = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_getTransactionCount") return "0x14";
    if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) return encodeFunctionResult({ abi: balanceAbi, functionName: "balanceOf", result: 30n });
    return dependencies.rpc(method, params);
  };
  let queries = 0;
  const dataset = await collectBaseInvestigation({ ...parameters, scope: "full" }, { ...dependencies, rpc, indexedRpc: rpc, fundingIndexSource: "alchemy", limits: { callBudget: 80 },
    holderPage: async () => ({ items: [], nextCursor: null }),
    creatorFundingHistory: async (creator, cursor, range) => {
      order.push("creator"); queries++;
      assert.equal(creator, funder); assert.equal(cursor, null); assert.deepEqual(range, { fromBlock: "0", toBlock: "100" });
      return { items: [{ hash: fundingHash, blockNumber: "99" }], nextCursor: null };
    },
    fundingHistory: async () => { order.push("recipient"); queries++; return { items: Array.from({ length: 100 }, () => ({ hash: fundingHash, blockNumber: "99" })), nextCursor: { pageKey: "busy" } }; },
  });
  assert.equal(order[0], "creator"); assert.ok(order.includes("recipient"));
  assert.equal(dataset.coverage.creatorFunding!.status, "complete");
  assert.equal(dataset.coverage.creatorFunding!.evidenceIds.length, 1);
  assert.ok(dataset.coverage.funding.some((row) => row.status !== "complete"));
  assert.ok(calls.length + queries <= 80);
  assert.ok(calls.some((row) => row.method === "eth_call" && (row.params[0] as { data: string }).data.startsWith("0x70a08231")));
  assert.equal(calls.at(-1)!.method, "eth_getBlockByNumber");
  assert.deepEqual(calls.at(-1)!.params, ["0x64", false]);
  assert.doesNotThrow(() => validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" })));
});

test("ordinary mints, factory calls and unrelated receipt contracts cannot establish a creator", async () => {
  for (const options of [{ omitContractAddress: true }, { contractAddress: null }, { contractAddress: null, transaction: { to: BASE_V2_ROUTER } }, { contractAddress: unrelated }, { amount: 0n }, { from: wallet }, { to: ZERO }]) {
    const { dependencies, reads } = creationFixture(options);
    const dataset = await collectBaseInvestigation(parameters, dependencies);
    assert.equal(dataset.evidence.some((event) => event.creation !== undefined), false);
    assert.equal(reads.some((read) => read.method === "eth_getTransactionByHash" && read.params[0] === mintHash), false);
  }
  for (const transaction of [{ from: ZERO }, { from: token }]) {
    const { dependencies } = creationFixture({ transaction });
    const dataset = await collectBaseInvestigation(parameters, dependencies);
    assert.equal(dataset.evidence.some((event) => event.creation !== undefined), false);
  }
});

test("deployment sender attribution rejects every canonical transaction inclusion mismatch", async () => {
  for (const transaction of [{ hash: saleHash }, { blockHash: block100 }, { blockNumber: "0x64" }, { transactionIndex: "0x1" }, { to: token }, { to: BASE_V2_ROUTER }]) {
    await assert.rejects(collectBaseInvestigation(parameters, creationFixture({ transaction }).dependencies), ProviderIntegrityError);
  }
  const failed = creationFixture({ failedReceipt: true });
  await assert.rejects(collectBaseInvestigation(parameters, failed.dependencies), ProviderIntegrityError);
  assert.equal(failed.reads.some((read) => read.method === "eth_getTransactionByHash" && read.params[0] === mintHash), false);
});

test("unavailable or budget-limited deployment lookups preserve acquired evidence and canonical reserve", async () => {
  for (const options of [{ unavailable: true }, { callBudget: 30 }]) {
    const { dependencies, reads } = creationFixture(options);
    const dataset = await collectBaseInvestigation(parameters, dependencies);
    assert.equal(dataset.evidence.some((event) => event.creation !== undefined), false);
    assert.equal(dataset.coverage.transfers, "complete");
    assert.ok(dataset.evidence.some((event) => event.kind === "transfer" && event.transactionHash === mintHash));
    assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("chain creator attribution remains unknown")));
    assert.deepEqual(reads.at(-1), { method: "eth_getBlockByNumber", params: ["0x64", false] });
    assert.ok(reads.length <= (options.callBudget ?? 500));
    if (options.callBudget) assert.equal(reads.some((read) => read.method === "eth_getTransactionByHash" && read.params[0] === mintHash), false, "the optional lookup must not borrow its phase reserve");
  }
});

function v2Fixture(options: { buying?: boolean; native?: boolean; initial?: boolean; fakePool?: boolean; badValue?: boolean; missingDeposit?: boolean; badMarker?: boolean } = {}) {
  const source = fixture(), fundingTargets: Address[] = [], reads: { method: string; params: unknown[] }[] = [];
  const pairedQuote = options.native ? BASE_WETH : quote;
  const v2Abi = parseAbi(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function getPair(address,address) view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"]);
  const firstLogs = options.initial ? [transferLog(mintHash, wallet, pool, 100n, token, 99, 0), transferLog(mintHash, wallet, pool, 1_000_000n, pairedQuote, 99, 1), transferLog(mintHash, ZERO, ZERO, options.badMarker ? 999n : 1000n, pool, 99, 2), transferLog(mintHash, ZERO, wallet, 9000n, pool, 99, 3),
    { ...transferLog(mintHash, wallet, pool, 0n, pool, 99, 4), topics: [V2_MINT_TOPIC, topicAddress(BASE_V2_ROUTER)], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [100n, 1_000_000n]) }]
    : [transferLog(mintHash, ZERO, wallet, 100n, token, 99)];
  const native = options.native && options.buying;
  const tradeLogs = [transferLog(saleHash, options.buying ? pool : wallet, options.buying ? wallet : pool, 70n, token, 100, native ? 2 : 1), transferLog(saleHash, options.buying ? native ? BASE_V2_ROUTER : wallet : pool, options.buying ? pool : wallet, 42n, pairedQuote, 100, native ? 1 : 0),
    { ...transferLog(saleHash, wallet, pool, 0n, pool, 100, 3), topics: [V2_SWAP_TOPIC, topicAddress(BASE_V2_ROUTER), topicAddress(wallet)], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], options.buying ? [0n, 42n, 70n, 0n] : [70n, 0n, 0n, 42n]) },
    ...(native && !options.missingDeposit ? [{ ...transferLog(saleHash, wallet, pool, 42n, BASE_WETH, 100, 0), topics: [keccak256(toBytes("Deposit(address,uint256)")), topicAddress(BASE_V2_ROUTER)] }] : [])];
  const dependencies: CollectorDependencies = { ...source, poolCandidates: async () => [pool], fundingHistory: async (target) => { fundingTargets.push(target); return { items: [], nextCursor: null }; }, rpc: async (method, params) => {
    reads.push({ method, params });
    if (method === "eth_getTransactionCount") { assert.equal(params[1], "0x64"); return "0x7"; }
    if (method === "eth_getLogs") return [firstLogs[0], tradeLogs[0]];
    if (method === "eth_getTransactionReceipt") {
      const value = await source.rpc(method, params) as object;
      return { ...value, logs: params[0] === mintHash ? firstLogs : tradeLogs };
    }
    if (method === "eth_getTransactionByHash" && params[0] === saleHash) return { hash: saleHash, blockNumber: "0x64", blockHash: block100, transactionIndex: "0x0", from: wallet, to: BASE_V2_ROUTER, value: native ? options.badValue ? "0x2b" : "0x2a" : "0x0" };
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: Address; data: Hash };
      if (to === BASE_V2_FACTORY) return encodeFunctionResult({ abi: v2Abi, functionName: "getPair", result: options.fakePool ? ZERO : pool });
      if (to === pool) {
        if (data === encodeFunctionData({ abi: v2Abi, functionName: "factory" })) return encodeFunctionResult({ abi: v2Abi, functionName: "factory", result: BASE_V2_FACTORY });
        if (data === encodeFunctionData({ abi: v2Abi, functionName: "token0" })) return encodeFunctionResult({ abi: v2Abi, functionName: "token0", result: token });
        if (data === encodeFunctionData({ abi: v2Abi, functionName: "token1" })) return encodeFunctionResult({ abi: v2Abi, functionName: "token1", result: pairedQuote });
        if (data === encodeFunctionData({ abi: v2Abi, functionName: "getReserves" })) { assert.equal(params[1], "0x64"); return encodeFunctionResult({ abi: v2Abi, functionName: "getReserves", result: [100n, 1_000_000n, 200] }); }
      }
    }
    return source.rpc(method, params);
  } };
  return { dependencies, fundingTargets, reads };
}

test("an atomic direct-deployment mint into a pool preserves independently authenticated initial liquidity", async () => {
  const { dependencies } = v2Fixture({ buying: true, initial: true });
  const mintedIntoPool = (event: ReturnType<typeof transferLog>) => event.transactionHash === mintHash && event.address === token && event.logIndex === "0x0" ? { ...event, topics: [TRANSFER_TOPIC, topicAddress(ZERO), topicAddress(pool)] } : event;
  const dataset = await collectBaseInvestigation(parameters, { ...dependencies, rpc: async (method, params) => {
    if (method === "eth_getTransactionByHash" && params[0] === mintHash) return { hash: mintHash, blockNumber: "0x63", blockHash: block99, transactionIndex: "0x0", from: funder, to: null, value: "0x0" };
    const value = await dependencies.rpc(method, params);
    if (method === "eth_getLogs") return (value as ReturnType<typeof transferLog>[]).map(mintedIntoPool);
    if (method === "eth_getTransactionReceipt" && params[0] === mintHash) return { ...value as object, contractAddress: token, logs: (value as { logs: ReturnType<typeof transferLog>[] }).logs.map(mintedIntoPool) };
    return value;
  } });
  const mint = dataset.evidence.find((event) => event.creation)!;
  assert.equal(mint.from, ZERO); assert.equal(mint.to, pool);
  assert.equal(mint.creation?.creator, funder);
  assert.equal(mint.liquidity?.initial, true);
  assert.equal(mint.liquidity?.supportingEvidenceIds.length, 4);
  const report = validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" }));
  assert.equal(deriveCreatorAttribution(report)?.address, funder);
  assert.ok(report.evidence.some((event) => event.creation && event.liquidity));
});

function busyBuyFixture(repeatedBuys: number, callBudget: number, forgedLastEntry = false) {
  const source = v2Fixture({ buying: true, initial: true }).dependencies;
  const rpcReads: { method: string; params: unknown[] }[] = [], tradeReads: Hash[] = [];
  const buyers = [...Array.from({ length: repeatedBuys }, () => wallet), unrelated, funder];
  const trades = buyers.map((buyer, index) => {
    const transactionHash = `0x${(50_000n + BigInt(index)).toString(16).padStart(64, "0")}` as Hash;
    const position = (event: ReturnType<typeof transferLog>) => ({ ...event, transactionIndex: quantity(index + 1) });
    const received = position(transferLog(transactionHash, pool, buyer, 1n, token, 100, 1));
    const paid = position(transferLog(transactionHash, forgedLastEntry && index === buyers.length - 1 ? wallet : buyer, pool, 2n, quote, 100, 0));
    const swapped = { ...position(transferLog(transactionHash, buyer, pool, 0n, pool, 100, 2)), topics: [V2_SWAP_TOPIC, topicAddress(BASE_V2_ROUTER), topicAddress(buyer)], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [0n, 2n, 1n, 0n]) };
    return { buyer, transactionHash, received, logs: [paid, received, swapped], transactionIndex: quantity(index + 1) };
  });
  const fundingItems = Array.from({ length: 100 }, (_, index) => ({ hash: `0x${(60_000n + BigInt(index)).toString(16).padStart(64, "0")}` as Hash, blockNumber: "100" }));
  let fundingRequests = 0, holderRequests = 0;
  const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const reserveAbi = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)"]);
  const dependencies: CollectorDependencies = { ...source, limits: { callBudget },
    holderPage: async () => { holderRequests++; return { items: [], nextCursor: null }; },
    fundingHistory: async () => { fundingRequests++; return { items: fundingItems, nextCursor: null }; },
    rpc: async (method, params) => {
      rpcReads.push({ method, params });
      const trade = trades.find((entry) => entry.transactionHash === params[0]);
      const fundingIndex = fundingItems.findIndex((entry) => entry.hash === params[0]);
      if (method === "eth_getTransactionReceipt" && (trade || fundingIndex >= 0)) return { transactionHash: params[0], transactionIndex: trade?.transactionIndex ?? quantity(100 + fundingIndex), blockNumber: "0x64", blockHash: block100, status: "0x1", logs: trade?.logs ?? [] };
      if (method === "eth_getTransactionByHash" && (trade || fundingIndex >= 0)) {
        if (trade) tradeReads.push(trade.transactionHash);
        return { hash: params[0], blockNumber: "0x64", blockHash: block100, transactionIndex: trade?.transactionIndex ?? quantity(100 + fundingIndex), from: trade?.buyer ?? unrelated, to: trade ? BASE_V2_ROUTER : wallet, value: "0x0" };
      }
      if (method === "eth_call") {
        const { to, data } = params[0] as { to: Address; data: Hash };
        if (to === token && data.startsWith("0x70a08231")) {
          assert.equal(params[1], "0x64");
          const amount = data.endsWith(pool.slice(2)) ? 100n - BigInt(buyers.length) : data.endsWith(wallet.slice(2)) ? BigInt(repeatedBuys) : 1n;
          return encodeFunctionResult({ abi: balanceAbi, functionName: "balanceOf", result: amount });
        }
        if (to === pool && data === encodeFunctionData({ abi: reserveAbi, functionName: "getReserves" })) return encodeFunctionResult({ abi: reserveAbi, functionName: "getReserves", result: [100n - BigInt(buyers.length), 1_000_000n + 2n * BigInt(buyers.length), 200] });
      }
      const value = await source.rpc(method, params);
      if (method === "eth_getLogs") return [(value as ReturnType<typeof transferLog>[])[0], ...trades.map((entry) => entry.received)];
      return value;
    },
  };
  return { dependencies, trades, tradeReads, rpcReads, calls: () => rpcReads.length + fundingRequests + holderRequests };
}

test("trade verification prioritizes each wallet's first receipt before repeated early buys", async () => {
  const f = busyBuyFixture(30, 160);
  const dataset = await collectBaseInvestigation(parameters, f.dependencies);
  assert.deepEqual(f.tradeReads.slice(0, 3), [f.trades[0].transactionHash, f.trades[30].transactionHash, f.trades[31].transactionHash]);
  for (const index of [0, 30, 31]) assert.ok(dataset.evidence.some((event) => event.transactionHash === f.trades[index].transactionHash && event.purchase), "every first-entry candidate receives the same complete purchase verification before repeat trades");
  assert.ok(dataset.evidence.some((event) => event.liquidity?.initial));
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("sale-enrichment allocation ended")));
  assert.equal(dataset.holderSnapshot?.balances.status, "complete");
  assert.equal(dataset.holderSnapshot?.balances.verifiedWallets, 4);
  assert.deepEqual(f.rpcReads.at(-1), { method: "eth_getBlockByNumber", params: ["0x64", false] });
  assert.ok(f.calls() <= 160);
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "first-entry-priority", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("all reserved trade capacity is usable while pinned balances and canonical recheck remain protected", async () => {
  const f = busyBuyFixture(10, 80);
  const dataset = await collectBaseInvestigation(parameters, f.dependencies);
  assert.equal(dataset.evidence.filter((event) => event.purchase).length, 12, "the old half-remaining ceiling left already-reserved trade reads unused");
  assert.equal(dataset.holderSnapshot?.balances.status, "complete");
  assert.equal(dataset.holderSnapshot?.balances.verifiedWallets, 4);
  assert.ok(f.calls() <= 80);
  assert.deepEqual(f.rpcReads.at(-1), { method: "eth_getBlockByNumber", params: ["0x64", false] });
  const forged = busyBuyFixture(30, 160, true);
  const invalid = await collectBaseInvestigation(parameters, forged.dependencies);
  assert.ok(forged.tradeReads.slice(0, 3).includes(forged.trades[31].transactionHash));
  assert.equal(invalid.evidence.some((event) => event.transactionHash === forged.trades[31].transactionHash && event.purchase), false, "priority cannot authenticate somebody else's quote payment");
  assert.equal(invalid.holderSnapshot?.balances.status, "complete");
  assert.ok(forged.calls() <= 160);
});

test("V2 pool authentication excludes infrastructure before funding and retains pinned reserves/nonce", async () => {
  const { dependencies, fundingTargets, reads } = v2Fixture();
  const dataset = await collectBaseInvestigation(parameters, dependencies);
  assert.ok(dataset.pools.includes(pool)); assert.ok(dataset.hubs.includes(BASE_V2_ROUTER));
  assert.deepEqual(fundingTargets, [wallet]);
  assert.equal(dataset.liquiditySnapshot?.reserve1Raw, "1000000");
  assert.equal(dataset.walletActivitySnapshot?.rows[0].outgoingTransactionCountRaw, "7");
  assert.equal(dataset.evidence.find((event) => event.kind === "sale")?.sale?.protocol, "uniswap-v2");
  const report = validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" }));
  assert.ok(report.infrastructure?.pools.includes(pool)); assert.equal(report.wallets.length, 1);
  assert.deepEqual(report.walletActivitySnapshot, dataset.walletActivitySnapshot);
  assert.deepEqual(report.liquiditySnapshot, dataset.liquiditySnapshot);
  assert.doesNotThrow(() => createInvestigatorContext(report, readLocalAiConfiguration({ LOCAL_AI_MODEL: "traceforce-investigator" })));
  assert.ok(reads.length <= 500);
});

test("V2 buys carry a complete authenticated receipt proof and never become sales", async () => {
  const dataset = await collectBaseInvestigation(parameters, v2Fixture({ buying: true }).dependencies);
  const bought = dataset.evidence.find((event) => event.purchase)!;
  assert.equal(bought.from, pool); assert.equal(bought.to, wallet); assert.equal(bought.purchase?.quoteAmountRaw, "42");
  assert.equal(bought.purchase?.supportingEvidenceIds.length, 2);
  assert.equal(dataset.evidence.filter((event) => event.kind === "sale").length, 0);
  const report = analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" });
  assert.ok(validateBaseInvestigationReport(report).evidence.some((event) => event.purchase));
  for (const mutation of ["missing-proof", "different-receipt", "amount", "hidden-outflow", "quote-zero"] as const) {
    const changed = structuredClone(dataset), event = changed.evidence.find((record) => record.purchase)!;
    if (mutation === "missing-proof") event.purchase!.supportingEvidenceIds.pop();
    if (mutation === "different-receipt") changed.evidence.find((record) => record.assetAddress === quote)!.transactionHash = fundingHash;
    if (mutation === "amount") event.amountRaw = "0";
    if (mutation === "hidden-outflow") changed.evidence.push({ ...event, id: "synthetic-omitted-outflow", purchase: undefined, from: wallet, to: unrelated, amountRaw: "1", logIndex: 2 });
    if (mutation === "quote-zero") event.purchase!.quoteAsset = ZERO;
    assert.throws(() => analyzeInvestigation(changed, { id: "invalid-buy", generatedAt: "2026-10-12T00:00:00.000Z" }));
  }
});

test("native-funded V2 buys require exact signed value and canonical WETH Deposit", async () => {
  for (const options of [{}, { badValue: true }, { missingDeposit: true }]) {
    const dataset = await collectBaseInvestigation(parameters, v2Fixture({ buying: true, native: true, ...options }).dependencies);
    const purchase = dataset.evidence.find((event) => event.purchase)?.purchase;
    assert.equal(Boolean(purchase), !options.badValue && !options.missingDeposit);
    if (purchase) { assert.equal(purchase.nativeInputRaw, "42"); assert.equal(purchase.quoteAsset, BASE_WETH); assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "native-buy", generatedAt: "2026-10-12T00:00:00.000Z" })); }
  }
});

test("initial V2 liquidity requires the first-mint lock marker and keeps every input and LP proof", async () => {
  for (const badMarker of [false, true]) {
    const dataset = await collectBaseInvestigation(parameters, v2Fixture({ buying: true, initial: true, badMarker }).dependencies);
    const initial = dataset.evidence.find((event) => event.liquidity);
    assert.equal(Boolean(initial), !badMarker);
    if (initial) {
      assert.equal(initial.timestamp, 198); assert.equal(initial.liquidity?.supportingEvidenceIds.length, 4);
      const report = validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" }));
      assert.ok(report.evidence.some((event) => event.liquidity));
      const changed = structuredClone(dataset); changed.evidence.find((event) => event.liquidity)!.liquidity!.supportingEvidenceIds.pop();
      assert.throws(() => analyzeInvestigation(changed, { id: "truncated-mint", generatedAt: "2026-10-12T00:00:00.000Z" }));
    }
  }
});

test("fake V2 pairs and unpinned/overflowed snapshots cannot acquire market authority", async () => {
  const dataset = await collectBaseInvestigation(parameters, v2Fixture({ buying: true, fakePool: true }).dependencies);
  assert.equal(dataset.liquiditySnapshot, undefined); assert.equal(dataset.evidence.some((event) => event.purchase), false);
  const valid = await collectBaseInvestigation(parameters, v2Fixture({ buying: true }).dependencies);
  for (const mutation of ["nonce-block", "reserve-block", "reserve-overflow", "reserve-zero", "wrong-token"] as const) {
    const changed = structuredClone(valid);
    if (mutation === "nonce-block") changed.walletActivitySnapshot!.block.hash = hash("ff");
    if (mutation === "reserve-block") changed.liquiditySnapshot!.block.number = "99";
    if (mutation === "reserve-overflow") changed.liquiditySnapshot!.reserve0Raw = (2n ** 112n).toString();
    if (mutation === "reserve-zero") changed.liquiditySnapshot!.reserve0Raw = "0";
    if (mutation === "wrong-token") changed.liquiditySnapshot!.token0 = unrelated;
    assert.throws(() => analyzeInvestigation(changed, { id: "invalid-snapshot", generatedAt: "2026-10-12T00:00:00.000Z" }));
  }
});

const newerFundingHash = hash("dd"), failedFundingHash = hash("ff");
const largeNativeAmount = 2n ** 255n + 123n;
function indexedFixture(pages: (page: number) => Promise<FundingHistoryPage>): CollectorDependencies {
  const source = fixture(); let page = 0;
  return { ...source, fundingHistory: async () => pages(page++), rpc: async (method, params) => {
    const selected = params[0] === newerFundingHash ? { hash: newerFundingHash, block: 100, index: 1, amount: largeNativeAmount } : params[0] === failedFundingHash ? { hash: failedFundingHash, block: 99, index: 2, amount: 7n } : null;
    if (selected && method === "eth_getTransactionByHash") return { hash: selected.hash, blockNumber: quantity(selected.block), blockHash: blockHash(selected.block), transactionIndex: quantity(selected.index), from: funder, to: wallet, value: quantity(selected.amount) };
    if (selected && method === "eth_getTransactionReceipt") return { transactionHash: selected.hash, blockNumber: quantity(selected.block), blockHash: blockHash(selected.block), transactionIndex: quantity(selected.index), status: "0x1", logs: [] };
    return source.rpc(method, params);
  } };
}
const indexedPage = (items: FundingHistoryPage["items"], next = false): FundingHistoryPage => ({ items, nextCursor: next ? { block_number: 100, index: 1 } : null });

function withAdditionalParticipants(source: CollectorDependencies, count: number): CollectorDependencies {
  const extras = Array.from({ length: count }, (_, index) => transferLog(mintHash, ZERO, `0x${(BigInt(index) + 1000n).toString(16).padStart(40, "0")}` as Address, 1n, token, 99, index + 1));
  return { ...source, rpc: async (method, params) => {
    const value = await source.rpc(method, params);
    if (method === "eth_getLogs") return [...value as unknown[], ...extras];
    if (method === "eth_getTransactionReceipt" && params[0] === mintHash) return { ...value as object, logs: [...(value as { logs: unknown[] }).logs, ...extras] };
    return value;
  } };
}

test("collector pins finalized Base history and retains receipt-backed sale and funding evidence", async () => {
  const dataset = await collectBaseInvestigation(parameters, fixture());
  assert.equal(dataset.token.chainId, 8453);
  assert.equal(dataset.token.name, "Fixture token");
  assert.equal(dataset.range.finality, "finalized");
  assert.equal(dataset.range.from.number, "99");
  assert.equal(dataset.range.to.hash, block100);
  assert.equal(dataset.coverage.transfers, "complete");
  assert.equal(dataset.coverage.funding[0].status, "complete");
  assert.equal(dataset.coverage.funding[0].internalTransfers, "not_examined");
  const sale = dataset.evidence.find((record) => record.kind === "sale");
  assert.ok(sale?.sale);
  assert.equal(sale.from, wallet);
  assert.equal(sale.amountRaw, "70");
  assert.equal(sale.sale.quoteAmountRaw, "42");
  assert.equal(sale.sale.factory, BASE_V3_FACTORY);
  assert.equal(sale.id, `8453:${block100}:${saleHash}:sale:2`);
  for (const id of sale.sale.supportingEvidenceIds) assert.ok(dataset.evidence.some((record) => record.id === id));
  assert.ok(dataset.evidence.some((record) => record.kind === "transfer" && record.assetAddress === quote && record.amountRaw === "42"));
  assert.ok(dataset.evidence.some((record) => record.kind === "funding" && record.from === funder && record.amountRaw === "1000" && record.logIndex === null));
});

test("an address without finalized bytecode raises a typed error before metadata or history and never switches to latest", async () => {
  const source = fixture(), calls: { method: string; params: unknown[] }[] = [];
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_getCode") return params[1] === "latest" ? "0x6000" : "0x";
    return source.rpc(method, params);
  } }), TokenContractNotFoundError);
  assert.deepEqual(calls.filter((row) => row.method === "eth_getCode"), [{ method: "eth_getCode", params: [token, "0x64"] }]);
  assert.equal(calls.some((row) => row.method === "eth_call" || row.method === "eth_getLogs" || row.params.includes("latest")), false);
});

test("malformed code remains a provider integrity failure instead of claiming a missing contract", async () => {
  const source = fixture();
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => method === "eth_getCode" ? "not-bytecode" : source.rpc(method, params) }),
    (error) => error instanceof ProviderIntegrityError && !(error instanceof TokenContractNotFoundError));
});

test("reordered and duplicated logs produce identical evidence with exact large amounts", async () => {
  const amount = 2n ** 200n;
  const normal = await collectBaseInvestigation(parameters, fixture({ hugeAmount: amount }));
  const reordered = await collectBaseInvestigation(parameters, fixture({ duplicates: true, hugeAmount: amount }));
  assert.deepEqual(reordered.evidence, normal.evidence);
  assert.equal(normal.token.totalSupplyRaw, amount.toString());
  assert.equal(normal.evidence.find((record) => record.transactionHash === mintHash)?.amountRaw, amount.toString());
});

test("receipt reconciliation recovers omitted sibling transfers without extra RPC reads or a completeness claim", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 2);
  const reads = (omit: boolean) => {
    const calls: string[] = [];
    return { calls, dependencies: { ...source,
      rpc: async (method: string, params: unknown[]) => { calls.push(`state:${method}`); return source.rpc(method, params); },
      logRpc: async (method: string, params: unknown[]) => {
        calls.push(`logs:${method}`);
        const value = await source.rpc(method, params);
        return omit && method === "eth_getLogs" ? (value as ReturnType<typeof transferLog>[]).filter((item) => item.logIndex === "0x0") : value;
      },
    } };
  };
  const complete = reads(false), omitted = reads(true);
  const baseline = await collectBaseInvestigation(parameters, complete.dependencies);
  const dataset = await collectBaseInvestigation(parameters, omitted.dependencies);
  assert.equal(baseline.coverage.transfers, "complete");
  assert.equal(dataset.coverage.transfers, "partial");
  assert.deepEqual(omitted.calls, complete.calls, "reconciliation must use the already acquired receipt and make no extra reads");
  assert.deepEqual(dataset.evidence.map((event) => ({ ...event, provenance: null })), baseline.evidence.map((event) => ({ ...event, provenance: null })));
  const recovered = dataset.evidence.filter((event) => event.transactionHash === mintHash && event.logIndex !== 0);
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((event) => event.provenance.method.includes("omitted by eth_getLogs")));
  assert.ok(dataset.coverage.warnings.some((warning) => /omitted ERC-20 transfers/.test(warning) && /other missing transactions cannot be ruled out/.test(warning)));
  assert.equal(dataset.coverage.eligibleWallets, baseline.coverage.eligibleWallets);
  const report = analyzeInvestigation(dataset, { id: "receipt-reconciliation", generatedAt: "2026-10-12T00:00:00.000Z" });
  assert.ok(report.wallets.every((item) => item.earlyAccumulator === null), "omission recovery cannot establish complete early accumulation");
});

test("receipt sibling recovery respects the transfer record cap and ignores unrelated token events", async () => {
  const source = fixture({ noSwap: true });
  const sibling = transferLog(mintHash, wallet, unrelated, 1n, token, 99, 1);
  const otherAsset = transferLog(mintHash, wallet, funder, 2n, quote, 99, 2);
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { maxTransferLogs: 1 }, rpc: async (method, params) => {
    const value = await source.rpc(method, params);
    return method === "eth_getTransactionReceipt" && params[0] === mintHash ? { ...value as object, logs: [...(value as { logs: unknown[] }).logs, sibling, otherAsset] } : value;
  } });
  assert.equal(dataset.coverage.transfers, "partial");
  assert.equal(dataset.evidence.filter((event) => event.kind === "transfer").length, 1);
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("record limit")));
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("omitted ERC-20 transfers")));
  assert.equal(dataset.evidence.some((event) => event.assetAddress === quote), false);
  assert.equal(dataset.coverage.funding.some((item) => item.wallet === unrelated), false, "a capped sibling must not become a fabricated observed participant");
});

test("receipt reconciliation never turns NFT-shaped token events into ERC-20 flows", async () => {
  const source = fixture({ noSwap: true });
  const standard = transferLog(mintHash, wallet, unrelated, 1n, token, 99, 1);
  const nonstandard = { ...standard, topics: [...standard.topics, hash("ab")], data: "0x" };
  const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
    const value = await source.rpc(method, params);
    return method === "eth_getTransactionReceipt" && params[0] === mintHash ? { ...value as object, logs: [...(value as { logs: unknown[] }).logs, nonstandard] } : value;
  } });
  assert.equal(dataset.coverage.transfers, "partial");
  assert.equal(dataset.evidence.some((event) => event.transactionHash === mintHash && event.logIndex === 1), false);
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("Nonstandard Transfer")));
  assert.equal(dataset.coverage.warnings.some((warning) => warning.includes("omitted ERC-20 transfers")), false);
});

test("receipt sibling identity conflicts and duplicate receipt indexes fail instead of publishing recovered evidence", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 1);
  for (const mutation of ["content", "duplicate", "foreign-transaction", "malformed"] as const) {
    await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
      const value = await source.rpc(method, params);
      if (method !== "eth_getTransactionReceipt" || params[0] !== mintHash) return value;
      const receipt = value as { logs: ReturnType<typeof transferLog>[] };
      const sibling = receipt.logs[1];
      const changed = mutation === "content" ? { ...sibling, data: `0x${"0".repeat(63)}2` }
        : mutation === "foreign-transaction" ? { ...sibling, transactionHash: saleHash }
          : mutation === "malformed" ? { ...sibling, data: "invalid" } : sibling;
      return { ...receipt, logs: mutation === "duplicate" ? [...receipt.logs, sibling] : [receipt.logs[0], changed] };
    } }), ProviderIntegrityError);
  }
});

test("cancellation after receipt resolution stops sibling recovery with the caller's reason", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 1);
  const controller = new AbortController(), reason = new Error("Cancelled during receipt reconciliation");
  let cancelled = false;
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, signal: controller.signal, rpc: async (method, params) => {
    if (cancelled) assert.fail("cancellation must stop all later provider reads");
    const value = await source.rpc(method, params);
    if (method === "eth_getTransactionReceipt" && params[0] === mintHash) { cancelled = true; controller.abort(reason); }
    return value;
  } }), (error: unknown) => error === reason);
  assert.equal(cancelled, true);
});

function indexedTransfers(source: CollectorDependencies, transferPage: TokenTransferPageReader): CollectorDependencies {
  return { ...source, indexedRpc: source.rpc, transferPage };
}

test("indexed fullcrawl requests genesis through finalized head and publishes only canonical receipt logs", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 2);
  let pages = 0, logQueries = 0;
  const dataset = await collectBaseInvestigation({ ...parameters, scope: "full" }, indexedTransfers({ ...source, rpc: async (method, params) => {
    if (method === "eth_getLogs") logQueries++;
    return source.rpc(method, params);
  } }, async (query) => {
    pages++;
    assert.equal(query.fromBlock, "0");
    assert.equal(query.toBlock, "100");
    assert.equal(query.token, token);
    assert.equal(query.cursor, null);
    return { items: [{ hash: mintHash, blockNumber: "99" }, { hash: saleHash, blockNumber: "100" }], nextCursor: null };
  }));
  assert.equal(pages, 1);
  assert.equal(logQueries, 0, "indexed discovery cannot accidentally crawl empty RPC log ranges too");
  assert.equal(dataset.range.from.number, "0");
  assert.equal(dataset.coverage.transfers, "complete");
  assert.deepEqual(dataset.coverage.transferCrawl, { scope: "full", source: "alchemy-transfers", completedRanges: [{ fromBlock: "0", toBlock: "100" }] });
  assert.equal(dataset.evidence.filter((event) => event.kind === "transfer" && event.transactionHash === mintHash).length, 3);
  assert.equal(dataset.evidence.find((event) => event.transactionHash === mintHash && event.logIndex === 0)?.amountRaw, "100");
  assert.ok(dataset.evidence.filter((event) => event.kind === "transfer").every((event) => event.provenance.provider.includes("Alchemy")));
  assert.ok(dataset.coverage.warnings.some((warning) => /not independent proof/.test(warning)));
});

test("indexed pagination keeps a fixed range and verifies a repeated transaction only once", async () => {
  const source = fixture({ noSwap: true });
  const cursors: (string | null)[] = [];
  let mintReceipts = 0;
  const dataset = await collectBaseInvestigation(parameters, indexedTransfers({ ...source, rpc: async (method, params) => {
    if (method === "eth_getTransactionReceipt" && params[0] === mintHash) mintReceipts++;
    return source.rpc(method, params);
  } }, async (query) => {
    cursors.push(query.cursor);
    assert.equal(query.fromBlock, "99"); assert.equal(query.toBlock, "100");
    return query.cursor === null ? { items: [{ hash: mintHash, blockNumber: "99" }], nextCursor: "page-2" }
      : { items: [{ hash: mintHash, blockNumber: "99" }, { hash: saleHash, blockNumber: "100" }], nextCursor: null };
  }));
  assert.deepEqual(cursors, [null, "page-2"]);
  assert.equal(mintReceipts, 1);
  assert.equal(dataset.coverage.transfers, "complete");
  assert.equal(new Set(dataset.evidence.map((event) => event.id)).size, dataset.evidence.length);
});

test("index chain and pinned-header disagreement fails before even an empty transfer page can claim completeness", async () => {
  const source = fixture({ noSwap: true });
  for (const mutation of ["chain", "hash", "timestamp"]) {
    let pages = 0;
    await assert.rejects(collectBaseInvestigation(parameters, { ...source, transferPage: async () => { pages++; return { items: [], nextCursor: null }; }, indexedRpc: async (method, params) => {
      if (mutation === "chain" && method === "eth_chainId") return "0x1";
      const value = await source.rpc(method, params);
      if (method === "eth_getBlockByNumber") return mutation === "hash" ? { ...value as object, hash: hash("ee") } : mutation === "timestamp" ? { ...value as object, timestamp: "0x1" } : value;
      return value;
    } }), ProviderIntegrityError);
    assert.equal(pages, 0);
  }
});

test("indexed outages retain verified transactions with partial coverage and never start another discovery lane", async () => {
  const source = fixture({ noSwap: true });
  for (const location of ["first-page", "later-page", "later-receipt"]) {
    let pages = 0, logQueries = 0;
    const dataset = await collectBaseInvestigation(parameters, indexedTransfers({ ...source, rpc: async (method, params) => {
      if (method === "eth_getLogs") logQueries++;
      if (location === "later-receipt" && method === "eth_getTransactionReceipt" && params[0] === saleHash) throw new UpstreamFailure();
      return source.rpc(method, params);
    } }, async () => {
      pages++;
      if (location === "first-page" || location === "later-page" && pages === 2) throw new UpstreamFailure();
      return { items: [{ hash: pages === 1 ? mintHash : saleHash, blockNumber: pages === 1 ? "99" : "100" }], nextCursor: pages === 1 ? "page-2" : null };
    }));
    assert.equal(dataset.coverage.transfers, "partial");
    assert.deepEqual(dataset.coverage.transferCrawl?.completedRanges, []);
    assert.equal(dataset.evidence.filter((event) => event.kind === "transfer").length, location === "first-page" ? 0 : 1);
    assert.equal(logQueries, 0);
    assert.ok(dataset.coverage.warnings.some((warning) => /remaining history is unknown/.test(warning)));
  }
});

test("indexed cursor loops and record exhaustion preserve partial evidence under finite reads", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 2);
  for (const cap of [false, true]) {
    let pages = 0, saleReceipts = 0;
    const dataset = await collectBaseInvestigation(parameters, indexedTransfers({ ...source, ...(cap ? { limits: { maxTransferLogs: 1 } } : {}), rpc: async (method, params) => {
      if (method === "eth_getTransactionReceipt" && params[0] === saleHash) saleReceipts++;
      return source.rpc(method, params);
    } }, async () => {
      pages++;
      return { items: [{ hash: mintHash, blockNumber: "99" }, ...(cap ? [{ hash: saleHash, blockNumber: "100" }] : [])], nextCursor: "same-page" };
    }));
    assert.equal(dataset.coverage.transfers, "partial");
    assert.equal(pages, cap ? 1 : 2);
    assert.equal(saleReceipts, 0, "a capped receipt must stop verification of later candidates");
    assert.equal(dataset.evidence.filter((event) => event.kind === "transfer").length, cap ? 1 : 3);
    assert.ok(dataset.coverage.warnings.some((warning) => cap ? warning.includes("record limit") : warning.includes("repeated a cursor")));
  }
});

test("indexed range/order/conflicting inclusion and missing token receipts remain integrity failures", async () => {
  const source = fixture({ noSwap: true });
  for (const mutation of ["range", "order", "conflicting-inclusion", "receipt-block", "failed-receipt", "no-token-log"]) {
    let page = 0;
    await assert.rejects(collectBaseInvestigation(parameters, indexedTransfers({ ...source, rpc: async (method, params) => {
      const value = await source.rpc(method, params);
      if (method === "eth_getTransactionReceipt" && params[0] === mintHash) {
        if (mutation === "receipt-block") return { ...value as object, blockNumber: "0x64", blockHash: block100 };
        if (mutation === "failed-receipt") return { ...value as object, status: "0x0" };
        if (mutation === "no-token-log") return { ...value as object, logs: [] };
      }
      return value;
    } }, async () => {
      page++;
      if (mutation === "range") return { items: [{ hash: mintHash, blockNumber: "98" }], nextCursor: null };
      if (mutation === "order") return page === 1 ? { items: [{ hash: saleHash, blockNumber: "100" }], nextCursor: "page-2" } : { items: [{ hash: mintHash, blockNumber: "99" }], nextCursor: null };
      if (mutation === "conflicting-inclusion") return { items: [{ hash: mintHash, blockNumber: "99" }, { hash: mintHash, blockNumber: "100" }], nextCursor: null };
      return { items: [{ hash: mintHash, blockNumber: "99" }], nextCursor: null };
    })), ProviderIntegrityError);
  }
});

test("indexed handshake and pages share the phase budget and cannot consume the canonical reserve", async () => {
  const source = fixture({ noSwap: true });
  let calls = 0, pages = 0, canonicalReads = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 20 },
    rpc: async (method, params) => { calls++; if (method === "eth_getBlockByNumber" && params[0] === "0x64") canonicalReads++; return source.rpc(method, params); },
    indexedRpc: async (method, params) => { calls++; return source.rpc(method, params); },
    transferPage: async () => { calls++; pages++; return { items: [], nextCursor: null }; },
  });
  assert.equal(pages, 0, "a small allocation must deny discovery after the counted index handshake");
  assert.equal(dataset.coverage.transfers, "partial");
  assert.ok(calls <= 20);
  assert.equal(canonicalReads, 1, "the reserved final pinned-end check must still run");
});

test("authenticated fixed-lane holder balances run in bounded parallel batches at the pinned block and count every physical read", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 6);
  const calls: { lane: string; method: string; params: unknown[] }[] = [];
  const checked = new Set<string>();
  let active = 0, maximumActive = 0, recoveries = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 80 },
    rpc: async (method, params) => {
      calls.push({ lane: "primary", method, params });
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) assert.fail("authenticated balances must use the fixed lane");
      return source.rpc(method, params);
    },
    indexedRpc: async (method, params) => {
      calls.push({ lane: "fixed", method, params });
      if (method !== "eth_call") return source.rpc(method, params);
      const request = params[0] as { to: Address; data: string };
      assert.equal(request.to, token);
      assert.ok(request.data.startsWith("0x70a08231"));
      assert.equal(params[1], "0x64", "concurrent reads cannot drift to latest state");
      checked.add(`0x${request.data.slice(-40)}`);
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return `0x${1n.toString(16).padStart(64, "0")}`;
    },
    transferPage: async () => { calls.push({ lane: "index", method: "transfers", params: [] }); return { items: [{ hash: mintHash, blockNumber: "99" }, { hash: saleHash, blockNumber: "100" }], nextCursor: null }; },
    holderPage: async () => { calls.push({ lane: "index", method: "holders", params: [] }); return { items: [{ address: unrelated }], nextCursor: null }; },
    fundingHistory: async () => { calls.push({ lane: "index", method: "funding", params: [] }); return { items: [], nextCursor: null }; },
    recoverRpc: () => { recoveries++; return true; },
  });
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
  assert.equal(recoveries, 0, "fixed-lane batches must not enter mutable primary recovery");
  assert.equal(dataset.holderSnapshot!.balances.status, "complete");
  assert.equal(checked.size, 9);
  assert.deepEqual([...checked].sort(), dataset.holderSnapshot!.holders.map((row) => row.address));
  assert.ok(dataset.holderSnapshot!.holders.every((row) => row.status === "verified" && row.balanceRaw === "1"));
  assert.deepEqual(calls.filter((call) => call.lane === "fixed" && call.method !== "eth_call").map(({ method, params }) => ({ method, params })), [
    { method: "eth_chainId", params: [] },
    { method: "eth_getBlockByNumber", params: ["0x63", false] },
    { method: "eth_getBlockByNumber", params: ["0x64", false] },
  ]);
  assert.ok(calls.length <= 80);
  assert.deepEqual(calls.at(-1), { lane: "primary", method: "eth_getBlockByNumber", params: ["0x64", false] });
  assert.doesNotThrow(() => validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" })));
});

test("parallel fixed-lane balances exhaust only their shared allocation and leave the final canonical read reserved", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 30);
  const calls: { lane: string; method: string; params: unknown[] }[] = [];
  let balanceReads = 0, active = 0, maximumActive = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 40 },
    rpc: async (method, params) => { calls.push({ lane: "primary", method, params }); return source.rpc(method, params); },
    indexedRpc: async (method, params) => {
      calls.push({ lane: "fixed", method, params });
      if (method !== "eth_call") return source.rpc(method, params);
      assert.equal(params[1], "0x64");
      balanceReads++; active++; maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return `0x${1n.toString(16).padStart(64, "0")}`;
    },
    transferPage: async () => { calls.push({ lane: "index", method: "transfers", params: [] }); return { items: [{ hash: mintHash, blockNumber: "99" }, { hash: saleHash, blockNumber: "100" }], nextCursor: null }; },
    holderPage: async () => { calls.push({ lane: "index", method: "holders", params: [] }); return { items: [{ address: unrelated }], nextCursor: null }; },
    fundingHistory: async () => { calls.push({ lane: "index", method: "funding", params: [] }); return { items: [], nextCursor: null }; },
  });
  assert.ok(maximumActive > 1 && maximumActive <= 4);
  assert.equal(calls.length, 40, "all physical attempts, index pages, and final verification share one cap");
  assert.equal(active, 0);
  assert.equal(dataset.holderSnapshot!.balances.status, "partial");
  assert.equal(dataset.holderSnapshot!.balances.verifiedWallets, balanceReads);
  assert.ok(balanceReads > 0 && balanceReads < dataset.holderSnapshot!.holders.length);
  assert.ok(dataset.holderSnapshot!.holders.filter((row) => row.status === "not_examined").every((row) => row.balanceRaw === null));
  assert.deepEqual(calls.at(-1), { lane: "primary", method: "eth_getBlockByNumber", params: ["0x64", false] });
});

test("a candidate cohort larger than the call budget receives real classification and funding reads while retaining bounded balances and canonical verification", async () => {
  const source = withAdditionalParticipants(creationFixture().dependencies, 100), externalLead = address("77");
  const calls: { lane: string; method: string; params: unknown[] }[] = [];
  const classified: Address[] = [], fundingQueries: Address[] = [], balanceQueries = new Set<string>();
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 80 }, fundingIndexSource: "alchemy",
    candidateAddresses: async () => [externalLead],
    rpc: async (method, params) => {
      calls.push({ lane: "primary", method, params });
      if (method === "eth_getCode" && params[0] !== token) { assert.equal(params[1], "0x64"); classified.push(params[0] as Address); }
      if (method === "eth_getTransactionCount") { assert.equal(params[1], "0x64"); return "0x2"; }
      return source.rpc(method, params);
    },
    indexedRpc: async (method, params) => {
      calls.push({ lane: "fixed", method, params });
      if (method !== "eth_call") return source.rpc(method, params);
      assert.equal(params[1], "0x64");
      const request = params[0] as { to: Address; data: string };
      assert.equal(request.to, token); assert.ok(request.data.startsWith("0x70a08231"));
      balanceQueries.add(`0x${request.data.slice(-40)}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return `0x${1n.toString(16).padStart(64, "0")}`;
    },
    transferPage: async () => { calls.push({ lane: "index", method: "transfers", params: [] }); return { items: [{ hash: mintHash, blockNumber: "99" }, { hash: saleHash, blockNumber: "100" }], nextCursor: null }; },
    holderPage: async () => { calls.push({ lane: "index", method: "holders", params: [] }); return { items: [{ address: unrelated }], nextCursor: null }; },
    fundingHistory: async (target, _cursor, range) => {
      calls.push({ lane: "index", method: "funding", params: [target] }); fundingQueries.push(target);
      assert.deepEqual(range, { fromBlock: "99", toBlock: "100" });
      return { items: [], nextCursor: null };
    },
  });
  assert.ok(dataset.holderSnapshot!.holders.length > 80, "this fixture must exceed the entire physical request budget");
  assert.deepEqual(classified.slice(0, 3), [funder, unrelated, externalLead], "verified creator and discovery leads receive examinations without presumed balances");
  assert.deepEqual(fundingQueries.slice(0, 3), [funder, unrelated, externalLead]);
  assert.ok(classified.length > 0 && fundingQueries.length > 0 && balanceQueries.size > 0);
  assert.equal(dataset.coverage.examinedWallets, fundingQueries.length);
  assert.ok(dataset.coverage.funding.some((row) => row.status === "not_examined"));
  assert.equal(dataset.coverage.funding.length, dataset.coverage.eligibleWallets);
  assert.equal(dataset.walletActivitySnapshot!.rows.length, dataset.coverage.eligibleWallets);
  assert.ok(dataset.walletActivitySnapshot!.rows.some((row) => row.code === "eoa"));
  assert.ok(dataset.walletActivitySnapshot!.rows.some((row) => row.code === "unavailable" && row.outgoingTransactionCountRaw === null));
  assert.equal(dataset.holderSnapshot!.balances.status, "partial");
  assert.equal(dataset.holderSnapshot!.balances.verifiedWallets, balanceQueries.size);
  assert.ok(dataset.holderSnapshot!.holders.some((row) => row.status === "not_examined" && row.balanceRaw === null));
  assert.equal(dataset.holderSnapshot!.holders.find((row) => row.address === externalLead)!.balanceRaw, null, "prioritizing a source lead must not invent its unexamined holding");
  const verifiedPositive = new Set(dataset.holderSnapshot!.holders.filter((row) => row.status === "verified" && row.balanceRaw !== null && BigInt(row.balanceRaw) > 0n).map((row) => row.address));
  assert.ok(dataset.walletActivitySnapshot!.rows.some((row) => row.code === "eoa" && verifiedPositive.has(row.address)), "the budget must permit an independently classified positive wallet");
  assert.equal(calls.length, 80);
  assert.deepEqual(calls.at(-1), { lane: "primary", method: "eth_getBlockByNumber", params: ["0x64", false] });
  assert.ok(dataset.coverage.warnings.some((warning) => /cohort exceeds the remaining call budget/.test(warning)));
  assert.doesNotThrow(() => validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: "00000000-0000-4000-8000-000000000020", generatedAt: "2026-10-12T00:00:00.000Z" })));
});

test("an index callback without its authenticated discovery handshake cannot enable parallel primary balance recovery", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 6);
  let indexedReads = 0, active = 0, maximumActive = 0, balanceReads = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 80 },
    indexedRpc: async () => { indexedReads++; assert.fail("an unused discovery lane must not be trusted for balances"); },
    holderPage: async () => ({ items: [{ address: unrelated }], nextCursor: null }),
    fundingHistory: async () => ({ items: [], nextCursor: null }),
    rpc: async (method, params) => {
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) {
        assert.equal(params[1], "0x64");
        balanceReads++; active++; maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return `0x${1n.toString(16).padStart(64, "0")}`;
      }
      return source.rpc(method, params);
    },
  });
  assert.equal(indexedReads, 0);
  assert.equal(maximumActive, 1);
  assert.equal(balanceReads, 9);
  assert.equal(dataset.holderSnapshot!.balances.status, "complete");
});

test("cancellation during indexed handshake or page resolution propagates before subsequent reads", async () => {
  for (const location of ["handshake", "page"]) {
    const source = fixture({ noSwap: true });
    const controller = new AbortController(), reason = new Error(`Cancelled during index ${location}`);
    let pages = 0, cancelled = false;
    await assert.rejects(collectBaseInvestigation(parameters, { ...source, signal: controller.signal,
      rpc: async (method, params) => { if (cancelled) assert.fail("no provider read after cancellation"); return source.rpc(method, params); },
      indexedRpc: async (method, params) => { const value = await source.rpc(method, params); if (location === "handshake") { cancelled = true; controller.abort(reason); } return value; },
      transferPage: async () => { pages++; cancelled = true; controller.abort(reason); return { items: [{ hash: mintHash, blockNumber: "99" }], nextCursor: null }; },
    }), (error: unknown) => error === reason);
    assert.equal(pages, location === "handshake" ? 0 : 1);
  }
});

test("Alchemy funding-only discovery authenticates its Base lane and reuses that handshake when transfers share it", async () => {
  for (const withTransfers of [false, true]) {
    const source = fixture({ noSwap: true });
    let indexReads = 0, historyReads = 0;
    const dataset = await collectBaseInvestigation(parameters, { ...source, fundingIndexSource: "alchemy",
      indexedRpc: async (method, params) => { indexReads++; return source.rpc(method, params); },
      ...(withTransfers ? { transferPage: async () => ({ items: [{ hash: mintHash, blockNumber: "99" }, { hash: saleHash, blockNumber: "100" }], nextCursor: null }) } : {}),
      fundingHistory: async (target, cursor, range) => { historyReads++; return source.fundingHistory!(target, cursor, range); },
    });
    assert.equal(indexReads, 3, "chain and both pinned headers are checked once across index consumers");
    assert.ok(historyReads > 0);
    assert.ok(dataset.evidence.some((event) => event.kind === "funding" && event.provenance.provider === "Alchemy + Base RPC"));
    assert.match(dataset.coverage.funding.find((item) => item.wallet === wallet)?.reason ?? "", /does not independently exclude indexer omissions/);
  }
});

test("an unavailable index handshake cannot be repeated for every funding wallet or erase healthy transfer evidence", async () => {
  const source = withAdditionalParticipants(fixture({ noSwap: true }), 2);
  let indexReads = 0, historyReads = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, fundingIndexSource: "alchemy",
    indexedRpc: async () => { indexReads++; throw new UpstreamFailure(false, { httpStatus: 403 }); },
    fundingHistory: async (target, cursor, range) => { historyReads++; return source.fundingHistory!(target, cursor, range); },
  });
  assert.equal(indexReads, 1);
  assert.equal(historyReads, 0);
  assert.equal(dataset.coverage.transfers, "complete");
  assert.equal(dataset.evidence.filter((event) => event.kind === "transfer").length, 4);
  assert.ok(dataset.coverage.funding.every((item) => item.status === "unavailable"));
  assert.equal(dataset.evidence.some((event) => event.kind === "funding"), false);
  let rejectedHistoryReads = 0;
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, fundingIndexSource: "alchemy", indexedRpc: async () => "0x1",
    fundingHistory: async () => { rejectedHistoryReads++; return { items: [], nextCursor: null }; },
  }), ProviderIntegrityError);
  assert.equal(rejectedHistoryReads, 0);
});

test("keyless funding scans full blocks with successful receipts rather than requiring an indexer", async () => {
  const dataset = await collectBaseInvestigation(parameters, fixture({ missingFunding: true }));
  assert.equal(dataset.coverage.examinedWallets, 1);
  assert.equal(dataset.coverage.funding[0].status, "complete");
  assert.match(dataset.coverage.funding[0].reason ?? "", /top-level/);
  assert.equal(dataset.evidence.find((record) => record.kind === "funding")?.amountRaw, "1000");
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "keyless-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

function nativeFixture(overrides: Partial<NativeFundingOptions> = {}): NativeFundingOptions {
  return {
    wallets: [wallet], from: { number: "99", hash: block99, timestamp: 198 }, to: { number: "100", hash: block100, timestamp: 200 }, maxBlocks: 32, observedAt: "2026-10-12T00:00:00.000Z",
    canonicalBlock: async (number, expectedHash) => {
      assert.equal(expectedHash, blockHash(Number(number)));
      return { number, hash: blockHash(Number(number)), timestamp: Number(number) * 2 };
    },
    request: async (method, params) => {
      if (method === "eth_getCode") return "0x";
      if (method === "eth_getBlockByNumber") {
        const number = Number(BigInt(String(params[0])));
        const transactionHash = number === 99 ? fundingHash : saleHash;
        return { number: quantity(number), hash: blockHash(number), parentHash: blockHash(number - 1), timestamp: quantity(number * 2), transactions: [{ hash: transactionHash, blockHash: blockHash(number), blockNumber: quantity(number), transactionIndex: "0x0", from: funder, to: wallet, value: quantity(2n ** 256n - 1n) }] };
      }
      if (method === "eth_getTransactionReceipt") {
        const number = params[0] === fundingHash ? 99 : 100;
        return { transactionHash: params[0], blockHash: blockHash(number), blockNumber: quantity(number), transactionIndex: "0x0", status: "0x1" };
      }
      throw new Error("Unexpected native fixture method.");
    },
    ...overrides,
  };
}

test("native fallback keeps exact uint256 amounts and marks only a fully examined window complete", async () => {
  const result = await collectNativeFundingPrefix(nativeFixture());
  assert.equal(result.completedBlocks, 2);
  assert.equal(result.examinedWallets, 1);
  assert.equal(result.coverage[0].status, "complete");
  assert.equal(result.coverage[0].toBlock, "100");
  assert.deepEqual(result.evidence.map((record) => record.amountRaw), Array(2).fill((2n ** 256n - 1n).toString()));
  assert.equal(result.evidence[0].id, `8453:${block99}:${fundingHash}:native`);
  assert.equal(result.evidence[0].assetAddress, null);
  assert.equal(result.evidence[0].logIndex, null);
  assert.match(result.coverage[0].reason ?? "", /lifetime-first funding are not examined/);
});

test("native block cap covers the oldest prefix explicitly and cannot imply the later window was examined", async () => {
  const result = await collectNativeFundingPrefix(nativeFixture({ maxBlocks: 1 }));
  assert.equal(result.completedBlocks, 1);
  assert.equal(result.coverage[0].status, "partial");
  assert.equal(result.coverage[0].fromBlock, "99");
  assert.equal(result.coverage[0].toBlock, "99");
  assert.deepEqual(result.evidence.map((record) => record.blockNumber), ["99"]);
  assert.match(result.coverage[0].reason ?? "", /block limit reached/);
});

test("native receipt failure rolls back all funding from that block and retains the prior verified prefix", async () => {
  const source = nativeFixture(); const additional = hash("dd");
  const result = await collectNativeFundingPrefix({ ...source, request: async (method, params) => {
    if (method === "eth_getTransactionReceipt" && params[0] === additional) throw new UpstreamFailure();
    const value = await source.request(method, params);
    if (method === "eth_getBlockByNumber" && params[0] === "0x64") {
      const block = value as { transactions: Record<string, unknown>[] };
      return { ...block, transactions: [...block.transactions, { ...block.transactions[0], hash: additional, transactionIndex: "0x1" }] };
    }
    return value;
  } });
  assert.equal(result.coverage[0].status, "partial");
  assert.equal(result.coverage[0].toBlock, "99");
  assert.deepEqual(result.evidence.map((record) => record.transactionHash), [fundingHash]);
});

test("zero verified native blocks distinguish provider unavailability from an unstarted budget-denied search", async () => {
  for (const failure of [new UpstreamFailure(), new ProviderBudgetError()]) {
    const result = await collectNativeFundingPrefix(nativeFixture({ request: async () => { throw failure; } }));
    assert.equal(result.coverage[0].status, failure instanceof ProviderBudgetError ? "not_examined" : "unavailable");
    assert.equal(result.completedBlocks, 0);
    assert.equal(result.examinedWallets, 0);
    assert.equal(result.evidence.length, 0);
  }
});

test("native fallback rejects parent discontinuity, reordered/duplicate inclusion, receipt conflicts, and invalid values", async () => {
  const source = nativeFixture();
  for (const mutation of ["parent", "ordering", "duplicate", "value", "receipt", "hash", "timestamp"]) {
    await assert.rejects(collectNativeFundingPrefix({ ...source, request: async (method, params) => {
      const value = await source.request(method, params) as Record<string, unknown>;
      if (method === "eth_getBlockByNumber") {
        const transactions = value.transactions as Record<string, unknown>[];
        if (mutation === "parent" && params[0] === "0x64") return { ...value, parentHash: hash("ee") };
        if (mutation === "hash") return { ...value, hash: "invalid" };
        if (mutation === "timestamp") return { ...value, timestamp: "0x1" };
        if (mutation === "ordering") return { ...value, transactions: [{ ...transactions[0], transactionIndex: "0x1" }] };
        if (mutation === "duplicate") return { ...value, transactions: [transactions[0], { ...transactions[0], transactionIndex: "0x1" }] };
        if (mutation === "value") return { ...value, transactions: [{ ...transactions[0], value: quantity(2n ** 256n) }] };
      }
      if (method === "eth_getTransactionReceipt" && mutation === "receipt") return { ...value, blockHash: hash("ee") };
      return value;
    } }), (error: unknown) => error instanceof ProviderIntegrityError || error instanceof assert.AssertionError);
  }
});

test("failed native execution, zero value, and contract recipients never create funding evidence", async () => {
  const source = nativeFixture();
  for (const mutation of ["failed", "zero", "contract-at-observation"]) {
    const result = await collectNativeFundingPrefix({ ...source, request: async (method, params) => {
      if (mutation === "contract-at-observation" && method === "eth_getCode" && params[1] === "0x63") return "0x6000";
      const value = await source.request(method, params);
      if (mutation === "failed" && method === "eth_getTransactionReceipt") return { ...value as object, status: "0x0" };
      if (mutation === "zero" && method === "eth_getBlockByNumber") { const block = value as { transactions: object[] }; return { ...block, transactions: block.transactions.map((tx) => ({ ...tx, value: "0x0" })) }; }
      return value;
    } });
    assert.equal(result.coverage[0].status, "complete");
    assert.equal(result.evidence.length, mutation === "contract-at-observation" ? 1 : 0);
  }
  const contract = await collectNativeFundingPrefix({ ...source, request: async (method, params) => method === "eth_getCode" ? "0x6000" : source.request(method, params) });
  assert.equal(contract.coverage[0].status, "not_examined");
  assert.equal(contract.examinedWallets, 0);
  assert.equal(contract.evidence.length, 0);
});

test("keyless collector examines every discovered participant without a wallet selection cap", async () => {
  const source = fixture({ missingFunding: true });
  const extra = transferLog(mintHash, wallet, unrelated, 1n, token, 99, 1);
  const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
    const value = await source.rpc(method, params);
    if (method === "eth_getLogs") return [...value as unknown[], extra];
    if (method === "eth_getTransactionReceipt" && params[0] === mintHash) return { ...value as object, logs: [(value as { logs: unknown[] }).logs[0], extra] };
    return value;
  } });
  assert.equal(dataset.coverage.eligibleWallets, 2);
  assert.equal(dataset.coverage.examinedWallets, 2);
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === unrelated)?.status, "complete");
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.status, "complete");
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "keyless-all-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("native budget denial before any block read leaves the shared candidate range not examined", async () => {
  const result = await collectNativeFundingPrefix(nativeFixture({ wallets: [wallet, unrelated], request: async () => { throw new ProviderBudgetError(); } }));
  assert.equal(result.coverage.find((item) => item.wallet === wallet)?.status, "not_examined");
  assert.equal(result.coverage.find((item) => item.wallet === unrelated)?.status, "not_examined");
  assert.equal(result.examinedWallets, 0);
  assert.equal(result.evidence.length, 0);
});

test("native funding honors a prior or newly observed RPC throttle without additional block/recipient requests", async () => {
  for (const prior of [false, true]) {
    let calls = 0;
    const failure = new UpstreamFailure(true, { httpStatus: 429 });
    let throttle: UpstreamFailure | null = prior ? failure : null;
    const source = nativeFixture();
    const result = await collectNativeFundingPrefix({ ...source, wallets: [wallet, unrelated], throttleError: () => throttle,
      request: async (method, params) => { calls++; throttle = failure; return source.request(method, params); },
    });
    assert.equal(calls, prior ? 0 : 1);
    assert.equal(result.completedBlocks, 0);
    assert.equal(result.examinedWallets, 0);
    assert.equal(result.coverage[0].status, prior ? "not_examined" : "unavailable");
    assert.equal(result.coverage[1].status, prior ? "not_examined" : "unavailable");
    assert.ok(result.coverage.every((item) => item.reason?.includes("throttling")));
  }
});

test("lazy native checks retain a verified funding prefix for more than one thousand candidates under four calls", async () => {
  const source = nativeFixture(), candidates = [wallet, ...Array.from({ length: 1000 }, (_, index) => `0x${(BigInt(index) + 1000n).toString(16).padStart(40, "0")}` as Address)];
  let calls = 0, codeReads = 0;
  const result = await collectNativeFundingPrefix({ ...source, wallets: candidates, request: async (method, params) => {
    if (calls >= 4) throw new ProviderBudgetError();
    calls++; if (method === "eth_getCode") { codeReads++; assert.equal(params[0], wallet); }
    return source.request(method, params);
  } });
  assert.equal(calls, 4);
  assert.equal(codeReads, 2, "only the actual recipient gets end/historical code checks");
  assert.equal(result.completedBlocks, 1);
  assert.equal(result.examinedWallets, 1001);
  assert.equal(result.coverage.length, 1001);
  assert.ok(result.coverage.every((item) => item.status === "partial" && item.toBlock === "99"));
  assert.deepEqual(result.evidence.map((record) => record.transactionHash), [fundingHash]);
  assert.equal(result.evidence[0].amountRaw, (2n ** 256n - 1n).toString());
  assert.match(result.coverage[0].reason!, /not verified EOA identity/);
});

test("lazy native code checks cache actual block/address identity and never inspect dormant or failed recipients", async () => {
  const source = nativeFixture(), additional = hash("dd"); let codeReads = 0;
  const result = await collectNativeFundingPrefix({ ...source, wallets: [wallet, unrelated], maxBlocks: 1, request: async (method, params) => {
    if (method === "eth_getCode") { codeReads++; assert.equal(params[0], wallet); }
    if (method === "eth_getTransactionReceipt" && params[0] === additional) return { transactionHash: additional, blockHash: block99, blockNumber: "0x63", transactionIndex: "0x1", status: "0x1" };
    const value = await source.request(method, params);
    if (method === "eth_getBlockByNumber") {
      const block = value as { transactions: Record<string, unknown>[] };
      return { ...block, transactions: [...block.transactions, { ...block.transactions[0], hash: additional, transactionIndex: "0x1" }] };
    }
    return value;
  } });
  assert.equal(codeReads, 2);
  assert.equal(result.evidence.length, 2);
  assert.equal(result.coverage.find((item) => item.wallet === unrelated)?.status, "partial");
  assert.match(result.coverage.find((item) => item.wallet === unrelated)!.reason!, /wallet type can remain unassessed/);
  let failedCodeReads = 0;
  const failed = await collectNativeFundingPrefix({ ...source, request: async (method, params) => {
    if (method === "eth_getCode") failedCodeReads++;
    const value = await source.request(method, params);
    return method === "eth_getTransactionReceipt" ? { ...value as object, status: "0x0" } : value;
  } });
  assert.equal(failedCodeReads, 0);
  assert.equal(failed.coverage[0].status, "complete");
  assert.equal(failed.evidence.length, 0);
});

test("lazy code failures keep only prior complete blocks and reject malformed code or cancellation", async () => {
  const source = nativeFixture();
  const result = await collectNativeFundingPrefix({ ...source, request: async (method, params) => {
    if (method === "eth_getTransactionReceipt" && params[0] === saleHash) throw new UpstreamFailure();
    return source.request(method, params);
  } });
  assert.equal(result.coverage[0].status, "partial");
  assert.equal(result.coverage[0].toBlock, "99");
  assert.deepEqual(result.evidence.map((record) => record.transactionHash), [fundingHash]);
  const additional = hash("dd");
  const lateCodeFailure = await collectNativeFundingPrefix({ ...source, wallets: [wallet, unrelated], maxBlocks: 1, request: async (method, params) => {
    if (method === "eth_getCode" && params[0] === unrelated) throw new UpstreamFailure();
    if (method === "eth_getTransactionReceipt" && params[0] === additional) return { transactionHash: additional, blockHash: block99, blockNumber: "0x63", transactionIndex: "0x1", status: "0x1" };
    const value = await source.request(method, params);
    if (method === "eth_getBlockByNumber") { const block = value as { transactions: Record<string, unknown>[] }; return { ...block, transactions: [...block.transactions, { ...block.transactions[0], hash: additional, transactionIndex: "0x1", to: unrelated }] }; }
    return value;
  } });
  assert.equal(lateCodeFailure.completedBlocks, 0);
  assert.equal(lateCodeFailure.evidence.length, 0, "a late code outage must roll back earlier funding records from the same block");
  assert.ok(lateCodeFailure.coverage.every((item) => item.status === "unavailable"));
  await assert.rejects(collectNativeFundingPrefix({ ...source, request: async (method, params) => method === "eth_getCode" ? "not-code" : source.request(method, params) }), ProviderIntegrityError);
  const controller = new AbortController(), reason = new Error("Synthetic cancellation after a full-block response"); let calls = 0, canonicalCalls = 0;
  await assert.rejects(collectNativeFundingPrefix({ ...source, signal: controller.signal,
    canonicalBlock: async (number, hash) => { canonicalCalls++; return source.canonicalBlock(number, hash); },
    request: async (method, params) => { calls++; const value = await source.request(method, params); controller.abort(reason); return value; },
  }), (error: unknown) => error === reason);
  assert.equal(calls, 1); assert.equal(canonicalCalls, 0);
});

test("both funding adapters accept more than fifty discovered participants within acquisition budgets", async () => {
  for (const missingFunding of [false, true]) {
    const dataset = await collectBaseInvestigation(parameters, withAdditionalParticipants(fixture({ missingFunding }), 60));
    assert.equal(dataset.coverage.eligibleWallets, 61);
    assert.equal(dataset.coverage.examinedWallets, 61);
    assert.equal(dataset.coverage.funding.length, 61);
    assert.ok(dataset.coverage.funding.every((item) => item.status === "complete"));
    assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "all-participants-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
  }
});

test("native fallback propagates cancellation and unknown terminal failures", async () => {
  const controller = new AbortController(); controller.abort(new Error("Native fixture cancelled"));
  await assert.rejects(collectNativeFundingPrefix(nativeFixture({ signal: controller.signal })), /Native fixture cancelled/);
  await assert.rejects(collectNativeFundingPrefix(nativeFixture({ request: async () => { throw new Error("Terminal persistence failure"); } })), /Terminal persistence failure/);
});

test("unexhausted funding pagination is partial and never lifetime-first", async () => {
  const dataset = await collectBaseInvestigation(parameters, { ...fixture({ fundingNextPage: true }), limits: { fundingMaxPages: 1 } });
  assert.equal(dataset.coverage.funding[0].status, "partial");
  assert.match(dataset.coverage.funding[0].reason ?? "", /page limit/);
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("lifetime-first")));
});

test("indexed first-page availability failures are unavailable without examined wallets or funding evidence", async () => {
  for (const failure of [new UpstreamFailure(), new ProviderBudgetError()]) {
    const dataset = await collectBaseInvestigation(parameters, indexedFixture(async () => { throw failure; }));
    assert.equal(dataset.coverage.funding[0].status, "unavailable");
    assert.equal(dataset.coverage.examinedWallets, 0);
    assert.equal(dataset.evidence.filter((record) => record.kind === "funding").length, 0);
    assert.match(dataset.coverage.funding[0].reason ?? "", /No indexed page completed verification/);
  }
});

test("indexed later-page outage retains only prior verified bounds and exact native amounts", async () => {
  const dataset = await collectBaseInvestigation(parameters, indexedFixture(async (page) => {
    if (page) throw new UpstreamFailure();
    return indexedPage([{ hash: newerFundingHash, blockNumber: "100" }], true);
  }));
  assert.equal(dataset.coverage.funding[0].status, "partial");
  assert.equal(dataset.coverage.funding[0].fromBlock, "100");
  assert.equal(dataset.coverage.funding[0].toBlock, "100");
  assert.equal(dataset.coverage.examinedWallets, 1);
  assert.deepEqual(dataset.evidence.filter((record) => record.kind === "funding").map((record) => record.amountRaw), [largeNativeAmount.toString()]);
  assert.match(dataset.coverage.funding[0].reason ?? "", /boundary block/);
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "indexed-partial-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("indexed receipt failure rolls back an entire page rather than leaking evidence outside prior bounds", async () => {
  for (const priorPage of [false, true]) {
    const source = indexedFixture(async (page) => priorPage && page === 0
      ? indexedPage([{ hash: newerFundingHash, blockNumber: "100" }], true)
      : indexedPage([{ hash: fundingHash, blockNumber: "99" }, { hash: failedFundingHash, blockNumber: "99" }]));
    const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
      if (method === "eth_getTransactionReceipt" && params[0] === failedFundingHash) throw new UpstreamFailure();
      return source.rpc(method, params);
    } });
    assert.equal(dataset.coverage.funding[0].status, priorPage ? "partial" : "unavailable");
    assert.equal(dataset.coverage.examinedWallets, priorPage ? 1 : 0);
    assert.deepEqual(dataset.evidence.filter((record) => record.kind === "funding").map((record) => record.transactionHash), priorPage ? [newerFundingHash] : []);
    if (priorPage) assert.equal(dataset.coverage.funding[0].fromBlock, "100");
  }
});

test("indexed verified empty history and unsuccessful native execution complete without inventing funding", async () => {
  for (const failedExecution of [false, true]) {
    const source = indexedFixture(async () => indexedPage(failedExecution ? [{ hash: fundingHash, blockNumber: "99" }] : []));
    const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
      const value = await source.rpc(method, params);
      return failedExecution && method === "eth_getTransactionReceipt" && params[0] === fundingHash ? { ...value as object, status: "0x0" } : value;
    } });
    assert.equal(dataset.coverage.funding[0].status, "complete");
    assert.equal(dataset.coverage.funding[0].fromBlock, "99");
    assert.equal(dataset.coverage.examinedWallets, 1);
    assert.equal(dataset.evidence.filter((record) => record.kind === "funding").length, 0);
  }
});

test("indexed unknown failures and deadlines propagate instead of becoming incomplete source results", async () => {
  for (const failure of [new Error("Synthetic terminal error"), new DOMException("Synthetic provider deadline", "TimeoutError")]) {
    for (const location of ["page", "transaction", "receipt"]) {
      const source = indexedFixture(async () => {
        if (location === "page") throw failure;
        return indexedPage([{ hash: fundingHash, blockNumber: "99" }]);
      });
      await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
        if (params[0] === fundingHash && (location === "transaction" && method === "eth_getTransactionByHash" || location === "receipt" && method === "eth_getTransactionReceipt")) throw failure;
        return source.rpc(method, params);
      } }), (error: unknown) => error === failure);
    }
  }
});

test("indexed cancellation after a page resolves propagates the caller reason before committing", async () => {
  const controller = new AbortController(); const reason = new Error("Synthetic indexed cancellation");
  await assert.rejects(collectBaseInvestigation(parameters, { ...indexedFixture(async () => {
    controller.abort(reason);
    return indexedPage([{ hash: fundingHash, blockNumber: "99" }]);
  }), signal: controller.signal }), (error: unknown) => error === reason);
});

test("indexed out-of-order pages and conflicting repeated transaction fields reject integrity", async () => {
  const unordered = indexedFixture(async () => indexedPage([{ hash: fundingHash, blockNumber: "99" }, { hash: newerFundingHash, blockNumber: "100" }]));
  await assert.rejects(collectBaseInvestigation(parameters, unordered), ProviderIntegrityError);
  const source = indexedFixture(async (page) => indexedPage([{ hash: fundingHash, blockNumber: "99" }], page === 0)); let txReads = 0;
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
    const value = await source.rpc(method, params);
    if (method === "eth_getTransactionByHash" && params[0] === fundingHash && ++txReads === 2) return { ...value as object, value: "0x1" };
    return value;
  } }), ProviderIntegrityError);
});

test("indexed pages beyond the pinned end do not claim acquisition inside the declared window", async () => {
  const dataset = await collectBaseInvestigation(parameters, indexedFixture(async (page) => {
    if (page) throw new UpstreamFailure();
    return indexedPage([{ hash: newerFundingHash, blockNumber: "101" }], true);
  }));
  assert.equal(dataset.coverage.funding[0].status, "unavailable");
  assert.equal(dataset.coverage.examinedWallets, 0);
  assert.equal(dataset.evidence.filter((record) => record.kind === "funding").length, 0);
});

test("indexed historical contract recipients are excluded explicitly instead of labeled native EOA funding", async () => {
  const source = fixture();
  const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => method === "eth_getCode" && params[0] === wallet && params[1] === "0x63" ? "0x6000" : source.rpc(method, params) });
  assert.equal(dataset.coverage.funding[0].status, "complete");
  assert.equal(dataset.evidence.filter((record) => record.kind === "funding").length, 0);
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("historical contract/delegated-wallet")));
});

test("indexed budget exhaustion stops new wallet requests and leaves unreached wallets not examined", async () => {
  let pageCalls = 0;
  const source = withAdditionalParticipants(fixture(), 2);
  const dataset = await collectBaseInvestigation(parameters, { ...source, fundingHistory: async () => { pageCalls++; throw new ProviderBudgetError(); } });
  assert.equal(pageCalls, 1);
  assert.equal(dataset.coverage.eligibleWallets, 3);
  assert.equal(dataset.coverage.funding.filter((item) => item.status === "unavailable").length, 1);
  assert.equal(dataset.coverage.funding.filter((item) => item.status === "not_examined").length, 2);
  assert.equal(dataset.coverage.examinedWallets, 0);
});

test("indexed provider throttling stops new wallets while a verified prior page remains partial", async () => {
  for (const failure of [new UpstreamFailure(true, { httpStatus: 429 }), new UpstreamFailure(true, { rpcCode: -32016 })]) {
    let pageReads = 0;
    const source = withAdditionalParticipants(fixture(), 2);
    const dataset = await collectBaseInvestigation(parameters, { ...source, fundingHistory: async () => { pageReads++; throw failure; } });
    assert.equal(pageReads, 1);
    assert.equal(dataset.coverage.funding.filter((item) => item.status === "unavailable").length, 1);
    assert.equal(dataset.coverage.funding.filter((item) => item.status === "not_examined").length, 2);
    assert.ok(dataset.coverage.funding.every((item) => item.reason?.includes("throttling")));
  }
  const partial = await collectBaseInvestigation(parameters, indexedFixture(async (page) => {
    if (page) throw new UpstreamFailure(true, { httpStatus: 429 });
    return indexedPage([{ hash: newerFundingHash, blockNumber: "100" }], true);
  }));
  assert.equal(partial.coverage.funding[0].status, "partial");
  assert.equal(partial.coverage.funding[0].fromBlock, "100");
  assert.equal(partial.evidence.find((event) => event.kind === "funding")?.amountRaw, largeNativeAmount.toString());
});

test("the actual shared call budget bounds all-participant funding and reserves the final canonical recheck", async () => {
  for (const missingFunding of [false, true]) {
    const source = withAdditionalParticipants(fixture({ missingFunding }), 60);
    let requests = 0; let finalRechecks = 0;
    const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 30 },
      ...(source.fundingHistory ? { fundingHistory: async (target: Address, cursor: Record<string, string | number> | null, range: { fromBlock: string; toBlock: string }) => { requests++; return source.fundingHistory!(target, cursor, range); } } : {}),
      rpc: async (method, params) => {
        requests++;
        if (method === "eth_getBlockByNumber" && params[0] === "0x64" && params[1] === false) finalRechecks++;
        return source.rpc(method, params);
      },
    });
    assert.ok(requests <= 30, "actual reads, including the final check, stay within the shared budget");
    assert.equal(finalRechecks, 1);
    assert.equal(dataset.coverage.eligibleWallets, 61);
    if (missingFunding) {
      assert.equal(dataset.coverage.examinedWallets, 61, "one shared block search covers candidates without per-wallet code reads");
      assert.ok(dataset.coverage.funding.every((item) => item.status === "complete"));
      assert.equal(dataset.evidence.find((item) => item.kind === "funding")?.amountRaw, "1000");
    } else {
      assert.ok(dataset.coverage.funding.some((item) => item.status === "not_examined"));
      assert.ok(dataset.coverage.examinedWallets < 61);
    }
    assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "actual-budget-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
  }
});

test("collector joins holder candidates into funding coverage and verifies pinned balances separately from observed flow", async () => {
  const source = fixture({ hugeAmount: 2n ** 200n });
  const dataset = await collectBaseInvestigation(parameters, { ...source,
    holderPage: async (selectedToken) => { assert.equal(selectedToken, token); return { items: [{ address: unrelated }], nextCursor: null, tokenAddress: token }; },
    rpc: async (method, params) => {
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) {
        assert.equal(params[1], "0x64");
        const amount = (params[0] as { data: string }).data.endsWith(unrelated.slice(2)) ? 20n : 40n;
        return `0x${amount.toString(16).padStart(64, "0")}`;
      }
      return source.rpc(method, params);
    },
  });
  assert.equal(dataset.coverage.eligibleWallets, 2);
  assert.equal(dataset.coverage.examinedWallets, 2);
  assert.equal(dataset.holderSnapshot?.balances.verifiedWallets, 3);
  assert.equal(dataset.holderSnapshot?.discovery.addresses, 1);
  assert.equal(dataset.holderSnapshot?.block.hash, dataset.range.to.hash);
  const report = analyzeInvestigation(dataset, { id: "holder-integration-fixture", generatedAt: "2026-10-12T00:00:00.000Z" });
  const discovered = report.wallets.find((item) => item.address === unrelated)!;
  assert.equal(discovered.balanceRaw, "20");
  assert.equal(discovered.observedIncomingRaw, "0");
  assert.equal(discovered.firstObservedAt, null);
  assert.match(report.summary, /Pinned balances verified: 3\/3/);
  assert.match(report.findings.find((item) => item.category === "coverage")!.explanation, /not a finalized holder census/);
  assert.equal(report.evidence.filter((item) => item.kind === "transfer").length, 3);
});

test("priority wallet activity stays within its row limit after candidates are reordered lexically", async () => {
  const source = fixture({ hugeAmount: 10_000n });
  const priorityHolder = address("ff");
  const recipients = Array.from({ length: 2000 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address);
  const receiptHashes = [hash("da"), hash("db")];
  const logs = recipients.map((recipient, index) => transferLog(receiptHashes[index < 1000 ? 0 : 1], index < 1000 ? wallet : recipients[index - 1000], recipient, 1n, token, index < 1000 ? 99 : 100, index % 1000));
  let calls = 0; const reads: { method: string; params: unknown[] }[] = [];
  const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const dataset = await collectBaseInvestigation(parameters, { ...source,
    limits: { callBudget: 96, maxTransferLogs: 2000 },
    holderPage: async () => { calls++; return { tokenAddress: token, items: [{ address: priorityHolder }], nextCursor: null }; },
    fundingHistory: async () => { calls++; return { items: [], nextCursor: null }; },
    rpc: async (method, params) => {
      calls++; reads.push({ method, params });
      if (method === "eth_getLogs") return logs;
      if (method === "eth_getTransactionReceipt") {
        const index = receiptHashes.indexOf(params[0] as Hash), block = index === 0 ? 99 : 100;
        assert.notEqual(index, -1);
        return { transactionHash: receiptHashes[index], transactionIndex: "0x0", blockNumber: quantity(block), blockHash: blockHash(block), status: "0x1", logs: logs.slice(index * 1000, (index + 1) * 1000) };
      }
      if (method === "eth_getTransactionCount") { assert.equal(params[1], "0x64"); return "0x1"; }
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) {
        assert.equal(params[1], "0x64");
        return encodeFunctionResult({ abi: balanceAbi, functionName: "balanceOf", result: 1n });
      }
      return source.rpc(method, params);
    },
  });
  const activity = dataset.walletActivitySnapshot!.rows;
  assert.equal(dataset.coverage.eligibleWallets, 2002);
  assert.equal(dataset.evidence.length, 2000, "all acquired evidence remains available");
  assert.equal(activity.length, 2000, "reordering must not append a second cohort beyond the validated snapshot limit");
  assert.deepEqual(activity.find((row) => row.address === priorityHolder), { address: priorityHolder, code: "eoa", outgoingTransactionCountRaw: "1" }, "retain the already verified priority row even though it sorts after every ordinary recipient");
  assert.equal(activity.some((row) => row.address === recipients.at(-1)), false, "a late lexical candidate stays omitted rather than displacing verified state");
  assert.equal(new Set(activity.map((row) => row.address)).size, activity.length);
  assert.ok(dataset.holderSnapshot!.holders.some((holder) => holder.address === recipients.at(-1)), "activity omission does not discard the separate holder candidate");
  assert.ok(dataset.coverage.funding.some((entry) => entry.wallet === recipients.at(-1)), "omitted activity candidates retain funding coverage status");
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("wallet-activity row limit") && warning.includes("unknown")));
  assert.ok(calls <= 96, "all reads share the unchanged call budget");
  assert.deepEqual(reads.at(-1), { method: "eth_getBlockByNumber", params: ["0x64", false] }, "the mandatory final canonical read stays reserved");
  const report = analyzeInvestigation(dataset, { id: "11111111-1111-4111-8111-111111111111", generatedAt: "2026-10-14T00:00:00.000Z" });
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= 8 * 1024 * 1024, `Synthetic report byte size: ${Buffer.byteLength(JSON.stringify(report), "utf8")}`);
  assert.doesNotThrow(() => validateBaseInvestigationReport(report));
});

test("deferred holder balances and funding take priority over supplemental nonce reads in a tight budget", async () => {
  const source = fixture(); let calls = 0; let balanceReads = 0; let fundingReads = 0; let finalRechecks = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 30 },
    holderPage: async () => { calls++; return { items: [{ address: unrelated }], nextCursor: null }; },
    fundingHistory: async (target, cursor, range) => { calls++; fundingReads++; return source.fundingHistory!(target, cursor, range); },
    rpc: async (method, params) => {
      calls++;
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) { balanceReads++; return `0x${1n.toString(16).padStart(64, "0")}`; }
      if (method === "eth_getBlockByNumber" && params[0] === "0x64" && params[1] === false) finalRechecks++;
      return source.rpc(method, params);
    },
  });
  assert.ok(calls <= 30);
  assert.equal(balanceReads, 3);
  assert.ok(fundingReads > 0);
  assert.equal(finalRechecks, 1);
  assert.equal(dataset.holderSnapshot?.balances.status, "complete");
  assert.ok(dataset.walletActivitySnapshot?.rows.every((row) => row.outgoingTransactionCountRaw === null), "supplemental nonce remains unknown when core acquisition needs its reserve");
  assert.ok(dataset.evidence.some((item) => item.kind === "funding" && item.to === wallet));
});

test("holder RPC throttling stops optional candidates, pauses retries, and still requires a canonical final check", async () => {
  const source = fixture(); let balanceReads = 0, fundingReads = 0, calls = 0, finalRechecks = 0;
  const throttles: number[] = []; let canonicalAt = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source,
    holderPage: async () => { calls++; return { items: [{ address: unrelated }], nextCursor: null }; },
    fundingHistory: async (target, cursor, range) => { fundingReads++; return source.fundingHistory!(target, cursor, range); },
    rpc: async (method, params) => {
      calls++;
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) {
        if (++balanceReads > 1) { throttles.push(performance.now()); throw new UpstreamFailure(true, { httpStatus: 429 }); }
        return `0x${17n.toString(16).padStart(64, "0")}`;
      }
      if (method === "eth_getBlockByNumber" && params[0] === "0x64" && params[1] === false) { finalRechecks++; canonicalAt = performance.now(); }
      return source.rpc(method, params);
    },
  });
  assert.equal(balanceReads, 3, "one successful balance plus one throttled candidate and its single retry");
  assert.ok(throttles[1] - throttles[0] >= 900, "rate-limit retries must receive meaningful backoff");
  assert.ok(canonicalAt - throttles[1] >= 900, "final canonical verification must receive a recovery pause");
  assert.equal(finalRechecks, 1);
  assert.ok(fundingReads > 0);
  assert.ok(calls < 500);
  assert.deepEqual(dataset.holderSnapshot!.holders.map((item) => [item.status, item.balanceRaw]), [["verified", "17"], ["unavailable", null], ["not_examined", null]]);
  assert.ok(dataset.coverage.funding.every((item) => item.status === "complete"));
  assert.equal(dataset.evidence.find((item) => item.kind === "funding")?.amountRaw, "1000", "late balance throttling preserves verified funding");
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "throttled-optional-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("cancellation interrupts rate-limit backoff before another actual RPC call", async () => {
  const controller = new AbortController(), reason = new Error("Synthetic cancellation during throttled backoff"); let calls = 0;
  await assert.rejects(collectBaseInvestigation(parameters, { ...fixture(), signal: controller.signal,
    rpc: async () => { calls++; setTimeout(() => controller.abort(reason), 20); throw new UpstreamFailure(true, { rpcCode: -32005 }); },
  }), (error: unknown) => error === reason);
  assert.equal(calls, 1);
});

test("provider outages and transfer limits retain explicit partial coverage", async () => {
  const outage = await collectBaseInvestigation(parameters, fixture({ transferFailure: true }));
  assert.equal(outage.coverage.transfers, "partial");
  assert.equal(outage.evidence.length, 0);
  const limited = await collectBaseInvestigation(parameters, { ...fixture(), limits: { maxTransferLogs: 1 } });
  assert.equal(limited.coverage.transfers, "partial");
  assert.equal(limited.evidence.filter((record) => record.kind === "transfer").length, 1);
});

test("an explicit log RPC discovers transfers while the state RPC verifies receipts without sharing endpoint advancement", async () => {
  const source = fixture();
  const stateReads: { endpoint: number; method: string; params: unknown[] }[] = [];
  const logReads: { method: string; params: unknown[] }[] = [];
  let endpoint = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source,
    rpcSource: () => `fixture-state-${endpoint}`,
    logRpcSource: () => "fixture-log-source",
    recoverRpc: () => { if (endpoint) return false; endpoint++; return true; },
    rpc: async (method, params) => {
      stateReads.push({ endpoint, method, params });
      assert.notEqual(method, "eth_getLogs", "state access must not replace the explicit log lane");
      if (endpoint === 0 && method === "eth_getTransactionReceipt") throw new UpstreamFailure(false, { httpStatus: 403 });
      return source.rpc(method, params);
    },
    logRpc: async (method, params) => {
      logReads.push({ method, params });
      assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"].includes(method), "receipt/state reads belong to the state lane");
      return source.rpc(method, params);
    },
  });
  assert.deepEqual(logReads.map(({ method }) => method), ["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByNumber", "eth_getLogs"]);
  assert.deepEqual(logReads.slice(1, 3).map(({ params }) => params), [["0x63", false], ["0x64", false]]);
  assert.equal(endpoint, 1, "only receipt verification advanced the independent state endpoint");
  assert.equal(dataset.coverage.transfers, "complete");
  assert.equal(dataset.evidence.filter((record) => record.kind === "transfer" && record.assetAddress === token).length, 2);
  assert.equal(dataset.evidence.find((record) => record.kind === "funding")?.amountRaw, "1000");
  assert.ok(dataset.evidence.some((record) => record.kind === "sale"));
  assert.deepEqual(stateReads.at(-1), { endpoint: 1, method: "eth_getBlockByNumber", params: ["0x64", false] });
  assert.ok(dataset.evidence.every((record) => record.provenance.provider.includes("fixture-log-source")));
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "separate-log-source", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("log RPC chain and pinned header disagreements reject before discovery or receipt reads", async () => {
  for (const mutation of ["chain", "hash", "number", "timestamp"]) {
    const source = fixture(); let discovered = 0; let receipts = 0; let recovered = 0;
    await assert.rejects(collectBaseInvestigation(parameters, { ...source,
      recoverRpc: () => { recovered++; return true; },
      rpc: async (method, params) => { if (method === "eth_getTransactionReceipt") receipts++; return source.rpc(method, params); },
      logRpc: async (method, params) => {
        if (method === "eth_getLogs") discovered++;
        const value = await source.rpc(method, params);
        if (mutation === "chain" && method === "eth_chainId") return "0x1";
        if (method !== "eth_getBlockByNumber") return value;
        const block = value as Record<string, unknown>;
        return { ...block, ...(mutation === "hash" ? { hash: hash("ee") } : mutation === "number" ? { number: "0x62" } : mutation === "timestamp" ? { timestamp: "0x1" } : {}) };
      },
    }), ProviderIntegrityError);
    assert.equal(discovered, 0);
    assert.equal(receipts, 0);
    assert.equal(recovered, 0, "integrity disagreement must not select another source");
  }
});

test("separate log source handshake shares the allocation and preserves funding and the final canonical reserve", async () => {
  const source = fixture(); let calls = 0; let logQueries = 0; let fundingQueries = 0;
  const reads: string[] = [];
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 20 },
    holderPage: async () => { calls++; return { items: [{ address: wallet }], nextCursor: null }; },
    fundingHistory: async (target, cursor, range) => { calls++; fundingQueries++; return source.fundingHistory!(target, cursor, range); },
    rpc: async (method, params) => { calls++; reads.push(method); return source.rpc(method, params); },
    logRpc: async (method, params) => { calls++; if (method === "eth_getLogs") logQueries++; return source.rpc(method, params); },
  });
  assert.equal(logQueries, 0, "three counted identity/header reads consume the small discovery allocation");
  assert.equal(dataset.coverage.transfers, "partial");
  assert.ok(fundingQueries > 0, "discovery cannot consume the separate funding allocation");
  assert.equal(reads.at(-1), "eth_getBlockByNumber");
  assert.ok(calls <= 20, "all actual state, log, index and funding reads share one total budget");
});

test("access refusal and transient log failure never waste funding capacity on smaller ranges", async () => {
  for (const failure of [new UpstreamFailure(false, { httpStatus: 403 }), new UpstreamFailure(true)]) {
    const source = fixture(); const widths: number[] = [];
    const dataset = await collectBaseInvestigation({ ...parameters, lookbackBlocks: 20 }, { ...source, limits: { logChunkSize: 20 },
      logRpc: async (method, params) => {
        if (method !== "eth_getLogs") return source.rpc(method, params);
        const range = params[0] as { fromBlock: string; toBlock: string };
        widths.push(Number(BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n));
        throw failure;
      },
    });
    assert.deepEqual(widths, failure.retryable ? [20, 20] : [20]);
    assert.equal(dataset.coverage.transfers, "partial");
    assert.equal(dataset.evidence.length, 0);
  }
});

test("explicit log range limits split without treating their overloaded error code as a state throttle", async () => {
  const source = fixture(); const widths: number[] = [];
  const dataset = await collectBaseInvestigation({ ...parameters, lookbackBlocks: 20 }, { ...source, limits: { logChunkSize: 20 },
    logRpc: async (method, params) => {
      if (method !== "eth_getLogs") return source.rpc(method, params);
      const range = params[0] as { fromBlock: string; toBlock: string };
      const width = Number(BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n);
      widths.push(width);
      if (width > 10) throw new ProviderLogRangeError(false, { rpcCode: -32005 });
      return source.rpc(method, params);
    },
  });
  assert.deepEqual(widths, [20, 10, 10]);
  assert.equal(dataset.coverage.transfers, "complete");
  assert.ok(dataset.evidence.some((record) => record.kind === "sale"), "a log range limit must not disable later swap verification");
  assert.ok(dataset.evidence.some((record) => record.kind === "funding"));
  assert.ok(!dataset.coverage.warnings.some((warning) => warning.includes("RPC throttling stopped")));
});

test("one refused old log chunk cannot suppress permitted recent receipt-backed evidence", async () => {
  const source = fixture(); const ranges: string[][] = [];
  const dataset = await collectBaseInvestigation({ ...parameters, lookbackBlocks: 30 }, { ...source, limits: { logChunkSize: 10 },
    logRpc: async (method, params) => {
      if (method !== "eth_getLogs") return source.rpc(method, params);
      const range = params[0] as { fromBlock: string; toBlock: string };
      ranges.push([BigInt(range.fromBlock).toString(), BigInt(range.toBlock).toString()]);
      if (range.fromBlock === quantity(81)) throw new UpstreamFailure(false, { httpStatus: 403 });
      return source.rpc(method, params);
    },
  });
  assert.deepEqual(ranges, [["71", "80"], ["81", "90"], ["91", "100"]]);
  assert.equal(dataset.coverage.transfers, "partial", "a successful suffix does not erase the refused gap");
  assert.equal(dataset.evidence.filter((record) => record.kind === "transfer" && record.assetAddress === token).length, 2);
  assert.ok(dataset.evidence.some((record) => record.kind === "funding"));
  assert.ok(dataset.evidence.some((record) => record.kind === "sale"));
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("81–90") && warning.includes("remain unknown")));
  const report = analyzeInvestigation(dataset, { id: "permitted-recent-suffix", generatedAt: "2026-10-12T00:00:00.000Z" });
  assert.ok(!report.findings.some((finding) => finding.category === "accumulation"), "a skipped prefix cannot establish early accumulation");
});

test("a second generic refusal stops the recent pass without retrying older or denied ranges", async () => {
  const source = fixture(); const ranges: string[][] = [];
  const dataset = await collectBaseInvestigation({ ...parameters, lookbackBlocks: 40 }, { ...source, limits: { logChunkSize: 10 },
    logRpc: async (method, params) => {
      if (method !== "eth_getLogs") return source.rpc(method, params);
      const range = params[0] as { fromBlock: string; toBlock: string };
      ranges.push([BigInt(range.fromBlock).toString(), BigInt(range.toBlock).toString()]);
      throw new UpstreamFailure(false, { httpStatus: 403 });
    },
  });
  assert.deepEqual(ranges, [["61", "70"], ["91", "100"]]);
  assert.equal(dataset.coverage.transfers, "partial");
  assert.equal(dataset.evidence.length, 0);
});

test("explicit result limits split the reversed suffix at a fixed end without crossing its gap", async () => {
  const source = fixture(); const ranges: string[][] = [];
  const dataset = await collectBaseInvestigation({ ...parameters, lookbackBlocks: 40 }, { ...source, limits: { logChunkSize: 20 },
    logRpc: async (method, params) => {
      if (method !== "eth_getLogs") return source.rpc(method, params);
      const range = params[0] as { fromBlock: string; toBlock: string };
      ranges.push([BigInt(range.fromBlock).toString(), BigInt(range.toBlock).toString()]);
      if (range.fromBlock === quantity(61)) throw new UpstreamFailure(false, { httpStatus: 403 });
      if (BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n > 10n) throw new ProviderLogRangeError();
      return source.rpc(method, params);
    },
  });
  assert.deepEqual(ranges, [["61", "80"], ["81", "100"], ["91", "100"], ["81", "90"]]);
  assert.equal(dataset.coverage.transfers, "partial");
  assert.equal(dataset.evidence.filter((record) => record.kind === "transfer" && record.assetAddress === token).length, 2);
});

test("receipt refusal and unverified log source refusal cannot start a recent-range pass", async () => {
  for (const failedMethod of ["eth_getTransactionReceipt", "eth_chainId"]) {
    const source = fixture(); const queriedRanges: string[][] = [];
    const earlyMint = { ...transferLog(mintHash, ZERO, wallet, 100n, token, 81), blockHash: blockHash(81) };
    const dataset = await collectBaseInvestigation({ ...parameters, lookbackBlocks: 20 }, { ...source, limits: { logChunkSize: 10 },
      rpc: async (method, params) => { if (failedMethod === "eth_getTransactionReceipt" && method === failedMethod) throw new UpstreamFailure(false, { httpStatus: 403 }); return source.rpc(method, params); },
      logRpc: async (method, params) => {
        if (failedMethod === "eth_chainId" && method === failedMethod) throw new UpstreamFailure(false, { httpStatus: 403 });
        if (method !== "eth_getLogs") return source.rpc(method, params);
        const range = params[0] as { fromBlock: string; toBlock: string };
        queriedRanges.push([BigInt(range.fromBlock).toString(), BigInt(range.toBlock).toString()]);
        return [earlyMint];
      },
    });
    assert.deepEqual(queriedRanges, failedMethod === "eth_chainId" ? [] : [["81", "90"]]);
    assert.equal(dataset.coverage.transfers, "partial");
    assert.ok(!dataset.coverage.warnings.some((warning) => warning.includes("newest backward")));
  }
});

test("valid oversized log arrays split ranges while malformed arrays still reject", async () => {
  const source = fixture({ missingFunding: true });
  const requestedWidths: number[] = [];
  const oversized = Array.from({ length: 2001 }, () => transferLog(mintHash, ZERO, wallet, 100n, token, 99));
  const split = await collectBaseInvestigation({ ...parameters, lookbackBlocks: 20 }, {
    ...source,
    limits: { logChunkSize: 20 },
    rpc: async (method, params) => {
      if (method !== "eth_getLogs") return source.rpc(method, params);
      const range = params[0] as { fromBlock: string; toBlock: string };
      const width = Number(BigInt(range.toBlock) - BigInt(range.fromBlock) + 1n);
      requestedWidths.push(width);
      return width > 10 ? oversized : source.rpc(method, params);
    },
  });
  assert.deepEqual(requestedWidths, [20, 10, 10]);
  assert.equal(split.coverage.transfers, "complete");
  assert.equal(split.evidence.filter((record) => record.kind === "transfer" && record.assetAddress === token).length, 2);
  const bounded = await collectBaseInvestigation(parameters, { ...source, rpc: (method, params) => method === "eth_getLogs" ? Promise.resolve(oversized) : source.rpc(method, params) });
  assert.equal(bounded.coverage.transfers, "partial");
  assert.ok(bounded.coverage.warnings.some((warning) => warning.includes("bounded log limit")));
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: (method, params) => method === "eth_getLogs" ? Promise.resolve([{ ...oversized[0], data: "invalid" }, ...oversized.slice(1)]) : source.rpc(method, params) }), ProviderIntegrityError);
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: (method, params) => method === "eth_getLogs" ? Promise.resolve([{ ...oversized[0], blockHash: hash("ee") }, ...oversized.slice(1)]) : source.rpc(method, params) }), ProviderIntegrityError);
});

test("invalid token text metadata remains unknown and cannot invalidate a receipt-backed report", async () => {
  for (const metadata of [{ metadataName: "", metadataSymbol: "" }, { metadataName: "  ", metadataSymbol: "  " }, { metadataName: "bad\u0000name", metadataSymbol: "bad\u007fsymbol" }, { metadataName: "n".repeat(256), metadataSymbol: "s".repeat(65) }]) {
    const dataset = await collectBaseInvestigation(parameters, fixture(metadata));
    assert.equal(dataset.token.name, null);
    assert.equal(dataset.token.symbol, null);
    assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("name metadata")));
    assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("symbol metadata")));
    assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "metadata-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
  }
  const boundary = await collectBaseInvestigation(parameters, fixture({ metadataName: "n".repeat(255), metadataSymbol: "s".repeat(64) }));
  assert.equal(boundary.token.name?.length, 255);
  assert.equal(boundary.token.symbol?.length, 64);
  assert.doesNotThrow(() => analyzeInvestigation(boundary, { id: "metadata-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("malformed supply ABI words cannot become a denominator for holder percentages", async () => {
  for (const supplyData of ["0x", "0x01", `0x${"0".repeat(63)}1${"0".repeat(64)}`]) {
    const source = fixture();
    const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
      if (method === "eth_call" && (params[0] as { data: string }).data === encodeFunctionData({ abi: metadataAbi, functionName: "totalSupply" })) return supplyData;
      return source.rpc(method, params);
    } });
    assert.equal(dataset.token.totalSupplyRaw, null);
    assert.match(dataset.coverage.warnings.join(" "), /supply percentages remain unknown/);
    assert.ok(dataset.evidence.some((event) => event.kind === "sale"));
  }
});

test("pool spoofing, outgoing transfers, missing consideration, and multihop do not create sales", async () => {
  for (const options of [{ fakePool: true }, { noSwap: true }, { missingQuote: true }, { coincidentGift: true }, { multipleSwaps: true }]) {
    const dataset = await collectBaseInvestigation(parameters, fixture(options));
    assert.equal(dataset.evidence.filter((record) => record.kind === "sale").length, 0);
    assert.ok(dataset.evidence.some((record) => record.kind === "transfer"));
  }
});

test("authenticated pools stay outside wallet groups when a multi-swap route is unclassified", async () => {
  const dataset = await collectBaseInvestigation(parameters, fixture({ multipleSwaps: true }));
  assert.equal(dataset.evidence.filter((record) => record.kind === "sale").length, 0);
  assert.ok(dataset.pools.includes(pool));
  assert.ok(dataset.hubs.includes(pool));
  assert.ok(dataset.coverage.funding.every((item) => item.wallet !== pool));
  const report = analyzeInvestigation(dataset, { id: "unsupported-route-fixture", generatedAt: "2026-10-12T00:00:00.000Z" });
  assert.ok(report.wallets.every((item) => item.address !== pool));
  assert.ok(report.connections.every((item) => item.from !== pool && item.to !== pool));
  assert.ok(report.groups.every((item) => !item.wallets.includes(pool)));

  const spoofed = await collectBaseInvestigation(parameters, fixture({ multipleSwaps: true, fakePool: true }));
  assert.ok(!spoofed.pools.includes(pool));
  assert.ok(!spoofed.hubs.includes(pool));
});

test("a selected pair is authenticated without window swaps and excluded from wallet findings only after factory proof", async () => {
  for (const forged of [false, true]) {
    const source = fixture({ noSwap: true, fakePool: forged });
    const reads: { to: string; block: unknown }[] = [];
    let quoteReads = 0;
    const dataset = await collectBaseInvestigation(parameters, { ...source,
      poolCandidates: async () => [pool],
      holderPage: async () => ({ items: [{ address: wallet }, { address: pool }], nextCursor: null }),
      rpc: async (method, params) => {
        if (method === "eth_getLogs") return [];
        if (method === "eth_call") {
          const target = params[0] as { to: string; data: string };
          if (target.to === pool && target.data === encodeFunctionData({ abi: exitQuoteAbi, functionName: "slot0" })) {
            quoteReads++;
            return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "slot0", result: [1n << 96n, 0, 0, 1, 1, 0, true] });
          }
          if (target.to === BASE_V3_QUOTER_V2) {
            quoteReads++;
            if (target.data === encodeFunctionData({ abi: exitQuoteAbi, functionName: "factory" })) return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "factory", result: BASE_V3_FACTORY });
            return encodeFunctionResult({ abi: exitQuoteAbi, functionName: "quoteExactInputSingle", result: [7n, (1n << 96n) * 9n / 10n, 2, 120000n] });
          }
          if (target.to === pool || target.to === BASE_V3_FACTORY) reads.push({ to: target.to, block: params[1] });
          if (target.to === token && target.data.startsWith("0x70a08231")) return `0x${(target.data.endsWith(pool.slice(2)) ? 90n : 10n).toString(16).padStart(64, "0")}`;
        }
        return source.rpc(method, params);
      },
    });
    assert.equal(dataset.evidence.some((item) => item.kind === "transfer" || item.kind === "sale"), false, "metadata does not manufacture event evidence");
    assert.equal(reads.length, 5);
    assert.ok(reads.every((item) => item.block === "0x64"), "all pool proof reads use the pinned finalized block");
    assert.equal(dataset.pools.includes(pool), !forged);
    assert.equal(quoteReads, forged ? 0 : 3, "only an authenticated selected pair can acquire a tick-aware quote");
    assert.equal(dataset.exitQuote?.status, forged ? "unsupported" : "quoted");
    if (!forged) { assert.equal(dataset.exitQuote?.wallet, wallet); assert.equal(dataset.exitQuote?.amountInRaw, "10"); assert.equal(dataset.exitQuote?.amountOutRaw, "7"); }
    const report = analyzeInvestigation(dataset, { id: `selected-pair-${forged}`, generatedAt: "2026-10-12T00:00:00.000Z" });
    assert.equal(report.wallets.some((item) => item.address === pool), forged);
    assert.equal(dataset.coverage.funding.some((item) => item.wallet === pool), forged);
    assert.equal(dataset.holderSnapshot?.holders.find((item) => item.address === pool)?.balanceRaw, "90", "pool holdings remain available separately from eligible wallets");
  }
});

test("selected-pair authentication preserves shared call limits and the reserved final canonical check", async () => {
  const source = fixture(); let calls = 0, candidateReads = 0, finalChecks = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 20 },
    poolCandidates: async () => { candidateReads++; return [pool]; },
    rpc: async (method, params) => {
      calls++;
      if (method === "eth_getBlockByNumber" && params[0] === "0x64") finalChecks++;
      return source.rpc(method, params);
    },
  });
  assert.ok(calls <= 20);
  assert.equal(finalChecks, 1);
  assert.equal(dataset.range.to.hash, block100);
  assert.ok(candidateReads <= 1);
});

test("selected-pair cancellation remains terminal and cannot produce a verified pool", async () => {
  const source = fixture(); const controller = new AbortController(); const reason = new Error("Synthetic selected-pair cancellation");
  let poolReads = 0;
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, signal: controller.signal,
    poolCandidates: async () => { controller.abort(reason); return [pool]; },
    rpc: async (method, params) => {
      if (method === "eth_call" && (params[0] as { to: string }).to === pool) poolReads++;
      return source.rpc(method, params);
    },
  }), (error) => error === reason);
  assert.equal(poolReads, 0);
});

test("a pool throttle stops other pool-authentication requests inside the same multi-swap receipt", async () => {
  const source = fixture({ multipleSwaps: true }); let firstPoolReads = 0, secondPoolReads = 0, finalRechecks = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
    if (method === "eth_call") {
      const target = (params[0] as { to: Address }).to;
      if (target === pool) { firstPoolReads++; throw new UpstreamFailure(true, { httpStatus: 429 }); }
      if (target === unrelated) secondPoolReads++;
    }
    if (method === "eth_getBlockByNumber" && params[0] === "0x64" && params[1] === false) finalRechecks++;
    const value = await source.rpc(method, params);
    if (method === "eth_getTransactionReceipt" && params[0] === saleHash) {
      const receipt = value as { logs: ReturnType<typeof transferLog>[] };
      return { ...receipt, logs: receipt.logs.map((log) => log.topics[0] === SWAP_TOPIC && log.logIndex === "0x3" ? { ...log, address: unrelated } : log) };
    }
    return value;
  } });
  assert.equal(firstPoolReads, 2, "the first pool gets at most one bounded retry");
  assert.equal(secondPoolReads, 0, "another pool in the same receipt must not create more throttle pressure");
  assert.equal(finalRechecks, 1);
  assert.equal(dataset.evidence.filter((event) => event.kind === "sale").length, 0);
  assert.equal(dataset.coverage.funding[0].status, "not_examined", "early infrastructure throttling must not claim a subsequent funding search completed");
});

test("busy transfer receipts leave room for a verified native funding prefix before enrichment", async () => {
  const source = fixture({ missingFunding: true }); let actualCalls = 0; const operations: string[] = [];
  const extraLogs = Array.from({ length: 60 }, (_, index) => ({ ...transferLog(`0x${(9000n + BigInt(index)).toString(16).padStart(64, "0")}` as Hash, ZERO, wallet, 1n, token, 99), transactionIndex: quantity(index + 2) }));
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 60 }, rpc: async (method, params) => {
    actualCalls++; operations.push(method === "eth_getBlockByNumber" && params[1] === true ? "funding-block" : method);
    const extra = extraLogs.find((log) => log.transactionHash === params[0]);
    if (method === "eth_getTransactionReceipt" && extra) return { transactionHash: extra.transactionHash, transactionIndex: extra.transactionIndex, blockNumber: "0x63", blockHash: block99, status: "0x1", logs: [extra] };
    const value = await source.rpc(method, params);
    if (method === "eth_getLogs") return [...value as object[], ...extraLogs];
    if (method === "eth_getBlockByNumber" && params[0] === "0x63" && params[1] === true) return { ...value as object, transactions: [...(value as { transactions: object[] }).transactions, ...extraLogs.map((log) => ({ hash: log.transactionHash, transactionIndex: log.transactionIndex, blockNumber: "0x63", blockHash: block99, from: funder, to: wallet, value: "0x0" }))] };
    return value;
  } });
  assert.ok(actualCalls <= 60);
  assert.ok(operations.indexOf("funding-block") < 30, "funding starts before optional work consumes most calls");
  assert.equal(dataset.coverage.transfers, "partial");
  assert.ok(dataset.coverage.warnings.some((warning) => warning.includes("preserve funding capacity")));
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.status, "complete");
  assert.equal(dataset.evidence.find((item) => item.kind === "funding")?.amountRaw, "1000");
  assert.equal(operations.at(-1), "eth_getBlockByNumber");
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "funding-priority-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("late sale-support participants receive explicit funding gaps and deferred pinned balances", async () => {
  const source = fixture(); const gift = transferLog(saleHash, funder, unrelated, 1n, token, 100, 3); const checkedBalances: string[] = [];
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { maxTransferLogs: 2 }, holderPage: async () => ({ items: [], nextCursor: null }), rpc: async (method, params) => {
    if (method === "eth_call" && (params[0] as { data: string }).data.startsWith("0x70a08231")) { checkedBalances.push((params[0] as { data: string }).data.slice(-40)); return `0x${1n.toString(16).padStart(64, "0")}`; }
    const value = await source.rpc(method, params);
    if (method === "eth_getLogs") return [...value as object[], gift];
    if (method === "eth_getTransactionReceipt" && params[0] === saleHash) return { ...value as object, logs: [...(value as { logs: object[] }).logs, gift] };
    return value;
  } });
  assert.equal(dataset.coverage.transfers, "partial");
  assert.equal(dataset.evidence.filter((item) => item.kind === "sale").length, 1);
  for (const target of [funder, unrelated]) {
    assert.equal(dataset.coverage.funding.find((item) => item.wallet === target)?.status, "not_examined");
    assert.match(dataset.coverage.funding.find((item) => item.wallet === target)?.reason ?? "", /after the funding phase/);
    assert.equal(dataset.holderSnapshot?.holders.find((item) => item.address === target)?.balanceRaw, "1");
    assert.ok(checkedBalances.includes(target.slice(2)));
  }
  assert.equal(dataset.coverage.eligibleWallets, 3);
  assert.equal(dataset.coverage.examinedWallets, 1);
  assert.equal(dataset.holderSnapshot?.balances.requestedWallets, 4);
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "late-sale-participants-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("late authenticated pools lose wallet funding coverage and matching native observations together", async () => {
  const source = fixture({ missingFunding: true }); const poolFunding = hash("de");
  const dataset = await collectBaseInvestigation(parameters, { ...source, rpc: async (method, params) => {
    if (method === "eth_getTransactionReceipt" && params[0] === poolFunding) return { transactionHash: poolFunding, transactionIndex: "0x2", blockNumber: "0x63", blockHash: block99, status: "0x1", logs: [] };
    const value = await source.rpc(method, params);
    if (method === "eth_getBlockByNumber" && params[0] === "0x63" && params[1] === true) return { ...value as object, transactions: [...(value as { transactions: object[] }).transactions, { hash: poolFunding, transactionIndex: "0x2", blockNumber: "0x63", blockHash: block99, from: funder, to: pool, value: "0x7" }] };
    return value;
  } });
  assert.ok(dataset.pools.includes(pool));
  assert.ok(!dataset.coverage.funding.some((item) => item.wallet === pool));
  assert.ok(!dataset.evidence.some((item) => item.kind === "funding" && item.to === pool));
  assert.equal(dataset.coverage.eligibleWallets, 1);
  assert.equal(dataset.coverage.examinedWallets, 1);
  assert.ok(dataset.evidence.some((item) => item.kind === "funding" && item.to === wallet));
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "late-pool-reconciliation-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("failed receipts, mixed block hashes, malformed logs, and finality changes reject evidence", async () => {
  for (const options of [{ failedReceipt: true }, { mismatchedReceipt: true }, { badTransfer: true }, { reorg: true }]) await assert.rejects(collectBaseInvestigation(parameters, fixture(options)), ProviderIntegrityError);
});

test("wrong network and cancellation stop collection before evidence can be returned", async () => {
  const source = fixture();
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc: (method, params) => method === "eth_chainId" ? Promise.resolve("0x1") : source.rpc(method, params) }), /not Base mainnet/);
  const controller = new AbortController(); controller.abort(new Error("Fixture cancellation"));
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, signal: controller.signal }), /Fixture cancellation/);
});

test("a throttled RPC can recover through a counted same-chain same-range fallback handshake", async () => {
  const source = fixture({ missingFunding: true }); let endpoint = 0; const reads: { endpoint: number; method: string; params: unknown[] }[] = [];
  const dataset = await collectBaseInvestigation(parameters, { ...source,
    recoverRpc: () => endpoint === 0 ? (endpoint++, true) : false,
    rpcSource: () => endpoint === 0 ? "Base public RPC" : "PublicNode Base RPC",
    rpc: async (method, params) => {
      reads.push({ endpoint, method, params });
      if (endpoint === 0 && method === "eth_getLogs") throw new UpstreamFailure(true, { httpStatus: 429 });
      return source.rpc(method, params);
    },
  });
  const recovered = reads.filter((item) => item.endpoint === 1);
  assert.deepEqual(recovered.slice(0, 4).map((item) => [item.method, item.params[0]]), [["eth_chainId", undefined], ["eth_getBlockByNumber", "0x63"], ["eth_getBlockByNumber", "0x64"], ["eth_getLogs", recovered[3].params[0]]]);
  assert.equal(dataset.coverage.transfers, "complete");
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.status, "complete");
  assert.ok(dataset.evidence.some((item) => item.kind === "sale"));
  assert.ok(dataset.evidence.every((item) => item.provenance.provider.includes("PublicNode Base RPC")));
  assert.match(dataset.coverage.warnings.join(" "), /scan-wide source set/);
  assert.equal(reads.at(-1)?.params[0], "0x64");
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "verified-fallback-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("fallback chain, hash and timestamp disagreements fail closed without replaying the failed read", async () => {
  for (const mismatch of ["chain", "hash", "timestamp"]) {
    const source = fixture(); let endpoint = 0; let replayedLogs = 0;
    await assert.rejects(collectBaseInvestigation(parameters, { ...source, recoverRpc: () => (endpoint++, true), rpc: async (method, params) => {
      if (endpoint === 0 && method === "eth_getLogs") throw new UpstreamFailure(true);
      if (endpoint === 1 && method === "eth_getLogs") replayedLogs++;
      const value = await source.rpc(method, params);
      if (endpoint === 1 && mismatch === "chain" && method === "eth_chainId") return "0x1";
      if (endpoint === 1 && method === "eth_getBlockByNumber") return { ...value as object, ...(mismatch === "hash" ? { hash: hash("ef") } : mismatch === "timestamp" ? { timestamp: "0xff" } : {}) };
      return value;
    } }), ProviderIntegrityError);
    assert.equal(replayedLogs, 0);
    assert.equal(endpoint, 1, "integrity disagreement cannot trigger another source switch");
  }
});

test("fallback activation cannot consume the reserved canonical call or bypass phase accounting", async () => {
  const source = fixture({ missingFunding: true }); let recoveries = 0; let failed = false; let calls = 0; let canonicalChecks = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { callBudget: 20 }, recoverRpc: () => { recoveries++; return true; }, rpc: async (method, params) => {
    calls++;
    if (method === "eth_getLogs" && !failed) { failed = true; throw new UpstreamFailure(true); }
    if (method === "eth_getBlockByNumber" && params[0] === "0x64" && params[1] === false) canonicalChecks++;
    return source.rpc(method, params);
  } });
  assert.equal(recoveries, 0, "insufficient handshake capacity keeps the current source");
  assert.ok(calls <= 20);
  assert.equal(canonicalChecks, 1);
  assert.equal(dataset.coverage.transfers, "partial");
  assert.ok(dataset.evidence.some((item) => item.kind === "funding"));
});

test("cancellation during a fallback handshake preserves the caller reason and prevents replay", async () => {
  const source = fixture(); const controller = new AbortController(); const reason = new Error("Synthetic fallback cancellation"); let endpoint = 0; let replayed = 0;
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, signal: controller.signal, recoverRpc: () => (endpoint++, true), rpc: async (method, params) => {
    if (endpoint === 0 && method === "eth_getLogs") throw new UpstreamFailure(true);
    if (endpoint === 1 && method === "eth_chainId") controller.abort(reason);
    if (endpoint === 1 && method === "eth_getLogs") replayed++;
    return source.rpc(method, params);
  } }), (error: unknown) => error === reason);
  assert.equal(replayed, 0);
});

test("malformed evidence never invokes RPC availability recovery", async () => {
  const source = fixture(); let recoveries = 0;
  await assert.rejects(collectBaseInvestigation(parameters, { ...source, recoverRpc: () => { recoveries++; return true; }, rpc: async (method, params) => method === "eth_getLogs" ? [{ invalid: true }] : source.rpc(method, params) }), ProviderIntegrityError);
  assert.equal(recoveries, 0);
});

function transferCeilingThrottleFixture(lastFallbackAvailable = true) {
  const source = fixture({ missingFunding: true, noSwap: true });
  const laterHash = hash("d1");
  const calls: { endpoint: number; method: string; params: unknown[] }[] = [];
  let endpoint = 0, recoveries = 0, fundingStartedAt = -1;
  const dependencies: CollectorDependencies = {
    ...source, limits: { callBudget: 30 },
    rpcSource: () => ["dRPC Base RPC", "PublicNode Base RPC", "Base public RPC"][endpoint],
    recoverRpc: () => {
      recoveries++;
      if (endpoint >= (lastFallbackAvailable ? 2 : 1)) return false;
      endpoint++; return true;
    },
    onProgress: async (stage) => { if (stage.startsWith("Tracing observed native funding")) fundingStartedAt = calls.length; },
    rpc: async (method, params) => {
      calls.push({ endpoint, method, params });
      // Primary state works, but its log method is denied. The first fallback
      // then throttles exactly on the final transfer-allocation receipt call.
      if (endpoint === 0 && method === "eth_getLogs") throw new UpstreamFailure(false, { httpStatus: 403 });
      if (endpoint === 1 && method === "eth_getTransactionReceipt" && params[0] === laterHash) throw new UpstreamFailure(true, { httpStatus: 429 });
      if (method === "eth_getLogs") return [transferLog(mintHash, ZERO, wallet, 100n, token, 99), transferLog(laterHash, ZERO, wallet, 1n, token, 99, 1)];
      return source.rpc(method, params);
    },
  };
  return { dependencies, calls, recoveries: () => recoveries, fundingStartedAt: () => fundingStartedAt };
}

test("a transfer-ceiling throttle can recover once at the funding boundary with counted pinned-header checks", async () => {
  for (const fundingSource of ["native", "sqd"] as const) {
    const f = transferCeilingThrottleFixture(); let indexedCalls = 0;
    if (fundingSource === "sqd") f.dependencies.sqdFundingPage = async () => {
      indexedCalls++;
      return { blocks: [
        { header: { number: "99", hash: block99, parentHash: blockHash(98), timestamp: 198 }, transactions: [{ hash: fundingHash, from: funder, to: wallet, value: "1000", transactionIndex: 1, status: 1 }] },
        { header: { number: "100", hash: block100, parentHash: block99, timestamp: 200 }, transactions: [] },
      ] };
    };
    const dataset = await collectBaseInvestigation(parameters, f.dependencies);
    assert.equal(f.fundingStartedAt(), 15, "the 429 must consume the exact transfer allocation, leaving no earlier handshake capacity");
    assert.equal(f.recoveries(), 2, "one log-method recovery, then one funding-boundary recovery");
    const fundingReads = f.calls.filter((call) => call.endpoint === 2);
    assert.deepEqual(fundingReads.slice(0, 3).map(({ method, params }) => [method, params]), [
      ["eth_chainId", []], ["eth_getBlockByNumber", ["0x63", false]], ["eth_getBlockByNumber", ["0x64", false]],
    ]);
    assert.equal(dataset.coverage.transfers, "partial", "recovery cannot restore the missing transfer receipts");
    assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.status, "complete");
    assert.equal(dataset.evidence.find((item) => item.kind === "funding")?.amountRaw, "1000");
    assert.equal(indexedCalls, fundingSource === "sqd" ? 1 : 0);
    assert.ok(f.calls.length + indexedCalls <= 30, "every handshake, source page and proof read consumes actual capacity");
    assert.deepEqual(f.calls.at(-1), { endpoint: 2, method: "eth_getBlockByNumber", params: ["0x64", false] }, "the independent final canonical recheck remains reserved");
    assert.match(dataset.coverage.warnings.join(" "), /funding phase recovered a transfer-phase RPC throttle/);
    assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: `phase-boundary-${fundingSource}-fixture`, generatedAt: "2026-10-12T00:00:00.000Z" }));
  }
});

test("verified funding-boundary RPC recovery unlocks deferred observed-holder balances without index rediscovery", async () => {
  const f = transferCeilingThrottleFixture(); const rpc = f.dependencies.rpc;
  const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  let indexReads = 0, balanceReads = 0;
  f.dependencies.holderPage = async () => { indexReads++; throw new Error("Prior RPC throttling must defer holder discovery, not rediscover it after recovery."); };
  f.dependencies.rpc = async (method, params) => {
    const result = await rpc(method, params);
    if (method === "eth_call" && (params[0] as { data: string }).data === encodeFunctionData({ abi: balanceAbi, functionName: "balanceOf", args: [wallet] })) {
      balanceReads++;
      assert.equal(f.recoveries(), 2, "balance reads need the verified funding-phase fallback");
      assert.equal(params[1], "0x64");
      return encodeFunctionResult({ abi: balanceAbi, functionName: "balanceOf", result: 37n });
    }
    return result;
  };
  const dataset = await collectBaseInvestigation(parameters, f.dependencies);
  assert.equal(f.fundingStartedAt(), 15);
  assert.equal(indexReads, 0);
  assert.equal(balanceReads, 1);
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.status, "complete");
  assert.equal(dataset.holderSnapshot?.discovery.status, "not_examined");
  assert.equal(dataset.holderSnapshot?.discovery.pages, 0);
  assert.equal(dataset.holderSnapshot?.balances.status, "complete");
  assert.deepEqual(dataset.holderSnapshot?.holders.map((item) => [item.address, item.status, item.balanceRaw]), [[wallet, "verified", "37"]]);
  assert.ok(f.calls.length <= 30);
  assert.deepEqual(f.calls.at(-1), { endpoint: 2, method: "eth_getBlockByNumber", params: ["0x64", false] });
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "recovered-holder-boundary-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("funding-boundary recovery rejects wrong chain or pinned identity before any funding request", async () => {
  for (const conflict of ["chain", "hash", "timestamp"] as const) {
    const f = transferCeilingThrottleFixture(); const rpc = f.dependencies.rpc;
    f.dependencies.rpc = async (method, params) => {
      const result = await rpc(method, params);
      if (f.recoveries() < 2) return result;
      if (conflict === "chain" && method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") return { ...result as object, ...(conflict === "hash" ? { hash: hash("ee") } : { timestamp: "0x1" }) };
      return result;
    };
    await assert.rejects(collectBaseInvestigation(parameters, f.dependencies), ProviderIntegrityError);
    assert.equal(f.recoveries(), 2);
    assert.ok(f.calls.filter((call) => call.endpoint === 2).every((call) => call.method === "eth_chainId" || call.method === "eth_getBlockByNumber" && call.params[1] === false));
    assert.equal(f.calls.filter((call) => call.endpoint === 2 && call.method === "eth_getTransactionReceipt").length, 0);
  }
});

test("funding-boundary cancellation and unknown defects stay terminal without querying funding", async () => {
  for (const failure of ["cancel", "unknown"] as const) {
    const f = transferCeilingThrottleFixture(); const rpc = f.dependencies.rpc;
    const parent = new AbortController(), reason = new Error(`Synthetic funding boundary ${failure}`);
    f.dependencies.signal = parent.signal;
    f.dependencies.rpc = async (method, params) => {
      const result = await rpc(method, params);
      if (f.recoveries() === 2 && method === "eth_chainId") {
        if (failure === "cancel") parent.abort(reason);
        else throw reason;
      }
      return result;
    };
    await assert.rejects(collectBaseInvestigation(parameters, f.dependencies), (error: unknown) => error === reason);
    assert.equal(f.recoveries(), 2);
    assert.deepEqual(f.calls.filter((call) => call.endpoint === 2).map((call) => call.method), ["eth_chainId"]);
  }
});

test("an exhausted fallback list leaves funding explicitly unexamined without a same-source boundary probe", async () => {
  const f = transferCeilingThrottleFixture(false);
  const dataset = await collectBaseInvestigation(parameters, f.dependencies);
  assert.equal(f.fundingStartedAt(), 15);
  assert.equal(f.recoveries(), 2, "one successful earlier switch and one no-network unavailable-alternative check");
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.status, "not_examined");
  assert.equal(dataset.evidence.some((item) => item.kind === "funding"), false);
  assert.equal(f.calls.length, 16, "only the mandatory final canonical read can follow the transfer throttle");
  assert.deepEqual(f.calls.at(-1), { endpoint: 1, method: "eth_getBlockByNumber", params: ["0x64", false] });
});

test("a public method refusal uses only an explicitly configured verified alternative", async () => {
  for (const failure of [new UpstreamFailure(false, { httpStatus: 403 }), new UpstreamFailure(false, { rpcCode: -32601 })]) {
    const source = fixture(); let endpoint = 0; let deniedCalls = 0;
    const rpc = async (method: string, params: unknown[]) => {
      if (endpoint === 0 && method === "eth_getCode" && params[0] === token) { deniedCalls++; throw failure; }
      return source.rpc(method, params);
    };
    await assert.rejects(collectBaseInvestigation(parameters, { ...source, rpc }), (error: unknown) => error === failure);
    deniedCalls = 0;
    const dataset = await collectBaseInvestigation(parameters, { ...source, rpc, recoverRpc: () => endpoint === 0 ? (endpoint++, true) : false });
    assert.equal(deniedCalls, 1, "forbidden reads are never retried on the denying endpoint");
    assert.equal(dataset.coverage.transfers, "complete");
    assert.ok(dataset.evidence.some((item) => item.kind === "funding"));
    assert.match(dataset.coverage.warnings.join(" "), /verifying Base chain identity/);
  }
});

test("SQD discovery searches the full pinned funding range and retains only RPC-verified candidates", async () => {
  const source = fixture(); let fullBlockReads = 0; let indexedReads = 0; let discoveryReads = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source, limits: { nativeFundingMaxBlocks: 1 },
    fundingHistory: async () => { indexedReads++; throw new Error("The other funding indexer must not run."); },
    sqdFundingPage: async (query) => {
      discoveryReads++;
      assert.equal(query.fromBlock, "99"); assert.equal(query.toBlock, "100");
      assert.ok(query.wallets.includes(wallet));
      return { blocks: [
        { header: { number: "99", hash: block99, parentHash: blockHash(98), timestamp: 198 }, transactions: [{ hash: fundingHash, from: funder, to: wallet, value: "1000", transactionIndex: 1, status: 1 }] },
        { header: { number: "100", hash: block100, parentHash: block99, timestamp: 200 }, transactions: [] },
      ] };
    },
    rpc: async (method, params) => { if (method === "eth_getBlockByNumber" && params[1] === true) fullBlockReads++; return source.rpc(method, params); },
  });
  assert.equal(discoveryReads, 1);
  assert.equal(indexedReads, 0);
  assert.equal(fullBlockReads, 0, "recipient discovery does not download all block transactions");
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.toBlock, "100");
  assert.equal(dataset.coverage.funding.find((item) => item.wallet === wallet)?.status, "complete");
  assert.equal(dataset.evidence.find((item) => item.kind === "funding")?.amountRaw, "1000");
  assert.match(dataset.coverage.warnings.join(" "), /does not independently exclude indexer omissions/);
  assert.doesNotThrow(() => analyzeInvestigation(dataset, { id: "sqd-funding-orchestration-fixture", generatedAt: "2026-10-12T00:00:00.000Z" }));
});

test("SQD availability failure before any verified page falls back to bounded native search", async () => {
  const source = fixture({ missingFunding: true }); let queryReads = 0; let fullBlockReads = 0;
  const dataset = await collectBaseInvestigation(parameters, { ...source,
    sqdFundingPage: async () => { queryReads++; throw new UpstreamFailure(); },
    rpc: async (method, params) => { if (method === "eth_getBlockByNumber" && params[1] === true) fullBlockReads++; return source.rpc(method, params); },
  });
  assert.equal(queryReads, 1);
  assert.ok(fullBlockReads > 0);
  assert.equal(dataset.evidence.find((item) => item.kind === "funding")?.amountRaw, "1000");
  assert.match(dataset.coverage.warnings.join(" "), /bounded native RPC prefix is used/);
});

test("provider configuration rejects arbitrary/private endpoints and invalid budgets", () => {
  assert.throws(() => readProviderConfiguration({}), /BASE_RPC_URL/);
  for (const endpoint of ["http://mainnet.base.org", "https://127.0.0.1", "https://mainnet.base.org.evil.example", "https://secret:password@mainnet.base.org", "file:///etc/passwd"]) assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: endpoint }));
  assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org", BASE_RPC_CALL_BUDGET: "2001" }));
  assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org", BASE_NATIVE_FUNDING_MAX_BLOCKS: "257" }));
  assert.equal(readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org" }).limits.nativeFundingMaxBlocks, 32);
  assert.equal(readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org" }).blockscoutApiKey, null);
  assert.equal(readProviderConfiguration({ NODE_ENV: "test", BASE_RPC_URL: "http://127.0.0.1:8545" }).allowLocalTests, true);
  for (const value of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.0.1", "::1", "fc00::1", "::ffff:127.0.0.1"]) assert.equal(isPublicAddress(value), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("transport bounds streamed response size and rejects malformed JSON", async () => {
  await assert.rejects(boundedJson(new Response("x".repeat(100)), 50), UpstreamFailure);
  await assert.rejects(boundedJson(new Response("not-json")), ProviderIntegrityError);
  await assert.rejects(boundedJson(new Response("{}", { status: 429 })), UpstreamFailure);
});

test("transport uses a fixed history origin and header authentication without exposing provider secrets", async () => {
  const key = "proapi_fixture_secret";
  const configuration = readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org", BLOCKSCOUT_API_KEY: key });
  let requestedUrl = "";
  let authorization = "";
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url); authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ items: [{ hash: fundingHash, block_number: 99 }], next_page_params: null }), { headers: { "content-type": "application/json" } });
  });
  try {
    const transport = createProviderTransport(configuration);
    const page = await transport.fundingHistory!(wallet, null, { fromBlock: "99", toBlock: "100" });
    assert.equal(page.items[0].blockNumber, "99");
    assert.equal(new URL(requestedUrl).origin, "https://api.blockscout.com");
    assert.equal(new URL(requestedUrl).searchParams.get("filter"), "to");
    assert.equal(authorization, `Bearer ${key}`);
    assert.ok(!requestedUrl.includes(key));
    await assert.rejects(transport.fundingHistory!(wallet, { redirect: "https://127.0.0.1" }, { fromBlock: "99", toBlock: "100" }), UpstreamFailure);
  } finally { mocked.mock.restore(); }
});

test("request deadlines stay active through streamed bodies and clear after completion", async () => {
  const configuration = { ...readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org" }), timeoutMs: 15 };
  let requestSignal: AbortSignal | undefined;
  let stallBody = true;
  const mocked = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    if (!stallBody) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x2105" }));
    return new Response(new ReadableStream({ start(controller) {
      requestSignal!.addEventListener("abort", () => controller.error(requestSignal!.reason), { once: true });
    } }));
  });
  try {
    const transport = createProviderTransport(configuration);
    await assert.rejects(transport.rpc("eth_chainId", []), (error: unknown) => error instanceof UpstreamFailure && error.retryable);
    assert.equal(requestSignal?.aborted, true);
    stallBody = false;
    assert.equal(await transport.rpc("eth_chainId", []), "0x2105");
    const completedSignal = requestSignal!;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(completedSignal.aborted, false, "completed requests must clear the timer");
  } finally { mocked.mock.restore(); }
});

test("outer cancellation reaches provider requests and preserves the caller reason", async () => {
  const configuration = readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org" });
  const parent = new AbortController();
  const reason = new Error("Synthetic scan cancellation");
  let requestSignal: AbortSignal | undefined;
  const mocked = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true }));
  });
  try {
    const pending = createProviderTransport(configuration, parent.signal).rpc("eth_chainId", []);
    parent.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(requestSignal?.reason, reason);
  } finally { mocked.mock.restore(); }
});
