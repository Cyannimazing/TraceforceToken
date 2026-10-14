import assert from "node:assert/strict";
import test from "node:test";
import { aiModelIdentifier, aiModelMatchesConfiguration, DEFAULT_OPENROUTER_MODEL, OPENROUTER_ORIGIN, readInvestigatorAiConfiguration, validateAiConfiguration, type OpenRouterAiConfiguration } from "../../src/agents/config";
import { generateModelJson, LocalAiError } from "../../src/agents/model-transport";
import { askInvestigatorQuestion, createInvestigatorChatContext, runInvestigatorWithConfig, verifyInvestigatorChatContext } from "../../src/agents/inference";
import { createChatContext, ChatContextError } from "../../src/agents/chat-context";
import { InvestigationQuestionError } from "../../src/agents/questions";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import { questionAnswerSchema } from "../../src/domain/investigations/questions";
import { reviewDeploymentEnvironment } from "../../deploy/preflight";
import { getBrowserReportFixture } from "../fixtures/report";

const key = "sk-or-v1-synthetic-only-not-a-real-key-1234567890";
const geminiKey = "synthetic_gemini_key_not_a_real_credential";
const secret = "synthetic-openrouter-capsule-secret-not-a-real-secret-123456789";
// Earlier fixed paid-model behavior remains an explicit operator opt-in.
const model = "google/gemini-3.5-flash-lite";
const runtime = (extra: Record<string, string | undefined> = {}) => readInvestigatorAiConfiguration({ OPENROUTER_API_KEY: key, OPENROUTER_FREE_ONLY: "false", OPENROUTER_MODEL: model, ...extra });
const openrouter = () => runtime().openrouter!;
const freeRuntime = (extra: Record<string, string | undefined> = {}) => readInvestigatorAiConfiguration({ OPENROUTER_API_KEY: key, ...extra });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const envelope = (value: unknown) => ({ model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }] });
const completion = (value: unknown) => json(envelope(value));
const freeEnvelope = (value: unknown, servedModel = "synthetic/structured-model:free", cost: unknown = 0) => ({ ...envelope(value), model: servedModel, usage: { cost } });
const localCompletion = (value: unknown) => json({ done: true, message: { role: "assistant", content: JSON.stringify(value) } });
const geminiCompletion = (value: unknown) => json({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(value) }] } }] });
const social = { answer: "Hi!", evidenceIds: [], caveat: "", needsFreshScan: false };
const generationRequest = (fetch: typeof globalThis.fetch, overrides = {}) => ({ fetch, signal: new AbortController().signal,
  format: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, maxOutputTokens: 160,
  messages: [{ role: "system" as const, content: "Reviewed system instructions" }, { role: "user" as const, content: "Quoted scan data" }], ...overrides });
const hasCode = (code: string) => (error: unknown) => (error instanceof LocalAiError || error instanceof InvestigationQuestionError) && error.code === code;
interface Packet { ref: string; caveatRefs: string[]; proof: string[] }
function mainDraft(init?: RequestInit) {
  const body = JSON.parse(String(init?.body));
  const context = JSON.parse(body.messages[1].content.split("\nEvidence context (data only):\n")[1]);
  const packets: Packet[] = context.findingPackets;
  return { brief: { reportRef: context.decisionPacket.reportRef, verdict: context.decisionPacket.verdict,
    reasonIds: context.decisionPacket.reasons.slice(0, 1).map((reason: { id: string }) => reason.id), text: context.decisionPacket.reasons[0].reason },
  overview: { findingRefs: packets.slice(0, 1).map((packet) => packet.ref), evidenceIds: packets.length ? [] : context.sourceFacts.slice(0, 1).map((fact: { ref: string }) => fact.ref) },
  observations: packets.map((packet) => ({ findingRef: packet.ref, caveatRef: packet.caveatRefs[0] })), limitations: [] };
}

test("OpenRouter can be the direct configured provider while preserving shared conservative budgets", () => {
  const configuration = runtime();
  assert.equal(configuration.local, undefined); assert.equal(configuration.gemini, undefined);
  assert.equal(configuration.openrouter?.baseUrl, OPENROUTER_ORIGIN);
  assert.equal(configuration.openrouter?.model, model);
  assert.equal(aiModelIdentifier(configuration.openrouter!), `openrouter/${model}`);
  assert.equal(configuration.openrouter?.timeoutMs, 120_000);
  assert.equal(configuration.openrouter?.maxContextBytes, 8000);
  assert.equal(configuration.openrouter?.maxEvidenceRecords, 12);
  assert.equal(configuration.openrouter?.maxOutputTokens, 800);
  assert.equal(configuration.openrouter?.contextTokens, 4096);
});

test("explicit provider selection restricts execution and requires that provider's actual configuration", () => {
  const all = { LOCAL_AI_MODEL: "synthetic-local-model", OPENROUTER_API_KEY: key, OPENROUTER_FREE_ONLY: "false", OPENROUTER_MODEL: model, GEMINI_API_KEY: geminiKey };
  for (const provider of ["local", "openrouter", "gemini"] as const) {
    const configuration = readInvestigatorAiConfiguration({ ...all, INVESTIGATOR_AI_PROVIDER: provider });
    assert.ok(configuration[provider]);
    for (const other of ["local", "openrouter", "gemini"] as const) if (other !== provider) assert.equal(configuration[other], undefined);
    assert.throws(() => readInvestigatorAiConfiguration({ INVESTIGATOR_AI_PROVIDER: provider }));
  }
  assert.throws(() => runtime({ INVESTIGATOR_AI_PROVIDER: "arbitrary" }));
  assert.ok(readInvestigatorAiConfiguration({ ...all, INVESTIGATOR_AI_PROVIDER: "auto" }).openrouter);
  assert.ok(runtime({ INVESTIGATOR_AI_PROVIDER: "openrouter", LOCAL_AI_MODEL: "unused", LOCAL_AI_BASE_URL: "https://untrusted.invalid", GEMINI_API_KEY: "unused-invalid-key" }).openrouter);
});

test("OpenRouter rejects untrusted routing, invalid model identifiers, exposed credentials and invalid budgets", () => {
  for (const badModel of ["https://attacker.example/model", "google/../model", "google/model/extra", "google/model?key=value", "google/model#fragment", "google/model:online", "openrouter/auto", "google/model\nunsafe", "google/" + "x".repeat(118)]) {
    assert.throws(() => runtime({ OPENROUTER_MODEL: badModel }), (error) => error instanceof Error && !error.message.includes(key));
  }
  for (const extra of [{ VERCEL: "1" }, { NEXT_PUBLIC_OPENROUTER_API_KEY: key }, { OPENROUTER_API_KEY: `${key}\nunsafe` }, { LOCAL_AI_TIMEOUT_MS: "120001" }, { LOCAL_AI_MAX_RESPONSE_BYTES: "262145" }]) {
    assert.throws(() => runtime(extra), (error) => error instanceof Error && !error.message.includes(key));
  }
  assert.throws(() => validateAiConfiguration({ ...openrouter(), baseUrl: "https://attacker.example" }));
  assert.throws(() => validateAiConfiguration({ ...openrouter(), provider: "arbitrary" }));
  assert.equal(runtime({ OPENROUTER_MODEL: "anthropic/claude-sonnet-4" }).openrouter?.model, "anthropic/claude-sonnet-4");
  const maximumModel = `test/${"x".repeat(112)}`;
  assert.equal(aiModelIdentifier(runtime({ OPENROUTER_MODEL: maximumModel }).openrouter!).length, 128);
  assert.throws(() => runtime({ OPENROUTER_MODEL: `${maximumModel}x` }));
});

test("OpenRouter uses one fixed private structured request with strict routing/privacy requirements and no tools", async () => {
  const result = await generateModelJson(openrouter(), generationRequest(async (url, init) => {
    assert.equal(String(url), `${OPENROUTER_ORIGIN}/api/v1/chat/completions`);
    const endpoint = new URL(String(url)); assert.equal(endpoint.search, ""); assert.equal(endpoint.username, ""); assert.equal(endpoint.password, "");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${key}`);
    assert.equal(headers.get("x-goog-api-key"), null);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, model); assert.equal(body.stream, false); assert.equal(body.max_tokens, 160); assert.equal(body.temperature, 0);
    assert.equal(body.response_format.type, "json_schema"); assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, generationRequest(async () => completion(social)).format);
    assert.equal(body.provider.require_parameters, true); assert.equal(body.provider.data_collection, "deny");
    assert.equal(body.provider.zdr, undefined); assert.equal(body.provider.allow_fallbacks, false);
    assert.deepEqual(body.reasoning, { effort: "minimal", exclude: true });
    assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.plugins, undefined);
    assert.equal(body.transforms, undefined); assert.equal(String(init?.body).includes(key), false);
    assert.deepEqual(body.messages, generationRequest(async () => completion(social)).messages);
    return completion(social);
  }));
  assert.equal(result.model, `openrouter/${model}`); assert.deepEqual(JSON.parse(result.content), social);
  const otherModel = { ...openrouter(), model: "synthetic/structured-model" };
  await generateModelJson(otherModel, generationRequest(async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).reasoning, { exclude: true });
    return json({ ...envelope(social), model: otherModel.model });
  }));
});

test("OpenRouter rejects unfinished, refused, tool-bearing, error and substituted-model responses", async () => {
  const valid = envelope(social), choice = valid.choices[0], message = choice.message;
  const invalid = [
    {}, { choices: valid.choices }, { model, choices: [] }, { ...valid, choices: [choice, choice] },
    { ...valid, choices: [{ ...choice, index: 1 }] },
    { ...valid, choices: [{ ...choice, finish_reason: "length" }] },
    { ...valid, choices: [{ ...choice, finish_reason: "content_filter" }] },
    { ...valid, choices: [{ ...choice, finish_reason: "tool_calls" }] },
    { ...valid, choices: [{ ...choice, message: { ...message, role: "user" } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, content: "" } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, content: null } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, content: [{ type: "text", text: "{}" }] } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, tool_calls: [{ type: "function", function: { name: "execute", arguments: "{}" } }] } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, function_call: { name: "execute", arguments: "{}" } } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, refusal: "Cannot answer." } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, reasoning: "Unrequested private chain of thought" } }] },
    { ...valid, choices: [{ ...choice, message: { ...message, reasoning_details: [{ type: "reasoning.text", text: "Private thought text" }] } }] },
    { ...valid, error: { message: key, code: 500 } },
    { ...valid, model: "google/other-model" },
  ];
  for (const response of invalid) await assert.rejects(generateModelJson(openrouter(), generationRequest(async () => json(response))), hasCode("INVALID_RESPONSE"));
});

test("OpenRouter accepts documented no-op optional placeholders without treating them as actions or refusals", async () => {
  const response = envelope(social);
  const result = await generateModelJson(openrouter(), generationRequest(async () => json({ ...response, error: null,
    choices: [{ ...response.choices[0], message: { ...response.choices[0].message, refusal: null, function_call: null,
      tool_calls: [], reasoning: "", reasoning_content: null, reasoning_details: [] } }],
  })));
  assert.deepEqual(JSON.parse(result.content), social);
  assert.equal(result.model, `openrouter/${model}`);
});

test("OpenRouter transport rejects MIME/UTF-8/body limits and sanitizes upstream failures", async () => {
  await assert.rejects(generateModelJson(openrouter(), generationRequest(async () => json({ error: { message: key } }, 403))),
    (error) => hasCode("UNAVAILABLE")(error) && !String(error).includes(key));
  // Preserve valid JSON structure while placing an invalid UTF-8 byte inside
  // the assistant's quoted content; a lossy decoder would silently accept it.
  const embeddedMalformed = new TextEncoder().encode(JSON.stringify(envelope(social)));
  const answerOffset = Buffer.from(embeddedMalformed).indexOf("Hi!");
  assert.ok(answerOffset >= 0);
  embeddedMalformed[answerOffset] = 0xff;
  const responses = [
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("{}", { headers: { "content-type": "application/jsonp" } }),
    new Response("not-json", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
    new Response(embeddedMalformed, { headers: { "content-type": "application/json" } }),
  ];
  for (const response of responses) await assert.rejects(generateModelJson(openrouter(), generationRequest(async () => response)), hasCode("INVALID_RESPONSE"));
  await assert.rejects(generateModelJson(openrouter(), generationRequest(async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "70000" } }))), hasCode("RESPONSE_LIMIT"));
  await assert.rejects(generateModelJson(openrouter(), generationRequest(async () => completion({ answer: "x".repeat(2000) }), { maxResponseBytes: 1024 })), hasCode("RESPONSE_LIMIT"));
});

test("OpenRouter HTTP429 is a trusted rate-limit failure without reading or exposing the upstream body", async (t) => {
  for (const configuration of [openrouter(), freeRuntime().openrouter!]) {
    const response = new Response(`<html>${key} private-provider-detail reset-in-999999-days</html>`, { status: 429, headers: { "content-type": "text/html", "retry-after": "9999999999" } });
    const reader = t.mock.method(response.body!, "getReader", () => { throw new Error("The private error body must not be read."); });
    const cancelled = t.mock.method(response.body!, "cancel", async () => undefined);
    let calls = 0;
    await assert.rejects(generateModelJson(configuration, generationRequest(async () => { calls++; return response; })), (error: unknown) => {
      assert.ok(error instanceof LocalAiError); assert.equal(error.code, "RATE_LIMITED");
      assert.doesNotMatch(error.message, /private-provider-detail|999999|sk-or-v1/);
      return true;
    });
    assert.equal(calls, 1); assert.equal(reader.mock.calls.length, 0); assert.equal(cancelled.mock.calls.length, 1);
  }
  const redirected = json({ error: "private-redirected-provider-body" }, 429);
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(generateModelJson(openrouter(), generationRequest(async () => redirected)), hasCode("UNAVAILABLE"), "a redirected response is not trusted rate-limit context");
});

test("OpenRouter main review restores canonical facts and complete proof without altering the report", async () => {
  const source = getBrowserReportFixture(), before = structuredClone(source); let calls = 0;
  const explanation = await runInvestigatorWithConfig(source, runtime(), { fetch: async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 300);
    assert.ok(body.response_format.json_schema.schema.properties.brief);
    assert.equal(body.response_format.json_schema.schema.properties.summary, undefined, "private generation uses brief without renaming the public summary");
    return completion(mainDraft(init));
  } });
  assert.equal(calls, 1); assert.deepEqual(source, before);
  const report = validateExplainedReport({ ...source, explanation });
  assert.equal(report.explanation.model, `openrouter/${model}`);
  assert.equal(explanation.grounding?.mode, "canonical-finding-selection");
  assert.equal(explanation.profileVersion, "1.6.0");
  assert.equal(explanation.summary?.grounding?.mode, "source-grounded-prose");
  assert.equal(explanation.summary?.text, explanation.summary?.reasons[0].reason, "the mock model's supplied prose survives restoration rather than being replaced by fixed wording");
  for (const observation of explanation.observations) assert.ok(source.findings.some((finding) => finding.evidenceIds.length === observation.evidenceIds.length && finding.evidenceIds.every((id) => observation.evidenceIds.includes(id))));
  const capsule = createInvestigatorChatContext(report, runtime(), secret);
  assert.equal(verifyInvestigatorChatContext(capsule, runtime(), secret).model, explanation.model);
  assert.throws(() => verifyInvestigatorChatContext(capsule, readInvestigatorAiConfiguration({ LOCAL_AI_MODEL: "synthetic-local-model" }), secret), ChatContextError);
});

test("auto fallback uses local then OpenRouter then Gemini only on availability failures", async () => {
  const configuration = runtime({ LOCAL_AI_MODEL: "synthetic-local-model", GEMINI_API_KEY: geminiKey });
  const calls: string[] = [];
  const explanation = await runInvestigatorWithConfig(getBrowserReportFixture(), configuration, { fetch: async (url, init) => {
    calls.push(new URL(String(url)).hostname);
    if (calls.length === 1) return json({ error: "Local unavailable" }, 503);
    return completion(mainDraft(init));
  } });
  assert.deepEqual(calls, ["127.0.0.1", "openrouter.ai"]); assert.equal(explanation.model, `openrouter/${model}`);
  const capsule = createChatContext(getBrowserReportFixture(), configuration.local!, secret); calls.length = 0;
  const answer = await askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch: async (url) => {
    calls.push(new URL(String(url)).hostname);
    return calls.length < 3 ? json({ error: "Unavailable" }, 503) : geminiCompletion(social);
  } });
  assert.deepEqual(calls, ["127.0.0.1", "openrouter.ai", "generativelanguage.googleapis.com"]);
  assert.equal(answer.model, aiModelIdentifier(configuration.gemini!));
});

test("rate limiting permits only the already configured next inference provider without retrying the refused endpoint", async () => {
  const configuration = runtime({ LOCAL_AI_MODEL: "synthetic-local-model", GEMINI_API_KEY: geminiKey });
  const source = getBrowserReportFixture(), capsule = createChatContext(source, configuration.local!, secret), hosts: string[] = [];
  const answer = await askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch: async (url) => {
    hosts.push(new URL(String(url)).hostname);
    return hosts.length < 3 ? json({ error: `private-provider-detail ${key}` }, 429) : geminiCompletion(social);
  } });
  assert.deepEqual(hosts, ["127.0.0.1", "openrouter.ai", "generativelanguage.googleapis.com"]);
  assert.equal(answer.answer, social.answer); assert.equal(answer.model, aiModelIdentifier(configuration.gemini!));
});

test("local success and explicit OpenRouter selection prevent unintended provider calls", async () => {
  const all = { LOCAL_AI_MODEL: "synthetic-local-model", GEMINI_API_KEY: geminiKey };
  const hosts: string[] = [];
  const local = await runInvestigatorWithConfig(getBrowserReportFixture(), runtime(all), { fetch: async (url, init) => {
    hosts.push(new URL(String(url)).hostname); return localCompletion(mainDraft(init));
  } });
  assert.deepEqual(hosts, ["127.0.0.1"]); assert.equal(local.model, all.LOCAL_AI_MODEL);
  hosts.length = 0;
  const direct = await runInvestigatorWithConfig(getBrowserReportFixture(), runtime({ ...all, INVESTIGATOR_AI_PROVIDER: "openrouter" }), { fetch: async (url, init) => {
    hosts.push(new URL(String(url)).hostname); return completion(mainDraft(init));
  } });
  assert.deepEqual(hosts, ["openrouter.ai"]); assert.equal(direct.model, `openrouter/${model}`);
  hosts.length = 0;
  await assert.rejects(runInvestigatorWithConfig(getBrowserReportFixture(), runtime({ ...all, INVESTIGATOR_AI_PROVIDER: "openrouter" }), { fetch: async (url) => {
    hosts.push(new URL(String(url)).hostname); return json({ error: "Unavailable" }, 503);
  } }), hasCode("UNAVAILABLE"));
  assert.deepEqual(hosts, ["openrouter.ai"]);
});

test("invalid OpenRouter references or invented chat claims never trigger Gemini fallback", async () => {
  const configuration = runtime({ GEMINI_API_KEY: geminiKey }); let calls = 0;
  await assert.rejects(runInvestigatorWithConfig(getBrowserReportFixture(), configuration, { fetch: async (_url, init) => {
    calls++; const draft = mainDraft(init); draft.overview.findingRefs = ["F999"]; return completion(draft);
  } }), hasCode("INVALID_CITATION"));
  assert.equal(calls, 1);
  const source = getBrowserReportFixture(); source.explanation.model = aiModelIdentifier(configuration.openrouter!);
  const capsule = createInvestigatorChatContext(source, configuration, secret); calls = 0;
  await assert.rejects(askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch: async () => {
    calls++; return completion({ ...social, answer: "I remember our previous chat." });
  } }), hasCode("INVALID_RESPONSE"));
  assert.equal(calls, 1);
});

test("OpenRouter greeting invokes genuine injected inference without sending chain facts or citations", async () => {
  const configuration = runtime(), source = getBrowserReportFixture(); source.explanation.model = aiModelIdentifier(configuration.openrouter!);
  const capsule = createInvestigatorChatContext(source, configuration, secret); let calls = 0;
  const answer = await askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch: async (url, init) => {
    calls++; assert.equal(new URL(String(url)).hostname, "openrouter.ai");
    const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 160);
    assert.equal(body.messages[1].content.includes("authenticatedScanFacts"), false);
    assert.equal(body.messages[1].content.includes(source.token.address), false);
    return completion(social);
  } });
  assert.equal(calls, 1); assert.equal(answer.model, `openrouter/${model}`);
  assert.deepEqual(questionAnswerSchema.parse(answer).evidenceIds, []);
});

test("OpenRouter substantive chat expands complete authenticated funding proof and rejects invented citations", async () => {
  const configuration = runtime(), source = getBrowserReportFixture(); source.explanation.model = aiModelIdentifier(configuration.openrouter!);
  const capsule = createInvestigatorChatContext(source, configuration, secret); let expected: string[] = [];
  const answer = await askInvestigatorQuestion("Who funded the wallets?", capsule, configuration, secret, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 384);
    const context = JSON.parse(body.messages[1].content), packet = context.authenticatedScanFacts.findingPackets[0];
    const signed = verifyInvestigatorChatContext(capsule, configuration, secret);
    expected = packet.proof.map((alias: string) => signed.citations.find((citation) => citation.alias === alias)!.id);
    return completion({ answer: "The supplied funding records link the examined wallets to a shared source.", caveat: "A common source does not establish shared ownership.", evidenceIds: [packet.proof[0]], needsFreshScan: false });
  } });
  assert.deepEqual(answer.evidenceIds.sort(), expected.sort()); assert.ok(expected.length > 1);
  await assert.rejects(askInvestigatorQuestion("Who funded the wallets?", capsule, configuration, secret, { fetch: async () => completion({
    answer: "The examined wallets have a common funding source.", caveat: "Ownership remains unknown.", evidenceIds: ["E999"], needsFreshScan: false,
  }) }), hasCode("INVALID_CITATION"));
});

test("OpenRouter parent cancellation stops pending headers/body and prevents another provider", async () => {
  const configuration = runtime({ GEMINI_API_KEY: geminiKey }), parent = new AbortController(); let calls = 0;
  const pending = runInvestigatorWithConfig(getBrowserReportFixture(), configuration, { signal: parent.signal, fetch: async () => {
    calls++; parent.abort(new Error("Visitor left")); return new Promise<Response>(() => undefined);
  } });
  await assert.rejects(pending, hasCode("ABORTED")); assert.equal(calls, 1);
  const bodyParent = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } });
  const reading = generateModelJson(openrouter(), generationRequest(async () => new Response(body, { headers: { "content-type": "application/json" } }), { signal: bodyParent.signal }));
  await new Promise((resolve) => setTimeout(resolve, 0)); bodyParent.abort();
  await assert.rejects(reading); assert.equal(cancelled, true);
});

test("OpenRouter fallback remains inside the minimum shared deadline", async () => {
  const configuration = runtime({ LOCAL_AI_MODEL: "synthetic-local-model", LOCAL_AI_TIMEOUT_MS: "1000" });
  const capsule = createChatContext(getBrowserReportFixture(), configuration.local!, secret); let calls = 0;
  const started = performance.now();
  const answer = await askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch: async () => {
    calls++; if (calls === 1) return new Promise<Response>(() => undefined); return completion(social);
  } });
  assert.equal(calls, 2); assert.equal(answer.model, aiModelIdentifier(configuration.openrouter!));
  assert.ok(performance.now() - started < 950);
});

test("three automatic providers reserve time for the final fallback without tripling the shared deadline", async () => {
  const configuration = runtime({ LOCAL_AI_MODEL: "synthetic-local-model", LOCAL_AI_TIMEOUT_MS: "1000", GEMINI_API_KEY: geminiKey });
  const capsule = createChatContext(getBrowserReportFixture(), configuration.local!, secret), calls: string[] = [];
  const started = performance.now();
  const answer = await askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch: async (url) => {
    calls.push(new URL(String(url)).hostname);
    if (calls.length < 3) return new Promise<Response>(() => undefined);
    return geminiCompletion(social);
  } });
  assert.deepEqual(calls, ["127.0.0.1", "openrouter.ai", "generativelanguage.googleapis.com"]);
  assert.equal(answer.model, aiModelIdentifier(configuration.gemini!));
  assert.ok(performance.now() - started < 950);
});

test("deployment preflight rejects public/Vercel OpenRouter credentials and permits bounded engine configuration", () => {
  assert.equal(reviewDeploymentEnvironment({ OPENROUTER_API_KEY: key }, "vercel").checks.find((check) => check.id === "credential-separation")?.ok, false);
  assert.equal(reviewDeploymentEnvironment({ NEXT_PUBLIC_OPENROUTER_API_KEY: key }, "engine").checks.find((check) => check.id === "browser-secrets")?.ok, false);
  const engine = reviewDeploymentEnvironment({ OPENROUTER_API_KEY: key }, "engine");
  assert.equal(engine.checks.find((check) => check.id === "cpu-model")?.ok, true);
  assert.equal(engine.checks.find((check) => check.id === "credential-separation")?.ok, true);
  assert.throws(() => validateAiConfiguration({ ...openrouter(), maxOutputTokens: 4097 } satisfies Partial<OpenRouterAiConfiguration>));
});

test("free OpenRouter routing is the default and paid model selection requires an explicit opt-in", () => {
  const configuration = freeRuntime();
  assert.equal(DEFAULT_OPENROUTER_MODEL, "openrouter/free");
  assert.equal(configuration.openrouter?.model, DEFAULT_OPENROUTER_MODEL);
  assert.equal(configuration.openrouter?.freeOnly, true);
  assert.equal(aiModelIdentifier(configuration.openrouter!), "openrouter/openrouter/free");
  const specific = freeRuntime({ OPENROUTER_MODEL: "synthetic/structured-model:free" });
  assert.equal(specific.openrouter?.model, "synthetic/structured-model:free");
  assert.equal(specific.openrouter?.freeOnly, true);
  assert.throws(() => freeRuntime({ OPENROUTER_MODEL: model }));
  assert.equal(runtime().openrouter?.freeOnly, false);
  for (const invalid of ["openrouter/auto", "openrouter/unknown", "synthetic/model:online", "synthetic/model:free:online", "synthetic/../model:free", "https://attacker.invalid/model:free"])
    assert.throws(() => freeRuntime({ OPENROUTER_MODEL: invalid }));
  assert.throws(() => freeRuntime({ OPENROUTER_FREE_ONLY: "sometimes" }));
});

test("free router requests cap prompt, completion and request prices at zero and retain the concrete served model", async () => {
  for (const servedModel of ["synthetic/structured-model:free", "synthetic/structured-model", "openrouter/synthetic-alpha"]) {
    const result = await generateModelJson(freeRuntime().openrouter!, generationRequest(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "openrouter/free");
      assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
      assert.equal(body.provider.require_parameters, true); assert.equal(body.provider.data_collection, "deny");
      assert.equal(body.provider.allow_fallbacks, false);
      assert.deepEqual(body.reasoning, { enabled: false, exclude: true });
      assert.equal(body.response_format.type, "json_schema"); assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.tools, undefined); assert.equal(body.plugins, undefined);
      return json(freeEnvelope(social, servedModel));
    }));
    assert.equal(result.model, `openrouter/${servedModel}`);
    assert.deepEqual(JSON.parse(result.content), social);
    assert.equal(aiModelMatchesConfiguration(freeRuntime().openrouter!, result.model), true);
  }
});

test("provider data collection requires explicit validated opt-in and never changes free-only safeguards", async () => {
  assert.equal(freeRuntime().openrouter?.allowDataCollection, false);
  for (const setting of ["false", "true"] as const) {
    const configuration = freeRuntime({ OPENROUTER_ALLOW_DATA_COLLECTION: setting }).openrouter!;
    assert.equal(configuration.allowDataCollection, setting === "true");
    await generateModelJson(configuration, generationRequest(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.provider.data_collection, setting === "true" ? "allow" : "deny");
      assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
      assert.equal(body.provider.allow_fallbacks, false);
      assert.equal(body.provider.require_parameters, true);
      assert.equal(body.response_format.json_schema.strict, true);
      return json(freeEnvelope(social));
    }));
  }
  for (const invalid of ["yes", "1", "TRUE", "allow"])
    assert.throws(() => freeRuntime({ OPENROUTER_ALLOW_DATA_COLLECTION: invalid }));
  assert.throws(() => validateAiConfiguration({ ...freeRuntime().openrouter!, allowDataCollection: "true" }));
  assert.throws(() => freeRuntime({ OPENROUTER_ALLOW_DATA_COLLECTION: "true", OPENROUTER_MODEL: model }));
});

test("free routing rejects billed responses and missing, malformed or pseudo-router model identities", async () => {
  const configuration = freeRuntime().openrouter!;
  for (const cost of [0.001, -1, "0", false, {}])
    await assert.rejects(generateModelJson(configuration, generationRequest(async () => json(freeEnvelope(social, "synthetic/model:free", cost)))), hasCode("INVALID_RESPONSE"));
  for (const servedModel of ["openrouter/free", "openrouter/auto", "openrouter/auto-beta", "openrouter/auto-exacto", "openrouter/fusion", "openrouter/bodybuilder", "openrouter/body-builder", "openrouter/pareto-code-router", "synthetic/model:online", "https://attacker.invalid/model", "synthetic/../model", "synthetic/model?secret=value", "synthetic/model\nunsafe"]) {
    await assert.rejects(generateModelJson(configuration, generationRequest(async () => json(freeEnvelope(social, servedModel)))), hasCode("INVALID_RESPONSE"));
    assert.equal(aiModelMatchesConfiguration(configuration, `openrouter/${servedModel}`), false);
  }
  const missingModel = freeEnvelope(social); Reflect.deleteProperty(missingModel, "model");
  await assert.rejects(generateModelJson(configuration, generationRequest(async () => json(missingModel))), hasCode("INVALID_RESPONSE"));
  for (const response of [freeEnvelope(social, "synthetic/model:free", null), { ...freeEnvelope(social, "synthetic/model:free"), usage: {} }, { ...freeEnvelope(social, "synthetic/model:free"), usage: undefined }]) {
    const result = await generateModelJson(configuration, generationRequest(async () => json(response)));
    assert.equal(result.model, "openrouter/synthetic/model:free");
  }
});

test("a specific free model remains pinned and cannot silently switch to another free model", async () => {
  const specific = "synthetic/pinned-model:free", configuration = freeRuntime({ OPENROUTER_MODEL: specific }).openrouter!;
  const result = await generateModelJson(configuration, generationRequest(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, specific);
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
    return json(freeEnvelope(social, specific));
  }));
  assert.equal(result.model, `openrouter/${specific}`);
  for (const returned of ["synthetic/other-model:free", "synthetic/pinned-model"])
    await assert.rejects(generateModelJson(configuration, generationRequest(async () => json(freeEnvelope(social, returned)))), hasCode("INVALID_RESPONSE"));
});

test("free-router canonical reports preserve actual served models while capsules bind the requested router scope", async () => {
  const configuration = freeRuntime(), source = getBrowserReportFixture(), firstModel = "synthetic/first-model:free", secondModel = "synthetic/second-model";
  const explanation = await runInvestigatorWithConfig(source, configuration, { fetch: async (_url, init) => json(freeEnvelope(mainDraft(init), firstModel)) });
  const report = validateExplainedReport({ ...source, explanation });
  assert.equal(report.explanation.model, `openrouter/${firstModel}`);
  assert.equal(report.explanation.grounding?.mode, "canonical-finding-selection");
  const capsule = createInvestigatorChatContext(report, configuration, secret);
  assert.equal(verifyInvestigatorChatContext(capsule, configuration, secret).model, "openrouter/openrouter/free");
  const answer = await askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, "openrouter/free");
    return json(freeEnvelope(social, secondModel));
  } });
  assert.equal(answer.model, `openrouter/${secondModel}`); assert.deepEqual(answer.evidenceIds, []);
  const fixed = freeRuntime({ OPENROUTER_MODEL: firstModel });
  assert.throws(() => verifyInvestigatorChatContext(capsule, fixed, secret), ChatContextError);
  const paid = runtime();
  const oldPaidReport = getBrowserReportFixture(); oldPaidReport.explanation.model = aiModelIdentifier(paid.openrouter!);
  const paidCapsule = createInvestigatorChatContext(oldPaidReport, paid, secret);
  assert.throws(() => verifyInvestigatorChatContext(paidCapsule, configuration, secret), ChatContextError);
});

test("free-only routing permits local inference but cannot fall through to Gemini, including injected configuration", async () => {
  const configuration = freeRuntime({ LOCAL_AI_MODEL: "synthetic-local-model", GEMINI_API_KEY: "unused-invalid-key" });
  assert.equal(configuration.gemini, undefined);
  const hosts: string[] = [];
  const explanation = await runInvestigatorWithConfig(getBrowserReportFixture(), configuration, { fetch: async (url, init) => {
    hosts.push(new URL(String(url)).hostname);
    return hosts.length === 1 ? json({ error: "Local unavailable" }, 503) : json(freeEnvelope(mainDraft(init)));
  } });
  assert.deepEqual(hosts, ["127.0.0.1", "openrouter.ai"]); assert.equal(explanation.model, "openrouter/synthetic/structured-model:free");
  hosts.length = 0;
  const paidGemini = readInvestigatorAiConfiguration({ INVESTIGATOR_AI_PROVIDER: "gemini", GEMINI_API_KEY: geminiKey }).gemini!;
  for (const failure of ["unavailable", "billed"] as const) {
    hosts.length = 0;
    await assert.rejects(runInvestigatorWithConfig(getBrowserReportFixture(), { ...freeRuntime(), gemini: paidGemini }, { fetch: async (url, init) => {
      hosts.push(new URL(String(url)).hostname);
      return failure === "unavailable" ? json({ error: "Free capacity unavailable" }, 503) : json(freeEnvelope(mainDraft(init), "synthetic/model:free", 0.001));
    } }), hasCode(failure === "unavailable" ? "UNAVAILABLE" : "INVALID_RESPONSE"));
    assert.deepEqual(hosts, ["openrouter.ai"]);
  }
  const explicitGemini = freeRuntime({ INVESTIGATOR_AI_PROVIDER: "gemini", GEMINI_API_KEY: geminiKey });
  assert.equal(explicitGemini.openrouter, undefined); assert.ok(explicitGemini.gemini);
});

test("free and explicitly selected OpenRouter rate limits return errors without a paid fallback or a fabricated answer", async () => {
  const paidGemini = readInvestigatorAiConfiguration({ INVESTIGATOR_AI_PROVIDER: "gemini", GEMINI_API_KEY: geminiKey }).gemini!;
  for (const configuration of [
    freeRuntime({ INVESTIGATOR_AI_PROVIDER: "openrouter", LOCAL_AI_MODEL: "synthetic-unused-local", GEMINI_API_KEY: geminiKey }),
    { ...freeRuntime(), gemini: paidGemini },
  ]) {
    const hosts: string[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      hosts.push(new URL(String(url)).hostname);
      assert.deepEqual(JSON.parse(String(init?.body)).provider.max_price, { prompt: 0, completion: 0, request: 0 });
      return json({ error: `private-provider-detail ${key}` }, 429);
    };
    await assert.rejects(runInvestigatorWithConfig(getBrowserReportFixture(), configuration, { fetch }), (error: unknown) => error instanceof LocalAiError && error.code === "RATE_LIMITED" && !error.message.includes(key));
    assert.deepEqual(hosts, ["openrouter.ai"]);
    hosts.length = 0;
    const source = getBrowserReportFixture(); source.explanation.model = "openrouter/synthetic/structured-model:free";
    const capsule = createInvestigatorChatContext(source, configuration, secret);
    await assert.rejects(askInvestigatorQuestion("hi", capsule, configuration, secret, { fetch }), (error: unknown) => error instanceof InvestigationQuestionError && error.code === "RATE_LIMITED" && !error.message.includes(key));
    assert.deepEqual(hosts, ["openrouter.ai"]);
  }
});
