import assert from "node:assert/strict";
import test from "node:test";
import { getBrowserReportFixture } from "../fixtures/report";
import { MAX_BROWSER_REPORT_BYTES, selectBrowserReportEvictions, validateBrowserSnapshot } from "../../src/components/browser-reports";

const row = (id: string, opened: number, bytes = 100) => ({ id, bytes, savedAt: "2026-10-12T00:00:00.000Z", lastOpenedAt: `2026-10-12T00:00:0${opened}.000Z` });
test("snapshot eviction preserves the current report and recent opens across the five-report and aggregate-byte caps", () => {
  assert.deepEqual(selectBrowserReportEvictions([row("oldest", 0), row("touched", 7), row("three", 2), row("four", 3), row("five", 4), row("new", 5)], "new"), ["oldest"]);
  const sevenMiB = 7 * 1024 * 1024;
  assert.deepEqual(selectBrowserReportEvictions([row("oldest", 0, sevenMiB), row("recent", 1, sevenMiB), row("new", 2, sevenMiB)], "new"), ["oldest"]);
  assert.deepEqual(selectBrowserReportEvictions([row("at-cap", 0, MAX_BROWSER_REPORT_BYTES)], "at-cap"), []);
  assert.throws(() => selectBrowserReportEvictions([row("too-large", 0, MAX_BROWSER_REPORT_BYTES + 1)], "too-large"), /snapshot limit/);
});

test("browser snapshot validation restores only a complete report and rejects corrupt identity, bytes and citations", () => {
  const report = getBrowserReportFixture(), bytes = new TextEncoder().encode(JSON.stringify(report)).byteLength;
  const source = { schemaVersion: 1, id: report.id, savedAt: "2026-10-12T00:00:00.000Z", lastOpenedAt: "2026-10-12T00:00:00.000Z", bytes, report, chatContext: "must-not-be-restored", conversation: ["must-not-be-restored"] };
  const snapshot = validateBrowserSnapshot(source);
  assert.deepEqual(snapshot.report, report); assert.equal("chatContext" in snapshot, false); assert.equal("conversation" in snapshot, false);
  for (const invalid of [{ ...source, bytes: bytes + 1 }, { ...source, id: "different" }, { ...source, savedAt: "invalid" }, { ...source, report: { ...report, explanation: null } }, { ...source, report: { ...report, explanation: { ...report.explanation, overview: { text: "Invented support", evidenceIds: ["invented"] } } } }]) assert.throws(() => validateBrowserSnapshot(invalid));
});
