import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { TraceForgeNavigation, type NavigationSection } from "./traceforge-navigation";
import { TraceForgeMark } from "./traceforge-brand";

export function BrandMark({ small = false, prominent = false }: { small?: boolean; prominent?: boolean }) {
  return <TraceForgeMark className={prominent ? "size-11" : small ? "size-8" : "size-10"} />;
}
export function InvestigationHeader({ active = "scan" }: { active?: "home" | "scan" } = {}) {
  return <TraceForgeNavigation active={active} />;
}
export function SiteHeader({ active }: { active?: NavigationSection } = {}) {
  return <TraceForgeNavigation active={active} />;
}
export function SiteFooter() {
  return <footer className="tf-site-footer"><div className="site-container tf-footer-main">
    <div><Link href="/" className="tf-brand" aria-label="TraceForge home"><BrandMark small /><span>TraceForge.</span></Link><p>Find the signal. Follow the evidence.</p></div>
    <nav aria-label="Footer navigation"><Link href="/investigate">Investigate <ArrowUpRight size={14} aria-hidden="true" /></Link><Link href="/methodology">Methodology <ArrowUpRight size={14} aria-hidden="true" /></Link><Link href="/data-sources">Data sources <ArrowUpRight size={14} aria-hidden="true" /></Link></nav>
  </div><div className="site-container tf-footer-note"><p>Public on-chain investigations, made understandable.</p><p>Starting on Base. Built to explore further.</p></div></footer>;
}
export function PageIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <section className="tf-page-intro"><div className="site-container"><Link href="/" className="tf-breadcrumb">TraceForge <span aria-hidden="true">/</span></Link><p className="tf-eyebrow">{eyebrow}</p><h1>{title}</h1><p className="tf-page-description">{description}</p></div></section>;
}