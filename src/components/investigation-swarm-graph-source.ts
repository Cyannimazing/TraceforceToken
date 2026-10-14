import type { InvestigationReport } from "@/domain/investigations/types";
import { validateSwarmAssessmentSnapshot, type SwarmAssessmentSnapshot } from "@/domain/investigations/swarm-assessment";

export type SwarmGraphData = NonNullable<SwarmAssessmentSnapshot["graph"]>;
export type SwarmGraphHolder = SwarmGraphData["holders"][number];

/** Source JSON fractions only. These are never recalculated from local balances. */
export function formatSwarmShare(share: number | null): string {
  if (share === null || !Number.isFinite(share) || share < 0 || share > 1) return "Unknown";
  if (share > 0 && share < 0.001) return "<0.1%";
  return `${(share * 100).toFixed(1)}%`;
}

export function swarmHolderFlags(holder: SwarmGraphHolder): string[] {
  return [holder.dev === true ? "creator" : null, holder.fresh === true ? "fresh" : null,
    holder.sniper === true ? "sniper" : null, holder.insider === true ? "insider" : null,
    holder.fromDev === true ? "from creator" : null, holder.isContract === true ? "contract" : null]
    .filter((value): value is string => value !== null);
}

/** Graph and table consume this same validated, source-ordered cohort. */
export function deriveSwarmGraphView(report: InvestigationReport) {
  if (!report.swarmAssessment) return null;
  let source: SwarmAssessmentSnapshot;
  try { source = validateSwarmAssessmentSnapshot(report.swarmAssessment, report.token.address); }
  catch { return null; }
  const graph = source.graph;
  if (!graph) return null;
  const holders = graph.holders, addresses = new Set(holders.map((holder) => holder.address));
  const clusters = graph.clusters.map((cluster) => ({
    ...cluster, wallets: cluster.wallets.filter((address) => addresses.has(address)),
  })).filter((cluster) => cluster.wallets.length > 1);
  const links = graph.links.filter((link) => addresses.has(link.a) && addresses.has(link.b));
  return { source, holders, clusters, links, truncated: graph.truncated,
    omittedExternalLinks: graph.links.length - links.length,
    label: `${holders.length} reported ${holders.length === 1 ? "holder" : "holders"} · ${clusters.length} linked ${clusters.length === 1 ? "group" : "groups"}` };
}

export type SwarmGraphView = NonNullable<ReturnType<typeof deriveSwarmGraphView>>;
