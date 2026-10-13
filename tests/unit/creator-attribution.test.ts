import assert from "node:assert/strict";
import test from "node:test";
import { deriveCreatorAttribution, validateCreationAnnotations } from "../../src/domain/investigations/creator-attribution";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import { deriveWalletSignals } from "../../src/domain/investigations/wallet-signals";
import { deriveSupplementalReportFacts } from "../../src/domain/investigations/report-facts";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { goPlusTokenUrl } from "../../src/domain/investigations/token-security";
import type { EvidenceRecord, ExplainedInvestigationReport } from "../../src/domain/investigations/types";
import { createInvestigatorContext } from "../../src/agents/context";
import { readLocalAiConfiguration } from "../../src/agents/config";
import { createChatContext, verifyChatContext } from "../../src/agents/chat-context";
import { askInvestigationQuestion, InvestigationQuestionError } from "../../src/agents/questions";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";
import { buildWalletDisplayFacts } from "../../src/components/investigation-wallet-facts";

const zero = `0x${"0".repeat(40)}` as const;
const secret = "synthetic-creator-proof-signing-secret-1234567890";
const config = readLocalAiConfiguration({ LOCAL_AI_MODEL: "synthetic-creator-model" });
function fixture(): ExplainedInvestigationReport {
  const value = getBrowserReportFixture();
  const mint: EvidenceRecord = { id: "synthetic-direct-deployment", kind: "transfer", chainId: 8453, blockNumber: value.range.from.number, blockHash: value.range.from.hash,
    transactionHash: `0x${"a".repeat(64)}`, transactionIndex: 0, logIndex: 0, traceId: null, timestamp: value.range.from.timestamp,
    from: zero, to: browserFixture.walletB, assetAddress: value.token.address, amountRaw: "100", sale: null,
    provenance: { provider: "Synthetic Base RPC fixture", method: "fabricated transaction+receipt direct deployment proof", observedAt: value.generatedAt },
    creation: { creator: browserFixture.walletA, contractAddress: value.token.address, transactionTo: null, receiptStatus: "0x1" } };
  value.evidence.push(mint);
  value.explanation.context.omittedEvidence++;
  return value;
}
function reported(value: ExplainedInvestigationReport, address = browserFixture.walletB) {
  value.token.securitySnapshot = { source: "goplus", status: "reported", checkedAt: value.generatedAt, sourceUrl: goPlusTokenUrl(value.token.address), tokenAddress: value.token.address,
    chainId: 8453, holderCount: null, creatorAddress: address, checks: [] };
}
function pinned(value: ExplainedInvestigationReport, creatorBalance: string | null) {
  value.token.totalSupplyRaw = "1000";
  const rows = value.wallets.map((wallet) => ({ address: wallet.address, balanceRaw: wallet.address === browserFixture.walletA ? creatorBalance : "0", status: wallet.address === browserFixture.walletA && creatorBalance === null ? "not_examined" as const : "verified" as const, discoveredBy: "observed" as const }));
  value.wallets.forEach((wallet) => { wallet.balanceRaw = rows.find((row) => row.address === wallet.address)!.balanceRaw; });
  value.holderSnapshot = { chainId: 8453, tokenAddress: value.token.address, block: { ...value.range.to }, totalSupplyRaw: "1000",
    holders: rows, discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${value.token.address}/holders`, observedAt: value.generatedAt, status: "unavailable", pages: 0, addresses: 0, finalizedCensus: false, reason: "Synthetic fixture" },
    balances: { status: creatorBalance === null ? "partial" : "complete", requestedWallets: rows.length, verifiedWallets: rows.filter((row) => row.status === "verified").length, reason: "Synthetic pinned reads" },
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: value.generatedAt } };
  return validateExplainedReport(value);
}

test("successful direct deployment attribution uses transaction sender rather than mint recipient and preserves proof", () => {
  const value = validateExplainedReport(fixture()); const before = structuredClone(value);
  const creator = deriveCreatorAttribution(value)!;
  assert.equal(creator.address, browserFixture.walletA); assert.notEqual(creator.address, value.evidence.at(-1)!.to);
  assert.equal(creator.kind, "direct-contract-creation"); assert.equal(creator.source, "Base RPC");
  assert.deepEqual(creator.evidenceIds, ["synthetic-direct-deployment"]); assert.match(creator.sourceUrl, /basescan\.org\/tx\/0x/);
  assert.match(creator.basis, /not developer identity/); assert.deepEqual(value, before);
  const signals = deriveWalletSignals(value);
  assert.ok(signals.wallets.find((row) => row.address === creator.address)!.labels.includes("creator"));
  assert.equal(signals.wallets.find((row) => row.address === browserFixture.walletB)!.labels.includes("creator"), false);
  assert.deepEqual(signals.wallets.find((row) => row.address === creator.address)!.flags.find((flag) => flag.label === "creator")!.evidenceIds, creator.evidenceIds);
  const badge = buildWalletDisplayFacts(value).get(creator.address)!.flags.find((flag) => flag.id === "creator")!;
  assert.equal(badge.label, "Creator"); assert.deepEqual(badge.evidenceIds, creator.evidenceIds); assert.equal(badge.sourceUrl, creator.sourceUrl);
  assert.doesNotMatch(badge.basis, /GoPlus/);
});

test("direct chain attribution takes precedence and discloses conflicting source-reported creator", () => {
  const value = fixture(); reported(value);
  const creator = deriveCreatorAttribution(value)!;
  assert.equal(creator.address, browserFixture.walletA); assert.equal(creator.conflictingReportedCreator, browserFixture.walletB);
  assert.match(creator.basis, /GoPlus separately reports/);
  delete value.evidence.at(-1)!.creation;
  assert.equal(deriveCreatorAttribution(value)!.address, browserFixture.walletB);
  assert.equal(deriveCreatorAttribution(value)!.kind, "source-reported");
  assert.deepEqual(deriveCreatorAttribution(value)!.evidenceIds, []);
  const legacy = buildWalletDisplayFacts(value).get(browserFixture.walletB)!.flags.find((flag) => flag.id === "source-reported-creator")!;
  assert.equal(legacy.label, "Creator · source-reported"); assert.deepEqual(legacy.evidenceIds, []); assert.equal(legacy.sourceUrl, goPlusTokenUrl(value.token.address));
  delete value.token.securitySnapshot; assert.equal(deriveCreatorAttribution(value), null);
});

test("wrong contract, non-mint, failed/non-direct, zero and future annotations fail analyzer and shared report boundary", () => {
  const mutations: ((event: EvidenceRecord, value: ExplainedInvestigationReport) => void)[] = [
    (event) => { event.creation!.contractAddress = browserFixture.walletB; },
    (event) => { event.from = browserFixture.walletA; },
    (event) => { event.assetAddress = browserFixture.walletB; },
    (event) => { event.kind = "funding"; event.assetAddress = null; },
    (event) => { event.amountRaw = "0"; },
    (event) => { event.creation!.creator = zero; },
    (event) => { event.to = zero; },
    (event) => { event.creation = { ...event.creation!, transactionTo: browserFixture.token } as unknown as EvidenceRecord["creation"]; },
    (event) => { event.creation = { ...event.creation!, receiptStatus: "0x0" } as unknown as EvidenceRecord["creation"]; },
    (event, value) => { event.blockNumber = (BigInt(value.range.to.number) + 1n).toString(); },
    (event, value) => { event.timestamp = value.range.to.timestamp + 1; },
    (event) => { event.blockHash = `0x${"b".repeat(64)}`; },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value.evidence.at(-1)!, value);
    assert.throws(() => validateExplainedReport(value)); assert.throws(() => deriveCreatorAttribution(value));
    assert.throws(() => analyzeInvestigation({ token: value.token, range: value.range, evidence: value.evidence, pools: value.infrastructure?.pools ?? [], hubs: [], coverage: value.coverage }, { id: value.id, generatedAt: value.generatedAt }));
  }
});

test("cross-event transaction identity and conflicting deployment creators/transactions reject", () => {
  for (const mutate of [(event: EvidenceRecord) => { event.transactionIndex++; }, (event: EvidenceRecord) => { event.timestamp++; }, (event: EvidenceRecord) => { event.blockHash = `0x${"b".repeat(64)}`; }]) {
    const value = fixture(); const repeated = { ...structuredClone(value.evidence.at(-1)!), id: "same-receipt-other-log", logIndex: 1 }; delete repeated.creation; mutate(repeated); value.evidence.push(repeated);
    assert.throws(() => validateCreationAnnotations(value)); assert.throws(() => validateExplainedReport(value));
  }
  for (const mutate of [(event: EvidenceRecord) => { event.creation!.creator = browserFixture.walletB; }, (event: EvidenceRecord) => { event.transactionHash = `0x${"c".repeat(64)}`; event.transactionIndex++; }]) {
    const value = fixture(); const repeated = { ...structuredClone(value.evidence.at(-1)!), id: "conflicting-creation", logIndex: 1 }; mutate(repeated); value.evidence.push(repeated);
    assert.throws(() => deriveCreatorAttribution(value));
  }
});

test("analyzer preserves and canonicalizes deployment proof while older reports stay compatible", () => {
  const value = fixture();
  const report = analyzeInvestigation({ token: value.token, range: value.range, evidence: value.evidence, pools: value.infrastructure?.pools ?? [], hubs: [], coverage: value.coverage }, { id: value.id, generatedAt: value.generatedAt });
  const creator = deriveCreatorAttribution(report)!;
  assert.ok(creator.evidenceIds[0].startsWith("8453:")); assert.deepEqual(report.evidence.find((event) => event.creation)!.creation, value.evidence.at(-1)!.creation);
  assert.doesNotThrow(() => validateExplainedReport(getBrowserReportFixture()));
});

test("supplemental creator facts and assessment use chain attribution and exact pinned zero versus unknown holdings", () => {
  const held = pinned(fixture(), "200"); reported(held);
  const facts = deriveSupplementalReportFacts(held);
  assert.equal(facts.creator?.address, browserFixture.walletA); assert.equal(facts.creator?.attribution.source, "Base RPC"); assert.equal(facts.creator?.holding?.balanceRaw, "200");
  const assessed = assessInvestigationReport(held);
  assert.equal(assessed.metrics.creatorSharePercent, "20.00"); assert.deepEqual(assessed.triggeredRules.find((rule) => rule.id === "creator-holding")?.evidenceIds, ["synthetic-direct-deployment"]);
  assert.equal(assessInvestigationReport(pinned(fixture(), "0")).metrics.creatorSharePercent, "0.00");
  assert.equal(assessInvestigationReport(pinned(fixture(), null)).metrics.creatorSharePercent, null);
  assert.equal(assessInvestigationReport(pinned(fixture(), "0")).gates.some((gate) => gate.id === "creator-holding"), false);
});

test("compact context and signed chat retain receipt-backed creator roles and require the exact deployment citation", async () => {
  const value = fixture(); const context = createInvestigatorContext(value, config);
  const data = JSON.parse(context.json); const creation = data.sourceFacts.find((fact: { creation?: unknown }) => fact.creation);
  assert.ok(creation); assert.equal(creation.from, "ZERO_ADDRESS"); assert.equal(context.roleAddresses.get(creation.creation.creator), browserFixture.walletA);
  assert.notEqual(creation.creation.creator, creation.to, "mint recipient is not the deploying address");
  const capsule = createChatContext(value, config, secret); const verified = verifyChatContext(capsule, config, secret);
  let calls = 0;
  const answer = await askInvestigationQuestion("Who deployed this token?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++; const prompt = JSON.parse(String(init?.body)); const facts = JSON.parse(prompt.messages[1].content).authenticatedScanFacts;
    const deployment = facts.sourceFacts.find((fact: { creation?: unknown }) => fact.creation);
    return new Response(JSON.stringify({ done: true, message: { role: "assistant", content: JSON.stringify({ answer: `${deployment.creation.creator} sent the successful direct deployment transaction for this token.`, caveat: "This establishes the deploying address, not developer identity or present control.", evidenceIds: [deployment.ref], needsFreshScan: false }) } }), { headers: { "content-type": "application/json" } });
  } });
  assert.equal(calls, 1); assert.match(answer.answer, /0x0000…000a/); assert.deepEqual(answer.evidenceIds, ["synthetic-direct-deployment"]);
  const alias = verified.citations.find((citation) => citation.id === "synthetic-direct-deployment")!.alias;
  await assert.rejects(askInvestigationQuestion("Who deployed this token?", capsule, config, secret, { fetch: async () => new Response(JSON.stringify({ done: true, message: { role: "assistant", content: JSON.stringify({ answer: "The direct deployment sender is shown in the report.", caveat: "Identity is unknown.", evidenceIds: [alias === "E1" ? "E2" : "E1"], needsFreshScan: false }) } }), { headers: { "content-type": "application/json" } }) }), (error: unknown) => error instanceof InvestigationQuestionError && error.code === "INVALID_CITATION");
});
