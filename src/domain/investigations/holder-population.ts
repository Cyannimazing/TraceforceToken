import type { Address, InvestigationReport } from "./types";
import { validateHolderSnapshot } from "./holder-snapshot";
import { deriveHolderTableDistribution } from "./holder-table-distribution";

/** Display populations only; these counts never replace acquisition coverage or risk inputs. */
export interface HolderPopulationPresentation {
  walletRows: number;
  contractRows: number;
  unclassifiedRows: number;
  /** Positive pinned candidates including retained authenticated pools and burn addresses. */
  verifiedPositiveCandidates: number | null;
  excludedPoolOrBurnCandidates: number;
  unrepresentedPositiveCandidates: number;
  unknownBalanceCandidates: number | null;
  /** Retained positive, non-infrastructure rows shown in the graph and detailed holdings. */
  shownLabel: string;
}

export function deriveHolderPopulationPresentation(report: InvestigationReport): HolderPopulationPresentation {
  const distribution = deriveHolderTableDistribution(report);
  let snapshot: InvestigationReport["holderSnapshot"];
  try { snapshot = report.holderSnapshot ? validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to) : undefined; }
  catch { snapshot = undefined; }
  const walletRows = distribution.holders.length;
  const contractRows = distribution.contractHolders.length;
  const unclassifiedRows = distribution.unclassifiedHolders.length;
  const parts: string[] = [];
  if (walletRows) parts.push(`${walletRows} ${walletRows === 1 ? "wallet" : "wallets"}`);
  if (contractRows) parts.push(`${contractRows} ${contractRows === 1 ? "contract" : "contracts"}`);
  if (unclassifiedRows) parts.push(`${unclassifiedRows} unclassified ${unclassifiedRows === 1 ? "address" : "addresses"}`);
  return {
    walletRows, contractRows, unclassifiedRows,
    verifiedPositiveCandidates: snapshot ? snapshot.holders.filter((row) => row.status === "verified" && row.balanceRaw !== null && BigInt(row.balanceRaw) > 0n).length : null,
    excludedPoolOrBurnCandidates: distribution.excluded.filter((row) => BigInt(row.balanceRaw) > 0n).length,
    unrepresentedPositiveCandidates: distribution.unrepresentedAddresses.length,
    unknownBalanceCandidates: snapshot ? snapshot.holders.filter((row) => row.status !== "verified").length : null,
    shownLabel: parts.length ? `${parts.join(" + ")} shown` : snapshot ? "No positive holding rows verified" : "Holdings not verified",
  };
}

export interface WalletLinkPresentation {
  walletCount: number;
  linkedGroupCount: number;
  linkedWalletCount: number;
  unlinkedWalletCount: number;
  summaryLabel: string;
  membershipLabel: string;
}

/** Counts observed links among the same visible wallet rows as the table.
 * These are address memberships, never a count of owners or people. Groups can
 * be connected through retained addresses outside the visible wallet cohort. */
export function deriveWalletLinkPresentation(report: InvestigationReport): WalletLinkPresentation {
  const wallets = new Set(deriveHolderTableDistribution(report).holders.map((holder) => holder.address));
  const linked = new Set<Address>();
  const memberships = new Set<string>();
  for (const group of report.groups) {
    const members = [...new Set(group.wallets.filter((address) => wallets.has(address)))].sort();
    if (members.length < 2) continue;
    memberships.add(members.join(":"));
    for (const address of members) linked.add(address);
  }
  const walletCount = wallets.size, linkedGroupCount = memberships.size, linkedWalletCount = linked.size;
  const unlinkedWalletCount = walletCount - linkedWalletCount;
  return {
    walletCount, linkedGroupCount, linkedWalletCount, unlinkedWalletCount,
    summaryLabel: `${walletCount} ${walletCount === 1 ? "wallet" : "wallets"} · ${linkedGroupCount} linked ${linkedGroupCount === 1 ? "group" : "groups"}`,
    membershipLabel: `${linkedWalletCount} linked · ${unlinkedWalletCount} unlinked in this scan`,
  };
}

export interface HolderPopulationBreakdown extends Omit<HolderPopulationPresentation, "shownLabel"> {
  label: string;
}

/** Disjoint accounting of verified positive candidates at the pinned block.
 * A source-reported global count never enters this partition. Unknown balances
 * stay separate, and unmatched positive candidates are disclosed explicitly. */
export function deriveHolderPopulationBreakdown(report: InvestigationReport): HolderPopulationBreakdown {
  let snapshot: InvestigationReport["holderSnapshot"];
  try { snapshot = report.holderSnapshot ? validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to) : undefined; }
  catch { snapshot = undefined; }
  if (!snapshot) return {
    walletRows: 0, contractRows: 0, unclassifiedRows: 0, verifiedPositiveCandidates: null,
    excludedPoolOrBurnCandidates: 0, unrepresentedPositiveCandidates: 0, unknownBalanceCandidates: null,
    label: "Holdings not verified",
  };
  const distribution = deriveHolderTableDistribution(report);
  const positive = new Set(snapshot.holders.filter((row) => row.status === "verified" && row.balanceRaw !== null && BigInt(row.balanceRaw) > 0n).map((row) => row.address));
  const remaining = new Set(positive);
  const take = (addresses: readonly Address[]) => {
    let count = 0;
    for (const address of new Set(addresses)) if (remaining.delete(address)) count++;
    return count;
  };
  const excludedPoolOrBurnCandidates = take(distribution.excluded.map((row) => row.address));
  const walletRows = take(distribution.holders.map((row) => row.address));
  const contractRows = take(distribution.contractHolders.map((row) => row.address));
  const unclassifiedRows = take(distribution.unclassifiedHolders.map((row) => row.address));
  const unrepresentedPositiveCandidates = remaining.size;
  const unknownBalanceCandidates = new Set(snapshot.holders.filter((row) => row.status !== "verified").map((row) => row.address)).size;
  const parts = [
    walletRows ? `${walletRows} ${walletRows === 1 ? "wallet" : "wallets"}` : null,
    contractRows ? `${contractRows} ${contractRows === 1 ? "contract" : "contracts"}` : null,
    unclassifiedRows ? `${unclassifiedRows} unclassified ${unclassifiedRows === 1 ? "address" : "addresses"}` : null,
    excludedPoolOrBurnCandidates ? `${excludedPoolOrBurnCandidates} pool/burn ${excludedPoolOrBurnCandidates === 1 ? "address" : "addresses"}` : null,
    unrepresentedPositiveCandidates ? `${unrepresentedPositiveCandidates} other positive ${unrepresentedPositiveCandidates === 1 ? "address" : "addresses"}` : null,
  ].filter((part): part is string => part !== null);
  return {
    walletRows, contractRows, unclassifiedRows, verifiedPositiveCandidates: positive.size,
    excludedPoolOrBurnCandidates, unrepresentedPositiveCandidates, unknownBalanceCandidates,
    label: `${positive.size} positive ${positive.size === 1 ? "address" : "addresses"} checked${parts.length ? `: ${parts.join(" + ")}` : ""}`,
  };
}
