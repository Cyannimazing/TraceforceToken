import type { EvidenceRecord, InvestigationReport } from "@/domain/investigations/types";

export interface SaleDisplayProof {
  event: EvidenceRecord;
  supportingEvidence: EvidenceRecord[];
}

/** Display only a retained sale annotation with its entire same-receipt proof. */
export function buildSaleDisplayProofs(report: InvestigationReport): Map<string, SaleDisplayProof> {
  const records = new Map(report.evidence.map((event) => [event.id, event]));
  const proofs = new Map<string, SaleDisplayProof>();
  for (const event of report.evidence) {
    const sale = event.sale;
    if (event.kind !== "sale" || event.assetAddress !== report.token.address || !sale
      || event.to !== sale.pool || !["uniswap-v2", "uniswap-v3"].includes(sale.protocol) || BigInt(event.amountRaw) <= 0n
      || BigInt(sale.quoteAmountRaw) <= 0n || sale.supportingEvidenceIds.length < 2
      || new Set(sale.supportingEvidenceIds).size !== sale.supportingEvidenceIds.length) continue;
    const support = sale.supportingEvidenceIds.map((id) => records.get(id));
    if (support.some((record) => !record || record.kind !== "transfer" || record.transactionHash !== event.transactionHash
      || record.blockHash !== event.blockHash || record.blockNumber !== event.blockNumber)) continue;
    const retained = support as EvidenceRecord[];
    const direct = (from: string, to: string, asset: string) => retained.filter((record) => record.from === from && record.to === to && record.assetAddress === asset)
      .reduce((sum, record) => sum + BigInt(record.amountRaw), 0n);
    if (direct(event.from, sale.pool, report.token.address) !== BigInt(event.amountRaw)
      || direct(sale.pool, event.from, sale.quoteAsset) !== BigInt(sale.quoteAmountRaw)) continue;
    proofs.set(event.id, { event, supportingEvidence: retained });
  }
  return proofs;
}

/** Native funding has its own per-wallet window and can predate token activity. */
export function retainedFundingRecords(report: InvestigationReport): EvidenceRecord[] {
  return report.evidence.filter((event) => event.kind === "funding" && event.assetAddress === null && BigInt(event.amountRaw) > 0n)
    .sort((left, right) => {
      const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
      return block < 0n ? -1 : block > 0n ? 1 : left.transactionIndex - right.transactionIndex || left.id.localeCompare(right.id);
    });
}
