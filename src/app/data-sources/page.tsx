import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/site-shell";
import { StructuredData } from "@/components/structured-data";
import { dataSources, dataSourcesReviewedAt, type DataSource } from "@/content/data-sources";
import { breadcrumbStructuredData, createMetadata } from "@/lib/seo";
import "@/components/traceforge-pages.css";

export const metadata = createMetadata({ title: "Data sources and verification", description: "Explore TraceForge’s Base data sources, their roles, API documentation, access requirements and the checks that keep provider claims separate from chain evidence.", path: "/data-sources" });

const optionalSources: DataSource[] = [
  { id: "swarm", name: "SWARM", category: "Indexed history", status: "available", purpose: "Provide the main report’s source-reported score, verdict, market context, grouped bubbles and holder rows from one fresh-request assessment.",
    dataProvided: ["Source-reported category scores, verdict weights and decision reasons", "Market figures, reported holder total, examined cohort and inferred wallet groups"],
    verification: ["Check Base/token identity, response bounds and source timing; disclose any unverified freshness.", "Keep all main assessment figures tied to the same SWARM snapshot. Model weights are not measured outcome probabilities.", "Alchemy and Base RPC separately verify supported blockchain observations; their counts and local rules do not overwrite the main source result."],
    limitations: ["Availability and scan limits belong to the provider. External scans are subject to SWARM’s own storage/privacy policy.", "A source assessment is not complete raw transaction evidence or a verified owner census."],
    officialUrl: "https://swarmengine.tech/", docsUrl: "https://swarmengine.tech/docs" },
  { id: "bubblemaps", name: "Bubblemaps", category: "Indexed history", status: "available", purpose: "Optionally add source-reported holder candidates, intermediary addresses and transfer relationships.",
    dataProvided: ["Base holder and contextual address candidates", "Reported transfer relationships and basic labels"],
    verification: ["Verify candidate balances at the declared chain snapshot before treating them as report holdings.", "Retain source attribution and source computation time. A relationship is an investigation lead."],
    limitations: ["Requires an operator API key and suitable integration terms. No configured key means this source is not queried.", "Indexed numerical balances are not used as exact blockchain amounts. Undocumented share units are not assumed."],
    officialUrl: "https://bubblemaps.io/", docsUrl: "https://github.com/bubblemaps/api-docs/blob/main/openapi.json" },
  { id: "nansen", name: "Nansen", category: "Indexed history", status: "available", purpose: "Optionally add basic individual-holder candidates and reported labels, with clear source attribution.",
    dataProvided: ["Bounded basic all-holder data on Base", "Reported non-premium labels and percentages, kept separate from pinned evidence"],
    verification: ["Use individual holders, disable premium labels and omit Smart Money filters.", "Verify candidate blockchain state separately and preserve visible stopping limits."],
    limitations: ["Requires configured API access. Redistribution rules vary by endpoint.", "Restricted Smart Money datasets and prohibited leaderboards are not part of this integration.", "The response’s retrieval time is not proof of its underlying index freshness."],
    officialUrl: "https://www.nansen.ai/", docsUrl: "https://docs.nansen.ai/guides/redistribution-guide" },
  { id: "arkham", name: "Arkham", category: "Indexed history", status: "planned", purpose: "A possible future source of entity labels and fund-flow context.",
    dataProvided: ["Potential entity and address attribution through licensed API access"],
    verification: ["Obtain explicit rights for the intended public analytics use before enabling any requests.", "Keep attribution confidence and original source identifiable."],
    limitations: ["No enabled provider calls. Access and redistribution rights are required first.", "An entity label is an evolving attribution, not proof of human identity."],
    officialUrl: "https://arkm.com/", docsUrl: "https://arkm.com/docs" },
  { id: "rugcheck", name: "RugCheck", category: "Indexed history", status: "planned", purpose: "A reference for structured token-security reporting, outside the confirmed Base integration.",
    dataProvided: ["No RugCheck data is acquired for the current Base pipeline"],
    verification: ["Confirm chain coverage and access before a future integration."],
    limitations: ["Base support is not documented in the reviewed public specification. The adapter makes no Base requests."],
    officialUrl: "https://rugcheck.xyz/", docsUrl: "https://api.rugcheck.xyz/swagger/index.html" },
];
const sources = [...dataSources, ...optionalSources.filter((source) => !dataSources.some((existing) => existing.id === source.id))];
function availability(source: DataSource) {
  if (source.id === "arkham") return "Permission required";
  if (source.id === "rugcheck") return "Base support unconfirmed";
  if (source.id === "sqd-portal") return "Local testing";
  if (source.id === "bubblemaps" || source.id === "nansen") return "Optional · API access required";
  return source.status === "available" ? "Adapter available" : "Planned integration";
}

export default function DataSourcesPage() {
  return <div className="tf-public tf-doc"><SiteHeader active="sources" /><main id="main-content">
    <section className="tf-container tf-document-hero"><p className="tf-eyebrow"><span className="tf-mini-square" />THE DATA SOURCES</p><h1>Know the source.<br /><em>Follow the evidence.</em></h1><p>Different sources answer different questions.<br />Every claim should keep its origin.</p><span className="tf-document-motif" aria-hidden="true"><span /><span /><span /><span /></span></section>
    <section className="document-body tf-document-body"><div className="tf-container tf-doc-spread">
      <aside className="tf-doc-sidebar"><p className="tf-eyebrow">THE SOURCE INDEX</p><nav aria-label="Data source sections">{sources.map((source) => <a key={source.id} href={"#" + source.id}>{source.name}<ArrowRight size={14} aria-hidden="true" /></a>)}</nav><p>Source availability depends on<br />the deployment and access.</p></aside>
      <div className="tf-doc-content">
        <div className="tf-source-introduction"><h2>A source is the start.<br />Verification is the work.</h2><p>SWARM supplies the main reported assessment, graph, holder cohort and market context. Alchemy discovers activity, and Base RPC verifies supported transaction facts and balances separately. Independent findings retain their evidence and snapshot; missing SWARM data remains unavailable rather than borrowing a local score.</p><div className="tf-inline-note"><span className="tf-mini-square" /><p>“Adapter available” describes implementation, not a live health check. Credentials, limits and coverage still depend on the deployment.</p></div><p className="tf-review-date">Core source documentation reviewed <time dateTime={dataSourcesReviewedAt}>{new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(dataSourcesReviewedAt))}</time>.</p></div>
        <div className="tf-source-list">{sources.map((source, index) => <article className="source-card tf-source-card" key={source.id} id={source.id}>
          <div className="tf-source-heading"><span className="tf-source-number">{String(index + 1).padStart(2, "0")}</span><div><p className="tf-eyebrow">{source.category}</p><h2>{source.name}</h2></div><span className="tf-source-status">{availability(source)}</span></div>
          <p className="source-purpose">{source.purpose}</p>
          <details className="tf-details tf-source-details"><summary>Data, verification &amp; limits</summary><div className="tf-source-detail-grid"><div><h3>What it supplies</h3><ul>{source.dataProvided.map((item) => <li key={item}>{item}</li>)}</ul></div><div><h3>What we check</h3><ul>{source.verification.map((item) => <li key={item}>{item}</li>)}</ul></div></div><div className="tf-source-limits"><h3>Coverage and access</h3><ul>{source.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div></details>
          <div className="tf-source-links"><a className="tf-text-link" href={source.docsUrl} target="_blank" rel="noopener noreferrer" aria-label={source.name + " official documentation"}>Official documentation <ArrowUpRight size={15} aria-hidden="true" /></a><a className="tf-text-link" href={source.officialUrl} target="_blank" rel="noopener noreferrer" aria-label={source.name + " website"}>Provider website <ArrowUpRight size={15} aria-hidden="true" /></a></div>
        </article>)}</div>
      </div>
    </div></section>
    <section className="tf-container tf-document-next"><p className="tf-eyebrow">HOW IT COMES TOGETHER</p><Link href="/methodology">Inside the investigation.<ArrowUpRight size={30} strokeWidth={1.2} aria-hidden="true" /></Link></section>
  </main><SiteFooter /><StructuredData value={breadcrumbStructuredData([{ name: "TraceForge", path: "/" }, { name: "Data sources", path: "/data-sources" }])} /></div>;
}
