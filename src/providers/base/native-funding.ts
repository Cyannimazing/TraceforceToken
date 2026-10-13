import { z } from "zod";
import type { Address, BlockReference, EvidenceRecord, Hash, WalletFundingCoverage } from "@/domain/investigations/types";
import { isProviderThrottle, ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "./errors";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hash);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66);
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(131_074);
const transaction = z.object({ hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity, from: address, to: address.nullable(), value: quantity });
const fullBlock = z.object({ number: quantity, hash, parentHash: hash, timestamp: quantity, transactions: z.array(transaction).max(20_000) });
const receipt = z.object({ transactionHash: hash, blockHash: hash, blockNumber: quantity, transactionIndex: quantity, status: z.enum(["0x0", "0x1"]) });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ProviderIntegrityError("Native funding RPC returned malformed or incomplete evidence.");
  return parsed.data;
}
function integer(value: string) {
  const result = Number(BigInt(value)); if (!Number.isSafeInteger(result)) throw new ProviderIntegrityError(); return result;
}
const hex = (value: bigint) => `0x${value.toString(16)}`;

export interface NativeFundingOptions {
  wallets: readonly Address[];
  from: BlockReference;
  to: BlockReference;
  maxBlocks: number;
  observedAt: string;
  request(method: string, params: unknown[]): Promise<unknown>;
  canonicalBlock(number: string, expectedHash: Hash): Promise<BlockReference>;
  signal?: AbortSignal;
  throttleError?: () => UpstreamFailure | null;
}

/** Scan one canonical oldest prefix for every candidate, committing whole blocks.
 * Code is checked lazily for successful positive inbound transactions only.
 * Coverage describes this bounded search, not proof that every candidate is an EOA. */
export async function collectNativeFundingPrefix(options: NativeFundingOptions): Promise<{
  evidence: EvidenceRecord[];
  coverage: WalletFundingCoverage[];
  examinedWallets: number;
  completedBlocks: number;
}> {
  const maximum = parse(z.number().int().min(1).max(256), options.maxBlocks);
  const first = BigInt(options.from.number); const last = BigInt(options.to.number);
  if (first > last) throw new ProviderIntegrityError();
  const end = first + BigInt(maximum - 1) < last ? first + BigInt(maximum - 1) : last;
  const wallets = [...new Set(options.wallets.map((wallet) => parse(address, wallet)))].sort();
  const coverage: WalletFundingCoverage[] = wallets.map((wallet) => ({ wallet, status: "not_examined", fromBlock: options.from.number, toBlock: options.from.number, internalTransfers: "not_examined", reason: "The bounded native-funding block search was not reached." }));
  const candidates = new Set(wallets), excludedContracts = new Set<Address>();
  const evidence: EvidenceRecord[] = [], codeCache = new Map<string, boolean>();
  let completedBlocks = 0; let previous: BlockReference | null = null; let failure: string | null = null;
  let attemptedBlock = false;
  const seenTransactions = new Set<Hash>();
  const checkAbort = () => options.signal?.throwIfAborted();
  const checkThrottle = () => { const error = options.throttleError?.(); if (error) throw error; };
  async function codeEmpty(wallet: Address, block: BlockReference) {
    const key = `${block.number}:${block.hash}:${wallet}`;
    const cached = codeCache.get(key);
    if (cached !== undefined) return cached;
    checkAbort(); checkThrottle();
    const empty = parse(bytes, await options.request("eth_getCode", [wallet, hex(BigInt(block.number))])) === "0x";
    checkAbort(); codeCache.set(key, empty); return empty;
  }
  try {
    for (let number = first; number <= end && candidates.size; number++) {
      checkAbort();
      checkThrottle();
      let rawBlock: unknown;
      try { rawBlock = await options.request("eth_getBlockByNumber", [hex(number), true]); attemptedBlock = true; }
      catch (error) { if (!(error instanceof ProviderBudgetError)) attemptedBlock = true; throw error; }
      const block = parse(fullBlock, rawBlock);
      checkAbort();
      checkThrottle();
      if (BigInt(block.number) !== number || (previous && (block.parentHash !== previous.hash || integer(block.timestamp) < previous.timestamp))) throw new ProviderIntegrityError("Native funding blocks did not form the expected ordered canonical prefix.");
      const canonical = await options.canonicalBlock(number.toString(), block.hash);
      checkAbort();
      if (canonical.number !== number.toString() || canonical.hash !== block.hash || canonical.timestamp !== integer(block.timestamp)) throw new ProviderIntegrityError();
      const staged: EvidenceRecord[] = [];
      for (const [index, tx] of block.transactions.entries()) {
        if (tx.blockHash !== block.hash || BigInt(tx.blockNumber) !== number || BigInt(tx.transactionIndex) !== BigInt(index) || seenTransactions.has(tx.hash) || BigInt(tx.value) >= 2n ** 256n) throw new ProviderIntegrityError("Native funding transaction inclusion or ordering conflicted with its block.");
        seenTransactions.add(tx.hash);
        if (!tx.to || !candidates.has(tx.to) || BigInt(tx.value) === 0n || excludedContracts.has(tx.to)) continue;
        checkThrottle();
        const txReceipt = parse(receipt, await options.request("eth_getTransactionReceipt", [tx.hash]));
        checkAbort();
        if (txReceipt.transactionHash !== tx.hash || txReceipt.blockHash !== tx.blockHash || txReceipt.blockNumber !== tx.blockNumber || txReceipt.transactionIndex !== tx.transactionIndex) throw new ProviderIntegrityError("Native funding transaction and receipt inclusion disagreed.");
        if (txReceipt.status !== "0x1") continue;
        // Keep the existing end-state contract/delegated-account exclusion,
        // without spending one lookup on every dormant candidate beforehand.
        if (!await codeEmpty(tx.to, options.to)) { excludedContracts.add(tx.to); continue; }
        if (!await codeEmpty(tx.to, canonical)) continue;
        const id = `8453:${block.hash}:${tx.hash}:native`;
        staged.push({ id, kind: "funding", chainId: 8453, blockNumber: number.toString(), blockHash: block.hash, transactionHash: tx.hash, transactionIndex: index, logIndex: null, traceId: null, timestamp: canonical.timestamp, from: tx.from, to: tx.to, assetAddress: null, amountRaw: BigInt(tx.value).toString(), provenance: { provider: "Base RPC", method: "bounded full-block top-level transaction discovery + receipt verification", observedAt: options.observedAt }, sale: null });
      }
      checkAbort();
      evidence.push(...staged);
      completedBlocks++; previous = canonical;
    }
  } catch (error) {
    checkAbort();
    // Archive/storage/unknown failures must escape. Only recognized acquisition
    // availability or budget failures may yield a declared incomplete prefix.
    if (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError)) throw error;
    failure = error instanceof ProviderBudgetError ? "Provider call budget reached." : isProviderThrottle(error) ? "RPC throttling stopped further native-funding requests." : "RPC could not complete native-funding verification.";
  }
  for (const item of coverage) {
    if (excludedContracts.has(item.wallet)) { item.reason = "A matching inbound transaction identified a contract or delegated recipient at the pinned end block; that wallet's funding is outside this adapter's scope."; continue; }
    if (!completedBlocks) {
      item.status = attemptedBlock ? "unavailable" : "not_examined";
      item.reason = `${failure ?? "No complete native-funding block was examined."} No complete canonical block contributes funding coverage. Internal native transfers and lifetime-first funding are not examined.`;
      continue;
    }
    item.toBlock = previous!.number;
    item.status = previous!.number === options.to.number ? "complete" : "partial";
    const scope = "Coverage describes a top-level inbound transaction search, not verified EOA identity. Only successful code-empty recipient observations are retained; wallet type can remain unassessed when no successful positive inbound observation requires a code check. Internal native transfers and lifetime-first funding are not examined.";
    item.reason = item.status === "complete" ? `The declared block window was searched through complete canonical full blocks. ${scope}` : `Only the contiguous oldest prefix ${options.from.number}–${previous!.number} was searched. ${failure ?? "Native-funding block limit reached."} ${scope}`;
  }
  return { evidence, coverage, examinedWallets: completedBlocks ? wallets.length - excludedContracts.size : 0, completedBlocks };
}
