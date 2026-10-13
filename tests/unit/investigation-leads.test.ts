import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveInvestigationLeads } from "../../src/domain/investigations/investigation-leads";
import type { Address, InvestigationReport } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserLinkedSellingFixture, getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

test("shared funding produces an upstream target with actual source/recipients and retained proof", () => {
  const report = getBrowserReportFixture(), original = structuredClone(report);
  const lead = deriveInvestigationLeads(report)[0];
  assert.equal(lead.kind, "shared-funding");
  assert.deepEqual(new Set(lead.wallets), new Set([browserFixture.funder, browserFixture.walletA, browserFixture.walletB]));
  assert.deepEqual(new Set(lead.evidenceIds), new Set(report.evidence.filter((event) => event.kind === "funding").map((event) => event.id)));
  assert.match(lead.nextCheck, /source's earlier inbound funding/);
  assert.match(lead.nextCheck, /exchange, bridge or public service/);
  assert.match(lead.limitation, /not proof of common ownership/);
  assert.deepEqual(report, original);
});

test("linked selling retains every sale, consideration and prior-link citation without claiming traced proceeds", () => {
  const report = getBrowserLinkedSellingFixture();
  const lead = deriveInvestigationLeads(report).find((entry) => entry.kind === "linked-selling")!;
  const finding = report.findings.find((entry) => entry.rule.name === "prior-linked-verified-selling")!;
  assert.deepEqual(new Set(lead.evidenceIds), new Set(finding.evidenceIds));
  for (const sale of report.evidence.filter((event) => event.kind === "sale")) {
    assert.ok(lead.evidenceIds.includes(sale.id));
    assert.ok(sale.sale!.supportingEvidenceIds.every((id) => lead.evidenceIds.includes(id)));
  }
  assert.match(lead.nextCheck, /later quote-asset transfers/);
  assert.match(lead.limitation, /later proceeds have not been traced/);
  report.evidence = report.evidence.filter((event) => event.id !== report.evidence.find((event) => event.kind === "sale")!.sale!.supportingEvidenceIds[0]);
  assert.equal(deriveInvestigationLeads(report).some((entry) => entry.kind === "linked-selling"), false);
});

test("the earliest supported pool buyer retains initial-liquidity and complete purchase proof", () => {
  const report = getBrowserWalletFlagsFixture();
  const lead = deriveInvestigationLeads(report).find((entry) => entry.kind === "early-buy")!;
  const initial = report.evidence.find((event) => event.liquidity)!, purchase = report.evidence.filter((event) => event.purchase).sort((left, right) => Number(BigInt(left.blockNumber) - BigInt(right.blockNumber)))[0];
  assert.deepEqual(lead.wallets, [purchase.to]);
  assert.deepEqual(new Set(lead.evidenceIds), new Set([...initial.liquidity!.supportingEvidenceIds, ...purchase.purchase!.supportingEvidenceIds]));
  assert.match(lead.limitation, /not a universal token launch/);
  for (const event of report.evidence) delete event.purchase;
  assert.equal(deriveInvestigationLeads(report).some((entry) => entry.kind === "early-buy"), false, "pool token transfers alone cannot create a buy lead");
});

test("partial history cannot provide an initial-liquidity buyer lead", () => {
  const report = getBrowserWalletFlagsFixture(); report.coverage.transfers = "partial";
  assert.equal(deriveInvestigationLeads(report).some((entry) => entry.kind === "early-buy"), false);
});

test("creator and important pinned holders receive actionable funding gaps without invented proof", () => {
  const report = getBrowserWalletFlagsFixture(), creator = report.token.securitySnapshot!.creatorAddress!;
  report.coverage.funding.find((row) => row.wallet === creator)!.status = "partial";
  const holder = report.holderSnapshot!.holders.find((row) => row.address !== creator && row.address !== browserFixture.pool)!.address;
  report.coverage.funding.find((row) => row.wallet === holder)!.status = "unavailable";
  const leads = deriveInvestigationLeads(report), gaps = leads.filter((lead) => lead.kind === "funding-gap");
  assert.equal(gaps[0].wallets[0], creator);
  assert.equal(gaps[0].title, "Complete the creator's funding trail");
  assert.match(gaps[0].observed, /GoPlus reports/); assert.match(gaps[0].observed, /positive balance is pinned/);
  assert.match(gaps[0].nextCheck, /blocks 0–400/);
  assert.equal(gaps[0].sourceUrl, report.token.securitySnapshot!.sourceUrl);
  assert.equal(gaps.length, 2);
  for (const gap of gaps) {
    assert.deepEqual(gap.evidenceIds, []);
    assert.equal(gap.basis, "pinned-balance-and-coverage");
    assert.match(gap.nextCheck, /canonical transactions and successful receipts/);
    assert.match(gap.limitation, /cannot establish an unfunded wallet/);
  }
});

test("missing creator funding stays a source-context lead and contract funding requests a supported trace source", () => {
  const report = getBrowserWalletFlagsFixture(), creator = report.token.securitySnapshot!.creatorAddress!;
  report.coverage.funding = report.coverage.funding.filter((row) => row.wallet !== creator);
  report.walletActivitySnapshot!.rows.find((row) => row.address === creator)!.code = "contract";
  delete report.holderSnapshot;
  const gap = deriveInvestigationLeads(report).find((lead) => lead.kind === "funding-gap")!;
  assert.deepEqual(gap.evidenceIds, []); assert.equal(gap.basis, "source-context-and-coverage");
  assert.match(gap.observed, /not examined; no search row was retained/);
  assert.doesNotMatch(gap.observed, /positive balance|%|zero|unfunded/);
  assert.match(gap.nextCheck, /supported contract\/internal-transfer trace source/);
  report.token.securitySnapshot!.tokenAddress = browserFixture.walletA;
  assert.equal(deriveInvestigationLeads(report).some((lead) => lead.kind === "funding-gap"), false, "foreign creator context cannot supply an investigative target");
});

test("important-holder ranking remains exact above Number precision and rejects stale balance authority", () => {
  const report = getBrowserWalletFlagsFixture(), creator = report.token.securitySnapshot!.creatorAddress!;
  const rows = report.holderSnapshot!.holders.filter((row) => row.address !== creator && row.address !== browserFixture.pool);
  const larger = rows[1].address, smaller = rows[0].address, amount = 2n ** 200n;
  report.token.totalSupplyRaw = (amount * 4n).toString(); report.holderSnapshot!.totalSupplyRaw = report.token.totalSupplyRaw;
  for (const row of report.holderSnapshot!.holders) {
    row.balanceRaw = row.address === larger ? (amount + 1n).toString() : row.address === smaller ? amount.toString() : "1";
    const wallet = report.wallets.find((entry) => entry.address === row.address); if (wallet) wallet.balanceRaw = row.balanceRaw;
  }
  for (const row of report.coverage.funding) row.status = "not_examined";
  const gaps = deriveInvestigationLeads(report).filter((lead) => lead.kind === "funding-gap");
  assert.equal(gaps[0].wallets[0], creator); assert.equal(gaps[1].wallets[0], larger);
  report.holderSnapshot!.block = { ...report.holderSnapshot!.block, hash: `0x${"f".repeat(64)}` };
  const stale = deriveInvestigationLeads(report).filter((lead) => lead.kind === "funding-gap");
  assert.equal(stale.length, 1); assert.equal(stale[0].basis, "source-context-and-coverage");
});

test("leads are deterministic, bounded and never cite missing transactions or fabricate a lead for empty data", () => {
  const report = getBrowserReportFixture();
  for (let index = 0; index < 12; index++) {
    const originals = report.evidence.filter((event) => event.kind === "funding").slice(0, 2), source = `0x${(100 + index).toString(16).padStart(40, "0")}` as Address;
    const events = originals.map((event, offset) => ({ ...event, id: `bounded-source-${index}-${offset}`, from: source }));
    report.evidence.push(...events);
    const finding = report.findings.find((entry) => entry.rule.name === "shared-observed-native-source")!;
    report.findings.push({ ...finding, id: `bounded-source:${index}`, wallets: [source, browserFixture.walletA, browserFixture.walletB], evidenceIds: events.map((event) => event.id) });
  }
  const leads = deriveInvestigationLeads(report);
  assert.ok(leads.length <= 6); assert.equal(leads.filter((lead) => lead.kind === "shared-funding").length, 2);
  for (const lead of leads) assert.ok(lead.evidenceIds.every((id) => report.evidence.some((event) => event.id === id)));
  report.findings.reverse(); report.evidence.reverse(); assert.deepEqual(deriveInvestigationLeads(report), leads);
  const empty: InvestigationReport = { ...getBrowserReportFixture(), findings: [], evidence: [], wallets: [], connections: [], groups: [], story: [] };
  assert.deepEqual(deriveInvestigationLeads(empty), []);
  empty.findings = [{ ...getBrowserReportFixture().findings[0], evidenceIds: ["never-retained"] }];
  assert.deepEqual(deriveInvestigationLeads(empty), []);
});
