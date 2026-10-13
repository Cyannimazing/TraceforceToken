import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createChatContext, verifyChatContext } from "../../src/agents/chat-context";
import { readLocalAiConfiguration } from "../../src/agents/config";
import { createInvestigatorContext, sourceContextSchema } from "../../src/agents/context";
import { askInvestigationQuestion, InvestigationQuestionError } from "../../src/agents/questions";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

const secret = "synthetic-assessment-context-secret-123456789";
const config = readLocalAiConfiguration({ LOCAL_AI_MODEL: "synthetic-assessment-context" });
function fixture(unknown = false) {
  const report = unknown ? getBrowserReportFixture() : getBrowserWalletFlagsFixture({ contractDominated: true });
  if (!unknown) report.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt: report.generatedAt,
    sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: report.infrastructure!.pools[0],
    priceUsd: "0.25", liquidityUsd: 0.01, marketCapUsd: 100, volume24hUsd: 25, priceChange24hPercent: -99, pairCreatedAt: null };
  const capsule = createChatContext(report, config, secret), context = verifyChatContext(capsule, config, secret);
  return { report, capsule, context, facts: JSON.parse(context.data), assessment: context.assessment! };
}
const completion = (answer: string, caveat = "These are local normalized rule weights, not calibrated outcome probabilities.") => new Response(JSON.stringify({
  done: true, done_reason: "stop", message: { role: "assistant", content: JSON.stringify({ answer, caveat, evidenceIds: [], needsFreshScan: false }) },
}), { headers: { "content-type": "application/json" } });
const hasCode = (code: InvestigationQuestionError["code"]) => (error: unknown) => error instanceof InvestigationQuestionError && error.code === code;
function signedPayload(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `v1.${payload}.${createHmac("sha256", secret).update(`traceforce-scan-questions:v1\0${payload}`).digest("base64url")}`;
}

test("signed assessment preserves deterministic values, unknown categories and bounded context", () => {
  const { report, facts, context, assessment: supplied } = fixture(), expected = assessInvestigationReport(report);
  assert.equal(supplied.model, "traceforce-judge-1.0.0");
  assert.equal(supplied.ruleVersion, expected.version);
  assert.equal(supplied.earnedScore, expected.assessedPoints);
  assert.equal(supplied.displayedScore, expected.displayedScore);
  assert.equal(supplied.assessedPossiblePoints, expected.assessedPossiblePoints);
  assert.deepEqual(supplied.scoreRange, expected.scoreRange);
  assert.deepEqual(supplied.weights, expected.verdictWeights);
  assert.deepEqual(supplied.rawStats, expected.metrics);
  assert.deepEqual(supplied.categories, expected.categories.map(({ id, points, possiblePoints }) => ({ id, points, possiblePoints })));
  assert.ok(supplied.categories.some((row: { points: number | null }) => row.points === null), "no earned points must not turn unassessed categories into factual zeros");
  assert.ok(Buffer.byteLength(context.data, "utf8") <= 6000);
  assert.equal(facts.sourceContext.assessment, undefined, "optional rule metadata does not consume the complete finding budget");
  const original = createInvestigatorContext(report, { ...config, maxContextBytes: 6000, maxEvidenceRecords: 12 });
  assert.equal(context.data, original.json);
  assert.deepEqual(context.citations.map((entry) => entry.id), original.context.evidence.map((entry) => entry.id), "no proof is removed or truncated for assessment metadata");
  assert.ok(supplied.gates.some((gate: { authority: string }) => gate.authority === "hypothetical"));
  assert.ok(supplied.gates.some((gate: { authority: string }) => gate.authority === "source-reported"));
});

test("score and verdict questions invoke AI using only supplied rule metadata", async () => {
  const { capsule, assessment } = fixture(); let calls = 0;
  for (const question of ["Why AVOID?", "Why is the score zero?", "What do these points mean?"]) {
    const answer = await askInvestigationQuestion(question, capsule, config, secret, { fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)), supplied = JSON.parse(body.messages[1].content).authenticatedScanFacts;
      assert.match(body.messages[0].content, /Required answer grounding: metadata/);
      assert.match(body.messages[0].content, /displayed 0 means no earned points, not verified absence/);
      assert.match(body.messages[0].content, /not calibrated probabilities/);
      assert.deepEqual(supplied.sourceContext.assessment, assessment);
      assert.deepEqual(Object.keys(supplied.sourceContext), ["assessment"]);
      return completion(`The AVOID verdict follows a hypothetical sale-model warning; the earned score is ${assessment.earnedScore}. Unknown categories have no earned points.`);
    } });
    assert.deepEqual(answer.evidenceIds, []);
    assert.equal(answer.needsFreshScan, false);
  }
  assert.equal(calls, 3);
});

test("verdict market explanations name their source and accept the official spaced brand", async () => {
  const { capsule } = fixture();
  for (const source of ["DEX Screener", "DEXScreener", "DexScreener", "dex screener", "\nDEX Screener"]) {
    const result = await askInvestigationQuestion("Why AVOID? Explain the dump and liquidity warnings.", capsule, config, secret, { fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.match(body.messages[0].content, /Name DEX Screener explicitly/);
      assert.match(body.messages[0].content, /generic past-snapshot caveat does not identify the market source/);
      assert.equal(body.format.properties.answer.pattern, undefined, "source qualification is checked across answer and caveat without an unsupported model grammar");
      assert.doesNotMatch(body.messages[0].content, /70 wallets have complete funding records/);
      return completion(`AVOID follows hypothetical sale-model warnings and thin liquidity reported by ${source}.`, "A sale model is hypothetical; selected-pair source figures are not total executable liquidity.");
    } });
    assert.deepEqual(result.evidenceIds, []);
  }
  await assert.rejects(askInvestigationQuestion("Why AVOID? Explain the dump and liquidity warnings.", capsule, config, secret, {
    fetch: async () => completion("AVOID follows hypothetical sale-model warnings and thin liquidity.", "The report is a past snapshot."),
  }), hasCode("INVALID_RESPONSE"));
  const caveatSource = await askInvestigationQuestion("Why AVOID? Explain the dump and liquidity warnings.", capsule, config, secret, {
    fetch: async () => completion("AVOID follows hypothetical sale-model warnings and thin liquidity.", "DEX Screener reports selected-pair liquidity."),
  });
  assert.match(caveatSource.caveat, /DEX Screener/, "generation constraints do not reject a legitimate source-attributed caveat from another provider");
});

test("assessment schema rejects invented earned totals, normalized weights and unknown replacements", () => {
  const { facts, assessment } = fixture(), source = { ...facts.sourceContext, assessment };
  for (const mutation of [
    { earnedScore: source.assessment.earnedScore + 1 }, { displayedScore: 101 }, { weights: { avoid: 1, caution: 1, ok: 0 } },
    { assessedPossiblePoints: source.assessment.assessedPossiblePoints + 1 },
    { scoreRange: { minimum: 80, maximum: 20 } },
    { categories: source.assessment.categories.map((row: { points: number | null }) => row.points === null ? { ...row, points: 0 } : row) },
  ]) assert.equal(sourceContextSchema.safeParse({ ...source, assessment: { ...source.assessment, ...mutation } }).success, false);
});

test("all nine supported warning gates fit the optional bounded assessment", () => {
  const { facts, assessment } = fixture();
  const labels = ["Wallet dump impact", "Contract concentration", "Contract dump impact", "Fresh wallets", "Creator holding", "Thin liquidity", "Honeypot flag", "Owner can change balances", "Transfers can be paused"];
  const gates = labels.map((label) => ({ ...assessment.gates[0], label }));
  const source = { ...facts.sourceContext, assessment: { ...assessment, gates } };
  assert.equal(sourceContextSchema.safeParse(source).success, true, "nine legitimate warnings must not disable all chatbot questions");
  assert.ok(Buffer.byteLength(JSON.stringify(source.assessment), "utf8") <= 4096);
  assert.equal(sourceContextSchema.safeParse({ ...source, assessment: { ...assessment, gates: [...gates, ...gates.slice(0, 4)] } }).success, false);
});

test("model output cannot replace unknown raw stats with zero or claim calibrated confidence", async () => {
  const { capsule, assessment } = fixture(true);
  assert.equal(assessment.rawStats.creatorSharePercent, null);
  for (const answer of ["The earned score is 99.", "Creator holding is 0%.", "These are calibrated probabilities."]) await assert.rejects(askInvestigationQuestion("Explain the dev score", capsule, config, secret, { fetch: async () => completion(answer, "The scan is a past snapshot.") }), hasCode("INVALID_RESPONSE"));
});

test("an unassessed Insiders category can be explained without claiming human insider identity", async () => {
  const { capsule, assessment } = fixture(true);
  assert.equal(assessment.categories.find((row) => row.id === "insiders")!.points, null);
  const answer = await askInvestigationQuestion("Explain the insiders score", capsule, config, secret, { fetch: async () => completion("The Insiders category is unassessed, so it has no earned points.", "Its raw measurement remains unknown; this does not establish that insider activity is absent.") });
  assert.match(answer.answer, /category is unassessed/);
  assert.deepEqual(answer.evidenceIds, []);
});

test("older signed capsules remain valid and missing assessments remain unknown", async () => {
  const { context } = fixture();
  const oldContext = { ...context }; delete oldContext.assessment;
  const capsule = signedPayload(oldContext);
  verifyChatContext(capsule, config, secret);
  const answer = await askInvestigationQuestion("Why AVOID?", capsule, config, secret, { fetch: async (_url, init) => {
    assert.match(JSON.parse(String(init?.body)).messages[0].content, /Required answer grounding: unknown/);
    return completion("The verdict details are not supplied to this answer; check the report's Verdict panel.", "No score or weights can be inferred from missing metadata.");
  } });
  assert.equal(answer.needsFreshScan, true);
});
