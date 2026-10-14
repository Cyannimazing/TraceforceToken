import { InvestigationWorkbench } from "@/components/investigation-workbench";
import { InvestigationHeader } from "@/components/site-shell";
import { createMetadata } from "@/lib/seo";
import Link from "next/link";

export const metadata = createMetadata({ title: "Investigate a Base token", description: "Run a fresh Base token investigation, inspect its evidence and ask questions. Save optional snapshots in your own browser. No sign-in required.", path: "/investigate", noIndex: true });

export default async function InvestigatePage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const requested = (await searchParams).token;
  const initialToken = typeof requested === "string" && /^0x[0-9a-fA-F]{40}$/.test(requested) ? requested.toLowerCase() : "";
  return <div className="engine-shell"><InvestigationHeader /><main id="main-content" className="engine-container py-6 sm:py-9"><InvestigationWorkbench initialToken={initialToken} /></main><footer className="engine-container mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border py-6 text-xs leading-6 text-muted"><p>TraceForge <span className="px-2 text-accent" aria-hidden="true">/</span> Follow the evidence.</p><nav aria-label="Investigation footer" className="flex flex-wrap gap-5"><Link href="/methodology" className="inline-flex min-h-11 items-center hover:text-accent">Methodology</Link><Link href="/data-sources" className="inline-flex min-h-11 items-center hover:text-accent">Data sources</Link><span className="inline-flex min-h-11 items-center font-mono text-[10px] tracking-wider">BASE</span></nav></footer></div>;
}
