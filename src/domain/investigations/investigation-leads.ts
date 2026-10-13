import type { Address, EvidenceRecord, InvestigationFinding, InvestigationReport } from "./types";
import { deriveReportDistribution, exactPercent } from "./report-distribution";
import { deriveWalletSignals, verifiedPurchaseProof } from "./wallet-signals";

export interface InvestigationLead {
  id: string;
  kind: "shared-funding" | "linked-selling" | "funding-gap" | "direct-transfer" | "early-buy";
  title: string;
  wallets: Address[];
  observed: string;
  evidenceIds: string[];
  basis: "retained-transactions" | "pinned-balance-and-coverage" | "source-context-and-coverage";
  nextCheck: string;
  limitation: string;
  sourceUrl?: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";
type Position = Pick<EvidenceRecord, "blockNumber" | "transactionIndex" | "logIndex">;
const ordered = (left: Position, right: Position) => BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1
  : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1 : left.transactionIndex - right.transactionIndex || (left.logIndex ?? -1) - (right.logIndex ?? -1);
const unique = <T extends string>(values: T[]) => [...new Set(values)].sort();

/** Suggested checks over a validated report, never additional acquired evidence
 * or LLM findings. Missing searches get no invented transaction citations. */
export function deriveInvestigationLeads(report: InvestigationReport): InvestigationLead[] {
  const byId = new Map(report.evidence.map((event) => [event.id, event]));
  if (byId.size !== report.evidence.length) return [];
  const distribution = deriveReportDistribution(report), signals = deriveWalletSignals(report);
  const positive = new Map(distribution.holders.map((wallet) => [wallet.address, BigInt(wallet.balanceRaw!)]));
  const candidates: { lead: InvestigationLead; priority: number; amount: bigint }[] = [];
  const push = (lead: InvestigationLead, priority: number) => candidates.push({ lead, priority,
    amount: lead.wallets.reduce((sum, wallet) => sum + (positive.get(wallet) ?? 0n), 0n) });
  const retained = (finding: InvestigationFinding) => {
    const events = finding.evidenceIds.map((id) => byId.get(id));
    return events.length && events.every((event) => event !== undefined) && new Set(finding.evidenceIds).size === events.length ? events as EvidenceRecord[] : null;
  };
  for (const finding of report.findings) {
    const events = retained(finding);
    if (!events) continue;
    if (finding.category === "funding" && finding.rule.name === "shared-observed-native-source") {
      const source = events[0].from, recipients = unique(events.map((event) => event.to));
      if (recipients.length < 2 || source === ZERO || events.some((event) => event.kind !== "funding" || event.assetAddress !== null || event.from !== source || event.from === event.to || BigInt(event.amountRaw) <= 0n)) continue;
      push({ id: `lead:${finding.id}`, kind: "shared-funding", title: "Trace the shared funder upstream", wallets: [source, ...recipients],
        observed: `One retained source sent native ETH to ${recipients.length} distinct token wallets.`, evidenceIds: unique(finding.evidenceIds), basis: "retained-transactions",
        nextCheck: "Inspect this source's earlier inbound funding and check whether it is an exchange, bridge or public service before attributing the recipient wallets.",
        limitation: "Shared funding is an investigative link, not proof of common ownership; upstream funding is not automatically crawled." }, 100);
    } else if (finding.category === "selling" && finding.rule.name === "prior-linked-verified-selling") {
      const sales = events.filter((event) => event.kind === "sale" && event.sale !== null);
      if (unique(sales.map((event) => event.from)).length < 2 || sales.some((event) => event.sale!.supportingEvidenceIds.some((id) => !finding.evidenceIds.includes(id) || !byId.has(id)))) continue;
      const links = events.filter((event) => event.kind !== "sale" && !sales.some((sale) => sale.sale!.supportingEvidenceIds.includes(event.id)));
      if (!links.length || links.some((event) => ordered(event, [...sales].sort(ordered)[0]) >= 0)) continue;
      push({ id: `lead:${finding.id}`, kind: "linked-selling", title: "Follow the linked sellers' proceeds", wallets: unique(sales.map((event) => event.from)),
        observed: `${unique(sales.map((event) => event.from)).length} previously linked wallets have supported token-out / quote-in sales within the finding's bounded interval.`, evidenceIds: unique(finding.evidenceIds), basis: "retained-transactions",
        nextCheck: "Inspect the sellers' later quote-asset transfers for shared destinations, verifying each receipt before extending the relationship.",
        limitation: "Prior links and sale timing do not prove coordinated intent; later proceeds have not been traced by this lead." }, 90);
    } else if (finding.category === "connections" && finding.rule.name === "direct-token-transfer" && events.length === 1) {
      const event = events[0];
      if (event.kind !== "transfer" || event.assetAddress !== report.token.address || event.from === event.to || [event.from, event.to].includes(ZERO as Address) || BigInt(event.amountRaw) <= 0n) continue;
      push({ id: `lead:${finding.id}`, kind: "direct-transfer", title: "Inspect the direct wallet transfer", wallets: [event.from, event.to],
        observed: "A retained token transfer directly connects this sender and recipient.", evidenceIds: [event.id], basis: "retained-transactions",
        nextCheck: "Inspect this receipt and each endpoint's retained funding and supported trades to distinguish a payment or distribution from a repeated relationship.",
        limitation: "A transfer alone does not establish common control or a purchase." }, signals.creator && [event.from, event.to].includes(signals.creator.address) ? 85 : 50);
    }
  }

  const important = unique([...(signals.creator ? [signals.creator.address] : []), ...distribution.holders.slice(0, 3).map((wallet) => wallet.address)]);
  for (const wallet of important) {
    const coverage = report.coverage.funding.find((row) => row.wallet === wallet);
    if (coverage?.status === "complete") continue;
    const creator = signals.creator?.address === wallet, balance = positive.get(wallet);
    const share = balance !== undefined && distribution.holdingDenominatorRaw ? exactPercent(balance, BigInt(distribution.holdingDenominatorRaw)) : null;
    const activity = report.walletActivitySnapshot?.block.hash === report.range.to.hash && report.walletActivitySnapshot.block.number === report.range.to.number
      ? report.walletActivitySnapshot.rows.find((row) => row.address === wallet) : undefined;
    const status = coverage?.status ?? "not_examined";
    push({ id: `lead:funding-gap:${wallet}`, kind: "funding-gap", title: creator ? "Complete the creator's funding trail" : "Complete a top holder's funding trail", wallets: [wallet],
      observed: `${creator ? "GoPlus reports this creator address. " : ""}${balance !== undefined ? `Its positive balance is pinned to block ${report.range.to.number}${share !== null ? ` (${share}% of ${distribution.holdingDenominatorLabel})` : ""}. ` : ""}Funding search: ${status.replaceAll("_", " ")}${coverage ? ` for blocks ${coverage.fromBlock}–${coverage.toBlock}` : "; no search row was retained"}.`,
      evidenceIds: [], basis: balance !== undefined ? "pinned-balance-and-coverage" : "source-context-and-coverage",
      nextCheck: activity?.code === "contract" ? "Use a supported contract/internal-transfer trace source to inspect this wallet's inbound funding; the current top-level EOA adapter cannot complete that trail."
        : coverage ? `Complete this wallet's inbound native funding search for blocks ${coverage.fromBlock}–${coverage.toBlock}, verifying indexed candidates against canonical transactions and successful receipts.`
          : "Acquire this wallet's bounded inbound native funding and verify candidate transactions and successful receipts before naming a funder.",
      limitation: "A missing or incomplete search cannot establish an unfunded wallet. This lead cites snapshot/coverage state, not a transaction proving absence.",
      ...(creator ? { sourceUrl: signals.creator!.sourceUrl } : {}) }, creator ? 95 : 80);
  }

  const initial = signals.initialLiquidity;
  if (initial) {
    const purchase = report.evidence.map((event) => ({ event, proof: verifiedPurchaseProof(report, event) })).filter((entry) => entry.proof?.pool === initial.pool && entry.proof.factory === initial.factory
      && ordered(entry.proof, initial) > 0)
      .sort((left, right) => ordered(left.event, right.event))[0];
    if (purchase?.proof) push({ id: `lead:early-buy:${purchase.event.id}`, kind: "early-buy", title: "Trace the earliest supported pool buyer", wallets: [purchase.proof.wallet],
      observed: "This is the earliest retained supported buy after the authenticated pool's initial liquidity.", evidenceIds: unique([...initial.evidenceIds, ...purchase.proof.evidenceIds]), basis: "retained-transactions",
      nextCheck: "Compare this buyer's retained pre-buy funding with the initial liquidity provider and other early buyers; verify missing funding before extending any link.",
      limitation: "The anchor is this pool's initialization, not a universal token launch. Early timing alone does not prove an insider or shared owner." }, 70);
  }
  candidates.sort((left, right) => right.priority - left.priority || (left.amount > right.amount ? -1 : left.amount < right.amount ? 1 : left.lead.id.localeCompare(right.lead.id)));
  const counts = new Map<InvestigationLead["kind"], number>(), selected: InvestigationLead[] = [];
  for (const { lead } of candidates) {
    if ((counts.get(lead.kind) ?? 0) >= (lead.kind === "shared-funding" || lead.kind === "funding-gap" ? 2 : 1)) continue;
    selected.push(lead); counts.set(lead.kind, (counts.get(lead.kind) ?? 0) + 1);
    if (selected.length === 6) break;
  }
  return selected;
}
