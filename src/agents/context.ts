import { z } from "zod";
import type { InvestigationReport } from "@/domain/investigations/types";
import type { AiConfiguration } from "./config";
import { ON_CHAIN_INVESTIGATOR } from "./profiles";
import { TOKEN_SECURITY_CHECKS, tokenSecuritySnapshotSchema } from "@/domain/investigations/token-security";
import { tokenMarketSnapshotSchema } from "@/domain/investigations/token-market";
import { validateHolderSnapshot } from "@/domain/investigations/holder-snapshot";
import { validateTransferCrawl } from "@/domain/investigations/transfer-crawl";
import { creationAnnotationSchema, validateCreationAnnotations } from "@/domain/investigations/creator-attribution";
import { deriveHolderTableDistribution } from "@/domain/investigations/holder-table-distribution";
import { assessInvestigationReport } from "@/domain/investigations/report-assessment";

export class InvestigatorContextError extends Error {
  constructor(public readonly code: "INVALID_CONTEXT" | "CONTEXT_LIMIT") { super(code); }
}
const text = (maximum: number) => z.string().min(1).max(maximum).refine((value) => Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value));
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const status = z.enum(["complete", "partial", "unavailable", "not_examined"]);
const sourceStatus = z.enum(["reported", "not_listed", "unavailable"]);
const count = z.number().int().nonnegative().safe();
const positiveAmount = z.string().regex(/^[1-9][0-9]{0,77}$/).refine((value) => BigInt(value) < 2n ** 256n);
const percent = z.string().regex(/^(?:100\.00|(?:0|[1-9][0-9]?)\.[0-9]{2})$/).nullable();
const assessmentCategory = z.enum(["swarm", "fresh", "insiders", "concentration", "snipers", "dev"]);
const scorePoints = z.number().finite().min(0).max(100);
export const assessmentContextSchema = z.object({
  model: z.literal("traceforce-judge-1.0.0"), ruleVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).max(24),
  earnedScore: scorePoints, displayedScore: z.number().int().min(0).max(100).optional(), scoreRange: z.object({ minimum: scorePoints, maximum: scorePoints }).strict(),
  verdict: z.enum(["AVOID", "CAUTION", "REVIEW", "INSUFFICIENT"]), assessedPossiblePoints: scorePoints, possiblePoints: z.literal(100),
  weights: z.object({ avoid: z.number().finite().min(0).max(1), caution: z.number().finite().min(0).max(1), ok: z.number().finite().min(0).max(1) }).strict(),
  categories: z.array(z.object({ id: assessmentCategory, points: scorePoints.nullable(), possiblePoints: scorePoints }).strict()).length(6),
  gates: z.array(z.object({ label: text(160), basis: text(200), authority: z.enum(["hypothetical", "source-reported", "pinned-balance", "source-reported-attribution"]) }).strict()).max(12),
  rawStats: z.object({ largestSharePercent: percent, topTenSharePercent: percent, creatorSharePercent: percent, dumpImpactPercent: percent, freshWalletsPercent: percent, sniperSharePercent: percent, insiderSharePercent: percent.optional() }).strict(),
}).strict().superRefine((assessment, context) => {
  const possible = assessment.categories.reduce((sum, row) => sum + row.possiblePoints, 0);
  const assessed = assessment.categories.filter((row) => row.points !== null);
  if (new Set(assessment.categories.map((row) => row.id)).size !== 6 || possible !== 100
    || assessment.categories.some((row) => row.points !== null && row.points > row.possiblePoints)
    || assessed.reduce((sum, row) => sum + row.possiblePoints, 0) !== assessment.assessedPossiblePoints
    || Math.abs(assessed.reduce((sum, row) => sum + row.points!, 0) - assessment.earnedScore) > 1e-8
    || assessment.displayedScore !== undefined && assessment.displayedScore !== Math.round(assessment.scoreRange.minimum)
    || assessment.scoreRange.minimum > assessment.scoreRange.maximum
    || Math.abs(assessment.weights.avoid + assessment.weights.caution + assessment.weights.ok - 1) > 1e-8) context.addIssue({ code: "custom", message: "Inconsistent deterministic assessment metadata." });
});
export const sourceContextSchema = z.object({
  security: z.object({ source: z.literal("GoPlus"), status: sourceStatus, checkedAt: z.iso.datetime(), holderCount: count.nullable(), checks: z.array(z.object({ id: z.enum(TOKEN_SECURITY_CHECKS), value: z.enum(["yes", "no", "unknown"]) }).strict()).max(TOKEN_SECURITY_CHECKS.length) }).strict().optional(),
  balances: z.object({ source: z.literal("Base RPC"), blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).max(30), blockTimestamp: count, verifiedCandidates: count, requestedCandidates: count, status, discoveryProvider: z.enum(["GoPlus", "Blockscout"]), discoveryStatus: status, finalizedCensus: z.literal(false) }).strict().optional(),
  walletTable: z.object({ source: z.literal("Base RPC"), blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/).max(30), blockTimestamp: count,
    walletRows: count, contractRows: count, unclassifiedRows: count, unrepresentedPositiveCandidates: count, unknownBalanceCandidates: count,
    classificationComplete: z.boolean(), contractSupplySharePercent: z.string().regex(/^(?:100\.00|(?:0|[1-9][0-9]?)\.[0-9]{2})$/).nullable(),
    holdingDenominatorRaw: positiveAmount.nullable(), holdingDenominatorLabel: z.enum(["float", "total supply"]), definition: text(1000), finalizedCensus: z.literal(false),
  }).strict().optional(),
  market: z.object({ source: z.literal("DEXScreener"), status: sourceStatus, checkedAt: z.iso.datetime(), priceUsd: z.string().regex(/^(?:0|[1-9][0-9]{0,35})(?:\.[0-9]{1,60})?$/).max(100).nullable(), liquidityUsd: z.number().finite().min(0).max(1e18).nullable(), marketCapUsd: z.number().finite().min(0).max(1e18).nullable(), volume24hUsd: z.number().finite().min(0).max(1e18).nullable() }).strict().optional(),
  assessment: assessmentContextSchema.optional(),
}).strict().superRefine((value, context) => {
  const security = value.security, balances = value.balances, market = value.market, table = value.walletTable;
  if ((security && (new Set(security.checks.map((check) => check.id)).size !== security.checks.length || (security.status !== "reported" && (security.holderCount !== null || security.checks.length))))
    || (balances && balances.verifiedCandidates > balances.requestedCandidates)
    || (market && market.status !== "reported" && [market.priceUsd, market.liquidityUsd, market.marketCapUsd, market.volume24hUsd].some((value) => value !== null))
    || (table && (!balances || table.blockNumber !== balances.blockNumber || table.blockTimestamp !== balances.blockTimestamp
      || table.walletRows + table.contractRows + table.unclassifiedRows + table.unrepresentedPositiveCandidates > balances.verifiedCandidates
      || table.unknownBalanceCandidates > balances.requestedCandidates - balances.verifiedCandidates
      || (table.classificationComplete && (table.unclassifiedRows > 0 || table.unrepresentedPositiveCandidates > 0))
      || (table.holdingDenominatorLabel === "float" && (!table.classificationComplete || table.unknownBalanceCandidates > 0 || table.holdingDenominatorRaw === null))))) context.addIssue({ code: "custom", message: "Inconsistent source metadata." });
});
export type ReportSourceContext = z.infer<typeof sourceContextSchema>;

function reportSourceContext(report: InvestigationReport): ReportSourceContext | undefined {
  const context: ReportSourceContext = {};
  try {
    if (report.token.securitySnapshot) {
      const security = tokenSecuritySnapshotSchema.parse(report.token.securitySnapshot);
      if (security.tokenAddress !== report.token.address || security.chainId !== report.token.chainId) throw new Error();
      context.security = { source: "GoPlus", status: security.status, checkedAt: security.checkedAt, holderCount: security.holderCount, checks: security.checks };
    }
    if (report.holderSnapshot) {
      const snapshot = validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to);
      context.balances = { source: "Base RPC", blockNumber: snapshot.block.number, blockTimestamp: snapshot.block.timestamp, verifiedCandidates: snapshot.balances.verifiedWallets, requestedCandidates: snapshot.balances.requestedWallets, status: snapshot.balances.status, discoveryProvider: snapshot.discovery.provider, discoveryStatus: snapshot.discovery.status, finalizedCensus: false };
      const table = deriveHolderTableDistribution(report);
      context.walletTable = { source: "Base RPC", blockNumber: snapshot.block.number, blockTimestamp: snapshot.block.timestamp,
        walletRows: table.holders.length, contractRows: table.contractHolders.length, unclassifiedRows: table.unclassifiedHolders.length,
        unrepresentedPositiveCandidates: table.unrepresentedAddresses.length, unknownBalanceCandidates: table.unverifiedBalanceAddresses.length,
        classificationComplete: table.classificationComplete, contractSupplySharePercent: table.contractSupplySharePercent,
        holdingDenominatorRaw: table.holdingDenominatorRaw, holdingDenominatorLabel: table.holdingDenominatorLabel,
        definition: `${table.definition} A contract holding is a token balance at an address with deployed code at the pinned block; EOA rows have empty account code. Account code alone does not show who controls the balance or whether it is locked.`, finalizedCensus: false };
    }
    if (report.token.marketSnapshot) {
      const market = tokenMarketSnapshotSchema.parse(report.token.marketSnapshot);
      if (market.sourceUrl !== `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`) throw new Error();
      context.market = { source: "DEXScreener", status: market.status, checkedAt: market.checkedAt, priceUsd: market.priceUsd, liquidityUsd: market.liquidityUsd, marketCapUsd: market.marketCapUsd, volume24hUsd: market.volume24hUsd };
    }
    return Object.keys(context).length ? sourceContextSchema.parse(context) : undefined;
  } catch { throw new InvestigatorContextError("INVALID_CONTEXT"); }
}

/** Optional signed chat-only rule context; never competes with complete finding proofs. */
export function createAssessmentSourceContext(report: InvestigationReport): NonNullable<ReportSourceContext["assessment"]> {
  const assessment = assessInvestigationReport(report);
  return assessmentContextSchema.parse({ model: "traceforce-judge-1.0.0", ruleVersion: assessment.version, earnedScore: assessment.assessedPoints, displayedScore: assessment.displayedScore, scoreRange: assessment.scoreRange,
    verdict: assessment.verdict, assessedPossiblePoints: assessment.assessedPossiblePoints, possiblePoints: assessment.possiblePoints,
    weights: assessment.verdictWeights, categories: assessment.categories.map(({ id, points, possiblePoints }) => ({ id, points, possiblePoints })),
    rawStats: { largestSharePercent: assessment.metrics.largestSharePercent, topTenSharePercent: assessment.metrics.topTenSharePercent,
      creatorSharePercent: assessment.metrics.creatorSharePercent, dumpImpactPercent: assessment.metrics.dumpImpactPercent,
      freshWalletsPercent: assessment.metrics.freshWalletsPercent, sniperSharePercent: assessment.metrics.sniperSharePercent, insiderSharePercent: assessment.metrics.insiderSharePercent },
    gates: assessment.gates.map((gate) => gate.id.includes("dump-impact")
      ? { label: gate.label, authority: "hypothetical", basis: "Hypothetical no-fee constant-product sale using pinned holdings and authenticated reserves; ignores fees, taxes and execution restrictions." }
      : gate.id === "creator-holding"
        ? { label: gate.label, authority: gate.sourceUrl ? "source-reported-attribution" : "pinned-balance", basis: "Pinned balance of an attributed creator; attribution can be source-reported and does not establish present control." }
        : gate.id === "thin-liquidity"
          ? { label: gate.label, authority: "source-reported", basis: "DEX Screener selected-pair liquidity below the local review threshold; not total liquidity or executable depth." }
          : ["is_honeypot", "owner_change_balance", "transfer_pausable"].includes(gate.id)
            ? { label: gate.label, authority: "source-reported", basis: "Third-party GoPlus warning flag; not an independently reproduced contract audit or proof of ownership." }
            : { label: gate.label, authority: "pinned-balance", basis: "A local warning derived from the report's pinned snapshot. It does not establish a person, shared control or token accessibility." }),
  });
}
const block = z.object({ number: z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(30), hash, timestamp: z.number().int().nonnegative().safe() });
const evidenceSchema = z.object({
  id: text(255), kind: z.enum(["transfer", "funding", "sale"]), chainId: z.literal(8453),
  blockNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(30), blockHash: hash, transactionHash: hash,
  logIndex: z.number().int().nonnegative().safe().nullable(),
  timestamp: z.number().int().nonnegative().safe(), from: address, to: address,
  assetAddress: address.nullable(), amountRaw: z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/).refine((value) => BigInt(value) < 2n ** 256n),
  sale: z.object({ pool: address, factory: address, protocol: z.enum(["uniswap-v2", "uniswap-v3"]), quoteAsset: address, quoteAmountRaw: z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/).refine((value) => BigInt(value) < 2n ** 256n), supportingEvidenceIds: z.array(text(255)).min(1).max(1000) }).nullable(),
  creation: creationAnnotationSchema.optional(),
});
const findingSchema = z.object({ id: text(255), category: z.enum(["funding", "connections", "accumulation", "selling"]), explanation: text(1000), limitations: z.array(text(500)).min(1).max(10), evidenceIds: z.array(text(255)).min(1), rule: z.object({ name: text(100) }).optional() });
type Finding = z.infer<typeof findingSchema>;
const categories = ["selling", "funding", "accumulation", "connections"] as const;
type OmissionReason = "category_limit" | "evidence_limit" | "context_limit" | "citation_limit";

/** Whole findings and sale proofs are selected atomically; never truncate their support. */
export function createInvestigatorContext(report: InvestigationReport, config: AiConfiguration) {
  try { validateCreationAnnotations(report); } catch { throw new InvestigatorContextError("INVALID_CONTEXT"); }
  if (!Array.isArray(report?.coverage?.warnings) || !Array.isArray(report?.coverage?.funding) || !Array.isArray(report?.findings)) throw new InvestigatorContextError("INVALID_CONTEXT");
  const warningList = report.coverage.warnings;
  const warnings = [...new Set(warningList.filter((warning) => warning.length <= 500 && !/^Funding coverage for 0x[0-9a-f]{40} is (?:complete|partial|unavailable|not_examined)\.$/i.test(warning)))].slice(0, 4);
  const parsedBase = z.object({ reportId: text(255), chainId: z.literal(8453), token: z.object({ address, decimals: z.number().int().min(0).max(255).nullable() }), range: z.object({ from: block, to: block, finality: z.literal("finalized") }), coverage: z.object({ transfers: status, eligibleWallets: z.number().int().nonnegative(), examinedWallets: z.number().int().nonnegative(), warnings: z.array(text(500)).max(4), omittedWarnings: z.number().int().nonnegative() }) }).safeParse({
    reportId: report.id, chainId: report.token?.chainId, token: report.token, range: report.range,
    coverage: { ...report.coverage, warnings, omittedWarnings: warningList.length - warnings.length },
  });
  const parsedEvidence = z.array(evidenceSchema).safeParse(report.evidence);
  const parsedFindings = z.array(findingSchema).safeParse(report.findings.filter((finding) => finding.category !== "coverage"));
  if (!parsedBase.success || !parsedEvidence.success || !parsedFindings.success) throw new InvestigatorContextError("INVALID_CONTEXT");
  const base = parsedBase.data, evidence = parsedEvidence.data, findings = parsedFindings.data;
  const sourceContext = reportSourceContext(report);
  let crawl: InvestigationReport["coverage"]["transferCrawl"];
  try { if (report.coverage.transferCrawl) crawl = validateTransferCrawl(report.coverage.transferCrawl, report.range, report.coverage.transfers); }
  catch { throw new InvestigatorContextError("INVALID_CONTEXT"); }
  const dossier = {
    retainedEvents: { nativeFunding: evidence.filter((record) => record.kind === "funding").length, tokenTransfers: evidence.filter((record) => record.kind === "transfer" && record.assetAddress === base.token.address).length, verifiedSales: evidence.filter((record) => record.kind === "sale").length },
    ...(crawl ? { crawl: { scope: crawl.scope, source: crawl.source, completedRanges: crawl.completedRanges.length } } : {}),
    authority: { sourceFacts: "Retained on-chain observations; omitted evidence or findings never prove absent activity.",
      ...(sourceContext?.balances ? { balances: "Pinned candidate balanceOf calls; not a holder census." } : {}),
      ...(sourceContext?.walletTable ? { walletTable: "Derived from pinned balances/account code: main EOA rows and wallet Float, separate contracts/unclassified rows. Wallet Float is shared by default bubbles and wallet-based score metrics; separate contract supply shares remain in risk checks. Row counts are not a holder census; a differing GoPlus count is a source/snapshot discrepancy, not verified absence." } : {}),
      ...(sourceContext?.security ? { security: "GoPlus source-reported context; not receipt-backed findings." } : {}),
      ...(sourceContext?.market ? { market: "DEX Screener source-reported latest context; not pinned chain evidence." } : {}),
      ...(sourceContext ? { agreement: "Different sources or agreeing values do not establish independent corroboration." } : {}),
    },
  };
  const byId = new Map(evidence.map((record) => [record.id, record]));
  if (byId.size !== evidence.length || new Set(findings.map((finding) => finding.id)).size !== findings.length) throw new InvestigatorContextError("INVALID_CONTEXT");
  const evidenceOrder = new Map(evidence.map((record, index) => [record.id, index]));
  const findingCategoryTotals = { selling: 0, funding: 0, accumulation: 0, connections: 0 };
  findings.forEach((finding) => findingCategoryTotals[finding.category]++);
  const fundingCounts = { complete: 0, partial: 0, unavailable: 0, not_examined: 0 };
  for (const entry of report.coverage.funding) {
    if (!status.safeParse(entry.status).success) throw new InvestigatorContextError("INVALID_CONTEXT");
    fundingCounts[entry.status]++;
  }
  fundingCounts.not_examined += Math.max(0, base.coverage.eligibleWallets - report.coverage.funding.length);
  const closure = (ids: readonly string[]) => {
    const result = new Set(ids);
    if (result.size !== ids.length) throw new InvestigatorContextError("INVALID_CONTEXT");
    for (const id of result) {
      const record = byId.get(id);
      if (!record) throw new InvestigatorContextError("INVALID_CONTEXT");
      if (record.kind === "sale") {
        if (!record.sale || new Set(record.sale.supportingEvidenceIds).size !== record.sale.supportingEvidenceIds.length) throw new InvestigatorContextError("INVALID_CONTEXT");
        for (const support of record.sale.supportingEvidenceIds) {
          if (byId.get(support)?.kind !== "transfer") throw new InvestigatorContextError("INVALID_CONTEXT");
          result.add(support);
        }
      }
    }
    return result;
  };
  // Malformed retained sale proofs must not become a deceptively smaller valid context.
  for (const record of evidence) if (record.kind === "sale") closure([record.id]);
  for (const finding of findings) {
    const support = closure(finding.evidenceIds);
    if (support.size !== finding.evidenceIds.length) throw new InvestigatorContextError("INVALID_CONTEXT");
  }
  const transferStatement = `Token transfer coverage is ${base.coverage.transfers} within finalized blocks ${base.range.from.number}–${base.range.to.number}.`;
  const fundingStatement = `Funding-history coverage: ${fundingCounts.complete} complete, ${fundingCounts.partial} partial, ${fundingCounts.unavailable} unavailable, ${fundingCounts.not_examined} not examined.`;
  const limitationStatements = new Map([...new Set([transferStatement, fundingStatement, ...warnings])].map((statement, index) => [`L${index + 1}`, statement]));
  const reasons = new Map<string, OmissionReason>();
  // Default every unselected finding to the category limit. Updating a reason
  // updates its count once, so portfolio leaves need not rescan all findings.
  const reasonTotals = { category_limit: findings.length, evidence_limit: 0, context_limit: 0, citation_limit: 0 };
  const setReason = (id: string, reason: OmissionReason) => {
    reasonTotals[reasons.get(id) ?? "category_limit"]--;
    reasonTotals[reason]++;
    reasons.set(id, reason);
  };
  for (const finding of findings) {
    if (finding.evidenceIds.length > ON_CHAIN_INVESTIGATOR.limits.evidencePerFinding) setReason(finding.id, "citation_limit");
    else if (finding.evidenceIds.length > config.maxEvidenceRecords) setReason(finding.id, "evidence_limit");
  }
  let selected: Finding[] = [];
  let selectedIds = new Set<string>();

  const build = (ids: Set<string>, supplied: Finding[]) => {
    const records = [...ids].map((id) => byId.get(id)!).sort((left, right) => evidenceOrder.get(left.id)! - evidenceOrder.get(right.id)!);
    const aliases = new Map(records.map((record, index) => [`E${index + 1}`, record.id]));
    const aliasFor = new Map([...aliases].map(([alias, id]) => [id, alias]));
    const roles = new Map<string, string>();
    const receipts = new Map<string, string>();
    const role = (value: string) => {
      if (value === `0x${"0".repeat(40)}`) return "ZERO_ADDRESS";
      if (!roles.has(value)) roles.set(value, `A${roles.size + 1}`);
      return roles.get(value)!;
    };
    records.forEach((record) => { role(record.from); role(record.to); if (!receipts.has(record.transactionHash)) receipts.set(record.transactionHash, `T${receipts.size + 1}`); });
    // Exact amounts/times remain in the report ledger. Avoid teaching the small
    // model to copy raw units and Unix timestamps into its reader-facing summary.
    const readable = (value: string) => value
      .replace(/0x[0-9a-f]{40}/g, (value) => roles.get(value) ?? "an address outside these event roles")
      .replace(/a net [0-9]+ raw token units/g, "a positive net token inflow")
      .replace(/starting at [0-9]+ and ending at [0-9]+/g, "inside the earliest examined interval")
      .replace(/within funding blocks [0-9]+[–-][0-9]+/g, "inside the examined funding window");
    const packets = supplied.map((finding, index) => ({ ref: `F${index + 1}`, category: finding.category, statement: readable(finding.explanation), caveats: finding.limitations.map(readable), caveatRefs: finding.limitations.map((_limitation, index) => `C${index + 1}`), proof: finding.evidenceIds.map((id) => aliasFor.get(id)!) }));
    const findingRefs = new Map(supplied.map((finding, index) => [`F${index + 1}`, finding]));
    const omitted = findings.length - supplied.length;
    const omissionReasons = { ...reasonTotals };
    supplied.forEach((finding) => omissionReasons[reasons.get(finding.id) ?? "category_limit"]--);
    const byCategory = Object.fromEntries(categories.map((category) => {
      const included = supplied.filter((finding) => finding.category === category).length, excluded = findingCategoryTotals[category] - included;
      return [category, { supplied: included, omitted: excluded, status: included ? "supplied" : excluded ? "omitted" : "no_retained_finding" }];
    }));
    const selection = { suppliedEvidence: records.length, omittedEvidence: evidence.length - records.length };
    const sourceFacts = records.map((record) => ({ ref: aliasFor.get(record.id), receipt: receipts.get(record.transactionHash), log: record.logIndex, kind: record.kind, from: role(record.from), to: role(record.to), asset: record.assetAddress === null ? "native ETH" : record.assetAddress === base.token.address ? "investigated ERC-20" : "other ERC-20", block: record.blockNumber, time: record.timestamp,
      ...(record.sale ? { sale: { protocol: record.sale.protocol, pool: role(record.sale.pool), support: record.sale.supportingEvidenceIds.map((id) => aliasFor.get(id)!) } } : {}),
      ...(record.creation ? { creation: { kind: "direct-contract-creation", creator: role(record.creation.creator), contract: role(record.creation.contractAddress), transactionTo: null, receiptStatus: "0x1" } } : {}),
    }));
    const findingSelection = { supplied: supplied.length, omitted, byCategory, omissionReasons };
    const json = JSON.stringify({ network: "Base (8453)", investigatedAsset: "ERC-20 token, not native ETH", range: { blocks: [base.range.from.number, base.range.to.number], times: [base.range.from.timestamp, base.range.to.timestamp], finality: "finalized" },
      coverage: { transfers: base.coverage.transfers, eligibleWallets: base.coverage.eligibleWallets, examinedWallets: base.coverage.examinedWallets, fundingStatusCounts: fundingCounts, fundingDefinitions: { complete: "Declared bounded funding search completed; not a positive event count or complete lifetime history.", partial: "Declared funding search was incomplete.", unavailable: "Funding search could not be retrieved.", not_examined: "Funding search was not checked." }, omittedWarnings: base.coverage.omittedWarnings },
      coverageStatements: [...limitationStatements].map(([id, text]) => ({ id, text })), selection, findingSelection, dossier, findingPackets: packets, sourceFacts, ...(sourceContext ? { sourceContext } : {}),
    });
    const roleAddresses = new Map([...roles].map(([address, label]) => [label, address]));
    if (records.some((record) => record.from === `0x${"0".repeat(40)}` || record.to === `0x${"0".repeat(40)}`)) roleAddresses.set("ZERO_ADDRESS", `0x${"0".repeat(40)}`);
    return { context: { reportId: base.reportId, evidence: records, selection }, json, aliases, packets, findingRefs, roleAddresses, limitationStatements, coverageSentence: `${transferStatement} ${fundingStatement}`, findingSelection };
  };

  // A locally cheapest first packet can consume evidence needed by another
  // perspective. Search bounded whole-finding portfolios jointly instead.
  // Four cheapest and four story-specific candidates preserve both small proofs
  // and useful group/funder findings; at most 9^4 portfolios are considered.
  const specificity = (finding: Finding) => ["shared-observed-native-source", "evidence-linked-component"].includes(finding.rule?.name ?? "") ? 2 : 1;
  const stable = (left: Finding, right: Finding) => left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
  const pools = categories.map((category) => {
    const candidates = findings.filter((finding) => finding.category === category && !reasons.has(finding.id));
    const cheapest = [...candidates].sort((left, right) => left.evidenceIds.length - right.evidenceIds.length || stable(left, right));
    const specific = [...candidates].sort((left, right) => specificity(right) - specificity(left) || left.evidenceIds.length - right.evidenceIds.length || stable(left, right));
    return [...new Map([...cheapest.slice(0, 4), ...specific.slice(0, 4), ...cheapest].map((finding) => [finding.id, finding])).values()].slice(0, 8);
  });
  type Portfolio = { findings: Finding[]; ids: Set<string>; priority: number; specificity: number; bytes: number; key: string };
  let best: Portfolio | undefined;
  const visit = (index: number, supplied: Finding[], ids: Set<string>, priority: number, storySpecificity: number) => {
    if (best && supplied.length + categories.length - index < best.findings.length) return;
    if (index < categories.length) {
      for (const candidate of pools[index]) {
        const nextIds = new Set([...ids, ...candidate.evidenceIds]);
        if (nextIds.size <= config.maxEvidenceRecords) visit(index + 1, [...supplied, candidate], nextIds, priority + 2 ** (categories.length - index - 1), storySpecificity + specificity(candidate));
      }
      visit(index + 1, supplied, ids, priority, storySpecificity);
      return;
    }
    const bytes = Buffer.byteLength(build(ids, supplied).json, "utf8");
    if (bytes > config.maxContextBytes - 128) return;
    const key = supplied.map((finding) => finding.id).join("\n");
    const better = !best || supplied.length > best.findings.length
      || (supplied.length === best.findings.length && (priority > best.priority
        || (priority === best.priority && (storySpecificity > best.specificity
          || (storySpecificity === best.specificity && (ids.size < best.ids.size
            || (ids.size === best.ids.size && (bytes < best.bytes || (bytes === best.bytes && key < best.key)))))))));
    if (better) best = { findings: supplied, ids, priority, specificity: storySpecificity, bytes, key };
  };
  visit(0, [], new Set(), 0, 0);
  if (best) { selected = best.findings; selectedIds = best.ids; }
  const selectedCategories = new Set(selected.map((finding) => finding.category));
  const shortlisted = new Set(pools.flatMap((pool) => pool.map((finding) => finding.id)));
  for (const finding of findings) {
    if (reasons.has(finding.id) || selected.some((item) => item.id === finding.id)) continue;
    if (selectedCategories.has(finding.category) || !shortlisted.has(finding.id)) setReason(finding.id, "category_limit");
    else {
      const nextIds = new Set([...selectedIds, ...finding.evidenceIds]);
      setReason(finding.id, nextIds.size > config.maxEvidenceRecords ? "evidence_limit"
        : Buffer.byteLength(build(nextIds, [...selected, finding]).json, "utf8") > config.maxContextBytes - 128 ? "context_limit" : "category_limit");
    }
  }
  // With no fitting finding, retain a small proof-complete overview sample rather than invent a packet.
  if (!selected.length) {
    const candidates = [...evidence].sort((left, right) => ({ sale: 0, funding: 1, transfer: 2 }[left.kind] - { sale: 0, funding: 1, transfer: 2 }[right.kind]));
    for (const candidate of candidates) {
      const nextIds = closure([candidate.id]);
      if (nextIds.size > config.maxEvidenceRecords || Buffer.byteLength(build(nextIds, []).json, "utf8") > config.maxContextBytes - 128) continue;
      selectedIds = nextIds; break;
    }
  }
  // Add one independently sufficient deployment receipt only when spare budget
  // permits it; never remove or trim selected finding proofs to make it fit.
  const deployment = evidence.find((record) => record.creation !== undefined);
  if (deployment && !selectedIds.has(deployment.id)) {
    const withDeployment = new Set([...selectedIds, deployment.id]);
    if (withDeployment.size <= config.maxEvidenceRecords && Buffer.byteLength(build(withDeployment, selected).json, "utf8") <= config.maxContextBytes - 128) selectedIds = withDeployment;
  }
  const result = build(selectedIds, selected);
  if (Buffer.byteLength(result.json, "utf8") > config.maxContextBytes || (!selectedIds.size && evidence.length)) throw new InvestigatorContextError("CONTEXT_LIMIT");
  return result;
}
