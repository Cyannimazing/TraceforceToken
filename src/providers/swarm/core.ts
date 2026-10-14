import { z } from "@/lib/validation";
import { createDeadline } from "@/lib/deadline";
import { SWARM_MAX_CANDIDATES, SWARM_ORIGIN, inspectSwarmFreshness, validateSwarmAssessmentSnapshot, type SwarmAssessmentSnapshot, type SwarmTransport } from "@/domain/investigations/swarm-assessment";

const MAX_RESPONSE_BYTES = 1_048_576;
const tokenSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const jobSchema = z.object({ job: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const progressSchema = z.object({
  done: z.boolean(), events: z.array(z.unknown()).max(1000).optional().default([]),
  token: tokenSchema.nullable().optional(), chain: z.string().max(32).nullable().optional(),
});
const unixTime = z.number().int().min(0).max(253402300799);

export type SwarmProviderErrorCode = "INVALID_INPUT" | "UNAVAILABLE" | "RATE_LIMITED" | "ACCESS_DENIED" | "TIMEOUT" | "INVALID_RESPONSE" | "IDENTITY_MISMATCH" | "STALE_RESULT" | "JOB_FAILED" | "POLL_LIMIT";
export class SwarmProviderError extends Error {
  constructor(readonly code: SwarmProviderErrorCode) {
    super(code === "RATE_LIMITED" ? "SWARM is rate limiting scan requests. Retry later."
      : code === "STALE_RESULT" ? "SWARM did not return a result from this fresh request. Retry the scan."
        : "The fresh SWARM assessment could not be verified. Retry the scan.");
    this.name = "SwarmProviderError";
  }
}

export interface SwarmProviderOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  monotonicNow?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function pick(value: unknown, fields: readonly string[], missingIsUnknown = false): Record<string, unknown> {
  const source = object(value);
  if (!source) throw new SwarmProviderError("INVALID_RESPONSE");
  return Object.fromEntries(fields.map((key) => [key, source[key] === undefined && missingIsUnknown ? null : source[key]]));
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const aborted = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => undefined);
    throw new SwarmProviderError(response.status === 429 ? "RATE_LIMITED" : [401, 403].includes(response.status) ? "ACCESS_DENIED" : response.ok ? "INVALID_RESPONSE" : "UNAVAILABLE");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new SwarmProviderError("INVALID_RESPONSE");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function candidatesFrom(report: Record<string, unknown>): Pick<SwarmAssessmentSnapshot, "candidates" | "candidatesTruncated"> {
  type Role = NonNullable<SwarmAssessmentSnapshot["candidates"]>[number]["roles"][number];
  const rows = new Map<string, { address: string; roles: Role[] }>();
  let candidatesTruncated = false;
  const add = (value: unknown, role: Role) => {
    if (value === null || value === undefined || value === "") return;
    const parsed = tokenSchema.safeParse(typeof value === "object" ? object(value)?.address : value);
    if (!parsed.success) throw new SwarmProviderError("INVALID_RESPONSE");
    if (parsed.data === `0x${"0".repeat(40)}` || parsed.data === `0x${"0".repeat(36)}dead`) return;
    const existing = rows.get(parsed.data);
    if (existing) { if (!existing.roles.includes(role)) existing.roles.push(role); return; }
    if (rows.size === SWARM_MAX_CANDIDATES) { candidatesTruncated = true; return; }
    rows.set(parsed.data, { address: parsed.data, roles: [role] });
  };
  const boundedRows = (value: unknown): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new SwarmProviderError("INVALID_RESPONSE");
    if (value.length > 4096) candidatesTruncated = true;
    return value.slice(0, 4096);
  };
  add(report.creator, "creator");
  for (const holder of boundedRows(report.holders)) {
    const row = object(holder);
    if (!row) throw new SwarmProviderError("INVALID_RESPONSE");
    add(row.address, "holder");
    const signals = object(row.signals);
    add(signals?.funder, "funder"); add(signals?.entry_from, "entry-source");
  }
  for (const link of boundedRows(report.links)) {
    const row = object(link);
    if (!row) throw new SwarmProviderError("INVALID_RESPONSE");
    if (![["a", "b"], ["from", "to"], ["source", "target"]].some(([left, right]) => row[left] != null && row[right] != null))
      throw new SwarmProviderError("INVALID_RESPONSE");
    for (const key of ["a", "b", "from", "to", "source", "target"] as const) add(row[key], "link");
  }
  return { candidates: [...rows.values()] as NonNullable<SwarmAssessmentSnapshot["candidates"]>, candidatesTruncated };
}

function graphFrom(report: Record<string, unknown>): SwarmAssessmentSnapshot["graph"] {
  if (!Array.isArray(report.holders)) return undefined;
  let truncated = report.holders.length > SWARM_MAX_CANDIDATES;
  const rows = report.holders.slice(0, SWARM_MAX_CANDIDATES).map(object).filter((row): row is Record<string, unknown> => row !== null && row.address != null);
  if (!rows.length && report.holders.length > 0) return undefined;
  if (rows.length !== Math.min(report.holders.length, SWARM_MAX_CANDIDATES)) truncated = true;
  const identifier = (value: unknown): string | null => {
    if (value == null) return null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value)) return value;
    throw new SwarmProviderError("INVALID_RESPONSE");
  };
  const nullableFlag = (value: unknown) => value == null ? null : z.boolean().parse(value);
  const nullableText = (value: unknown, maximum: number) => value == null || value === "" ? null : z.string().max(maximum).parse(value);
  const nullableShare = (value: unknown) => value == null ? null : z.number().min(0).max(1).parse(value);
  const asAddress = (value: unknown) => tokenSchema.parse(value) as SwarmAssessmentSnapshot["tokenAddress"];
  const holders = rows.map((row) => {
    const signals = row.signals == null ? null : object(row.signals);
    if (row.signals != null && signals === null) throw new SwarmProviderError("INVALID_RESPONSE");
    return {
      address: asAddress(row.address), share: nullableShare(row.share), shareSupply: nullableShare(row.share_supply),
      isContract: nullableFlag(row.is_contract), label: nullableText(row.label, 128), clusterId: identifier(row.cluster),
      entryKind: nullableText(signals?.kind, 32),
      transactionCount: signals?.tx_count == null ? null : z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(signals.tx_count),
      fresh: nullableFlag(signals?.fresh), sniper: nullableFlag(signals?.sniper), insider: nullableFlag(signals?.insider),
      dev: nullableFlag(signals?.dev), fromDev: nullableFlag(signals?.from_dev),
    };
  });
  const addresses = new Set(holders.map((row) => row.address));
  const rawClusters = report.clusters == null ? [] : z.array(z.unknown()).parse(report.clusters);
  if (rawClusters.length > SWARM_MAX_CANDIDATES) truncated = true;
  const clusters = rawClusters.slice(0, SWARM_MAX_CANDIDATES).flatMap((value) => {
    const row = object(value);
    if (!row || !Array.isArray(row.wallets)) throw new SwarmProviderError("INVALID_RESPONSE");
    const id = identifier(row.id);
    if (id === null) throw new SwarmProviderError("INVALID_RESPONSE");
    if (row.wallets.length > SWARM_MAX_CANDIDATES) truncated = true;
    const sourceWallets = row.wallets.slice(0, 4096).map(asAddress);
    const wallets = sourceWallets.filter((wallet) => addresses.has(wallet));
    if (wallets.length !== row.wallets.length) truncated = true;
    return wallets.length ? [{ id, wallets, share: nullableShare(row.share) }] : [];
  });
  const clusterIds = new Set(clusters.map((row) => row.id));
  for (const holder of holders) {
    if (holder.clusterId !== null && !clusterIds.has(holder.clusterId)) { holder.clusterId = null; truncated = true; }
  }
  const rawLinks = report.links == null ? [] : z.array(z.unknown()).parse(report.links);
  if (rawLinks.length > 2048) truncated = true;
  const links = rawLinks.slice(0, 2048).map((value) => {
    const row = object(value);
    if (!row) throw new SwarmProviderError("INVALID_RESPONSE");
    return { a: asAddress(row.a ?? row.from ?? row.source), b: asAddress(row.b ?? row.to ?? row.target), kind: nullableText(row.kind, 32), level: nullableText(row.level, 32) };
  });
  return { holders, links, clusters, truncated };
}

function projectResult(value: unknown, token: string, requestedAt: string, checkedAt: string, clocks: Pick<SwarmTransport, "jobId" | "start" | "result">): SwarmAssessmentSnapshot {
  const envelope = object(value), report = object(envelope?.result);
  if (envelope?.error) throw new SwarmProviderError("JOB_FAILED");
  if (!report) throw new SwarmProviderError("INVALID_RESPONSE");
  const identity = tokenSchema.safeParse(report.token);
  if (!identity.success || identity.data !== token || report.chain !== "base") throw new SwarmProviderError("IDENTITY_MISMATCH");
  const timestamp = unixTime.safeParse(report.scanned_at);
  if (!timestamp.success) throw new SwarmProviderError("INVALID_RESPONSE");
  const scannedAt = new Date(timestamp.data * 1000).toISOString();
  const freshness = inspectSwarmFreshness(clocks, scannedAt);
  if (freshness.stale) throw new SwarmProviderError("STALE_RESULT");
  const sourceJudge = object(report.judge);
  if (!sourceJudge || !Array.isArray(sourceJudge.evidence)) throw new SwarmProviderError("INVALID_RESPONSE");
  const judge = pick(sourceJudge, ["model", "decision", "confidence", "p", "evidence", "features", "why", "receipt", "bar", "escalate", "route", "latency_ms", "cost_usd"]);
  judge.p = pick(sourceJudge.p, ["avoid", "caution", "ok"]);
  judge.evidence = sourceJudge.evidence.map((row) => pick(row, ["k", "avoid", "caution", "ok"]));
  const graph = graphFrom(report);
  return validateSwarmAssessmentSnapshot({
    source: "swarm", status: "reported", chainId: 8453, tokenAddress: token,
    sourceUrl: `${SWARM_ORIGIN}/t/base/${token}`, requestedAt, checkedAt, scannedAt, freshRequested: true,
    score: report.score, band: report.band,
    parts: pick(report.parts, ["swarm", "fresh", "insiders", "concentration", "snipers", "dev"], true),
    gates: report.gates,
    metrics: pick(report.metrics, ["hands", "wallets", "impact", "biggest", "fresh", "insiders", "snipers", "concentration", "dev"], true),
    header: pick(report.header, ["name", "symbol", "decimals", "supply", "holders_count", "price_usd", "mcap", "liquidity_usd", "vol24h", "change24h", "age_h", "dex", "pair"], true),
    judge, transport: { ...clocks, freshness: freshness.freshness, reason: freshness.reason }, ...candidatesFrom(report),
    ...(graph ? { graph } : {}),
  }, token);
}

/** One fresh SWARM job, owned only by this request. No cached-result/history fallback. */
export async function fetchSwarmAssessment(tokenAddress: string, signal: AbortSignal, options: SwarmProviderOptions = {}): Promise<SwarmAssessmentSnapshot> {
  signal.throwIfAborted();
  const token = tokenSchema.safeParse(tokenAddress);
  if (!token.success) throw new SwarmProviderError("INVALID_INPUT");
  const timeoutMs = options.timeoutMs ?? 120_000, pollIntervalMs = options.pollIntervalMs ?? 1000, maxPolls = options.maxPolls ?? 120;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000
    || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 10_000
    || !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 240) throw new SwarmProviderError("INVALID_INPUT");
  const fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? (() => new Date()), monotonicNow = options.monotonicNow ?? (() => performance.now());
  const startedClock = monotonicNow(), requestedAt = now().toISOString(), deadline = createDeadline(timeoutMs, [signal]);
  // One extra idempotent read for the entire owned job, never another scan POST.
  let readRetryAvailable = true;
  const request = async (path: string, body?: unknown) => {
    for (;;) {
      deadline.signal.throwIfAborted();
      const started = monotonicNow(), requested = path === "/api/scan" ? requestedAt : now().toISOString();
      let response: Response;
      try {
        response = await abortable(fetcher(`${SWARM_ORIGIN}${path}`, {
          method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", credentials: "omit",
          headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: deadline.signal,
        }), deadline.signal);
      } catch (error) {
        deadline.signal.throwIfAborted();
        // Native fetch rejects network failures with TypeError; decoding below
        // has a separate boundary and must remain an invalid response.
        if (!(error instanceof TypeError)) throw error;
        if (body === undefined && readRetryAvailable) { readRetryAvailable = false; continue; }
        throw new SwarmProviderError("UNAVAILABLE");
      }
      if (body === undefined && readRetryAvailable && response.status >= 500 && response.status <= 599) {
        readRetryAvailable = false; void response.body?.cancel().catch(() => undefined); continue;
      }
      const received = monotonicNow(), receivedAt = now().toISOString(), dateHeader = response.headers.get("date");
      const parsedDate = dateHeader && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(dateHeader) ? Date.parse(dateHeader) : Number.NaN;
      const age = response.headers.get("age");
      const clock: SwarmTransport["start"] = {
        requestedAt: requested, receivedAt,
        sourceDate: Number.isFinite(parsedDate) && (age === null || age === "0") ? new Date(parsedDate).toISOString() : null,
        elapsedMs: received - started, observedAfterMs: received - startedClock,
      };
      return { data: await readJson(response, deadline.signal), clock };
    }
  };
  try {
    const started = await request("/api/scan", { token: token.data, chain: "base", fresh: true });
    if (object(started.data)?.error) throw new SwarmProviderError("JOB_FAILED");
    const job = jobSchema.parse(started.data).job;
    let after = 0;
    for (let index = 0; index < maxPolls; index++) {
      const polled = await request(`/api/events?job=${encodeURIComponent(job)}&after=${after}`);
      if (object(polled.data)?.error) throw new SwarmProviderError("JOB_FAILED");
      const progress = progressSchema.parse(polled.data);
      if ((progress.token && progress.token !== token.data) || (progress.chain && progress.chain !== "base")) throw new SwarmProviderError("IDENTITY_MISMATCH");
      after += progress.events.length;
      if (progress.done) {
        const result = await request(`/api/result?job=${encodeURIComponent(job)}`);
        deadline.signal.throwIfAborted();
        return projectResult(result.data, token.data, requestedAt, now().toISOString(), { jobId: job, start: started.clock, result: result.clock });
      }
      if (index + 1 < maxPolls) await pause(pollIntervalMs, deadline.signal);
    }
    throw new SwarmProviderError("POLL_LIMIT");
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted) throw new SwarmProviderError("TIMEOUT");
    if (error instanceof SwarmProviderError) throw error;
    throw new SwarmProviderError(error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError ? "INVALID_RESPONSE" : "UNAVAILABLE");
  } finally { deadline.dispose(); }
}
