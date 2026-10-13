/** Synthetic browser-only test data. Never import this module from the application. */
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { validateInvestigationExplanation } from "../../src/domain/investigations/explanation";
import type { Address, EvidenceRecord, ExplainedInvestigationReport, Hash, InvestigationDataset, InvestigationJob } from "../../src/domain/investigations/types";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hash;
export const browserFixture = {
  id: "11111111-1111-4111-8111-111111111111",
  token: address(500),
  walletA: address(10),
  walletB: address(11),
  funder: address(13),
  pool: address(900),
  exactAmount: ((1n << 255n) + 9_007_199_254_740_993n).toString(),
  timestamp: 1_760_000_000,
  generatedAt: "2026-10-12T00:00:00.000Z",
} as const;

function transfer(block: number, tx: number, from: Address, to: Address, amountRaw = "1"): EvidenceRecord {
  return {
    id: `synthetic-transfer-${tx}`, kind: "transfer", chainId: 8453,
    blockNumber: String(block), blockHash: hash(block), transactionHash: hash(tx), transactionIndex: 0,
    logIndex: 0, traceId: null, timestamp: browserFixture.timestamp + (block - 100) * 10,
    from, to, assetAddress: browserFixture.token, amountRaw,
    provenance: { provider: "Synthetic browser test fixture", method: "fabricated test receipt", observedAt: browserFixture.generatedAt }, sale: null,
  };
}

function funding(block: number, tx: number, to: Address): EvidenceRecord {
  return { ...transfer(block, tx, browserFixture.funder, to, "1000"), id: `synthetic-funding-${tx}`, kind: "funding", logIndex: null, assetAddress: null };
}

export function getBrowserReportFixture(): ExplainedInvestigationReport {
  const input: InvestigationDataset = {
    token: { address: browserFixture.token, chainId: 8453, name: "Synthetic browser test fixture", symbol: null, decimals: 18, totalSupplyRaw: null },
    range: {
      from: { number: "100", hash: hash(100), timestamp: browserFixture.timestamp },
      to: { number: "400", hash: hash(400), timestamp: browserFixture.timestamp + 3000 }, finality: "finalized",
    },
    evidence: [
      funding(90, 10, browserFixture.walletA), funding(95, 11, browserFixture.walletB),
      transfer(110, 20, browserFixture.pool, browserFixture.walletA, browserFixture.exactAmount),
      transfer(111, 21, browserFixture.pool, browserFixture.walletB, "99"),
      // Exercise evidence pagination without inventing extra relationship claims.
      ...Array.from({ length: 23 }, (_, index) => transfer(130 + index, 100 + index, browserFixture.pool, browserFixture.walletB)),
      transfer(180, 200, browserFixture.walletA, browserFixture.walletB, "7"),
    ],
    pools: [browserFixture.pool], hubs: [],
    coverage: {
      transfers: "partial", eligibleWallets: 3, examinedWallets: 2,
      funding: [browserFixture.walletA, browserFixture.walletB].map((wallet) => ({ wallet, status: "partial", fromBlock: "0", toBlock: "400", internalTransfers: "not_examined", reason: "Synthetic fixture: indexed history is incomplete." })),
      warnings: ["Synthetic browser test fixture; these addresses and events are fabricated.", "One eligible wallet and some transfer history were not examined."],
    },
  };
  const report = analyzeInvestigation(input, { id: browserFixture.id, generatedAt: browserFixture.generatedAt });
  const fundingIds = report.evidence.filter((event) => event.kind === "funding").map((event) => event.id);
  const transferId = report.connections.find((edge) => edge.kind === "transfer")!.evidenceIds[0];
  const contextIds = [...fundingIds, transferId].sort();
  const explanation = validateInvestigationExplanation(report, {
    schemaVersion: 1, reportId: report.id, profileId: "on-chain-investigator", profileVersion: "1.0.0",
    model: "synthetic-qwen3:4b-test-fixture", generatedAt: "2026-10-12T00:00:01.000Z", authority: "non-authoritative-commentary",
    overview: { text: "In this synthetic browser fixture, two observed token wallets received native funding from the same source. This describes a funding relationship, not proof that one person controls both wallets.", evidenceIds: fundingIds },
    observations: [
      { category: "funding", claim: "The synthetic funding records link two recipients to one source.", caveat: "The source may be a public service, and earlier or internal funding was not fully examined.", evidenceIds: fundingIds },
      { category: "connections", claim: "A later synthetic token transfer directly connects the two wallets.", caveat: "A payment or distribution can create this connection without shared ownership.", evidenceIds: [transferId] },
    ],
    limitations: ["Synthetic test explanation; no live model generated this text.", "Only the declared window and examined wallets are covered. Current balances and lifetime funding remain unknown."],
    context: { evidenceIds: contextIds, suppliedEvidence: contextIds.length, omittedEvidence: report.evidence.length - contextIds.length },
  });
  return { ...report, explanation };
}

export function getBrowserJobFixture(status: InvestigationJob["status"]): InvestigationJob {
  return {
    id: browserFixture.id, status,
    parameters: { token: browserFixture.token, lookbackBlocks: 1000 },
    stage: status === "queued" ? "Synthetic queued test fixture" : status === "running" ? "Rewriting evidence in plain English" : "Synthetic completed test fixture",
    attempts: status === "queued" ? 0 : 1, createdAt: browserFixture.generatedAt, updatedAt: browserFixture.generatedAt,
    error: null, report: status === "completed" ? getBrowserReportFixture() : null,
  };
}

/** Positive linked-selling UI fixture; all transactions and addresses are synthetic. */
export function getBrowserLinkedSellingFixture(): ExplainedInvestigationReport {
  const original = getBrowserReportFixture();
  const sales = [browserFixture.walletA, browserFixture.walletB].flatMap((wallet, index): EvidenceRecord[] => {
    const transaction = 301 + index, block = 200 + index * 30;
    const common = transfer(block, transaction, wallet, browserFixture.pool, "10");
    const outgoing = { ...common, id: `synthetic-sale-out-${transaction}` };
    const quote = { ...common, id: `synthetic-sale-quote-${transaction}`, logIndex: 1, from: browserFixture.pool, to: wallet, assetAddress: address(901), amountRaw: "5" };
    return [outgoing, quote, { ...common, id: `synthetic-sale-${transaction}`, kind: "sale", logIndex: 2, sale: {
      pool: browserFixture.pool, factory: address(902), protocol: "uniswap-v3", quoteAsset: address(901), quoteAmountRaw: "5", swapLogIndex: 2, supportingEvidenceIds: [outgoing.id, quote.id],
    } }];
  });
  const report = analyzeInvestigation({ token: original.token, range: original.range, evidence: [...original.evidence, ...sales], pools: [browserFixture.pool], hubs: [], coverage: original.coverage }, { id: original.id, generatedAt: original.generatedAt });
  const explanation = validateInvestigationExplanation(report, { ...original.explanation, context: { ...original.explanation.context, omittedEvidence: report.evidence.length - original.explanation.context.suppliedEvidence } });
  return { ...report, explanation };
}

/** Fabricated full-history V2 receipts exercise exact visible wallet vocabulary. */
export function getBrowserWalletFlagsFixture(options: { contractDominated?: boolean } = {}): ExplainedInvestigationReport {
  const contractDominated = options.contractDominated === true;
  const creator = browserFixture.funder, pool = browserFixture.pool, quote = "0x4200000000000000000000000000000000000006" as Address;
  const factory = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6" as Address;
  const zero = address(0), buyers = Array.from({ length: contractDominated ? 12 : 10 }, (_, index) => address(1000 + index));
  const buyerBalance = (index: number) => contractDominated ? index === 11 ? "1199" : "1196" : "1500";
  const from = { number: "0", hash: hash(0), timestamp: browserFixture.timestamp }, to = { number: "400", hash: hash(400), timestamp: browserFixture.timestamp + 4000 };
  const record = (block: number, transaction: number, logIndex: number, from: Address, recipient: Address, asset: Address, amountRaw: string, timestamp = browserFixture.timestamp + block): EvidenceRecord => ({
    ...transfer(block, transaction, from, recipient, amountRaw), id: `synthetic-flags-${transaction}-${logIndex}`, logIndex, assetAddress: asset, timestamp,
  });
  const mint = record(10, 10, 0, zero, creator, browserFixture.token, "100000");
  const initial = [record(20, 20, 0, creator, pool, browserFixture.token, contractDominated ? "15355" : "16000"), record(20, 20, 1, creator, pool, quote, "2000"), record(20, 20, 2, zero, zero, pool, "1000")];
  initial[0].liquidity = { pool, factory, protocol: "uniswap-v2", mintLogIndex: 5, initial: true, supportingEvidenceIds: initial.map((event) => event.id) };
  const insiderFunding: EvidenceRecord = { ...record(15, 15, 0, creator, buyers[1], browserFixture.token, "50"), kind: "funding", assetAddress: null, logIndex: null };
  const purchases = buyers.flatMap((buyer, index) => {
    const block = 23 + index * 10, timestamp = browserFixture.timestamp + (index === 0 ? 50 : 200 + index * 20), tx = 30 + index;
    const paid = record(block, tx, 0, buyer, pool, quote, "100", timestamp), received = record(block, tx, 1, pool, buyer, browserFixture.token, buyerBalance(index), timestamp);
    received.purchase = { pool, factory, protocol: "uniswap-v2", quoteAsset: quote, quoteAmountRaw: "100", swapLogIndex: 2, supportingEvidenceIds: [paid.id, received.id] };
    return [paid, received];
  });
  const participants = [creator, ...buyers];
  const input: InvestigationDataset = {
    token: { address: browserFixture.token, chainId: 8453, name: "Synthetic reference flags", symbol: "TEST", decimals: 0, totalSupplyRaw: "100000", securitySnapshot: {
      source: "goplus", status: "reported", checkedAt: browserFixture.generatedAt, sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${browserFixture.token}`,
      tokenAddress: browserFixture.token, chainId: 8453, holderCount: participants.length, creatorAddress: contractDominated ? null : creator, checks: [],
    } },
    range: { from, to, finality: "finalized" }, pools: [pool], hubs: [factory], evidence: [mint, insiderFunding, ...initial, ...purchases],
    coverage: { transfers: "complete", transferCrawl: { scope: "full", source: "rpc-logs", completedRanges: [{ fromBlock: "0", toBlock: "400" }] }, eligibleWallets: participants.length, examinedWallets: participants.length,
      funding: participants.map((wallet) => ({ wallet, status: "complete", fromBlock: "0", toBlock: "400", internalTransfers: "not_examined", reason: "Synthetic complete top-level funding search." })), warnings: ["Fabricated browser test receipts, balances and state; no live acquisition."] },
    holderSnapshot: { chainId: 8453, tokenAddress: browserFixture.token, block: to, totalSupplyRaw: "100000",
      discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${browserFixture.token}/holders`, observedAt: browserFixture.generatedAt, status: "complete", pages: 1, addresses: participants.length + 1, finalizedCensus: false, reason: null },
      balances: { status: "complete", requestedWallets: participants.length + 1, verifiedWallets: participants.length + 1, reason: null },
      holders: [...participants.map((wallet, index) => ({ address: wallet, balanceRaw: wallet === creator ? contractDominated ? "84645" : "84000" : buyerBalance(index - 1), status: "verified" as const, discoveredBy: "indexed" as const })), { address: pool, balanceRaw: "1000", status: "verified", discoveredBy: "indexed" }],
      provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: browserFixture.generatedAt } },
    walletActivitySnapshot: { block: to, rows: participants.map((wallet, index) => ({ address: wallet, outgoingTransactionCountRaw: index === 0 ? "6" : index === 1 ? "606" : String(450 + index), code: contractDominated && index === 0 ? "contract" : "eoa" })) },
    liquiditySnapshot: { protocol: "uniswap-v2", pool, factory, token0: browserFixture.token, token1: quote, reserve0Raw: "1000", reserve1Raw: contractDominated ? "3200" : "3000", block: to,
      provenance: { provider: "Synthetic browser fixture", method: "fabricated authenticated pinned reserves", observedAt: browserFixture.generatedAt } },
  };
  const report = analyzeInvestigation(input, { id: browserFixture.id, generatedAt: browserFixture.generatedAt });
  const original = getBrowserReportFixture().explanation;
  const evidenceIds = report.findings.find((finding) => finding.category === "funding")!.evidenceIds;
  const explanation = validateInvestigationExplanation(report, { ...original, overview: { text: "Synthetic receipt-backed funding and wallet flags for browser testing.", evidenceIds }, observations: [],
    context: { evidenceIds, suppliedEvidence: evidenceIds.length, omittedEvidence: report.evidence.length - evidenceIds.length } });
  return { ...report, explanation };
}
