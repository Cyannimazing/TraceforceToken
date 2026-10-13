import type { Address, InvestigationReport } from "@/domain/investigations/types";
import { deriveHolderTableDistribution } from "@/domain/investigations/holder-table-distribution";
import { deriveReportDistribution } from "@/domain/investigations/report-distribution";
import { collectGraphAddresses } from "./investigation-graph-geometry";

export type GraphViewMode = "wallets" | "all-addresses";

/** Presentation only: the default graph and the main table compare the same wallets. */
export function deriveInvestigationGraphView(
  report: InvestigationReport,
  requestedMode: GraphViewMode = "wallets",
  selected: Address | null = null,
) {
  const table = deriveHolderTableDistribution(report);
  const allDistribution = deriveReportDistribution(report);
  const allAddresses = collectGraphAddresses(report);
  const walletAddresses = table.holders.map((holder) => holder.address);
  const hasWalletView = walletAddresses.length > 0;
  // A citation or supplemental contract row must reveal its real context rather
  // than silently selecting an address absent from the default wallet view.
  const mode: GraphViewMode = requestedMode === "wallets" && hasWalletView
    && (selected === null || walletAddresses.includes(selected)) ? "wallets" : "all-addresses";
  const distribution = mode === "wallets" ? table : allDistribution;
  return {
    mode,
    addresses: mode === "wallets" ? walletAddresses : allAddresses,
    allAddresses,
    walletAddresses,
    hasWalletView,
    walletCount: walletAddresses.length,
    contractCount: table.contractHolders.length,
    unclassifiedCount: table.unclassifiedHolders.length,
    holdingDenominatorRaw: distribution.holdingDenominatorRaw,
    holdingDenominatorLabel: distribution.holdingDenominatorLabel,
    holdingBasisMatchesWallets: distribution.holdingDenominatorRaw === table.holdingDenominatorRaw,
  };
}
