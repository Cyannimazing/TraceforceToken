import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, GitBranch, ScanLine, Wallet, Waves } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { createMetadata } from "@/lib/seo";
import "@/components/traceforge-pages.css";

export const metadata = createMetadata({
  title: "Follow the evidence",
  description: "Investigate Base tokens with TraceForge. Follow wallet funding, understand connections, and get a clear explanation of the evidence behind the activity.",
  path: "/",
});

const questions = [
  { number: "01", label: "FOLLOW THE FUNDING", icon: Wallet, title: "Where did the money come from?", description: "Follow the observed funding into a wallet. Open the transactions that connect it to the source." },
  { number: "02", label: "CONNECT THE WALLETS", icon: GitBranch, title: "Are these wallets connected?", description: "Find shared funding and transfers. See the reason for each link, without treating a connection as proof of one owner." },
  { number: "03", label: "RECONSTRUCT THE ACTIVITY", icon: ScanLine, title: "Who got in early?", description: "Explore accumulation in the period examined. Understand what happened before the activity you see today." },
  { number: "04", label: "EXAMINE THE EXITS", icon: Waves, title: "What does the selling reveal?", description: "Look at supported sales and previously linked wallets. Separate actual trades from tokens simply moving around." },
];

function NetworkIllustration() {
  const pixels = Array.from({ length: 112 }, (_, index) => {
    const column = index % 14, row = Math.floor(index / 14);
    return { x: 125 + column * 22, y: 60 + row * 22, size: 8 + ((column * 7 + row * 11) % 13), visible: (column + row * 3) % 5 !== 0 };
  });
  return <figure className="tf-hero-art" aria-labelledby="tf-network-caption">
    <svg className="tf-network-illustration" viewBox="0 0 560 480" fill="none" aria-hidden="true">
      <defs><linearGradient id="tf-pixel-spectrum" x1="140" y1="70" x2="430" y2="250" gradientUnits="userSpaceOnUse"><stop className="tf-stop-cobalt" /><stop offset=".43" className="tf-stop-cyan" /><stop offset=".72" className="tf-stop-violet" /><stop offset="1" className="tf-stop-coral" /></linearGradient></defs>
      <g className="tf-art-orbit"><path d="M38 275H120V353H255V417H438V344H508M85 217H168V302H332V252H473V158H524" /><path d="M168 302V379H91M332 252V179H390V115M255 417V448H340M438 344H381V302" /><rect x="32" y="269" width="12" height="12" /><rect x="114" y="347" width="12" height="12" /><rect x="249" y="411" width="12" height="12" /><rect x="432" y="338" width="12" height="12" /><rect x="502" y="338" width="12" height="12" /><rect x="162" y="296" width="12" height="12" /><rect x="326" y="246" width="12" height="12" /><rect x="467" y="152" width="12" height="12" /><rect x="384" y="109" width="12" height="12" /></g>
      <g className="tf-art-pixels" fill="url(#tf-pixel-spectrum)">{pixels.filter((pixel) => pixel.visible).map((pixel, index) => <rect key={index} x={pixel.x} y={pixel.y} width={pixel.size} height={pixel.size} className={["tf-pixel", "tf-pixel-phase-" + index % 4].join(" ")} />)}</g>
      <g className="tf-art-signals"><rect x="162" y="296" width="12" height="12" /><rect x="326" y="246" width="12" height="12" /><rect x="432" y="338" width="12" height="12" /></g>
      <path className="tf-art-trace" d="M38 275H120V353H255V417H438V344H508" pathLength="100" />
    </svg>
    <figcaption id="tf-network-caption"><span className="tf-mini-square" />Illustrative network · your report uses acquired evidence</figcaption>
  </figure>;
}

export default function Home() {
  return <div className="tf-public tf-home">
    <SiteHeader active="home" />
    <main id="main-content">
      <section className="tf-container tf-hero" aria-labelledby="hero-title">
        <div className="tf-hero-copy">
          <p className="tf-eyebrow"><span className="tf-mini-square" />ON-CHAIN INVESTIGATION · BASE</p>
          <h1 id="hero-title">Every token<br />has a <em>story.</em></h1>
          <p className="tf-hero-description">Follow the money. Understand the connections.<br className="tf-desktop-break" /> Get a clearer picture of what you’re looking at.</p>
          <div className="tf-actions"><Link className="tf-button tf-button-primary" href="/investigate">Investigate a token <ArrowUpRight size={18} aria-hidden="true" /></Link><Link className="tf-text-link" href="/methodology">How it works <ArrowRight size={16} aria-hidden="true" /></Link></div>
          <p className="tf-hero-note">Public data. No wallet connection.</p>
        </div>
        <NetworkIllustration />
        <div className="tf-hero-bottom"><p>A trail worth understanding.</p><a className="tf-text-link" href="#approach">Explore the possibilities <ArrowDown size={16} aria-hidden="true" /></a></div>
      </section>

      <section className="questions-section tf-section" id="approach" aria-labelledby="questions-title">
        <div className="tf-container">
          <div className="tf-section-intro"><div><p className="tf-eyebrow">START WITH BETTER QUESTIONS</p><h2 id="questions-title">Look beyond<br /><em>the price.</em></h2></div><p>A token address opens a trail of activity. TraceForge brings the important parts together, with evidence you can explore.</p></div>
          <div className="tf-question-grid">{questions.map(({ number, label, icon: Icon, title, description }) => <article className="question-card tf-question" key={number}>
            <div className="tf-question-top"><p className="question-label"><span>{number}</span>{label}</p><Icon size={24} strokeWidth={1.3} aria-hidden="true" /></div>
            <h3>{title}</h3><p>{description}</p><Link href="/investigate" className="tf-question-link" aria-label={"Investigate: " + title}><ArrowUpRight size={22} strokeWidth={1.4} aria-hidden="true" /></Link>
          </article>)}</div>
        </div>
      </section>

      <section className="tf-container tf-section tf-process" aria-labelledby="process-title">
        <div className="tf-section-intro"><div><p className="tf-eyebrow">FROM ADDRESS TO UNDERSTANDING</p><h2 id="process-title">A little less noise.<br /><em>A clearer trail.</em></h2></div><Link className="tf-text-link" href="/methodology">Inside the method <ArrowUpRight size={16} aria-hidden="true" /></Link></div>
        <ol className="tf-process-steps">{[
          ["01", "Find the signals", "Collect public activity and source context for the token you’re examining."],
          ["02", "Check the evidence", "Inspect transactions, wallet balances and the basis for reported relationships."],
          ["03", "Make it understandable", "Read a direct explanation of the findings, then ask about the details that matter to you."],
        ].map(([number, title, description]) => <li key={number}><span className="tf-step-node">{number}</span><h3>{title}</h3><p>{description}</p></li>)}</ol>
      </section>

      <section className="tf-interpretation" aria-labelledby="explanation-title"><div className="tf-container tf-interpretation-inner"><div><p className="tf-eyebrow">AI, WITH SOMETHING TO SAY</p><h2 id="explanation-title">Human language.<br /><em>Traceable reasons.</em></h2><p>Start with the conclusion and why it matters. Open the supporting details when you want to go deeper.</p><Link className="tf-text-link" href="/investigate">Follow a token’s story <ArrowUpRight size={16} aria-hidden="true" /></Link></div><div className="tf-example"><p className="tf-eyebrow">EXAMPLE EXPLANATION · ILLUSTRATIVE</p><blockquote>“One wallet holds most of the tokens available to trade. A large sale could move the price sharply.”</blockquote><span className="tf-example-rule" /><p>Your report explains the acquired findings. Missing evidence stays visible.</p></div></div></section>

      <section className="tf-container tf-source-strip" aria-labelledby="sources-title"><div><p className="tf-eyebrow">KNOW THE SOURCE</p><h2 id="sources-title">Connected data. Clear attribution.</h2></div><div className="tf-source-names" aria-label="Core data providers"><span>Alchemy</span><span>SWARM</span><span>GoPlus</span><span>DEX Screener</span></div><Link className="tf-text-link" href="/data-sources">Explore data sources <ArrowUpRight size={16} aria-hidden="true" /></Link></section>
      <section className="tf-container tf-closing"><span className="tf-closing-square" aria-hidden="true" /><h2>Find the story<br /><em>behind the address.</em></h2><Link className="tf-button tf-button-primary" href="/investigate">Start an investigation <ArrowUpRight size={18} aria-hidden="true" /></Link></section>
    </main>
    <SiteFooter />
  </div>;
}
