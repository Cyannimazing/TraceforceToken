import type { Address, CoverageStatus, EvidenceRecord, InvestigationReport } from "@/domain/investigations/types";
import { buildSaleDisplayProofs } from "./investigation-evidence-facts";
import { deriveWalletSignals, type WalletSignal, type WalletFlagLabel } from "@/domain/investigations/wallet-signals";

export interface WalletDisplayFlag {
  id: "source-reported-creator" | "observed-mint" | "early-window-accumulation" | "verified-sale" | WalletFlagLabel;
  label: string;
  basis: string;
  evidenceIds: string[];
  sourceUrl?: string;
}

export interface WalletDisplayFacts {
  firstReceipt: EvidenceRecord | null;
  retainedTransactions: number;
  outgoingTransactionCountRaw: string | null;
  entry: WalletSignal["entry"];
  nativeFunders: Address[];
  fundingStatus: CoverageStatus;
  groups: number[];
  supportedSales: number;
  flags: WalletDisplayFlag[];
}

/** Shared presentation of retained receipt proofs and pinned account state. */
export function buildWalletDisplayFacts(report: InvestigationReport): Map<Address, WalletDisplayFacts> {
  const records = new Map<Address, { first: EvidenceRecord | null; transactions: Set<string>; funders: Set<Address>; sales: string[]; mints: string[] }>();
  const saleProofs = buildSaleDisplayProofs(report);
  const derivedSignals = deriveWalletSignals(report);
  const signals = new Map(derivedSignals.wallets.map((signal) => [signal.address, signal]));
  const evidence = new Map(report.evidence.map((event) => [event.id, event]));
  const entry = (address: Address) => {
    let value = records.get(address);
    if (!value) { value = { first: null, transactions: new Set<string>(), funders: new Set<Address>(), sales: [], mints: [] }; records.set(address, value); }
    return value;
  };
  for (const wallet of report.wallets) entry(wallet.address);
  for (const holder of report.holderSnapshot?.holders ?? []) entry(holder.address);
  const earlier = (left: EvidenceRecord, right: EvidenceRecord) => BigInt(left.blockNumber) < BigInt(right.blockNumber)
    || (left.blockNumber === right.blockNumber && (left.transactionIndex < right.transactionIndex
      || (left.transactionIndex === right.transactionIndex && (left.logIndex ?? -1) < (right.logIndex ?? -1))));
  for (const event of report.evidence) {
    entry(event.from).transactions.add(event.transactionHash);
    const recipient = entry(event.to);
    recipient.transactions.add(event.transactionHash);
    if (event.kind === "transfer" && event.assetAddress === report.token.address && BigInt(event.amountRaw) > 0n
      && (!recipient.first || earlier(event, recipient.first))) recipient.first = event;
    if (event.kind === "funding" && event.assetAddress === null && BigInt(event.amountRaw) > 0n) recipient.funders.add(event.from);
    if (event.kind === "transfer" && event.assetAddress === report.token.address
      && event.from === "0x0000000000000000000000000000000000000000" && BigInt(event.amountRaw) > 0n) recipient.mints.push(event.id);
    if (saleProofs.has(event.id)) entry(event.from).sales.push(event.id);
  }
  const funding = new Map(report.coverage.funding.map((value) => [value.wallet, value.status]));
  return new Map([...records].map(([address, value]) => {
    const flags: WalletDisplayFlag[] = [];
    const signal = signals.get(address);
    const creator = derivedSignals.creator;
    if (signal?.labels.includes("creator") && creator) flags.push({
      id: creator.kind === "direct-contract-creation" ? "creator" : "source-reported-creator", label: creator.kind === "direct-contract-creation" ? "Creator" : "Creator · source-reported", evidenceIds: creator.evidenceIds,
      sourceUrl: creator.sourceUrl,
      basis: creator.basis,
    });
    for (const flag of signal?.flags ?? []) if (flag.label !== "creator") flags.push({ ...flag, id: flag.label });
    if (value.mints.length) flags.push({ id: "observed-mint", label: "Observed mint receipt", evidenceIds: value.mints,
      basis: "Retained investigated-token transfers from the zero address to this address. This does not establish a purchase, creator identity or launch entry." });
    const accumulation = report.coverage.transfers === "complete" ? report.findings.filter((finding) => finding.category === "accumulation"
      && finding.rule.name === "observed-window-net-accumulation" && finding.wallets.includes(address) && finding.evidenceIds.length > 0
      && finding.evidenceIds.every((id) => { const record = evidence.get(id); return record?.kind === "transfer" && record.assetAddress === report.token.address && (record.from === address || record.to === address); })) : [];
    if (accumulation.length) flags.push({ id: "early-window-accumulation", label: "Early-window accumulation",
      evidenceIds: [...new Set(accumulation.flatMap((finding) => finding.evidenceIds))],
      basis: "A retained deterministic finding establishes net inflow in the earliest examined window. This is not launch-relative buying or a sniper classification." });
    if (value.sales.length) flags.push({ id: "verified-sale", label: "Verified sale", evidenceIds: [...new Set(value.sales.flatMap((id) => [id, ...saleProofs.get(id)!.event.sale!.supportingEvidenceIds]))],
      basis: "A supported direct Uniswap sale has retained token-out and quote-in transfer proof. Other routes and intent remain unknown." });
    return [address, {
    firstReceipt: value.first, retainedTransactions: value.transactions.size, nativeFunders: [...value.funders].sort(),
    outgoingTransactionCountRaw: signal?.outgoingTransactionCountRaw ?? null, entry: signal?.entry ?? null,
    fundingStatus: funding.get(address) ?? "not_examined", supportedSales: value.sales.length, flags,
    groups: report.groups.flatMap((group, index) => group.wallets.includes(address) ? [index + 1] : []),
    }];
  }));
}
