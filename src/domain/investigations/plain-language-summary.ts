import { z } from "@/lib/validation";
import type { InvestigationReport } from "./types";
import { derivePrimaryAssessment, swarmPlainLanguageReasons } from "./primary-assessment";
import { tokenMarketSnapshotSchema } from "./token-market";

const text = (max: number) => z.string().min(1).max(max).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const verdictSchema = z.enum(["AVOID", "CAUTION", "REVIEW", "OK", "INSUFFICIENT"]);
export type PlainLanguageVerdict = z.infer<typeof verdictSchema>;
const sourceSchema = z.object({
  name: z.enum(["SWARM", "TraceForce", "TraceForge"]), url: z.string().max(255).nullable(), checkedAt: z.iso.datetime(),
  dataThrough: z.iso.datetime().nullable(), authority: z.enum(["source-reported", "local-rules"]),
}).strict();
const reasonSchema = z.object({
  id: text(80), reason: text(400), meaning: text(400), evidenceIds: z.array(text(255)).max(200),
  sourceName: text(40), sourceUrl: z.string().max(255).nullable(), asOf: z.iso.datetime(),
}).strict();
export type PlainLanguageReason = z.infer<typeof reasonSchema>;
export interface PlainLanguagePacket {
  version: 1;
  reportRef: string;
  verdict: PlainLanguageVerdict;
  action: string;
  source: z.infer<typeof sourceSchema>;
  reasons: PlainLanguageReason[];
  limitations: string[];
}
export const plainLanguageSelectionSchema = z.object({
  reportRef: text(400), verdict: verdictSchema,
  reasonIds: z.array(text(80)).min(1).max(2).refine((ids) => new Set(ids).size === ids.length),
}).strict();
export type PlainLanguageSelection = z.infer<typeof plainLanguageSelectionSchema>;
/** Decimal points are not sentence endings. Keep this lookaround-free so the
 * same constraint can guide provider JSON-schema generation. */
export const GENERATED_SUMMARY_SENTENCE_PATTERN = /^(?:[^.!?]|[0-9]\.[0-9])+(?:[.!?](?: +(?:[^.!?]|[0-9]\.[0-9])+[.!?]?)?)?$/;
const generatedTextSchema = text(400).regex(GENERATED_SUMMARY_SENTENCE_PATTERN).refine((value) => value === value.trim());
export const generatedPlainLanguageSelectionSchema = plainLanguageSelectionSchema.extend({ text: generatedTextSchema });
type SummaryOptions = { profileVersion?: "1.5.0" | "1.6.0" };
export const plainLanguageSummarySchema = z.object({
  reportRef: text(400), verdict: verdictSchema, action: text(80),
  reasonIds: z.array(text(80)).min(1).max(2).refine((ids) => new Set(ids).size === ids.length),
  reasons: z.array(reasonSchema).min(1).max(2), source: sourceSchema,
  limitations: z.array(text(400)).max(3),
  text: generatedTextSchema.optional(),
  grounding: z.object({ mode: z.literal("source-grounded-prose") }).strict().optional(),
}).strict();
export type PlainLanguageSummary = z.infer<typeof plainLanguageSummarySchema>;

/** Selection needs readable reasons, not duplicated URLs, timestamps or raw
 * evidence IDs. Full provenance is restored from the report after inference. */
export function plainLanguageDecisionContext(packet: PlainLanguagePacket) {
  return { version: packet.version, reportRef: "R1" as const, verdict: packet.verdict, action: packet.action,
    source: { name: packet.source.name, authority: packet.source.authority },
    reasons: packet.reasons.map(({ reason, meaning }, index) => ({ id: `D${index + 1}`, reason, meaning })), limitations: packet.limitations };
}

const actions: Record<PlainLanguageVerdict, string> = {
  AVOID: "Avoid for now", CAUTION: "Be careful", REVIEW: "Be careful", OK: "No major warning found", INSUFFICIENT: "Not enough information",
};
const dollars = (amount: number) => amount > 0 && amount < 0.01 ? "less than $0.01" : `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true })}`;
const blockTime = (report: InvestigationReport) => new Date(report.range.to.timestamp * 1000).toISOString();

/** Source facts, fixed wording and exact local measurements are the only prose
 * authority. Source free text and model prose never enter the summary. */
export function buildPlainLanguagePacket(report: InvestigationReport, options: SummaryOptions = {}): PlainLanguagePacket {
  const primary = derivePrimaryAssessment(report);
  if (primary.authority === "swarm") {
    const source: PlainLanguagePacket["source"] = { name: "SWARM", url: primary.sourceUrl, checkedAt: primary.checkedAt,
      dataThrough: primary.dataThrough, authority: "source-reported" };
    const reportRef = `${report.id}:${report.token.address}:${report.range.to.hash}:SWARM:${source.dataThrough ?? primary.checkedAt}:${primary.status === "reported" ? primary.snapshot.judge.receipt : "unavailable"}${options.profileVersion === "1.6.0" ? ":prose1.6" : ""}`;
    const reasons = primary.status === "reported" ? swarmPlainLanguageReasons(primary.snapshot, { detailed: options.profileVersion === "1.6.0" })
      : [{ reason: options.profileVersion === "1.6.0" && report.swarmAvailability
        ? `SWARM assessment unavailable: ${primary.unavailableReason.replace(/^SWARM(?:['’]s)?\s+/, "")}`
        : "SWARM's assessment is unavailable for this scan.",
      meaning: "The independently checked on-chain findings remain available, but there is no SWARM verdict for this report." }];
    return { version: 1, reportRef, verdict: primary.verdict, action: actions[primary.verdict], source,
      reasons: reasons.map((reason, index) => ({ id: `swarm:${primary.status}:${index + 1}`, reason: reason.reason, meaning: reason.meaning, evidenceIds: [],
        sourceName: "SWARM", sourceUrl: source.url, asOf: source.dataThrough ?? source.checkedAt })),
      limitations: primary.status === "reported" ? [
        "SWARM's result and model weights are source-reported; they are not independently calibrated probabilities.",
        "Reported wallet groups do not establish verified people or common ownership.",
        ...(primary.snapshot.transport?.freshness === "unverified" ? ["The source's scan freshness could not be independently confirmed."] : []),
      ] : ["Missing source data is unavailable, not a clean result or a zero score."] };
  }
  // Preserve the original canonical packet for reports predating the explicit
  // authority flag, including historical profile 1.5 browser snapshots.
  const assessment = primary.assessment;
  const verdict: PlainLanguageVerdict = assessment.verdict;
  const source: PlainLanguagePacket["source"] = { name: "TraceForge", url: null, checkedAt: report.generatedAt, dataThrough: blockTime(report), authority: "local-rules" };
  const reportRef = `${report.id}:${report.token.address}:${report.range.to.hash}:${source.name}:${source.dataThrough}${options.profileVersion === "1.6.0" ? ":prose1.6" : ""}`;
  const reasons: PlainLanguageReason[] = [];
  const add = (id: string, reason: string, meaning: string, metadata: Partial<Pick<PlainLanguageReason, "evidenceIds" | "sourceName" | "sourceUrl" | "asOf">> = {}) => {
    reasons.push({ id, reason, meaning, evidenceIds: [], sourceName: source.name, sourceUrl: source.url, asOf: source.dataThrough!, ...metadata });
  };

    const gates = assessment.gates;
    const honeypot = gates.find((gate) => gate.id === "is_honeypot");
    if (honeypot) add("traceforce:honeypot", "GoPlus warns that selling may be blocked.", "You could be able to buy this token but unable to sell it.", { sourceName: "GoPlus", sourceUrl: honeypot.sourceUrl ?? null, asOf: report.token.securitySnapshot!.checkedAt });
    for (const [id, reason, meaning] of [
      ["owner_change_balance", "GoPlus reports that an administrator can change token balances.", "Your displayed token balance could be changed through the contract's controls."],
      ["transfer_pausable", "GoPlus reports that token transfers can be paused.", "A pause could stop you from moving or selling your tokens."],
    ] as const) {
      const gate = gates.find((gate) => gate.id === id);
      if (gate) add(`traceforce:${id}`, reason, meaning, { sourceName: "GoPlus", sourceUrl: gate.sourceUrl ?? null, asOf: report.token.securitySnapshot!.checkedAt });
    }
    if (gates.some((gate) => gate.id === "contract-dump-impact")) add("traceforce:contract-holding", "A checked contract holds enough tokens that a sale could heavily move the pool price.", "This is a calculated scenario; the scan has not established whether that contract can sell.");
    if (gates.some((gate) => gate.id === "fresh-wallets")) add("traceforce:fresh-wallets", "Most checked wallets have very few outgoing transactions.", "This is a warning sign to examine, but it does not show who controls those wallets.");
    const parsedMarket = tokenMarketSnapshotSchema.safeParse(report.token.marketSnapshot);
    const market = parsedMarket.success && parsedMarket.data.sourceUrl === `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}` ? parsedMarket.data : null;
    if (gates.some((gate) => gate.id === "thin-liquidity") && market?.status === "reported" && market.liquidityUsd !== null) {
      add("traceforce:liquidity", `DEX Screener reports ${dollars(market.liquidityUsd)} in the trading pool.`, "Selling may be difficult, and even a small sale could move the price.", { sourceName: "DEX Screener", sourceUrl: market.sourceUrl, asOf: market.checkedAt });
    }
    if (gates.some((gate) => gate.id === "dump-impact") && assessment.metrics.dumpImpactPercent !== null) {
      add("traceforce:modeled-drop", `A sale of the largest checked ${assessment.holdingBasis.kind === "wallets" ? "wallet's" : "address's"} holding could lower the pool price by ${assessment.metrics.dumpImpactPercent}%.`, "This is a calculated scenario, not a prediction or a price you can sell at.");
    } else if (assessment.metrics.largestSharePercent !== null && Number(assessment.metrics.largestSharePercent) >= 10) {
      const supplyBasis = assessment.holdingBasis.denominatorLabel === "total supply" ? "total token supply"
        : assessment.holdingBasis.kind === "wallets" ? "supply counted for wallets in this report" : "supply outside verified pools and burn addresses";
      add("traceforce:concentration", `The largest checked ${assessment.holdingBasis.kind === "wallets" ? "wallet" : "address"} holds ${assessment.metrics.largestSharePercent}% of the ${supplyBasis}.`, "A large sale from those holdings could move the price.");
    }
    const linkedSales = assessment.triggeredRules.find((rule) => rule.id === "linked-selling-window");
    if (linkedSales) add("traceforce:linked-selling", "Previously linked wallets sold within ten minutes of each other.", "Their sales deserve a closer look; the links do not prove one owner or a coordinated plan.", { evidenceIds: linkedSales.evidenceIds });
  if (!reasons.length) {
    if (verdict === "OK") add("assessment:no-major-warning", `${source.name} found no major warning in the checks it completed.`, "This does not guarantee that the token is safe or that you can sell it.");
    else if (verdict === "INSUFFICIENT") add("assessment:incomplete", "Some checks could not be completed.", "There is not enough information for a complete assessment.");
    else add("assessment:source-warning", `${source.name} reports ${verdict === "AVOID" ? "a serious warning" : "a reason to be careful"} for this token.`, "The available details do not establish what would happen if you bought or sold.");
  }
  const incomplete = !assessment.complete;
  return { version: 1, reportRef, verdict, action: actions[verdict], source, reasons: reasons.slice(0, 2), limitations: [
    ...(incomplete ? ["Some checks are incomplete; missing information is not a clean result."] : []),
    "This assessment uses the evidence available at the scan time; it does not guarantee what happens next.",
  ] };
}

/** The model selects IDs and ordering only. Restore every visible factual word. */
export function restorePlainLanguageSummary(report: InvestigationReport, value: unknown, options: SummaryOptions = {}): PlainLanguageSummary {
  const generated = options.profileVersion === "1.6.0";
  const selection = generated ? generatedPlainLanguageSelectionSchema.parse(value) : plainLanguageSelectionSchema.parse(value), packet = buildPlainLanguagePacket(report, options);
  if (selection.reportRef !== packet.reportRef || selection.verdict !== packet.verdict) throw new Error("Plain-language selection does not match this report.");
  const byId = new Map(packet.reasons.map((reason) => [reason.id, reason]));
  const reasons = selection.reasonIds.map((id) => {
    const reason = byId.get(id);
    if (!reason) throw new Error("Plain-language reason was not supplied by this report.");
    return reason;
  });
  const summary: PlainLanguageSummary = { reportRef: packet.reportRef, verdict: packet.verdict, action: packet.action, reasonIds: [...selection.reasonIds], reasons, source: packet.source, limitations: packet.limitations };
  if (generated && "text" in selection && typeof selection.text === "string") {
    validateGeneratedSummaryText(selection.text, summary);
    summary.text = selection.text; summary.grounding = { mode: "source-grounded-prose" };
  }
  return summary;
}

/** Shared browser/API validation rejects changed facts, authority and provenance. */
export function validatePlainLanguageSummary(report: InvestigationReport, value: unknown, options: SummaryOptions = {}): PlainLanguageSummary {
  const summary = plainLanguageSummarySchema.parse(value);
  const canonical = restorePlainLanguageSummary(report, { reportRef: summary.reportRef, verdict: summary.verdict, reasonIds: summary.reasonIds,
    ...(options.profileVersion === "1.6.0" ? { text: summary.text } : {}) }, options);
  if (JSON.stringify(summary) !== JSON.stringify(canonical)) throw new Error("Plain-language summary differs from its canonical report facts.");
  return canonical;
}

/** Bounded generated commentary, not a semantic truth certificate. Every number
 * must retain a supplied unit, while direct unsupported claims fail closed. */
export class GeneratedSummaryValidationError extends Error {
  constructor() { super("Generated summary is not supported by its selected source reasons."); this.name = "GeneratedSummaryValidationError"; }
}

function validateGeneratedSummaryText(value: string, summary: PlainLanguageSummary): void {
  const reject = () => { throw new GeneratedSummaryValidationError(); };
  if (/[<>]|https?:\/\/|www\.|0x[0-9a-f]{8,}|\b[AEFCLD][0-9]+\b/i.test(value)) reject();
  const supplied = summary.reasons.map((reason) => `${reason.reason} ${reason.meaning}`).join(" ");
  if (/\b(?:scores?|confidence|probabilities|calibrated)\b/i.test(value)) reject();
  for (const verdict of value.match(/\b(?:AVOID|CAUTION|REVIEW|OK|INSUFFICIENT)\b/g) ?? []) if (verdict !== summary.verdict) reject();
  const knownNumbers = [...supplied.matchAll(/(\$)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)(%)?/g)]
    .map((match) => ({ value: Number(match[2].replaceAll(",", "")), unit: match[1] ? "dollars" : match[3] ? "percent" : "count" }));
  for (const match of value.matchAll(/(\$)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)(%|\s+percent|\s+dollars)?/gi)) {
    const unit = match[1] || /dollars/i.test(match[3] ?? "") ? "dollars" : match[3] ? "percent" : "count";
    if (!knownNumbers.some((known) => known.value === Number(match[2].replaceAll(",", "")) && known.unit === unit)) reject();
  }
  if (summary.source.name === "SWARM" && !/\bSWARM\b/.test(value)) reject();
  // A separate ownership caveat cannot qualify a direct absence claim. Summary
  // decision reasons never establish that missing/omitted events did not occur.
  if (/\b(?:no|zero)\s+(?:(?:verified|supported|observed|actual|retained|completed|native|token|ETH)\s+)*(?:sales?|selling|purchases?|trades?|transfers?|funding)\b/i.test(value)
    || /\b(?:sales?|selling|purchases?|trades?|transfers?|funding)\s+(?:(?:have|has|had)\s+)?(?:never|not)\s+(?:occurred|happened|existed)\b/i.test(value)) reject();
  if (summary.source.name === "SWARM" && /\bfloat\b.{0,55}\b(?:exclud(?:es|ing)|minus|removes?)\b.{0,60}\b(?:contracts?|pools?|burns?|burned addresses)\b/i.test(value)) reject();
  if (summary.source.name === "SWARM" && (
    /\b(?:verdict|decision|assessment|result)\s+(?:(?:is|was)\s+)?(?:based|derived)\s+(?:solely|only|exclusively)\s+(?:on|from)\b/i.test(value)
    || /\b(?:without|no)\s+(?:any\s+)?(?:independent|internal)\s+(?:validation|verification|review|checks?)\b/i.test(value)
    || /\bSWARM\b.{0,45}\b(?:does not|doesn't|has not|hasn't|never)\s+(?:independently\s+)?(?:validate|verify|check)\b/i.test(value)
    || /\bSWARM\b.{0,45}\b(?:lacks?|does not have|has no)\s+(?:independent|internal)\s+(?:validation|verification|review|checks?)\b/i.test(value)
  )) reject();
  for (const match of value.matchAll(/\b(?:verdict|decision)\s*(?:(?:is|of)\s+|:\s*)(AVOID|CAUTION|REVIEW|OK|INSUFFICIENT)\b/gi)) if (match[1].toUpperCase() !== summary.verdict) reject();
  for (const [pattern, support] of [
    [/\b(?:creator|developer|dev)\b/i, /\b(?:creator|dev)\b/i],
    [/\bliquidity\b/i, /\bliquidity|\$|trading pool\b/i],
    [/\b(?:honeypot|paused|pausable|administrator)\b/i, /\b(?:GoPlus|blocked|paused|administrator)\b/i],
  ] as const) if (pattern.test(value) && !support.test(supplied)) reject();
  if (/\bno (?:risks?|warnings?|missing (?:data|information))\b/i.test(value)
    || /\b(?:it|this token|the token)\s+(?:has|poses|carries)\s+zero\s+risks?\b/i.test(value)) reject();
  for (const sentence of value.split(/[.!?]\s+/)) {
    if (/\bfloat\b/i.test(supplied) && /\btotal\s+(?:token\s+)?supply\b/i.test(sentence)
      && !/\bnot\s+(?:the\s+)?total\s+(?:token\s+)?supply\b/i.test(sentence)) reject();
    for (const clause of sentence.split(/[,;]|\s+(?:and|while)\s+/i)) for (const [topic, fact] of [[/\b(?:creator|developer|dev)\b/i, /\bcreator\b/i], [/\blargest\b/i, /\blargest\b/i]] as const) {
        if (!topic.test(clause)) continue;
        const topicNumbers = summary.reasons.filter((reason) => fact.test(reason.reason)).flatMap((reason) => [...reason.reason.matchAll(/([0-9]+(?:\.[0-9]+)?)%/g)].map((match) => Number(match[1])));
        for (const match of clause.matchAll(/([0-9]+(?:\.[0-9]+)?)(?:%|\s+percent)/gi)) if (!topicNumbers.includes(Number(match[1]))) reject();
      }
    for (const clause of sentence.split(/\s+(?:but|however|yet)\s+|[;]/i)) {
      if (/\bcreator(?:'s|’s|[- ]linked)?\b.{0,65}\b(?:largest|same|single)\s+(?:wallet\s+)?group\b/i.test(clause)
        && !/\b(?:not|cannot|can't|unknown|unverified|unproven)\b/i.test(clause)) reject();
      if (/\b(?:guarantee[ds]?|risk[- ]free|certain profit|will (?:rise|fall|crash|dump|increase|decrease)|safe|scam|same owner|single owner|common ownership|shared control|verified (?:people|owners)|coordinated|completed sale|no (?:selling|funding))\b/i.test(clause)
        && !/\b(?:not|no proof|no guarantee|cannot|can't|unknown|unverified|unproven|doesn't|does not)\b/i.test(clause)) reject();
    }
  }
  if (summary.source.name === "SWARM" && summary.verdict === "INSUFFICIENT" && (
    /\bno\s+(?:conclusions?|findings?)\s+(?:(?:can|could|may)\s+be\s+)?(?:drawn|made|reached|established|derived|obtained)\s+(?:from|about|using)\s+(?:the\s+)?(?:on[- ]chain|blockchain|(?:this|the|entire|whole)\s+report)\b/i.test(value)
    || /\bnothing\s+(?:can|could|may)\s+be\s+(?:concluded|determined|established)\s+(?:from|about|using)\s+(?:the\s+)?(?:on[- ]chain|blockchain|(?:this|the|entire|whole)\s+report)\b/i.test(value)
    || /\bno\s+(?:on[- ]chain|blockchain)\s+(?:conclusions?|findings?)\b/i.test(value)
    || /\b(?:on[- ]chain|blockchain)\s+(?:data|evidence|findings)\s+(?:cannot|can't|does not|doesn't)\s+(?:support|yield|provide|establish)\s+(?:any\s+)?(?:conclusions?|findings?)\b/i.test(value)
    || /\b(?:this|the|entire|whole)\s+(?:(?:entire|whole)\s+)?report\s+(?:has|contains|provides)\s+no\s+(?:(?:usable|supported|meaningful)\s+)?(?:findings?|conclusions?|evidence)\b/i.test(value)
  )) reject();
  const missingSourceAssessment = summary.source.name === "SWARM" && (
    /\bSWARM\s+has\s+no\s+assessment\s+for\s+this\s+scan\b/i.test(value)
    || /\bSWARM(?:['’]s)?\s+assessment\s+is\s+not\s+(?:supplied|available)\b/i.test(value)
  );
  if (missingSourceAssessment && summary.verdict !== "INSUFFICIENT") reject();
  if (summary.verdict === "INSUFFICIENT" && !missingSourceAssessment && !/\b(?:unavailable|unknown|incomplete|not enough|missing|could not|cannot|can't)\b/i.test(value)) reject();
}
