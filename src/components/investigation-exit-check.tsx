import type { InvestigationReport } from "@/domain/investigations/types";
import { tokenAmount } from "./investigation-amounts";

/** Keep an actual protocol quote separate from the assessment's hypothetical price scenario. */
export function InvestigationExitCheck({ report }: { report: InvestigationReport }) {
  const quote = report.exitQuote;
  if (!quote) return null;
  const quoted = quote.status === "quoted";
  const wrappedEth = quote.quoteAsset === "0x4200000000000000000000000000000000000006";
  const output = quoted && wrappedEth ? `${tokenAmount(quote.amountOutRaw!, 18)} WETH` : null;
  return <section aria-labelledby="exit-check-title" className="min-w-0 border border-border bg-surface p-5" data-exit-quote-status={quote.status}>
    <h2 id="exit-check-title" className="text-sm font-medium">Exit check</h2>
    <p className="mt-3 text-sm leading-6">{quoted ? "A swap quote was returned for the largest checked wallet’s holding in the selected pool." : quote.status === "unsupported" ? "This pool’s trading rules are not supported by the exit check yet." : "An exit quote could not be verified for this scan."}</p>
    {output && <p className="mt-2 text-lg font-semibold" data-quote-output-raw={quote.amountOutRaw}>Quoted output: {output}</p>}
    <p className="mt-2 text-xs leading-6 text-muted">{quoted ? "The simulation includes the pool’s swap fee at the report time. Taxes, wallet restrictions and transaction costs were not checked. It does not establish that the wallet can sell." : "No selling price or successful sale is inferred from this result."}</p>
    {quoted && quote.inputConsumption === "not-proven" && <p className="mt-2 text-xs leading-6 text-muted">This pool can stop a quote at its price boundary. The response does not confirm that the entire holding was exchanged.</p>}
    {quote.pool && <a className="mt-2 inline-flex min-h-11 items-center text-xs underline underline-offset-4" href={`https://basescan.org/address/${quote.pool}`} target="_blank" rel="noopener noreferrer nofollow">Inspect the selected pool</a>}
  </section>;
}
