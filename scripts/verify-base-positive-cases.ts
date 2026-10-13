import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { decodeAbiParameters, decodeEventLog, encodeFunctionData, keccak256, parseAbi, toBytes, type Hex } from "viem";
import { z } from "zod";
import { analyzeInvestigation } from "../src/domain/investigations/analyze";
import type { Address, EvidenceRecord, InvestigationDataset } from "../src/domain/investigations/types";
import { createDeadline } from "../src/lib/deadline";
import { readProviderConfiguration } from "../src/providers/base/config";
import { BASE_V3_FACTORY, BASE_V3_ROUTERS, SWAP_TOPIC, TRANSFER_TOPIC, UpstreamFailure, collectBaseInvestigation } from "../src/providers/base/core";
import { createProviderTransport, validateProviderDestination } from "../src/providers/base/transport";
import { collectNativeFundingPrefix } from "../src/providers/base/native-funding";

// These identities come from official Uniswap, Circle, and Coinbase documentation.
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const V2_SWAP = keccak256(toBytes("Swap(address,uint256,uint256,uint256,uint256,address)"));
const abi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function factory() view returns (address)", "function token0() view returns (address)",
  "function token1() view returns (address)", "function fee() view returns (uint24)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v.toLowerCase() as Address);
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform((v) => v.toLowerCase() as Hex);
const identity = { blockNumber: quantity, blockHash: hash, transactionHash: hash, transactionIndex: quantity };
const logSchema = z.object({ ...identity, address, logIndex: quantity, topics: z.array(hash), data: bytes, removed: z.boolean().optional() });
const receiptSchema = z.object({ ...identity, status: quantity, from: address, to: address.nullable(), logs: z.array(logSchema) });
const txSchema = z.object({ hash, blockNumber: quantity, blockHash: hash, transactionIndex: quantity, from: address, to: address.nullable(), value: quantity, input: bytes });
const blockSchema = z.object({ number: quantity, hash, timestamp: quantity, transactions: z.array(z.union([hash, txSchema])) });
type Receipt = z.infer<typeof receiptSchema>;
type Transaction = z.infer<typeof txSchema>;
type Log = z.infer<typeof logSchema>;
type Block = z.infer<typeof blockSchema>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const numberHex = (value: bigint) => `0x${value.toString(16)}`;
const decimal = (value: string) => BigInt(value).toString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const codeFor = (error: unknown) => error instanceof UpstreamFailure ? `UPSTREAM_${error.httpStatus ?? error.rpcCode ?? "UNKNOWN"}` : error instanceof assert.AssertionError ? "EVIDENCE_DISAGREEMENT" : error instanceof Error && error.name === "TimeoutError" ? "DEADLINE" : "VERIFICATION_FAILED";

async function replayClassification(path: string) {
  const startedAt = new Date().toISOString(), started = performance.now();
  const sourceBytes = await readFile(path), source = JSON.parse(sourceBytes.toString("utf8"));
  assert.equal(source.status, "both_positive_transactions_verified_and_crosschecked");
  const selected = z.object({ tx: txSchema, receipt: receiptSchema, block: blockSchema, token: address, pool: address, tokenAmount: z.string(), quoteAmount: z.string() }).parse(source.sale);
  const archive = z.array(z.object({ method: z.string(), params: z.array(z.unknown()), result: z.unknown().optional(), sha256: z.string().optional() })).parse(source.archive);
  for (const entry of archive) if (entry.sha256) assert.equal(digest(entry.result), entry.sha256);
  for (const head of [source.primaryFinalized, source.secondaryFinalized]) assert(BigInt(blockSchema.parse(head).number) >= BigInt(selected.block.number));
  const scope = "OFFLINE CLASSIFICATION REPLAY ONLY: the finalized tag resolves to a previously two-source-verified historical block, and eth_getLogs is a derived view of one actual receipt. This is not live acquisition, complete block/token history, or a fresh finalized-head query.";
  const calls: { method: string; params: unknown[]; source: string }[] = [];
  const rpc: Rpc = async (method, params) => {
    if (calls.length >= 100) throw new Error("REPLAY_BUDGET");
    if (method === "eth_getBlockByNumber" && params[0] === "finalized") {
      calls.push({ method, params, source: "Explicit historical tag resolution; retained real block payload" }); return selected.block;
    }
    if (method === "eth_getLogs") {
      const query = params[0] as { address: string; fromBlock: string; toBlock: string; topics: string[] };
      assert.equal(query.address, selected.token); assert.equal(BigInt(query.fromBlock), BigInt(selected.block.number)); assert.equal(BigInt(query.toBlock), BigInt(selected.block.number)); assert.equal(query.topics[0], TRANSFER_TOPIC);
      calls.push({ method, params, source: "Derived selected-receipt token Transfer view; completeness intentionally unknown" });
      return selected.receipt.logs.filter((log) => log.address === selected.token && log.topics[0] === TRANSFER_TOPIC);
    }
    const entry = archive.find((entry) => entry.method === method && JSON.stringify(entry.params) === JSON.stringify(params) && entry.sha256);
    calls.push({ method, params, source: entry ? `Retained raw response sha256:${entry.sha256}` : "Not retained; explicit availability failure" });
    if (!entry) throw new UpstreamFailure();
    return entry.result;
  };
  const collected = await collectBaseInvestigation({ token: selected.token, lookbackBlocks: 1 }, {
    rpc, fundingHistory: async () => { throw new UpstreamFailure(); }, now: () => new Date(source.startedAt), limits: { callBudget: 100, logChunkSize: 10, maxTransferLogs: 50 },
  });
  const sales = collected.evidence.filter((event) => event.kind === "sale");
  assert.equal(sales.length, 1); assert.equal(sales[0].transactionHash, selected.tx.hash); assert.equal(sales[0].amountRaw, selected.tokenAmount); assert.equal(sales[0].sale!.quoteAmountRaw, selected.quoteAmount);
  assert(collected.pools.includes(selected.pool));
  // The injected receipt view cannot establish complete range coverage, regardless of the collector's normal success state.
  const dataset = { ...collected, coverage: { ...collected.coverage, transfers: "partial" as const, warnings: [scope, ...collected.coverage.warnings] } };
  const report = analyzeInvestigation(dataset, { id: randomUUID(), generatedAt: startedAt });
  assert.equal(report.wallets.find((wallet) => wallet.address === selected.tx.from)?.verifiedSoldRaw, selected.tokenAmount);
  const output = `.artifacts/base-classification-replay-${startedAt.replaceAll(/[:.]/g, "-")}.json`;
  const result = { schemaVersion: 1, status: "production_classification_positive_receipt_replay_passed", startedAt, elapsedMs: Math.round(performance.now() - started), scope, networkCalls: 0, sourceArtifact: path, sourceArtifactSha256: createHash("sha256").update(sourceBytes).digest("hex"), collectorReportedTransferCoverageInInjectedView: collected.coverage.transfers, calls, dataset, report };
  await mkdir(".artifacts", { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ artifact: output, status: result.status, networkCalls: 0, replayCalls: calls.length, elapsedMs: result.elapsedMs, verifiedSale: selected.tx.hash }));
}

async function main() {
  if (process.argv.includes("--help")) { console.log("Read-only Base verification, <=200 RPC calls/120 seconds. Options: --public, --funding-only, --blocks=100 (1..1000), --sale=0xHASH --expect-rejection --funding=0xHASH. Offline-only --replay=ARTIFACT replays production classification of one retained receipt, not full acquisition. No AI, DB, signing, or lifetime-history claim."); return; }
  const replay = process.argv.find((value) => value.startsWith("--replay="))?.slice(9);
  if (replay) { await replayClassification(replay); return; }
  config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
  const blocks = z.coerce.number().int().min(1).max(1000).parse(process.argv.find((v) => v.startsWith("--blocks="))?.slice(9) ?? 100);
  const suppliedSale = process.argv.find((v) => v.startsWith("--sale="))?.slice(7);
  const suppliedFunding = process.argv.find((v) => v.startsWith("--funding="))?.slice(10);
  const fundingOnly = process.argv.includes("--funding-only");
  const expectRejection = process.argv.includes("--expect-rejection");
  if (expectRejection) assert(suppliedSale, "Expected rejection requires an explicit selected transaction.");
  if (suppliedSale) hash.parse(suppliedSale); if (suppliedFunding) hash.parse(suppliedFunding);
  const startedAt = new Date().toISOString(); const started = performance.now();
  const deadline = createDeadline(120_000); let calls = 0;
  let nextRequest = performance.now();
  const archive: { source: string; method: string; params: unknown[]; observedAt: string; result?: unknown; sha256?: string; errorCode?: string }[] = [];
  const rejected: Record<string, number> = {};
  const artifact: Record<string, unknown> = { schemaVersion: 1, startedAt, scope: "Independent transaction proof; not production collector replay or a precision benchmark", budgets: { rpcCalls: 200, deadlineMs: 120000 }, sourceIndependence: "Different endpoint hostnames may share infrastructure.", selection: { blocks, suppliedSale: suppliedSale ?? null, suppliedFunding: suppliedFunding ?? null, expectRejection }, rejected, archive };
  const configuration = readProviderConfiguration({ ...process.env, BASE_RPC_URL: process.argv.includes("--public") ? "https://mainnet.base.org" : process.env.BASE_RPC_URL ?? "https://base.drpc.org", BASE_RPC_FALLBACK_URLS: "", BASE_LOG_RPC_URL: "", BASE_FUNDING_SOURCE: "rpc", BLOCKSCOUT_API_KEY: "", BASE_PROVIDER_TIMEOUT_MS: "6000" });
  const secondaryConfiguration = readProviderConfiguration({ ...process.env, BASE_RPC_URL: new URL(configuration.rpcUrl).hostname === "mainnet.base.org" ? "https://base.drpc.org" : "https://mainnet.base.org", BASE_RPC_FALLBACK_URLS: "", BASE_LOG_RPC_URL: "", BASE_FUNDING_SOURCE: "rpc", BLOCKSCOUT_API_KEY: "", BASE_PROVIDER_TIMEOUT_MS: "6000" });
  async function reader(label: string, settings: typeof configuration): Promise<Rpc> {
    await validateProviderDestination(settings);
    const transport = createProviderTransport(settings, deadline.signal);
    return async (method, params) => {
      deadline.signal.throwIfAborted(); if (calls >= 200) throw new Error("RPC_BUDGET");
      const requestAt = Math.max(performance.now(), nextRequest); nextRequest = requestAt + 450;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, requestAt - performance.now())));
      deadline.signal.throwIfAborted();
      calls++;
      const entry: (typeof archive)[number] = { source: label, method, params, observedAt: new Date().toISOString() }; archive.push(entry);
      try { const result = await transport.rpc(method, params); entry.result = result; entry.sha256 = digest(result); return result; }
      catch (error) { entry.errorCode = codeFor(error); throw error; }
    };
  }
  async function getBlock(rpc: Rpc, tag: string, full = false) { const block = blockSchema.parse(await rpc("eth_getBlockByNumber", [tag, full])); if (tag.startsWith("0x")) assert.equal(BigInt(block.number), BigInt(tag)); return block; }
  async function transaction(rpc: Rpc, transactionHash: string) {
    const tx = txSchema.parse(await rpc("eth_getTransactionByHash", [transactionHash])); assert.equal(tx.hash, transactionHash.toLowerCase()); return tx;
  }
  async function receipt(rpc: Rpc, transactionHash: string) {
    const value = receiptSchema.parse(await rpc("eth_getTransactionReceipt", [transactionHash])); assert.equal(value.transactionHash, transactionHash.toLowerCase());
    const seen = new Set<string>();
    for (const log of value.logs) { assert.equal(log.removed ?? false, false); for (const key of ["blockNumber", "blockHash", "transactionHash", "transactionIndex"] as const) assert.equal(log[key], value[key]); assert(!seen.has(log.logIndex)); seen.add(log.logIndex); }
    return value;
  }
  async function call(rpc: Rpc, to: Address, name: "getPool" | "factory" | "token0" | "token1" | "fee", args: readonly unknown[], block: string) {
    const data = encodeFunctionData({ abi, functionName: name, args: args as never });
    const result = bytes.parse(await rpc("eth_call", [{ to, data }, block]));
    return name === "fee" ? decodeAbiParameters([{ type: "uint24" }], result)[0] : address.parse(decodeAbiParameters([{ type: "address" }], result)[0]);
  }
  async function authenticate(rpc: Rpc, pool: Address, block: string) {
    const [factory, token0, token1, fee] = await Promise.all([call(rpc, pool, "factory", [], block), call(rpc, pool, "token0", [], block), call(rpc, pool, "token1", [], block), call(rpc, pool, "fee", [], block)]);
    assert.equal(factory, BASE_V3_FACTORY); assert.equal(typeof token0, "string"); assert.equal(typeof token1, "string"); assert.equal(typeof fee, "number");
    assert.equal(await call(rpc, BASE_V3_FACTORY, "getPool", [token0, token1, fee], block), pool);
    return { factory: factory as Address, token0: token0 as Address, token1: token1 as Address, fee: fee as number };
  }
  function flows(value: Receipt) {
    return value.logs.filter((log) => log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3 && /^0x[0-9a-f]{64}$/.test(log.data) && log.topics.slice(1).every((topic) => /^0x0{24}[0-9a-f]{40}$/.test(topic))).map((log) => ({ log, asset: log.address, from: address.parse(`0x${log.topics[1].slice(-40)}`), to: address.parse(`0x${log.topics[2].slice(-40)}`), amount: BigInt(log.data) }));
  }
  function identityMatches(tx: Transaction, value: Receipt, block: Block) {
    assert.equal(value.status, "0x1"); assert.equal(tx.hash, value.transactionHash); assert.equal(tx.blockHash, value.blockHash); assert.equal(tx.blockNumber, value.blockNumber); assert.equal(tx.transactionIndex, value.transactionIndex); assert.equal(tx.from, value.from); assert.equal(tx.to, value.to); assert.equal(block.hash, tx.blockHash); assert.equal(block.number, tx.blockNumber);
    assert(block.transactions.some((item) => typeof item === "string" ? item === tx.hash : item.hash === tx.hash));
  }
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  try {
    const primary = await reader("configured-primary", configuration); const secondary = await reader("secondary-public-base", secondaryConfiguration);
    artifact.sources = [{ label: "configured-primary", publicHostname: new URL(configuration.rpcUrl).hostname }, { label: "secondary-public-base", publicHostname: new URL(secondaryConfiguration.rpcUrl).hostname }];
    assert.equal(BigInt(String(await primary("eth_chainId", []))), 8453n); assert.equal(BigInt(String(await secondary("eth_chainId", []))), 8453n);
    const finalized = await getBlock(primary, "finalized"); const end = BigInt(finalized.number); artifact.primaryFinalized = finalized;
    const candidates: string[] = suppliedSale ? [suppliedSale.toLowerCase()] : [];
    if (!suppliedSale && !fundingOnly) {
      const pools: Address[] = [];
      const logBlocks = new Map<string, Set<string>>();
      for (const token of [CBBTC, WETH]) for (const fee of [500, 3000, 100]) { const pool = await call(primary, BASE_V3_FACTORY, "getPool", [token, USDC, fee], finalized.number); if (pool !== ZERO) pools.push(pool as Address); }
      artifact.discoveryPools = pools;
      // Small contiguous chunks avoid treating a provider's range limit as empty data.
      for (let offset = 0; offset < blocks && logBlocks.size < 50; offset += 10) {
        const to = end - BigInt(offset); const from = to - BigInt(Math.min(10, blocks - offset)) + 1n;
        try {
          const logs = z.array(logSchema).max(2000).parse(await primary("eth_getLogs", [{ address: pools, topics: [SWAP_TOPIC, BASE_V3_ROUTERS.map((router) => `0x${router.slice(2).padStart(64, "0")}`)], fromBlock: numberHex(from), toBlock: numberHex(to) }]));
          for (const log of logs) {
            assert(!log.removed); assert(BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to);
            const hashes = logBlocks.get(log.blockNumber) ?? new Set<string>(); hashes.add(log.transactionHash); logBlocks.set(log.blockNumber, hashes);
          }
        } catch (error) { reject(codeFor(error)); if (deadline.signal.aborted) throw error; }
      }
      // Inspect block transactions first: many aggregator contracts call a known
      // router internally, which does not satisfy the collector's top-level scope.
      for (const [blockNumber, hashes] of [...logBlocks].sort(([a], [b]) => BigInt(a) > BigInt(b) ? -1 : 1).slice(0, 50)) {
        if (calls >= 110 || performance.now() - started > 65_000) break;
        const block = await getBlock(primary, blockNumber, true);
        for (const tx of block.transactions) if (typeof tx !== "string" && hashes.has(tx.hash)) {
          if (BASE_V3_ROUTERS.includes(tx.to as Address)) { if (!candidates.includes(tx.hash)) candidates.push(tx.hash); }
          else reject("UNSUPPORTED_TOP_LEVEL_ROUTER_DISCOVERY");
        }
        if (candidates.length >= 15) break;
      }
    }
    artifact.candidates = candidates;
    let sale: { tx: Transaction; receipt: Receipt; block: Block; swap: Log; pool: Address; token: Address; quote: Address; tokenAmount: string; quoteAmount: string; authentication: Awaited<ReturnType<typeof authenticate>> } | null = null;
    for (const candidate of candidates.slice(0, 60)) {
      if (calls >= 155 || performance.now() - started > 90_000) break;
      const value = await receipt(primary, candidate); if (value.status !== "0x1") { reject("FAILED_TRANSACTION"); continue; }
      const swaps = value.logs.filter((log) => log.topics[0] === SWAP_TOPIC);
      if (swaps.length !== 1 || value.logs.some((log) => log.topics[0] === V2_SWAP)) { reject("MULTIPLE_OR_MIXED_SWAPS"); continue; }
      const tx = await transaction(primary, candidate); const swap = swaps[0];
      if (tx.to !== swap.address && !BASE_V3_ROUTERS.includes(tx.to as Address)) { reject("UNSUPPORTED_ROUTER"); continue; }
      if (bytes.parse(await primary("eth_getCode", [tx.from, tx.blockNumber])) !== "0x") { reject("CONTRACT_SENDER"); continue; }
      const auth = await authenticate(primary, swap.address, tx.blockNumber);
      const decoded = decodeEventLog({ abi, eventName: "Swap", topics: swap.topics as [Hex, ...Hex[]], data: swap.data });
      const { amount0, amount1 } = decoded.args;
      if (!((amount0 > 0n && amount1 < 0n) || (amount1 > 0n && amount0 < 0n))) { reject("UNSUPPORTED_DELTAS"); continue; }
      const token = amount0 > 0n ? auth.token0 : auth.token1; const quote = amount0 > 0n ? auth.token1 : auth.token0;
      const tokenAmount = amount0 > 0n ? amount0 : amount1; const quoteAmount = -(amount0 > 0n ? amount1 : amount0);
      const relevant = flows(value).filter((flow) => flow.asset === token || flow.asset === quote);
      const net = (asset: Address, wallet: Address) => relevant.filter((flow) => flow.asset === asset).reduce((total, flow) => total + (flow.to === wallet ? flow.amount : 0n) - (flow.from === wallet ? flow.amount : 0n), 0n);
      const direct = (asset: Address, from: Address, to: Address) => relevant.filter((flow) => flow.asset === asset && flow.from === from && flow.to === to).reduce((total, flow) => total + flow.amount, 0n);
      if (net(token, tx.from) !== -tokenAmount || net(quote, tx.from) !== quoteAmount || net(token, swap.address) !== tokenAmount || net(quote, swap.address) !== -quoteAmount || direct(token, tx.from, swap.address) !== tokenAmount || direct(quote, swap.address, tx.from) !== quoteAmount) { reject("UNSUPPORTED_CONSIDERATION_PATH"); continue; }
      const block = await getBlock(primary, tx.blockNumber); identityMatches(tx, value, block); assert(BigInt(block.number) <= end);
      sale = { tx, receipt: value, block, swap, pool: swap.address, token, quote, tokenAmount: tokenAmount.toString(), quoteAmount: quoteAmount.toString(), authentication: auth }; break;
    }
    let tokenCode: Hex | null = null;
    if (sale) { tokenCode = bytes.parse(await primary("eth_getCode", [sale.token, sale.tx.blockNumber])); assert.notEqual(tokenCode, "0x"); }
    artifact.sale = sale;
    let negative: { tx: Transaction; receipt: Receipt; block: Block; rejectionReasons: string[] } | null = null;
    if (expectRejection) {
      assert.equal(sale, null, "The expected unsupported candidate was accepted.");
      const tx = await transaction(primary, suppliedSale!.toLowerCase()); const value = await receipt(primary, tx.hash); const block = await getBlock(primary, tx.blockNumber);
      identityMatches(tx, value, block); assert(BigInt(block.number) <= end); assert(Object.keys(rejected).length > 0);
      negative = { tx, receipt: value, block, rejectionReasons: Object.keys(rejected) }; artifact.negative = negative;
    }
    let funding: { tx: Transaction; receipt: Receipt; block: Block; observation: string } | null = null;
    const fundingCandidates: Transaction[] = suppliedFunding ? [await transaction(primary, suppliedFunding.toLowerCase())] : [];
    if (!suppliedFunding) {
      for (let offset = 0; offset < 5 && fundingCandidates.length === 0; offset++) {
        const block = await getBlock(primary, numberHex(end - BigInt(offset)), true);
        for (const tx of block.transactions) if (typeof tx !== "string" && tx.to && tx.to !== ZERO && tx.input === "0x" && BigInt(tx.value) > 0n) fundingCandidates.push(tx);
      }
    }
    for (const tx of fundingCandidates.slice(0, 10)) {
      if (!tx.to || tx.to === ZERO || tx.input !== "0x" || BigInt(tx.value) <= 0n) { reject("UNSUPPORTED_NATIVE_TRANSACTION"); continue; }
      const value = await receipt(primary, tx.hash); if (value.status !== "0x1") continue;
      if (bytes.parse(await primary("eth_getCode", [tx.to, tx.blockNumber])) !== "0x" || bytes.parse(await primary("eth_getCode", [tx.from, tx.blockNumber])) !== "0x") continue;
      const block = await getBlock(primary, tx.blockNumber); identityMatches(tx, value, block); assert(BigInt(block.number) <= end);
      funding = { tx, receipt: value, block, observation: "One successful top-level native ETH transfer. Not lifetime-first funding, complete wallet history, internal transfer coverage, or proof of common ownership." }; break;
    }
    artifact.funding = funding;
    if (funding) {
      const reference = { number: decimal(funding.block.number), hash: funding.block.hash, timestamp: Number(BigInt(funding.block.timestamp)) };
      const fallback = await collectNativeFundingPrefix({ wallets: [funding.tx.to!], from: reference, to: reference, maxBlocks: 1, observedAt: startedAt, request: primary, canonicalBlock: async (number, expectedHash) => {
        const block = await getBlock(primary, numberHex(BigInt(number))); assert.equal(block.hash, expectedHash);
        return { number: decimal(block.number), hash: block.hash, timestamp: Number(BigInt(block.timestamp)) };
      }, signal: deadline.signal });
      assert.equal(fallback.coverage[0].status, "complete");
      assert(fallback.evidence.some((record) => record.transactionHash === funding.tx.hash && record.amountRaw === decimal(funding.tx.value)));
      artifact.nativeFallbackResult = fallback;
    }
    const secondaryFinalized = await getBlock(secondary, "finalized"); artifact.secondaryFinalized = secondaryFinalized;
    const comparisons: unknown[] = [];
    for (const selected of [sale, funding, negative]) if (selected) {
      assert(BigInt(selected.block.number) <= BigInt(secondaryFinalized.number));
      const otherReceipt = await receipt(secondary, selected.tx.hash); const otherTx = await transaction(secondary, selected.tx.hash); const otherBlock = await getBlock(secondary, selected.block.number);
      identityMatches(otherTx, otherReceipt, otherBlock); assert.deepEqual(otherReceipt, selected.receipt); assert.deepEqual(otherTx, selected.tx); assert.equal(otherBlock.hash, selected.block.hash); assert.equal(otherBlock.timestamp, selected.block.timestamp);
      comparisons.push({ transactionHash: selected.tx.hash, status: "matched", checked: "successful receipt and every log; transaction fields; block number/hash/timestamp; finalized head covers transaction" });
    }
    if (sale) {
      assert.deepEqual(await authenticate(secondary, sale.pool, sale.tx.blockNumber), sale.authentication);
      assert.equal(bytes.parse(await secondary("eth_getCode", [sale.token, sale.tx.blockNumber])), tokenCode);
    }
    assert.equal((await getBlock(primary, finalized.number)).hash, finalized.hash);
    artifact.crosscheck = comparisons;
    if (sale) {
      const provenance = { provider: "independent-positive-case-verifier", method: "eth_getTransactionReceipt + eth_getTransactionByHash + eth_getBlockByNumber + eth_call", observedAt: startedAt };
      const common = { chainId: 8453 as const, blockNumber: decimal(sale.tx.blockNumber), blockHash: sale.tx.blockHash, transactionHash: sale.tx.hash, transactionIndex: Number(BigInt(sale.tx.transactionIndex)), traceId: null, timestamp: Number(BigInt(sale.block.timestamp)), provenance };
      const evidence: EvidenceRecord[] = flows(sale.receipt).filter((flow) => flow.asset === sale.token || flow.asset === sale.quote).map((flow) => ({ ...common, id: `8453:${sale.tx.blockHash}:${sale.tx.hash}:log:${BigInt(flow.log.logIndex)}`, kind: "transfer", logIndex: Number(BigInt(flow.log.logIndex)), from: flow.from, to: flow.to, assetAddress: flow.asset, amountRaw: flow.amount.toString(), sale: null }));
      const swapLogIndex = Number(BigInt(sale.swap.logIndex));
      evidence.push({ ...common, id: `8453:${sale.tx.blockHash}:${sale.tx.hash}:sale:${swapLogIndex}`, kind: "sale", logIndex: swapLogIndex, from: sale.tx.from, to: sale.pool, assetAddress: sale.token, amountRaw: sale.tokenAmount, sale: { pool: sale.pool, factory: BASE_V3_FACTORY, protocol: "uniswap-v3", quoteAsset: sale.quote, quoteAmountRaw: sale.quoteAmount, swapLogIndex, supportingEvidenceIds: evidence.map((item) => item.id).sort() } });
      const reference = { number: decimal(sale.block.number), hash: sale.block.hash, timestamp: Number(BigInt(sale.block.timestamp)) };
      const dataset: InvestigationDataset = { token: { address: sale.token, chainId: 8453, name: null, symbol: null, decimals: null, totalSupplyRaw: null }, range: { from: reference, to: reference, finality: "finalized" }, evidence, pools: [sale.pool], hubs: [...BASE_V3_ROUTERS], coverage: { transfers: "partial", funding: [], eligibleWallets: 0, examinedWallets: 0, warnings: ["Selected one receipt only; no complete token range or wallet funding history was acquired. Independent verifier, not production collector replay."] } };
      const report = analyzeInvestigation(dataset, { id: randomUUID(), generatedAt: new Date().toISOString() });
      assert.equal(report.wallets.find((wallet) => wallet.address === sale!.tx.from)?.verifiedSoldRaw, sale.tokenAmount);
      artifact.independentDataset = dataset; artifact.independentAnalyzerReport = report;
    }
    artifact.status = expectRejection && negative ? "selected_unsupported_transaction_verified_and_crosschecked" : sale && funding ? "both_positive_transactions_verified_and_crosschecked" : fundingOnly && funding ? "positive_native_fallback_verified_and_crosschecked" : "incomplete_positive_case_search";
  } catch (error) { artifact.status = "verification_failed_or_incomplete"; artifact.failureCode = codeFor(error); }
  finally {
    deadline.dispose(); artifact.rpcCalls = calls; artifact.elapsedMs = Math.round(performance.now() - started); artifact.completedAt = new Date().toISOString();
    await mkdir(".artifacts", { recursive: true });
    const path = `.artifacts/base-positive-${startedAt.replaceAll(/[:.]/g, "-")}.json`;
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(JSON.stringify({ artifact: path, status: artifact.status, rpcCalls: calls, elapsedMs: artifact.elapsedMs, rejected, sale: artifact.sale ? "found" : "not_found", funding: artifact.funding ? "found" : "not_found", failureCode: artifact.failureCode ?? null }));
    if (!["both_positive_transactions_verified_and_crosschecked", "positive_native_fallback_verified_and_crosschecked", "selected_unsupported_transaction_verified_and_crosschecked"].includes(String(artifact.status))) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (process.argv.some((argument) => argument.startsWith("--replay="))) console.error(JSON.stringify({ mode: "offline-receipt-replay", code: codeFor(error) }));
  else console.error("Verification setup failed; no provider URL or credentials are logged.");
  process.exitCode = 1;
});
