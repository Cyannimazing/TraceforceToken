import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSupplementalReportFacts } from "../../src/domain/investigations/report-facts";
import { goPlusTokenUrl } from "../../src/domain/investigations/token-security";
import type { Address, HolderSnapshot, InvestigationReport, TokenMarketSnapshot, TokenSecuritySnapshot } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const extra = address(99);
function snapshot(report: InvestigationReport, rows: { address: Address; balanceRaw: string | null; status?: "unavailable" | "not_examined" }[], supply = "1000"): InvestigationReport {
  const value = structuredClone(report);
  value.token.totalSupplyRaw = supply;
  const holders: HolderSnapshot["holders"] = rows.map((row) => ({ address: row.address, balanceRaw: row.balanceRaw, status: row.balanceRaw === null ? row.status ?? "not_examined" : "verified", discoveredBy: "indexed" }));
  const verified = holders.filter((row) => row.status === "verified").length;
  value.holderSnapshot = {
    chainId: 8453, tokenAddress: value.token.address, block: { ...value.range.to }, totalSupplyRaw: supply,
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${value.token.address}/holders`, observedAt: value.generatedAt, status: "partial", pages: 1, addresses: holders.length, finalizedCensus: false, reason: "Synthetic indexed selection, not a census." },
    balances: { status: verified === holders.length ? "complete" : verified ? "partial" : holders.some((row) => row.status === "unavailable") ? "unavailable" : "not_examined", requestedWallets: holders.length, verifiedWallets: verified, reason: "Synthetic pinned reads." },
    holders, provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: value.generatedAt },
  };
  const balances = new Map(holders.map((row) => [row.address, row.balanceRaw]));
  value.wallets = value.wallets.map((wallet) => ({ ...wallet, balanceRaw: balances.get(wallet.address) ?? null }));
  return value;
}
function security(report: InvestigationReport, creatorAddress: Address | null = browserFixture.walletA): TokenSecuritySnapshot {
  return { source: "goplus", status: "reported", checkedAt: report.generatedAt, sourceUrl: goPlusTokenUrl(report.token.address), tokenAddress: report.token.address, chainId: 8453, holderCount: 13, creatorAddress, checks: [] };
}
function market(report: InvestigationReport, liquidityUsd: number | null): TokenMarketSnapshot {
  return { source: "dexscreener", status: "reported", checkedAt: report.generatedAt, sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: browserFixture.pool,
    priceUsd: "0.001", marketCapUsd: null, liquidityUsd, volume24hUsd: null, priceChange24hPercent: null, pairCreatedAt: null };
}

test("source-reported creator has exact pinned holding and directional retained proof, without verified ownership", () => {
  const report = snapshot(getBrowserReportFixture(), [{ address: browserFixture.walletA, balanceRaw: "848" }, { address: browserFixture.walletB, balanceRaw: "20" }]);
  report.token.securitySnapshot = security(report);
  const creator = deriveSupplementalReportFacts(report).creator!;
  assert.equal(creator.address, browserFixture.walletA);
  assert.match(creator.qualification, /source-reported creator/);
  assert.match(creator.qualification, /creation transaction.*ownership.*not verified/);
  assert.deepEqual(creator.holding, { block: report.range.to, status: "verified", balanceRaw: "848", shareOfSupply: { amountRaw: "848", totalSupplyRaw: "1000" } });
  assert.equal(creator.evidence.nativeReceivedIds.length, 1);
  assert.equal(creator.evidence.nativeSentIds.length, 0);
  assert.equal(creator.evidence.tokenReceivedIds.length, 1);
  assert.equal(creator.evidence.tokenSentIds.length, 1);
  for (const ids of Object.values(creator.evidence)) for (const id of ids) assert.ok(report.evidence.some((event) => event.id === id));
  report.token.securitySnapshot = security(report, browserFixture.funder);
  assert.equal(deriveSupplementalReportFacts(report).creator!.evidence.nativeSentIds.length, 2);
});

test("creator absence, missing read, failed read and verified zero remain distinct", () => {
  const report = getBrowserReportFixture();
  assert.equal(deriveSupplementalReportFacts(report).creator, null);
  report.token.securitySnapshot = security(report);
  assert.equal(deriveSupplementalReportFacts(report).creator!.holding, null);
  for (const [rows, status, balance] of [
    [[{ address: browserFixture.walletB, balanceRaw: "0" }], "missing", null],
    [[{ address: browserFixture.walletA, balanceRaw: null, status: "unavailable" }], "unavailable", null],
    [[{ address: browserFixture.walletA, balanceRaw: "0" }], "verified", "0"],
  ] as const) {
    const value = snapshot(report, rows.map((row) => ({ ...row })));
    const holding = deriveSupplementalReportFacts(value).creator!.holding!;
    assert.equal(holding.status, status); assert.equal(holding.balanceRaw, balance);
    assert.deepEqual(holding.shareOfSupply, balance === null ? null : { amountRaw: "0", totalSupplyRaw: "1000" });
  }
});

test("group known subtotal is exact with separate missing, unavailable and unexamined members", () => {
  const report = snapshot(getBrowserReportFixture(), [
    { address: browserFixture.walletA, balanceRaw: "400" }, { address: browserFixture.walletB, balanceRaw: null, status: "unavailable" },
    { address: extra, balanceRaw: null },
  ]);
  report.groups = [{ id: "synthetic-group", wallets: [extra, browserFixture.walletB, browserFixture.walletA, browserFixture.funder, browserFixture.walletA], evidenceIds: [], explanation: "Synthetic only." }];
  const holding = deriveSupplementalReportFacts(report).groups[0].holding!;
  assert.deepEqual(holding, { block: report.range.to, totalAddresses: 4, verifiedAddresses: 1, unavailableAddresses: 1, notExaminedAddresses: 1, missingAddresses: 1,
    knownBalanceRaw: "400", shareOfSupply: { amountRaw: "400", totalSupplyRaw: "1000" }, isLowerBound: true });
});

test("uint256 values and group supply ratios never round through floating point", () => {
  const a = (2n ** 255n + 9_007_199_254_740_993n).toString(), b = "9007199254740993", supply = (2n ** 256n - 1n).toString();
  const report = snapshot(getBrowserReportFixture(), [{ address: browserFixture.walletA, balanceRaw: a }, { address: browserFixture.walletB, balanceRaw: b }], supply);
  report.groups = [{ id: "synthetic-group", wallets: [browserFixture.walletB, browserFixture.walletA], evidenceIds: [], explanation: "Synthetic only." }];
  const holding = deriveSupplementalReportFacts(report).groups[0].holding!;
  assert.equal(holding.knownBalanceRaw, (BigInt(a) + BigInt(b)).toString());
  assert.deepEqual(holding.shareOfSupply, { amountRaw: (BigInt(a) + BigInt(b)).toString(), totalSupplyRaw: supply });
  assert.equal(holding.isLowerBound, false);
});

test("set-aside inventory distinguishes retained authenticated pools from unclassified addresses", () => {
  const report = snapshot(getBrowserReportFixture(), [
    { address: browserFixture.walletA, balanceRaw: "100" }, { address: browserFixture.pool, balanceRaw: "900" }, { address: extra, balanceRaw: null },
  ]);
  const setAside = deriveSupplementalReportFacts(report).setAside!;
  assert.deepEqual(setAside.addresses.map((row) => row.address), [extra, browserFixture.pool].sort());
  assert.equal(setAside.holding.knownBalanceRaw, "900"); assert.equal(setAside.holding.notExaminedAddresses, 1);
  assert.equal(setAside.holding.isLowerBound, true); assert.deepEqual(setAside.discovery, report.holderSnapshot!.discovery);
  assert.deepEqual(setAside.provenance, report.holderSnapshot!.provenance);
  assert.equal(setAside.addresses.find((row) => row.address === browserFixture.pool)!.role, "Authenticated pool");
  assert.match(setAside.addresses.find((row) => row.address === browserFixture.pool)!.reason, /Authenticated liquidity pool/);
  assert.equal(setAside.addresses.find((row) => row.address === extra)!.role, "Unclassified");
  assert.match(setAside.addresses.find((row) => row.address === extra)!.reason, /role is unverified/);
  const concerns = deriveSupplementalReportFacts(report).signals.filter((signal) => signal.kind === "concentration");
  assert.deepEqual(concerns.map((signal) => signal.address), [browserFixture.walletA]);
});

test("known burn roles and authenticated pool roles do not depend on successful balance reads", () => {
  const zero = address(0), dead = "0x000000000000000000000000000000000000dead" as Address;
  const report = snapshot(getBrowserReportFixture(), [
    { address: zero, balanceRaw: "10" }, { address: dead, balanceRaw: "20" },
    { address: browserFixture.pool, balanceRaw: null, status: "unavailable" },
  ]);
  const inventory = deriveSupplementalReportFacts(report).setAside!;
  assert.deepEqual(inventory.addresses.filter((row) => row.role === "Burn address").map((row) => row.address), [zero, dead]);
  const pool = inventory.addresses.find((row) => row.address === browserFixture.pool)!;
  assert.equal(pool.role, "Authenticated pool");
  assert.equal(pool.status, "unavailable");
  assert.equal(pool.balanceRaw, null);
  assert.equal(inventory.holding.knownBalanceRaw, "30");
  assert.equal(inventory.holding.isLowerBound, true);
});

test("a selected market pair or contract code cannot authenticate an excluded pool or locker", () => {
  const report = snapshot(getBrowserReportFixture(), [
    { address: browserFixture.pool, balanceRaw: "100" }, { address: extra, balanceRaw: "200" },
  ]);
  report.token.marketSnapshot = market(report, 100);
  report.walletActivitySnapshot = { block: { ...report.range.to }, rows: [
    { address: browserFixture.pool, code: "contract", outgoingTransactionCountRaw: null },
    { address: extra, code: "contract", outgoingTransactionCountRaw: null },
  ] };
  for (const infrastructure of [undefined, { pools: [], hubs: [extra] }]) {
    report.infrastructure = infrastructure;
    const inventory = deriveSupplementalReportFacts(report).setAside!;
    assert.equal(inventory.addresses.length, 2);
    assert.ok(inventory.addresses.every((row) => row.role === "Unclassified"));
    assert.ok(inventory.addresses.every((row) => /role is unverified/.test(row.reason)));
  }
});

test("all-unknown group subtotal is null; zero reads and empty inventory have exact zero", () => {
  const report = snapshot(getBrowserReportFixture(), [{ address: browserFixture.walletA, balanceRaw: null }]);
  report.groups = [{ id: "synthetic-group", wallets: [browserFixture.walletA], evidenceIds: [], explanation: "Synthetic only." }];
  assert.equal(deriveSupplementalReportFacts(report).groups[0].holding!.knownBalanceRaw, null);
  const zero = snapshot(report, [{ address: browserFixture.walletA, balanceRaw: "0" }], "0");
  const facts = deriveSupplementalReportFacts(zero);
  assert.equal(facts.groups[0].holding!.knownBalanceRaw, "0"); assert.equal(facts.groups[0].holding!.shareOfSupply, null);
  assert.equal(facts.setAside!.holding.totalAddresses, 0); assert.equal(facts.setAside!.holding.knownBalanceRaw, "0");
  assert.equal(facts.signals.length, 0);
});

test("concentration threshold uses integer comparison and unknown never becomes absence of concern", () => {
  const base = getBrowserReportFixture();
  const below = deriveSupplementalReportFacts(snapshot(base, [{ address: browserFixture.walletA, balanceRaw: "100" }], "1001"));
  assert.equal(below.signals.length, 0);
  const threshold = deriveSupplementalReportFacts(snapshot(base, [{ address: browserFixture.walletA, balanceRaw: "101" }], "1001"));
  assert.equal(threshold.signals[0].kind, "concentration");
  const missing = deriveSupplementalReportFacts(snapshot(base, [{ address: browserFixture.walletA, balanceRaw: null }]));
  assert.equal(missing.signals.length, 0); assert.equal(missing.groups[0].holding!.verifiedAddresses, 0);
});

test("thin liquidity is a separate selected-pair convention; reported zero differs from unknown", () => {
  const report = getBrowserReportFixture();
  for (const [liquidity, count] of [[3.69, 1], [0, 1], [9999.99, 1], [10000, 0], [null, 0]] as const) {
    report.token.marketSnapshot = market(report, liquidity);
    const signals = deriveSupplementalReportFacts(report).signals;
    assert.equal(signals.length, count);
    if (signals[0]?.kind === "thin-liquidity") { assert.equal(signals[0].liquidityUsd, liquidity); assert.equal(signals[0].pairAddress, browserFixture.pool); assert.match(signals[0].limitations.join(" "), /not total token liquidity/); }
  }
});

test("contract flags keep source attribution and proxy context; no or unknown never imply safety", () => {
  const report = getBrowserReportFixture();
  report.token.securitySnapshot = { ...security(report), checks: [
    { id: "is_honeypot", value: "yes" }, { id: "is_proxy", value: "yes" }, { id: "is_mintable", value: "unknown" },
    { id: "is_open_source", value: "no" }, { id: "hidden_owner", value: "no" },
  ] };
  const flags = deriveSupplementalReportFacts(report).signals.filter((signal) => signal.kind === "contract-flag");
  assert.deepEqual(flags.map((flag) => [flag.checkId, flag.reportedValue, flag.level]), [["is_honeypot", "yes", "review"], ["is_open_source", "no", "review"], ["is_proxy", "yes", "context"]]);
  assert.ok(flags.every((flag) => flag.sourceUrl === report.token.securitySnapshot!.sourceUrl && /GoPlus/.test(flag.label)));
});

test("foreign identities, inconsistent snapshots and malformed dates cannot produce supplemental facts", () => {
  const report = snapshot(getBrowserReportFixture(), [{ address: browserFixture.walletA, balanceRaw: "100" }]);
  for (const mutate of [
    (value: InvestigationReport) => { value.holderSnapshot!.block.number = "401"; },
    (value: InvestigationReport) => { value.holderSnapshot!.holders[0].balanceRaw = "-1"; },
    (value: InvestigationReport) => { value.token.securitySnapshot = security(value); value.token.securitySnapshot.tokenAddress = extra; value.token.securitySnapshot.sourceUrl = goPlusTokenUrl(extra); },
    (value: InvestigationReport) => { value.token.marketSnapshot = market(value, 3.69); value.token.marketSnapshot.sourceUrl = `https://api.dexscreener.com/token-pairs/v1/base/${extra}`; },
    (value: InvestigationReport) => { value.token.securitySnapshot = security(value); value.token.securitySnapshot.checkedAt = "not a date"; },
  ]) { const value = structuredClone(report); mutate(value); assert.throws(() => deriveSupplementalReportFacts(value)); }
});

test("derivation is immutable, serializable and stable across report ordering", () => {
  const report = snapshot(getBrowserReportFixture(), [{ address: browserFixture.walletA, balanceRaw: "848" }, { address: browserFixture.pool, balanceRaw: "100" }]);
  report.token.securitySnapshot = { ...security(report), checks: [{ id: "hidden_owner", value: "yes" }, { id: "is_proxy", value: "yes" }] };
  report.token.marketSnapshot = market(report, 3.69);
  const original = structuredClone(report), expected = deriveSupplementalReportFacts(report);
  assert.deepEqual(report, original); assert.doesNotThrow(() => JSON.stringify(expected));
  report.evidence.reverse(); report.groups.reverse(); report.holderSnapshot!.holders.reverse(); report.token.securitySnapshot!.checks.reverse();
  assert.deepEqual(deriveSupplementalReportFacts(report), expected);
  const plain = getBrowserReportFixture();
  assert.equal(deriveSupplementalReportFacts(plain).setAside, null);
  assert.ok(deriveSupplementalReportFacts(plain).groups.every((group) => group.holding === null));
});
