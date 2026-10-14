import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePrimaryAssessment, swarmUnavailableReason } from "../../src/domain/investigations/primary-assessment";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";
import { getBrowserSwarmAssessmentFixture } from "../fixtures/swarm-report";

test("one explicitly selected SWARM snapshot owns primary score, verdict, population and source time", () => {
  const report = getBrowserWalletFlagsFixture(); report.assessmentAuthority = "swarm";
  report.swarmAssessment = getBrowserSwarmAssessmentFixture(report);
  report.swarmAssessment.judge.decision = "OK"; report.swarmAssessment.judge.p = { avoid: 0.1, caution: 0.1, ok: 0.8 }; report.swarmAssessment.judge.confidence = 0.8;
  const primary = derivePrimaryAssessment(report);
  assert.equal(assessInvestigationReport(report).verdict, "AVOID");
  assert.equal(primary.status, "reported");
  if (primary.status !== "reported") throw new Error("Expected source snapshot.");
  assert.equal(primary.verdict, "OK"); assert.equal(primary.score, 45);
  assert.equal(primary.dataThrough, report.swarmAssessment.scannedAt);
  assert.equal(primary.sourceUrl, report.swarmAssessment.sourceUrl);
  assert.deepEqual(primary.snapshot.parts, report.swarmAssessment.parts);
  assert.equal(primary.snapshot.metrics.wallets, 12);
});

test("source availability never silently promotes local values and missing score remains null", () => {
  const report = getBrowserWalletFlagsFixture(); report.assessmentAuthority = "swarm";
  const missing = derivePrimaryAssessment(report);
  assert.equal(missing.status, "unavailable"); assert.equal(missing.verdict, "INSUFFICIENT"); assert.equal(missing.score, null);
  report.swarmAssessment = getBrowserSwarmAssessmentFixture(report); report.swarmAssessment.score = null;
  assert.equal(derivePrimaryAssessment(report).score, null);
  report.swarmAssessment.tokenAddress = `0x${"2".repeat(40)}`;
  assert.throws(() => derivePrimaryAssessment(report), "malformed identity is not an availability fallback");
});

test("legacy absent authority and explicit local authority preserve original local assessment", () => {
  const report = getBrowserWalletFlagsFixture(), local = assessInvestigationReport(report);
  report.swarmAssessment = getBrowserSwarmAssessmentFixture(report);
  const legacy = derivePrimaryAssessment(report);
  assert.equal(legacy.authority, "traceforge"); assert.equal(legacy.verdict, local.verdict); assert.equal(legacy.score, local.displayedScore);
  report.assessmentAuthority = "traceforge";
  assert.deepEqual(derivePrimaryAssessment(report), legacy);
});

test("unavailable primary assessment preserves each validated cause without source values or local fallback", () => {
  const report = getBrowserWalletFlagsFixture(); report.assessmentAuthority = "swarm";
  const causes = {
    timeout: /did not finish.*time limit/, rate_limited: /limiting scan requests/, access_denied: /denied access/,
    stale_result: /returned an older result/, invalid_response: /did not pass the response checks/,
    identity_mismatch: /did not match this token and network/, job_failed: /did not complete successfully/,
    unavailable: /could not provide an assessment/,
  } as const;
  for (const reason of Object.keys(causes) as (keyof typeof causes)[]) {
    report.swarmAvailability = { status: "unavailable", reason, checkedAt: "2026-10-14T00:00:00.000Z" };
    const primary = derivePrimaryAssessment(report);
    assert.equal(primary.status, "unavailable");
    if (primary.status !== "unavailable") throw new Error("Expected unavailable source.");
    assert.match(primary.unavailableReason, causes[reason]); assert.equal(primary.unavailableReason, swarmUnavailableReason(reason));
    assert.equal(primary.checkedAt, report.swarmAvailability.checkedAt); assert.equal(primary.score, null);
    assert.equal(primary.dataThrough, null); assert.equal(primary.verdict, "INSUFFICIENT"); assert.equal(primary.band, "UNKNOWN");
  }
  delete report.swarmAvailability;
  const legacy = derivePrimaryAssessment(report);
  assert.equal(legacy.status, "unavailable");
  if (legacy.status === "unavailable") assert.equal(legacy.unavailableReason, "SWARM's assessment is unavailable for this scan.");
  assert.throws(() => swarmUnavailableReason("untrusted upstream text" as "timeout"), /Unknown SWARM availability reason/);
  assert.throws(() => swarmUnavailableReason("constructor" as "timeout"), /Unknown SWARM availability reason/);
});
