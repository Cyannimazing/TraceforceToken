import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "../../src/domain/investigations/types";
import { tokenMarketSnapshotSchema } from "../../src/domain/investigations/token-market";
import { collectTokenMetadata } from "../../src/providers/token-websites-core";

const token = `0x${"11".repeat(20)}` as Address;
const other = `0x${"22".repeat(20)}` as Address;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const now = () => new Date("2026-10-12T00:00:00.000Z");
const pair = (n: number, overrides: Record<string, unknown> = {}) => ({
  chainId: "base", pairAddress: address(n), baseToken: { address: token },
  priceUsd: "0.000000000000000000123456789", marketCap: 12_000,
  liquidity: { usd: 100 }, volume: { h24: 300 }, priceChange: { h24: -4.5 },
  pairCreatedAt: 1_700_000_000_000, info: { websites: [{ url: "https://project.org/" }] }, ...overrides,
});
const collect = (payload: unknown) => collectTokenMetadata(token, { now, fetch: (async () => Response.json(payload)) as typeof fetch });

test("one listing response supplies websites and one exact-identity highest-liquidity market pair", async () => {
  let calls = 0;
  const result = await collectTokenMetadata(token, { now, fetch: (async (input, init) => {
    calls++;
    assert.equal(String(input), `https://api.dexscreener.com/token-pairs/v1/base/${token}`);
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    return Response.json([
      pair(1, { priceUsd: "8", liquidity: { usd: 50 }, volume: { h24: 9999 } }),
      pair(2, { liquidity: { usd: 200 } }),
      pair(3, { chainId: "ethereum", liquidity: { usd: 1e12 } }),
      pair(4, { baseToken: { address: other }, quoteToken: { address: token }, liquidity: { usd: 1e12 } }),
    ]);
  }) as typeof fetch });
  assert.equal(calls, 1);
  assert.equal(result.webPresence.status, "reported");
  assert.deepEqual(result.webPresence.websites[0].pairAddresses, [address(1), address(2)]);
  assert.deepEqual(result.marketSnapshot, {
    source: "dexscreener", status: "reported", checkedAt: now().toISOString(),
    sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${token}`, pairAddress: address(2),
    priceUsd: "0.000000000000000000123456789", marketCapUsd: 12_000,
    liquidityUsd: 200, volume24hUsd: 300, priceChange24hPercent: -4.5, pairCreatedAt: 1_700_000_000_000,
  });
  tokenMarketSnapshotSchema.parse(result.marketSnapshot);
});

test("market selection is independent of response order and ranks valid zero liquidity above unknown", async () => {
  const rows = [pair(3, { liquidity: { usd: 0 } }), pair(1, { liquidity: { usd: "100000" } }), pair(2, { liquidity: { usd: 0 } })];
  const forward = (await collect(rows)).marketSnapshot;
  const reverse = (await collect([...rows].reverse())).marketSnapshot;
  assert.deepEqual(forward, reverse);
  assert.equal(forward.pairAddress, address(2)); assert.equal(forward.liquidityUsd, 0);
  const duplicates = [pair(1, { priceUsd: "2" }), pair(1, { priceUsd: "1" })];
  assert.deepEqual((await collect(duplicates)).marketSnapshot, (await collect([...duplicates].reverse())).marketSnapshot);
});

test("malformed or absent market values stay null without substituting FDV or another pair", async () => {
  const result = await collect([
    pair(1, { liquidity: { usd: 200 }, priceUsd: "1e-8", marketCap: undefined, fdv: 55, volume: { h24: -1 }, priceChange: { h24: "10" }, pairCreatedAt: 1_700_000_000 }),
    pair(2, { marketCap: 900, volume: { h24: 500 } }),
  ]);
  assert.equal(result.webPresence.status, "reported");
  assert.deepEqual(result.marketSnapshot, {
    source: "dexscreener", status: "reported", checkedAt: now().toISOString(),
    sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${token}`, pairAddress: address(1),
    priceUsd: null, marketCapUsd: null, liquidityUsd: 200, volume24hUsd: null, priceChange24hPercent: null, pairCreatedAt: null,
  });
});

test("website validation failure does not erase independently valid market metrics", async () => {
  const result = await collect([pair(1, { info: { websites: {} } })]);
  assert.equal(result.webPresence.status, "unavailable");
  assert.equal(result.marketSnapshot.status, "reported"); assert.equal(result.marketSnapshot.marketCapUsd, 12_000);
  tokenMarketSnapshotSchema.parse(result.marketSnapshot);
});

test("market status distinguishes no usable matching listing from unavailable transport or identity", async () => {
  for (const rows of [[], [pair(1, { chainId: "ethereum" })], [pair(1, { pairAddress: `0x${"ab".repeat(32)}` })]]) {
    const result = (await collect(rows)).marketSnapshot;
    assert.equal(result.status, "not_listed"); assert.equal(result.pairAddress, null);
    tokenMarketSnapshotSchema.parse(result);
  }
  const malformed = await collect([pair(1, { pairAddress: "not-an-address" })]);
  assert.equal(malformed.marketSnapshot.status, "unavailable");
  const failed = await collectTokenMetadata(token, { now, fetch: (async () => new Response("secret upstream error", { status: 429 })) as typeof fetch });
  assert.equal(failed.marketSnapshot.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(failed), /secret upstream/);
});

test("market parser rejects unbounded numbers, future creation dates and nondecimal prices", async () => {
  const result = await collect([pair(1, {
    priceUsd: "00.5", marketCap: 1e19, liquidity: { usd: -1 }, volume: { h24: "30" },
    priceChange: { h24: -101 }, pairCreatedAt: now().getTime() + 1,
  })]);
  assert.equal(result.marketSnapshot.status, "reported");
  for (const field of ["priceUsd", "marketCapUsd", "liquidityUsd", "volume24hUsd", "priceChange24hPercent", "pairCreatedAt"] as const) assert.equal(result.marketSnapshot[field], null);
  assert.equal(result.webPresence.status, "reported");
});

test("market shared validation rejects impossible statuses, unsafe dates and invented values", async () => {
  const valid = (await collect([pair(1)])).marketSnapshot;
  for (const change of [
    { status: "not_listed" }, { pairAddress: null }, { priceUsd: "NaN" },
    { marketCapUsd: Infinity }, { liquidityUsd: -1 }, { priceChange24hPercent: -101 },
    { pairCreatedAt: now().getTime() + 1 }, { pairCreatedAt: 1_700_000_000 },
    { sourceUrl: "https://untrusted.org/" }, { extra: "untrusted" },
  ]) assert.equal(tokenMarketSnapshotSchema.safeParse({ ...valid, ...change }).success, false);
});
