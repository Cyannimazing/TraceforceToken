import type { Address, BlockReference, EvidenceRecord, InvestigationReport } from "./types";
import { deriveCreatorAttribution, type CreatorAttribution } from "./creator-attribution";
import { validateTransferCrawl } from "./transfer-crawl";

export type WalletFlagLabel = "creator" | "fresh" | "sniper" | "insider" | "contract" | "unread";
export interface WalletSignalFlag {
  label: WalletFlagLabel;
  evidenceIds: string[];
  basis: string;
  sourceUrl?: string;
}
export interface InitialLiquidityReference {
  pool: Address;
  factory: Address;
  timestamp: number;
  blockNumber: string;
  transactionHash: EvidenceRecord["transactionHash"];
  transactionIndex: number;
  logIndex: number;
  evidenceIds: string[];
  basis: string;
}
export interface VerifiedPurchaseProof {
  wallet: Address;
  pool: Address;
  factory: Address;
  protocol: "uniswap-v2" | "uniswap-v3";
  timestamp: number;
  blockNumber: string;
  transactionHash: EvidenceRecord["transactionHash"];
  transactionIndex: number;
  logIndex: number;
  evidenceIds: string[];
}
export interface WalletSignal {
  address: Address;
  labels: WalletFlagLabel[];
  flags: WalletSignalFlag[];
  outgoingTransactionCountRaw: string | null;
  entry: { kind: "mint" | "buy" | "transfer"; timestamp: number; transactionHash: EvidenceRecord["transactionHash"]; evidenceIds: string[] } | null;
}
export interface WalletSignalResult {
  creator: CreatorAttribution | null;
  initialLiquidity: InitialLiquidityReference | null;
  wallets: WalletSignal[];
  limitations: string[];
}

const ZERO = `0x${"0".repeat(40)}` as Address;
const rawAmount = (value: string): bigint | null => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n ? BigInt(value) : null;
const positive = (record: EvidenceRecord) => (rawAmount(record.amountRaw) ?? 0n) > 0n;
const validPosition = (record: { blockNumber: string; transactionIndex: number; logIndex: number | null; timestamp: number }) => /^(0|[1-9][0-9]{0,77})$/.test(record.blockNumber)
  && Number.isSafeInteger(record.transactionIndex) && record.transactionIndex >= 0
  && (record.logIndex === null || (Number.isSafeInteger(record.logIndex) && record.logIndex >= 0))
  && Number.isSafeInteger(record.timestamp) && record.timestamp >= 0;
function comparePosition(left: { blockNumber: string; transactionIndex: number; logIndex: number | null }, right: { blockNumber: string; transactionIndex: number; logIndex: number | null }): number {
  const a = BigInt(left.blockNumber), b = BigInt(right.blockNumber);
  return a < b ? -1 : a > b ? 1 : left.transactionIndex - right.transactionIndex || (left.logIndex ?? -1) - (right.logIndex ?? -1);
}
const sameBlock = (left: BlockReference, right: BlockReference) => left.number === right.number && left.hash === right.hash && left.timestamp === right.timestamp;

/** Report validation authenticates pools/receipts; this rejects incomplete or
 * cross-receipt support before a display flag can use an annotation. */
function retainedProof(report: InvestigationReport, event: EvidenceRecord, ids: readonly string[]): EvidenceRecord[] | null {
  if (!validPosition(event) || !ids.length || new Set(ids).size !== ids.length || !ids.includes(event.id)) return null;
  const byId = new Map(report.evidence.map((record) => [record.id, record]));
  if (byId.size !== report.evidence.length || byId.get(event.id) !== event) return null;
  const proof: EvidenceRecord[] = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (!record || record.kind !== "transfer" || record.assetAddress === null || record.logIndex === null || !validPosition(record) || !positive(record)
      || record.chainId !== report.token.chainId || record.blockNumber !== event.blockNumber || record.blockHash !== event.blockHash
      || record.transactionHash !== event.transactionHash || record.transactionIndex !== event.transactionIndex || record.timestamp !== event.timestamp) return null;
    proof.push(record);
  }
  return proof;
}
function net(proof: readonly EvidenceRecord[], wallet: Address, asset: Address): bigint {
  return proof.filter((record) => record.assetAddress === asset).reduce((value, record) => value + (record.to === wallet ? BigInt(record.amountRaw) : 0n) - (record.from === wallet ? BigInt(record.amountRaw) : 0n), 0n);
}

/** A purchase annotation is not inferred from an ordinary pool transfer. */
export function verifiedPurchaseProof(report: InvestigationReport, event: EvidenceRecord): VerifiedPurchaseProof | null {
  const purchase = event.purchase;
  if (!purchase || event.kind !== "transfer" || event.assetAddress !== report.token.address || event.from !== purchase.pool || event.to === ZERO || event.to === purchase.pool
    || event.logIndex === null || !positive(event) || !["uniswap-v2", "uniswap-v3"].includes(purchase.protocol)
    || purchase.quoteAsset === report.token.address || purchase.quoteAsset === purchase.pool || purchase.quoteAsset === ZERO
    || !Number.isSafeInteger(purchase.swapLogIndex) || purchase.swapLogIndex <= event.logIndex
    || (rawAmount(purchase.quoteAmountRaw) ?? 0n) <= 0n) return null;
  const proof = retainedProof(report, event, purchase.supportingEvidenceIds);
  if (!proof || net(proof, event.to, report.token.address) <= 0n || net(proof, purchase.pool, purchase.quoteAsset) !== BigInt(purchase.quoteAmountRaw)) return null;
  // Native-wrap purchases have router->pool WETH rather than wallet->pool WETH.
  // The collector/validator authenticates the router, Deposit and tx.value; do
  // not manufacture a missing wallet WETH debit in this pure display layer.
  return { wallet: event.to, pool: purchase.pool, factory: purchase.factory, protocol: purchase.protocol, timestamp: event.timestamp, blockNumber: event.blockNumber,
    transactionHash: event.transactionHash, transactionIndex: event.transactionIndex, logIndex: purchase.swapLogIndex, evidenceIds: [...purchase.supportingEvidenceIds] };
}

/** Earliest retained authenticated V2 pool initialization, not a universal token
 * launch date. Complete genesis-range transfer acquisition is required. */
export function firstAuthenticatedLiquidity(report: InvestigationReport): InitialLiquidityReference | null {
  if (report.coverage.transfers !== "complete" || report.range.from.number !== "0" || report.coverage.transferCrawl?.scope !== "full") return null;
  try { validateTransferCrawl(report.coverage.transferCrawl, report.range, report.coverage.transfers); } catch { return null; }
  const candidates: InitialLiquidityReference[] = [];
  for (const event of report.evidence) {
    const liquidity = event.liquidity;
    if (!liquidity || liquidity.initial !== true || liquidity.protocol !== "uniswap-v2" || event.kind !== "transfer" || event.assetAddress !== report.token.address
      || event.to !== liquidity.pool || event.logIndex === null || !positive(event) || !Number.isSafeInteger(liquidity.mintLogIndex) || liquidity.mintLogIndex <= event.logIndex) continue;
    const proof = retainedProof(report, event, liquidity.supportingEvidenceIds);
    if (!proof || proof.some((record) => record.logIndex! >= liquidity.mintLogIndex)
      || !proof.some((record) => record.assetAddress === liquidity.pool && record.from === ZERO && record.to === ZERO && record.amountRaw === "1000")
      || net(proof, liquidity.pool, report.token.address) <= 0n
      || !proof.some((record) => record.assetAddress !== report.token.address && record.assetAddress !== liquidity.pool && record.to === liquidity.pool && net(proof, liquidity.pool, record.assetAddress!) > 0n)) continue;
    candidates.push({ pool: liquidity.pool, factory: liquidity.factory, timestamp: event.timestamp, blockNumber: event.blockNumber, transactionHash: event.transactionHash,
      transactionIndex: event.transactionIndex, logIndex: liquidity.mintLogIndex, evidenceIds: [...liquidity.supportingEvidenceIds],
      basis: "Earliest retained authenticated Uniswap V2 pool initial liquidity in a completed genesis-range transfer crawl; other venues and a universal token launch are not established." });
  }
  return candidates.sort(comparePosition)[0] ?? null;
}

/** Exact familiar labels with explicit evidence bases. No AI or market metadata
 * can supply a missing purchase, launch anchor, balance or account state. */
export function deriveWalletSignals(report: InvestigationReport): WalletSignalResult {
  const creator = deriveCreatorAttribution(report);
  const initialLiquidity = firstAuthenticatedLiquidity(report);
  const snapshot = report.walletActivitySnapshot;
  const activityRows = snapshot && sameBlock(snapshot.block, report.range.to) && new Set(snapshot.rows.map((row) => row.address)).size === snapshot.rows.length ? snapshot.rows : [];
  const byWallet = new Map(activityRows.map((row) => [row.address, row]));
  // Index first positive token receipts once. A later launch-window buy cannot
  // turn a prior mint/allocation/transfer recipient into a first-entry sniper.
  const firstReceipts = new Map<Address, EvidenceRecord>();
  for (const event of report.evidence) {
    if (event.kind !== "transfer" || event.assetAddress !== report.token.address || !positive(event) || !validPosition(event)) continue;
    const previous = firstReceipts.get(event.to);
    if (!previous || comparePosition(event, previous) < 0) firstReceipts.set(event.to, event);
  }
  const wallets = report.wallets.map((wallet): WalletSignal => {
    const flags: WalletSignalFlag[] = [];
    const incoming = firstReceipts.get(wallet.address);
    const purchase = incoming ? verifiedPurchaseProof(report, incoming) : null;
    const activity = byWallet.get(wallet.address);
    const outgoing = activity?.outgoingTransactionCountRaw !== null && activity?.outgoingTransactionCountRaw !== undefined && rawAmount(activity.outgoingTransactionCountRaw) !== null ? activity.outgoingTransactionCountRaw : null;
    if (creator?.address === wallet.address) flags.push({ label: "creator", evidenceIds: creator.evidenceIds, basis: creator.basis, sourceUrl: creator.sourceUrl });
    if (activity?.code === "eoa" && outgoing !== null && BigInt(outgoing) <= 10n) flags.push({ label: "fresh", evidenceIds: [], basis: "Pinned EOA account nonce is at most 10 outgoing transactions; this does not count incoming, internal or complete lifetime transaction activity." });
    const sniper = initialLiquidity && purchase && purchase.pool === initialLiquidity.pool && purchase.factory === initialLiquidity.factory && purchase.protocol === "uniswap-v2"
      && comparePosition(purchase, initialLiquidity) > 0 && purchase.timestamp >= initialLiquidity.timestamp && purchase.timestamp - initialLiquidity.timestamp < 60 ? purchase : null;
    if (sniper && initialLiquidity) flags.push({ label: "sniper", evidenceIds: [...new Set([...initialLiquidity.evidenceIds, ...sniper.evidenceIds])], basis: "This wallet's earliest retained positive token receipt is a receipt-verified purchase after this authenticated V2 pool's initial liquidity and within its first 60 seconds; pool-scoped first entry, not an independently established universal token launch." });
    const insider = creator && creator.address !== wallet.address && initialLiquidity ? report.evidence.filter((event) => event.from === creator.address && event.to === wallet.address && positive(event) && validPosition(event)
      && (event.kind === "funding" && event.assetAddress === null || event.kind === "transfer" && event.assetAddress === report.token.address)
      && event.timestamp <= initialLiquidity.timestamp && comparePosition(event, initialLiquidity) < 0).sort(comparePosition)[0] : undefined;
    if (insider && initialLiquidity && creator) flags.push({ label: "insider", evidenceIds: [...new Set([insider.id, ...initialLiquidity.evidenceIds])], sourceUrl: creator.sourceUrl,
      basis: "Receipt-backed native funding or token receipt directly from the attributed creator before this pool's initial liquidity; operational connection, not proof of identity, privilege or common ownership." });
    if (activity?.code === "contract") flags.push({ label: "contract", evidenceIds: [], basis: "Nonempty account bytecode at the pinned finalized block; contract status does not identify a pool, router or owner." });
    if (wallet.balanceRaw === null) flags.push({ label: "unread", evidenceIds: [], basis: "A pinned current token balance was not verified for this examined address." });
    return { address: wallet.address, labels: flags.map((flag) => flag.label), flags, outgoingTransactionCountRaw: outgoing,
      entry: incoming ? { kind: incoming.from === ZERO ? "mint" : purchase ? "buy" : "transfer", timestamp: incoming.timestamp, transactionHash: incoming.transactionHash, evidenceIds: purchase?.evidenceIds ?? [incoming.id] } : null };
  });
  return { creator, initialLiquidity, wallets, limitations: [
    "Fresh uses a pinned outgoing account nonce, not a lifetime all-transaction count.",
    "Creator is direct-deployment receipt-backed when available, otherwise explicitly GoPlus-reported. Insider and shared funding labels do not establish identity or common ownership.",
    "Sniper requires the earliest retained positive token receipt to be an authenticated purchase within this pool's first 60 seconds after initial liquidity in completed full-scope acquisition; unexamined venues and universal token launch remain unknown.",
  ] };
}
