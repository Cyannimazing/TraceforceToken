"use client";

import { InvestigationPanel } from "./investigation-panel";

import { useEffect, useRef, useState } from "react";
import { Copy, Download } from "lucide-react";
import type { ExplainedInvestigationReport } from "@/domain/investigations/types";

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

export function InvestigationShare({ report }: { report: ExplainedInvestigationReport }) {
  const [message, setMessage] = useState("");
  const [manualLink, setManualLink] = useState("");
  const downloads = useRef(new Set<string>());
  useEffect(() => { const owned = downloads.current; return () => { owned.forEach((url) => URL.revokeObjectURL(url)); owned.clear(); }; }, []);
  const label = report.token.name ?? report.token.symbol ?? "Base token";
  async function copyLink() {
    const url = new URL("/investigate", window.location.origin); url.searchParams.set("token", report.token.address);
    try { await navigator.clipboard.writeText(url.toString()); setMessage("Token scan link copied."); setManualLink(""); }
    catch { setManualLink(url.toString()); setMessage("Select and copy the token scan link below."); }
  }
  function downloadCard() {
    const title = label.length > 55 ? `${label.slice(0, 52)}…` : label;
    const content = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="560" viewBox="0 0 1000 560"><rect width="1000" height="560" rx="12" fill="#080808"/><rect x="1" y="1" width="998" height="558" rx="12" fill="none" stroke="#333"/><g font-family="monospace" fill="#eee"><text x="50" y="65" font-size="18" letter-spacing="3">TRACEFORCE ENGINE · BASE</text><text x="50" y="140" font-size="30">${escapeXml(title)}</text><text x="50" y="182" font-size="15" fill="#aaa">${escapeXml(report.token.address)}</text><text x="50" y="270" font-size="24">${report.wallets.length} discovered addresses · ${report.groups.length} linked groups</text><text x="50" y="315" font-size="17" fill="#aaa">Relationships do not establish shared ownership.</text><text x="50" y="390" font-size="17">Transfer coverage: ${escapeXml(report.coverage.transfers)}</text><text x="50" y="425" font-size="17">Finalized block ${escapeXml(report.range.to.number)}</text><text x="50" y="500" font-size="14" fill="#aaa">Snapshot generated ${escapeXml(report.generatedAt)}</text></g></svg>`;
    const url = URL.createObjectURL(new Blob([content], { type: "image/svg+xml" })); downloads.current.add(url);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `traceforce-base-${report.token.address}-${report.range.to.number}.svg`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 1000); setMessage("Report card downloaded.");
  }
  return <InvestigationPanel aria-labelledby="share-title" className="border border-border bg-surface/90 p-5"><h2 id="share-title" className="font-mono text-xs font-semibold uppercase tracking-wider">{"// SHARE"}</h2><div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"><div className="rounded-lg border border-border bg-background p-6"><p className="font-mono text-[10px] tracking-widest text-muted">TRACEFORCE · BASE</p><h3 className="mt-5 break-words text-xl font-semibold">{label}</h3><p className="mt-3 break-all font-mono text-[10px] text-muted">{report.token.address}</p><p className="mt-8 text-sm font-semibold">{report.wallets.length} discovered addresses · {report.groups.length} linked groups</p><p className="mt-3 text-xs leading-6 text-muted">Relationships do not establish shared ownership.</p><p className="mt-8 font-mono text-[10px] text-muted">Finalized block {report.range.to.number}</p></div><div><div className="flex flex-wrap gap-3"><button type="button" className="engine-button" onClick={downloadCard}><Download size={14} aria-hidden="true" />Download card</button><button type="button" className="engine-button" onClick={() => void copyLink()}><Copy size={14} aria-hidden="true" />Copy token link</button></div><p className="mt-4 text-xs leading-6 text-muted">The link opens this token for a fresh scan. The card represents this report’s original block window.</p><p role="status" className="mt-3 text-xs leading-6 text-muted">{message}</p>{manualLink && <input aria-label="Token scan link" readOnly value={manualLink} onFocus={(event) => event.currentTarget.select()} className="mt-3 min-h-11 w-full border border-border bg-background px-3 font-mono text-xs" />}</div></div></InvestigationPanel>;
}
