import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveHolderPopulationBreakdown, deriveHolderPopulationPresentation, deriveWalletLinkPresentation } from "../../src/domain/investigations/holder-population";
import { deriveHolderTableDistribution } from "../../src/domain/investigations/holder-table-distribution";
import { deriveReportDistribution } from "../../src/domain/investigations/report-distribution";
import { browserFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

test("graph counts distinguish twelve wallets, one contract and the excluded positive pool without changing risk", () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  const risk = deriveReportDistribution(report), before = structuredClone(report);
  assert.deepEqual(deriveHolderPopulationPresentation(report), {
    walletRows: 12, contractRows: 1, unclassifiedRows: 0,
    verifiedPositiveCandidates: 14, excludedPoolOrBurnCandidates: 1,
    unrepresentedPositiveCandidates: 0, unknownBalanceCandidates: 0,
    shownLabel: "12 wallets + 1 contract shown",
  });
  assert.equal(risk.holders.length, 13);
  assert.equal(risk.holders[0].address, browserFixture.funder);
  assert.deepEqual(deriveReportDistribution(report), risk);
  assert.deepEqual(report, before);
});

test("unavailable, absent and stale account code cannot manufacture wallet identities", () => {
  for (const mode of ["unavailable", "absent", "stale"] as const) {
    const report = getBrowserWalletFlagsFixture({ contractDominated: true });
    if (mode === "unavailable") report.walletActivitySnapshot!.rows[0].code = "unavailable";
    else if (mode === "absent") delete report.walletActivitySnapshot;
    else report.walletActivitySnapshot!.block.hash = `0x${"f".repeat(64)}`;
    const population = deriveHolderPopulationPresentation(report);
    assert.equal(population.verifiedPositiveCandidates, 14);
    assert.equal(population.contractRows, 0);
    assert.equal(population.shownLabel, mode === "unavailable" ? "12 wallets + 1 unclassified address shown" : "13 unclassified addresses shown");
  }
});

test("unknown balance candidates are separate from the verified positive population", () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  const row = report.holderSnapshot!.holders.find((entry) => entry.address !== browserFixture.pool && entry.address !== browserFixture.funder)!;
  row.status = "unavailable"; row.balanceRaw = null;
  report.wallets.find((entry) => entry.address === row.address)!.balanceRaw = null;
  report.holderSnapshot!.balances.status = "partial";
  report.holderSnapshot!.balances.verifiedWallets--;
  const population = deriveHolderPopulationPresentation(report);
  assert.equal(population.walletRows, 11);
  assert.equal(population.contractRows, 1);
  assert.equal(population.verifiedPositiveCandidates, 13);
  assert.equal(population.unknownBalanceCandidates, 1);
  assert.equal(population.shownLabel, "11 wallets + 1 contract shown");
});

test("positive candidates absent from retained rows do not inflate the graph label", () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  report.wallets = report.wallets.filter((row) => row.address !== browserFixture.funder);
  const population = deriveHolderPopulationPresentation(report);
  assert.equal(population.verifiedPositiveCandidates, 14);
  assert.equal(population.contractRows, 0);
  assert.equal(population.unrepresentedPositiveCandidates, 1);
  assert.equal(population.shownLabel, "12 wallets shown");
});

test("invalid or missing pinned balances remain unverified instead of becoming a zero-holder census", () => {
  for (const mode of ["absent", "stale", "malformed"] as const) {
    const report = getBrowserWalletFlagsFixture({ contractDominated: true });
    if (mode === "absent") delete report.holderSnapshot;
    else if (mode === "stale") report.holderSnapshot!.block.number = "399";
    else report.holderSnapshot!.holders[0].balanceRaw = "-1";
    assert.deepEqual(deriveHolderPopulationPresentation(report), {
      walletRows: 0, contractRows: 0, unclassifiedRows: 0,
      verifiedPositiveCandidates: null, excludedPoolOrBurnCandidates: 0,
      unrepresentedPositiveCandidates: 0, unknownBalanceCandidates: null,
      shownLabel: "Holdings not verified",
    });
  }
});

test("eleven visible wallets with one six-member group remain eleven wallets, with six linked and five unlinked", () => {
  const report = getBrowserWalletFlagsFixture();
  const wallets = deriveHolderTableDistribution(report).holders.map((row) => row.address);
  assert.equal(wallets.length, 11);
  report.groups = [{ id: "synthetic-six", wallets: wallets.slice(0, 6), evidenceIds: [], explanation: "Synthetic observed relationship group." }];
  const before = structuredClone(report);
  assert.deepEqual(deriveWalletLinkPresentation(report), {
    walletCount: 11, linkedGroupCount: 1, linkedWalletCount: 6, unlinkedWalletCount: 5,
    summaryLabel: "11 wallets · 1 linked group", membershipLabel: "6 linked · 5 unlinked in this scan",
  });
  assert.deepEqual(report, before);
});

test("wallet link counts use unique visible memberships across duplicate and overlapping groups", () => {
  const report = getBrowserWalletFlagsFixture();
  const wallets = deriveHolderTableDistribution(report).holders.map((row) => row.address);
  const group = (id: string, members: typeof wallets) => ({ id, wallets: members, evidenceIds: [], explanation: "Synthetic group." });
  report.groups = [group("a", [...wallets.slice(0, 6), wallets[0]]), group("a-copy", wallets.slice(0, 6).reverse()), group("b", wallets.slice(4)), group("hidden", [browserFixture.pool, wallets[0]])];
  const presentation = deriveWalletLinkPresentation(report);
  assert.equal(presentation.walletCount, 11);
  assert.equal(presentation.linkedGroupCount, 2);
  assert.equal(presentation.linkedWalletCount, 11);
  assert.equal(presentation.unlinkedWalletCount, 0);
  report.groups = [group("one-visible", [wallets[0], browserFixture.pool, browserFixture.pool])];
  assert.equal(deriveWalletLinkPresentation(report).linkedGroupCount, 0);
  assert.equal(deriveWalletLinkPresentation(report).linkedWalletCount, 0);
  assert.equal(deriveWalletLinkPresentation(report).unlinkedWalletCount, 11);
});

function thirteenPositiveFixture() {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  const row = report.holderSnapshot!.holders.find((holder) => holder.address !== browserFixture.pool && holder.address !== browserFixture.funder)!;
  row.balanceRaw = "0";
  report.wallets.find((holder) => holder.address === row.address)!.balanceRaw = "0";
  return report;
}

test("positive address breakdown reconciles thirteen checked addresses into eleven wallets, one contract and one pool", () => {
  const report = thirteenPositiveFixture();
  report.token.securitySnapshot!.holderCount = 999;
  const before = structuredClone(report);
  assert.deepEqual(deriveHolderPopulationBreakdown(report), {
    walletRows: 11, contractRows: 1, unclassifiedRows: 0, verifiedPositiveCandidates: 13,
    excludedPoolOrBurnCandidates: 1, unrepresentedPositiveCandidates: 0, unknownBalanceCandidates: 0,
    label: "13 positive addresses checked: 11 wallets + 1 contract + 1 pool/burn address",
  });
  assert.deepEqual(report, before);
});

test("positive partitions keep unknown types, unrepresented rows and unread balances separate without duplicate counts", () => {
  const report = thirteenPositiveFixture();
  const wallet = deriveHolderTableDistribution(report).holders[0];
  report.walletActivitySnapshot!.rows.find((row) => row.address === wallet.address)!.code = "unavailable";
  report.wallets = report.wallets.filter((row) => row.address !== browserFixture.funder);
  // Presentation remains robust when a legacy retained wallet row is duplicated.
  report.wallets.push({ ...report.wallets.find((row) => row.address === wallet.address)! });
  const unread = report.holderSnapshot!.holders.find((row) => row.address !== browserFixture.pool && row.address !== browserFixture.funder && row.address !== wallet.address && row.balanceRaw !== "0")!;
  unread.balanceRaw = null; unread.status = "unavailable";
  report.wallets.find((row) => row.address === unread.address)!.balanceRaw = null;
  report.holderSnapshot!.balances.status = "partial";
  report.holderSnapshot!.balances.verifiedWallets--;
  const result = deriveHolderPopulationBreakdown(report);
  assert.equal(result.verifiedPositiveCandidates, 12);
  assert.equal(result.walletRows, 9);
  assert.equal(result.contractRows, 0);
  assert.equal(result.unclassifiedRows, 1);
  assert.equal(result.excludedPoolOrBurnCandidates, 1);
  assert.equal(result.unrepresentedPositiveCandidates, 1);
  assert.equal(result.unknownBalanceCandidates, 1);
  assert.equal(result.walletRows + result.contractRows + result.unclassifiedRows + result.excludedPoolOrBurnCandidates + result.unrepresentedPositiveCandidates, result.verifiedPositiveCandidates);
});

test("unverified snapshots cannot turn source-reported totals into a verified partition", () => {
  const report = thirteenPositiveFixture();
  report.holderSnapshot!.block.number = "399";
  report.token.securitySnapshot!.holderCount = 13;
  const result = deriveHolderPopulationBreakdown(report);
  assert.equal(result.verifiedPositiveCandidates, null);
  assert.equal(result.unknownBalanceCandidates, null);
  assert.equal(result.label, "Holdings not verified");
  const links = deriveWalletLinkPresentation(report);
  assert.equal(links.walletCount, 0);
  assert.equal(links.linkedWalletCount, 0);
  assert.equal(links.unlinkedWalletCount, 0);
});
