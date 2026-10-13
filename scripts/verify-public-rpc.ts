/** Read-only, credential-free capability probe; never acquires a report.
 * Run: node --conditions=react-server --import tsx scripts/verify-public-rpc.ts --source=publicnode|drpc
 * Only these fixed public endpoints are accepted; no environment is loaded.
 * Public dRPC's basic-read mode deliberately excludes paid log discovery.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { readProviderConfiguration } from "../src/providers/base/config";
import { createProviderTransport, validateProviderDestination } from "../src/providers/base/transport";
import { ProviderIntegrityError, UpstreamFailure } from "../src/providers/base/errors";
import { createDeadline } from "../src/lib/deadline";

const SOURCES = {
  publicnode: { endpoint: "https://base-rpc.publicnode.com", label: "PublicNode Base public RPC", hostname: "base-rpc.publicnode.com", probeLogs: true },
  drpc: { endpoint: "https://base.drpc.org", label: "dRPC Base public RPC", hostname: "base.drpc.org", probeLogs: false },
} as const;
const WETH = "0x4200000000000000000000000000000000000006";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CALL_LIMIT = 8;
const DEADLINE_MS = 60_000;
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66).transform((value) => BigInt(value));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(2_000_000).transform((value) => value.toLowerCase());
const headerSchema = z.object({ number: quantity, hash, parentHash: hash, timestamp: quantity });
const transactionSchema = z.object({ hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity, from: address, to: address.nullable(), value: quantity });
const fullBlockSchema = headerSchema.extend({ transactions: z.array(transactionSchema).max(10_000) });
const logSchema = z.object({ address, blockHash: hash, blockNumber: quantity, transactionHash: hash, transactionIndex: quantity, logIndex: quantity, topics: z.array(hash).max(4), data: bytes, removed: z.literal(false) });
const receiptSchema = z.object({ transactionHash: hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity, status: z.enum(["0x0", "0x1"]), logs: z.array(logSchema).max(2000) });
type Check = { name: string; status: "passed" | "not_sampled" | "intentionally_not_tested"; count?: number };

function failureMetadata(error: unknown) {
  if (error instanceof UpstreamFailure) return { kind: "provider_unavailable", retryable: error.retryable, ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}), ...(error.rpcCode !== undefined ? { rpcCode: error.rpcCode } : {}) };
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) return { kind: "deadline_or_cancellation" };
  if (error instanceof ProviderIntegrityError || error instanceof z.ZodError || (error instanceof Error && error.name === "AssertionError")) return { kind: "identity_or_shape_validation_failed" };
  return { kind: "verification_failed" };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.info("Read-only fixed-source probe: --source=publicnode|drpc (default publicnode). Maximum eight RPC calls and 60 seconds. No URL overrides, environment credentials, retry, evidence or report persistence. dRPC mode excludes log discovery.");
    return;
  }
  if (args.length > 1 || (args.length === 1 && !/^--source=(?:publicnode|drpc)$/.test(args[0]))) {
    console.error("Use --source=publicnode|drpc (or --help). Arbitrary endpoints are not supported.");
    process.exitCode = 2;
    return;
  }
  const sourceKey = (args[0]?.slice("--source=".length) ?? "publicnode") as keyof typeof SOURCES;
  const source = SOURCES[sourceKey];
  const started = performance.now();
  const deadline = createDeadline(DEADLINE_MS);
  const checks: Check[] = [];
  let stage = "approved public DNS destination";
  let calls = 0;
  let finalizedBlock: string | null = null;
  let transactionCount: number | null = null;
  let transferLogs: number | null = null;
  let failure: ReturnType<typeof failureMetadata> | null = null;
  try {
    // Deliberately do not load process.env, dotenv, credentials or URL overrides.
    const configuration = await validateProviderDestination(readProviderConfiguration({
      BASE_RPC_URL: source.endpoint,
      BASE_PROVIDER_TIMEOUT_MS: "7000",
      BASE_PROVIDER_SCAN_TIMEOUT_MS: String(DEADLINE_MS),
    }), deadline.signal);
    assert.equal(configuration.rpcUrl, `${source.endpoint}/`);
    assert.equal(configuration.rpcFallbackUrls.length, 0);
    assert.equal(configuration.blockscoutApiKey, null);
    checks.push({ name: stage, status: "passed" });
    const transport = createProviderTransport(configuration, deadline.signal);
    const rpc = async (method: string, params: unknown[]) => {
      deadline.signal.throwIfAborted();
      assert.ok(calls < CALL_LIMIT, "The fixed physical RPC-call limit was reached.");
      calls++;
      // Transport performs exactly one HTTP request; this probe never retries.
      return transport.rpc(method, params);
    };

    stage = "Base mainnet chain identity";
    assert.equal(quantity.parse(await rpc("eth_chainId", [])), 8453n);
    checks.push({ name: stage, status: "passed" });

    stage = "finalized block header";
    const pinned = headerSchema.parse(await rpc("eth_getBlockByNumber", ["finalized", false]));
    assert.ok(pinned.timestamp <= BigInt(Math.floor(Date.now() / 1000) + 120));
    finalizedBlock = pinned.number.toString();
    checks.push({ name: stage, status: "passed" });
    const blockTag = `0x${pinned.number.toString(16)}`;

    stage = "full block matches pinned header";
    const block = fullBlockSchema.parse(await rpc("eth_getBlockByNumber", [blockTag, true]));
    assert.deepEqual({ number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp }, pinned);
    const transactions = new Map<string, z.infer<typeof transactionSchema>>();
    for (const [index, transaction] of block.transactions.entries()) {
      assert.equal(transaction.blockHash, pinned.hash);
      assert.equal(transaction.blockNumber, pinned.number);
      assert.equal(transaction.transactionIndex, BigInt(index));
      assert.ok(!transactions.has(transaction.hash));
      transactions.set(transaction.hash, transaction);
    }
    transactionCount = transactions.size;
    checks.push({ name: stage, status: "passed", count: transactionCount });

    const logs = source.probeLogs
      ? z.array(logSchema).max(2000).parse(await (async () => {
        stage = "one-block WETH Transfer logs";
        return rpc("eth_getLogs", [{ address: WETH, fromBlock: blockTag, toBlock: blockTag, topics: [TRANSFER] }]);
      })())
      : [];
    const seenLogs = new Set<string>();
    for (const log of logs) {
      assert.equal(log.address, WETH);
      assert.equal(log.blockHash, pinned.hash);
      assert.equal(log.blockNumber, pinned.number);
      assert.equal(log.topics[0], TRANSFER);
      assert.equal(log.topics.length, 3);
      assert.match(log.topics[1], /^0x0{24}[0-9a-f]{40}$/);
      assert.match(log.topics[2], /^0x0{24}[0-9a-f]{40}$/);
      assert.match(log.data, /^0x[0-9a-f]{64}$/);
      assert.equal(transactions.get(log.transactionHash)?.transactionIndex, log.transactionIndex);
      assert.ok(!seenLogs.has(log.logIndex.toString()));
      seenLogs.add(log.logIndex.toString());
    }
    if (source.probeLogs) {
      transferLogs = logs.length;
      checks.push({ name: stage, status: "passed", count: transferLogs });
    } else {
      checks.push({ name: "eth_getLogs excluded from public dRPC basic-read mode", status: "intentionally_not_tested" });
    }

    stage = "pinned WETH contract code";
    const code = bytes.parse(await rpc("eth_getCode", [WETH, blockTag]));
    assert.ok(code.length > 2, "The known WETH contract must have code.");
    checks.push({ name: stage, status: "passed", count: (code.length - 2) / 2 });

    stage = "pinned WETH totalSupply call";
    assert.match(bytes.parse(await rpc("eth_call", [{ to: WETH, data: "0x18160ddd" }, blockTag])), /^0x[0-9a-f]{64}$/);
    checks.push({ name: stage, status: "passed" });

    const sampleLog = logs[0];
    const sample = sampleLog ? transactions.get(sampleLog.transactionHash) : block.transactions[0];
    if (sample) {
      stage = sampleLog ? "sample receipt identity and retained-log agreement" : "sample receipt identity";
      const receipt = receiptSchema.parse(await rpc("eth_getTransactionReceipt", [sample.hash]));
      assert.equal(receipt.transactionHash, sample.hash);
      assert.equal(receipt.transactionIndex, sample.transactionIndex);
      assert.equal(receipt.blockHash, pinned.hash);
      assert.equal(receipt.blockNumber, pinned.number);
      for (const log of receipt.logs) {
        assert.equal(log.transactionHash, sample.hash);
        assert.equal(log.transactionIndex, sample.transactionIndex);
        assert.equal(log.blockHash, pinned.hash);
        assert.equal(log.blockNumber, pinned.number);
      }
      if (sampleLog) {
        assert.equal(receipt.status, "0x1");
        assert.deepEqual(receipt.logs.find((log) => log.logIndex === sampleLog.logIndex), sampleLog);
      }
      checks.push({ name: stage, status: "passed", count: receipt.logs.length });

      stage = "sample transaction matches full block";
      assert.deepEqual(transactionSchema.parse(await rpc("eth_getTransactionByHash", [sample.hash])), sample);
      checks.push({ name: stage, status: "passed" });
    } else {
      checks.push({ name: "receipt and transaction sample: finalized block was empty", status: "not_sampled" });
    }
    deadline.signal.throwIfAborted();
  } catch (error) {
    failure = failureMetadata(error);
    process.exitCode = 1;
  } finally { deadline.dispose(); }

  const summary = {
    verifiedAt: new Date().toISOString(),
    source: source.label,
    providerHostname: source.hostname,
    status: failure ? "failed" : "passed",
    callLimit: CALL_LIMIT,
    actualRpcCalls: calls,
    deadlineMilliseconds: DEADLINE_MS,
    elapsedMilliseconds: Math.round(performance.now() - started),
    finalizedBlock,
    transactionCount,
    transferLogs,
    checks,
    ...(failure ? { failedStage: stage, failure } : {}),
    scope: "One bounded endpoint-capability sample, not full acquisition, independent corroboration, uptime, complete history, or report-quality verification. Empty logs do not establish absence outside this block.",
    privacy: "Metadata only. No RPC payload, transaction/log evidence, report, provider configuration, credentials, or upstream error message was written.",
  };
  await mkdir(".artifacts", { recursive: true });
  await writeFile(`.artifacts/${sourceKey}-base-capability-verification.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.info(JSON.stringify(summary));
}

main().catch(() => {
  console.error(JSON.stringify({ status: "failed", kind: "operator_script_failure", note: "No provider payload, credentials or upstream error message was logged." }));
  process.exitCode = 1;
});
