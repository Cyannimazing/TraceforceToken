import assert from "node:assert/strict";
import test from "node:test";
import { getBrowserReportFixture } from "../fixtures/report";
import { getBrowserSwarmAssessmentFixture } from "../fixtures/swarm-report";
import { createScanResponse, type ScanDependencies } from "../../src/services/scan-stream";
import { ScanCapacity, ScanCapacityError } from "../../src/services/scan-capacity";
import { readScanEngineConfiguration } from "../../src/config/scan-engine";
import { proxyScanResponse, type RemoteScanConfiguration } from "../../src/server/scan-proxy";
import type { Address, InvestigationDataset } from "../../src/domain/investigations/types";
import { ProviderDeadlineError, ProviderIntegrityError, TokenContractNotFoundError } from "../../src/providers/base/errors";
import { validateProviderEnrichmentBundle } from "../../src/domain/investigations/provider-enrichment";
import { SwarmProviderError } from "../../src/providers/swarm/core";
import { derivePrimaryAssessment } from "../../src/domain/investigations/primary-assessment";
import { AI_RATE_LIMIT_SCAN_MESSAGE } from "../../src/domain/investigations/scan";
import { LocalAiError } from "../../src/agents/model-transport";

const fixture = getBrowserReportFixture();
const parameters = { token: fixture.token.address, lookbackBlocks: 100 };
const dataset: InvestigationDataset = { token: fixture.token, range: fixture.range, evidence: fixture.evidence, pools: [], hubs: [], coverage: fixture.coverage };
const dependencies = (capacity = new ScanCapacity()): ScanDependencies => ({
  capacity, collect: async () => dataset,
  explain: async (report) => ({ ...fixture.explanation, reportId: report.id }),
});
const read = async (response: Response) => (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
const remote: RemoteScanConfiguration = { mode: "remote", url: "https://engine.example/scan", secret: "s".repeat(32), localTest: false };
const noDestinationCheck = async () => undefined;
const candidateAddress = (index: number) => `0x${(index + 20_000).toString(16).padStart(40, "0")}` as Address;
const candidateEnrichment = (addresses: readonly Address[], limitReached = false) => validateProviderEnrichmentBundle({
  schemaVersion: 1, chainId: 8453, tokenAddress: parameters.token, checkedAt: "2026-10-13T00:00:02.000Z",
  sources: [{ provider: "bubblemaps", authority: "source-reported", chainId: 8453, tokenAddress: parameters.token,
    requestedAt: "2026-10-13T00:00:00.000Z", checkedAt: "2026-10-13T00:00:02.000Z", sourceObservedAt: null,
    sourceUrl: `https://v2.bubblemaps.io/map?chain=base&address=${parameters.token}`,
    candidates: addresses.map((address) => ({ address, role: "holder", label: null, reportedSharePercent: null })),
    relationships: [], coverage: { scope: "top-holders-and-context", returnedCandidates: addresses.length, limitReached } }],
  capabilities: [{ provider: "bubblemaps", status: "available" }, { provider: "nansen", status: "not-configured" },
    { provider: "arkham", status: "rights-required" }, { provider: "rugcheck", status: "unsupported-chain" }],
}, parameters.token);

test("fresh source assessment and local evidence both reach the preview and model unchanged", async () => {
  const source = getBrowserSwarmAssessmentFixture(fixture);
  let acquisitions = 0, assessments = 0, reviews = 0;
  const events = await read(createScanResponse(parameters, {
    ...dependencies(),
    collect: async () => { acquisitions++; return dataset; },
    assess: async (token, signal) => { assessments++; assert.equal(token, parameters.token); assert.equal(signal.aborted, false); return source; },
    explain: async (report) => { reviews++; assert.deepEqual(report.swarmAssessment, source); assert.equal(report.evidence.length, dataset.evidence.length); return { ...fixture.explanation, reportId: report.id }; },
  }));
  assert.deepEqual([acquisitions, assessments, reviews], [1, 1, 1]);
  assert.deepEqual(events.find((event) => event.type === "analysis").report.swarmAssessment, source);
  assert.equal(events.find((event) => event.type === "analysis").report.assessmentAuthority, "swarm");
  assert.equal(events.at(-1).type, "report");
  assert.deepEqual(events.at(-1).report.swarmAssessment, source);
  assert.equal(events.at(-1).report.swarmAvailability, undefined);
});

test("unavailable or mismatched optional source does not replace or block the local investigation", async () => {
  let reviews = 0;
  for (const assess of [async () => { throw new Error("private-source-response"); }, async () => ({ ...getBrowserSwarmAssessmentFixture(fixture), tokenAddress: `0x${"f".repeat(40)}` as const })]) {
    const events = await read(createScanResponse(parameters, { ...dependencies(), assess,
      explain: async (report) => { reviews++; return { ...fixture.explanation, reportId: report.id }; },
    }));
    assert.equal(events.at(-1).type, "report");
    assert.equal(events.at(-1).report.swarmAssessment, undefined);
    assert.equal(events.at(-1).report.assessmentAuthority, "swarm");
    assert.equal(events.at(-1).report.swarmAvailability.reason, "unavailable");
    assert.equal(derivePrimaryAssessment(events.at(-1).report).score, null);
    assert.ok(events.at(-1).report.coverage.warnings.some((warning: string) => warning.includes("SWARM context was unavailable")));
    assert.equal(JSON.stringify(events).includes("private-source-response"), false);
  }
  assert.equal(reviews, 2);
});

test("primary source errors retain only a trusted failure class and never substitute a local score", async () => {
  for (const [code, reason] of [["TIMEOUT", "timeout"], ["ACCESS_DENIED", "access_denied"], ["RATE_LIMITED", "rate_limited"], ["STALE_RESULT", "stale_result"], ["INVALID_RESPONSE", "invalid_response"], ["IDENTITY_MISMATCH", "identity_mismatch"]] as const) {
    const events = await read(createScanResponse(parameters, { ...dependencies(), assess: async () => { throw new SwarmProviderError(code); } }));
    const report = events.at(-1).report;
    assert.equal(events.at(-1).type, "report");
    assert.equal(report.swarmAvailability.reason, reason);
    assert.equal(report.swarmAssessment, undefined);
    const primary = derivePrimaryAssessment(report);
    assert.equal(primary.status, "unavailable");
    assert.equal(primary.verdict, "INSUFFICIENT");
    assert.equal(primary.score, null);
  }
  const events = await read(createScanResponse(parameters, dependencies()));
  assert.equal(events.at(-1).report.assessmentAuthority, undefined);
  assert.equal(derivePrimaryAssessment(events.at(-1).report).authority, "traceforge");
});

test("optional source failure leaves candidate discovery usable and releases capacity", async () => {
  const capacity = new ScanCapacity(1);
  let siblingSignal: AbortSignal | undefined;
  const events = await read(createScanResponse(parameters, { ...dependencies(capacity),
    collect: async (_parameters, { signal, candidateAddresses }) => { siblingSignal = signal; assert.deepEqual(await candidateAddresses, []); assert.equal(signal.aborted, false); return dataset; },
    assess: async () => { throw new Error("source unavailable"); },
  }));
  assert.equal(events.at(-1).type, "report");
  assert.equal(siblingSignal?.aborted, true);
  const leave = capacity.enter(); leave();
});

test("overlapping SWARM and enrichment leads reach acquisition once without a false 512-address omission warning", async () => {
  const addresses = Array.from({ length: 300 }, (_, index) => candidateAddress(index));
  const source = { ...getBrowserSwarmAssessmentFixture(fixture), candidates: addresses.slice(0, 256).map((address) => ({ address, roles: ["holder" as const] })) };
  const enrichment = candidateEnrichment(addresses);
  const events = await read(createScanResponse(parameters, { ...dependencies(), assess: async () => source, enrich: async () => enrichment,
    collect: async (_input, { candidateAddresses }) => {
      assert.deepEqual(await candidateAddresses, addresses);
      return dataset;
    },
  }));
  const report = events.at(-1).report;
  assert.equal(events.at(-1).type, "report");
  assert.equal(report.coverage.warnings.some((warning: string) => warning.includes("limited to 512")), false);
  assert.deepEqual(report.providerEnrichment, enrichment);
  assert.deepEqual(report.swarmAssessment, source);
  assert.deepEqual(report.evidence, dataset.evidence, "source addresses cannot invent observations");
});

test("the external candidate cap applies to the unique union while retaining source attribution and a truthful warning", async () => {
  const addresses = Array.from({ length: 600 }, (_, index) => candidateAddress(index));
  const source = { ...getBrowserSwarmAssessmentFixture(fixture), candidates: addresses.slice(0, 256).map((address) => ({ address, roles: ["holder" as const] })) };
  const enrichment = candidateEnrichment(addresses);
  const events = await read(createScanResponse(parameters, { ...dependencies(), assess: async () => source, enrich: async () => enrichment,
    collect: async (_input, { candidateAddresses }) => {
      const retained = await candidateAddresses;
      assert.equal(retained?.length, 512);
      assert.equal(new Set(retained).size, 512);
      assert.deepEqual(retained, addresses.slice(0, 512));
      return dataset;
    },
  }));
  assert.equal(events.at(-1).type, "report");
  const report = events.at(-1).report;
  assert.equal(report.coverage.warnings.filter((warning: string) => warning.includes("limited to 512")).length, 1);
  assert.equal(report.providerEnrichment.sources[0].candidates.length, 600);
  assert.deepEqual(report.evidence, dataset.evidence);
});

test("source-side candidate truncation is disclosed independently of the local unique-address cap", async () => {
  const addresses = [candidateAddress(0), candidateAddress(1)];
  for (const provider of ["swarm", "bubblemaps"] as const) {
    const source = { ...getBrowserSwarmAssessmentFixture(fixture), candidates: [{ address: addresses[0], roles: ["holder" as const] }], candidatesTruncated: provider === "swarm" };
    const enrichment = candidateEnrichment(addresses, provider === "bubblemaps");
    const events = await read(createScanResponse(parameters, { ...dependencies(), assess: async () => source, enrich: async () => enrichment,
      collect: async (_input, { candidateAddresses }) => { assert.deepEqual(await candidateAddresses, addresses); return dataset; },
    }));
    assert.equal(events.at(-1).type, "report");
    const warnings = events.at(-1).report.coverage.warnings as string[];
    assert.equal(warnings.some((warning) => warning.includes("limited to 512")), false);
    assert.equal(warnings.filter((warning) => warning.includes("external source limited its candidate list")).length, 1);
  }
});

test("each request acquires fresh evidence and returns a validated report without a repository", async () => {
  const options = dependencies();
  let acquisitions = 0;
  options.collect = async (_input, { onProgress }) => { acquisitions++; await onProgress("Checking receipt identity"); return dataset; };
  options.createChatContext = () => "synthetic-signed-context";
  const firstResponse = createScanResponse(parameters, options);
  assert.match(firstResponse.headers.get("cache-control")!, /no-store/);
  assert.match(firstResponse.headers.get("content-type")!, /application\/x-ndjson/);
  const first = await read(firstResponse);
  const second = await read(createScanResponse(parameters, options));
  assert.equal(acquisitions, 2);
  assert.ok(first.some((event) => event.type === "progress" && event.stage === "Checking receipt identity"));
  assert.equal(first.at(-1).type, "report");
  assert.equal(first.at(-1).chatContext, "synthetic-signed-context");
  assert.equal(first.at(-1).report.token.address, parameters.token);
  const analysis = first.find((event) => event.type === "analysis");
  assert.ok(analysis); assert.equal(analysis.report.explanation, undefined); assert.equal(analysis.chatContext, undefined);
  assert.equal(analysis.report.id, first.at(-1).report.id);
  assert.notEqual(first.at(-1).report.id, second.at(-1).report.id);
});

test("invalid or unavailable required AI produces an error and releases request capacity", async () => {
  const capacity = new ScanCapacity(1);
  for (const explain of [async () => { throw new Error("private-model-key"); }, async () => ({ ...fixture.explanation, reportId: "wrong-report" })]) {
    const events = await read(createScanResponse(parameters, { ...dependencies(capacity), explain }));
    assert.equal(events.at(-1).type, "error");
    assert.equal(events.some((event) => event.type === "report"), false);
    assert.equal(events.filter((event) => event.type === "analysis").length, 1, "acquired facts remain only an incomplete preview");
    assert.match(events.at(-1).error, /evidence is ready.*AI explanation could not finish/);
    assert.equal(JSON.stringify(events).includes("private-model-key"), false);
    const leave = capacity.enter(); leave();
  }
});

test("a trusted required-AI rate limit keeps evidence incomplete and tells the visitor to wait without leaking provider details", async () => {
  const capacity = new ScanCapacity(1), failure = new LocalAiError("RATE_LIMITED");
  failure.message = "private-model-key and upstream reset-in-999999-days";
  let chatContexts = 0;
  const events = await read(createScanResponse(parameters, { ...dependencies(capacity), explain: async () => { throw failure; }, createChatContext: () => { chatContexts++; return "must-not-be-created"; } }));
  assert.deepEqual(events.at(-1), { type: "error", code: "AI_RATE_LIMITED", error: AI_RATE_LIMIT_SCAN_MESSAGE });
  assert.equal(events.filter((event) => event.type === "error").length, 1);
  assert.equal(events.filter((event) => event.type === "analysis").length, 1);
  assert.equal(events.find((event) => event.type === "analysis").report.explanation, undefined);
  assert.equal(events.some((event) => event.type === "report" || event.chatContext), false);
  assert.equal(chatContexts, 0);
  assert.match(events.at(-1).error, /limit.*reset|reset.*limit/i);
  assert.doesNotMatch(JSON.stringify(events), /private-model-key|999999|must-not-be-created/);
  const leave = capacity.enter(); leave();
  const releaseExplanation = await capacity.explanation(AbortSignal.timeout(100)); releaseExplanation();
});

test("an exception's forged AI rate-limit name or code cannot become trusted quota guidance", async () => {
  for (const failure of [
    Object.assign(new Error("private-model-key"), { name: "LocalAiError", code: "RATE_LIMITED" }),
    Object.assign(new Error("HTTP429 private-model-key"), { code: "RATE_LIMITED" }),
  ]) {
    const capacity = new ScanCapacity(1);
    const events = await read(createScanResponse(parameters, { ...dependencies(capacity), explain: async () => { throw failure; } }));
    assert.deepEqual(events.at(-1), { type: "error", error: "The evidence is ready, but the AI explanation could not finish. Please retry this scan." });
    assert.equal(events.filter((event) => event.type === "analysis").length, 1);
    assert.equal(events.some((event) => event.type === "report" || event.chatContext), false);
    assert.doesNotMatch(JSON.stringify(events), /private-model-key|HTTP429/);
    const leave = capacity.enter(); leave();
  }
});

test("missing finalized Base contract receives specific safe guidance without inference or a report", async () => {
  const capacity = new ScanCapacity(1);
  let inference = 0;
  const failure = new TokenContractNotFoundError();
  failure.message = "private-provider-detail";
  const events = await read(createScanResponse(parameters, { ...dependencies(capacity), collect: async () => { throw failure; },
    explain: async (report) => { inference++; return { ...fixture.explanation, reportId: report.id }; },
  }));
  assert.deepEqual(events.at(-1), { type: "error", error: "No contract found on Base at the finalized block. Check the network and address. New tokens may need time to finalize." });
  assert.equal(events.some((event) => event.type === "analysis" || event.type === "report"), false);
  assert.equal(inference, 0);
  assert.equal(JSON.stringify(events).includes("private-provider-detail"), false);
  const leave = capacity.enter(); leave();
});

test("acquisition errors explain a verified failure class without exposing details or trusting a forged name", async () => {
  const forged = new Error("private-provider-detail"); forged.name = "TokenContractNotFoundError";
  for (const failure of [new Error("private-provider-detail"), new ProviderIntegrityError("private-provider-detail"), forged]) {
    const events = await read(createScanResponse(parameters, { ...dependencies(), collect: async () => { throw failure; } }));
    assert.deepEqual(events.at(-1), { type: "error", error: failure instanceof ProviderIntegrityError
      ? "The returned blockchain data could not be verified. Please retry this scan."
      : "The investigation could not finish. Please try again shortly." });
    assert.equal(JSON.stringify(events).includes("private-provider-detail"), false);
    assert.equal(events.some((event) => event.type === "analysis" || event.type === "report"), false);
  }
});

test("an inner acquisition deadline has a distinct actionable message without publishing partial work", async () => {
  const failure = new ProviderDeadlineError(); failure.message = "private-provider-detail";
  let inference = 0;
  const events = await read(createScanResponse(parameters, { ...dependencies(), collect: async () => { throw failure; },
    explain: async (report) => { inference++; return { ...fixture.explanation, reportId: report.id }; },
  }));
  assert.deepEqual(events.at(-1), { type: "error", error: "The blockchain checks took too long. Try again or choose a recent history window in Scan settings." });
  assert.equal(events.some((event) => event.type === "analysis" || event.type === "report"), false);
  assert.equal(inference, 0);
  assert.equal(JSON.stringify(events).includes("private-provider-detail"), false);
});

test("validated evidence preview is emitted while actual required inference is still pending", async () => {
  let finish!: () => void, started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  const modelFinished = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const result = createScanResponse(parameters, { ...dependencies(), explain: async (report) => { calls++; started(); await modelFinished; return { ...fixture.explanation, reportId: report.id }; } });
  const reader = result.body!.getReader(), decoder = new TextDecoder(); let pending = "";
  for (;;) {
    const chunk = await reader.read(); assert.equal(chunk.done, false); pending += decoder.decode(chunk.value, { stream: true });
    if (pending.split("\n").some((line) => line && JSON.parse(line).type === "analysis")) break;
  }
  const preview = pending.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "analysis");
  assert.ok(preview); assert.equal(preview.report.explanation, undefined);
  assert.equal(pending.includes('"type":"report"'), false);
  await modelStarted; assert.equal(calls, 1);
  finish();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true }); }
  const final = pending.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.equal(final.type, "report"); assert.equal(final.report.id, preview.report.id); assert.ok(final.report.explanation);
});

test("a scan deadline stops hung acquisition and never publishes its eventual result", async () => {
  const capacity = new ScanCapacity(1);
  let complete!: (value: InvestigationDataset) => void;
  let inference = 0;
  const response = createScanResponse(parameters, { ...dependencies(capacity), deadlineMilliseconds: 15,
    collect: () => new Promise((resolve) => { complete = resolve; }),
    explain: async (report) => { inference++; return { ...fixture.explanation, reportId: report.id }; },
  });
  const events = await read(response);
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).error, /time limit/);
  complete(dataset);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(inference, 0);
  const leave = capacity.enter(); leave();
});

test("browser disconnection aborts acquisition and releases capacity", async () => {
  const capacity = new ScanCapacity(1);
  let signal: AbortSignal | undefined;
  const response = createScanResponse(parameters, { ...dependencies(capacity), collect: async (_input, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await response.body!.cancel("visitor left");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(signal?.aborted, true);
  const leave = capacity.enter(); leave();
});

test("disconnect after a genuine analysis preview aborts required inference and releases both slots", async () => {
  const capacity = new ScanCapacity(1);
  let started!: () => void, inferenceSignal: AbortSignal | undefined;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  const response = createScanResponse(parameters, { ...dependencies(capacity), explain: async (_report, { signal }) => {
    inferenceSignal = signal; started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let wire = "";
  while (!wire.includes('"type":"analysis"')) {
    const chunk = await reader.read(); assert.equal(chunk.done, false); wire += decoder.decode(chunk.value);
  }
  await modelStarted;
  await reader.cancel("visitor left the preview");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inferenceSignal?.aborted, true);
  assert.equal(wire.includes('"type":"report"'), false);
  const leave = capacity.enter(), release = await capacity.explanation(new AbortController().signal);
  release(); leave();
});

test("three visitors can collect concurrently while AI uses one cancellable slot", async () => {
  const capacity = new ScanCapacity(3);
  const releases = [capacity.enter(), capacity.enter(), capacity.enter()];
  assert.throws(() => capacity.enter(), ScanCapacityError);
  const first = await capacity.explanation(new AbortController().signal);
  const cancelled = new AbortController();
  const second = capacity.explanation(cancelled.signal);
  let thirdStarted = false;
  const third = capacity.explanation(new AbortController().signal).then((release) => { thirdStarted = true; return release; });
  cancelled.abort(new Error("cancelled question"));
  await assert.rejects(second, /cancelled question/);
  assert.equal(thirdStarted, false);
  first(); first();
  const releaseThird = await third;
  assert.equal(thirdStarted, true);
  releaseThird(); releases.forEach((release) => release());
  const leave = capacity.enter(); leave();
});

test("Vercel requires a trusted engine and rejects untrusted endpoint settings", () => {
  assert.deepEqual(readScanEngineConfiguration({}), { mode: "local" });
  assert.throws(() => readScanEngineConfiguration({ VERCEL: "1" }));
  for (const url of ["http://engine.example/scan", "https://127.0.0.1/scan", "https://engine.example/other", "https://a:b@engine.example/scan", "https://engine.example/scan?key=secret", "https://engine.example/scan#fragment"]) {
    assert.throws(() => readScanEngineConfiguration({ SCAN_ENGINE_URL: url, SCAN_ENGINE_SECRET: remote.secret }));
  }
  assert.equal(readScanEngineConfiguration({ SCAN_ENGINE_URL: remote.url, SCAN_ENGINE_SECRET: remote.secret }).mode, "remote");
});

test("private proxy authenticates and validates a fragmented terminal report", async () => {
  const wire = new TextEncoder().encode(`${JSON.stringify({ type: "progress", stage: "Checking Base" })}\n${JSON.stringify({ type: "report", report: fixture, chatContext: "signed-context" })}\n`);
  const response = await proxyScanResponse(parameters, remote, new AbortController().signal, {
    validateDestination: noDestinationCheck,
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${remote.secret}`);
      assert.equal(init?.redirect, "error");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(wire.slice(0, 80)); controller.enqueue(wire.slice(80)); controller.close(); } }), { headers: { "content-type": "application/x-ndjson" } });
    },
  });
  const events = await read(response);
  assert.equal(events.at(-1).report.id, fixture.id);
  assert.equal(events.at(-1).chatContext, "signed-context");
});

test("proxy rejects invalid, missing and mismatched reports without forwarding engine errors", async () => {
  for (const value of [JSON.stringify({ type: "report", report: {} }), JSON.stringify({ type: "error", error: "private-server-password" }), JSON.stringify({ type: "progress", stage: "Still collecting" })]) {
    const response = await proxyScanResponse(parameters, remote, new AbortController().signal, { validateDestination: noDestinationCheck,
      fetch: async () => new Response(`${value}\n`, { headers: { "content-type": "application/x-ndjson" } }),
    });
    const events = await read(response);
    assert.equal(events.at(-1).type, "error");
    assert.equal(JSON.stringify(events).includes("private-server-password"), false);
  }
  const response = await proxyScanResponse({ ...parameters, token: `0x${"f".repeat(40)}` }, remote, new AbortController().signal, { validateDestination: noDestinationCheck,
    fetch: async () => new Response(`${JSON.stringify({ type: "report", report: fixture })}\n`, { headers: { "content-type": "application/x-ndjson" } }),
  });
  assert.equal((await read(response)).at(-1).type, "error");
});

test("proxy deadline stays active for a stalled stream and cancels it", async () => {
  let cancelled = false;
  const response = await proxyScanResponse(parameters, remote, new AbortController().signal, { validateDestination: noDestinationCheck, timeoutMilliseconds: 15,
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/x-ndjson" } }),
  });
  assert.equal((await read(response)).at(-1).type, "error");
  assert.equal(cancelled, true);
});

test("private proxy validates previews and retains mandatory matching explained completion", async () => {
  const analysis = { ...fixture }; Reflect.deleteProperty(analysis, "explanation");
  const wire = async (events: unknown[]) => read(await proxyScanResponse(parameters, remote, new AbortController().signal, { validateDestination: noDestinationCheck,
    fetch: async () => new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } }),
  }));
  const valid = await wire([{ type: "analysis", report: analysis }, { type: "report", report: fixture }]);
  assert.deepEqual(valid.map((event) => event.type), ["analysis", "report"]);
  for (const events of [
    [{ type: "analysis", report: fixture }],
    [{ type: "analysis", report: analysis }],
    [{ type: "analysis", report: analysis }, { type: "analysis", report: analysis }],
    [{ type: "analysis", report: analysis }, { type: "report", report: { ...fixture, summary: "Changed after preview" } }],
    [{ type: "analysis", report: { ...analysis, token: { ...analysis.token, address: `0x${"f".repeat(40)}` } } }],
  ]) { const result = await wire(events); assert.equal(result.at(-1).type, "error"); assert.equal(result.some((event) => event.type === "report"), false); }
});
