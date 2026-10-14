import assert from "node:assert/strict";
import test from "node:test";
import { readInvestigationAnswer } from "../../src/components/investigation-question-response";

const body = { answer: "The observed transfer links these addresses.", caveat: "A transfer does not establish common ownership.", evidenceIds: ["known-evidence"], needsFreshScan: false };
const signal = () => new AbortController().signal;
test("question responses retain known citations and reject invented, duplicate, unbounded or malformed answers", async () => {
  const known = new Set(["known-evidence"]);
  assert.deepEqual(await readInvestigationAnswer(Response.json(body), known, signal()), body);
  for (const source of [{ ...body, evidenceIds: ["invented"] }, { ...body, evidenceIds: ["known-evidence", "known-evidence"] }, { ...body, answer: "x".repeat(1001) }, { ...body, caveat: "bad\u0000text" }, { ...body, needsFreshScan: "yes" }]) await assert.rejects(readInvestigationAnswer(Response.json(source), known, signal()), /could not be validated/);
});
test("question response bytes are bounded and safe server errors remain readable", async () => {
  await assert.rejects(readInvestigationAnswer(new Response("x".repeat(65537)), new Set(), signal()), /could not be validated/);
  await assert.rejects(readInvestigationAnswer(Response.json({ error: "This question session has expired. Run a fresh scan." }, { status: 410 }), new Set(), signal()), /session has expired/);
  for (const source of [
    { error: "The AI service is temporarily unavailable. Try again shortly.", code: "AI_UNAVAILABLE" },
    { error: "The AI answer could not be verified. Try rephrasing your question about this scan.", code: "AI_RESPONSE_UNVERIFIED" },
    { error: "The AI provider has reached its request limit. Wait for it to reset before trying again.", code: "AI_RATE_LIMITED" },
  ]) await assert.rejects(readInvestigationAnswer(Response.json(source, { status: 503, headers: { "cache-control": "private, no-store" } }), new Set(), signal()), (error: unknown) => error instanceof Error && error.message === source.error);
  for (const source of [
    { error: "Untrusted details must not become public copy.", code: "UNRECOGNIZED_PROVIDER_ERROR" },
    { error: "Untrusted details must not become public copy.", code: "AI_RESPONSE_UNVERIFIED", providerBody: "untrusted diagnostics" },
    { error: "Untrusted details must not become public copy.", code: "AI_RATE_LIMITED", providerBody: "untrusted diagnostics" },
  ]) await assert.rejects(readInvestigationAnswer(Response.json(source, { status: 503 }), new Set(), signal()), /Questions are temporarily unavailable/);
  await assert.rejects(readInvestigationAnswer(Response.json({ error: "bad\u0000text" }, { status: 503 }), new Set(), signal()), /temporarily unavailable/);
});
test("cancellation closes a stalled question-response stream", async () => {
  const controller = new AbortController(); let cancelled = false;
  const pending = readInvestigationAnswer(new Response(new ReadableStream({ cancel() { cancelled = true; } })), new Set(), controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError"); assert.equal(cancelled, true);
});
