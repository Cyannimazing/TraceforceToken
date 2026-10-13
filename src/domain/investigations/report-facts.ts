import { deriveCreatorAttribution, type CreatorAttribution } from "./creator-attribution";
import { validateHolderSnapshot } from "./holder-snapshot";
import { tokenMarketSnapshotSchema } from "./token-market";
import { goPlusTokenUrl, tokenSecuritySnapshotSchema } from "./token-security";
import type { Address, BlockReference, HolderSnapshot, InvestigationReport, TokenSecurityCheckId } from "./types";

/** An exact fraction of pinned total supply, never a circulating-supply estimate. */
export interface ExactSupplyShare { amountRaw: string; totalSupplyRaw: string }
export interface PinnedAddressHolding {
  block: BlockReference;
  status: "verified" | "unavailable" | "not_examined" | "missing";
  balanceRaw: string | null;
  shareOfSupply: ExactSupplyShare | null;
}
export interface PinnedBalanceSubtotal {
  block: BlockReference;
  totalAddresses: number;
  verifiedAddresses: number;
  unavailableAddresses: number;
  notExaminedAddresses: number;
  missingAddresses: number;
  /** Null when no address has a verified read; verified zero remains "0". */
  knownBalanceRaw: string | null;
  shareOfSupply: ExactSupplyShare | null;
  isLowerBound: boolean;
}
export interface CreatorReportFacts {
  attribution: CreatorAttribution;
  address: Address;
  sourceUrl: string;
  checkedAt: string;
  qualification: string;
  holding: PinnedAddressHolding | null;
  evidence: { nativeSentIds: string[]; nativeReceivedIds: string[]; tokenSentIds: string[]; tokenReceivedIds: string[] };
}
export interface GroupHoldingFacts { id: string; addresses: Address[]; holding: PinnedBalanceSubtotal | null }
export interface SetAsideInventory {
  addresses: (HolderSnapshot["holders"][number] & { role: "Authenticated pool" | "Burn address" | "Unclassified"; reason: string })[];
  holding: PinnedBalanceSubtotal;
  discovery: HolderSnapshot["discovery"];
  provenance: HolderSnapshot["provenance"];
}
interface SignalBase { id: string; label: string; limitations: string[] }
export type ReportConcernSignal =
  | (SignalBase & { kind: "concentration"; address: Address; balanceRaw: string; shareOfSupply: ExactSupplyShare; block: BlockReference; thresholdBasisPoints: 1000 })
  | (SignalBase & { kind: "thin-liquidity"; pairAddress: Address; liquidityUsd: number; thresholdUsd: 10000; sourceUrl: string; checkedAt: string })
  | (SignalBase & { kind: "contract-flag"; checkId: TokenSecurityCheckId; reportedValue: "yes" | "no"; level: "review" | "context"; sourceUrl: string; checkedAt: string });
export interface SupplementalReportFacts {
  version: "1.0.0";
  creator: CreatorReportFacts | null;
  groups: GroupHoldingFacts[];
  setAside: SetAsideInventory | null;
  signals: ReportConcernSignal[];
}

const ZERO = `0x${"0".repeat(40)}`;
const DEAD = "0x000000000000000000000000000000000000dead";
const distinct = (addresses: Address[]) => [...new Set(addresses)].sort();
const copyBlock = (block: BlockReference): BlockReference => ({ ...block });
const share = (amountRaw: string | null, supply: string | null): ExactSupplyShare | null =>
  amountRaw !== null && supply !== null && BigInt(supply) > 0n ? { amountRaw, totalSupplyRaw: supply } : null;

function excludedAddressRole(address: Address, pools: Set<Address>): Pick<SetAsideInventory["addresses"][number], "role" | "reason"> {
  if (address === ZERO || address === DEAD) return {
    role: "Burn address", reason: "Known zero or dead burn address; excluded from holder-wallet counts.",
  };
  if (pools.has(address)) return {
    role: "Authenticated pool", reason: "Authenticated liquidity pool retained in this report; excluded from holder-wallet counts.",
  };
  return { role: "Unclassified", reason: "Outside the analyzer's eligible wallet set; its role is unverified." };
}

function subtotal(snapshot: HolderSnapshot, addresses: Address[]): PinnedBalanceSubtotal {
  const unique = distinct(addresses), byAddress = new Map(snapshot.holders.map((holder) => [holder.address, holder]));
  const rows = unique.map((address) => byAddress.get(address));
  const verified = rows.filter((row) => row?.status === "verified");
  const knownBalanceRaw = unique.length === 0 ? "0" : verified.length ? verified.reduce((sum, row) => sum + BigInt(row!.balanceRaw!), 0n).toString() : null;
  return {
    block: copyBlock(snapshot.block), totalAddresses: unique.length, verifiedAddresses: verified.length,
    unavailableAddresses: rows.filter((row) => row?.status === "unavailable").length,
    notExaminedAddresses: rows.filter((row) => row?.status === "not_examined").length,
    missingAddresses: rows.filter((row) => !row).length,
    knownBalanceRaw, shareOfSupply: share(knownBalanceRaw, snapshot.totalSupplyRaw), isLowerBound: verified.length !== unique.length,
  };
}

const FLAG_LABELS: Partial<Record<TokenSecurityCheckId, string>> = {
  is_honeypot: "GoPlus reports a honeypot flag",
  is_proxy: "GoPlus reports a proxy contract",
  is_mintable: "GoPlus reports minting capability",
  hidden_owner: "GoPlus reports a hidden-owner flag",
  can_take_back_ownership: "GoPlus reports ownership can be reclaimed",
  owner_change_balance: "GoPlus reports an owner balance-change capability",
  transfer_pausable: "GoPlus reports transfers can be paused",
  is_blacklisted: "GoPlus reports a blacklist flag",
};

/**
 * Pure supplemental display facts over a validated report. No new acquisition,
 * score, ownership inference, deployment verification, or holder census.
 */
export function deriveSupplementalReportFacts(report: InvestigationReport): SupplementalReportFacts {
  const snapshot = report.holderSnapshot ? validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to) : null;
  const security = report.token.securitySnapshot ? tokenSecuritySnapshotSchema.parse(report.token.securitySnapshot) : null;
  if (security && (security.tokenAddress !== report.token.address || security.chainId !== report.token.chainId || security.sourceUrl !== goPlusTokenUrl(report.token.address))) {
    throw new Error("Security context does not match the investigated token.");
  }
  const market = report.token.marketSnapshot ? tokenMarketSnapshotSchema.parse(report.token.marketSnapshot) : null;
  if (market && market.sourceUrl !== `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`) {
    throw new Error("Market context does not match the investigated token.");
  }
  const eligible = new Set(report.wallets.map((wallet) => wallet.address));
  const signals: ReportConcernSignal[] = [];
  if (snapshot && snapshot.totalSupplyRaw !== null && BigInt(snapshot.totalSupplyRaw) > 0n) {
    for (const holder of snapshot.holders) if (eligible.has(holder.address) && holder.address !== ZERO
      && holder.status === "verified" && BigInt(holder.balanceRaw!) * 10n >= BigInt(snapshot.totalSupplyRaw)) {
      signals.push({ id: `concentration:${holder.address}`, kind: "concentration", label: "Examined address holds at least 10% of pinned total supply",
        address: holder.address, balanceRaw: holder.balanceRaw!, shareOfSupply: share(holder.balanceRaw, snapshot.totalSupplyRaw)!,
        block: copyBlock(snapshot.block), thresholdBasisPoints: 1000,
        limitations: ["A local review threshold, not an ownership or manipulation conclusion.", "Incomplete discovery cannot establish a global holder ranking; unrecognized infrastructure may remain."] });
    }
  }
  if (market?.status === "reported" && market.pairAddress && market.liquidityUsd !== null && market.liquidityUsd < 10_000) {
    signals.push({ id: "selected-pair-thin-liquidity", kind: "thin-liquidity", label: "Selected pair reports liquidity below $10,000",
      pairAddress: market.pairAddress, liquidityUsd: market.liquidityUsd, thresholdUsd: 10000, sourceUrl: market.sourceUrl, checkedAt: market.checkedAt,
      limitations: ["The $10,000 threshold is a local review convention, not a risk probability.", "DEX Screener reports an approximate latest selected-pair value; this is not total token liquidity, executable depth, or a finalized balance."] });
  }
  if (security?.status === "reported") for (const check of [...security.checks].sort((a, b) => a.id.localeCompare(b.id))) {
    const label = check.id === "is_open_source" && check.value === "no" ? "GoPlus does not mark the contract source as open" : check.value === "yes" ? FLAG_LABELS[check.id] : undefined;
    if (label) signals.push({ id: `contract:${check.id}`, kind: "contract-flag", label, checkId: check.id,
      reportedValue: check.value as "yes" | "no", level: check.id === "is_proxy" ? "context" : "review", sourceUrl: security.sourceUrl, checkedAt: security.checkedAt,
      limitations: ["A latest third-party flag, not a pinned receipt-backed finding or independent contract audit.", ...(check.id === "is_proxy" ? ["A proxy alone does not establish unsafe behavior or who controls upgrades."] : ["The flag warrants source review; it does not establish exploitation, ownership, or overall safety."])] });
  }

  let creator: CreatorReportFacts | null = null;
  const attribution = deriveCreatorAttribution(report);
  if (attribution) {
    const address = attribution.address;
    const row = snapshot?.holders.find((holder) => holder.address === address);
    const ids = (kind: "funding" | "transfer", direction: "from" | "to") => [...new Set(report.evidence.filter((event) => event.kind === kind
      && event[direction] === address && (kind === "funding" ? event.assetAddress === null && BigInt(event.amountRaw) > 0n : event.assetAddress === report.token.address)).map((event) => event.id))].sort();
    creator = {
      address, attribution, sourceUrl: attribution.sourceUrl, checkedAt: attribution.checkedAt,
      qualification: attribution.basis,
      holding: snapshot ? { block: copyBlock(snapshot.block), status: row?.status ?? "missing", balanceRaw: row?.balanceRaw ?? null, shareOfSupply: share(row?.balanceRaw ?? null, snapshot.totalSupplyRaw) } : null,
      evidence: { nativeSentIds: ids("funding", "from"), nativeReceivedIds: ids("funding", "to"), tokenSentIds: ids("transfer", "from"), tokenReceivedIds: ids("transfer", "to") },
    };
  }
  const groups = [...report.groups].sort((a, b) => a.id.localeCompare(b.id)).map((group) => ({ id: group.id, addresses: distinct(group.wallets), holding: snapshot ? subtotal(snapshot, group.wallets) : null }));
  const setAsideRows = snapshot?.holders.filter((holder) => !eligible.has(holder.address)) ?? [];
  const pools = new Set(report.infrastructure?.pools ?? []);
  const setAside = snapshot ? {
    addresses: setAsideRows.map((holder) => ({ ...holder, ...excludedAddressRole(holder.address, pools) })),
    holding: subtotal(snapshot, setAsideRows.map((holder) => holder.address)), discovery: { ...snapshot.discovery }, provenance: { ...snapshot.provenance },
  } : null;
  return { version: "1.0.0", creator, groups, setAside, signals: signals.sort((a, b) => a.id.localeCompare(b.id)) };
}
