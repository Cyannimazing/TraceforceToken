import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "../../src/domain/investigations/types";
import { deriveSwarmGraphView, formatSwarmShare, swarmHolderFlags, type SwarmGraphHolder } from "../../src/components/investigation-swarm-graph-source";
import { curvedSourceLink, layoutSwarmGraph, sourceHoldingRadius } from "../../src/components/investigation-swarm-graph-geometry";
import { getBrowserSwarmAssessmentFixture } from "../fixtures/swarm-report";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const holder = (value: number, share: number | null, clusterId: string | null): SwarmGraphHolder => ({
  address: address(value), share, shareSupply: share === null ? null : share / 4, clusterId,
  isContract: false, label: null, entryKind: null, transactionCount: null,
  fresh: null, sniper: null, insider: null, dev: null, fromDev: null,
});
function sourceReport() {
  const report = getBrowserWalletFlagsFixture();
  report.swarmAssessment = getBrowserSwarmAssessmentFixture(report);
  report.swarmAssessment.graph = {
    holders: [{ ...holder(50, 0.64, "0"), dev: true, entryKind: "mint", transactionCount: 6263 }, holder(51, 0.25, "0"), holder(52, 0.11, null)],
    clusters: [{ id: "0", wallets: [address(50), address(51)], share: 0.89 }],
    links: [{ a: address(50), b: address(51), kind: "direct", level: "proven" }], truncated: false,
  };
  return report;
}

test("SWARM graph and table share the source cohort and shares without borrowing local wallets or balances", () => {
  const report = sourceReport(), original = structuredClone(report), view = deriveSwarmGraphView(report)!;
  assert.equal(view.source.score, report.swarmAssessment!.score);
  assert.deepEqual(view.holders.map((row) => row.address), [address(50), address(51), address(52)]);
  assert.equal(view.holders.some((row) => report.wallets.some((wallet) => wallet.address === row.address)), false);
  assert.deepEqual(view.holders.map((row) => formatSwarmShare(row.share)), ["64.0%", "25.0%", "11.0%"]);
  assert.equal(view.clusters[0].id, "0");
  assert.deepEqual(view.clusters[0].wallets, [address(50), address(51)]);
  assert.equal(view.links[0].level, "proven");
  assert.equal(view.label, "3 reported holders · 1 linked group");
  assert.deepEqual(report, original, "presentation cannot mutate validated source facts");
});

test("missing or invalid source graph never falls back to a local holding presented as SWARM", () => {
  const missing = sourceReport(); delete missing.swarmAssessment!.graph;
  assert.equal(deriveSwarmGraphView(missing), null);
  const report = sourceReport(); report.swarmAssessment!.tokenAddress = address(999);
  assert.equal(deriveSwarmGraphView(report), null);
  const contradictory = sourceReport();
  contradictory.swarmAssessment!.graph!.clusters[0].wallets = [address(50)];
  assert.equal(deriveSwarmGraphView(contradictory), null, "a holder's source cluster cannot be repaired into unreported membership");
});

test("source bubble areas follow reported fractions and retain nonoverlap and viewport fit", () => {
  const view = deriveSwarmGraphView(sourceReport())!, { nodes, fit } = layoutSwarmGraph(view);
  const largest = nodes.find((node) => node.address === address(50))!, second = nodes.find((node) => node.address === address(51))!;
  assert.ok(Math.abs(largest.radius ** 2 / second.radius ** 2 - 0.64 / 0.25) < 1e-12);
  assert.equal(largest.clusterId, "0");
  for (const [index, node] of nodes.entries()) {
    const x = 450 + (node.x - fit.x) * fit.scale, y = 300 + (node.y - fit.y) * fit.scale;
    assert.ok(x - node.radius * fit.scale > 0 && x + node.radius * fit.scale < 900);
    assert.ok(y - node.radius * fit.scale > 0 && y + node.radius * fit.scale < 600);
    for (const other of nodes.slice(index + 1)) assert.ok(Math.hypot(node.x - other.x, node.y - other.y) >= node.radius + other.radius);
  }
  assert.deepEqual(layoutSwarmGraph(view), { nodes, fit });
  assert.match(curvedSourceLink(largest, second), /^M [-\d.]+ [-\d.]+ Q /);
});

test("source graph rejects missing, conflicting or overlapping cluster membership instead of presenting repaired groups", () => {
  const missing = sourceReport();
  missing.swarmAssessment!.graph!.holders[1].clusterId = null;
  assert.equal(deriveSwarmGraphView(missing), null, "declared source membership cannot override a missing holder cluster ID");

  const conflicting = sourceReport(), conflictingGraph = conflicting.swarmAssessment!.graph!;
  conflictingGraph.holders[1].clusterId = "1";
  conflictingGraph.clusters.push({ id: "1", wallets: [address(51)], share: 0.25 });
  assert.equal(deriveSwarmGraphView(conflicting), null, "a holder cannot disagree with a cluster that declares it as a member");

  const overlapping = sourceReport(), overlappingGraph = overlapping.swarmAssessment!.graph!;
  overlappingGraph.holders[2].clusterId = "1";
  overlappingGraph.clusters.push({ id: "1", wallets: [address(51), address(52)], share: 0.36 });
  assert.equal(deriveSwarmGraphView(overlapping), null, "one address cannot be assigned to two source clusters");
});

test("tiny markers preserve truthful percentages while unknowns, zero counts and absent flags remain distinct", () => {
  const tiny = sourceHoldingRadius(0.0000001);
  assert.equal(tiny.radius, 6); assert.equal(tiny.minimumMarker, true);
  assert.equal(formatSwarmShare(0.0000001), "<0.1%");
  assert.equal(formatSwarmShare(null), "Unknown"); assert.equal(formatSwarmShare(0), "0.0%");
  assert.equal(sourceHoldingRadius(null).minimumMarker, false);
  const unknown = { ...holder(53, null, null), transactionCount: 0, fresh: false, sniper: true };
  assert.equal(unknown.transactionCount, 0);
  assert.deepEqual(swarmHolderFlags(unknown), ["sniper"]);
});
