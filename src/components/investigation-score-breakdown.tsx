import { ArrowUpRight } from "lucide-react";
import type { InvestigationReport } from "@/domain/investigations/types";
import type { ReportAssessment } from "@/domain/investigations/report-assessment";
import { InvestigationPanel } from "./investigation-panel";
import { derivePrimaryAssessment } from "@/domain/investigations/primary-assessment";
import { SWARM_CATEGORY_WEIGHTS } from "@/domain/investigations/swarm-assessment";
import { readableSwarmText } from "./investigation-swarm-assessment";

type Reveal = (id: string) => void;

/** Earned points summarize completed checks; missing observations remain unknown. */
export function InvestigationRuleBreakdown({ assessment, report, onReveal }: { assessment: ReportAssessment; report?: InvestigationReport; onReveal: Reveal }) {
  const primary = report ? derivePrimaryAssessment(report) : null;
  if (primary?.authority === "swarm") {
    if (primary.status !== "reported") return null;
    const snapshot = primary.snapshot;
    return <InvestigationPanel aria-label="Score breakdown" className="relative isolate min-w-0 overflow-hidden rounded-xl border border-border bg-surface/95 p-5" data-assessment-source="swarm">
      <h2 id="score-breakdown-title" className="text-sm font-medium">Score breakdown</h2>
      <p className="mt-2 text-xs text-muted">SWARM category points</p>
      <dl aria-label="Category scores" className="mt-3 text-xs">{(Object.keys(SWARM_CATEGORY_WEIGHTS) as (keyof typeof SWARM_CATEGORY_WEIGHTS)[]).map((id) => {
        const points = snapshot.parts[id], possible = SWARM_CATEGORY_WEIGHTS[id], width = points === null ? 0 : points / possible * 100;
        return <div key={id} data-category-id={id} data-score-points={points ?? undefined} data-assessment-status={points === null ? "not_reported" : "source_reported"} className="grid min-h-9 grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-3"><dt className="text-muted">{id}</dt><dd className="contents"><svg viewBox="0 0 100 6" preserveAspectRatio="none" className="h-1.5 w-full" aria-hidden="true"><rect width="100" height="6" rx="3" className="fill-border/65" />{width > 0 && <rect width={width} height="6" rx="3" className="fill-foreground" />}</svg><span aria-label={points === null ? `${id} not reported` : `${points} SWARM points out of ${possible}`} className="whitespace-nowrap text-right tabular-nums"><span className="font-semibold">{points ?? "—"}</span><span className="text-muted">/{possible}</span></span></dd></div>;
      })}</dl>
      {snapshot.gates.length > 0 && <section aria-label="SWARM reported warnings" className="mt-4 border-t border-border pt-4"><h3 className="text-xs font-semibold">Rules triggered</h3><ul className="mt-2 list-disc space-y-2 pl-4 text-xs leading-6">{snapshot.gates.map((gate, index) => <li key={`${index}-${gate}`}>{readableSwarmText(gate)}</li>)}</ul></section>}
      <p className="mt-3 text-xs leading-5 text-muted">Reported by SWARM. Missing category values remain unknown.</p>
    </InvestigationPanel>;
  }
  return <InvestigationPanel aria-label="Score breakdown" className="relative isolate min-w-0 overflow-hidden rounded-xl border border-border bg-surface/95 p-5">
    <h2 id="score-breakdown-title" className="text-sm font-medium">Score breakdown</h2>
    <dl aria-label="Category scores" className="mt-3 text-xs">{assessment.categories.map((category) => {
      const width = category.points === null || category.possiblePoints <= 0 ? 0 : Math.max(0, Math.min(100, category.points / category.possiblePoints * 100));
      return <div key={category.id} data-category-id={category.id} data-score-points={category.points ?? 0} data-assessment-status={category.status} className="grid min-h-9 grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-3">
        <dt className="text-muted lowercase">{category.label}</dt>
        <dd className="contents"><svg viewBox="0 0 100 6" preserveAspectRatio="none" className="h-1.5 w-full" aria-hidden="true"><rect width="100" height="6" rx="3" className="fill-border/65" />{width > 0 && <rect width={width} height="6" rx="3" className="fill-foreground" />}</svg><span aria-label={`${category.points ?? 0} earned points out of ${category.possiblePoints}, ${category.status === "not_assessed" ? "unassessed" : category.status === "concern" ? "warning triggered" : "measured"}`} className="whitespace-nowrap text-right tabular-nums"><span className="font-semibold">{category.points ?? 0}</span><span className="text-muted">/{category.possiblePoints}</span></span></dd>
      </div>;
    })}</dl>
    {!assessment.complete && <p className="mt-3 text-xs leading-5 text-muted">Some checks are incomplete. Unchecked categories earn no points.</p>}
    <details className="mt-3 border-t border-border" data-score-details="true">
      <summary className="min-h-11 cursor-pointer content-center text-xs text-muted">What was checked</summary>
      <ul className="divide-y divide-border">{assessment.categories.map((category) => <li key={category.id} data-category-details={category.id} className="py-3">
        <h3 className="text-sm font-medium">{category.label}</h3>
        <p className="mt-1 text-xs leading-6 text-muted">{category.metric ?? "This check could not be completed."}</p>
        <p className="text-xs leading-6 text-muted">{category.status === "not_assessed" ? "Not fully assessed; the result remains unknown." : category.status === "concern" ? "A warning was established by the available evidence." : "Assessed from the available evidence."}</p>
      </li>)}</ul>
      {assessment.triggeredRules.length > 0 && <section aria-label="Rule evidence" className="border-t border-border py-3"><h3 className="text-sm font-medium">Evidence behind the warnings</h3><ul className="divide-y divide-border">{assessment.triggeredRules.map((rule) => <li key={rule.id} className="py-3">
        <h4 className="text-xs leading-6">{rule.label}</h4>
        <div className="flex flex-wrap gap-x-4">{rule.evidenceIds.map((id, index) => <a key={id} href={`#evidence-${encodeURIComponent(id)}`} onClick={() => onReveal(id)} className="inline-flex min-h-11 items-center gap-1 text-xs underline underline-offset-4">Evidence {index + 1}<ArrowUpRight size={11} aria-hidden="true" /></a>)}</div>
      </li>)}</ul></section>}
    </details>
  </InvestigationPanel>;
}
