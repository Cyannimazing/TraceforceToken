import type { Address, InvestigationReport } from "@/domain/investigations/types";
import { deriveReportDistribution } from "@/domain/investigations/report-distribution";
import { validateHolderSnapshot } from "@/domain/investigations/holder-snapshot";

export const GRAPH_PAGE_SIZE = 48;
export type GraphBasis = "holdings" | "unscaled-balances" | "flow";
export interface WalletGraphNode {
  address: Address;
  volume: bigint;
  balanceRaw: string | null;
  kind: "holding" | "zero" | "unknown" | "infrastructure" | "flow";
  radius: number;
  x: number;
  y: number;
}

function logarithm(value: bigint): number {
  const digits = value.toString();
  return value === 0n ? 0 : digits.length - 1 + Math.log10(Number(digits.slice(0, 12)) / 10 ** (Math.min(digits.length, 12) - 1));
}

function pinnedSnapshot(report: InvestigationReport) {
  try { return report.holderSnapshot ? validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to) : null; }
  catch { return null; }
}

export function graphBasis(report: InvestigationReport, holdingDenominatorRaw?: string | null): GraphBasis {
  const eligible = new Set(report.wallets.map((wallet) => wallet.address));
  const verified = pinnedSnapshot(report)?.holders.some((holder) => eligible.has(holder.address) && holder.status === "verified" && holder.balanceRaw !== null);
  if (!verified) return "flow";
  const denominator = holdingDenominatorRaw === undefined ? deriveReportDistribution(report).holdingDenominatorRaw : holdingDenominatorRaw;
  return denominator && BigInt(denominator) > 0n ? "holdings" : "unscaled-balances";
}

export function collectGraphAddresses(report: InvestigationReport): Address[] {
  const eligible = new Set(report.wallets.map((wallet) => wallet.address));
  const snapshot = pinnedSnapshot(report);
  const balances = new Map(snapshot?.holders.filter((holder) => holder.status === "verified" && holder.balanceRaw !== null).map((holder) => [holder.address, BigInt(holder.balanceRaw!)]));
  const flows = new Map(report.wallets.map((wallet) => [wallet.address, BigInt(wallet.observedIncomingRaw) + BigInt(wallet.observedOutgoingRaw)]));
  const values = graphBasis(report) === "flow" ? flows : balances;
  return [...new Set([...eligible, ...report.connections.flatMap((edge) => [edge.from, edge.to]), ...(snapshot?.holders.map((holder) => holder.address) ?? [])])].sort((a, b) => {
    if (eligible.has(a) !== eligible.has(b)) return eligible.has(a) ? -1 : 1;
    const left = values.get(a) ?? 0n, right = values.get(b) ?? 0n;
    return left > right ? -1 : left < right ? 1 : a.localeCompare(b);
  });
}

/** One scale for every positive holding: area = PI * 180² * balance / supply. */
export function holdingRadius(balanceRaw: string, totalSupplyRaw: string): number {
  const balance = BigInt(balanceRaw), supply = BigInt(totalSupplyRaw);
  if (balance < 0n || supply <= 0n || balance > supply) return 0;
  // uint256 quantities fit finite IEEE754 values; approximation is used for pixels only.
  return 180 * Math.sqrt(Number(balance) / Number(supply));
}

type Bounds = { left: number; right: number; top: number; bottom: number };
function nodeBounds(node: WalletGraphNode): Bounds {
  const marker = Math.max(node.radius, 18), halfWidth = Math.max(marker + 12, 66);
  return { left: node.x - halfWidth, right: node.x + halfWidth, top: node.y - marker - 16, bottom: node.y + marker + 52 };
}

/** Pack visual markers and their address labels; never clamp circles against the viewport. */
export function layoutGraph(report: InvestigationReport, addresses: Address[], page: number, holdingDenominatorRaw?: string | null): { nodes: WalletGraphNode[]; total: number } {
  const eligible = new Set(report.wallets.map((wallet) => wallet.address));
  const infrastructure = new Set<Address>([...(report.infrastructure?.pools ?? []), ...(report.infrastructure?.hubs ?? []), "0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
  const balances = new Map(pinnedSnapshot(report)?.holders.filter((holder) => holder.status === "verified" && holder.balanceRaw !== null).map((holder) => [holder.address, holder.balanceRaw!]));
  const volumes = new Map(report.wallets.map((wallet) => [wallet.address, BigInt(wallet.observedIncomingRaw) + BigInt(wallet.observedOutgoingRaw)]));
  const basis = graphBasis(report, holdingDenominatorRaw), supply = holdingDenominatorRaw === undefined ? deriveReportDistribution(report).holdingDenominatorRaw : holdingDenominatorRaw;
  const maxLog = Math.max(1, ...addresses.map((address) => logarithm((volumes.get(address) ?? 0n) + 1n)));
  const nodes: WalletGraphNode[] = addresses.slice(page * GRAPH_PAGE_SIZE, (page + 1) * GRAPH_PAGE_SIZE).map((address) => {
    const balanceRaw = balances.get(address) ?? null, volume = volumes.get(address) ?? 0n;
    const kind: WalletGraphNode["kind"] = infrastructure.has(address) ? "infrastructure" : !eligible.has(address) ? "unknown" : basis === "flow" ? "flow" : balanceRaw === "0" ? "zero" : balanceRaw === null || basis === "unscaled-balances" ? "unknown" : "holding";
    const radius = kind === "holding" ? holdingRadius(balanceRaw!, supply!) : kind === "flow" ? 22 + 68 * logarithm(volume + 1n) / maxLog : 0;
    return { address, volume, balanceRaw, kind, radius, x: 450, y: 300 };
  });
  const placed: Bounds[] = [];
  for (const node of nodes) {
    let found = false;
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const angle = attempt * 2.399963229728653, distance = 10 * Math.sqrt(attempt);
      node.x = 450 + Math.cos(angle) * distance;
      node.y = 300 + Math.sin(angle) * distance * 0.8;
      const bounds = nodeBounds(node);
      if (placed.every((other) => bounds.right + 16 <= other.left || bounds.left >= other.right + 16 || bounds.bottom + 16 <= other.top || bounds.top >= other.bottom + 16)) { placed.push(bounds); found = true; break; }
    }
    if (!found) { node.x = Math.max(450, ...placed.map((bounds) => bounds.right)) + Math.max(node.radius + 12, 66) + 24; node.y = 300; placed.push(nodeBounds(node)); }
  }
  return { nodes, total: addresses.length };
}

export function fitGraph(nodes: WalletGraphNode[]): { x: number; y: number; scale: number } {
  if (!nodes.length) return { x: 450, y: 300, scale: 1 };
  const bounds = nodes.map(nodeBounds), left = Math.min(...bounds.map((value) => value.left)), right = Math.max(...bounds.map((value) => value.right));
  const top = Math.min(...bounds.map((value) => value.top)), bottom = Math.max(...bounds.map((value) => value.bottom));
  return { x: (left + right) / 2, y: (top + bottom) / 2, scale: Math.min(1.85, 790 / (right - left), 460 / (bottom - top)) };
}
