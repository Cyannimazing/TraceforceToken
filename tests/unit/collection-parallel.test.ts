import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { Address } from "../../src/domain/investigations/types";
import { createDeadline } from "../../src/lib/deadline";
import { collectChainAndMetadata } from "../../src/providers/base/collection-parallel";
import { collectTokenMetadata } from "../../src/providers/token-websites-core";

const token = `0x${"11".repeat(20)}` as Address;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("chain and the single metadata lookup start before either completes", async () => {
  const chain = deferred<string>(), metadata = deferred<string>(), bothStarted = deferred<void>();
  let chainStarted = false, metadataStarted = false, metadataCalls = 0, completed = false;
  const result = collectChainAndMetadata({
    collectDataset: () => { chainStarted = true; if (metadataStarted) bothStarted.resolve(); return chain.promise; },
    collectMetadata: () => { metadataCalls++; metadataStarted = true; if (chainStarted) bothStarted.resolve(); return metadata.promise; },
  }).then((value) => { completed = true; return value; });
  await bothStarted.promise;
  chain.resolve("verified chain");
  await Promise.resolve();
  assert.equal(completed, false, "both independent reads must finish before returning");
  metadata.resolve("reported metadata");
  assert.deepEqual(await result, { dataset: "verified chain", metadata: "reported metadata" });
  assert.equal(metadataCalls, 1);
});

test("chain failure cancels an active metadata fetch and preserves the original failure", async () => {
  const chain = deferred<string>(), fetchStarted = deferred<void>();
  const failure = new Error("Synthetic canonical mismatch");
  let metadataSignal: AbortSignal | undefined;
  const result = collectChainAndMetadata({
    collectDataset: () => chain.promise,
    collectMetadata: (signal) => collectTokenMetadata(token, { signal, fetch: async (_url, init) => {
      metadataSignal = init?.signal ?? undefined;
      fetchStarted.resolve();
      return new Promise<Response>((_resolve, reject) => metadataSignal!.addEventListener("abort", () => reject(metadataSignal!.reason), { once: true }));
    } }),
  });
  await fetchStarted.promise;
  chain.reject(failure);
  await assert.rejects(result, (error) => error === failure);
  assert.equal(metadataSignal?.aborted, true);
  assert.equal(metadataSignal?.reason, failure);
});

test("ordinary metadata unavailability preserves successful chain acquisition", async () => {
  let calls = 0;
  const result = await collectChainAndMetadata({
    collectDataset: async () => "verified chain",
    collectMetadata: (signal) => collectTokenMetadata(token, { signal, fetch: async () => { calls++; throw new TypeError("Synthetic upstream failure"); } }),
  });
  assert.equal(result.dataset, "verified chain");
  assert.equal(result.metadata.webPresence.status, "unavailable");
  assert.equal(result.metadata.marketSnapshot.status, "unavailable");
  assert.equal(calls, 1);
});

test("parent cancellation stops both tasks promptly and removes forwarding listeners", async () => {
  const parent = new AbortController(), started = deferred<void>(), reason = new Error("Synthetic visitor disconnect");
  const signals: AbortSignal[] = [];
  const pending = (signal: AbortSignal) => { signals.push(signal); if (signals.length === 2) started.resolve(); return new Promise<never>(() => undefined); };
  const result = collectChainAndMetadata({ signal: parent.signal, collectDataset: pending, collectMetadata: pending });
  await started.promise;
  parent.abort(reason);
  await assert.rejects(result, (error) => error === reason);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted && signal.reason === reason));
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.equal(getEventListeners(signals[0], "abort").length, 0);
});

test("unexpected metadata failure cancels the chain and handles its later rejection", async () => {
  const chain = deferred<string>(), started = deferred<void>(), failure = new Error("Synthetic metadata implementation failure");
  let chainSignal: AbortSignal | undefined;
  const result = collectChainAndMetadata({
    collectDataset: (signal) => { chainSignal = signal; started.resolve(); return chain.promise; },
    collectMetadata: async () => { await started.promise; throw failure; },
  });
  await assert.rejects(result, (error) => error === failure);
  assert.equal(chainSignal?.aborted, true);
  chain.reject(new Error("Synthetic late chain rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("already cancelled work starts neither read and completed work releases its parent", async () => {
  const parent = new AbortController(), reason = new Error("Already disconnected");
  parent.abort(reason);
  let calls = 0;
  const read = async () => { calls++; return "unexpected"; };
  await assert.rejects(collectChainAndMetadata({ signal: parent.signal, collectDataset: read, collectMetadata: read }), (error) => error === reason);
  assert.equal(calls, 0);
  const active = new AbortController();
  await collectChainAndMetadata({ signal: active.signal, collectDataset: read, collectMetadata: read });
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
});

test("one shared owned deadline bounds both reads", async () => {
  const deadline = createDeadline(15);
  try {
    const pending = () => new Promise<never>(() => undefined);
    await assert.rejects(collectChainAndMetadata({ signal: deadline.signal, collectDataset: pending, collectMetadata: pending }), (error) => error instanceof DOMException && error.name === "TimeoutError");
  } finally { deadline.dispose(); }
});

test("chain acquisition can consume the same metadata later without a second lookup or serial startup", async () => {
  const metadata = deferred<string>(), chainStarted = deferred<void>();
  let lookups = 0;
  const result = collectChainAndMetadata({
    collectMetadata: async () => { lookups++; return metadata.promise; },
    collectDataset: async (_signal, sameMetadata) => { chainStarted.resolve(); return `verified pool from ${await sameMetadata}`; },
  });
  await chainStarted.promise;
  metadata.resolve("reported selected pair");
  assert.deepEqual(await result, { dataset: "verified pool from reported selected pair", metadata: "reported selected pair" });
  assert.equal(lookups, 1);
});
