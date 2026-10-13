import type { Address, InvestigationReport } from "./types";
import { validateHolderSnapshot } from "./holder-snapshot";

export interface ReportDistribution {
  holdingDenominatorRaw: string | null;
  holdingDenominatorLabel: "float" | "total supply";
  definition: string;
  excluded: { address: Address; balanceRaw: string }[];
  missingPoolBalances: Address[];
  /** Pinned positive eligible candidates, not a claim of an exhaustive holder census. */
  holders: InvestigationReport["wallets"];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/** Exact display denominator. Only authenticated pools and retained burn balances are excluded. */
export function deriveReportDistribution(report: InvestigationReport): ReportDistribution {
  let snapshot: InvestigationReport["holderSnapshot"];
  try { snapshot = report.holderSnapshot ? validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to) : undefined; }
  catch { snapshot = undefined; }
  const poolAddresses = new Set(report.infrastructure?.pools ?? []);
  const balances = new Map(snapshot?.holders.map((row) => [row.address, row]) ?? []);
  const excluded: ReportDistribution["excluded"] = [];
  const missingPoolBalances: Address[] = [];
  for (const address of [...poolAddresses].sort()) {
    const row = balances.get(address);
    if (row?.status === "verified" && row.balanceRaw !== null) excluded.push({ address, balanceRaw: row.balanceRaw });
    else missingPoolBalances.push(address);
  }
  for (const address of [ZERO, DEAD] as Address[]) {
    const row = balances.get(address);
    if (!poolAddresses.has(address) && row?.status === "verified" && row.balanceRaw !== null) excluded.push({ address, balanceRaw: row.balanceRaw });
  }
  const total = snapshot?.totalSupplyRaw ?? null;
  const removed = excluded.reduce((sum, row) => sum + BigInt(row.balanceRaw), 0n);
  const canComputeFloat = Boolean(report.infrastructure) && missingPoolBalances.length === 0 && total !== null && removed < BigInt(total);
  const holdingDenominatorRaw = canComputeFloat ? (BigInt(total!) - removed).toString() : total !== null && BigInt(total) > 0n ? total : null;
  const holdingDenominatorLabel = canComputeFloat ? "float" : "total supply";
  const holders = report.wallets.filter((row) => row.address !== ZERO && row.address !== DEAD && !poolAddresses.has(row.address)
    && balances.get(row.address)?.status === "verified" && row.balanceRaw !== null && balances.get(row.address)?.balanceRaw === row.balanceRaw && BigInt(row.balanceRaw) > 0n)
    .sort((a, b) => BigInt(a.balanceRaw!) > BigInt(b.balanceRaw!) ? -1 : BigInt(a.balanceRaw!) < BigInt(b.balanceRaw!) ? 1 : a.address.localeCompare(b.address));
  return {
    holdingDenominatorRaw, holdingDenominatorLabel, holders, excluded, missingPoolBalances,
    definition: canComputeFloat
      ? "Float means pinned total supply minus the pinned balances of authenticated pools and any retained zero/dead burn balances. Other locked, treasury or custodial balances are not presumed excluded. Holder discovery may be incomplete."
      : "Shares use pinned total supply because authenticated pool balances are incomplete or infrastructure metadata is absent. Missing balances are unknown; this is not an inferred circulating supply.",
  };
}

/** Decimal percentage rounded down to two places without converting chain amounts to Number. */
export function exactPercent(amount: bigint, denominator: bigint): string | null {
  if (amount < 0n || denominator <= 0n || amount > denominator) return null;
  const hundredths = amount * 10_000n / denominator;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}
