import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createDeadline } from "../../src/lib/deadline";

test("owned deadlines fire under repeated garbage collection on the installed Node runtime", () => {
  const result = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "-e", `
    const { createDeadline } = require('./src/lib/deadline.ts');
    const began = performance.now();
    const deadline = createDeadline(250);
    const sweep = setInterval(() => global.gc(), 10);
    const watchdog = setTimeout(() => { deadline.dispose(); clearInterval(sweep); process.exitCode = 1; }, 1500);
    deadline.signal.addEventListener('abort', () => {
      console.log(JSON.stringify({ aborted: deadline.signal.aborted, reason: deadline.signal.reason.name, elapsed: performance.now() - began }));
      deadline.dispose(); clearInterval(sweep); clearTimeout(watchdog);
    }, { once: true });
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  const outcome = JSON.parse(result.trim()) as { aborted: boolean; reason: string; elapsed: number };
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.reason, "TimeoutError");
  assert.ok(outcome.elapsed >= 200 && outcome.elapsed < 1400);
});

test("parent cancellation preserves its reason and removes every forwarding listener", () => {
  const first = new AbortController();
  const second = new AbortController();
  const deadline = createDeadline(60_000, [first.signal, second.signal]);
  const reason = new Error("Synthetic outer cancellation");
  assert.equal(getEventListeners(first.signal, "abort").length, 1);
  assert.equal(getEventListeners(second.signal, "abort").length, 1);
  second.abort(reason);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason, reason);
  assert.equal(getEventListeners(first.signal, "abort").length, 0);
  assert.equal(getEventListeners(second.signal, "abort").length, 0);
  deadline.dispose();
});

test("disposing a completed deadline clears its timer and detaches parent cancellation", async () => {
  const parent = new AbortController();
  const deadline = createDeadline(10, [parent.signal]);
  deadline.dispose();
  deadline.dispose();
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  parent.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(deadline.signal.aborted, false);
});

test("already aborted parents fail immediately without leaving listeners", () => {
  const first = new AbortController();
  const stopped = new AbortController();
  stopped.abort(new Error("Already stopped"));
  const deadline = createDeadline(60_000, [first.signal, stopped.signal]);
  assert.equal(deadline.signal.reason, stopped.signal.reason);
  assert.equal(getEventListeners(first.signal, "abort").length, 0);
  deadline.dispose();
});
