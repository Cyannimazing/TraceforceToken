"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ChevronRight, Download, FolderOpen, HardDrive, Layers3, Network, Radio, Save, Search, ShieldCheck, Square, Trash2, Wallet, X, Zap } from "lucide-react";
import type { ExplainedInvestigationReport, InvestigationReport } from "@/domain/investigations/types";
import { DEFAULT_LOOKBACK_BLOCKS } from "@/domain/investigations/scan-defaults";
import { InvestigationReportView } from "./investigation-report";
import { InvestigationStreamError, readInvestigationStream } from "./investigation-stream";
import { BrowserReportStorageError, clearBrowserReports, listBrowserReports, openBrowserReport, removeBrowserReport, saveBrowserReport, type BrowserReportSummary } from "./browser-reports";
import { BackgroundBeamsWithCollision } from "./ui/background-beams-with-collision";
import { Spotlight } from "./ui/spotlight";
import { GlowingEffect } from "./ui/glowing-effect";
import { Button as MovingBorderButton } from "./ui/moving-border";
import { useTraceMotion } from "./ui/motion-preferences";
import { BentoGridItem } from "./ui/bento-grid";

const inputClass = "engine-input mt-2 focus-visible:outline-focus";
const secondaryButtonClass = "engine-button";
type CurrentResult = { report: ExplainedInvestigationReport; chatContext?: string; savedAt?: string; revision: number };
type AnalysisPreview = { report: InvestigationReport; revision: number };
const date = (value: string) => new Date(value).toLocaleString();

export function InvestigationWorkbench({ initialToken = "" }: { initialToken?: string }) {
  const { active: effectsActive } = useTraceMotion();
  const active = useRef<AbortController | null>(null), resultTitle = useRef<HTMLHeadingElement>(null), tokenInput = useRef<HTMLInputElement>(null), formRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(false), revision = useRef(0), analysisId = useRef<string | null>(null), downloadUrls = useRef(new Set<string>());
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [stages, setStages] = useState<string[]>([]);
  const [current, setCurrent] = useState<CurrentResult | null>(null), [snapshots, setSnapshots] = useState<BrowserReportSummary[]>([]);
  const [preview, setPreview] = useState<AnalysisPreview | null>(null);
  const [scope, setScope] = useState<"full" | "window">("full");
  const displayed = current ?? preview;
  const [storageBusy, setStorageBusy] = useState(false), [storageError, setStorageError] = useState(""), [storageMessage, setStorageMessage] = useState("");

  useEffect(() => {
    mounted.current = true;
    void listBrowserReports().then((rows) => { if (mounted.current) setSnapshots(rows); }).catch(() => { if (mounted.current) setStorageError("Browser storage is unavailable. You can still investigate and download reports."); });
    const urls = downloadUrls.current;
    return () => { mounted.current = false; active.current?.abort(); active.current = null; urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear(); };
  }, []);

  function showResult(result: Omit<CurrentResult, "revision">) {
    const samePreview = analysisId.current === result.report.id;
    analysisId.current = null;
    setCurrent({ ...result, revision: samePreview ? revision.current : ++revision.current });
    setPreview(null);
    if (!samePreview) requestAnimationFrame(() => resultTitle.current?.focus());
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    analysisId.current = null;
    setBusy(true); setError(""); setCurrent(null); setPreview(null); setStorageMessage(""); setStages(["Starting a fresh Base investigation"]);
    const deadline = setTimeout(() => controller.abort(new DOMException("Investigation timed out", "TimeoutError")), 295_000);
    try {
      const response = await fetch("/api/investigations", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, cache: "no-store", signal: controller.signal, body: JSON.stringify({ token: String(form.get("token")).trim(), scope, lookbackBlocks: scope === "window" ? Number(form.get("lookbackBlocks")) : DEFAULT_LOOKBACK_BLOCKS }) });
      const result = await readInvestigationStream(response, {
        signal: controller.signal,
        onProgress: (stage) => { if (active.current === controller) setStages((previous) => previous.at(-1) === stage ? previous : [...previous.slice(-19), stage]); },
        onAnalysis: (report) => {
          if (active.current !== controller) return;
          analysisId.current = report.id;
          setPreview({ report, revision: ++revision.current });
          requestAnimationFrame(() => resultTitle.current?.focus());
        },
      });
      if (active.current !== controller) return;
      showResult(result); setStages([]);
    } catch (caught) {
      if (active.current !== controller) return;
      setError(controller.signal.aborted ? (controller.signal.reason?.name === "TimeoutError" ? "The investigation took too long. Start a fresh investigation." : "Investigation cancelled. Start again to collect fresh data.") : caught instanceof InvestigationStreamError ? caught.message : "The investigation could not complete. Please try again."); setStages([]);
    } finally { clearTimeout(deadline); if (active.current === controller) { active.current = null; setBusy(false); } }
  }

  function freshScan() {
    if (!displayed || busy || storageBusy) return;
    if (tokenInput.current) tokenInput.current.value = displayed.report.token.address;
    formRef.current?.requestSubmit();
  }
  function clearResult() { active.current?.abort(); analysisId.current = null; setCurrent(null); setPreview(null); setStages([]); setStorageMessage(""); tokenInput.current?.focus(); }
  async function storageAction(action: () => Promise<void>) {
    setStorageBusy(true); setStorageError(""); setStorageMessage("");
    try { await action(); const rows = await listBrowserReports(); if (mounted.current) setSnapshots(rows); }
    catch (caught) { if (mounted.current) setStorageError(caught instanceof BrowserReportStorageError ? caught.message : "The browser snapshot could not be changed. Your current report is still available."); }
    finally { if (mounted.current) setStorageBusy(false); }
  }
  function saveCurrent() {
    if (!current) return;
    void storageAction(async () => { const result = await saveBrowserReport(current.report); if (mounted.current) setStorageMessage(`Report saved in this browser.${result.evicted ? ` ${result.evicted} older snapshot${result.evicted === 1 ? " was" : "s were"} removed to stay within the browser limit.` : ""}`); });
  }
  function openSnapshot(id: string) {
    void storageAction(async () => { const result = await openBrowserReport(id); if (!mounted.current) return; setError(""); showResult(result); setStorageMessage("Opened a saved browser snapshot. No fresh crawl was requested."); });
  }
  function downloadCurrent() {
    if (!current) return;
    try {
      // Export only the report: the signed question capsule and conversation are separate state.
      const blob = new Blob([JSON.stringify(current.report, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob);
      downloadUrls.current.add(url);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `traceforce-base-${current.report.token.address}-${current.report.range.to.number}.json`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 1000);
    } catch { setStorageError("The download could not start. Your current report is still available."); }
  }

  return <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
    <BentoGridItem as="section" id="investigation-form" aria-labelledby="scan-title" className="order-1 isolate scroll-mt-40 sm:scroll-mt-28">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true"><Spotlight className="-top-40 left-0 opacity-50" fill="var(--accent)" /><BackgroundBeamsWithCollision compact className="absolute inset-0 h-full w-full" /></div>
      <div className="relative z-[2] px-5 pt-7 pb-6 sm:px-9 sm:pt-10 lg:px-11">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2"><p className="engine-kicker flex items-center gap-2 text-accent"><span className="size-1.5 rounded-full bg-accent" />BASE TOKEN INTELLIGENCE</p><span className="font-mono text-[10px] tracking-wider text-muted">FRESH READS / PUBLIC EVIDENCE</span></div>
        <div className="mt-5 grid gap-6 lg:grid-cols-[1.3fr_1fr] lg:items-end lg:gap-12">
          <div><h1 id="scan-title" className="max-w-3xl text-[clamp(2.1rem,4.5vw,3.7rem)] leading-[1.08] font-semibold tracking-[-.045em] text-balance">Follow the token.<br /><span className="text-accent">Trace the wallets.</span></h1><p className="mt-5 max-w-xl text-sm leading-7 text-muted sm:text-base">Investigate funding, wallet links, early accumulation and supported selling evidence on Base.</p></div>
          <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-l-2 border-accent/35 pl-5 text-xs text-muted"><span className="flex items-center gap-2"><ShieldCheck size={15} className="text-accent" aria-hidden="true" />Read-only investigation</span><span className="flex items-center gap-2"><Wallet size={15} className="text-accent" aria-hidden="true" />No wallet connection</span><span className="flex items-center gap-2"><Zap size={15} className="text-accent" aria-hidden="true" />Free to use</span><span className="flex items-center gap-2"><Layers3 size={15} className="text-accent" aria-hidden="true" />Base mainnet</span></div>
        </div>
        <div className="engine-scan-panel relative mt-8 rounded-xl border border-border p-4 sm:p-6">
          <GlowingEffect spread={35} glow disabled={false} proximity={80} inactiveZone={0.2} borderWidth={1} />
          <form ref={formRef} onSubmit={submit} aria-busy={busy} className="relative">
            <div className="flex flex-wrap items-center justify-between gap-2"><label className="flex items-center gap-2 text-sm font-semibold" htmlFor="token-address"><Search size={16} className="text-accent" aria-hidden="true" />Base token contract</label><span className="font-mono text-[10px] tracking-wider text-muted">ERC-20 / 8453</span></div>
            <div className="mt-1 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start"><input ref={tokenInput} id="token-address" name="token" defaultValue={initialToken} required pattern="0x[0-9a-fA-F]{40}" maxLength={42} autoComplete="off" spellCheck={false} aria-describedby="token-help" placeholder="Paste a Base contract · 0x..." className={`${inputClass} min-w-0 font-mono text-base`} disabled={busy || storageBusy} /><MovingBorderButton type="submit" duration={4000} containerClassName="mt-2 h-14 w-full md:w-56 disabled:cursor-not-allowed disabled:opacity-50" className="engine-primary-fill gap-2 border-accent/50 px-5 text-sm font-semibold" disabled={busy || storageBusy}>{busy ? "Investigating..." : "Start investigation"}<ArrowRight size={17} aria-hidden="true" /></MovingBorderButton></div>
            <p id="token-help" className="mt-3 text-xs leading-6 text-muted">Fresh full crawl from Base genesis through the finalized block. Your report shows completed ranges and any remaining gaps.</p>
            <div className="mt-2 flex flex-wrap items-start justify-between gap-3"><details className="min-w-0"><summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted">Scan settings<ChevronRight size={13} aria-hidden="true" /></summary><div className="max-w-sm pb-3"><label className="block text-xs font-semibold" htmlFor="scan-scope">History scope</label><select id="scan-scope" name="scope" value={scope} onChange={(event) => setScope(event.target.value as "full" | "window")} className={inputClass} disabled={busy || storageBusy}><option value="full">Full crawl · all token history</option><option value="window">Recent block window</option></select>{scope === "window" && <><label className="mt-4 block text-xs font-semibold" htmlFor="lookback-blocks">History window (blocks)</label><input id="lookback-blocks" name="lookbackBlocks" type="number" min={100} max={20000} step={1} defaultValue={DEFAULT_LOOKBACK_BLOCKS} required className={inputClass} disabled={busy || storageBusy} /></>}<p className="mt-2 text-xs leading-6 text-muted">All discovered wallets are eligible. A full crawl is complete only when every requested range has been processed; provider, record and time limits remain visible.</p></div></details>{busy && <button type="button" className={secondaryButtonClass} onClick={() => active.current?.abort()}><Square size={13} aria-hidden="true" />Cancel investigation</button>}</div>
          </form>
        </div>
        {!busy && !current && <div className="mt-6 grid grid-cols-2 gap-4 text-xs leading-6 text-muted lg:grid-cols-4">{[{ icon: Wallet, text: "Who funded the wallets?" }, { icon: Network, text: "How are they connected?" }, { icon: Radio, text: "Who accumulated early?" }, { icon: Search, text: "What supports a sale?" }].map(({ icon: Icon, text }) => <div key={text} className="flex items-start gap-2"><Icon size={15} className="mt-1 shrink-0 text-accent" aria-hidden="true" /><span>{text}</span></div>)}</div>}
        {busy && !preview && <div className="mt-6 grid overflow-hidden rounded-2xl border border-accent/20 bg-background/85 lg:grid-cols-[.7fr_1.3fr]">
          <div className="engine-orbit-field relative flex min-h-52 items-center justify-center border-b border-border lg:border-r lg:border-b-0" aria-hidden="true"><svg viewBox="0 0 360 360" className="w-52 text-accent"><circle cx="180" cy="180" r="140" fill="none" stroke="currentColor" opacity=".12" /><circle cx="180" cy="180" r="105" fill="none" stroke="currentColor" opacity=".2" /><circle cx="180" cy="180" r="57" fill="currentColor" opacity=".04" /><g className={effectsActive ? "engine-orbit" : undefined}>{Array.from({ length: 24 }, (_, index) => { const angle = index * Math.PI * 2 / 24; return <circle key={index} cx={180 + Math.cos(angle) * (95 + index % 3 * 9)} cy={180 + Math.sin(angle) * (95 + index % 3 * 9)} r={2 + index % 3} fill="currentColor" opacity={.25 + index % 4 * .15} />; })}</g><path d="M150 180h60M180 150v60" stroke="currentColor" opacity=".4" /><circle cx="180" cy="180" r="8" fill="currentColor" /><text x="180" y="265" textAnchor="middle" fill="currentColor" fontSize="9" fontFamily="monospace" letterSpacing="3">TRACING EVIDENCE</text></svg></div>
          <div role="status" aria-live="polite" className="min-w-0 p-5 sm:p-6"><div className="flex items-center justify-between gap-3"><p className="engine-kicker flex items-center gap-2"><Radio size={14} className="text-accent" aria-hidden="true" />Live investigation</p><span className="font-mono text-[10px] text-muted">{stages.length} updates</span></div><p className="mt-3 text-base font-medium text-foreground">Fresh crawl in progress</p><ol className="mt-4 max-h-52 space-y-3 overflow-y-auto text-xs leading-6 text-muted">{stages.map((stage, index) => <li key={`${index}-${stage}`} className="flex gap-3"><span className="shrink-0 font-mono text-accent/80">{String(index + 1).padStart(2, "0")}</span><span className={index === stages.length - 1 ? "text-foreground" : ""}>{stage}</span></li>)}</ol></div>
        </div>}
        {busy && preview && <p className="mt-5 flex items-center gap-2 text-sm leading-6 text-muted"><Radio size={15} className="text-accent" aria-hidden="true" />{stages.at(-1) ?? "Preparing the required AI explanation"}</p>}
        {error && <p role="alert" className="mt-5 rounded-xl border border-copper/40 bg-copper/5 p-4 text-sm leading-7 text-foreground">{error}</p>}
      </div><div className="engine-tracer-rule" aria-hidden="true" />
    </BentoGridItem>
    <BentoGridItem as="section" aria-labelledby="browser-reports-title" className="order-3 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><HardDrive size={18} className="text-muted" aria-hidden="true" /><h2 id="browser-reports-title" className="text-base font-medium">Local snapshots</h2><span className="rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted">{snapshots.length} / 5</span></div>{snapshots.length > 0 && <button type="button" className={secondaryButtonClass} disabled={busy || storageBusy} onClick={() => void storageAction(async () => { await clearBrowserReports(); if (mounted.current) setStorageMessage("All saved browser snapshots were removed. The current page result is unchanged."); })}><Trash2 size={15} aria-hidden="true" />Clear all saved reports</button>}</div>
      {!snapshots.length ? <p className="mt-3 text-sm leading-7 text-muted">No reports saved in this browser.</p> : <ul className="mt-5 grid gap-4 sm:grid-cols-2">{snapshots.map((snapshot) => <li key={snapshot.id} className="min-w-0 rounded-xl border border-border bg-background/50 p-4"><p className="break-words text-sm font-semibold">{snapshot.name ?? "Base token"}</p><p className="mt-2 break-all font-mono text-xs leading-6 text-muted">{snapshot.token}</p><p className="mt-2 text-xs leading-6 text-muted">Saved <time dateTime={snapshot.savedAt}>{date(snapshot.savedAt)}</time> / blocks {snapshot.fromBlock}–{snapshot.toBlock}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={secondaryButtonClass} disabled={busy || storageBusy} onClick={() => openSnapshot(snapshot.id)}><FolderOpen size={15} aria-hidden="true" />Open snapshot</button><button type="button" className={secondaryButtonClass} aria-label={`Remove saved report for ${snapshot.token}`} disabled={busy || storageBusy} onClick={() => void storageAction(async () => { await removeBrowserReport(snapshot.id); if (mounted.current) setStorageMessage("Saved browser snapshot removed. The current page result is unchanged."); })}><Trash2 size={15} aria-hidden="true" />Remove</button></div></li>)}</ul>}
      {storageBusy && <p role="status" className="mt-4 text-sm leading-7 text-muted">Updating browser snapshots...</p>}
      {storageMessage && <p role="status" className="mt-4 text-sm leading-7">{storageMessage}</p>}
      {storageError && <p role="alert" className="mt-4 rounded-xl border border-copper/40 p-4 text-sm leading-7">{storageError}</p>}
    </BentoGridItem>
    {displayed && <section aria-labelledby="current-report-title" className="order-2 min-w-0 space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="current-report-title" ref={resultTitle} tabIndex={-1} className="scroll-mt-40 font-mono text-xs uppercase tracking-widest text-muted sm:scroll-mt-28">Your investigation report</h2><div className="flex flex-wrap gap-2">{current && <><button type="button" className={secondaryButtonClass} disabled={storageBusy} onClick={saveCurrent}><Save size={14} aria-hidden="true" />Save in this browser</button><button type="button" className={secondaryButtonClass} onClick={downloadCurrent}><Download size={14} aria-hidden="true" />Download JSON</button></>}<button type="button" className={secondaryButtonClass} onClick={clearResult}><X size={14} aria-hidden="true" />Clear report</button></div></div>
      {!current && preview && <p role="status" className="rounded-xl border border-accent/25 bg-accent/5 p-4 text-sm leading-7">{busy ? "Evidence is ready. The required AI explanation is still being prepared." : "Evidence preview only. The required AI explanation did not finish; start a fresh scan to complete the report."}</p>}
      {current?.savedAt && <div className="rounded-xl border border-copper/30 bg-surface p-4"><p className="text-xs leading-6 text-muted">Saved snapshot from <time dateTime={current.savedAt}>{date(current.savedAt)}</time>. Opening it does not collect new data. Its evidence ends at block {current.report.range.to.number}.</p><button type="button" onClick={freshScan} disabled={storageBusy} className="mt-2 inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-accent underline underline-offset-4">Run a fresh scan<ArrowRight size={14} aria-hidden="true" /></button></div>}
      <InvestigationReportView key={`${displayed.report.id}-${displayed.revision}`} report={displayed.report} pendingExplanation={busy && !current} chatContext={current?.chatContext} onFreshScan={freshScan} />
    </section>}
  </div>;
}
