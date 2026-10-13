"use client";

// Installed from Aceternity's moving-border registry; adapted for native typing,
// semantic colors, reduced motion and SVG attributes under the nonce CSP.
import { useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useAnimationFrame } from "motion/react";
import { cn } from "@/lib/utils";
import { useTraceMotion } from "./motion-preferences";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  containerClassName?: string;
  borderClassName?: string;
  duration?: number;
};

export function Button({ children, containerClassName, borderClassName, duration, className, type = "button", disabled, ...props }: ButtonProps) {
  return <button type={type} disabled={disabled} {...props} className={cn("group/moving relative isolate inline-flex min-h-11 overflow-hidden rounded-xl bg-border p-px text-sm disabled:cursor-not-allowed disabled:opacity-50", containerClassName)}>
    <span className="pointer-events-none absolute inset-0 rounded-[inherit]" aria-hidden="true"><MovingBorder duration={duration} paused={disabled} className={borderClassName} /></span>
    <span className={cn("relative flex min-h-11 w-full items-center justify-center gap-2 rounded-[inherit] border border-accent/20 bg-surface px-5 py-3 font-mono text-xs font-semibold text-foreground transition-colors group-hover/moving:bg-accent/10", className)}>{children}</span>
  </button>;
}

export function MovingBorder({ duration = 4500, paused = false, className }: { duration?: number; paused?: boolean; className?: string }) {
  const pathRef = useRef<SVGRectElement>(null);
  const dotRef = useRef<SVGGElement>(null);
  const { active } = useTraceMotion();
  const id = useId().replace(/:/g, "");
  useAnimationFrame((time) => {
    if (!active || paused || !pathRef.current || !dotRef.current) return;
    const length = pathRef.current.getTotalLength();
    if (!length) return;
    const point = pathRef.current.getPointAtLength((time * length / Math.max(1000, duration)) % length);
    dotRef.current.setAttribute("transform", `translate(${point.x} ${point.y})`);
  });
  return <svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" className={cn("absolute inset-0 size-full text-accent", className)} aria-hidden="true">
    <defs><radialGradient id={`moving-${id}`}><stop stopColor="currentColor" stopOpacity=".9" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient></defs>
    <rect ref={pathRef} x="1" y="1" width="99%" height="97%" rx="12" fill="none" />
    {active && !paused && <g ref={dotRef}><circle r="28" fill={`url(#moving-${id})`} /></g>}
  </svg>;
}
