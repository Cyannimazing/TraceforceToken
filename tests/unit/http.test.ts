import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, readSmallJson } from "../../src/lib/http";

test("JSON limits enforce actual streamed bytes even without content-length", async () => {
  const request = new Request("https://traceforge.example/api/investigations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "é".repeat(100) }) });
  await assert.rejects(readSmallJson(request, 100), (error: unknown) => error instanceof HttpError && error.status === 413);
  const valid = new Request("https://traceforge.example/api/investigations", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: '{"token":"test"}' });
  assert.deepEqual(await readSmallJson(valid), { token: "test" });
  await assert.rejects(readSmallJson(new Request("https://traceforge.example", { method: "POST", body: "not json" })), (error: unknown) => error instanceof HttpError && error.status === 415);
});
