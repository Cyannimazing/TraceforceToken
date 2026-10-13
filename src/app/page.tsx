import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, Blocks, Bot, GitBranch, ScanLine, ShieldCheck, Wallet } from "lucide-react";
import { InvestigationHeader } from "@/components/site-shell";
import { BackgroundBeamsWithCollision } from "@/components/ui/background-beams-with-collision";
import { BentoGrid, BentoGridItem } from "@/components/ui/bento-grid";
import { TraceMotionProvider } from "@/components/ui/motion-preferences";
import { createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "On-chain investigation, backed by evidence",
  description: "TraceForce Engine investigates Base tokens through public on-chain evidence, tracing wallet funding, connections, early accumulation and coordinated selling.",
  path: "/",
});

const questions = [
  { number: "01", label: "FUNDING PROVENANCE", icon: Wallet, title: "Who funded the wallets?", description: "Trace observed native funding into examined wallets, with the transactions and time window behind each relationship.", detail: "Follow the source" },
  { number: "02", label: "WALLET CONNECTIONS", icon: GitBranch, title: "Which wallets are connected?", description: "Examine shared funding and direct transfers. Inspect why addresses are linked and where those links remain uncertain.", detail: "Connect the activity" },
  { number: "03", label: "EARLY ACCUMULATION", icon: Blocks, title: "Who accumulated early?", description: "Reconstruct token inflows in the earliest examined interval. See the receipts without mistaking a partial window for token launch.", detail: "Reconstruct the timeline" },
  { number: "04", label: "COORDINATED SELLING", icon: ScanLine, title: "What suggests a coordinated exit?", description: "Compare supported selling across previously connected wallets. Distinguish verified swaps from outgoing transfers.", detail: "Examine the evidence" },
];

export default function Home() {
  return <TraceMotionProvider><div className="engine-shell engine-home">
    <InvestigationHeader active="home" />
    <main id="main-content">
      <section className="engine-container pt-12 sm:pt-20" aria-labelledby="hero-title">
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.08fr] lg:gap-14">
          <div>
            <p className="engine-kicker flex items-center gap-2"><ScanLine size={14} aria-hidden="true" />ON-CHAIN INVESTIGATION / BASE</p>
            <h1 id="hero-title" className="mt-6 text-[clamp(2.8rem,5.5vw,5rem)] leading-[1.04] font-semibold tracking-[-.05em] text-balance">Every token<br />leaves a <span className="text-accent">trail.</span></h1>
            <p className="mt-6 max-w-lg text-base leading-8 text-muted sm:text-lg">Trace the funding. Connect the wallets. Reconstruct the activity behind the token.</p>
            <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-3">
              <Link className="engine-button engine-button-primary" href="/investigate">Investigate a token <ArrowUpRight size={18} aria-hidden="true" /></Link>
              <Link className="inline-flex min-h-11 items-center gap-2 text-sm text-muted hover:text-accent" href="/methodology">Explore the methodology <ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] text-muted"><span className="flex items-center gap-2"><ShieldCheck size={14} className="text-accent" aria-hidden="true" />Read-only public data</span><span>No wallet connection</span></div>
          </div>
          <BentoGridItem className="border-accent/25">
            <figure aria-labelledby="laser-concept-title">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 font-mono text-[10px] tracking-wider"><span id="laser-concept-title" className="flex items-center gap-2 text-accent"><Bot size={16} aria-hidden="true" />LASER / TRACE ENGINE</span><span className="text-muted">CONCEPT VIEW</span></div>
              <BackgroundBeamsWithCollision className="aspect-[3/2] h-auto w-full" />
              <figcaption className="border-t border-border px-5 py-4 text-xs leading-6 text-muted">Illustrative paths. The report shows the transactions and verified balances collected for your token.</figcaption>
            </figure>
          </BentoGridItem>
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border py-6 text-xs text-muted sm:mt-14"><p>Public records. Connected evidence. A clearer story.</p><a href="#approach" className="inline-flex min-h-11 items-center gap-3 hover:text-accent">Follow the evidence <ArrowDown size={15} aria-hidden="true" /></a></div>
      </section>

      <section className="questions-section border-y border-border" id="approach" aria-labelledby="questions-title">
        <div className="engine-container">
          <div className="mb-8 grid gap-5 lg:grid-cols-2 lg:items-end lg:gap-14">
            <div><p className="engine-kicker">FOUR LINES OF INQUIRY</p><h2 id="questions-title" className="mt-4 text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">The story behind<br /><span className="text-muted">the token.</span></h2></div>
            <p className="max-w-lg text-sm leading-7 text-muted sm:text-base">Start with a token address. Inspect its observed activity, wallet relationships and the evidence behind each finding.</p>
          </div>
          <BentoGrid className="max-w-none gap-4 md:auto-rows-auto md:grid-cols-2 sm:gap-6">
            {questions.map(({ number, label, icon: Icon, title, description, detail }) => <BentoGridItem as="article" className="question-card" key={number}>
              <div className="flex items-center justify-between gap-4"><p className="question-label"><span>{number}</span>{label}</p><Icon size={24} strokeWidth={1.4} className="text-accent" aria-hidden="true" /></div>
              <h3 className="mt-6">{title}</h3><p>{description}</p><span className="mt-7 flex items-center gap-3 text-xs text-accent">{detail}<ArrowRight size={14} aria-hidden="true" /></span>
            </BentoGridItem>)}
          </BentoGrid>
        </div>
      </section>

      <section className="engine-container py-14 sm:py-20" aria-labelledby="llm-title">
        <BentoGridItem as="section" className="p-6 sm:p-9">
          <div className="grid gap-8 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
            <div><p className="engine-kicker flex items-center gap-2"><Bot size={16} aria-hidden="true" />TRACEFORCE / AI</p><h2 id="llm-title" className="mt-5 text-3xl leading-tight font-semibold tracking-tight">Evidence first.<br /><span className="text-accent">AI explains the trail.</span></h2><p className="mt-5 max-w-lg text-sm leading-7 text-muted">AI reviews the collected findings and answers questions about this scan, using a local model or a configured Gemini fallback. Explanations link back to evidence and keep missing data visible.</p><Link className="mt-6 inline-flex min-h-11 items-center gap-2 text-sm text-accent" href="/data-sources">Explore data sources <ArrowUpRight size={16} aria-hidden="true" /></Link></div>
            <ol className="flex flex-col justify-center divide-y divide-border">
              {[
                ["01", "Read", "Collect public on-chain activity in a pinned block window."],
                ["02", "Reconstruct", "Link funding, transfers and supported selling with exact transaction references."],
                ["03", "Explain", "Review the findings with the LLM, then ask follow-up questions."],
              ].map(([number, title, description]) => <li key={number} className="flex gap-5 py-5"><span className="pt-1 font-mono text-xs text-accent">{number}</span><div><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-muted">{description}</p></div></li>)}
            </ol>
          </div>
        </BentoGridItem>
      </section>
    </main>
    <footer className="engine-container flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border py-6 text-xs leading-6 text-muted"><p>TraceForce Engine / Public evidence. Clear limits.</p><nav aria-label="Footer navigation" className="flex flex-wrap gap-5"><Link className="inline-flex min-h-11 items-center hover:text-accent" href="/methodology">Methodology</Link><Link className="inline-flex min-h-11 items-center hover:text-accent" href="/data-sources">Data sources</Link></nav></footer>
  </div></TraceMotionProvider>;
}
