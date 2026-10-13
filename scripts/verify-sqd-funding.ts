/** One bounded, read-only positive check of the actual SQD funding helper.
 * Run: node --conditions=react-server --import tsx scripts/verify-sqd-funding.ts
 * Fixed public evaluation sources; never loads .env or accepts URL/range overrides.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Address, BlockReference, Hash } from "../src/domain/investigations/types";
import { createDeadline } from "../src/lib/deadline";
import { readProviderConfiguration } from "../src/providers/base/config";
import { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "../src/providers/base/errors";
import { collectSqdFundingWindow, createSqdFundingQuery } from "../src/providers/base/sqd-funding";
import { createProviderTransport, validateProviderDestination } from "../src/providers/base/transport";

const BLOCK = "52493537";
const BLOCK_HASH: Hash = "0xa0c1f1223de5ed85fae6cc76949e1dabf1ddbcc247d04598a2f72b037e381758";
const RECIPIENT: Address = "0xc157ce1b852819810add196befbddd8fb7dab274";
const EXPECTED_TRANSACTION: Hash = "0x3995c62ba9099dc5a16e5a400f01697e69f0d0d13a10e3873e0ca91c08979466";
const EXPECTED_SENDER: Address = "0xe06f028436c6febc99159395cabe538d09da0375";
const EXPECTED_AMOUNT = BigInt("0x10c305315a367").toString();
const MAX_REQUESTS = 12;
const DEADLINE_MS = 60_000;
const RPC_GAP_MS = 250;
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66);
const headerSchema = z.object({ number: quantity, hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), timestamp: quantity });

function header(value: unknown): BlockReference {
  const parsed = headerSchema.parse(value);
  const timestamp = Number(BigInt(parsed.timestamp));
  assert.ok(Number.isSafeInteger(timestamp));
  return { number: BigInt(parsed.number).toString(), hash: parsed.hash.toLowerCase() as Hash, timestamp };
}
function sanitizedFailure(error: unknown) {
  if (error instanceof UpstreamFailure) return { kind: "provider_unavailable", retryable: error.retryable, ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}), ...(error.rpcCode !== undefined ? { rpcCode: error.rpcCode } : {}) };
  if (error instanceof ProviderBudgetError) return { kind: "fixed_request_budget_reached" };
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) return { kind: "deadline_or_cancellation" };
  if (error instanceof ProviderIntegrityError || error instanceof z.ZodError || (error instanceof Error && error.name === "AssertionError")) return { kind: "identity_or_positive_proof_not_verified" };
  return { kind: "verification_failed" };
}

async function main() {
  if (process.argv.length > 2) {
    console.info("Run verify-sqd-funding.ts without arguments. Sources, historical block, recipient, request cap and deadline are fixed; no environment or overrides are used.");
    if (!(process.argv.length === 3 && process.argv[2] === "--help")) process.exitCode = 2;
    return;
  }
  const started = performance.now();
  const deadline = createDeadline(DEADLINE_MS);
  let stage = "approved public RPC destination";
  let rpcCalls = 0, sqdCalls = 0;
  let lastRpcFinished: number | null = null;
  let knownExpectedTransactionMatched = false;
  let finalizedHeadCoversKnownBlock = false;
  let canonicalRecheckMatched = false;
  let completedBlocks = 0, retainedFundingCount = 0;
  let coverage: { status: string; fromBlock: string; toBlock: string } | null = null;
  let failure: ReturnType<typeof sanitizedFailure> | null = null;
  const sourceFailures: { source: "rpc" | "sqd"; failure: ReturnType<typeof sanitizedFailure> }[] = [];
  const methods: Record<string, number> = {};
  const reserveRequest = () => {
    deadline.signal.throwIfAborted();
    if (rpcCalls + sqdCalls >= MAX_REQUESTS) throw new ProviderBudgetError();
  };
  try {
    const configuration = await validateProviderDestination(readProviderConfiguration({
      BASE_RPC_URL: "https://base.drpc.org",
      BASE_RPC_FALLBACK_URLS: "",
      BASE_FUNDING_SOURCE: "rpc",
      BASE_PROVIDER_TIMEOUT_MS: "7000",
      BASE_PROVIDER_SCAN_TIMEOUT_MS: String(DEADLINE_MS),
    }), deadline.signal);
    assert.equal(configuration.rpcUrl, "https://base.drpc.org/");
    assert.equal(configuration.rpcFallbackUrls.length, 0);
    assert.equal(configuration.blockscoutApiKey, null);
    const transport = createProviderTransport(configuration, deadline.signal);
    const rpc = async (method: string, params: unknown[]) => {
      // Pace physical RPC reads; never retry, recover or start overlapping calls.
      if (lastRpcFinished !== null) {
        const remainingGap = RPC_GAP_MS - (performance.now() - lastRpcFinished);
        if (remainingGap > 0) {
          try { await delay(Math.ceil(remainingGap), undefined, { signal: deadline.signal }); }
          catch (error) { deadline.signal.throwIfAborted(); throw error; }
        }
      }
      reserveRequest();
      stage = method;
      rpcCalls++;
      methods[method] = (methods[method] ?? 0) + 1;
      try { return await transport.rpc(method, params); }
      catch (error) { sourceFailures.push({ source: "rpc", failure: sanitizedFailure(error) }); throw error; }
      finally { lastRpcFinished = performance.now(); }
    };
    assert.equal(BigInt(quantity.parse(await rpc("eth_chainId", []))), 8453n);
    const blockTag = `0x${BigInt(BLOCK).toString(16)}`;
    const pinned = header(await rpc("eth_getBlockByNumber", [blockTag, false]));
    assert.equal(pinned.number, BLOCK);
    assert.equal(pinned.hash, BLOCK_HASH);
    const finalized = header(await rpc("eth_getBlockByNumber", ["finalized", false]));
    finalizedHeadCoversKnownBlock = BigInt(finalized.number) >= BigInt(BLOCK) && finalized.timestamp >= pinned.timestamp;
    assert.equal(finalizedHeadCoversKnownBlock, true);

    const query = createSqdFundingQuery(configuration.timeoutMs, deadline.signal);
    stage = "single-block production SQD funding helper";
    const result = await collectSqdFundingWindow({
      wallets: [RECIPIENT], from: pinned, to: pinned,
      observedAt: new Date().toISOString(), signal: deadline.signal, request: rpc,
      canonicalBlock: async (number, expectedHash) => {
        assert.equal(number, BLOCK);
        assert.equal(expectedHash, BLOCK_HASH);
        const actual = header(await rpc("eth_getBlockByNumber", [blockTag, false]));
        assert.deepEqual(actual, pinned);
        return actual;
      },
      queryPage: async (parameters) => {
        assert.deepEqual([...parameters.wallets], [RECIPIENT]);
        assert.equal(parameters.fromBlock, BLOCK);
        assert.equal(parameters.toBlock, BLOCK);
        // This single-block probe must never continue to a second page.
        assert.equal(sqdCalls, 0);
        reserveRequest(); sqdCalls++; stage = "SQD public finalized-stream";
        try { return await query(parameters); }
        catch (error) { sourceFailures.push({ source: "sqd", failure: sanitizedFailure(error) }); throw error; }
      },
    });
    completedBlocks = result.completedBlocks;
    retainedFundingCount = result.evidence.length;
    const item = result.coverage.find((entry) => entry.wallet === RECIPIENT);
    coverage = item ? { status: item.status, fromBlock: item.fromBlock, toBlock: item.toBlock } : null;
    knownExpectedTransactionMatched = result.evidence.some((record) => record.kind === "funding" && record.chainId === 8453
      && record.blockNumber === BLOCK && record.blockHash === BLOCK_HASH && record.transactionHash === EXPECTED_TRANSACTION
      && record.from === EXPECTED_SENDER && record.to === RECIPIENT && record.amountRaw === EXPECTED_AMOUNT
      && record.assetAddress === null && record.logIndex === null && record.traceId === null
      && record.provenance.provider === "SQD Portal + Base RPC");
    stage = "known positive and exact single indexed-block coverage";
    assert.equal(knownExpectedTransactionMatched, true);
    assert.equal(completedBlocks, 1);
    assert.equal(result.examinedWallets, 1);
    assert.deepEqual(coverage, { status: "complete", fromBlock: BLOCK, toBlock: BLOCK });
    assert.match(item!.reason ?? "", /index omissions are not independently disproved/);
    assert.equal(item!.internalTransfers, "not_examined");
    stage = "historical canonical end recheck";
    assert.deepEqual(header(await rpc("eth_getBlockByNumber", [blockTag, false])), pinned);
    canonicalRecheckMatched = true;
    deadline.signal.throwIfAborted();
  } catch (error) { failure = sanitizedFailure(error); process.exitCode = 1; }
  finally { deadline.dispose(); }

  const summary = {
    verifiedAt: new Date().toISOString(), status: failure ? "failed" : "passed",
    sources: ["SQD public Portal testing", "dRPC Base public RPC"],
    elapsedMilliseconds: Math.round(performance.now() - started), deadlineMilliseconds: DEADLINE_MS,
    requestLimit: MAX_REQUESTS, actualHttpRequests: rpcCalls + sqdCalls, rpcCalls, sqdCalls,
    dnsPreflightExcludedFromHttpCount: true, rpcGapMilliseconds: RPC_GAP_MS, rpcMethods: methods,
    block: BLOCK, completedBlocks, retainedFundingCount, knownExpectedTransactionMatched,
    finalizedHeadCoversKnownBlock, canonicalRecheckMatched, coverage,
    ...(failure ? { failedStage: stage, failure, sourceFailures } : {}),
    scope: "Actual production SQD helper on one previously verified historical recipient/block. Complete is indexed single-block search scope, not independently proven index completeness, lifetime-first funding, internal transfers, current public-scan coverage or production-approved access. Historical and pinned recipient code refer to the same block in this probe.",
    privacy: "Metadata only; no raw responses, report, evidence records, credential-bearing URLs, keys, chat, AI, database or public quota access.",
  };
  await mkdir(".artifacts", { recursive: true });
  await writeFile(".artifacts/sqd-funding-adapter-verification.json", `${JSON.stringify(summary, null, 2)}\n`);
  console.info(JSON.stringify(summary));
}

main().catch(() => {
  console.error(JSON.stringify({ status: "failed", kind: "operator_script_failure", note: "No raw payload, credentials or upstream message was logged." }));
  process.exitCode = 1;
});
