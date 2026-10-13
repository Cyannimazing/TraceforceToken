import assert from "node:assert/strict";
import test from "node:test";
import { verifyPublicReference } from "../../scripts/verification/public-reference";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { deriveHolderTableDistribution } from "../../src/domain/investigations/holder-table-distribution";
import { exactPercent } from "../../src/domain/investigations/report-distribution";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";

function fixture() {
  const report = getBrowserWalletFlagsFixture(), assessment = assessInvestigationReport(report), table = deriveHolderTableDistribution(report);
  const reference = { result: {
    scanned_at: report.range.to.timestamp, score: 45,
    metrics: { biggest: Number(assessment.metrics.largestSharePercent) / 100, snipers: Number(assessment.metrics.sniperSharePercent) / 100, dev: Number(assessment.metrics.creatorSharePercent) / 100 },
    holders: table.holders.map((holder) => ({ address: holder.address, share: Number(exactPercent(BigInt(holder.balanceRaw!), BigInt(table.holdingDenominatorRaw!))) / 100 })),
  } };
  return { report, reference };
}

test("reference verification uses one public cached GET and compares measurements without equating score policies", async () => {
  const { report, reference } = fixture();
  let calls = 0;
  const result = await verifyPublicReference(report, new AbortController().signal, async (input, init) => {
    calls++;
    assert.equal(input, `https://swarmengine.tech/api/token/base/${report.token.address}`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    return Response.json(reference);
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "matched-at-reference-display-precision");
  assert.equal(result.comparedWallets, reference.result.holders.length);
  assert.equal(result.matchedWallets, result.comparedWallets);
  assert.equal(result.walletSetsMatch, true);
  assert.equal(result.scorePolicyComparable, false);
  assert.equal(result.rawCacheArchived, false);
  assert.equal(result.freshScanRequested, false);
  for (const holder of reference.result.holders) assert.ok(!JSON.stringify(result).includes(holder.address));
});

test("matching common wallets cannot conceal a missing or extra reference wallet", async () => {
  for (const variant of ["missing", "extra"] as const) {
    const { report, reference } = fixture();
    const originalCount = reference.result.holders.length;
    if (variant === "missing") reference.result.holders.pop();
    else reference.result.holders.push({ address: "0xffffffffffffffffffffffffffffffffffffffff", share: 0 });
    const result = await verifyPublicReference(report, new AbortController().signal, async () => Response.json(reference));
    assert.equal(result.status, "different-snapshots-or-definitions", variant);
    assert.equal(result.walletSetsMatch, false);
    assert.equal(result.matchedWallets, result.comparedWallets, "all shared percentages still agree");
    assert.equal(result.localWallets, originalCount);
    assert.equal(result.referenceWallets, originalCount + (variant === "missing" ? -1 : 1));
    assert.equal(result.walletsMissingFromReference, variant === "missing" ? 1 : 0);
    assert.equal(result.walletsMissingFromLocal, variant === "extra" ? 1 : 0);
    assert.equal(result.duplicateReferenceWallets, 0);
    assert.equal(result.scorePolicyComparable, false);
    for (const holder of reference.result.holders) assert.ok(!JSON.stringify(result).includes(holder.address));
  }
});

test("equal row counts with a replaced or duplicate reference address do not prove wallet parity", async () => {
  for (const variant of ["replacement", "duplicate"] as const) {
    const { report, reference } = fixture();
    reference.result.holders[reference.result.holders.length - 1] = variant === "replacement"
      ? { address: "0xffffffffffffffffffffffffffffffffffffffff", share: 0 }
      : { ...reference.result.holders[0] };
    const result = await verifyPublicReference(report, new AbortController().signal, async () => Response.json(reference));
    assert.equal(result.status, "different-snapshots-or-definitions", variant);
    assert.equal(result.localWallets, result.referenceWallets);
    assert.equal(result.matchedWallets, result.comparedWallets);
    assert.equal(result.walletSetsMatch, false);
    assert.equal(result.walletsMissingFromReference, 1);
    assert.equal(result.walletsMissingFromLocal, variant === "replacement" ? 1 : 0);
    assert.equal(result.duplicateReferenceWallets, variant === "duplicate" ? 1 : 0);
  }
});

test("an older or different reference records disagreement rather than forcing local percentages or score", async () => {
  const { report, reference } = fixture();
  reference.result.scanned_at--;
  reference.result.holders[0].share = Math.max(0, reference.result.holders[0].share - 0.01);
  reference.result.metrics.biggest = Math.max(0, reference.result.metrics.biggest - 0.01);
  const before = structuredClone(report);
  const result = await verifyPublicReference(report, new AbortController().signal, async () => Response.json(reference));
  assert.equal(result.status, "different-snapshots-or-definitions");
  assert.ok(result.maximumWalletDeltaPercent > result.tolerancePercent);
  assert.ok(result.matchedWallets < result.comparedWallets);
  assert.equal(result.cachedReferenceScore, 45);
  assert.equal(result.localEarnedScore, assessInvestigationReport(report).displayedScore);
  assert.deepEqual(report, before);
});

test("missing, malformed and oversized cache responses remain unavailable", async () => {
  const { report } = fixture();
  for (const response of [
    new Response(null, { status: 404 }), Response.json({ result: null }),
    Response.json({ result: { scanned_at: 0, score: 45, metrics: { biggest: 2 }, holders: [] } }),
    new Response("x".repeat(1_048_577)),
  ]) {
    const result = await verifyPublicReference(report, new AbortController().signal, async () => response);
    assert.equal(result.status, "unavailable");
    assert.equal(result.freshScanRequested, false);
  }
});

test("reference cancellation is preserved without a request", async () => {
  const { report } = fixture(), controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(verifyPublicReference(report, controller.signal, async () => { calls++; return Response.json({}); }), (error) => error === reason);
  assert.equal(calls, 0);
});
