import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDatasetComparison, readableCoverageNotes } from "../../src/components/investigation-dataset-facts";
import type { Address } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserLinkedSellingFixture, getBrowserReportFixture } from "../fixtures/report";

test("human coverage notes disclose material source limits without rendering upstream text or raw values", () => {
  const report = getBrowserReportFixture();
  report.coverage.warnings = [
    `SWARM context was unavailable for this scan. Secret error detail ${browserFixture.walletA}`,
    "External discovery was limited to 512 candidate addresses; additional source candidates were not independently checked.",
    "An external source limited its candidate list. Additional addresses may be missing from this scan.",
    "The token-transfer record limit was reached; transfer history is partial.",
    "RPC availability recovery used a configured fallback after verifying Base chain identity and every already-pinned range header.",
    "Unrecognized upstream error contains 999999999999999999999999 raw units.",
  ];
  const notes = readableCoverageNotes(report);
  assert.equal(notes.length, 3);
  assert.match(notes.join(" "), /external address-list limit was reached/);
  assert.match(notes.join(" "), /transaction-reading limit was reached/);
  assert.doesNotMatch(notes.join(" "), /Secret|0x[0-9a-f]{40}|999999|fallback/);
});

test("dataset comparison separates token receipt records, unique transactions and eligible endpoints", () => {
  const report = getBrowserLinkedSellingFixture(), before = structuredClone(report);
  const transfers = report.evidence.filter((record) => record.kind === "transfer" && record.assetAddress === report.token.address);
  const facts = buildDatasetComparison(report);
  assert.equal(facts.tokenActivity.records, transfers.length);
  assert.equal(facts.tokenActivity.transactions, new Set(transfers.map((record) => record.transactionHash)).size);
  assert.equal(facts.tokenActivity.participants, 3); // Two eligible wallets and the authenticated pool.
  assert.equal(facts.tokenActivity.eligibleParticipants, 2);
  assert.equal(facts.tokenActivity.status, "partial");
  assert.equal(facts.tokenActivity.crawl, null);
  assert.equal(facts.nativeFunding.records, 2);
  assert.deepEqual(facts.nativeFunding.searches, { complete: 0, partial: 2, unavailable: 0, not_examined: 1 });
  assert.deepEqual(report, before);
});

test("token activity excludes quote assets and counts one transaction with multiple token logs once", () => {
  const report = getBrowserLinkedSellingFixture();
  const token = report.evidence.find((record) => record.kind === "transfer" && record.assetAddress === report.token.address)!;
  const before = buildDatasetComparison(report).tokenActivity;
  report.evidence.push({ ...token, id: "synthetic-extra-token-log", logIndex: 9 });
  report.evidence.push({ ...token, id: "synthetic-extra-quote-log", logIndex: 10, assetAddress: browserFixture.pool });
  const after = buildDatasetComparison(report).tokenActivity;
  assert.equal(after.records, before.records + 1);
  assert.equal(after.transactions, before.transactions);
  assert.equal(after.participants, before.participants);
});

test("legacy reports leave absent holder and source datasets unknown without fabricating zero counts", () => {
  const facts = buildDatasetComparison(getBrowserReportFixture());
  assert.equal(facts.holders, null);
  assert.equal(facts.security, null);
  assert.equal(facts.market, null);
});

test("a requested full crawl retains its explicit processed discovery ranges without upgrading partial history", () => {
  const report = getBrowserReportFixture();
  report.coverage.transferCrawl = { scope: "full", source: "alchemy-transfers", completedRanges: [{ fromBlock: "100", toBlock: "120" }, { fromBlock: "200", toBlock: "250" }] };
  const facts = buildDatasetComparison(report);
  assert.deepEqual(facts.tokenActivity.crawl, report.coverage.transferCrawl);
  assert.equal(facts.tokenActivity.status, "partial");
  assert.equal(facts.tokenActivity.range.from.number, "100");
  assert.deepEqual(facts.tokenActivity.missingRanges, [{ fromBlock: "0", toBlock: "99" }, { fromBlock: "121", toBlock: "199" }, { fromBlock: "251", toBlock: "400" }]);
});

test("window coverage exposes exact gaps and adjacent completed ranges leave no false gap", () => {
  const report = getBrowserReportFixture();
  report.coverage.transferCrawl = { scope: "window", source: "rpc-logs", completedRanges: [{ fromBlock: "200", toBlock: "210" }, { fromBlock: "100", toBlock: "150" }] };
  assert.deepEqual(buildDatasetComparison(report).tokenActivity.missingRanges, [{ fromBlock: "151", toBlock: "199" }, { fromBlock: "211", toBlock: "400" }]);
  report.coverage.transferCrawl.completedRanges = [{ fromBlock: "100", toBlock: "199" }, { fromBlock: "200", toBlock: "400" }];
  assert.deepEqual(buildDatasetComparison(report).tokenActivity.missingRanges, []);
  report.coverage.transferCrawl.completedRanges = [];
  assert.deepEqual(buildDatasetComparison(report).tokenActivity.missingRanges, [{ fromBlock: "100", toBlock: "400" }]);
});

test("pinned positive, verified-zero, failed and unexamined balances stay separate from latest reported count", () => {
  const report = getBrowserReportFixture();
  report.token.totalSupplyRaw = (2n ** 256n - 1n).toString();
  const huge = (2n ** 255n + 9_007_199_254_740_993n).toString();
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: report.range.to, totalSupplyRaw: report.token.totalSupplyRaw,
    discovery: { provider: "GoPlus", sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`, observedAt: "2026-10-12T00:00:02.000Z", status: "partial", pages: 1, addresses: 2, finalizedCensus: false, reason: null },
    balances: { status: "partial", requestedWallets: 4, verifiedWallets: 2, reason: null },
    holders: [
      { address: browserFixture.walletA, balanceRaw: huge, status: "verified", discoveredBy: "indexed" },
      { address: browserFixture.walletB, balanceRaw: "0", status: "verified", discoveredBy: "observed" },
      { address: browserFixture.funder, balanceRaw: null, status: "unavailable", discoveredBy: "observed" },
      { address: browserFixture.pool, balanceRaw: null, status: "not_examined", discoveredBy: "indexed" },
    ],
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: "2026-10-12T00:00:03.000Z" },
  };
  report.token.securitySnapshot = { source: "goplus", status: "reported", sourceUrl: report.holderSnapshot.discovery.sourceUrl, checkedAt: "2026-10-12T00:00:02.000Z", tokenAddress: report.token.address, chainId: 8453, holderCount: 13, creatorAddress: null, checks: [] };
  const facts = buildDatasetComparison(report);
  assert.equal(facts.holders!.positive, 1);
  assert.equal(facts.holders!.zero, 1);
  assert.equal(facts.holders!.unavailable, 1);
  assert.equal(facts.holders!.notExamined, 1);
  assert.equal(facts.holders!.discovery.addresses, 2);
  assert.equal(facts.holders!.retainedCandidates, 4);
  assert.equal(facts.security!.holderCount, 13);
  assert.notEqual(facts.security!.checkedAt, facts.holders!.provenance.observedAt);
  report.token.securitySnapshot.status = "unavailable";
  assert.equal(buildDatasetComparison(report).security!.holderCount, null);
});

test("zero endpoints are excluded and acquisition times are ordered chronologically", () => {
  const report = getBrowserReportFixture();
  const transfer = report.evidence.find((record) => record.kind === "transfer")!;
  report.evidence = [
    { ...transfer, from: `0x${"0".repeat(40)}` as Address, provenance: { ...transfer.provenance, observedAt: "2026-10-12T00:00:00.001Z" } },
    { ...transfer, id: "synthetic-other-time", provenance: { ...transfer.provenance, provider: "Synthetic alternative", observedAt: "2026-10-12T00:00:00Z" } },
  ];
  const facts = buildDatasetComparison(report);
  assert.equal(facts.tokenActivity.participants, 2);
  assert.deepEqual(facts.tokenActivity.retrieved, { from: "2026-10-12T00:00:00Z", to: "2026-10-12T00:00:00.001Z" });
  assert.deepEqual(facts.tokenActivity.providers, ["Synthetic alternative", "Synthetic browser test fixture"]);
});
