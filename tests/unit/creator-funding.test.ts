import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hash } from "../../src/domain/investigations/types";
import { collectCreatorFunding } from "../../src/providers/base/creator-funding";
import { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "../../src/providers/base/errors";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;
const creator = address(1), wallet = address(2), other = address(3);
const boundary = (n: number) => ({ number: String(n), hash: hash(n), timestamp: n * 2 });
function fixture(): Parameters<typeof collectCreatorFunding>[0] {
  return { creator, cohort: [wallet], from: boundary(0), to: boundary(100), observedAt: "2026-10-12T00:00:00.000Z", maxEvidence: 200,
    query: async () => ({ items: [{ hash: hash(1000), blockNumber: "80" }], nextCursor: null }),
    request: async (method) => method === "eth_getCode" ? "0x" : ({ hash: hash(1000), blockHash: hash(80), blockNumber: "0x50", transactionIndex: "0x1", from: creator, to: wallet, value: "0x20000000000001" }),
    receipt: async () => ({ transactionHash: hash(1000), blockHash: hash(80), blockNumber: "0x50", transactionIndex: "0x1", status: "0x1" }),
    canonicalBlock: async () => boundary(80),
  };
}

test("creator query retains exact successful canonical funding and independent exhausted coverage", async () => {
  const result = await collectCreatorFunding(fixture());
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.coverage.paginationExhausted, true);
  assert.deepEqual(result.coverage.cohort, [wallet]);
  assert.equal(result.evidence[0].amountRaw, "9007199254740993");
  assert.equal(result.evidence[0].from, creator);
  assert.deepEqual(result.coverage.evidenceIds, result.evidence.map((row) => row.id));
  assert.match(result.coverage.reason, /recipient inbound histories remain outside/);
});

test("creator query verifies but excludes noncohort, zero, failed and historical contract recipients", async () => {
  for (const variant of ["noncohort", "zero", "failed", "contract"]) {
    const options = fixture(), request = options.request, receipt = options.receipt;
    options.request = async (method, params) => method === "eth_getCode" ? variant === "contract" ? "0x6000" : "0x" : ({ ...await request(method, params) as object, ...(variant === "noncohort" ? { to: other } : {}), ...(variant === "zero" ? { value: "0x0" } : {}) });
    if (variant === "failed") options.receipt = async (tx) => ({ ...await receipt(tx), status: "0x0" });
    const result = await collectCreatorFunding(options);
    assert.equal(result.coverage.status, "complete");
    assert.equal(result.evidence.length, 0);
  }
});

test("creator query rejects sender, receipt and canonical integrity conflicts", async () => {
  for (const variant of ["sender", "receipt", "canonical"]) {
    const options = fixture(), request = options.request, receipt = options.receipt;
    if (variant === "sender") options.request = async (method, params) => ({ ...await request(method, params) as object, from: other });
    if (variant === "receipt") options.receipt = async (tx) => ({ ...await receipt(tx), blockHash: hash(81) });
    if (variant === "canonical") options.canonicalBlock = async () => { throw new ProviderIntegrityError(); };
    await assert.rejects(collectCreatorFunding(options), ProviderIntegrityError);
  }
});

test("creator query commits only complete pages and never upgrades budget failures", async () => {
  const options = fixture();
  let page = 0;
  options.query = async () => ++page === 1 ? { items: [], nextCursor: { pageKey: "next" } } : { items: [{ hash: hash(1000), blockNumber: "80" }, { hash: hash(1001), blockNumber: "70" }], nextCursor: null };
  const request = options.request;
  options.request = async (method, params) => { if (params[0] === hash(1001)) throw new ProviderBudgetError(); return request(method, params); };
  const result = await collectCreatorFunding(options);
  assert.equal(result.coverage.status, "partial");
  assert.equal(result.coverage.paginationExhausted, false);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.coverage.evidenceIds, []);
});

test("creator query caps pagination at two pages and propagates cancellation", async () => {
  const options = fixture(); let pages = 0;
  options.query = async () => ({ items: [], nextCursor: { pageKey: `page-${++pages}` } });
  assert.equal((await collectCreatorFunding(options)).coverage.status, "partial");
  assert.equal(pages, 2);
  for (const failure of [new ProviderBudgetError(), new UpstreamFailure()]) {
    assert.equal((await collectCreatorFunding({ ...fixture(), query: async () => { throw failure; } })).coverage.status, "unavailable");
  }
  const controller = new AbortController(), reason = new Error("cancelled"); controller.abort(reason);
  await assert.rejects(collectCreatorFunding({ ...fixture(), signal: controller.signal }), (error) => error === reason);
});
