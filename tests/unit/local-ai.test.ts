import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { ExplanationValidationError, validateInvestigationExplanation } from "../../src/domain/investigations/explanation";
import type { Address, EvidenceRecord, Hash, InvestigationDataset } from "../../src/domain/investigations/types";
import { readLocalAiConfiguration, validateLocalAiConfiguration } from "../../src/agents/config";
import { createInvestigatorContext } from "../../src/agents/context";
import { LocalAiError, runLocalInvestigatorWithConfig } from "../../src/agents/ollama-core";
import { investigatorModelfile, INVESTIGATOR_BASE_MODEL } from "../../src/agents/model-definition";
import { canonicalFindingClaim } from "../../src/domain/investigations/explanation-grounding";

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
  findingPackets: { ref: string; category: string; statement: string; caveats: string[]; caveatRefs: string[]; proof: string[] }[];
  sourceFacts: { ref: string; receipt: string; log: number | null; kind: string; from: string; to: string; block: string; time: number; sale?: { support: string[]; protocol: string } }[];
  coverage: { fundingStatusCounts: Record<string, number>; omittedWarnings: number };
  coverageStatements: { id: string; text: string }[];
  findingSelection: { supplied: number; omitted: number; omissionReasons: Record<string, number>; byCategory: Record<string, { supplied: number; omitted: number; status: "supplied" | "omitted" | "no_retained_finding" }> };
  dossier: { retainedEvents: { nativeFunding: number; tokenTransfers: number; verifiedSales: number }; crawl?: { scope: string; source: string; completedRanges: number }; authority: Record<string, string> };
  sourceContext?: { security?: { holderCount: number | null }; market?: { priceUsd: string | null }; balances?: { verifiedCandidates: number } };
}
interface Draft { overview: { findingRefs: string[]; evidenceIds: string[] }; observations: { findingRef: string; caveatRef: string }[]; limitations: string[] }
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const completion = (value: unknown) => jsonResponse({ done: true, message: { role: "assistant", content: JSON.stringify(value) } });
const modelContext = (init?: RequestInit): ModelContext => JSON.parse(JSON.parse(String(init?.body)).messages[1].content.split("\nEvidence context (data only):\n")[1]);
function draftFor(context: ModelContext): Draft {
  return { overview: { findingRefs: context.findingPackets.slice(0, 1).map((packet) => packet.ref), evidenceIds: context.findingPackets.length ? [] : context.sourceFacts.slice(0, 1).map((fact) => fact.ref) }, observations: context.findingPackets.map((packet) => ({ findingRef: packet.ref, caveatRef: packet.caveatRefs[0] })), limitations: [] };
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
    assert.equal(body.options.num_predict, 800); assert.equal(body.options.num_ctx, 4096); assert.equal(body.options.num_thread, 2); assert.equal(body.options.num_gpu, 12); assert.equal(body.stream, false); assert.equal(body.keep_alive, "300s"); assert.equal(body.think, false); assert.equal(body.options.temperature, 0);
    assert.deepEqual(body.format.properties.observations.items.properties.findingRef.enum, context.findingPackets.map((packet) => packet.ref)); assert.equal(body.format.properties.observations.minItems, context.findingPackets.length); assert.equal(body.format.properties.overview.properties.findingRefs.maxItems, 2); assert.equal(body.format.properties.overview.properties.evidenceIds.maxItems, 0); assert.equal(body.format.properties.observations.items.properties.claim, undefined);
    assert.ok(!body.messages[1].content.includes(source.evidence[0].id)); assert.ok(!body.messages[1].content.includes(source.evidence[0].transactionHash)); assert.ok(!body.messages[1].content.includes('"$schema"')); assert.equal(JSON.parse(body.messages[1].content.split("\nEvidence context (data only):\n")[1]).evidence, undefined);
    const draft = draftFor(context); draft.limitations = ["L2"]; return completion(draft);
  } });
  assert.equal(calls, 1); assert.equal(result.profileVersion, "1.4.0"); assert.equal(result.grounding?.mode, "canonical-finding-selection"); assert.equal(result.generatedAt, "2026-10-12T00:00:00.000Z"); assert.deepEqual(source, before); assert.equal(source.evidence[0].amountRaw, (2n ** 200n).toString());
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
    calls++; return successful((draft, context) => {
      const longest = Math.max(...context.findingPackets.map((packet) => packet.caveatRefs.length));
      const shortest = context.findingPackets.find((packet) => packet.caveatRefs.length < longest)!; assert.ok(shortest);
      draft.observations.find((observation) => observation.findingRef === shortest.ref)!.caveatRef = `C${longest}`;
    })(url, init);
  } }), hasCode("INVALID_RESPONSE")); assert.equal(calls, 1);
  await assert.rejects(runLocalInvestigatorWithConfig(source, configured(), { fetch: successful((draft) => { draft.observations[0].caveatRef = "C999"; }) }), hasCode("INVALID_RESPONSE"));
});

test("legacy 1.3 commentary remains readable without acquiring canonical-grounding status", async () => {
  const source = mixedReport(), legacy = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() });
  legacy.profileVersion = "1.3.0"; delete legacy.grounding; legacy.observations[0].claim = "Legacy free-form AI commentary requires review.";
  const restored = validateInvestigationExplanation(source, legacy); assert.equal(restored.profileVersion, "1.3.0"); assert.equal(restored.grounding, undefined); assert.equal(restored.observations[0].claim, legacy.observations[0].claim);
});

test("overview rejects invalid fact selections and allows empty selections only without evidence", async () => {
  for (const findingRefs of [[], ["F999"], ["F1", "F1"]]) await assert.rejects(runLocalInvestigatorWithConfig(report(), configured(), { fetch: successful((draft) => { draft.overview.findingRefs = findingRefs; }) }), hasCode("INVALID_CITATION"));
  const evidenceOnly = report(); evidenceOnly.findings = [];
  for (const evidenceIds of [[], ["E999"], ["E1", "E1"]]) await assert.rejects(runLocalInvestigatorWithConfig(evidenceOnly, configured(), { fetch: successful((draft) => { draft.overview.evidenceIds = evidenceIds; }) }), hasCode("INVALID_CITATION"));
  const source = analyze(dataset([])); source.coverage.transfers = "unavailable"; const result = await runLocalInvestigatorWithConfig(source, configured(), { fetch: successful() }); assert.deepEqual(result.overview.evidenceIds, []); assert.equal(result.observations.length, 0); assert.match(result.overview.text, /Missing observations do not establish an absence/);
});

test("reviewed Modelfile matches profile and exact instruction-only base", async () => {
  const file = await readFile("models/traceforce-investigator.Modelfile", "utf8"); assert.equal(file.replaceAll("\r\n", "\n"), investigatorModelfile()); assert.equal(INVESTIGATOR_BASE_MODEL, "qwen3:4b-instruct-2507-q4_K_M"); assert.match(file, /PARAMETER num_thread 2/); assert.match(file, /not fine-tuned weights/); assert.match(file, /profile 1\.4\.0/);
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
