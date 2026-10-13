import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/site-shell";
import { StructuredData } from "@/components/structured-data";
import { breadcrumbStructuredData, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Investigation methodology",
  description: "How TraceForce Engine will connect token funding, wallet relationships, accumulation, and selling to verifiable on-chain evidence and explicit coverage limits.",
  path: "/methodology",
});

const questions = [
  { title: "Who funded the wallets?", text: "Trace observed native-asset funding to its source transaction. A bounded history supports first observed funding; lifetime-first funding requires complete eligible history. Exchange, bridge, and service hubs need separate treatment." },
  { title: "Which wallets are connected?", text: "Build associations from identifiable funding and direct-transfer evidence. Shared timing alone will not merge wallets. A connection describes observed activity, not a verified common owner." },
  { title: "Who accumulated early?", text: "Compare net acquisitions against a supported launch reference and the period examined. A pool creation time is a market observation. When launch history is missing, describe activity as early in the observed window." },
  { title: "What suggests coordinated selling?", text: "Establish relationships before the exits, verify supported swaps and net token flows, then examine multiple linked sellers in a declared time window. A transfer into a pool, or simultaneous activity alone, does not prove a coordinated sale." },
];

export default function MethodologyPage() {
  return (
    <>
      <SiteHeader active="methodology" />
      <main id="main-content">
        <PageIntro eyebrow="METHODOLOGY / EVIDENCE FIRST" title="A story you can trace back to its source." description="The investigation engine is in development. These are the evidence standards that will guide the first Base implementation." />
        <section className="document-body">
          <div className="site-container">
            <div className="prose">
              <h2>Four questions. One traceable record.</h2>
              <p>Every finding should link to the chain, block hash, transaction, log or trace position, provider observation, and rule version that produced it. Facts, inferred associations, and unknowns will remain distinct.</p>
            </div>
            <div className="content-grid methodology-grid">
              {questions.map((question, index) => (
                <article className="content-card prose" key={question.title}>
                  <p className="eyebrow">QUESTION {String(index + 1).padStart(2, "0")}</p>
                  <h3>{question.title}</h3>
                  <p>{question.text}</p>
                </article>
              ))}
            </div>
            <div className="prose">
              <h2>Coverage belongs in the finding.</h2>
              <p>A report will state the blocks and time range examined, wallets checked, query limits, indexing lag, and failed sources. Missing data is unknown. Partial transfer history cannot silently become a current-balance claim.</p>
              <h2>Recent history can change.</h2>
              <p>Base transactions have different confirmation and finality stages. Ingestion will retain block hashes, recheck recent blocks, and invalidate affected evidence after a reorganization. Reports will disclose the confirmation policy used.</p>
              <p><a href="https://docs.base.org/specifications/transactions/transaction-finality" target="_blank" rel="noopener noreferrer">Read Base’s transaction finality documentation <ArrowUpRight size={14} aria-hidden="true" /></a></p>
              <h2>Validation before live claims.</h2>
              <p>Every submission collects fresh data through bounded RPC and indexed-history adapters, then runs deterministic analysis and prepares a plain English explanation. Reports and evidence are not stored as server history. You can explicitly save a snapshot in your own browser or download its JSON; opening a browser snapshot does not run a new crawl. Questions use the current report and disclose when fresh data is needed. Fixtures test exact amounts, coverage limits, hub exclusions, failed sources, conflicting block hashes, and supported swap flows. Comprehensive live detection benchmarks remain a release requirement.</p>
              <div className="page-note"><strong>Designed for investigation.</strong> The goal is to make the evidence reviewable. A relationship is not an identity, and an analytical finding does not guarantee what a token will do next.</div>
              <Link className="document-action" href="/data-sources">Review the planned data sources <ArrowUpRight size={16} aria-hidden="true" /></Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
      <StructuredData value={breadcrumbStructuredData([{ name: "TraceForce Engine", path: "/" }, { name: "Methodology", path: "/methodology" }])} />
    </>
  );
}
