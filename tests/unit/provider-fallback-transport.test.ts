import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { readProviderConfiguration } from "../../src/providers/base/config";
import { isProviderThrottle, ProviderIntegrityError, ProviderLogRangeError, ProviderResponseLimitError, UpstreamFailure } from "../../src/providers/base/errors";
import { createProviderTransport, validateProviderDestination } from "../../src/providers/base/transport";

const primary = "https://mainnet.base.org/";
const secondary = "https://base-rpc.publicnode.com/";
const tertiary = "https://base.drpc.org/";
const configuration = () => readProviderConfiguration({ BASE_RPC_URL: primary, BASE_RPC_FALLBACK_URLS: `${secondary},${tertiary}` });
const publicDns = [{ address: "8.8.8.8" }];
function rpcResponse(init?: RequestInit, result: unknown = "0x2105") {
  const { id } = JSON.parse(String(init?.body)) as { id: number };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

test("RPC fallbacks are explicit, normalized, deduplicated and capped at two distinct alternatives", () => {
  assert.deepEqual(readProviderConfiguration({ BASE_RPC_URL: primary }).rpcFallbackUrls, []);
  const configured = readProviderConfiguration({ BASE_RPC_URL: primary, BASE_RPC_FALLBACK_URLS: `https://MAINNET.BASE.ORG:443, ${secondary}, ${secondary}, ${tertiary}` });
  assert.equal(configured.rpcUrl, primary);
  assert.deepEqual(configured.rpcFallbackUrls, [secondary, tertiary]);
  assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: primary, BASE_RPC_FALLBACK_URLS: `${secondary},${tertiary},https://base-mainnet.infura.io/` }), /at most two/);
  assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: primary, BASE_RPC_FALLBACK_URLS: `${secondary},` }), /approved/);
  assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: primary, BASE_RPC_FALLBACK_URLS: "x".repeat(16_385) }), /configuration length/);
});

test("every fallback uses the primary security policy without leaking configured values", () => {
  for (const endpoint of ["http://mainnet.base.org", "https://127.0.0.1", "https://mainnet.base.org.evil.example", "https://fixture-user:fixture-secret@mainnet.base.org", "https://mainnet.base.org/#fixture-secret", "file:///fixture-secret", "https://mainnet.base.org\\fixture-secret", "https://mainnet.base.org/\nfixture-secret"]) {
    assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: primary, BASE_RPC_FALLBACK_URLS: `${secondary},${endpoint}` }), (error: unknown) => error instanceof Error && !error.message.includes("fixture-secret") && !error.message.includes(endpoint));
  }
  assert.deepEqual(readProviderConfiguration({ NODE_ENV: "test", BASE_RPC_URL: primary, BASE_RPC_FALLBACK_URLS: "http://127.0.0.1:8545,http://[::1]:8546" }).rpcFallbackUrls, ["http://127.0.0.1:8545/", "http://[::1]:8546/"]);
});

test("recovery advances without network access and each RPC invocation makes one physical request", async () => {
  const urls: string[] = [];
  let unavailable = true;
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return unavailable ? new Response("unavailable", { status: 503 }) : rpcResponse(init);
  });
  try {
    const transport = createProviderTransport(configuration());
    await assert.rejects(transport.rpc("eth_chainId", []), (error: unknown) => error instanceof UpstreamFailure && error.retryable);
    assert.deepEqual(urls, [primary]);
    assert.equal(transport.rpcSource!(), "Base public RPC");
    assert.equal(transport.recoverRpc!(), true);
    assert.equal(transport.rpcSource!(), "PublicNode Base RPC");
    assert.deepEqual(urls, [primary], "recovery itself must not make chain or retry requests");
    unavailable = false;
    assert.equal(await transport.rpc("eth_chainId", []), "0x2105");
    assert.deepEqual(urls, [primary, secondary]);
    assert.equal(transport.recoverRpc!(), true);
    assert.equal(transport.rpcSource!(), "dRPC Base RPC");
    assert.equal(transport.recoverRpc!(), false);
    assert.equal(await transport.rpc("eth_chainId", []), "0x2105");
    assert.deepEqual(urls, [primary, secondary, tertiary]);
  } finally { mocked.mock.restore(); }
});

test("transport deduplicates canonical configured URLs without round-robin reuse", () => {
  const configured = configuration();
  const transport = createProviderTransport({ ...configured, rpcFallbackUrls: [primary, secondary, secondary] });
  assert.equal(transport.recoverRpc!(), true);
  assert.equal(transport.rpcSource!(), "PublicNode Base RPC");
  assert.equal(transport.recoverRpc!(), false);
  assert.equal(transport.rpcSource!(), "PublicNode Base RPC");
});

test("public source labels never expose host, URL path, query keys or user-controlled labels", () => {
  const cases = [
    [primary, "Base public RPC"], [secondary, "PublicNode Base RPC"], [tertiary, "dRPC Base RPC"],
    ["https://base-mainnet.g.alchemy.com/v2/fixture-secret", "Alchemy Base RPC"],
    ["https://base-mainnet.infura.io/v3/fixture-secret?key=fixture-secret", "Infura Base RPC"],
  ];
  for (const [endpoint, label] of cases) assert.equal(createProviderTransport(readProviderConfiguration({ BASE_RPC_URL: endpoint })).rpcSource!(), label);
  const custom = createProviderTransport(readProviderConfiguration({ BASE_RPC_URL: "https://fixture-secret.provider.example/private?token=fixture-secret", BASE_RPC_ALLOWED_HOSTS: "fixture-secret.provider.example", BASE_RPC_FALLBACK_URLS: secondary }));
  assert.equal(custom.rpcSource!(), "Configured Base RPC 1");
  assert.equal(custom.recoverRpc!(), true);
  assert.equal(custom.rpcSource!(), "PublicNode Base RPC");
});

test("integrity failures, unknown errors and nonretryable availability never rotate automatically", async () => {
  const requested: string[] = [];
  const sentinel = new Error("Synthetic non-provider failure");
  let mode: "json" | "envelope" | "unknown" | "forbidden" = "json";
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requested.push(String(url));
    if (mode === "unknown") throw sentinel;
    if (mode === "forbidden") return new Response("fixture-secret", { status: 403 });
    return new Response(mode === "json" ? "not JSON" : JSON.stringify({ jsonrpc: "2.0", id: -1, result: "0x2105" }));
  });
  try {
    const transport = createProviderTransport(configuration());
    await assert.rejects(transport.rpc("eth_chainId", []), ProviderIntegrityError);
    mode = "envelope";
    await assert.rejects(transport.rpc("eth_chainId", []), ProviderIntegrityError);
    mode = "unknown";
    await assert.rejects(transport.rpc("eth_chainId", []), (error: unknown) => error === sentinel);
    mode = "forbidden";
    await assert.rejects(transport.rpc("eth_chainId", []), (error: unknown) => error instanceof UpstreamFailure && !error.retryable && !error.message.includes("fixture-secret"));
    assert.equal(transport.rpcSource!(), "Base public RPC");
    assert.deepEqual(requested, Array(4).fill(primary));
    await assert.rejects(transport.rpc("eth_sendRawTransaction", []), /read-only/);
    assert.equal(requested.length, 4);
  } finally { mocked.mock.restore(); }
});

test("DNS preflight selects a healthy fallback after primary failure and preserves input", async () => {
  const configured = configuration();
  const before = structuredClone(configured);
  const checked: string[] = [];
  const ready = await validateProviderDestination(configured, undefined, async (hostname) => {
    checked.push(hostname);
    if (hostname === "mainnet.base.org") throw new Error("Synthetic DNS outage");
    return publicDns;
  });
  assert.deepEqual(checked, ["mainnet.base.org", "base-rpc.publicnode.com", "base.drpc.org"]);
  assert.equal(ready.rpcUrl, secondary);
  assert.deepEqual(ready.rpcFallbackUrls, [tertiary]);
  assert.deepEqual(configured, before);
  assert.notEqual(ready, configured);
});

test("an unavailable fallback does not disable a healthy primary", async () => {
  const ready = await validateProviderDestination(configuration(), undefined, async (hostname) => {
    if (hostname === "base-rpc.publicnode.com") throw new Error("Synthetic DNS outage");
    if (hostname === "base.drpc.org") return [];
    return publicDns;
  });
  assert.equal(ready.rpcUrl, primary);
  assert.deepEqual(ready.rpcFallbackUrls, []);
  await assert.rejects(validateProviderDestination(configuration(), undefined, async () => { throw new Error("Synthetic DNS outage"); }), (error: unknown) => error instanceof UpstreamFailure && error.retryable);
});

test("any prohibited DNS answer hard-fails even with another healthy configured endpoint", async () => {
  for (const addresses of [[{ address: "127.0.0.1" }], [...publicDns, { address: "10.0.0.1" }]]) {
    await assert.rejects(validateProviderDestination(configuration(), undefined, async (hostname) => hostname === "base.drpc.org" ? addresses : publicDns), /prohibited network/);
  }
  let lookups = 0;
  await assert.rejects(validateProviderDestination({ ...configuration(), rpcFallbackUrls: [secondary, "https://fixture-secret@mainnet.base.org"] }, undefined, async () => { lookups++; return publicDns; }), /embedded credentials/);
  assert.equal(lookups, 0, "every URL policy is checked before resolving even the primary");
});

test("the local fixture exception skips only loopback destinations and still validates public fallbacks", async () => {
  const configured = readProviderConfiguration({ NODE_ENV: "test", BASE_RPC_URL: "http://127.0.0.1:8545", BASE_RPC_FALLBACK_URLS: secondary });
  const checked: string[] = [];
  const ready = await validateProviderDestination(configured, undefined, async (hostname) => { checked.push(hostname); return publicDns; });
  assert.deepEqual(checked, ["base-rpc.publicnode.com"]);
  assert.equal(ready.rpcUrl, "http://127.0.0.1:8545/");
  await assert.rejects(validateProviderDestination(configured, undefined, async () => [{ address: "192.168.1.1" }]), /prohibited network/);
});

test("DNS timeouts advance to a healthy alternative while outer cancellation preserves its reason", async () => {
  const configured = { ...configuration(), timeoutMs: 15 };
  const ready = await validateProviderDestination(configured, undefined, (hostname) => hostname === "mainnet.base.org" ? new Promise(() => {}) : Promise.resolve(publicDns));
  assert.equal(ready.rpcUrl, secondary);
  const parent = new AbortController();
  const reason = new Error("Synthetic DNS cancellation");
  const pending = validateProviderDestination(configured, parent.signal, () => new Promise(() => {}));
  parent.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("request-local fetch and body timeouts are retryable without automatic recovery", async () => {
  const configured = { ...configuration(), timeoutMs: 15 };
  let body = false;
  let calls = 0;
  const mocked = mock.method(globalThis, "fetch", async () => {
    calls++;
    if (!body) return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ start() {} }));
  });
  try {
    const transport = createProviderTransport(configured);
    await assert.rejects(transport.rpc("eth_chainId", []), (error: unknown) => error instanceof UpstreamFailure && error.retryable);
    assert.equal(calls, 1);
    body = true;
    await assert.rejects(transport.rpc("eth_chainId", []), (error: unknown) => error instanceof UpstreamFailure && error.retryable);
    assert.equal(calls, 2);
    assert.equal(transport.rpcSource!(), "Base public RPC");
  } finally { mocked.mock.restore(); }
});

test("outer request cancellation is preserved without waiting for a stalled fetch", async () => {
  const parent = new AbortController();
  const reason = new Error("Synthetic request cancellation");
  let requestSignal: AbortSignal | undefined;
  const mocked = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => { requestSignal = init?.signal ?? undefined; return new Promise<Response>(() => {}); });
  try {
    const transport = createProviderTransport(configuration(), parent.signal);
    const pending = transport.rpc("eth_chainId", []);
    parent.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(requestSignal?.reason, reason);
    assert.equal(transport.rpcSource!(), "Base public RPC");
  } finally { mocked.mock.restore(); }
});

test("the log lane is explicit, single-endpoint and follows the same URL/engine-only policy", () => {
  assert.equal(readProviderConfiguration({ BASE_RPC_URL: primary }).logRpcUrl, null);
  assert.equal(readProviderConfiguration({ BASE_RPC_URL: primary, BASE_LOG_RPC_URL: "https://BASE-RPC.PUBLICNODE.COM:443" }).logRpcUrl, secondary);
  for (const endpoint of ["http://mainnet.base.org", "https://127.0.0.1", "https://fixture-secret@mainnet.base.org", `${secondary},${tertiary}`, "https://mainnet.base.org/#fixture-secret"]) {
    assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: primary, BASE_LOG_RPC_URL: endpoint }), (error: unknown) => error instanceof Error && !error.message.includes("fixture-secret"));
  }
  assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: primary, BASE_LOG_RPC_URL: secondary, VERCEL: "1" }), /protected scan engine/);
});

test("log DNS is validated before acquisition and cannot borrow healthy state destinations", async () => {
  const configured = readProviderConfiguration({ BASE_RPC_URL: primary, BASE_LOG_RPC_URL: secondary });
  const checked: string[] = [];
  const ready = await validateProviderDestination(configured, undefined, async (host) => { checked.push(host); return publicDns; });
  assert.deepEqual(checked, ["mainnet.base.org", "base-rpc.publicnode.com"]);
  assert.equal(ready.logRpcUrl, secondary);
  await assert.rejects(validateProviderDestination(configured, undefined, async (host) => host === "base-rpc.publicnode.com" ? [{ address: "127.0.0.1" }] : publicDns), /prohibited network/);
  await assert.rejects(validateProviderDestination(configured, undefined, async (host) => host === "base-rpc.publicnode.com" ? [] : publicDns), UpstreamFailure);
  let lookups = 0;
  await assert.rejects(validateProviderDestination({ ...configured, logRpcUrl: "https://fixture-secret@mainnet.base.org" }, undefined, async () => { lookups++; return publicDns; }), /embedded credentials/);
  assert.equal(lookups, 0);
});

test("separate log transport stays on its explicit endpoint when state recovery advances", async () => {
  const configured = readProviderConfiguration({ BASE_RPC_URL: tertiary, BASE_RPC_FALLBACK_URLS: primary, BASE_LOG_RPC_URL: secondary });
  const calls: { url: string; method: string }[] = [];
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ url: String(url), method });
    return rpcResponse(init, method === "eth_getLogs" ? [] : "0x2105");
  });
  try {
    const state = createProviderTransport(configured);
    const logs = createProviderTransport({ ...configured, rpcUrl: configured.logRpcUrl!, rpcFallbackUrls: [] });
    await logs.rpc("eth_getLogs", [{}]);
    assert.equal(state.recoverRpc!(), true);
    await state.rpc("eth_chainId", []);
    await logs.rpc("eth_getLogs", [{}]);
    assert.equal(logs.recoverRpc!(), false);
    assert.deepEqual(calls, [{ url: secondary, method: "eth_getLogs" }, { url: primary, method: "eth_chainId" }, { url: secondary, method: "eth_getLogs" }]);
  } finally { mocked.mock.restore(); }
});

test("only explicit log range/result or body limits are split; throttles and unknown failures remain distinct", async () => {
  let mode: "range" | "rate" | "unknown" | "body" | "malformed" = "range";
  const mocked = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    if (mode === "body") return new Response("{}", { headers: { "content-length": "2000001" } });
    if (mode === "malformed") return new Response("not-json");
    const message = mode === "range" ? "query returned more than 10000 results fixture-secret" : mode === "rate" ? "rate limit exceeded for query fixture-secret" : "provider currently unavailable fixture-secret";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message } }));
  });
  try {
    const transport = createProviderTransport(configuration());
    await assert.rejects(transport.rpc("eth_getLogs", [{}]), (error: unknown) => error instanceof ProviderLogRangeError && !error.message.includes("fixture-secret") && !isProviderThrottle(error));
    await assert.rejects(transport.rpc("eth_call", []), (error: unknown) => error instanceof UpstreamFailure && !(error instanceof ProviderLogRangeError));
    mode = "rate";
    await assert.rejects(transport.rpc("eth_getLogs", [{}]), (error: unknown) => isProviderThrottle(error) && !(error instanceof ProviderLogRangeError));
    mode = "unknown";
    await assert.rejects(transport.rpc("eth_getLogs", [{}]), (error: unknown) => error instanceof UpstreamFailure && !(error instanceof ProviderLogRangeError));
    mode = "body";
    await assert.rejects(transport.rpc("eth_getLogs", [{}]), ProviderLogRangeError);
    await assert.rejects(transport.rpc("eth_getCode", []), ProviderResponseLimitError);
    mode = "malformed";
    await assert.rejects(transport.rpc("eth_getLogs", [{}]), ProviderIntegrityError);
  } finally { mocked.mock.restore(); }
});
