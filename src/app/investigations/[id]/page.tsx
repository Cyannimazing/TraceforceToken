import Link from "next/link";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/site-shell";
import type { Metadata } from "next";

export const metadata: Metadata = { title: { absolute: "No server report history | TraceForce Engine" }, description: "Start a fresh investigation or open an optional snapshot saved in your own browser. Reports are not stored at a server address.", robots: { index: false, follow: false } };

export default function InvestigationPage() {
  return <><SiteHeader /><main id="main-content"><PageIntro eyebrow="INVESTIGATION / NO SERVER HISTORY" title="Reports stay with you." description="Each fresh investigation displays its result on the page where you started it. Reports are not stored at a server address." /><section className="document-body"><div className="site-container"><div className="max-w-3xl rounded border border-paper-line bg-light p-6 sm:p-9"><p className="text-sm leading-7 text-ink-muted">There is no saved report or investigation history at this address. The investigation page lets you start a fresh crawl or open a snapshot you explicitly saved in this browser.</p><Link href="/investigate" className="mt-5 inline-flex min-h-12 items-center rounded bg-dark px-5 text-sm font-semibold text-warm-white">Start a fresh investigation →</Link></div></div></section></main><SiteFooter /></>;
}
