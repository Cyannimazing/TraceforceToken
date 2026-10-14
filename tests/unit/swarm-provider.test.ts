import assert from "node:assert/strict";
import test from "node:test";
import { fetchSwarmAssessment, SwarmProviderError } from "../../src/providers/swarm/core";
import { validateSwarmAssessmentSnapshot } from "../../src/domain/investigations/swarm-assessment";

const token = "0x1111111111111111111111111111111111111111", otherToken = "0x2222222222222222222222222222222222222222";
const at = "2026-10-13T12:00:00.000Z", timestamp = Date.parse(at) / 1000;
const now = () => new Date(at);
function wireResult() {
  return {
    token, chain: "base", scanned_at: timestamp, score: 45, band: "DANGER",
    parts: { swarm: 0, fresh: 20, insiders: 15, concentration: 0, snipers: 10, dev: 0 },
    gates: ["Synthetic source warning"],
    metrics: { hands: 11, wallets: 11, impact: 0.9999, biggest: 0.838, fresh: 0, insiders: 0, snipers: 0.0188, concentration: 0.9865, dev: 0.838 },
    header: { name: "Synthetic source fixture", symbol: "TEST", decimals: 18, supply: 7.4e27, holders_count: 13,
      price_usd: 1.694e-10, mcap: 1, liquidity_usd: 0.01, vol24h: 7359.92, change24h: -100, age_h: 23.1,
      dex: "uniswap", pair: otherToken, socials: [], image: null },
    judge: { model: "swarm-judge-1", decision: "AVOID", confidence: 0.757, p: { avoid: 0.757, caution: 0.239, ok: 0.004 },
      evidence: [{ k: "score 45", avoid: 0.606, caution: 0.507, ok: 0.008 }, { k: "hard rule: DANGER band", avoid: 0.6 }, { k: "one hand can dump", avoid: 0.4 }],
      features: { score: 45, hands_ratio: 1, biggest_swarm: 0.838, dump_impact: 0.9999, snipers: 0.0188, liquidity_usd: 0.01 },
      why: ["Synthetic reason"], receipt: "rcpt_synthetic", bar: 0.7, escalate: false, route: "act: confident decision", latency_ms: 0.08, cost_usd: 0 },
    holders: [{ sourceNumber: 7.4e27 }], timeline: [{ synthetic: true }],
  };
}
const json = (value: unknown, status = 200, headers: Record<string, string> = { date: new Date(at).toUTCString() }) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const isCode = (code: string) => (error: unknown) => error instanceof SwarmProviderError && error.code === code;

function providerMock(result: unknown = wireResult(), pending = false) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/api/scan")) return json({ job: "synthetic-job" });
    if (url.includes("/api/events?")) return json({ done: !pending || calls.filter((call) => call.url.includes("/api/events?")).length > 1,
      events: [{ type: "synthetic-progress" }], token, chain: "base" });
    if (url.includes("/api/result?")) return json({ result, history: ["MUST_NOT_BE_RETAINED"] });
    throw new Error("Unexpected provider request");
  };
  return { fetcher, calls };
}

test("fresh source job returns the actual judge and bounded source numbers without copying history or exact chain claims", async () => {
  const { fetcher, calls } = providerMock(wireResult(), true);
  const result = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: fetcher, now, pollIntervalMs: 0 });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/api/scan", "/api/events", "/api/events", "/api/result"]);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { token, chain: "base", fresh: true });
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new URL(calls[2].url).searchParams.get("after"), "1");
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://swarmengine.tech");
    assert.equal(call.init?.redirect, "error"); assert.equal(call.init?.cache, "no-store");
    assert.equal(call.init?.credentials, "omit");
    assert.ok(call.init?.signal instanceof AbortSignal);
    assert.equal(new Headers(call.init?.headers).has("authorization"), false);
  }
  assert.equal(result.source, "swarm"); assert.equal(result.status, "reported");
  assert.equal(result.freshRequested, true); assert.equal(result.scannedAt, at);
  assert.equal(result.transport?.freshness, "source-window-verified");
  assert.equal(result.transport?.start.sourceDate, at);
  assert.equal(result.transport?.jobId, "synthetic-job");
  assert.equal(result.score, 45); assert.equal(result.judge.decision, "AVOID");
  assert.deepEqual(result.judge.p, { avoid: 0.757, caution: 0.239, ok: 0.004 });
  assert.equal(result.judge.evidence[1].avoid, 0.6);
  assert.equal(result.judge.receipt, "rcpt_synthetic");
  assert.equal(typeof result.header.supply, "number"); assert.equal(result.header.supply, 7.4e27);
  assert.equal(result.header.price_usd, 1.694e-10);
  for (const excluded of ["holders", "history", "timeline", "image", "socials", "MUST_NOT_BE_RETAINED"])
    assert.equal(JSON.stringify(result).includes(`"${excluded}"`), false);
  assert.deepEqual(validateSwarmAssessmentSnapshot(result, token.toUpperCase().replace("0X", "0x")), result);
});

test("source shape validation rejects wrong identities, stale results and malformed judge probabilities without a cache fallback", async () => {
  const mutations: [(value: ReturnType<typeof wireResult>) => void, string][] = [
    [(value) => { value.token = otherToken; }, "IDENTITY_MISMATCH"],
    [(value) => { value.chain = "ethereum"; }, "IDENTITY_MISMATCH"],
    [(value) => { value.scanned_at -= 60; }, "STALE_RESULT"],
    [(value) => { value.scanned_at += 600; }, "STALE_RESULT"],
    [(value) => { value.judge.p.avoid = 0.95; }, "INVALID_RESPONSE"],
    [(value) => { value.judge.p.ok = -0.1; }, "INVALID_RESPONSE"],
    [(value) => { value.judge.confidence = 0.1; }, "INVALID_RESPONSE"],
    [(value) => { value.metrics.hands = 12; }, "INVALID_RESPONSE"],
    [(value) => { value.parts.fresh = 21; }, "INVALID_RESPONSE"],
    [(value) => { value.judge.evidence[0].avoid = -1; }, "INVALID_RESPONSE"],
  ];
  for (const [mutate, code] of mutations) {
    const raw = wireResult(); mutate(raw);
    const { fetcher, calls } = providerMock(raw);
    await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { fetch: fetcher, now }), isCode(code));
    assert.equal(calls.length, 3, "an invalid completed result is not retried");
    assert.equal(calls.some((call) => call.url.includes("/api/token/")), false);
  }
});

test("runtime snapshot validation is strict, binds its token URL and retains explicit unknowns", async () => {
  const { fetcher } = providerMock();
  const valid = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: fetcher, now });
  assert.throws(() => validateSwarmAssessmentSnapshot({ ...valid, unexpected: "discarding silently would weaken the report boundary" }, token));
  assert.throws(() => validateSwarmAssessmentSnapshot(valid, otherToken));
  assert.throws(() => validateSwarmAssessmentSnapshot({ ...valid, sourceUrl: `https://swarmengine.tech/t/base/${otherToken}` }, token));
  assert.throws(() => validateSwarmAssessmentSnapshot({ ...valid, freshRequested: false }, token));
  assert.throws(() => validateSwarmAssessmentSnapshot({ ...valid, checkedAt: "2026-10-12T12:00:00.000Z" }, token));
  valid.header.price_usd = null; valid.metrics.snipers = null; valid.parts.snipers = null;
  const unknown = validateSwarmAssessmentSnapshot(valid, token);
  assert.equal(unknown.header.price_usd, null); assert.equal(unknown.metrics.snipers, null); assert.equal(unknown.parts.snipers, null);
});

test("upstream failures remain sanitized and never start another job", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
      fetch: async () => { calls++; return json({ error: "UPSTREAM_PRIVATE_BODY" }, status); }, now,
    }), (error: unknown) => error instanceof SwarmProviderError && error.code === (status === 429 ? "RATE_LIMITED" : [401, 403].includes(status) ? "ACCESS_DENIED" : "UNAVAILABLE") && !error.message.includes("UPSTREAM_PRIVATE_BODY"));
    assert.equal(calls, 1);
  }
  const { fetcher } = providerMock();
  await assert.rejects(fetchSwarmAssessment("not-an-address", new AbortController().signal, { fetch: fetcher, now }), isCode("INVALID_INPUT"));
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { fetch: async () => json({ error: "SENSITIVE_JOB_ERROR" }), now }), isCode("JOB_FAILED"));
});

test("native fetch failure is unavailable while malformed JSON and UTF-8 remain invalid responses", async () => {
  let calls = 0;
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { now, fetch: async () => {
    calls++; throw new TypeError("PRIVATE_FETCH_FAILURE");
  } }), (error: unknown) => error instanceof SwarmProviderError && error.code === "UNAVAILABLE" && !error.message.includes("PRIVATE_FETCH_FAILURE"));
  assert.equal(calls, 1, "a failed fresh-job POST must not be repeated");
  for (const body of ["{broken", new Uint8Array([0xff, 0xfe])]) {
    calls = 0;
    await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { now, fetch: async () => {
      calls++; return new Response(body, { headers: { "content-type": "application/json" } });
    } }), isCode("INVALID_RESPONSE"));
    assert.equal(calls, 1);
  }
});

test("one transient poll read can recover on the same job and cursor without consuming another logical poll", async () => {
  const mock = providerMock(wireResult(), true), calls: { url: string; method: string | undefined }[] = [];
  let failed = false;
  const source = await fetchSwarmAssessment(token, new AbortController().signal, { now, maxPolls: 2, pollIntervalMs: 0, fetch: async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method });
    if (new URL(url).pathname === "/api/events" && new URL(url).searchParams.get("after") === "1" && !failed) {
      failed = true; throw new TypeError("PRIVATE_TRANSIENT_NETWORK_FAILURE");
    }
    return mock.fetcher(input, init);
  } });
  assert.equal(source.judge.decision, "AVOID"); assert.equal(source.transport!.jobId, "synthetic-job");
  assert.equal(calls.length, 5, "one POST, two logical polls, one result read and exactly one extra GET");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  const polls = calls.filter((call) => new URL(call.url).pathname === "/api/events");
  assert.deepEqual(polls.map((call) => new URL(call.url).searchParams.get("after")), ["0", "1", "1"]);
  assert.equal(polls[1].url, polls[2].url);
  assert.ok(calls.slice(1).every((call) => new URL(call.url).searchParams.get("job") === "synthetic-job"));
});

test("one transient result HTTP5xx can recover without reading its error body or starting another job", async (t) => {
  const mock = providerMock(), calls: string[] = [];
  const refused = new Response("PRIVATE_5XX_BODY", { status: 502 });
  const reader = t.mock.method(refused.body!, "getReader", () => { throw new Error("Error bodies must not be read."); });
  const cancel = t.mock.method(refused.body!, "cancel", async () => undefined);
  let failed = false;
  const source = await fetchSwarmAssessment(token, new AbortController().signal, { now, fetch: async (input, init) => {
    const url = String(input); calls.push(url);
    if (new URL(url).pathname === "/api/result" && !failed) { failed = true; return refused; }
    return mock.fetcher(input, init);
  } });
  assert.equal(source.score, 45); assert.equal(calls.length, 4);
  assert.equal(calls[2], calls[3]); assert.equal(mock.calls.filter((call) => call.init?.method === "POST").length, 1);
  assert.equal(reader.mock.calls.length, 0); assert.equal(cancel.mock.calls.length, 1);
});

test("poll and result reads share one extra-attempt budget for the entire owned job", async () => {
  const mock = providerMock(), calls: string[] = [];
  let failedPoll = false;
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { now, fetch: async (input, init) => {
    const url = String(input); calls.push(url);
    if (new URL(url).pathname === "/api/events" && !failedPoll) { failedPoll = true; throw new TypeError("PRIVATE_NETWORK_FAILURE"); }
    if (new URL(url).pathname === "/api/result") return new Response("PRIVATE_RESULT_FAILURE", { status: 503 });
    return mock.fetcher(input, init);
  } }), isCode("UNAVAILABLE"));
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ["/api/scan", "/api/events", "/api/events", "/api/result"]);
  assert.equal(calls[1], calls[2]);
});

test("idempotent reads do not retry access denial, throttles, malformed bodies or completed job errors", async () => {
  const failures: { response: () => Response; code: string }[] = [
    ...[401, 403, 429].map((status) => ({ response: () => json({ error: "PRIVATE_BODY" }, status), code: status === 429 ? "RATE_LIMITED" : "ACCESS_DENIED" })),
    { response: () => new Response("{broken", { headers: { "content-type": "application/json" } }), code: "INVALID_RESPONSE" },
    { response: () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), code: "INVALID_RESPONSE" },
    { response: () => json({ error: "PRIVATE_JOB_FAILURE" }), code: "JOB_FAILED" },
  ];
  for (const failure of failures) {
    let calls = 0;
    await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { now, fetch: async () => ++calls === 1 ? json({ job: "same-job" }) : failure.response() }), isCode(failure.code));
    assert.equal(calls, 2);
  }
});

test("cancelled and timed-out reads cannot spend another retry or reset the original deadline", async () => {
  const reason = new Error("owned parent cancellation"), controller = new AbortController(); let calls = 0;
  await assert.rejects(fetchSwarmAssessment(token, controller.signal, { now, fetch: async () => {
    if (++calls === 1) return json({ job: "owned-job" });
    controller.abort(reason); throw new TypeError("PRIVATE_NETWORK_FAILURE");
  } }), (error) => error === reason);
  assert.equal(calls, 2, "abort before a retry prevents another physical read");
  calls = 0;
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { now, timeoutMs: 20, fetch: async () => {
    if (++calls === 1) return json({ job: "owned-job" });
    if (calls === 2) throw new TypeError("PRIVATE_NETWORK_FAILURE");
    return new Promise<Response>(() => undefined);
  } }), isCode("TIMEOUT"));
  assert.equal(calls, 3, "a non-cooperative retried read remains inside the one owned timeout");
  const duringRetry = new AbortController(); calls = 0;
  await assert.rejects(fetchSwarmAssessment(token, duringRetry.signal, { now, fetch: async () => {
    if (++calls === 1) return json({ job: "owned-job" });
    if (calls === 2) throw new TypeError("PRIVATE_NETWORK_FAILURE");
    queueMicrotask(() => duringRetry.abort(reason)); return new Promise<Response>(() => undefined);
  } }), (error) => error === reason);
  assert.equal(calls, 3);
});

test("polling is bounded and never mistakes a pending job for a completed assessment", async () => {
  let calls = 0;
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: async () => ++calls === 1 ? json({ job: "pending-job" }) : json({ done: false, events: [] }),
    now, maxPolls: 2, pollIntervalMs: 0,
  }), isCode("POLL_LIMIT"));
  assert.equal(calls, 3);
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: async () => json({ job: "../foreign-host?" }), now,
  }), isCode("INVALID_RESPONSE"));
});

test("parent abort and owned deadline stop even non-cooperative fetch and body reads", async () => {
  const before = new AbortController(), reason = new Error("owned cancellation"); before.abort(reason);
  let calls = 0;
  await assert.rejects(fetchSwarmAssessment(token, before.signal, { fetch: async () => { calls++; throw new Error("must not run"); } }), (error) => error === reason);
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = fetchSwarmAssessment(token, controller.signal, { fetch: () => new Promise<Response>(() => undefined), now });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: () => new Promise<Response>(() => undefined), now, timeoutMs: 10,
  }), isCode("TIMEOUT"));
  let canceled = false;
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined), cancel: () => { canceled = true; } }), { headers: { "content-type": "application/json" } }), now, timeoutMs: 10,
  }), isCode("TIMEOUT"));
  assert.equal(canceled, true);
});

test("decoded bodies, UTF-8, and progress identity stay bounded and validated", async () => {
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: async () => new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }), now,
  }), isCode("INVALID_RESPONSE"));
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: async () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } }), now,
  }), isCode("INVALID_RESPONSE"));
  let calls = 0;
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: async () => ++calls === 1 ? json({ job: "valid" }) : json({ done: false, events: [], token: otherToken, chain: "base" }), now,
  }), isCode("IDENTITY_MISMATCH"));
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: async () => new Response('{"job":"valid"}', { headers: { "content-type": "text/html" } }), now,
  }), isCode("INVALID_RESPONSE"));
});

test("freshness uses the source HTTP clock despite large local clock offsets", async () => {
  for (const offset of [-86_400_000, 86_400_000]) {
    const { fetcher } = providerMock();
    const snapshot = await fetchSwarmAssessment(token, new AbortController().signal, {
      fetch: fetcher, now: () => new Date(Date.parse(at) + offset),
    });
    assert.equal(snapshot.scannedAt, at);
    assert.equal(snapshot.transport?.freshness, "source-window-verified");
    assert.deepEqual(validateSwarmAssessmentSnapshot(snapshot, token), snapshot);
  }
});

test("missing, malformed, cached or inconsistent source clocks remain explicitly unverified", async () => {
  for (const mode of ["missing", "malformed", "cached", "changed"] as const) {
    const raw = wireResult(); raw.scanned_at -= 86_400;
    let calls = 0, tick = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      const data = calls === 1 ? { job: "clock-test" } : calls === 2 ? { done: true, events: [] } : { result: raw };
      const headers: Record<string, string> = mode === "missing" ? {} : mode === "malformed" ? { date: "yesterday" }
        : mode === "cached" ? { date: new Date(at).toUTCString(), age: "60" }
          : { date: new Date(Date.parse(at) + (calls === 3 ? 60_000 : 0)).toUTCString() };
      return json(data, 200, headers);
    };
    const snapshot = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: fetcher, now, monotonicNow: () => ++tick });
    assert.equal(snapshot.transport?.freshness, "unverified");
    assert.equal(snapshot.transport?.reason, mode === "changed" ? "inconsistent-source-clock" : "missing-source-clock");
    assert.deepEqual(validateSwarmAssessmentSnapshot(snapshot, token), snapshot);
    assert.throws(() => validateSwarmAssessmentSnapshot({ ...snapshot, transport: { ...snapshot.transport, freshness: "source-window-verified" } }, token));
  }
});

test("measured start round trip handles a scan beginning before its start response Date", async () => {
  const raw = wireResult(); raw.scanned_at -= 3;
  const ticks = [0, 0, 4000, 4000, 4100, 4100, 4200];
  const { fetcher } = providerMock(raw);
  const snapshot = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: fetcher, now, monotonicNow: () => ticks.shift()! });
  assert.equal(snapshot.transport?.freshness, "source-window-verified");
  raw.scanned_at -= 2;
  const secondTicks = [0, 0, 4000, 4000, 4100, 4100, 4200];
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now, monotonicNow: () => secondTicks.shift()! }), isCode("STALE_RESULT"));
});

test("candidate discovery is bounded, deduplicated, exact-address only and keeps roles without numeric balances", async () => {
  const creator = "0x3333333333333333333333333333333333333333", funder = "0x4444444444444444444444444444444444444444";
  const raw = { ...wireResult(), creator,
    holders: [{ address: otherToken, balance: 1e99, share: 0.9, signals: { funder, entry_from: creator } }, { address: creator, balance: 5 }],
    links: [{ a: creator, b: funder, label: "DO_NOT_RETAIN" }],
  };
  const snapshot = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now });
  assert.deepEqual(snapshot.candidates, [
    { address: creator, roles: ["creator", "entry-source", "holder", "link"] },
    { address: otherToken, roles: ["holder"] }, { address: funder, roles: ["funder", "link"] },
  ]);
  assert.equal(snapshot.candidatesTruncated, false);
  assert.equal(JSON.stringify(snapshot.candidates).includes("balance"), false);
  assert.equal(JSON.stringify(snapshot).includes("DO_NOT_RETAIN"), false);
  raw.holders = Array.from({ length: 300 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, "0")}`, balance: 1 }));
  const bounded = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now });
  assert.equal(bounded.candidates?.length, 256);
  assert.equal(bounded.candidatesTruncated, true);
  raw.holders[0].address = "not-an-address";
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now }), isCode("INVALID_RESPONSE"));
});

test("source job failures during polling, chain mismatches and unsupported link shapes reject safely", async () => {
  for (const [progress, code] of [[{ error: "PRIVATE" }, "JOB_FAILED"], [{ done: false, chain: "ethereum" }, "IDENTITY_MISMATCH"]] as const) {
    let calls = 0;
    await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
      fetch: async () => ++calls === 1 ? json({ job: "valid" }) : json(progress), now,
    }), isCode(code));
    assert.equal(calls, 2);
  }
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, {
    fetch: providerMock({ ...wireResult(), links: [{ inferredController: otherToken }] }).fetcher, now,
  }), isCode("INVALID_RESPONSE"));
});

test("a 32-byte pool ID preserves the complete assessment without becoming an RPC address", async () => {
  const raw = wireResult();
  raw.header.pair = `0x${"ab".repeat(32)}`;
  const snapshot = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now });
  assert.equal(snapshot.header.pair, raw.header.pair);
  assert.equal(snapshot.score, raw.score);
  raw.header.pair = `0x${"AB".repeat(32)}`;
  const mixed = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now });
  assert.equal(mixed.header.pair, raw.header.pair.toLowerCase());
  for (const pair of [`0x${"ab".repeat(31)}`, "https://untrusted.example/pool", "arbitrary pool ID"]) {
    raw.header.pair = pair;
    await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now }), isCode("INVALID_RESPONSE"));
  }
});

test("source graph preserves cluster zero, source shares, entry flags and counts without raw balances", async () => {
  const raw = { ...wireResult(),
    holders: [{ address: token, balance: 1e90, share: 0.999, share_supply: 0.25, cluster: 0, is_contract: false,
      label: null, signals: { kind: "mint", tx_count: 6263, dev: true, fresh: false, sniper: false, insider: false, from_dev: false } },
    { address: otherToken, share: 0.001, cluster: 0 }],
    clusters: [{ id: 0, wallets: [token, otherToken], share: 1 }],
    links: [{ a: token, b: otherToken, kind: "direct", level: "proven", via: "DO_NOT_RETAIN" }],
  };
  const snapshot = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now });
  assert.equal(snapshot.graph?.holders[0].clusterId, "0");
  assert.equal(snapshot.graph?.holders[0].share, 0.999);
  assert.equal(snapshot.graph?.holders[0].shareSupply, 0.25);
  assert.equal(snapshot.graph?.holders[0].entryKind, "mint");
  assert.equal(snapshot.graph?.holders[0].transactionCount, 6263);
  assert.equal(snapshot.graph?.holders[0].dev, true);
  assert.equal(snapshot.graph?.holders[1].fresh, null);
  assert.deepEqual(snapshot.graph?.clusters[0], { id: "0", wallets: [token, otherToken], share: 1 });
  assert.equal(snapshot.graph?.links[0].level, "proven");
  assert.equal(snapshot.graph?.truncated, false);
  assert.equal(JSON.stringify(snapshot.graph).includes("balance"), false);
  assert.equal(JSON.stringify(snapshot.graph).includes("DO_NOT_RETAIN"), false);
  assert.throws(() => validateSwarmAssessmentSnapshot({ ...snapshot, graph: { ...snapshot.graph, holders: [...snapshot.graph!.holders, snapshot.graph!.holders[0]] } }, token));
  assert.throws(() => validateSwarmAssessmentSnapshot({ ...snapshot, graph: { ...snapshot.graph, clusters: [{ id: "0", wallets: ["0x3333333333333333333333333333333333333333"], share: 1 }] } }, token));
  raw.holders[0].share = 1.01;
  await assert.rejects(fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now }), isCode("INVALID_RESPONSE"));
});

test("a returned empty holder cohort is distinct from missing source holder data", async () => {
  const raw = { ...wireResult(), holders: [], clusters: [], links: [] };
  const snapshot = await fetchSwarmAssessment(token, new AbortController().signal, { fetch: providerMock(raw).fetcher, now });
  assert.deepEqual(snapshot.graph, { holders: [], clusters: [], links: [], truncated: false });
  assert.equal(snapshot.header.holders_count, 13, "an empty examined cohort must not replace the source's wider holder count with zero");
});
