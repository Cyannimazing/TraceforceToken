import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { analyzeInvestigation } from "../src/domain/investigations/analyze";
import { validateBaseInvestigationReport } from "../src/domain/investigations/report-validation";
import type { Address, InvestigationReport } from "../src/domain/investigations/types";
import { createDeadline } from "../src/lib/deadline";
import { collectInvestigationWithConfig } from "../src/providers/base/collector";
import { readProviderConfiguration } from "../src/providers/base/config";
import { ProviderBudgetError, ProviderIntegrityError, TRANSFER_TOPIC, UpstreamFailure } from "../src/providers/base/core";
import { createProviderTransport, validateProviderDestination } from "../src/providers/base/transport";

// Operator-only, fresh read-only collection. Report/evidence stay in memory.
// This writes metadata only and never invokes AI, a database or public quotas.
const TOKEN = "0x1641ea6eab36969fe11d71e6eb8f102889c735e1" as Address;
const REQUEST_LIMIT = 500;
const DEADLINE_MS = 120_000;
const ARTIFACT = ".artifacts/full-crawl-verification.json";
const knownSources: Record<string, string> = {
  "base.drpc.org": "dRPC", "base-rpc.publicnode.com": "PublicNode", "mainnet.base.org": "Base public",
  "base-mainnet.g.alchemy.com": "Alchemy", "portal.sqd.dev": "SQD public testing",
  "api.gopluslabs.io": "GoPlus", "api.dexscreener.com": "DEX Screener", "api.blockscout.com": "Blockscout PRO",
};

function failureCode(error: unknown) {
  if (error instanceof ProviderIntegrityError) return "EVIDENCE_INTEGRITY_FAILURE";
  if (error instanceof ProviderBudgetError) return "PHYSICAL_REQUEST_BUDGET_EXHAUSTED";
  if (error instanceof UpstreamFailure) return error.httpStatus !== undefined ? `HTTP_${error.httpStatus}` : error.rpcCode !== undefined ? `RPC_${error.rpcCode}` : "UPSTREAM_UNAVAILABLE";
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "DEADLINE_OR_CANCELLATION";
  return "COLLECTION_OR_VALIDATION_FAILURE";
}

function redact(value: string) {
  return value.replace(/https?:\/\/[^\s"<>]+/g, "[provider URL]").slice(0, 1200);
}

function counts<T>(items: readonly T[], key: (item: T) => string) {
  return items.reduce<Record<string, number>>((result, item) => { const value = key(item); result[value] = (result[value] ?? 0) + 1; return result; }, {});
}

function reportMetadata(report: InvestigationReport) {
  return {
    status: report.coverage.transfers === "complete" ? "full_transfer_crawl_complete" : "collected_with_coverage_limits",
    validation: "deterministic_report_and_citations_passed",
    range: { fromBlock: report.range.from.number, toBlock: report.range.to.number, finality: report.range.finality },
    transferCrawl: report.coverage.transferCrawl ?? null,
    transferStatus: report.coverage.transfers,
    verifiedEvidenceCount: report.evidence.length,
    verifiedEvidenceByKind: counts(report.evidence, (item) => item.kind),
    findingsByCategory: counts(report.findings, (item) => item.category),
    knownHistoricalTransferRetained: report.evidence.some((item) => item.kind === "transfer" && item.transactionHash === "0x594c0fba7cf56643f25e60c06ae3b519aa5641827c6a06ce245fd11b26860a37"),
    funding: { eligibleWallets: report.coverage.eligibleWallets, examinedWallets: report.coverage.examinedWallets, byStatus: counts(report.coverage.funding, (item) => item.status) },
    holders: {
      sourceReportedCount: report.token.securitySnapshot?.holderCount ?? null,
      discoveryStatus: report.holderSnapshot?.discovery.status ?? null,
      indexedCandidates: report.holderSnapshot?.discovery.addresses ?? null,
      balanceStatus: report.holderSnapshot?.balances.status ?? null,
      requestedBalances: report.holderSnapshot?.balances.requestedWallets ?? null,
      verifiedBalances: report.holderSnapshot?.balances.verifiedWallets ?? null,
      censusEstablished: false,
    },
    sourceStatuses: {
      websites: report.token.webPresence?.status ?? null,
      market: report.token.marketSnapshot?.status ?? null,
      security: report.token.securitySnapshot?.status ?? null,
      evidenceProviderLabels: [...new Set(report.evidence.map((item) => item.provenance.provider))].map(redact),
    },
    warnings: report.coverage.warnings.map(redact),
  };
}

async function main() {
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
  await mkdir(".artifacts", { recursive: true });
  const startedAt = new Date().toISOString(), began = performance.now();
  const configuration = readProviderConfiguration({
    ...process.env,
    BASE_RPC_LOG_CHUNK_SIZE: "1000000",
    BASE_RPC_CALL_BUDGET: String(REQUEST_LIMIT),
    BASE_PROVIDER_SCAN_TIMEOUT_MS: String(DEADLINE_MS),
  });
  const deadline = createDeadline(DEADLINE_MS);
  const physicalRequests = new Map<string, { source: string; method: string; calls: number; statuses: Record<string, number> }>();
  const progress: { stage: string; elapsedMs: number }[] = [];
  const logQueries: { source: string; fromBlock: string; toBlock: string; status: string }[] = [];
  const originalFetch = globalThis.fetch;
  let actualRequests = 0;
  let result: Record<string, unknown>;
  let report: InvestigationReport | null = null;

  globalThis.fetch = async (input, init) => {
    deadline.signal.throwIfAborted();
    if (actualRequests >= REQUEST_LIMIT) throw new ProviderBudgetError();
    actualRequests++;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const source = knownSources[url.hostname] ?? "Configured approved provider";
    let method = init?.method ?? "GET";
    let query: typeof logQueries[number] | undefined;
    if (typeof init?.body === "string" && init.body.length <= 8192) {
      try {
        const body: unknown = JSON.parse(init.body);
        if (body && typeof body === "object" && "method" in body && typeof body.method === "string" && /^(?:eth|alchemy)_[A-Za-z]+$/.test(body.method)) {
          method = body.method;
          if (method === "eth_getLogs" && "params" in body && Array.isArray(body.params)) {
            const filter: unknown = body.params[0];
            if (filter && typeof filter === "object" && "fromBlock" in filter && "toBlock" in filter && typeof filter.fromBlock === "string" && typeof filter.toBlock === "string" && /^0x[0-9a-f]+$/i.test(filter.fromBlock) && /^0x[0-9a-f]+$/i.test(filter.toBlock)) {
              query = { source, fromBlock: BigInt(filter.fromBlock).toString(), toBlock: BigInt(filter.toBlock).toString(), status: "pending" };
              logQueries.push(query);
            }
          }
        }
      } catch { /* Request instrumentation never stores unparsed input. */ }
    }
    const key = `${source}:${method}`;
    const record = physicalRequests.get(key) ?? { source, method, calls: 0, statuses: {} };
    record.calls++; physicalRequests.set(key, record);
    try {
      const response = await originalFetch(input, init);
      record.statuses[String(response.status)] = (record.statuses[String(response.status)] ?? 0) + 1;
      if (query) query.status = `HTTP_${response.status}`;
      return response;
    } catch (error) {
      record.statuses.unavailable = (record.statuses.unavailable ?? 0) + 1;
      if (query) query.status = "unavailable";
      throw error;
    }
  };

  try {
    const dataset = await collectInvestigationWithConfig({ token: TOKEN, lookbackBlocks: 1000, scope: "full" }, configuration, {
      signal: deadline.signal,
      onProgress: async (stage) => {
        const event = { stage: redact(stage), elapsedMs: Math.round(performance.now() - began) };
        if (progress.length < 120) progress.push(event);
        console.info(JSON.stringify({ progress: event }));
      },
    });
    report = validateBaseInvestigationReport(analyzeInvestigation(dataset, { id: randomUUID(), generatedAt: new Date().toISOString() }));
    if (report.range.from.number !== "0" || report.coverage.transferCrawl?.scope !== "full") throw new ProviderIntegrityError("The verifier did not receive the requested full crawl scope.");
    result = reportMetadata(report);

    if (process.argv.includes("--probe-full-range") && DEADLINE_MS - (performance.now() - began) > 5000 && actualRequests < REQUEST_LIMIT) {
      try {
        const remainingMs = Math.min(15_000, Math.floor(DEADLINE_MS - (performance.now() - began)));
        const signal = AbortSignal.any([deadline.signal, AbortSignal.timeout(remainingMs)]);
        const approved = await validateProviderDestination(configuration, signal);
        const probe = createProviderTransport({ ...approved, rpcUrl: approved.logRpcUrl ?? approved.rpcUrl, rpcFallbackUrls: [] }, signal);
        const raw = await probe.rpc("eth_getLogs", [{ address: TOKEN, topics: [TRANSFER_TOPIC], fromBlock: "0x0", toBlock: `0x${BigInt(report.range.to.number).toString(16)}` }]);
        result.directFullRangeProbe = { status: "query_succeeded_unverified", returnedEntries: Array.isArray(raw) ? raw.length : null, note: "Access diagnostic only; these entries were not incorporated into the report or independently verified." };
      } catch (error) { result.directFullRangeProbe = { status: "unavailable", failure: failureCode(error) }; }
    }
  } catch (error) {
    result = { status: "failed", failure: failureCode(error), fullTransferHistoryEstablished: false };
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    deadline.dispose();
    report = null;
  }

  const artifact = {
    schemaVersion: 1, token: TOKEN, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - began),
    requestedScope: "full", logChunkSize: configuration.limits.logChunkSize,
    limits: { physicalRequests: REQUEST_LIMIT, deadlineMs: DEADLINE_MS, maxRetainedTransferLogs: configuration.limits.maxTransferLogs },
    configuredSources: { transfer: configuration.transferSource ?? "rpc", funding: configuration.fundingSource, separateLogLane: Boolean(configuration.logRpcUrl), alchemyLane: Boolean(configuration.alchemyRpcUrl), authenticatedBlockscout: Boolean(configuration.blockscoutApiKey) },
    actualRequests, physicalRequests: [...physicalRequests.values()], logQueries, progress, ...result!,
    scopeNote: "One fresh production collector and pure analyzer. Only metadata is stored here. No AI, database, public quota, raw response, report or evidence storage. Search completion does not prove provider omission freedom, a full holder census, internal native history, lifetime-first funding, ownership or contract safety.",
  };
  await writeFile(ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.info(JSON.stringify({ artifact: ARTIFACT, ...artifact }));
}

void main().catch(() => {
  console.error(JSON.stringify({ status: "operator_verifier_setup_failed", fullTransferHistoryEstablished: false }));
  process.exitCode = 1;
});
