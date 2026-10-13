import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, Hash } from "../../src/domain/investigations/types";
import { createAlchemyFundingHistoryReader } from "../../src/providers/base/alchemy-funding";
import { ProviderIntegrityError, UpstreamFailure } from "../../src/providers/base/errors";

const address = (value: string) => `0x${value.repeat(40)}` as Address;
const hash = (value: string) => `0x${value.repeat(64)}` as Hash;
const wallet = address("a"), sender = address("b"), other = address("c");
const range = { fromBlock: "100", toBlock: "120" };
const transfer = (overrides: Record<string, unknown> = {}) => ({
  hash: hash("a"), blockNum: "0x78", from: sender, to: wallet, category: "external",
  uniqueId: `${hash("a")}:external`, rawContract: { address: null, value: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
  value: 1.7976931348623157e308, ...overrides,
});

test("Alchemy funding pins a recipient-filtered native query and publishes only transaction identities", async () => {
  const calls: { method: string; params: unknown[] }[] = [];
  const reader = createAlchemyFundingHistoryReader(async (method, params) => {
    calls.push({ method, params });
    return { transfers: [transfer()], pageKey: "next-page:1" };
  });
  const page = await reader(wallet, null, range);
  assert.deepEqual(calls, [{ method: "alchemy_getAssetTransfers", params: [{
    fromBlock: "0x64", toBlock: "0x78", toAddress: wallet, category: ["external"],
    excludeZeroValue: true, order: "desc", maxCount: "0x64", withMetadata: false,
  }] }]);
  assert.deepEqual(page, { items: [{ hash: hash("a"), blockNumber: "120" }], nextCursor: { pageKey: "next-page:1" } });
  assert.equal(JSON.stringify(page).includes("value"), false, "approximate and raw index amounts must not become evidence");
  await reader(wallet, page.nextCursor, range);
  assert.equal((calls[1].params[0] as unknown as { pageKey: string }).pageKey, "next-page:1");
});

test("Alchemy funding normalizes address and hash case and does not require index amounts", async () => {
  const uppercase = (value: string) => `0x${value.slice(2).toUpperCase()}`;
  const reader = createAlchemyFundingHistoryReader(async () => ({ transfers: [transfer({
    hash: uppercase(hash("a")), from: uppercase(sender), to: uppercase(wallet), rawContract: { address: null },
  })] }));
  assert.deepEqual(await reader(uppercase(wallet) as Address, null, range), { items: [{ hash: hash("a"), blockNumber: "120" }], nextCursor: null });
});

test("Alchemy funding accepts an empty last page and each documented terminal cursor representation", async () => {
  for (const pageKey of [undefined, null, ""]) {
    const reader = createAlchemyFundingHistoryReader(async () => ({ transfers: [], ...(pageKey === undefined ? {} : { pageKey }) }));
    assert.deepEqual(await reader(wallet, null, range), { items: [], nextCursor: null });
  }
});

test("Alchemy funding rejects malformed recipient, range and cursor input before an RPC read", async () => {
  let calls = 0;
  const reader = createAlchemyFundingHistoryReader(async () => { calls++; return { transfers: [] }; });
  await assert.rejects(reader("0x1" as Address, null, range), ProviderIntegrityError);
  for (const invalid of [{ fromBlock: "0100", toBlock: "120" }, { fromBlock: "121", toBlock: "120" }, { fromBlock: "-1", toBlock: "120" }, { fromBlock: "0", toBlock: "1".repeat(25) }]) {
    await assert.rejects(reader(wallet, null, invalid), ProviderIntegrityError);
  }
  const invalidCursors: Record<string, string | number>[] = [{ pageKey: "" }, { pageKey: "x".repeat(513) }, { pageKey: 1 }, { pageKey: "valid", origin: "https://example.com" }, { block_number: 100 }, { pageKey: "contains spaces" }];
  for (const cursor of invalidCursors) {
    await assert.rejects(reader(wallet, cursor, range), ProviderIntegrityError);
  }
  assert.equal(calls, 0);
});

test("Alchemy funding bounds pages and pagination tokens", async () => {
  const accepted = createAlchemyFundingHistoryReader(async () => ({ transfers: Array.from({ length: 100 }, () => transfer()), pageKey: "x".repeat(512) }));
  const page = await accepted(wallet, null, range);
  assert.equal(page.items.length, 1, "identical index duplicates cannot multiply candidate evidence");
  assert.equal(page.nextCursor?.pageKey, "x".repeat(512));
  for (const result of [{ transfers: Array.from({ length: 101 }, () => transfer()) }, { transfers: [], pageKey: "x".repeat(513) }, { transfers: [], pageKey: 1 }, { transfers: null }]) {
    await assert.rejects(createAlchemyFundingHistoryReader(async () => result)(wallet, null, range), ProviderIntegrityError);
  }
});

test("Alchemy funding rejects foreign recipient, non-native category and malformed transaction identities", async () => {
  const invalidTransfers = [
    transfer({ to: other }), transfer({ to: null }), transfer({ from: "0x1" }),
    transfer({ category: "internal" }), transfer({ category: "erc20" }),
    transfer({ rawContract: { address: other } }), transfer({ rawContract: {} }),
    transfer({ hash: "0x1234" }), transfer({ blockNum: "0x078" }), transfer({ blockNum: "120" }),
    transfer({ uniqueId: `${hash("b")}:external` }),
  ];
  for (const invalid of invalidTransfers) {
    await assert.rejects(createAlchemyFundingHistoryReader(async () => ({ transfers: [invalid] }))(wallet, null, range), ProviderIntegrityError);
  }
});

test("Alchemy funding rejects out-of-range and ascending identities rather than retaining a valid prefix", async () => {
  for (const transfers of [
    [transfer({ blockNum: "0x79" })], [transfer({ blockNum: "0x63" })],
    [transfer({ hash: hash("b"), uniqueId: `${hash("b")}:external`, blockNum: "0x64" }), transfer()],
  ]) {
    await assert.rejects(createAlchemyFundingHistoryReader(async () => ({ transfers }))(wallet, null, range), ProviderIntegrityError);
  }
});

test("Alchemy funding rejects conflicting duplicate identities", async () => {
  for (const conflicting of [transfer({ blockNum: "0x77" }), transfer({ from: other })]) {
    await assert.rejects(createAlchemyFundingHistoryReader(async () => ({ transfers: [transfer(), conflicting] }))(wallet, null, range), ProviderIntegrityError);
  }
});

test("Alchemy funding preserves block identities beyond JavaScript's exact number range", async () => {
  const blockNumber = "9007199254740993";
  const reader = createAlchemyFundingHistoryReader(async () => ({ transfers: [transfer({ blockNum: `0x${BigInt(blockNumber).toString(16)}` })] }));
  assert.equal((await reader(wallet, null, { fromBlock: blockNumber, toBlock: blockNumber })).items[0].blockNumber, blockNumber);
});

test("Alchemy funding preserves transport failure and cancellation identity without hidden retries", async () => {
  for (const failure of [new UpstreamFailure(true, { httpStatus: 429 }), new Error("cancelled")]) {
    let calls = 0;
    const reader = createAlchemyFundingHistoryReader(async () => { calls++; throw failure; });
    await assert.rejects(reader(wallet, null, range), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test("creator outbound discovery filters the exact sender and rejects conflicting recipients", async () => {
  let query: unknown;
  const reader = createAlchemyFundingHistoryReader(async (_method, params) => { query = params[0]; return { transfers: [transfer()] }; }, "outbound");
  assert.equal((await reader(sender, null, range)).items.length, 1);
  assert.equal((query as { fromAddress: string }).fromAddress, sender);
  assert.equal("toAddress" in (query as object), false);
  await assert.rejects(createAlchemyFundingHistoryReader(async () => ({ transfers: [transfer({ from: other })] }), "outbound")(sender, null, range), ProviderIntegrityError);
  await assert.rejects(createAlchemyFundingHistoryReader(async () => ({ transfers: [transfer(), transfer({ to: other })] }), "outbound")(sender, null, range), ProviderIntegrityError);
});
