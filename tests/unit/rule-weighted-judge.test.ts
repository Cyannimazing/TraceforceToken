import assert from "node:assert/strict";
import test from "node:test";
import { assessInvestigationReport, type ReportAssessment } from "../../src/domain/investigations/report-assessment";
import { deriveRuleWeightedJudge, type RuleWeightedJudgeInput } from "../../src/domain/investigations/report-judge";
import { getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("DANGER weights reconstruct the category ledger and authenticated impact without copied reference percentages", () => {
  const assessment = assessInvestigationReport(getBrowserWalletFlagsFixture());
  const before = structuredClone(assessment), result = deriveRuleWeightedJudge(assessment);
  assert.equal(result.modelId, "traceforce-judge-1.0.0");
  assert.equal(result.decision, "AVOID");
  assert.equal(result.selectedWeight, "avoid");
  assert.equal(result.calibrated, false);
  const deduction = assessment.categories.filter((row) => row.status !== "not_assessed").reduce((sum, row) => sum + row.possiblePoints - row.points!, 0);
  const missing = assessment.categories.filter((row) => row.status === "not_assessed").reduce((sum, row) => sum + row.possiblePoints, 0);
  const impact = Number(assessment.metrics.dumpImpactPercent) / 100;
  close(result.masses.avoid, deduction / 100 + 2 + impact);
  close(result.masses.caution, missing / 100);
  close(result.masses.ok, assessment.assessedPoints / 100);
  close(result.totalMass, 3 + impact);
  close(result.weights.avoid, result.masses.avoid / result.totalMass);
  close(result.weights.avoid + result.weights.caution + result.weights.ok, 1);
  assert.equal(result.decisionWeight, result.weights.avoid);
  assert.deepEqual(result.contributions.map((row) => row.id), ["base", "decision-policy", "dump-impact"]);
  close(result.contributions[2].avoidOffset, deduction / 100 + 2);
  assert.ok(result.weights.avoid > result.weights.caution && result.weights.avoid > result.weights.ok);
  assert.equal(result.displayTenths.avoid + result.displayTenths.caution + result.displayTenths.ok, 1000);
  assert.ok(result.policy.some((line) => line.includes("not calibrated")));
  assert.deepEqual(assessment, before);
});

test("unknown-only inputs support caution exclusively, including requested zero display values", () => {
  const assessment = assessInvestigationReport(getBrowserReportFixture());
  const unknown = deriveRuleWeightedJudge(assessment);
  assert.equal(unknown.decision, "INSUFFICIENT");
  assert.deepEqual(unknown.weights, { avoid: 0, caution: 1, ok: 0 });
  assert.deepEqual(unknown.displayPercentages, { avoid: "0.0%", caution: "100.0%", ok: "0.0%" });
  assert.deepEqual(unknown.contributions[0].masses, { avoid: 0, caution: 1, ok: 0 });
  for (const category of assessment.categories) category.points = 0;
  const displayedZeros = deriveRuleWeightedJudge(assessment);
  assert.deepEqual(displayedZeros.weights, unknown.weights, "zero display never converts missing evidence into a risk deduction or favorable credit");
});

test("soft warning precedence remains CAUTION despite known deductions", () => {
  const report = getBrowserWalletFlagsFixture();
  delete report.liquiditySnapshot;
  const assessment = assessInvestigationReport(report), result = deriveRuleWeightedJudge(assessment);
  assert.equal(result.decision, "CAUTION");
  assert.equal(result.selectedWeight, "caution");
  assert.ok(result.weights.caution > result.weights.avoid);
  assert.ok(result.weights.caution > result.weights.ok);
  assert.deepEqual(result.contributions.map((row) => row.id), ["base", "decision-policy"]);
  assert.equal(result.contributions[1].target, "caution");
  assert.equal(result.contributions[1].mass, 2);
  close(result.weights.ok, assessment.assessedPoints / 100 / result.totalMass);
});

test("a source-reported hard warning is ranked by explicit local policy without fabricated chain severity", () => {
  const report = getBrowserReportFixture();
  report.token.securitySnapshot = {
    source: "goplus", status: "reported", checkedAt: report.generatedAt, tokenAddress: report.token.address, chainId: 8453,
    sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`,
    holderCount: null, creatorAddress: null, checks: [{ id: "is_honeypot", value: "yes" }],
  };
  const result = deriveRuleWeightedJudge(assessInvestigationReport(report));
  assert.equal(result.decision, "AVOID");
  assert.deepEqual(result.masses, { avoid: 2, caution: 1, ok: 0 });
  close(result.weights.avoid, 2 / 3);
  assert.equal(result.contributions.some((row) => row.id === "dump-impact"), false);
  assert.deepEqual(result.displayPercentages, { avoid: "66.7%", caution: "33.3%", ok: "0.0%" });
});

test("larger authenticated hypothetical impact monotonically increases avoid weight", () => {
  const assessment = assessInvestigationReport(getBrowserWalletFlagsFixture());
  let previous = -1;
  for (const impact of ["50", "60", "75", "90", "99.99", "100"]) {
    assessment.metrics.dumpImpactPercent = impact;
    const result = deriveRuleWeightedJudge(assessment);
    assert.ok(result.weights.avoid > previous);
    assert.equal(result.decision, "AVOID");
    previous = result.weights.avoid;
  }
});

test("replacing a missing category with established deductions raises avoid support without earning OK credits", () => {
  const assessment = assessInvestigationReport(getBrowserReportFixture());
  const before = deriveRuleWeightedJudge(assessment);
  const fresh = assessment.categories.find((row) => row.id === "fresh")!;
  assert.equal(fresh.status, "not_assessed");
  fresh.status = "concern"; fresh.points = 0;
  assessment.scoreRange.maximum -= fresh.possiblePoints;
  const after = deriveRuleWeightedJudge(assessment);
  assert.ok(after.weights.avoid > before.weights.avoid);
  assert.ok(after.weights.caution < before.weights.caution);
  assert.equal(after.weights.ok, 0);
  close(after.totalMass, before.totalMass);
});

test("only established earned points contribute OK mass while hard warnings keep AVOID dominant", () => {
  const assessment = assessInvestigationReport(getBrowserWalletFlagsFixture());
  const previouslyEarned = assessment.assessedPoints;
  const dev = assessment.categories.find((row) => row.id === "dev")!;
  dev.points = 5;
  const result = deriveRuleWeightedJudge(assessment);
  close(result.masses.ok, (previouslyEarned + 5) / 100);
  assert.ok(result.weights.avoid > result.weights.ok);
  assert.equal(result.selectedWeight, "avoid");
});

test("displayed weights always total 100.0% and preserve deterministic rounding", () => {
  for (const report of [getBrowserReportFixture(), getBrowserWalletFlagsFixture()]) {
    const assessment = assessInvestigationReport(report);
    for (let numerator = 50; numerator <= 100; numerator++) {
      if (assessment.gates.some((gate) => gate.id === "dump-impact")) assessment.metrics.dumpImpactPercent = String(numerator + (numerator === 100 ? 0 : 0.013));
      const result = deriveRuleWeightedJudge(assessment);
      assert.equal(Object.values(result.displayTenths).reduce((sum, value) => sum + value, 0), 1000);
      for (const key of ["avoid", "caution", "ok"] as const) {
        assert.match(result.displayPercentages[key], /^\d+\.\d%$/);
        assert.ok(Math.abs(result.displayTenths[key] / 1000 - result.weights[key]) < 0.001);
      }
      assert.deepEqual(deriveRuleWeightedJudge(assessment).displayTenths, result.displayTenths);
    }
  }
});

test("duplicate warning rows cannot inflate decision weight", () => {
  const assessment = assessInvestigationReport(getBrowserWalletFlagsFixture());
  assessment.gates.push({ ...assessment.gates[0] });
  assert.throws(() => deriveRuleWeightedJudge(assessment), RangeError);
});

test("decimal category tenths keep exact ledger bounds valid during normalization", () => {
  const assessment = assessInvestigationReport(getBrowserReportFixture());
  for (const [index, category] of assessment.categories.entries()) {
    category.points = index === 0 ? 0.1 : index === 1 ? 0.2 : 0;
    category.status = category.points > 0 ? "measured" : "concern";
  }
  assessment.scoreRange = { minimum: 0.3, maximum: 0.3 };
  const result = deriveRuleWeightedJudge(assessment);
  assert.deepEqual(result.contributions[0].masses, { avoid: 0.997, caution: 0, ok: 0.003 });
  assert.equal(result.totalMass, 3);
  assert.equal(Object.values(result.displayTenths).reduce((sum, value) => sum + value, 0), 1000);
});

test("malformed weights, category state, bounds and dump severity are rejected", () => {
  const mutations: ((assessment: ReportAssessment) => void)[] = [
    (value) => { value.categories.push({ ...value.categories[0] }); },
    (value) => { value.categories[0].possiblePoints = 29; },
    (value) => { value.categories[0].points = Number.NaN; },
    (value) => { value.categories[0].points = -1; },
    (value) => { value.categories[0].points = 31; },
    (value) => { value.categories[0].status = "not_assessed"; value.categories[0].points = 1; },
    (value) => { value.categories.find((row) => row.status === "concern")!.points = null; },
    (value) => { value.scoreRange.minimum = -1; },
    (value) => { value.scoreRange.maximum = 101; },
    (value) => { value.scoreRange.maximum = Number.NaN; },
    (value) => { value.metrics.dumpImpactPercent = null; },
    (value) => { value.metrics.dumpImpactPercent = "49.99"; },
    (value) => { value.metrics.dumpImpactPercent = "100.01"; },
    (value) => { value.metrics.dumpImpactPercent = "Infinity"; },
    (value) => { value.verdict = "CAUTION"; },
  ];
  for (const mutate of mutations) {
    const assessment = assessInvestigationReport(getBrowserWalletFlagsFixture());
    mutate(assessment);
    assert.throws(() => deriveRuleWeightedJudge(assessment), RangeError);
  }
  const badSeverity = assessInvestigationReport(getBrowserWalletFlagsFixture()) as RuleWeightedJudgeInput;
  badSeverity.gates[0].severity = "unsupported" as "hard";
  assert.throws(() => deriveRuleWeightedJudge(badSeverity), RangeError);
});
