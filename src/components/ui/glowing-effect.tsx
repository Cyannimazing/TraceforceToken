"use client";

import { memo, useCallback, useEffect, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { animate } from "motion/react";
import { useTraceMotion } from "./motion-preferences";

interface GlowingEffectProps {
  blur?: number;
  inactiveZone?: number;
  proximity?: number;
  spread?: number;
  variant?: "default" | "white";
  glow?: boolean;
  className?: string;
  disabled?: boolean;
  movementDuration?: number;
  borderWidth?: number;
}
const GlowingEffect = memo(
  ({
    blur = 0,
    inactiveZone = 0.7,
    proximity = 0,
    spread = 20,
    variant = "default",
    glow = false,
    className,
    movementDuration = 2,
    borderWidth = 1,
    disabled = true,
  }: GlowingEffectProps) => {
    const containerRef = useRef<SVGSVGElement>(null);
    const gradientRef = useRef<SVGLinearGradientElement>(null);
    const angleRef = useRef(0);
    const id = `glow-${useId().replace(/:/g, "")}`;
    const { active } = useTraceMotion();
    const lastPosition = useRef({ x: 0, y: 0 });
    const animationFrameRef = useRef<number>(0);
    const angleAnimation = useRef<ReturnType<typeof animate> | null>(null);

    const handleMove = useCallback(
      (e?: MouseEvent | { x: number; y: number }) => {
        if (!containerRef.current) return;

        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }

        animationFrameRef.current = requestAnimationFrame(() => {
          const element = containerRef.current;
          if (!element) return;

          const { left, top, width, height } = element.getBoundingClientRect();
          const mouseX = e?.x ?? lastPosition.current.x;
          const mouseY = e?.y ?? lastPosition.current.y;

          if (e) {
            lastPosition.current = { x: mouseX, y: mouseY };
          }

          const center = [left + width * 0.5, top + height * 0.5];
          const distanceFromCenter = Math.hypot(
            mouseX - center[0],
            mouseY - center[1]
          );
          const inactiveRadius = 0.5 * Math.min(width, height) * inactiveZone;

          if (distanceFromCenter < inactiveRadius) {
            element.setAttribute("opacity", glow ? ".3" : "0");
            return;
          }

          const isActive =
            mouseX > left - proximity &&
            mouseX < left + width + proximity &&
            mouseY > top - proximity &&
            mouseY < top + height + proximity;

          element.setAttribute("opacity", isActive ? "1" : glow ? ".3" : "0");

          if (!isActive) return;

          const currentAngle = angleRef.current;
          const targetAngle =
            (180 * Math.atan2(mouseY - center[1], mouseX - center[0])) /
              Math.PI +
            90;

          const angleDiff = ((targetAngle - currentAngle + 180) % 360) - 180;
          const newAngle = currentAngle + angleDiff;

          angleAnimation.current?.stop();
          angleAnimation.current = animate(currentAngle, newAngle, {
            duration: movementDuration,
            ease: [0.16, 1, 0.3, 1],
            onUpdate: (value) => {
              angleRef.current = value;
              gradientRef.current?.setAttribute("gradientTransform", `rotate(${value} .5 .5)`);
            },
          });
        });
      },
      [inactiveZone, proximity, movementDuration, glow]
    );

    useEffect(() => {
      if (disabled || !active) return;

      const handleScroll = () => handleMove();
      const handlePointerMove = (e: PointerEvent) => handleMove(e);

      window.addEventListener("scroll", handleScroll, { passive: true });
      document.body.addEventListener("pointermove", handlePointerMove, {
        passive: true,
      });

      return () => {
        angleAnimation.current?.stop();
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        window.removeEventListener("scroll", handleScroll);
        document.body.removeEventListener("pointermove", handlePointerMove);
      };
    }, [handleMove, disabled, active]);

    return (
      // Keep the installed pointer/angle behavior. SVG gradient attributes replace
      // inline CSS variables and masks, preserving the application's strict CSP.
      <svg ref={containerRef} width="100%" height="100%" opacity={glow ? ".3" : "0"} aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full overflow-visible rounded-[inherit] transition-opacity motion-reduce:transition-none", blur > 0 && "blur-sm", className, disabled && !glow && "hidden")}>
        <defs><linearGradient ref={gradientRef} id={id} x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stopColor={variant === "white" ? "var(--foreground)" : "var(--cyan)"} /><stop offset={`${Math.min(90, Math.max(10, spread))}%`} stopColor="var(--amber)" /><stop offset="1" stopColor="var(--cyan)" stopOpacity="0" /></linearGradient></defs>
        <rect x="1" y="1" width="99.6%" height="99%" rx="16" fill="none" stroke={`url(#${id})`} strokeWidth={borderWidth} />
      </svg>
    );
  }
);

GlowingEffect.displayName = "GlowingEffect";

export { GlowingEffect };
