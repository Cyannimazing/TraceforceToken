import assert from "node:assert/strict";
import test from "node:test";
import { getBrowserReportFixture } from "../fixtures/report";
import { InvestigationStreamError, readInvestigationStream } from "../../src/components/investigation-stream";
import { AI_RATE_LIMIT_SCAN_MESSAGE } from "../../src/domain/investigations/scan";
import { proxyScanResponse } from "../../src/server/scan-proxy";

const response = (events: unknown[]) => new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
const options = () => ({ signal: new AbortController().signal, onProgress: () => undefined });
const baseReport = () => { const report = getBrowserReportFixture(); Reflect.deleteProperty(report, "explanation"); return report; };

test("fragmented UTF-8 NDJSON delivers progress then a fully validated in-memory report", async () => {
  const report = getBrowserReportFixture(); report.token.name = "Synthetic café fixture";
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "progress", stage: "Checking transaction receipts" }) + "\n" + JSON.stringify({ type: "report", report }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13)); controller.close(); } });
  const stages: string[] = [];
  const result = await readInvestigationStream(new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } }), { ...options(), onProgress: (stage) => stages.push(stage) });
  assert.deepEqual(stages, ["Checking transaction receipts"]); assert.deepEqual(result, { report });
});

test("analysis becomes available before the required final explanation without becoming stream success", async () => {
  const analysis = baseReport(), report = getBrowserReportFixture(), seen: string[] = [];
  const result = await readInvestigationStream(response([{ type: "analysis", report: analysis }, { type: "progress", stage: "Preparing the AI explanation" }, { type: "report", report }]), {
    ...options(), onAnalysis: (value) => { assert.deepEqual(value, analysis); assert.equal(value.explanation, undefined); seen.push("analysis"); }, onProgress: (stage) => seen.push(stage),
  });
  seen.push("final");
  assert.deepEqual(seen, ["analysis", "Preparing the AI explanation", "final"]);
  assert.deepEqual(result.report, report);
  for (const last of [undefined, { type: "error", error: "The required AI explanation could not complete." }]) {
    let previews = 0;
    await assert.rejects(readInvestigationStream(response([{ type: "analysis", report: analysis }, ...(last ? [last] : [])]), { ...options(), onAnalysis: () => { previews++; } }), InvestigationStreamError);
    assert.equal(previews, 1);
  }
});

test("duplicate, fabricated and mismatched analysis frames fail before completion", async () => {
  const analysis = baseReport(), report = getBrowserReportFixture();
  for (const invalid of [
    { type: "analysis", report },
    { type: "analysis", report: analysis, chatContext: "not-authorized-before-ai" },
    { type: "analysis", report: { ...analysis, findings: [{ ...analysis.findings[0], evidenceIds: ["invented"] }] } },
  ]) {
    let previews = 0;
    await assert.rejects(readInvestigationStream(response([invalid]), { ...options(), onAnalysis: () => { previews++; } }), InvestigationStreamError);
    assert.equal(previews, 0);
  }
  await assert.rejects(readInvestigationStream(response([{ type: "analysis", report: analysis }, { type: "analysis", report: analysis }]), options()), /report could not be validated/);
  for (const final of [{ ...report, id: "22222222-2222-4222-8222-222222222222", explanation: { ...report.explanation, reportId: "22222222-2222-4222-8222-222222222222" } }, { ...report, token: { ...report.token, name: "Different facts after preview" } }]) await assert.rejects(readInvestigationStream(response([{ type: "analysis", report: analysis }, { type: "report", report: final }]), options()), /report could not be validated/);
});

test("cancellation after a preview stops the unfinished explanation stream", async () => {
  const controller = new AbortController(); let cancelled = false, previews = 0;
  const stream = new ReadableStream<Uint8Array>({ start(output) { output.enqueue(new TextEncoder().encode(JSON.stringify({ type: "analysis", report: baseReport() }) + "\n")); }, cancel() { cancelled = true; } });
  const pending = readInvestigationStream(new Response(stream, { headers: { "content-type": "application/x-ndjson" } }), { signal: controller.signal, onProgress: () => undefined, onAnalysis: () => { previews++; controller.abort(); } });
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(previews, 1); assert.equal(cancelled, true);
});

test("a signed question context stays separate from report data and is bounded", async () => {
  const report = getBrowserReportFixture(), chatContext = "synthetic-signed.context-only-for-browser-fixture";
  const result = await readInvestigationStream(response([{ type: "report", report, chatContext }]), options());
  assert.deepEqual(result, { report, chatContext }); assert.equal("chatContext" in result.report, false);
  for (const context of ["", "x".repeat(32769), "bad\u0000context", 42]) await assert.rejects(readInvestigationStream(response([{ type: "report", report, chatContext: context }]), options()), /incomplete or invalid/);
});

test("missing explanations and invented report citations never reach rendering", async () => {
  const source = getBrowserReportFixture();
  for (const report of [{ ...source, explanation: null }, { ...source, explanation: { ...source.explanation, overview: { text: "Unsupported citation.", evidenceIds: ["invented"] } } }, { ...source, range: { ...source.range, to: { ...source.range.to, timestamp: "invalid" } } }]) await assert.rejects(readInvestigationStream(response([{ type: "report", report }]), options()), /report could not be validated/);
});

test("safe public HTTP and stream errors surface without interpreting markup", async () => {
  const message = "Data sources were unavailable. Start a fresh investigation.";
  await assert.rejects(readInvestigationStream(response([{ type: "error", error: message }]), options()), (error: unknown) => error instanceof InvestigationStreamError && error.message === message);
  await assert.rejects(readInvestigationStream(Response.json({ error: message }, { status: 503 }), options()), (error: unknown) => error instanceof InvestigationStreamError && error.message === message);
  for (const error of ["x".repeat(241), "Bad\u0000text", ""]) await assert.rejects(readInvestigationStream(response([{ type: "error", error }]), options()), /incomplete or invalid/);
});

test("AI quota errors retain the validated preview and use fixed public copy rather than upstream prose", async () => {
  const analysis = baseReport(), previews: unknown[] = [];
  await assert.rejects(readInvestigationStream(response([
    { type: "analysis", report: analysis },
    { type: "error", code: "AI_RATE_LIMITED", error: "Private upstream model/account details must never be displayed." },
  ]), { ...options(), onAnalysis: (report) => previews.push(report) }), (error: unknown) => error instanceof InvestigationStreamError
    && error.code === "AI_RATE_LIMITED" && error.message === AI_RATE_LIMIT_SCAN_MESSAGE && !error.message.includes("Private upstream"));
  assert.deepEqual(previews, [analysis]);
  assert.equal((previews[0] as typeof analysis).explanation, undefined, "quota failure does not promote an evidence preview to a completed report");
  for (const invalid of [
    { type: "error", code: "UNKNOWN_PROVIDER_CODE", error: "Untrusted private provider details" },
    { type: "error", code: 429, error: "Untrusted private provider details" },
    { type: "error", code: "AI_RATE_LIMITED", error: "Untrusted private provider details", upstreamBody: "untrusted" },
  ]) {
    let previewCount = 0;
    await assert.rejects(readInvestigationStream(response([{ type: "analysis", report: analysis }, invalid]), { ...options(), onAnalysis: () => previewCount++ }),
      (error: unknown) => error instanceof InvestigationStreamError && error.code === undefined && !error.message.includes("private provider"));
    assert.equal(previewCount, 1);
  }
});

test("the remote scan proxy preserves finite AI quota codes and canonicalizes their message before browser consumption", async () => {
  const analysis = baseReport(), upstreamMessage = "Private upstream quota body: provider routing and account details.";
  let requests = 0;
  const proxied = await proxyScanResponse({ token: analysis.token.address, lookbackBlocks: 100, scope: "full" },
    { mode: "remote", url: "https://engine.example/scan", secret: "synthetic-test-engine-secret-123456789", localTest: false }, new AbortController().signal,
    { validateDestination: async () => undefined, fetch: async (_url, init) => {
      requests++;
      assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
      return response([{ type: "analysis", report: analysis }, { type: "error", code: "AI_RATE_LIMITED", error: upstreamMessage }]);
    } });
  const forwarded = (await proxied.clone().text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(forwarded.at(-1), { type: "error", code: "AI_RATE_LIMITED", error: AI_RATE_LIMIT_SCAN_MESSAGE });
  assert.ok(!JSON.stringify(forwarded).includes(upstreamMessage));
  const previews: unknown[] = [];
  await assert.rejects(readInvestigationStream(proxied, { ...options(), onAnalysis: (report) => previews.push(report) }),
    (error: unknown) => error instanceof InvestigationStreamError && error.code === "AI_RATE_LIMITED" && error.message === AI_RATE_LIMIT_SCAN_MESSAGE);
  assert.deepEqual(previews, [analysis]); assert.equal(requests, 1, "quota failure does not fetch a replacement result");
});

test("the remote scan proxy rejects unknown error codes without forwarding provider details", async () => {
  const analysis = baseReport(), previews: unknown[] = [];
  const proxied = await proxyScanResponse({ token: analysis.token.address, lookbackBlocks: 100 },
    { mode: "remote", url: "https://engine.example/scan", secret: "synthetic-test-engine-secret-123456789", localTest: false }, new AbortController().signal,
    { validateDestination: async () => undefined, fetch: async () => response([
      { type: "analysis", report: analysis }, { type: "error", code: "UNKNOWN_PROVIDER_CODE", error: "Private upstream account details." },
    ]) });
  const text = await proxied.clone().text();
  assert.ok(!text.includes("UNKNOWN_PROVIDER_CODE")); assert.ok(!text.includes("Private upstream account"));
  await assert.rejects(readInvestigationStream(proxied, { ...options(), onAnalysis: (report) => previews.push(report) }),
    (error: unknown) => error instanceof InvestigationStreamError && error.code === undefined && /connection ended/.test(error.message));
  assert.deepEqual(previews, [analysis]);
});

test("unknown envelopes, truncated streams and unsupported response types reject", async () => {
  for (const source of [response([{ type: "progress", stage: "Checking" }]), response([{ type: "unexpected" }]), response([{ type: "progress", stage: "Checking", extra: true }]), new Response('{"type":"report"', { headers: { "content-type": "application/x-ndjson" } }), Response.json({ id: "legacy-job" })]) await assert.rejects(readInvestigationStream(source, options()), /incomplete or invalid/);
});

test("declared and streamed size caps reject oversized responses", async () => {
  await assert.rejects(readInvestigationStream(new Response("", { headers: { "content-type": "application/x-ndjson", "content-length": String(16 * 1024 * 1024 + 1) } }), options()), /size limit/);
  const huge = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); controller.close(); } });
  await assert.rejects(readInvestigationStream(new Response(huge, { headers: { "content-type": "application/x-ndjson" } }), options()), /size limit/);
  const report = getBrowserReportFixture(); report.summary = "x".repeat(8 * 1024 * 1024);
  await assert.rejects(readInvestigationStream(response([{ type: "report", report }]), options()), /report could not be validated/);
});

test("cancellation interrupts a stalled body and cancels its reader", async () => {
  const controller = new AbortController(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
  const pending = readInvestigationStream(new Response(stream, { headers: { "content-type": "application/x-ndjson" } }), { signal: controller.signal, onProgress: () => undefined });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError"); assert.equal(cancelled, true);
});
