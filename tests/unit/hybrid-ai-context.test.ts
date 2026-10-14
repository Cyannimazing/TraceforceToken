import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createChatContext, verifyChatContext } from "../../src/agents/chat-context";
import { readLocalAiConfiguration } from "../../src/agents/config";
import { createAssessmentSourceContext } from "../../src/agents/context";
import { askInvestigationQuestion, InvestigationQuestionError } from "../../src/agents/questions";
import { buildPlainLanguagePacket, restorePlainLanguageSummary } from "../../src/domain/investigations/plain-language-summary";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";
import { getBrowserSwarmAssessmentFixture, getBrowserSwarmSummaryFixture } from "../fixtures/swarm-report";

const secret = "synthetic-hybrid-context-secret-123456789012345";
const config = readLocalAiConfiguration({ LOCAL_AI_MODEL: "synthetic-hybrid-chat" });
const completion = (answer: string, caveat = "These are separate assessments at their stated scan times.") => new Response(JSON.stringify({ done: true, done_reason: "stop", message: { role: "assistant", content: JSON.stringify({ answer, caveat, evidenceIds: [], needsFreshScan: false }) } }), { headers: { "content-type": "application/json" } });
const hasCode = (code: InvestigationQuestionError["code"]) => (error: unknown) => error instanceof InvestigationQuestionError && error.code === code;
function fixture(external = true, primary = false, verdict: "AVOID" | "CAUTION" | "OK" = "OK") {
  const report = getBrowserWalletFlagsFixture();
  if (primary) report.assessmentAuthority = "swarm";
  if (external) {
    report.swarmAssessment = getBrowserSwarmAssessmentFixture(report);
    report.swarmAssessment.band = verdict === "AVOID" ? "DANGER" : verdict === "CAUTION" ? "RISKY" : "OK";
    report.swarmAssessment.judge.decision = verdict;
    report.swarmAssessment.judge.p = { avoid: verdict === "AVOID" ? 0.8 : 0.1, caution: verdict === "CAUTION" ? 0.8 : 0.1, ok: verdict === "OK" ? 0.8 : 0.1 };
    report.swarmAssessment.judge.confidence = 0.8;
  }
  const capsule = createChatContext(report, config, secret);
  return { report, capsule, context: verifyChatContext(capsule, config, secret) };
}

test("new signed authority keeps the primary source within unchanged metadata/proof budgets", () => {
  const { report, context } = fixture(true, true);
  assert.equal(context.assessmentAuthority, "swarm");
  assert.equal(context.swarmAssessment!.verdict, "OK");
  assert.equal(context.swarmAssessment!.score, 45);
  assert.equal(context.swarmAssessment!.header!.holders_count, 14);
  assert.equal(context.swarmAssessment!.metrics.wallets, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(context.swarmAssessment)) + (context.assessment ? Buffer.byteLength(JSON.stringify(context.assessment)) : 0) <= 4096);
  assert.ok(Buffer.byteLength(context.data) <= 6000);
  const old = fixture(true, false).context;
  assert.equal(context.data, old.data, "source metadata never replaces retained event facts");
  assert.deepEqual(context.citations, old.citations);
  assert.equal(context.model, config.model);
  assert.notEqual(context.model, report.swarmAssessment!.judge.model);
});

test("profile1.6 signed chat retains its strongest structured concentration warning below the large-impact threshold while legacy reasons stay unchanged", async () => {
  const contexts = new Map<string, ReturnType<typeof verifyChatContext>>();
  let currentCapsule = "";
  for (const profileVersion of ["1.5.0", "1.6.0"] as const) {
    const report = getBrowserSwarmSummaryFixture(), source = report.swarmAssessment!;
    source.metrics.dev = 0.999;
    source.metrics.biggest = 0.999;
    source.metrics.impact = 0.437;
    source.header.liquidity_usd = 564_140.7;
    source.gates = [];
    const options = { profileVersion }, packet = buildPlainLanguagePacket(report, options);
    report.explanation = { ...report.explanation, profileVersion,
      summary: restorePlainLanguageSummary(report, {
        reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id),
        ...(profileVersion === "1.6.0" ? { text: "SWARM reports 99.9% creator-linked holdings. These links do not establish ownership." } : {}),
      }, options),
    };
    const capsule = createChatContext(report, config, secret);
    contexts.set(profileVersion, verifyChatContext(capsule, config, secret));
    if (profileVersion === "1.6.0") currentCapsule = capsule;
  }
  const current = contexts.get("1.6.0")!.swarmAssessment!;
  assert.equal(current.metrics.dev, 0.999); assert.equal(current.metrics.biggest, 0.999);
  assert.equal(current.metrics.impact, 0.437); assert.equal(current.liquidityUsd, 564_140.7);
  assert.equal(current.reasons.length, 1);
  assert.match(current.reasons[0].reason, /wallets linked to the creator hold 99\.90%/);
  assert.doesNotMatch(current.reasons[0].reason, /largest.*wallet group/);
  assert.doesNotMatch(JSON.stringify(current.reasons), /private decision formula|43\.70% pool-price|thin liquidity/);
  const legacy = contexts.get("1.5.0")!.swarmAssessment!;
  assert.equal(legacy.reasons.length, 1);
  assert.equal(legacy.reasons[0].reason, "SWARM reports AVOID for this token.");
  assert.match(legacy.reasons[0].meaning, /private decision formula/);
  let calls = 0;
  const reply = "I would hold off: SWARM's verdict is AVOID and it reports 99.9% creator-linked holdings.";
  const answer = await askInvestigationQuestion("should i buy this token?", currentCapsule, config, secret, { fetch: async (_url, init) => {
    calls++;
    const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
    assert.deepEqual(supplied.reasons.map((reason: { meaning: string }) => reason.meaning), current.reasons.map((reason) => `${reason.meaning.split(";")[0]}.`));
    assert.equal(supplied.reasons[0].topic, "creator-linked holdings");
    assert.equal(supplied.reasons[0].reason, undefined);
    assert.doesNotMatch(JSON.stringify(supplied.reasons), /private decision formula/);
    return completion(reply);
  } });
  assert.equal(calls, 1); assert.equal(answer.answer, reply);
});

test("a realistic profile1.6 why follow-up retains the latest buy question and full AI reply within a 4096-token configuration", async (t) => {
  const report = getBrowserSwarmSummaryFixture(), source = report.swarmAssessment!;
  source.score = 55; source.band = "RISKY";
  source.parts = { swarm: 9.8, fresh: 20, insiders: 15, concentration: 0, snipers: 10, dev: 0 };
  source.metrics = { ...source.metrics, hands: 1, wallets: 33, dev: 0.999, biggest: 0.999, impact: 0.437 };
  source.header.liquidity_usd = 563_000;
  source.judge.decision = "CAUTION"; source.judge.p = { avoid: 0.421, caution: 0.551, ok: 0.028 }; source.judge.confidence = 0.551;
  source.gates = [];
  const options = { profileVersion: "1.6.0" as const }, packet = buildPlainLanguagePacket(report, options);
  report.explanation = { ...report.explanation, profileVersion: "1.6.0", summary: restorePlainLanguageSummary(report, {
    reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id),
    text: "SWARM reports 99.9% creator-linked holdings. Those links do not establish ownership.",
  }, options) };
  const boundedConfig = { ...config, contextTokens: 4096 };
  const capsule = createChatContext(report, boundedConfig, secret);
  const greeting = "Hi! Ask me about this token scan";
  const buyQuestion = "should i buy this token?";
  const buyReply = "I would hold off: SWARM reports that wallets linked to the creator hold 99.9% of the holdings used in its analysis. A large sale could move the price sharply; those links do not prove one owner or that a sale will happen now.";
  assert.equal(greeting.length, 32); assert.equal(buyReply.length, 225);
  let calls = 0;
  const answer = await askInvestigationQuestion("why?", capsule, boundedConfig, secret, {
    history: [{ role: "user", content: "hello" }, { role: "assistant", content: greeting }, { role: "user", content: buyQuestion }, { role: "assistant", content: buyReply }],
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const supplied = JSON.parse(body.messages[1].content);
      const recent = supplied.recentConversationUntrusted;
      t.diagnostic(JSON.stringify({ promptBytes: Buffer.byteLength(JSON.stringify(body.messages)), priorMessagesSent: recent.length, latestPairRetained: recent.at(-2)?.content === buyQuestion && recent.at(-1)?.content === buyReply }));
      assert.deepEqual(recent.at(-2), { role: "user", content: buyQuestion }, "a follow-up must retain its latest user topic");
      assert.deepEqual(recent.at(-1), { role: "assistant", content: buyReply }, "the model must see its latest reply to explain rather than repeat it");
      assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.score, undefined);
      assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.verdict, undefined, "a why follow-up receives its risk reasons without another action label");
      assert.equal(supplied.currentQuestionUntrusted, "why?");
      return completion("SWARM reports a concentrated creator-linked holding, so a large sale from it could move the price sharply.");
    },
  });
  assert.equal(calls, 1); assert.match(answer.answer, /large sale.*could move the price/);
  assert.equal(answer.needsFreshScan, false, "explaining the existing risk does not ask for newer activity");
});

test("a primary SWARM report still answers contract-holding definitions from the independent pinned table", async () => {
  const { capsule } = fixture(true, true, "CAUTION"); let calls = 0;
  const reply = "Contract holding means tokens held at an address with deployed code at the pinned block.";
  const answer = await askInvestigationQuestion("what is contract holding?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++;
    const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext;
    assert.ok(supplied.walletTable);
    assert.equal(supplied.swarmAssessment, undefined, "a general account-code definition is not a SWARM measurement");
    assert.match(supplied.walletTable.definition, /address with deployed code at the pinned block/);
    return completion(reply, "Account code does not prove ownership or whether those tokens are locked.");
  } });
  assert.equal(calls, 1); assert.equal(answer.answer, reply); assert.equal(answer.needsFreshScan, false);
});

test("a separate ownership caveat cannot rescue a positive claim that creator-linked wallets control holdings", async () => {
  const { report } = fixture(true, true, "CAUTION");
  report.swarmAssessment!.metrics.dev = 0.999; report.swarmAssessment!.metrics.biggest = 0.999;
  const capsule = createChatContext(report, config, secret); let calls = 0;
  await assert.rejects(askInvestigationQuestion("What is the creator holding?", capsule, config, secret, { fetch: async () => {
    calls++;
    return completion("SWARM reports CAUTION. Nearly all holdings are controlled by creator-linked wallets.", "The scan does not establish common ownership.");
  } }), hasCode("INVALID_RESPONSE"));
  assert.equal(calls, 1);
});

test("reported creator-linked balances can be explained naturally without claiming control or ownership", async () => {
  const { report } = fixture(true, true, "CAUTION");
  report.swarmAssessment!.metrics.dev = 0.999; report.swarmAssessment!.metrics.biggest = 0.999;
  const capsule = createChatContext(report, config, secret); let calls = 0;
  const reply = "Wallets linked to the creator hold 99.9% of the holdings in SWARM's analysis.";
  const caveat = "Those links do not establish who owns or controls the wallets.";
  const answer = await askInvestigationQuestion("What is the creator holding?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++;
    const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
    assert.equal(supplied.metrics.dev, 0.999);
    return completion(reply, caveat);
  } });
  assert.equal(calls, 1); assert.equal(answer.answer, reply); assert.equal(answer.caveat, caveat);
  assert.equal(answer.needsFreshScan, false);
});

test("ordinary score, verdict and source-float questions use the same primary SWARM snapshot", async () => {
  const { capsule } = fixture(true, true); let calls = 0;
  for (const question of ["Explain our verdict", "Why is the score 45?", "What does the top holders float mean?"]) {
    const answer = await askInvestigationQuestion(question, capsule, config, secret, { fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)), facts = JSON.parse(body.messages[1].content).authenticatedScanFacts;
      assert.deepEqual(Object.keys(facts.sourceContext), ["swarmAssessment"]);
      assert.equal(facts.sourceContext.swarmAssessment.verdict, "OK");
      assert.equal(facts.sourceContext.swarmAssessment.score, 45);
      assert.match(body.messages[0].content, /primary reported assessment/);
      return completion("SWARM's verdict is OK and its reported score is 45.");
    } });
    assert.match(answer.answer, /OK.*45/); assert.deepEqual(answer.evidenceIds, []);
  }
  assert.equal(calls, 3, "each accepted answer still invokes inference");
});

test("the exact greeting then buy-question flow invokes AI with the primary assessment and preserves its prose", async () => {
  const { capsule } = fixture(true, true, "AVOID");
  const reply = "I would skip this token: SWARM's verdict is AVOID because a large sale could sharply move its pool price.";
  let calls = 0;
  const result = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, {
    history: [{ role: "user", content: "hello" }, { role: "assistant", content: "Hello! How can I help you today?" }],
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const supplied = JSON.parse(body.messages[1].content);
      assert.equal(supplied.currentQuestionUntrusted, "should i buy this token?");
      assert.deepEqual(Object.keys(supplied.authenticatedScanFacts), ["sourceContext"]);
      assert.deepEqual(Object.keys(supplied.authenticatedScanFacts.sourceContext), ["swarmAssessment"]);
      assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.verdict, "AVOID");
      assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.score, undefined);
      assert.ok(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.reasons.length > 0);
      assert.equal(supplied.recentConversationUntrusted.length, 2);
      return completion(reply);
    },
  });
  assert.equal(calls, 1, "a report-based buy question must reach inference rather than a preset error");
  assert.equal(result.answer, reply, "the model writes the reply; the app must not replace it with a template");
  assert.deepEqual(result.evidenceIds, []);
  assert.equal(result.needsFreshScan, false, "interpreting an available report does not itself require a new scan");
});

test("ordinary primary-source guidance sends only its authenticated authority, verdict and selected reasons while preserving signed measurements", async () => {
  const { capsule, context } = fixture(true, true, "AVOID");
  const original = JSON.stringify(context.swarmAssessment);
  let calls = 0;
  for (const question of ["should i buy this token?", "What do you think?", "is it worth buying?", "should I sell this token?", "okay but why?"]) {
    const result = await askInvestigationQuestion(question, capsule, config, secret, {
      ...(question === "okay but why?" ? { history: [{ role: "user" as const, content: "should i buy this token?" }, { role: "assistant" as const, content: "SWARM's verdict is AVOID because a large sale could move its pool price sharply." }] } : {}),
      fetch: async (_url, init) => {
        calls++;
        const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
        assert.deepEqual(Object.keys(supplied).sort(), question === "okay but why?" ? ["authority", "limitation", "reasons", "source"] : ["authority", "limitation", "reasons", "source", "verdict"]);
        assert.equal(supplied.source, "SWARM"); assert.equal(supplied.authority, "source-reported"); assert.equal(supplied.verdict, question === "okay but why?" ? undefined : "AVOID");
        assert.deepEqual(supplied.reasons.map((reason: { meaning: string }) => reason.meaning), context.swarmAssessment!.reasons.map((reason) => `${reason.meaning.split(";")[0]}.`));
        assert.match(supplied.limitation, /SWARM.*snapshot.*not.*real-time/);
        assert.doesNotMatch(JSON.stringify(supplied.reasons), /ownership|one owner|sale will happen|transaction proof/);
        assert.ok(supplied.reasons.every((reason: { topic: string; reason?: unknown }) => typeof reason.topic === "string" && reason.reason === undefined));
        assert.doesNotMatch(JSON.stringify(supplied), /[0-9]|%|\$/);
        const body = JSON.parse(String(init?.body));
        for (const field of ["answer", "caveat"]) {
          const pattern = new RegExp(body.format.properties[field].pattern);
          assert.equal(pattern.test("SWARM reports AVOID because a large sale could sharply move the pool price."), true);
          assert.equal(pattern.test("SWARM reports 99.90% of its analyzed holdings."), false);
          assert.equal(pattern.test("SWARM's score is 55."), false);
        }
        const answerPattern = new RegExp(body.format.properties.answer.pattern);
        assert.equal(answerPattern.test("I would skip it because a large sale could sharply move the price."), false, "ordinary source guidance must generate its attribution");
        assert.equal(answerPattern.test("I would skip it. SWARM reports a hypothetical sale risk."), false, "source attribution begins the generated answer");
        assert.equal(answerPattern.test("SWARM reports a hypothetical sale risk. I would skip it."), false, "ordinary guidance generation stays within one sentence");
        assert.equal(body.format.properties.answer.maxLength, 240);
        assert.equal(body.format.properties.caveat.maxLength, 140);
        assert.equal(answerPattern.test("SWARM reports risk. I would skip it. This is a third sentence."), false);
        assert.equal(new RegExp(body.format.properties.caveat.pattern).test("This is a source-reported snapshot."), true, "the caveat need not repeat the assessment source");
        return completion("SWARM reports AVOID because a large sale could sharply move the pool price.");
      },
    });
    assert.equal(result.needsFreshScan, false);
  }
  assert.equal(calls, 5);
  assert.equal(JSON.stringify(verifyChatContext(capsule, config, secret).swarmAssessment), original, "outgoing projection must not mutate the signed assessment or post-response facts");
});

test("mixed guidance and explicit numeric questions retain the full authenticated source fields", async () => {
  const { capsule, context } = fixture(true, true, "AVOID"); let calls = 0;
  for (const question of [
    "Should I buy this token, and what is its score?",
    "What's your take, and what category points are reported?",
    "Is it worth buying, and what are the confidence and decision weights?",
    "Should I buy this token, and how many holders, wallets and hands are reported?",
    "What's your take on its price, liquidity, market cap and volume?",
    "Should I buy this token, and what percentage of holdings is creator-linked?",
    "What's your take, and when was SWARM checked?",
  ]) {
    let supplied: unknown;
    await askInvestigationQuestion(question, capsule, config, secret, { fetch: async (_url, init) => {
      calls++;
      supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
      const body = JSON.parse(String(init?.body));
      assert.equal(new RegExp(body.format.properties.answer.pattern).test("SWARM's reported score is 45."), true, "explicit measurement answers retain numeric provider grammar");
      return completion("SWARM's verdict is AVOID and its reported score is 45.");
    } });
    assert.deepEqual(supplied, context.swarmAssessment, question);
  }
  assert.equal(calls, 7);
});

test("guidance input minimization does not remove full-source score checks after generation", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  await assert.rejects(askInvestigationQuestion("What do you think?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++;
    const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
    assert.equal(supplied.score, undefined);
    return completion("SWARM's verdict is AVOID and its score is 99.");
  } }), hasCode("INVALID_RESPONSE"));
  assert.equal(calls, 1);
});

test("a why projection omits the verdict label without weakening the signed verdict guard", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  await assert.rejects(askInvestigationQuestion("okay but why?", capsule, config, secret, {
    history: [{ role: "user", content: "should i buy this token?" }, { role: "assistant", content: "SWARM reports AVOID because a large sale could sharply move the price." }],
    fetch: async (_url, init) => {
      calls++;
      const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
      assert.equal(supplied.verdict, undefined); assert.ok(supplied.reasons.length > 0);
      return completion("SWARM's verdict is OK because the source reports no higher warning.");
    },
  }), hasCode("INVALID_RESPONSE"));
  assert.equal(calls, 1);
});

test("source guidance with no concrete reported reason supplies that uncertainty rather than a manufactured price risk", async () => {
  const report = getBrowserSwarmSummaryFixture(), source = report.swarmAssessment!;
  source.metrics.dev = 0; source.metrics.biggest = 0; source.metrics.impact = 0; source.metrics.concentration = 0;
  source.header.liquidity_usd = 563_000; source.gates = [];
  const options = { profileVersion: "1.6.0" as const }, packet = buildPlainLanguagePacket(report, options);
  report.explanation = { ...report.explanation, profileVersion: "1.6.0", summary: restorePlainLanguageSummary(report, {
    reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id),
    text: "SWARM reports AVOID without a specific reason supplied in this result.",
  }, options) };
  const capsule = createChatContext(report, config, secret); let calls = 0;
  const reply = "SWARM reports AVOID without a specific reason in this result.";
  const result = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++;
    const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
    assert.deepEqual(supplied.reasons, [{ topic: "reported assessment", meaning: "A specific reason for this verdict is not supplied in this result." }]);
    assert.doesNotMatch(JSON.stringify(supplied.reasons), /selling|concentrat|price.*(?:move|drop)/i);
    return completion(reply, "This is SWARM's reported snapshot, not a real-time assessment.");
  } });
  assert.equal(result.answer, reply); assert.equal(calls, 1);
});

test("the assessment provider cannot become an invented token identity", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  for (const answer of [
    "AVOID buying SWARM tokens because selling them could cause a sharp price move.",
    "SWARM's tokens could move sharply in price if sold.",
    "SWARM coins have a hypothetical sale risk.",
  ]) await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
    calls++; return completion(answer, "This is a source-reported snapshot.");
  } }), hasCode("INVALID_RESPONSE"));
  const reply = "SWARM's token assessment is AVOID because a large sale could sharply move this token's price.";
  const result = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
    calls++; return completion(reply, "This is a source-reported snapshot.");
  } });
  assert.equal(result.answer, reply); assert.equal(calls, 4);
});

test("a hypothetical source warning supports skipping a purchase rather than certifying that the token is unsafe", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const supported = "SWARM advises skipping this token because a large sale could move the price sharply.";
  for (const unsupported of [
    "SWARM reports conditional sale risk, making it unsafe to hold or buy.",
    "SWARM reports AVOID because this token is unsafe.",
  ]) for (const field of ["answer", "caveat"] as const) {
    await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++; return completion(field === "answer" ? unsupported : supported, field === "caveat" ? unsupported : "This is a source-reported snapshot.");
    } }), hasCode("INVALID_RESPONSE"));
  }
  const caveat = "This estimate does not establish that this token is unsafe.";
  const result = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
    calls++; return completion(supported, caveat);
  } });
  assert.equal(result.answer, supported); assert.equal(result.caveat, caveat); assert.equal(calls, 5);
});

test("duplicate generated keys cannot hide an invalid answer or invented citation behind a valid final value", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const valid = { answer: "SWARM advises skipping this token because a large sale could move the price sharply.", caveat: "This is a source-reported snapshot.", evidenceIds: [], needsFreshScan: false };
  for (const [key, hidden] of [["answer", "Buy SWARM tokens now."], ["caveat", "No transaction proof exists."], ["evidenceIds", ["A-SC-HP-CT-CL"]]] as const) {
    const generated = `{${JSON.stringify(key)}:${JSON.stringify(hidden)},${JSON.stringify(valid).slice(1)}`;
    assert.deepEqual(JSON.parse(generated), valid, "ordinary JSON parsing would silently retain valid final fields");
    await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ done: true, done_reason: "stop", message: { role: "assistant", content: generated } }), { headers: { "content-type": "application/json" } });
    } }), hasCode("INVALID_RESPONSE"), key);
  }
  assert.equal(calls, 3);
});

test("qualitative guidance projects positive canonical risk clauses and one snapshot limit without erasing signed caveats", async () => {
  const report = getBrowserSwarmSummaryFixture(), source = report.swarmAssessment!;
  source.metrics.dev = 1; source.metrics.biggest = 1; source.metrics.impact = 1;
  source.header.liquidity_usd = 563_000;
  const options = { profileVersion: "1.6.0" as const }, packet = buildPlainLanguagePacket(report, options);
  report.explanation = { ...report.explanation, profileVersion: "1.6.0", summary: restorePlainLanguageSummary(report, {
    reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id),
    text: "SWARM reports creator-linked holdings and hypothetical sale risk. Those links do not establish ownership.",
  }, options) };
  const capsule = createChatContext(report, config, secret), original = verifyChatContext(capsule, config, secret);
  assert.equal(original.swarmAssessment!.reasons.length, 2);
  const result = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async (_url, init) => {
    const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext.swarmAssessment;
    assert.deepEqual(supplied.reasons, [
      { topic: "hypothetical sale impact", meaning: "Selling could move the price heavily." },
      { topic: "creator-linked holdings", meaning: "If those tokens are sold, the price could move sharply." },
    ]);
    assert.match(supplied.limitation, /reported snapshot.*not a real-time/);
    assert.doesNotMatch(JSON.stringify(supplied), /[0-9]|%|ownership|one owner|no sale|no transaction proof/);
    return completion("I would skip it: SWARM reports AVOID because a large sale could sharply move the price.", "This describes SWARM's source snapshot, not live activity.");
  } });
  assert.equal(result.needsFreshScan, false);
  const retained = verifyChatContext(capsule, config, secret).swarmAssessment!;
  assert.deepEqual(retained, original.swarmAssessment);
  assert.match(retained.reasons[1].meaning, /links do not prove one owner or that a sale will happen/);
});

test("source holding percentages must retain the SWARM-analysis basis in each generated clause", async () => {
  const report = getBrowserSwarmSummaryFixture(), source = report.swarmAssessment!;
  source.metrics.dev = 0.999; source.metrics.biggest = 0.999;
  const options = { profileVersion: "1.6.0" as const }, packet = buildPlainLanguagePacket(report, options);
  report.explanation = { ...report.explanation, profileVersion: "1.6.0", summary: restorePlainLanguageSummary(report, {
    reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id),
    text: "SWARM reports 99.9% creator-linked holdings. Those links do not establish ownership.",
  }, options) };
  const capsule = createChatContext(report, config, secret);
  const history = [{ role: "user" as const, content: "should i buy this token?" }, { role: "assistant" as const, content: "SWARM reports AVOID due to concentrated holdings." }];
  let calls = 0;
  for (const unsupported of [
    "SWARM identifies extreme concentration—99.90% of tokens held by creator-linked wallets—meaning a sale by those holders could cause a sharp price drop.",
    "SWARM reports 99.9% of holdings held by wallets linked to the creator.",
    "SWARM reports 99.9% of total token supply held by wallets linked to the creator.",
    "SWARM reports 99.9% of holdings in its float, but 99.9% of all tokens are held by creator-linked wallets.",
  ]) for (const field of ["answer", "caveat"] as const) {
    await assert.rejects(askInvestigationQuestion("okay but why?", capsule, config, secret, { history, fetch: async () => {
      calls++;
      return completion(field === "answer" ? unsupported : "SWARM reports AVOID due to concentrated creator-linked holdings.", field === "caveat" ? unsupported : "Those links do not establish common ownership.");
    } }), hasCode("INVALID_RESPONSE"), `${field}: ${unsupported}`);
  }
  for (const reply of [
    "SWARM reports creator-linked wallets hold 99.90% of holdings in SWARM's analysis.",
    "SWARM reports creator-linked wallets hold 99.9% of tokens in its float.",
    "Creator-linked wallets hold 99.9% of SWARM's analyzed holdings.",
    "SWARM reports a highly concentrated holding, so a large sale could move the price sharply.",
  ]) {
    const result = await askInvestigationQuestion("okay but why?", capsule, config, secret, { history, fetch: async () => {
      calls++; return completion(reply, "Those links do not establish common ownership.");
    } });
    assert.equal(result.answer, reply, "supported model phrasing must survive unchanged rather than receiving a replacement denominator");
    assert.equal(result.needsFreshScan, false);
  }
  assert.equal(calls, 12);
});

test("source liquidity and sale-impact metadata cannot establish that a transaction will or cannot execute", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const guidance = "I would skip this token: SWARM's verdict is AVOID because low liquidity makes its price easy to move.";
  const unsupported = [
    "Liquidity is extremely low, so no real transaction could execute safely.",
    "Selling is impossible because liquidity is low.",
    "This token cannot be sold.",
    "You can sell this token now.",
    "A sale will execute successfully.",
    "This scan cannot establish whether a sale can execute, but selling is impossible.",
    "Execution is unverified, but you can sell it now.",
  ];
  for (const claim of unsupported) for (const field of ["answer", "caveat"] as const) {
    await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++;
      return completion(field === "answer" ? `${guidance} ${claim}` : guidance, field === "caveat" ? claim : undefined);
    } }), hasCode("INVALID_RESPONSE"), `${field}: ${claim}`);
  }
  assert.equal(calls, unsupported.length * 2, "unsupported execution claims are checked in both generated fields after inference");
});

test("source-based buy guidance preserves genuine execution uncertainty without adding a refresh requirement", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const guidance = "I would skip this token: SWARM's verdict is AVOID because low liquidity makes its price easy to move.";
  for (const caveat of [
    "This scan cannot establish whether a sale can execute; it does not include a transaction simulation.",
    "The report does not verify whether this token can be sold.",
    "Execution is unverified; the source's price-impact estimate is not a successful sale.",
  ]) {
    const answer = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++;
      return completion(guidance, caveat);
    } });
    assert.equal(answer.answer, guidance); assert.equal(answer.caveat, caveat);
    assert.equal(answer.needsFreshScan, false); assert.deepEqual(answer.evidenceIds, []);
  }
  assert.equal(calls, 3);
});

test("metadata-only guidance cannot invent the absence of observed or confirmed sales", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const guidance = "SWARM advises avoiding this token because a large sale could cause sharp price movements.";
  const unsupportedClaims = [
    "SWARM advises avoiding this token because creator-linked holdings could cause sharp price movements if sold, though no sale is confirmed.",
    "SWARM advises AVOID due to hypothetical sale impact and creator-linked holdings that could sharply move prices—no actual sale or ownership is confirmed.",
    "No ownership or trade is confirmed.",
    "No actual ownership, sale or recorded trade has been confirmed.",
    "There are no actual trades or confirmed sales.",
    "No sales were recorded.",
    "No verified sale has been observed.",
    "There are no confirmed sales.",
    "The scan confirms no actual sales.",
    "No sale has occurred.",
  ];
  for (const unsupported of unsupportedClaims) for (const field of ["answer", "caveat"] as const) {
    await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++; return completion(field === "answer" ? `${guidance} ${unsupported}` : guidance, field === "caveat" ? unsupported : "This is a source-reported hypothetical estimate.");
    } }), hasCode("INVALID_RESPONSE"), `${field}: ${unsupported}`);
  }
  assert.equal(calls, unsupportedClaims.length * 2, "each unsupported negative observation is rejected after actual model invocation in either prose field");
});

test("metadata-only guidance preserves conditional sale uncertainty without replacing the AI reply", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const guidance = "SWARM advises avoiding this token because a large sale could sharply move its pool price.";
  for (const caveat of [
    "The source's hypothetical risk does not establish whether a sale occurred.",
    "These links do not prove a sale will happen.",
    "Only a hypothetical price effect is supplied; actual sales remain unknown here.",
    "These links do not establish common ownership or whether a trade occurred.",
  ]) {
    const result = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++; return completion(guidance, caveat);
    } });
    assert.equal(result.answer, guidance); assert.equal(result.caveat, caveat); assert.equal(result.needsFreshScan, false);
  }
  assert.equal(calls, 4);
});

test("metadata cannot erase transaction proof from the full report with an unscoped absence assertion", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const guidance = "SWARM advises avoiding this token because a large sale could sharply move the price.";
  for (const claim of [
    "The assessment is based on a snapshot and does not confirm actual sales or ownership; no transaction proof exists.",
    "No transaction proof is supplied.", "No sale evidence is available.", "No trade records exist.",
    "The report has no transfer receipts.", "No proof of transactions is provided.",
    "No transaction proof exists in this report.",
  ]) for (const field of ["answer", "caveat"] as const) {
    await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++; return completion(field === "answer" ? `${guidance} ${claim}` : guidance, field === "caveat" ? claim : "This is a source-reported snapshot.");
    } }), hasCode("INVALID_RESPONSE"), `${field}: ${claim}`);
  }
  assert.equal(calls, 14);
});

test("explicit missing-input scope and conditional sale uncertainty do not become whole-report absence claims", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const guidance = "SWARM advises avoiding this token because a large sale could sharply move the price.";
  for (const caveat of [
    "No transaction proof is supplied to this metadata answer.",
    "No sale evidence is supplied in this reply.",
    "This hypothetical estimate is not transaction proof.",
    "This estimate cannot establish whether a sale occurred.",
  ]) {
    const result = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++; return completion(guidance, caveat);
    } });
    assert.equal(result.answer, guidance); assert.equal(result.caveat, caveat); assert.equal(result.needsFreshScan, false);
  }
  assert.equal(calls, 4);
});

test("ordinary recommendation, safety and sell wording routes to the primary SWARM risk assessment", async () => {
  const questions = ["is it worth buying?", "would you recommend this token?", "is this token safe?", "should I sell this token?"];
  for (const verdict of ["AVOID", "CAUTION", "OK"] as const) {
    const { capsule } = fixture(true, true, verdict); let calls = 0;
    const reply = verdict === "AVOID" ? "I would skip this token: SWARM's verdict is AVOID because its sale model shows a warning."
      : verdict === "CAUTION" ? "I would hold off for now: SWARM's verdict is CAUTION, so this scan does not support a clear go-ahead."
      : "SWARM's verdict is OK in this scan, meaning its reported checks did not trigger a higher warning; that does not establish it is safe.";
    for (const question of questions) {
      const answer = await askInvestigationQuestion(question, capsule, config, secret, { fetch: async (_url, init) => {
        calls++;
        const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts;
        assert.deepEqual(Object.keys(supplied.sourceContext), ["swarmAssessment"]);
        assert.equal(supplied.sourceContext.swarmAssessment.verdict, verdict);
        return completion(reply);
      } });
      assert.equal(answer.answer, reply); assert.deepEqual(answer.evidenceIds, []);
    }
    assert.equal(calls, questions.length, `${verdict}: every accepted wording invokes the model`);
  }
});

test("ordinary opinion questions invoke AI with the current assessment and recent conversation as separate untrusted context", async () => {
  const { capsule } = fixture(true, true, "CAUTION"); let calls = 0;
  const questions = ["What do you think?", "What's your take?", "Your opinion?", "Is it worth it?"];
  const replies = [
    "I would hold off: SWARM's verdict is CAUTION, so this report does not give a clear go-ahead.",
    "SWARM's verdict is CAUTION; I would check the risks before considering it.",
    "I would be cautious with this token because SWARM's verdict is CAUTION.",
    "SWARM's verdict is CAUTION, so I would not treat it as an easy buy.",
  ];
  for (const [index, question] of questions.entries()) {
    const answer = await askInvestigationQuestion(question, capsule, config, secret, {
      history: [{ role: "user", content: "Should I buy this token?" }, { role: "assistant", content: "Earlier assistant text incorrectly said SWARM's score was 99 and the verdict was OK." }],
      fetch: async (_url, init) => {
        calls++;
        const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        assert.equal(supplied.currentQuestionUntrusted, question);
        assert.equal(supplied.recentConversationUntrusted.length, 2);
        assert.match(supplied.recentConversationUntrusted[1].content, /99/);
        assert.deepEqual(Object.keys(supplied.authenticatedScanFacts.sourceContext), ["swarmAssessment"]);
        assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.verdict, "CAUTION");
        assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.score, undefined);
        assert.equal(JSON.stringify(supplied.authenticatedScanFacts).includes("99"), false);
        return completion(replies[index]);
      },
    });
    assert.equal(answer.answer, replies[index], "each distinct model reply is preserved without a preset answer");
    assert.deepEqual(answer.evidenceIds, []);
  }
  assert.equal(calls, questions.length);
});

test("ambiguous follow-ups to buy questions reuse signed primary facts rather than previous assistant claims", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  const questions = ["why?", "explain simply", "okay but why?", "why though?", "are you sure?", "explain that like I'm new"];
  for (const question of questions) {
    const reply = "SWARM's verdict is AVOID because a large sale could sharply move the pool price.";
    const answer = await askInvestigationQuestion(question, capsule, config, secret, {
      history: [{ role: "user", content: "should i buy this token?" }, { role: "assistant", content: "Earlier assistant text incorrectly said the score was 99." }],
      fetch: async (_url, init) => {
        calls++;
        const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        assert.equal(supplied.currentQuestionUntrusted, question);
        assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.score, undefined);
        assert.equal(supplied.authenticatedScanFacts.sourceContext.swarmAssessment.verdict, undefined);
        assert.equal(JSON.stringify(supplied.authenticatedScanFacts).includes("99"), false);
        assert.equal(supplied.recentConversationUntrusted.length, 2);
        assert.match(supplied.recentConversationUntrusted[1].content, /99/);
        return completion(reply);
      },
    });
    assert.equal(answer.answer, reply);
  }
  assert.equal(calls, questions.length);
});

test("natural negated buy and ownership statements remain AI prose without hiding a contradictory second clause", async () => {
  const { capsule } = fixture(true, true, "AVOID"); let calls = 0;
  for (const reply of [
    "I don't think you should buy this token: SWARM's verdict is AVOID.",
    "SWARM's verdict is AVOID. These links do not prove the same owner.",
  ]) {
    const answer = await askInvestigationQuestion("What do you think?", capsule, config, secret, { fetch: async () => {
      calls++;
      return completion(reply);
    } });
    assert.equal(answer.answer, reply);
  }
  for (const reply of [
    "I don't think you should buy this token; however, you should buy it. SWARM's verdict is AVOID.",
    "SWARM's verdict is AVOID. These links do not prove the same owner; these wallets have a common owner.",
  ]) await assert.rejects(askInvestigationQuestion("What do you think?", capsule, config, secret, { fetch: async () => {
    calls++;
    return completion(reply);
  } }), hasCode("INVALID_RESPONSE"), reply);
  assert.equal(calls, 4);
});

test("legacy report buy questions use the local assessment without substituting contradictory SWARM figures", async () => {
  const { capsule } = fixture(true, false, "OK"); let calls = 0;
  const reply = "I would skip this token: TraceForge's verdict is AVOID because its sale model shows a warning.";
  const answer = await askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++;
    const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts;
    assert.deepEqual(Object.keys(supplied.sourceContext), ["assessment"]);
    assert.equal(supplied.sourceContext.assessment.verdict, "AVOID");
    return completion(reply);
  } });
  assert.equal(calls, 1); assert.equal(answer.answer, reply); assert.deepEqual(answer.evidenceIds, []);
});

test("missing primary assessment still invokes AI for buy guidance without replacing missing data with local warnings", async () => {
  const { capsule, context } = fixture(false, true); let calls = 0;
  assert.equal(context.assessment!.verdict, "AVOID");
  const questions = ["should i buy this token?", "What's your take?"];
  const replies = ["I cannot give this token a go-ahead because SWARM's assessment is unavailable in this scan.", "I can't assess this token from this report because SWARM's result is unavailable here."];
  for (const [index, question] of questions.entries()) {
    const answer = await askInvestigationQuestion(question, capsule, config, secret, { fetch: async (_url, init) => {
      calls++;
      const supplied = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts;
      assert.equal(supplied.sourceContext?.assessment, undefined);
      assert.equal(supplied.sourceContext?.swarmAssessment, undefined);
      return completion(replies[index]);
    } });
    assert.equal(answer.answer, replies[index]); assert.equal(answer.needsFreshScan, true);
  }
  assert.equal(calls, questions.length);
});

test("AI cannot turn AVOID, CAUTION or unavailable assessments into a buy endorsement or guaranteed return", async () => {
  for (const verdict of ["AVOID", "CAUTION", null] as const) {
    const { capsule } = fixture(verdict !== null, true, verdict ?? "OK"); let calls = 0;
    const source = verdict ? `SWARM's verdict is ${verdict}. ` : "SWARM's assessment is unavailable. ";
    for (const recommendation of ["Yes, buy this token now.", "Go ahead and buy it.", "I recommend buying this token.", "This token guarantees profits.", "This token is safe.", "This token is safe, though profits are not guaranteed.", "SWARM identifies these wallets as the same owner."]) {
      await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
        calls++;
        return completion(`${source}${recommendation}`);
      } }), hasCode("INVALID_RESPONSE"), `${verdict ?? "unavailable"}: ${recommendation}`);
    }
    assert.equal(calls, 7, "model output must be checked after inference, not replaced with an input menu error");
  }
});

test("a report-based buy question never gets a preset successful answer when inference fails", async () => {
  let calls = 0;
  for (const available of [true, false]) {
    const { capsule } = fixture(available, true, "AVOID");
    await assert.rejects(askInvestigationQuestion("should i buy this token?", capsule, config, secret, { fetch: async () => {
      calls++;
      throw new Error("Synthetic inference outage.");
    } }), hasCode("UNAVAILABLE"));
  }
  assert.equal(calls, 2);
});

test("primary header holder count is distinct from source wallets/groups and independent GoPlus", async () => {
  const { capsule } = fixture(true, true);
  const holders = await askInvestigationQuestion("How many holders does the token have?", capsule, config, secret, { fetch: async (_url, init) => {
    const source = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts.sourceContext;
    assert.deepEqual(Object.keys(source), ["swarmAssessment"]);
    assert.equal(source.swarmAssessment.header.holders_count, 14);
    assert.equal(source.swarmAssessment.metrics.wallets, 12);
    return completion("SWARM reports 14 holders; its examined cohort contains 12 wallets.");
  } });
  assert.match(holders.answer, /14 holders.*12 wallets/);
  const groups = await askInvestigationQuestion("What does 12 real hands mean?", capsule, config, secret, { fetch: async () => completion("SWARM reports 12 inferred groups for 12 wallets; these are not verified people or owners.") });
  assert.match(groups.answer, /not verified people/);
  for (const answer of ["SWARM reports 12 holders.", "SWARM reports 14 holders at the pinned block.", "SWARM reports 6 inferred groups.", "SWARM reports 14 holders; its cohort has 13 wallets.", "SWARM reports 12 real owners."]) {
    await assert.rejects(askInvestigationQuestion("How many holders and groups are reported?", capsule, config, secret, { fetch: async () => completion(answer) }), hasCode("INVALID_RESPONSE"), answer);
  }
});

test("primary source answers cannot silently use local verdict, invented score or calibrated confidence", async () => {
  const { capsule } = fixture(true, true);
  for (const answer of ["AVOID, according to SWARM.", "SWARM's verdict is AVOID.", "SWARM's score is 99.", "SWARM reports OK. The score is 99.", "SWARM reports OK with calibrated probabilities.", "SWARM reports OK. The snipers category score is 10."]) {
    await assert.rejects(askInvestigationQuestion("Explain our verdict and score", capsule, config, secret, { fetch: async () => completion(answer) }), hasCode("INVALID_RESPONSE"));
  }
});

test("unavailable primary source never substitutes its independent local warning", async () => {
  const { capsule, context } = fixture(false, true);
  assert.equal(context.assessmentAuthority, "swarm"); assert.equal(context.assessment!.verdict, "AVOID");
  const answer = await askInvestigationQuestion("Explain our verdict", capsule, config, secret, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /primary authority is SWARM/);
    assert.match(body.messages[0].content, /never substitute the independent local score/);
    assert.equal(JSON.parse(body.messages[1].content).authenticatedScanFacts.sourceContext?.assessment, undefined);
    return completion("SWARM's assessment is not supplied to this chat; its verdict is unavailable here.");
  } });
  assert.equal(answer.needsFreshScan, true);
  for (const answer of ["The verdict is AVOID because of local warnings; SWARM is unavailable.", "SWARM is unavailable; the score is 0.", "OK: SWARM is not supplied here."]) {
    await assert.rejects(askInvestigationQuestion("Explain our verdict", capsule, config, secret, { fetch: async () => completion(answer) }), hasCode("INVALID_RESPONSE"));
  }
});

test("explicit independent local checks remain separate from the primary source", async () => {
  const { capsule, context } = fixture(true, true);
  assert.ok(context.assessment, "this small fixture fits both lanes within the same byte cap");
  const answer = await askInvestigationQuestion("Explain the independent local verdict", capsule, config, secret, { fetch: async (_url, init) => {
    const facts = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).authenticatedScanFacts;
    assert.equal(facts.sourceContext.assessment.verdict, "AVOID");
    assert.equal(facts.sourceContext.swarmAssessment, undefined);
    return completion("The independent local verdict is AVOID because its hypothetical sale model shows a warning.");
  } });
  assert.match(answer.answer, /independent local verdict is AVOID/);
});
function signedPayload(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `v1.${payload}.${createHmac("sha256", secret).update(`traceforce-scan-questions:v1\0${payload}`).digest("base64url")}`;
}

test("signed local assessment stays primary while a contradictory external assessment remains separately attributed", () => {
  const { report, context } = fixture();
  assert.deepEqual(context.assessment, createAssessmentSourceContext(report));
  assert.equal(context.assessment!.verdict, "AVOID");
  assert.equal(context.swarmAssessment!.verdict, "OK");
  assert.equal(context.swarmAssessment!.source, "SWARM");
  assert.ok(Buffer.byteLength(JSON.stringify(context.assessment)) + Buffer.byteLength(JSON.stringify(context.swarmAssessment)) <= 4096);
  assert.ok(Buffer.byteLength(context.data) <= 6000);
});

test("ordinary verdict questions supply the local assessment without external numbers", async () => {
  const { capsule } = fixture(); let calls = 0;
  const answer = await askInvestigationQuestion("Why AVOID?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)), facts = JSON.parse(body.messages[1].content).authenticatedScanFacts;
    assert.deepEqual(Object.keys(facts.sourceContext), ["assessment"]);
    assert.equal(facts.sourceContext.assessment.verdict, "AVOID");
    assert.match(body.messages[0].content, /TraceForge's own deterministic rule output/);
    return completion("TraceForge's verdict is AVOID because a large sale could sharply move the pool price.");
  } });
  assert.equal(calls, 1);
  assert.match(answer.answer, /AVOID/);
});

test("explicit comparison supplies both attributed outcomes without inventing a discrepancy cause", async () => {
  const { capsule } = fixture();
  const answer = await askInvestigationQuestion("Compare our verdict with SWARM's report.", capsule, config, secret, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), facts = JSON.parse(body.messages[1].content).authenticatedScanFacts;
    assert.equal(facts.sourceContext.assessment.verdict, "AVOID");
    assert.equal(facts.sourceContext.swarmAssessment.verdict, "OK");
    assert.match(body.messages[0].content, /do not invent a hidden formula or a reason for a discrepancy/);
    return completion("TraceForge's verdict is AVOID. SWARM's verdict is OK; these are separate assessments.");
  } });
  assert.match(answer.answer, /TraceForge.*AVOID/);
  assert.match(answer.answer, /SWARM.*OK/);
  assert.deepEqual(answer.evidenceIds, []);
});

test("missing external assessment stays unavailable and does not block a local explanation", async () => {
  const { capsule } = fixture(false);
  const answer = await askInvestigationQuestion("Why is our verdict different from SWARM's report?", capsule, config, secret, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), facts = JSON.parse(body.messages[1].content).authenticatedScanFacts;
    assert.equal(facts.sourceContext.swarmAssessment, undefined);
    assert.equal(facts.sourceContext.assessment.verdict, "AVOID");
    assert.match(body.messages[0].content, /No SWARM assessment is supplied/);
    return completion("TraceForge's verdict is AVOID. SWARM's result is not supplied to this chat, so I cannot compare them here.");
  } });
  assert.match(answer.answer, /cannot compare/);
});

test("AI cannot replace the primary verdict or an explicitly attributed external score", async () => {
  const { capsule } = fixture();
  for (const answer of ["The verdict is OK.", "OK: no warning found.", "TraceForge's verdict is OK."]) {
    await assert.rejects(askInvestigationQuestion("Explain our verdict", capsule, config, secret, { fetch: async () => completion(answer) }), hasCode("INVALID_RESPONSE"));
  }
  await assert.rejects(askInvestigationQuestion("Compare our score with SWARM's report", capsule, config, secret, { fetch: async () => completion("TraceForge's verdict is AVOID. SWARM's score is 99.") }), hasCode("INVALID_RESPONSE"));
});

test("legacy 1.4 capsules remain usable and external-only legacy context does not masquerade as our verdict", async () => {
  const { context } = fixture(), legacy = { ...context, profileVersion: "1.4.0", assessment: context.swarmAssessment };
  delete legacy.swarmAssessment;
  const capsule = signedPayload(legacy);
  assert.equal(verifyChatContext(capsule, config, secret).profileVersion, "1.4.0");
  const answer = await askInvestigationQuestion("Explain our verdict", capsule, config, secret, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.messages[0].content, /Required answer grounding: unknown/);
    return completion("The local verdict details are not supplied to this answer; check the report's verdict panel.");
  } });
  assert.equal(answer.needsFreshScan, true);
});
