import assert from "node:assert/strict";
import test from "node:test";
import { validateBaseInvestigationReport } from "../../src/domain/investigations/report-validation";
import { getBrowserReportFixture } from "../fixtures/report";
import { validateTransferCrawl } from "../../src/domain/investigations/transfer-crawl";

function report() {
  const value = { ...getBrowserReportFixture() };
  Reflect.deleteProperty(value, "explanation");
  value.range.from = { ...value.range.from, number: "0" };
  value.coverage.transfers = "complete";
  value.coverage.transferCrawl = { scope: "full", source: "rpc-logs", completedRanges: [{ fromBlock: "0", toBlock: value.range.to.number }] };
  return value;
}

test("full crawl metadata survives browser/report validation without inventing legacy scope", () => {
  const value = report();
  assert.deepEqual(validateBaseInvestigationReport(value).coverage.transferCrawl, value.coverage.transferCrawl);
  delete value.coverage.transferCrawl;
  assert.equal(validateBaseInvestigationReport(value).coverage.transferCrawl, undefined);
});

test("complete full crawl rejects missing, overlapping, out-of-range and false genesis coverage", () => {
  for (const mutate of [
    (value: ReturnType<typeof report>) => { value.coverage.transferCrawl!.completedRanges = []; },
    (value: ReturnType<typeof report>) => { value.coverage.transferCrawl!.completedRanges[0].fromBlock = "1"; },
    (value: ReturnType<typeof report>) => { value.coverage.transferCrawl!.completedRanges[0].toBlock = String(BigInt(value.range.to.number) - 1n); },
    (value: ReturnType<typeof report>) => { value.coverage.transferCrawl!.completedRanges.push({ fromBlock: "1", toBlock: "2" }); },
    (value: ReturnType<typeof report>) => { value.range.from.number = "1"; },
  ]) { const value = report(); mutate(value); assert.throws(() => validateBaseInvestigationReport(value)); }
});

test("partial full crawl retains exact completed prefixes without upgrading unknown history", () => {
  const value = report();
  value.coverage.transfers = "partial";
  value.coverage.transferCrawl!.completedRanges = [{ fromBlock: "0", toBlock: "1" }];
  const checked = validateBaseInvestigationReport(value);
  assert.equal(checked.coverage.transfers, "partial");
  assert.deepEqual(checked.coverage.transferCrawl!.completedRanges, [{ fromBlock: "0", toBlock: "1" }]);
});

test("range normalization is deterministic without mutating acquisition metadata", () => {
  const value = report();
  const crawl = { scope: "full" as const, source: "rpc-logs" as const, completedRanges: [{ fromBlock: "5", toBlock: "6" }, { fromBlock: "0", toBlock: "1" }] };
  const before = structuredClone(crawl);
  assert.deepEqual(validateTransferCrawl(crawl, value.range, "partial").completedRanges, [...crawl.completedRanges].reverse());
  assert.deepEqual(crawl, before);
});
