import { encodeFunctionData, parseAbi } from "viem";
import type { InvestigationReport } from "../../src/domain/investigations/types";
import { validateHolderSnapshot } from "../../src/domain/investigations/holder-snapshot";
import { validateLiquiditySnapshot, validateWalletActivitySnapshot } from "../../src/domain/investigations/chain-snapshots";
import { createDeadline } from "../../src/lib/deadline";

const PROVIDERS = [
  { name: "PublicNode", url: "https://base-rpc.publicnode.com" },
  { name: "Base public RPC", url: "https://mainnet.base.org" },
] as const;
const MAX_REQUESTS = 160, CONCURRENCY = 6, CALL_TIMEOUT_MS = 10_000, MAX_RESPONSE_BYTES = 65_536;
const abi = parseAbi([
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)", "function getPair(address,address) view returns (address)",
]);

export class IndependentStateIntegrityError extends Error {
  constructor(field: string) { super(`Independent state verification disagreed on ${field}.`); this.name = "IndependentStateIntegrityError"; }
}
class PublicProviderUnavailable extends Error {}

export interface IndependentStateVerification {
  status: "verified" | "unavailable";
  provider: typeof PROVIDERS[number]["name"] | null;
  attemptedProviders: string[];
  requestCount: number;
  checked: { totalSupply: number; balances: number; codeClassifications: number; outgoingNonces: number; reservePools: number; blockIdentities: number };
  methods: string[];
  reason: "public-providers-unavailable" | "read-budget-exceeded" | "pinned-state-unavailable" | null;
}
const emptyCounts = (): IndependentStateVerification["checked"] => ({ totalSupply: 0, balances: 0, codeClassifications: 0, outgoingNonces: 0, reservePools: 0, blockIdentities: 0 });
function integrity(field: string): never { throw new IndependentStateIntegrityError(field); }
function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) return integrity(field);
  return BigInt(value);
}
function word(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return integrity(field);
  return BigInt(value);
}
function addressWord(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/i.test(value)) return integrity(field);
  return `0x${value.slice(-40).toLowerCase()}`;
}
async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new PublicProviderUnavailable();
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new PublicProviderUnavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new PublicProviderUnavailable(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PublicProviderUnavailable(); }
}

/** Operator-only comparison of one in-memory scan against fixed public RPCs.
 * Nothing is persisted, and metadata never includes addresses, amounts or evidence.
 * Agreement checks retained state only; it is not a holder census or history audit. */
export async function verifyIndependentState(report: InvestigationReport, outerSignal: AbortSignal, fetcher: typeof fetch = fetch): Promise<IndependentStateVerification> {
  outerSignal.throwIfAborted();
  const attemptedProviders: string[] = [], methods = new Set<string>();
  let requestCount = 0;
  const unavailable = (reason: IndependentStateVerification["reason"]): IndependentStateVerification => ({ status: "unavailable", provider: null, attemptedProviders, requestCount, checked: emptyCounts(), methods: [...methods].sort(), reason });
  if (!report.holderSnapshot || report.token.totalSupplyRaw === null) return unavailable("pinned-state-unavailable");
  let holders: NonNullable<InvestigationReport["holderSnapshot"]>;
  let activity: InvestigationReport["walletActivitySnapshot"];
  let liquidity: InvestigationReport["liquiditySnapshot"];
  try {
    holders = validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to);
    activity = report.walletActivitySnapshot ? validateWalletActivitySnapshot(report.walletActivitySnapshot, report.range.to) : undefined;
    liquidity = report.liquiditySnapshot ? validateLiquiditySnapshot(report.liquiditySnapshot, report.token.address, report.range.to) : undefined;
  } catch { return integrity("input snapshot identity"); }
  const verifiedBalances = holders.holders.filter((row) => row.status === "verified" && row.balanceRaw !== null);
  const codeRows = activity?.rows.filter((row) => row.code !== "unavailable") ?? [];
  const nonceRows = activity?.rows.filter((row) => row.outgoingTransactionCountRaw !== null) ?? [];
  // One chain identity, opening/closing block identity, supply, candidates and
  // optional reserve identities. A provider attempt must fit in full.
  const plannedRequests = 4 + verifiedBalances.length + codeRows.length + nonceRows.length + (liquidity ? 5 : 0);
  if (plannedRequests > MAX_REQUESTS) return unavailable("read-budget-exceeded");
  const blockTag = `0x${BigInt(report.range.to.number).toString(16)}`;
  for (const provider of PROVIDERS) {
    outerSignal.throwIfAborted();
    if (MAX_REQUESTS - requestCount < plannedRequests) return unavailable("read-budget-exceeded");
    attemptedProviders.push(provider.name);
    const checked = emptyCounts();
    async function rpc(method: string, params: unknown[]): Promise<unknown> {
      outerSignal.throwIfAborted();
      if (requestCount >= MAX_REQUESTS) throw new PublicProviderUnavailable();
      const id = ++requestCount;
      methods.add(method);
      const deadline = createDeadline(CALL_TIMEOUT_MS, [outerSignal]);
      try {
        const response = await fetcher(provider.url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", cache: "no-store", signal: deadline.signal, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
        if (!response.ok) throw new PublicProviderUnavailable();
        const payload = await responseJson(response);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new PublicProviderUnavailable();
        const envelope = payload as Record<string, unknown>;
        if (envelope.jsonrpc !== "2.0" || envelope.id !== id) return integrity("RPC response identity");
        if ("error" in envelope || !Object.hasOwn(envelope, "result") || envelope.result === null) throw new PublicProviderUnavailable();
        return envelope.result;
      } catch (error) {
        outerSignal.throwIfAborted();
        if (error instanceof IndependentStateIntegrityError) throw error;
        throw new PublicProviderUnavailable();
      } finally { deadline.dispose(); }
    }
    async function checkBlock() {
      const value = await rpc("eth_getBlockByNumber", [blockTag, false]);
      if (!value || typeof value !== "object" || Array.isArray(value)) return integrity("pinned block identity");
      const block = value as Record<string, unknown>;
      if (quantity(block.number, "pinned block number") !== BigInt(report.range.to.number)
        || quantity(block.timestamp, "pinned block timestamp") !== BigInt(report.range.to.timestamp)
        || typeof block.hash !== "string" || block.hash.toLowerCase() !== report.range.to.hash) return integrity("pinned block identity");
      checked.blockIdentities++;
    }
    const call = (to: string, data: string) => rpc("eth_call", [{ to, data }, blockTag]);
    try {
      if (quantity(await rpc("eth_chainId", []), "chain identity") !== 8453n) return integrity("chain identity");
      await checkBlock();
      const tasks: (() => Promise<void>)[] = [async () => {
        if (word(await call(report.token.address, encodeFunctionData({ abi, functionName: "totalSupply" })), "total supply") !== BigInt(report.token.totalSupplyRaw!)) return integrity("total supply");
        checked.totalSupply++;
      }];
      for (const row of verifiedBalances) tasks.push(async () => {
        if (word(await call(report.token.address, encodeFunctionData({ abi, functionName: "balanceOf", args: [row.address] })), "candidate balance") !== BigInt(row.balanceRaw!)) return integrity("candidate balance");
        checked.balances++;
      });
      for (const row of codeRows) tasks.push(async () => {
        const code = await rpc("eth_getCode", [row.address, blockTag]);
        if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(code) || (code === "0x" ? "eoa" : "contract") !== row.code) return integrity("account code classification");
        checked.codeClassifications++;
      });
      for (const row of nonceRows) tasks.push(async () => {
        if (quantity(await rpc("eth_getTransactionCount", [row.address, blockTag]), "outgoing nonce") !== BigInt(row.outgoingTransactionCountRaw!)) return integrity("outgoing nonce");
        checked.outgoingNonces++;
      });
      if (liquidity) {
        const pool = liquidity;
        for (const [name, expected] of [["factory", pool.factory], ["token0", pool.token0], ["token1", pool.token1]] as const) tasks.push(async () => {
          if (addressWord(await call(pool.pool, encodeFunctionData({ abi, functionName: name })), "reserve pool identity") !== expected) return integrity("reserve pool identity");
        });
        tasks.push(async () => {
          if (addressWord(await call(pool.factory, encodeFunctionData({ abi, functionName: "getPair", args: [pool.token0, pool.token1] })), "reserve factory registration") !== pool.pool) return integrity("reserve factory registration");
        });
        tasks.push(async () => {
          const value = await call(pool.pool, encodeFunctionData({ abi, functionName: "getReserves" }));
          if (typeof value !== "string" || !/^0x[0-9a-f]{192}$/i.test(value)) return integrity("pool reserves");
          const reserve0 = BigInt(`0x${value.slice(2, 66)}`), reserve1 = BigInt(`0x${value.slice(66, 130)}`), timestamp = BigInt(`0x${value.slice(130)}`);
          if (reserve0 !== BigInt(pool.reserve0Raw) || reserve1 !== BigInt(pool.reserve1Raw) || timestamp >= 2n ** 32n) return integrity("pool reserves");
          checked.reservePools++;
        });
      }
      let nextTask = 0;
      const failures: unknown[] = [];
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
        while (!failures.length && nextTask < tasks.length) {
          const task = tasks[nextTask++];
          try { await task(); } catch (error) { failures.push(error); }
        }
      }));
      outerSignal.throwIfAborted();
      // Drain every issued call and prefer any observed integrity failure over an
      // availability error. Never pick a provider that happens to agree later.
      const mismatch = failures.find((error) => error instanceof IndependentStateIntegrityError);
      if (mismatch) throw mismatch;
      if (failures.length) throw new PublicProviderUnavailable();
      await checkBlock();
      return { status: "verified", provider: provider.name, attemptedProviders, requestCount, checked, methods: [...methods].sort(), reason: null };
    } catch (error) {
      outerSignal.throwIfAborted();
      if (error instanceof IndependentStateIntegrityError) throw error;
    }
  }
  return unavailable("public-providers-unavailable");
}
