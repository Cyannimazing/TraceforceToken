import assert from "node:assert/strict";
import { test } from "node:test";
import { investigationShareDetails, investigationShareSvg } from "../../src/components/investigation-share";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";
import { getBrowserSwarmAssessmentFixture, getBrowserSwarmSummaryFixture } from "../fixtures/swarm-report";

test("share preview and SVG use one primary SWARM score, verdict, source time and population", () => {
  const report = getBrowserSwarmSummaryFixture(), source = report.swarmAssessment!;
  source.score = 55; source.header.holders_count = 34; source.metrics.wallets = 28; source.metrics.hands = 27;
  const details = investigationShareDetails(report), svg = investigationShareSvg(report);
  assert.equal(details.authority, "swarm");
  assert.equal(details.assessment, "SWARM · Score 55 / 100 · AVOID");
  assert.equal(details.population, "34 reported holders");
  assert.equal(details.counts, "28 reported wallets · 27 inferred groups");
  assert.equal(details.sourceTime, `SWARM scan ${source.scannedAt}`);
  for (const text of [details.assessment, details.population, details.counts, details.sourceTime, details.snapshot]) assert.ok(svg.includes(text));
  assert.doesNotMatch(svg, /discovered addresses|linked groups|Transfer coverage/);
  assert.doesNotMatch(details.sourceTime, new RegExp(report.generatedAt.replaceAll(".", "\\.")));
  assert.match(details.qualification, /do not establish verified people/);
});

test("unavailable primary share data stays unavailable rather than borrowing independent counts or local score", () => {
  const report = getBrowserSwarmSummaryFixture(); delete report.swarmAssessment;
  report.swarmAvailability = { status: "unavailable", reason: "timeout", checkedAt: "2026-10-14T01:02:03.000Z" };
  const details = investigationShareDetails(report), svg = investigationShareSvg(report);
  assert.equal(details.assessment, "SWARM assessment unavailable");
  assert.equal(details.population, "SWARM holder and group counts unavailable");
  assert.match(details.sourceTime, /2026-10-14T01:02:03.000Z/);
  assert.doesNotMatch(svg, /Score [0-9]|AVOID|discovered addresses|linked groups/);
});

test("share exports retain unverified source timing without adding the warning to verified or legacy cards", () => {
  const report = getBrowserSwarmSummaryFixture(), warning = "Source scan time could not be verified against this request.";
  assert.equal(investigationShareDetails(report).freshness, warning);
  assert.ok(investigationShareSvg(report).includes(warning));
  const stamp = { requestedAt: report.swarmAssessment!.requestedAt, receivedAt: report.swarmAssessment!.checkedAt,
    sourceDate: null as string | null, elapsedMs: 2000, observedAfterMs: 2000 };
  report.swarmAssessment!.transport = { jobId: "synthetic-share-timing", start: stamp, result: stamp,
    freshness: "unverified", reason: "missing-source-clock" };
  assert.equal(investigationShareDetails(report).freshness, warning);
  report.swarmAssessment!.transport.start.sourceDate = report.swarmAssessment!.scannedAt;
  report.swarmAssessment!.transport.result.sourceDate = report.swarmAssessment!.scannedAt;
  report.swarmAssessment!.transport.freshness = "source-window-verified";
  report.swarmAssessment!.transport.reason = "matching-source-clock-window";
  assert.equal(investigationShareDetails(report).freshness, null);
  assert.ok(!investigationShareSvg(report).includes(warning));
  const legacy = getBrowserWalletFlagsFixture();
  assert.equal(investigationShareDetails(legacy).freshness, null);
});

test("missing source values are not zeros while actual reported zero stays zero", () => {
  const report = getBrowserSwarmSummaryFixture(), source = report.swarmAssessment!;
  source.score = null; source.header.holders_count = null; source.metrics.wallets = null; source.metrics.hands = null;
  const missing = investigationShareDetails(report);
  assert.equal(missing.assessment, "SWARM · Score unavailable · AVOID");
  assert.match(missing.population, /unavailable/); assert.match(missing.counts, /unavailable reported wallets.*unavailable inferred groups/);
  assert.doesNotMatch(missing.population + missing.counts, /\b0\b/);
  source.header.holders_count = 0; source.metrics.wallets = 0; source.metrics.hands = 0;
  const zero = investigationShareDetails(report);
  assert.equal(zero.population, "0 reported holders"); assert.equal(zero.counts, "0 reported wallets · 0 inferred groups");
});

test("SVG escapes source strings and bounds every text line within the fixed card width", () => {
  const report = getBrowserSwarmSummaryFixture();
  report.swarmAssessment!.header.name = `<tag>&"' malicious name`;
  const escaped = investigationShareSvg(report);
  assert.ok(escaped.includes("&lt;tag&gt;&amp;&quot;&apos;")); assert.ok(!escaped.includes("<tag>"));
  report.swarmAssessment!.header.name = "X".repeat(256);
  report.swarmAssessment!.header.holders_count = Number.MAX_SAFE_INTEGER;
  report.swarmAssessment!.metrics.wallets = Number.MAX_SAFE_INTEGER;
  report.swarmAssessment!.metrics.hands = Number.MAX_SAFE_INTEGER;
  report.range.to.number = "9".repeat(30);
  const svg = investigationShareSvg(report);
  assert.match(svg, new RegExp(`${"X".repeat(42)}…</text>`));
  for (const match of svg.matchAll(/<text[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)) {
    const emWidth = match[2].length * Number(match[1]) * 0.61;
    assert.ok(emWidth <= 900, `Card line exceeds available width: ${match[2]}`);
  }
  assert.doesNotMatch(svg, /style=|<script|foreignObject|https?:\/\/(?!www\.w3\.org)/);
});

test("legacy reports keep local authority and original independent population despite a secondary source", () => {
  const report = getBrowserWalletFlagsFixture();
  report.swarmAssessment = getBrowserSwarmAssessmentFixture(report);
  report.swarmAssessment.header.holders_count = 999;
  const details = investigationShareDetails(report), svg = investigationShareSvg(report);
  assert.equal(details.authority, "traceforge"); assert.match(details.assessment, /^TraceForge/);
  assert.equal(details.population, `${report.wallets.length} discovered addresses · ${report.groups.length} linked groups`);
  assert.equal(details.snapshot, `Finalized block ${report.range.to.number}`);
  assert.ok(svg.includes(details.population)); assert.doesNotMatch(svg, /999 reported holders|SWARM scan/);
});
