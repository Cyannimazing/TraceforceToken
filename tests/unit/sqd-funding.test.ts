import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hash } from "../../src/domain/investigations/types";
import { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "../../src/providers/base/errors";
import { collectSqdFundingWindow, createSqdFundingQuery, type SqdFundingBlock, type SqdFundingOptions, type SqdFundingPageQuery } from "../../src/providers/base/sqd-funding";

const address = (number: number) => `0x${number.toString(16).padStart(40, "0")}` as Address;
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}` as Hash;
const hex = (number: string | number) => `0x${BigInt(number).toString(16)}`;
const wallet = address(1), funder = address(2), other = address(3);
const observedAt = "2026-10-12T00:00:00.000Z";
const header = (number: number) => ({ number: String(number), hash: hash(number), parentHash: hash(number - 1), timestamp: 1000 + 2 * number });
const transaction = (block: number, to = wallet, value = "7", index = 2): SqdFundingBlock["transactions"][number] => ({ hash: hash(10_000 + 100 * block + index), from: funder, to, value, transactionIndex: index, status: 1 });
type RecordedCall = { method: string; params: unknown[] };
function fixture(settings: { from?: number; to?: number; wallets?: Address[]; txs?: Map<number, SqdFundingBlock["transactions"]>; pageSize?: number } = {}) {
  const first = settings.from ?? 100, last = settings.to ?? 102;
  const txs = settings.txs ?? new Map([[101, [transaction(101)]]]);
  const calls: RecordedCall[] = [], queries: Parameters<SqdFundingPageQuery>[0][] = [], anchors: string[] = [];
  const options: SqdFundingOptions = {
    wallets: settings.wallets ?? [wallet], from: header(first), to: header(last), observedAt,
    async queryPage(query) {
      queries.push(query);
      const end = Math.min(Number(query.toBlock), Number(query.fromBlock) + (settings.pageSize ?? 1000) - 1);
      return { blocks: Array.from({ length: end - Number(query.fromBlock) + 1 }, (_, index) => {
        const number = Number(query.fromBlock) + index;
        return { header: header(number), transactions: (txs.get(number) ?? []).filter((tx) => query.wallets.includes(tx.to!)) };
      }) };
    },
    async canonicalBlock(number, expectedHash) {
      anchors.push(number);
      assert.equal(expectedHash, hash(Number(number)));
      return header(Number(number));
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "eth_getCode") return "0x";
      for (const [number, transactions] of txs) {
        const tx = transactions.find((item) => item.hash === params[0]);
        if (!tx) continue;
        if (method === "eth_getTransactionByHash") return { ...tx, blockHash: hash(number), blockNumber: hex(number), value: hex(tx.value), transactionIndex: hex(tx.transactionIndex) };
        if (method === "eth_getTransactionReceipt") return { transactionHash: tx.hash, blockHash: hash(number), blockNumber: hex(number), transactionIndex: hex(tx.transactionIndex), status: hex(tx.status) };
      }
      throw new Error("Unexpected synthetic RPC request");
    },
  };
  return { options, calls, queries, anchors };
}

test("SQD search retains exact uint256 funding with candidate inclusion, receipt, code and timestamp proofs", async () => {
  const amount = (2n ** 256n - 1n).toString();
  const f = fixture({ txs: new Map([[101, [transaction(101, wallet, amount)]]]) });
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].amountRaw, amount);
  assert.equal(result.evidence[0].id, `8453:${hash(101)}:${transaction(101).hash}:native`);
  assert.equal(result.evidence[0].timestamp, header(101).timestamp);
  assert.deepEqual(f.anchors, ["100", "102", "101"]);
  assert.deepEqual(f.calls.map((call) => call.method), ["eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getCode", "eth_getCode"]);
  assert.equal(result.coverage[0].status, "complete");
  assert.equal(result.coverage[0].toBlock, "102");
  assert.match(result.coverage[0].reason!, /index omissions are not independently disproved/);
  assert.match(result.coverage[0].reason!, /internal transfers or lifetime-first funding/);
  assert.equal(result.examinedWallets, 1);
});

test("empty headers extend an indexed window beyond the native prefix without per-header RPC reads", async () => {
  const f = fixture({ from: 100, to: 1200, txs: new Map() });
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.completedBlocks, 1101);
  assert.equal(result.coverage[0].status, "complete");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.anchors, ["100", "1099", "1100", "1200"]);
  assert.deepEqual(f.queries.map((query) => [query.fromBlock, query.toBlock, query.parentBlockHash]), [["100", "1099", undefined], ["1100", "1200", hash(1099)]]);
});

test("short successful pages resume from the last header plus one, not the requested upper bound", async () => {
  const f = fixture({ pageSize: 1, txs: new Map() });
  const result = await collectSqdFundingWindow(f.options);
  assert.deepEqual(f.queries.map((query) => query.fromBlock), ["100", "101", "102"]);
  assert.equal(result.coverage[0].toBlock, "102");
  assert.equal(result.coverage[0].status, "complete");
});

test("all recipients remain eligible through 128-address batches with per-batch coverage", async () => {
  const wallets = Array.from({ length: 129 }, (_, index) => address(index + 10));
  const f = fixture({ wallets, txs: new Map([[101, [transaction(101, wallets[128])]]]) });
  const result = await collectSqdFundingWindow(f.options);
  assert.deepEqual(f.queries.map((query) => query.wallets.length), [128, 1]);
  assert.equal(result.coverage.length, 129);
  assert.equal(result.examinedWallets, 129);
  assert.equal(result.evidence[0].to, wallets[128]);
  assert.ok(result.coverage.every((item) => item.status === "complete"));
});

test("a failed later page keeps only the committed prefix and does not leak staged funding or contract exclusions", async () => {
  const f = fixture({ pageSize: 1, wallets: [wallet, other], txs: new Map([[100, [transaction(100)]], [101, [transaction(101), transaction(101, other, "8", 3)]]]) });
  const original = f.options.request;
  f.options.request = async (method, params) => {
    if (method === "eth_getTransactionReceipt" && params[0] === transaction(101, other, "8", 3).hash) throw new UpstreamFailure();
    return original(method, params);
  };
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].blockNumber, "100");
  assert.equal(result.completedBlocks, 1);
  assert.ok(result.coverage.every((item) => item.status === "partial" && item.toBlock === "100"));
});

test("a later candidate failure within one anchored page retains only fully verified earlier blocks", async () => {
  const f = fixture({ wallets: [wallet, other], txs: new Map([[100, [transaction(100)]], [101, [transaction(101), transaction(101, other, "8", 3)]]]) });
  const request = f.options.request;
  f.options.request = async (method, params) => {
    if (method === "eth_getTransactionReceipt" && params[0] === transaction(101, other, "8", 3).hash) throw new ProviderBudgetError();
    return request(method, params);
  };
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(f.queries.length, 1);
  assert.equal(result.completedBlocks, 1);
  assert.deepEqual(result.evidence.map((item) => item.blockNumber), ["100"]);
  assert.ok(result.coverage.every((item) => item.status === "partial" && item.toBlock === "100"));
});

test("failure in the first indexed block rolls back all of that block's funding records", async () => {
  const f = fixture({ wallets: [wallet, other], txs: new Map([[100, [transaction(100), transaction(100, other, "8", 3)]]]) });
  const request = f.options.request;
  f.options.request = async (method, params) => {
    if (method === "eth_getTransactionReceipt" && params[0] === transaction(100, other, "8", 3).hash) throw new UpstreamFailure();
    return request(method, params);
  };
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.completedBlocks, 0);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.examinedWallets, 0);
  assert.ok(result.coverage.every((item) => item.status === "unavailable"));
});

test("an EOF without reaching the exact end cannot complete the search, and page-end anchor failure commits nothing", async () => {
  const f = fixture({ pageSize: 1, txs: new Map() });
  const query = f.options.queryPage;
  f.options.queryPage = async (input) => input.fromBlock === "100" ? query(input) : { blocks: [] };
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.coverage[0].status, "partial");
  assert.equal(result.coverage[0].toBlock, "100");
  const failedAnchor = fixture();
  const canonical = failedAnchor.options.canonicalBlock;
  failedAnchor.options.canonicalBlock = async (number, expected) => { if (number === "102") throw new UpstreamFailure(); return canonical(number, expected); };
  const unavailable = await collectSqdFundingWindow(failedAnchor.options);
  assert.equal(unavailable.completedBlocks, 0);
  assert.equal(unavailable.evidence.length, 0);
  assert.equal(unavailable.coverage[0].status, "unavailable");
});

test("failure after a staged contract exclusion cannot change a wallet's previously committed search coverage", async () => {
  const f = fixture({ pageSize: 1, wallets: [wallet, other], txs: new Map([[101, [transaction(101), transaction(101, other, "8", 3)]]]) });
  const original = f.options.request;
  f.options.request = async (method, params) => {
    if (method === "eth_getCode" && params[0] === wallet) return "0x01";
    if (method === "eth_getTransactionReceipt" && params[0] === transaction(101, other, "8", 3).hash) throw new UpstreamFailure();
    return original(method, params);
  };
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.evidence.length, 0);
  assert.ok(result.coverage.every((item) => item.status === "partial" && item.toBlock === "100"));
  assert.equal(result.examinedWallets, 2);
});

test("first-page outage differs from an unreached budget or prior throttle and later batches stay unexamined", async () => {
  for (const [error, expected] of [[new UpstreamFailure(), "unavailable"], [new ProviderBudgetError(), "not_examined"]] as const) {
    const f = fixture({ wallets: Array.from({ length: 129 }, (_, index) => address(index + 10)) });
    let queries = 0;
    f.options.queryPage = async () => { queries++; throw error; };
    const result = await collectSqdFundingWindow(f.options);
    assert.equal(queries, 1);
    assert.ok(result.coverage.slice(0, 128).every((item) => item.status === expected));
    assert.equal(result.coverage[128].status, "not_examined");
    assert.equal(result.examinedWallets, 0);
  }
  const f = fixture();
  f.options.throttleError = () => new UpstreamFailure(true, { httpStatus: 429 });
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(f.queries.length, 0);
  assert.equal(result.coverage[0].status, "not_examined");
});

test("429 or 529 stops optional pressure while retaining an already verified prefix", async () => {
  for (const httpStatus of [429, 529]) {
    const f = fixture({ pageSize: 1, txs: new Map(), wallets: Array.from({ length: 129 }, (_, index) => address(index + 10)) });
    const original = f.options.queryPage;
    let attempts = 0;
    f.options.queryPage = async (query) => { if (++attempts === 2) throw new UpstreamFailure(true, { httpStatus }); return original(query); };
    const result = await collectSqdFundingWindow(f.options);
    assert.equal(attempts, 2);
    assert.equal(result.coverage[0].status, "partial");
    assert.equal(result.coverage[0].toBlock, "100");
    assert.match(result.coverage[0].reason!, /throttling/);
    assert.equal(result.coverage[128].status, "not_examined");
  }
});

test("contract recipients at pinned end are excluded; historical contract, failed and zero-value transactions are not funding", async () => {
  const f = fixture({ wallets: [wallet, other], txs: new Map([[101, [transaction(101), { ...transaction(101, other, "8", 3), status: 0 }, transaction(101, other, "0", 4)]]]) });
  const original = f.options.request;
  f.options.request = async (method, params) => method === "eth_getCode" && params[0] === wallet ? "0x01" : original(method, params);
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.evidence.length, 0);
  assert.equal(result.coverage.find((item) => item.wallet === wallet)?.status, "not_examined");
  assert.equal(result.coverage.find((item) => item.wallet === other)?.status, "complete");
  assert.equal(result.examinedWallets, 1);
  assert.equal(f.calls.filter((call) => call.method === "eth_getCode").length, 0); // Contract response came from override.
  const historical = fixture();
  const request = historical.options.request;
  historical.options.request = async (method, params) => method === "eth_getCode" && params[1] === "0x65" ? "0x01" : request(method, params);
  assert.equal((await collectSqdFundingWindow(historical.options)).evidence.length, 0);
});

test("recipient code cache is pinned by address and actual block identity", async () => {
  const f = fixture({ txs: new Map([[100, [transaction(100), transaction(100, wallet, "8", 3)]], [101, [transaction(101)]]]) });
  const result = await collectSqdFundingWindow(f.options);
  assert.equal(result.evidence.length, 3);
  assert.deepEqual(f.calls.filter((call) => call.method === "eth_getCode").map((call) => call.params[1]), ["0x66", "0x64", "0x65"]);
});

test("malformed/repeated/gapped headers, parent conflicts and pinned boundary mismatches fail closed", async () => {
  const mutations: ((blocks: SqdFundingBlock[]) => void)[] = [
    (blocks) => { blocks[1].header.number = "100"; },
    (blocks) => { blocks[1].header.parentHash = hash(999); },
    (blocks) => { blocks[0].header.hash = hash(999); },
    (blocks) => { blocks[2].header.hash = hash(999); },
    (blocks) => { blocks[1].header.timestamp = 1; },
    (blocks) => { blocks[1].header.number = "0101"; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); const original = f.options.queryPage;
    f.options.queryPage = async (query) => { const page = await original(query); mutate(page.blocks); return page; };
    await assert.rejects(collectSqdFundingWindow(f.options), ProviderIntegrityError);
  }
  const f = fixture({ pageSize: 1 }); const original = f.options.queryPage;
  f.options.queryPage = async (query) => { const page = await original(query); if (query.fromBlock === "101") page.blocks[0].header.parentHash = hash(999); return page; };
  await assert.rejects(collectSqdFundingWindow(f.options), ProviderIntegrityError);
  const batches = fixture({ wallets: Array.from({ length: 129 }, (_, index) => address(index + 10)), txs: new Map() });
  const query = batches.options.queryPage;
  batches.options.queryPage = async (input) => { const page = await query(input); if (input.wallets.length === 1) page.blocks[1].header.timestamp++; return page; };
  await assert.rejects(collectSqdFundingWindow(batches.options), ProviderIntegrityError);
});

test("candidate identity, amounts, recipient filters, duplicate hashes and RPC disagreements cannot become funding", async () => {
  for (const field of ["blockHash", "blockNumber", "transactionIndex", "from", "to", "value", "hash"] as const) {
    const f = fixture(); const request = f.options.request;
    f.options.request = async (method, params) => {
      const value = await request(method, params);
      return method === "eth_getTransactionByHash" ? { ...(value as object), [field]: field === "blockHash" || field === "hash" ? hash(999) : field === "from" || field === "to" ? other : "0x9" } : value;
    };
    await assert.rejects(collectSqdFundingWindow(f.options), ProviderIntegrityError);
  }
  for (const value of ["-1", (2n ** 256n).toString(), "01"]) {
    const f = fixture({ txs: new Map([[101, [transaction(101, wallet, value)]]]) });
    await assert.rejects(collectSqdFundingWindow(f.options), ProviderIntegrityError);
  }
  for (const mutate of [(blocks: SqdFundingBlock[]) => { blocks[1].transactions.push({ ...blocks[1].transactions[0], transactionIndex: 3 }); }, (blocks: SqdFundingBlock[]) => { blocks[1].transactions[0].to = other; }]) {
    const f = fixture(); const query = f.options.queryPage;
    f.options.queryPage = async (input) => { const page = await query(input); mutate(page.blocks); return page; };
    await assert.rejects(collectSqdFundingWindow(f.options), ProviderIntegrityError);
  }
  const f = fixture(); const request = f.options.request;
  f.options.request = async (method, params) => { const value = await request(method, params); return method === "eth_getTransactionReceipt" ? { ...(value as object), status: "0x0" } : value; };
  await assert.rejects(collectSqdFundingWindow(f.options), ProviderIntegrityError);
});

test("unknown failures, integrity failures and caller cancellation propagate rather than becoming partial success", async () => {
  for (const error of [new Error("Synthetic terminal defect"), new ProviderIntegrityError()]) {
    const f = fixture(); f.options.queryPage = async () => { throw error; };
    await assert.rejects(collectSqdFundingWindow(f.options), (actual) => actual === error);
  }
  const f = fixture(); const controller = new AbortController(), reason = new Error("Synthetic cancellation");
  const request = f.options.request;
  f.options.signal = controller.signal;
  f.options.request = async (method, params) => { const value = await request(method, params); controller.abort(reason); return value; };
  await assert.rejects(collectSqdFundingWindow(f.options), (actual) => actual === reason);
  assert.equal(f.calls.length, 1);
});

function wireBlock(number: number, txs: SqdFundingBlock["transactions"] = []) {
  return { header: { ...header(number), number }, ...(txs.length ? { transactions: txs.map((tx) => ({ ...tx, value: hex(tx.value) })) } : {}) };
}

test("fixed SQD transport bounds its request, decodes split JSONL exactly and normalizes omitted empty transactions", async (t) => {
  let captured = "";
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(url, "https://portal.sqd.dev/datasets/base-mainnet/finalized-stream");
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    captured = String(init.body);
    assert.ok(Buffer.byteLength(captured) <= 8192);
    const data = Buffer.from(`${JSON.stringify(wireBlock(100))}\n${JSON.stringify(wireBlock(101, [transaction(101, wallet, (2n ** 256n - 1n).toString())]))}`);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, 27)); controller.enqueue(data.subarray(27)); controller.close(); } }));
  });
  const page = await createSqdFundingQuery(1000)({ wallets: [wallet], fromBlock: "100", toBlock: "101", parentBlockHash: hash(99) });
  assert.deepEqual(page.blocks[0].transactions, []);
  assert.equal(page.blocks[1].transactions[0].value, (2n ** 256n - 1n).toString());
  const body = JSON.parse(captured) as { includeAllBlocks: boolean; transactions: { to: string[] }[]; parentBlockHash: string };
  assert.equal(body.includeAllBlocks, true); assert.deepEqual(body.transactions, [{ to: [wallet] }]); assert.equal(body.parentBlockHash, hash(99));
  await assert.rejects(createSqdFundingQuery(1000)({ wallets: Array.from({ length: 129 }, (_, i) => address(i + 1)), fromBlock: "100", toBlock: "101" }), ProviderIntegrityError);
  await assert.rejects(createSqdFundingQuery(1000)({ wallets: [wallet], fromBlock: "100", toBlock: "1100" }), ProviderIntegrityError);
});

test("transport rejects malformed JSONL, excessive headers/body and 204 or empty EOF without false completeness", async (t) => {
  let response = new Response("{invalid}\n");
  t.mock.method(globalThis, "fetch", async () => response);
  const query = () => createSqdFundingQuery(1000)({ wallets: [wallet], fromBlock: "100", toBlock: "102" });
  await assert.rejects(query(), ProviderIntegrityError);
  response = new Response(Array.from({ length: 1001 }, (_, i) => JSON.stringify(wireBlock(100 + i))).join("\n"));
  await assert.rejects(query(), ProviderIntegrityError);
  response = new Response("x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(query(), UpstreamFailure);
  response = new Response(null, { status: 204 });
  await assert.rejects(query(), (error) => error instanceof UpstreamFailure && error.httpStatus === 204);
  response = new Response("");
  await assert.rejects(query(), UpstreamFailure);
  response = new Response("", { status: 529 });
  await assert.rejects(query(), (error) => error instanceof UpstreamFailure && error.httpStatus === 529);
});

test("owned deadline covers hanging fetch and body reads and preserves explicit parent cancellation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(() => undefined));
  await assert.rejects(createSqdFundingQuery(20)({ wallets: [wallet], fromBlock: "100", toBlock: "102" }), (error) => error instanceof UpstreamFailure && error.retryable);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start() { /* Deliberately remains open. */ } })));
  await assert.rejects(createSqdFundingQuery(20)({ wallets: [wallet], fromBlock: "100", toBlock: "102" }), (error) => error instanceof UpstreamFailure && error.retryable);
  for (const reason of [new Error("Synthetic parent cancellation"), new DOMException("Synthetic outer deadline", "TimeoutError")]) {
    const controller = new AbortController();
    const pending = createSqdFundingQuery(1000, controller.signal)({ wallets: [wallet], fromBlock: "100", toBlock: "102" });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
  }
});

test("request-local SQD timeouts yield unavailable or retain a partial prefix instead of terminating collection", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(() => undefined));
  const unavailable = fixture();
  unavailable.options.queryPage = createSqdFundingQuery(20);
  const first = await collectSqdFundingWindow(unavailable.options);
  assert.equal(first.coverage[0].status, "unavailable");
  assert.equal(first.examinedWallets, 0);
  assert.equal(first.evidence.length, 0);
  assert.equal(unavailable.calls.length, 0);
  const partial = fixture({ pageSize: 1, txs: new Map([[100, [transaction(100)]]]) });
  const query = partial.options.queryPage, timeout = createSqdFundingQuery(20);
  partial.options.queryPage = (input) => input.fromBlock === "100" ? query(input) : timeout(input);
  const later = await collectSqdFundingWindow(partial.options);
  assert.equal(later.coverage[0].status, "partial");
  assert.equal(later.coverage[0].toBlock, "100");
  assert.equal(later.examinedWallets, 1);
  assert.equal(later.evidence.length, 1);
  assert.equal(later.evidence[0].blockNumber, "100");
});
