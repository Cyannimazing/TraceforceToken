import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { PageIntro, SiteFooter, SiteHeader } from "@/components/site-shell";
import { StructuredData } from "@/components/structured-data";
import { dataSources, dataSourcesReviewedAt } from "@/content/data-sources";
import { breadcrumbStructuredData, createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Data sources and verification",
  description: "TraceForce Engine’s Base data sources, adapter availability, official API documentation, known limits, and evidence verification requirements.",
  path: "/data-sources",
});

export default function DataSourcesPage() {
  return (
    <>
      <SiteHeader active="sources" />
      <main id="main-content">
        <PageIntro eyebrow="DATA SOURCES / BASE FIRST" title="Know where the evidence comes from." description="The adapters, provider plan, official documentation, and verification standards behind TraceForce Engine’s Base investigation pipeline." />
        <section className="document-body">
          <div className="site-container">
            <div className="prose">
              <div className="page-note"><strong>Availability is not a health check.</strong> RPC and indexed-history adapters are implemented. Their credentials, coverage, and live validation depend on the deployment. Documentation was reviewed on <time dateTime={dataSourcesReviewedAt}>12 October 2026</time>.</div>
              <h2>Different sources answer different questions.</h2>
              <p>Blockchain records support transaction facts. Indexers help find history. Listing APIs supply reported website links. TraceForce Engine calculates relationships from the acquired evidence and displays its coverage limits. Each source answers a different question; repeating a third-party claim does not verify it.</p>
            </div>
            <div className="source-list">
              {dataSources.map((source) => (
                <article className="source-card" key={source.id} id={source.id}>
                  <div className="source-card-heading">
                    <div><p className="eyebrow">{source.category}</p><h2>{source.name}</h2></div>
                    <span className="source-status">{source.status === "available" ? "Adapter available" : "Planned integration"}</span>
                  </div>
                  <p className="source-purpose">{source.purpose}</p>
                  <div className="source-detail-grid">
                    <div><h3>Data it provides</h3><ul>{source.dataProvided.map((item) => <li key={item}>{item}</li>)}</ul></div>
                    <div><h3>What needs verification</h3><ul>{source.verification.map((item) => <li key={item}>{item}</li>)}</ul></div>
                  </div>
                  <details className="source-limitations"><summary>Coverage and reliability limits</summary><ul>{source.limitations.map((item) => <li key={item}>{item}</li>)}</ul></details>
                  <div className="source-links"><a href={source.docsUrl} target="_blank" rel="noopener noreferrer">Official API documentation <ArrowUpRight size={15} aria-hidden="true" /></a><a href={source.officialUrl} target="_blank" rel="noopener noreferrer">Provider website <ArrowUpRight size={15} aria-hidden="true" /></a></div>
                </article>
              ))}
            </div>
            <div className="prose">
              <h2>Reliability comes from the pipeline.</h2>
              <p>Using established providers is only the starting point. Reports will need reproducible event identifiers, declared query windows, complete pagination or visible stopping limits, source timestamps, and receipt checks before findings can be treated as live evidence.</p>
              <Link className="document-action" href="/methodology">Read the investigation methodology <ArrowUpRight size={16} aria-hidden="true" /></Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
      <StructuredData value={breadcrumbStructuredData([{ name: "TraceForce Engine", path: "/" }, { name: "Data sources", path: "/data-sources" }])} />
    </>
  );
}
