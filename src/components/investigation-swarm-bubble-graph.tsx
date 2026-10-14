"use client";

import { useId, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Maximize2, Minus, Plus, X } from "lucide-react";
import type { Address } from "@/domain/investigations/types";
import { InvestigationPanel } from "./investigation-panel";
import { curvedSourceLink, layoutSwarmGraph } from "./investigation-swarm-graph-geometry";
import { formatSwarmShare, swarmHolderFlags, type SwarmGraphView } from "./investigation-swarm-graph-source";

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const control = "engine-button min-h-11 min-w-11 justify-center px-3 focus-visible:outline-accent disabled:opacity-35";

export function InvestigationSwarmBubbleGraph({ view, selected, onSelect }: {
  view: SwarmGraphView; selected: Address | null; onSelect: (address: Address | null) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, ""), titleId = `source-graph-${uid}`, cardId = `source-holder-${uid}`;
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState<Address | null>(null), [focused, setFocused] = useState<Address | null>(null);
  const touchFocus = useRef(false);
  const drag = useRef<{ pointer: number; x: number; y: number; originX: number; originY: number; scale: number } | null>(null);
  const { nodes, fit } = useMemo(() => layoutSwarmGraph(view), [view]);
  const byAddress = useMemo(() => new Map(nodes.map((node) => [node.address, node])), [nodes]);
  const active = hovered ?? focused ?? selected, activeNode = active ? byAddress.get(active) : undefined;
  const activeFlags = activeNode ? swarmHolderFlags(activeNode.holder) : [];
  const activeGroup = activeNode?.clusterId !== null ? view.source.graph?.clusters.find((group) => group.id === activeNode?.clusterId) : undefined;
  const linked = new Set(view.links.flatMap((link) => link.a === active ? [link.b] : link.b === active ? [link.a] : []));
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const toggle = (address: Address) => { setHovered(null); onSelect(selected === address ? null : address); };

  return <InvestigationPanel aria-labelledby={titleId} data-graph-source="swarm" className="traceforce-graph min-w-0 overflow-hidden">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4 sm:p-5">
      <div><p className="engine-kicker text-accent">SWARM · reported holder map</p><h2 id={titleId} className="mt-2 text-sm font-semibold">{view.label}</h2><p className="mt-1 text-xs leading-6 text-muted">Same holder rows and float shares as the SWARM table. Links describe relationships, not people.</p></div>
      <div className="flex gap-1" role="group" aria-label="SWARM graph controls">
        <button type="button" className={control} aria-label="Zoom out SWARM graph" disabled={zoom <= 0.65} onClick={() => setZoom((value) => Math.max(0.65, value - 0.2))}><Minus size={16} aria-hidden="true" /></button>
        <button type="button" className={control} aria-label="Zoom in SWARM graph" disabled={zoom >= 2.4} onClick={() => setZoom((value) => Math.min(2.4, value + 0.2))}><Plus size={16} aria-hidden="true" /></button>
        <button type="button" className={control} aria-label="Fit SWARM graph" onClick={reset}><Maximize2 size={16} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="relative isolate overflow-hidden bg-background/35" onPointerLeave={() => setHovered(null)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null); }}>
      <p className="pointer-events-none absolute right-4 top-3 z-10 rounded-md border border-border bg-surface/90 px-2 py-1 font-mono text-[10px] text-muted">Hover or tap a holder</p>
      {nodes.length === 0 ? <p className="flex min-h-80 items-center justify-center p-8 text-center text-sm leading-7 text-muted">SWARM returned no holder rows for this scan. No holding was inferred.</p> : <svg data-graph-view="swarm" data-source-holder-count={view.holders.length} data-share-basis="swarm-float" viewBox="0 0 900 600" className="block h-[400px] w-full touch-pan-y text-foreground sm:h-[480px]" aria-label="SWARM-reported holders and wallet links. Use the holder selector for a list; arrow keys pan the map."
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as Element).closest("[data-node-address]")) return;
          const width = event.currentTarget.getBoundingClientRect().width;
          drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y, scale: 900 / Math.max(1, width) };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => { const current = drag.current; if (current?.pointer === event.pointerId) setPan({ x: current.originX + (event.clientX - current.x) * current.scale, y: current.originY + (event.clientY - current.y) * current.scale }); }}
        onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
        onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setHovered(null); setFocused(null); onSelect(null); return; }
          const direction = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
          if (direction) { event.preventDefault(); setPan((value) => ({ x: value.x + direction[0], y: value.y + direction[1] })); }
        }}>
        <defs>
          <radialGradient id={`planet-${uid}`} cx="28%" cy="22%" r="85%"><stop offset="0%" stopColor="var(--foreground)" stopOpacity="0.95" /><stop offset="27%" stopColor="var(--accent)" stopOpacity="0.8" /><stop offset="66%" stopColor="var(--signal-secondary)" stopOpacity="0.5" /><stop offset="100%" stopColor="var(--background)" /></radialGradient>
          <radialGradient id={`halo-${uid}`}><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.1" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></radialGradient>
        </defs>
        <circle cx="450" cy="300" r="285" fill={`url(#halo-${uid})`} aria-hidden="true" />
        <g transform={`translate(${450 + pan.x} ${300 + pan.y}) scale(${fit.scale * zoom}) translate(${-fit.x} ${-fit.y})`}>
          {view.clusters.map((group) => {
            const members = group.wallets.flatMap((address) => { const node = byAddress.get(address); return node ? [node] : []; });
            const x = members.reduce((sum, node) => sum + node.x, 0) / members.length, y = members.reduce((sum, node) => sum + node.y, 0) / members.length;
            const radius = Math.max(...members.map((node) => Math.hypot(node.x - x, node.y - y) + node.radius)) + 16;
            return <circle key={group.id} data-source-cluster={group.id} cx={x} cy={y} r={radius} fill="var(--accent)" fillOpacity="0.025" stroke="var(--accent)" strokeOpacity="0.2" strokeDasharray="4 7" aria-hidden="true" />;
          })}
          {view.links.map((link, index) => {
            const from = byAddress.get(link.a)!, to = byAddress.get(link.b)!;
            const emphasized = active === link.a || active === link.b;
            return <path key={`${link.a}-${link.b}-${index}`} data-source-link={link.kind ?? "reported"} data-source-link-level={link.level ?? undefined} d={curvedSourceLink(from, to)} fill="none" stroke="var(--accent)" strokeWidth={emphasized ? 2.5 : 1.4} strokeOpacity={active && !emphasized ? 0.12 : 0.6} strokeDasharray={link.kind?.includes("fund") ? "5 5" : undefined}><title>{link.kind ?? "Reported link"}: {short(link.a)} to {short(link.b)}</title></path>;
          })}
          {nodes.map((node) => {
            const highlighted = active === node.address, creator = node.holder.dev === true, positive = node.holder.share !== null && node.holder.share > 0;
            return <g key={node.address} data-node-address={node.address} data-node-kind="source-holder" data-source-share={node.holder.share ?? undefined} data-holding-share={formatSwarmShare(node.holder.share)} data-source-cluster-id={node.clusterId ?? undefined} data-minimum-marker={node.minimumMarker ? "true" : undefined}
              role="button" tabIndex={0} aria-label={`Inspect reported holder ${node.address}`} aria-pressed={selected === node.address} aria-describedby={highlighted ? cardId : undefined}
              className="cursor-pointer outline-none focus-visible:outline-accent" onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered(node.address); }}
              onPointerDown={(event) => { touchFocus.current = event.pointerType === "touch"; if (touchFocus.current) { setHovered(null); setFocused(null); } }}
              onFocus={() => { if (!touchFocus.current) setFocused(node.address); touchFocus.current = false; }} onClick={() => toggle(node.address)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(node.address); } }} opacity={!active || highlighted || linked.has(node.address) ? 1 : 0.55}>
              <title>{short(node.address)} · {formatSwarmShare(node.holder.share)} of SWARM float</title>
              <circle cx={node.x} cy={node.y} r={Math.max(22, node.radius + 5)} fill="transparent" />
              {creator && <ellipse data-source-marker="creator" cx={node.x} cy={node.y} rx={Math.max(25, node.radius * 1.3)} ry={Math.max(9, node.radius * 0.3)} transform={`rotate(-22 ${node.x} ${node.y})`} fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.65" />}
              <circle data-source-bubble="true" cx={node.x} cy={node.y} r={node.radius} fill={positive ? `url(#planet-${uid})` : "var(--surface)"} stroke="var(--accent)" strokeWidth={highlighted ? 2.5 : 0.9} strokeOpacity={highlighted ? 1 : 0.65} strokeDasharray={node.holder.share === null ? "3 3" : undefined} />
              {positive && node.radius > 22 && <ellipse cx={node.x} cy={node.y + node.radius * 0.12} rx={node.radius * 0.9} ry={node.radius * 0.16} transform={`rotate(-17 ${node.x} ${node.y})`} fill="none" stroke="var(--foreground)" strokeOpacity="0.14" strokeWidth={Math.max(1, node.radius * 0.025)} aria-hidden="true" />}
              {node.radius >= 23 && <text x={node.x} y={node.y + 4} textAnchor="middle" fill="var(--foreground)" stroke="var(--background)" strokeOpacity="0.6" strokeWidth="0.35" paintOrder="stroke" fontSize={node.radius > 90 ? 25 : node.radius > 40 ? 17 : 11} fontFamily="var(--font-sans)" fontWeight="700">{formatSwarmShare(node.holder.share)}</text>}
              {node.holder.fresh === true && <circle data-source-marker="fresh" cx={node.x + node.radius * 0.7} cy={node.y - node.radius * 0.7} r="4" fill="var(--accent)" stroke="var(--surface)" />}
            </g>;
          })}
        </g>
      </svg>}
      {activeNode && <div id={cardId} data-source-holder-card role="group" aria-label="Reported holder details" className="absolute bottom-4 left-4 z-20 w-64 max-w-[calc(100%_-_2rem)] rounded-xl border border-accent/35 bg-surface p-4 shadow-xl">
        <div className="flex items-start justify-between gap-3"><a href={`https://basescan.org/address/${activeNode.address}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-2 break-all font-mono text-xs font-semibold underline underline-offset-4">{short(activeNode.address)}<ArrowUpRight size={13} aria-hidden="true" /></a>{selected && <button type="button" aria-label="Clear reported holder selection" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline-accent" onClick={() => { onSelect(null); setHovered(null); setFocused(null); }}><X size={15} aria-hidden="true" /></button>}</div>
        <p className="text-2xl font-semibold tracking-tight">{formatSwarmShare(activeNode.holder.share)}<span className="ml-2 text-xs font-normal text-muted">of SWARM float</span></p>
        {activeNode.holder.label && <p className="mt-2 break-words text-xs text-muted">{activeNode.holder.label}</p>}
        {activeNode.holder.entryKind !== null && <p className="mt-2 text-xs"><span className="text-muted">Entry </span>{activeNode.holder.entryKind}</p>}
        {activeNode.holder.transactionCount !== null && <p className="mt-2 text-xs"><span className="text-muted">Transactions </span>{activeNode.holder.transactionCount.toLocaleString("en-US")}</p>}
        {activeFlags.length > 0 && <p className="mt-3 flex flex-wrap gap-1.5">{activeFlags.map((flag) => <span key={flag} className="rounded border border-border px-2 py-1 text-[10px] font-medium">{flag}</span>)}</p>}
        {activeGroup && <p className="mt-3 text-xs leading-5 text-muted">Reported group {activeGroup.id} · {activeGroup.wallets.length} holder address{activeGroup.wallets.length === 1 ? "" : "es"}. Links do not establish common ownership.</p>}
        <p className="mt-3 border-t border-border pt-2 text-[10px] leading-5 text-muted">Source-reported at <time dateTime={view.source.scannedAt}>{new Date(view.source.scannedAt).toLocaleString("en-US", { timeZone: "UTC", hour12: false })} UTC</time>.</p>
      </div>}
    </div>
    <div className="space-y-3 border-t border-border p-4 sm:p-5">
      <p className="text-xs leading-6 text-muted">Bubble area follows SWARM’s reported float share. {nodes.some((node) => node.minimumMarker) && "Tiny holdings use a minimum visible marker; their percentages are unchanged. "}{view.truncated && "The source list was limited; more holders or links may exist. "}These observations are separate from TraceForge’s pinned on-chain checks.</p>
      <label htmlFor={`source-holder-select-${uid}`} className="block text-xs font-medium">Inspect a reported holder</label>
      <select id={`source-holder-select-${uid}`} value={selected && byAddress.has(selected) ? selected : ""} onChange={(event) => { setHovered(null); setFocused(null); onSelect(event.target.value ? event.target.value as Address : null); }} className="engine-input min-h-11 w-full min-w-0 text-sm">
        <option value="">Choose a holder</option>{view.holders.map((holder) => <option key={holder.address} value={holder.address}>{short(holder.address)} · {formatSwarmShare(holder.share)}</option>)}
      </select>
    </div>
  </InvestigationPanel>;
}
