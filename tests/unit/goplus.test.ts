import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Address, Hash } from "../../src/domain/investigations/types";
import { createGoPlusTokenQuery, parseGoPlusTokenData } from "../../src/providers/base/goplus";
import { goPlusTokenUrl, tokenSecuritySnapshotSchema } from "../../src/domain/investigations/token-security";
import { validateHolderSnapshot } from "../../src/domain/investigations/holder-snapshot";
import { collectHolderSnapshot } from "../../src/providers/base/holders";
import { ProviderIntegrityError, UpstreamFailure } from "../../src/providers/base/errors";

const token = `0x${"1".repeat(40)}` as Address, A = `0x${"2".repeat(40)}` as Address, B = `0x${"3".repeat(40)}` as Address;
const checkedAt = "2026-10-12T07:00:00.000Z";
const envelope = (data: unknown) => ({ code: 1, result: { [token]: data } });

test("GoPlus keeps source count and candidate addresses separate from balances and audit conclusions", () => {
  const data = parseGoPlusTokenData(envelope({ holder_count: "13", creator_address: A, holders: [{ address: A, balance: "99999999", percent: "1" }, { address: A }, { address: B }], is_honeypot: "0", is_proxy: "1", is_mintable: "", hidden_owner: 0 }), token, checkedAt);
  assert.equal(data.snapshot.holderCount, 13);
  assert.equal(data.snapshot.creatorAddress, A);
  assert.deepEqual(data.addresses, [A, B]);
  assert.deepEqual(data.snapshot.checks.slice(0, 4), [{ id: "is_honeypot", value: "no" }, { id: "is_proxy", value: "yes" }, { id: "is_mintable", value: "unknown" }, { id: "hidden_owner", value: "unknown" }]);
  assert.equal("balance" in data, false);
  assert.doesNotThrow(() => tokenSecuritySnapshotSchema.parse(data.snapshot));
});

test("GoPlus rejects foreign identity, malformed rows and failed semantic responses; missing counts stay unknown", () => {
  assert.throws(() => parseGoPlusTokenData({ code: 1, result: { [A]: {} } }, token, checkedAt), ProviderIntegrityError);
  assert.throws(() => parseGoPlusTokenData({ code: 1 }, token, checkedAt), ProviderIntegrityError);
  assert.throws(() => parseGoPlusTokenData(envelope({ holders: [{ address: "bad" }] }), token, checkedAt), ProviderIntegrityError);
  assert.throws(() => parseGoPlusTokenData({ code: 0, result: {} }, token, checkedAt), UpstreamFailure);
  for (const holder_count of [undefined, "", "-1", "1.1", "9007199254740992", "1e3"]) {
    assert.equal(parseGoPlusTokenData(envelope({ holder_count }), token, checkedAt).snapshot.holderCount, null);
  }
  const missing = parseGoPlusTokenData({ code: 1, result: {} }, token, checkedAt);
  assert.equal(missing.snapshot.status, "not_listed"); assert.equal(missing.snapshot.holderCount, null);
  assert.equal(parseGoPlusTokenData(envelope({ holder_count: "0" }), token, checkedAt).snapshot.holderCount, 0);
  assert.equal(parseGoPlusTokenData(envelope({ creator_address: `0x${"0".repeat(40)}` }), token, checkedAt).snapshot.creatorAddress, null);
});

test("a source-reported creator outside the holder subset is an exact balance candidate, not an ownership proof", () => {
  const data = parseGoPlusTokenData(envelope({ holder_count: "13", creator_address: B, creator_balance: "999999", holders: [{ address: A }] }), token, checkedAt);
  assert.deepEqual(data.addresses, [A, B]);
  assert.equal(data.snapshot.creatorAddress, B);
  assert.equal(data.snapshot.holderCount, 13);
  assert.equal("creator_balance" in data.snapshot, false);
  assert.deepEqual(parseGoPlusTokenData(envelope({ creator_address: `0x${"0".repeat(40)}`, holders: [{ address: A }] }), token, checkedAt).addresses, [A]);
});

test("GoPlus context cannot impersonate a pinned balance census or another token/source", () => {
  const snapshot = parseGoPlusTokenData(envelope({ holder_count: "13" }), token, checkedAt).snapshot;
  for (const changed of [{ sourceUrl: goPlusTokenUrl(A) }, { holderCount: -1 }, { status: "unavailable" }, { checks: [{ id: "is_proxy", value: "yes" }, { id: "is_proxy", value: "no" }] }]) {
    assert.equal(tokenSecuritySnapshotSchema.safeParse({ ...snapshot, ...changed }).success, false);
  }
});

test("GoPlus subset merges observed candidates and verifies only exact pinned RPC balances", async () => {
  const block = { number: "100", hash: `0x${"a".repeat(64)}` as Hash, timestamp: 200 };
  let pages = 0; const reads: unknown[][] = [];
  const snapshot = await collectHolderSnapshot({
    token, block, totalSupplyRaw: "100", observedAt: checkedAt, observedWallets: [B], provider: "GoPlus", sourceUrl: goPlusTokenUrl(token), indexIndependentOfRpc: true,
    page: async () => { pages++; return { tokenAddress: token, items: [{ address: A }], nextCursor: null, complete: false }; },
    remainingCalls: () => 20,
    request: async (method, params) => { assert.equal(method, "eth_call"); reads.push(params); return `0x${(10n).toString(16).padStart(64, "0")}`; },
  });
  assert.equal(pages, 1); assert.equal(reads.length, 2);
  assert.ok(reads.every((params) => params[1] === "0x64"));
  assert.equal(snapshot.discovery.status, "partial"); assert.equal(snapshot.discovery.finalizedCensus, false);
  assert.equal(snapshot.balances.status, "complete"); assert.equal(snapshot.balances.verifiedWallets, 2);
  assert.deepEqual(snapshot.holders.map((item) => item.balanceRaw), ["10", "10"]);
  const details = { address: token, chainId: 8453 as const, name: null, symbol: null, decimals: 18, totalSupplyRaw: "100" };
  assert.doesNotThrow(() => validateHolderSnapshot(snapshot, details, block));
  assert.throws(() => validateHolderSnapshot({ ...snapshot, discovery: { ...snapshot.discovery, status: "complete" } }, details, block));
});

test("Independent GoPlus discovery still runs while RPC is throttled, without pretending balances succeeded", async () => {
  let pages = 0, reads = 0;
  const snapshot = await collectHolderSnapshot({ token, block: { number: "100", hash: `0x${"a".repeat(64)}` as Hash, timestamp: 200 }, totalSupplyRaw: "100", observedAt: checkedAt, observedWallets: [], provider: "GoPlus", sourceUrl: goPlusTokenUrl(token), indexIndependentOfRpc: true,
    page: async () => { pages++; return { items: [{ address: A }], nextCursor: null, complete: false }; }, remainingCalls: () => 20,
    throttleError: () => new UpstreamFailure(true, { httpStatus: 429 }), request: async () => { reads++; throw Error("Must not read"); },
  });
  assert.equal(pages, 1); assert.equal(reads, 0); assert.equal(snapshot.discovery.addresses, 1);
  assert.equal(snapshot.balances.status, "not_examined"); assert.equal(snapshot.holders[0].balanceRaw, null);
});

test("GoPlus transport uses one fixed read with no redirects or hidden retries, bounded errors and cancellation", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => { requests.push({ url, init }); return Response.json(envelope({ holder_count: "13", holders: [{ address: A }] })); });
  try {
    assert.equal((await createGoPlusTokenQuery(1000)(token)).snapshot.holderCount, 13);
    assert.equal(requests.length, 1); assert.equal(requests[0].url, goPlusTokenUrl(token));
    assert.equal(requests[0].init?.redirect, "error"); assert.equal(requests[0].init?.cache, "no-store");
    await assert.rejects(createGoPlusTokenQuery(1000)("https://private" as Address), ProviderIntegrityError); assert.equal(requests.length, 1);
    fetchMock.mock.mockImplementation(async () => new Response("provider secret", { status: 429 }));
    await assert.rejects(createGoPlusTokenQuery(1000)(token), (error: unknown) => error instanceof UpstreamFailure && error.httpStatus === 429 && !error.message.includes("secret"));
    const controller = new AbortController(), reason = new Error("Owned cancellation");
    fetchMock.mock.mockImplementation(async () => new Promise<Response>(() => {}));
    const pending = createGoPlusTokenQuery(1000, controller.signal)(token); controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    fetchMock.mock.mockImplementation(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("{")); } })));
    await assert.rejects(createGoPlusTokenQuery(1000)(token), (error: unknown) => error instanceof UpstreamFailure && error.retryable);
  } finally { fetchMock.mock.restore(); }
});
