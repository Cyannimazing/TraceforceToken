import type { Address, InvestigationReport } from "./types";
import { validateWalletActivitySnapshot } from "./chain-snapshots";
import { validateHolderSnapshot } from "./holder-snapshot";
import { deriveReportDistribution, exactPercent, type ReportDistribution } from "./report-distribution";

/** Presentation only. Contract balances remain part of the report's risk calculations. */
export interface HolderTableDistribution extends ReportDistribution {
  /** Positive eligible balances with contract code at the report's pinned block. */
  contractHolders: InvestigationReport["wallets"];
  /** Positive eligible balances whose account type could not be verified. */
  unclassifiedHolders: InvestigationReport["wallets"];
  /** Includes pinned positive candidates even if a legacy report has no matching wallet row. */
  unclassifiedAddresses: Address[];
  /** Pinned positive candidates omitted from the report's retained wallet rows. */
  unrepresentedAddresses: Address[];
  /** Eligible candidate amounts that remain unknown and cannot be subtracted as zero. */
  unverifiedBalanceAddresses: Address[];
  classificationComplete: boolean;
  excludedContractBalanceRaw: string;
  /** Share of total supply, never the renormalized wallet-table Float. */
  contractSupplySharePercent: string | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/**
 * Wallet-table convention: remove verified contract accounts from the main rows and
 * from its Float, while returning them separately. It does not alter report facts,
 * infrastructure authentication, holder discovery, or the underlying distribution.
 */
export function deriveHolderTableDistribution(report: InvestigationReport): HolderTableDistribution {
  const original = deriveReportDistribution(report);
  let snapshot: InvestigationReport["holderSnapshot"];
  let activity: InvestigationReport["walletActivitySnapshot"];
  try { snapshot = report.holderSnapshot ? validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to) : undefined; }
  catch { snapshot = undefined; }
  try { activity = report.walletActivitySnapshot ? validateWalletActivitySnapshot(report.walletActivitySnapshot, report.range.to) : undefined; }
  catch { activity = undefined; }

  const codes = new Map(activity?.rows.map((row) => [row.address, row.code]) ?? []);
  const excludedAddresses = new Set<string>([ZERO, DEAD, ...(report.infrastructure?.pools ?? [])]);
  const positiveCandidates = snapshot?.holders.filter((row) => !excludedAddresses.has(row.address)
    && row.status === "verified" && row.balanceRaw !== null && BigInt(row.balanceRaw) > 0n) ?? [];
  const representedAddresses = new Set(original.holders.map((row) => row.address));
  const unclassifiedAddresses = positiveCandidates.filter((row) => !["eoa", "contract"].includes(codes.get(row.address) ?? "unavailable"))
    .map((row) => row.address).sort();
  const unrepresentedAddresses = positiveCandidates.filter((row) => !representedAddresses.has(row.address)).map((row) => row.address).sort();
  const unverifiedBalanceAddresses = snapshot?.holders.filter((row) => !excludedAddresses.has(row.address) && row.status !== "verified")
    .map((row) => row.address).sort() ?? [];
  const holders = original.holders.filter((row) => codes.get(row.address) === "eoa");
  const contractHolders = original.holders.filter((row) => codes.get(row.address) === "contract");
  const unclassifiedHolders = original.holders.filter((row) => !["eoa", "contract"].includes(codes.get(row.address) ?? "unavailable"));
  const excludedContracts = positiveCandidates.filter((row) => codes.get(row.address) === "contract")
    .reduce((sum, row) => sum + BigInt(row.balanceRaw!), 0n);
  const total = snapshot?.totalSupplyRaw === null || snapshot?.totalSupplyRaw === undefined ? null : BigInt(snapshot.totalSupplyRaw);
  const classificationComplete = Boolean(snapshot && activity) && unclassifiedAddresses.length === 0 && unrepresentedAddresses.length === 0;
  const baseFloat = original.holdingDenominatorLabel === "float" && original.holdingDenominatorRaw !== null ? BigInt(original.holdingDenominatorRaw) : null;
  const walletFloat = classificationComplete && unverifiedBalanceAddresses.length === 0 && baseFloat !== null && excludedContracts < baseFloat ? baseFloat - excludedContracts : null;
  const holdingDenominatorRaw = walletFloat !== null && walletFloat > 0n ? walletFloat.toString() : total !== null && total > 0n ? total.toString() : null;
  const holdingDenominatorLabel = walletFloat !== null && walletFloat > 0n ? "float" : "total supply";

  return {
    ...original, holders, contractHolders, unclassifiedHolders, unclassifiedAddresses, unrepresentedAddresses, unverifiedBalanceAddresses,
    classificationComplete, holdingDenominatorRaw, holdingDenominatorLabel,
    excludedContractBalanceRaw: excludedContracts.toString(),
    contractSupplySharePercent: total === null ? null : exactPercent(excludedContracts, total),
    definition: holdingDenominatorLabel === "float"
      ? "Wallet-table Float is pinned total supply minus authenticated pool and retained zero/dead burn balances, then minus positive eligible balances with verified contract code at the same block. Contract holdings remain visible separately and included in risk assessment. Account type does not establish ownership or a pool/locker role; discovery may be incomplete."
      : "Wallet shares use pinned total supply because account classification, eligible candidate balances or pool balances are incomplete, infrastructure metadata is absent, or removing contract holdings leaves no positive wallet-table Float. Only verified EOA rows appear in the main table; contract and unclassified holdings remain separate. Missing account code or balances are unknown, not an EOA, a zero holding or proof of infrastructure. Discovery may be incomplete.",
  };
}
