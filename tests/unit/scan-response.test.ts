import assert from "node:assert/strict";
import test from "node:test";
import { getBrowserReportFixture } from "../fixtures/report";
import { createScanResponse, type ScanDependencies } from "../../src/services/scan-stream";
import { ScanCapacity, ScanCapacityError } from "../../src/services/scan-capacity";
import { readScanEngineConfiguration } from "../../src/config/scan-engine";
import { proxyScanResponse, type RemoteScanConfiguration } from "../../src/server/scan-proxy";
import type { InvestigationDataset } from "../../src/domain/investigations/types";
import { ProviderIntegrityError, TokenContractNotFoundError } from "../../src/providers/base/errors";

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
    assert.equal(JSON.stringify(events).includes("private-model-key"), false);
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

test("other acquisition errors and forged error names remain sanitized generic failures", async () => {
  const forged = new Error("private-provider-detail"); forged.name = "TokenContractNotFoundError";
  for (const failure of [new Error("private-provider-detail"), new ProviderIntegrityError("private-provider-detail"), forged]) {
    const events = await read(createScanResponse(parameters, { ...dependencies(), collect: async () => { throw failure; } }));
    assert.deepEqual(events.at(-1), { type: "error", error: "The investigation could not finish. Check the token address or try again shortly." });
    assert.equal(JSON.stringify(events).includes("private-provider-detail"), false);
    assert.equal(events.some((event) => event.type === "analysis" || event.type === "report"), false);
  }
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
