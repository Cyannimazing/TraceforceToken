import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSaleDisplayProofs, retainedFundingRecords } from "../../src/components/investigation-evidence-facts";
import { buildWalletDisplayFacts } from "../../src/components/investigation-wallet-facts";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { browserFixture, getBrowserLinkedSellingFixture, getBrowserReportFixture } from "../fixtures/report";

test("retained sale presentation preserves pool, exact quote amount and the complete supporting proof", () => {
  const report = getBrowserLinkedSellingFixture();
  const proofs = buildSaleDisplayProofs(report);
  assert.equal(proofs.size, 2);
  for (const proof of proofs.values()) {
    assert.equal(proof.event.sale!.pool, browserFixture.pool);
    assert.equal(proof.event.sale!.quoteAmountRaw, "5");
    assert.deepEqual(proof.supportingEvidence.map((event) => event.id), proof.event.sale!.supportingEvidenceIds);
    assert.ok(proof.supportingEvidence.every((event) => event.transactionHash === proof.event.transactionHash && event.blockHash === proof.event.blockHash));
    const flag = buildWalletDisplayFacts(report).get(proof.event.from)!.flags.find((entry) => entry.id === "verified-sale")!;
    assert.deepEqual(new Set(flag.evidenceIds), new Set([proof.event.id, ...proof.event.sale!.supportingEvidenceIds]));
  }
  const first = report.evidence.find((event) => event.kind === "sale")!;
  const quote = report.evidence.find((event) => event.id === first.sale!.supportingEvidenceIds[1])!;
  const exact = ((1n << 255n) + 99n).toString();
  quote.amountRaw = exact;
  first.sale!.quoteAmountRaw = exact;
  assert.equal(buildSaleDisplayProofs(report).get(first.id)!.event.sale!.quoteAmountRaw, exact);
});

test("retained V2 sales preserve the same direct consideration proof", () => {
  const report = getBrowserLinkedSellingFixture();
  for (const event of report.evidence) if (event.sale) { event.sale.protocol = "uniswap-v2"; event.sale.factory = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6"; }
  const proofs = buildSaleDisplayProofs(report);
  assert.equal(proofs.size, 2);
  assert.ok([...proofs.values()].every((proof) => proof.event.sale?.protocol === "uniswap-v2" && proof.supportingEvidence.length === 2));
});

test("missing, wrong-fork or wrong-amount sale support cannot earn a verified-sale flag", () => {
  for (const defect of ["missing", "fork", "amount"] as const) {
    const report = getBrowserLinkedSellingFixture(), sale = report.evidence.find((event) => event.kind === "sale" && event.from === browserFixture.walletA)!;
    const quote = report.evidence.find((event) => event.id === sale.sale!.supportingEvidenceIds[1])!;
    if (defect === "missing") report.evidence = report.evidence.filter((event) => event.id !== quote.id);
    else if (defect === "fork") quote.blockHash = `0x${"f".repeat(64)}`;
    else quote.amountRaw = "6";
    assert.equal(buildSaleDisplayProofs(report).has(sale.id), false);
    const wallet = buildWalletDisplayFacts(report).get(browserFixture.walletA)!;
    assert.equal(wallet.supportedSales, 0);
    assert.equal(wallet.flags.some((flag) => flag.id === "verified-sale"), false);
  }
});

test("native funding list retains chronological positive ETH records outside the token window", () => {
  const report = getBrowserReportFixture();
  report.evidence.reverse();
  const funding = retainedFundingRecords(report);
  assert.deepEqual(funding.map((event) => event.blockNumber), ["90", "95"]);
  assert.ok(funding.every((event) => event.assetAddress === null && BigInt(event.blockNumber) < BigInt(report.range.from.number)));
  report.evidence.push({ ...funding[0], id: "synthetic-zero-funding", amountRaw: "0" });
  assert.equal(retainedFundingRecords(report).length, 2);
});

test("creator flags are explicitly source-reported while mint flags retain zero-address transfer proof", () => {
  const report = getBrowserReportFixture();
  report.token.securitySnapshot = {
    source: "goplus", status: "reported", checkedAt: report.generatedAt,
    sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`,
    tokenAddress: report.token.address, chainId: 8453, holderCount: 13, creatorAddress: browserFixture.walletA, checks: [],
  };
  const receipt = report.evidence.find((event) => event.kind === "transfer" && event.to === browserFixture.walletA)!;
  const mint = { ...receipt, id: "synthetic-mint-receipt", from: "0x0000000000000000000000000000000000000000" as const, amountRaw: "25" };
  report.evidence.push(mint, { ...mint, id: "synthetic-zero-mint", amountRaw: "0" }, { ...mint, id: "synthetic-other-token-mint", assetAddress: browserFixture.funder });
  const flags = buildWalletDisplayFacts(report).get(browserFixture.walletA)!.flags;
  const creator = flags.find((flag) => flag.id === "source-reported-creator")!;
  assert.equal(creator.label, "Creator · source-reported");
  assert.deepEqual(creator.evidenceIds, []);
  assert.equal(creator.sourceUrl, report.token.securitySnapshot.sourceUrl);
  assert.match(creator.basis, /GoPlus source-reported creator address/);
  assert.match(creator.basis, /creation transaction, developer identity, present ownership and privileged control were not verified/);
  assert.deepEqual(flags.find((flag) => flag.id === "observed-mint")!.evidenceIds, [mint.id]);
  assert.equal(buildWalletDisplayFacts(report).get(browserFixture.walletB)!.flags.some((flag) => flag.id === "source-reported-creator"), false);
  report.token.securitySnapshot.status = "unavailable";
  assert.equal(buildWalletDisplayFacts(report).get(browserFixture.walletA)!.flags.some((flag) => flag.id === "source-reported-creator"), false);
});

test("early-window flags require a complete-transfer deterministic finding and its retained support", () => {
  const original = getBrowserReportFixture();
  original.wallets[0].earlyAccumulator = true;
  assert.equal(buildWalletDisplayFacts(original).get(browserFixture.walletA)!.flags.some((flag) => flag.id === "early-window-accumulation"), false);
  const report = analyzeInvestigation({ token: original.token, range: original.range, evidence: original.evidence,
    pools: [browserFixture.pool], hubs: [], coverage: { ...original.coverage, transfers: "complete" } }, { id: original.id, generatedAt: original.generatedAt });
  const finding = report.findings.find((entry) => entry.category === "accumulation" && entry.wallets.includes(browserFixture.walletA))!;
  assert.ok(finding);
  const flag = buildWalletDisplayFacts(report).get(browserFixture.walletA)!.flags.find((entry) => entry.id === "early-window-accumulation")!;
  assert.deepEqual(flag.evidenceIds, finding.evidenceIds);
  assert.match(flag.basis, /not launch-relative buying or a sniper classification/);
  report.coverage.transfers = "partial";
  assert.equal(buildWalletDisplayFacts(report).get(browserFixture.walletA)!.flags.some((entry) => entry.id === flag.id), false);
  report.coverage.transfers = "complete";
  report.evidence = report.evidence.filter((event) => event.id !== finding.evidenceIds[0]);
  assert.equal(buildWalletDisplayFacts(report).get(browserFixture.walletA)!.flags.some((entry) => entry.id === flag.id), false);
});
