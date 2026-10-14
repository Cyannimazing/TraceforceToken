"use client";

import { InvestigationPanel } from "./investigation-panel";

import { useEffect, useRef, useState } from "react";
import { Copy, Download } from "lucide-react";
import type { ExplainedInvestigationReport } from "@/domain/investigations/types";
import { derivePrimaryAssessment } from "@/domain/investigations/primary-assessment";

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

/** Preview and downloaded card share one explicit assessment authority. */
export function investigationShareDetails(report: ExplainedInvestigationReport) {
  const primary = derivePrimaryAssessment(report);
  const label = primary.status === "reported" ? primary.snapshot.header.name ?? primary.snapshot.header.symbol ?? report.token.name ?? report.token.symbol ?? "Base token"
    : report.token.name ?? report.token.symbol ?? "Base token";
  if (primary.authority === "swarm") {
    if (primary.status === "unavailable") return { authority: primary.authority, label,
      assessment: "SWARM assessment unavailable", population: "SWARM holder and group counts unavailable", counts: "No source score or verdict is available.",
      qualification: "Independent blockchain checks are separate from the unavailable source result.",
      freshness: null,
      sourceTime: `Source checked ${primary.checkedAt}`, snapshot: `Independent blockchain snapshot: block ${report.range.to.number}`,
      description: "The link opens this token for a fresh scan. The card records that SWARM's assessment was unavailable for this request." };
    const source = primary.snapshot, count = (value: number | null) => value === null ? "unavailable" : String(value);
    return { authority: primary.authority, label,
      assessment: `SWARM · ${primary.score === null ? "Score unavailable" : `Score ${primary.score} / 100`} · ${primary.verdict}`,
      population: `${count(source.header.holders_count)} reported holders`,
      counts: `${count(source.metrics.wallets)} reported wallet${source.metrics.wallets === 1 ? "" : "s"} · ${count(source.metrics.hands)} inferred group${source.metrics.hands === 1 ? "" : "s"}`,
      qualification: "Reported groups do not establish verified people or common ownership.",
      freshness: source.transport?.freshness === "source-window-verified" ? null : "Source scan time could not be verified against this request.",
      sourceTime: `SWARM scan ${primary.dataThrough}`, snapshot: `Independent blockchain snapshot: block ${report.range.to.number}`,
      description: "The link opens this token for a fresh scan. The card keeps SWARM's original reported assessment and source scan time; independent blockchain checks use a separate snapshot." };
  }
  return { authority: primary.authority, label, assessment: `TraceForge · Score ${primary.score} / 100 · ${primary.verdict}`,
    population: `${report.wallets.length} discovered addresses · ${report.groups.length} linked groups`, counts: `Transfer coverage: ${report.coverage.transfers}`,
    qualification: "Relationships do not establish shared ownership.", sourceTime: `Snapshot generated ${report.generatedAt}`,
    freshness: null,
    snapshot: `Finalized block ${report.range.to.number}`,
    description: "The link opens this token for a fresh scan. The card represents this report's original block window." };
}

export function investigationShareSvg(report: ExplainedInvestigationReport): string {
  const details = investigationShareDetails(report), title = details.label.length > 45 ? `${details.label.slice(0, 42)}…` : details.label;
  const freshness = details.freshness ? `<text x="50" y="520" font-size="13" fill="#aaa">${escapeXml(details.freshness)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="560" viewBox="0 0 1000 560"><rect width="1000" height="560" rx="12" fill="#080808"/><rect x="1" y="1" width="998" height="558" rx="12" fill="none" stroke="#333"/><g font-family="monospace" fill="#eee"><text x="50" y="65" font-size="18" letter-spacing="3">TRACEFORGE ENGINE · BASE</text><text x="50" y="130" font-size="30">${escapeXml(title)}</text><text x="50" y="170" font-size="15" fill="#aaa">${escapeXml(report.token.address)}</text><text x="50" y="235" font-size="24">${escapeXml(details.assessment)}</text><text x="50" y="280" font-size="20">${escapeXml(details.population)}</text><text x="50" y="320" font-size="17">${escapeXml(details.counts)}</text><text x="50" y="365" font-size="15" fill="#aaa">${escapeXml(details.qualification)}</text><text x="50" y="435" font-size="15">${escapeXml(details.sourceTime)}</text><text x="50" y="485" font-size="15" fill="#aaa">${escapeXml(details.snapshot)}</text>${freshness}</g></svg>`;
}

export function InvestigationShare({ report }: { report: ExplainedInvestigationReport }) {
  const [message, setMessage] = useState("");
  const [manualLink, setManualLink] = useState("");
  const downloads = useRef(new Set<string>());
  useEffect(() => { const owned = downloads.current; return () => { owned.forEach((url) => URL.revokeObjectURL(url)); owned.clear(); }; }, []);
  const details = investigationShareDetails(report);
  async function copyLink() {
    const url = new URL("/investigate", window.location.origin); url.searchParams.set("token", report.token.address);
    try { await navigator.clipboard.writeText(url.toString()); setMessage("Token scan link copied."); setManualLink(""); }
    catch { setManualLink(url.toString()); setMessage("Select and copy the token scan link below."); }
  }
  function downloadCard() {
    const content = investigationShareSvg(report);
    const url = URL.createObjectURL(new Blob([content], { type: "image/svg+xml" })); downloads.current.add(url);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `traceforce-base-${report.token.address}-${report.range.to.number}.svg`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 1000); setMessage("Report card downloaded.");
  }
  return <InvestigationPanel aria-labelledby="share-title" className="border border-border bg-surface/90 p-5"><h2 id="share-title" className="font-mono text-xs font-semibold uppercase tracking-wider">{"// SHARE"}</h2><div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"><div data-share-authority={details.authority} className="rounded-lg border border-border bg-background p-6"><p className="font-mono text-[10px] tracking-widest text-muted">TRACEFORGE · BASE</p><h3 className="mt-5 break-words text-xl font-semibold">{details.label}</h3><p className="mt-3 break-all font-mono text-[10px] text-muted">{report.token.address}</p><p className="mt-8 text-sm font-semibold">{details.assessment}</p><p className="mt-3 text-sm">{details.population}</p><p className="mt-2 text-xs leading-6 text-muted">{details.counts}</p><p className="mt-3 text-xs leading-6 text-muted">{details.qualification}</p><p className="mt-8 break-words font-mono text-[10px] text-muted">{details.sourceTime}</p><p className="mt-2 font-mono text-[10px] text-muted">{details.snapshot}</p>{details.freshness && <p className="mt-2 text-xs leading-6 text-muted">{details.freshness}</p>}</div><div><div className="flex flex-wrap gap-3"><button type="button" className="engine-button" onClick={downloadCard}><Download size={14} aria-hidden="true" />Download card</button><button type="button" className="engine-button" onClick={() => void copyLink()}><Copy size={14} aria-hidden="true" />Copy token link</button></div><p className="mt-4 text-xs leading-6 text-muted">{details.description}</p><p role="status" className="mt-3 text-xs leading-6 text-muted">{message}</p>{manualLink && <input aria-label="Token scan link" readOnly value={manualLink} onFocus={(event) => event.currentTarget.select()} className="mt-3 min-h-11 w-full border border-border bg-background px-3 font-mono text-xs" />}</div></div></InvestigationPanel>;
}
