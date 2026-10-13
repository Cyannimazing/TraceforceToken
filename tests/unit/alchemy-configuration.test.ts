import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { readProviderConfiguration } from "../../src/providers/base/config";
import { createProviderTransport, validateProviderDestination } from "../../src/providers/base/transport";

const state = "https://mainnet.base.org/", index = "https://base-mainnet.g.alchemy.com/v2/fixture-private-key";

test("indexed acquisition requires explicit supported private configuration", () => {
  const configured = readProviderConfiguration({ BASE_RPC_URL: state, BASE_ALCHEMY_RPC_URL: index, BASE_TRANSFER_SOURCE: "alchemy", BASE_FUNDING_SOURCE: "alchemy" });
  assert.equal(configured.transferSource, "alchemy"); assert.equal(configured.fundingSource, "alchemy");
  assert.equal(readProviderConfiguration({ BASE_RPC_URL: state }).transferSource, "rpc");
  for (const options of [
    { BASE_TRANSFER_SOURCE: "alchemy" }, { BASE_FUNDING_SOURCE: "alchemy" },
    { BASE_TRANSFER_SOURCE: "untrusted" }, { BASE_ALCHEMY_RPC_URL: state },
    { BASE_ALCHEMY_RPC_URL: index, VERCEL: "1" },
  ]) assert.throws(() => readProviderConfiguration({ BASE_RPC_URL: state, ...options }), (error: unknown) => error instanceof Error && !error.message.includes("fixture-private-key"));
});

test("DNS preflight overlaps unique hostnames, deduplicates lanes and preserves provider priority", async () => {
  const configuration = readProviderConfiguration({ BASE_RPC_URL: state, BASE_RPC_FALLBACK_URLS: "https://base-rpc.publicnode.com", BASE_LOG_RPC_URL: "https://base-rpc.publicnode.com", BASE_ALCHEMY_RPC_URL: index });
  const started: string[] = [];
  const completions = new Map<string, (value: { address: string }[]) => void>();
  const result = validateProviderDestination(configuration, undefined, (host) => {
    started.push(host); return new Promise((resolve) => completions.set(host, resolve));
  });
  assert.deepEqual(started, ["mainnet.base.org", "base-rpc.publicnode.com", "base-mainnet.g.alchemy.com"]);
  for (const finish of [...completions.values()].reverse()) finish([{ address: "8.8.8.8" }]);
  assert.equal((await result).rpcUrl, state);
});

test("an unavailable or prohibited explicit indexed destination blocks acquisition", async () => {
  const configuration = readProviderConfiguration({ BASE_RPC_URL: state, BASE_ALCHEMY_RPC_URL: index, BASE_TRANSFER_SOURCE: "alchemy" });
  for (const records of [[], [{ address: "127.0.0.1" }]]) await assert.rejects(validateProviderDestination(configuration, undefined, async (host) => host === "base-mainnet.g.alchemy.com" ? records : [{ address: "8.8.8.8" }]));
});

test("indexed read method stays on the fixed Alchemy transport and other endpoints refuse it", async () => {
  const calls: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url)); const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { transfers: [] } }));
  });
  try {
    await assert.rejects(createProviderTransport(readProviderConfiguration({ BASE_RPC_URL: state })).rpc("alchemy_getAssetTransfers", [{}]), /read-only/);
    await createProviderTransport(readProviderConfiguration({ BASE_RPC_URL: index })).rpc("alchemy_getAssetTransfers", [{}]);
    assert.deepEqual(calls, [index]);
  } finally { fetch.mock.restore(); }
});
