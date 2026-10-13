import type {
  Address,
  CoverageStatus,
  EvidenceRecord,
  Hash,
  InvestigationDataset,
  InvestigationFinding,
  InvestigationReport,
} from "./types";
import { tokenWebPresenceSchema } from "./token-web-presence";
import { tokenMarketSnapshotSchema } from "./token-market";
import { validateHolderSnapshot } from "./holder-snapshot";
import { tokenSecuritySnapshotSchema } from "./token-security";
import { validateTransferCrawl } from "./transfer-crawl";
import { creatorFundingCoverageSchema, validateCreatorFundingCoverage } from "./creator-funding";
import { creationAnnotationSchema, validateCreationAnnotations } from "./creator-attribution";
import { initialLiquiditySchema, purchaseSchema, validateLiquiditySnapshot, validateMarketAnnotations, validateWalletActivitySnapshot } from "./chain-snapshots";

const ZERO = `0x${"0".repeat(40)}`;
const UINT256_MAX = (1n << 256n) - 1n;
const WINDOW_SECONDS = 600;
const STATUSES = new Set<CoverageStatus>(["complete", "partial", "unavailable", "not_examined"]);
const VERSION = "1.0.0";

export class AnalysisInputError extends Error {
  constructor(field: string) {
    super(`Invalid investigation dataset: ${field}.`);
    this.name = "AnalysisInputError";
  }
}

function requireValue(condition: unknown, field: string): asserts condition {
  if (!condition) throw new AnalysisInputError(field);
}

function text(value: unknown, field: string, limit = 255): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value), field);
  return value;
}

function address(value: unknown, field: string): Address {
  requireValue(typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value), field);
  return value.toLowerCase() as Address;
}

function hash(value: unknown, field: string): Hash {
  requireValue(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), field);
  return value.toLowerCase() as Hash;
}

function raw(value: unknown, field: string): string {
  requireValue(typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value), field);
  requireValue(BigInt(value) <= UINT256_MAX, field);
  return value;
}

function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum, field);
  return value;
}

function timestamp(value: unknown, field: string): number {
  return integer(value, field, 8_640_000_000_000);
}

function iso(value: unknown, field: string): string {
  requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), field);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  requireValue(calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day, field);
  return new Date(value).toISOString();
}

function sorted<T extends string>(items: Iterable<T>): T[] {
  return [...new Set(items)].sort();
}

type EventIdentity = Pick<EvidenceRecord, "kind" | "chainId" | "blockHash" | "transactionHash" | "logIndex" | "traceId">;

/** Fork-specific IDs are independent of provider names and acquisition order. */
export function evidenceId(record: EventIdentity): string {
  requireValue(record.chainId === 8453, "evidence chain ID");
  const base = `${record.chainId}:${hash(record.blockHash, "evidence block hash")}:${hash(record.transactionHash, "evidence transaction hash")}`;
  if (record.kind === "funding") {
    requireValue(record.logIndex === null, "native funding log index");
    if (record.traceId !== null) return `${base}:trace:${text(record.traceId, "funding trace ID", 128)}`;
    return `${base}:native`;
  }
  requireValue(record.kind === "transfer" || record.kind === "sale", "evidence kind");
  integer(record.logIndex, "event log index");
  requireValue(record.traceId === null, "log trace ID");
  return `${base}:${record.kind === "sale" ? "sale" : "log"}:${record.logIndex}`;
}

function compareEvents(a: EvidenceRecord, b: EvidenceRecord): number {
  const blockA = BigInt(a.blockNumber), blockB = BigInt(b.blockNumber);
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  return a.transactionIndex - b.transactionIndex ||
    (a.logIndex ?? -1) - (b.logIndex ?? -1) ||
    a.transactionHash.localeCompare(b.transactionHash) ||
    (a.traceId ?? "").localeCompare(b.traceId ?? "", "en", { numeric: true }) ||
    a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}

function normalizeEvent(event: EvidenceRecord): EvidenceRecord {
  requireValue(event && typeof event === "object", "evidence record");
  text(event.id, "source evidence ID", 512);
  requireValue(event.chainId === 8453, "evidence chain ID");
  requireValue(["transfer", "funding", "sale"].includes(event.kind), "evidence kind");
  requireValue(event.provenance && typeof event.provenance === "object", "evidence provenance");
  const normalized: EvidenceRecord = {
    id: event.id,
    kind: event.kind,
    chainId: 8453,
    blockNumber: raw(event.blockNumber, "evidence block number"),
    blockHash: hash(event.blockHash, "evidence block hash"),
    transactionHash: hash(event.transactionHash, "evidence transaction hash"),
    transactionIndex: integer(event.transactionIndex, "transaction index"),
    logIndex: event.logIndex === null ? null : integer(event.logIndex, "log index"),
    traceId: event.traceId === null ? null : text(event.traceId, "trace ID", 128),
    timestamp: timestamp(event.timestamp, "event timestamp"),
    from: address(event.from, "event sender"),
    to: address(event.to, "event recipient"),
    assetAddress: event.assetAddress === null ? null : address(event.assetAddress, "event asset"),
    amountRaw: raw(event.amountRaw, "event amount"),
    provenance: {
      provider: text(event.provenance.provider, "provider", 128),
      method: text(event.provenance.method, "provider method", 128),
      observedAt: iso(event.provenance.observedAt, "observation time"),
    },
    sale: null,
  };
  if (event.kind === "funding") {
    requireValue(event.assetAddress === null && event.sale === null, "native funding asset/metadata");
  } else {
    requireValue(normalized.assetAddress !== null, "token event asset");
  }
  if (event.kind === "sale") {
    requireValue(event.sale && typeof event.sale === "object", "sale verification metadata");
    requireValue(event.sale.protocol === "uniswap-v2" || event.sale.protocol === "uniswap-v3", "supported sale protocol");
    requireValue(Array.isArray(event.sale.supportingEvidenceIds) && event.sale.supportingEvidenceIds.length > 0, "sale supporting evidence");
    normalized.sale = {
      pool: address(event.sale.pool, "sale pool"),
      factory: address(event.sale.factory, "sale factory"),
      protocol: event.sale.protocol,
      quoteAsset: address(event.sale.quoteAsset, "sale quote asset"),
      quoteAmountRaw: raw(event.sale.quoteAmountRaw, "sale quote amount"),
      swapLogIndex: integer(event.sale.swapLogIndex, "swap log index"),
      supportingEvidenceIds: sorted(event.sale.supportingEvidenceIds.map((id) => text(id, "sale supporting ID", 512))),
    };
    requireValue(normalized.logIndex === normalized.sale.swapLogIndex, "sale swap identity");
  } else {
    requireValue(event.sale === null, "unexpected sale metadata");
  }
  try {
    if (event.creation !== undefined) normalized.creation = creationAnnotationSchema.parse(event.creation);
    if (event.purchase !== undefined) normalized.purchase = purchaseSchema.parse(event.purchase) as NonNullable<EvidenceRecord["purchase"]>;
    if (event.liquidity !== undefined) normalized.liquidity = initialLiquiditySchema.parse(event.liquidity) as NonNullable<EvidenceRecord["liquidity"]>;
  } catch { throw new AnalysisInputError("market verification metadata"); }
  const canonicalId = evidenceId(normalized);
  return { ...normalized, id: canonicalId };
}

function normalizeDataset(input: InvestigationDataset): InvestigationDataset {
  requireValue(input && typeof input === "object" && input.token && input.range && input.coverage, "required records");
  const token = input.token;
  requireValue(token.chainId === 8453, "token chain ID");
  const presence = token.webPresence === undefined ? undefined : tokenWebPresenceSchema.safeParse(token.webPresence);
  requireValue(presence === undefined || presence.success, "token website metadata");
  const market = token.marketSnapshot === undefined ? undefined : tokenMarketSnapshotSchema.safeParse(token.marketSnapshot);
  requireValue(market === undefined || market.success, "token market metadata");
  const security = token.securitySnapshot === undefined ? undefined : tokenSecuritySnapshotSchema.safeParse(token.securitySnapshot);
  requireValue(security === undefined || security.success, "token security metadata");
  const normalizedToken = {
    address: address(token.address, "token address"),
    chainId: 8453 as const,
    name: token.name === null ? null : text(token.name, "token name"),
    symbol: token.symbol === null ? null : text(token.symbol, "token symbol", 64),
    decimals: token.decimals === null ? null : integer(token.decimals, "token decimals", 255),
    totalSupplyRaw: token.totalSupplyRaw === null ? null : raw(token.totalSupplyRaw, "token supply"),
    ...(presence?.success ? { webPresence: presence.data } : {}),
    ...(market?.success ? { marketSnapshot: market.data } : {}),
    ...(security?.success ? { securitySnapshot: security.data } : {}),
  };
  requireValue(!normalizedToken.webPresence || normalizedToken.webPresence.sourceUrl === `https://api.dexscreener.com/token-pairs/v1/base/${normalizedToken.address}`, "token website identity");
  requireValue(!normalizedToken.marketSnapshot || normalizedToken.marketSnapshot.sourceUrl === `https://api.dexscreener.com/token-pairs/v1/base/${normalizedToken.address}`, "token market identity");
  requireValue(!normalizedToken.securitySnapshot || normalizedToken.securitySnapshot.tokenAddress === normalizedToken.address, "token security identity");
  requireValue(normalizedToken.address !== ZERO, "zero token address");
  requireValue(input.range.from && input.range.to && input.range.finality === "finalized", "finalized range");
  const block = (value: InvestigationDataset["range"]["from"]) => ({
    number: raw(value.number, "range block number"),
    hash: hash(value.hash, "range block hash"),
    timestamp: timestamp(value.timestamp, "range timestamp"),
  });
  const range = { from: block(input.range.from), to: block(input.range.to), finality: "finalized" as const };
  requireValue(BigInt(range.from.number) <= BigInt(range.to.number) && range.from.timestamp <= range.to.timestamp, "range order");
  let holderSnapshot: InvestigationDataset["holderSnapshot"];
  if (input.holderSnapshot !== undefined) {
    try { holderSnapshot = validateHolderSnapshot(input.holderSnapshot, normalizedToken, range.to); }
    catch { throw new AnalysisInputError("pinned holder snapshot"); }
  }
  let walletActivitySnapshot: InvestigationDataset["walletActivitySnapshot"], liquiditySnapshot: InvestigationDataset["liquiditySnapshot"];
  try {
    if (input.walletActivitySnapshot) walletActivitySnapshot = validateWalletActivitySnapshot(input.walletActivitySnapshot, range.to);
    if (input.liquiditySnapshot) liquiditySnapshot = validateLiquiditySnapshot(input.liquiditySnapshot, normalizedToken.address, range.to);
  } catch { throw new AnalysisInputError("pinned chain snapshot"); }
  requireValue(Array.isArray(input.pools) && Array.isArray(input.hubs) && Array.isArray(input.evidence), "evidence/infrastructure arrays");
  requireValue(input.evidence.length <= 100_000, "evidence budget");
  const pools = sorted(input.pools.map((item) => address(item, "pool address")));
  const hubs = sorted(input.hubs.map((item) => address(item, "hub address")));
  const coverage = input.coverage;
  requireValue(STATUSES.has(coverage.transfers) && Array.isArray(coverage.funding) && Array.isArray(coverage.warnings), "coverage statuses");
  const eligibleWallets = integer(coverage.eligibleWallets, "eligible wallets");
  const examinedWallets = integer(coverage.examinedWallets, "examined wallets");
  requireValue(examinedWallets <= eligibleWallets, "wallet coverage counts");
  const fundingCoverage = new Map<Address, InvestigationDataset["coverage"]["funding"][number]>();
  const creatorFunding = coverage.creatorFunding ? creatorFundingCoverageSchema.parse(coverage.creatorFunding) : undefined;
  for (const item of coverage.funding) {
    requireValue(item && STATUSES.has(item.status) && item.internalTransfers === "not_examined", "funding coverage status");
    const entry = {
      wallet: address(item.wallet, "funding coverage wallet"),
      status: item.status,
      fromBlock: raw(item.fromBlock, "funding start block"),
      toBlock: raw(item.toBlock, "funding end block"),
      internalTransfers: "not_examined" as const,
      reason: item.reason === null ? null : text(item.reason, "funding coverage reason", 2000),
    };
    requireValue(BigInt(entry.fromBlock) <= BigInt(entry.toBlock) && BigInt(entry.toBlock) <= BigInt(range.to.number), "funding coverage range");
    const prior = fundingCoverage.get(entry.wallet);
    requireValue(!prior || JSON.stringify(prior) === JSON.stringify(entry), "conflicting wallet coverage");
    fundingCoverage.set(entry.wallet, entry);
  }

  const blockIdentities = new Map<string, { hash: Hash; timestamp: number }>();
  const registerBlock = (number: string, identity: { hash: Hash; timestamp: number }) => {
    const existing = blockIdentities.get(number);
    requireValue(!existing || (existing.hash === identity.hash && existing.timestamp === identity.timestamp), "conflicting block identity");
    blockIdentities.set(number, identity);
  };
  registerBlock(range.from.number, range.from);
  registerBlock(range.to.number, range.to);
  const aliases = new Map<string, string>();
  const logicalEvents = new Map<string, string>();
  const transactions = new Map<Hash, string>();
  const positions = new Map<string, Hash>();
  const normalized = input.evidence.map((source) => {
    const event = normalizeEvent(source);
    const n = BigInt(event.blockNumber);
    requireValue(n <= BigInt(range.to.number) && event.timestamp <= range.to.timestamp, "event after pinned range");
    if (event.kind === "funding") {
      const covered = fundingCoverage.get(event.to);
      const coveredByCreator = creatorFunding && ["complete", "partial"].includes(creatorFunding.status) && (creatorFunding.evidenceIds.includes(source.id) || creatorFunding.evidenceIds.includes(event.id)) && event.from === creatorFunding.creator && creatorFunding.cohort.includes(event.to) && n >= BigInt(creatorFunding.fromBlock) && n <= BigInt(creatorFunding.toBlock);
      requireValue(coveredByCreator || covered && covered.status !== "not_examined" && covered.status !== "unavailable" && n >= BigInt(covered.fromBlock) && n <= BigInt(covered.toBlock), "funding outside examined coverage");
      requireValue(event.traceId === null, "internal funding contradicts unexamined trace coverage");
    } else {
      requireValue(n >= BigInt(range.from.number) && event.timestamp >= range.from.timestamp, "token event outside range");
      requireValue(coverage.transfers !== "unavailable" && coverage.transfers !== "not_examined", "token evidence without acquisition");
    }
    registerBlock(event.blockNumber, { hash: event.blockHash, timestamp: event.timestamp });
    const txIdentity = `${event.blockHash}:${event.blockNumber}:${event.transactionIndex}:${event.timestamp}`;
    requireValue(!transactions.has(event.transactionHash) || transactions.get(event.transactionHash) === txIdentity, "conflicting transaction inclusion");
    transactions.set(event.transactionHash, txIdentity);
    const position = `${event.blockHash}:${event.transactionIndex}`;
    requireValue(!positions.has(position) || positions.get(position) === event.transactionHash, "conflicting transaction position");
    positions.set(position, event.transactionHash);
    const logical = `${event.chainId}:${event.transactionHash}:${event.kind === "funding" ? event.traceId === null ? "native" : `trace:${event.traceId}` : `${event.kind === "sale" ? "sale" : "log"}:${event.logIndex}`}`;
    requireValue(!logicalEvents.has(logical) || logicalEvents.get(logical) === event.id, "mixed-fork logical event");
    logicalEvents.set(logical, event.id);
    for (const alias of [source.id, event.id]) {
      requireValue(!aliases.has(alias) || aliases.get(alias) === event.id, "ambiguous source evidence ID");
      aliases.set(alias, event.id);
    }
    return event;
  });
  const orderedBlocks = [...blockIdentities].sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  for (let i = 1; i < orderedBlocks.length; i++) {
    requireValue(orderedBlocks[i - 1][1].timestamp <= orderedBlocks[i][1].timestamp, "nonchronological block timestamps");
  }
  const events = new Map<string, EvidenceRecord>();
  const canonicalSupport = (ids: string[]) => sorted(ids.map((id) => { const canonical = aliases.get(id); requireValue(canonical, "unresolved market supporting evidence"); return canonical; }));
  for (const item of normalized) {
    const event: EvidenceRecord = { ...item, sale: item.sale ? { ...item.sale, supportingEvidenceIds: sorted(item.sale.supportingEvidenceIds.map((id) => {
      const canonical = aliases.get(id);
      requireValue(canonical, "unresolved sale supporting evidence");
      return canonical;
    })) } : null, ...(item.purchase ? { purchase: { ...item.purchase, supportingEvidenceIds: canonicalSupport(item.purchase.supportingEvidenceIds) } } : {}), ...(item.liquidity ? { liquidity: { ...item.liquidity, supportingEvidenceIds: canonicalSupport(item.liquidity.supportingEvidenceIds) } } : {}) };
    const previous = events.get(event.id);
    if (previous) {
      const semantic = (record: EvidenceRecord) => JSON.stringify({ ...record, provenance: undefined });
      requireValue(semantic(previous) === semantic(event), "conflicting repeated event");
      if (JSON.stringify(event.provenance) < JSON.stringify(previous.provenance)) events.set(event.id, event);
    } else events.set(event.id, event);
  }
  if (creatorFunding) creatorFunding.evidenceIds = sorted(creatorFunding.evidenceIds.map((id) => { const canonical = aliases.get(id); requireValue(canonical, "unresolved creator funding evidence"); return canonical; }));
  try { validateMarketAnnotations([...events.values()], normalizedToken.address); validateCreationAnnotations({ token: normalizedToken, range, evidence: [...events.values()] });
    if (creatorFunding) validateCreatorFundingCoverage(creatorFunding, { token: normalizedToken, range, evidence: [...events.values()], walletActivitySnapshot }); }
  catch { throw new AnalysisInputError("market receipt proof"); }
  return {
    token: normalizedToken,
    range,
    pools,
    hubs,
    ...(holderSnapshot ? { holderSnapshot } : {}),
    ...(walletActivitySnapshot ? { walletActivitySnapshot } : {}),
    ...(liquiditySnapshot ? { liquiditySnapshot } : {}),
    evidence: [...events.values()].sort(compareEvents),
    coverage: {
      transfers: coverage.transfers,
      ...(coverage.transferCrawl ? { transferCrawl: validateTransferCrawl(coverage.transferCrawl, range, coverage.transfers) } : {}),
      funding: [...fundingCoverage.values()].sort((a, b) => a.wallet.localeCompare(b.wallet)),
      ...(creatorFunding ? { creatorFunding } : {}),
      eligibleWallets,
      examinedWallets,
      warnings: sorted(coverage.warnings.map((warning) => text(warning, "coverage warning", 2000))),
    },
  };
}

class Components {
  private parents = new Map<Address, Address>();
  find(wallet: Address): Address {
    let root = wallet;
    while (this.parents.has(root) && this.parents.get(root) !== root) root = this.parents.get(root)!;
    this.parents.set(root, root);
    let current = wallet;
    while (current !== root) {
      const parent = this.parents.get(current);
      this.parents.set(current, root);
      if (!parent) break;
      current = parent;
    }
    return root;
  }
  join(a: Address, b: Address) {
    const rootA = this.find(a), rootB = this.find(b);
    if (rootA !== rootB) this.parents.set(rootA < rootB ? rootB : rootA, rootA < rootB ? rootA : rootB);
  }
}

function validateSales(dataset: InvestigationDataset): EvidenceRecord[] {
  const byId = new Map(dataset.evidence.map((event) => [event.id, event]));
  const infrastructure = new Set<string>([ZERO, ...dataset.pools, ...dataset.hubs]);
  const sales = dataset.evidence.filter((event) => event.kind === "sale");
  const annotatedFlows = new Set<string>();
  const annotatedTransactions = new Set<Hash>();
  for (const event of sales) {
    const sale = event.sale!;
    const flowIdentity = `${event.transactionHash}:${event.from}:${event.assetAddress}`;
    requireValue(!annotatedFlows.has(flowIdentity), "repeated sale net-flow annotation");
    annotatedFlows.add(flowIdentity);
    requireValue(!annotatedTransactions.has(event.transactionHash), "multiple sale annotations in one transaction");
    annotatedTransactions.add(event.transactionHash);
    requireValue(event.assetAddress === dataset.token.address && event.amountRaw !== "0", "sale token/amount");
    requireValue(!infrastructure.has(event.from) && event.to === sale.pool && sale.pool !== ZERO && dataset.pools.includes(sale.pool), "sale wallet/pool");
    requireValue(sale.factory !== ZERO && sale.quoteAsset !== ZERO && sale.quoteAsset !== dataset.token.address && sale.quoteAmountRaw !== "0", "sale consideration");
    const support = sale.supportingEvidenceIds.map((id) => byId.get(id)!);
    requireValue(support.every((item) => item && item.kind === "transfer" && item.transactionHash === event.transactionHash && item.blockHash === event.blockHash && (item.assetAddress === dataset.token.address || item.assetAddress === sale.quoteAsset)), "sale supporting transaction/asset");
    const flows = dataset.evidence.filter((item) => item.kind === "transfer" && item.transactionHash === event.transactionHash && (item.assetAddress === dataset.token.address || item.assetAddress === sale.quoteAsset));
    requireValue(!dataset.evidence.some((item) => item.kind === "transfer" && item.transactionHash === event.transactionHash && item.logIndex === sale.swapLogIndex), "swap log conflicts with transfer log");
    const supporting = new Set(sale.supportingEvidenceIds);
    requireValue(flows.length > 0 && flows.every((item) => supporting.has(item.id)), "incomplete sale net-flow evidence");
    const net = (wallet: Address, asset: Address) => flows.filter((item) => item.assetAddress === asset).reduce((sum, item) => sum + (item.to === wallet ? BigInt(item.amountRaw) : 0n) - (item.from === wallet ? BigInt(item.amountRaw) : 0n), 0n);
    const tokenAmount = BigInt(event.amountRaw), quoteAmount = BigInt(sale.quoteAmountRaw);
    requireValue(net(event.from, dataset.token.address) === -tokenAmount && net(event.from, sale.quoteAsset) === quoteAmount && net(sale.pool, dataset.token.address) === tokenAmount && net(sale.pool, sale.quoteAsset) === -quoteAmount, "sale net token/quote flow mismatch");
    const direct = (from: Address, to: Address, asset: Address) => flows.filter((item) => item.from === from && item.to === to && item.assetAddress === asset).reduce((sum, item) => sum + BigInt(item.amountRaw), 0n);
    requireValue(direct(event.from, sale.pool, dataset.token.address) === tokenAmount && direct(sale.pool, event.from, sale.quoteAsset) === quoteAmount, "sale direct consideration path mismatch");
  }
  return sales;
}

/** Pure, deterministic analysis of already-acquired, explicitly bounded evidence. */
export function analyzeInvestigation(
  input: InvestigationDataset,
  options: { id: string; generatedAt: string },
): InvestigationReport {
  const id = text(options?.id, "report ID", 191);
  const generatedAt = iso(options?.generatedAt, "report generation time");
  const dataset = normalizeDataset(input);
  const { evidence, token, range, coverage } = dataset;
  const infrastructure = new Set<string>([ZERO, ...dataset.pools, ...dataset.hubs]);
  const eligible = (wallet: Address) => !infrastructure.has(wallet);
  const transfers = evidence.filter((event) => event.kind === "transfer" && event.assetAddress === token.address);
  const tokenWallets = new Set([...transfers.flatMap((event) => [event.from, event.to]), ...evidence.flatMap((event) => event.creation ? [event.creation.creator] : []), ...(dataset.holderSnapshot?.holders.map((item) => item.address) ?? [])].filter(eligible));
  const funding = evidence.filter((event) => event.kind === "funding" && event.amountRaw !== "0" && event.from !== event.to && event.from !== ZERO && event.to !== ZERO && tokenWallets.has(event.to));
  const sales = validateSales(dataset);
  const qualifyingEdges = evidence.filter((event) => event.amountRaw !== "0" && event.from !== event.to && eligible(event.from) && eligible(event.to) && ((event.kind === "funding" && tokenWallets.has(event.to)) || (event.kind === "transfer" && event.assetAddress === token.address)));
  const connections: InvestigationReport["connections"] = qualifyingEdges.map((event) => ({
    id: `connection:${event.id}`,
    from: event.from,
    to: event.to,
    kind: event.kind === "funding" ? "funding" : "transfer",
    timestamp: event.timestamp,
    evidenceIds: [event.id],
  }));
  const walletAddresses = sorted([...tokenWallets, ...qualifyingEdges.flatMap((event) => [event.from, event.to])]);
  const findings: InvestigationFinding[] = [];
  const add = (finding: Omit<InvestigationFinding, "rule">, name: string, parameters: Record<string, string | number> = {}) => {
    findings.push({ ...finding, wallets: sorted(finding.wallets), evidenceIds: sorted(finding.evidenceIds), limitations: sorted(finding.limitations), rule: { name, version: VERSION, parameters } });
  };
  const fundingBounds = new Map(coverage.funding.map((entry) => [entry.wallet, entry]));
  const firstFunding = new Map<Address, EvidenceRecord>();
  for (const event of funding) if (!firstFunding.has(event.to)) firstFunding.set(event.to, event);
  for (const [wallet, event] of [...firstFunding].sort(([a], [b]) => a.localeCompare(b))) {
    const inbound = fundingBounds.get(wallet);
    const creatorOnly = coverage.creatorFunding?.evidenceIds.includes(event.id) && (!inbound || !["complete", "partial"].includes(inbound.status) || BigInt(event.blockNumber) < BigInt(inbound.fromBlock));
    const bounds = creatorOnly ? { fromBlock: coverage.creatorFunding!.fromBlock, toBlock: coverage.creatorFunding!.toBlock, status: "partial" } : inbound!;
    const knownInfrastructure = infrastructure.has(event.from);
    add({
      id: `funding:${wallet}`,
      category: "funding",
      title: "First observed native funding",
      explanation: `The earliest retrieved native ETH funding for this wallet is from ${event.from}, within funding blocks ${bounds.fromBlock}–${bounds.toBlock}.${knownInfrastructure ? " This source is known infrastructure and is excluded from relationship groups." : " This source's public-service or hub status is unknown."}`,
      confidence: knownInfrastructure && bounds.status === "complete" ? "medium" : "low",
      wallets: [wallet, event.from],
      evidenceIds: [event.id],
      limitations: ["This is first observed funding, not lifetime-first funding.", "Internal native transfers were not examined.", "Funding does not establish common ownership.", ...(creatorOnly ? ["This retained event came from the creator-only external funding query; the recipient's full inbound history was not established."] : []), ...(bounds.status !== "complete" ? ["Funding acquisition is incomplete even within its declared window."] : [])],
    }, "first-observed-native-funding", { fromBlock: bounds.fromBlock, toBlock: bounds.toBlock });
  }
  const fundingSources = new Map<Address, EvidenceRecord[]>();
  for (const event of qualifyingEdges.filter((item) => item.kind === "funding")) {
    if (!fundingSources.has(event.from)) fundingSources.set(event.from, []);
    fundingSources.get(event.from)!.push(event);
  }
  for (const [source, events] of [...fundingSources].sort(([a], [b]) => a.localeCompare(b))) {
    const recipients = sorted(events.map((event) => event.to));
    if (recipients.length < 2) continue;
    add({ id: `shared-funding:${source}`, category: "funding", title: "Shared observed native funding source", explanation: `This address sent native ETH to ${recipients.length} distinct observed token wallets. Its public-service or hub status is unknown, so shared funding supports only a qualified association.`, confidence: "low", wallets: [source, ...recipients], evidenceIds: events.map((event) => event.id), limitations: ["Unlisted exchanges, bridges, and services may fund unrelated users.", "Shared funding does not establish common ownership or coordinated intent.", "Funding observations are bounded and internal transfers were not examined."] }, "shared-observed-native-source");
  }
  for (const event of qualifyingEdges.filter((item) => item.kind === "transfer")) {
    add({ id: `transfer:${event.id}`, category: "connections", title: "Direct token transfer relationship", explanation: "An observed token transfer connects these addresses. Payments, custody, and distribution are alternative explanations; this is not an ownership inference.", confidence: "medium", wallets: [event.from, event.to], evidenceIds: [event.id], limitations: ["A transfer alone does not establish common control or coordinated intent."] }, "direct-token-transfer");
  }
  const components = new Components();
  for (const event of qualifyingEdges) components.join(event.from, event.to);
  const connected = new Map<Address, Address[]>();
  for (const wallet of walletAddresses) {
    const root = components.find(wallet);
    if (!connected.has(root)) connected.set(root, []);
    connected.get(root)!.push(wallet);
  }
  const groups: InvestigationReport["groups"] = [...connected.values()].filter((members) => members.length > 1).sort((a, b) => a[0].localeCompare(b[0])).map((wallets, i) => ({
    id: `group:${i + 1}`,
    wallets,
    evidenceIds: sorted(qualifyingEdges.filter((event) => components.find(event.from) === components.find(wallets[0])).map((event) => event.id)),
    explanation: "Evidence-linked addresses, not verified common owners. Some paths are transitive; unlisted funders have unknown public-service status, and unrelated users can share infrastructure.",
  }));
  for (const group of groups) {
    add({ id: `connections:${group.id}`, category: "connections", title: "Evidence-linked wallet group", explanation: group.explanation, confidence: "low", wallets: group.wallets, evidenceIds: group.evidenceIds, limitations: ["Connected components can include indirect relationships.", "Unknown hubs may connect unrelated users.", "Timing alone never creates a connection."] }, "evidence-linked-component");
  }
  const early = new Set<Address>();
  // Genesis is the search boundary, not the token's first activity.
  const fullCrawl = coverage.transferCrawl?.scope === "full";
  const earlyStart = fullCrawl && transfers.length ? transfers[0].timestamp : range.from.timestamp;
  const earlyEnd = Math.min(range.to.timestamp, earlyStart + WINDOW_SECONDS);
  if (coverage.transfers === "complete") {
    for (const wallet of sorted(tokenWallets)) {
      const events = transfers.filter((event) => (event.from === wallet || event.to === wallet) && event.timestamp < earlyStart + WINDOW_SECONDS);
      const net = events.reduce((sum, event) => sum + (event.to === wallet ? BigInt(event.amountRaw) : 0n) - (event.from === wallet ? BigInt(event.amountRaw) : 0n), 0n);
      if (net <= 0n) continue;
      early.add(wallet);
      add({ id: `accumulation:${wallet}`, category: "accumulation", title: "Accumulation in earliest observed window", explanation: `This wallet received a net ${net} raw token units during the first observed window, starting at ${earlyStart} and ending at ${earlyEnd}. This is not a market-launch window or proof of purchases.`, confidence: "medium", wallets: [wallet], evidenceIds: events.map((event) => event.id), limitations: [fullCrawl ? "The first retained token transfer is an observed reference, not proof of contract deployment, market launch or omission-free indexing." : "Launch time and pre-lookback activity are not established.", "Transfers can be distributions or payments rather than buys.", ...(range.to.timestamp < earlyStart + WINDOW_SECONDS ? ["The observed range ends before a full 600-second window is available."] : [])] }, "observed-window-net-accumulation", { baseline: fullCrawl ? "first-observed-token-transfer" : "range-start", windowSeconds: WINDOW_SECONDS, endExclusive: earlyStart + WINDOW_SECONDS });
    }
  }
  const priorComponents = new Components();
  let edgeIndex = 0;
  const reportedSellerSets = new Set<string>();
  for (let i = 0; i < sales.length; i++) {
    const start = sales[i];
    while (edgeIndex < qualifyingEdges.length && compareEvents(qualifyingEdges[edgeIndex], start) < 0) {
      priorComponents.join(qualifyingEdges[edgeIndex].from, qualifyingEdges[edgeIndex].to);
      edgeIndex++;
    }
    const candidates = new Map<Address, EvidenceRecord[]>();
    for (let j = i; j < sales.length && sales[j].timestamp - start.timestamp <= WINDOW_SECONDS; j++) {
      const event = sales[j], component = priorComponents.find(event.from);
      candidates.set(component, [...(candidates.get(component) ?? []), event]);
    }
    for (const [component, windowSales] of candidates) {
      if (!windowSales.some((event) => event.id === start.id)) continue;
      const sellers = sorted(windowSales.map((event) => event.from));
      if (sellers.length < 2 || reportedSellerSets.has(sellers.join(":"))) continue;
      reportedSellerSets.add(sellers.join(":"));
      const links = qualifyingEdges.slice(0, edgeIndex).filter((event) => priorComponents.find(event.from) === component);
      add({ id: `selling:${reportedSellerSets.size}`, category: "selling", title: "Linked wallets sold within 600 seconds", explanation: `${sellers.length} distinct wallets with relationships observed before the earliest sale have verified net token-out and quote-in sales within a rolling 600-second interval. This describes timing and prior evidence, not coordinated intent.`, confidence: "low", wallets: sellers, evidenceIds: [...links.map((event) => event.id), ...windowSales.flatMap((event) => [event.id, ...event.sale!.supportingEvidenceIds])], limitations: ["A prior relationship and similar sale timing do not prove common ownership, coordination, or manipulation.", "Unknown public-service funders can connect unrelated wallets.", ...(coverage.transfers !== "complete" ? ["Transfer acquisition is partial; other sales may be missing."] : [])] }, "prior-linked-verified-selling", { intervalSeconds: WINDOW_SECONDS, intervalStart: start.timestamp, intervalEndInclusive: start.timestamp + WINDOW_SECONDS });
    }
  }
  const missingFunding = sorted(tokenWallets).filter((wallet) => fundingBounds.get(wallet)?.status !== "complete");
  const warnings = sorted([...coverage.warnings, ...missingFunding.map((wallet) => `Funding coverage for ${wallet} is ${fundingBounds.get(wallet)?.status ?? "not_examined"}.`)]);
  const reportCoverage = { ...coverage, warnings };
  const snapshot = dataset.holderSnapshot;
  const balanceDisclosure = snapshot ? `Pinned finalized balances are verified for ${snapshot.balances.verifiedWallets} of ${snapshot.balances.requestedWallets} discovered candidates at block ${snapshot.block.number}. Latest indexed discovery is not a finalized holder census. Live-current balances and lifetime histories remain unknown.` : "Current balances and lifetime histories are not reconstructed.";
  add({ id: "coverage:window", category: "coverage", title: snapshot ? "Bounded coverage and pinned holder balances" : "Bounded coverage; balances unknown", explanation: `Token transfer coverage is ${coverage.transfers} for blocks ${range.from.number}–${range.to.number}. ${coverage.examinedWallets} of ${coverage.eligibleWallets} eligible wallets were examined for funding; ${missingFunding.length} discovered token participants lack complete funding-window coverage. ${balanceDisclosure}`, confidence: "high", wallets: missingFunding, evidenceIds: [], limitations: [snapshot ? "Only successful pinned balanceOf calls establish balances; missing results are unknown. Percentages use total supply, not an inferred float." : "All balanceRaw values are null; observed net flow is not a current balance.", "Internal native transfers were not examined.", ...warnings] }, "coverage-disclosure", { fromBlock: range.from.number, toBlock: range.to.number, eligibleWallets: coverage.eligibleWallets, examinedWallets: coverage.examinedWallets });
  const pinnedBalances = new Map(snapshot?.holders.map((item) => [item.address, item.balanceRaw]) ?? []);
  const wallets: InvestigationReport["wallets"] = walletAddresses.map((wallet) => {
    const relevant = transfers.filter((event) => event.from === wallet || event.to === wallet);
    const incoming = relevant.reduce((sum, event) => sum + (event.to === wallet ? BigInt(event.amountRaw) : 0n), 0n);
    const outgoing = relevant.reduce((sum, event) => sum + (event.from === wallet ? BigInt(event.amountRaw) : 0n), 0n);
    const seen = evidence.filter((event) => (event.kind === "funding" || event.assetAddress === token.address) && (event.from === wallet || event.to === wallet));
    return { address: wallet, observedIncomingRaw: incoming.toString(), observedOutgoingRaw: outgoing.toString(), observedNetRaw: (incoming - outgoing).toString(), balanceRaw: pinnedBalances.get(wallet) ?? null, verifiedSoldRaw: sales.filter((event) => event.from === wallet).reduce((sum, event) => sum + BigInt(event.amountRaw), 0n).toString(), firstObservedAt: seen.length ? Math.min(...seen.map((event) => event.timestamp)) : null, earlyAccumulator: coverage.transfers === "complete" ? early.has(wallet) : null };
  });
  const byId = new Map(evidence.map((event) => [event.id, event]));
  const story = findings.filter((finding) => finding.category !== "coverage").map((finding) => ({
    id: `story:${finding.id}`,
    timestamp: finding.category === "selling" ? Number(finding.rule.parameters.intervalStart) : Math.min(...finding.evidenceIds.map((item) => byId.get(item)!.timestamp)),
    title: finding.title,
    description: finding.explanation,
    evidenceIds: finding.evidenceIds,
  })).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  return { schemaVersion: 1, id, generatedAt, mode: "live", token, range, coverage: reportCoverage, ...(snapshot ? { holderSnapshot: snapshot } : {}), ...(dataset.walletActivitySnapshot ? { walletActivitySnapshot: dataset.walletActivitySnapshot } : {}), ...(dataset.liquiditySnapshot ? { liquiditySnapshot: dataset.liquiditySnapshot } : {}), infrastructure: { pools: dataset.pools, hubs: dataset.hubs }, summary: `${tokenWallets.size} discovered token participants; ${groups.length} evidence-linked groups; ${findings.filter((finding) => finding.category === "selling").length} qualified linked-wallet selling windows. Transfer coverage: ${coverage.transfers}. Funding examined: ${coverage.examinedWallets}/${coverage.eligibleWallets}. Relationships do not establish ownership. ${snapshot ? `Pinned balances verified: ${snapshot.balances.verifiedWallets}/${snapshot.balances.requestedWallets}; live-current balances remain unknown.` : "Balances remain unknown."}`, wallets, connections, groups, findings, story, evidence };
}
