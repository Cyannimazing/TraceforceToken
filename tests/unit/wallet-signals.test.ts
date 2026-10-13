import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address, EvidenceRecord, Hash, InvestigationReport } from "../../src/domain/investigations/types";
import { deriveWalletSignals, firstAuthenticatedLiquidity, verifiedPurchaseProof } from "../../src/domain/investigations/wallet-signals";
import { goPlusTokenUrl } from "../../src/domain/investigations/token-security";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;
const zero = address(0), token = address(1), quote = address(2), creator = address(3), buyer = address(4), other = address(5), pool = address(6), factory = address(7), router = address(8);
const head = { number: "200", hash: hash(200), timestamp: 2000 };
function event(id: string, from: Address, to: Address, assetAddress: Address, amountRaw = "100", overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { id, kind: "transfer", chainId: 8453, blockNumber: "100", blockHash: hash(100), transactionHash: hash(1), transactionIndex: 0, logIndex: 0,
    traceId: null, timestamp: 1000, from, to, assetAddress, amountRaw, provenance: { provider: "Synthetic test fixture", method: "fabricated", observedAt: "2026-10-12T00:00:00.000Z" }, sale: null, ...overrides };
}
function liquidity(): EvidenceRecord[] {
  const deposit = event("initial-token", creator, pool, token);
  const quoteDeposit = event("initial-quote", creator, pool, quote, "500", { logIndex: 1 });
  const locked = event("locked-lp", zero, zero, pool, "1000", { logIndex: 2 });
  deposit.liquidity = { pool, factory, protocol: "uniswap-v2", mintLogIndex: 5, initial: true, supportingEvidenceIds: [deposit.id, quoteDeposit.id, locked.id] };
  return [deposit, quoteDeposit, locked];
}
function purchase(overrides: Partial<EvidenceRecord> = {}, paymentFrom = buyer): EvidenceRecord[] {
  const base = { blockNumber: "101", blockHash: hash(101), transactionHash: hash(2), transactionIndex: 0, timestamp: 1030, ...overrides };
  const received = event("purchase-token", pool, buyer, token, "20", { ...base, logIndex: 1 });
  const paid = event("purchase-quote", paymentFrom, pool, quote, "50", { ...base, logIndex: 0 });
  received.purchase = { pool, factory, protocol: "uniswap-v2", quoteAsset: quote, quoteAmountRaw: "50", swapLogIndex: 2, supportingEvidenceIds: [received.id, paid.id] };
  return [received, paid];
}
function report(evidence = [...liquidity(), ...purchase()]): InvestigationReport {
  return { schemaVersion: 1, id: "synthetic-wallet-signals", generatedAt: "2026-10-12T00:00:00.000Z", mode: "live",
    token: { address: token, chainId: 8453, name: "Synthetic", symbol: null, decimals: 18, totalSupplyRaw: "1000", securitySnapshot: {
      source: "goplus", status: "reported", checkedAt: "2026-10-12T00:00:00.000Z", sourceUrl: goPlusTokenUrl(token), tokenAddress: token, chainId: 8453, holderCount: 3, creatorAddress: creator, checks: [],
    } },
    range: { from: { number: "0", hash: hash(0), timestamp: 0 }, to: head, finality: "finalized" },
    coverage: { transfers: "complete", transferCrawl: { scope: "full", source: "rpc-logs", completedRanges: [{ fromBlock: "0", toBlock: "200" }] }, funding: [], eligibleWallets: 3, examinedWallets: 0, warnings: [] },
    walletActivitySnapshot: { block: head, rows: [{ address: creator, outgoingTransactionCountRaw: "6", code: "eoa" }, { address: buyer, outgoingTransactionCountRaw: "10", code: "eoa" }, { address: other, outgoingTransactionCountRaw: "11", code: "eoa" }] },
    summary: "Synthetic fixture", wallets: [creator, buyer, other].map((address) => ({ address, observedIncomingRaw: "0", observedOutgoingRaw: "0", observedNetRaw: "0", balanceRaw: "100", verifiedSoldRaw: "0", firstObservedAt: null, earlyAccumulator: null })),
    connections: [], groups: [], findings: [], story: [], evidence,
  };
}
const signal = (value: InvestigationReport, wallet = buyer) => deriveWalletSignals(value).wallets.find((row) => row.address === wallet)!;

test("familiar labels disclose source-reported creator and exact pinned outgoing nonce boundaries", () => {
  const value = report();
  assert.deepEqual(signal(value, creator).labels, ["creator", "fresh"]);
  assert.deepEqual(signal(value).labels, ["fresh", "sniper"]);
  assert.deepEqual(signal(value, other).labels, []);
  const basis = signal(value).flags.find((flag) => flag.label === "fresh")!.basis;
  assert.match(basis, /outgoing/); assert.match(basis, /does not count incoming/);
  assert.equal(deriveWalletSignals(value).creator?.sourceUrl, goPlusTokenUrl(token));
  value.walletActivitySnapshot!.rows[1].outgoingTransactionCountRaw = (2n ** 200n).toString();
  assert.equal(signal(value).outgoingTransactionCountRaw, (2n ** 200n).toString());
  assert.equal(signal(value).labels.includes("fresh"), false);
  value.walletActivitySnapshot!.rows[1].outgoingTransactionCountRaw = "0";
  assert.equal(signal(value).labels.includes("fresh"), true);
});

test("unknown balance, unavailable code and foreign block state never become zero or Fresh", () => {
  const value = report([]);
  value.wallets[1].balanceRaw = null;
  value.wallets[2].balanceRaw = "0";
  value.walletActivitySnapshot!.rows[1] = { address: buyer, outgoingTransactionCountRaw: "0", code: "contract" };
  value.walletActivitySnapshot!.rows[2] = { address: other, outgoingTransactionCountRaw: null, code: "unavailable" };
  assert.deepEqual(signal(value).labels, ["contract", "unread"]);
  assert.deepEqual(signal(value, other).labels, []);
  value.walletActivitySnapshot!.block = { ...head, hash: hash(199) };
  assert.deepEqual(signal(value).labels, ["unread"]);
  assert.equal(signal(value).outgoingTransactionCountRaw, null);
});

test("creator flags require matching reported GoPlus token context", () => {
  for (const mutate of [
    (value: InvestigationReport) => { value.token.securitySnapshot!.creatorAddress = null; },
    (value: InvestigationReport) => { value.token.securitySnapshot!.tokenAddress = other; },
    (value: InvestigationReport) => { value.token.securitySnapshot!.sourceUrl = goPlusTokenUrl(other); },
    (value: InvestigationReport) => { value.token.securitySnapshot!.status = "unavailable"; },
    (value: InvestigationReport) => { delete value.token.securitySnapshot; },
  ]) {
    const value = report(); mutate(value);
    assert.equal(deriveWalletSignals(value).creator, null);
    assert.equal(signal(value, creator).labels.includes("creator"), false);
  }
});

test("initial liquidity needs completed genesis acquisition and the entire same-receipt initial Mint proof", () => {
  const valid = report();
  assert.deepEqual(firstAuthenticatedLiquidity(valid)?.evidenceIds, ["initial-token", "initial-quote", "locked-lp"]);
  assert.equal(firstAuthenticatedLiquidity(valid)?.logIndex, 5, "reference the Mint ordering, not an earlier token deposit");
  for (const mutate of [
    (value: InvestigationReport) => { value.coverage.transfers = "partial"; },
    (value: InvestigationReport) => { value.coverage.transferCrawl!.scope = "window"; },
    (value: InvestigationReport) => { value.range.from.number = "1"; },
    (value: InvestigationReport) => { value.coverage.transferCrawl!.completedRanges = []; },
    (value: InvestigationReport) => { value.evidence[2].amountRaw = "999"; },
    (value: InvestigationReport) => { value.evidence[2].from = creator; },
    (value: InvestigationReport) => { value.evidence[1].transactionHash = hash(99); },
    (value: InvestigationReport) => { value.evidence[1].blockHash = hash(99); },
    (value: InvestigationReport) => { value.evidence[1].timestamp++; },
    (value: InvestigationReport) => { value.evidence[1].to = other; },
    (value: InvestigationReport) => { value.evidence[0].liquidity!.supportingEvidenceIds.pop(); },
  ]) {
    const value = report(); mutate(value);
    assert.equal(firstAuthenticatedLiquidity(value), null);
    assert.equal(signal(value).labels.includes("sniper"), false);
  }
});

test("purchase proof requires authenticated annotation, whole same-receipt transfers and exact pool quote inflow", () => {
  assert.equal(verifiedPurchaseProof(report(), report().evidence[3]), null, "only a retained report record can be used");
  for (const mutate of [
    (value: InvestigationReport) => { delete value.evidence[3].purchase; },
    (value: InvestigationReport) => { value.evidence[3].from = other; },
    (value: InvestigationReport) => { value.evidence[3].purchase!.quoteAmountRaw = "51"; },
    (value: InvestigationReport) => { value.evidence[4].to = other; },
    (value: InvestigationReport) => { value.evidence[4].transactionHash = hash(99); },
    (value: InvestigationReport) => { value.evidence[4].transactionIndex++; },
    (value: InvestigationReport) => { value.evidence[3].purchase!.supportingEvidenceIds.push("purchase-token"); },
    (value: InvestigationReport) => { value.evidence[3].purchase!.swapLogIndex = 1; },
  ]) {
    const value = report(); mutate(value);
    assert.equal(verifiedPurchaseProof(value, value.evidence[3]), null);
    assert.equal(signal(value).labels.includes("sniper"), false);
    assert.equal(signal(value).entry?.kind, "transfer");
  }
});

test("native-wrap authenticated purchases keep router-paid quote proof without inventing wallet WETH debits", () => {
  const value = report([...liquidity(), ...purchase({}, router)]);
  assert.ok(verifiedPurchaseProof(value, value.evidence[3]));
  assert.equal(signal(value).labels.includes("sniper"), true);
  assert.equal(signal(value).entry?.kind, "buy");
});

test("Sniper requires same-pool ordered purchase within the half-open sixty-second interval", () => {
  for (const [offset, expected] of [[0, true], [59, true], [60, false], [-1, false]] as const) {
    const value = report([...liquidity(), ...purchase({ timestamp: 1000 + offset, blockNumber: "100", blockHash: hash(100), transactionIndex: 1 })]);
    assert.equal(signal(value).labels.includes("sniper"), expected, `offset ${offset}`);
  }
  const beforeMint = report([...liquidity(), ...purchase({ timestamp: 1000, blockNumber: "100", blockHash: hash(100), transactionIndex: 0 })]);
  assert.equal(signal(beforeMint).labels.includes("sniper"), false, "same timestamp does not override transaction/log ordering");
  beforeMint.evidence[3].purchase!.swapLogIndex = 5;
  assert.equal(signal(beforeMint).labels.includes("sniper"), false, "a swap cannot occupy the initial Mint's exact ordered position");
  const wrongVenue = report(); wrongVenue.evidence[3].purchase!.protocol = "uniswap-v3";
  assert.equal(signal(wrongVenue).entry?.kind, "buy", "a verified V3 purchase remains a purchase");
  assert.equal(signal(wrongVenue).labels.includes("sniper"), false, "a V2 initialization cannot anchor another protocol");
  const wrongFactory = report(); wrongFactory.evidence[3].purchase!.factory = other;
  assert.equal(signal(wrongFactory).labels.includes("sniper"), false);
});

test("Insider requires direct creator-sourced receipt before initial liquidity and preserves its evidence basis", () => {
  const funding = event("creator-funding", creator, other, token, "1", { kind: "funding", assetAddress: null, logIndex: null, blockNumber: "99", blockHash: hash(99), transactionHash: hash(9), timestamp: 990 });
  const value = report([funding, ...liquidity(), ...purchase()]);
  const insider = signal(value, other).flags.find((flag) => flag.label === "insider")!;
  assert.deepEqual(insider.evidenceIds, ["creator-funding", "initial-token", "initial-quote", "locked-lp"]);
  assert.match(insider.basis, /not proof of identity/);
  assert.equal(signal(value, creator).labels.includes("insider"), false);
  funding.kind = "transfer"; funding.assetAddress = token; funding.logIndex = 0;
  assert.equal(signal(value, other).labels.includes("insider"), true);
  funding.from = buyer;
  assert.equal(signal(value, other).labels.includes("insider"), false, "transitive or unrelated senders are not the creator");
  funding.from = creator; funding.timestamp = 1000; funding.blockNumber = "100"; funding.transactionIndex = 1;
  assert.equal(signal(value, other).labels.includes("insider"), false, "same-second receipt after Mint is not pre-liquidity");
});

test("earliest entry uses exact chain order and never relabels accumulation as a purchase", () => {
  const mint = event("mint", zero, buyer, token, "1", { blockNumber: "90", blockHash: hash(90), timestamp: 900 });
  const value = report([...purchase(), ...liquidity(), mint]);
  value.wallets[1].earlyAccumulator = true;
  const before = JSON.stringify(value);
  assert.equal(signal(value).entry?.kind, "mint");
  assert.equal(signal(value).labels.includes("sniper"), false, "a later early purchase cannot relabel an earlier mint recipient as a first-entry sniper");
  assert.deepEqual(signal(value).entry?.evidenceIds, ["mint"]);
  assert.equal(JSON.stringify(value), before, "derivation cannot mutate evidence or wallet records");
  delete value.evidence[0].purchase;
  value.evidence = value.evidence.filter((record) => record.id !== "mint");
  assert.equal(signal(value).entry?.kind, "transfer");
  assert.equal(signal(value).labels.includes("sniper"), false);
});

test("preexisting token receipts prevent Sniper even when a later authenticated purchase is inside sixty seconds", () => {
  const prior = event("prior-allocation", creator, buyer, token, "1", { blockNumber: "99", blockHash: hash(99), transactionHash: hash(99), timestamp: 990 });
  const value = report([...purchase(), ...liquidity(), prior]);
  assert.equal(signal(value).entry?.kind, "transfer");
  assert.equal(signal(value).labels.includes("sniper"), false);
  assert.equal(signal(value).labels.includes("insider"), true, "direct creator allocation retains its separate evidence-backed label");
  prior.amountRaw = "0";
  assert.equal(signal(value).entry?.kind, "buy", "zero-value receipts do not establish token entry");
  assert.equal(signal(value).labels.includes("sniper"), true);
  assert.match(signal(value).flags.find((flag) => flag.label === "sniper")!.basis, /earliest retained positive token receipt/);
});

test("a mint recipient does not acquire Creator attribution when the reported creator is unavailable", () => {
  const minted = event("initial-mint", zero, buyer, token, "1", { blockNumber: "90", blockHash: hash(90), transactionHash: hash(90), timestamp: 900 });
  const value = report([...liquidity(), ...purchase(), minted]);
  value.token.securitySnapshot!.creatorAddress = null;
  assert.equal(signal(value).entry?.kind, "mint");
  assert.equal(deriveWalletSignals(value).creator, null);
  assert.equal(signal(value).labels.includes("creator"), false, "token mint recipients are not contract-creation proof");
  assert.equal(signal(value).labels.includes("sniper"), false);
});

test("first entry uses transaction/log order before a same-second early purchase", () => {
  const prior = event("prior-receipt", other, buyer, token, "1", { blockNumber: "101", blockHash: hash(101), transactionHash: hash(8), transactionIndex: 0, logIndex: 0, timestamp: 1030 });
  const value = report([...purchase({ transactionIndex: 1 }), prior, ...liquidity()]);
  assert.equal(signal(value).labels.includes("sniper"), false);
  assert.deepEqual(signal(value).entry?.evidenceIds, [prior.id]);
  prior.transactionIndex = 2;
  assert.equal(signal(value).labels.includes("sniper"), true, "a later ordinary receipt cannot erase an earlier verified buy");
});
