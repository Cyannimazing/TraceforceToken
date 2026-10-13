import { z } from "zod";
import type { Address, BlockReference, EvidenceRecord, Hash, WalletFundingCoverage } from "@/domain/investigations/types";
import { createDeadline } from "@/lib/deadline";
import { isProviderThrottle, ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "./errors";

const ENDPOINT = "https://portal.sqd.dev/datasets/base-mainnet/finalized-stream";
const MAX_BODY = 2 * 1024 * 1024;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hash);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => BigInt(value) < 2n ** 256n);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66);
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(131_074);
const safeInteger = z.number().int().nonnegative().safe();
const reference = z.object({ number: decimal, hash, timestamp: safeInteger });
const indexedTransaction = z.object({ hash, from: address, to: address.nullable(), value: decimal, transactionIndex: safeInteger, status: z.union([z.literal(0), z.literal(1)]) });
const blockSchema = z.object({ header: reference.extend({ parentHash: hash }), transactions: z.array(indexedTransaction).max(20_000) });
const rpcTransaction = z.object({ hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity, from: address, to: address.nullable(), value: quantity });
const rpcReceipt = z.object({ transactionHash: hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity, status: z.enum(["0x0", "0x1"]) });

export interface SqdFundingBlock {
  header: BlockReference & { parentHash: Hash };
  transactions: { hash: Hash; from: Address; to: Address | null; value: string; transactionIndex: number; status: 0 | 1 }[];
}
export type SqdFundingPageQuery = (query: {
  wallets: readonly Address[];
  fromBlock: string;
  toBlock: string;
  parentBlockHash?: Hash;
}) => Promise<{ blocks: SqdFundingBlock[] }>;
export interface SqdFundingOptions {
  wallets: readonly Address[];
  from: BlockReference;
  to: BlockReference;
  observedAt: string;
  request(method: string, params: unknown[]): Promise<unknown>;
  canonicalBlock(number: string, expectedHash: Hash): Promise<BlockReference>;
  signal?: AbortSignal;
  throttleError?: () => UpstreamFailure | null;
  /** The caller counts this one HTTP request against its shared actual-call budget. */
  queryPage: SqdFundingPageQuery;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderIntegrityError("SQD funding returned malformed evidence or bounds.");
  return result.data;
}
const hex = (value: string | number) => `0x${BigInt(value).toString(16)}`;
function integer(value: string): number {
  const result = Number(BigInt(value));
  if (!Number.isSafeInteger(result)) throw new ProviderIntegrityError();
  return result;
}
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    try { operation().then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); }); }
    catch (error) { cleanup(); reject(error); }
  });
}

/** Fixed public evaluation endpoint; activation and commercial-use policy belong to configuration. */
export function createSqdFundingQuery(timeoutMs: number, signal?: AbortSignal): SqdFundingPageQuery {
  parse(z.number().int().min(1).max(120_000), timeoutMs);
  return async (query) => {
    const wallets = parse(z.array(address).min(1).max(128), [...query.wallets]);
    const from = integer(parse(decimal, query.fromBlock)), to = integer(parse(decimal, query.toBlock));
    if (from > to || to - from >= 1000 || new Set(wallets).size !== wallets.length) throw new ProviderIntegrityError();
    const parentBlockHash = query.parentBlockHash === undefined ? undefined : parse(hash, query.parentBlockHash);
    const body = JSON.stringify({ type: "evm", fromBlock: from, toBlock: to, includeAllBlocks: true, ...(parentBlockHash ? { parentBlockHash } : {}), fields: { block: { number: true, hash: true, parentHash: true, timestamp: true }, transaction: { hash: true, from: true, to: true, value: true, transactionIndex: true, status: true } }, transactions: [{ to: wallets }] });
    if (Buffer.byteLength(body) > 8192) throw new ProviderIntegrityError();
    const deadline = createDeadline(timeoutMs, signal ? [signal] : []);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await abortable(() => fetch(ENDPOINT, { method: "POST", body, redirect: "error", cache: "no-store", headers: { "content-type": "application/json", accept: "application/jsonl" }, signal: deadline.signal }), deadline.signal);
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); throw new UpstreamFailure(response.status === 429 || response.status >= 500, { httpStatus: response.status }); }
      if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY || !response.body) { void response.body?.cancel().catch(() => undefined); throw new UpstreamFailure(); }
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const blocks: SqdFundingBlock[] = [];
      let length = 0, pending = "";
      const line = (text: string) => {
        if (!text.trim()) return;
        if (blocks.length >= 1000) throw new ProviderIntegrityError("SQD returned too many block headers.");
        let raw: unknown;
        try { raw = JSON.parse(text) as unknown; } catch { throw new ProviderIntegrityError("SQD returned malformed JSONL."); }
        const wire = parse(z.object({ header: z.object({ number: safeInteger, hash, parentHash: hash, timestamp: safeInteger }), transactions: z.array(z.object({ hash, from: address, to: address.nullable(), value: quantity, transactionIndex: safeInteger, status: z.union([z.literal(0), z.literal(1)]) })).max(20_000).optional().default([]) }), raw);
        blocks.push(parse(blockSchema, { header: { ...wire.header, number: String(wire.header.number) }, transactions: wire.transactions.map((tx) => ({ ...tx, value: BigInt(tx.value).toString() })) }));
      };
      while (true) {
        const chunk = await abortable(() => reader!.read(), deadline.signal);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BODY) throw new UpstreamFailure();
        try { pending += decoder.decode(chunk.value, { stream: true }); } catch { throw new ProviderIntegrityError("SQD returned invalid UTF-8."); }
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) { line(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      }
      try { pending += decoder.decode(); } catch { throw new ProviderIntegrityError("SQD returned invalid UTF-8."); }
      line(pending);
      if (!blocks.length) throw new UpstreamFailure();
      deadline.signal.throwIfAborted();
      return { blocks };
    } catch (error) {
      signal?.throwIfAborted();
      // A local request timeout is provider availability; an outer scan deadline
      // or cancellation above remains the caller's exact terminal reason.
      if (deadline.signal.aborted) throw new UpstreamFailure(true);
      if (error instanceof TypeError) throw new UpstreamFailure(true);
      throw error;
    } finally {
      // Do not await a hostile/failed stream's cancellation after the owned deadline.
      if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      deadline.dispose();
    }
  };
}

/** Indexed, recipient-filtered top-level search with RPC anchors and candidate proofs.
 * Atomic blocks within anchored pages establish searched bounds, never lifetime-first funding or proof of index completeness. */
export async function collectSqdFundingWindow(options: SqdFundingOptions): Promise<{
  evidence: EvidenceRecord[]; coverage: WalletFundingCoverage[]; examinedWallets: number; completedBlocks: number;
}> {
  const from = parse(reference, options.from), to = parse(reference, options.to);
  const first = integer(from.number), last = integer(to.number);
  if (first > last || from.timestamp > to.timestamp || (first === last && from.hash !== to.hash)) throw new ProviderIntegrityError();
  parse(z.iso.datetime(), options.observedAt);
  const wallets = [...new Set(options.wallets.map((wallet) => parse(address, wallet)))].sort();
  const coverage: WalletFundingCoverage[] = wallets.map((wallet) => ({ wallet, status: "not_examined", fromBlock: from.number, toBlock: from.number, internalTransfers: "not_examined", reason: "The indexed native-funding search was not reached." }));
  const byWallet = new Map(coverage.map((item) => [item.wallet, item]));
  const evidence: EvidenceRecord[] = [], excluded = new Set<Address>(), codeCache = new Map<string, boolean>(), canonicalCache = new Map<string, BlockReference>();
  const seenTransactions = new Set<Hash>(), committedHeaders = new Map<string, SqdFundingBlock["header"]>();
  let completedBlocks = 0, stopped = false;
  const check = () => { options.signal?.throwIfAborted(); const failure = options.throttleError?.(); if (failure) throw failure; };
  async function canonical(header: SqdFundingBlock["header"]) {
    const key = `${header.number}:${header.hash}`;
    const cached = canonicalCache.get(key);
    if (cached) { if (cached.timestamp !== header.timestamp) throw new ProviderIntegrityError(); return cached; }
    check();
    const block = parse(reference, await options.canonicalBlock(header.number, header.hash));
    options.signal?.throwIfAborted();
    if (block.number !== header.number || block.hash !== header.hash || block.timestamp !== header.timestamp || (block.number === from.number && (block.hash !== from.hash || block.timestamp !== from.timestamp)) || (block.number === to.number && (block.hash !== to.hash || block.timestamp !== to.timestamp))) throw new ProviderIntegrityError();
    canonicalCache.set(key, block); return block;
  }
  async function codeEmpty(wallet: Address, block: BlockReference) {
    const key = `${block.number}:${block.hash}:${wallet}`;
    const cached = codeCache.get(key);
    if (cached !== undefined) return cached;
    check(); const empty = parse(bytes, await options.request("eth_getCode", [wallet, hex(block.number)])) === "0x";
    options.signal?.throwIfAborted(); codeCache.set(key, empty); return empty;
  }
  for (let offset = 0; offset < wallets.length; offset += 128) {
    const batch = wallets.slice(offset, offset + 128), recipients = new Set(batch);
    if (stopped) continue;
    let cursor = first, previous: SqdFundingBlock["header"] | null = null, committed = 0, attempted = false, failure: string | null = null;
    try {
      while (cursor <= last) {
        check();
        const pageEnd = Math.min(cursor + 999, last);
        let raw: unknown;
        try { raw = await options.queryPage({ wallets: batch, fromBlock: String(cursor), toBlock: String(pageEnd), ...(previous ? { parentBlockHash: previous.hash } : {}) }); attempted = true; }
        catch (error) { if (!(error instanceof ProviderBudgetError)) attempted = true; throw error; }
        options.signal?.throwIfAborted();
        const { blocks } = parse(z.object({ blocks: z.array(blockSchema).max(1000) }), raw);
        if (!blocks.length) throw new UpstreamFailure();
        const pageHashes = new Set<Hash>();
        let preceding = previous;
        for (const [index, block] of blocks.entries()) {
          const number = integer(block.header.number);
          const known = committedHeaders.get(block.header.number);
          if (known && (known.hash !== block.header.hash || known.parentHash !== block.header.parentHash || known.timestamp !== block.header.timestamp)) throw new ProviderIntegrityError("SQD recipient batches disagreed on block identity.");
          if (number !== cursor + index || number > pageEnd || (preceding && (block.header.parentHash !== preceding.hash || block.header.timestamp < preceding.timestamp)) || block.header.timestamp < from.timestamp || block.header.timestamp > to.timestamp || (number === first && (block.header.hash !== from.hash || block.header.timestamp !== from.timestamp)) || (number === last && (block.header.hash !== to.hash || block.header.timestamp !== to.timestamp))) throw new ProviderIntegrityError("SQD headers did not form the requested contiguous pinned range.");
          preceding = block.header;
          let previousIndex = -1;
          for (const tx of block.transactions) {
            if (!tx.to || !recipients.has(tx.to) || tx.transactionIndex <= previousIndex || pageHashes.has(tx.hash) || seenTransactions.has(tx.hash)) throw new ProviderIntegrityError("SQD transaction identity, ordering or recipient filter conflicted.");
            previousIndex = tx.transactionIndex; pageHashes.add(tx.hash);
          }
        }
        await canonical(blocks[0].header); await canonical(blocks.at(-1)!.header);
        for (const block of blocks) {
          check();
          const staged: EvidenceRecord[] = [], stagedExcluded = new Set<Address>();
          for (const tx of block.transactions) {
          if (BigInt(tx.value) === 0n || excluded.has(tx.to!) || stagedExcluded.has(tx.to!)) continue;
          check();
          const actual = parse(rpcTransaction, await options.request("eth_getTransactionByHash", [tx.hash]));
          options.signal?.throwIfAborted();
          if (actual.hash !== tx.hash || actual.blockHash !== block.header.hash || BigInt(actual.blockNumber).toString() !== block.header.number || BigInt(actual.transactionIndex) !== BigInt(tx.transactionIndex) || actual.from !== tx.from || actual.to !== tx.to || BigInt(actual.value).toString() !== tx.value) throw new ProviderIntegrityError("SQD candidate and RPC transaction inclusion disagreed.");
          check();
          const receipt = parse(rpcReceipt, await options.request("eth_getTransactionReceipt", [tx.hash]));
          options.signal?.throwIfAborted();
          if (receipt.transactionHash !== tx.hash || receipt.blockHash !== actual.blockHash || receipt.blockNumber !== actual.blockNumber || receipt.transactionIndex !== actual.transactionIndex || Number(BigInt(receipt.status)) !== tx.status) throw new ProviderIntegrityError("SQD candidate and RPC receipt disagreed.");
          if (receipt.status !== "0x1") continue;
          const identity = await canonical(block.header);
          if (!await codeEmpty(tx.to!, to)) { stagedExcluded.add(tx.to!); continue; }
          if (!await codeEmpty(tx.to!, identity)) continue;
          staged.push({ id: `8453:${identity.hash}:${tx.hash}:native`, kind: "funding", chainId: 8453, blockNumber: identity.number, blockHash: identity.hash, transactionHash: tx.hash, transactionIndex: tx.transactionIndex, logIndex: null, traceId: null, timestamp: identity.timestamp, from: tx.from, to: tx.to!, assetAddress: null, amountRaw: tx.value, provenance: { provider: "SQD Portal + Base RPC", method: "recipient-filtered indexed top-level transaction search + canonical RPC transaction/receipt/code verification", observedAt: options.observedAt }, sale: null });
          }
          options.signal?.throwIfAborted();
          evidence.push(...staged); stagedExcluded.forEach((wallet) => excluded.add(wallet)); block.transactions.forEach((tx) => seenTransactions.add(tx.hash)); committedHeaders.set(block.header.number, block.header);
          committed++; completedBlocks++; previous = block.header; cursor = integer(previous.number) + 1;
        }
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError)) throw error;
      failure = error instanceof ProviderBudgetError ? "Shared provider call budget reached." : error.httpStatus === 529 || isProviderThrottle(error) ? "Provider throttling stopped further indexed funding acquisition." : "The index or RPC could not complete funding verification.";
      stopped = true;
    }
    for (const wallet of batch) {
      const item = byWallet.get(wallet)!;
      if (excluded.has(wallet)) { item.reason = "A verified inbound candidate identified a contract or delegated recipient at the pinned end block; this wallet is outside the adapter's funding scope."; continue; }
      const scope = "Coverage is an indexed top-level recipient search with canonical page anchors and RPC-verified positive candidates; index omissions are not independently disproved. It does not establish EOA identity, internal transfers or lifetime-first funding.";
      if (!committed) { item.status = attempted ? "unavailable" : "not_examined"; item.reason = `${failure ?? "No complete indexed block was verified."} ${scope}`; continue; }
      item.toBlock = previous!.number; item.status = cursor > last ? "complete" : "partial";
      item.reason = `${item.status === "complete" ? "The declared indexed window was searched." : `Only the contiguous indexed prefix ${from.number}–${previous!.number} was verified. ${failure}`} ${scope}`;
    }
  }
  return { evidence, coverage, examinedWallets: coverage.filter((item) => item.status === "partial" || item.status === "complete").length, completedBlocks };
}
