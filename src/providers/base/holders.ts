import { encodeFunctionData, parseAbi } from "viem";
import { z } from "zod";
import type { Address, BlockReference, HolderSnapshot } from "@/domain/investigations/types";
import { approvedHolderSource, validateHolderSnapshot } from "@/domain/investigations/holder-snapshot";
import { isProviderThrottle, ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "./errors";

export interface HolderDiscoveryPage {
  items: { address: Address }[];
  nextCursor: Record<string, string | number> | null;
  tokenAddress?: Address;
  /** False when a source supplies a fixed subset rather than exhaustible pages. */
  complete?: boolean;
}
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const cursorKeys = new Set(["address_hash", "value", "items_count", "token_id"]);
const cursor = z.record(z.string(), z.union([z.string().max(256), z.number().int().nonnegative().safe()])).refine((value) => Object.keys(value).length <= 4 && Object.keys(value).every((key) => cursorKeys.has(key)));
const pageSchema = z.object({ items: z.array(z.object({ address })).max(100), nextCursor: cursor.nullable(), tokenAddress: address.optional(), complete: z.boolean().optional() });
const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface HolderCollectionOptions {
  token: Address;
  totalSupplyRaw: string | null;
  block: BlockReference;
  observedWallets: readonly Address[];
  /** External address suggestions are not observations of token activity. */
  externalWallets?: readonly Address[];
  observedAt: string;
  sourceUrl?: string;
  provider?: HolderSnapshot["discovery"]["provider"];
  indexIndependentOfRpc?: boolean;
  page(cursor: Record<string, string | number> | null): Promise<HolderDiscoveryPage>;
  /** Above one, the caller must supply counted reads on a fixed, authenticated
   * RPC lane without concurrent endpoint recovery or hidden retries. */
  balanceConcurrency?: number;
  request(method: string, params: unknown[]): Promise<unknown>;
  /** Includes real retries; supplied by the collector's shared acquisition counter. */
  remainingCalls(): number;
  signal?: AbortSignal;
  throttleError?: () => UpstreamFailure | null;
}

export interface HolderDiscoveryResult {
  snapshot: HolderSnapshot;
  /** Sticky only for a recognized throttle from an attempted holder-index page.
   * The current RPC throttle is checked separately when balances are read. */
  throttled: boolean;
}

/** Discover indexed candidates without making balance calls. Pagination completion
 * never establishes a historical/finalized holder census. */
export async function discoverHolderCandidates(options: HolderCollectionOptions): Promise<HolderDiscoveryResult> {
  const checkAbort = () => options.signal?.throwIfAborted();
  checkAbort();
  const sourceUrl = options.sourceUrl ?? `https://base.blockscout.com/api/v2/tokens/${options.token}/holders`;
  const provider = options.provider ?? "Blockscout";
  if (!approvedHolderSource(provider, options.token, sourceUrl)) throw new ProviderIntegrityError("The holder discovery source was not an approved token endpoint.");
  const holders = new Map<Address, HolderSnapshot["holders"][number]>();
  for (const wallet of options.observedWallets) {
    const parsed = address.safeParse(wallet); if (!parsed.success) throw new ProviderIntegrityError();
    holders.set(parsed.data, { address: parsed.data, balanceRaw: null, status: "not_examined", discoveredBy: "observed" });
  }
  for (const wallet of options.externalWallets ?? []) {
    const parsed = address.safeParse(wallet); if (!parsed.success) throw new ProviderIntegrityError();
    if (!holders.has(parsed.data)) holders.set(parsed.data, { address: parsed.data, balanceRaw: null, status: "not_examined", discoveredBy: "external" });
  }
  const snapshot: HolderSnapshot = {
    chainId: 8453, tokenAddress: options.token, block: { ...options.block }, totalSupplyRaw: options.totalSupplyRaw,
    discovery: { provider, sourceUrl, observedAt: options.observedAt, status: "not_examined", pages: 0, addresses: 0, finalizedCensus: false, reason: "The holder discovery phase had no remaining shared call budget." },
    balances: { status: "not_examined", requestedWallets: 0, verifiedWallets: 0, reason: null }, holders: [],
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: options.observedAt },
  };
  // Pagination gets at most one quarter of the caller's allocation. The caller
  // can prioritize funding before supplying a later balance-read allocation.
  const discoveryCalls = Math.max(1, Math.floor(options.remainingCalls() / 4));
  let next: Record<string, string | number> | null = null;
  const rpcThrottledBeforeDiscovery = !options.indexIndependentOfRpc && Boolean(options.throttleError?.());
  let throttled = false;
  if (rpcThrottledBeforeDiscovery) snapshot.discovery.reason = "Earlier RPC throttling stopped the optional holder phase before discovery began.";
  const cursors = new Set<string>();
  try {
    for (let read = 0; read < discoveryCalls && options.remainingCalls() > 0 && !rpcThrottledBeforeDiscovery && !throttled; read++) {
      checkAbort();
      const parsed = pageSchema.safeParse(await options.page(next));
      checkAbort();
      if (!parsed.success) throw new ProviderIntegrityError("The holder index returned malformed discovery or pagination data.");
      const page: HolderDiscoveryPage = parsed.data;
      if (page.tokenAddress !== undefined && page.tokenAddress !== options.token) throw new ProviderIntegrityError("The holder discovery response identified another token.");
      for (const item of page.items) {
        const previous = holders.get(item.address);
        holders.set(item.address, { address: item.address, balanceRaw: null, status: "not_examined", discoveredBy: previous?.discoveredBy === "observed" || previous?.discoveredBy === "both" ? "both" : "indexed" });
      }
      snapshot.discovery.pages++;
      snapshot.discovery.status = page.nextCursor === null && page.complete !== false && provider !== "GoPlus" ? "complete" : "partial";
      snapshot.discovery.reason = provider === "GoPlus" ? "GoPlus supplies a source-reported holder count and a top-holder subset. All returned and observed candidates are eligible for pinned RPC balance checks; the source subset is not a full holder census or an application wallet limit."
        : page.nextCursor === null ? "The latest indexed address pages were exhausted. The index may lag, change between pages, or omit holders at the pinned finalized block; this is not a finalized holder census." : "The shared discovery call allocation ended before indexed pagination completed; additional addresses may be missing.";
      if (page.nextCursor === null) break;
      next = page.nextCursor;
      const key = JSON.stringify(Object.entries(next).sort());
      if (cursors.has(key)) { snapshot.discovery.reason = "Indexed pagination repeated a cursor; additional holder addresses remain unknown."; break; }
      cursors.add(key);
    }
  } catch (error) {
    checkAbort();
    if (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError)) throw error;
    if (isProviderThrottle(error)) throttled = true;
    snapshot.discovery.status = snapshot.discovery.pages ? "partial" : "unavailable";
    snapshot.discovery.reason = error instanceof ProviderBudgetError ? "The shared call budget interrupted indexed holder discovery." : isProviderThrottle(error) ? "Provider throttling stopped the optional holder phase; retained candidates remain bounded and their unchecked balances are unknown." : "The configured holder index could not complete address discovery; retained observed and indexed candidates remain explicitly bounded.";
  }
  snapshot.holders = [...holders.values()].sort((a, b) => a.address.localeCompare(b.address));
  snapshot.discovery.addresses = snapshot.holders.filter((item) => item.discoveredBy === "indexed" || item.discoveredBy === "both").length;
  snapshot.balances.requestedWallets = snapshot.holders.length;
  snapshot.balances.status = !snapshot.holders.length && snapshot.discovery.status === "complete" ? "complete" : "not_examined";
  snapshot.balances.reason = "Balance verification has not started. Discovered candidates retain unknown balances until pinned RPC reads succeed.";
  checkAbort();
  return { snapshot, throttled };
}

/** Verify only retained candidates, after any intervening funding work. An actual
 * holder-index throttle remains binding even if the RPC is healthy afterward;
 * deferral before index acquisition relies on the current RPC throttle instead. */
export async function verifyHolderBalances(discoveryResult: HolderDiscoveryResult, options: HolderCollectionOptions): Promise<HolderSnapshot> {
  const checkAbort = () => options.signal?.throwIfAborted();
  checkAbort();
  const concurrency = options.balanceConcurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new RangeError("Balance concurrency must be an integer between one and four.");
  let snapshot: HolderSnapshot;
  try {
    if (typeof discoveryResult?.throttled !== "boolean") throw new ProviderIntegrityError();
    snapshot = validateHolderSnapshot(discoveryResult.snapshot, { address: options.token, chainId: 8453, name: null, symbol: null, decimals: null, totalSupplyRaw: options.totalSupplyRaw }, options.block);
    if (snapshot.holders.some((item) => item.status !== "not_examined" || item.balanceRaw !== null)) throw new ProviderIntegrityError();
  } catch { throw new ProviderIntegrityError("Holder discovery did not match the pending pinned balance phase."); }
  let throttled = discoveryResult.throttled || Boolean(options.throttleError?.());
  for (let offset = 0; offset < snapshot.holders.length;) {
    checkAbort();
    const remaining = options.remainingCalls();
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new RangeError("Remaining balance-call allocation must be a nonnegative safe integer.");
    if (remaining === 0 || throttled || options.throttleError?.()) { throttled ||= Boolean(options.throttleError?.()); break; }
    const batch = snapshot.holders.slice(offset, offset + Math.min(concurrency, remaining));
    // Each caller-owned read consumes one reserved allocation before it awaits
    // I/O. Settle the entire bounded batch before any new reads or publication.
    const results = await Promise.allSettled(batch.map(async (item) => {
      checkAbort();
      item.status = "unavailable";
      const value = await options.request("eth_call", [{ to: options.token, data: encodeFunctionData({ abi, functionName: "balanceOf", args: [item.address] }) }, `0x${BigInt(options.block.number).toString(16)}`]);
      checkAbort();
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ProviderIntegrityError("The pinned balanceOf response was not one exact uint256 ABI word.");
      return BigInt(value).toString();
    }));
    checkAbort();
    let budgetEnded = false, terminalFailure = false;
    let failure: unknown;
    for (const [index, result] of results.entries()) {
      const item = batch[index];
      if (result.status === "fulfilled") { item.balanceRaw = result.value; item.status = "verified"; }
      else if (result.reason instanceof UpstreamFailure) throttled ||= isProviderThrottle(result.reason);
      else if (result.reason instanceof ProviderBudgetError) budgetEnded = true;
      else if (!terminalFailure) { terminalFailure = true; failure = result.reason; }
    }
    if (terminalFailure) throw failure;
    offset += batch.length;
    if (throttled || budgetEnded) break;
  }
  const verified = snapshot.holders.filter((item) => item.status === "verified");
  if (options.totalSupplyRaw !== null && verified.reduce((sum, item) => sum + BigInt(item.balanceRaw!), 0n) > BigInt(options.totalSupplyRaw)) throw new ProviderIntegrityError("Pinned token balances exceeded the reported total supply.");
  snapshot.balances.requestedWallets = snapshot.holders.length;
  snapshot.balances.verifiedWallets = verified.length;
  snapshot.balances.status = verified.length === snapshot.holders.length && (verified.length > 0 || snapshot.discovery.status === "complete") ? "complete" : verified.length ? "partial" : snapshot.holders.some((item) => item.status === "unavailable") ? "unavailable" : "not_examined";
  snapshot.balances.reason = snapshot.balances.status === "complete" ? "All discovered candidates have pinned finalized balanceOf results. This does not establish complete holder discovery." : throttled ? "Provider throttling stopped optional holder checks. Verified balances are retained; failed reads retain null balances and unreached candidates remain not_examined." : "Only verified balanceOf results are known; failed and unreached candidates retain null balances. Balance checks share the acquisition budget with transfer receipts, funding, and the final canonical recheck.";
  checkAbort();
  return snapshot;
}

/** Backward-compatible composed acquisition for callers without phase scheduling. */
export async function collectHolderSnapshot(options: HolderCollectionOptions): Promise<HolderSnapshot> {
  return verifyHolderBalances(await discoverHolderCandidates(options), options);
}
