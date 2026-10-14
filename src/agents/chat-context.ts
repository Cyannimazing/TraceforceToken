import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ExplainedInvestigationReport } from "@/domain/investigations/types";
import { validateExplainedReport } from "@/domain/investigations/report-validation";
import { aiModelIdentifier, validateAiConfiguration, type AiConfiguration } from "./config";
import { assessmentContextSchema, createAssessmentSourceContext, createInvestigatorContext } from "./context";
import { ON_CHAIN_INVESTIGATOR } from "./profiles";
import { createSwarmAssessmentContext, swarmAssessmentContextSchema } from "./swarm-assessment-context";

export const CHAT_CONTEXT_MAX_CHARACTERS = 32_768;
export const CHAT_CONTEXT_LIFETIME_SECONDS = 30 * 60;
const MAX_CONTEXT_BYTES = 6000;
const MAX_EVIDENCE = 12;
const MAX_ASSESSMENT_BYTES = 4096;
const assessmentBytes = (assessment: unknown, comparison?: unknown) => (assessment === undefined ? 0 : Buffer.byteLength(JSON.stringify(assessment), "utf8")) + (comparison === undefined ? 0 : Buffer.byteLength(JSON.stringify(comparison), "utf8"));
const PURPOSE = "traceforce-scan-questions";
const alias = z.string().regex(/^E[1-9][0-9]?$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const capsuleSchema = z.object({
  version: z.literal(1), purpose: z.literal(PURPOSE),
  issuedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe(),
  reportId: z.uuid(), profileId: z.literal("on-chain-investigator"), profileVersion: z.string().max(32), model: z.string().min(1).max(128),
  tokenAddress: address,
  assessmentAuthority: z.enum(["swarm", "traceforge"]).optional(),
  data: z.string().max(MAX_CONTEXT_BYTES),
  assessment: assessmentContextSchema.optional().refine((value) => value === undefined || Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_ASSESSMENT_BYTES),
  swarmAssessment: swarmAssessmentContextSchema.optional(),
  citations: z.array(z.object({ alias, id: z.string().min(1).max(255), support: z.array(alias).max(MAX_EVIDENCE) }).strict()).max(MAX_EVIDENCE),
  roles: z.array(z.tuple([z.string().regex(/^(?:A[1-9][0-9]?|ZERO_ADDRESS)$/), address])).max(32),
}).strict().superRefine((value, context) => {
  if (assessmentBytes(value.assessment, value.swarmAssessment) > MAX_ASSESSMENT_BYTES) context.addIssue({ code: "custom", message: "Assessment context exceeds its shared byte budget." });
});

export type VerifiedChatContext = z.infer<typeof capsuleSchema>;
export class ChatContextError extends Error {
  constructor(public readonly code: "INVALID_CONTEXT" | "EXPIRED_CONTEXT" | "CONTEXT_LIMIT") {
    super(`Scan question context could not be used (${code}).`); this.name = "ChatContextError";
  }
}

function validatedSecret(secret: string): string {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /[\x00-\x20\x7f]/.test(secret)) throw new ChatContextError("INVALID_CONTEXT");
  return secret;
}
function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", validatedSecret(secret)).update(`${PURPOSE}:v1\0${payload}`, "utf8").digest();
}

/** A signed browser-held snapshot, not server storage or an encrypted/private report. */
export function createChatContext(report: ExplainedInvestigationReport, configuration: AiConfiguration, secret: string): string {
  try {
    validatedSecret(secret);
    const config = validateAiConfiguration(configuration);
    const validated = validateExplainedReport(report);
    const compact = createInvestigatorContext(validated, { ...config, maxContextBytes: Math.min(config.maxContextBytes, MAX_CONTEXT_BYTES), maxEvidenceRecords: Math.min(config.maxEvidenceRecords, MAX_EVIDENCE) }, { includeDecisionPacket: false });
    const aliasesById = new Map([...compact.aliases].map(([alias, id]) => [id, alias]));
    const issuedAt = Math.floor(Date.now() / 1000);
    const value: VerifiedChatContext = {
      version: 1, purpose: PURPOSE, issuedAt, expiresAt: issuedAt + CHAT_CONTEXT_LIFETIME_SECONDS,
      reportId: validated.id, profileId: ON_CHAIN_INVESTIGATOR.id, profileVersion: ON_CHAIN_INVESTIGATOR.version, model: aiModelIdentifier(config),
      tokenAddress: validated.token.address,
      ...(validated.assessmentAuthority ? { assessmentAuthority: validated.assessmentAuthority } : {}),
      data: compact.json,
      citations: compact.context.evidence.map((record) => ({ alias: aliasesById.get(record.id)!, id: record.id, support: (record.sale?.supportingEvidenceIds ?? []).map((id) => aliasesById.get(id)!) })),
      roles: [...compact.roleAddresses],
    };
    // Keep the existing proof selection and its 6 KiB data cap intact. Optional
    // score metadata shares the already-bounded signed envelope, not that budget.
    const assessment = createAssessmentSourceContext(validated);
    if (validated.assessmentAuthority === "swarm") {
      // Primary source has priority inside the same existing metadata budget.
      // Retain the authority marker even when the source is unavailable; its
      // absence cannot silently promote the independent local ledger.
      if (validated.swarmAssessment) {
        const swarmAssessment = createSwarmAssessmentContext(validated);
        if (assessmentBytes(swarmAssessment) <= MAX_ASSESSMENT_BYTES) value.swarmAssessment = swarmAssessment;
      }
      if (assessmentBytes(assessment, value.swarmAssessment) <= MAX_ASSESSMENT_BYTES) value.assessment = assessment;
    } else {
      if (assessmentBytes(assessment) <= MAX_ASSESSMENT_BYTES) value.assessment = assessment;
      if (validated.swarmAssessment && value.assessment) {
        const swarmAssessment = createSwarmAssessmentContext(validated);
        if (assessmentBytes(assessment, swarmAssessment) <= MAX_ASSESSMENT_BYTES) value.swarmAssessment = swarmAssessment;
      }
    }
    const encode = () => {
      const payload = Buffer.from(JSON.stringify(capsuleSchema.parse(value)), "utf8").toString("base64url");
      return `v1.${payload}.${signature(payload, secret).toString("base64url")}`;
    };
    let capsule = encode();
    if (capsule.length > CHAT_CONTEXT_MAX_CHARACTERS && value.assessmentAuthority === "swarm" && value.assessment) { delete value.assessment; capsule = encode(); }
    if (capsule.length > CHAT_CONTEXT_MAX_CHARACTERS && value.swarmAssessment) { delete value.swarmAssessment; capsule = encode(); }
    if (capsule.length > CHAT_CONTEXT_MAX_CHARACTERS && value.assessment) { delete value.assessment; capsule = encode(); }
    if (capsule.length > CHAT_CONTEXT_MAX_CHARACTERS) throw new ChatContextError("CONTEXT_LIMIT");
    return capsule;
  } catch (error) {
    if (error instanceof ChatContextError) throw error;
    throw new ChatContextError("INVALID_CONTEXT");
  }
}

/** Authenticate the bounded bytes before JSON parsing; nothing supplied by the browser is a report. */
export function verifyChatContext(capsule: string, configuration: AiConfiguration, secret: string, options: { now?: () => Date; allowedModels?: readonly string[] } = {}): VerifiedChatContext {
  try {
    validatedSecret(secret);
    const config = validateAiConfiguration(configuration);
    if (typeof capsule !== "string" || capsule.length > CHAT_CONTEXT_MAX_CHARACTERS) throw new ChatContextError("CONTEXT_LIMIT");
    const parts = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(capsule);
    if (!parts) throw new ChatContextError("INVALID_CONTEXT");
    const supplied = Buffer.from(parts[2], "base64url");
    if (supplied.length !== 32 || supplied.toString("base64url") !== parts[2] || !timingSafeEqual(signature(parts[1], secret), supplied)) throw new ChatContextError("INVALID_CONTEXT");
    const bytes = Buffer.from(parts[1], "base64url");
    if (bytes.toString("base64url") !== parts[1]) throw new ChatContextError("INVALID_CONTEXT");
    const value = capsuleSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    if (!Number.isSafeInteger(now) || value.expiresAt - value.issuedAt !== CHAT_CONTEXT_LIFETIME_SECONDS || value.issuedAt > now + 5) throw new ChatContextError("INVALID_CONTEXT");
    if (value.expiresAt <= now) throw new ChatContextError("EXPIRED_CONTEXT");
    if (value.profileId !== ON_CHAIN_INVESTIGATOR.id || !["1.4.0", "1.5.0", ON_CHAIN_INVESTIGATOR.version].includes(value.profileVersion) || !(options.allowedModels ?? [aiModelIdentifier(config)]).includes(value.model)
      || Buffer.byteLength(value.data, "utf8") > Math.min(config.maxContextBytes, MAX_CONTEXT_BYTES) || value.citations.length > Math.min(config.maxEvidenceRecords, MAX_EVIDENCE)) throw new ChatContextError("INVALID_CONTEXT");
    if (value.assessment && "source" in value.assessment && value.assessment.tokenAddress !== value.tokenAddress) throw new ChatContextError("INVALID_CONTEXT");
    if (value.swarmAssessment && value.swarmAssessment.tokenAddress !== value.tokenAddress) throw new ChatContextError("INVALID_CONTEXT");
    const aliases = new Set(value.citations.map((entry) => entry.alias));
    if (aliases.size !== value.citations.length || new Set(value.citations.map((entry) => entry.id)).size !== value.citations.length
      || new Set(value.roles.map(([role]) => role)).size !== value.roles.length
      || value.citations.some((entry) => new Set(entry.support).size !== entry.support.length || entry.support.some((support) => support === entry.alias || !aliases.has(support)))) throw new ChatContextError("INVALID_CONTEXT");
    // Data was produced by createInvestigatorContext, not a caller's arbitrary JSON.
    const data = z.object({ sourceFacts: z.array(z.object({ ref: alias })).max(MAX_EVIDENCE) }).parse(JSON.parse(value.data) as unknown);
    if (data.sourceFacts.length !== aliases.size || data.sourceFacts.some((fact) => !aliases.has(fact.ref)) || new Set(data.sourceFacts.map((fact) => fact.ref)).size !== aliases.size) throw new ChatContextError("INVALID_CONTEXT");
    return value;
  } catch (error) {
    if (error instanceof ChatContextError) throw error;
    throw new ChatContextError("INVALID_CONTEXT");
  }
}
