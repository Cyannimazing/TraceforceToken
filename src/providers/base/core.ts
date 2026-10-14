import { decodeEventLog, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toBytes } from "viem";
import { z } from "zod";
import type { Address, BlockReference, EvidenceRecord, Hash, InvestigationDataset, ScanParameters, WalletFundingCoverage } from "@/domain/investigations/types";
import { isProviderThrottle, ProviderBudgetError, ProviderIntegrityError, ProviderLogRangeError, TokenContractNotFoundError, UpstreamFailure } from "./errors";
import { collectNativeFundingPrefix } from "./native-funding";
import { collectSqdFundingWindow, type SqdFundingPageQuery } from "./sqd-funding";
import { discoverHolderCandidates, verifyHolderBalances, type HolderCollectionOptions, type HolderDiscoveryPage, type HolderDiscoveryResult } from "./holders";
import type { TokenTransferPage, TokenTransferPageReader } from "./alchemy-transfers";
import { collectCreatorFunding } from "./creator-funding";
import { collectExitQuote } from "./exit-quote";
export { ProviderBudgetError, ProviderIntegrityError, UpstreamFailure } from "./errors";

/** Official Base deployment, checked against Uniswap's Base deployments documentation. */
export const BASE_V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd" as Address;
export const BASE_V2_FACTORY = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6" as Address;
export const BASE_V2_ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24" as Address;
export const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;
export const BASE_V3_ROUTERS: readonly Address[] = [
  "0x2626664c2603336e57b271c5c0b26f421741e481",
  "0x6ff5693b99212da76ad316178a184ab56d299b43",
];
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
export const SWAP_TOPIC = keccak256(toBytes("Swap(address,address,int256,int256,uint160,uint128,int24)"));
export const V2_SWAP_TOPIC = keccak256(toBytes("Swap(address,uint256,uint256,uint256,uint256,address)"));
export const V2_MINT_TOPIC = keccak256(toBytes("Mint(address,uint256,uint256)"));
const DEPOSIT_TOPIC = keccak256(toBytes("Deposit(address,uint256)"));
const erc20Abi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
const poolAbi = parseAbi(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)", "function getPair(address tokenA,address tokenB) view returns (address)", "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)"]);
const swapAbi = parseAbi(["event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"]);
const v2SwapAbi = parseAbi(["event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)"]);
const v2MintAbi = parseAbi(["event Mint(address indexed sender,uint256 amount0,uint256 amount1)"]);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hash);
const quantitySchema = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/).max(66);
const bytesSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).max(131_074);
const blockSchema = z.object({ number: quantitySchema, hash: hashSchema, timestamp: quantitySchema });
const logSchema = z.object({ address: addressSchema, blockNumber: quantitySchema, blockHash: hashSchema, transactionHash: hashSchema, transactionIndex: quantitySchema, logIndex: quantitySchema, topics: z.array(hashSchema).max(4), data: bytesSchema, removed: z.boolean().optional() });
const receiptSchema = z.object({ transactionHash: hashSchema, transactionIndex: quantitySchema, blockHash: hashSchema, blockNumber: quantitySchema, status: z.enum(["0x0", "0x1"]), contractAddress: addressSchema.nullable().optional(), logs: z.array(logSchema).max(1000) });
const transactionSchema = z.object({ hash: hashSchema, blockHash: hashSchema, blockNumber: quantitySchema, transactionIndex: quantitySchema, from: addressSchema, to: addressSchema.nullable(), value: quantitySchema });
type RpcLog = z.infer<typeof logSchema>;
type RpcReceipt = z.infer<typeof receiptSchema>;

export interface FundingHistoryPage {
  items: { hash: Hash; blockNumber: string }[];
  nextCursor: Record<string, string | number> | null;
}
const fundingPageSchema = z.object({
  items: z.array(z.object({ hash: hashSchema, blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(24) })).max(100),
  nextCursor: z.record(z.string().min(1).max(40), z.union([z.string().max(512), z.number().int().nonnegative().safe()])).refine((cursor) => Object.keys(cursor).length <= 8).nullable(),
});
const tokenTransferPageSchema = z.object({
  items: z.array(z.object({ hash: hashSchema, blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(24) })).max(1000),
  nextCursor: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/).nullable(),
});
export interface CollectorLimits { logChunkSize: number; maxTransferLogs: number; callBudget: number; fundingMaxPages: number; nativeFundingMaxBlocks: number }
export interface CollectorDependencies {
  rpc(method: string, params: unknown[]): Promise<unknown>;
  /** Optional explicit discovery lane; receipt/state verification still uses rpc. */
  logRpc?: (method: string, params: unknown[]) => Promise<unknown>;
  logRpcSource?: () => string;
  /** Optional fixed-lane indexed transaction discovery; receipts remain canonical evidence. */
  transferPage?: TokenTransferPageReader;
  /** Fixed index lane used to authenticate Base and already pinned range headers. */
  indexedRpc?: (method: string, params: unknown[]) => Promise<unknown>;
  fundingIndexSource?: "alchemy";
  /** One source-reported selected pair, authenticated through its supported factory. */
  poolCandidates?: () => Promise<readonly Address[]>;
  /** Third-party addresses are discovery leads only; state and receipts must
   * establish their actual holdings/activity at our pinned block. */
  candidateAddresses?: () => Promise<readonly Address[]>;
  /** Advance a configured endpoint without I/O; every subsequent read is counted here. */
  recoverRpc?: () => boolean;
  /** Static public provider label; never a configured URL or credential. */
  rpcSource?: () => string;
  fundingHistory?: (wallet: Address, cursor: Record<string, string | number> | null, range: { fromBlock: string; toBlock: string }) => Promise<FundingHistoryPage>;
  creatorFundingHistory?: (creator: Address, cursor: Record<string, string | number> | null, range: { fromBlock: string; toBlock: string }) => Promise<FundingHistoryPage>;
  sqdFundingPage?: SqdFundingPageQuery;
  holderPage?: (token: Address, cursor: Record<string, string | number> | null) => Promise<HolderDiscoveryPage>;
  holderSourceUrl?: (token: Address) => string;
  holderProvider?: "Blockscout" | "GoPlus";
  holderIndexIndependentOfRpc?: boolean;
  limits?: Partial<CollectorLimits>;
  signal?: AbortSignal;
  onProgress?: (stage: string) => Promise<void>;
  now?: () => Date;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderIntegrityError("The provider returned malformed or incomplete blockchain evidence.");
  return result.data;
}
function hex(value: bigint) { return `0x${value.toString(16)}`; }
function integer(value: string) {
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new ProviderIntegrityError("A provider index or timestamp exceeded the supported integer range.");
  return number;
}
function blockReference(raw: unknown): BlockReference {
  const value = parsed(blockSchema, raw);
  return { number: BigInt(value.number).toString(), hash: value.hash, timestamp: integer(value.timestamp) };
}
function evidenceId(log: RpcLog) { return `8453:${log.blockHash}:${log.transactionHash}:log:${integer(log.logIndex)}`; }
function transfer(log: RpcLog, timestamp: number, observedAt: string): EvidenceRecord | null {
  if (log.topics[0] !== TRANSFER_TOPIC) return null;
  // ERC-721's four-topic Transfer has a different data shape and is never treated as ERC-20.
  if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data) || !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[1]) || !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[2])) return null;
  return { id: evidenceId(log), kind: "transfer", chainId: 8453, blockNumber: BigInt(log.blockNumber).toString(), blockHash: log.blockHash, transactionHash: log.transactionHash, transactionIndex: integer(log.transactionIndex), logIndex: integer(log.logIndex), traceId: null, timestamp, from: `0x${log.topics[1].slice(-40)}`, to: `0x${log.topics[2].slice(-40)}`, assetAddress: log.address, amountRaw: BigInt(log.data).toString(), provenance: { provider: "Base RPC", method: "eth_getLogs + eth_getTransactionReceipt", observedAt }, sale: null };
}
function sameLog(left: RpcLog, right: RpcLog) { return left.address === right.address && left.blockHash === right.blockHash && left.transactionHash === right.transactionHash && left.blockNumber === right.blockNumber && left.transactionIndex === right.transactionIndex && left.logIndex === right.logIndex && left.data.toLowerCase() === right.data.toLowerCase() && left.topics.join(":") === right.topics.join(":"); }
function netFlow(records: EvidenceRecord[], wallet: Address, asset: Address) { return records.filter((record) => record.assetAddress === asset).reduce((sum, record) => sum + (record.to === wallet ? BigInt(record.amountRaw) : 0n) - (record.from === wallet ? BigInt(record.amountRaw) : 0n), 0n); }
function directFlow(records: EvidenceRecord[], from: Address, to: Address, asset: Address) { return records.filter((record) => record.from === from && record.to === to && record.assetAddress === asset).reduce((sum, record) => sum + BigInt(record.amountRaw), 0n); }

/** Pure orchestration with injected I/O. A partial source never becomes a successful empty source. */
export async function collectBaseInvestigation(parameters: ScanParameters, dependencies: CollectorDependencies): Promise<InvestigationDataset> {
  const input = parsed(z.object({ token: addressSchema, lookbackBlocks: z.number().int().min(1).max(30_000), scope: z.enum(["full", "window"]).default("window") }), parameters);
  const limits = parsed(z.object({ logChunkSize: z.number().int().min(10).max(10_000_000), maxTransferLogs: z.number().int().min(1).max(2000), callBudget: z.number().int().min(20).max(2000), fundingMaxPages: z.number().int().min(1).max(20), nativeFundingMaxBlocks: z.number().int().min(1).max(256) }), { logChunkSize: 100, maxTransferLogs: 2000, callBudget: 500, fundingMaxPages: 2, nativeFundingMaxBlocks: 32, ...dependencies.limits });
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const warnings = new Set<string>([
    "Analysis is limited to the declared finalized block window; it does not reconstruct lifetime-first funding. Reported balances require the separate pinned RPC snapshot and do not represent live-current balances.",
    "Trade verification supports authenticated single-pool Uniswap v2/v3 direct ERC-20 consideration paths and exact-value V2 Router02 WETH-wrapped native buys. Multihop routes, native-ETH unwrapping, other DEXes, and smart-wallet routes remain unclassified. Initial-liquidity observations identify the authenticated pool, not every market's launch.",
    "Internal native transfers and exchange/bridge hub attribution are not examined. Shared funding may reflect a public service.",
    "Token flow uses ERC-20 Transfer events; rebasing, deceptive events, and other nonstandard token behavior require additional investigation.",
  ]);
  let calls = 0;
  let phaseCeiling = limits.callBudget - 1;
  let rpcThrottle: UpstreamFailure | null = null;
  let pinnedBlocks: BlockReference[] = [];
  let rpcNeedsVerification = false;
  const rpcSources = new Set<string>([dependencies.rpcSource?.() ?? "Base RPC"]);
  const checkAbort = () => { dependencies.signal?.throwIfAborted(); };
  async function backoff(milliseconds: number) {
    checkAbort();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { dependencies.signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
      const abort = () => { clearTimeout(timer); reject(dependencies.signal?.reason ?? new Error("Investigation cancelled.")); };
      dependencies.signal?.addEventListener("abort", abort, { once: true });
    });
    checkAbort();
  }
  async function countedRpcAttempt(method: string, params: unknown[], ceiling: number): Promise<unknown> {
    checkAbort();
    if (calls >= ceiling) throw new ProviderBudgetError();
    calls++;
    try { return await dependencies.rpc(method, params); }
    catch (error) { checkAbort(); if (isProviderThrottle(error)) rpcThrottle = error; throw error; }
  }
  async function verifyRecoveredSource(ceiling: number) {
    if (!rpcNeedsVerification) return;
    if (BigInt(parsed(quantitySchema, await countedRpcAttempt("eth_chainId", [], ceiling))) !== 8453n) throw new ProviderIntegrityError("The fallback RPC is not Base mainnet.");
    for (const pinned of pinnedBlocks) {
      const actual = blockReference(await countedRpcAttempt("eth_getBlockByNumber", [hex(BigInt(pinned.number)), false], ceiling));
      if (actual.number !== pinned.number || actual.hash !== pinned.hash || actual.timestamp !== pinned.timestamp) throw new ProviderIntegrityError("The fallback RPC disagreed with the pinned finalized range.");
    }
    rpcNeedsVerification = false;
    rpcSources.add(dependencies.rpcSource?.() ?? "Configured Base RPC fallback");
    warnings.add("RPC availability recovery used a configured fallback after verifying Base chain identity and every already-pinned range header. All attempts and verification reads share the acquisition budget.");
  }
  async function request(method: string, params: unknown[], finalCheck = false, phaseLimit = limits.callBudget): Promise<unknown> {
    checkAbort();
    const ceiling = finalCheck ? limits.callBudget : Math.min(phaseLimit, phaseCeiling, limits.callBudget - 1);
    const attempt = (readMethod: string, readParams: unknown[]) => countedRpcAttempt(readMethod, readParams, ceiling);
    try { await verifyRecoveredSource(ceiling); return await attempt(method, params); }
    catch (error) {
      checkAbort();
      if (!(error instanceof UpstreamFailure) || calls >= ceiling) throw error;
      const retryable = error.retryable || isProviderThrottle(error);
      const accessRefused = error.httpStatus === 403 || error.rpcCode === -32601;
      let switched = false;
      if (!retryable) {
        // A public endpoint can serve logs while denying state methods. Only
        // an explicit next endpoint can recover access/method refusal; never
        // retry the same forbidden request or treat malformed data as outage.
        if (!accessRefused || ceiling - calls < pinnedBlocks.length + 2 || !dependencies.recoverRpc?.()) throw error;
        rpcNeedsVerification = true; switched = true;
      }
      if (retryable) await backoff(isProviderThrottle(error) ? 1000 : 150);
      // A switch cannot borrow the canonical reserve or hide additional calls.
      // If the handshake cannot fit, retry the current endpoint once instead.
      if (!switched && ceiling - calls >= pinnedBlocks.length + 2 && dependencies.recoverRpc?.()) rpcNeedsVerification = true;
      await verifyRecoveredSource(ceiling);
      const result = await attempt(method, params);
      if (isProviderThrottle(error)) rpcThrottle = null;
      return result;
    }
  }
  let logSourceVerified = false;
  async function requestTransferLogs(params: unknown[]): Promise<unknown> {
    if (!dependencies.logRpc) return request("eth_getLogs", params);
    const ceiling = Math.min(phaseCeiling, limits.callBudget - 1);
    const attempt = async (method: string, values: unknown[]) => {
      checkAbort();
      if (calls >= ceiling) throw new ProviderBudgetError();
      calls++;
      return dependencies.logRpc!(method, values);
    };
    if (!logSourceVerified) {
      if (BigInt(parsed(quantitySchema, await attempt("eth_chainId", []))) !== 8453n) throw new ProviderIntegrityError("The log-discovery RPC is not Base mainnet.");
      for (const pinned of pinnedBlocks) {
        const actual = blockReference(await attempt("eth_getBlockByNumber", [hex(BigInt(pinned.number)), false]));
        if (actual.number !== pinned.number || actual.hash !== pinned.hash || actual.timestamp !== pinned.timestamp) throw new ProviderIntegrityError("The log-discovery RPC disagreed with the pinned finalized range.");
      }
      logSourceVerified = true;
      rpcSources.add(dependencies.logRpcSource?.() ?? "Configured Base log RPC");
      warnings.add("Transfer candidates use a separately configured log RPC checked against Base and the pinned range; receipts and balances are verified through the state RPC. All physical reads share the same call allocation.");
    }
    try { return await attempt("eth_getLogs", params); }
    catch (error) {
      checkAbort();
      if (!(error instanceof UpstreamFailure) || (!error.retryable && !isProviderThrottle(error)) || error instanceof ProviderLogRangeError || calls >= ceiling) throw error;
      await backoff(isProviderThrottle(error) ? 1000 : 150);
      return attempt("eth_getLogs", params);
    }
  }
  let indexedSourceVerified = false;
  let indexedSourceFailure: UpstreamFailure | null = null;
  async function verifyIndexedSource() {
    checkAbort();
    if (indexedSourceVerified) return;
    if (indexedSourceFailure) throw indexedSourceFailure;
    if (!dependencies.indexedRpc) throw new ProviderIntegrityError("Indexed discovery requires its own authenticated Base RPC lane.");
    const attempt = async (method: string, params: unknown[]) => {
      checkAbort();
      if (calls >= Math.min(phaseCeiling, limits.callBudget - 1)) throw new ProviderBudgetError();
      calls++;
      const value = await dependencies.indexedRpc!(method, params);
      checkAbort();
      return value;
    };
    try {
      if (BigInt(parsed(quantitySchema, await attempt("eth_chainId", []))) !== 8453n) throw new ProviderIntegrityError("The indexed-discovery RPC is not Base mainnet.");
      for (const pinned of pinnedBlocks) {
        const actual = blockReference(await attempt("eth_getBlockByNumber", [hex(BigInt(pinned.number)), false]));
        if (actual.number !== pinned.number || actual.hash !== pinned.hash || actual.timestamp !== pinned.timestamp) throw new ProviderIntegrityError("The indexed-discovery RPC disagreed with the pinned finalized range.");
      }
      indexedSourceVerified = true;
      rpcSources.add("Alchemy indexed discovery");
    } catch (error) {
      checkAbort();
      // The fixed cursor lane never switches providers or repeats an unavailable
      // handshake. A later phase may retry only a budget-denied verification.
      if (error instanceof UpstreamFailure) indexedSourceFailure = error;
      throw error;
    }
  }
  await dependencies.onProgress?.("Pinning the finalized Base block range");
  if (BigInt(parsed(quantitySchema, await request("eth_chainId", []))) !== 8453n) throw new ProviderIntegrityError("The configured RPC is not Base mainnet (chain ID 8453).");
  const to = blockReference(await request("eth_getBlockByNumber", ["finalized", false]));
  pinnedBlocks = [to];
  const toNumber = BigInt(to.number);
  const fromNumber = input.scope === "full" ? 0n : toNumber >= BigInt(input.lookbackBlocks - 1) ? toNumber - BigInt(input.lookbackBlocks - 1) : 0n;
  const from = fromNumber === toNumber ? to : blockReference(await request("eth_getBlockByNumber", [hex(fromNumber), false]));
  if (BigInt(from.number) !== fromNumber || from.timestamp > to.timestamp) throw new ProviderIntegrityError();
  pinnedBlocks = from.number === to.number ? [to] : [from, to];
  const blockCache = new Map<string, BlockReference>([[from.number, from], [to.number, to]]);
  const receiptCache = new Map<Hash, RpcReceipt>();
  const evidence = new Map<string, EvidenceRecord>();
  const seenLogicalLogs = new Map<string, Hash>();
  const seenRawLogs = new Map<string, RpcLog>();
  const pools = new Set<Address>();
  const hubs = new Set<Address>([BASE_V2_FACTORY, BASE_V2_ROUTER, BASE_V3_FACTORY, ...BASE_V3_ROUTERS]);
  let transfersStatus: InvestigationDataset["coverage"]["transfers"] = "complete";
  async function canonicalBlock(blockNumber: string, expectedHash: Hash) {
    const number = BigInt(blockNumber).toString();
    let block = blockCache.get(number);
    if (!block) { block = blockReference(await request("eth_getBlockByNumber", [hex(BigInt(number)), false])); blockCache.set(number, block); }
    if (block.number !== number || block.hash !== expectedHash || BigInt(number) < fromNumber || BigInt(number) > toNumber) throw new ProviderIntegrityError();
    return block;
  }
  async function receipt(hash: Hash) {
    const cached = receiptCache.get(hash);
    if (cached) return cached;
    const value = parsed(receiptSchema, await request("eth_getTransactionReceipt", [hash]));
    if (value.transactionHash !== hash) throw new ProviderIntegrityError();
    await canonicalBlock(value.blockNumber, value.blockHash);
    const seen = new Set<number>();
    for (const log of value.logs) {
      if (log.removed || log.blockHash !== value.blockHash || log.blockNumber !== value.blockNumber || log.transactionHash !== hash || log.transactionIndex !== value.transactionIndex || seen.has(integer(log.logIndex))) throw new ProviderIntegrityError();
      seen.add(integer(log.logIndex));
    }
    receiptCache.set(hash, value);
    return value;
  }
  async function call(address: Address, data: Hash, block = to.number) { return parsed(bytesSchema, await request("eth_call", [{ to: address, data }, hex(BigInt(block))])) as Hash; }
  const tokenCode = parsed(bytesSchema, await request("eth_getCode", [input.token, hex(toNumber)]));
  if (tokenCode === "0x") throw new TokenContractNotFoundError();
  async function metadata(name: "name" | "symbol" | "decimals" | "totalSupply") {
    try {
      const data = await call(input.token, encodeFunctionData({ abi: erc20Abi, functionName: name }));
      // A malformed denominator must never produce a reported supply percentage.
      if (name === "totalSupply" && !/^0x[0-9a-fA-F]{64}$/.test(data)) { warnings.add("ERC-20 totalSupply was not one exact uint256 ABI word; supply and supply percentages remain unknown."); return null; }
      return decodeFunctionResult({ abi: erc20Abi, functionName: name, data });
    }
    catch { checkAbort(); warnings.add("Some ERC-20 metadata is unavailable; missing fields remain unknown."); return null; }
  }
  const name = await metadata("name"); const symbol = await metadata("symbol"); const decimals = await metadata("decimals"); const supply = await metadata("totalSupply");
  function textMetadata(value: unknown, field: "name" | "symbol", limit: number): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
      warnings.add(`ERC-20 ${field} metadata is invalid or unsupported; it remains unknown.`);
      return null;
    }
    return value;
  }
  const tokenName = textMetadata(name, "name", 255);
  const tokenSymbol = textMetadata(symbol, "symbol", 64);
  await dependencies.onProgress?.(input.scope === "full" ? "Crawling Base token history from block 0 to the finalized head" : "Collecting and verifying token transfers");
  // Transfer receipt expansion must leave capacity for the funding investigation.
  // This is a request allocation, never a ceiling on eligible wallet count.
  phaseCeiling = calls + Math.floor(Math.max(0, limits.callBudget - calls - 1) / 3);
  const completedTransferRanges: { fromBlock: string; toBlock: string }[] = [];
  let retainedLogs = 0;
  function retainReceiptTransfers(txReceipt: RpcReceipt, block: BlockReference, responseIdentities: ReadonlyMap<string, RpcLog> | null): boolean {
    checkAbort();
    let complete = true;
    // A receipt contains every token log for the retrieved transaction. With
    // raw-log discovery, omissions are detectable without another RPC read.
    const receiptTransfers = txReceipt.logs.filter((item) => item.address === input.token && item.topics[0] === TRANSFER_TOPIC)
      .sort((left, right) => integer(left.logIndex) - integer(right.logIndex));
    for (const item of receiptTransfers) {
      const itemLogicalId = `${item.transactionHash}:${integer(item.logIndex)}`;
      const discovered = responseIdentities?.get(itemLogicalId);
      if (discovered && !sameLog(discovered, item)) throw new ProviderIntegrityError("Token-log discovery disagreed with a matching receipt log.");
      const record = transfer(item, block.timestamp, observedAt);
      if (!record) { complete = false; warnings.add("Nonstandard Transfer event shapes were excluded from ERC-20 flow reconstruction."); continue; }
      if (responseIdentities && !discovered) {
        complete = false;
        warnings.add("Token-log discovery omitted ERC-20 transfers present in verified receipts. Receipt-backed sibling transfers are retained within the record limit, but other missing transactions cannot be ruled out; transfer coverage remains partial.");
        record.provenance.method = "eth_getTransactionReceipt (transfer omitted by eth_getLogs)";
      } else if (!responseIdentities) {
        record.provenance.provider = "Alchemy + Base RPC";
        record.provenance.method = "alchemy_getAssetTransfers identities + eth_getTransactionReceipt";
      }
      const previousHash = seenLogicalLogs.get(itemLogicalId);
      if (previousHash && previousHash !== item.blockHash) throw new ProviderIntegrityError();
      const original = seenRawLogs.get(record.id);
      if (original) {
        if (!sameLog(original, item)) throw new ProviderIntegrityError("Duplicate receipt-backed token logs disagreed on their contents.");
        continue;
      }
      if (retainedLogs >= limits.maxTransferLogs) {
        complete = false;
        warnings.add("The token-transfer record limit was reached; transfer history is partial.");
        continue;
      }
      seenLogicalLogs.set(itemLogicalId, item.blockHash);
      evidence.set(record.id, record); seenRawLogs.set(record.id, item); retainedLogs++;
    }
    if (!complete) transfersStatus = "partial";
    return complete;
  }
  if (dependencies.transferPage) {
    warnings.add("Alchemy supplies indexed token-transfer transaction discovery. Successful canonical receipts establish retained logs and exact amounts. Exhausted indexed pagination describes this provider query, not independent proof that no historical transaction was omitted.");
    const seenCursors = new Set<string>();
    const seenTransactions = new Map<Hash, string>();
    let pageCursor: string | null = null;
    let previousBlock = fromNumber;
    for (let pageNumber = 0; ; pageNumber++) {
      checkAbort();
      if (pageNumber >= 100) { transfersStatus = "partial"; warnings.add("The indexed token-transfer page limit was reached; remaining history is unknown."); break; }
      if (pageNumber % 10 === 0) await dependencies.onProgress?.(`Base token crawl: indexed page ${pageNumber + 1}; ${retainedLogs} verified token transfers`);
      try {
        await verifyIndexedSource();
        if (calls >= phaseCeiling) throw new ProviderBudgetError();
        calls++;
        const page: TokenTransferPage = parsed(tokenTransferPageSchema, await dependencies.transferPage({ token: input.token, fromBlock: from.number, toBlock: to.number, cursor: pageCursor }));
        checkAbort();
        // Validate the complete page before publishing any of its observations.
        for (const item of page.items) {
          const number = BigInt(item.blockNumber);
          if (number < fromNumber || number > toNumber || number < previousBlock) throw new ProviderIntegrityError("Indexed token-transfer candidates disagreed with the pinned range or ascending ordering.");
          const prior = seenTransactions.get(item.hash);
          if (prior !== undefined && prior !== item.blockNumber) throw new ProviderIntegrityError("Indexed token-transfer candidates disagreed on transaction inclusion.");
          previousBlock = number;
          seenTransactions.set(item.hash, item.blockNumber);
        }
        for (const item of page.items) {
          const txReceipt = await receipt(item.hash);
          if (txReceipt.status !== "0x1" || BigInt(txReceipt.blockNumber).toString() !== item.blockNumber) throw new ProviderIntegrityError("An indexed token-transfer transaction lacked a successful receipt at its declared block.");
          const block = await canonicalBlock(txReceipt.blockNumber, txReceipt.blockHash);
          if (!txReceipt.logs.some((log) => log.address === input.token && transfer(log, block.timestamp, observedAt))) throw new ProviderIntegrityError("An indexed token-transfer transaction contained no matching canonical ERC-20 transfer.");
          if (!retainReceiptTransfers(txReceipt, block, null)) transfersStatus = "partial";
          if (transfersStatus === "partial" && retainedLogs >= limits.maxTransferLogs) break;
        }
        if (transfersStatus === "partial" && retainedLogs >= limits.maxTransferLogs) break;
        if (page.nextCursor === null) {
          if (transfersStatus === "complete") completedTransferRanges.push({ fromBlock: from.number, toBlock: to.number });
          break;
        }
        if (retainedLogs >= limits.maxTransferLogs) { transfersStatus = "partial"; warnings.add("The token-transfer record limit was reached before indexed pagination exhausted; remaining history is unknown."); break; }
        if (seenCursors.has(page.nextCursor)) { transfersStatus = "partial"; warnings.add("Indexed token-transfer pagination repeated a cursor; the verified observations are retained and remaining history is unknown."); break; }
        seenCursors.add(page.nextCursor);
        pageCursor = page.nextCursor;
      } catch (error) {
        checkAbort();
        if (error instanceof ProviderIntegrityError || (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError))) throw error;
        transfersStatus = "partial";
        warnings.add(error instanceof ProviderBudgetError ? "The indexed transfer-verification call allocation ended to preserve funding capacity; remaining history is unknown." : "An indexed token-transfer page or receipt was unavailable; verified observations are retained and remaining history is unknown.");
        break;
      }
    }
  } else {
  let cursor = fromNumber;
  let chunk = BigInt(limits.logChunkSize);
  // Some public log endpoints permit recent history while refusing an older
  // chunk. One bounded change of traversal retains permitted newer evidence;
  // it neither retries the refused range nor promotes the missing history.
  let reverseCursor: bigint | null = null;
  let reverseFloor = fromNumber;
  let queriedRanges = 0;
  while (reverseCursor !== null ? reverseCursor >= reverseFloor : cursor <= toNumber) {
    checkAbort();
    const end: bigint = reverseCursor ?? (cursor + chunk - 1n < toNumber ? cursor + chunk - 1n : toNumber);
    const start: bigint = reverseCursor === null ? cursor : end - chunk + 1n > reverseFloor ? end - chunk + 1n : reverseFloor;
    if (queriedRanges % 10 === 0) await dependencies.onProgress?.(`Base token crawl: checking blocks ${start}-${end}; ${retainedLogs} verified token transfers`);
    queriedRanges++;
    let logQueryCompleted = false;
    try {
      const raw = await requestTransferLogs([{ address: input.token, fromBlock: hex(start), toBlock: hex(end), topics: [TRANSFER_TOPIC] }]);
      logQueryCompleted = true;
      // Transport bounds bytes first. Validate event shapes before interpreting a
      // valid oversized array as a range limit, so malformed evidence still fails.
      const logs = parsed(z.array(logSchema), raw);
      const responseIdentities = new Map<string, RpcLog>();
      for (const log of logs) {
        if (log.address !== input.token || log.removed || BigInt(log.blockNumber) < start || BigInt(log.blockNumber) > end || log.topics[0] !== TRANSFER_TOPIC) throw new ProviderIntegrityError();
        const logicalId = `${log.transactionHash}:${integer(log.logIndex)}`;
        const prior = responseIdentities.get(logicalId);
        if ((prior && !sameLog(prior, log)) || (seenLogicalLogs.has(logicalId) && seenLogicalLogs.get(logicalId) !== log.blockHash)) throw new ProviderIntegrityError("Duplicate provider logs disagreed on their contents or inclusion.");
        responseIdentities.set(logicalId, log);
      }
      if (logs.length > 2000) throw new ProviderLogRangeError();
      logs.sort((a, b) => integer(a.blockNumber) - integer(b.blockNumber) || integer(a.transactionIndex) - integer(b.transactionIndex) || integer(a.logIndex) - integer(b.logIndex));
      let rangeComplete = true;
      for (const log of logs) {
        if (log.address !== input.token || log.removed || BigInt(log.blockNumber) < start || BigInt(log.blockNumber) > end || log.topics[0] !== TRANSFER_TOPIC) throw new ProviderIntegrityError();
        const logicalId = `${log.transactionHash}:${integer(log.logIndex)}`;
        const previousHash = seenLogicalLogs.get(logicalId);
        if (previousHash && previousHash !== log.blockHash) throw new ProviderIntegrityError();
        if (evidence.has(evidenceId(log))) {
          const original = seenRawLogs.get(evidenceId(log));
          if (!original || !sameLog(original, log)) throw new ProviderIntegrityError("Duplicate provider logs disagreed on their contents.");
          continue;
        }
        if (retainedLogs >= limits.maxTransferLogs) { transfersStatus = "partial"; warnings.add("The token-transfer record limit was reached; transfer history is partial."); break; }
        const txReceipt = await receipt(log.transactionHash);
        if (txReceipt.status !== "0x1" || !txReceipt.logs.some((item) => sameLog(log, item))) throw new ProviderIntegrityError("A token log was not present in a successful matching receipt.");
        const block = await canonicalBlock(log.blockNumber, log.blockHash);
        rangeComplete = retainReceiptTransfers(txReceipt, block, responseIdentities) && rangeComplete;
      }
      if (transfersStatus === "partial" && retainedLogs >= limits.maxTransferLogs) break;
      if (rangeComplete) completedTransferRanges.push({ fromBlock: start.toString(), toBlock: end.toString() });
      if (reverseCursor === null) cursor = end + 1n;
      else reverseCursor = start - 1n;
    } catch (error) {
      checkAbort();
      if (error instanceof ProviderIntegrityError) throw error;
      if (error instanceof ProviderLogRangeError && chunk > 10n) { chunk = chunk / 2n < 10n ? 10n : chunk / 2n; continue; }
      transfersStatus = "partial";
      if (dependencies.logRpc && !logQueryCompleted && logSourceVerified && reverseCursor === null && error instanceof UpstreamFailure && error.httpStatus === 403 && !(error instanceof ProviderLogRangeError) && end < toNumber) {
        warnings.add(`The log RPC refused token-transfer blocks ${start}–${end}. Remaining recent ranges are checked from newest backward within the existing allocation; the refused and any unretrieved history remain unknown.`);
        reverseCursor = toNumber;
        reverseFloor = end + 1n;
        continue;
      }
      warnings.add(error instanceof ProviderBudgetError ? "The transfer-verification call allocation ended to preserve funding capacity; transfer history is partial." : error instanceof ProviderLogRangeError ? "A token-transfer response exceeded the bounded log limit; transfer history is partial." : "A token-transfer range could not be retrieved; transfer history is partial.");
      break;
    }
  }
  }
  const poolCache = new Map<Address, { token0: Address; token1: Address; factory: Address; protocol: "uniswap-v2" | "uniswap-v3"; feePips: number } | null>();
  const poolAttempts = new Set<Address>();
  async function authenticatePool(address: Address, block: string) {
    if (poolCache.has(address)) return poolCache.get(address) ?? null;
    if (rpcThrottle || calls >= phaseCeiling) return null;
    if (poolAttempts.has(address)) return null;
    if (poolAttempts.size >= 50) { warnings.add("The pool verification limit was reached; additional swap activity remains unclassified and unknown pool addresses may remain in observed relationships."); return null; }
    poolAttempts.add(address);
    try {
      const read = async (functionName: "factory" | "token0" | "token1" | "fee") => decodeFunctionResult({ abi: poolAbi, functionName, data: await call(address, encodeFunctionData({ abi: poolAbi, functionName }), block) });
      const factory = parsed(addressSchema, await read("factory"));
      if (factory !== BASE_V3_FACTORY && factory !== BASE_V2_FACTORY) { poolCache.set(address, null); return null; }
      const token0 = parsed(addressSchema, await read("token0")); const token1 = parsed(addressSchema, await read("token1"));
      if (token0 === token1 || ![token0, token1].includes(input.token)) { poolCache.set(address, null); return null; }
      let actual: Address;
      let feePips = 3000;
      if (factory === BASE_V2_FACTORY) actual = parsed(addressSchema, decodeFunctionResult({ abi: poolAbi, functionName: "getPair", data: await call(factory, encodeFunctionData({ abi: poolAbi, functionName: "getPair", args: [token0, token1] }), block) }));
      else {
        const fee = Number(await read("fee"));
        if (!Number.isInteger(fee) || fee < 0 || fee >= 1_000_000) { poolCache.set(address, null); return null; }
        feePips = fee;
        actual = parsed(addressSchema, decodeFunctionResult({ abi: poolAbi, functionName: "getPool", data: await call(factory, encodeFunctionData({ abi: poolAbi, functionName: "getPool", args: [token0, token1, fee] }), block) }));
      }
      if (actual !== address) { poolCache.set(address, null); return null; }
      const result = { token0, token1, factory, feePips, protocol: factory === BASE_V2_FACTORY ? "uniswap-v2" as const : "uniswap-v3" as const }; poolCache.set(address, result); pools.add(address); hubs.add(address); return result;
    } catch (error) { checkAbort(); if (error instanceof ProviderIntegrityError) throw error; warnings.add("Some pool contracts could not be authenticated; their activity remains unclassified and unknown pool addresses may remain in observed relationships."); return null; }
  }
  const transferReceipts = [...receiptCache.values()];
  // Authenticate infrastructure before selecting wallets for funding. Otherwise
  // every buyer can be falsely connected through an ordinary-looking pool.
  const infrastructureRemaining = Math.max(0, limits.callBudget - calls - 1);
  phaseCeiling = calls + Math.min(infrastructureRemaining, Math.max(5, Math.min(30, Math.floor(infrastructureRemaining / 8))));
  const selectedPairs = dependencies.poolCandidates ? parsed(z.array(addressSchema).max(1), await dependencies.poolCandidates()) : [];
  for (const address of selectedPairs) if (address !== ZERO) await authenticatePool(address, to.number);
  for (const txReceipt of transferReceipts) {
    for (const log of txReceipt.logs.filter((log) => [SWAP_TOPIC, V2_SWAP_TOPIC, V2_MINT_TOPIC].includes(log.topics[0]))) {
      if (calls >= phaseCeiling) break;
      await authenticatePool(log.address, BigInt(txReceipt.blockNumber).toString());
    }
  }
  let liquiditySnapshot: InvestigationDataset["liquiditySnapshot"];
  for (const address of selectedPairs) {
    const pool = poolCache.get(address);
    if (!pool || pool.protocol !== "uniswap-v2" || calls >= phaseCeiling) continue;
    try {
      const [reserve0, reserve1] = decodeFunctionResult({ abi: poolAbi, functionName: "getReserves", data: await call(address, encodeFunctionData({ abi: poolAbi, functionName: "getReserves" }), to.number) });
      if (reserve0 > 0n && reserve1 > 0n) liquiditySnapshot = { protocol: "uniswap-v2", pool: address, factory: pool.factory, token0: pool.token0, token1: pool.token1, reserve0Raw: reserve0.toString(), reserve1Raw: reserve1.toString(), block: to, provenance: { provider: "Base RPC", method: "authenticated V2 factory getPair + pinned getReserves", observedAt } };
    } catch (error) { checkAbort(); if (error instanceof ProviderIntegrityError) throw error; warnings.add("Pinned selected-pool reserves could not be verified; price impact remains unknown."); }
  }
  // A mint recipient is not a creator. Only a retained direct-deployment
  // receipt naming this token can justify one optional canonical sender read.
  // Keep it after pool authentication in the existing infrastructure allocation.
  let verifiedCreation: { evidenceId: string; value: NonNullable<EvidenceRecord["creation"]> } | undefined;
  const deploymentMint = [...evidence.values()].find((record) => record.kind === "transfer" && record.assetAddress === input.token && record.from === ZERO && record.to !== ZERO && BigInt(record.amountRaw) > 0n && receiptCache.get(record.transactionHash)?.contractAddress === input.token);
  if (deploymentMint) {
    const txReceipt = receiptCache.get(deploymentMint.transactionHash)!;
    try {
      if (rpcThrottle) throw rpcThrottle;
      if (txReceipt.status !== "0x1") throw new ProviderIntegrityError("A retained deployment mint lacked a successful receipt.");
      const transaction = parsed(transactionSchema, await request("eth_getTransactionByHash", [txReceipt.transactionHash]));
      if (transaction.hash !== txReceipt.transactionHash || transaction.blockHash !== txReceipt.blockHash || transaction.blockNumber !== txReceipt.blockNumber || transaction.transactionIndex !== txReceipt.transactionIndex) throw new ProviderIntegrityError("The deployment transaction disagreed with its canonical receipt.");
      if (transaction.to !== null) throw new ProviderIntegrityError("A contract-creation receipt contradicted its top-level transaction destination.");
      if (transaction.from !== ZERO && transaction.from !== input.token) verifiedCreation = { evidenceId: deploymentMint.id, value: { creator: transaction.from, contractAddress: input.token, transactionTo: null, receiptStatus: "0x1" } };
    } catch (error) {
      checkAbort();
      if (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError)) throw error;
      warnings.add("The retained deployment mint's transaction sender could not be verified within the optional allocation; chain creator attribution remains unknown.");
    }
  }
  const walletCode = new Map<Address, "eoa" | "contract">();
  async function pinnedWalletCode(wallet: Address) {
    if (!walletCode.has(wallet)) walletCode.set(wallet, parsed(bytesSchema, await request("eth_getCode", [wallet, hex(toNumber)])) === "0x" ? "eoa" : "contract");
    return walletCode.get(wallet)!;
  }
  async function collectSales() {
  // A later wallet's first token receipt should not lose its trade proof to
  // repeated early trades by an already-examined wallet. Ordering changes no
  // evidence requirements and makes no additional network requests.
  const eligible = new Set(candidates);
  const firstReceipts = new Map<Address, EvidenceRecord>();
  for (const record of evidence.values()) {
    if (record.kind !== "transfer" || record.assetAddress !== input.token || BigInt(record.amountRaw) <= 0n || !eligible.has(record.to) || hubs.has(record.to)) continue;
    const previous = firstReceipts.get(record.to);
    if (!previous || BigInt(record.blockNumber) < BigInt(previous.blockNumber) || record.blockNumber === previous.blockNumber && (record.transactionIndex < previous.transactionIndex || record.transactionIndex === previous.transactionIndex && record.logIndex! < previous.logIndex!)) firstReceipts.set(record.to, record);
  }
  const entryTransactions = new Set([...firstReceipts.values()].map((record) => record.transactionHash));
  const priorities = new Map(transferReceipts.map((value) => {
    const lockedLp = new Map<Address, number>();
    for (const log of value.logs) {
      const marker = transfer(log, 0, observedAt);
      if (marker?.from === ZERO && marker.to === ZERO && marker.amountRaw === "1000") lockedLp.set(log.address, Math.min(lockedLp.get(log.address) ?? Infinity, integer(log.logIndex)));
    }
    const initialLiquidityCandidate = value.logs.some((log) => log.topics[0] === V2_MINT_TOPIC && (lockedLp.get(log.address) ?? Infinity) < integer(log.logIndex));
    return [value.transactionHash, initialLiquidityCandidate ? 0 : entryTransactions.has(value.transactionHash) ? 1 : 2] as const;
  }));
  const orderedReceipts = [...transferReceipts].sort((left, right) => priorities.get(left.transactionHash)! - priorities.get(right.transactionHash)! || (BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1 : integer(left.transactionIndex) - integer(right.transactionIndex)));
  for (const txReceipt of orderedReceipts) {
    checkAbort();
    if (calls >= phaseCeiling) { warnings.add("The sale-enrichment allocation ended to preserve pinned-balance and canonical verification capacity; additional selling remains unclassified."); break; }
    if (rpcThrottle) { warnings.add("RPC throttling stopped additional optional swap checks; some pool addresses may remain unauthenticated in observed relationships. Retained verified observations remain available."); break; }
    // Initial V2 liquidity is established by Mint and the first-mint locked LP
    // marker, never by a first buy or a third-party pair creation timestamp.
    for (const mint of txReceipt.logs.filter((log) => log.topics[0] === V2_MINT_TOPIC)) {
      try {
        const pool = await authenticatePool(mint.address, BigInt(txReceipt.blockNumber).toString());
        if (!pool || pool.protocol !== "uniswap-v2") continue;
        const decoded = decodeEventLog({ abi: v2MintAbi, eventName: "Mint", data: mint.data as Hash, topics: mint.topics as [Hash, ...Hash[]], strict: true });
        if (decoded.args.amount0 <= 0n || decoded.args.amount1 <= 0n) continue;
        const block = await canonicalBlock(txReceipt.blockNumber, txReceipt.blockHash);
        const flows = txReceipt.logs.map((log) => transfer(log, block.timestamp, observedAt)).filter((record): record is EvidenceRecord => Boolean(record && [pool.token0, pool.token1, mint.address].includes(record.assetAddress ?? ZERO)));
        const marker = flows.find((record) => record.assetAddress === mint.address && record.from === ZERO && record.to === ZERO && record.amountRaw === "1000" && record.logIndex! < integer(mint.logIndex));
        if (!marker || netFlow(flows, mint.address, pool.token0) !== decoded.args.amount0 || netFlow(flows, mint.address, pool.token1) !== decoded.args.amount1) continue;
        const deposit = flows.find((record) => record.assetAddress === input.token && record.to === mint.address && BigInt(record.amountRaw) > 0n);
        if (!deposit || evidence.size + flows.filter((record) => !evidence.has(record.id)).length > 4000) continue;
        for (const record of flows) evidence.set(record.id, record);
        evidence.set(deposit.id, { ...deposit, liquidity: { pool: mint.address, factory: pool.factory, protocol: "uniswap-v2", mintLogIndex: integer(mint.logIndex), initial: true, supportingEvidenceIds: flows.map((record) => record.id).sort() } });
      } catch (error) { checkAbort(); if (error instanceof ProviderIntegrityError) throw error; warnings.add("Some initial-liquidity receipts could not be verified; launch timing remains unknown for those pools."); }
    }
    const swapLogs = txReceipt.logs.filter((log) => [SWAP_TOPIC, V2_SWAP_TOPIC].includes(log.topics[0]));
    if (!swapLogs.length) continue;
    // Pool identity is separate from sale support. Multi-pool and unsupported
    // routes must not turn authenticated liquidity pools into ordinary wallets.
    for (const log of swapLogs) await authenticatePool(log.address, BigInt(txReceipt.blockNumber).toString());
    if (swapLogs.length !== 1) { warnings.add("Transactions with multiple or mixed-protocol swap events remain unclassified."); continue; }
    const swapLog = swapLogs[0];
    try {
      const pool = await authenticatePool(swapLog.address, BigInt(txReceipt.blockNumber).toString());
      if (!pool) continue;
      let amount0: bigint, amount1: bigint;
      if (pool.protocol === "uniswap-v2" && swapLog.topics[0] === V2_SWAP_TOPIC) {
        const decoded = decodeEventLog({ abi: v2SwapAbi, eventName: "Swap", data: swapLog.data as Hash, topics: swapLog.topics as [Hash, ...Hash[]], strict: true });
        if ((decoded.args.amount0In > 0n && decoded.args.amount0Out > 0n) || (decoded.args.amount1In > 0n && decoded.args.amount1Out > 0n)) continue;
        amount0 = decoded.args.amount0In - decoded.args.amount0Out; amount1 = decoded.args.amount1In - decoded.args.amount1Out;
      } else if (pool.protocol === "uniswap-v3" && swapLog.topics[0] === SWAP_TOPIC) {
        const decoded = decodeEventLog({ abi: swapAbi, eventName: "Swap", data: swapLog.data as Hash, topics: swapLog.topics as [Hash, ...Hash[]], strict: true });
        amount0 = decoded.args.amount0; amount1 = decoded.args.amount1;
      } else continue;
      const tokenDelta = pool.token0 === input.token ? amount0 : amount1;
      const quoteDelta = pool.token0 === input.token ? amount1 : amount0;
      const buying = tokenDelta < 0n && quoteDelta > 0n;
      if (!buying && !(tokenDelta > 0n && quoteDelta < 0n)) continue;
      const transaction = parsed(transactionSchema, await request("eth_getTransactionByHash", [txReceipt.transactionHash]));
      if (transaction.hash !== txReceipt.transactionHash || transaction.blockHash !== txReceipt.blockHash || transaction.blockNumber !== txReceipt.blockNumber || transaction.transactionIndex !== txReceipt.transactionIndex) throw new ProviderIntegrityError();
      if (transaction.to !== swapLog.address && !(pool.protocol === "uniswap-v2" ? transaction.to === BASE_V2_ROUTER : BASE_V3_ROUTERS.includes(transaction.to ?? ZERO))) continue;
      if (parsed(bytesSchema, await request("eth_getCode", [transaction.from, transaction.blockNumber])) !== "0x") continue;
      const quote = pool.token0 === input.token ? pool.token1 : pool.token0;
      const block = await canonicalBlock(txReceipt.blockNumber, txReceipt.blockHash);
      const flows = txReceipt.logs.map((log) => transfer(log, block.timestamp, observedAt)).filter((record): record is EvidenceRecord => Boolean(record && [input.token, quote].includes(record.assetAddress ?? ZERO)));
      if (netFlow(flows, transaction.from, input.token) !== -tokenDelta || netFlow(flows, swapLog.address, input.token) !== tokenDelta || netFlow(flows, swapLog.address, quote) !== quoteDelta) continue;
      const wrappedNativeBuy = buying && pool.protocol === "uniswap-v2" && quote === BASE_WETH && transaction.to === BASE_V2_ROUTER && BigInt(transaction.value) === quoteDelta
        && netFlow(flows, transaction.from, quote) === 0n && directFlow(flows, BASE_V2_ROUTER, swapLog.address, quote) === quoteDelta
        && txReceipt.logs.some((log) => log.address === BASE_WETH && log.topics.length === 2 && log.topics[0] === DEPOSIT_TOPIC && log.topics[1] === `0x${BASE_V2_ROUTER.slice(2).padStart(64, "0")}` && /^0x[0-9a-fA-F]{64}$/.test(log.data) && BigInt(log.data) === quoteDelta);
      if (!wrappedNativeBuy && netFlow(flows, transaction.from, quote) !== -quoteDelta) continue;
      // Net deltas alone can be counterfeited by unrelated gifts in the same receipt.
      // The first adapter deliberately accepts only explicit direct consideration paths.
      if (buying ? directFlow(flows, swapLog.address, transaction.from, input.token) !== -tokenDelta || (!wrappedNativeBuy && directFlow(flows, transaction.from, swapLog.address, quote) !== quoteDelta)
        : directFlow(flows, transaction.from, swapLog.address, input.token) !== tokenDelta || directFlow(flows, swapLog.address, transaction.from, quote) !== -quoteDelta) continue;
      if (buying && flows.filter((record) => record.assetAddress === input.token && record.from === swapLog.address && record.to === transaction.from && BigInt(record.amountRaw) > 0n).length !== 1) continue;
      if (evidence.size + flows.filter((record) => !evidence.has(record.id)).length + 1 > 4000) { warnings.add("The total supporting-evidence limit was reached; additional swaps remain unclassified."); continue; }
      for (const record of flows) evidence.set(record.id, record);
      const supportingEvidenceIds = flows.map((record) => record.id).sort();
      if (buying) {
        const received = flows.find((record) => record.assetAddress === input.token && record.from === swapLog.address && record.to === transaction.from && BigInt(record.amountRaw) > 0n)!;
        evidence.set(received.id, { ...received, purchase: { pool: swapLog.address, factory: pool.factory, protocol: pool.protocol, quoteAsset: quote, quoteAmountRaw: quoteDelta.toString(), swapLogIndex: integer(swapLog.logIndex), supportingEvidenceIds, ...(wrappedNativeBuy ? { nativeInputRaw: BigInt(transaction.value).toString() } : {}) } });
        continue;
      }
      const id = `8453:${swapLog.blockHash}:${swapLog.transactionHash}:sale:${integer(swapLog.logIndex)}`;
      evidence.set(id, { id, kind: "sale", chainId: 8453, blockNumber: BigInt(swapLog.blockNumber).toString(), blockHash: swapLog.blockHash, transactionHash: swapLog.transactionHash, transactionIndex: integer(swapLog.transactionIndex), logIndex: integer(swapLog.logIndex), traceId: null, timestamp: block.timestamp, from: transaction.from, to: swapLog.address, assetAddress: input.token, amountRaw: tokenDelta.toString(), provenance: { provider: "Base RPC", method: "eth_getTransactionReceipt + eth_call + reconciled ERC-20 flows", observedAt }, sale: { pool: swapLog.address, factory: pool.factory, protocol: pool.protocol, quoteAsset: quote, quoteAmountRaw: (-quoteDelta).toString(), swapLogIndex: integer(swapLog.logIndex), supportingEvidenceIds } });
    } catch (error) { checkAbort(); if (error instanceof ProviderIntegrityError) throw error; warnings.add("Some swap checks could not be completed; those transactions remain unclassified."); }
  }
  }
  const observedWallets = [...new Set([...evidence.values()].filter((record) => record.kind === "transfer" && record.assetAddress === input.token).flatMap((record) => [record.from, record.to]).concat(verifiedCreation ? [verifiedCreation.value.creator] : []))].filter((wallet) => wallet !== ZERO).sort();
  let externalWallets: Address[] = [];
  if (dependencies.candidateAddresses) {
    const leads = parsed(z.array(addressSchema).max(512), await dependencies.candidateAddresses());
    checkAbort();
    externalWallets = [...new Set(leads)].filter((lead) => lead !== ZERO && !observedWallets.includes(lead)).sort();
    if (leads.length) warnings.add("External provider addresses are discovery leads only. Their balances and account types require pinned RPC checks; source labels and relationships do not establish ownership or complete holder coverage.");
  }
  let holderSnapshot: InvestigationDataset["holderSnapshot"];
  let holderDiscovery: HolderDiscoveryResult | undefined;
  let holderOptions: HolderCollectionOptions | undefined;
  if (dependencies.holderPage) {
    await dependencies.onProgress?.("Discovering holder candidates before tracing wallet funding");
    const snapshotCeiling = calls + Math.floor(Math.max(0, limits.callBudget - calls - 1) / 3);
    phaseCeiling = snapshotCeiling;
    holderOptions = {
      token: input.token, totalSupplyRaw: typeof supply === "bigint" ? supply.toString() : null, block: to, observedWallets, externalWallets, observedAt,
      sourceUrl: dependencies.holderSourceUrl?.(input.token),
      provider: dependencies.holderProvider,
      indexIndependentOfRpc: dependencies.holderIndexIndependentOfRpc,
      throttleError: () => rpcThrottle,
      signal: dependencies.signal, remainingCalls: () => Math.max(0, snapshotCeiling - calls),
      request: (method, params) => request(method, params, false, snapshotCeiling),
      page: async (next) => {
        checkAbort(); if (calls >= snapshotCeiling) throw new ProviderBudgetError(); calls++;
        return dependencies.holderPage!(input.token, next);
      },
    };
    holderDiscovery = await discoverHolderCandidates(holderOptions);
    holderSnapshot = holderDiscovery.snapshot;
    warnings.add("Latest indexed holder pages add eligible candidates before funding. Balance reads are deferred until funding and sale verification have received their allocations; discovery is not a finalized holder census.");
  }
  await dependencies.onProgress?.("Tracing observed native funding within the pinned window");
  phaseCeiling = calls + Math.floor(Math.max(0, limits.callBudget - calls - 1) * 3 / 4);
  // A throttle on the last transfer-allocation call cannot fit recovery there.
  // Make one explicit attempt using the new funding allocation, never a
  // same-source probe or a borrowed canonical reserve. A funding read must fit
  // after the entire chain/pinned-header handshake before changing endpoints.
  if (rpcThrottle && phaseCeiling - calls >= pinnedBlocks.length + 2 && dependencies.recoverRpc?.()) {
    rpcNeedsVerification = true;
    await backoff(1000);
    try {
      await verifyRecoveredSource(phaseCeiling);
      rpcThrottle = null;
      warnings.add("The funding phase recovered a transfer-phase RPC throttle through one configured fallback verification; transfer history remains partial.");
    } catch (error) {
      checkAbort();
      if (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError)) throw error;
      warnings.add("The funding-phase fallback verification could not complete; the RPC throttle remains active and optional acquisition stays incomplete.");
    }
  }
  // Source addresses influence examination order only; their identity, holdings
  // and funding still require the same pinned reads and canonical proofs.
  const priorityCandidates = new Set(holderSnapshot?.holders.filter((item) => item.discoveredBy !== "observed").map((item) => item.address) ?? []);
  const candidatePriority = (wallet: Address) => wallet === verifiedCreation?.value.creator ? 0 : priorityCandidates.has(wallet) ? 1 : 2;
  const candidates = [...new Set([...observedWallets, ...externalWallets, ...(holderSnapshot?.holders.map((item) => item.address) ?? [])])].filter((wallet) => wallet !== ZERO && !hubs.has(wallet))
    .sort((left, right) => candidatePriority(left) - candidatePriority(right) || left.localeCompare(right));
  const walletActivitySnapshot: NonNullable<InvestigationDataset["walletActivitySnapshot"]> = { block: to, rows: [] };
  // Keep the cheap pinned classification ahead of variable funding pagination.
  // Its fixed allocation still leaves the majority for evidence acquisition.
  const activityRemaining = Math.max(0, limits.callBudget - calls - 1);
  const pendingBalances = holderDiscovery?.snapshot.holders.length ?? 0;
  const pendingTradeReads = Math.min(40, 2 * transferReceipts.filter((receipt) => receipt.logs.some((log) => [SWAP_TOPIC, V2_SWAP_TOPIC].includes(log.topics[0]))).length);
  const denseCandidateCohort = pendingBalances > activityRemaining;
  // Reserving one balance read for every discovered address can exceed the
  // entire budget after a distribution and starve both of the preceding phases.
  // Preserve bounded shares for classification and funding in that case; every
  // unreached address remains eligible and explicitly unexamined.
  const activityAllocation = denseCandidateCohort ? Math.floor(activityRemaining / 8)
    : Math.max(0, activityRemaining - Math.floor(activityRemaining * 3 / 4) - pendingBalances - pendingTradeReads);
  phaseCeiling = calls + Math.min(50, activityAllocation);
  for (const wallet of candidates.slice(0, 2000)) {
    let code: "eoa" | "contract" | "unavailable" = walletCode.get(wallet) ?? "unavailable";
    let outgoingTransactionCountRaw: string | null = null;
    if (!rpcThrottle && calls < phaseCeiling) {
      try {
        code = await pinnedWalletCode(wallet);
        if (code === "eoa") outgoingTransactionCountRaw = BigInt(parsed(quantitySchema, await request("eth_getTransactionCount", [wallet, hex(toNumber)]))).toString();
      } catch (error) { checkAbort(); if (error instanceof ProviderIntegrityError) throw error; }
    }
    walletActivitySnapshot.rows.push({ address: wallet, outgoingTransactionCountRaw, code });
  }
  const fundingRemaining = Math.max(0, limits.callBudget - calls - 1);
  phaseCeiling = calls + (denseCandidateCohort ? Math.min(50, Math.floor(fundingRemaining / 8))
    : Math.max(0, Math.min(Math.floor(fundingRemaining * 3 / 4), fundingRemaining - pendingBalances - pendingTradeReads)));
  if (denseCandidateCohort) warnings.add("The discovered address cohort exceeds the remaining call budget. Separate bounded allocations preserve wallet classification, funding, balances and the final canonical check; unreached addresses remain unexamined.");
  const funding: WalletFundingCoverage[] = [];
  let creatorFunding: InvestigationDataset["coverage"]["creatorFunding"];
  // A creator with a short outbound history can establish this narrow source
  // query before busy recipient histories consume the funding allocation.
  // All query/proof reads share the existing phase ceiling and final reserve.
  if (input.scope === "full" && verifiedCreation && dependencies.creatorFundingHistory && dependencies.fundingIndexSource === "alchemy") {
    const creator = verifiedCreation.value.creator;
    const result = await collectCreatorFunding({ creator, cohort: candidates.filter((wallet) => wallet !== creator && walletCode.get(wallet) === "eoa"), from, to, observedAt, maxEvidence: Math.max(0, 4000 - evidence.size), request, receipt, canonicalBlock, signal: dependencies.signal,
      query: async (cursor) => {
        checkAbort();
        if (rpcThrottle) throw rpcThrottle;
        await verifyIndexedSource();
        if (calls >= phaseCeiling) throw new ProviderBudgetError();
        calls++;
        return dependencies.creatorFundingHistory!(creator, cursor, { fromBlock: from.number, toBlock: to.number });
      },
    });
    creatorFunding = result.coverage;
    for (const record of result.evidence) evidence.set(record.id, record);
    warnings.add(result.coverage.reason);
  }
  let examinedWallets = 0;
  let useNativeFallback = !dependencies.fundingHistory && !dependencies.sqdFundingPage;
  if (dependencies.sqdFundingPage) {
    const indexed = await collectSqdFundingWindow({ wallets: candidates, from, to, observedAt, request, canonicalBlock, signal: dependencies.signal, throttleError: () => rpcThrottle,
      queryPage: async (query) => {
        checkAbort(); if (calls >= phaseCeiling) throw new ProviderBudgetError(); calls++;
        return dependencies.sqdFundingPage!(query);
      },
    });
    funding.push(...indexed.coverage);
    for (const record of indexed.evidence) evidence.set(record.id, record);
    examinedWallets = indexed.examinedWallets;
    warnings.add("SQD public testing supplies recipient-filtered top-level transaction discovery for local evaluation. Search coverage relies on indexed results with RPC range anchors and candidate verification; it does not independently exclude indexer omissions. Production-approved access is required before hosting this source.");
    if (indexed.completedBlocks === 0 && !rpcThrottle && calls < phaseCeiling) {
      useNativeFallback = true; funding.length = 0;
      warnings.add("SQD funding discovery completed no verified block; the bounded native RPC prefix is used as an availability fallback.");
    }
  }
  if (useNativeFallback) {
    const native = await collectNativeFundingPrefix({ wallets: candidates, from, to, maxBlocks: limits.nativeFundingMaxBlocks, observedAt, request, canonicalBlock, signal: dependencies.signal, throttleError: () => rpcThrottle });
    funding.push(...native.coverage);
    for (const record of native.evidence) evidence.set(record.id, record);
    examinedWallets = native.examinedWallets;
    warnings.add(`Keyless native funding examines a bounded oldest prefix of at most ${limits.nativeFundingMaxBlocks} full blocks; internal transfers and lifetime-first funding are not examined.`);
  }
  if (dependencies.fundingHistory && !dependencies.sqdFundingPage) {
  const verifiedIndexedTransactions = new Map<Hash, string>();
  let fundingBudgetExhausted = false;
  let fundingThrottled = false;
  for (const wallet of candidates) {
    checkAbort();
    const coverage: WalletFundingCoverage = { wallet, status: "not_examined", fromBlock: from.number, toBlock: to.number, internalTransfers: "not_examined", reason: null };
    funding.push(coverage);
    if (rpcThrottle || fundingThrottled) { coverage.reason = "Provider throttling stopped additional funding requests before this wallet was examined."; continue; }
    if (fundingBudgetExhausted || calls >= phaseCeiling) { coverage.reason = "Funding call allocation ended before this wallet's examination began; remaining calls preserve sale, balance and canonical checks."; continue; }
    try {
      if (dependencies.fundingIndexSource === "alchemy") await verifyIndexedSource();
      if (await pinnedWalletCode(wallet) !== "eoa") { coverage.reason = "Contract or delegated-wallet native funding is outside this adapter's scope."; continue; }
      coverage.status = "unavailable";
      let next: Record<string, string | number> | null = null;
      const cursors = new Set<string>();
      let oldest: bigint | null = null;
      let verifiedLowerBound: bigint | null = null;
      let counted = false;
      for (let pageNumber = 0; pageNumber < limits.fundingMaxPages; pageNumber++) {
        checkAbort();
        if (rpcThrottle) throw rpcThrottle;
        if (calls >= phaseCeiling) throw new ProviderBudgetError();
        calls++;
        const page: FundingHistoryPage = parsed(fundingPageSchema, await dependencies.fundingHistory(wallet, next, { fromBlock: from.number, toBlock: to.number }));
        checkAbort();
        const staged = new Map<string, EvidenceRecord>();
        const stagedTransactions = new Map<Hash, string>();
        let pageOldest: bigint | null = oldest;
        let pageLowerBound: bigint | null = null;
        let crossedStart = false;
        for (const item of page.items) {
          if (rpcThrottle) throw rpcThrottle;
          const number = BigInt(item.blockNumber);
          if (pageOldest !== null && number > pageOldest) throw new ProviderIntegrityError("Indexed funding history was not ordered newest to oldest.");
          pageOldest = number;
          if (number < fromNumber) { crossedStart = true; continue; }
          if (number > toNumber) continue;
          if (pageLowerBound === null || number < pageLowerBound) pageLowerBound = number;
          const transaction = parsed(transactionSchema, await request("eth_getTransactionByHash", [item.hash]));
          if (BigInt(transaction.value) >= 2n ** 256n) throw new ProviderIntegrityError("Indexed native funding amount exceeded uint256.");
          if (transaction.hash !== item.hash || BigInt(transaction.blockNumber) !== number) throw new ProviderIntegrityError("Funding indexer and RPC transaction inclusion disagreed.");
          const transactionKey = `${transaction.blockHash}:${BigInt(transaction.blockNumber)}:${BigInt(transaction.transactionIndex)}:${transaction.from}:${transaction.to ?? ""}:${BigInt(transaction.value)}`;
          const previous = stagedTransactions.get(item.hash) ?? verifiedIndexedTransactions.get(item.hash);
          if (previous !== undefined && previous !== transactionKey) throw new ProviderIntegrityError("Repeated indexed funding transaction fields disagreed.");
          const txReceipt = await receipt(item.hash);
          if (txReceipt.blockHash !== transaction.blockHash || txReceipt.blockNumber !== transaction.blockNumber || txReceipt.transactionIndex !== transaction.transactionIndex) throw new ProviderIntegrityError();
          const block = await canonicalBlock(transaction.blockNumber, transaction.blockHash);
          stagedTransactions.set(item.hash, transactionKey);
          if (transaction.to !== wallet || BigInt(transaction.value) === 0n || txReceipt.status !== "0x1") continue;
          if (parsed(bytesSchema, await request("eth_getCode", [wallet, transaction.blockNumber])) !== "0x") { warnings.add("Some historical contract/delegated-wallet funding observations were excluded; only code-empty recipient observations are supported."); continue; }
          const id = `8453:${transaction.blockHash}:${transaction.hash}:native`;
          staged.set(id, { id, kind: "funding", chainId: 8453, blockNumber: BigInt(transaction.blockNumber).toString(), blockHash: transaction.blockHash, transactionHash: transaction.hash, transactionIndex: integer(transaction.transactionIndex), logIndex: null, traceId: null, timestamp: block.timestamp, from: transaction.from, to: wallet, assetAddress: null, amountRaw: BigInt(transaction.value).toString(), provenance: { provider: dependencies.fundingIndexSource === "alchemy" ? "Alchemy + Base RPC" : "Blockscout PRO + Base RPC", method: "address transactions discovery + RPC transaction/receipt verification", observedAt }, sale: null });
        }
        checkAbort();
        // A failed page must not extend bounds or leak its earlier verified items.
        // Prior complete pages remain useful partial evidence.
        for (const [id, record] of staged) evidence.set(id, record);
        for (const [hash, key] of stagedTransactions) verifiedIndexedTransactions.set(hash, key);
        oldest = pageOldest;
        const complete = crossedStart || page.nextCursor === null;
        if (pageLowerBound !== null && (verifiedLowerBound === null || pageLowerBound < verifiedLowerBound)) verifiedLowerBound = pageLowerBound;
        if (complete || verifiedLowerBound !== null) {
          if (!counted) { examinedWallets++; counted = true; }
          coverage.status = complete ? "complete" : "partial";
          coverage.fromBlock = complete ? from.number : verifiedLowerBound!.toString();
        }
        if (complete) { coverage.reason = `Declared-window indexed top-level inbound transactions examined; internal transfers and lifetime-first funding are not examined.${dependencies.fundingIndexSource === "alchemy" ? " Exhausted Alchemy pagination does not independently exclude indexer omissions." : ""}`; break; }
        next = page.nextCursor;
        const key = JSON.stringify(Object.entries(next!).sort());
        if (cursors.has(key)) throw new UpstreamFailure();
        cursors.add(key);
      }
      if (coverage.status === "partial") coverage.reason = `Fully verified indexed pages reached blocks ${coverage.fromBlock}–${coverage.toBlock}; the page limit left pagination incomplete, including possible additional transactions in the boundary block.`;
      if (coverage.status === "unavailable") coverage.reason = "Funding pages did not complete verification within the declared finalized window before the page limit.";
    } catch (error) {
      checkAbort();
      if (!(error instanceof UpstreamFailure) && !(error instanceof ProviderBudgetError)) throw error;
      if (error instanceof ProviderBudgetError) fundingBudgetExhausted = true;
      if (isProviderThrottle(error)) fundingThrottled = true;
      coverage.status = coverage.status === "partial" ? "partial" : "unavailable";
      const cause = error instanceof ProviderBudgetError ? "Funding call allocation ended." : isProviderThrottle(error) ? "Provider throttling stopped further funding requests." : "Funding history or its RPC verification could not be completed.";
      coverage.reason = coverage.status === "partial" ? `${cause} Only fully verified indexed pages within blocks ${coverage.fromBlock}–${coverage.toBlock} were retained; pagination, including the boundary block, remains incomplete.` : `${cause} No indexed page completed verification within the declared finalized window.`;
    }
  }
  }
  await dependencies.onProgress?.("Verifying authenticated market buys, sales and initial liquidity");
  const tradeRemaining = Math.max(0, limits.callBudget - calls - 1);
  // Account/code and creator reads are already finished. Only pinned balances
  // and the separately excluded canonical recheck remain mandatory. Include
  // receipt-backed participants which enrichment could add after a record cap.
  const tradeBalanceCandidates = new Set(holderDiscovery?.snapshot.holders.map((holder) => holder.address) ?? []);
  if (holderOptions) for (const txReceipt of transferReceipts) for (const log of txReceipt.logs) {
    if (log.address !== input.token) continue;
    const record = transfer(log, 0, observedAt);
    if (!record) continue;
    for (const wallet of [record.from, record.to]) if (wallet !== ZERO) tradeBalanceCandidates.add(wallet);
  }
  const selectedExitPool = selectedPairs.find((address) => address !== ZERO) ?? null;
  let authenticatedExitPool = selectedExitPool ? poolCache.get(selectedExitPool) ?? null : null;
  // Reserve only when every pending balance plus the three V3 reads can fit.
  // The final canonical recheck is already excluded from tradeRemaining.
  const exitQuoteReserve = !rpcThrottle && authenticatedExitPool?.protocol === "uniswap-v3"
    && tradeRemaining >= tradeBalanceCandidates.size + 3 ? 3 : 0;
  phaseCeiling = calls + Math.max(0, tradeRemaining - tradeBalanceCandidates.size - exitQuoteReserve);
  await collectSales();
  authenticatedExitPool = selectedExitPool ? poolCache.get(selectedExitPool) ?? null : null;
  // Infrastructure is authenticated after the funding priority phase. Exclude
  // it from wallet coverage and remove funding-to-infrastructure observations
  // together, keeping every retained funding event backed by its coverage row.
  for (let index = funding.length - 1; index >= 0; index--) {
    if (hubs.has(funding[index].wallet)) funding.splice(index, 1);
  }
  for (const [id, record] of evidence) if (record.kind === "funding" && hubs.has(record.to)) evidence.delete(id);
  if (creatorFunding) {
    creatorFunding.cohort = creatorFunding.cohort.filter((wallet) => !hubs.has(wallet));
    creatorFunding.evidenceIds = creatorFunding.evidenceIds.filter((id) => evidence.has(id));
  }
  for (let index = candidates.length - 1; index >= 0; index--) if (hubs.has(candidates[index])) candidates.splice(index, 1);
  const finalObservedWallets = [...new Set([...evidence.values()].filter((record) => record.kind === "transfer" && record.assetAddress === input.token).flatMap((record) => [record.from, record.to]))].filter((wallet) => wallet !== ZERO).sort();
  const candidateSet = new Set(candidates);
  for (const wallet of finalObservedWallets) {
    if (hubs.has(wallet) || candidateSet.has(wallet)) continue;
    candidateSet.add(wallet); candidates.push(wallet);
    funding.push({ wallet, status: "not_examined", fromBlock: from.number, toBlock: to.number, internalTransfers: "not_examined", reason: "Supporting sale receipts introduced this token participant after the funding phase; its funding history was not examined." });
  }
  candidates.sort(); funding.sort((left, right) => left.wallet.localeCompare(right.wallet));
  examinedWallets = funding.filter((item) => item.status === "complete" || item.status === "partial").length;
  if (holderDiscovery && holderOptions) {
    // Sale proof may add token-flow participants omitted by a partial log range.
    // Keep them eligible for the deferred balance phase without rediscovery.
    const pendingHolders = new Map(holderDiscovery.snapshot.holders.map((item) => [item.address, item]));
    for (const address of finalObservedWallets) {
      const previous = pendingHolders.get(address);
      pendingHolders.set(address, { address, balanceRaw: null, status: "not_examined", discoveredBy: previous?.discoveredBy === "indexed" || previous?.discoveredBy === "both" ? "both" : "observed" });
    }
    holderDiscovery = { ...holderDiscovery, snapshot: { ...holderDiscovery.snapshot, holders: [...pendingHolders.values()].sort((left, right) => left.address.localeCompare(right.address)), balances: { ...holderDiscovery.snapshot.balances, status: pendingHolders.size ? "not_examined" : holderDiscovery.snapshot.balances.status, requestedWallets: pendingHolders.size } } };
    await dependencies.onProgress?.("Checking pinned holder balances after funding investigation");
    phaseCeiling = limits.callBudget - 1 - exitQuoteReserve;
    // The authenticated index lane is fixed: concurrent balance reads cannot
    // race the primary RPC's mutable recovery/handshake state. Each individual
    // read still consumes the shared allocation and uses the exact pinned block.
    let balanceThrottle: UpstreamFailure | null = null;
    const fixedBalanceRequest = dependencies.indexedRpc && indexedSourceVerified
      ? async (method: string, params: unknown[]) => {
        checkAbort();
        if (method !== "eth_call") throw new ProviderIntegrityError();
        if (balanceThrottle) throw balanceThrottle;
        if (calls >= phaseCeiling) throw new ProviderBudgetError();
        calls++;
        try { return await dependencies.indexedRpc!(method, params); }
        catch (error) { checkAbort(); if (isProviderThrottle(error)) balanceThrottle = error; throw error; }
      } : undefined;
    holderSnapshot = await verifyHolderBalances(holderDiscovery, {
      ...holderOptions,
      balanceConcurrency: fixedBalanceRequest ? 4 : 1,
      throttleError: () => rpcThrottle ?? balanceThrottle,
      remainingCalls: () => Math.max(0, limits.callBudget - calls - 1 - exitQuoteReserve),
      request: fixedBalanceRequest ?? ((method, params) => request(method, params)),
    });
    if (fixedBalanceRequest) warnings.add("Pinned holder balances used up to four concurrent read-only calls on the fixed Alchemy lane, authenticated against Base and the pinned range. Every call shares the acquisition budget; unavailable reads remain unknown.");
    if (holderSnapshot.discovery.status !== "complete" || holderSnapshot.balances.status !== "complete") warnings.add("Holder discovery or pinned balance verification is incomplete; missing balances are unknown, not zero.");
  }
  if (funding.some((item) => item.status !== "complete")) warnings.add("Funding history is not complete for every eligible participant; unexamined or unavailable wallets are listed individually.");
  phaseCeiling = limits.callBudget - 1;
  walletActivitySnapshot.rows = walletActivitySnapshot.rows.filter((row) => !hubs.has(row.address)).map((row) => row.code === "unavailable" && walletCode.has(row.address) ? { ...row, code: walletCode.get(row.address)! } : row);
  const activityAddresses = new Set(walletActivitySnapshot.rows.map((row) => row.address));
  // Candidate priority changes after collection. Keep every retained verified
  // row; fill only remaining snapshot slots with explicitly unknown candidates.
  for (const wallet of candidates) {
    if (activityAddresses.has(wallet)) continue;
    if (walletActivitySnapshot.rows.length >= 2000) break;
    walletActivitySnapshot.rows.push({ address: wallet, outgoingTransactionCountRaw: null, code: "unavailable" });
    activityAddresses.add(wallet);
  }
  walletActivitySnapshot.rows.sort((left, right) => left.address.localeCompare(right.address));
  if (candidates.some((wallet) => !activityAddresses.has(wallet))) warnings.add("The pinned wallet-activity row limit was reached; omitted candidates have unknown outgoing nonce and contract status.");
  if (walletActivitySnapshot.rows.some((row) => row.code === "unavailable" || row.outgoingTransactionCountRaw === null && row.code === "eoa")) warnings.add("Some pinned wallet code or outgoing-transaction nonce reads were unavailable or budget-limited. A small outgoing nonce is not a complete activity history.");
  await dependencies.onProgress?.("Checking the largest verified wallet's fee-aware pool exit quote");
  const exitQuote = await collectExitQuote({
    token: { address: input.token, chainId: 8453, name: tokenName, symbol: tokenSymbol, decimals: typeof decimals === "number" ? decimals : null, totalSupplyRaw: typeof supply === "bigint" ? supply.toString() : null },
    block: to, observedAt, holderSnapshot, walletActivitySnapshot, selectedPool: selectedExitPool,
    authenticatedPool: authenticatedExitPool && selectedExitPool ? { ...authenticatedExitPool, address: selectedExitPool } : null,
    authenticatedPools: [...pools],
    unsupportedPool: selectedExitPool !== null && poolCache.has(selectedExitPool) && poolCache.get(selectedExitPool) === null,
    liquiditySnapshot, request: (method, params) => request(method, params),
    remainingCalls: () => rpcThrottle ? 0 : Math.max(0, limits.callBudget - calls - 1), signal: dependencies.signal, throttleError: () => rpcThrottle,
  });
  await dependencies.onProgress?.("Rechecking canonical finalized block identity");
  if (rpcThrottle) { warnings.add("Recognized RPC throttling stopped optional candidate checks; the mandatory canonical recheck receives a bounded one-second recovery pause."); await backoff(1000); }
  const currentEnd = blockReference(await request("eth_getBlockByNumber", [hex(toNumber), false], true));
  if (currentEnd.hash !== to.hash || currentEnd.number !== to.number || currentEnd.timestamp !== to.timestamp) throw new ProviderIntegrityError("The pinned end block changed while the investigation was collecting evidence.");
  if (verifiedCreation) {
    const mint = evidence.get(verifiedCreation.evidenceId)!;
    if (mint.purchase === undefined) evidence.set(mint.id, { ...mint, creation: verifiedCreation.value, provenance: { ...mint.provenance, method: "canonical ERC-20 deployment mint + eth_getTransactionByHash + eth_getTransactionReceipt" } });
  }
  const orderedEvidence = [...evidence.values()].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || a.transactionIndex - b.transactionIndex || (a.logIndex ?? -1) - (b.logIndex ?? -1) || a.id.localeCompare(b.id));
  if (dependencies.rpcSource) {
    const sourceLabel = `Base RPC [${[...rpcSources].join("; ")}]`;
    for (const record of orderedEvidence) record.provenance = { ...record.provenance, provider: record.provenance.provider.replace("Base RPC", sourceLabel) };
    warnings.add(`RPC sources used for acquisition: ${[...rpcSources].join("; ")}. This is a scan-wide source set; individual evidence may require reads from more than one source.`);
  }
  completedTransferRanges.sort((left, right) => BigInt(left.fromBlock) < BigInt(right.fromBlock) ? -1 : BigInt(left.fromBlock) > BigInt(right.fromBlock) ? 1 : 0);
  return { token: { address: input.token, chainId: 8453, name: tokenName, symbol: tokenSymbol, decimals: typeof decimals === "number" ? decimals : null, totalSupplyRaw: typeof supply === "bigint" ? supply.toString() : null }, range: { from, to, finality: "finalized" }, evidence: orderedEvidence, pools: [...pools].sort(), hubs: [...hubs].sort(), ...(holderSnapshot ? { holderSnapshot } : {}), walletActivitySnapshot, ...(liquiditySnapshot ? { liquiditySnapshot } : {}), exitQuote, coverage: { transfers: transfersStatus, transferCrawl: { scope: input.scope, source: dependencies.transferPage ? "alchemy-transfers" : "rpc-logs", completedRanges: completedTransferRanges }, funding, ...(creatorFunding ? { creatorFunding } : {}), eligibleWallets: candidates.length, examinedWallets, warnings: [...warnings] } };
}
