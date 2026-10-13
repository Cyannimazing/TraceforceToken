import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveReportDistribution, exactPercent } from "../../src/domain/investigations/report-distribution";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";

function fixture() {
  const report = getBrowserReportFixture();
  report.token.totalSupplyRaw = "1000";
  report.infrastructure = { pools: [browserFixture.pool], hubs: [] };
  report.wallets = report.wallets.map((row) => ({ ...row, balanceRaw: row.address === browserFixture.walletA ? "850" : row.address === browserFixture.walletB ? "100" : "0" }));
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: { ...report.range.to }, totalSupplyRaw: "1000",
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${report.token.address}/holders`, observedAt: report.generatedAt,
      status: "unavailable", pages: 0, addresses: 0, finalizedCensus: false, reason: "Synthetic fixture" },
    balances: { status: "complete", requestedWallets: report.wallets.length + 1, verifiedWallets: report.wallets.length + 1, reason: null },
    holders: [...report.wallets.map((row) => ({ address: row.address, balanceRaw: row.balanceRaw, status: "verified" as const, discoveredBy: "observed" as const })),
      { address: browserFixture.pool, balanceRaw: "50", status: "verified", discoveredBy: "observed" }],
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: report.generatedAt },
  };
  return report;
}

test("float excludes authenticated pinned pools and ranks positive candidate balances only", () => {
  const report = fixture(), original = structuredClone(report);
  const distribution = deriveReportDistribution(report);
  assert.equal(distribution.holdingDenominatorLabel, "float"); assert.equal(distribution.holdingDenominatorRaw, "950");
  assert.deepEqual(distribution.holders.map((row) => row.address), [browserFixture.walletA, browserFixture.walletB]);
  assert.deepEqual(distribution.excluded, [{ address: browserFixture.pool, balanceRaw: "50" }]);
  assert.deepEqual(report, original);
});

test("missing pool balances use the explicitly named total supply instead of invented float", () => {
  const report = fixture();
  const pool = report.holderSnapshot!.holders.find((row) => row.address === browserFixture.pool)!;
  pool.status = "not_examined"; pool.balanceRaw = null;
  report.holderSnapshot!.balances.status = "partial"; report.holderSnapshot!.balances.verifiedWallets--;
  const distribution = deriveReportDistribution(report);
  assert.equal(distribution.holdingDenominatorLabel, "total supply"); assert.equal(distribution.holdingDenominatorRaw, "1000");
  assert.deepEqual(distribution.missingPoolBalances, [browserFixture.pool]);
  delete report.infrastructure;
  assert.equal(deriveReportDistribution(report).holdingDenominatorLabel, "total supply");
});

test("a stale or inconsistent snapshot cannot supply ranking or denominator", () => {
  const report = fixture(); report.holderSnapshot!.block.number = "399";
  assert.equal(deriveReportDistribution(report).holdingDenominatorRaw, null);
  assert.deepEqual(deriveReportDistribution(report).holders, []);
});

test("large chain amounts keep exact fraction arithmetic and reject impossible shares", () => {
  const supply = (1n << 255n) + 9_007_199_254_740_993n;
  assert.equal(exactPercent(supply / 2n, supply), "49.99");
  assert.equal(exactPercent(supply, supply), "100.00");
  assert.equal(exactPercent(supply + 1n, supply), null); assert.equal(exactPercent(0n, 0n), null);
});
