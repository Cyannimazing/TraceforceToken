import assert from "node:assert/strict";
import { test } from "node:test";
import { coveragePercentage, fundingSearchCounts, goalCardFinding, reportParticipants } from "../../src/components/investigation-report-facts";
import { validateInvestigationExplanation } from "../../src/domain/investigations/explanation";
import { canonicalExplanationOverview, canonicalFindingClaim } from "../../src/domain/investigations/explanation-grounding";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";

test("discovered candidates are counted separately from retained token-transfer participants", () => {
  const report = getBrowserReportFixture();
  assert.deepEqual(reportParticipants(report), { discovered: 3, retainedTokenParticipants: 2 });
  report.wallets.push({ ...report.wallets[0], address: "0x00000000000000000000000000000000000000ff", observedIncomingRaw: "0", observedOutgoingRaw: "0", observedNetRaw: "0", verifiedSoldRaw: "0", firstObservedAt: null });
  assert.deepEqual(reportParticipants(report), { discovered: 4, retainedTokenParticipants: 2 });
  report.evidence = report.evidence.filter((event) => event.kind !== "transfer");
  assert.deepEqual(reportParticipants(report), { discovered: 4, retainedTokenParticipants: 0 });
});

test("incomplete funding ratios never round to a displayed 100 percent", () => {
  assert.equal(coveragePercentage(200, 201), 99.5);
  assert.equal(coveragePercentage(9999, 10000), 99.9);
  assert.equal(coveragePercentage(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER), 99.9);
  assert.equal(coveragePercentage(201, 201), 100);
  assert.equal(coveragePercentage(0, 201), 0);
  assert.equal(coveragePercentage(0, 0), null);
  assert.equal(coveragePercentage(2, 1), null);
});

test("missing legacy funding rows count as not examined without changing unavailable coverage", () => {
  const report = getBrowserReportFixture();
  assert.deepEqual(fundingSearchCounts(report), { complete: 0, partial: 2, unavailable: 0, not_examined: 1 });
  report.coverage.funding[0].status = "unavailable";
  assert.deepEqual(fundingSearchCounts(report), { complete: 0, partial: 1, unavailable: 1, not_examined: 1 });
  report.coverage.funding.push({ ...report.coverage.funding[0], wallet: browserFixture.funder, status: "not_examined" });
  assert.deepEqual(fundingSearchCounts(report), { complete: 0, partial: 1, unavailable: 1, not_examined: 1 });
  report.coverage.funding = [];
  assert.deepEqual(fundingSearchCounts(report), { complete: 0, partial: 0, unavailable: 0, not_examined: 3 });
});

test("legacy commentary uses the finding with its complete proof rather than the first category title", () => {
  const report = getBrowserReportFixture();
  const firstFunding = report.findings.find((finding) => finding.category === "funding")!;
  const card = goalCardFinding(report, "funding");
  assert.equal(firstFunding.title, "First observed native funding");
  assert.equal(card.finding?.title, "Shared observed native funding source");
  assert.notEqual(card.finding?.id, firstFunding.id);
  assert.equal(card.observation?.caveat, report.explanation.observations[0].caveat);
  assert.equal(card.reviewed, false);
  assert.deepEqual([...card.finding!.evidenceIds].sort(), [...card.observation!.evidenceIds].sort());
  report.explanation.observations[0].evidenceIds = [browserFixture.id];
  assert.equal(goalCardFinding(report, "funding").observation, null);
});

test("canonical review selects its identified finding and refuses a partial supporting set", () => {
  const report = getBrowserReportFixture();
  const original = goalCardFinding(report, "funding").finding!;
  const selected = { ...original, id: "synthetic-selected-funding", title: "Synthetic exact selected finding" };
  report.findings.push(selected);
  report.explanation = validateInvestigationExplanation(report, {
    ...report.explanation, profileVersion: "1.4.0",
    overview: { text: canonicalExplanationOverview(report, [selected], []), evidenceIds: selected.evidenceIds },
    observations: [{ category: selected.category, claim: canonicalFindingClaim(selected), caveat: selected.limitations[0], evidenceIds: selected.evidenceIds }],
    grounding: { mode: "canonical-finding-selection", overviewFindingIds: [selected.id], overviewEvidenceIds: [], observations: [{ findingId: selected.id, caveatIndex: 0 }] },
  });
  const card = goalCardFinding(report, "funding");
  assert.equal(card.finding?.id, selected.id);
  assert.equal(card.reviewed, true);
  assert.equal(card.ambiguous, false);
  report.explanation.observations[0].evidenceIds = [selected.evidenceIds[0]];
  const partial = goalCardFinding(report, "funding");
  assert.equal(partial.observation, null);
  assert.equal(partial.reviewed, false);
});
