import assert from "node:assert/strict";
import test from "node:test";
import type { ExplainedInvestigationReport, InvestigationDataset, InvestigationExplanation, InvestigationJob, InvestigationReport } from "../../src/domain/investigations/types";
import type { InvestigationRepository } from "../../src/repositories/investigations";
import { runNextInvestigation } from "../../src/services/run-investigation";

const address = `0x${"1".repeat(40)}` as const;
const dataset: InvestigationDataset = {
  token: { address, chainId: 8453, name: "Test token", symbol: "TEST", decimals: 18, totalSupplyRaw: "100000000000000000000" },
  range: { from: { number: "100", hash: `0x${"a".repeat(64)}`, timestamp: 1000 }, to: { number: "200", hash: `0x${"b".repeat(64)}`, timestamp: 1200 }, finality: "finalized" },
  evidence: [], pools: [], hubs: [], coverage: { transfers: "complete", funding: [], eligibleWallets: 0, examinedWallets: 0, warnings: [] },
};

async function explain(report: InvestigationReport): Promise<InvestigationExplanation> {
  return {
    schemaVersion: 1, reportId: report.id, profileId: "on-chain-investigator", profileVersion: "1.0.0",
    model: "synthetic-worker-test", generatedAt: report.generatedAt,
    overview: { text: "Synthetic worker explanation: no token evidence was retained; activity remains unknown beyond the examined coverage.", evidenceIds: [] },
    observations: [], limitations: ["Synthetic test fixture; no live AI or blockchain verification."],
    context: { evidenceIds: [], suppliedEvidence: 0, omittedEvidence: report.evidence.length },
    authority: "non-authoritative-commentary",
  };
}

function repository(options: { leaseLost?: boolean; leaseLostAfter?: number; completeLost?: boolean; idle?: boolean; terminalFailure?: boolean } = {}) {
  const job: InvestigationJob = { id: "b3db49c2-0bbb-49d6-a21b-ecc339868aa4", status: "running", parameters: { token: address, lookbackBlocks: 100 }, stage: "Starting", attempts: 1, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", error: null, report: null };
  const state = { completed: null as ExplainedInvestigationReport | null, failed: false, heartbeats: 0, stages: [] as string[] };
  const implementation: InvestigationRepository = {
    enqueue: async () => job, get: async () => job,
    claimNext: async () => options.idle ? null : { job, leaseToken: "9d2c6f10-0a29-4ca6-a35c-32cb2634938c" },
    heartbeat: async (_id, _token, stage) => { state.heartbeats++; state.stages.push(stage); return !options.leaseLost && !(options.leaseLostAfter && state.heartbeats > options.leaseLostAfter); },
    complete: async (_id, _token, report) => { if (options.completeLost) return false; state.completed = report; return true; },
    fail: async (_id, _token, error) => { assert.equal(error.includes("private-provider-key"), false); state.failed = true; job.status = options.terminalFailure ? "failed" : "queued"; return true; },
  };
  return { implementation, state, job };
}

test("worker composes real analysis and commits evidence only through its claimed lease", async () => {
  const repo = repository();
  const result = await runNextInvestigation({ repository: repo.implementation, explain, collect: async (_parameters, { onProgress }) => { await onProgress("Verifying block identity"); return dataset; } });
  assert.equal(result.status, "completed");
  assert.equal(repo.state.completed?.id, repo.job.id);
  assert.equal(repo.state.completed?.range.to.hash, dataset.range.to.hash);
  assert.equal(repo.state.completed?.mode, "live");
  assert.equal(repo.state.completed?.explanation.reportId, repo.job.id);
  assert.ok(repo.state.stages.includes("Rewriting evidence in plain English"));
  assert.ok(repo.state.heartbeats >= 3);
  assert.equal(repo.state.failed, false);
});

test("an empty queue makes no provider request", async () => {
  const repo = repository({ idle: true });
  let calls = 0;
  assert.equal((await runNextInvestigation({ repository: repo.implementation, explain, collect: async () => { calls++; return dataset; } })).status, "idle");
  assert.equal(calls, 0);
});

test("a lost heartbeat prevents provider acquisition or a stale failure write", async () => {
  const repo = repository({ leaseLost: true });
  let calls = 0;
  assert.equal((await runNextInvestigation({ repository: repo.implementation, explain, collect: async () => { calls++; return dataset; } })).status, "lost_lease");
  assert.equal(calls, 0);
  assert.equal(repo.state.failed, false);
});

test("provider failures become retry state without leaking upstream messages", async () => {
  const repo = repository();
  const result = await runNextInvestigation({ repository: repo.implementation, explain, collect: async () => { throw new Error("https://provider.example/private-provider-key"); } });
  assert.equal(result.status, "retrying");
  assert.equal(repo.state.failed, true);
  assert.equal(repo.state.completed, null);
});

test("completion rejected by lease compare-and-swap never becomes success", async () => {
  const repo = repository({ completeLost: true });
  const result = await runNextInvestigation({ repository: repo.implementation, explain, collect: async () => dataset });
  assert.equal(result.status, "lost_lease");
  assert.equal(repo.state.completed, null);
});

test("an exhausted job reports terminal failure rather than promising another retry", async () => {
  const repo = repository({ terminalFailure: true });
  const result = await runNextInvestigation({ repository: repo.implementation, explain, collect: async () => { throw new Error("Provider unavailable"); } });
  assert.equal(result.status, "failed");
  assert.equal(repo.state.failed, true);
});

test("AI unavailability retries without completing or leaking model/server details", async () => {
  const repo = repository();
  const result = await runNextInvestigation({ repository: repo.implementation, collect: async () => dataset, explain: async () => { throw new Error("private-provider-key model unavailable"); } });
  assert.equal(result.status, "retrying");
  assert.equal(repo.state.completed, null);
  assert.equal(repo.state.failed, true);
  assert.ok(repo.state.stages.includes("Rewriting evidence in plain English"));
});

test("an invalid or invented AI citation cannot become a completed report", async () => {
  const repo = repository();
  const result = await runNextInvestigation({ repository: repo.implementation, collect: async () => dataset, explain: async (report) => ({ ...await explain(report), overview: { text: "Invented transfer", evidenceIds: ["invented-evidence"] } }) });
  assert.equal(result.status, "retrying");
  assert.equal(repo.state.completed, null);
  assert.equal(repo.state.failed, true);
});

test("lease loss during AI generation aborts output and cannot fail or publish stale work", async () => {
  const repo = repository({ leaseLostAfter: 3 });
  let observedAbort = false;
  const result = await runNextInvestigation({ repository: repo.implementation, collect: async () => dataset, explain: async (report, { signal, onProgress }) => {
    try { await onProgress("Rewriting evidence in plain English"); }
    finally { observedAbort = signal.aborted; }
    return explain(report);
  } });
  assert.equal(result.status, "lost_lease");
  assert.equal(observedAbort, true);
  assert.equal(repo.state.completed, null);
  assert.equal(repo.state.failed, false);
});

test("heartbeats continue while the required explanation is being generated", async () => {
  const repo = repository();
  const result = await runNextInvestigation({ repository: repo.implementation, collect: async () => dataset,
    heartbeatMilliseconds: 5,
    explain: async (report) => { await new Promise((resolve) => setTimeout(resolve, 35)); return explain(report); },
  });
  assert.equal(result.status, "completed");
  assert.ok(repo.state.stages.filter((stage) => stage === "Rewriting evidence in plain English").length >= 3);
});

test("an overall deadline during AI generation fails the attempt without a fallback report", async () => {
  const repo = repository();
  let sawCancellation = false;
  const result = await runNextInvestigation({ repository: repo.implementation, collect: async () => dataset,
    deadlineMilliseconds: 10,
    explain: async (report, { signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      sawCancellation = signal.aborted;
      return explain(report);
    },
  });
  assert.equal(result.status, "retrying");
  // Orchestration now stops before an adapter that ignores cancellation returns.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sawCancellation, true);
  assert.equal(repo.state.completed, null);
  assert.equal(repo.state.failed, true);
});

test("overall cancellation stops lease renewal and releases a hung acquisition attempt", async () => {
  const repo = repository();
  let signal: AbortSignal | undefined;
  let renewalsAfterAbort = 0;
  const originalHeartbeat = repo.implementation.heartbeat;
  repo.implementation.heartbeat = async (...args) => {
    if (signal?.aborted) renewalsAfterAbort++;
    return originalHeartbeat(...args);
  };
  const keepAlive = setTimeout(() => undefined, 300);
  try {
    const result = await runNextInvestigation({ repository: repo.implementation, explain,
      deadlineMilliseconds: 15, heartbeatMilliseconds: 5,
      collect: async (_parameters, options) => { signal = options.signal; return new Promise<InvestigationDataset>(() => undefined); },
    });
    assert.equal(result.status, "retrying");
    assert.equal(signal?.aborted, true);
    const heartbeats = repo.state.heartbeats;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(repo.state.heartbeats, heartbeats);
    assert.equal(renewalsAfterAbort, 0);
    assert.equal(repo.state.failed, true);
    assert.equal(repo.state.completed, null);
  } finally { clearTimeout(keepAlive); }
});

test("late rejection from abandoned acquisition is handled after cancellation", async () => {
  const repo = repository();
  const result = await runNextInvestigation({ repository: repo.implementation, explain,
    deadlineMilliseconds: 5,
    collect: async () => new Promise<InvestigationDataset>((_resolve, reject) => setTimeout(() => reject(new Error("private late provider detail")), 40)),
  });
  assert.equal(result.status, "retrying");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(repo.state.completed, null);
});
