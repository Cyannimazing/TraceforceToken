import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, parseAbi } from "viem";
import { verifyIndependentState, IndependentStateIntegrityError } from "../../scripts/verification/independent-state";
import { browserFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";
import type { InvestigationReport } from "../../src/domain/investigations/types";

const abi = parseAbi([
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)", "function getPair(address,address) view returns (address)",
]);
const word = (value: string | bigint) => BigInt(value).toString(16).padStart(64, "0");
type Request = { url: string; method: string; params: unknown[]; functionName?: string; blockRead: number };
function publicFixture(report: InvestigationReport, change?: (request: Request, result: unknown) => unknown | Response) {
  const requests: Request[] = [];
  let active = 0, maximumActive = 0, blockRead = 0;
  const fetcher: typeof fetch = async (input, init) => {
    assert.ok(init?.signal);
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "POST");
    const url = String(input);
    assert.ok(["https://base-rpc.publicnode.com", "https://mainnet.base.org"].includes(url));
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    const request: Request = { url, method: body.method, params: body.params, blockRead };
    let result: unknown;
    const tag = `0x${BigInt(report.range.to.number).toString(16)}`;
    if (body.method !== "eth_chainId") assert.equal(body.params.at(-1) === false ? body.params[0] : body.params.at(-1), tag, "Every state read must use the same explicit block number");
    if (body.method === "eth_chainId") result = "0x2105";
    else if (body.method === "eth_getBlockByNumber") {
      request.blockRead = ++blockRead;
      result = { number: tag, hash: report.range.to.hash, timestamp: `0x${report.range.to.timestamp.toString(16)}` };
    } else if (body.method === "eth_getCode") result = report.walletActivitySnapshot!.rows.find((row) => row.address === body.params[0])!.code === "eoa" ? "0x" : "0x60006000";
    else if (body.method === "eth_getTransactionCount") result = `0x${BigInt(report.walletActivitySnapshot!.rows.find((row) => row.address === body.params[0])!.outgoingTransactionCountRaw!).toString(16)}`;
    else {
      assert.equal(body.method, "eth_call");
      const call = body.params[0] as { to: string; data: `0x${string}` };
      const decoded = decodeFunctionData({ abi, data: call.data });
      request.functionName = decoded.functionName;
      const pool = report.liquiditySnapshot!;
      switch (decoded.functionName) {
        case "totalSupply": assert.equal(call.to, report.token.address); result = `0x${word(report.token.totalSupplyRaw!)}`; break;
        case "balanceOf": {
          assert.equal(call.to, report.token.address);
          const account = decoded.args[0].toLowerCase();
          result = `0x${word(report.holderSnapshot!.holders.find((row) => row.address === account)!.balanceRaw!)}`; break;
        }
        case "factory": assert.equal(call.to, pool.pool); result = `0x${pool.factory.slice(2).padStart(64, "0")}`; break;
        case "token0": result = `0x${pool.token0.slice(2).padStart(64, "0")}`; break;
        case "token1": result = `0x${pool.token1.slice(2).padStart(64, "0")}`; break;
        case "getPair": assert.equal(call.to, pool.factory); result = `0x${pool.pool.slice(2).padStart(64, "0")}`; break;
        case "getReserves": result = `0x${word(pool.reserve0Raw)}${word(pool.reserve1Raw)}${word(10n)}`; break;
      }
    }
    requests.push(request);
    active++; maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    const changed = change ? change(request, result) : result;
    return changed instanceof Response ? changed : Response.json({ jsonrpc: "2.0", id: body.id, result: changed });
  };
  return { fetcher, requests, maximumActive: () => maximumActive };
}

test("independent public state verification checks every retained pinned state item and emits only metadata", async () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true }), before = structuredClone(report);
  const fixture = publicFixture(report);
  const result = await verifyIndependentState(report, new AbortController().signal, fixture.fetcher);
  assert.equal(result.status, "verified");
  assert.equal(result.provider, "PublicNode");
  assert.deepEqual(result.attemptedProviders, ["PublicNode"]);
  assert.deepEqual(result.checked, { totalSupply: 1, balances: 14, codeClassifications: 13, outgoingNonces: 13, reservePools: 1, blockIdentities: 2 });
  assert.equal(result.requestCount, 49);
  assert.ok(fixture.maximumActive() > 1 && fixture.maximumActive() <= 6);
  assert.equal(fixture.requests.at(-1)?.method, "eth_getBlockByNumber");
  assert.deepEqual(result.methods, ["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getTransactionCount"]);
  assert.ok(!/0x[0-9a-f]{40}|84645|100000|synthetic-flags/i.test(JSON.stringify(result)));
  assert.deepEqual(report, before, "Operator verification must not rewrite its input report");
});

for (const mismatch of ["balance", "supply", "block", "timestamp", "code", "nonce", "chain", "reserve", "pool identity", "factory registration", "final block"] as const) {
  test(`an independent ${mismatch} disagreement is terminal and never selects another provider`, async () => {
    const report = getBrowserWalletFlagsFixture({ contractDominated: true });
    const fixture = publicFixture(report, (request, result) => {
      if (mismatch === "chain" && request.method === "eth_chainId") return "0x1";
      if (mismatch === "block" && request.method === "eth_getBlockByNumber") return { ...(result as object), hash: `0x${"f".repeat(64)}` };
      if (mismatch === "timestamp" && request.method === "eth_getBlockByNumber") return { ...(result as object), timestamp: "0x1" };
      if (mismatch === "final block" && request.method === "eth_getBlockByNumber" && request.blockRead === 2) return { ...(result as object), hash: `0x${"e".repeat(64)}` };
      if (mismatch === "balance" && request.functionName === "balanceOf") return `0x${word(1n)}`;
      if (mismatch === "supply" && request.functionName === "totalSupply") return `0x${word(1n)}`;
      if (mismatch === "code" && request.method === "eth_getCode") return result === "0x" ? "0x6000" : "0x";
      if (mismatch === "nonce" && request.method === "eth_getTransactionCount") return "0xffff";
      if (mismatch === "reserve" && request.functionName === "getReserves") return `0x${word(1n)}${word(2n)}${word(10n)}`;
      if (mismatch === "pool identity" && request.functionName === "token0") return `0x${word(1n)}`;
      if (mismatch === "factory registration" && request.functionName === "getPair") return `0x${word(1n)}`;
      return result;
    });
    await assert.rejects(verifyIndependentState(report, new AbortController().signal, fixture.fetcher), (error) => {
      assert.ok(error instanceof IndependentStateIntegrityError);
      assert.ok(!error.message.includes(report.token.address));
      return true;
    });
    assert.ok(fixture.requests.every((request) => request.url === "https://base-rpc.publicnode.com"));
  });
}

test("a public availability failure may use the second fixed provider without mixing state comparisons", async () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  const fixture = publicFixture(report, (request, result) => request.url.includes("publicnode") && request.functionName === "balanceOf" ? new Response("unavailable", { status: 429 }) : result);
  const result = await verifyIndependentState(report, new AbortController().signal, fixture.fetcher);
  assert.equal(result.status, "verified");
  assert.equal(result.provider, "Base public RPC");
  assert.deepEqual(result.attemptedProviders, ["PublicNode", "Base public RPC"]);
  assert.equal(result.checked.balances, 14, "Partial first-provider comparisons must not count toward second-provider verification");
  assert.equal(result.checked.blockIdentities, 2);
  assert.ok(result.requestCount <= 160);
});

test("a mismatch in an issued concurrent read beats another concurrent availability failure", async () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  let balanceCalls = 0;
  const fixture = publicFixture(report, (request, result) => {
    if (request.functionName !== "balanceOf") return result;
    return ++balanceCalls === 1 ? new Response("unavailable", { status: 503 }) : `0x${word(1n)}`;
  });
  await assert.rejects(verifyIndependentState(report, new AbortController().signal, fixture.fetcher), IndependentStateIntegrityError);
  assert.ok(fixture.requests.every((request) => request.url.includes("publicnode")));
});

test("two public failures return sanitized unavailable metadata, not a successful comparison", async () => {
  const report = getBrowserWalletFlagsFixture();
  const fixture = publicFixture(report, () => new Response("private upstream details must not escape", { status: 403 }));
  const result = await verifyIndependentState(report, new AbortController().signal, fixture.fetcher);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "public-providers-unavailable");
  assert.equal(result.provider, null);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.checked, { totalSupply: 0, balances: 0, codeClassifications: 0, outgoingNonces: 0, reservePools: 0, blockIdentities: 0 });
  assert.ok(!JSON.stringify(result).includes("private upstream"));
});

test("missing pinned state is unavailable and stale input is rejected before any provider access", async () => {
  const report = getBrowserWalletFlagsFixture(), fixture = publicFixture(report);
  delete report.holderSnapshot;
  const missing = await verifyIndependentState(report, new AbortController().signal, fixture.fetcher);
  assert.equal(missing.reason, "pinned-state-unavailable");
  assert.equal(fixture.requests.length, 0);
  const stale = getBrowserWalletFlagsFixture();
  stale.walletActivitySnapshot!.block = { ...stale.range.to, number: "399" };
  await assert.rejects(verifyIndependentState(stale, new AbortController().signal, fixture.fetcher), IndependentStateIntegrityError);
  assert.equal(fixture.requests.length, 0);
});

test("verification respects outer cancellation before issuing requests", async () => {
  const report = getBrowserWalletFlagsFixture(), fixture = publicFixture(report), controller = new AbortController();
  const reason = new Error("operator cancelled");
  controller.abort(reason);
  await assert.rejects(verifyIndependentState(report, controller.signal, fixture.fetcher), (error) => error === reason);
  assert.equal(fixture.requests.length, 0);
  assert.ok(report.holderSnapshot!.holders.some((row) => row.address === browserFixture.pool));
});

test("contract classification accepts maximum-size deployed code without a false provider failure", async () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  const fixture = publicFixture(report, (request, result) => request.method === "eth_getCode" && result !== "0x" ? `0x${"00".repeat(24_576)}` : result);
  const result = await verifyIndependentState(report, new AbortController().signal, fixture.fetcher);
  assert.equal(result.status, "verified");
  assert.deepEqual(result.attemptedProviders, ["PublicNode"]);
  assert.equal(result.checked.codeClassifications, 13);
});

test("a report exceeding the bounded read plan remains unavailable without issuing partial verification", async () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  report.walletActivitySnapshot!.rows.push(...Array.from({ length: 161 }, (_, index) => ({ address: `0x${(10_000 + index).toString(16).padStart(40, "0")}` as const, outgoingTransactionCountRaw: null, code: "eoa" as const })));
  const fixture = publicFixture(report);
  const result = await verifyIndependentState(report, new AbortController().signal, fixture.fetcher);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "read-budget-exceeded");
  assert.equal(result.requestCount, 0);
  assert.deepEqual(result.attemptedProviders, []);
});
