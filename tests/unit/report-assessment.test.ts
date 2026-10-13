import assert from "node:assert/strict";
import { test } from "node:test";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import type { Address, EvidenceRecord, ExplainedInvestigationReport, Hash, HolderSnapshot } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";
import { deriveHolderTableDistribution } from "../../src/domain/investigations/holder-table-distribution";
import { exactPercent } from "../../src/domain/investigations/report-distribution";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hash;

function sale(block: number, tx: number, wallet: Address): EvidenceRecord[] {
  const common = {
    chainId: 8453 as const, blockNumber: String(block), blockHash: hash(block), transactionHash: hash(tx), transactionIndex: 0,
    traceId: null, timestamp: browserFixture.timestamp + (block - 100) * 10,
    provenance: { provider: "Synthetic assessment fixture", method: "fabricated test receipt", observedAt: browserFixture.generatedAt },
  };
  const token: EvidenceRecord = { ...common, id: `out-${tx}`, kind: "transfer", logIndex: 0, from: wallet, to: browserFixture.pool, assetAddress: browserFixture.token, amountRaw: "10", sale: null };
  const quote: EvidenceRecord = { ...common, id: `quote-${tx}`, kind: "transfer", logIndex: 1, from: browserFixture.pool, to: wallet, assetAddress: address(901), amountRaw: "5", sale: null };
  return [token, quote, { ...common, id: `sale-${tx}`, kind: "sale", logIndex: 2, from: wallet, to: browserFixture.pool, assetAddress: browserFixture.token, amountRaw: "10", sale: {
    pool: browserFixture.pool, factory: address(902), protocol: "uniswap-v3", quoteAsset: address(901), quoteAmountRaw: "5", swapLogIndex: 2, supportingEvidenceIds: [token.id, quote.id],
  } }];
}

function withEvidence(evidence: EvidenceRecord[]): ExplainedInvestigationReport {
  const original = getBrowserReportFixture();
  const report = analyzeInvestigation({ token: original.token, range: original.range, evidence, pools: [browserFixture.pool], hubs: [], coverage: original.coverage }, { id: original.id, generatedAt: original.generatedAt });
  const ids = report.evidence.slice(0, 1).map((event) => event.id);
  return validateExplainedReport({ ...report, explanation: {
    ...original.explanation, overview: { text: "Synthetic assessment fixture over retained records.", evidenceIds: ids }, observations: [],
    context: { evidenceIds: ids, suppliedEvidence: ids.length, omittedEvidence: report.evidence.length - ids.length },
  } });
}

function linkedSales(): ExplainedInvestigationReport {
  return withEvidence([...getBrowserReportFixture().evidence, ...sale(200, 301, browserFixture.walletA), ...sale(230, 302, browserFixture.walletB)]);
}

function withBalances(report: ExplainedInvestigationReport, supply: string | null, entries: { address: Address; balanceRaw: string | null }[]): ExplainedInvestigationReport {
  const value = structuredClone(report);
  value.token.totalSupplyRaw = supply;
  const holders: HolderSnapshot["holders"] = entries.map((item) => ({ ...item, status: item.balanceRaw === null ? "not_examined" : "verified", discoveredBy: "observed" }));
  const verified = holders.filter((item) => item.status === "verified").length;
  value.holderSnapshot = {
    chainId: 8453, tokenAddress: value.token.address, block: { ...value.range.to }, totalSupplyRaw: supply,
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${value.token.address}/holders`, observedAt: value.generatedAt, status: "unavailable", pages: 0, addresses: 0, finalizedCensus: false, reason: "Synthetic incomplete discovery." },
    balances: { status: verified === holders.length ? "complete" : verified ? "partial" : "not_examined", requestedWallets: holders.length, verifiedWallets: verified, reason: "Synthetic pinned calls." },
    holders, provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: value.generatedAt },
  };
  const balances = new Map(entries.map((item) => [item.address, item.balanceRaw]));
  value.wallets = value.wallets.map((wallet) => ({ ...wallet, balanceRaw: balances.get(wallet.address) ?? null }));
  return validateExplainedReport(value);
}

test("partial scans and no concerns never earn clean points or OK decision weight", () => {
  const report = getBrowserReportFixture(), before = structuredClone(report);
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.overallScore, null); assert.equal(assessment.verdict, "INSUFFICIENT");
  assert.deepEqual(assessment.verdictWeights, { avoid: 0, caution: 1, ok: 0 });
  assert.deepEqual(assessment.categories.map((item) => [item.id, item.possiblePoints]), [["swarm", 30], ["fresh", 20], ["insiders", 15], ["concentration", 15], ["snipers", 10], ["dev", 10]]);
  assert.ok(assessment.categories.every((item) => item.points === null && item.status === "not_assessed"));
  assert.equal(assessment.assessedPoints, 0); assert.equal(assessment.assessedPossiblePoints, 0);
  assert.equal(assessment.possiblePoints, 100); assert.deepEqual(assessment.triggeredRules, []);
  assert.doesNotThrow(() => JSON.stringify(assessment)); assert.deepEqual(report, before);
});

test("qualifying linked selling retains complete proof without inventing pool price impact", () => {
  const report = linkedSales(), assessment = assessInvestigationReport(report);
  const category = assessment.categories.find((item) => item.id === "swarm")!;
  assert.equal(assessment.verdict, "REVIEW");
  assert.equal(assessment.judge.label, "Review the observed concerns");
  assert.equal(category.points, null); assert.equal(category.status, "not_assessed");
  assert.equal(assessment.assessedPossiblePoints, 0); assert.equal(assessment.overallScore, null);
  const rule = assessment.triggeredRules[0]; assert.equal(rule.deductedPoints, 0); assert.equal(rule.holderBlock, null);
  assert.deepEqual(rule.addresses, [browserFixture.walletA, browserFixture.walletB]);
  const selling = report.findings.find((finding) => finding.category === "selling")!;
  assert.deepEqual(rule.evidenceIds, [...selling.evidenceIds].sort());
  for (const event of report.evidence.filter((event) => event.kind === "sale")) {
    assert.ok(rule.evidenceIds.includes(event.id));
    assert.ok(event.sale!.supportingEvidenceIds.every((id) => rule.evidenceIds.includes(id)));
  }
  assert.ok(assessment.categories.filter((item) => item.id !== "swarm").every((item) => item.points === null));
});

test("ordinary transfers, similar timing, and AI assertions do not become selling concerns", () => {
  const original = getBrowserReportFixture();
  original.explanation.overview.text = "Synthetic unsupported claim: these are insiders and snipers selling together.";
  assert.equal(assessInvestigationReport(original).triggeredRules.length, 0);
  const unlinked = original.evidence.filter((event) => event.kind !== "funding" && !(event.from === browserFixture.walletA && event.to === browserFixture.walletB));
  const report = withEvidence([...unlinked, ...sale(200, 301, browserFixture.walletA), ...sale(230, 302, browserFixture.walletB)]);
  assert.equal(report.findings.some((finding) => finding.category === "selling"), false);
  assert.equal(assessInvestigationReport(report).triggeredRules.length, 0);
});

test("missing sale support, wrong rule versions, or relationships only after sales cannot trigger", () => {
  for (const mutate of [
    (report: ExplainedInvestigationReport) => { report.findings.find((finding) => finding.category === "selling")!.rule.version = "unknown"; },
    (report: ExplainedInvestigationReport) => { const sale = report.evidence.find((event) => event.kind === "sale")!; report.evidence = report.evidence.filter((event) => event.id !== sale.sale!.supportingEvidenceIds[0]); },
    (report: ExplainedInvestigationReport) => { report.findings.find((finding) => finding.category === "selling")!.evidenceIds = report.evidence.filter((event) => event.blockNumber === "200" || event.blockNumber === "230").map((event) => event.id); },
    (report: ExplainedInvestigationReport) => { report.evidence.find((event) => event.kind === "sale")!.sale!.quoteAmountRaw = "999"; },
  ]) { const report = linkedSales(); mutate(report); assert.equal(assessInvestigationReport(report).triggeredRules.length, 0); }
});

test("exact pinned balance shares support a concentration lower bound despite incomplete discovery", () => {
  const supply = (2n ** 255n + 3n).toString(), threshold = (BigInt(supply) + 9n) / 10n;
  const report = withBalances(getBrowserReportFixture(), supply, [
    { address: browserFixture.walletA, balanceRaw: threshold.toString() }, { address: browserFixture.walletB, balanceRaw: null },
  ]);
  const assessment = assessInvestigationReport(report), rule = assessment.triggeredRules[0];
  assert.equal(assessment.verdict, "REVIEW");
  assert.equal(rule.category, "concentration"); assert.equal(rule.deductedPoints, 0);
  assert.deepEqual(rule.evidenceIds, []); assert.deepEqual(rule.addresses, [browserFixture.walletA]);
  assert.deepEqual(rule.holderBlock, report.range.to); assert.match(rule.basis, /lower bound/);
  assert.equal(assessment.assessedPossiblePoints, 0); assert.equal(assessment.overallScore, null);
  const below = withBalances(getBrowserReportFixture(), supply, [{ address: browserFixture.walletA, balanceRaw: (threshold - 1n).toString() }]);
  assert.equal(assessInvestigationReport(below).triggeredRules.length, 0);
});

test("missing supply, zero supply, unverified balances, and sampled small balances remain unknown", () => {
  for (const [supply, balance] of [[null, "100"], ["0", "0"], ["1000", null], ["1000", "99"]] as const) {
    const assessment = assessInvestigationReport(withBalances(getBrowserReportFixture(), supply, [{ address: browserFixture.walletA, balanceRaw: balance }]));
    assert.equal(assessment.categories.find((item) => item.id === "concentration")!.points, null);
    assert.equal(assessment.overallScore, null); assert.equal(assessment.triggeredRules.length, 0);
  }
  const report = getBrowserReportFixture(); report.wallets[0].balanceRaw = "999999";
  assert.equal(assessInvestigationReport(report).triggeredRules.length, 0);
});

test("known pool holdings are excluded while the remaining holder Float is measured exactly", () => {
  const report = withBalances(getBrowserReportFixture(), "1000", [
    { address: browserFixture.pool, balanceRaw: "900" }, { address: browserFixture.walletA, balanceRaw: "50" },
  ]);
  assert.ok(!report.wallets.some((wallet) => wallet.address === browserFixture.pool));
  assert.equal(report.holderSnapshot!.holders.find((holder) => holder.address === browserFixture.pool)!.balanceRaw, "900");
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.metrics.topTenSharePercent, "50.00");
  assert.equal(assessment.categories.find((category) => category.id === "concentration")!.points, 0);
  assert.equal(assessment.triggeredRules.length, 0);
  const withEligibleConcern = withBalances(getBrowserReportFixture(), "1000", [
    { address: browserFixture.pool, balanceRaw: "900" }, { address: browserFixture.walletA, balanceRaw: "100" },
  ]);
  assert.deepEqual(assessInvestigationReport(withEligibleConcern).triggeredRules[0].addresses, [browserFixture.walletA]);
});

test("mismatched snapshot identity cannot affect assessment and known concerns never normalize unknowns away", () => {
  const report = withBalances(linkedSales(), "1000", [{ address: browserFixture.walletA, balanceRaw: "100" }]);
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.assessedPossiblePoints, 0); assert.equal(assessment.assessedPoints, 0);
  assert.equal(assessment.triggeredRules.length, 2); assert.equal(assessment.overallScore, null);
  const reordered = structuredClone(report); reordered.evidence.reverse(); reordered.findings.reverse();
  assert.deepEqual(assessInvestigationReport(reordered), assessment);
  report.holderSnapshot!.block.hash = hash(999);
  assert.equal(assessInvestigationReport(report).triggeredRules.some((rule) => rule.category === "concentration"), false);
});

test("pinned V2 reserves and a creator holding produce a bounded score and a traceable warning", () => {
  const report = withBalances(getBrowserReportFixture(), "1000", [
    { address: browserFixture.pool, balanceRaw: "50" }, { address: browserFixture.walletA, balanceRaw: "850" }, { address: browserFixture.walletB, balanceRaw: "100" },
  ]);
  report.infrastructure = { pools: [browserFixture.pool], hubs: [] };
  report.token.securitySnapshot = { source: "goplus", status: "reported", checkedAt: report.generatedAt,
    sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`,
    tokenAddress: report.token.address, chainId: 8453, holderCount: 3, creatorAddress: browserFixture.walletA, checks: [] };
  report.liquiditySnapshot = { protocol: "uniswap-v2", pool: browserFixture.pool, factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6", token0: report.token.address, token1: address(903),
    reserve0Raw: "50", reserve1Raw: "5000", block: { ...report.range.to }, provenance: { provider: "Synthetic fixture", method: "fabricated reserve read", observedAt: report.generatedAt } };
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.band, "DANGER"); assert.equal(assessment.verdict, "AVOID");
  assert.equal(assessment.overallScore, null); assert.deepEqual(assessment.scoreRange, { minimum: 0, maximum: 45 });
  assert.equal(assessment.metrics.dumpImpactPercent, "99.69");
  assert.equal(assessment.metrics.creatorSharePercent, "89.47");
  const masses = { avoid: 0.55 + 2 + 0.9969, caution: 0.45, ok: 0 };
  const total = masses.avoid + masses.caution;
  assert.deepEqual(assessment.verdictWeights, { avoid: masses.avoid / total, caution: masses.caution / total, ok: 0 });
  assert.ok(assessment.gates.find((gate) => gate.id === "dump-impact")!.basis.includes("no-fee constant-product"));
  assert.equal(assessment.categories.find((category) => category.id === "fresh")!.points, null);
  assert.equal(assessment.categories.find((category) => category.id === "snipers")!.points, null);
  for (const mutate of [
    (value: ExplainedInvestigationReport) => { value.liquiditySnapshot!.block.hash = hash(888); },
    (value: ExplainedInvestigationReport) => { value.liquiditySnapshot!.reserve1Raw = "0"; },
    (value: ExplainedInvestigationReport) => { value.infrastructure!.pools = []; },
    (value: ExplainedInvestigationReport) => { value.liquiditySnapshot!.factory = address(999); },
    (value: ExplainedInvestigationReport) => { value.liquiditySnapshot!.reserve0Raw = (2n ** 112n).toString(); },
  ]) { const altered = structuredClone(report); mutate(altered); assert.equal(assessInvestigationReport(altered).gates.some((gate) => gate.id === "dump-impact"), false); }
});

test("fresh uses acquired outgoing counts and missing counts stay unknown", () => {
  const report = withBalances(getBrowserReportFixture(), "1000", [
    { address: browserFixture.walletA, balanceRaw: "40" }, { address: browserFixture.walletB, balanceRaw: "30" },
  ]);
  report.walletActivitySnapshot = { block: { ...report.range.to }, rows: [
    { address: browserFixture.walletA, outgoingTransactionCountRaw: "10", code: "eoa" },
    { address: browserFixture.walletB, outgoingTransactionCountRaw: "11", code: "eoa" },
  ] };
  assert.equal(assessInvestigationReport(report).metrics.freshWalletsPercent, "50.00");
  assert.equal(assessInvestigationReport(report).categories.find((row) => row.id === "fresh")!.points, 10);
  report.walletActivitySnapshot.rows[1].outgoingTransactionCountRaw = null;
  assert.equal(assessInvestigationReport(report).metrics.freshWalletsPercent, null);
  report.walletActivitySnapshot.rows[1].code = "contract";
  assert.equal(assessInvestigationReport(report).metrics.freshWalletsPercent, "100.00");
  report.walletActivitySnapshot.rows[1].code = "eoa";
  report.walletActivitySnapshot.rows[1].outgoingTransactionCountRaw = "11";
  report.walletActivitySnapshot.block.hash = hash(777);
  assert.equal(assessInvestigationReport(report).metrics.freshWalletsPercent, null);
});

test("measured categories earn positive credits while incomplete funding cannot earn Insider credits", () => {
  const report = getBrowserWalletFlagsFixture();
  const complete = assessInvestigationReport(report);
  assert.equal(complete.version, "1.3.0");
  assert.equal(complete.metrics.freshWalletsPercent, "0.00");
  assert.equal(complete.categories.find((row) => row.id === "fresh")!.points, 20);
  assert.ok(complete.categories.find((row) => row.id === "insiders")!.points! > 0);
  assert.ok(complete.categories.find((row) => row.id === "snipers")!.points! > 0);
  assert.equal(complete.assessedPossiblePoints, 100);
  assert.equal(complete.overallScore, complete.displayedScore);
  const subtotal = complete.categories.reduce((sum, row) => sum + Math.round(row.points! * 10), 0) / 10;
  assert.equal(complete.assessedPoints, subtotal);
  report.coverage.funding[1].status = "not_examined";
  const partial = assessInvestigationReport(report);
  assert.equal(partial.metrics.insiderSharePercent, null);
  assert.equal(partial.categories.find((row) => row.id === "insiders")!.points, null);
  assert.equal(partial.assessedPossiblePoints, 85);
  assert.equal(partial.overallScore, null);
  assert.equal(partial.displayedScore, Math.round(partial.scoreRange.minimum));
  assert.equal(partial.verdict, "AVOID");
});

test("unread candidate balances cannot earn favorable cohort credits or a Fresh count warning", () => {
  const report = getBrowserWalletFlagsFixture();
  const missing = address(555);
  report.holderSnapshot!.holders.push({ address: missing, balanceRaw: null, status: "not_examined", discoveredBy: "observed" });
  report.holderSnapshot!.balances.status = "partial";
  report.holderSnapshot!.balances.requestedWallets++;
  for (const row of report.walletActivitySnapshot!.rows) row.outgoingTransactionCountRaw = "1";
  const assessment = assessInvestigationReport(report);
  for (const id of ["fresh", "insiders", "snipers"] as const) assert.equal(assessment.categories.find((row) => row.id === id)!.points, null);
  assert.equal(assessment.metrics.freshWalletsPercent, null);
  assert.ok(!assessment.gates.some((gate) => gate.id === "fresh-wallets"));
  assert.equal(assessment.categories.find((row) => row.id === "swarm")!.points, 0, "known saturated price-impact concern remains supported");
  assert.equal(assessment.categories.find((row) => row.id === "concentration")!.points, 0, "known top-ten lower bound already exceeds50%");
  assert.equal(assessment.categories.find((row) => row.id === "dev")!.points, 0, "specific creator balance remains verified");
  assert.equal(assessment.overallScore, null);
});

test("a partial top-ten lower bound below saturation supports review but no numeric credit", () => {
  const report = withBalances(getBrowserReportFixture(), "1000", [
    { address: browserFixture.walletA, balanceRaw: "125" }, { address: browserFixture.walletB, balanceRaw: "50" }, { address: browserFixture.funder, balanceRaw: null },
  ]);
  report.walletActivitySnapshot = { block: { ...report.range.to }, rows: [browserFixture.walletA, browserFixture.walletB].map((address) => ({ address, code: "eoa", outgoingTransactionCountRaw: "100" })) };
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.metrics.topTenSharePercent, "17.50");
  assert.equal(assessment.categories.find((row) => row.id === "concentration")!.points, null);
  assert.equal(assessment.triggeredRules.find((rule) => rule.category === "concentration")!.deductedPoints, 0);
  assert.equal(assessment.assessedPossiblePoints, 0);
  assert.equal(assessment.verdict, "REVIEW");
});

test("wallet score metrics share the table Float and keep large contracts in separate risk checks", () => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  const table = deriveHolderTableDistribution(report), assessment = assessInvestigationReport(report);
  assert.equal(table.holders.length, 12);
  assert.equal(table.contractHolders.length, 1);
  assert.equal(table.holdingDenominatorRaw, "14355");
  assert.equal(assessment.holdingBasis.kind, "wallets");
  assert.equal(assessment.holdingBasis.denominatorRaw, table.holdingDenominatorRaw);
  assert.equal(assessment.holdingBasis.holders, table.holders.length);
  const largest = BigInt(table.holders[0].balanceRaw!), denominator = BigInt(table.holdingDenominatorRaw!);
  assert.equal(assessment.metrics.largestSharePercent, exactPercent(largest, denominator));
  assert.equal(assessment.metrics.topTenSharePercent, exactPercent(table.holders.slice(0, 10).reduce((sum, row) => sum + BigInt(row.balanceRaw!), 0n), denominator));
  const reserve = 1000n, afterSquared = (reserve + largest) ** 2n;
  assert.equal(assessment.metrics.dumpImpactPercent, exactPercent(afterSquared - reserve ** 2n, afterSquared));
  assert.equal(assessment.metrics.dumpImpactPercent, "79.32");
  assert.ok(assessment.gates.some((gate) => gate.id === "contract-concentration" && gate.label.includes("84.64%")));
  assert.ok(assessment.gates.some((gate) => gate.id === "contract-dump-impact"));
  assert.ok(!assessment.triggeredRules.some((rule) => rule.category === "concentration"), "excluded contract cannot be shown as the wallet category's deduction proof");
  assert.equal(assessment.categories.find((row) => row.id === "fresh")!.points, 20);
  assert.ok(assessment.categories.find((row) => row.id === "snipers")!.points! > 0);
  assert.equal(assessment.categories.find((row) => row.id === "dev")!.points, null);
  assert.equal(assessment.verdict, "AVOID");
  report.liquiditySnapshot!.reserve1Raw = "0";
  const noLiquidity = assessInvestigationReport(report);
  assert.equal(noLiquidity.metrics.dumpImpactPercent, null);
  assert.ok(!noLiquidity.gates.some((gate) => gate.id === "contract-dump-impact"));
  assert.ok(noLiquidity.gates.some((gate) => gate.id === "contract-concentration"));
});

test("warning proof deductions agree with positive category credits instead of subtracting a full category twice", () => {
  const report = getBrowserWalletFlagsFixture();
  for (const row of report.holderSnapshot!.holders) if (row.address !== browserFixture.pool) row.balanceRaw = row.address === browserFixture.funder ? "12000" : "8700";
  const balances = new Map(report.holderSnapshot!.holders.map((row) => [row.address, row.balanceRaw]));
  report.wallets = report.wallets.map((row) => ({ ...row, balanceRaw: balances.get(row.address) ?? null }));
  const assessment = assessInvestigationReport(report);
  const category = assessment.categories.find((row) => row.id === "dev")!;
  assert.equal(category.points, 7);
  assert.equal(assessment.triggeredRules.find((rule) => rule.id === "creator-holding")!.deductedPoints, 3);
  assert.equal(assessment.gates.find((gate) => gate.id === "creator-holding")!.severity, "soft");
});

test("an empty noncreator Fresh population cannot earn favorable points from a zero denominator", () => {
  const report = getBrowserWalletFlagsFixture();
  for (const row of report.holderSnapshot!.holders) if (row.address !== browserFixture.pool) row.balanceRaw = row.address === browserFixture.funder ? "99000" : "0";
  const balances = new Map(report.holderSnapshot!.holders.map((row) => [row.address, row.balanceRaw]));
  report.wallets = report.wallets.map((row) => ({ ...row, balanceRaw: balances.get(row.address) ?? null }));
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.holdingBasis.holders, 1);
  assert.equal(assessment.metrics.freshWalletsPercent, null);
  assert.equal(assessment.categories.find((row) => row.id === "fresh")!.points, null);
  assert.equal(assessment.overallScore, null);
});

test("category credits use the exact pinned balance fraction rather than its truncated display percentage", () => {
  const report = getBrowserWalletFlagsFixture();
  report.token.totalSupplyRaw = report.holderSnapshot!.totalSupplyRaw = "1000001000";
  for (const row of report.holderSnapshot!.holders) if (row.address !== browserFixture.pool) row.balanceRaw = row.address === browserFixture.funder ? "2000001" : "99799999";
  const balances = new Map(report.holderSnapshot!.holders.map((row) => [row.address, row.balanceRaw]));
  report.wallets = report.wallets.map((row) => ({ ...row, balanceRaw: balances.get(row.address) ?? null }));
  const assessment = assessInvestigationReport(report);
  assert.equal(assessment.metrics.creatorSharePercent, "0.20");
  assert.equal(assessment.categories.find((row) => row.id === "dev")!.points, 9.9);
});

test("foreign or malformed source context cannot create creator or contract warning gates", () => {
  const report = withBalances(getBrowserReportFixture(), "1000", [{ address: browserFixture.walletA, balanceRaw: "850" }]);
  report.token.securitySnapshot = { source: "goplus", status: "reported", checkedAt: report.generatedAt, tokenAddress: address(555), chainId: 8453,
    sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address(555)}`, holderCount: 1, creatorAddress: browserFixture.walletA, checks: [{ id: "is_honeypot", value: "yes" }] };
  assert.equal(assessInvestigationReport(report).gates.length, 0);
  report.token.securitySnapshot.tokenAddress = report.token.address;
  assert.equal(assessInvestigationReport(report).gates.length, 0);
});
