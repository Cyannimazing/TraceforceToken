import { z } from "@/lib/validation";
import type { ExplainedInvestigationReport, InvestigationReport, ScanParameters } from "./types";
import { validateInvestigationExplanation } from "./explanation";
import { tokenWebPresenceSchema } from "./token-web-presence";
import { tokenMarketSnapshotSchema } from "./token-market";
import { holderSnapshotSchema, validateHolderSnapshot } from "./holder-snapshot";
import { initialLiquiditySchema, liquiditySnapshotSchema, purchaseSchema, validateLiquiditySnapshot, validateMarketAnnotations, validateWalletActivitySnapshot, walletActivitySnapshotSchema } from "./chain-snapshots";
import { tokenSecuritySnapshotSchema } from "./token-security";
import { creationAnnotationSchema, validateCreationAnnotations } from "./creator-attribution";
import { transferCrawlSchema, validateTransferCrawl } from "./transfer-crawl";
import { creatorFundingCoverageSchema, validateCreatorFundingCoverage } from "./creator-funding";
import { swarmAssessmentSnapshotSchema, validateSwarmAssessmentSnapshot } from "./swarm-assessment";
import { providerEnrichmentBundleSchema, validateProviderEnrichmentBundle } from "./provider-enrichment";
import { exitQuoteSchema, validateExitQuote } from "./exit-quote";

export const MAX_INVESTIGATION_REPORT_BYTES = 8 * 1024 * 1024;

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const raw = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((value) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < (1n << 256n));
// Repeated transfers can make an observed sum exceed one uint256 transfer value.
const aggregateRaw = z.string().regex(/^(0|[1-9][0-9]{0,95})$/);
const blockNumber = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000);
const identity = z.string().min(1).max(255);
const evidenceIds = z.array(identity);
const coverageStatus = z.enum(["complete", "partial", "unavailable", "not_examined"]);
const provenance = z.object({ provider: z.string(), method: z.string(), observedAt: z.iso.datetime() });
const block = z.object({ number: blockNumber, hash, timestamp });

const reportSchema: z.ZodType<InvestigationReport> = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  generatedAt: z.iso.datetime(),
  mode: z.literal("live"),
  assessmentAuthority: z.enum(["swarm", "traceforge"]).optional(),
  swarmAvailability: z.object({ status: z.literal("unavailable"), reason: z.enum(["timeout", "rate_limited", "access_denied", "stale_result", "invalid_response", "identity_mismatch", "job_failed", "unavailable"]), checkedAt: z.iso.datetime() }).strict().optional(),
  swarmAssessment: swarmAssessmentSnapshotSchema.optional(),
  providerEnrichment: providerEnrichmentBundleSchema.optional(),
  token: z.object({
    address: address.transform((value) => value as ScanParameters["token"]),
    chainId: z.literal(8453),
    name: z.string().nullable(),
    symbol: z.string().nullable(),
    decimals: z.number().int().min(0).max(255).nullable(),
    totalSupplyRaw: raw.nullable(),
    webPresence: tokenWebPresenceSchema.optional(),
    marketSnapshot: tokenMarketSnapshotSchema.optional(),
    securitySnapshot: tokenSecuritySnapshotSchema.optional(),
  }).superRefine((token, context) => {
    if (token.webPresence && token.webPresence.sourceUrl !== `https://api.dexscreener.com/token-pairs/v1/base/${token.address}`) {
      context.addIssue({ code: "custom", message: "Website metadata does not match the investigated token." });
    }
    if (token.marketSnapshot && token.marketSnapshot.sourceUrl !== `https://api.dexscreener.com/token-pairs/v1/base/${token.address}`) {
      context.addIssue({ code: "custom", message: "Market metadata does not match the investigated token." });
    }
    if (token.securitySnapshot && token.securitySnapshot.tokenAddress !== token.address) {
      context.addIssue({ code: "custom", message: "Security metadata does not match the investigated token." });
    }
  }),
  range: z.object({
    from: block,
    to: block,
    finality: z.literal("finalized"),
  }),
  coverage: z.object({
    transfers: coverageStatus,
    transferCrawl: transferCrawlSchema.optional(),
    creatorFunding: creatorFundingCoverageSchema.optional(),
    funding: z.array(z.object({
      wallet: address,
      status: coverageStatus,
      fromBlock: blockNumber,
      toBlock: blockNumber,
      internalTransfers: z.literal("not_examined"),
      reason: z.string().nullable(),
    })),
    eligibleWallets: z.number().int().nonnegative(),
    examinedWallets: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  }),
  summary: z.string(),
  holderSnapshot: holderSnapshotSchema.optional(),
  walletActivitySnapshot: walletActivitySnapshotSchema.optional(),
  liquiditySnapshot: liquiditySnapshotSchema.optional(),
  exitQuote: exitQuoteSchema.optional(),
  infrastructure: z.object({ pools: z.array(address).max(2000), hubs: z.array(address).max(2000) }).strict().optional(),
  wallets: z.array(z.object({
    address,
    observedIncomingRaw: aggregateRaw,
    observedOutgoingRaw: aggregateRaw,
    observedNetRaw: z.string().regex(/^-?(0|[1-9][0-9]{0,95})$/),
    balanceRaw: raw.nullable(),
    verifiedSoldRaw: aggregateRaw,
    firstObservedAt: timestamp.nullable(),
    earlyAccumulator: z.boolean().nullable(),
  })),
  connections: z.array(z.object({
    id: identity, from: address, to: address,
    kind: z.enum(["funding", "transfer"]), timestamp, evidenceIds,
  })),
  groups: z.array(z.object({ id: identity, wallets: z.array(address), evidenceIds, explanation: z.string() })),
  findings: z.array(z.object({
    id: identity,
    category: z.enum(["funding", "connections", "accumulation", "selling", "coverage"]),
    title: z.string(), explanation: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    wallets: z.array(address), evidenceIds, limitations: z.array(z.string()),
    rule: z.object({ name: z.string(), version: z.string(), parameters: z.record(z.string(), z.union([z.string(), z.number().finite()])) }),
  })),
  story: z.array(z.object({ id: identity, timestamp, title: z.string(), description: z.string(), evidenceIds })),
  evidence: z.array(z.object({
    id: identity, kind: z.enum(["transfer", "funding", "sale"]), chainId: z.literal(8453),
    blockNumber, blockHash: hash, transactionHash: hash,
    transactionIndex: z.number().int().nonnegative(), logIndex: z.number().int().nonnegative().nullable(),
    traceId: z.string().nullable(), timestamp, from: address, to: address,
    assetAddress: address.nullable(), amountRaw: raw, provenance,
    sale: z.object({
      pool: address, factory: address, protocol: z.enum(["uniswap-v2", "uniswap-v3"]),
      quoteAsset: address, quoteAmountRaw: raw,
      swapLogIndex: z.number().int().nonnegative(), supportingEvidenceIds: evidenceIds,
    }).nullable(),
    purchase: purchaseSchema.optional(),
    liquidity: initialLiquiditySchema.optional(),
    creation: creationAnnotationSchema.optional(),
  })),
  explanation: z.unknown().optional(),
}) as z.ZodType<InvestigationReport>;

function parseReport(value: unknown): InvestigationReport {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > MAX_INVESTIGATION_REPORT_BYTES) throw new Error();
  const report = reportSchema.parse(value);
  if (report.swarmAssessment && report.swarmAvailability) throw new Error();
  if (report.swarmAssessment) report.swarmAssessment = validateSwarmAssessmentSnapshot(report.swarmAssessment, report.token.address);
  if (report.providerEnrichment) report.providerEnrichment = validateProviderEnrichmentBundle(report.providerEnrichment, report.token.address);
  if (report.coverage.transferCrawl) validateTransferCrawl(report.coverage.transferCrawl, report.range, report.coverage.transfers);
  if (report.holderSnapshot) report.holderSnapshot = validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to);
  if (report.walletActivitySnapshot) report.walletActivitySnapshot = validateWalletActivitySnapshot(report.walletActivitySnapshot, report.range.to);
  if (report.liquiditySnapshot) report.liquiditySnapshot = validateLiquiditySnapshot(report.liquiditySnapshot, report.token.address, report.range.to);
  if (report.infrastructure) for (const addresses of [report.infrastructure.pools, report.infrastructure.hubs]) if (new Set(addresses).size !== addresses.length || addresses.includes(`0x${"0".repeat(40)}`)) throw new Error();
  if (report.exitQuote) report.exitQuote = validateExitQuote(report.exitQuote, report.token, report.range.to, report.holderSnapshot, report.walletActivitySnapshot, report.infrastructure?.pools ?? []);
  validateMarketAnnotations(report.evidence, report.token.address);
  validateCreationAnnotations(report);
  if (report.coverage.creatorFunding) report.coverage.creatorFunding = validateCreatorFundingCoverage(report.coverage.creatorFunding, report);
  const balances = new Map(report.holderSnapshot?.holders.map((item) => [item.address, item.balanceRaw]) ?? []);
  if (report.wallets.some((wallet) => wallet.balanceRaw !== (balances.get(wallet.address) ?? null))) throw new Error();
  const evidence = new Map(report.evidence.map((record) => [record.id, record]));
  if (evidence.size !== report.evidence.length) throw new Error();
  const references = (ids: string[]) => {
    if (new Set(ids).size !== ids.length || ids.some((id) => !evidence.has(id))) throw new Error();
  };
  for (const entry of [...report.findings, ...report.connections, ...report.groups, ...report.story]) references(entry.evidenceIds);
  for (const record of report.evidence) {
    if ((record.kind === "sale") !== (record.sale !== null)) throw new Error();
    if (record.sale) {
      references(record.sale.supportingEvidenceIds);
      if (!record.sale.supportingEvidenceIds.length || record.sale.supportingEvidenceIds.some((id) => evidence.get(id)?.kind !== "transfer")) throw new Error();
    }
  }
  return report;
}

/** Acquired evidence and deterministic findings, explicitly without AI prose. */
export function validateBaseInvestigationReport(value: unknown): InvestigationReport {
  try {
    const report = parseReport(value);
    if (report.explanation !== undefined) throw new Error();
    delete report.explanation;
    return report;
  } catch { throw new Error("Invalid investigation report."); }
}

/** A final explanation cannot silently replace facts already shown in a preview. */
export function sameInvestigationAnalysis(analysis: InvestigationReport, report: InvestigationReport): boolean {
  const base = { ...report };
  delete base.explanation;
  // Runtime schemas can reorder object properties. Compare every value while
  // retaining array order, so normalization cannot manufacture a changed scan.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;
  return JSON.stringify(canonical(analysis)) === JSON.stringify(canonical(base));
}

/** Shared server/browser boundary; validates shape and citations without persistence. */
export function validateExplainedReport(value: unknown): ExplainedInvestigationReport {
  try {
    const report = parseReport(value);
    return { ...report, explanation: validateInvestigationExplanation(report, report.explanation) };
  } catch { throw new Error("Invalid investigation report."); }
}
