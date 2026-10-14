"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { TraceForgeEnvironment } from "./traceforge-environment";
import { TraceMotionProvider, useTraceMotion } from "./ui/motion-preferences";

function ExperienceStage({ children }: { children: ReactNode }) {
  const pathname = usePathname(), router = useRouter();
  const { active } = useTraceMotion();
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.dataset.motion = active ? "active" : "paused";
    const visibility = () => { document.documentElement.dataset.visibility = document.hidden ? "hidden" : "visible"; };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release: ReturnType<typeof setTimeout> | undefined;
    const navigate = (event: MouseEvent) => {
      if (!active || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.download || anchor.target || anchor.hasAttribute("data-native-navigation")) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname || url.pathname.startsWith("/api/") || /\.[a-z0-9]+$/i.test(url.pathname)) return;
      event.preventDefault();
      if (timer) clearTimeout(timer);
      if (stage.current) stage.current.dataset.phase = "leaving";
      timer = setTimeout(() => { router.push(`${url.pathname}${url.search}${url.hash}`); release = setTimeout(() => { if (stage.current) stage.current.dataset.phase = "entered"; }, 700); }, 140);
    };
    document.addEventListener("click", navigate, true);
    return () => { document.removeEventListener("click", navigate, true); document.removeEventListener("visibilitychange", visibility); clearTimeout(timer); clearTimeout(release); };
  }, [active, router]);
  useEffect(() => {
    if (stage.current) stage.current.dataset.phase = "entered";
    if (!active || !stage.current || !("IntersectionObserver" in window)) return;
    const elements = [...stage.current.querySelectorAll<HTMLElement>(".tf-reveal, .source-card, .question-card, .content-card")];
    const observer = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) { (entry.target as HTMLElement).dataset.reveal = "visible"; observer.unobserve(entry.target); } }, { threshold: .08 });
    for (const element of elements) { element.dataset.reveal = "ready"; observer.observe(element); }
    return () => { observer.disconnect(); for (const element of elements) delete element.dataset.reveal; };
  }, [active, pathname]);
  useEffect(() => {
    if (!active) return;
    let button: HTMLElement | null = null, animation: Animation | undefined;
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>(".engine-button-primary, .tf-magnetic, button[type=submit]");
      if (!target || target.matches(":disabled")) { animation?.cancel(); button = null; return; }
      if (button !== target) { animation?.cancel(); button = target; }
      const rect = target.getBoundingClientRect();
      const x = Math.max(-4, Math.min(4, (event.clientX - rect.left - rect.width / 2) * .06));
      const y = Math.max(-3, Math.min(3, (event.clientY - rect.top - rect.height / 2) * .06));
      animation?.cancel();
      animation = target.animate([{ transform: `translate(${x}px, ${y}px)` }], { duration: 180, fill: "forwards", easing: "ease-out" });
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => { document.removeEventListener("pointermove", move); animation?.cancel(); };
  }, [active]);
  return <><TraceForgeEnvironment /><div ref={stage} key={pathname} className="tf-page-stage" data-phase="entered">{children}</div></>;
}

export function TraceForgeExperience({ children }: { children: ReactNode }) {
  return <TraceMotionProvider><ExperienceStage>{children}</ExperienceStage></TraceMotionProvider>;
}
