"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowUpRight, Bot, CornerDownLeft, Link2, MessageSquare, RotateCcw, Send, Square } from "lucide-react";
import { useReducedMotion } from "motion/react";
import type { ExplainedInvestigationReport } from "@/domain/investigations/types";
import type { InvestigationChatMessage } from "@/domain/investigations/questions";
import { InvestigationQuestionError, readInvestigationAnswer, type InvestigationAnswer } from "./investigation-question-response";
import { LoaderOne } from "./ui/loader";
import { Button as MovingBorderButton } from "./ui/moving-border";
import { BentoGridItem } from "./ui/bento-grid";
import { GlowingEffect } from "./ui/glowing-effect";

type Exchange = { id: number; question: string } & (
  | { status: "pending" }
  | { status: "answered"; response: InvestigationAnswer }
  | { status: "failed"; error: string }
);
export function InvestigationChat({ report, context, onReveal, onFreshScan }: { report: ExplainedInvestigationReport; context?: string; onReveal: (id: string) => void; onFreshScan: () => void }) {
  const reduceMotion = useReducedMotion();
  const active = useRef<AbortController | null>(null), nextId = useRef(0);
  const [question, setQuestion] = useState(""), [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null), busy = activeId !== null;
  const transcript = useRef<HTMLDivElement>(null), conversationEnd = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), restoreComposerFocus = useRef(false);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => { if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; if (exchanges.length) conversationEnd.current?.scrollIntoView({ block: "nearest" }); }, [exchanges]);
  useEffect(() => { if (!busy && restoreComposerFocus.current) { restoreComposerFocus.current = false; composer.current?.focus({ preventScroll: true }); } }, [busy]);

  async function send(text: string, retryId?: number) {
    if (!context || !text || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const id = retryId ?? ++nextId.current;
    setQuestion(""); setActiveId(id);
    const preceding = retryId === undefined ? exchanges : exchanges.slice(0, exchanges.findIndex((exchange) => exchange.id === retryId));
    const history: InvestigationChatMessage[] = preceding.filter((exchange) => exchange.status === "answered").slice(-3).flatMap((exchange) => exchange.status === "answered" ? [{ role: "user", content: exchange.question }, { role: "assistant", content: exchange.response.answer }] : []);
    setExchanges((previous) => retryId === undefined ? [...previous.slice(-9), { id, question: text, status: "pending" }] : previous.map((entry) => entry.id === id ? { id, question: text, status: "pending" } : entry));
    const deadline = setTimeout(() => controller.abort(new DOMException("Question timed out", "TimeoutError")), 145_000);
    try {
      const response = await fetch("/api/questions", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, cache: "no-store", signal: controller.signal, body: JSON.stringify({ question: text, context, ...(history.length ? { history } : {}) }) });
      const result = await readInvestigationAnswer(response, new Set(report.evidence.map((item) => item.id)), controller.signal);
      controller.signal.throwIfAborted();
      if (active.current === controller) setExchanges((previous) => previous.map((entry) => entry.id === id ? { id, question: text, status: "answered", response: result } : entry));
    } catch (caught) {
      if (active.current !== controller) return;
      const message = controller.signal.aborted ? (controller.signal.reason?.name === "TimeoutError" ? "The question took too long. Please try again." : "Question cancelled.") : caught instanceof InvestigationQuestionError ? caught.message : "The question could not complete. Please try again.";
      setExchanges((previous) => previous.map((entry) => entry.id === id ? { id, question: text, status: "failed", error: message } : entry));
      setQuestion(text);
    } finally { clearTimeout(deadline); if (active.current === controller) { active.current = null; restoreComposerFocus.current = true; setActiveId(null); } }
  }

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim(), latest = exchanges.at(-1);
    void send(text, latest?.status === "failed" && latest.question === text ? latest.id : undefined);
  }

  return <BentoGridItem as="section" aria-labelledby="questions-title" className="isolate text-foreground">
    <GlowingEffect disabled={false} blur={0} spread={40} proximity={32} />
    <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-background/40 px-4 py-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent"><Bot size={23} strokeWidth={1.5} aria-hidden="true" /></span>
        <div className="min-w-0"><p className="mb-1 font-mono text-[10px] tracking-[0.18em] text-accent">TRACEFORCE / AI</p><h2 id="questions-title" className="text-sm font-semibold tracking-tight sm:text-base">Questions about this token</h2></div>
      </div>
      {exchanges.length > 0 && <button type="button" disabled={busy} onClick={() => { setExchanges([]); composer.current?.focus({ preventScroll: true }); }} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"><RotateCcw size={13} aria-hidden="true" />Clear conversation</button>}
    </div>
    {!context ? <div className="relative p-5 sm:p-6"><p className="max-w-xl text-sm leading-7 text-muted">Start a fresh scan to chat about this token. Saved snapshots do not include an active chat session.</p><button type="button" onClick={onFreshScan} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-4 text-sm text-accent transition-colors hover:bg-accent/20 focus-visible:outline-accent">Run a fresh scan<ArrowUpRight size={14} aria-hidden="true" /></button></div> : <>
      <div ref={transcript} role="region" aria-label="Conversation" tabIndex={0} className="relative max-h-[520px] min-h-64 overflow-y-auto overscroll-contain p-4 focus-visible:outline-accent sm:p-6">
        {!exchanges.length && <div className="relative flex min-h-64 flex-col items-center justify-center overflow-hidden px-2 py-6 text-center">
          <div aria-hidden="true" className="pointer-events-none absolute inset-8 -z-10 rounded-xl border border-dashed border-accent/10"><span className="absolute -left-px -top-px size-4 rounded-tl-lg border-l border-t border-accent/40" /><span className="absolute -bottom-px -right-px size-4 rounded-br-lg border-b border-r border-accent/40" /></div>
          <span className="flex size-14 items-center justify-center rounded-xl border border-accent/30 bg-background text-accent"><MessageSquare size={25} strokeWidth={1.5} aria-hidden="true" /></span>
          <p className="mt-5 max-w-lg break-words text-lg font-medium leading-7 tracking-tight">What would you like to know about {report.token.name ?? "this token"}?</p>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted">Follow the funding, explore wallet connections, or ask what the evidence means.</p>
          <span className="mt-5 inline-flex items-center gap-2 rounded-full border border-amber/20 bg-amber/5 px-3 py-1.5 font-mono text-[10px] tracking-wider text-amber"><Link2 size={12} aria-hidden="true" />EVIDENCE IN FOCUS</span>
        </div>}
        <ol aria-label="Questions and answers" aria-live="polite" className="space-y-7">{exchanges.map((exchange) => <li key={exchange.id} className="space-y-4">
          <div className="ml-auto max-w-[90%] rounded-xl rounded-tr-md border border-border bg-foreground/5 px-4 py-3 sm:max-w-[75%] sm:px-5"><p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">You</p><p className="whitespace-pre-wrap break-words text-base leading-7 sm:text-[15px]">{exchange.question}</p></div>
          <div className="flex items-start gap-2.5 sm:gap-3">
            <span className={`mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl border ${exchange.status === "failed" ? "border-amber/30 bg-amber/10 text-amber" : "border-accent/30 bg-accent/10 text-accent"}`}><Bot size={17} strokeWidth={1.5} aria-hidden="true" /></span>
            <div className={`min-w-0 max-w-[calc(100%_-_42px)] rounded-xl rounded-tl-md border px-4 py-4 sm:max-w-[85%] sm:px-5 ${exchange.status === "failed" ? "border-amber/30 bg-amber/5" : "border-accent/20 bg-background/70"}`}>
              <p className={`mb-2 font-mono text-[10px] uppercase tracking-[0.16em] ${exchange.status === "failed" ? "text-amber" : "text-accent"}`}>{exchange.status === "failed" ? "Response unavailable" : "TraceForce AI"}{exchange.status === "answered" && exchange.response.model && <span aria-label={`Response model ${exchange.response.model}`} className="ml-2 break-all font-normal normal-case tracking-normal text-muted">{exchange.response.model}</span>}</p>
              {exchange.status === "pending" ? <div role="status" className="flex min-h-9 items-center gap-4 text-sm leading-7 text-muted"><span aria-hidden="true" className="flex h-8 items-center text-accent">{reduceMotion ? <Activity size={20} /> : <LoaderOne />}</span><span>Reading report…</span></div> : exchange.status === "failed" ? <>
                <p role="alert" className="break-words text-base leading-7 sm:text-[15px]">{exchange.error}</p><button type="button" disabled={busy} onClick={() => void send(exchange.question, exchange.id)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-amber/25 px-3 text-xs text-amber transition-colors hover:bg-amber/10 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"><RotateCcw size={13} aria-hidden="true" />Retry question</button>
              </> : <>
                <p className="whitespace-pre-wrap break-words text-base leading-7 sm:text-[15px]">{exchange.response.answer}</p>
                {exchange.response.caveat && <p className="mt-4 border-l border-amber/50 pl-3 text-sm leading-6 text-muted">{exchange.response.caveat}</p>}
                {exchange.response.evidenceIds.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{exchange.response.evidenceIds.map((id, index) => <a key={id} href={`#evidence-${encodeURIComponent(id)}`} onClick={() => onReveal(id)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-amber/25 bg-amber/5 px-3 font-mono text-[11px] text-amber transition-colors hover:border-amber/50 hover:bg-amber/10 focus-visible:outline-accent"><Link2 size={12} aria-hidden="true" />Evidence {index + 1}<ArrowUpRight size={12} aria-hidden="true" /></a>)}</div>}
                {exchange.response.needsFreshScan && <button type="button" onClick={onFreshScan} className="mt-3 inline-flex min-h-11 items-center gap-2 text-xs text-accent underline underline-offset-4 focus-visible:outline-accent">Run a fresh scan<ArrowUpRight size={14} aria-hidden="true" /></button>}
              </>}
            </div>
          </div>
        </li>)}</ol>
        <div ref={conversationEnd} />
      </div>
      <div className="relative border-t border-border bg-background/40 p-4 sm:p-5">
        <form onSubmit={ask} aria-busy={busy} className="flex items-stretch gap-2 rounded-xl border border-accent/20 bg-background p-2 transition-colors focus-within:border-accent/60">
          <label htmlFor="token-question" className="sr-only">Ask about the observed evidence</label><textarea ref={composer} id="token-question" rows={2} maxLength={1000} required value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} disabled={busy} placeholder="Ask about this token..." className="min-h-14 min-w-0 flex-1 resize-y rounded-xl bg-transparent px-2 py-2 text-base leading-6 text-foreground placeholder:text-muted focus-visible:outline-accent disabled:opacity-50 sm:text-sm" />
          <MovingBorderButton type="submit" aria-label="Ask investigator" disabled={busy || !question.trim()} duration={4000} containerClassName="h-auto min-h-12 w-12 shrink-0 rounded-xl disabled:cursor-not-allowed disabled:opacity-40 sm:w-24" className="gap-2 rounded-xl border-accent/30 bg-accent/10 px-0 text-accent sm:px-4"><Send size={17} aria-hidden="true" /><span className="hidden font-mono text-xs sm:inline">SEND</span></MovingBorderButton>
          {busy && <button type="button" aria-label="Cancel question" onClick={() => active.current?.abort()} className="flex min-h-12 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-muted transition-colors hover:border-amber/50 hover:bg-amber/5 hover:text-amber focus-visible:outline-accent"><Square size={15} aria-hidden="true" /></button>}
        </form>
        <div className="mt-3 flex flex-wrap gap-2">{["Who funded the wallets?", "Are the wallets connected?", "Who accumulated early?", "What does the selling evidence show?"].map((prompt) => <button key={prompt} type="button" disabled={busy} onClick={() => { setQuestion(prompt); composer.current?.focus(); }} className="min-h-11 rounded-xl border border-border bg-surface px-3 text-xs text-muted transition-colors hover:border-accent/40 hover:bg-accent/5 hover:text-foreground focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50">{prompt}</button>)}</div>
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-6 text-muted"><span className="inline-flex items-center gap-1.5"><Link2 size={12} className="text-amber" aria-hidden="true" />Grounded in this scan</span><span className="inline-flex items-center gap-1.5"><CornerDownLeft size={12} aria-hidden="true" />Enter to send</span><span>Shift + Enter for a new line</span></p>
      </div>
    </>}
  </BentoGridItem>;
}
