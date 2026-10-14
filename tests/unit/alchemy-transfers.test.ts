import assert from "node:assert/strict";
import test from "node:test";
import { createAlchemyTransferPageReader, type TokenTransferPageQuery } from "../../src/providers/base/alchemy-transfers";
import { ProviderIntegrityError, UpstreamFailure } from "../../src/providers/base/errors";
import type { Address, Hash } from "../../src/domain/investigations/types";

const token = `0x${"ab".repeat(20)}` as Address, other = `0x${"cd".repeat(20)}` as Address;
const hash = `0x${"12".repeat(32)}` as Hash, secondHash = `0x${"34".repeat(32)}` as Hash;
const query: TokenTransferPageQuery = { token, fromBlock: "0", toBlock: "100", cursor: null };
const item = { blockNum: "0x63", hash, category: "erc20", rawContract: { address: token, value: "0x20000000000001", decimal: "0x12" }, value: 0.009007199254740993 };

test("Alchemy transfer discovery pins the token/range, includes zero transfers and forwards its cursor on one RPC call", async () => {
  const calls: { method: string; params: unknown[] }[] = [];
  const read = createAlchemyTransferPageReader(async (method, params) => { calls.push({ method, params }); return { transfers: [item], pageKey: "opaque-page-1" }; });
  const first = await read(query);
  assert.deepEqual(first, { items: [{ hash, blockNumber: "99" }], nextCursor: "opaque-page-1" });
  assert.deepEqual(calls, [{ method: "alchemy_getAssetTransfers", params: [{
    fromBlock: "0x0", toBlock: "0x64", contractAddresses: [token], category: ["erc20"], order: "asc",
    excludeZeroValue: false, withMetadata: false, maxCount: "0x3e8",
  }] }]);
  await read({ ...query, cursor: first.nextCursor });
  assert.equal((calls[1].params[0] as unknown as { pageKey: string }).pageKey, "opaque-page-1");
  assert.equal(calls.length, 2, "each reader call must perform exactly one physical RPC invocation");
  assert.equal("value" in first.items[0], false, "approximate API values never become on-chain evidence");
});

test("Alchemy discovery deduplicates transaction identities and normalizes only documented terminal cursors", async () => {
  for (const pageKey of [undefined, null, ""]) {
    const read = createAlchemyTransferPageReader(async () => ({ transfers: [item, { ...item, value: 0 }, { ...item, blockNum: "0x64", hash: secondHash }], pageKey }));
    assert.deepEqual(await read(query), { items: [{ hash, blockNumber: "99" }, { hash: secondHash, blockNumber: "100" }], nextCursor: null });
  }
});

test("Alchemy discovery rejects token/category/range/order/identity and cursor inconsistencies", async () => {
  const invalidPages: unknown[] = [
    { transfers: [{ ...item, rawContract: { address: other } }] },
    { transfers: [{ ...item, category: "external" }] },
    { transfers: [{ ...item, blockNum: "0x65" }] },
    { transfers: [{ ...item, blockNum: "0x64" }, { ...item, hash: secondHash }] },
    { transfers: [item, { ...item, blockNum: "0x64" }] },
    { transfers: [{ ...item, hash: "invalid" }] },
    { transfers: [{ ...item, blockNum: "0x01" }] },
    { transfers: [item], pageKey: "bad\ncursor" },
    { transfers: Array(1001).fill(item) },
    { transfers: null },
  ];
  for (const page of invalidPages) await assert.rejects(createAlchemyTransferPageReader(async () => page)(query), ProviderIntegrityError);
  await assert.rejects(createAlchemyTransferPageReader(async () => ({ transfers: [item] }))({ ...query, fromBlock: "100" }), ProviderIntegrityError);
});

test("Alchemy transfer discovery accepts a full thousand-row page without trusting indexed amounts", async () => {
  const transfers = Array.from({ length: 1000 }, (_, index) => ({ ...item, hash: `0x${index.toString(16).padStart(64, "0")}` }));
  const page = await createAlchemyTransferPageReader(async () => ({ transfers, pageKey: "next-page" }))(query);
  assert.equal(page.items.length, 1000);
  assert.equal(page.nextCursor, "next-page");
  assert.ok(page.items.every((row) => Object.keys(row).sort().join(",") === "blockNumber,hash"));
});

test("Alchemy discovery keeps provider failures unchanged and rejects invalid queries before I/O", async () => {
  const failure = new UpstreamFailure(true, { httpStatus: 429 });
  await assert.rejects(createAlchemyTransferPageReader(async () => { throw failure; })(query), (error: unknown) => error === failure);
  let calls = 0;
  const read = createAlchemyTransferPageReader(async () => { calls++; return { transfers: [] }; });
  for (const changed of [{ ...query, fromBlock: "101" }, { ...query, cursor: "bad cursor" }, { ...query, token: "invalid" as Address }]) await assert.rejects(read(changed), ProviderIntegrityError);
  assert.equal(calls, 0);
});
