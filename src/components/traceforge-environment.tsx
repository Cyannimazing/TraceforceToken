"use client";

import { useEffect, useRef, useState } from "react";
import { useTraceMotion } from "./ui/motion-preferences";
import { chooseCrawlerDestination, crawlerStateDuration, isCrawlerPathSafe, isCrawlerPositionSafe, nextCrawlerState, type CrawlerObstacle, type CrawlerPoint, type CrawlerState } from "@/lib/crawler-behavior";
import "./traceforge-environment.css";

const avoidSelector = "a,button,input,textarea,select,[contenteditable=true],[role=button],h1,h2,h3,p,label,td,th,summary,[data-crawler-avoid]";
const legNumbers = [0, 1, 2, 3, 4, 5];
interface EnvironmentMemory {
  elapsed: number; state: CrawlerState; until: number; heading: number; headingTarget: number; steps: number;
  point: CrawlerPoint | null; target: CrawlerPoint | null;
  nodes: { x: number; y: number; phase: number; speed: number }[];
}

/** One persistent, decorative canvas and an articulated SVG rig; no frame-by-frame React renders. */
export function TraceForgeEnvironment() {
  const canvasRef = useRef<HTMLCanvasElement>(null), stageRef = useRef<SVGSVGElement>(null), rigRef = useRef<SVGGElement>(null), eyesRef = useRef<SVGGElement>(null);
  const [shown, setShown] = useState(true);
  const shownRef = useRef(shown);
  const memoryRef = useRef<EnvironmentMemory | null>(null);
  const { active, reduced } = useTraceMotion();
  useEffect(() => { shownRef.current = shown; window.dispatchEvent(new Event("traceforge:toggle-crawler")); }, [shown]);

  useEffect(() => {
    const canvas = canvasRef.current, stage = stageRef.current, rig = rigRef.current, eyes = eyesRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !stage || !rig || !eyes || !context) return;
    const saved = memoryRef.current;
    let width = 0, height = 0, mobile = false, frame = 0, lastFrame = 0, lastMeasure = -2000, elapsed = saved?.elapsed ?? 0;
    let dirty = true, hidden = document.hidden, state: CrawlerState = saved?.state ?? "IDLE", until = saved?.until ?? 1600, nextReaction = 0, heading = saved?.heading ?? 0, headingTarget = saved?.headingTarget ?? 0, steps = saved?.steps ?? 0;
    let point: CrawlerPoint | null = saved?.point ?? null, target: CrawlerPoint | null = saved?.target ?? null, cursor: CrawlerPoint | null = null, obstacles: CrawlerObstacle[] = [], boundaryPoints: CrawlerPoint[] = [];
    let palette = { line: "rgba(35,65,115,.12)", node: "rgba(40,85,160,.45)", blue: "49,86,236", cyan: "42,177,218", violet: "149,102,216", coral: "245,135,115" };
    const legs = [...rig.querySelectorAll<SVGPathElement>("[data-crawler-leg]")];
    const joints = [...rig.querySelectorAll<SVGRectElement>("[data-crawler-joint]")];
    const nodes = saved?.nodes ?? Array.from({ length: 38 }, (_, index) => ({ x: Math.random(), y: Math.random(), phase: index * 2.399, speed: 0.45 + Math.random() * 0.65 }));

    function theme() {
      const dark = document.documentElement.dataset.theme === "dark" || document.documentElement.classList.contains("dark");
      palette = { ...palette, line: dark ? "rgba(145,174,220,.13)" : "rgba(35,65,115,.12)", node: dark ? "rgba(135,192,245,.6)" : "rgba(40,85,160,.45)" };
    }
    function resize() {
      width = window.innerWidth; height = window.innerHeight; mobile = width < 700;
      const ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
      canvas!.width = Math.round(width * ratio); canvas!.height = Math.round(height * ratio);
      context!.setTransform(ratio, 0, 0, ratio, 0, 0);
      stage!.setAttribute("viewBox", `0 0 ${width} ${height}`); dirty = true;
      if (!active && !hidden) { paintNetwork(elapsed / 1000); measure(); moveCrawler(0); }
    }
    function measure() {
      obstacles = [];
      // Bound the visible obstacles, not the first nodes in document order:
      // long reports can place their active controls far below those nodes.
      for (const element of document.querySelectorAll<HTMLElement>(avoidSelector)) {
        if (obstacles.length >= 700) break;
        if (element.closest(".tf-crawler-stage")) continue;
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0 && box.bottom >= 0 && box.top <= height && box.right >= 0 && box.left <= width)
          obstacles.push({ left: box.left - 5, top: box.top - 5, right: box.right + 5, bottom: box.bottom + 5 });
      }
      // Keep the crawler out of the top navigation and browser safe-area corners.
      obstacles.push({ left: 0, top: 0, right: width, bottom: mobile ? 92 : 76 });
      boundaryPoints = [...document.querySelectorAll("main section,[data-crawler-path]")].slice(0, 30).flatMap((element) => {
        const box = element.getBoundingClientRect();
        return [{ x: box.left - 38, y: box.top + 38 }, { x: box.right + 38, y: box.bottom - 38 }];
      });
      dirty = false; lastMeasure = elapsed;
    }
    function paintNetwork(seconds: number) {
      context!.clearRect(0, 0, width, height);
      const count = mobile ? 15 : nodes.length, positions: CrawlerPoint[] = [];
      for (let index = 0; index < count; index++) {
        const node = nodes[index], drift = 1;
        let x = node.x * width + Math.sin(seconds * 0.15 * node.speed + node.phase) * 36 * drift;
        let y = node.y * height + Math.cos(seconds * 0.12 * node.speed + node.phase) * 29 * drift;
        if (cursor && active && !mobile) {
          const dx = x - cursor.x, dy = y - cursor.y, distance = Math.hypot(dx, dy);
          if (distance < 170 && distance > 0) { const push = (1 - distance / 170) * 24; x += dx / distance * push; y += dy / distance * push; }
        }
        positions.push({ x, y });
      }
      context!.strokeStyle = palette.line; context!.lineWidth = 0.7;
      for (let index = 0; index < count; index++) {
        let links = 0;
        for (let other = index + 1; other < count && links < 3; other++) {
          const a = positions[index], b = positions[other];
          if (Math.hypot(a.x - b.x, a.y - b.y) < (mobile ? 180 : 240)) {
            context!.beginPath(); context!.moveTo(a.x, a.y); context!.lineTo(b.x, b.y); context!.stroke(); links++;
            if (active && (index + other) % 5 === 0) {
              const t = (seconds * 0.11 + index * 0.13) % 1;
              context!.fillStyle = palette.node; context!.fillRect(a.x + (b.x - a.x) * t - 1.5, a.y + (b.y - a.y) * t - 1.5, 3, 3);
            }
          }
        }
      }
      context!.strokeStyle = palette.node;
      for (let index = 0; index < count; index++) {
        const node = positions[index], size = 3 + (index % 3);
        context!.strokeRect(Math.round(node.x), Math.round(node.y), size, size);
      }
      const clusters = mobile ? 2 : 3, pixel = mobile ? 12 : 17;
      for (let cluster = 0; cluster < clusters; cluster++) {
        const baseX = width * [0.84, 0.09, 0.63][cluster], baseY = height * [0.26, 0.76, 0.92][cluster];
        const time = seconds, dx = Math.sin(time * 0.12 + cluster) * 38, dy = Math.cos(time * 0.1 + cluster * 2) * 24;
        for (let x = -5; x <= 5; x++) for (let y = -4; y <= 4; y++) {
          const falloff = Math.exp(-(x * x / 16 + y * y / 11));
          const modulation = 0.65 + Math.sin(time * 0.32 + x * 0.7 + y * 0.6 + cluster) * 0.35;
          const alpha = falloff * modulation * (mobile ? 0.13 : 0.19);
          if (alpha < 0.02) continue;
          const color = (x + y + cluster + 12) % 4;
          context!.fillStyle = `rgba(${[palette.blue, palette.cyan, palette.violet, palette.coral][color]},${alpha})`;
          context!.fillRect(Math.round(baseX + dx + x * pixel), Math.round(baseY + dy + y * pixel), pixel - 1, pixel - 1);
        }
      }
    }
    function enter(next: CrawlerState) {
      state = next; until = elapsed + crawlerStateDuration(next); rig!.setAttribute("data-state", next);
      if (next === "EXPLORE" && point) {
        target = chooseCrawlerDestination({ width, height }, obstacles, Math.random, point, mobile ? 24 : 30);
        const radius = mobile ? 24 : 30;
        // Occasionally follow a section edge or inspect a free decorative network node.
        const paths = Math.random() < 0.6 ? boundaryPoints : nodes.map((node) => ({ x: node.x * width, y: node.y * height }));
        const nearby = paths.filter((destination) => Math.hypot(destination.x - point!.x, destination.y - point!.y) > 60
          && isCrawlerPathSafe(point!, destination, { width, height }, obstacles, radius));
        if (nearby.length && Math.random() < 0.45) target = nearby[Math.floor(Math.random() * nearby.length)];
        if (!target) { state = "REST"; until = elapsed + 2500; }
      }
      if (next === "CRAWL" && target && point) {
        headingTarget = Math.atan2(target.y - point.y, target.x - point.x) * 180 / Math.PI;
        until = elapsed + Math.hypot(target.x - point.x, target.y - point.y) / (mobile ? 28 : 42) * 1000 + 500;
      }
      rig!.setAttribute("data-state", state);
    }
    function moveCrawler(delta: number) {
      const radius = mobile ? 24 : 30;
      if (!shownRef.current) { rig!.setAttribute("visibility", "hidden"); return; }
      let repositioned = false;
      if (!point || !isCrawlerPositionSafe(point, { width, height }, obstacles, radius)) {
        point = chooseCrawlerDestination({ width, height }, obstacles, Math.random, undefined, radius); target = null; enter("IDLE"); repositioned = true;
      }
      if (!point) { rig!.setAttribute("visibility", "hidden"); return; }
      rig!.setAttribute("visibility", "visible");
      if (!active && saved && !repositioned) return;
      if (active && elapsed >= until) enter(nextCrawlerState(state));
      if (active && !mobile && cursor && elapsed > nextReaction && Math.hypot(cursor.x - point.x, cursor.y - point.y) < 120) {
        nextReaction = elapsed + 6500; headingTarget = Math.atan2(cursor.y - point.y, cursor.x - point.x) * 180 / Math.PI; enter("REACT");
        const following = { x: cursor.x - 60, y: cursor.y + 36 };
        if (Math.random() < 0.45 && isCrawlerPathSafe(point, following, { width, height }, obstacles, radius)) target = following;
      }
      let moving = false;
      if (active && (state === "CRAWL" || state === "REACT") && target) {
        if (!isCrawlerPathSafe(point, target, { width, height }, obstacles, radius)) { target = null; enter("REST"); }
        else {
          const distance = Math.hypot(target.x - point.x, target.y - point.y), step = Math.min(distance, delta * (mobile ? 28 : 42));
          if (distance < 1) enter("INSPECT");
          else { point = { x: point.x + (target.x - point.x) / distance * step, y: point.y + (target.y - point.y) / distance * step }; moving = true; steps += step * 0.2; }
        }
      }
      const turn = ((headingTarget - heading + 540) % 360) - 180; heading += turn * Math.min(delta * 4.5, 1);
      const seconds = elapsed / 1000, breathing = active ? Math.sin(seconds * 2.5) * (state === "REST" ? 0.5 : 1.2) : 0;
      const desiredHop = active && state === "REACT" ? Math.max(0, Math.sin((until - elapsed) / 1000 * Math.PI)) * 8 : 0;
      const hop = isCrawlerPositionSafe({ x: point.x, y: point.y - desiredHop }, { width, height }, obstacles, radius) ? desiredHop : 0;
      rig!.setAttribute("transform", `translate(${point.x.toFixed(2)} ${(point.y - hop + breathing).toFixed(2)}) rotate(${heading.toFixed(2)}) scale(${mobile ? 0.72 : 0.9})`);
      const blink = active && (seconds % 4.7 < 0.12 || (state === "INSPECT" && seconds % 2.8 < 0.1));
      eyes!.setAttribute("transform", `translate(${state === "INSPECT" ? Math.sin(seconds * 2) * 1.8 : state === "REACT" ? 2 : 0} 0) scale(1 ${blink ? 0.12 : 1})`);
      for (let index = 0; index < 6; index++) {
        const side = index < 3 ? -1 : 1, rank = index % 3, stride = moving ? Math.sin(steps + rank * 1.8 + (side > 0 ? Math.PI : 0)) * 8 : Math.sin(seconds * 1.4 + rank) * (active ? 1 : 0);
        const anchor = -12 + rank * 12, kneeX = anchor - 6 + stride * 0.4, kneeY = side * (state === "REST" ? 14 : 18), footX = anchor - 13 + stride, footY = side * (state === "REST" ? 22 : 29);
        legs[index].setAttribute("d", `M ${anchor} ${side * 7} L ${kneeX.toFixed(2)} ${kneeY} L ${footX.toFixed(2)} ${footY}`);
        joints[index].setAttribute("transform", `translate(${kneeX.toFixed(2)} ${kneeY})`);
      }
    }
    function animate(timestamp: number) {
      if (hidden) return;
      if (timestamp - lastFrame + 0.5 < (mobile ? 1000 / 24 : 1000 / 60)) { frame = requestAnimationFrame(animate); return; }
      const delta = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.08) : 0; lastFrame = timestamp;
      if (active) elapsed += delta * 1000;
      if (dirty || elapsed - lastMeasure > 2200) measure();
      paintNetwork(elapsed / 1000); moveCrawler(delta);
      if (active) frame = requestAnimationFrame(animate);
    }
    function refresh() { dirty = true; if (!active && !hidden) { paintNetwork(elapsed / 1000); measure(); moveCrawler(0); } }
    function visibility() { hidden = document.hidden; cancelAnimationFrame(frame); lastFrame = 0; if (!hidden) frame = requestAnimationFrame(animate); }
    function pointer(event: PointerEvent) { cursor = { x: event.clientX, y: event.clientY }; }
    function leave() { cursor = null; }
    const observer = new MutationObserver(() => { theme(); refresh(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    const layoutObserver = new MutationObserver(refresh);
    layoutObserver.observe(document.body, { childList: true, subtree: true });
    theme(); resize(); frame = requestAnimationFrame(animate);
    window.addEventListener("resize", resize); window.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("traceforge:toggle-crawler", refresh);
    window.addEventListener("pointermove", pointer, { passive: true }); window.addEventListener("pointerout", leave);
    document.addEventListener("visibilitychange", visibility); document.addEventListener("focusin", refresh);
    return () => {
      memoryRef.current = { elapsed, state, until, heading, headingTarget, steps, point, target, nodes };
      cancelAnimationFrame(frame); observer.disconnect(); layoutObserver.disconnect();
      window.removeEventListener("resize", resize); window.removeEventListener("scroll", refresh);
      window.removeEventListener("traceforge:toggle-crawler", refresh);
      window.removeEventListener("pointermove", pointer); window.removeEventListener("pointerout", leave);
      document.removeEventListener("visibilitychange", visibility); document.removeEventListener("focusin", refresh);
    };
  }, [active]);

  return <>
    <canvas ref={canvasRef} className="tf-environment-canvas" aria-hidden="true" data-testid="traceforge-network" />
    <svg ref={stageRef} className="tf-crawler-stage" aria-hidden="true" focusable="false" data-testid="traceforge-crawler" data-motion={reduced ? "reduced" : active ? "active" : "paused"}>
      <g ref={rigRef} data-crawler-rig="true" data-state="IDLE" visibility="hidden">
        <g className="tf-crawler-legs">{legNumbers.map((index) => <path key={index} data-crawler-leg={index} d="M 0 0 L 12 15 L 23 20" />)}</g>
        <g className="tf-crawler-joints">{legNumbers.map((index) => <rect key={index} data-crawler-joint={index} x="-2" y="-2" width="4" height="4" rx="0.7" />)}</g>
        <path className="tf-crawler-body" d="M -18 -9 L -10 -14 L 12 -12 L 22 -5 L 22 5 L 12 12 L -10 14 L -18 9 Z" />
        <path className="tf-crawler-shell" d="M -13 -6 L -7 -10 L 4 -9 L 9 0 L 4 9 L -7 10 L -13 6 Z" />
        <path className="tf-crawler-trace" d="M -10 0 H -3 V -5 H 3 M -3 0 V 5 H 3" />
        <g className="tf-crawler-eyes" ref={eyesRef}><rect x="12" y="-7" width="4" height="4" rx="0.6" /><rect x="12" y="3" width="4" height="4" rx="0.6" /></g>
        <path className="tf-crawler-aerial" d="M -15 -8 L -22 -14 M -15 8 L -22 14" /><rect className="tf-crawler-sensor" x="-25" y="-17" width="4" height="4" /><rect className="tf-crawler-sensor" x="-25" y="13" width="4" height="4" />
      </g>
    </svg>
    <button type="button" className="tf-crawler-toggle" onClick={() => setShown((value) => !value)} aria-pressed={shown} aria-label={shown ? "Hide robotic crawler" : "Show robotic crawler"} title={shown ? "Hide robotic crawler" : "Show robotic crawler"} data-crawler-control="true">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 8H17V16H7ZM4 5L8 9M20 5L16 9M3 12H7M17 12H21M4 19L8 15M20 19L16 15" stroke="currentColor" strokeWidth="1.3" /><path d="M10 10H11V12H10ZM14 10H15V12H14Z" fill="currentColor" /></svg>
      <span>Crawler {shown ? "on" : "off"}</span>
    </button>
  </>;
}
