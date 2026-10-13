import assert from "node:assert/strict";
import test from "node:test";
import { assessInvestigationReport, type ReportAssessment } from "../../src/domain/investigations/report-assessment";
import { deriveDecisionXray } from "../../src/domain/investigations/report-judge";
import { browserFixture, getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

test("a real synthetic DANGER assessment exposes each supported category deduction once and keeps probabilities unknown", () => {
  const assessment = assessInvestigationReport(getBrowserWalletFlagsFixture());
  const before = structuredClone(assessment);
  assert.equal(assessment.band, "DANGER");
  const result = deriveDecisionXray(assessment);
  assert.equal(result.modelId, "traceforce-rules-1.3.0");
  assert.equal(result.base, 100);
  assert.deepEqual(result.rows.map(({ id, label, points, offset }) => ({ id, label, points, offset })), [
    { id: "swarm", label: "Swarm", points: 30, offset: 0 },
    { id: "insiders", label: "Insiders", points: 0.8, offset: 30 },
    { id: "concentration", label: "Concentration", points: 15, offset: 30.8 },
    { id: "snipers", label: "Snipers", points: 0.6, offset: 45.8 },
    { id: "dev", label: "Dev", points: 10, offset: 46.4 },
  ]);
  assert.equal(result.totalKnownDeduction, 56.4);
  assert.equal(result.unknownPossiblePoints, 0);
  assert.equal(result.uncappedMaximum, 43.6);
  assert.equal(result.maximum, 43.6);
  assert.equal(result.minimum, 43.6);
  assert.equal(result.gateCapDeduction, undefined, "a soft cap of 59 cannot deduct again when the known ledger is already below it");
  assert.equal(result.overallScore, null);
  assert.deepEqual(result.probabilities, { avoid: null, caution: null, ok: null });
  for (const row of result.rows) {
    const category = assessment.categories.find((item) => item.id === row.id)!;
    assert.equal(row.basis, category.basis);
    assert.equal(row.metric, category.metric);
    assert.equal(row.points, Math.round((category.possiblePoints - category.points!) * 10) / 10);
  }
  assert.deepEqual(assessment, before);
});

test("a binding soft gate is separate from known category deductions and reconstructs the actual maximum", () => {
  const report = getBrowserWalletFlagsFixture();
  delete report.liquiditySnapshot;
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.band, "RISKY");
  assert.equal(assessment.scoreRange.maximum, 59);
  const result = deriveDecisionXray(assessment);
  assert.deepEqual(result.rows.map(({ id, points, offset }) => ({ id, points, offset })), [
    { id: "insiders", points: 0.8, offset: 0 },
    { id: "concentration", points: 15, offset: 0.8 },
    { id: "snipers", points: 0.6, offset: 15.8 },
    { id: "dev", points: 10, offset: 16.4 },
  ]);
  assert.equal(result.totalKnownDeduction, 26.4);
  assert.equal(result.unknownPossiblePoints, 30);
  assert.equal(result.uncappedMaximum, 73.6);
  assert.equal(result.gateCapDeduction, 14.6);
  assert.equal(result.maximum, 59);
  assert.equal(Math.round((result.base - result.totalKnownDeduction - result.gateCapDeduction!) * 10) / 10, result.maximum);
  assert.equal(result.overallScore, null);
  assert.deepEqual(result.probabilities, { avoid: null, caution: null, ok: null });
});

test("an unknown assessment has no invented contribution, score, probability or clean points", () => {
  const assessment = assessInvestigationReport(getBrowserReportFixture());
  const result = deriveDecisionXray(assessment);
  assert.equal(assessment.verdict, "INSUFFICIENT");
  assert.deepEqual(result.rows, []);
  assert.equal(result.totalKnownDeduction, 0);
  assert.equal(result.unknownPossiblePoints, 100);
  assert.equal(result.uncappedMaximum, 100);
  assert.equal(result.maximum, 100);
  assert.equal(result.minimum, 0);
  assert.equal(result.overallScore, null);
  assert.equal(result.gateCapDeduction, undefined);
  assert.deepEqual(result.probabilities, { avoid: null, caution: null, ok: null });
});

test("a source-only hard warning cannot become an arbitrary numerical contribution", () => {
  const report = getBrowserReportFixture();
  report.token.securitySnapshot = {
    source: "goplus", status: "reported", checkedAt: report.generatedAt,
    tokenAddress: report.token.address, chainId: 8453,
    sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`,
    holderCount: null, creatorAddress: null, checks: [{ id: "is_honeypot", value: "yes" }],
  };
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.band, "DANGER");
  assert.ok(assessment.gates.some((gate) => gate.id === "is_honeypot"));
  const result = deriveDecisionXray(assessment);
  assert.deepEqual(result.rows, []);
  assert.equal(result.totalKnownDeduction, 0);
  assert.equal(result.unknownPossiblePoints, 100);
  assert.equal(result.maximum, 100);
  assert.deepEqual(result.probabilities, { avoid: null, caution: null, ok: null });
});

test("multiple triggered rules in one category do not stack category deductions", () => {
  const assessment = assessInvestigationReport(getBrowserWalletFlagsFixture());
  const before = deriveDecisionXray(assessment);
  assessment.triggeredRules.push({ ...assessment.triggeredRules[0], id: "synthetic-duplicate-rule", addresses: [browserFixture.walletA] });
  const result = deriveDecisionXray(assessment);
  assert.equal(result.rows.filter((row) => row.id === assessment.triggeredRules[0].category).length, 1);
  assert.equal(result.totalKnownDeduction, before.totalKnownDeduction);
});

test("known awarded points reduce the deduction without turning the remaining bound into an exact score", () => {
  const assessment = assessInvestigationReport(getBrowserReportFixture());
  const category = assessment.categories.find((row) => row.id === "concentration")!;
  category.points = 5;
  assessment.assessedPoints = 5;
  assessment.assessedPossiblePoints = 15;
  assessment.scoreRange = { minimum: 0, maximum: 90 };
  const result = deriveDecisionXray(assessment);
  assert.equal(result.rows[0].points, 10);
  assert.equal(result.totalKnownDeduction, 10);
  assert.equal(result.unknownPossiblePoints, 85);
  assert.equal(result.uncappedMaximum, 90);
  assert.equal(result.maximum, 90);
  assert.equal(result.minimum, 0);
  assert.equal(result.overallScore, null);
});

test("duplicate categories, bad weight checksums, invalid points and inconsistent bounds are rejected", () => {
  const mutations: ((assessment: ReportAssessment) => void)[] = [
    (value) => { value.categories.push({ ...value.categories[0] }); },
    (value) => { value.categories[0].possiblePoints = 29; },
    (value) => { value.categories[0].possiblePoints += value.categories.pop()!.possiblePoints; },
    (value) => { value.categories[0].points = -1; },
    (value) => { value.categories[0].points = 31; },
    (value) => { value.categories[0].points = Number.NaN; },
    (value) => { value.assessedPossiblePoints = 1; },
    (value) => { value.assessedPoints = 1; },
    (value) => { value.scoreRange.minimum = -1; },
    (value) => { value.scoreRange.maximum = 101; },
    (value) => { value.scoreRange.minimum = 101; },
    (value) => { value.scoreRange.maximum = Number.NaN; },
  ];
  for (const mutate of mutations) {
    const assessment = assessInvestigationReport(getBrowserReportFixture());
    mutate(assessment);
    assert.throws(() => deriveDecisionXray(assessment), RangeError);
  }
  const danger = assessInvestigationReport(getBrowserWalletFlagsFixture());
  danger.scoreRange.maximum = 46;
  assert.throws(() => deriveDecisionXray(danger), RangeError, "the bound cannot exceed 100 minus supported deductions");
});

test("decimal tenths reconstruct a complete ledger without binary-fraction drift", () => {
  const assessment = assessInvestigationReport(getBrowserReportFixture());
  for (const [index, category] of assessment.categories.entries()) {
    category.points = index === 0 ? 0.1 : index === 1 ? 0.2 : 0;
    category.status = category.points > 0 ? "measured" : "concern";
  }
  assessment.assessedPoints = 0.3;
  assessment.assessedPossiblePoints = 100;
  assessment.scoreRange = { minimum: 0.3, maximum: 0.3 };
  const result = deriveDecisionXray(assessment);
  assert.equal(result.totalKnownDeduction, 99.7);
  assert.equal(result.uncappedMaximum, 0.3);
  assert.equal(result.maximum, 0.3);
  assert.equal(result.gateCapDeduction, undefined);
});
