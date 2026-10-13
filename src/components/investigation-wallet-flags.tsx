import { ArrowUpRight } from "lucide-react";
import type { WalletDisplayFacts, WalletDisplayFlag } from "./investigation-wallet-facts";

export function walletFlagLabel(flag: WalletDisplayFlag): string {
  return flag.id === "source-reported-creator" ? "Creator" : flag.label;
}

/** Compact report vocabulary; each badge opens its actual basis and citations. */
export function InvestigationWalletFlags({ facts, onReveal }: { facts: WalletDisplayFacts; onReveal: (id: string) => void }) {
  const flags = facts.flags.filter((flag) => !["observed-mint", "early-window-accumulation", "verified-sale"].includes(flag.id));
  return flags.length ? <div className="flex flex-wrap items-start gap-x-2">{flags.map((flag) => <details key={flag.id} className="min-w-0" onToggle={(event) => {
    if (!event.currentTarget.open) return;
    const scroller = event.currentTarget.closest<HTMLElement>('[aria-label="Holder table"]');
    const body = event.currentTarget.querySelector<HTMLElement>("[data-flag-basis]");
    if (!scroller || !body) return;
    const box = body.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
    if (box.left < viewport.left + 12) scroller.scrollLeft -= viewport.left + 12 - box.left;
    else if (box.right > viewport.right - 12) scroller.scrollLeft += box.right - viewport.right + 12;
  }}>
    <summary title={flag.basis} className="flex min-h-11 cursor-pointer list-none items-center"><span className={flag.label === "sniper" ? "border border-foreground bg-foreground px-2 py-1 font-mono text-[11px] lowercase text-background" : "border border-border px-2 py-1 font-mono text-[11px] lowercase text-foreground"}>{walletFlagLabel(flag)}</span></summary>
    <div data-flag-basis className="w-56 max-w-64 pb-3 text-[11px] leading-6 text-muted"><p>{flag.basis}</p><div className="flex flex-wrap gap-x-3">{flag.evidenceIds.map((id, index) => <a key={id} href={`#evidence-${encodeURIComponent(id)}`} onClick={() => onReveal(id)} className="inline-flex min-h-11 items-center gap-1 text-accent underline underline-offset-4">Evidence {index + 1}<ArrowUpRight size={10} aria-hidden="true" /></a>)}{flag.sourceUrl && <a href={flag.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center gap-1 text-accent underline underline-offset-4">Source<ArrowUpRight size={10} aria-hidden="true" /></a>}</div></div>
  </details>)}</div> : <span className="text-muted" title="No supported wallet flag; unexamined flags remain unknown.">—</span>;
}
