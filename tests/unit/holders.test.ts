import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Address, Hash, HolderSnapshot } from "../../src/domain/investigations/types";
import { holderSnapshotSchema, validateHolderSnapshot } from "../../src/domain/investigations/holder-snapshot";
import { collectHolderSnapshot, discoverHolderCandidates, verifyHolderBalances, type HolderCollectionOptions } from "../../src/providers/base/holders";
import { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "../../src/providers/base/errors";
import { readProviderConfiguration } from "../../src/providers/base/config";
import { createProviderTransport } from "../../src/providers/base/transport";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const token = address(1), A = address(2), B = address(3), C = address(4);
const block = { number: "100", hash: `0x${"a".repeat(64)}` as Hash, timestamp: 200 };
const observedAt = "2026-10-12T00:00:00.000Z", maximum = 2n ** 256n - 1n;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
function fixture(overrides: Partial<HolderCollectionOptions> = {}, budget = 20) {
  let calls = 0;
  const requests: { method: string; params: unknown[] }[] = [];
  const options: HolderCollectionOptions = {
    token, totalSupplyRaw: maximum.toString(), block, observedWallets: [A], observedAt,
    page: async () => ({ items: [{ address: A }, { address: B }], nextCursor: null, tokenAddress: token }),
    request: async () => word(10n), ...overrides, remainingCalls: () => Math.max(0, budget - calls),
  };
  const page = options.page, request = options.request;
  options.page = async (cursor) => { calls++; return page(cursor); };
  options.request = async (method, params) => { calls++; requests.push({ method, params }); return request(method, params); };
  return { options, requests, calls: () => calls };
}
const validate = (snapshot: HolderSnapshot) => validateHolderSnapshot(snapshot, { address: token, chainId: 8453, name: null, symbol: null, decimals: 18, totalSupplyRaw: maximum.toString() }, block);
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("balance batches default to serial reads and support four concurrent exact pinned reads", async () => {
  const wallets = Array.from({ length: 8 }, (_, index) => address(index + 100));
  for (const concurrency of [1, 4]) {
    let active = 0, peak = 0;
    const waiting: { wallet: Address; release(value: string): void }[] = [];
    const amounts = new Map(wallets.map((wallet, index) => [wallet, 2n ** 200n + BigInt(index)]));
    const source = fixture({ observedWallets: wallets, page: async () => ({ items: [], nextCursor: null }), request: async (_method, params) => {
      const wallet = `0x${(params[0] as { data: string }).data.slice(-40)}` as Address;
      active++; peak = Math.max(peak, active);
      try { return await new Promise<string>((release) => waiting.push({ wallet, release })); }
      finally { active--; }
    } }, 30);
    const discovery = await discoverHolderCandidates(source.options), before = structuredClone(discovery);
    const running = verifyHolderBalances(discovery, { ...source.options, ...(concurrency === 4 ? { balanceConcurrency: 4 } : {}) });
    for (let offset = 0; offset < wallets.length; offset += concurrency) {
      await nextTurn();
      assert.equal(waiting.length, concurrency);
      assert.equal(source.requests.length, offset + concurrency, "no later batch starts before all current reads settle");
      for (const entry of waiting.splice(0).reverse()) entry.release(word(amounts.get(entry.wallet)!));
    }
    const result = await running;
    assert.equal(peak, concurrency); assert.equal(active, 0);
    assert.equal(result.balances.status, "complete");
    assert.deepEqual(result.holders.map((holder) => [holder.address, holder.balanceRaw]), wallets.map((wallet) => [wallet, amounts.get(wallet)!.toString()]));
    assert.ok(source.requests.every((request) => request.method === "eth_call" && request.params[1] === "0x64" && (request.params[0] as { to: Address }).to === token));
    assert.deepEqual(discovery, before, "parallel verification cannot alter discovery input");
    assert.doesNotThrow(() => validate(result));
  }
});

test("parallel balance batches cannot exceed the exact remaining shared call allocation", async () => {
  const wallets = Array.from({ length: 8 }, (_, index) => address(index + 100));
  const source = fixture({ balanceConcurrency: 4, observedWallets: wallets, page: async () => ({ items: [], nextCursor: null }), request: async () => word(0n) }, 3);
  const result = await collectHolderSnapshot(source.options);
  assert.equal(source.calls(), 3, "one discovery call leaves exactly two balance calls");
  assert.equal(source.requests.length, 2);
  assert.deepEqual(result.holders.map((holder) => [holder.status, holder.balanceRaw]), [
    ["verified", "0"], ["verified", "0"], ...wallets.slice(2).map(() => ["not_examined", null]),
  ]);
  assert.equal(result.balances.status, "partial");
  assert.doesNotThrow(() => validate(result));
});

test("a throttle settles the already launched balance batch and stops every later batch", async () => {
  const wallets = Array.from({ length: 8 }, (_, index) => address(index + 100));
  for (const failure of [new UpstreamFailure(true, { httpStatus: 429 }), new UpstreamFailure(true, { rpcCode: -32005 }), new UpstreamFailure(true, { rpcCode: -32016 }), new UpstreamFailure(true, { rpcCode: 429 })]) {
    let settled = 0;
    const source = fixture({ balanceConcurrency: 4, observedWallets: wallets, page: async () => ({ items: [], nextCursor: null }), request: async (_method, params) => {
      await nextTurn(); settled++;
      if ((params[0] as { data: string }).data.endsWith(wallets[1].slice(2))) throw failure;
      return word(17n);
    } }, 30);
    const result = await collectHolderSnapshot(source.options);
    assert.equal(source.requests.length, 4); assert.equal(settled, 4);
    assert.deepEqual(result.holders.map((holder) => [holder.status, holder.balanceRaw]), [
      ["verified", "17"], ["unavailable", null], ["verified", "17"], ["verified", "17"], ...wallets.slice(4).map(() => ["not_examined", null]),
    ]);
    assert.equal(result.balances.verifiedWallets, 3); assert.match(result.balances.reason!, /throttling/);
    assert.doesNotThrow(() => validate(result));
  }
});

test("ordinary unavailable reads preserve null and allow later balance batches without inventing zero", async () => {
  const wallets = Array.from({ length: 8 }, (_, index) => address(index + 100));
  const source = fixture({ balanceConcurrency: 4, observedWallets: wallets, page: async () => ({ items: [], nextCursor: null }), request: async (_method, params) => {
    if ((params[0] as { data: string }).data.endsWith(wallets[0].slice(2))) throw new UpstreamFailure();
    return word(0n);
  } }, 30);
  const result = await collectHolderSnapshot(source.options);
  assert.equal(source.requests.length, 8); assert.equal(result.holders[0].balanceRaw, null); assert.equal(result.holders[0].status, "unavailable");
  assert.ok(result.holders.slice(1).every((holder) => holder.status === "verified" && holder.balanceRaw === "0"));
  assert.equal(result.balances.status, "partial"); assert.doesNotThrow(() => validate(result));
});

test("a denied balance budget settles its bounded batch but starts no additional requests", async () => {
  const wallets = Array.from({ length: 8 }, (_, index) => address(index + 100));
  const source = fixture({ balanceConcurrency: 4, observedWallets: wallets, page: async () => ({ items: [], nextCursor: null }), request: async (_method, params) => {
    if ((params[0] as { data: string }).data.endsWith(wallets[1].slice(2))) throw new ProviderBudgetError();
    return word(1n);
  } }, 30);
  const result = await collectHolderSnapshot(source.options);
  assert.equal(source.requests.length, 4); assert.equal(result.balances.verifiedWallets, 3);
  assert.equal(result.holders[1].status, "unavailable");
  assert.ok(result.holders.slice(4).every((holder) => holder.status === "not_examined" && holder.balanceRaw === null));
  assert.doesNotThrow(() => validate(result));
});

test("malformed and unknown balance failures settle launched reads then reject without later batches", async () => {
  const wallets = Array.from({ length: 8 }, (_, index) => address(index + 100));
  for (const failure of [undefined, new Error("Synthetic terminal balance failure")]) {
    const waiting: ((value: string) => void)[] = [];
    const source = fixture({ balanceConcurrency: 4, observedWallets: wallets, page: async () => ({ items: [], nextCursor: null }), request: async (_method, params) => {
      if ((params[0] as { data: string }).data.endsWith(wallets[0].slice(2))) { if (failure) throw failure; return "0x01"; }
      return new Promise<string>((resolve) => waiting.push(resolve));
    } }, 30);
    const discovery = await discoverHolderCandidates(source.options), before = structuredClone(discovery);
    const running = verifyHolderBalances(discovery, source.options); let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await nextTurn(); assert.equal(waiting.length, 3); assert.equal(settled, false);
    for (const release of waiting) release(word(1n));
    await assert.rejects(running, (error: unknown) => failure ? error === failure : error instanceof ProviderIntegrityError);
    assert.equal(source.requests.length, 4); assert.deepEqual(discovery, before);
  }
});

test("parent cancellation aborts the launched balance batch and prevents later work or publication", async () => {
  const controller = new AbortController(), reason = new Error("Synthetic balance batch cancellation");
  const wallets = Array.from({ length: 8 }, (_, index) => address(index + 100));
  let aborted = 0;
  const source = fixture({ balanceConcurrency: 4, signal: controller.signal, observedWallets: wallets, page: async () => ({ items: [], nextCursor: null }), request: async () => new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => { aborted++; reject(controller.signal.reason); }, { once: true });
  }) }, 30);
  const discovery = await discoverHolderCandidates(source.options), before = structuredClone(discovery);
  const running = verifyHolderBalances(discovery, source.options);
  await nextTurn(); assert.equal(source.requests.length, 4); controller.abort(reason);
  await assert.rejects(running, (error: unknown) => error === reason);
  assert.equal(aborted, 4); assert.equal(source.requests.length, 4); assert.deepEqual(discovery, before);
});

test("parallel reads retain exact uint256 and final total-supply checks and reject invalid concurrency", async () => {
  const source = fixture({ balanceConcurrency: 4, observedWallets: [A, B], request: async (_method, params) => (params[0] as { data: string }).data.endsWith(A.slice(2)) ? word(maximum) : word(1n) });
  await assert.rejects(collectHolderSnapshot(source.options), ProviderIntegrityError);
  assert.equal(source.requests.length, 2);
  for (const concurrency of [0, 5, 1.5, NaN, Infinity]) {
    const invalid = fixture(), discovery = await discoverHolderCandidates(invalid.options);
    await assert.rejects(verifyHolderBalances(discovery, { ...invalid.options, balanceConcurrency: concurrency }), RangeError);
    assert.equal(invalid.requests.length, 0);
  }
});

test("two-stage holder discovery makes no balance calls and later verification never rediscovers pages", async () => {
  let pages = 0;
  const source = fixture({ page: async () => { pages++; return { items: [{ address: A }, { address: B }], nextCursor: null }; } });
  const discovery = await discoverHolderCandidates(source.options);
  assert.equal(pages, 1); assert.equal(source.requests.length, 0); assert.equal(discovery.throttled, false);
  assert.deepEqual(discovery.snapshot.holders.map((holder) => [holder.status, holder.balanceRaw]), [["not_examined", null], ["not_examined", null]]);
  assert.equal(discovery.snapshot.balances.requestedWallets, 2);
  assert.doesNotThrow(() => validate(discovery.snapshot));
  const before = structuredClone(discovery);
  const snapshot = await verifyHolderBalances(discovery, { ...source.options, page: async () => { throw new Error("Balance verification must not rediscover candidates."); } });
  assert.equal(pages, 1); assert.equal(source.requests.length, 2);
  assert.equal(snapshot.balances.status, "complete");
  assert.deepEqual(discovery, before, "verification must not mutate the pending discovery result");
  assert.deepEqual(validate(snapshot), snapshot);
});

test("external-only candidates remain external and do not inflate indexed discovery or manufacture observed activity", async () => {
  const source = fixture({ observedWallets: [A], externalWallets: [B, C, A], page: async () => ({ items: [{ address: A }, { address: B }], nextCursor: null }) });
  const discovery = await discoverHolderCandidates(source.options);
  assert.deepEqual(discovery.snapshot.holders.map((holder) => [holder.address, holder.discoveredBy]), [[A, "both"], [B, "indexed"], [C, "external"]]);
  assert.equal(discovery.snapshot.discovery.addresses, 2);
  assert.equal(discovery.snapshot.discovery.finalizedCensus, false);
  const verified = await verifyHolderBalances(discovery, source.options);
  assert.equal(verified.holders.find((holder) => holder.address === C)?.discoveredBy, "external");
  assert.equal(verified.holders.find((holder) => holder.address === C)?.balanceRaw, "10");
  assert.doesNotThrow(() => validate(verified));
  const forged = structuredClone(verified); forged.discovery.addresses++;
  assert.throws(() => validate(forged), /Inconsistent pinned holder snapshot/);
});

test("external lead balance verification cannot upgrade an unavailable holder index into complete discovery", async () => {
  const source = fixture({ observedWallets: [], externalWallets: [C], page: async () => { throw new UpstreamFailure(); } });
  const discovery = await discoverHolderCandidates(source.options);
  assert.equal(discovery.snapshot.discovery.status, "unavailable"); assert.equal(discovery.snapshot.discovery.addresses, 0);
  assert.equal(discovery.snapshot.holders[0].discoveredBy, "external");
  const verified = await verifyHolderBalances(discovery, source.options);
  assert.equal(verified.discovery.status, "unavailable"); assert.equal(verified.balances.status, "complete");
  assert.equal(verified.discovery.finalizedCensus, false); assert.doesNotThrow(() => validate(verified));
});

test("delayed balance verification respects the remaining budget after prioritized work", async () => {
  let remaining = 4, pageReads = 0, balanceReads = 0;
  const options: HolderCollectionOptions = { token, totalSupplyRaw: maximum.toString(), block, observedWallets: [A], observedAt,
    remainingCalls: () => remaining,
    page: async () => { pageReads++; remaining--; return { items: [{ address: B }], nextCursor: null }; },
    request: async () => { balanceReads++; remaining--; return word(7n); },
  };
  const discovery = await discoverHolderCandidates(options);
  remaining = 1; // Intervening funding work consumed the shared allocation.
  const snapshot = await verifyHolderBalances(discovery, options);
  assert.equal(pageReads, 1); assert.equal(balanceReads, 1);
  assert.deepEqual(snapshot.holders.map((holder) => [holder.status, holder.balanceRaw]), [["verified", "7"], ["not_examined", null]]);
  assert.equal(snapshot.balances.status, "partial"); assert.doesNotThrow(() => validate(snapshot));
});

test("a holder-index throttle survives delayed verification against a healthy primary RPC", async () => {
  let pages = 0;
  const source = fixture({ throttleError: () => null, page: async () => {
    if (pages++) throw new UpstreamFailure(true, { httpStatus: 429 });
    return { items: [{ address: B }], nextCursor: { value: "1" } };
  } });
  const discovery = await discoverHolderCandidates(source.options);
  assert.equal(discovery.throttled, true); assert.equal(discovery.snapshot.discovery.status, "partial");
  const snapshot = await verifyHolderBalances(discovery, source.options);
  assert.equal(pages, 2); assert.equal(source.requests.length, 0);
  assert.equal(snapshot.balances.status, "not_examined");
  assert.ok(snapshot.holders.every((holder) => holder.status === "not_examined" && holder.balanceRaw === null));
  assert.match(snapshot.balances.reason!, /throttling/); assert.doesNotThrow(() => validate(snapshot));
});

test("discovery deferred by earlier RPC throttling can verify observed candidates after recovery without rediscovery", async () => {
  let rpcThrottle: UpstreamFailure | null = new UpstreamFailure(true, { httpStatus: 429 });
  let pages = 0;
  const source = fixture({ throttleError: () => rpcThrottle, page: async () => { pages++; return { items: [{ address: B }], nextCursor: null }; } });
  const discovery = await discoverHolderCandidates(source.options);
  assert.equal(pages, 0);
  assert.equal(discovery.throttled, false, "an unattempted index has not reported a throttle");
  assert.equal(discovery.snapshot.discovery.status, "not_examined");
  assert.match(discovery.snapshot.discovery.reason!, /Earlier RPC throttling/);
  assert.deepEqual(discovery.snapshot.holders.map((item) => item.address), [A]);
  const stillBlocked = await verifyHolderBalances(discovery, source.options);
  assert.equal(stillBlocked.balances.status, "not_examined");
  assert.equal(source.requests.length, 0, "the current RPC latch must still stop balances before recovery");
  rpcThrottle = null;
  const snapshot = await verifyHolderBalances(discovery, source.options);
  assert.equal(pages, 0, "recovery must not silently repeat indexed discovery");
  assert.equal(source.requests.length, 1);
  assert.equal(snapshot.discovery.status, "not_examined", "successful balance reads cannot upgrade undiscovered index coverage");
  assert.equal(snapshot.balances.status, "complete");
  assert.deepEqual(snapshot.holders.map((item) => [item.address, item.status, item.balanceRaw]), [[A, "verified", "10"]]);
  assert.doesNotThrow(() => validate(snapshot));
});

test("an actual first-page index 429 stays binding even when RPC recovery clears its separate latch", async () => {
  let rpcThrottle: UpstreamFailure | null = null;
  const source = fixture({ throttleError: () => rpcThrottle, page: async () => { throw new UpstreamFailure(true, { httpStatus: 429 }); } });
  const discovery = await discoverHolderCandidates(source.options);
  assert.equal(discovery.throttled, true);
  assert.equal(discovery.snapshot.discovery.status, "unavailable");
  rpcThrottle = new UpstreamFailure(true, { httpStatus: 429 });
  assert.equal((await verifyHolderBalances(discovery, source.options)).balances.status, "not_examined");
  rpcThrottle = null;
  const snapshot = await verifyHolderBalances(discovery, source.options);
  assert.equal(source.requests.length, 0);
  assert.equal(snapshot.balances.status, "not_examined");
  assert.equal(snapshot.holders[0].balanceRaw, null);
  assert.match(snapshot.balances.reason!, /throttling/);
  assert.doesNotThrow(() => validate(snapshot));
});

test("delayed holder verification rejects token, supply and exact block identity changes before RPC calls", async () => {
  const source = fixture(), discovery = await discoverHolderCandidates(source.options);
  for (const options of [
    { ...source.options, token: B }, { ...source.options, totalSupplyRaw: "1" },
    { ...source.options, block: { ...block, number: "101" } },
    { ...source.options, block: { ...block, hash: `0x${"b".repeat(64)}` as Hash } },
    { ...source.options, block: { ...block, timestamp: block.timestamp + 1 } },
  ]) await assert.rejects(verifyHolderBalances(discovery, options), ProviderIntegrityError);
  assert.equal(source.requests.length, 0);
});

test("cancellation between holder phases propagates without starting a balance read", async () => {
  const controller = new AbortController(), source = fixture({ signal: controller.signal });
  const discovery = await discoverHolderCandidates(source.options), reason = new Error("Synthetic between-phase cancellation");
  controller.abort(reason);
  await assert.rejects(verifyHolderBalances(discovery, source.options), (error: unknown) => error === reason);
  assert.equal(source.requests.length, 0);
});

test("holder discovery joins indexed and observed addresses but reads exact balances only at the pinned block", async () => {
  const source = fixture({ request: async (_method, params) => (params[0] as { data: string }).data.endsWith(A.slice(2)) ? word(maximum) : word(0n) });
  const snapshot = await collectHolderSnapshot(source.options);
  assert.equal(snapshot.discovery.status, "complete");
  assert.equal(snapshot.discovery.finalizedCensus, false);
  assert.equal(snapshot.discovery.addresses, 2);
  assert.equal(snapshot.holders.find((item) => item.address === A)?.discoveredBy, "both");
  assert.equal(snapshot.holders.find((item) => item.address === B)?.discoveredBy, "indexed");
  assert.equal(snapshot.holders[0].balanceRaw, maximum.toString());
  assert.equal(snapshot.holders[1].balanceRaw, "0");
  assert.equal(snapshot.balances.status, "complete");
  assert.ok(source.requests.every((request) => request.method === "eth_call" && request.params[1] === "0x64" && (request.params[0] as { to: Address }).to === token));
  assert.deepEqual(validate(snapshot), snapshot);
});

test("holder discovery partial pages retain candidates without pretending indexed balances are finalized", async () => {
  let page = 0;
  const source = fixture({ page: async () => {
    if (page++) throw new UpstreamFailure();
    return { items: [{ address: B }], nextCursor: { value: "10", address_hash: B } };
  } });
  const snapshot = await collectHolderSnapshot(source.options);
  assert.equal(snapshot.discovery.status, "partial");
  assert.equal(snapshot.discovery.pages, 1);
  assert.equal(snapshot.balances.status, "complete");
  assert.equal(snapshot.holders.length, 2);
  assert.doesNotThrow(() => validate(snapshot));
});

test("an index outage leaves discovery unavailable while observed candidates can still have verified balances", async () => {
  const snapshot = await collectHolderSnapshot(fixture({ page: async () => { throw new UpstreamFailure(); } }).options);
  assert.equal(snapshot.discovery.status, "unavailable");
  assert.equal(snapshot.discovery.pages, 0);
  assert.equal(snapshot.discovery.addresses, 0);
  assert.equal(snapshot.balances.status, "complete");
  assert.equal(snapshot.holders[0].balanceRaw, "10");
  assert.doesNotThrow(() => validate(snapshot));
});

test("recognized balance outages remain null and unreached addresses remain not examined", async () => {
  const source = fixture({ page: async () => ({ items: [{ address: A }, { address: B }, { address: C }], nextCursor: null }), request: async (_method, params) => {
    if ((params[0] as { data: string }).data.endsWith(A.slice(2))) throw new UpstreamFailure();
    return word(0n);
  } }, 3);
  const snapshot = await collectHolderSnapshot(source.options);
  assert.deepEqual(snapshot.holders.map((item) => [item.status, item.balanceRaw]), [["unavailable", null], ["verified", "0"], ["not_examined", null]]);
  assert.equal(snapshot.balances.status, "partial");
  assert.equal(snapshot.balances.verifiedWallets, 1);
  assert.equal(source.calls(), 3);
  assert.doesNotThrow(() => validate(snapshot));
});

test("recognized holder throttles stop optional balance pressure while retaining earlier exact results", async () => {
  for (const failure of [new UpstreamFailure(true, { httpStatus: 429 }), new UpstreamFailure(true, { rpcCode: -32005 }), new UpstreamFailure(true, { rpcCode: -32016 }), new UpstreamFailure(true, { rpcCode: 429 })]) {
    let reads = 0;
    const source = fixture({ page: async () => ({ items: [{ address: A }, { address: B }, { address: C }], nextCursor: null }), request: async () => { if (++reads === 2) throw failure; return word(17n); } });
    const snapshot = await collectHolderSnapshot(source.options);
    assert.equal(reads, 2);
    assert.deepEqual(snapshot.holders.map((item) => [item.status, item.balanceRaw]), [["verified", "17"], ["unavailable", null], ["not_examined", null]]);
    assert.equal(snapshot.balances.status, "partial");
    assert.match(snapshot.balances.reason!, /throttling/);
    assert.doesNotThrow(() => validate(snapshot));
  }
});

test("holder-index throttling and a prior RPC throttle leave balance candidates not examined", async () => {
  const failure = new UpstreamFailure(true, { httpStatus: 429 });
  for (const prior of [false, true]) {
    let pageReads = 0, balanceReads = 0;
    const snapshot = await collectHolderSnapshot(fixture({
      throttleError: () => prior ? failure : null,
      page: async () => { pageReads++; throw failure; }, request: async () => { balanceReads++; return word(1n); },
    }).options);
    assert.equal(pageReads, prior ? 0 : 1);
    assert.equal(balanceReads, 0);
    assert.equal(snapshot.discovery.status, prior ? "not_examined" : "unavailable");
    assert.equal(snapshot.balances.status, "not_examined");
    assert.equal(snapshot.holders[0].status, "not_examined");
    assert.match(snapshot.balances.reason!, /throttling/);
    assert.doesNotThrow(() => validate(snapshot));
  }
});

test("no holder phase allocation performs no requests and never converts unknown balances to zero", async () => {
  const source = fixture({}, 0); const snapshot = await collectHolderSnapshot(source.options);
  assert.equal(source.calls(), 0);
  assert.equal(snapshot.discovery.status, "not_examined");
  assert.equal(snapshot.balances.status, "not_examined");
  assert.equal(snapshot.holders[0].balanceRaw, null);
  assert.doesNotThrow(() => validate(snapshot));
});

test("holder acquisition has no fifty-wallet ceiling and follows bounded cursor pages", async () => {
  let page = 0;
  const items = Array.from({ length: 70 }, (_, index) => ({ address: address(index + 100) }));
  const source = fixture({ observedWallets: [], page: async () => page++ === 0 ? { items: items.slice(0, 50), nextCursor: { value: "1", address_hash: items[49].address } } : { items: items.slice(50), nextCursor: null } }, 100);
  const snapshot = await collectHolderSnapshot(source.options);
  assert.equal(snapshot.discovery.pages, 2);
  assert.equal(snapshot.holders.length, 70);
  assert.equal(snapshot.balances.verifiedWallets, 70);
  assert.equal(snapshot.balances.status, "complete");
});

test("repeated indexed cursors stop with partial discovery while duplicate candidate addresses deduplicate", async () => {
  const source = fixture({ page: async () => ({ items: [{ address: A }, { address: B }, { address: B }], nextCursor: { value: "1" } }) });
  const snapshot = await collectHolderSnapshot(source.options);
  assert.equal(snapshot.discovery.pages, 2);
  assert.equal(snapshot.discovery.addresses, 2);
  assert.equal(snapshot.discovery.status, "partial");
  assert.match(snapshot.discovery.reason ?? "", /repeated a cursor/);
});

test("malformed balance words, supply inconsistencies, and mismatched discovery token identities reject", async () => {
  for (const value of ["0x", "0x01", word(1n) + "00", word(2n ** 256n), -1, 123]) {
    await assert.rejects(collectHolderSnapshot(fixture({ request: async () => value }).options), ProviderIntegrityError);
  }
  await assert.rejects(collectHolderSnapshot(fixture({ totalSupplyRaw: "1" }).options), ProviderIntegrityError);
  await assert.rejects(collectHolderSnapshot(fixture({ page: async () => ({ items: [], nextCursor: null, tokenAddress: B }) }).options), ProviderIntegrityError);
});

test("holder cancellation, deadlines, and unknown terminal errors propagate rather than claim incomplete success", async () => {
  for (const failure of [new Error("Synthetic terminal failure"), new DOMException("Synthetic deadline", "TimeoutError")]) {
    await assert.rejects(collectHolderSnapshot(fixture({ page: async () => { throw failure; } }).options), (error: unknown) => error === failure);
    await assert.rejects(collectHolderSnapshot(fixture({ request: async () => { throw failure; } }).options), (error: unknown) => error === failure);
  }
  const parent = new AbortController(), reason = new Error("Synthetic holder cancellation");
  await assert.rejects(collectHolderSnapshot(fixture({ signal: parent.signal, page: async () => { parent.abort(reason); return { items: [], nextCursor: null }; } }).options), (error: unknown) => error === reason);
  const budget = await collectHolderSnapshot(fixture({ request: async () => { throw new ProviderBudgetError(); } }).options);
  assert.equal(budget.balances.status, "unavailable");
});

test("shared snapshot validation rejects altered identities, count/status lies, amounts and unsafe URLs", async () => {
  const original = await collectHolderSnapshot(fixture().options);
  const changes = [
    (snapshot: HolderSnapshot) => { snapshot.tokenAddress = B; },
    (snapshot: HolderSnapshot) => { snapshot.block.hash = `0x${"b".repeat(64)}`; },
    (snapshot: HolderSnapshot) => { snapshot.totalSupplyRaw = "100"; },
    (snapshot: HolderSnapshot) => { snapshot.balances.verifiedWallets++; },
    (snapshot: HolderSnapshot) => { snapshot.holders[0].status = "not_examined"; },
    (snapshot: HolderSnapshot) => { snapshot.holders.push(snapshot.holders[0]); },
    (snapshot: HolderSnapshot) => { snapshot.holders[0].balanceRaw = (2n ** 256n).toString(); },
    (snapshot: HolderSnapshot) => { snapshot.discovery.sourceUrl = "https://evil.example/"; },
    (snapshot: HolderSnapshot) => { Reflect.set(snapshot.discovery, "finalizedCensus", true); },
  ];
  for (const mutate of changes) { const snapshot = structuredClone(original); mutate(snapshot); assert.throws(() => validate(snapshot)); }
  const invalid = structuredClone(original); Reflect.set(invalid.holders[0], "balanceRaw", 10);
  assert.equal(holderSnapshotSchema.safeParse(invalid).success, false);
});

test("public Blockscout holder transport is keyless, uses only a fixed path, and preserves integer cursors exactly", async () => {
  const configuration = readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org" });
  const value = maximum.toString(); const requests: { url: URL; headers: Headers }[] = [];
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(url)), headers: new Headers(init?.headers) });
    return new Response(`{"items":[{"address":{"hash":"${A}"},"value":"999"},{"address_hash":{"hash":"${B}"}}],"next_page_params":{"address_hash":"${B}","value":${value},"items_count":50},"token":{"address_hash":"${token}"}}`);
  });
  try {
    const transport = createProviderTransport(configuration);
    const first = await transport.holderPage!(token, null);
    assert.equal(first.nextCursor?.value, value);
    assert.deepEqual(first.items, [{ address: A }, { address: B }]);
    await transport.holderPage!(token, first.nextCursor);
    assert.equal(requests[1].url.origin, "https://base.blockscout.com");
    assert.equal(requests[1].url.pathname, `/api/v2/tokens/${token}/holders`);
    assert.equal(requests[1].url.searchParams.get("value"), value);
    assert.equal(requests[1].headers.get("authorization"), null);
    await assert.rejects(transport.holderPage!(token, { url: "https://127.0.0.1" }), ProviderIntegrityError);
    assert.equal(requests.length, 2);
  } finally { mocked.mock.restore(); }
});

test("configured Blockscout PRO holders use the fixed Base path and header auth with matching public provenance", async () => {
  const configuration = readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org", BLOCKSCOUT_API_KEY: "synthetic-test-secret" });
  let requests = 0;
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(String(url), `https://api.blockscout.com/8453/api/v2/tokens/${token}/holders`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-test-secret");
    assert.equal(new URL(String(url)).search, "");
    return new Response(JSON.stringify({ items: [{ address: { hash: A } }], next_page_params: null }));
  });
  try {
    const transport = createProviderTransport(configuration), sourceUrl = transport.holderSourceUrl!(token);
    const page = await transport.holderPage!(token, null);
    assert.equal(requests, 1);
    const snapshot = await collectHolderSnapshot(fixture({ sourceUrl, page: async () => page }).options);
    assert.equal(snapshot.discovery.sourceUrl, sourceUrl);
    assert.doesNotThrow(() => validate(snapshot));
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-test-secret/);
    await assert.rejects(collectHolderSnapshot(fixture({ sourceUrl: "https://api.blockscout.com/1/api/v2/tokens/0x0000000000000000000000000000000000000001/holders" }).options), ProviderIntegrityError);
  } finally { mocked.mock.restore(); }
});

test("public holder transport rejects malformed identities instead of treating the page as empty", async () => {
  const configuration = readProviderConfiguration({ BASE_RPC_URL: "https://mainnet.base.org" });
  let response: unknown = { items: [{ address: { hash: "invalid" } }], next_page_params: null };
  const mocked = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(response)));
  try {
    const transport = createProviderTransport(configuration);
    await assert.rejects(transport.holderPage!(token, null), ProviderIntegrityError);
    response = { items: [], next_page_params: null, token: { address_hash: B } };
    await assert.rejects(transport.holderPage!(token, null), ProviderIntegrityError);
  } finally { mocked.mock.restore(); }
});
