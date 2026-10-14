import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import type { Metadata } from "next";
import "@/components/traceforge-pages.css";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

export default function NotFound() {
  return <div className="tf-public"><SiteHeader /><main id="main-content" className="tf-container tf-empty-page">
    <div className="tf-empty-art" aria-hidden="true"><span>4</span><span className="tf-empty-node" /><span>4</span></div>
    <p className="tf-eyebrow">404 / NO TRAIL HERE</p><h1>An uncharted<br /><em>address.</em></h1><p>We couldn’t find this page.<br />There are plenty of other trails to follow.</p><div className="tf-actions"><Link href="/" className="tf-button tf-button-primary"><ArrowLeft size={17} aria-hidden="true" />Return home</Link><Link href="/investigate" className="tf-text-link">Investigate a token <ArrowUpRight size={17} aria-hidden="true" /></Link></div>
  </main><SiteFooter /></div>;
}
