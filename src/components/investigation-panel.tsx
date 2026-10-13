import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
/** Shared semantic panel; report density and borders are scoped by the report shell. */
export function InvestigationPanel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={cn("traceforce-panel relative isolate block min-w-0 rounded-sm border border-border bg-surface", className)} />;
}
