"use client";

import { Pause, Play } from "lucide-react";
import { useTraceMotion } from "./ui/motion-preferences";

export function VisualEffectsToggle() {
  const { paused, reduced, toggle } = useTraceMotion();
  return <button type="button" onClick={toggle} disabled={reduced} aria-label={paused ? "Resume visual effects" : "Pause visual effects"} aria-pressed={paused} title={reduced ? "Visual effects follow your reduced-motion preference" : paused ? "Resume visual effects" : "Pause visual effects"} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-border px-3 text-xs text-muted transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-default disabled:opacity-60">{paused || reduced ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}<span className="hidden xl:inline">Effects</span></button>;
}
