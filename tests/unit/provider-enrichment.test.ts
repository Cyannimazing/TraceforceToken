import assert from "node:assert/strict";
import test from "node:test";
import { fetchOptionalProviderEnrichment, readProviderEnrichmentConfig } from "../../src/providers/enrichment/core";
import { fetchBubblemapsEnrichment } from "../../src/providers/enrichment/bubblemaps";
import { fetchNansenEnrichment } from "../../src/providers/enrichment/nansen";
import { EnrichmentProviderError } from "../../src/providers/enrichment/transport";
import { validateProviderEnrichmentBundle } from "../../src/domain/investigations/provider-enrichment";

const token = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";
const funder = "0x3333333333333333333333333333333333333333";
const otherToken = "0x4444444444444444444444444444444444444444";
const at = "2026-10-13T12:00:00.000Z", now = () => new Date(at);
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const code = (expected: string) => (error: unknown) => error instanceof EnrichmentProviderError && error.code === expected;
function bubbleFixture() {
  return { metadata: { dt_update: at, ts_update: Date.parse(at) / 1000 },
    nodes: { top_holders: [{ address: wallet, address_details: { label: "Reported wallet", is_paid_label: false },
      holder_data: { amount: 7.4e27, rank: 1, share: 0.83 } }],
    magic_nodes: [{ address: funder, address_details: { label: "Paid attribution", is_paid_label: true } }], time_nodes: [] },
    relationships: [{ from_address: funder, to_address: wallet, rel_type: "GROUPED_TRANSFER",
      data: { total_transfers: 2, token_key: { chain: "base", address: otherToken }, total_value: 1e30 } }],
    clusters: [{ holders: [wallet], ownershipClaim: "DO_NOT_KEEP" }], metrics: { amount: 7.4e27 } };
}
function nansenFixture() {
  return { data: [{ address: wallet, address_label: "Reported basic label", ownership_percentage: 83.8, token_amount: 7.4e27,
    value_usd: 54000 }], pagination: { page: 1, per_page: 100, is_last_page: false } };
}

test("optional integrations make no network requests without credentials and disclose rights/Base restrictions", async () => {
  const result = await fetchOptionalProviderEnrichment(token, signal(), {}, { now, fetch: async () => { throw new Error("Must not call providers"); } });
  assert.equal(result.sources.length, 0);
  assert.deepEqual(result.capabilities, [{ provider: "bubblemaps", status: "not-configured" }, { provider: "nansen", status: "not-configured" },
    { provider: "arkham", status: "rights-required" }, { provider: "rugcheck", status: "unsupported-chain" }]);
});

test("Bubblemaps uses the authenticated fixed Base map endpoint and retains source leads without balances/ownership inference", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await fetchBubblemapsEnrichment(token.toUpperCase().replace("0X", "0x"), "private-bubble-key", signal(), {
    now, fetch: async (input, init) => { calls.push({ url: String(input), init }); return json(bubbleFixture()); },
  });
  assert.equal(calls.length, 1);
  const call = calls[0], url = new URL(call.url), headers = new Headers(call.init?.headers);
  assert.equal(url.origin, "https://api.bubblemaps.io"); assert.equal(url.pathname, `/v0/tokens/map/base/${token}`);
  assert.equal(url.searchParams.get("refresh"), "true"); assert.equal(url.searchParams.get("return_relationships"), "true");
  assert.equal(headers.get("X-ApiKey"), "private-bubble-key"); assert.equal(headers.has("apikey"), false);
  assert.equal(call.init?.redirect, "error"); assert.equal(call.init?.cache, "no-store"); assert.equal(call.init?.credentials, "omit");
  assert.equal(result.authority, "source-reported"); assert.equal(result.sourceObservedAt, at);
  assert.deepEqual(result.candidates, [{ address: wallet, role: "holder", label: "Reported wallet", reportedSharePercent: null },
    { address: funder, role: "context", label: null, reportedSharePercent: null }]);
  assert.deepEqual(result.relationships, [{ from: funder, to: wallet, kind: "transfer", reportedTokenAddress: otherToken, reportedTransferCount: 2 }]);
  for (const excluded of ["amount", "holder_data", "ownershipClaim", "clusters", "private-bubble-key", "Paid attribution"])
    assert.equal(JSON.stringify(result).includes(excluded), false);
});

test("Nansen restricts the request to basic individual holders, explicitly includes dust and preserves missing measurements", async () => {
  let body: Record<string, unknown> | undefined;
  const fixture = nansenFixture(); delete (fixture.data[0] as { ownership_percentage?: number }).ownership_percentage;
  const result = await fetchNansenEnrichment(token, "private-nansen-key", signal(), { now, fetch: async (input, init) => {
    assert.equal(String(input), "https://api.nansen.ai/api/v1/tgm/holders");
    assert.equal(new Headers(init?.headers).get("apikey"), "private-nansen-key");
    body = JSON.parse(String(init?.body)); return json(fixture);
  } });
  assert.deepEqual(body, { chain: "base", token_address: token, aggregate_by_entity: false, label_type: "all_holders", premium_labels: false,
    pagination: { page: 1, per_page: 100 }, filters: { value_usd: { min: 0 } }, order_by: [{ field: "token_amount", direction: "DESC" }] });
  assert.equal(result.candidates[0].reportedSharePercent, null); assert.equal(result.sourceObservedAt, null);
  assert.equal(result.coverage.limitReached, true); assert.equal(result.relationships.length, 0);
  assert.equal(JSON.stringify(result).includes("token_amount"), false);
});

test("overlapping Bubblemaps relationship rows deduplicate exact counts and reject conflicting source measurements", async () => {
  const exact = bubbleFixture();
  exact.relationships.push(structuredClone(exact.relationships[0]));
  const result = await fetchBubblemapsEnrichment(token, "key", signal(), { now, fetch: async () => json(exact) });
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0].reportedTransferCount, 2);
  const conflict = bubbleFixture();
  conflict.relationships.push({ ...structuredClone(conflict.relationships[0]), data: { ...conflict.relationships[0].data, total_transfers: 3 } });
  await assert.rejects(fetchBubblemapsEnrichment(token, "key", signal(), { now, fetch: async () => json(conflict) }), code("invalid-response"));
});

test("independent optional providers preserve a successful response while exposing the other provider's failure", async () => {
  const result = await fetchOptionalProviderEnrichment(token, signal(), { bubblemapsApiKey: "bubble-key", nansenApiKey: "nansen-key" }, { now,
    fetch: async (input) => String(input).startsWith("https://api.bubblemaps.io/") ? json(bubbleFixture()) : json({ error: "secret body" }, 429),
  });
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].provider, "bubblemaps");
  assert.equal(result.capabilities.find((item) => item.provider === "nansen")?.status, "rate-limited");
  assert.equal(JSON.stringify(result).includes("secret body"), false);
  assert.deepEqual(validateProviderEnrichmentBundle(result, token), result);
});

test("external relationships are retained as Base token-specific leads and cannot invent current holders", async () => {
  const fixture = bubbleFixture(); fixture.relationships[0].data.token_key.chain = "ethereum";
  const result = await fetchBubblemapsEnrichment(token, "key", signal(), { now, fetch: async () => json(fixture) });
  assert.equal(result.relationships.length, 0); assert.equal(result.candidates.length, 2);
  const nansen = await fetchNansenEnrichment(token, "key", signal(), { now, fetch: async () => json(nansenFixture()) });
  assert.equal(nansen.candidates[0].reportedSharePercent, 83.8);
});

test("malformed address, source time and non-finite/out-of-range percentages reject whole provider response", async () => {
  const badBubble = bubbleFixture(); badBubble.nodes.top_holders[0].address = "https://attacker.invalid";
  await assert.rejects(fetchBubblemapsEnrichment(token, "key", signal(), { now, fetch: async () => json(badBubble) }), code("invalid-response"));
  const future = bubbleFixture(); future.metadata.ts_update += 120;
  await assert.rejects(fetchBubblemapsEnrichment(token, "key", signal(), { now, fetch: async () => json(future) }), code("invalid-response"));
  const badNansen = nansenFixture(); badNansen.data[0].ownership_percentage = 101;
  await assert.rejects(fetchNansenEnrichment(token, "key", signal(), { now, fetch: async () => json(badNansen) }), code("invalid-response"));
  const duplicate = nansenFixture(); duplicate.data.push({ ...duplicate.data[0] });
  await assert.rejects(fetchNansenEnrichment(token, "key", signal(), { now, fetch: async () => json(duplicate) }), code("invalid-response"));
});

test("provider errors omit upstream response bodies and access failures cannot trigger additional requests", async () => {
  for (const [status, expected] of [[401, "access-denied"], [402, "access-denied"], [403, "access-denied"], [429, "rate-limited"], [503, "unavailable"]] as const) {
    let calls = 0;
    await assert.rejects(fetchNansenEnrichment(token, "key", signal(), { now, fetch: async () => { calls++; return json({ secret: "private-error" }, status); } }),
      (error) => code(expected)(error) && !String(error).includes("private-error"));
    assert.equal(calls, 1);
  }
});

test("bounded transport rejects MIME, invalid JSON/UTF-8 and oversized streamed responses", async () => {
  const responses = [
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("{}", { headers: { "content-type": "application/jsonp" } }),
    new Response("{}", { headers: { "content-type": "text/application/json" } }),
    new Response("not-json", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array(2_097_153), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "2097153" } }),
  ];
  for (const response of responses) await assert.rejects(fetchNansenEnrichment(token, "key", signal(), { now, fetch: async () => response }), code("invalid-response"));
});

test("parent cancellation preserves its exact reason and owned deadlines cover both pending fetch and pending body", async () => {
  const parent = new AbortController(), reason = new Error("request-owned cancellation");
  const operation = fetchOptionalProviderEnrichment(token, parent.signal, { nansenApiKey: "key" }, { now, fetch: () => new Promise(() => undefined) });
  parent.abort(reason); await assert.rejects(operation, (error) => error === reason);
  await assert.rejects(fetchNansenEnrichment(token, "key", signal(), { now, timeoutMs: 10, fetch: () => new Promise(() => undefined) }), code("timeout"));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchNansenEnrichment(token, "key", signal(), { now, timeoutMs: 10,
    fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }) }), code("timeout"));
  assert.equal(cancelled, true);
});

test("runtime bundle validation rejects source mixing, invented capabilities and external links", async () => {
  const result = await fetchOptionalProviderEnrichment(token, signal(), { nansenApiKey: "key" }, { now, fetch: async () => json(nansenFixture()) });
  assert.throws(() => validateProviderEnrichmentBundle(result, otherToken));
  assert.throws(() => validateProviderEnrichmentBundle({ ...result, ignoredSecret: "must reject" }, token));
  assert.throws(() => validateProviderEnrichmentBundle({ ...result, sources: [{ ...result.sources[0], sourceUrl: "https://attacker.invalid" }] }, token));
  const forged = structuredClone(result); forged.capabilities[2].status = "available";
  assert.throws(() => validateProviderEnrichmentBundle(forged, token));
  const mixed = structuredClone(result); mixed.sources[0].tokenAddress = otherToken;
  assert.throws(() => validateProviderEnrichmentBundle(mixed, token));
  const bubble = await fetchOptionalProviderEnrichment(token, signal(), { bubblemapsApiKey: "key" }, { now, fetch: async () => json(bubbleFixture()) });
  bubble.sources[0].relationships.push(structuredClone(bubble.sources[0].relationships[0]));
  assert.throws(() => validateProviderEnrichmentBundle(bubble, token));
});

test("provider configuration rejects public/Vercel secrets, invalid credentials and unbounded deadlines without exposing values", () => {
  assert.deepEqual(readProviderEnrichmentConfig({ BUBBLEMAPS_API_KEY: " bubble-key ", ENRICHMENT_TIMEOUT_MS: "12000" }), { bubblemapsApiKey: "bubble-key", timeoutMs: 12000 });
  assert.throws(() => readProviderEnrichmentConfig({ NEXT_PUBLIC_NANSEN_API_KEY: "secret-key" }), /protected scan engine/);
  assert.throws(() => readProviderEnrichmentConfig({ VERCEL: "1", NANSEN_API_KEY: "secret-key" }), /protected scan engine/);
  assert.throws(() => readProviderEnrichmentConfig({ NANSEN_API_KEY: "private\nvalue" }), (error) => !String(error).includes("private"));
  assert.throws(() => readProviderEnrichmentConfig({ ENRICHMENT_TIMEOUT_MS: "30001" }), /configuration is invalid/);
});
