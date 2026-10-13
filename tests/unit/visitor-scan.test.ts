import assert from "node:assert/strict";
import test from "node:test";
import { runVisitorScan } from "../../src/services/visitor-scan";

const encoder = new TextEncoder();
function pendingSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  return { response: new Response(body, { headers: { "content-type": "application/x-ndjson" } }), controller, isCancelled: () => cancelled };
}

test("visitor lease spans the complete stream and releases once on successful completion", async () => {
  const source = pendingSource(); let releases = 0;
  const response = await runVisitorScan(() => source.response, async () => { releases++; }, new AbortController().signal);
  source.controller.enqueue(encoder.encode("progress\n"));
  assert.equal(releases, 0);
  source.controller.enqueue(encoder.encode("report\n")); source.controller.close();
  assert.equal(await response.text(), "progress\nreport\n");
  assert.equal(releases, 1);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
});

test("client cancellation aborts upstream work and releases its lease once", async () => {
  const source = pendingSource(); let releases = 0; let signal!: AbortSignal;
  const response = await runVisitorScan((value) => { signal = value; return source.response; }, async () => { releases++; }, new AbortController().signal);
  await response.body!.cancel("client disconnected");
  assert.equal(signal.aborted, true); assert.equal(source.isCancelled(), true); assert.equal(releases, 1);
});

test("parent disconnect cancels a stalled reader and frees the visitor lease", async () => {
  const source = pendingSource(), parent = new AbortController(); let releases = 0;
  const response = await runVisitorScan(() => source.response, async () => { releases++; }, parent.signal);
  const body = response.text(); parent.abort(new Error("disconnected"));
  await assert.rejects(body); assert.equal(source.isCancelled(), true); assert.equal(releases, 1);
});

test("deadline aborts a stalled stream rather than leaving a permanent active-scan lock", async () => {
  const source = pendingSource(); let releases = 0;
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const response = await runVisitorScan(() => source.response, async () => { releases++; }, new AbortController().signal, 15);
    await assert.rejects(response.text());
    assert.equal(source.isCancelled(), true); assert.equal(releases, 1);
  } finally { clearTimeout(keepAlive); }
});

test("execution failure, already-aborted callers and empty responses release reservations", async () => {
  let releases = 0;
  const release = async () => { releases++; };
  await assert.rejects(runVisitorScan(() => { throw new Error("execution unavailable"); }, release, new AbortController().signal));
  const parent = new AbortController(); parent.abort();
  await assert.rejects(runVisitorScan(() => { throw new Error("must not execute"); }, release, parent.signal));
  const response = await runVisitorScan(() => new Response(null, { status: 204 }), release, new AbortController().signal);
  assert.equal(response.status, 204); assert.equal(releases, 3);
});

test("failed lease cleanup does not disclose connection details or replace a finished response", async () => {
  const response = await runVisitorScan(() => new Response("done"), async () => { throw new Error("mysql://private:secret@host/db"); }, new AbortController().signal);
  assert.equal(await response.text(), "done");
});
