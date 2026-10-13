import assert from "node:assert/strict";
import { test } from "node:test";
import { getBrowserWalletFlagsFixture, browserFixture } from "../fixtures/report";
import { validateCreatorFundingCoverage } from "../../src/domain/investigations/creator-funding";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { validateBaseInvestigationReport } from "../../src/domain/investigations/report-validation";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";

function fixture() {
  const report = getBrowserWalletFlagsFixture();
  const mint = report.evidence.find((row) => row.from === `0x${"0".repeat(40)}` && row.assetAddress === report.token.address)!;
  mint.creation = { creator: browserFixture.funder, contractAddress: report.token.address, receiptStatus: "0x1", transactionTo: null };
  const cohort = report.walletActivitySnapshot!.rows.filter((row) => row.code === "eoa" && row.address !== browserFixture.funder).map((row) => row.address);
  report.coverage.creatorFunding = { creator: browserFixture.funder, source: "alchemy-transfers", scope: "direct-creator-external-native", status: "complete", fromBlock: "0", toBlock: report.range.to.number, cohort, evidenceIds: report.evidence.filter((row) => row.kind === "funding" && row.from === browserFixture.funder).map((row) => row.id), paginationExhausted: true, internalTransfers: "not_examined", reason: "Synthetic exhausted creator-only query; no recipient histories established." };
  report.coverage.funding = report.coverage.funding.map((row) => ({ ...row, status: "not_examined" }));
  report.coverage.examinedWallets = 0;
  return report;
}

test("completed direct-creator query measures Insider exposure despite unexamined inbound histories", () => {
  const report = fixture(), before = structuredClone(report.coverage.funding);
  const result = assessInvestigationReport(report);
  assert.equal(result.metrics.insiderSharePercent, "1.51");
  assert.equal(result.categories.find((row) => row.id === "insiders")!.points, 14.2);
  assert.deepEqual(report.coverage.funding, before);
  const plain = { ...report }; delete (plain as { explanation?: unknown }).explanation;
  assert.deepEqual(validateBaseInvestigationReport(plain).coverage.creatorFunding, report.coverage.creatorFunding);
  const { infrastructure, ...rest } = report;
  const analyzed = analyzeInvestigation({ ...rest, pools: infrastructure!.pools, hubs: infrastructure!.hubs }, { id: report.id, generatedAt: report.generatedAt });
  assert.equal(analyzed.coverage.creatorFunding!.status, "complete");
  assert.equal(analyzed.coverage.funding.every((row) => row.status === "not_examined"), true);
  assert.match(analyzed.findings.find((row) => row.category === "funding")!.limitations.join(" "), /creator-only/);
});

test("partial or incomplete creator cohorts cannot earn Insider credits", () => {
  for (const variant of ["partial", "cohort", "no-proof", "wrong-creator", "wrong-range", "not-exhausted", "bad-evidence", "contract-cohort"]) {
    const report = fixture(), coverage = report.coverage.creatorFunding!;
    if (variant === "partial") { coverage.status = "partial"; coverage.paginationExhausted = false; }
    if (variant === "cohort") coverage.cohort = coverage.cohort.slice(1);
    if (variant === "no-proof") delete report.evidence.find((row) => row.creation)!.creation;
    if (variant === "wrong-creator") coverage.creator = browserFixture.walletA;
    if (variant === "wrong-range") coverage.fromBlock = "1";
    if (variant === "not-exhausted") coverage.paginationExhausted = false;
    if (variant === "bad-evidence") coverage.evidenceIds = ["missing"];
    if (variant === "contract-cohort") report.walletActivitySnapshot!.rows.find((row) => row.address === coverage.cohort[0])!.code = "contract";
    const assessment = assessInvestigationReport(report);
    assert.equal(assessment.metrics.insiderSharePercent, null, variant);
    assert.equal(assessment.categories.find((row) => row.id === "insiders")!.points, null, variant);
  }
});

test("an exhausted verified creator query can establish zero observed direct Insider share within its scope", () => {
  const report = fixture();
  report.evidence = report.evidence.filter((row) => row.kind !== "funding");
  report.coverage.creatorFunding!.evidenceIds = [];
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.metrics.insiderSharePercent, "0.00");
  assert.equal(assessment.categories.find((row) => row.id === "insiders")!.points, 15);
  assert.equal(report.coverage.funding.every((row) => row.status === "not_examined"), true);
  assert.match(assessment.categories.find((row) => row.id === "insiders")!.limitations.join(" "), /internal transfers or indirect connections/);
});

test("coverage rejects duplicate cohorts, unknown evidence, wrong sender and falsified completion", () => {
  for (const variant of ["duplicate", "sender", "unknown", "completion", "snapshot"]) {
    const report = fixture(), coverage = report.coverage.creatorFunding!;
    if (variant === "duplicate") coverage.cohort.push(coverage.cohort[0]);
    if (variant === "sender") report.evidence.find((row) => row.id === coverage.evidenceIds[0])!.from = browserFixture.walletA;
    if (variant === "unknown") coverage.evidenceIds.push("unknown");
    if (variant === "completion") coverage.paginationExhausted = false;
    if (variant === "snapshot") report.walletActivitySnapshot!.block = { ...report.range.to, number: "399" };
    assert.throws(() => validateCreatorFundingCoverage(coverage, report), Error, variant);
  }
});

test("analysis normalizes creator funding evidence aliases with the canonical native proof", () => {
  const report = fixture();
  const funding = report.evidence.find((row) => row.id === report.coverage.creatorFunding!.evidenceIds[0])!;
  const canonicalId = funding.id;
  funding.id = "source-native-alias";
  report.coverage.creatorFunding!.evidenceIds = [funding.id];
  const analyzed = analyzeInvestigation({ ...report, pools: report.infrastructure!.pools, hubs: report.infrastructure!.hubs }, { id: report.id, generatedAt: report.generatedAt });
  assert.deepEqual(analyzed.coverage.creatorFunding!.evidenceIds, [canonicalId]);
  assert.doesNotThrow(() => validateBaseInvestigationReport(analyzed));
});
