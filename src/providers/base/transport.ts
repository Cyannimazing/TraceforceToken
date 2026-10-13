import { lookup } from "node:dns/promises";
import { z } from "zod";
import type { Address, Hash } from "@/domain/investigations/types";
import { configuredAlchemyRpcEndpoint, configuredLogRpcEndpoint, configuredRpcEndpoints, isPublicAddress, type ProviderConfiguration } from "./config";
import { ProviderIntegrityError, UpstreamFailure, type CollectorDependencies, type FundingHistoryPage } from "./core";
import { ProviderLogRangeError, ProviderResponseLimitError } from "./errors";
import { createDeadline } from "@/lib/deadline";
import type { HolderDiscoveryPage } from "./holders";

const envelopeSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number().int(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string().max(4096) }).optional() });
const blockNumberSchema = z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d+$/).max(24)]).transform((value) => BigInt(value).toString());
const cursorSchema = z.record(z.string().max(40), z.union([z.string().max(256), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])).nullable();
const pageSchema = z.object({ items: z.array(z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hash), block_number: blockNumberSchema })).max(100), next_page_params: cursorSchema });
const cursorKeys = new Set(["block_number", "index", "inserted_at", "hash", "value", "fee", "items_count"]);
const holderAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const holderRaw = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n);
const holderCursor = z.object({
  address_hash: holderAddress.optional(),
  value: z.union([holderRaw, z.number().int().nonnegative().safe().transform(String)]).optional(),
  items_count: z.union([z.number().int().nonnegative().safe(), z.string().regex(/^(0|[1-9][0-9]{0,15})$/)]).optional(),
  token_id: z.union([holderRaw, z.number().int().nonnegative().safe().transform(String)]).optional(),
}).strict().nullable();
const indexedHolderAddress = z.object({ hash: holderAddress });
const holderPageSchema = z.object({
  items: z.array(z.object({ address: indexedHolderAddress.optional(), address_hash: z.union([holderAddress, indexedHolderAddress]).optional() }).refine((item) => {
    const older = typeof item.address_hash === "string" ? item.address_hash : item.address_hash?.hash;
    return Boolean(item.address?.hash || older) && (!item.address?.hash || !older || item.address.hash === older);
  })).max(100),
  next_page_params: holderCursor,
  token: z.object({ address_hash: holderAddress.optional(), address: holderAddress.optional(), hash: holderAddress.optional() }).optional(),
});

export function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      operation().then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    } catch (error) { cleanup(); reject(error); }
  });
}

export async function validateProviderDestination(configuration: ProviderConfiguration, signal?: AbortSignal, resolveHostname: (hostname: string) => Promise<readonly { address: string }[]> = (hostname) => lookup(hostname, { all: true })): Promise<ProviderConfiguration> {
  // Validate the complete set before any DNS lookup. An invalid fallback cannot
  // hide behind a working primary or a loopback-only fixture endpoint.
  const endpoints = configuredRpcEndpoints(configuration);
  const logEndpoint = configuredLogRpcEndpoint(configuration);
  const alchemyEndpoint = configuredAlchemyRpcEndpoint(configuration);
  const healthy: URL[] = [];
  let logHealthy = logEndpoint === null;
  let alchemyHealthy = alchemyEndpoint === null;
  signal?.throwIfAborted();
  const lanes = [...endpoints.map((url) => [url, "state"] as const), ...(logEndpoint ? [[logEndpoint, "log"] as const] : []), ...(alchemyEndpoint ? [[alchemyEndpoint, "alchemy"] as const] : [])];
  const lookups = new Map<string, Promise<readonly { address: string }[]>>();
  function resolve(url: URL) {
    if (configuration.allowLocalTests && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return Promise.resolve([{ address: "fixture" }]);
    const pending = lookups.get(url.hostname);
    if (pending) return pending;
    const lookupTask = (async () => {
      const deadline = createDeadline(configuration.timeoutMs, signal ? [signal] : []);
      try {
        const records = await abortable(() => resolveHostname(url.hostname), deadline.signal);
        if (records.some((record) => !isPublicAddress(record.address))) throw new ProviderIntegrityError("The provider hostname resolves to a prohibited network destination.");
        return records;
      } catch (error) { signal?.throwIfAborted(); if (error instanceof ProviderIntegrityError) throw error; return []; }
      finally { deadline.dispose(); }
    })();
    lookups.set(url.hostname, lookupTask);
    return lookupTask;
  }
  // Resolve independent destinations together, once per hostname. Preserve
  // configured state priority and inspect every result before any HTTP read.
  const results = await Promise.allSettled(lanes.map(([url]) => resolve(url)));
  signal?.throwIfAborted();
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === "rejected") throw result.reason;
    const [url, lane] = lanes[index];
    if (result.value.length) { if (lane === "log") logHealthy = true; else if (lane === "alchemy") alchemyHealthy = true; else healthy.push(url); }
  }
  if (!healthy.length || !logHealthy || !alchemyHealthy) throw new UpstreamFailure(true);
  return { ...configuration, rpcUrl: healthy[0].toString(), rpcFallbackUrls: healthy.slice(1).map((url) => url.toString()), ...(logEndpoint ? { logRpcUrl: logEndpoint.toString() } : {}) };
}

/** Read a stream under a byte cap rather than downloading an unbounded JSON response. */
export async function boundedJson(response: Response, maxBytes = 2_000_000, preserveLargeIntegers = false): Promise<unknown> {
  if (!response.ok) throw new UpstreamFailure(response.status === 429 || response.status >= 500, { httpStatus: response.status });
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new ProviderResponseLimitError();
  if (!response.body) throw new UpstreamFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new ProviderResponseLimitError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const source = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(preserveLargeIntegers ? preserveJsonIntegers(source) : source) as unknown;
  } catch { throw new ProviderIntegrityError("The provider returned malformed JSON."); }
}

/** Preserve large integer pagination cursors before JSON.parse can round them.
 * Strings and escaped content are left intact; JSON.parse still validates syntax. */
function preserveJsonIntegers(source: string): string {
  const chunks: string[] = []; let quoted = false; let escaped = false; let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) { if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') quoted = false; continue; }
    if (character === '"') { quoted = true; continue; }
    if (character !== "-" && !/[0-9]/.test(character)) continue;
    const first = index;
    while (index + 1 < source.length && /[0-9eE.+-]/.test(source[index + 1])) index++;
    const number = source.slice(first, index + 1);
    if (/^-?(0|[1-9][0-9]*)$/.test(number) && !Number.isSafeInteger(Number(number))) {
      chunks.push(source.slice(start, first), JSON.stringify(number)); start = index + 1;
    }
  }
  chunks.push(source.slice(start)); return chunks.join("");
}

export function createProviderTransport(configuration: ProviderConfiguration, signal?: AbortSignal): Pick<CollectorDependencies, "rpc" | "recoverRpc" | "rpcSource" | "fundingHistory" | "holderPage" | "holderSourceUrl"> {
  let requestId = 0;
  const endpoints = configuredRpcEndpoints(configuration);
  let endpointIndex = 0;
  const sourceLabels: Readonly<Record<string, string>> = {
    "mainnet.base.org": "Base public RPC",
    "base-rpc.publicnode.com": "PublicNode Base RPC",
    "base.drpc.org": "dRPC Base RPC",
    "base-mainnet.g.alchemy.com": "Alchemy Base RPC",
    "base-mainnet.infura.io": "Infura Base RPC",
  };
  const holderSourceUrl = (token: Address) => configuration.blockscoutApiKey ? `https://api.blockscout.com/8453/api/v2/tokens/${token}/holders` : `https://base.blockscout.com/api/v2/tokens/${token}/holders`;
  const safeRequest = async <T>(url: string, init: RequestInit, readResponse: (response: Response) => Promise<T>): Promise<T> => {
    const deadline = createDeadline(configuration.timeoutMs, signal ? [signal] : []);
    try {
      let response: Response;
      try {
        deadline.signal.throwIfAborted();
        response = await abortable(() => fetch(url, { ...init, redirect: "error", cache: "no-store", signal: deadline.signal }), deadline.signal);
      } catch (error) {
        if (error instanceof TypeError) throw new UpstreamFailure(true);
        throw error;
      }
      // Keep the deadline owned until the entire bounded body has been read.
      return await abortable(() => readResponse(response), deadline.signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.signal.aborted) throw new UpstreamFailure(true);
      throw error;
    } finally { deadline.dispose(); }
  };
  return {
    holderSourceUrl,
    recoverRpc() {
      if (endpointIndex + 1 >= endpoints.length) return false;
      endpointIndex++;
      return true;
    },
    rpcSource() { return sourceLabels[endpoints[endpointIndex].hostname] ?? `Configured Base RPC ${endpointIndex + 1}`; },
    async holderPage(token: Address, cursor: Record<string, string | number> | null): Promise<HolderDiscoveryPage> {
      const checkedToken = holderAddress.safeParse(token);
      const checkedCursor = holderCursor.safeParse(cursor);
      if (!checkedToken.success || !checkedCursor.success) throw new ProviderIntegrityError("Invalid holder discovery request identity or cursor.");
      const url = new URL(holderSourceUrl(checkedToken.data));
      if (checkedCursor.data) for (const [key, value] of Object.entries(checkedCursor.data)) if (value !== undefined) url.searchParams.set(key, String(value));
      return safeRequest(url.toString(), { headers: { accept: "application/json", ...(configuration.blockscoutApiKey ? { authorization: `Bearer ${configuration.blockscoutApiKey}` } : {}) } }, async (response) => {
        const result = holderPageSchema.safeParse(await boundedJson(response, 1_000_000, true));
        if (!result.success) throw new ProviderIntegrityError("The public holder index returned malformed addresses or pagination.");
        const identities = [result.data.token?.address_hash, result.data.token?.address, result.data.token?.hash].filter((value): value is Address => value !== undefined);
        if (identities.some((value) => value !== checkedToken.data)) throw new ProviderIntegrityError("The holder index identified another token.");
        return {
          items: result.data.items.map((item) => ({ address: item.address?.hash ?? (typeof item.address_hash === "string" ? item.address_hash : item.address_hash!.hash) })),
          nextCursor: result.data.next_page_params,
          ...(identities.length ? { tokenAddress: checkedToken.data } : {}),
        };
      });
    },
    async rpc(method, params) {
      // Callers cannot turn this transport into a write/signing or arbitrary-method proxy.
      if (!["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getCode", "eth_getTransactionCount", "eth_call"].includes(method) && !(method === "alchemy_getAssetTransfers" && (configuration.allowLocalTests || endpoints[endpointIndex].hostname === "base-mainnet.g.alchemy.com"))) throw new Error("Unsupported read-only provider method.");
      const id = ++requestId;
      // Exactly one physical HTTP request. Recovery is a separate explicit core
      // action, so its chain/header checks and retries consume the shared budget.
      return safeRequest(endpoints[endpointIndex].toString(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }, async (response) => {
        let value: unknown;
        try { value = await boundedJson(response); }
        catch (error) { if (method === "eth_getLogs" && error instanceof ProviderResponseLimitError) throw new ProviderLogRangeError(); throw error; }
        const result = envelopeSchema.safeParse(value);
        if (!result.success || result.data.id !== id || Boolean(result.data.error) === Object.prototype.hasOwnProperty.call(result.data, "result")) throw new ProviderIntegrityError("The RPC response envelope did not match its request.");
        if (result.data.error) {
          const { code, message } = result.data.error;
          // Explicit 429/rate/quota errors take priority over a generic "limit".
          // Inspect only bounded error text; never retain/log upstream messages.
          const throttle = code === 429 || /\b(?:rate[ -]?limit|too many requests|quota|compute units|requests per second)\b/i.test(message);
          const rangeLimit = /\b(?:block range (?:is )?(?:too (?:large|wide)|exceed|limit)|(?:maximum|max) (?:allowed )?(?:block range|blocks per query)|(?:query|response|result set) (?:returned )?(?:too (?:large|many)|exceeds?|exceeded)|more than \d+ (?:results|logs)|limit (?:the|your) (?:query|block range))\b/i.test(message);
          if (method === "eth_getLogs" && !throttle && rangeLimit) throw new ProviderLogRangeError(false, { rpcCode: code });
          throw new UpstreamFailure(throttle || [429, -32005, -32016].includes(code), { rpcCode: code });
        }
        return result.data.result;
      });
    },
    ...(configuration.blockscoutApiKey ? {
      async fundingHistory(wallet: Address, cursor: Record<string, string | number> | null): Promise<FundingHistoryPage> {
        // Fixed origin/path; provider pagination cannot inject an origin or replace authentication.
        const url = new URL(`https://api.blockscout.com/8453/api/v2/addresses/${wallet}/transactions`);
        if (cursor) for (const [key, value] of Object.entries(cursor)) { if (!cursorKeys.has(key)) throw new UpstreamFailure(); url.searchParams.set(key, String(value)); }
        url.searchParams.set("filter", "to"); url.searchParams.set("sort", "block_number"); url.searchParams.set("order", "desc");
        return safeRequest(url.toString(), { headers: { accept: "application/json", authorization: `Bearer ${configuration.blockscoutApiKey}` } }, async (response) => {
          const result = pageSchema.safeParse(await boundedJson(response, 1_000_000));
          if (!result.success || (result.data.next_page_params && (Object.keys(result.data.next_page_params).length > 8 || Object.keys(result.data.next_page_params).some((key) => !cursorKeys.has(key))))) throw new UpstreamFailure();
          return { items: result.data.items.map((item) => ({ hash: item.hash, blockNumber: item.block_number })), nextCursor: result.data.next_page_params };
        });
      },
    } : {}),
  };
}
