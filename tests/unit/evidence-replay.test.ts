import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvidenceReplay } from "../../src/domain/investigations/evidence-replay";
import type { Address, EvidenceRecord, Hash } from "../../src/domain/investigations/types";
import { getBrowserReportFixture } from "../fixtures/report";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hash;

test("replay preserves the declared window and excludes earlier funding and other-token activity", () => {
  const report = getBrowserReportFixture(), before = structuredClone(report);
  const frames = buildEvidenceReplay(report);
  assert.equal(frames[0].block, report.range.from.number);
  assert.equal(frames.at(-1)!.block, report.range.to.number);
  for (let index = 1; index < frames.length; index++) assert.ok(BigInt(frames[index].block) >= BigInt(frames[index - 1].block));
  assert.equal(frames.at(-1)!.funding, 0); // Fixture funding predates token window.
  assert.equal(frames.at(-1)!.transfers, report.evidence.filter((event) => event.kind === "transfer" && event.assetAddress === report.token.address).length);
  assert.deepEqual(report, before);
  const unrelated = { ...report.evidence.find((event) => event.kind === "transfer")!, id: "other-token", assetAddress: address(999) };
  assert.deepEqual(buildEvidenceReplay({ ...report, evidence: [...report.evidence, unrelated] }), frames);
});

test("unordered repeated records count once and mint/burn zero addresses never become observed wallets", () => {
  const report = getBrowserReportFixture();
  const original = report.evidence.find((event) => event.kind === "transfer")!;
  const mint: EvidenceRecord = { ...original, id: "mint", from: address(0), to: address(50), blockNumber: "110", blockHash: hash(110), timestamp: report.range.from.timestamp + 10 };
  const burn: EvidenceRecord = { ...mint, id: "burn", from: address(50), to: address(0), blockNumber: "120", blockHash: hash(120), timestamp: mint.timestamp + 10 };
  const funding: EvidenceRecord = { ...mint, id: "fund", kind: "funding", assetAddress: null, from: address(70), to: address(50), blockNumber: "115", blockHash: hash(115), timestamp: mint.timestamp + 5 };
  const input = { ...report, evidence: [burn, mint, funding, mint, burn] };
  const frames = buildEvidenceReplay(input);
  assert.deepEqual(frames.map((frame) => frame.block), [report.range.from.number, "110", "115", "120", report.range.to.number]);
  assert.equal(frames.at(-1)!.observedAddresses, 1);
  assert.equal(frames.at(-1)!.transfers, 2);
  assert.equal(frames.at(-1)!.funding, 1);
  assert.equal(frames.at(-1)!.supportedSales, 0);
});

test("empty activity retains both boundaries and long replay retains exact cumulative endpoint counts", () => {
  const report = getBrowserReportFixture();
  const empty = buildEvidenceReplay({ ...report, evidence: [] });
  assert.deepEqual(empty.map((frame) => frame.block), [report.range.from.number, report.range.to.number]);
  assert.ok(empty.every((frame) => frame.observedAddresses === 0 && frame.transfers === 0));
  const original = report.evidence.find((event) => event.kind === "transfer")!;
  const evidence = Array.from({ length: 600 }, (_, index): EvidenceRecord => ({
    ...original, id: `transfer-${index}`, blockNumber: String(index + 100), blockHash: hash(index + 100),
    transactionHash: hash(index + 1), timestamp: report.range.from.timestamp + index,
    from: address(index + 1), to: address(index + 2),
  }));
  const frames = buildEvidenceReplay({ ...report, evidence, range: { ...report.range, to: { ...report.range.to, number: "800", hash: hash(800), timestamp: report.range.from.timestamp + 700 } } });
  assert.equal(frames.length, 200);
  assert.equal(frames[0].block, "100");
  assert.equal(frames.at(-1)!.block, "800");
  assert.equal(frames.at(-1)!.transfers, 600);
  assert.equal(frames.at(-1)!.observedAddresses, 601);
});
