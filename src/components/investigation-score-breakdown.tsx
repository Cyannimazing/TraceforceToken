import { ArrowUpRight } from "lucide-react";
import type { InvestigationReport } from "@/domain/investigations/types";
import type { ReportAssessment } from "@/domain/investigations/report-assessment";
import { deriveCreatorAttribution } from "@/domain/investigations/creator-attribution";
import { InvestigationPanel } from "./investigation-panel";

type Reveal = (id: string) => void;

function Citations({ ids, onReveal }: { ids: string[]; onReveal: Reveal }) {
  return <div className="flex flex-wrap gap-x-4">{ids.map((id, index) => <a key={id} href={`#evidence-${encodeURIComponent(id)}`} onClick={() => onReveal(id)} className="inline-flex min-h-11 items-center gap-1 font-mono text-[10px] underline decoration-border underline-offset-4">Evidence {index + 1}<ArrowUpRight size={11} aria-hidden="true" /></a>)}</div>;
}

/** Zero earned credits do not turn an unassessed observation into an absent finding. */
export function InvestigationRuleBreakdown({ assessment, report, onReveal }: { assessment: ReportAssessment; report?: InvestigationReport; onReveal: Reveal }) {
  const creator = report ? deriveCreatorAttribution(report) : null;
  const walletGates = assessment.gates.filter((gate) => !gate.id.startsWith("contract-"));
  const gates = walletGates.some((gate) => gate.severity === "hard") ? walletGates : assessment.gates;
  const rules = gates.length ? gates : assessment.triggeredRules;

  return <InvestigationPanel aria-label="Score breakdown" className="relative isolate min-w-0 overflow-hidden rounded-xl border border-border bg-surface/95 p-5">
    <h2 id="score-breakdown-title" className="font-mono text-xs font-semibold tracking-wider"><span aria-hidden="true" className="text-muted">{"// "}</span>SCORE</h2>
    <dl aria-label="Category scores" className="mt-3 font-mono text-xs">{assessment.categories.map((category) => {
      const width = category.points === null || category.possiblePoints <= 0 ? 0 : Math.max(0, Math.min(100, category.points / category.possiblePoints * 100));
      return <div key={category.id} data-category-id={category.id} data-score-points={category.points ?? 0} data-assessment-status={category.status} className="grid min-h-8 grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-3">
        <dt className="text-muted lowercase">{category.label}</dt>
        <dd className="contents"><svg viewBox="0 0 100 6" preserveAspectRatio="none" className="h-1.5 w-full" aria-hidden="true"><rect width="100" height="6" rx="3" className="fill-border/65" />{width > 0 && <rect width={width} height="6" rx="3" className="fill-foreground" />}</svg><span aria-label={`${category.points ?? 0} earned points out of ${category.possiblePoints}, ${category.status === "not_assessed" ? "unassessed" : category.status === "concern" ? "warning triggered" : "measured"}`} className="whitespace-nowrap text-right tabular-nums"><span className="font-semibold">{category.points ?? 0}</span><span className="text-muted">/{category.possiblePoints}</span></span></dd>
      </div>;
    })}</dl>

    <section aria-label="Triggered rules" className="mt-4">
      <h3 id="triggered-rules-title" className="font-mono text-[11px] font-semibold uppercase tracking-wider">RULES TRIGGERED</h3>
      {rules.length ? <ul className="mt-2 list-disc space-y-1 pl-3 font-mono text-[11px] leading-5 marker:text-muted">{rules.map((rule) => <li key={rule.id}>{rule.label}</li>)}</ul> : <p className="mt-2 text-xs leading-5 text-muted">No supported rule triggered</p>}
    </section>

    <details className="mt-3 border-t border-border" data-score-details="true">
      <summary className="min-h-11 cursor-pointer content-center font-mono text-[10px] text-muted">Details</summary>
      <p className="pb-3 text-xs leading-6 text-muted">Points earned from assessed evidence. Unassessed categories earn 0; this does not establish that a risk is absent. {assessment.assessedPossiblePoints}/100 weighted points assessed.</p>
      <ul className="divide-y divide-border">{assessment.categories.map((category) => <li key={category.id} data-category-details={category.id} className="py-3">
        <h3 className="font-mono text-xs font-semibold">{category.label}</h3>
        <p className="mt-1 text-xs leading-6">{category.metric ?? (category.id === "dev" ? creator ? "Creator holding unknown" : "Creator not confirmed" : category.status === "concern" ? "Warning observed" : "Not assessed")}</p>
        <p className="font-mono text-[11px] leading-6 text-muted">Earned points: {category.points ?? 0}/{category.possiblePoints} · {category.status === "not_assessed" ? "not assessed" : category.status === "concern" ? "warning triggered" : "measured"}</p>
        {category.points === null && <p className="text-xs leading-6 text-muted">{category.metric !== null ? "Measurement available; numeric score not established." : "Measurement unavailable in this report."}</p>}
        {category.id === "dev" && category.metric === null && <p className="text-xs leading-6 text-muted">{creator ? creator.kind === "direct-contract-creation" ? "The deploying address was verified from its creation transaction, but its pinned holding could not be established." : "A creator address was source-reported, but its pinned holding could not be established." : "No creation transaction or usable creator attribution was retained. This does not establish that the token has no creator."}</p>}
        <p className="text-xs leading-6 text-muted">{category.basis}</p>
        {category.limitations.map((limit) => <p key={limit} className="text-xs leading-6 text-muted">{limit}</p>)}
      </li>)}</ul>
      {assessment.triggeredRules.length > 0 && <section aria-label="Rule evidence" className="border-t border-border py-3"><h3 className="font-mono text-xs font-semibold">Rule evidence</h3><ul className="divide-y divide-border">{assessment.triggeredRules.map((rule) => <li key={rule.id} className="py-3">
        <div className="flex items-start justify-between gap-3"><h4 className="text-xs font-medium leading-6">{rule.label}</h4><span aria-label={rule.deductedPoints > 0 ? `${rule.deductedPoints} points deducted` : "Review without point deduction"} className="shrink-0 whitespace-nowrap font-mono text-[10px] leading-6 text-muted">{rule.deductedPoints > 0 ? `−${rule.deductedPoints}` : "Review"}</span></div>
        <p className="text-xs leading-6 text-muted">{rule.basis}</p>
        {rule.holderBlock && <p className="mt-2 break-all font-mono text-[10px] leading-5 text-muted">BLOCK {rule.holderBlock.number}<br />{rule.holderBlock.hash}</p>}
        <Citations ids={rule.evidenceIds} onReveal={onReveal} />
      </li>)}</ul></section>}
      {assessment.gates.length > 0 && <section aria-label="Warning evidence" className="border-t border-border py-3"><h3 className="font-mono text-xs font-semibold">Warning evidence</h3><ul className="divide-y divide-border">{assessment.gates.map((gate) => <li key={gate.id} className="py-3">
        <h4 className="text-xs font-medium leading-6">{gate.label}</h4><p className="text-xs leading-6 text-muted">{gate.basis}</p>
        <Citations ids={gate.evidenceIds} onReveal={onReveal} />
        {gate.sourceUrl && <a href={gate.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-[11px] underline underline-offset-4">Inspect source<ArrowUpRight size={11} aria-hidden="true" /></a>}
      </li>)}</ul></section>}
      <section aria-label="Assessment scope" className="border-t border-border py-3"><h3 className="font-mono text-xs font-semibold">Assessment scope</h3><ul className="mt-2 space-y-2 text-xs leading-6 text-muted">{assessment.limitations.map((limit) => <li key={limit}>{limit}</li>)}</ul></section>
    </details>
  </InvestigationPanel>;
}
