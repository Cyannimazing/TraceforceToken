import type { InvestigationReport } from "./types";

export interface EvidenceReplayFrame {
  block: string;
  timestamp: number;
  observedAddresses: number;
  transfers: number;
  funding: number;
  supportedSales: number;
}

/** Cumulative retained observations, never a historical balance or holder census. */
export function buildEvidenceReplay(report: InvestigationReport): EvidenceReplayFrame[] {
  const fromBlock = BigInt(report.range.from.number), toBlock = BigInt(report.range.to.number);
  // Funding history may predate the token window. It still supports the report,
  // but must not move this bounded token-activity replay backwards in time.
  const events = report.evidence.filter((event) => {
    const block = BigInt(event.blockNumber);
    return block >= fromBlock && block <= toBlock
      && (event.kind === "funding" || event.assetAddress === report.token.address);
  }).sort((a, b) => {
    const difference = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    return difference < 0n ? -1 : difference > 0n ? 1 : a.transactionIndex - b.transactionIndex || (a.logIndex ?? -1) - (b.logIndex ?? -1) || a.id.localeCompare(b.id);
  });
  const addresses = new Set<string>();
  const seen = new Set<string>();
  const frames: EvidenceReplayFrame[] = [{ block: report.range.from.number, timestamp: report.range.from.timestamp, observedAddresses: 0, transfers: 0, funding: 0, supportedSales: 0 }];
  let transfers = 0, funding = 0, supportedSales = 0;
  const zero = "0x0000000000000000000000000000000000000000";
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.kind === "transfer" && event.assetAddress === report.token.address) {
      transfers++;
      if (event.from !== zero) addresses.add(event.from);
      if (event.to !== zero) addresses.add(event.to);
    } else if (event.kind === "funding") funding++;
    else if (event.kind === "sale") supportedSales++;
    const next = { block: event.blockNumber, timestamp: event.timestamp, observedAddresses: addresses.size, transfers, funding, supportedSales };
    if (frames.length > 1 && frames.at(-1)!.block === event.blockNumber) frames[frames.length - 1] = next;
    else frames.push(next);
  }
  if (frames.at(-1)!.block !== report.range.to.number) frames.push({ block: report.range.to.number, timestamp: report.range.to.timestamp, observedAddresses: addresses.size, transfers, funding, supportedSales });
  // Bound rendering/animation frames, while keeping exact cumulative end counts.
  if (frames.length <= 200) return frames;
  return Array.from({ length: 200 }, (_, index) => frames[Math.floor(index * (frames.length - 1) / 199)]);
}
