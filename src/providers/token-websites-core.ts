import type { Address, TokenMarketSnapshot, TokenWebPresence } from "@/domain/investigations/types";
import { normalizeTokenWebsite } from "@/domain/investigations/token-web-presence";
import { normalizeMarketChange, normalizeMarketPrice, normalizeMarketUsd, normalizePairCreatedAt } from "@/domain/investigations/token-market";
import { createDeadline } from "@/lib/deadline";

const MAX_BYTES = 256 * 1024;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID = /^0x[0-9a-fA-F]{64}$/;
const MAX_PAIRS = 100;

export interface TokenWebsiteOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface TokenMetadata {
  webPresence: TokenWebPresence;
  marketSnapshot: TokenMarketSnapshot;
}

type MetadataBase = Pick<TokenWebPresence, "source" | "checkedAt" | "sourceUrl">;
interface MatchingPair { address: Address; data: Record<string, unknown> }

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Website metadata is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error("Website metadata exceeded its response limit.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    // Do not await cancellation: a non-cooperative injected/upstream stream must
    // not keep the request alive beyond its owned deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function matchingPairs(payload: unknown, token: string): { pairs: MatchingPair[]; unsupportedPools: number } {
  if (!Array.isArray(payload) || payload.length > MAX_PAIRS) throw new Error("Unexpected token metadata response.");
  const pairs: MatchingPair[] = [];
  let unsupportedPools = 0;
  for (const entry of payload) {
    const pair = object(entry);
    const baseToken = object(pair?.baseToken);
    if (!pair || typeof pair.chainId !== "string" || !baseToken || typeof baseToken.address !== "string") throw new Error("Unexpected pair metadata.");
    // Quote-token listings cannot safely attribute token metadata to this scan.
    if (pair.chainId !== "base" || baseToken.address.toLowerCase() !== token) continue;
    if (typeof pair.pairAddress === "string" && POOL_ID.test(pair.pairAddress)) { unsupportedPools++; continue; }
    if (typeof pair.pairAddress !== "string" || !ADDRESS.test(pair.pairAddress)) throw new Error("Unexpected pair identity.");
    pairs.push({ address: pair.pairAddress.toLowerCase() as Address, data: pair });
  }
  return { pairs, unsupportedPools };
}

function websitesFromPairs(base: MetadataBase, matching: MatchingPair[], unsupportedPools: number): TokenWebPresence {
    const pairs = new Set(matching.map((pair) => pair.address));
    const sites = new Map<string, Set<Address>>();
    let rejected = 0;
    for (const { address: pairAddress, data: pair } of matching) {
      if (pair.info === undefined || pair.info === null) continue;
      const info = object(pair.info);
      if (!info) throw new Error("Unexpected website metadata.");
      if (info.websites === undefined || info.websites === null) continue;
      if (!Array.isArray(info.websites) || info.websites.length > 20) throw new Error("Unexpected website metadata.");
      for (const raw of info.websites) {
        const candidate = object(raw);
        const url = normalizeTokenWebsite(candidate?.url);
        if (!url) { rejected++; continue; }
        const references = sites.get(url) ?? new Set<Address>();
        references.add(pairAddress);
        sites.set(url, references);
      }
    }
    const websites = [...sites].sort(([left], [right]) => left.localeCompare(right)).slice(0, 5)
      .map(([url, pairAddresses]) => ({ url, pairAddresses: [...pairAddresses].sort() }));
    const notes = [
      ...(unsupportedPools ? [pairs.size ? "Some matching listings use unsupported 32-byte pool IDs; their website metadata was not used." : "Matching listings used unsupported 32-byte pool IDs; no usable website listing was examined."] : []),
      ...(rejected ? ["Some source-reported links were rejected by the HTTPS website policy."] : []),
      ...(sites.size > 5 ? ["Only five distinct source-reported websites are shown."] : []),
    ];
    if (!websites.length && !notes.length) notes.push(pairs.size ? "The matching base-token pairs did not report a website." : "No matching base-token pair was returned; quote-token metadata is not used.");
    return { ...base, status: websites.length ? "reported" : "not_listed", websites, matchedPairs: pairs.size, reason: notes.length ? notes.join(" ") : null };
}

function emptyMarket(base: MetadataBase, status: "not_listed" | "unavailable"): TokenMarketSnapshot {
  return { ...base, status, pairAddress: null, priceUsd: null, marketCapUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPercent: null, pairCreatedAt: null };
}

function marketFromPairs(base: MetadataBase, matching: MatchingPair[]): TokenMarketSnapshot {
  const candidates = matching.map(({ address, data }) => ({
    ...base, status: "reported" as const, pairAddress: address,
    priceUsd: normalizeMarketPrice(data.priceUsd),
    marketCapUsd: normalizeMarketUsd(data.marketCap),
    liquidityUsd: normalizeMarketUsd(object(data.liquidity)?.usd),
    volume24hUsd: normalizeMarketUsd(object(data.volume)?.h24),
    priceChange24hPercent: normalizeMarketChange(object(data.priceChange)?.h24),
    pairCreatedAt: normalizePairCreatedAt(data.pairCreatedAt, Date.parse(base.checkedAt)),
  }));
  candidates.sort((left, right) => {
    const liquidity = (right.liquidityUsd ?? -1) - (left.liquidityUsd ?? -1);
    if (liquidity) return liquidity;
    if (left.pairAddress !== right.pairAddress) return left.pairAddress < right.pairAddress ? -1 : 1;
    // Conflicting duplicate rows remain deterministic without mixing fields.
    const leftKey = JSON.stringify(left), rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return candidates[0] ?? emptyMarket(base, "not_listed");
}

/** One bounded listing lookup; values are source reports, never chain proof. */
export async function collectTokenMetadata(token: Address, options: TokenWebsiteOptions = {}): Promise<TokenMetadata> {
  if (!ADDRESS.test(token)) throw new Error("A canonical token address is required.");
  const canonical = token.toLowerCase();
  const sourceUrl = `https://api.dexscreener.com/token-pairs/v1/base/${canonical}`;
  const base = { source: "dexscreener" as const, checkedAt: (options.now ?? (() => new Date()))().toISOString(), sourceUrl };
  const deadline = createDeadline(5_000, options.signal ? [options.signal] : []);
  const unavailableWebsite = (reason: string): TokenWebPresence => ({ ...base, status: "unavailable", websites: [], matchedPairs: 0, reason });
  try {
    deadline.signal.throwIfAborted();
    const response = await abortable((options.fetch ?? globalThis.fetch)(sourceUrl, {
      method: "GET", headers: { accept: "application/json" }, redirect: "error", cache: "no-store", signal: deadline.signal,
    }), deadline.signal);
    const { pairs, unsupportedPools } = matchingPairs(await readResponse(response, deadline.signal), canonical);
    let webPresence: TokenWebPresence;
    try { webPresence = websitesFromPairs(base, pairs, unsupportedPools); }
    catch { webPresence = unavailableWebsite("Website metadata could not be retrieved or validated."); }
    return { webPresence, marketSnapshot: marketFromPairs(base, pairs) };
  } catch {
    options.signal?.throwIfAborted();
    return { webPresence: unavailableWebsite(deadline.signal.aborted ? "Website metadata request exceeded its deadline." : "Website metadata could not be retrieved or validated."), marketSnapshot: emptyMarket(base, "unavailable") };
  } finally { deadline.dispose(); }
}

/** Compatibility helper; new scan wiring should use the combined lookup once. */
export async function collectTokenWebPresence(token: Address, options: TokenWebsiteOptions = {}): Promise<TokenWebPresence> {
  return (await collectTokenMetadata(token, options)).webPresence;
}
