import Link from "next/link";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/site-shell";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main-content">
        <PageIntro eyebrow="404 / NO TRAIL HERE" title="This page could not be found." description="The address may have changed. Return to TraceForce Engine to continue." />
        <section className="document-body">
          <div className="site-container"><Link href="/" className="button button-outline">Return to TraceForce Engine</Link></div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
