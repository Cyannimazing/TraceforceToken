import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, InvestigationReport } from "../../src/domain/investigations/types";
import { deriveHolderTableDistribution } from "../../src/domain/investigations/holder-table-distribution";
import { deriveReportDistribution, exactPercent } from "../../src/domain/investigations/report-distribution";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";

const contract = "0x0000000000000000000000000000000000000042" as Address;
const dead = "0x000000000000000000000000000000000000dead" as Address;
const zero = "0x0000000000000000000000000000000000000000" as Address;

function fixture(): InvestigationReport {
  const report = getBrowserReportFixture();
  const template = report.wallets[0];
  const balances = [
    { address: contract, balanceRaw: "85000" },
    { address: browserFixture.walletA, balanceRaw: "10000" },
    { address: browserFixture.walletB, balanceRaw: "4000" },
  ];
  report.token.totalSupplyRaw = "100000";
  report.infrastructure = { pools: [browserFixture.pool], hubs: [] };
  report.wallets = balances.map((row) => ({ ...template, ...row }));
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: { ...report.range.to }, totalSupplyRaw: "100000",
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${report.token.address}/holders`, observedAt: report.generatedAt,
      status: "unavailable", pages: 0, addresses: 0, finalizedCensus: false, reason: "Synthetic fixture" },
    balances: { status: "complete", requestedWallets: 4, verifiedWallets: 4, reason: null },
    holders: [...balances, { address: browserFixture.pool, balanceRaw: "1000" }].map((row) => ({ ...row, status: "verified", discoveredBy: "observed" })),
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: report.generatedAt },
  };
  report.walletActivitySnapshot = { block: { ...report.range.to }, rows: balances.map((row) => ({
    address: row.address, code: row.address === contract ? "contract" : "eoa", outgoingTransactionCountRaw: null,
  })) };
  return report;
}

test("wallet-table Float separates an 85% contract and renormalizes only proven EOA holdings", () => {
  const report = fixture(), before = structuredClone(report), original = deriveReportDistribution(report);
  const view = deriveHolderTableDistribution(report);
  assert.deepEqual(view.holders.map((row) => row.address), [browserFixture.walletA, browserFixture.walletB]);
  assert.deepEqual(view.contractHolders.map((row) => row.address), [contract]);
  assert.deepEqual(view.unclassifiedHolders, []);
  assert.equal(view.holdingDenominatorLabel, "float");
  assert.equal(view.holdingDenominatorRaw, "14000");
  assert.equal(view.excludedContractBalanceRaw, "85000");
  assert.equal(view.contractSupplySharePercent, "85.00");
  assert.equal(exactPercent(10000n, BigInt(view.holdingDenominatorRaw!)), "71.42");
  assert.equal(view.classificationComplete, true);
  assert.deepEqual(report, before);
  assert.deepEqual(deriveReportDistribution(report), original);
  assert.equal(original.holdingDenominatorRaw, "99000");
  assert.deepEqual(original.holders.map((row) => row.address), [contract, browserFixture.walletA, browserFixture.walletB]);
});

test("missing and unavailable account code is explicit and cannot silently become an EOA", () => {
  for (const unavailable of [false, true]) {
    const report = fixture();
    if (unavailable) report.walletActivitySnapshot!.rows.find((row) => row.address === browserFixture.walletB)!.code = "unavailable";
    else report.walletActivitySnapshot!.rows = report.walletActivitySnapshot!.rows.filter((row) => row.address !== browserFixture.walletB);
    const view = deriveHolderTableDistribution(report);
    assert.deepEqual(view.holders.map((row) => row.address), [browserFixture.walletA]);
    assert.deepEqual(view.unclassifiedHolders.map((row) => row.address), [browserFixture.walletB]);
    assert.deepEqual(view.unclassifiedAddresses, [browserFixture.walletB]);
    assert.equal(view.classificationComplete, false);
    assert.equal(view.holdingDenominatorLabel, "total supply");
    assert.equal(view.holdingDenominatorRaw, "100000");
    assert.equal(view.excludedContractBalanceRaw, "85000");
    assert.equal(exactPercent(10000n, BigInt(view.holdingDenominatorRaw!)), "10.00");
  }
});

test("legacy, stale and malformed account snapshots leave all positive candidates unclassified", () => {
  for (const invalid of ["absent", "number", "hash", "timestamp", "duplicates"] as const) {
    const report = fixture();
    if (invalid === "absent") delete report.walletActivitySnapshot;
    else if (invalid === "number") report.walletActivitySnapshot!.block.number = "399";
    else if (invalid === "hash") report.walletActivitySnapshot!.block.hash = `0x${"f".repeat(64)}`;
    else if (invalid === "timestamp") report.walletActivitySnapshot!.block.timestamp--;
    else report.walletActivitySnapshot!.rows.push({ ...report.walletActivitySnapshot!.rows[0] });
    const view = deriveHolderTableDistribution(report);
    assert.deepEqual(view.holders, [], invalid);
    assert.deepEqual(view.contractHolders, [], invalid);
    assert.equal(view.unclassifiedHolders.length, 3, invalid);
    assert.equal(view.classificationComplete, false, invalid);
    assert.equal(view.holdingDenominatorLabel, "total supply", invalid);
    assert.equal(view.holdingDenominatorRaw, "100000", invalid);
    assert.equal(view.excludedContractBalanceRaw, "0", invalid);
  }
});

test("pool and burn balances are excluded once before any contract subtraction", () => {
  const report = fixture();
  report.infrastructure!.pools.push(dead, browserFixture.pool, dead);
  const snapshot = report.holderSnapshot!;
  snapshot.holders.find((row) => row.address === contract)!.balanceRaw = "84000";
  report.wallets.find((row) => row.address === contract)!.balanceRaw = "84000";
  snapshot.holders.push({ address: dead, balanceRaw: "800", status: "verified", discoveredBy: "observed" },
    { address: zero, balanceRaw: "200", status: "verified", discoveredBy: "observed" });
  snapshot.balances.requestedWallets += 2; snapshot.balances.verifiedWallets += 2;
  report.walletActivitySnapshot!.rows.push(...[browserFixture.pool, dead, zero].map((address) => ({ address, code: "contract" as const, outgoingTransactionCountRaw: null })));
  const view = deriveHolderTableDistribution(report);
  assert.equal(view.holdingDenominatorRaw, "14000");
  assert.equal(view.excludedContractBalanceRaw, "84000");
  assert.equal(view.contractSupplySharePercent, "84.00");
  assert.deepEqual(view.contractHolders.map((row) => row.address), [contract]);
  assert.equal(view.excluded.reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n), 2000n);
  assert.equal(new Set(view.excluded.map((row) => row.address)).size, 3);
});

test("missing infrastructure or pool balances cannot produce the wallet-table Float", () => {
  for (const invalid of ["infrastructure", "pool"] as const) {
    const report = fixture();
    if (invalid === "infrastructure") delete report.infrastructure;
    else {
      const snapshot = report.holderSnapshot!, pool = snapshot.holders.find((row) => row.address === browserFixture.pool)!;
      pool.status = "not_examined"; pool.balanceRaw = null;
      snapshot.balances.verifiedWallets--; snapshot.balances.status = "partial";
    }
    const view = deriveHolderTableDistribution(report);
    assert.equal(view.holdingDenominatorLabel, "total supply");
    assert.equal(view.holdingDenominatorRaw, "100000");
  }
});

test("an unrepresented pinned positive candidate cannot silently complete account classification", () => {
  const report = fixture();
  report.wallets = report.wallets.filter((row) => row.address !== browserFixture.walletB);
  const view = deriveHolderTableDistribution(report);
  assert.equal(view.classificationComplete, false);
  assert.deepEqual(view.unrepresentedAddresses, [browserFixture.walletB]);
  assert.equal(view.holdingDenominatorLabel, "total supply");
});

test("an unavailable eligible contract balance cannot be treated as zero when computing Float", () => {
  const report = fixture(), unknown = "0x0000000000000000000000000000000000000043" as Address;
  report.holderSnapshot!.holders.push({ address: unknown, balanceRaw: null, status: "unavailable", discoveredBy: "observed" });
  report.holderSnapshot!.balances.requestedWallets++; report.holderSnapshot!.balances.status = "partial";
  report.walletActivitySnapshot!.rows.push({ address: unknown, code: "contract", outgoingTransactionCountRaw: null });
  const view = deriveHolderTableDistribution(report);
  assert.deepEqual(view.unverifiedBalanceAddresses, [unknown]);
  assert.equal(view.holdingDenominatorLabel, "total supply");
  assert.equal(view.holdingDenominatorRaw, "100000");
  assert.equal(view.excludedContractBalanceRaw, "85000");
});

test("large balances retain exact bigint denominators and contract supply percentages", () => {
  const report = fixture(), unit = (1n << 230n) + 9007199254740993n;
  report.token.totalSupplyRaw = (100000n * unit).toString();
  report.holderSnapshot!.totalSupplyRaw = report.token.totalSupplyRaw;
  for (const row of report.holderSnapshot!.holders) row.balanceRaw = (BigInt(row.balanceRaw!) * unit).toString();
  for (const row of report.wallets) row.balanceRaw = (BigInt(row.balanceRaw!) * unit).toString();
  const view = deriveHolderTableDistribution(report);
  assert.equal(view.holdingDenominatorRaw, (14000n * unit).toString());
  assert.equal(view.excludedContractBalanceRaw, (85000n * unit).toString());
  assert.equal(view.contractSupplySharePercent, "85.00");
  assert.equal(exactPercent(10000n * unit, BigInt(view.holdingDenominatorRaw!)), "71.42");
});

test("an all-contract balance set never produces a zero or negative Float denominator", () => {
  const report = fixture();
  for (const row of report.walletActivitySnapshot!.rows) row.code = "contract";
  const view = deriveHolderTableDistribution(report);
  assert.deepEqual(view.holders, []);
  assert.equal(view.contractHolders.length, 3);
  assert.equal(view.excludedContractBalanceRaw, "99000");
  assert.equal(view.holdingDenominatorLabel, "total supply");
  assert.equal(view.holdingDenominatorRaw, "100000");
});

test("a valid empty zero-supply snapshot has no fabricated percentage denominator", () => {
  const report = fixture();
  report.token.totalSupplyRaw = "0"; report.holderSnapshot!.totalSupplyRaw = "0";
  for (const row of report.holderSnapshot!.holders) row.balanceRaw = "0";
  for (const row of report.wallets) row.balanceRaw = "0";
  const view = deriveHolderTableDistribution(report);
  assert.deepEqual(view.holders, []);
  assert.deepEqual(view.contractHolders, []);
  assert.equal(view.holdingDenominatorRaw, null);
  assert.equal(view.contractSupplySharePercent, null);
});

test("invalid balances or a stale holder snapshot cannot supply amounts or account rows", () => {
  for (const invalid of ["stale", "excess", "negative", "zero"] as const) {
    const report = fixture();
    if (invalid === "stale") report.holderSnapshot!.block.number = "399";
    else {
      report.token.totalSupplyRaw = invalid === "zero" ? "0" : "100000";
      report.holderSnapshot!.totalSupplyRaw = report.token.totalSupplyRaw;
      const value = invalid === "excess" ? "100001" : invalid === "negative" ? "-1" : "85000";
      report.holderSnapshot!.holders[0].balanceRaw = value;
      report.wallets[0].balanceRaw = value;
    }
    const view = deriveHolderTableDistribution(report);
    assert.equal(view.holdingDenominatorRaw, null, invalid);
    assert.equal(view.excludedContractBalanceRaw, "0", invalid);
    assert.equal(view.contractSupplySharePercent, null, invalid);
    assert.deepEqual(view.holders, [], invalid);
    assert.deepEqual(view.contractHolders, [], invalid);
  }
});
