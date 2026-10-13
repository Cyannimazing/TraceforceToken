import assert from "node:assert/strict";
import test from "node:test";
import { runInvestigationWorkerLoop } from "../../src/services/worker-loop";

test("polling awaits each attempt and never starts overlapping jobs", async () => {
  const controller = new AbortController();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  await runInvestigationWorkerLoop({ signal: controller.signal, pollMilliseconds: 1000,
    runOnce: async () => {
      calls++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      if (calls === 2) controller.abort();
      return { status: "completed" };
    },
  });
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});

test("shutdown wakes an idle poll without claiming another job", async () => {
  const controller = new AbortController();
  let calls = 0;
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await runInvestigationWorkerLoop({ signal: controller.signal, pollMilliseconds: 60_000,
      runOnce: async () => { calls++; return { status: "idle" }; },
    });
    assert.equal(controller.signal.aborted, true);
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test("shutdown is passed to active work and waits for its fenced cleanup", async () => {
  const controller = new AbortController();
  let cleanedUp = false;
  let calls = 0;
  const loop = runInvestigationWorkerLoop({ signal: controller.signal,
    runOnce: async (signal) => {
      calls++;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 15), { once: true }));
      cleanedUp = true;
      return { status: "retrying" };
    },
  });
  controller.abort();
  await loop;
  assert.equal(cleanedUp, true);
  assert.equal(calls, 1);
});

test("storage errors leave supervision to the process manager instead of spinning", async () => {
  let calls = 0;
  await assert.rejects(runInvestigationWorkerLoop({ signal: new AbortController().signal,
    runOnce: async () => { calls++; throw new Error("synthetic storage failure"); },
  }), /synthetic storage failure/);
  assert.equal(calls, 1);
});

test("invalid poll budgets and an already stopped worker cannot claim work", async () => {
  const controller = new AbortController();
  let calls = 0;
  const runOnce = async () => { calls++; return { status: "idle" as const }; };
  for (const pollMilliseconds of [0, 999, 60_001, Number.NaN]) {
    await assert.rejects(runInvestigationWorkerLoop({ signal: controller.signal, pollMilliseconds, runOnce }), /polling/);
  }
  controller.abort();
  await runInvestigationWorkerLoop({ signal: controller.signal, runOnce });
  assert.equal(calls, 0);
});
