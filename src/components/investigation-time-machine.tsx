"use client";

import { InvestigationPanel } from "./investigation-panel";

import { useEffect, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { InvestigationReport } from "@/domain/investigations/types";
import { buildEvidenceReplay } from "@/domain/investigations/evidence-replay";
import { reconstructHoldingReplay, type HoldingReplay, type HoldingReplayFrame } from "@/domain/investigations/holding-replay";
import { supplyShare } from "./investigation-amounts";

function ObservedActivityReplay({ report, reason }: { report: InvestigationReport; reason: string | null }) {
  const frames = useMemo(() => buildEvidenceReplay(report), [report]);
  const [position, setPosition] = useState(frames.length - 1);
  const [playing, setPlaying] = useState(false);
  const current = frames[Math.min(position, frames.length - 1)];
  useEffect(() => {
    if (!playing || position >= frames.length - 1) return;
    const timer = setInterval(() => setPosition((value) => Math.min(value + 1, frames.length - 1)), 600);
    return () => clearInterval(timer);
  }, [playing, frames.length, position]);
  const maximum = Math.max(1, ...frames.map((frame) => frame.observedAddresses));
  const x = (index: number) => frames.length <= 1 ? 0 : index * 1000 / (frames.length - 1);
  const points = frames.map((frame, index) => `${x(index)},${105 - frame.observedAddresses / maximum * 90}`).join(" ");
  const utc = new Date(current.timestamp * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
  return <InvestigationPanel aria-labelledby="time-machine-title" className="border border-border bg-surface/90 p-5">
    <div className="mb-5 flex flex-wrap items-center gap-3"><h2 id="time-machine-title" className="font-mono text-xs font-semibold uppercase tracking-wider">{"// TIME MACHINE"}</h2><p className="text-xs text-muted">Observed activity in this scan</p></div>
    <p className="mb-4 text-[11px] leading-6 text-muted">Holding reconstruction unavailable: {reason ?? "A consistent pinned holding series was not established."}</p>
    <div className="flex items-center gap-4"><button type="button" className="engine-button min-w-11 px-3" aria-label={playing && position < frames.length - 1 ? "Pause activity replay" : "Play activity replay"} disabled={frames.length < 2} onClick={() => {
      if (playing && position < frames.length - 1) setPlaying(false);
      else { if (position === frames.length - 1) setPosition(0); setPlaying(true); }
    }}>{playing && position < frames.length - 1 ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button><input type="range" min={0} max={Math.max(0, frames.length - 1)} value={Math.min(position, frames.length - 1)} aria-label="Replay observed activity by block" aria-valuetext={`Block ${current.block}, ${current.observedAddresses} observed token-transfer addresses`} disabled={frames.length < 2} className="min-h-11 min-w-0 flex-1 accent-foreground" onChange={(event) => { setPlaying(false); setPosition(Number(event.target.value)); }} /><span className="font-mono text-[10px] text-muted">{position === frames.length - 1 ? "LATEST" : "REPLAY"}</span></div>
    <svg viewBox="0 0 1000 120" preserveAspectRatio="none" role="img" aria-label="Cumulative observed token-transfer addresses within the scan window" className="mt-3 h-28 w-full border-y border-border bg-background"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /><line x1={x(Math.min(position, frames.length - 1))} x2={x(Math.min(position, frames.length - 1))} y1="0" y2="120" stroke="currentColor" strokeDasharray="3 5" opacity="0.5" /><circle cx={x(Math.min(position, frames.length - 1))} cy={105 - current.observedAddresses / maximum * 90} r="3" fill="currentColor" /></svg>
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] text-muted" aria-live="off"><span>Block <strong className="text-foreground">{current.block}</strong></span><span>Observed addresses <strong className="text-foreground">{current.observedAddresses}</strong></span><span>Transfers <strong className="text-foreground">{current.transfers}</strong></span><span>Funding records <strong className="text-foreground">{current.funding}</strong></span><span>Supported sales <strong className="text-foreground">{current.supportedSales}</strong></span></div>
    <p className="mt-3 font-mono text-[10px] leading-6 text-muted">{utc} · Retained records only; this is not holder history since launch. Transfer coverage: {report.coverage.transfers.replace("_", " ")}.</p>
  </InvestigationPanel>;
}

type HoldingSeries = keyof HoldingReplayFrame["shares"];

/** Pixel approximation only. Every frame's denominator is its reconstructed supply. */
function sharePercentage(frame: HoldingReplayFrame, series: HoldingSeries): number | null {
  const share = frame.shares[series];
  return share && BigInt(share.totalSupplyRaw) > 0n
    ? Number(BigInt(share.amountRaw)) / Number(BigInt(share.totalSupplyRaw)) * 100 : null;
}

function ReconstructedHoldingReplay({ replay }: { replay: HoldingReplay }) {
  const frames = replay.frames;
  const [position, setPosition] = useState(frames.length - 1), [playing, setPlaying] = useState(false);
  const index = Math.min(position, frames.length - 1), current = frames[index];
  useEffect(() => {
    if (!playing || position >= frames.length - 1) return;
    const timer = setInterval(() => setPosition((value) => Math.min(value + 1, frames.length - 1)), 600);
    return () => clearInterval(timer);
  }, [playing, frames.length, position]);
  const start = BigInt(frames[0].block.number), span = BigInt(frames.at(-1)!.block.number) - start;
  const x = (frame: HoldingReplayFrame) => span > 0n ? 8 + Number(BigInt(frame.block.number) - start) / Number(span) * 984 : 500;
  const y = (percentage: number) => 105 - percentage * 0.9;
  const sampled = frames.length < replay.totalFrames;
  const points = (series: HoldingSeries): { points: string; single: { x: number; y: number } | null }[] => {
    const segments: { points: string; single: { x: number; y: number } | null }[] = [];
    let segment: string[] = [];
    let previous: { x: number; y: number } | null = null;
    const flush = () => {
      if (segment.length) segments.push({ points: segment.join(" "), single: segment.length === 1 ? previous : null });
      segment = []; previous = null;
    };
    for (const frame of frames) {
      const percentage = sharePercentage(frame, series);
      if (percentage === null) flush();
      else {
        const next = { x: x(frame), y: y(percentage) };
        // With every block state present, balances change at a block boundary.
        // Sampled histories must not imply the skipped states stayed constant.
        if (previous && !sampled) segment.push(`${next.x},${previous.y}`);
        segment.push(`${next.x},${next.y}`);
        previous = next;
      }
    }
    flush();
    return segments;
  };
  const percentageText = (series: HoldingSeries) => {
    const share = current.shares[series];
    return share ? supplyShare(share.amountRaw, share.totalSupplyRaw) ?? "—" : "—";
  };
  const showGroup = frames.some((frame) => frame.shares.largestGroup !== null);
  const utc = new Date(current.block.timestamp * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
  const axisTime = (frame: HoldingReplayFrame) => new Date(frame.block.timestamp * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
  const series: { id: HoldingSeries; label: string; color: string; dashed?: boolean }[] = [
    { id: "top10", label: "Top 10 tracked / supply", color: "var(--accent)" },
    { id: "largest", label: "Largest known / supply", color: "var(--signal-secondary)" },
    ...(showGroup ? [{ id: "largestGroup" as const, label: "Largest group known / supply", color: "var(--amber)", dashed: true }] : []),
  ];
  return <InvestigationPanel aria-labelledby="time-machine-title" className="border border-border bg-surface/90 p-5">
    <div className="mb-5 flex flex-wrap items-center gap-3"><h2 id="time-machine-title" className="font-mono text-xs font-semibold uppercase tracking-wider">{"// TIME MACHINE"}</h2><p className="text-xs text-muted">Reconstructed tracked holdings in this scan</p></div>
    <p className="mb-4 text-[11px] leading-6 text-muted">{replay.knownAddresses} known · {replay.unknownAddresses} unknown of {replay.trackedAddresses} tracked candidate addresses. This is the current eligible cohort, not all holders or history since launch.</p>
    <div className="flex items-center gap-4"><button type="button" className="engine-button min-w-11 px-3" aria-label={playing && index < frames.length - 1 ? "Pause holding replay" : "Play holding replay"} disabled={frames.length < 2} onClick={() => {
      if (playing && index < frames.length - 1) setPlaying(false);
      else { if (index === frames.length - 1) setPosition(0); setPlaying(true); }
    }}>{playing && index < frames.length - 1 ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}</button><input type="range" min={0} max={Math.max(0, frames.length - 1)} value={index} aria-label="Replay tracked holdings by block" aria-valuetext={`Block ${current.block.number}, ${utc}, top 10 known ${percentageText("top10")} of reconstructed supply`} disabled={frames.length < 2} className="min-h-11 min-w-0 flex-1 accent-foreground" onChange={(event) => { setPlaying(false); setPosition(Number(event.target.value)); }} /><span className="font-mono text-[10px] text-muted">{index === frames.length - 1 ? "LATEST" : "REPLAY"}</span></div>
    <div className="relative mt-3"><div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 flex w-9 flex-col justify-between py-1 text-right font-mono text-[9px] text-muted"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox="0 0 1000 120" preserveAspectRatio="none" role="img" aria-label="Known tracked holdings as shares of reconstructed total supply" className="ml-10 h-28 w-[calc(100%-2.5rem)] border-y border-border bg-background">
      {[0, 50, 100].map((percentage) => <line key={percentage} x1="0" x2="1000" y1={y(percentage)} y2={y(percentage)} stroke="currentColor" opacity="0.15" vectorEffect="non-scaling-stroke" />)}
      {series.flatMap((item) => points(item.id).map((segment, segmentIndex) => <g key={`${item.id}-${segmentIndex}`}><polyline data-holding-series={item.id} points={segment.points} fill="none" stroke={item.color} strokeWidth="1.5" strokeDasharray={item.dashed ? "6 5" : undefined} vectorEffect="non-scaling-stroke" />{segment.single && <circle data-holding-point={item.id} cx={segment.single.x} cy={segment.single.y} r="3" fill={item.color} />}</g>))}
      <line x1={x(current)} x2={x(current)} y1="0" y2="120" stroke="currentColor" strokeDasharray="3 5" opacity="0.5" />
      {series.map((item) => { const percentage = sharePercentage(current, item.id); return percentage === null ? null : <circle key={item.id} data-holding-point={item.id} cx={x(current)} cy={y(percentage)} r="3" fill={item.color} />; })}
    </svg></div>
    <div className="ml-10 mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-[9px] text-muted"><span>{axisTime(frames[0])}</span>{frames.length > 1 && <span>{axisTime(frames.at(-1)!)}</span>}</div>
    <p data-holding-range className="mt-2 font-mono text-[10px] leading-6 text-muted">Blocks {frames[0].block.number}–{frames.at(-1)!.block.number} · {frames.length === 1 ? "One reconstructed block state" : sampled ? "Sampled block states; connecting lines guide the eye" : "State after each acquired transfer block"}.</p>
    <p className="mt-2 font-mono text-[10px] leading-6 text-muted">Fixed axis: 0–100% of each frame’s reconstructed total supply. Solid: top 10 tracked and largest known · dashed: largest known linked-group subtotal.</p>
    <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] text-muted">{series.map((item) => <div key={item.id}><dt>{item.label}</dt><dd className="mt-1 text-foreground">{percentageText(item.id)}</dd></div>)}</dl>
    <p className="mt-3 font-mono text-[10px] leading-6 text-muted">Block {current.block.number} · {utc} · state after this block. {showGroup && `The largest known group subtotal has ${current.unknownGroupMembers} unknown members. `}Missing anchors remain unknown; known shares do not establish the complete distribution.</p>
    <details className="mt-3 border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-[11px] text-muted">Reconstruction assumptions and provenance</summary><ul className="space-y-2 pb-3 text-[11px] leading-6 text-muted">{replay.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul><p className="pb-3 font-mono text-[10px] leading-6 text-muted">{frames.length} displayed of {replay.totalFrames} block states. Anchor: block {replay.anchor!.block.number} · {replay.anchor!.provenance.provider} · {replay.anchor!.provenance.method}<br />Retrieved {replay.anchor!.provenance.observedAt}</p></details>
  </InvestigationPanel>;
}

export function InvestigationTimeMachine({ report }: { report: InvestigationReport }) {
  const reconstruction = useMemo(() => reconstructHoldingReplay(report), [report]);
  return reconstruction.status === "available"
    ? <ReconstructedHoldingReplay replay={reconstruction} />
    : <ObservedActivityReplay report={report} reason={reconstruction.reason} />;
}
