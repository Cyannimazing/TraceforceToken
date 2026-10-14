import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisInputError, MAX_DETAILED_TRANSFER_FINDINGS, analyzeInvestigation, evidenceId } from "../../src/domain/investigations/analyze";
import { MAX_INVESTIGATION_REPORT_BYTES, validateBaseInvestigationReport } from "../../src/domain/investigations/report-validation";
import type { Address, EvidenceRecord, Hash, HolderSnapshot, InvestigationDataset } from "../../src/domain/investigations/types";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hash;
const A = address(10), B = address(11), C = address(12), FUNDER = address(13);
const TOKEN = address(500), POOL = address(900), QUOTE = address(901), FACTORY = address(902), HUB = address(800);
const ZERO = address(0), TIME = 1_760_000_000;
const OPTIONS = { id: "analysis-fixture", generatedAt: "2026-10-12T00:00:00.000Z" };
const MAX = ((1n << 256n) - 1n).toString();

function transfer(block: number, tx: number, from: Address, to: Address, amount = "100", extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { id: `transfer-${tx}-${extra.logIndex ?? 0}`, kind: "transfer", chainId: 8453, blockNumber: String(block), blockHash: hash(block), transactionHash: hash(tx), transactionIndex: tx, logIndex: 0, traceId: null, timestamp: TIME + (block - 100) * 10, from, to, assetAddress: TOKEN, amountRaw: amount, provenance: { provider: "fixture", method: "eth_getLogs", observedAt: "2026-10-11T00:00:00.000Z" }, sale: null, ...extra };
}

function funding(block: number, tx: number, from: Address, to: Address, amount = "1000", extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return transfer(block, tx, from, to, amount, { id: `funding-${tx}`, kind: "funding", assetAddress: null, logIndex: null, ...extra });
}

function sale(block: number, tx: number, wallet: Address, amount = "50"): EvidenceRecord[] {
  const tokenFlow = transfer(block, tx, wallet, POOL, amount);
  const quoteFlow = transfer(block, tx, POOL, wallet, "25", { logIndex: 1, assetAddress: QUOTE });
  return [tokenFlow, quoteFlow, transfer(block, tx, wallet, POOL, amount, { id: `sale-${tx}`, kind: "sale", logIndex: 2, sale: { pool: POOL, factory: FACTORY, protocol: "uniswap-v3", quoteAsset: QUOTE, quoteAmountRaw: "25", swapLogIndex: 2, supportingEvidenceIds: [tokenFlow.id, quoteFlow.id] } })];
}

function dataset(evidence: EvidenceRecord[], overrides: Partial<InvestigationDataset> = {}): InvestigationDataset {
  const wallets = [...new Set(evidence.filter((event) => event.kind === "transfer" && event.assetAddress?.toLowerCase() === TOKEN).flatMap((event) => [event.from, event.to]).filter((wallet) => wallet !== POOL && wallet !== ZERO && wallet !== HUB))];
  return {
    token: { address: TOKEN, chainId: 8453, name: "Synthetic Fixture", symbol: "FIXTURE", decimals: 18, totalSupplyRaw: MAX },
    range: { from: { number: "100", hash: hash(100), timestamp: TIME }, to: { number: "400", hash: hash(400), timestamp: TIME + 3000 }, finality: "finalized" },
    evidence,
    pools: [POOL],
    hubs: [HUB],
    coverage: { transfers: "complete", funding: wallets.map((wallet) => ({ wallet, status: "complete", fromBlock: "0", toBlock: "400", internalTransfers: "not_examined", reason: null })), eligibleWallets: wallets.length, examinedWallets: wallets.length, warnings: [] },
    ...overrides,
  };
}

const analyze = (input: InvestigationDataset) => analyzeInvestigation(input, OPTIONS);
const findings = (input: InvestigationDataset, category: string) => analyze(input).findings.filter((item) => item.category === category);
const initial = () => [transfer(110, 20, POOL, A), transfer(110, 21, POOL, B)];
const linked = () => [...initial(), funding(90, 10, FUNDER, A), funding(95, 11, FUNDER, B)];

test("ordinary transfer reports retain every direct finding and story until the narrative limit", () => {
  const events = Array.from({ length: MAX_DETAILED_TRANSFER_FINDINGS }, (_, index) => transfer(101 + index, 1000 + index, A, B));
  const source = dataset(events), report = analyze(source);
  const detailed = report.findings.filter((finding) => finding.rule.name === "direct-token-transfer");
  assert.equal(detailed.length, events.length);
  assert.deepEqual(detailed.map((finding) => finding.evidenceIds[0]), events.map(evidenceId));
  for (const finding of detailed) assert.ok(report.story.some((entry) => entry.id === `story:${finding.id}` && entry.evidenceIds[0] === finding.evidenceIds[0]));
  assert.equal(report.coverage.warnings.some((warning) => warning.startsWith("Detailed summaries cover ")), false);
});

test("dense transfer reports fit the existing byte limit without losing evidence, candidates, graph edges or complete group proofs", () => {
  const participants = Array.from({ length: 1998 }, (_, index) => address(1000 + index));
  const observedAt = "2026-10-14T00:00:00.000Z";
  const range = { from: { number: "0", hash: hash(0), timestamp: TIME }, to: { number: "2500", hash: hash(2500), timestamp: TIME + 5000 }, finality: "finalized" as const };
  const events = Array.from({ length: 2000 }, (_, index) => transfer(index + 1, 10000 + index, participants[0], participants[1 + index % 1997], "1000000000000000000", {
    transactionIndex: 0, timestamp: TIME + (index + 1) * 2,
    provenance: { provider: "Synthetic stress fixture".padEnd(128, "x"), method: "fabricated test receipt".padEnd(128, "x"), observedAt },
  }));
  const source = dataset(events, {
    range, pools: [], hubs: [],
    coverage: { transfers: "partial", transferCrawl: { scope: "full", source: "alchemy-transfers", completedRanges: [] },
      funding: participants.map((wallet) => ({ wallet, status: "not_examined", fromBlock: "0", toBlock: "2500", internalTransfers: "not_examined", reason: "Synthetic stress: funding not examined within the bounded budget." })),
      eligibleWallets: participants.length, examinedWallets: 0, warnings: ["Synthetic stress data only."] },
    holderSnapshot: { chainId: 8453, tokenAddress: TOKEN, block: range.to, totalSupplyRaw: MAX,
      discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${TOKEN}/holders`, observedAt, status: "unavailable", pages: 0, addresses: 0, finalizedCensus: false, reason: "Synthetic index unavailable." },
      balances: { status: "partial", requestedWallets: participants.length, verifiedWallets: 459, reason: "Synthetic bounded balance coverage." },
      holders: participants.map((wallet, index) => ({ address: wallet, balanceRaw: index < 459 ? "1" : null, status: index < 459 ? "verified" : "not_examined", discoveredBy: "observed" })),
      provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt } },
    walletActivitySnapshot: { block: range.to, rows: participants.map((wallet) => ({ address: wallet, outgoingTransactionCountRaw: null, code: "unavailable" })) },
  });
  const original = structuredClone(source);
  const options = { id: "11111111-1111-4111-8111-111111111111", generatedAt: observedAt };
  const report = analyzeInvestigation(source, options);
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") < MAX_INVESTIGATION_REPORT_BYTES);
  assert.doesNotThrow(() => validateBaseInvestigationReport(report));
  assert.deepEqual(source, original);
  assert.equal(report.evidence.length, events.length);
  assert.deepEqual(report.evidence.map((event) => event.id), events.map(evidenceId));
  assert.equal(report.connections.length, events.length);
  assert.deepEqual(report.connections.map((connection) => connection.evidenceIds[0]), report.evidence.map((event) => event.id));
  assert.deepEqual(report.wallets.map((wallet) => wallet.address), participants);
  assert.deepEqual(report.holderSnapshot, source.holderSnapshot);
  assert.deepEqual(report.walletActivitySnapshot, source.walletActivitySnapshot);
  assert.deepEqual(report.coverage.funding, source.coverage.funding);
  assert.equal(report.coverage.transfers, "partial"); assert.equal(report.coverage.examinedWallets, 0);
  assert.equal(report.groups.length, 1); assert.deepEqual(report.groups[0].wallets, participants);
  const completeProof = new Set(report.evidence.map((event) => event.id));
  assert.deepEqual(new Set(report.groups[0].evidenceIds), completeProof);
  assert.deepEqual(new Set(report.findings.find((finding) => finding.id === "connections:group:1")!.evidenceIds), completeProof);
  assert.deepEqual(new Set(report.story.find((entry) => entry.id === "story:connections:group:1")!.evidenceIds), completeProof);
  const detailed = report.findings.filter((finding) => finding.rule.name === "direct-token-transfer");
  assert.equal(detailed.length, MAX_DETAILED_TRANSFER_FINDINGS);
  assert.deepEqual(detailed.map((finding) => finding.evidenceIds[0]), report.evidence.slice(0, MAX_DETAILED_TRANSFER_FINDINGS).map((event) => event.id));
  assert.equal(report.story.filter((entry) => entry.id.startsWith("story:transfer:")).length, MAX_DETAILED_TRANSFER_FINDINGS);
  const disclosure = `Detailed summaries cover ${MAX_DETAILED_TRANSFER_FINDINGS} of ${events.length} qualifying token transfers; ${events.length - MAX_DETAILED_TRANSFER_FINDINGS} transfers have no individual finding or timeline summary. All evidence, connections and group proofs are retained.`;
  assert.ok(report.coverage.warnings.includes(disclosure));
  assert.ok(report.coverage.warnings.includes("Synthetic stress data only."));
  assert.ok(report.findings.find((finding) => finding.category === "coverage")!.limitations.includes(disclosure));
  const reordered = structuredClone(source); reordered.evidence.reverse();
  assert.deepEqual(analyzeInvestigation(reordered, options), report);
});

test("completed full crawl preserves scope and measures early accumulation from token activity, not Base genesis", () => {
  const source = dataset(initial());
  source.range.from = { number: "0", hash: hash(0), timestamp: TIME - 1_000_000 };
  source.coverage.transferCrawl = { scope: "full", source: "rpc-logs", completedRanges: [{ fromBlock: "0", toBlock: "400" }] };
  const report = analyze(source);
  assert.deepEqual(report.coverage.transferCrawl, source.coverage.transferCrawl);
  const early = report.findings.filter((finding) => finding.category === "accumulation");
  assert.equal(early.length, 2);
  assert.equal(early[0].rule.parameters.baseline, "first-observed-token-transfer");
  assert.equal(early[0].rule.parameters.endExclusive, TIME + 100 + 600);
  assert.match(early[0].limitations[0], /not proof of.*market launch/);
  assert.equal(report.wallets.find((wallet) => wallet.address === A)?.earlyAccumulator, true);
});

test("partial full crawl leaves early labels unknown and rejects a fabricated complete range", () => {
  const source = dataset(initial());
  source.range.from = { number: "0", hash: hash(0), timestamp: TIME - 1_000_000 };
  source.coverage.transfers = "partial";
  source.coverage.transferCrawl = { scope: "full", source: "alchemy-transfers", completedRanges: [] };
  const report = analyze(source);
  assert.equal(report.findings.some((finding) => finding.category === "accumulation"), false);
  assert.equal(report.wallets.find((wallet) => wallet.address === A)?.earlyAccumulator, null);
  source.coverage.transfers = "complete";
  assert.throws(() => analyze(source));
});

function holderSnapshot(input: InvestigationDataset): HolderSnapshot {
  return {
    chainId: 8453, tokenAddress: TOKEN, block: input.range.to, totalSupplyRaw: MAX,
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${TOKEN}/holders`, observedAt: OPTIONS.generatedAt, status: "partial", pages: 1, addresses: 2, finalizedCensus: false, reason: "Synthetic partial index." },
    balances: { status: "partial", requestedWallets: 3, verifiedWallets: 2, reason: "Synthetic bounded checks." },
    holders: [
      { address: C, balanceRaw: null, status: "not_examined", discoveredBy: "observed" },
      { address: B, balanceRaw: "0", status: "verified", discoveredBy: "indexed" },
      { address: A, balanceRaw: MAX, status: "verified", discoveredBy: "both" },
    ],
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: OPTIONS.generatedAt },
  };
}

test("pinned holder balances preserve exact values, add indexed participants, and leave unread balances unknown", () => {
  const input = dataset([transfer(110, 20, POOL, A)]);
  input.coverage.transfers = "partial";
  input.holderSnapshot = holderSnapshot(input);
  const original = structuredClone(input), report = analyze(input);
  assert.equal(report.wallets.find((wallet) => wallet.address === A)?.balanceRaw, MAX);
  assert.equal(report.wallets.find((wallet) => wallet.address === B)?.balanceRaw, "0");
  assert.equal(report.wallets.find((wallet) => wallet.address === C)?.balanceRaw, null);
  assert.equal(report.wallets.find((wallet) => wallet.address === B)?.observedIncomingRaw, "0");
  assert.equal(report.wallets.find((wallet) => wallet.address === B)?.firstObservedAt, null);
  assert.ok(report.wallets.every((wallet) => wallet.earlyAccumulator === null));
  assert.deepEqual(report.evidence, analyze(dataset(input.evidence)).evidence);
  assert.match(report.summary, /Pinned balances verified: 2\/3/);
  assert.doesNotMatch(report.findings.at(-1)!.explanation, /all balances are unknown/i);
  const reordered = structuredClone(input); reordered.holderSnapshot!.holders.reverse();
  assert.deepEqual(analyze(reordered), report);
  assert.deepEqual(input, original);
});

test("analyzer rejects a holder snapshot for another finalized block, token, or inconsistent supply", () => {
  const input = dataset(initial()); input.holderSnapshot = holderSnapshot(input);
  for (const mutate of [
    (value: HolderSnapshot) => { value.block = { ...value.block, hash: hash(401) }; },
    (value: HolderSnapshot) => { value.tokenAddress = QUOTE; },
    (value: HolderSnapshot) => { value.totalSupplyRaw = "100"; },
    (value: HolderSnapshot) => { value.holders[2].balanceRaw = (2n ** 256n).toString(); },
  ]) { const changed = structuredClone(input); mutate(changed.holderSnapshot!); assert.throws(() => analyze(changed), AnalysisInputError); }
});

test("source-reported market metadata survives analysis without creating evidence and must match this token", () => {
  const input = dataset(initial()), original = analyze(input);
  input.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt: OPTIONS.generatedAt, sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${TOKEN}`, pairAddress: POOL, priceUsd: "0.000000000000000000123456789", marketCapUsd: 123, liquidityUsd: 200, volume24hUsd: null, priceChange24hPercent: -2, pairCreatedAt: 1_700_000_000_000 };
  const report = analyze(input);
  assert.deepEqual(report.token.marketSnapshot, input.token.marketSnapshot);
  assert.deepEqual(report.evidence, original.evidence);
  assert.deepEqual(report.findings, original.findings);
  input.token.marketSnapshot.sourceUrl = `https://api.dexscreener.com/token-pairs/v1/base/${QUOTE}`;
  assert.throws(() => analyze(input), AnalysisInputError);
});

test("website metadata survives analysis without becoming transaction evidence or findings", () => {
  const input = dataset(initial()), original = analyze(input);
  input.token.webPresence = {
    source: "dexscreener", status: "reported", checkedAt: "2026-10-12T00:00:00.000Z",
    sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${TOKEN}`,
    websites: [{ url: "https://project.org/", pairAddresses: [POOL] }], matchedPairs: 1, reason: null,
  };
  const report = analyze(input);
  assert.deepEqual(report.token.webPresence, input.token.webPresence);
  assert.deepEqual(report.findings, original.findings);
  assert.deepEqual(report.evidence, original.evidence);
  input.token.webPresence.sourceUrl = `https://api.dexscreener.com/token-pairs/v1/base/${QUOTE}`;
  assert.throws(() => analyze(input), AnalysisInputError);
});

test("empty failed acquisition remains unavailable with an explicit coverage finding", () => {
  const input = dataset([]);
  input.coverage = { transfers: "unavailable", funding: [], eligibleWallets: 12, examinedWallets: 0, warnings: ["Provider quota exhausted."] };
  const report = analyze(input);
  assert.equal(report.coverage.transfers, "unavailable");
  assert.equal(report.coverage.eligibleWallets, 12);
  assert.equal(report.wallets.length, 0);
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].explanation, /0 of 12/);
  assert.ok(report.findings[0].limitations.includes("Provider quota exhausted."));
  assert.doesNotMatch(report.summary, /clean|safe|independent/i);
});

test("uint256 amounts retain exact precision and balances always remain unknown", () => {
  const report = analyze(dataset([transfer(110, 20, POOL, A, MAX), transfer(120, 21, A, B, "9007199254740993123456789")]));
  const wallet = report.wallets.find((item) => item.address === A)!;
  assert.equal(wallet.observedIncomingRaw, MAX);
  assert.equal(wallet.observedNetRaw, (BigInt(MAX) - 9007199254740993123456789n).toString());
  assert.ok(report.wallets.every((item) => item.balanceRaw === null));
  assert.equal(report.token.totalSupplyRaw, MAX);
});

test("reordered duplicate events, aliases, warnings and metadata produce the same report without mutating input", () => {
  const events = [...linked(), ...sale(200, 30, A), ...sale(230, 31, B)];
  const duplicate = { ...events[0], id: "another-source-alias" };
  const input = dataset([...events, duplicate]);
  input.coverage.warnings = ["Second warning.", "First warning.", "Second warning."];
  const snapshot = structuredClone(input);
  const expected = analyze(input);
  for (let shift = 0; shift < events.length; shift++) {
    const other = structuredClone(input);
    other.evidence = [...other.evidence.slice(shift), ...other.evidence.slice(0, shift)].reverse();
    other.coverage.funding.reverse();
    other.coverage.warnings.reverse();
    assert.deepEqual(analyze(other), expected);
  }
  assert.deepEqual(input, snapshot);
  assert.equal(expected.evidence.length, events.length);
  assert.ok(expected.evidence.every((event) => event.id === evidenceId(event)));
  const ids = new Set(expected.evidence.map((event) => event.id));
  for (const item of [...expected.findings, ...expected.story, ...expected.connections, ...expected.groups]) {
    assert.ok(item.evidenceIds.every((id) => ids.has(id)));
  }
  for (const event of expected.evidence) assert.ok(event.sale?.supportingEvidenceIds.every((id) => ids.has(id)) ?? true);
});

test("address/hash case normalizes without changing event identity", () => {
  const input = dataset([transfer(110, 20, POOL, A)]);
  input.token.address = TOKEN.toUpperCase().replace("0X", "0x") as Address;
  for (const event of input.evidence) {
    event.to = event.to.toUpperCase().replace("0X", "0x") as Address;
    event.blockHash = event.blockHash.toUpperCase().replace("0X", "0x") as Hash;
    event.transactionHash = event.transactionHash.toUpperCase().replace("0X", "0x") as Hash;
  }
  const report = analyze(input);
  assert.equal(report.token.address, TOKEN);
  assert.ok(report.wallets.some((wallet) => wallet.address === A));
});

test("funding ordering uses chain positions and reports first observed rather than lifetime-first", () => {
  const input = dataset([...initial(), funding(95, 11, B, A), funding(90, 10, FUNDER, A)]);
  const result = findings(input, "funding").find((finding) => finding.wallets.includes(FUNDER))!;
  assert.equal(result.title, "First observed native funding");
  assert.match(result.explanation, /blocks 0–400/);
  assert.match(result.limitations.join(" "), /not lifetime-first/);
  assert.equal(result.evidenceIds[0], evidenceId(input.evidence[3]));
});

test("unknown shared funders create only qualified low-confidence association groups", () => {
  const report = analyze(dataset(linked()));
  assert.equal(report.groups.length, 1);
  assert.deepEqual(report.groups[0].wallets, [A, B, FUNDER].sort());
  assert.match(report.groups[0].explanation, /unknown public-service/);
  assert.match(report.groups[0].explanation, /not verified common owners/);
  assert.ok(report.findings.filter((finding) => finding.category === "funding" || finding.id.startsWith("connections:")).every((finding) => finding.confidence === "low"));
});

test("known hubs, pools, zero addresses, self moves and zero amounts never create relationship edges", () => {
  const report = analyze(dataset([...initial(), funding(90, 10, HUB, A), funding(95, 11, HUB, B), transfer(120, 22, ZERO, A), transfer(125, 23, A, ZERO), transfer(130, 24, A, A), transfer(135, 25, A, B, "0")]));
  assert.equal(report.connections.length, 0);
  assert.equal(report.groups.length, 0);
  assert.equal(report.wallets.some((wallet) => [POOL, ZERO, HUB].includes(wallet.address)), false);
  assert.ok(report.findings.filter((finding) => finding.category === "funding").every((finding) => finding.explanation.includes("excluded from relationship groups")));
});

test("similar receipt timing alone does not produce graph connections or groups", () => {
  const report = analyze(dataset(initial()));
  assert.equal(report.groups.length, 0);
  assert.equal(report.connections.length, 0);
});

test("direct transfers form evidence-linked groups with explicit transitive and ownership caveats", () => {
  const report = analyze(dataset([...initial(), transfer(120, 22, A, B), transfer(130, 23, B, C)]));
  assert.deepEqual(report.groups[0].wallets, [A, B, C]);
  assert.match(report.groups[0].explanation, /transitive/);
  assert.ok(report.findings.filter((finding) => finding.title === "Direct token transfer relationship").every((finding) => /not an ownership inference/.test(finding.explanation)));
});

test("early accumulation is only the first observed 600 seconds and ignores quote assets", () => {
  const report = analyze(dataset([transfer(110, 20, POOL, A), transfer(160, 21, POOL, B), transfer(110, 22, POOL, C, "500", { assetAddress: QUOTE })]));
  assert.equal(report.wallets.find((wallet) => wallet.address === A)?.earlyAccumulator, true);
  assert.equal(report.wallets.find((wallet) => wallet.address === B)?.earlyAccumulator, false);
  assert.equal(report.wallets.some((wallet) => wallet.address === C), false);
  const early = report.findings.filter((finding) => finding.category === "accumulation");
  assert.equal(early.length, 1);
  assert.equal(early[0].rule.parameters.baseline, "range-start");
  assert.match(early[0].explanation, /not a market-launch window/);
});

test("partial transfer and wallet funding coverage never become current balances or complete accumulation", () => {
  const input = dataset(initial());
  input.coverage.transfers = "partial";
  input.coverage.funding = [{ ...input.coverage.funding[0], status: "partial", reason: "Page budget exhausted." }];
  input.coverage.examinedWallets = 1;
  const report = analyze(input);
  assert.equal(report.findings.some((finding) => finding.category === "accumulation"), false);
  assert.ok(report.wallets.every((wallet) => wallet.balanceRaw === null && wallet.earlyAccumulator === null));
  assert.match(report.coverage.warnings.join(" "), /not_examined/);
  assert.match(report.findings.find((finding) => finding.category === "coverage")!.explanation, /1 of 2/);
});

test("qualified sales use independent token-out/quote-in evidence and do not double count annotations", () => {
  const report = analyze(dataset([...linked(), ...sale(200, 30, A), ...sale(230, 31, B)]));
  const selling = report.findings.filter((finding) => finding.category === "selling");
  assert.equal(selling.length, 1);
  assert.deepEqual(selling[0].wallets, [A, B]);
  assert.equal(selling[0].confidence, "low");
  const wallet = report.wallets.find((item) => item.address === A)!;
  assert.equal(wallet.observedIncomingRaw, "100");
  assert.equal(wallet.observedOutgoingRaw, "50");
  assert.equal(wallet.verifiedSoldRaw, "50");
  assert.equal(selling[0].evidenceIds.length, 8);
  assert.match(selling[0].explanation, /not coordinated intent/);
});

test("unrelated verified sellers at similar times are not a linked-selling finding", () => {
  const report = analyze(dataset([...initial(), ...sale(200, 30, A), ...sale(230, 31, B)]));
  assert.equal(report.findings.some((finding) => finding.category === "selling"), false);
  assert.equal(report.wallets.find((wallet) => wallet.address === A)?.verifiedSoldRaw, "50");
});

test("relationships observed after the earliest sale cannot be backdated", () => {
  const report = analyze(dataset([...initial(), ...sale(200, 30, A), transfer(220, 29, A, B, "1"), ...sale(230, 31, B)]));
  assert.equal(report.groups.length, 1);
  assert.equal(report.findings.some((finding) => finding.category === "selling"), false);
});

test("rolling selling windows include exactly 600 seconds but require distinct wallets", () => {
  assert.equal(findings(dataset([...linked(), ...sale(200, 30, A), ...sale(260, 31, B)]), "selling").length, 1);
  assert.equal(findings(dataset([...linked(), ...sale(200, 30, A), ...sale(261, 31, B)]), "selling").length, 0);
  assert.equal(findings(dataset([...linked(), ...sale(200, 30, A), ...sale(230, 31, A)]), "selling").length, 0);
});

test("pool transfers and internal moves remain transfers without verified sale annotations", () => {
  const report = analyze(dataset([...linked(), transfer(200, 30, A, POOL, "50"), transfer(220, 31, B, A, "30")]));
  assert.ok(report.wallets.every((wallet) => wallet.verifiedSoldRaw === "0"));
  assert.equal(report.findings.some((finding) => finding.category === "selling"), false);
});

test("sale metadata cannot omit flows, claim missing quote receipts, or classify liquidity provision", () => {
  const valid = [...initial(), ...sale(200, 30, A)];
  const missingSupport = structuredClone(valid);
  missingSupport[4].sale!.supportingEvidenceIds = [missingSupport[2].id];
  assert.throws(() => analyze(dataset(missingSupport)), /incomplete sale net-flow/);
  const quoteMismatch = structuredClone(valid);
  quoteMismatch[3].amountRaw = "24";
  assert.throws(() => analyze(dataset(quoteMismatch)), /quote flow mismatch/);
  const liquidity = structuredClone(valid);
  liquidity[3].from = A;
  liquidity[3].to = POOL;
  assert.throws(() => analyze(dataset(liquidity)), /quote flow mismatch/);
  const unresolved = structuredClone(valid);
  unresolved[4].sale!.supportingEvidenceIds.push("absent-receipt");
  assert.throws(() => analyze(dataset(unresolved)), /unresolved sale/);
});

test("one wallet net sale in a transaction cannot be annotated again at another swap log", () => {
  const events = [...initial(), ...sale(200, 30, A)];
  const repeated = structuredClone(events[4]);
  repeated.id = "second-sale-annotation";
  repeated.logIndex = 3;
  repeated.sale!.swapLogIndex = 3;
  assert.throws(() => analyze(dataset([...events, repeated])), /repeated sale net-flow/);
});

test("coincident quote donations cannot establish pool-to-wallet sale consideration", () => {
  const events = [...initial(), ...sale(200, 30, A)];
  events[3].to = C;
  const donation = transfer(200, 30, B, A, "25", { logIndex: 3, assetAddress: QUOTE });
  events[4].sale!.supportingEvidenceIds.push(donation.id);
  assert.throws(() => analyze(dataset([...events, donation])), /direct consideration path/);
});

test("sale support must include pool flows and independently reconcile pool net amounts", () => {
  const events = [...initial(), ...sale(200, 30, A)];
  const extraPoolOutflow = transfer(200, 30, POOL, C, "1", { logIndex: 3, assetAddress: QUOTE });
  assert.throws(() => analyze(dataset([...events, extraPoolOutflow])), /incomplete sale net-flow/);
  events[4].sale!.supportingEvidenceIds.push(extraPoolOutflow.id);
  assert.throws(() => analyze(dataset([...events, extraPoolOutflow])), /quote flow mismatch/);
});

test("different wallet sale annotations cannot claim a single supported transaction twice", () => {
  const first = sale(200, 30, A), second = sale(200, 30, B);
  const otherPool = address(903);
  second.forEach((event, index) => { event.id = `second-${index}`; event.logIndex! += 3; });
  second[0].to = otherPool;
  second[1].from = otherPool;
  second[2].to = otherPool;
  second[2].sale!.pool = otherPool;
  second[2].sale!.swapLogIndex = 5;
  second[2].sale!.supportingEvidenceIds = [second[0].id, second[1].id];
  const allFlows = [first[0].id, first[1].id, second[0].id, second[1].id];
  first[2].sale!.supportingEvidenceIds = allFlows;
  second[2].sale!.supportingEvidenceIds = allFlows;
  assert.throws(() => analyze(dataset([...initial(), ...first, ...second], { pools: [POOL, otherPool] })), /multiple sale annotations/);
});

test("native funding cannot invent internal trace coverage and swaps cannot reuse a transfer log", () => {
  assert.throws(() => analyze(dataset([...initial(), funding(90, 10, FUNDER, A, "100", { traceId: "0_1" })])), /unexamined trace coverage/);
  const events = [...initial(), ...sale(200, 30, A)];
  events[4].logIndex = 0;
  events[4].sale!.swapLogIndex = 0;
  assert.throws(() => analyze(dataset(events)), /swap log conflicts/);
});

test("mixed forks, contradictory logical events and ambiguous aliases are rejected", () => {
  const event = transfer(110, 20, POOL, A);
  assert.throws(() => analyze(dataset([event, { ...event, id: "fork", blockHash: hash(999) }])), /conflicting block|mixed-fork/);
  assert.throws(() => analyze(dataset([event, { ...event, id: "changed", amountRaw: "999" }])), /conflicting repeated event/);
  assert.throws(() => analyze(dataset([event, { ...transfer(120, 21, POOL, B), id: event.id }])), /ambiguous source/);
  assert.throws(() => analyze(dataset([event, { ...transfer(120, 20, POOL, B), id: "different-inclusion" }])), /conflicting transaction inclusion/);
});

test("pinned boundary hashes, block timestamps and coverage bounds are enforced", () => {
  assert.throws(() => analyze(dataset([transfer(100, 20, POOL, A, "100", { blockHash: hash(999) })])), /conflicting block identity/);
  assert.throws(() => analyze(dataset([transfer(400, 20, POOL, A, "100", { timestamp: TIME + 2999 })])), /conflicting block identity/);
  assert.throws(() => analyze(dataset([transfer(99, 20, POOL, A)])), /outside range/);
  assert.throws(() => analyze(dataset([transfer(401, 20, POOL, A)])), /after pinned/);
  const input = dataset(linked());
  input.coverage.funding.forEach((entry) => { entry.fromBlock = "100"; });
  assert.throws(() => analyze(input), /outside examined coverage/);
});

test("malicious amounts, addresses, hashes, timestamps and chain IDs fail before analysis", () => {
  for (const amount of ["-1", "01", "1e18", "1.1", (BigInt(MAX) + 1n).toString()]) {
    assert.throws(() => analyze(dataset([transfer(110, 20, POOL, A, amount)])), AnalysisInputError);
  }
  const invalids: Partial<EvidenceRecord>[] = [
    { from: "0x1234" as Address },
    { blockHash: "0xwrong" as Hash },
    { transactionHash: "0xwrong" as Hash },
    { timestamp: Number.NaN },
    { timestamp: -1 },
    { transactionIndex: 1.5 },
    { logIndex: -1 },
    { chainId: 1 as 8453 },
  ];
  for (const invalid of invalids) assert.throws(() => analyze(dataset([transfer(110, 20, POOL, A, "1", invalid)])), AnalysisInputError);
  assert.throws(() => analyzeInvestigation(dataset([]), { ...OPTIONS, generatedAt: "not-a-date" }), AnalysisInputError);
  assert.throws(() => analyzeInvestigation(dataset([]), { ...OPTIONS, generatedAt: "2026-02-30T00:00:00Z" }), AnalysisInputError);
});
