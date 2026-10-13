import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INVESTIGATION_REPORT_BYTES, sameInvestigationAnalysis, validateBaseInvestigationReport, validateExplainedReport } from "../../src/domain/investigations/report-validation";
import { getBrowserReportFixture } from "../fixtures/report";

test("shared report validation preserves complete synthetic report and exact large raw amounts", () => {
  const report = getBrowserReportFixture();
  assert.deepEqual(validateExplainedReport(JSON.parse(JSON.stringify(report))), report);
  assert.ok(report.evidence.some((event) => BigInt(event.amountRaw) > BigInt(Number.MAX_SAFE_INTEGER)));
});

test("analysis previews validate acquired facts without accepting an invented AI explanation", () => {
  const source = getBrowserReportFixture(), { explanation, ...base } = source;
  const preview = validateBaseInvestigationReport(base);
  assert.deepEqual(preview, base); assert.equal("explanation" in preview, false);
  assert.equal(sameInvestigationAnalysis(preview, source), true);
  assert.throws(() => validateBaseInvestigationReport({ ...base, explanation }));
  assert.throws(() => validateBaseInvestigationReport({ ...base, explanation: null }));
  assert.equal(sameInvestigationAnalysis(preview, { ...source, summary: "Changed after the preview." }), false);
  assert.equal(sameInvestigationAnalysis({ ...preview, token: { ...preview.token, address: preview.token.address } }, { ...source, infrastructure: { hubs: [], pools: [] } }), false, "optional authenticated context cannot change after preview");
  const reordered = Object.fromEntries(Object.entries(source).reverse()) as typeof source;
  assert.equal(sameInvestigationAnalysis(preview, reordered), true, "object-key normalization preserves all scan values");
});

test("base preview citations resolve to unique retained evidence before rendering", () => {
  const source = { ...getBrowserReportFixture() };
  Reflect.deleteProperty(source, "explanation");
  for (const mutate of [
    (report: typeof source) => { report.findings[0].evidenceIds.push("invented"); },
    (report: typeof source) => { report.connections[0].evidenceIds.push("invented"); },
    (report: typeof source) => { report.story[0].evidenceIds.push("invented"); },
    (report: typeof source) => { report.evidence.push(report.evidence[0]); },
  ]) { const report = structuredClone(source); mutate(report); assert.throws(() => validateBaseInvestigationReport(report)); }
});

test("shared report validation rejects invalid dates, chain identity, and numeric blockchain amounts", () => {
  const changes = [
    (report: ReturnType<typeof getBrowserReportFixture>) => { report.generatedAt = "not-a-date"; },
    (report: ReturnType<typeof getBrowserReportFixture>) => { Reflect.set(report.token, "chainId", 1); },
    (report: ReturnType<typeof getBrowserReportFixture>) => { Reflect.set(report.evidence[0], "amountRaw", 1); },
    (report: ReturnType<typeof getBrowserReportFixture>) => { report.evidence[0].amountRaw = (1n << 256n).toString(); },
    (report: ReturnType<typeof getBrowserReportFixture>) => { report.evidence[0].timestamp = 8_640_000_000_001; },
  ];
  for (const mutate of changes) {
    const report = getBrowserReportFixture(); mutate(report);
    assert.throws(() => validateExplainedReport(report), { message: "Invalid investigation report." });
  }
});

test("shared report validation requires model explanation and rejects invented citations", () => {
  const missing = getBrowserReportFixture();
  Reflect.deleteProperty(missing, "explanation");
  assert.throws(() => validateExplainedReport(missing), { message: "Invalid investigation report." });
  const invented = getBrowserReportFixture();
  invented.explanation.overview.evidenceIds.push("provider-private-key-not-a-real-reference");
  assert.throws(() => validateExplainedReport(invented), { message: "Invalid investigation report." });
});

test("shared report byte cap counts UTF-8 bytes before accepting browser/server output", () => {
  const report = getBrowserReportFixture();
  report.summary = "é".repeat(MAX_INVESTIGATION_REPORT_BYTES / 2);
  assert.throws(() => validateExplainedReport(report), { message: "Invalid investigation report." });
});

test("reported websites remain attributed metadata and reject unsafe or mismatched stored links", () => {
  const report = getBrowserReportFixture();
  report.token.webPresence = {
    source: "dexscreener", status: "reported", checkedAt: "2026-10-12T04:00:00.000Z",
    sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`,
    matchedPairs: 1, reason: null,
    websites: [{ url: "https://project.org/", pairAddresses: ["0x1111111111111111111111111111111111111111"] }],
  };
  assert.deepEqual(validateExplainedReport(report).token.webPresence, report.token.webPresence);
  for (const url of ["javascript:alert(1)", "https://user:secret@project.org/", "https://127.0.0.1/", "https://project.local/", "https://project.org:8443/"]) {
    const changed = structuredClone(report);
    changed.token.webPresence!.websites[0].url = url;
    assert.throws(() => validateExplainedReport(changed), { message: "Invalid investigation report." });
  }
  const mismatch = structuredClone(report);
  mismatch.token.webPresence!.sourceUrl = "https://api.dexscreener.com/token-pairs/v1/base/0x2222222222222222222222222222222222222222";
  assert.throws(() => validateExplainedReport(mismatch), { message: "Invalid investigation report." });
});

test("pinned balances survive the shared boundary only with matching snapshot identity and exact wallet amounts", () => {
  const report = getBrowserReportFixture(), maximum = (2n ** 256n - 1n).toString();
  report.token.totalSupplyRaw = maximum;
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, totalSupplyRaw: maximum, block: report.range.to,
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${report.token.address}/holders`, observedAt: report.generatedAt, status: "complete", pages: 1, addresses: report.wallets.length, finalizedCensus: false, reason: "Synthetic completed latest pages, not a finalized census." },
    balances: { status: "complete", requestedWallets: report.wallets.length, verifiedWallets: report.wallets.length, reason: null },
    holders: report.wallets.map((wallet, index) => ({ address: wallet.address, balanceRaw: index === 0 ? maximum : "0", status: "verified", discoveredBy: "both" })),
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: report.generatedAt },
  };
  report.wallets.forEach((wallet, index) => { wallet.balanceRaw = index === 0 ? maximum : "0"; });
  assert.deepEqual(validateExplainedReport(report).holderSnapshot, report.holderSnapshot);
  assert.equal(validateExplainedReport(report).wallets[0].balanceRaw, maximum);
  for (const mutate of [
    (value: typeof report) => { value.holderSnapshot!.block = { ...value.holderSnapshot!.block, number: "401" }; },
    (value: typeof report) => { value.wallets[0].balanceRaw = "1"; },
    (value: typeof report) => { value.holderSnapshot!.totalSupplyRaw = "100"; },
    (value: typeof report) => { value.holderSnapshot!.balances.verifiedWallets--; },
  ]) { const changed = structuredClone(report); mutate(changed); assert.throws(() => validateExplainedReport(changed)); }
  const noSnapshot = getBrowserReportFixture(); noSnapshot.wallets[0].balanceRaw = "0";
  assert.throws(() => validateExplainedReport(noSnapshot));
});

test("market metadata keeps exact source prices and rejects another token or inconsistent unavailable metrics", () => {
  const report = getBrowserReportFixture();
  report.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt: report.generatedAt, sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: "0x1111111111111111111111111111111111111111", priceUsd: "0.000000000000000000123456789", marketCapUsd: 123, liquidityUsd: 200, volume24hUsd: 300, priceChange24hPercent: -2, pairCreatedAt: 1_700_000_000_000 };
  assert.deepEqual(validateExplainedReport(report).token.marketSnapshot, report.token.marketSnapshot);
  for (const mutate of [
    (value: typeof report) => { value.token.marketSnapshot!.sourceUrl = "https://api.dexscreener.com/token-pairs/v1/base/0x2222222222222222222222222222222222222222"; },
    (value: typeof report) => { value.token.marketSnapshot!.status = "unavailable"; },
    (value: typeof report) => { value.token.marketSnapshot!.pairCreatedAt = 1_700_000_000; },
    (value: typeof report) => { Reflect.set(value.token.marketSnapshot!, "priceUsd", 1e-19); },
  ]) { const changed = structuredClone(report); mutate(changed); assert.throws(() => validateExplainedReport(changed)); }
});
