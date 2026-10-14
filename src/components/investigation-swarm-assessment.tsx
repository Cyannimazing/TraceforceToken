import type { SwarmAssessmentSnapshot } from "@/domain/investigations/swarm-assessment";
import type { ReportAssessment } from "@/domain/investigations/report-assessment";
import { InvestigationPanel } from "./investigation-panel";
import type { InvestigationReport } from "@/domain/investigations/types";
import { swarmUnavailableReason } from "@/domain/investigations/primary-assessment";

/** Keep source prose readable without publishing raw identifiers or receipts. */
export function readableSwarmText(value: string): string {
  if (/balanceRaw|\braw (?:token )?units\b/i.test(value)) return "A source-reported holding check requires further verification.";
  return value.replace(/0x[0-9a-fA-F]{64}/g, "transaction reference").replace(/0x[0-9a-fA-F]{40}/g, (address) => `${address.slice(0, 6)}…${address.slice(-4)}`)
    .replace(/\breal hands\b/gi, "wallet groups").replace(/\bone hand\b/gi, "one wallet group").replace(/\bbiggest hand\b/gi, "biggest wallet group");
}

export function SwarmSourceTime({ snapshot }: { snapshot: SwarmAssessmentSnapshot }) {
  const scanned = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(snapshot.scannedAt));
  return <div className="space-y-1 text-xs leading-5 text-muted"><p>SWARM · <time dateTime={snapshot.scannedAt}>{scanned} UTC</time></p>{snapshot.transport?.freshness !== "source-window-verified" && <p className="text-warning">The result time could not be verified against this request.</p>}</div>;
}

export function SwarmUnavailable({ report }: { report: InvestigationReport }) {
  return <div className="mt-4 space-y-3" data-swarm-unavailable-reason={report.swarmAvailability?.reason ?? "unavailable"}><p className="text-xl font-semibold tracking-tight">SWARM assessment unavailable</p><p className="text-sm leading-6 text-muted">{swarmUnavailableReason(report.swarmAvailability?.reason)} Independent blockchain checks are shown below.</p><a href={`https://swarmengine.tech/t/base/${report.token.address}`} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center text-xs underline underline-offset-4">Open SWARM source</a></div>;
}

export function InvestigationIndependentChecks({ report, assessment }: { report: InvestigationReport; assessment: ReportAssessment }) {
  const balance = report.holderSnapshot?.balances;
  return <InvestigationPanel aria-label="Independent TraceForge checks" className="relative min-w-0 rounded-xl border border-border bg-surface/95 p-5" data-assessment-source="traceforge">
    <h2 className="text-base font-semibold tracking-tight">Independent TraceForge checks</h2><p className="mt-2 text-sm leading-6 text-muted">Separate blockchain observations collected through the configured RPC providers. These checks do not replace SWARM’s report.</p>
    <p className="mt-3 text-sm leading-6">{balance ? `${balance.verifiedWallets} of ${balance.requestedWallets} candidate balances checked.` : "Current holder balances could not be checked."} Funding examined for {report.coverage.examinedWallets} of {report.coverage.eligibleWallets} eligible addresses.</p>
    <p className="mt-1 text-xs leading-6 text-muted">Transfer coverage: {report.coverage.transfers.replace("_", " ")}. Unread balances and unexamined histories remain unknown.</p>
    <details className="mt-3 border-t border-border"><summary className="min-h-11 cursor-pointer content-center text-xs text-muted">Local check outcome</summary><p className="pb-3 text-xs leading-6 text-muted">TraceForge’s separate local assessment is {assessment.verdict}. {assessment.complete ? "All local categories were assessed." : "Local category checks are incomplete."} Its policy and observation time can differ from SWARM.</p></details>
  </InvestigationPanel>;
}

/** External assessment is attributed comparison context, never our report's verdict. */
export function InvestigationSwarmAssessment({ snapshot, assessment }: { snapshot: SwarmAssessmentSnapshot; assessment: ReportAssessment }) {
  const sameVerdict = snapshot.judge.decision === assessment.verdict;
  const scanned = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(snapshot.scannedAt));
  return <InvestigationPanel aria-label="External assessment" className="relative min-w-0 rounded-xl border border-border bg-surface/95 px-5">
    <details>
      <summary className="min-h-14 cursor-pointer content-center text-sm font-medium">External assessment · SWARM</summary>
      <div className="space-y-3 border-t border-border py-4 text-sm leading-6">
        <p>SWARM reported <strong>{snapshot.judge.decision}</strong>{snapshot.score === null ? "." : ` and a score of ${snapshot.score}/100.`}</p>
        <p className="text-muted">{sameVerdict ? "Both assessments reach the same verdict. Their checks and scan times can differ." : `TraceForge’s assessment is ${assessment.verdict}. The two services use different checks and scan times.`}</p>
        <p className="text-xs text-muted">Reported <time dateTime={snapshot.scannedAt}>{scanned} UTC</time>.</p>
        {snapshot.transport?.freshness !== "source-window-verified" && <p className="text-xs text-warning">SWARM’s result time could not be verified against this request.</p>}
        <a href={snapshot.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center text-xs underline underline-offset-4">View SWARM source</a>
      </div>
    </details>
  </InvestigationPanel>;
}
