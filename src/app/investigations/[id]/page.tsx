import Link from "next/link";
import { ArrowUpRight, FolderOpen } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import type { Metadata } from "next";
import "@/components/traceforge-pages.css";

export const metadata: Metadata = { title: { absolute: "No server report history | TraceForge" }, description: "Start a fresh investigation or open a snapshot saved in your own browser. TraceForge reports are not stored at a server address.", robots: { index: false, follow: false } };

export default function InvestigationPage() {
  return <div className="tf-public"><SiteHeader /><main id="main-content" className="tf-container tf-empty-page tf-snapshot-page">
    <div className="tf-snapshot-symbol" aria-hidden="true"><FolderOpen size={42} strokeWidth={1} /><span /><span /><span /></div><p className="tf-eyebrow">YOUR REPORT / YOUR BROWSER</p><h1>Reports stay<br /><em>with you.</em></h1><p>There is no saved report at this server address.<br />Open a snapshot you saved in this browser, or start a fresh investigation.</p><Link href="/investigate" className="tf-button tf-button-primary">Open investigations <ArrowUpRight size={18} aria-hidden="true" /></Link><p className="tf-empty-footnote">Each snapshot keeps its original scan time. A new investigation collects fresh data.</p>
  </main><SiteFooter /></div>;
}
