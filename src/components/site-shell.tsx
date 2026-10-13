import Link from "next/link";
import { ArrowUpRight, ChevronRight, ScanLine } from "lucide-react";
import { VisualEffectsToggle } from "./visual-effects-toggle";

export function BrandMark({ small = false, prominent = false }: { small?: boolean; prominent?: boolean }) {
  const size = prominent ? 44 : small ? 31 : 36;
  // A small local PNG with explicit dimensions avoids generated inline image styles under CSP.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/traceforce-mark.png" width={size} height={size} alt="" aria-hidden="true" className={prominent ? "size-11 object-contain" : small ? "size-[31px] object-contain" : "size-9 object-contain max-[480px]:size-[31px]"} />;
}

export function InvestigationHeader({ active = "scan" }: { active?: "home" | "scan" } = {}) {
  return <header className="sticky top-0 z-10 border-b border-border bg-background/95 text-foreground backdrop-blur-xl">
    <div className="engine-container flex min-h-20 flex-wrap items-center justify-between gap-x-8 gap-y-1 py-3">
      <Link href="/" aria-label="TraceForce Engine home" className="inline-flex min-h-11 items-center gap-3"><BrandMark prominent /><span className="flex flex-col gap-1"><span className="text-base leading-none font-bold tracking-[.15em]">TRACEFORCE</span><span className="font-mono text-[9px] tracking-[.3em] text-accent">ON-CHAIN INTELLIGENCE</span></span></Link>
      <nav aria-label="Main navigation" className="flex min-h-11 items-center gap-5 text-xs sm:gap-7">
        <Link href="/investigate" aria-current={active === "scan" ? "page" : undefined} className="inline-flex min-h-11 items-center gap-2 border-b border-accent px-1 font-semibold text-accent"><ScanLine size={14} aria-hidden="true" />Scan</Link>
        <Link href="/methodology" className="inline-flex min-h-11 items-center text-muted transition-colors hover:text-foreground">Methodology</Link>
        <Link href="/data-sources" className="inline-flex min-h-11 items-center text-muted transition-colors hover:text-foreground">Sources</Link>
      </nav>
      <div className="flex items-center gap-3"><span className="hidden items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-3 py-2 font-mono text-[10px] tracking-wider text-accent lg:inline-flex"><span className="size-1.5 rounded-full bg-accent" />BASE MAINNET</span><VisualEffectsToggle /></div>
    </div>
  </header>;
}

export function SiteHeader({ active }: { active?: "methodology" | "sources" } = {}) {
  return (
    <header className="bg-dark text-warm-white">
      <div className="site-container flex min-h-[101px] items-center gap-10 border-b border-dark-line max-[800px]:min-h-[88px] max-[800px]:gap-5 max-[480px]:min-h-20 max-[480px]:flex-wrap max-[480px]:gap-3.5 max-[480px]:py-[15px] max-[350px]:gap-0 max-[350px]:py-[9px]">
        <Link className="inline-flex min-h-11 items-center gap-2.5 text-2xl font-semibold tracking-[-0.9px] max-[800px]:gap-2 max-[800px]:text-[22px]" href="/" aria-label="TraceForce Engine home"><BrandMark /><span>TraceForce Engine<span className="text-copper">.</span></span></Link>
        <nav className="ml-auto flex gap-9 max-[800px]:gap-5 max-[480px]:gap-4 max-[350px]:ml-0 max-[350px]:w-full max-[350px]:justify-between" aria-label="Main navigation">
          <Link className="inline-flex min-h-11 items-center gap-[7px] text-sm text-warm-white/80 transition-colors duration-150 hover:text-warm-white aria-[current=page]:text-warm-white max-[800px]:text-xs max-[480px]:text-[11px]" href="/methodology" aria-current={active === "methodology" ? "page" : undefined}>Methodology</Link>
          <Link className="inline-flex min-h-11 items-center gap-[7px] text-sm text-warm-white/80 transition-colors duration-150 hover:text-warm-white aria-[current=page]:text-warm-white max-[800px]:text-xs max-[480px]:text-[11px]" href="/data-sources" aria-current={active === "sources" ? "page" : undefined}>Data sources <ArrowUpRight className="max-[480px]:hidden" size={14} aria-hidden="true" /></Link>
        </nav>
        <span className="inline-flex items-center gap-[9px] rounded border border-dark-line px-[13px] py-2.5 text-xs whitespace-nowrap text-muted-on-dark max-[800px]:hidden"><span className="inline-block size-[5px] shrink-0 rounded-full bg-copper" />In development</span>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-dark text-warm-white">
      <div className="site-container flex items-start justify-between gap-[30px] pt-[47px] pb-[41px] max-[800px]:py-[35px] max-[480px]:flex-col max-[480px]:gap-5 max-[480px]:pt-[30px] max-[480px]:pb-[22px]">
        <div>
          <Link className="inline-flex min-h-11 items-center gap-2.5 text-[22px] font-semibold tracking-[-0.9px] max-[800px]:gap-2" href="/" aria-label="TraceForce Engine home"><BrandMark small /><span>TraceForce Engine<span className="text-copper">.</span></span></Link>
          <p className="mt-3 text-[11px] text-muted-on-dark">Follow the activity. Understand the connections.</p>
        </div>
        <nav className="flex gap-[42px] max-[800px]:gap-[22px] max-[480px]:gap-8" aria-label="Footer navigation">
          <Link className="inline-flex min-h-11 items-center gap-4 text-[11px] text-warm-white/80 transition-colors duration-150 hover:text-copper" href="/methodology">Methodology <ChevronRight size={14} aria-hidden="true" /></Link>
          <Link className="inline-flex min-h-11 items-center gap-4 text-[11px] text-warm-white/80 transition-colors duration-150 hover:text-copper" href="/data-sources">Data sources <ChevronRight size={14} aria-hidden="true" /></Link>
        </nav>
      </div>
      <div className="site-container flex items-center justify-between gap-5 border-t border-dark-line py-[22px] text-[10px] text-muted-on-dark max-[800px]:gap-[13px] max-[800px]:text-[9px] max-[480px]:flex-wrap max-[480px]:gap-[15px] max-[480px]:pt-[18px] max-[480px]:pb-6 max-[480px]:leading-[1.7]"><p>TraceForce Engine <span className="px-2.5 text-muted-on-dark/70" aria-hidden="true">/</span> Public on-chain investigations</p><p className="max-[800px]:hidden">Base first. Evidence always.</p><span className="inline-flex items-center gap-[9px] whitespace-nowrap"><span className="inline-block size-[5px] shrink-0 rounded-full bg-copper" />In development</span></div>
    </footer>
  );
}

export function PageIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <section className="bg-dark pt-[38px] pb-20 text-warm-white max-[800px]:pb-[60px] max-[480px]:pt-[25px] max-[480px]:pb-[46px]">
      <div className="site-container"><Link className="mb-[31px] inline-flex min-h-11 items-center gap-[13px] text-[11px] text-muted-on-dark transition-colors duration-150 hover:text-copper max-[480px]:mb-[22px]" href="/">TraceForce Engine <span className="text-muted-on-dark/70" aria-hidden="true">/</span></Link><p className="mb-[21px] flex items-center gap-[11px] text-[11px] leading-normal font-semibold tracking-[1.8px] text-copper max-[480px]:text-[9px]">{eyebrow}</p><h1 className="max-w-[850px] text-[clamp(42px,5vw,66px)] leading-[1.12] font-normal tracking-[-2.6px] text-balance max-[480px]:text-[42px] max-[480px]:tracking-[-1.6px]">{title}</h1><p className="mt-[25px] max-w-[680px] text-[17px] leading-[1.85] text-warm-white/75 max-[800px]:text-base max-[480px]:mt-5 max-[480px]:text-[15px]">{description}</p></div>
    </section>
  );
}
