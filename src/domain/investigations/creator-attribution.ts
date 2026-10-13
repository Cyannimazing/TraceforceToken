import { z } from "@/lib/validation";
import type { Address, EvidenceRecord, Hash, InvestigationReport } from "./types";
import { tokenSecuritySnapshotSchema } from "./token-security";

const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
const ZERO = `0x${"0".repeat(40)}`;
export const creationAnnotationSchema = z.object({ creator: address, contractAddress: address,
  transactionTo: z.null(), receiptStatus: z.literal("0x1") }).strict();
type CreationReport = Pick<InvestigationReport, "token" | "range" | "evidence">;
export interface CreatorAttribution {
  address: Address;
  kind: "direct-contract-creation" | "source-reported";
  source: "Base RPC" | "GoPlus";
  sourceUrl: string;
  checkedAt: string;
  basis: string;
  evidenceIds: string[];
  transactionHash: Hash | null;
  blockNumber: string | null;
  /** Present only when the lower-priority source disagrees with direct deployment proof. */
  conflictingReportedCreator?: Address;
}

/** Receipt acquisition proves this annotation; shared boundaries preserve its semantics. */
export function validateCreationAnnotations(report: CreationReport): void {
  const annotated = report.evidence.filter((event) => event.creation !== undefined);
  if (!annotated.length) return;
  let deployment: string | undefined;
  const receiptIdentities = new Map<Hash, string>();
  for (const event of report.evidence) {
    const identity = `${event.blockNumber}:${event.blockHash}:${event.transactionIndex}:${event.timestamp}`;
    const previous = receiptIdentities.get(event.transactionHash);
    if (previous !== undefined && previous !== identity) throw new Error("Inconsistent deployment transaction context.");
    receiptIdentities.set(event.transactionHash, identity);
  }
  for (const event of annotated) {
    const creation = creationAnnotationSchema.parse(event.creation);
    if (event.kind !== "transfer" || event.chainId !== report.token.chainId || event.assetAddress !== report.token.address
      || event.from !== ZERO || event.to === ZERO || event.logIndex === null || event.traceId !== null || event.sale !== null || event.purchase !== undefined
      || creation.creator === ZERO || creation.creator === creation.contractAddress || creation.contractAddress !== report.token.address
      || !/^(?:0|[1-9][0-9]{0,77})$/.test(event.amountRaw) || BigInt(event.amountRaw) <= 0n || BigInt(event.amountRaw) >= 2n ** 256n
      || !/^(?:0|[1-9][0-9]*)$/.test(event.blockNumber) || BigInt(event.blockNumber) < BigInt(report.range.from.number) || BigInt(event.blockNumber) > BigInt(report.range.to.number)
      || !Number.isSafeInteger(event.timestamp) || event.timestamp < report.range.from.timestamp || event.timestamp > report.range.to.timestamp
      || !Number.isSafeInteger(event.transactionIndex) || event.transactionIndex < 0 || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0
      || !/^0x[0-9a-f]{64}$/.test(event.blockHash) || !/^0x[0-9a-f]{64}$/.test(event.transactionHash)) throw new Error("Invalid direct contract-creation annotation.");
    for (const boundary of [report.range.from, report.range.to]) if (event.blockNumber === boundary.number && (event.blockHash !== boundary.hash || event.timestamp !== boundary.timestamp)) throw new Error("Deployment disagrees with the pinned range.");
    const identity = `${event.transactionHash}:${event.blockNumber}:${event.blockHash}:${event.transactionIndex}:${event.timestamp}:${creation.creator}`;
    if (deployment !== undefined && deployment !== identity) throw new Error("Conflicting direct contract-creation annotations.");
    deployment = identity;
  }
}

/** A directly deployed contract's transaction sender is not a verified person or present owner. */
export function deriveCreatorAttribution(report: CreationReport): CreatorAttribution | null {
  validateCreationAnnotations(report);
  const parsed = tokenSecuritySnapshotSchema.safeParse(report.token.securitySnapshot);
  const security = parsed.success && parsed.data.status === "reported" && parsed.data.tokenAddress === report.token.address && parsed.data.chainId === report.token.chainId ? parsed.data : null;
  const creation = report.evidence.filter((event): event is EvidenceRecord & { creation: NonNullable<EvidenceRecord["creation"]> } => event.creation !== undefined)
    .sort((a, b) => a.logIndex! - b.logIndex! || a.id.localeCompare(b.id))[0];
  const conflictingReportedCreator = creation && security?.creatorAddress && security.creatorAddress !== ZERO && security.creatorAddress !== creation.creation.creator ? security.creatorAddress : undefined;
  if (creation) return { address: creation.creation.creator, kind: "direct-contract-creation", source: "Base RPC", sourceUrl: `https://basescan.org/tx/${creation.transactionHash}`,
    checkedAt: creation.provenance.observedAt, evidenceIds: [creation.id], transactionHash: creation.transactionHash, blockNumber: creation.blockNumber,
    ...(conflictingReportedCreator ? { conflictingReportedCreator } : {}),
    basis: "Receipt-backed successful direct contract creation: the canonical transaction sender deployed this exact token with transaction.to=null and matching receipt.contractAddress. This establishes the deploying address, not developer identity, present ownership or privileged control."
      + (conflictingReportedCreator ? ` GoPlus separately reports ${conflictingReportedCreator}; the direct deployment receipt takes precedence.` : "") };
  return security?.creatorAddress && security.creatorAddress !== ZERO ? { address: security.creatorAddress, kind: "source-reported", source: "GoPlus", sourceUrl: security.sourceUrl,
    checkedAt: security.checkedAt, evidenceIds: [], transactionHash: null, blockNumber: null,
    basis: "GoPlus source-reported creator address; the creation transaction, developer identity, present ownership and privileged control were not verified." } : null;
}
