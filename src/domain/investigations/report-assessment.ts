import type { Address, BlockReference, EvidenceRecord, InvestigationReport, InvestigationFinding } from "./types";
import { validateHolderSnapshot } from "./holder-snapshot";
import { deriveReportDistribution, exactPercent } from "./report-distribution";
import { deriveCreatorAttribution } from "./creator-attribution";
import { validateCreatorFundingCoverage } from "./creator-funding";
import { deriveWalletSignals, verifiedPurchaseProof } from "./wallet-signals";
import { validateLiquiditySnapshot, validateWalletActivitySnapshot } from "./chain-snapshots";
import { tokenSecuritySnapshotSchema } from "./token-security";
import { tokenMarketSnapshotSchema } from "./token-market";
import { deriveRuleWeightedJudge } from "./report-judge";
import { deriveHolderTableDistribution } from "./holder-table-distribution";
import { linearCategoryEarnedPointsFromShare, LOCAL_CATEGORY_SCORE_POLICY, sumCategoryEarnedPoints } from "./report-category-score";

export type AssessmentCategoryId = "swarm" | "fresh" | "insiders" | "concentration" | "snipers" | "dev";

export interface AssessmentCategory {
  id: AssessmentCategoryId;
  label: string;
  possiblePoints: number;
  /** Higher is better. Unknown never earns points; supported concerns earn zero. */
  points: number | null;
  status: "concern" | "measured" | "not_assessed";
  basis: string;
  limitations: string[];
  metric: string | null;
}

export interface AssessmentRule {
  id: string;
  category: AssessmentCategoryId;
  label: string;
  basis: string;
  evidenceIds: string[];
  addresses: Address[];
  /** Balance reads have pinned snapshot provenance, not fabricated event IDs. */
  holderBlock: BlockReference | null;
  deductedPoints: number;
}

export interface ReportAssessment {
  version: "1.4.0";
  overallScore: number | null;
  displayedScore: number;
  scoreRange: { minimum: number; maximum: number };
  band: "DANGER" | "RISKY" | "CLEAN" | "UNKNOWN";
  verdict: "AVOID" | "CAUTION" | "REVIEW" | "OK" | "INSUFFICIENT";
  /** Completion of these disclosed checks, never a full audit or holder census. */
  complete: boolean;
  missingChecks: string[];
  /** Normalized, versioned rule weights; not calibrated outcome probabilities. */
  verdictWeights: { avoid: number; caution: number; ok: number };
  judge: { label: string; summary: string };
  assessedPoints: number;
  assessedPossiblePoints: number;
  possiblePoints: 100;
  categories: AssessmentCategory[];
  holdingBasis: { kind: "wallets" | "eligible-addresses"; denominatorRaw: string | null; denominatorLabel: "float" | "total supply"; holders: number };
  triggeredRules: AssessmentRule[];
  limitations: string[];
  gates: { id: string; severity: "hard" | "soft"; label: string; basis: string; evidenceIds: string[]; sourceUrl?: string }[];
  metrics: { largestSharePercent: string | null; topTenSharePercent: string | null; creatorSharePercent: string | null; dumpImpactPercent: string | null; freshWalletsPercent: string | null; sniperSharePercent: string | null; insiderSharePercent: string | null };
}

const ZERO = `0x${"0".repeat(40)}`;
const RAW = /^(?:0|[1-9][0-9]{0,77})$/;
const positive = (value: string) => RAW.test(value) && BigInt(value) > 0n && BigInt(value) < 2n ** 256n;
const unique = <T extends string>(items: T[]): T[] => [...new Set(items)].sort();

function before(left: EvidenceRecord, right: EvidenceRecord): boolean {
  const a = BigInt(left.blockNumber), b = BigInt(right.blockNumber);
  return a < b || (a === b && (left.transactionIndex < right.transactionIndex
    || (left.transactionIndex === right.transactionIndex && (left.logIndex ?? -1) < (right.logIndex ?? -1))));
}

function supportedSale(event: EvidenceRecord, token: Address, ids: Set<string>, transfers: EvidenceRecord[]): boolean {
  const sale = event.sale;
  if (event.kind !== "sale" || !sale || !["uniswap-v2", "uniswap-v3"].includes(sale.protocol) || event.assetAddress !== token
    || event.to !== sale.pool || [event.from, sale.pool, sale.factory, sale.quoteAsset].includes(ZERO as Address)
    || sale.quoteAsset === token || !positive(event.amountRaw) || !positive(sale.quoteAmountRaw)
    || event.logIndex !== sale.swapLogIndex || !sale.supportingEvidenceIds.length) return false;
  const support = new Set(sale.supportingEvidenceIds);
  const flows = transfers.filter((flow) => flow.assetAddress === token || flow.assetAddress === sale.quoteAsset);
  if (support.size !== sale.supportingEvidenceIds.length || support.size !== flows.length
    || !flows.length || flows.some((flow) => !support.has(flow.id) || !ids.has(flow.id)
      || flow.blockHash !== event.blockHash || flow.logIndex === sale.swapLogIndex || !RAW.test(flow.amountRaw))) return false;
  const net = (wallet: Address, asset: Address) => flows.filter((flow) => flow.assetAddress === asset)
    .reduce((sum, flow) => sum + (flow.to === wallet ? BigInt(flow.amountRaw) : 0n) - (flow.from === wallet ? BigInt(flow.amountRaw) : 0n), 0n);
  const direct = (from: Address, to: Address, asset: Address) => flows.filter((flow) => flow.from === from && flow.to === to && flow.assetAddress === asset)
    .reduce((sum, flow) => sum + BigInt(flow.amountRaw), 0n);
  const amount = BigInt(event.amountRaw), quote = BigInt(sale.quoteAmountRaw);
  return net(event.from, token) === -amount && net(event.from, sale.quoteAsset) === quote
    && net(sale.pool, token) === amount && net(sale.pool, sale.quoteAsset) === -quote
    && direct(event.from, sale.pool, token) === amount && direct(sale.pool, event.from, sale.quoteAsset) === quote;
}

function linkedSellingRule(report: InvestigationReport): AssessmentRule | null {
  const byId = new Map(report.evidence.map((event) => [event.id, event]));
  const transfersByTransaction = new Map<string, EvidenceRecord[]>();
  for (const event of report.evidence) if (event.kind === "transfer") {
    const values = transfersByTransaction.get(event.transactionHash) ?? [];
    values.push(event); transfersByTransaction.set(event.transactionHash, values);
  }
  const candidates = report.findings.filter((finding) => finding.category === "selling"
    && finding.rule.name === "prior-linked-verified-selling" && finding.rule.version === "1.0.0")
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const finding of candidates) {
    const rule = qualifyingSellingFinding(finding, report.token.address, byId, transfersByTransaction);
    if (rule) return rule; // One category deduction; more windows never stack points.
  }
  return null;
}

function qualifyingSellingFinding(
  finding: InvestigationFinding, token: Address, byId: Map<string, EvidenceRecord>, transfersByTransaction: Map<string, EvidenceRecord[]>,
): AssessmentRule | null {
  const ids = new Set(finding.evidenceIds);
  if (!ids.size || ids.size !== finding.evidenceIds.length || [...ids].some((id) => !byId.has(id))) return null;
  const events = [...ids].map((id) => byId.get(id)!);
  const sales = events.filter((event) => event.kind === "sale");
  const sellers = unique(sales.map((event) => event.from));
  if (sellers.length < 2 || sellers.length !== new Set(finding.wallets).size || sellers.some((wallet) => !finding.wallets.includes(wallet))
    || sales.some((event) => !supportedSale(event, token, ids, transfersByTransaction.get(event.transactionHash) ?? []))) return null;
  const start = finding.rule.parameters.intervalStart;
  if (!Number.isSafeInteger(start) || finding.rule.parameters.intervalSeconds !== 600
    || finding.rule.parameters.intervalEndInclusive !== Number(start) + 600
    || sales.some((event) => event.timestamp < Number(start) || event.timestamp > Number(start) + 600)) return null;
  const first = [...sales].sort((a, b) => before(a, b) ? -1 : before(b, a) ? 1 : 0)[0];
  if (first.timestamp !== start) return null;
  const pools = new Set(sales.map((event) => event.sale!.pool));
  const adjacency = new Map<Address, Set<Address>>();
  for (const event of events) {
    if (!before(event, first) || !positive(event.amountRaw) || event.from === event.to
      || event.from === ZERO || event.to === ZERO || pools.has(event.from) || pools.has(event.to)
      || !(event.kind === "funding" && event.assetAddress === null || event.kind === "transfer" && event.assetAddress === token)) continue;
    for (const [from, to] of [[event.from, event.to], [event.to, event.from]]) {
      const neighbors = adjacency.get(from) ?? new Set<Address>(); neighbors.add(to); adjacency.set(from, neighbors);
    }
  }
  const reached = new Set<Address>([sellers[0]]), pending = [sellers[0]];
  for (let index = 0; index < pending.length; index++) for (const next of adjacency.get(pending[index]) ?? []) {
    if (!reached.has(next)) { reached.add(next); pending.push(next); }
  }
  if (sellers.some((wallet) => !reached.has(wallet))) return null;
  return {
    id: "linked-selling-window", category: "swarm", label: "Previously linked wallets sold within 600 seconds",
    basis: `${sellers.length} distinct sellers have retained relationships before the first verified sale, with reconciled token-out and quote-in support inside a 600-second interval. This warrants review; it does not establish coordination or common ownership.`,
    evidenceIds: [...ids].sort(), addresses: sellers, holderBlock: null, deductedPoints: 0,
  };
}

function concentrationRule(report: InvestigationReport, assessedWallets?: Set<Address>): AssessmentRule | null {
  if (!report.holderSnapshot) return null;
  try {
    const snapshot = validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to);
    if (snapshot.totalSupplyRaw === null || !positive(snapshot.totalSupplyRaw)) return null;
    const supply = BigInt(snapshot.totalSupplyRaw);
    // The snapshot also retains infrastructure balances. The analyzer's wallet
    // set excludes authenticated pools, known hubs and zero; do not turn their
    // legitimate custody/liquidity into a concentration concern.
    const eligible = assessedWallets ?? new Set(report.wallets.map((wallet) => wallet.address));
    const qualifying = snapshot.holders.filter((holder) => holder.status === "verified" && holder.address !== ZERO && eligible.has(holder.address)
      && holder.balanceRaw !== null && BigInt(holder.balanceRaw) * 10n >= supply);
    if (!qualifying.length) return null;
    const maximum = qualifying.reduce((balance, holder) => BigInt(holder.balanceRaw!) > balance ? BigInt(holder.balanceRaw!) : balance, 0n);
    const basisPoints = maximum * 10_000n / supply;
    const percent = `${basisPoints / 100n}.${(basisPoints % 100n).toString().padStart(2, "0")}`;
    return {
      id: "observed-address-supply-share", category: "concentration", label: "An eligible examined address holds at least 10% of total supply",
      basis: `${qualifying.length} eligible examined address${qualifying.length === 1 ? "" : "es"} each hold at least 10% of pinned total supply at finalized block ${snapshot.block.number}; the largest observed share is at least ${percent}%. Known infrastructure is excluded. This is a lower bound, not a complete holder ranking or circulating-supply share.`,
      evidenceIds: [], addresses: unique(qualifying.map((holder) => holder.address)), holderBlock: { ...snapshot.block }, deductedPoints: 15,
    };
  } catch { return null; }
}

/** Public category names/weights with independently disclosed local scoring curves and gates. */
export function assessInvestigationReport(report: InvestigationReport): ReportAssessment {
  const broadDistribution = deriveReportDistribution(report);
  const table = deriveHolderTableDistribution(report);
  const walletBasis = table.classificationComplete && table.holders.length > 0;
  const candidateCohortComplete = walletBasis && table.unverifiedBalanceAddresses.length === 0;
  const distribution = walletBasis ? table : broadDistribution;
  const denominator = distribution.holdingDenominatorRaw === null ? null : BigInt(distribution.holdingDenominatorRaw);
  const holders = distribution.holders;
  const triggeredRules = [linkedSellingRule(report), concentrationRule(report, walletBasis ? new Set(holders.map((row) => row.address)) : undefined)].filter((rule): rule is AssessmentRule => rule !== null);
  const percent = (amount: bigint) => denominator === null ? null : exactPercent(amount, denominator);
  const largest = holders[0];
  const largestSharePercent = largest ? percent(BigInt(largest.balanceRaw!)) : null;
  const topTenBalance = holders.slice(0, 10).reduce((sum, row) => sum + BigInt(row.balanceRaw!), 0n);
  const topTenSharePercent = holders.length ? percent(topTenBalance) : null;
  const parsedSecurity = tokenSecuritySnapshotSchema.safeParse(report.token.securitySnapshot);
  const security = parsedSecurity.success && parsedSecurity.data.tokenAddress === report.token.address && parsedSecurity.data.chainId === report.token.chainId ? parsedSecurity.data : null;
  const creatorAttribution = deriveCreatorAttribution(report);
  const creator = creatorAttribution?.address ?? null;
  const creatorHolding = creator ? holders.find((row) => row.address === creator) : null;
  let creatorBalanceRaw: string | null = null;
  try {
    const snapshot = report.holderSnapshot ? validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to) : null;
    const row = creator ? snapshot?.holders.find((holder) => holder.address === creator) : undefined;
    if (row?.status === "verified") creatorBalanceRaw = row.balanceRaw;
  } catch { /* Invalid optional state remains unknown. */ }
  const creatorSharePercent = creatorBalanceRaw !== null ? percent(BigInt(creatorBalanceRaw)) : null;
  const signals = deriveWalletSignals(report);
  const sniperAddresses = new Set(signals.wallets.filter((row) => row.labels.includes("sniper")).map((row) => row.address));
  const sniperBalance = holders.filter((row) => sniperAddresses.has(row.address)).reduce((sum, row) => sum + BigInt(row.balanceRaw!), 0n);
  const sniperSharePercent = signals.initialLiquidity ? percent(sniperBalance) : null;
  let activityRows: NonNullable<InvestigationReport["walletActivitySnapshot"]>["rows"] = [];
  try { activityRows = report.walletActivitySnapshot ? validateWalletActivitySnapshot(report.walletActivitySnapshot, report.range.to).rows : []; } catch { /* Invalid optional context earns no assessment. */ }
  const activity = new Map(activityRows.map((row) => [row.address, row]));
  const activityComplete = holders.length > 0 && holders.every((row) => {
    const state = activity.get(row.address);
    // Known contracts do not satisfy the EOA Fresh rule. Their intentionally
    // absent outgoing count must not erase valid classifications of the sample.
    return state?.code === "contract" || state?.code === "eoa" && state.outgoingTransactionCountRaw !== null;
  });
  // The deploying account has its own Dev category. Its Fresh badge is retained
  // in the holder table, but it is not counted again in this category.
  const freshEligible = holders.filter((row) => row.address !== creator && activity.get(row.address)?.code === "eoa");
  const freshCount = freshEligible.filter((row) => activity.get(row.address)?.outgoingTransactionCountRaw !== null && activity.has(row.address) && BigInt(activity.get(row.address)!.outgoingTransactionCountRaw!) <= 10n).length;
  const freshWalletsPercent = candidateCohortComplete && activityComplete && freshEligible.length > 0 ? exactPercent(BigInt(freshCount), BigInt(freshEligible.length)) : null;
  const insiderAddresses = new Set(signals.wallets.filter((row) => row.labels.includes("insider")).map((row) => row.address));
  let creatorFunding: InvestigationReport["coverage"]["creatorFunding"];
  try { creatorFunding = report.coverage.creatorFunding ? validateCreatorFundingCoverage(report.coverage.creatorFunding, report) : undefined; } catch { /* Invalid source-query coverage cannot establish a zero. */ }
  const creatorFundingComplete = creatorFunding?.status === "complete" && creatorFunding.creator === creator && creatorFunding.fromBlock === "0"
    && holders.filter((row) => row.address !== creator).every((row) => creatorFunding.cohort.includes(row.address));
  const insiderCoverageComplete = Boolean(creator && signals.initialLiquidity && report.coverage.transfers === "complete")
    && holders.some((row) => row.address !== creator) && (creatorFundingComplete || holders.filter((row) => row.address !== creator).every((row) => report.coverage.funding.some((coverage) => coverage.wallet === row.address && coverage.status === "complete" && BigInt(coverage.fromBlock) === 0n && BigInt(coverage.toBlock) >= BigInt(signals.initialLiquidity!.blockNumber))));
  const insiderBalance = holders.filter((row) => insiderAddresses.has(row.address)).reduce((sum, row) => sum + BigInt(row.balanceRaw!), 0n);
  const insiderSharePercent = insiderCoverageComplete ? percent(insiderBalance) : null;
  const gates: ReportAssessment["gates"] = [];
  let dumpImpactPercent: string | null = null;
  let dumpFraction: readonly [bigint, bigint] | null = null;
  let liquidity: InvestigationReport["liquiditySnapshot"];
  try { liquidity = report.liquiditySnapshot ? validateLiquiditySnapshot(report.liquiditySnapshot, report.token.address, report.range.to) : undefined; } catch { /* Invalid reserve context cannot trigger a warning. */ }
  if (largest && liquidity && liquidity.block.number === report.range.to.number && liquidity.block.hash === report.range.to.hash
    && liquidity.block.timestamp === report.range.to.timestamp && liquidity.protocol === "uniswap-v2"
    && report.infrastructure?.pools.includes(liquidity.pool) && [liquidity.token0, liquidity.token1].includes(report.token.address)
    && BigInt(liquidity.reserve0Raw) > 0n && BigInt(liquidity.reserve1Raw) > 0n) {
    const reserve = BigInt(liquidity.token0 === report.token.address ? liquidity.reserve0Raw : liquidity.reserve1Raw);
    const amount = BigInt(largest.balanceRaw!);
    const afterSquared = (reserve + amount) ** 2n, reserveSquared = reserve ** 2n;
    dumpImpactPercent = exactPercent(afterSquared - reserveSquared, afterSquared);
    dumpFraction = [afterSquared - reserveSquared, afterSquared];
    if (afterSquared >= 2n * reserveSquared) {
      const basis = `Selling the largest examined address's entire pinned holding into authenticated pool ${liquidity.pool} gives a modeled spot-price drop of ${dumpImpactPercent}% under the no-fee constant-product formula 1 − reserve²/(reserve + amount)². This hypothetical model ignores fees, taxes, arbitrage, other pools and execution restrictions; a wallet link does not prove ownership.`;
      gates.push({ id: "dump-impact", severity: "hard", label: `Modeled dump impact ${dumpImpactPercent}%`, basis, evidenceIds: [] });
      triggeredRules.push({ id: "modeled-dump-impact", category: "swarm", label: "Largest examined holding could move the modeled pool price by at least 50%", basis,
        evidenceIds: [], addresses: [largest.address, liquidity.pool], holderBlock: { ...liquidity.block }, deductedPoints: 30 });
    }
  }
  // Keep excluded contracts in a separately identified risk lane. The primary
  // wallet metric must use the same cohort as Top holders and default bubbles.
  if (walletBasis && table.contractHolders.length) {
    const contract = table.contractHolders[0];
    const total = report.holderSnapshot?.totalSupplyRaw;
    const share = total ? exactPercent(BigInt(contract.balanceRaw!), BigInt(total)) : null;
    if (share !== null && Number(share) >= 10) gates.push({ id: "contract-concentration", severity: "soft", label: `Contract holds ${share}% of total supply`, basis: "Separate pinned contract balance, excluded from wallet Float and retained in risk checks. Deployed code does not establish ownership, a locker role or whether these tokens can be sold.", evidenceIds: [] });
    if (liquidity?.protocol === "uniswap-v2" && report.infrastructure?.pools.includes(liquidity.pool)
      && BigInt(liquidity.reserve0Raw) > 0n && BigInt(liquidity.reserve1Raw) > 0n) {
      const reserve = BigInt(liquidity.token0 === report.token.address ? liquidity.reserve0Raw : liquidity.reserve1Raw);
      if (reserve > 0n) {
        const afterSquared = (reserve + BigInt(contract.balanceRaw!)) ** 2n;
        const impact = exactPercent(afterSquared - reserve ** 2n, afterSquared);
        if (afterSquared >= 2n * reserve ** 2n) gates.push({ id: "contract-dump-impact", severity: "hard", label: `Contract modeled dump impact ${impact}%`, basis: "Separate hypothetical sale of the largest excluded contract holding against the pinned authenticated V2 pool. This is not the wallet-based dump metric, an executable quote or proof the contract can sell.", evidenceIds: [] });
      }
    }
  }
  if (freshWalletsPercent !== null && Number(freshWalletsPercent) >= 80) gates.push({ id: "fresh-wallets", severity: "hard", label: `${freshWalletsPercent}% Fresh wallets`, basis: "At least 80% of examined positive noncreator EOA holders have a pinned outgoing nonce at most 10. This is not their lifetime all-transaction count or proof of common control.", evidenceIds: [] });
  if (creatorHolding && denominator && BigInt(creatorHolding.balanceRaw!) * 10n >= denominator) {
    const basis = `The ${creatorAttribution!.kind === "direct-contract-creation" ? "receipt-backed direct deployer" : "GoPlus-reported creator"} holds ${creatorSharePercent}% of ${distribution.holdingDenominatorLabel} in pinned balance reads. ${creatorAttribution!.basis} Creator-funded wallet holdings are not added without a complete attribution rule.`;
    gates.push({ id: "creator-holding", severity: "soft", label: `Creator holds ${creatorSharePercent}% of ${distribution.holdingDenominatorLabel}`, basis, evidenceIds: creatorAttribution!.evidenceIds, sourceUrl: creatorAttribution!.sourceUrl });
    triggeredRules.push({ id: "creator-holding", category: "dev", label: `Creator holding is at least 10% of ${distribution.holdingDenominatorLabel}`, basis, evidenceIds: creatorAttribution!.evidenceIds, addresses: [creatorHolding.address], holderBlock: { ...report.range.to }, deductedPoints: 10 });
  }
  const parsedMarket = tokenMarketSnapshotSchema.safeParse(report.token.marketSnapshot);
  const market = parsedMarket.success && parsedMarket.data.sourceUrl === `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}` ? parsedMarket.data : null;
  if (market?.status === "reported" && market.liquidityUsd !== null && market.liquidityUsd < 10_000) gates.push({
    id: "thin-liquidity", severity: "soft", label: `Thin liquidity ($${market.liquidityUsd.toFixed(2)})`,
    basis: "DEX Screener's latest selected pair reports liquidity below the local $10,000 review threshold. This is source-reported pair context, not total liquidity or executable depth.", evidenceIds: [], sourceUrl: market.sourceUrl,
  });
  if (security?.status === "reported") for (const [id, label] of [["is_honeypot", "Honeypot flag"], ["owner_change_balance", "Owner can change balances"], ["transfer_pausable", "Transfers can be paused"]] as const) {
    if (security.checks.some((row) => row.id === id && row.value === "yes")) gates.push({ id, severity: "hard", label: `GoPlus: ${label}`, basis: `GoPlus reports ${id}=yes. This is a third-party warning, not an independently reproduced contract audit.`, evidenceIds: [], sourceUrl: security.sourceUrl });
  }
  const definitions: { id: AssessmentCategoryId; label: string; possiblePoints: number; metric: string | null; basis: string; limitations: string[] }[] = [
    { id: "swarm", label: "Swarm", possiblePoints: 30, metric: dumpImpactPercent === null ? null : `${dumpImpactPercent}% modeled drop`, basis: "Hypothetical largest-address sale against pinned authenticated pool reserves.", limitations: ["Uses a no-fee constant-product model, not a quoted executable trade.", "Groups describe observed relationships, not common owners."] },
    { id: "fresh", label: "Fresh", possiblePoints: 20, metric: freshWalletsPercent === null ? null : `${freshWalletsPercent}% of examined noncreator EOAs`, basis: "Share of positive noncreator EOA holders with at most 10 outgoing transactions at the pinned block. The creator retains its Fresh badge but is assessed separately under Dev; unavailable account state stays unknown.", limitations: ["RPC transaction count measures outgoing nonce, not all incoming transfers or account creation time.", "The creator exclusion is a disclosed local scoring convention; the reference's full conversion is undisclosed."] },
    { id: "insiders", label: "Insiders", possiblePoints: 15, metric: insiderSharePercent === null ? null : `${insiderSharePercent}% observed creator-sourced pre-liquidity holdings`, basis: "Receipt-backed direct creator funding or token receipts before authenticated initial liquidity. Positive credits require a completed genesis-range token search and either completed recipient funding searches or a completed direct-creator external-native query covering every examined wallet.", limitations: ["A transfer or funding link does not identify an insider or prove common control.", "Unexamined native funding never becomes a verified zero insider share.", "A completed creator query covers only this direct source and declared cohort; it does not establish complete recipient histories or exclude index omissions, internal transfers or indirect connections."] },
    { id: "concentration", label: "Concentration", possiblePoints: 15, metric: topTenSharePercent === null ? null : `${topTenSharePercent}% top 10 examined`, basis: "Pinned balances of the ten largest examined wallets using the same denominator as Top holders; contract concentration remains a separate warning.", limitations: ["The local linear curve reaches zero points at 50% examined top-10 share.", "Discovery is not a complete holder census; the reference's component conversion curve is undisclosed."] },
    { id: "snipers", label: "Snipers", possiblePoints: 10, metric: sniperSharePercent === null ? null : `${sniperSharePercent}% held by flagged wallets`, basis: "Receipt-supported buys in the first minute after a proven initial liquidity mint in the acquired full history.", limitations: ["This is relative to retained authenticated pool liquidity, not proof of the earliest trading venue anywhere.", "Unsupported routes remain unclassified; an unflagged wallet is not proven to have bought later."] },
    { id: "dev", label: "Dev", possiblePoints: 10, metric: creatorSharePercent === null ? null : `${creatorSharePercent}% creator holding`, basis: "Pinned holding of the attributed creator; direct receipt-backed deployment takes precedence over GoPlus-reported attribution. Neither establishes present control.", limitations: ["Developer identity, privileged control and exhaustive creator-funded holdings remain unverified."] },
  ];
  const sniperEntriesComplete = walletBasis && Boolean(signals.initialLiquidity) && holders.every((row) => {
    const entry = signals.wallets.find((signal) => signal.address === row.address)?.entry;
    if (entry?.kind === "mint") return true;
    if (entry?.kind !== "buy") return false;
    const event = report.evidence.find((event) => event.kind === "transfer" && event.to === row.address && event.transactionHash === entry.transactionHash && event.assetAddress === report.token.address && event.purchase);
    const purchase = event ? verifiedPurchaseProof(report, event) : null;
    return purchase?.protocol === "uniswap-v2" && purchase.pool === signals.initialLiquidity!.pool && purchase.factory === signals.initialLiquidity!.factory;
  });
  const fraction = (available: boolean, amount: bigint): readonly [bigint, bigint] | null => available && denominator !== null ? [amount, denominator] : null;
  const risks: Record<AssessmentCategoryId, readonly [bigint, bigint] | null> = {
    swarm: dumpFraction,
    fresh: freshWalletsPercent === null ? null : [BigInt(freshCount), BigInt(freshEligible.length)],
    insiders: fraction(insiderSharePercent !== null, insiderBalance),
    concentration: fraction(topTenSharePercent !== null, topTenBalance),
    snipers: fraction(sniperEntriesComplete && sniperSharePercent !== null, sniperBalance),
    dev: fraction(creatorSharePercent !== null, BigInt(creatorBalanceRaw ?? "0")),
  };
  const categories: AssessmentCategory[] = definitions.map((definition) => {
    const measuredPoints = linearCategoryEarnedPointsFromShare(risks[definition.id], definition.possiblePoints, LOCAL_CATEGORY_SCORE_POLICY.saturationPercent[definition.id]);
    // Unread candidate balances may hide a larger or flagged holding. A known
    // balance lower bound can establish a saturated concern, never favorable
    // cohort credits. Dev is a specific verified creator balance, not a census.
    const points = candidateCohortComplete || definition.id === "dev" || measuredPoints === 0
      ? measuredPoints : null;
    return { ...definition, points, status: points === null ? "not_assessed" : points === 0 ? "concern" : "measured",
      basis: `${definition.basis} Local curve: ${definition.possiblePoints} × max(0, 1 − measured percentage / ${LOCAL_CATEGORY_SCORE_POLICY.saturationPercent[definition.id]}%), rounded to one decimal. Favorable cohort credits require all discovered eligible balances and account types; a saturated balance-based concern can be established by known holdings alone.` };
  });
  // A warning is proof for a category, not an additional stackable deduction.
  // Keep the legacy evidence field consistent with the actual local ledger.
  for (const rule of triggeredRules) {
    const category = categories.find((row) => row.id === rule.category)!;
    rule.deductedPoints = category.points === null || rule.id === "linked-selling-window"
      ? 0 : (category.possiblePoints * 10 - Math.round(category.points * 10)) / 10;
  }
  const score = sumCategoryEarnedPoints(categories);
  const assessedPossiblePoints = categories.reduce((sum, category) => sum + (category.points === null ? 0 : category.possiblePoints), 0);
  const hard = gates.some((gate) => gate.severity === "hard"), soft = gates.some((gate) => gate.severity === "soft");
  const maximum = Math.min(score.scoreRange.maximum, soft ? 59 : 100);
  const minimum = Math.min(score.scoreRange.minimum, maximum);
  const missingChecks = categories.filter((category) => category.points === null).map((category) => category.label);
  for (const [id, label] of [["is_honeypot", "Selling restrictions"], ["owner_change_balance", "Administrator balance controls"], ["transfer_pausable", "Transfer pause controls"]] as const) {
    if (security?.status !== "reported" || !security.checks.some((check) => check.id === id && check.value !== "unknown")) missingChecks.push(label);
  }
  if (market?.status !== "reported" || market.liquidityUsd === null) missingChecks.push("Reported trading-pool liquidity");
  const complete = missingChecks.length === 0;
  const measuredConcern = categories.some((category) => category.status === "concern");
  const verdict = hard ? "AVOID" : soft ? "CAUTION" : triggeredRules.length || measuredConcern ? "REVIEW" : complete ? "OK" : "INSUFFICIENT";
  const assessment: ReportAssessment = {
    version: "1.4.0", overallScore: score.complete ? Math.round(minimum) : null, displayedScore: Math.round(minimum), scoreRange: { minimum, maximum }, band: hard ? "DANGER" : soft ? "RISKY" : verdict === "OK" ? "CLEAN" : "UNKNOWN", verdict, complete, missingChecks, verdictWeights: { avoid: 0, caution: 0, ok: 0 },
    judge: {
      label: hard ? "A hard warning rule triggered" : soft ? "Review the creator, market and contract warnings" : triggeredRules.length || measuredConcern ? "Review the observed concerns" : complete ? "No major warning found in the completed checks" : "Evidence is insufficient for a complete assessment",
      summary: `${score.earnedPoints} earned category points from ${assessedPossiblePoints}/100 assessed weight. Unassessed categories earn 0 without becoming absent findings. The possible score is ${minimum}–${maximum}, including warning caps. Local scoring curves and normalized decision weights are disclosed rules, not calibrated probabilities.`,
    },
    assessedPoints: score.earnedPoints,
    assessedPossiblePoints,
    possiblePoints: 100, categories, triggeredRules,
    holdingBasis: { kind: walletBasis ? "wallets" : "eligible-addresses", denominatorRaw: distribution.holdingDenominatorRaw, denominatorLabel: distribution.holdingDenominatorLabel, holders: holders.length },
    gates, metrics: { largestSharePercent, topTenSharePercent, creatorSharePercent, dumpImpactPercent, freshWalletsPercent, sniperSharePercent, insiderSharePercent },
    limitations: ["Published category weights: Swarm 30, Fresh 20, Insiders 15, Concentration 15, Snipers 10, Dev 10. The reference's undisclosed curves, exclusions and Judge masses are not reproduced.", "The displayed category points are earned evidence credits. Unassessed categories display 0 earned points; their measurements stay unknown where unavailable and their possible points remain in the score range.", "The published creator/thin-liquidity soft gate caps the upper bound at 59. The numeric thin-liquidity and concentration thresholds here are disclosed local conventions.", "Decision percentages are normalized TraceForce rule weights, not measured probabilities of a token being safe or unsafe. Missing category evidence contributes to caution, never OK.", distribution.definition, "Rule labels describe observed or modeled warnings, not verified owners, calibrated outcomes or a contract audit."],
  };
  assessment.verdictWeights = deriveRuleWeightedJudge(assessment).weights;
  return assessment;
}
