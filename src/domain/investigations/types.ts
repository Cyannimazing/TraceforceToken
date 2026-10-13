export type Address = `0x${string}`;
export type Hash = `0x${string}`;
export type CoverageStatus = "complete" | "partial" | "unavailable" | "not_examined";

export interface BlockReference {
  number: string;
  hash: Hash;
  timestamp: number;
}

export interface TokenDetails {
  address: Address;
  chainId: 8453;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupplyRaw: string | null;
  /** Third-party listing metadata; never proof of project ownership or safety. */
  webPresence?: TokenWebPresence;
  marketSnapshot?: TokenMarketSnapshot;
  securitySnapshot?: TokenSecuritySnapshot;
}

/** Latest third-party context, kept separate from receipt-backed findings and pinned balances. */
export interface TokenSecuritySnapshot {
  source: "goplus";
  status: "reported" | "not_listed" | "unavailable";
  checkedAt: string;
  sourceUrl: string;
  tokenAddress: Address;
  chainId: 8453;
  holderCount: number | null;
  creatorAddress: Address | null;
  checks: { id: TokenSecurityCheckId; value: "yes" | "no" | "unknown" }[];
}
export type TokenSecurityCheckId = "is_honeypot" | "is_proxy" | "is_mintable" | "hidden_owner" | "can_take_back_ownership" | "owner_change_balance" | "transfer_pausable" | "is_blacklisted" | "is_open_source";

/** Source-reported DEX market values are approximate metadata, not chain evidence. */
export interface TokenMarketSnapshot {
  source: "dexscreener";
  status: "reported" | "not_listed" | "unavailable";
  checkedAt: string;
  sourceUrl: string;
  pairAddress: Address | null;
  priceUsd: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPercent: number | null;
  /** Pair creation time in Unix milliseconds; never token launch time. */
  pairCreatedAt: number | null;
}

export interface TokenWebPresence {
  source: "dexscreener";
  status: "reported" | "not_listed" | "unavailable";
  checkedAt: string;
  sourceUrl: string;
  websites: { url: string; pairAddresses: Address[] }[];
  matchedPairs: number;
  reason: string | null;
}

export interface EvidenceRecord {
  id: string;
  kind: "transfer" | "funding" | "sale";
  chainId: 8453;
  blockNumber: string;
  blockHash: Hash;
  transactionHash: Hash;
  transactionIndex: number;
  logIndex: number | null;
  traceId: string | null;
  timestamp: number;
  from: Address;
  to: Address;
  assetAddress: Address | null;
  amountRaw: string;
  provenance: { provider: string; method: string; observedAt: string };
  /** Set only after authenticated pool, successful receipt, and wallet net-flow checks. */
  sale: null | {
    pool: Address;
    factory: Address;
    protocol: "uniswap-v2" | "uniswap-v3";
    quoteAsset: Address;
    quoteAmountRaw: string;
    swapLogIndex: number;
    supportingEvidenceIds: string[];
  };
  /** Authenticated market purchase, attached to its pool-to-buyer token transfer. */
  purchase?: NonNullable<EvidenceRecord["sale"]> & { nativeInputRaw?: string };
  /** First V2 mint, including the canonical minimum-liquidity lock marker. */
  liquidity?: { pool: Address; factory: Address; protocol: "uniswap-v2"; mintLogIndex: number; initial: true; supportingEvidenceIds: string[] };
  /** Successful direct deployment, verified against this mint's transaction and receipt. */
  creation?: { creator: Address; contractAddress: Address; transactionTo: null; receiptStatus: "0x1" };
}

export interface WalletFundingCoverage {
  wallet: Address;
  status: CoverageStatus;
  fromBlock: string;
  toBlock: string;
  internalTransfers: "not_examined";
  reason: string | null;
}

/** A separate creator-filtered external-native query; never recipient history. */
export interface CreatorFundingCoverage {
  creator: Address;
  source: "alchemy-transfers";
  scope: "direct-creator-external-native";
  status: CoverageStatus;
  fromBlock: string;
  toBlock: string;
  cohort: Address[];
  evidenceIds: string[];
  paginationExhausted: boolean;
  internalTransfers: "not_examined";
  reason: string;
}

/** Indexed address discovery is latest-state and never a finalized holder census.
 * Only successful pinned RPC balanceOf calls establish the reported balances. */
export interface HolderSnapshot {
  chainId: 8453;
  tokenAddress: Address;
  block: BlockReference;
  totalSupplyRaw: string | null;
  discovery: {
    provider: "Blockscout" | "GoPlus";
    sourceUrl: string;
    observedAt: string;
    status: CoverageStatus;
    pages: number;
    addresses: number;
    finalizedCensus: false;
    reason: string | null;
  };
  balances: {
    status: CoverageStatus;
    requestedWallets: number;
    verifiedWallets: number;
    reason: string | null;
  };
  holders: {
    address: Address;
    balanceRaw: string | null;
    status: "verified" | "unavailable" | "not_examined";
    discoveredBy: "indexed" | "observed" | "both";
  }[];
  provenance: {
    provider: "Base RPC";
    method: "eth_call balanceOf(address) at pinned finalized block";
    observedAt: string;
  };
}

export interface WalletActivitySnapshot {
  block: BlockReference;
  rows: { address: Address; outgoingTransactionCountRaw: string | null; code: "eoa" | "contract" | "unavailable" }[];
}
export interface LiquiditySnapshot {
  protocol: "uniswap-v2"; pool: Address; factory: Address; token0: Address; token1: Address;
  reserve0Raw: string; reserve1Raw: string; block: BlockReference;
  provenance: { provider: string; method: string; observedAt: string };
}

export interface InvestigationDataset {
  token: TokenDetails;
  range: { from: BlockReference; to: BlockReference; finality: "finalized" };
  evidence: EvidenceRecord[];
  pools: Address[];
  hubs: Address[];
  holderSnapshot?: HolderSnapshot;
  walletActivitySnapshot?: WalletActivitySnapshot;
  liquiditySnapshot?: LiquiditySnapshot;
  coverage: {
    transfers: CoverageStatus;
    /** Requested acquisition scope and fully processed discovery ranges, not proof of index completeness. */
    transferCrawl?: {
      scope: "full" | "window";
      source: "rpc-logs" | "alchemy-transfers";
      completedRanges: { fromBlock: string; toBlock: string }[];
    };
    funding: WalletFundingCoverage[];
    creatorFunding?: CreatorFundingCoverage;
    eligibleWallets: number;
    examinedWallets: number;
    warnings: string[];
  };
}

export interface InvestigationFinding {
  id: string;
  category: "funding" | "connections" | "accumulation" | "selling" | "coverage";
  title: string;
  explanation: string;
  confidence: "high" | "medium" | "low";
  wallets: Address[];
  evidenceIds: string[];
  limitations: string[];
  rule: { name: string; version: string; parameters: Record<string, string | number> };
}

/** AI commentary over retained evidence; never an acquisition or finding authority. */
export interface InvestigationExplanation {
  schemaVersion: 1;
  reportId: string;
  profileId: "on-chain-investigator";
  profileVersion: "1.0.0" | "1.1.0" | "1.1.1" | "1.1.2" | "1.2.0" | "1.3.0" | "1.4.0";
  model: string;
  generatedAt: string;
  overview: { text: string; evidenceIds: string[] };
  observations: {
    category: "funding" | "connections" | "accumulation" | "selling";
    claim: string;
    caveat: string;
    evidenceIds: string[];
  }[];
  limitations: string[];
  context: { evidenceIds: string[]; suppliedEvidence: number; omittedEvidence: number };
  authority: "non-authoritative-commentary";
  /** In 1.4.0 the model selects facts; published prose is restored from these exact sources. */
  grounding?: {
    mode: "canonical-finding-selection";
    overviewFindingIds: string[];
    overviewEvidenceIds: string[];
    observations: { findingId: string; caveatIndex: number }[];
  };
}

export interface InvestigationReport {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  mode: "live";
  token: TokenDetails;
  range: InvestigationDataset["range"];
  coverage: InvestigationDataset["coverage"];
  holderSnapshot?: HolderSnapshot;
  walletActivitySnapshot?: WalletActivitySnapshot;
  liquiditySnapshot?: LiquiditySnapshot;
  infrastructure?: { pools: Address[]; hubs: Address[] };
  summary: string;
  wallets: {
    address: Address;
    observedIncomingRaw: string;
    observedOutgoingRaw: string;
    observedNetRaw: string;
    balanceRaw: string | null;
    verifiedSoldRaw: string;
    firstObservedAt: number | null;
    earlyAccumulator: boolean | null;
  }[];
  connections: { id: string; from: Address; to: Address; kind: "funding" | "transfer"; timestamp: number; evidenceIds: string[] }[];
  groups: { id: string; wallets: Address[]; evidenceIds: string[]; explanation: string }[];
  findings: InvestigationFinding[];
  story: { id: string; timestamp: number; title: string; description: string; evidenceIds: string[] }[];
  evidence: EvidenceRecord[];
  /** Absent during deterministic analysis; mandatory before job completion. */
  explanation?: InvestigationExplanation;
}

export interface ExplainedInvestigationReport extends InvestigationReport {
  explanation: InvestigationExplanation;
}

export interface ScanParameters {
  token: Address;
  lookbackBlocks: number;
  /** Public requests default to full; absent only in legacy direct collector callers. */
  scope?: "full" | "window";
}

export interface InvestigationJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  parameters: ScanParameters;
  stage: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  report: ExplainedInvestigationReport | null;
}
