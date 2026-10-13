import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWalletDisplayFacts } from "../../src/components/investigation-wallet-facts";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import { deriveReportDistribution } from "../../src/domain/investigations/report-distribution";
import type { InvestigationReport } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserLinkedSellingFixture, getBrowserReportFixture } from "../fixtures/report";

test("wallet presentation separates the earliest retained token receipt from older native funding", () => {
  const report = getBrowserReportFixture();
  report.evidence.reverse();
  const facts = buildWalletDisplayFacts(report);
  assert.equal(facts.get(browserFixture.walletA)!.firstReceipt!.blockNumber, "110");
  assert.equal(facts.get(browserFixture.walletB)!.firstReceipt!.blockNumber, "111");
  assert.deepEqual(facts.get(browserFixture.walletA)!.nativeFunders, [browserFixture.funder]);
  assert.equal(facts.get(browserFixture.walletA)!.fundingStatus, "partial");
  assert.equal(facts.get(browserFixture.walletA)!.retainedTransactions, 3);
  assert.equal(facts.get(browserFixture.walletB)!.retainedTransactions, 26);
});

test("multiple token logs and sale support in one transaction count as one retained transaction", () => {
  const report = getBrowserReportFixture();
  const receipt = report.evidence.find((event) => event.kind === "transfer" && event.to === browserFixture.walletA)!;
  report.evidence.push({ ...receipt, id: `${receipt.id}-second-log`, logIndex: receipt.logIndex! + 1 });
  assert.equal(buildWalletDisplayFacts(report).get(browserFixture.walletA)!.retainedTransactions, 3);
  const selling = buildWalletDisplayFacts(getBrowserLinkedSellingFixture());
  assert.equal(selling.get(browserFixture.walletA)!.supportedSales, 1);
  assert.equal(selling.get(browserFixture.walletB)!.supportedSales, 1);
});

test("no retained receipt or funding never becomes an inferred purchase or complete funding search", () => {
  const facts = buildWalletDisplayFacts(getBrowserReportFixture()).get(browserFixture.funder)!;
  assert.equal(facts.firstReceipt, null);
  assert.deepEqual(facts.nativeFunders, []);
  assert.equal(facts.fundingStatus, "not_examined");
  assert.equal(facts.retainedTransactions, 2);
  assert.deepEqual(facts.groups, [1]);
});

test("analysis-only previews retain real wallet facts before any explanation exists", () => {
  const report: InvestigationReport = structuredClone(getBrowserReportFixture());
  delete report.explanation;
  assert.equal(report.explanation, undefined);
  assert.equal(buildWalletDisplayFacts(report).get(browserFixture.walletB)!.retainedTransactions, 26);
});
test("validated full-history browser fixture retains exact flags, purchased entry and pinned outgoing counts", () => {
  const report = validateExplainedReport(getBrowserWalletFlagsFixture());
  const distribution = deriveReportDistribution(report), facts = buildWalletDisplayFacts(report);
  assert.equal(distribution.holders.length, 11);
  assert.equal(distribution.holdingDenominatorRaw, "99000");
  assert.equal(distribution.holdingDenominatorLabel, "float");
  const creator = facts.get(report.token.securitySnapshot!.creatorAddress!)!;
  assert.equal(creator.entry?.kind, "mint");
  assert.equal(creator.outgoingTransactionCountRaw, "6");
  assert.ok(creator.flags.some((flag) => flag.id === "fresh"));
  const sniper = [...facts.values()].find((wallet) => wallet.flags.some((flag) => flag.id === "sniper"))!;
  assert.equal(sniper.entry?.kind, "buy");
  assert.equal(sniper.outgoingTransactionCountRaw, "606");
});
