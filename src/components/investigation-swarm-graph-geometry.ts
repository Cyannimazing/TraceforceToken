import type { Address } from "@/domain/investigations/types";
import type { SwarmGraphHolder, SwarmGraphView } from "./investigation-swarm-graph-source";

export interface SwarmGraphNode {
  address: Address;
  holder: SwarmGraphHolder;
  x: number;
  y: number;
  radius: number;
  minimumMarker: boolean;
  clusterId: string | null;
}

export function sourceHoldingRadius(share: number | null): { radius: number; minimumMarker: boolean } {
  if (share === null || !Number.isFinite(share) || share < 0 || share > 1) return { radius: 10, minimumMarker: false };
  if (share === 0) return { radius: 6, minimumMarker: false };
  const radius = 210 * Math.sqrt(share);
  return { radius: Math.max(6, radius), minimumMarker: radius < 6 };
}

type Circle = { x: number; y: number; radius: number };
function pack(circles: Circle[]) {
  const placed: Circle[] = [];
  for (const circle of circles) {
    for (let step = 0; step < 24_000; step++) {
      const angle = step * 2.399963229728653, distance = 4 * Math.sqrt(step);
      circle.x = Math.cos(angle) * distance; circle.y = Math.sin(angle) * distance;
      if (placed.every((other) => Math.hypot(circle.x - other.x, circle.y - other.y) >= circle.radius + other.radius + 9)) break;
    }
    placed.push(circle);
  }
}

/** Deterministic circle packing keeps actual source clusters together. No
 * geometric proximity creates a link, group, balance, or ownership claim. */
export function layoutSwarmGraph(view: SwarmGraphView) {
  const membership = new Map<Address, string>();
  for (const group of view.clusters) for (const address of group.wallets) membership.set(address, group.id);
  const nodes: SwarmGraphNode[] = view.holders.map((holder) => ({ address: holder.address, holder,
    ...sourceHoldingRadius(holder.share), x: 0, y: 0, clusterId: membership.get(holder.address) ?? holder.clusterId }));
  const groups = new Map<string, SwarmGraphNode[]>();
  for (const node of nodes) {
    const key = node.clusterId === null ? `address:${node.address}` : `cluster:${node.clusterId}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  const packed = [...groups.values()].map((members) => {
    members.sort((left, right) => right.radius - left.radius || left.address.localeCompare(right.address));
    const circles = members.map((node) => ({ x: 0, y: 0, radius: Math.max(node.radius, 16), node }));
    pack(circles);
    const left = Math.min(...circles.map((node) => node.x - node.radius)), right = Math.max(...circles.map((node) => node.x + node.radius));
    const top = Math.min(...circles.map((node) => node.y - node.radius)), bottom = Math.max(...circles.map((node) => node.y + node.radius));
    const centerX = (left + right) / 2, centerY = (top + bottom) / 2;
    for (const circle of circles) { circle.node.x = circle.x - centerX; circle.node.y = circle.y - centerY; }
    return { x: 0, y: 0, radius: Math.max(...circles.map((circle) => Math.hypot(circle.x - centerX, circle.y - centerY) + circle.radius)), members };
  }).sort((left, right) => right.radius - left.radius || left.members[0].address.localeCompare(right.members[0].address));
  pack(packed);
  for (const group of packed) for (const node of group.members) { node.x += group.x; node.y += group.y; }
  if (!nodes.length) return { nodes, fit: { x: 0, y: 0, scale: 1 } };
  const left = Math.min(...nodes.map((node) => node.x - Math.max(22, node.radius * (node.holder.dev ? 1.3 : 1))));
  const right = Math.max(...nodes.map((node) => node.x + Math.max(22, node.radius * (node.holder.dev ? 1.3 : 1))));
  const top = Math.min(...nodes.map((node) => node.y - Math.max(22, node.radius))), bottom = Math.max(...nodes.map((node) => node.y + Math.max(22, node.radius)));
  return { nodes, fit: { x: (left + right) / 2, y: (top + bottom) / 2, scale: Math.min(1.35, 780 / Math.max(1, right - left), 470 / Math.max(1, bottom - top)) } };
}

export function curvedSourceLink(from: Circle, to: Circle): string {
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy) || 1;
  const startX = from.x + dx / distance * from.radius, startY = from.y + dy / distance * from.radius;
  const endX = to.x - dx / distance * to.radius, endY = to.y - dy / distance * to.radius;
  const curve = Math.min(35, distance * 0.12);
  return `M ${startX} ${startY} Q ${(startX + endX) / 2 - dy / distance * curve} ${(startY + endY) / 2 + dx / distance * curve} ${endX} ${endY}`;
}
