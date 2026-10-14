import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { ExplanationValidationError, validateInvestigationExplanation } from "../../src/domain/investigations/explanation";
import type { Address, EvidenceRecord, Hash, InvestigationDataset } from "../../src/domain/investigations/types";
import { readInvestigatorAiConfiguration, readLocalAiConfiguration, validateLocalAiConfiguration } from "../../src/agents/config";
import { compactMainReviewJson, createInvestigatorContext } from "../../src/agents/context";
import { LocalAiError, runLocalInvestigatorWithConfig } from "../../src/agents/ollama-core";
import { investigatorModelfile, INVESTIGATOR_BASE_MODEL } from "../../src/agents/model-definition";
import { canonicalFindingClaim } from "../../src/domain/investigations/explanation-grounding";
import { buildPlainLanguagePacket, plainLanguageDecisionContext } from "../../src/domain/investigations/plain-language-summary";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";
import { getBrowserSwarmSummaryFixture } from "../fixtures/swarm-report";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { createChatContext, verifyChatContext } from "../../src/agents/chat-context";
import { derivePrimaryAssessment } from "../../src/domain/investigations/primary-assessment";

const address = (number: number) => `0x${number.toString(16).padStart(40, "0")}` as Address;
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}` as Hash;
const token = address(1), first = address(2), second = address(3), pool = address(10), quote = address(11);
const configured = (extra: Record<string, string | undefined> = {}) => readLocalAiConfiguration({ LOCAL_AI_MODEL: "fixture-model:local", ...extra });
function event(block: number, tx: number, from: Address, to: Address, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { id: `fixture-${tx}-${extra.logIndex ?? 0}`, kind: "transfer", chainId: 8453, blockNumber: String(block), blockHash: hash(block), transactionHash: hash(tx), transactionIndex: tx, logIndex: 0, traceId: null, timestamp: block * 10, from, to, assetAddress: token, amountRaw: "100", provenance: { provider: "synthetic unit fixture", method: "fixture", observedAt: "2026-10-12T00:00:00.000Z" }, sale: null, ...extra };
}
function sale(block: number, tx: number, wallet: Address) {
  const out = event(block, tx, wallet, pool, { amountRaw: "50" });
  const incoming = event(block, tx, pool, wallet, { assetAddress: quote, amountRaw: "25", logIndex: 1 });
  return [out, incoming, event(block, tx, wallet, pool, { id: `sale-${tx}`, kind: "sale", amountRaw: "50", logIndex: 2, sale: { pool, factory: address(12), protocol: "uniswap-v3", quoteAsset: quote, quoteAmountRaw: "25", swapLogIndex: 2, supportingEvidenceIds: [out.id, incoming.id] } })];
}
function dataset(evidence: EvidenceRecord[], transfers: "complete" | "partial" = "complete"): InvestigationDataset {
  return { token: { address: token, chainId: 8453, name: "Synthetic Fixture", symbol: "FIX", decimals: 18, totalSupplyRaw: null }, range: { from: { number: "100", hash: hash(100), timestamp: 1000 }, to: { number: "400", hash: hash(400), timestamp: 4000 }, finality: "finalized" }, evidence, pools: [pool], hubs: [], coverage: { transfers, funding: [first, second].map((wallet) => ({ wallet, status: "unavailable", fromBlock: "100", toBlock: "400", internalTransfers: "not_examined", reason: "Synthetic fixture has no funding integration." })), eligibleWallets: 2, examinedWallets: 0, warnings: [] } };
}
const analyze = (value: InvestigationDataset) => analyzeInvestigation(value, { id: "local-ai-fixture", generatedAt: "2026-10-12T00:00:00.000Z" });
const report = (coverage: "complete" | "partial" = "complete") => analyze(dataset([event(110, 1, address(0), first, { amountRaw: (2n ** 200n).toString() }), event(120, 2, first, second, { amountRaw: "70" })], coverage));
function mixedReport(extra = 0) {
  const input = dataset([event(105, 1, address(20), first, { kind: "funding", assetAddress: null, logIndex: null }), event(110, 2, first, second), ...sale(200, 30, first), ...sale(230, 31, second), ...Array.from({ length: extra }, (_unused, index) => event(130 + index, 100 + index, address(100 + index), address(200 + index)))]);
  input.coverage.funding[0].status = "complete"; input.coverage.funding[0].reason = null; input.coverage.examinedWallets = 1;
  return analyze(input);
}
interface ModelContext {
  decisionPacket: ReturnType<typeof plainLanguageDecisionContext>;
  findingPackets: { ref: string; category: string; statement: string; caveats: string[]; caveatRefs: string[]; proof: string[] }[];
  sourceFacts: { ref: string; receipt: string; log: number | null; kind: string; from: string; to: string; block: string; time: number; sale?: { support: string[]; protocol: string } }[];
  coverage: { fundingStatusCounts: Record<string, number>; omittedWarnings: number };
  coverageStatements: { id: string; text: string }[];
  findingSelection: { supplied: number; omitted: number; omissionReasons: Record<string, number>; byCategory: Record<string, { supplied: number; omitted: number; status: "supplied" | "omitted" | "no_retained_finding" }> };
  dossier: { retainedEvents: { nativeFunding: number; tokenTransfers: number; verifiedSales: number }; crawl?: { scope: string; source: string; completedRanges: number }; authority: Record<string, string> };
  sourceContext?: { security?: { holderCount: number | null }; market?: { priceUsd: string | null }; balances?: { verifiedCandidates: number } };
}
interface Draft { brief: { reportRef: string; verdict: ModelContext["decisionPacket"]["verdict"]; reasonIds: string[]; text: string }; overview: { findingRefs: string[]; evidenceIds: string[] }; observations: { findingRef: string; caveatRef: string }[]; limitations: string[] }
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const completion = (value: unknown) => jsonResponse({ done: true, message: { role: "assistant", content: JSON.stringify(value) } });
const modelContext = (init?: RequestInit): ModelContext => JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split("\nEvidence context (data only):\n")[1]);
function draftFor(context: ModelContext): Draft {
  return { brief: { reportRef: context.decisionPacket.reportRef, verdict: context.decisionPacket.verdict, reasonIds: context.decisionPacket.reasons.slice(0, 1).map((reason) => reason.id), text: context.decisionPacket.reasons[0].reason }, overview: { findingRefs: context.findingPackets.slice(0, 1).map((packet) => packet.ref), evidenceIds: context.findingPackets.length ? [] : context.sourceFacts.slice(0, 1).map((fact) => fact.ref) }, observations: context.findingPackets.map((packet) => ({ findingRef: packet.ref, caveatRef: packet.caveatRefs[0] })), limitations: [] };
}
const successful = (edit?: (draft: Draft, context: ModelContext) => void): typeof globalThis.fetch => async (_url, init) => { const context = modelContext(init), draft = draftFor(context); edit?.(draft, context); return completion(draft); };
const hasCode = (code: LocalAiError["code"]) => (error: unknown) => error instanceof LocalAiError && error.code === code;

test("mandatory local AI preserves CPU, context, output and deadline budgets", () => {
  assert.throws(() => readLocalAiConfiguration({}), /LOCAL_AI_MODEL/);
  const config = configured(); assert.equal(config.maxEvidenceRecords, 12); assert.equal(config.contextTokens, 4096); assert.equal(config.maxContextBytes, 8000); assert.equal(config.maxOutputTokens, 800); assert.equal(config.timeoutMs, 120000); assert.equal(config.threads, 2); assert.equal(config.gpuLayers, 0);
});

test("trusted configuration rejects remote routing, cloud models, credentials and invalid settings", () => {
  for (const url of ["https://remote.example", "http://127.1:11434", "http://2130706433:11434", "http://127.0.0.1.evil.example", "http://localhost:11434/api", "http://localhost:11434?key=secret", "http://user:pass@localhost:11434", "http://localhost:11434/#fragment", "file:///tmp/model", "http://[::ffff:127.0.0.1]:11434"]) assert.throws(() => configured({ LOCAL_AI_BASE_URL: url }), /LOCAL_AI_BASE_URL/);
  assert.equal(configured({ LOCAL_AI_BASE_URL: "https://localhost:11434/" }).baseUrl, "https://127.0.0.1:11434"); assert.equal(configured({ LOCAL_AI_BASE_URL: "http://[::1]:11434" }).baseUrl, "http://[::1]:11434");
  for (const model of ["", "model:120b-cloud", "model:cloud", "model\nkey", "../model", "https://model.example"]) assert.throws(() => configured({ LOCAL_AI_MODEL: model }), /LOCAL_AI_MODEL/);
  for (const setting of [{ LOCAL_AI_TIMEOUT_MS: "0" }, { LOCAL_AI_MAX_RESPONSE_BYTES: "262145" }, { LOCAL_AI_MAX_EVIDENCE_RECORDS: "201" }, { LOCAL_AI_MAX_OUTPUT_TOKENS: "-1" }]) assert.throws(() => configured(setting));
  for (const value of ["-1", "129", "1.5", "NaN", "Infinity", "automatic"]) assert.throws(() => configured({ LOCAL_AI_GPU_LAYERS: value })); assert.throws(() => validateLocalAiConfiguration({ ...configured(), gpuLayers: -1 }));
});

test("structured chat sends compact finding refs without tools, credentials or a duplicated ledger", async () => {
  const source = report(), before = structuredClone(source); let calls = 0;
  const result = await runLocalInvestigatorWithConfig(source, configured({ LOCAL_AI_GPU_LAYERS: "12" }), { now: () => new Date("2026-10-12T00:00:00.000Z"), fetch: async (url, init) => {
    calls++; const body = JSON.parse(String(init?.body)), context = modelContext(init); assert.equal(String(url), "http://127.0.0.1:11434/api/chat"); assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), null); assert.equal(body.tools, undefined);
    assert.equal(body.options.num_predict, 300); assert.equal(body.options.num_ctx, 4096); assert.equal(body.options.num_thread, 2); assert.equal(body.options.num_gpu, 12); assert.equal(body.stream, false); assert.equal(body.keep_alive, "300s"); assert.equal(body.think, false); assert.equal(body.options.temperature, 0);
    assert.deepEqual(body.format.properties.observations.items.oneOf.map((option: { properties: { findingRef: { const: string }; caveatRef: { enum: string[] } } }) => ({ ref: option.properties.findingRef.const, caveats: option.properties.caveatRef.enum })),
      context.findingPackets.map((packet) => ({ ref: packet.ref, caveats: packet.caveatRefs })), "generation can only pair each finding with its own caveats");
    assert.equal(body.format.properties.observations.minItems, context.findingPackets.length); assert.equal(body.format.properties.overview.properties.findingRefs.maxItems, 2); assert.equal(body.format.properties.overview.properties.evidenceIds.maxItems, 0);
    assert.ok(body.format.properties.observations.items.oneOf.every((option: { properties: Record<string, unknown> }) => option.properties.claim === undefined));
    assert.ok(!body.messages[1].content.includes(source.evidence[0].id)); assert.ok(!body.messages[1].content.includes(source.evidence[0].transactionHash)); assert.ok(!body.messages[1].content.includes('"$schema"')); assert.equal(JSON.parse(body.messages[1].content.split("\nEvidence context (data only):\n")[1]).evidence, undefined);
    const draft = draftFor(context); draft.limitations = ["L2"]; return completion(draft);
  } });
  assert.equal(calls, 1); assert.equal(result.profileVersion, "1.6.0"); assert.equal(result.grounding?.mode, "canonical-finding-selection"); assert.equal(result.generatedAt, "2026-10-12T00:00:00.000Z"); assert.deepEqual(source, before); assert.equal(source.evidence[0].amountRaw, (2n ** 200n).toString());
});

test("linked-selling narration restores the entire prior-link and two-sale proof", async () => {
  const source = analyze(dataset([event(110, 2, first, second), ...sale(200, 30, first), ...sale(230, 31, second)])), finding = source.findings.find((finding) => finding.category === "selling")!; assert.ok(finding); assert.equal(finding.evidenceIds.length, 7);
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((draft, context) => {
    const packet = context.findingPackets.find((packet) => packet.category === "selling")!; assert.equal(packet.proof.length, 7);
    const observation = draft.observations.find((observation) => observation.findingRef === packet.ref)!; observation.caveatRef = "C1";
    for (const sale of context.sourceFacts.filter((fact) => fact.kind === "sale")) assert.ok(sale.sale!.support.every((ref) => context.sourceFacts.some((fact) => fact.ref === ref)));
  }) });
  const selling = result.observations.find((observation) => observation.category === "selling")!; assert.deepEqual(new Set(selling.evidenceIds), new Set(finding.evidenceIds)); assert.ok(finding.evidenceIds.every((id) => result.context.evidenceIds.includes(id) && result.overview.evidenceIds.includes(id)));
});

test("category diversity prevents generic connections from crowding out the other goals", async () => {
  const source = mixedReport(12), before = structuredClone(source), selected = createInvestigatorContext(source, configured()); assert.deepEqual(selected, createInvestigatorContext(source, configured()));
  assert.deepEqual(selected.packets.map((packet) => packet.category), ["selling", "funding", "accumulation", "connections"]); assert.ok(selected.context.evidence.length <= 12); assert.ok(Buffer.byteLength(selected.json, "utf8") <= 8000);
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() }); assert.deepEqual(result.observations.map((observation) => observation.category), ["selling", "funding", "accumulation", "connections"]); assert.ok(result.limitations.some((limit) => limit.includes("Finding packets supplied: 4 of") && limit.includes("by category diversity"))); assert.deepEqual(source, before);
});

test("joint whole-proof retrieval covers all four goals when the smallest selling proof would crowd one out", () => {
  const third = address(4), fourth = address(5), funder = address(20);
  const input = dataset([
    event(105, 1, funder, third, { kind: "funding", assetAddress: null, logIndex: null }),
    event(106, 2, funder, fourth, { kind: "funding", assetAddress: null, logIndex: null }),
    event(110, 3, first, second), event(111, 4, pool, third),
    ...sale(200, 30, first), ...sale(230, 31, second), ...sale(250, 32, third), ...sale(280, 33, fourth),
  ]);
  input.coverage.funding = [first, second, third, fourth].map((wallet) => ({ wallet, status: "complete", fromBlock: "100", toBlock: "400", internalTransfers: "not_examined", reason: null }));
  input.coverage.eligibleWallets = 4; input.coverage.examinedWallets = 4;
  const source = analyze(input);
  // Retain genuine canonical candidates: two independently supported selling
  // groups, the shared funder, this early recipient and its connected group.
  source.findings = source.findings.filter((finding) => finding.category === "selling"
    || finding.rule.name === "shared-observed-native-source"
    || finding.category === "accumulation" && finding.wallets.includes(third)
    || finding.rule.name === "evidence-linked-component" && finding.wallets.includes(third));
  assert.deepEqual(source.findings.filter((finding) => finding.category === "selling").map((finding) => finding.evidenceIds.length).sort(), [7, 8]);
  const before = structuredClone(source), selected = createInvestigatorContext(source, configured({ LOCAL_AI_MAX_EVIDENCE_RECORDS: "9" }));
  assert.deepEqual(selected.packets.map((packet) => packet.category), ["selling", "funding", "accumulation", "connections"]);
  assert.equal(selected.context.evidence.length, 9);
  const chosenSale = [...selected.findingRefs.values()].find((finding) => finding.category === "selling")!;
  assert.equal(chosenSale.evidenceIds.length, 8, "the larger overlapping proof leaves capacity for every perspective");
  for (const finding of selected.findingRefs.values()) assert.ok(finding.evidenceIds.every((id) => selected.context.evidence.some((record) => record.id === id)));
  assert.ok(Buffer.byteLength(selected.json, "utf8") <= 8000);
  assert.deepEqual(source, before);
  const reordered = structuredClone(source); reordered.findings.reverse();
  assert.deepEqual(createInvestigatorContext(reordered, configured({ LOCAL_AI_MAX_EVIDENCE_RECORDS: "9" })), selected);
});

test("receipt aliases distinguish same-block transactions and keep every sale's support in its original receipt", () => {
  const source = analyze(dataset([event(110, 2, first, second), ...sale(200, 30, first), ...sale(200, 31, second)]));
  const context: ModelContext = JSON.parse(createInvestigatorContext(source, configured()).json);
  const sales = context.sourceFacts.filter((record) => record.kind === "sale");
  assert.equal(sales.length, 2);
  assert.equal(sales[0].block, sales[1].block);
  assert.equal(sales[0].time, sales[1].time);
  assert.notEqual(sales[0].receipt, sales[1].receipt, "same block/time does not identify the same transaction");
  for (const sale of sales) for (const support of sale.sale!.support) assert.equal(context.sourceFacts.find((record) => record.ref === support)?.receipt, sale.receipt);
  assert.ok(context.sourceFacts.every((record) => /^T[1-9][0-9]*$/.test(record.receipt)));
  assert.ok(!JSON.stringify(context).includes(source.evidence[0].transactionHash));
});

test("the bounded dossier separates source-reported context from chain evidence without manufacturing corroboration", () => {
  const source = mixedReport(), checkedAt = source.generatedAt;
  source.token.securitySnapshot = { source: "goplus", status: "reported", tokenAddress: token, chainId: 8453, checkedAt, sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${token}`, holderCount: 13, creatorAddress: null, checks: [{ id: "is_honeypot", value: "unknown" }] };
  source.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt, sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${token}`, pairAddress: pool, priceUsd: "0.000000000000000000123", liquidityUsd: null, marketCapUsd: null, volume24hUsd: null, priceChange24hPercent: null, pairCreatedAt: null };
  source.coverage.transferCrawl = { scope: "window", source: "alchemy-transfers", completedRanges: [{ fromBlock: "100", toBlock: "400" }] };
  const before = structuredClone(source), selected = createInvestigatorContext(source, configured()), context: ModelContext = JSON.parse(selected.json);
  assert.equal(context.sourceContext?.security?.holderCount, 13);
  assert.equal(context.sourceContext?.market?.priceUsd, source.token.marketSnapshot.priceUsd);
  assert.match(context.dossier.authority.security, /source-reported/);
  assert.match(context.dossier.authority.market, /not pinned chain evidence/);
  assert.match(context.dossier.authority.agreement, /do not establish independent corroboration/);
  assert.deepEqual(context.dossier.crawl, { scope: "window", source: "alchemy-transfers", completedRanges: 1 });
  assert.deepEqual(context.dossier.retainedEvents, { nativeFunding: 1, tokenTransfers: 3, verifiedSales: 2 });
  assert.equal(selected.packets.length, 4, "authority context must still leave default capacity for all four goals");
  assert.ok(Buffer.byteLength(selected.json, "utf8") <= 8000);
  const reduced = createInvestigatorContext(source, configured({ LOCAL_AI_MAX_CONTEXT_BYTES: "4096" })), reducedContext: ModelContext = JSON.parse(reduced.json);
  assert.ok(Buffer.byteLength(reduced.json, "utf8") <= 4096);
  assert.deepEqual(reducedContext.sourceContext, context.sourceContext, "a smaller budget must not erase source authority to fit a finding");
  assert.deepEqual(reducedContext.dossier, context.dossier);
  assert.ok(reduced.findingSelection.omissionReasons.context_limit > 0);
  assert.equal(reducedContext.findingSelection.byCategory.selling.status, "omitted");
  assert.deepEqual(source, before);
});

test("main-review latency compaction preserves every selected proof and separates short aliases from final report identity", () => {
  const source = getBrowserWalletFlagsFixture({ contractDominated: true });
  const selected = createInvestigatorContext(source, configured()), full = JSON.parse(selected.json);
  const compactJson = compactMainReviewJson(selected.json), compact = JSON.parse(compactJson);
  for (const field of ["sourceFacts", "findingPackets", "coverageStatements", "selection", "findingSelection", "decisionPacket"]) assert.deepEqual(compact[field], full[field], `${field} must not be trimmed to improve latency`);
  assert.deepEqual(compact.coverage.fundingStatusCounts, full.coverage.fundingStatusCounts);
  assert.equal(compact.sourceContext, undefined, "redundant metadata must not introduce independent denominations into the main decision summary");
  assert.equal(Object.keys(compact).at(-1), "decisionPacket", "one unchanged decision packet follows the selected proof facts");
  assert.deepEqual(JSON.parse(selected.json), full, "main compaction must not mutate full context");
  assert.match(compact.dossier.authority.walletTable, /not a census or ownership proof/);
  assert.ok(Buffer.byteLength(compactJson) < Buffer.byteLength(selected.json) - 400);
  assert.equal(compact.decisionPacket.reportRef, "R1");
  assert.deepEqual(compact.decisionPacket.reasons.map((reason: { id: string }, index: number) => reason.id === `D${index + 1}`), compact.decisionPacket.reasons.map(() => true));
  assert.ok(!compactJson.includes(source.range.to.hash));
  assert.ok(!compactJson.includes(source.token.address));
  assert.equal(buildPlainLanguagePacket(source).reportRef.includes(source.range.to.hash), true, "complete final source binding remains intact outside model input");
});

test("main compaction removes independent float definitions while signed chat retains its full source context", () => {
  const source = getBrowserSwarmSummaryFixture(), config = configured({ LOCAL_AI_MODEL: source.explanation.model });
  const selected = createInvestigatorContext(source, config), full = JSON.parse(selected.json), compactJson = compactMainReviewJson(selected.json);
  assert.ok(full.sourceContext.walletTable.definition.includes("contract"));
  assert.equal(JSON.parse(compactJson).sourceContext, undefined);
  assert.equal(compactJson.includes(full.sourceContext.walletTable.definition), false);
  const secret = "synthetic-compaction-test-secret-1234567890";
  const signed = verifyChatContext(createChatContext(source, config, secret), config, secret), chat = JSON.parse(signed.data);
  assert.equal(chat.decisionPacket, undefined, "the main decision packet is not added to signed chat evidence bytes");
  assert.equal(chat.sourceContext.walletTable.definition, full.sourceContext.walletTable.definition);
  assert.equal(chat.sourceContext.walletTable.holdingDenominatorRaw, full.sourceContext.walletTable.holdingDenominatorRaw);
  assert.equal(chat.sourceContext.walletTable.contractSupplySharePercent, full.sourceContext.walletTable.contractSupplySharePercent);
  assert.ok(chat.sourceFacts.length > 0);
});

test("dossier categories distinguish omitted findings from no retained finding under the existing small-context budget", () => {
  const source = mixedReport(), small = createInvestigatorContext(source, configured({ LOCAL_AI_MAX_EVIDENCE_RECORDS: "6", LOCAL_AI_MAX_CONTEXT_BYTES: "4096" }));
  const context: ModelContext = JSON.parse(small.json);
  assert.equal(context.findingSelection.byCategory.selling.status, "omitted");
  assert.ok(context.findingSelection.byCategory.selling.omitted > 0);
  assert.ok(Buffer.byteLength(small.json, "utf8") <= 4096);
  source.findings = [];
  const noFindings: ModelContext = JSON.parse(createInvestigatorContext(source, configured()).json);
  assert.ok(Object.values(noFindings.findingSelection.byCategory).every((category) => category.status === "no_retained_finding"));
  assert.match(noFindings.dossier.authority.sourceFacts, /never prove absent activity/);
  assert.equal(noFindings.dossier.retainedEvents.verifiedSales, 2, "omitted finding packets must not erase observed events");
});

test("malformed fullcrawl coverage cannot gain authority by entering the model dossier", () => {
  const source = mixedReport();
  source.coverage.transferCrawl = { scope: "full", source: "rpc-logs", completedRanges: [{ fromBlock: "100", toBlock: "400" }] };
  assert.throws(() => createInvestigatorContext(source, configured()), /INVALID_CONTEXT/);
});

test("evidence and context caps omit findings atomically with explicit reasons", async () => {
  const source = mixedReport(), config = configured({ LOCAL_AI_MAX_EVIDENCE_RECORDS: "6" }), selected = createInvestigatorContext(source, config); assert.ok(!selected.packets.some((packet) => packet.category === "selling")); assert.ok(!selected.context.evidence.some((record) => record.kind === "sale")); assert.ok(selected.findingSelection.omissionReasons.evidence_limit > 0);
  const result = await runLocalInvestigatorWithConfig(source, config, { fetch: successful() }); assert.ok(!result.observations.some((observation) => observation.category === "selling")); assert.ok(result.limitations.some((limit) => /[1-9][0-9]* by evidence cap/.test(limit)));
  source.findings.find((finding) => finding.category === "selling")!.limitations = Array.from({ length: 10 }, (_unused, index) => `${index}: ${"bounded qualification ".repeat(22)}`);
  const bounded = createInvestigatorContext(source, configured({ LOCAL_AI_MAX_CONTEXT_BYTES: "4096" })); assert.ok(!bounded.packets.some((packet) => packet.category === "selling")); assert.ok(bounded.findingSelection.omissionReasons.context_limit > 0); assert.ok(Buffer.byteLength(bounded.json, "utf8") <= 4096);
});

test("reader-facing finding packets omit raw amounts and Unix timestamps while retaining qualifications", () => {
  const source = mixedReport(), before = structuredClone(source);
  const context: ModelContext = JSON.parse(createInvestigatorContext(source, configured()).json);
  const accumulation = context.findingPackets.find((packet) => packet.category === "accumulation")!;
  const funding = context.findingPackets.find((packet) => packet.category === "funding")!;
  assert.match(accumulation.statement, /positive net token inflow/);
  assert.match(accumulation.statement, /not a market-launch window or proof of purchases/);
  assert.doesNotMatch(accumulation.statement, /raw token units|starting at [0-9]+|ending at [0-9]+/);
  assert.match(funding.statement, /examined funding window/);
  assert.doesNotMatch(funding.statement, /funding blocks [0-9]+/);
  assert.deepEqual(source, before);
});

test("missing sale support and truncated finding proofs reject before inference", async () => {
  for (const broken of ["missing-record", "truncated-finding"] as const) {
    const source = mixedReport(), selling = source.findings.find((finding) => finding.category === "selling")!, support = source.evidence.find((record) => record.kind === "sale")!.sale!.supportingEvidenceIds[1];
    if (broken === "missing-record") source.evidence = source.evidence.filter((record) => record.id !== support); else selling.evidenceIds = selling.evidenceIds.filter((id) => id !== support);
    await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: async () => { throw new Error("Unexpected inference."); } }), hasCode("INVALID_CONTEXT"));
  }
});

test("unknown, duplicate and omitted finding refs cannot create or discard packet observations", async () => {
  for (const edit of [(draft: Draft) => { draft.observations[0].findingRef = "F999"; }, (draft: Draft) => { draft.observations[0].findingRef = "E1"; }, (draft: Draft) => { draft.observations[1].findingRef = draft.observations[0].findingRef; }]) await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: successful(edit) }), hasCode("INVALID_CITATION"));
  await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: successful((draft) => { draft.observations = []; }) }), hasCode("INVALID_RESPONSE"));
  const source = report("partial"), result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() }); assert.ok(!result.observations.some((observation) => observation.category === "accumulation")); const forged = structuredClone(result); forged.observations[0].category = "accumulation"; assert.throws(() => validateInvestigationExplanation(source, forged), (error: unknown) => error instanceof ExplanationValidationError && error.code === "INVALID_CITATION");
});

test("shared validator independently rejects partial selling citations", async () => {
  const source = mixedReport(), result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() }), forged = structuredClone(result); forged.observations.find((observation) => observation.category === "selling")!.evidenceIds.pop(); assert.throws(() => validateInvestigationExplanation(source, forged), (error: unknown) => error instanceof ExplanationValidationError && error.code === "INVALID_CITATION");
  const overview = structuredClone(result), support = source.evidence.find((record) => record.kind === "sale")!.sale!.supportingEvidenceIds[0]; overview.overview.evidenceIds = overview.overview.evidenceIds.filter((id) => id !== support); assert.throws(() => validateInvestigationExplanation(source, overview), (error: unknown) => error instanceof ExplanationValidationError && error.code === "INVALID_CITATION");
  const duplicate = structuredClone(result); duplicate.observations.push(duplicate.observations[0]); assert.throws(() => validateInvestigationExplanation(source, duplicate), (error: unknown) => error instanceof ExplanationValidationError && error.code === "INVALID_CITATION");
});

test("large complete findings are disclosed as citation-cap omissions without trimming support", () => {
  const source = analyze(dataset(Array.from({ length: 22 }, (_unused, index) => event(110 + index, index + 1, address(100 + index), address(101 + index)))));
  assert.ok(source.findings.some((finding) => finding.evidenceIds.length > 20));
  const selected = createInvestigatorContext(source, configured()); assert.ok(selected.findingSelection.omissionReasons.citation_limit > 0); assert.ok(selected.packets.every((packet) => packet.proof.length <= 20));
});

test("overview sales expand all proof citations when no finding packet fits", async () => {
  const source = analyze(dataset(sale(200, 30, first))); source.findings = source.findings.filter((finding) => finding.category === "coverage"); const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((draft, context) => { draft.overview.evidenceIds = [context.sourceFacts.find((fact) => fact.kind === "sale")!.ref]; }) }); assert.equal(result.observations.length, 0); assert.deepEqual(new Set(result.overview.evidenceIds), new Set(source.evidence.map((record) => record.id)));
});

test("canonical coverage preserves attribution and unavailable versus unexamined counts", async () => {
  const source = report("partial"), attribution = "Internal native transfers and exchange/bridge hub attribution are not examined.";
  source.coverage.funding = Array.from({ length: 92 }, (_unused, index) => ({ ...source.coverage.funding[0], wallet: address(index + 100), status: index < 3 ? "unavailable" : "not_examined" })); source.coverage.eligibleWallets = 92; source.coverage.examinedWallets = 3; source.coverage.warnings = [attribution];
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((draft, context) => { assert.deepEqual(context.coverage.fundingStatusCounts, { complete: 0, partial: 0, unavailable: 3, not_examined: 89 }); assert.deepEqual(context.coverageStatements[2], { id: "L3", text: attribution }); draft.limitations = ["L2", "L3"]; }) }); assert.ok(result.limitations.includes(attribution)); assert.ok(!result.limitations.some((limit) => limit.includes("bridge hub activity"))); assert.ok(result.overview.text.endsWith("Funding-history coverage: 0 complete, 0 partial, 3 unavailable, 89 not examined."));
  for (const limitations of [["L999"], ["L3", "L3"], ["Internal native transfers and bridge hub activity are not examined."], ["Funding-history coverage: 0 complete, 0 partial, 89 unavailable, 3 not examined."]]) await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((draft) => { draft.limitations = limitations; }) }), hasCode("INVALID_RESPONSE"));
});

test("eligible wallets missing a funding coverage row remain explicitly unexamined", async () => {
  const source = report("partial"); source.coverage.eligibleWallets = 3;
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((_draft, context) => {
    assert.deepEqual(context.coverage.fundingStatusCounts, { complete: 0, partial: 0, unavailable: 2, not_examined: 1 });
  }) });
  assert.ok(result.overview.text.endsWith("Funding-history coverage: 0 complete, 0 partial, 2 unavailable, 1 not examined."));
});

test("lean warnings preserve retrieval causes after redundant wallet lines", () => {
  const source = report("partial"), cause = "A token-transfer range could not be retrieved; transfer history is partial.", limits = [cause, "Internal native transfers were not examined.", "Current balances are unknown.", "Only the declared window was retrieved."]; source.coverage.warnings = [...Array.from({ length: 25 }, (_unused, index) => `Funding coverage for ${address(index + 100)} is not_examined.`), cause, cause, ...limits.slice(1), "x".repeat(501), "Another omitted limit."]; const context: ModelContext = JSON.parse(createInvestigatorContext(source, configured()).json); assert.deepEqual(context.coverageStatements.slice(2).map((statement) => statement.text), limits); assert.equal(context.coverage.omittedWarnings, source.coverage.warnings.length - 4);
});

test("model prose cannot enter the selector protocol, including the observed infrastructure error", async () => {
  for (const edit of [
    (draft: Draft) => { Object.assign(draft.observations[0], { claim: "Wallets are linked through shared infrastructure or transfers." }); },
    (draft: Draft) => { Object.assign(draft.observations[0], { caveat: "A0 ownership is unknown." }); },
    (draft: Draft) => { Object.assign(draft.overview, { text: "The wallets share infrastructure." }); },
  ]) await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: successful(edit) }), hasCode("INVALID_RESPONSE"));
});

test("genuine inference controls selection, ordering and an exact finding-local caveat", async () => {
  const source = mixedReport(), before = structuredClone(source); let calls = 0;
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    calls++; return successful((draft, context) => {
      draft.observations.reverse();
      const selected = draft.observations.find((observation) => context.findingPackets.find((packet) => packet.ref === observation.findingRef)!.category === "accumulation")!;
      selected.caveatRef = "C2"; draft.observations = [selected, ...draft.observations.filter((observation) => observation !== selected)];
      draft.overview.findingRefs = [draft.observations[0].findingRef];
    })(url, init);
  } });
  assert.equal(calls, 1); assert.equal(result.observations[0].category, "accumulation");
  const chosen = source.findings.find((finding) => finding.id === result.grounding!.observations[0].findingId)!;
  assert.equal(result.observations[0].claim, canonicalFindingClaim(chosen)); assert.equal(result.observations[0].caveat, chosen.limitations[1]);
  assert.deepEqual(result.grounding!.overviewFindingIds, [chosen.id]); assert.ok(result.overview.text.startsWith(canonicalFindingClaim(chosen))); assert.deepEqual(source, before);
});

test("one inference writes concise summary prose using selected authenticated reasons", async () => {
  const source = mixedReport(), packet = buildPlainLanguagePacket(source), before = structuredClone(source);
  let calls = 0;
  const chosen = packet.reasons.slice(-2).reverse();
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)), context = modelContext(init);
    assert.equal(Object.keys(body.format.properties)[0], "brief");
    assert.equal(Object.keys(body.format.properties).sort()[0], "brief", "generated prose precedes selectors in lexically emitted provider grammars");
    assert.equal(body.format.required[0], "brief");
    assert.equal(body.format.properties.summary, undefined, "the old private output key is not a second generated summary");
    assert.deepEqual(context.decisionPacket, plainLanguageDecisionContext(packet));
    assert.equal(body.format.properties.brief.properties.verdict.const, packet.verdict);
    assert.equal(body.format.properties.brief.properties.reportRef.const, "R1");
    assert.deepEqual(body.format.properties.brief.properties.reasonIds.items.enum, packet.reasons.map((_reason, index) => `D${index + 1}`));
    assert.equal(body.format.properties.brief.properties.reasonIds.minItems, 1);
    assert.equal(body.format.properties.brief.properties.reasonIds.maxItems, 2);
    return successful((draft) => { draft.brief.reasonIds = chosen.map((reason) => `D${packet.reasons.findIndex((candidate) => candidate.id === reason.id) + 1}`); draft.brief.text = "Some checks could not be completed, so there is not enough information for a complete assessment."; })(url, init);
  } });
  assert.equal(calls, 1);
  assert.equal(result.summary!.verdict, packet.verdict);
  assert.equal(result.summary!.action, packet.action);
  assert.deepEqual(result.summary!.reasonIds, chosen.map((reason) => reason.id));
  assert.deepEqual(result.summary!.reasons, chosen);
  assert.deepEqual(result.summary!.source, packet.source);
  assert.equal(result.summary!.text, "Some checks could not be completed, so there is not enough information for a complete assessment.");
  assert.equal(result.summary!.grounding!.mode, "source-grounded-prose");
  assert.equal("brief" in result, false);
  assert.deepEqual(Object.keys(result.summary!).sort(), ["action", "grounding", "limitations", "reasonIds", "reasons", "reportRef", "source", "text", "verdict"].sort(), "private brief restores the unchanged public profile1.6 summary");
  assert.deepEqual(source, before);
});

test("main generation constrains sentence count without treating decimal holding shares as sentence endings", async () => {
  const source = getBrowserSwarmSummaryFixture();
  source.swarmAssessment!.metrics.dev = 0.999; source.swarmAssessment!.metrics.biggest = 0.999;
  source.swarmAssessment!.metrics.impact = 0.1; source.swarmAssessment!.header.liquidity_usd = 100_000;
  const text = "SWARM reports wallets linked to the creator hold 99.90% of the holdings in its analysis. A large sale could move the price; links do not prove one owner.";
  const rejected = "SWARM reports 99.90% of token holdings are held by creator-linked wallets. This does not prove a single owner or imminent sale, but suggests high concentration risk. A sharp price move is possible if those wallets act together, though no evidence confirms coordinated action or sale intent.";
  let calls = 0;
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)), constraint = body.format.properties.brief.properties.text;
    assert.equal(constraint.maxLength, 400, "stored profile1.6 contract remains compatible");
    assert.match(constraint.description, /240/);
    assert.equal(/\(\?[<!=]/.test(constraint.pattern), false, "the provider pattern uses no lookaround");
    const sentences = new RegExp(constraint.pattern);
    assert.equal(sentences.test(text.replace("SWARM reports", "The source reports")), false, "source attribution is constrained during generation");
    assert.equal(sentences.test(text.replace("SWARM reports", "The finding from SWARM reports")), false, "SWARM attribution must begin the summary");
    assert.equal(sentences.test(text), true);
    assert.equal(sentences.test(rejected), false);
    assert.equal(sentences.test("SWARM reports a warning. it remains qualified. another claim."), false);
    return successful((draft) => { draft.brief.text = text; })(url, init);
  } });
  assert.equal(calls, 1); assert.equal(result.summary!.text, text);
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((draft) => { draft.brief.text = rejected; }) }), hasCode("INVALID_RESPONSE"));
});

test("main source grammar follows explicit authority and retains missing-source uncertainty", async () => {
  for (const sourceStatus of ["reported", "unavailable", "independent-only"] as const) {
    const source = getBrowserSwarmSummaryFixture();
    if (sourceStatus === "reported") {
      source.swarmAssessment!.metrics.impact = 0.2; source.swarmAssessment!.header.liquidity_usd = 100_000;
      source.swarmAssessment!.metrics.biggest = 0.32; source.swarmAssessment!.metrics.dev = 0.05;
      source.swarmAssessment!.judge.decision = "CAUTION"; source.swarmAssessment!.judge.confidence = 0.7;
      source.swarmAssessment!.judge.p = { avoid: 0.25, caution: 0.7, ok: 0.05 };
      assert.equal(assessInvestigationReport(source).verdict, "AVOID", "the independent assessment must not replace the primary source");
    } else if (sourceStatus === "unavailable") delete source.swarmAssessment;
    else source.assessmentAuthority = "traceforge";
    let calls = 0;
    const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)), context = modelContext(init), pattern = new RegExp(body.format.properties.brief.properties.text.pattern);
      assert.equal(context.decisionPacket.source.name, sourceStatus === "independent-only" ? "TraceForge" : "SWARM");
      assert.equal(pattern.test("An unattributed explanation."), sourceStatus === "independent-only");
      assert.match(body.messages[0].content, /brief\.text uses ONLY the selected decisionPacket/);
      assert.match(body.messages[1].content, /brief\.text first, only from decisionPacket/);
      return successful((draft) => {
        if (sourceStatus === "reported") draft.brief.text = "SWARM reports a group holding 32.00% of the holdings in its analysis. A large sale could move the price, but the links do not prove one owner.";
      })(url, init);
    } });
    assert.equal(calls, 1);
    assert.equal(result.summary!.verdict, sourceStatus === "reported" ? "CAUTION" : sourceStatus === "unavailable" ? "INSUFFICIENT" : "AVOID");
    if (sourceStatus === "unavailable") assert.match(result.summary!.text!, /unavailable/);
  }
});

test("main summary rejects two invalid source briefs without a successful fixed answer", async () => {
  const source = getBrowserSwarmSummaryFixture();
  source.swarmAssessment!.metrics.impact = 0.2; source.swarmAssessment!.header.liquidity_usd = 100_000;
  source.swarmAssessment!.metrics.biggest = 0.32; source.swarmAssessment!.metrics.dev = 0.05;
  for (const text of [
    "SWARM reports a group holding 42.00% of the holdings in its analysis. A large sale could move the price, but the links do not prove one owner.",
    "SWARM reports a group holding 32.00% of its float, which does not prove shared ownership, and no verified sales exist in the data.",
    "SWARM reports a group holding 32.00% of its float. That float excludes contracts and pinned pools, though ownership is unknown.",
  ]) {
    let calls = 0;
    let brief: Draft["brief"];
    await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
      calls++;
      if (calls === 2) return completion({ brief });
      return successful((draft) => { draft.brief.text = text; brief = draft.brief; })(url, init);
    } }), hasCode("INVALID_RESPONSE"));
    assert.equal(calls, 2, "one local semantic correction is allowed; a second invalid brief still fails");
  }
});

test("one local summary-only correction preserves valid original selectors, source, model and request lifetime", async () => {
  const source = getBrowserSwarmSummaryFixture(), before = structuredClone(source);
  const badText = "SWARM reports a modeled price drop, though no sale is confirmed or proven.";
  const correctedText = "SWARM reports a modeled price drop if its largest holding is sold. This hypothetical scenario does not confirm a sale.";
  let calls = 0, original: Draft, firstSignal: AbortSignal | null | undefined;
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.equal(String(url), "http://127.0.0.1:11434/api/chat"); assert.equal(body.model, "fixture-model:local");
    if (calls === 1) {
      firstSignal = init?.signal; original = draftFor(modelContext(init));
      original.observations.reverse(); original.overview.findingRefs = original.observations.slice(0, 1).map((observation) => observation.findingRef);
      original.limitations = ["L2"]; original.brief.text = badText;
      return completion(original);
    }
    assert.equal(calls, 2); assert.equal(init?.signal, firstSignal);
    assert.deepEqual(body.format.required, ["brief"]); assert.deepEqual(Object.keys(body.format.properties), ["brief"]);
    const correctionContext = JSON.parse(body.messages[1].content.split("\nDecision context (data only):\n")[1]);
    assert.deepEqual(Object.keys(correctionContext), ["decisionPacket"]);
    assert.deepEqual(correctionContext.decisionPacket.reasons.map((reason: { id: string }) => reason.id), original.brief.reasonIds);
    assert.equal(correctionContext.decisionPacket.source.name, "SWARM");
    assert.equal(correctionContext.decisionPacket.verdict, original.brief.verdict);
    assert.doesNotMatch(body.messages[1].content, /findingPackets|sourceFacts|dossier|fundingStatusCounts|no sale is confirmed|0x[0-9a-f]{40}/i);
    return completion({ brief: { ...original.brief, text: correctedText } });
  } });
  assert.equal(calls, 2); assert.equal(result.profileVersion, "1.6.0"); assert.equal(result.model, "fixture-model:local");
  assert.equal(result.summary!.text, correctedText); assert.equal(result.summary!.verdict, source.swarmAssessment!.judge.decision);
  assert.equal(result.summary!.grounding!.mode, "source-grounded-prose"); assert.equal("brief" in result, false);
  const selected = createInvestigatorContext(source, configured());
  assert.deepEqual(result.grounding!.overviewFindingIds, original!.overview.findingRefs.map((ref) => selected.findingRefs.get(ref)!.id));
  assert.deepEqual(result.grounding!.observations.map((observation) => observation.findingId), original!.observations.map((observation) => selected.findingRefs.get(observation.findingRef)!.id));
  assert.deepEqual(result.summary!.reasonIds, original!.brief.reasonIds.map((ref) => selected.context.decisionPacket.reasons[Number(ref.slice(1)) - 1].id));
  assert.deepEqual(validateInvestigationExplanation(source, result), result); assert.deepEqual(source, before);
});

test("invalid JSON, first selectors, full-proof citations and transport failures never start a summary correction", async () => {
  const source = mixedReport(), invalidText = "The token has no verified sales and guarantees profit.";
  for (const [mutate, code] of [
    [(draft: Draft) => { draft.observations[0].findingRef = "F999"; }, "INVALID_CITATION"],
    [(draft: Draft) => { draft.observations[1].findingRef = draft.observations[0].findingRef; }, "INVALID_CITATION"],
    [(draft: Draft) => { draft.overview.findingRefs = ["F1", "F1"]; }, "INVALID_CITATION"],
    [(draft: Draft) => { draft.observations[0].caveatRef = "C999"; }, "INVALID_RESPONSE"],
    [(draft: Draft) => { draft.brief.reasonIds = ["D1", "D1"]; }, "INVALID_RESPONSE"],
  ] as const) {
    let calls = 0;
    await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
      calls++; return successful((draft) => { draft.brief.text = invalidText; mutate(draft); })(url, init);
    } }), hasCode(code));
    assert.equal(calls, 1);
  }
  for (const [response, code] of [
    [jsonResponse({ done: true, message: { role: "assistant", content: "not-json" } }), "INVALID_RESPONSE"],
    [new Response("private upstream body", { status: 429 }), "RATE_LIMITED"],
    [new Response("private upstream body", { status: 503 }), "UNAVAILABLE"],
  ] as const) {
    let calls = 0;
    await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: async () => { calls++; return response; } }), hasCode(code));
    assert.equal(calls, 1);
  }
});

test("duplicate model properties fail before a local correction and cannot be hidden by last-value parsing", async () => {
  for (const duplicate of ["brief", "evidenceIds"] as const) {
    let calls = 0;
    await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: async (_url, init) => {
      calls++; const content = JSON.stringify(draftFor(modelContext(init)));
      const ambiguous = duplicate === "brief" ? `{"brief":{},${content.slice(1)}`
        : content.replace('"evidenceIds":[]', '"evidenceIds":["E999"],"evidenceIds":[]');
      assert.notEqual(ambiguous, content);
      return jsonResponse({ done: true, done_reason: "stop", message: { role: "assistant", content: ambiguous } });
    } }), hasCode("INVALID_RESPONSE"));
    assert.equal(calls, 1, "ambiguous first output never starts semantic regeneration");
  }
});

test("duplicate properties in a local correction reject without a third generation", async () => {
  const source = getBrowserSwarmSummaryFixture(); let calls = 0, brief: Draft["brief"];
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    calls++;
    if (calls === 1) return successful((draft) => { draft.brief.text = "SWARM reports a modeled drop, though no sale is confirmed."; brief = draft.brief; })(url, init);
    const corrected = JSON.stringify({ brief: { ...brief, text: "SWARM reports a hypothetical price drop if a large holding is sold." } });
    return jsonResponse({ done: true, done_reason: "stop", message: { role: "assistant", content: `{"brief":{},${corrected.slice(1)}` } });
  } }), hasCode("INVALID_RESPONSE"));
  assert.equal(calls, 2);
});

test("local correction cannot change reason selectors or return another report payload", async () => {
  const source = getBrowserSwarmSummaryFixture();
  for (const mutate of [
    (brief: Draft["brief"]) => { brief.reasonIds = ["D2"]; },
    (brief: Draft["brief"]) => { brief.reportRef = "other-report"; },
    (brief: Draft["brief"]) => { Object.assign(brief, { verdict: "OK" }); },
  ]) {
    let calls = 0, brief: Draft["brief"];
    await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
      calls++;
      if (calls === 1) return successful((draft) => { draft.brief.text = "SWARM reports a modeled drop, though no sale is confirmed."; brief = draft.brief; })(url, init);
      const replacement = { ...brief, reasonIds: [...brief.reasonIds], text: "SWARM reports a hypothetical price drop if a large holding is sold." };
      mutate(replacement); return completion({ brief: replacement });
    } }), hasCode("INVALID_RESPONSE"));
    assert.equal(calls, 2);
  }
});

test("summary correction uses the original deadline and cancellation instead of restarting the request", async () => {
  const source = getBrowserSwarmSummaryFixture();
  let elapsed = 0, calls = 0;
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured({ LOCAL_AI_TIMEOUT_MS: "1000" }), {
    monotonicNow: () => elapsed, fetch: async (url, init) => {
      calls++; elapsed = 1001;
      return successful((draft) => { draft.brief.text = "SWARM reports a modeled drop, though no sale is confirmed."; })(url, init);
    },
  }), hasCode("TIMEOUT"));
  assert.equal(calls, 1, "an elapsed request cannot start the correction");
  const controller = new AbortController(); calls = 0;
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { signal: controller.signal, fetch: async (url, init) => {
    calls++; const response = await successful((draft) => { draft.brief.text = "SWARM reports a modeled drop, though no sale is confirmed."; })(url, init);
    controller.abort(); return response;
  } }), hasCode("ABORTED"));
  assert.equal(calls, 1);
  const duringCorrection = new AbortController(); calls = 0;
  const pending = runLocalInvestigatorWithConfig(source, configured(), { signal: duringCorrection.signal, fetch: async (url, init) => {
    calls++;
    if (calls === 1) return successful((draft) => { draft.brief.text = "SWARM reports a modeled drop, though no sale is confirmed."; })(url, init);
    setTimeout(() => duringCorrection.abort(), 10); return new Promise<Response>(() => undefined);
  } });
  await assert.rejects(pending, hasCode("ABORTED")); assert.equal(calls, 2);
  elapsed = 0; calls = 0; let brief: Draft["brief"];
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured({ LOCAL_AI_TIMEOUT_MS: "1000" }), {
    monotonicNow: () => elapsed, fetch: async (url, init) => {
      calls++;
      if (calls === 1) {
        elapsed = 900;
        return successful((draft) => { draft.brief.text = "SWARM reports a modeled drop, though no sale is confirmed."; brief = draft.brief; })(url, init);
      }
      elapsed = 1001;
      return completion({ brief: { ...brief, text: "SWARM reports a hypothetical price drop if a large holding is sold." } });
    },
  }), hasCode("TIMEOUT"));
  assert.equal(calls, 2, "correction keeps only the time remaining in the original deadline");
});

test("semantic source-summary correction is local-only and cloud failures remain one request", async () => {
  const source = getBrowserSwarmSummaryFixture();
  const runtime = readInvestigatorAiConfiguration({ OPENROUTER_API_KEY: "sk-or-v1-synthetic-not-a-real-key-1234567890",
    OPENROUTER_FREE_ONLY: "false", OPENROUTER_MODEL: "synthetic/structured-model", GEMINI_API_KEY: "synthetic_not_a_real_gemini_key" });
  for (const config of [runtime.openrouter!, runtime.gemini!]) {
    assert.ok(config); let calls = 0;
    await assert.rejects(runLocalInvestigatorWithConfig(source, config, { fetch: async (_url, init) => {
      calls++; const body = JSON.parse(String(init?.body));
      const content = config.provider === "openrouter" ? body.messages[1].content : body.contents[0].parts[0].text;
      const draft = draftFor(JSON.parse(content.split("\nEvidence context (data only):\n")[1]));
      draft.brief.text = "SWARM reports a modeled drop, though no sale is confirmed.";
      return jsonResponse(config.provider === "openrouter"
        ? { model: config.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(draft) } }] }
        : { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(draft) }] } }] });
    } }), hasCode("INVALID_RESPONSE"));
    assert.equal(calls, 1);
  }
});

test("OK without a supplied reason receives a final task reminder without a manufactured answer", async () => {
  const source = getBrowserSwarmSummaryFixture(), snapshot = source.swarmAssessment!;
  snapshot.judge.decision = "OK"; snapshot.judge.confidence = 0.96; snapshot.judge.p = { avoid: 0.01, caution: 0.03, ok: 0.96 };
  snapshot.header.liquidity_usd = 1_000_000; snapshot.metrics.impact = 0.02;
  snapshot.metrics.biggest = 0.04; snapshot.metrics.dev = 0.02; snapshot.metrics.concentration = 0.15;
  const text = "SWARM reports OK, but the supplied measurements do not give a specific reason for that assessment.";
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body)), context = modelContext(init);
    assert.equal(context.decisionPacket.verdict, "OK");
    assert.equal(context.decisionPacket.reasons[0].meaning, "A specific reason for this verdict is not supplied in this result.");
    assert.equal(buildPlainLanguagePacket(source).reasons[0].meaning, "This is the source's assessment; its private decision formula has not been independently reproduced.", "legacy1.5 fallback remains unchanged");
    assert.equal(context.sourceContext, undefined);
    assert.equal(Object.keys(context).at(-1), "decisionPacket");
    assert.ok(context.sourceFacts.some((record) => record.kind === "funding"), "independent proof remains available for its own observation selectors");
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[2].role, "user");
    assert.match(body.messages[2].content, /a specific reason is not supplied/);
    assert.match(body.messages[2].content, /Explain only these facts/);
    assert.doesNotMatch(body.messages[2].content, /formula|exclusive|validation|independent findings|without/i);
    assert.equal(body.messages[2].content.includes(text), false, "the task reminder does not supply a preset successful response");
    return successful((draft) => { draft.brief.text = text; })(url, init);
  } });
  assert.equal(result.summary!.text, text);
  assert.equal(result.summary!.verdict, "OK");
});

test("missing SWARM gets a concise known-limit task while complete independent proof remains available", async () => {
  const source = getBrowserSwarmSummaryFixture(); delete source.swarmAssessment;
  assert.equal(assessInvestigationReport(source).verdict, "AVOID");
  assert.equal(derivePrimaryAssessment(source).score, null);
  const full = JSON.parse(createInvestigatorContext(source, configured()).json);
  const text = "SWARM's assessment is unavailable, so the primary assessment cannot be completed for this scan.";
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body)), context = modelContext(init);
    assert.equal(context.decisionPacket.verdict, "INSUFFICIENT");
    assert.equal(context.decisionPacket.source.name, "SWARM");
    assert.equal(body.format.properties.brief.properties.text.maxLength, 200, "provider generation is narrower than the unchanged400character public envelope");
    assert.deepEqual(context.findingPackets, full.findingPackets);
    assert.deepEqual(context.sourceFacts, full.sourceFacts);
    assert.equal(body.messages.length, 3);
    assert.match(body.messages[2].content, /primary assessment cannot be completed/);
    assert.match(body.messages[2].content, /Independent blockchain findings remain available separately/);
    assert.match(body.messages[2].content, /source-specific limitation/);
    assert.match(body.messages[2].content, /one short sentence in your own words/);
    assert.doesNotMatch(body.messages[2].content, /sales?|funding|transfers?|ownership|formula|validation/i);
    assert.equal(body.messages[2].content.includes(text), false);
    return successful((draft) => { draft.brief.text = text; })(url, init);
  } });
  assert.equal(result.summary!.verdict, "INSUFFICIENT");
  assert.equal(result.summary!.source.dataThrough, null);
  assert.equal(result.summary!.text, text);
});

test("missing-source task does not promise available independent findings without a supplied proof", async () => {
  const source = analyze(dataset([])); source.assessmentAuthority = "swarm";
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body)), context = modelContext(init);
    assert.equal(context.sourceFacts.length, 0);
    assert.equal(context.findingPackets.length, 0);
    assert.doesNotMatch(body.messages[2].content, /findings remain available/);
    assert.match(body.messages[2].content, /source-specific limitation/);
    return successful()(url, init);
  } });
  assert.equal(result.summary!.verdict, "INSUFFICIENT");
  assert.equal(result.summary!.source.name, "SWARM");
});

test("summary selector rejects absent, foreign, duplicate or model-authored decisions without a fallback", async () => {
  for (const mutate of [
    (draft: Draft) => { Reflect.deleteProperty(draft, "brief"); },
    (draft: Draft) => { Object.assign(draft, { summary: draft.brief }); Reflect.deleteProperty(draft, "brief"); },
    (draft: Draft) => { Reflect.deleteProperty(draft.brief, "text"); },
    (draft: Draft) => { draft.brief.text = ""; },
    (draft: Draft) => { draft.brief.reportRef = "foreign-report"; },
    (draft: Draft) => { Object.assign(draft.brief, { verdict: "BUY" }); },
    (draft: Draft) => { draft.brief.reasonIds = []; },
    (draft: Draft) => { draft.brief.reasonIds = ["invented-reason"]; },
    (draft: Draft) => { draft.brief.reasonIds = [draft.brief.reasonIds[0], draft.brief.reasonIds[0]]; },
    (draft: Draft) => { Object.assign(draft.brief, { reason: "This token is guaranteed safe." }); },
  ]) {
    let calls = 0;
    await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: async (url, init) => {
      calls++; return successful(mutate)(url, init);
    } }), hasCode("INVALID_RESPONSE"));
    assert.equal(calls, 1);
  }
});

test("transitive component facts preserve infrastructure as a possibility, not a proved mechanism", async () => {
  const source = mixedReport(); source.findings = source.findings.filter((finding) => finding.category !== "connections" || finding.rule.name === "evidence-linked-component");
  const finding = source.findings.find((finding) => finding.category === "connections")!;
  const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() });
  const observation = result.observations.find((observation) => observation.category === "connections")!;
  assert.equal(observation.claim, canonicalFindingClaim(finding)); assert.match(observation.claim, /paths are transitive/); assert.match(observation.claim, /can share infrastructure/);
  assert.doesNotMatch(observation.claim, /linked through shared infrastructure|addresses share infrastructure/);
  assert.deepEqual(new Set(observation.evidenceIds), new Set(finding.evidenceIds));
});

test("independent validation rejects forged canonical prose, selectors and grounding downgrade", async () => {
  const source = mixedReport(), result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() });
  const mutations = [
    (value: typeof result) => { value.observations[0].claim = "Linked wallets share infrastructure."; },
    (value: typeof result) => { value.observations[0].caveat = "Common ownership is established."; },
    (value: typeof result) => { value.overview.text = "No transfers occurred."; },
    (value: typeof result) => { value.grounding!.observations[0].findingId = "unknown-finding"; },
    (value: typeof result) => { value.grounding!.observations[0].caveatIndex = 9; },
    (value: typeof result) => { value.grounding!.overviewFindingIds = ["unknown-finding"]; },
    (value: typeof result) => { delete value.grounding; },
    (value: typeof result) => { value.profileVersion = "1.3.0"; },
  ];
  for (const mutate of mutations) { const forged = structuredClone(result); mutate(forged); assert.throws(() => validateInvestigationExplanation(source, forged), ExplanationValidationError); }
});

test("caveat references must belong to their selected finding, with no guessed successful replacement", async () => {
  const source = mixedReport(); let calls = 0;
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: async (url, init) => {
    calls++; const body = JSON.parse(String(init?.body)); return successful((draft, context) => {
      const longest = Math.max(...context.findingPackets.map((packet) => packet.caveatRefs.length));
      const shortest = context.findingPackets.find((packet) => packet.caveatRefs.length < longest)!; assert.ok(shortest);
      const generationChoice = body.format.properties.observations.items.oneOf.find((option: { properties: { findingRef: { const: string } } }) => option.properties.findingRef.const === shortest.ref);
      assert.deepEqual(generationChoice.properties.caveatRef.enum, shortest.caveatRefs);
      assert.equal(generationChoice.properties.caveatRef.enum.includes(`C${longest}`), false, "invalid cross-finding caveats are excluded during generation as well as restoration");
      draft.observations.find((observation) => observation.findingRef === shortest.ref)!.caveatRef = `C${longest}`;
    })(url, init);
  } }), hasCode("INVALID_RESPONSE")); assert.equal(calls, 1);
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((draft) => { draft.observations[0].caveatRef = "C999"; }) }), hasCode("INVALID_RESPONSE"));
});

test("legacy 1.3 commentary remains readable without acquiring canonical-grounding status", async () => {
  const source = mixedReport(), legacy = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() });
  legacy.profileVersion = "1.3.0"; delete legacy.grounding; delete legacy.summary; legacy.observations[0].claim = "Legacy free-form AI commentary requires review.";
  const restored = validateInvestigationExplanation(source, legacy); assert.equal(restored.profileVersion, "1.3.0"); assert.equal(restored.grounding, undefined); assert.equal(restored.observations[0].claim, legacy.observations[0].claim);
});

test("legacy 1.4 grounded findings remain readable without a new summary receipt", async () => {
  const source = mixedReport(), legacy = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() });
  legacy.profileVersion = "1.4.0"; delete legacy.summary;
  const restored = validateInvestigationExplanation(source, legacy);
  assert.equal(restored.profileVersion, "1.4.0");
  assert.equal(restored.grounding?.mode, "canonical-finding-selection");
  assert.equal(restored.summary, undefined);
});

test("overview rejects invalid fact selections and allows empty selections only without evidence", async () => {
  for (const findingRefs of [[], ["F999"], ["F1", "F1"]]) await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: successful((draft) => { draft.overview.findingRefs = findingRefs; }) }), hasCode("INVALID_CITATION"));
  const evidenceOnly = report(); evidenceOnly.findings = [];
  for (const evidenceIds of [[], ["E999"], ["E1", "E1"]]) await assert.rejects(runLocalInvestigatorWithConfig(evidenceOnly, configured(), { fetch: successful((draft) => { draft.overview.evidenceIds = evidenceIds; }) }), hasCode("INVALID_CITATION"));
  const source = analyze(dataset([])); source.coverage.transfers = "unavailable"; const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() }); assert.deepEqual(result.overview.evidenceIds, []); assert.equal(result.observations.length, 0); assert.match(result.overview.text, /Missing observations do not establish an absence/);
});

test("reviewed Modelfile matches profile and exact instruction-only base", async () => {
  const file = await readFile("models/traceforce-investigator.Modelfile", "utf8"); assert.equal(file.replaceAll("\r\n", "\n"), investigatorModelfile()); assert.equal(INVESTIGATOR_BASE_MODEL, "qwen3:4b-instruct-2507-q4_K_M"); assert.match(file, /PARAMETER num_thread 2/); assert.match(file, /not fine-tuned weights/); assert.match(file, /profile 1\.6\.0/);
});

test("malformed, unfinished, tool-calling and oversized responses reject", async () => {
  for (const response of [jsonResponse({ done: false, message: { role: "assistant", content: "{}" } }), jsonResponse({ done: true, done_reason: "length", message: { role: "assistant", content: "{}" } }), jsonResponse({ done: true, message: { role: "assistant", content: "not-json" } }), jsonResponse({ done: true, message: { role: "assistant", content: "{}", tool_calls: [{}] } }), new Response("not-json", { headers: { "content-type": "application/json" } })]) await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: async () => response }), hasCode("INVALID_RESPONSE"));
  await assert.rejects(runLocalInvestigatorWithConfig(report(), configured({ LOCAL_AI_MAX_RESPONSE_BYTES: "1024" }), { fetch: async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "2000" } }) }), hasCode("RESPONSE_LIMIT"));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1200))); controller.close(); } }); await assert.rejects(runLocalInvestigatorWithConfig(report(), configured({ LOCAL_AI_MAX_RESPONSE_BYTES: "1024" }), { fetch: async () => new Response(stream, { headers: { "content-type": "application/json" } }) }), hasCode("RESPONSE_LIMIT"));
});

test("context exhaustion performs no inference", async () => {
  const source = report(); source.coverage.warnings = Array.from({ length: 4 }, (_unused, index) => `${index}${"警".repeat(499)}`); await assert.rejects(runLocalInvestigatorWithConfig(source, configured({ LOCAL_AI_MAX_CONTEXT_BYTES: "4096" }), { fetch: async () => { throw new Error("Unexpected inference."); } }), hasCode("CONTEXT_LIMIT"));
});

test("external cancellation interrupts transport and prior cancellation performs no request", async () => {
  const controller = new AbortController(); let fetched = false; const pending = runLocalInvestigatorWithConfig(report(), configured(), { signal: controller.signal, fetch: async () => { fetched = true; return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "content-type": "application/json" } }); } }); setTimeout(() => controller.abort(), 10); await assert.rejects(pending, hasCode("ABORTED")); assert.equal(fetched, true); await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { signal: controller.signal, fetch: successful() }), hasCode("ABORTED"));
});

test("owned deadline bounds hanging transport and upstream details remain sanitized", async () => {
  await assert.rejects(runLocalInvestigatorWithConfig(report(), configured({ LOCAL_AI_TIMEOUT_MS: "1000" }), { fetch: () => new Promise<Response>(() => undefined) }), hasCode("TIMEOUT")); await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: async () => { throw new Error("private-upstream-detail"); } }), (error: unknown) => hasCode("UNAVAILABLE")(error) && !String(error).includes("private-upstream-detail"));
});

test("monotonic deadline rejects late output before a delayed timer dispatch", async () => {
  let elapsed = 0; await assert.rejects(runLocalInvestigatorWithConfig(report(), configured({ LOCAL_AI_TIMEOUT_MS: "1000" }), { monotonicNow: () => elapsed, fetch: async (url, init) => { assert.equal(init?.signal?.aborted, false); elapsed = 1001; return successful()(url, init); } }), hasCode("TIMEOUT"));
});

test("progress respects cancellation and cannot start inference after elapsed deadline", async () => {
  const controller = new AbortController(); let fetched = false; const pending = runLocalInvestigatorWithConfig(report(), configured(), { signal: controller.signal, onProgress: () => new Promise<void>(() => undefined), fetch: async (url, init) => { fetched = true; return successful()(url, init); } }); setTimeout(() => controller.abort(), 10); await assert.rejects(pending, hasCode("ABORTED")); assert.equal(fetched, false);
  let elapsed = 0; await assert.rejects(runLocalInvestigatorWithConfig(report(), configured({ LOCAL_AI_TIMEOUT_MS: "1000" }), { monotonicNow: () => elapsed, onProgress: async () => { elapsed = 1001; }, fetch: async (url, init) => { fetched = true; return successful()(url, init); } }), hasCode("TIMEOUT")); assert.equal(fetched, false);
});

test("owned deadline settles never-ending progress without starting inference", async () => {
  let fetched = false; const startedAt = performance.now(); await assert.rejects(runLocalInvestigatorWithConfig(report(), configured({ LOCAL_AI_TIMEOUT_MS: "1000" }), { onProgress: () => new Promise<void>(() => undefined), fetch: async (url, init) => { fetched = true; return successful()(url, init); } }), hasCode("TIMEOUT")); assert.ok(performance.now() - startedAt >= 900); assert.equal(fetched, false);
});
