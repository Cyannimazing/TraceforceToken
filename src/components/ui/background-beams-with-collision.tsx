"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useTraceMotion } from "@/components/ui/motion-preferences";

/**
 * Installed from Aceternity's background-beams-with-collision registry.
 * Retains its moving-beam → collision → explosion sequence, using explicit
 * SVG geometry instead of HTML transforms, layout polling or reset timers.
 * Original source/provenance: .artifacts/aceternity/ and docs/ui-components.md.
 */
type Beam = { x: number; y: number; duration: number; offset: number; color: string };
const HERO_BEAMS: readonly Beam[] = [
  { x: 474, y: 104, duration: 5.2, offset: 0, color: "var(--accent)" },
  { x: 536, y: 200, duration: 6.1, offset: 2.1, color: "var(--signal-secondary)" },
  { x: 468, y: 300, duration: 5.7, offset: 3.8, color: "var(--accent)" },
];
const COMPACT_BEAMS: readonly Beam[] = [
  { x: 562, y: 174, duration: 5.4, offset: 0, color: "var(--accent)" },
  { x: 528, y: 230, duration: 6.3, offset: 2.8, color: "var(--signal-secondary)" },
];
const PARTICLES = 6;
const SOURCE = { x: 91, y: 200 };

export interface BackgroundBeamsWithCollisionProps {
  children?: ReactNode;
  className?: string;
  compact?: boolean;
  active?: boolean;
}

export function BackgroundBeamsWithCollision({
  children,
  className,
  compact = false,
  active = true,
}: BackgroundBeamsWithCollisionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const heads = useRef<(SVGCircleElement | null)[]>([]);
  const streaks = useRef<(SVGLineElement | null)[]>([]);
  const impacts = useRef<(SVGCircleElement | null)[]>([]);
  const particles = useRef<(SVGCircleElement | null)[][]>([]);
  const elapsed = useRef(0);
  const instance = useId().replace(/:/g, "");
  const [inView, setInView] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(true);
  const motion = useTraceMotion();
  const running = active && motion.active && inView && documentVisible;
  const beams = compact ? COMPACT_BEAMS : HERO_BEAMS;

  useEffect(() => {
    const visibilityChanged = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibilityChanged);
    const element = containerRef.current;
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0 },
    );
    if (element) observer?.observe(element);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!running || document.hidden) return;
    let frame = 0;
    let previous: number | undefined;
    const render = (now: number) => {
      // Resume the same scene without jumping through missed collisions.
      if (previous !== undefined) elapsed.current += Math.min(now - previous, 50);
      previous = now;
      const seconds = elapsed.current / 1000;
      beams.forEach((beam, index) => {
        const phase = ((seconds + beam.offset) % beam.duration) / beam.duration;
        const travel = Math.min(phase / 0.78, 1);
        const trail = Math.max(0, travel - 0.15);
        const x = SOURCE.x + (beam.x - SOURCE.x) * travel;
        const y = SOURCE.y + (beam.y - SOURCE.y) * travel;
        const head = heads.current[index];
        head?.setAttribute("cx", x.toFixed(2));
        head?.setAttribute("cy", y.toFixed(2));
        head?.setAttribute("opacity", phase < 0.78 ? "1" : "0");
        const streak = streaks.current[index];
        streak?.setAttribute("x1", (SOURCE.x + (beam.x - SOURCE.x) * trail).toFixed(2));
        streak?.setAttribute("y1", (SOURCE.y + (beam.y - SOURCE.y) * trail).toFixed(2));
        streak?.setAttribute("x2", x.toFixed(2));
        streak?.setAttribute("y2", y.toFixed(2));
        streak?.setAttribute("opacity", phase < 0.78 ? "0.95" : "0");
        const burst = Math.max(0, (phase - 0.78) / 0.22);
        const strength = phase >= 0.78 ? (1 - burst) * 0.8 : 0;
        const impact = impacts.current[index];
        impact?.setAttribute("r", (8 + burst * 29).toFixed(2));
        impact?.setAttribute("opacity", strength.toFixed(3));
        for (let particle = 0; particle < PARTICLES; particle++) {
          const angle = particle / PARTICLES * Math.PI * 2 + index * 0.35;
          const distance = 9 + burst * (25 + particle % 3 * 7);
          const dot = particles.current[index]?.[particle];
          dot?.setAttribute("cx", (beam.x + Math.cos(angle) * distance).toFixed(2));
          dot?.setAttribute("cy", (beam.y + Math.sin(angle) * distance).toFixed(2));
          dot?.setAttribute("opacity", strength.toFixed(3));
        }
      });
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [running, beams]);

  return (
    <div
      ref={containerRef}
      data-aceternity="background-beams-with-collision"
      data-motion={running ? "running" : "paused"}
      data-variant={compact ? "compact" : "hero"}
      className={cn(
        compact ? "pointer-events-none absolute inset-0 overflow-hidden" : "relative isolate h-[25rem] w-full overflow-hidden",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 600 400"
        fill="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
        preserveAspectRatio={compact ? "none" : "xMidYMid meet"}
      >
        <defs>
          <filter id={`laser-glow-${instance}`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <radialGradient id={`laser-field-${instance}`}>
            <stop stopColor="var(--accent)" stopOpacity="0.13" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {!compact && <>
          <ellipse cx="298" cy="200" rx="270" ry="170" fill={`url(#laser-field-${instance})`} />
          <path d="M28 64h90l22 22h116m-228 250h90l22-22h116M344 56h184l44 44v58M344 344h184l44-44v-58" stroke="var(--border)" strokeWidth="1" />
          <path d="M150 200h400M300 72v256" stroke="var(--border)" strokeWidth="1" strokeDasharray="2 10" opacity="0.65" />
          <circle cx="300" cy="200" r="128" stroke="var(--border)" strokeDasharray="2 12" opacity="0.6" />
          <circle cx="300" cy="200" r="84" stroke="var(--border)" opacity="0.35" />
          <path d="M35 170l18-18h23l19 18v60l-19 18H53l-18-18z" fill="var(--surface)" stroke="var(--border)" strokeWidth="1.5" />
          <circle cx="65" cy="200" r="23" stroke="var(--accent)" strokeWidth="1.5" opacity="0.75" />
          <circle cx="65" cy="200" r="13" fill="var(--accent)" fillOpacity="0.14" stroke="var(--accent)" />
          <path d="M87 183h10v34H87" stroke="var(--signal-secondary)" strokeWidth="2" />
          <circle cx="65" cy="200" r="4" fill="var(--accent)" />
        </>}
        {beams.map((beam, index) => (
          <g key={index}>
            <line x1={SOURCE.x} y1={SOURCE.y} x2={beam.x} y2={beam.y} stroke={beam.color} strokeWidth={compact ? "1" : "1.5"} opacity={compact ? "0.2" : "0.32"} />
            <line x1={SOURCE.x} y1={SOURCE.y} x2={beam.x} y2={beam.y} stroke={beam.color} strokeWidth="6" opacity="0.12" filter={`url(#laser-glow-${instance})`} />
            <circle cx={beam.x} cy={beam.y} r={compact ? 8 : 18} fill="var(--surface)" fillOpacity={compact ? 0 : 0.75} stroke={beam.color} strokeWidth="1.3" opacity="0.8" />
            {!compact && <>
              <circle cx={beam.x} cy={beam.y} r="29" stroke={beam.color} strokeDasharray="7 10" opacity="0.3" />
              <path d={`M${beam.x - 9} ${beam.y}h18M${beam.x} ${beam.y - 9}v18`} stroke={beam.color} opacity="0.8" />
              <path d={`M${beam.x + 37} ${beam.y - 13}h17m-17 9h10`} stroke="var(--border)" />
            </>}
            <line
              ref={(element) => { streaks.current[index] = element; }}
              x1={SOURCE.x + (beam.x - SOURCE.x) * 0.25}
              y1={SOURCE.y + (beam.y - SOURCE.y) * 0.25}
              x2={SOURCE.x + (beam.x - SOURCE.x) * 0.4}
              y2={SOURCE.y + (beam.y - SOURCE.y) * 0.4}
              stroke={beam.color}
              strokeWidth={compact ? "2.2" : "3"}
              strokeLinecap="round"
            />
            <circle
              ref={(element) => { heads.current[index] = element; }}
              data-laser-head={index}
              cx={SOURCE.x + (beam.x - SOURCE.x) * 0.4}
              cy={SOURCE.y + (beam.y - SOURCE.y) * 0.4}
              r={compact ? "2.8" : "4"}
              fill={beam.color}
            />
            <circle
              ref={(element) => { impacts.current[index] = element; }}
              data-laser-impact={index}
              cx={beam.x} cy={beam.y} r="8" opacity="0"
              stroke={beam.color} strokeWidth="2"
            />
            {Array.from({ length: PARTICLES }, (_, particle) => (
              <circle
                key={particle}
                ref={(element) => {
                  particles.current[index] ??= [];
                  particles.current[index][particle] = element;
                }}
                cx={beam.x} cy={beam.y} r={particle % 2 ? "1.6" : "2.2"}
                opacity="0" fill={beam.color}
              />
            ))}
          </g>
        ))}
      </svg>
      {children && <div className="relative z-10">{children}</div>}
    </div>
  );
}
