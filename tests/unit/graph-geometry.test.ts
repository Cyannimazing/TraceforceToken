import assert from "node:assert/strict";
import { test } from "node:test";
import type { InvestigationReport } from "../../src/domain/investigations/types";
import { collectGraphAddresses, fitGraph, graphBasis, holdingRadius, layoutGraph } from "../../src/components/investigation-graph-geometry";
import { browserFixture, getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";
import { deriveHolderTableDistribution } from "../../src/domain/investigations/holder-table-distribution";
import { deriveReportDistribution } from "../../src/domain/investigations/report-distribution";

function withBalances(): InvestigationReport {
  const report = getBrowserReportFixture();
  report.token.totalSupplyRaw = "100";
  const entries = [
    { address: browserFixture.walletA, balanceRaw: "90", status: "verified" as const },
    { address: browserFixture.walletB, balanceRaw: "1", status: "verified" as const },
    { address: browserFixture.funder, balanceRaw: null, status: "not_examined" as const },
    { address: browserFixture.pool, balanceRaw: "9", status: "verified" as const },
  ];
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: report.range.to, totalSupplyRaw: "100",
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${report.token.address}/holders`, observedAt: report.generatedAt, status: "partial", pages: 1, addresses: 4, finalizedCensus: false, reason: "Synthetic fixture." },
    balances: { status: "partial", requestedWallets: 4, verifiedWallets: 3, reason: "Synthetic unread candidate." },
    holders: entries.map((entry) => ({ ...entry, discoveredBy: "indexed" as const })),
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: report.generatedAt },
  };
  report.wallets.forEach((wallet) => { wallet.balanceRaw = entries.find((entry) => entry.address === wallet.address)?.balanceRaw ?? null; });
  return report;
}

test("holding bubble area preserves 90:1 shares without logarithms or radius floors", () => {
  const large = holdingRadius("90", "100"), small = holdingRadius("1", "100");
  assert.ok(Math.abs((large * large) / (small * small) - 90) < 1e-10);
  assert.equal(holdingRadius("0", "100"), 0);
  assert.equal(holdingRadius("1", "0"), 0);
  assert.equal(holdingRadius("101", "100"), 0);
  const maximum = (2n ** 256n - 1n).toString();
  assert.equal(holdingRadius(maximum, maximum), 180);
  assert.ok(holdingRadius("1", maximum) > 0 && holdingRadius("1", maximum) < 1e-30);
});

test("unknown and known infrastructure markers never acquire a fabricated holding radius", () => {
  const report = withBalances(), addresses = collectGraphAddresses(report), { nodes } = layoutGraph(report, addresses, 0);
  assert.equal(graphBasis(report), "holdings");
  const unknown = nodes.find((node) => node.address === browserFixture.funder)!;
  assert.equal(unknown.kind, "unknown"); assert.equal(unknown.radius, 0);
  const infrastructure = nodes.find((node) => node.address === browserFixture.pool)!;
  assert.equal(infrastructure.kind, "infrastructure"); assert.equal(infrastructure.radius, 0);
  report.holderSnapshot!.holders.find((holder) => holder.address === browserFixture.walletB)!.balanceRaw = "0";
  assert.equal(layoutGraph(report, addresses, 0).nodes.find((node) => node.address === browserFixture.walletB)!.kind, "zero");
});

test("packed circles do not overlap and a common viewport transform keeps them inside the graph", () => {
  const report = withBalances(), { nodes } = layoutGraph(report, collectGraphAddresses(report), 0), fit = fitGraph(nodes);
  for (let left = 0; left < nodes.length; left++) {
    const a = nodes[left], visual = Math.max(a.radius, 18);
    const x = 450 + (a.x - fit.x) * fit.scale, y = 300 + (a.y - fit.y) * fit.scale;
    assert.ok(x - visual * fit.scale > 0 && x + visual * fit.scale < 900);
    assert.ok(y - visual * fit.scale > 0 && y + (visual + 52) * fit.scale < 600);
    for (const b of nodes.slice(left + 1)) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= Math.max(a.radius, 18) + Math.max(b.radius, 18));
  }
  const first = nodes.find((node) => node.address === browserFixture.walletA)!;
  const second = nodes.find((node) => node.address === browserFixture.walletB)!;
  assert.ok(Math.abs((first.radius * fit.scale) ** 2 / (second.radius * fit.scale) ** 2 - 90) < 1e-10);
  assert.deepEqual(layoutGraph(report, collectGraphAddresses(report), 0).nodes, nodes);
});

test("unverified scans use explicitly separate flow geometry and missing supply never invents a share", () => {
  const report = getBrowserReportFixture();
  assert.equal(graphBasis(report), "flow");
  assert.ok(layoutGraph(report, collectGraphAddresses(report), 0).nodes.every((node) => node.kind === "flow"));
  const balances = withBalances(); balances.holderSnapshot!.totalSupplyRaw = null; balances.token.totalSupplyRaw = null;
  assert.equal(graphBasis(balances), "unscaled-balances");
  assert.equal(layoutGraph(balances, collectGraphAddresses(balances), 0).nodes.find((node) => node.address === browserFixture.walletA)!.radius, 0);
});

test("wallet graph areas use the same contract-excluded denominator as the holder table", () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  const table = deriveHolderTableDistribution(report), riskBefore = deriveReportDistribution(report);
  const addresses = table.holders.map((holder) => holder.address);
  const { nodes } = layoutGraph(report, addresses, 0, table.holdingDenominatorRaw);
  assert.equal(nodes.length, 12);
  assert.equal(nodes.some((node) => node.address === browserFixture.funder), false);
  for (const node of nodes) {
    assert.equal(node.kind, "holding");
    assert.ok(Math.abs(node.radius ** 2 / 180 ** 2 - Number(node.balanceRaw) / Number(table.holdingDenominatorRaw)) < 1e-12);
  }
  assert.deepEqual(deriveReportDistribution(report), riskBefore);
  assert.equal(layoutGraph(report, collectGraphAddresses(report), 0).nodes.find((node) => node.address === browserFixture.funder)?.kind, "holding");
});

test("an explicit unknown graph denominator cannot silently borrow the broader risk denominator", () => {
  const report = withBalances();
  assert.equal(graphBasis(report, null), "unscaled-balances");
  const node = layoutGraph(report, collectGraphAddresses(report), 0, null).nodes.find((row) => row.address === browserFixture.walletA)!;
  assert.equal(node.kind, "unknown");
  assert.equal(node.radius, 0);
});

test("stale or mismatched holder snapshots never establish graph holding balances", () => {
  for (const mismatch of ["block", "token"] as const) {
    const report = withBalances();
    if (mismatch === "block") report.holderSnapshot!.block = { ...report.range.to, hash: `0x${"f".repeat(64)}` };
    else report.holderSnapshot!.tokenAddress = browserFixture.walletA;
    assert.equal(graphBasis(report), "flow");
    const nodes = layoutGraph(report, collectGraphAddresses(report), 0).nodes;
    assert.ok(nodes.every((node) => node.balanceRaw === null && node.kind !== "holding"));
  }
});

test("a funding source outside the examined cohort is not presumed known infrastructure", () => {
  const report = withBalances();
  report.wallets = report.wallets.filter((wallet) => wallet.address !== browserFixture.funder);
  const node = layoutGraph(report, collectGraphAddresses(report), 0).nodes.find((row) => row.address === browserFixture.funder)!;
  assert.equal(node.kind, "unknown");
  assert.equal(node.radius, 0);
  report.infrastructure!.hubs.push(browserFixture.funder);
  assert.equal(layoutGraph(report, collectGraphAddresses(report), 0).nodes.find((row) => row.address === browserFixture.funder)!.kind, "infrastructure");
});
