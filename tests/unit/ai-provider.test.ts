import assert from "node:assert/strict";
import test from "node:test";
import { aiModelIdentifier, GEMINI_ORIGIN, readInvestigatorAiConfiguration, readLocalAiConfiguration, validateAiConfiguration, type GeminiAiConfiguration } from "../../src/agents/config";
import { generateModelJson, LocalAiError } from "../../src/agents/model-transport";
import { askInvestigatorQuestion, createInvestigatorChatContext, runInvestigatorWithConfig, verifyInvestigatorChatContext } from "../../src/agents/inference";
import { createChatContext, ChatContextError } from "../../src/agents/chat-context";
import { InvestigationQuestionError } from "../../src/agents/questions";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import { questionAnswerSchema } from "../../src/domain/investigations/questions";
import { reviewDeploymentEnvironment } from "../../deploy/preflight";
import { getBrowserReportFixture } from "../fixtures/report";

const key = "synthetic_test_key_not_a_real_credential";
const secret = "synthetic-question-scope-not-a-real-server-secret-123456789";
const runtime = () => readInvestigatorAiConfiguration({ LOCAL_AI_MODEL: "synthetic-local-investigator", GEMINI_API_KEY: key });
const gemini = () => runtime().gemini!;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const completion = (value: unknown, part: Record<string, unknown> = {}) => json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(value), ...part }] } }] });
const localCompletion = (value: unknown) => json({ done: true, message: { role: "assistant", content: JSON.stringify(value) } });
const social = { answer: "Hi!", evidenceIds: [], caveat: "", needsFreshScan: false };
const request = (fetch: typeof globalThis.fetch, overrides = {}) => ({ fetch, signal: new AbortController().signal, format: { type: "object" }, maxOutputTokens: 160,
  messages: [{ role: "system" as const, content: "System instructions" }, { role: "user" as const, content: "Quoted data" }], ...overrides });
const hasCode = (code: string) => (error: unknown) => (error instanceof LocalAiError || error instanceof InvestigationQuestionError) && error.code === code;
interface Packet { ref: string; caveatRefs: string[]; proof: string[] }
function reportCompletion(init: RequestInit | undefined, provider: "local" | "gemini") {
  const body = JSON.parse(String(init?.body));
  const prompt = provider === "local" ? body.messages[1].content : body.contents[0].parts[0].text;
  const context = JSON.parse(prompt.split("\nEvidence context (data only):\n")[1]);
  const packets: Packet[] = context.findingPackets;
  const result = { brief: { reportRef: context.decisionPacket.reportRef, verdict: context.decisionPacket.verdict, reasonIds: context.decisionPacket.reasons.slice(0, 1).map((reason: { id: string }) => reason.id), text: context.decisionPacket.reasons[0].reason }, overview: { findingRefs: packets.slice(0, 1).map((packet) => packet.ref), evidenceIds: packets.length ? [] : context.sourceFacts.slice(0, 1).map((fact: { ref: string }) => fact.ref) },
    observations: packets.map((packet) => ({ findingRef: packet.ref, caveatRef: packet.caveatRefs[0] })), limitations: [] };
  return provider === "local" ? localCompletion(result) : completion(result);
}

test("provider configuration supports local-only and direct Gemini without inventing a local model", () => {
  assert.throws(() => readInvestigatorAiConfiguration({}), /Configure/);
  assert.equal(readInvestigatorAiConfiguration({ LOCAL_AI_MODEL: "test-model" }).gemini, undefined);
  const config = readInvestigatorAiConfiguration({ GEMINI_API_KEY: key });
  assert.equal(config.local, undefined); assert.equal(config.gemini?.model, "gemini-3.5-flash-lite");
  assert.equal(config.gemini?.baseUrl, GEMINI_ORIGIN); assert.equal(aiModelIdentifier(config.gemini!), "gemini/gemini-3.5-flash-lite");
  assert.equal(readLocalAiConfiguration({ LOCAL_AI_MODEL: "test" }).keepAliveSeconds, 300);
  assert.equal(readLocalAiConfiguration({ LOCAL_AI_MODEL: "test", LOCAL_AI_KEEP_ALIVE_SECONDS: "0" }).keepAliveSeconds, 0);
});

test("configuration rejects arbitrary destinations/models, exposed secrets and malformed keys without echoing a key", () => {
  for (const env of [{ GEMINI_API_KEY: key, GEMINI_MODEL: "arbitrary-cloud-model" }, { GEMINI_API_KEY: key, VERCEL: "1" }, { NEXT_PUBLIC_GEMINI_API_KEY: key }, { GEMINI_API_KEY: `${key}\nunsafe` }, { LOCAL_AI_MODEL: "test", LOCAL_AI_KEEP_ALIVE_SECONDS: "901" }]) {
    assert.throws(() => readInvestigatorAiConfiguration(env), (error: unknown) => error instanceof Error && !error.message.includes(key));
  }
  assert.throws(() => validateAiConfiguration({ ...gemini(), baseUrl: "https://attacker.example" }));
  assert.throws(() => validateAiConfiguration({ ...gemini(), provider: "other" }));
});

test("Gemini uses fixed HTTPS, header credentials, structured JSON and minimal bounded thinking without tools", async () => {
  const result = await generateModelJson(gemini(), request(async (url, init) => {
    assert.equal(String(url), `${GEMINI_ORIGIN}/v1beta/models/gemini-3.5-flash-lite:generateContent`);
    assert.equal(new URL(String(url)).search, ""); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), key);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.maxOutputTokens, 160); assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseJsonSchema, { type: "object" });
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "minimal", includeThoughts: false });
    assert.equal(body.tools, undefined); assert.equal(body.cachedContent, undefined); assert.equal(String(init?.body).includes(key), false);
    return completion(social, { thought: false, thoughtSignature: "YmxvYg==" });
  }));
  assert.equal(result.model, "gemini/gemini-3.5-flash-lite"); assert.deepEqual(JSON.parse(result.content), social);
  await generateModelJson({ ...gemini(), model: "gemini-3.8-flash" }, request(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).generationConfig.thinkingConfig.thinkingLevel, "low"); return completion(social);
  }));
});

test("local transport keeps weights warm while allowing explicit unload", async () => {
  for (const [seconds, expected] of [[300, "300s"], [0, 0]] as const) {
    await generateModelJson(readLocalAiConfiguration({ LOCAL_AI_MODEL: "test", LOCAL_AI_KEEP_ALIVE_SECONDS: String(seconds) }), request(async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).keep_alive, expected); assert.equal(new Headers(init?.headers).has("x-goog-api-key"), false); return localCompletion(social);
    }));
  }
});

test("Gemini rejects thought text, tool/data parts, unfinished, blocked and multiple candidates", async () => {
  for (const part of [{ thought: true }, { functionCall: { name: "bad" } }, { inlineData: { mimeType: "text/plain", data: "bad" } }, { thoughtSignature: "x".repeat(70_000) }]) {
    await assert.rejects(generateModelJson(gemini(), request(async () => completion(social, part))), hasCode(part.thoughtSignature ? "RESPONSE_LIMIT" : "INVALID_RESPONSE"));
  }
  for (const raw of [{ candidates: [{ finishReason: "MAX_TOKENS", content: { role: "model", parts: [{ text: "{}" }] } }] }, { candidates: [], promptFeedback: { blockReason: "SAFETY" } }, { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "{}" }] } }], promptFeedback: { blockReason: "OTHER" } }]) {
    await assert.rejects(generateModelJson(gemini(), request(async () => json(raw))), hasCode("INVALID_RESPONSE"));
  }
});

test("upstream failures and response limits are sanitized and never return provider credential prose", async () => {
  await assert.rejects(generateModelJson(gemini(), request(async () => json({ error: key }, 403))), (error: unknown) => error instanceof LocalAiError && error.code === "UNAVAILABLE" && !error.message.includes(key));
  await assert.rejects(generateModelJson(gemini(), request(async () => new Response("x", { headers: { "content-type": "application/json", "content-length": "70000" } }))), hasCode("RESPONSE_LIMIT"));
  await assert.rejects(generateModelJson(gemini(), request(async () => new Response("<html>bad</html>", { headers: { "content-type": "text/html" } }))), hasCode("INVALID_RESPONSE"));
});

test("local and Gemini HTTP429 retain a distinct rate-limit code without consuming private error bodies", async (t) => {
  for (const configuration of [runtime().local!, gemini()]) {
    const response = new Response(`private-provider-detail ${key}`, { status: 429, headers: { "content-type": "text/plain" } });
    const reader = t.mock.method(response.body!, "getReader", () => { throw new Error("Do not read upstream error prose."); });
    const cancelled = t.mock.method(response.body!, "cancel", async () => undefined);
    await assert.rejects(generateModelJson(configuration, request(async () => response)), (error: unknown) => error instanceof LocalAiError && error.code === "RATE_LIMITED" && !error.message.includes(key) && !error.message.includes("private-provider-detail"));
    assert.equal(reader.mock.calls.length, 0); assert.equal(cancelled.mock.calls.length, 1);
  }
});

test("a local HTTP429 can use configured Gemini for a genuine generated review rather than a preset fallback", async () => {
  const hosts: string[] = [];
  const explanation = await runInvestigatorWithConfig(getBrowserReportFixture(), runtime(), { fetch: async (url, init) => {
    hosts.push(new URL(String(url)).hostname);
    return hosts.length === 1 ? json({ error: `private-provider-detail ${key}` }, 429) : reportCompletion(init, "gemini");
  } });
  assert.deepEqual(hosts, ["127.0.0.1", "generativelanguage.googleapis.com"]);
  assert.equal(explanation.model, aiModelIdentifier(runtime().gemini!));
  assert.ok(explanation.summary?.text); assert.doesNotMatch(JSON.stringify(explanation), /private-provider-detail|synthetic_test_key/);
});

test("main review falls back once after local outage, retains canonical proof and names the actual Gemini model", async () => {
  const calls: string[] = []; const source = getBrowserReportFixture();
  const explanation = await runInvestigatorWithConfig(source, runtime(), { fetch: async (url, init) => {
    calls.push(new URL(String(url)).hostname);
    if (calls.length > 1) {
      const schema = JSON.parse(String(init?.body)).generationConfig.responseJsonSchema;
      assert.ok(schema.properties.brief); assert.equal(schema.properties.summary, undefined, "private generation uses brief; the published report keeps summary");
    }
    return calls.length === 1 ? json({ error: "Local model unavailable" }, 503) : reportCompletion(init, "gemini");
  } });
  const report = validateExplainedReport({ ...source, explanation });
  assert.deepEqual(calls, ["127.0.0.1", "generativelanguage.googleapis.com"]);
  assert.equal(explanation.model, "gemini/gemini-3.5-flash-lite"); assert.equal(explanation.grounding?.mode, "canonical-finding-selection");
  assert.equal(explanation.profileVersion, "1.6.0");
  assert.equal(explanation.summary?.grounding?.mode, "source-grounded-prose");
  assert.equal(explanation.summary?.text, explanation.summary?.reasons[0].reason);
  assert.ok(explanation.observations.every((observation) => source.findings.some((finding) => finding.evidenceIds.every((id) => observation.evidenceIds.includes(id)))));
  const capsule = createInvestigatorChatContext(report, runtime(), secret);
  assert.equal(verifyInvestigatorChatContext(capsule, runtime(), secret).model, explanation.model);
  assert.throws(() => verifyInvestigatorChatContext(capsule, { local: runtime().local }, secret), ChatContextError);
});

test("configured local success never calls Gemini; invalid local citations do not trigger fallback", async () => {
  let calls = 0;
  const result = await runInvestigatorWithConfig(getBrowserReportFixture(), runtime(), { fetch: async (_url, init) => { calls++; return reportCompletion(init, "local"); } });
  assert.equal(calls, 1); assert.equal(result.model, runtime().local?.model);
  calls = 0;
  await assert.rejects(runInvestigatorWithConfig(getBrowserReportFixture(), runtime(), { fetch: async () => { calls++; return localCompletion({ overview: { findingRefs: ["F99"], evidenceIds: [] }, observations: [], limitations: [] }); } }), hasCode("INVALID_CITATION"));
  assert.equal(calls, 1);
});

test("direct Gemini skips local retry and permits short uncited conversational replies", async () => {
  const config = { gemini: gemini() }; const source = getBrowserReportFixture();
  source.explanation.model = aiModelIdentifier(config.gemini);
  const capsule = createInvestigatorChatContext(source, config, secret);
  let calls = 0;
  const answer = await askInvestigatorQuestion("hi", capsule, config, secret, { fetch: async (url, init) => {
    calls++; assert.equal(new URL(String(url)).hostname, "generativelanguage.googleapis.com");
    const body = JSON.parse(String(init?.body)); assert.equal(body.generationConfig.maxOutputTokens, 160);
    assert.equal(body.contents[0].parts[0].text.includes("authenticatedScanFacts"), false); return completion(social);
  } });
  assert.equal(calls, 1); assert.equal(answer.answer, social.answer); assert.equal(answer.model, aiModelIdentifier(config.gemini));
  assert.equal(questionAnswerSchema.parse(answer).model, answer.model);
});

test("chat fallback accepts a configured local signed scope and expands complete funding proof", async () => {
  const config = runtime(); const capsule = createChatContext(getBrowserReportFixture(), config.local!, secret); let calls = 0; let expected: string[] = [];
  const answer = await askInvestigatorQuestion("Who funded the wallets?", capsule, config, secret, { fetch: async (_url, init) => {
    calls++; if (calls === 1) throw new Error("Local unavailable");
    const body = JSON.parse(String(init?.body)); assert.equal(body.generationConfig.maxOutputTokens, 384);
    const facts = JSON.parse(body.contents[0].parts[0].text); const packet = facts.authenticatedScanFacts.findingPackets[0];
    const context = verifyInvestigatorChatContext(capsule, config, secret); expected = packet.proof.map((alias: string) => context.citations.find((citation) => citation.alias === alias)!.id);
    return completion({ answer: "The supplied funding records link the examined wallets to a shared source.", caveat: "A common funding source does not establish shared ownership.", evidenceIds: [packet.proof[0]], needsFreshScan: false });
  } });
  assert.equal(calls, 2); assert.equal(answer.model, aiModelIdentifier(config.gemini!)); assert.deepEqual(answer.evidenceIds.sort(), expected.sort()); assert.ok(expected.length > 1);
});

test("invalid chat prose never retries another model and cancelled requests do not infer", async () => {
  const config = runtime(); const capsule = createChatContext(getBrowserReportFixture(), config.local!, secret); let calls = 0;
  await assert.rejects(askInvestigatorQuestion("hi", capsule, config, secret, { fetch: async () => { calls++; return localCompletion({ ...social, answer: "I remember our previous chat." }); } }), hasCode("INVALID_RESPONSE"));
  assert.equal(calls, 1); const controller = new AbortController(); controller.abort(); calls = 0;
  await assert.rejects(askInvestigatorQuestion("hi", capsule, config, secret, { signal: controller.signal, fetch: async () => { calls++; return completion(social); } }));
  assert.equal(calls, 0);
});

test("local deadline fallback uses only the remaining shared budget", async () => {
  const configured = runtime(); const config = { local: { ...configured.local!, timeoutMs: 1000 }, gemini: { ...configured.gemini!, timeoutMs: 3000 } as GeminiAiConfiguration };
  const capsule = createChatContext(getBrowserReportFixture(), config.local, secret); let calls = 0;
  const started = performance.now();
  const result = await askInvestigatorQuestion("hi", capsule, config, secret, { fetch: async () => { calls++; if (calls === 1) return new Promise<Response>(() => undefined); return completion(social); } });
  assert.equal(calls, 2); assert.equal(result.model, aiModelIdentifier(config.gemini)); assert.ok(performance.now() - started < 2500);
});

test("abort during a hung local request prevents the Gemini fallback", async () => {
  const config = runtime(); const capsule = createChatContext(getBrowserReportFixture(), config.local!, secret); const controller = new AbortController(); let calls = 0;
  const pending = askInvestigatorQuestion("hi", capsule, config, secret, { signal: controller.signal, fetch: async () => { calls++; controller.abort(); return new Promise<Response>(() => undefined); } });
  await assert.rejects(pending, hasCode("ABORTED")); assert.equal(calls, 1);
});

test("the minimum shared one-second budget reserves time for a slow-local Gemini fallback", async () => {
  const config = readInvestigatorAiConfiguration({ LOCAL_AI_MODEL: "test", LOCAL_AI_TIMEOUT_MS: "1000", GEMINI_API_KEY: key });
  const capsule = createChatContext(getBrowserReportFixture(), config.local!, secret); let calls = 0;
  const started = performance.now();
  const result = await askInvestigatorQuestion("hi", capsule, config, secret, { fetch: async () => { calls++; if (calls === 1) return new Promise<Response>(() => undefined); return completion(social); } });
  assert.equal(calls, 2); assert.equal(result.model, aiModelIdentifier(config.gemini!)); assert.ok(performance.now() - started < 950);
});

test("deployment preflight rejects Gemini credentials on Vercel and any browser-exposed key", () => {
  const badVercel = reviewDeploymentEnvironment({ GEMINI_API_KEY: key }, "vercel");
  assert.equal(badVercel.checks.find((check) => check.id === "credential-separation")?.ok, false);
  const publicKey = reviewDeploymentEnvironment({ NEXT_PUBLIC_GEMINI_API_KEY: key }, "engine");
  assert.equal(publicKey.checks.find((check) => check.id === "browser-secrets")?.ok, false);
  const engine = reviewDeploymentEnvironment({ GEMINI_API_KEY: key }, "engine");
  assert.equal(engine.checks.find((check) => check.id === "cpu-model")?.ok, true);
  assert.equal(engine.checks.find((check) => check.id === "credential-separation")?.ok, true);
});

test("late local success cannot bypass an attempt deadline while its timer is starved", async () => {
  const config = readInvestigatorAiConfiguration({ LOCAL_AI_MODEL: "test", LOCAL_AI_TIMEOUT_MS: "1000", GEMINI_API_KEY: key });
  const capsule = createChatContext(getBrowserReportFixture(), config.local!, secret); let calls = 0;
  const answer = await askInvestigatorQuestion("hi", capsule, config, secret, { fetch: async () => {
    calls++;
    if (calls === 1) { const until = performance.now() + 550; while (performance.now() < until) { /* Deliberately starve timer dispatch in this regression. */ } return localCompletion(social); }
    return completion(social);
  } });
  assert.equal(calls, 2); assert.equal(answer.model, aiModelIdentifier(config.gemini!));
});
