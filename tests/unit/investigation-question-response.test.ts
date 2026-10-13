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
  await assert.rejects(readInvestigationAnswer(Response.json({ error: "bad\u0000text" }, { status: 503 }), new Set(), signal()), /temporarily unavailable/);
});
test("cancellation closes a stalled question-response stream", async () => {
  const controller = new AbortController(); let cancelled = false;
  const pending = readInvestigationAnswer(new Response(new ReadableStream({ cancel() { cancelled = true; } })), new Set(), controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError"); assert.equal(cancelled, true);
});
