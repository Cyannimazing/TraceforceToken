import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "../../src/domain/investigations/types";
import { collectTokenWebPresence } from "../../src/providers/token-websites-core";

const token = `0x${"11".repeat(20)}` as Address;
const other = `0x${"22".repeat(20)}` as Address;
const pool = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const pair = (n: number, websites: string[], overrides = {}) => ({ chainId: "base", pairAddress: pool(n), baseToken: { address: token }, quoteToken: { address: other }, info: { websites: websites.map((url) => ({ url })) }, ...overrides });
const jsonFetch = (payload: unknown) => (async () => Response.json(payload)) as typeof fetch;

test("website discovery uses one fixed HTTPS lookup and exact base-token identity", async () => {
  const calls: string[] = [];
  const result = await collectTokenWebPresence(token, { fetch: (async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    assert.equal(init?.method, "GET"); assert.equal(init?.headers && "authorization" in init.headers, false);
    return Response.json([pair(1, ["https://project.org/#about"]), pair(2, ["https://wrong-chain.org"], { chainId: "ethereum" }), pair(3, ["https://quote-only.org"], { baseToken: { address: other }, quoteToken: { address: token } })]);
  }) as typeof fetch });
  assert.deepEqual(calls, [`https://api.dexscreener.com/token-pairs/v1/base/${token}`]);
  assert.equal(result.status, "reported"); assert.equal(result.matchedPairs, 1);
  assert.deepEqual(result.websites, [{ url: "https://project.org/", pairAddresses: [pool(1)] }]);
});

test("website discovery preserves distinct pool reports and deduplicates exact links/references", async () => {
  const result = await collectTokenWebPresence(token, { fetch: jsonFetch([pair(1, ["https://one.org", "https://two.org"]), pair(2, ["https://one.org/"]), pair(2, ["https://one.org/"])]) });
  assert.equal(result.matchedPairs, 2);
  assert.deepEqual(result.websites, [{ url: "https://one.org/", pairAddresses: [pool(1), pool(2)] }, { url: "https://two.org/", pairAddresses: [pool(1)] }]);
});

test("website discovery skips recognized 32-byte pool IDs without losing usable address-based metadata", async () => {
  const idPair = pair(2, ["https://unsupported-pool.org"], { pairAddress: `0x${"ab".repeat(32)}` });
  const mixed = await collectTokenWebPresence(token, { fetch: jsonFetch([pair(1, ["https://project.org"]), idPair]) });
  assert.equal(mixed.status, "reported"); assert.equal(mixed.matchedPairs, 1);
  assert.deepEqual(mixed.websites, [{ url: "https://project.org/", pairAddresses: [pool(1)] }]);
  assert.match(mixed.reason!, /unsupported 32-byte pool IDs/);
  const unsupportedOnly = await collectTokenWebPresence(token, { fetch: jsonFetch([idPair]) });
  assert.equal(unsupportedOnly.status, "not_listed"); assert.equal(unsupportedOnly.matchedPairs, 0);
  assert.deepEqual(unsupportedOnly.websites, []);
  assert.match(unsupportedOnly.reason!, /no usable website listing was examined/);
});

test("website discovery distinguishes absent metadata from unavailable and rejects unsafe links", async () => {
  const absent = await collectTokenWebPresence(token, { fetch: jsonFetch([pair(1, [])]) });
  assert.equal(absent.status, "not_listed"); assert.match(absent.reason!, /did not report/);
  const empty = await collectTokenWebPresence(token, { fetch: jsonFetch([]) });
  assert.equal(empty.status, "not_listed"); assert.match(empty.reason!, /No matching/);
  const rejected = await collectTokenWebPresence(token, { fetch: jsonFetch([pair(1, ["http://unsafe.org", "javascript:alert(1)", "https://user:secret@project.org", "https://localhost", "https://127.0.0.1", "https://project.org:444/"])]) });
  assert.equal(rejected.status, "not_listed"); assert.deepEqual(rejected.websites, []); assert.match(rejected.reason!, /rejected/);
  const failed = await collectTokenWebPresence(token, { fetch: (async () => { throw new Error("sensitive upstream detail"); }) as typeof fetch });
  assert.equal(failed.status, "unavailable"); assert.doesNotMatch(JSON.stringify(failed), /sensitive/);
});

test("website discovery bounds response bytes, pair count and distinct sites", async () => {
  const oversized = await collectTokenWebPresence(token, { fetch: (async () => new Response(" ".repeat(256 * 1024 + 1))) as typeof fetch });
  assert.equal(oversized.status, "unavailable");
  const excessive = await collectTokenWebPresence(token, { fetch: jsonFetch(Array.from({ length: 101 }, (_, index) => pair(index, []))) });
  assert.equal(excessive.status, "unavailable");
  const bounded = await collectTokenWebPresence(token, { fetch: jsonFetch([pair(1, Array.from({ length: 7 }, (_, index) => `https://site${index}.org`))]) });
  assert.equal(bounded.websites.length, 5); assert.match(bounded.reason!, /Only five/);
});

test("website discovery rejects malformed response and HTTP failure without reading error bodies", async () => {
  for (const payload of [{ pairs: [] }, [pair(1, [], { pairAddress: "not-a-pool" })], [pair(1, [], { info: { websites: {} } })]]) {
    assert.equal((await collectTokenWebPresence(token, { fetch: jsonFetch(payload) })).status, "unavailable");
  }
  const result = await collectTokenWebPresence(token, { fetch: (async () => new Response("upstream secret", { status: 429 })) as typeof fetch });
  assert.equal(result.status, "unavailable"); assert.doesNotMatch(JSON.stringify(result), /upstream secret/);
});

test("website discovery aborts promptly even when injected fetch ignores its signal", async () => {
  const controller = new AbortController();
  const reason = new Error("request disconnected");
  const operation = collectTokenWebPresence(token, { signal: controller.signal, fetch: (async () => new Promise<Response>(() => undefined)) as typeof fetch });
  controller.abort(reason);
  await assert.rejects(operation, (error) => error === reason);
});

test("website discovery owns its deadline through stalled body reads", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const response = new Response(new ReadableStream<Uint8Array>({ start() {} }));
  const operation = collectTokenWebPresence(token, { fetch: (async () => response) as typeof fetch });
  await Promise.resolve(); await Promise.resolve();
  context.mock.timers.tick(5_001);
  const result = await operation;
  assert.equal(result.status, "unavailable"); assert.match(result.reason!, /deadline/);
});
