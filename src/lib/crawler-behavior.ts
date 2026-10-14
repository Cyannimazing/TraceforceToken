export type CrawlerState = "IDLE" | "EXPLORE" | "CRAWL" | "INSPECT" | "REACT" | "REST";
export interface CrawlerPoint { x: number; y: number }
export interface CrawlerObstacle { left: number; top: number; right: number; bottom: number }
export interface CrawlerViewport { width: number; height: number }

export function isCrawlerPositionSafe(point: CrawlerPoint, viewport: CrawlerViewport, obstacles: readonly CrawlerObstacle[], radius = 30): boolean {
  if (![point.x, point.y, viewport.width, viewport.height, radius].every(Number.isFinite) || radius < 0) return false;
  return point.x >= radius && point.x <= viewport.width - radius && point.y >= radius && point.y <= viewport.height - radius
    && !obstacles.some((box) => point.x >= box.left - radius && point.x <= box.right + radius && point.y >= box.top - radius && point.y <= box.bottom + radius);
}

/** Sweep the entire footprint along a segment; checking only the destination can cross a form. */
export function isCrawlerPathSafe(from: CrawlerPoint, to: CrawlerPoint, viewport: CrawlerViewport, obstacles: readonly CrawlerObstacle[], radius = 30): boolean {
  if (!isCrawlerPositionSafe(from, viewport, obstacles, radius) || !isCrawlerPositionSafe(to, viewport, obstacles, radius)) return false;
  return !obstacles.some((box) => {
    let enter = 0, leave = 1;
    for (const [start, delta, low, high] of [[from.x, to.x - from.x, box.left - radius, box.right + radius], [from.y, to.y - from.y, box.top - radius, box.bottom + radius]]) {
      if (delta === 0) { if (start < low || start > high) return false; }
      else {
        const first = (low - start) / delta, last = (high - start) / delta;
        enter = Math.max(enter, Math.min(first, last)); leave = Math.min(leave, Math.max(first, last));
        if (enter > leave) return false;
      }
    }
    return enter <= leave;
  });
}

export function chooseCrawlerDestination(viewport: CrawlerViewport, obstacles: readonly CrawlerObstacle[], random: () => number = Math.random, origin?: CrawlerPoint, radius = 30): CrawlerPoint | null {
  const margin = radius + 8, width = viewport.width - margin * 2, height = viewport.height - margin * 2;
  if (width < 0 || height < 0) return null;
  for (let attempt = 0; attempt < 72; attempt++) {
    const side = Math.floor(random() * 4), t = random();
    // Prefer whitespace at viewport boundaries, with some free-space exploration.
    const point = attempt < 48 ? { x: side < 2 ? margin + t * width : side === 2 ? margin : viewport.width - margin,
      y: side < 2 ? side === 0 ? margin : viewport.height - margin : margin + t * height }
      : { x: margin + random() * width, y: margin + random() * height };
    if (isCrawlerPositionSafe(point, viewport, obstacles, radius)
      && (!origin || (Math.hypot(point.x - origin.x, point.y - origin.y) > 55 && isCrawlerPathSafe(origin, point, viewport, obstacles, radius)))) return point;
  }
  return null;
}

export function nextCrawlerState(state: CrawlerState, random: () => number = Math.random): CrawlerState {
  switch (state) {
    case "IDLE": return random() < 0.7 ? "EXPLORE" : "INSPECT";
    case "EXPLORE": return "CRAWL";
    case "CRAWL": return random() < 0.75 ? "INSPECT" : "REST";
    case "INSPECT": return random() < 0.6 ? "EXPLORE" : "REST";
    case "REACT": return "EXPLORE";
    case "REST": return "IDLE";
  }
}

export function crawlerStateDuration(state: CrawlerState, random: () => number = Math.random): number {
  const limits: Record<CrawlerState, readonly [number, number]> = {
    IDLE: [1000, 2800], EXPLORE: [350, 900], CRAWL: [5000, 12000], INSPECT: [1000, 2300], REACT: [700, 1300], REST: [2000, 5000],
  };
  const [minimum, maximum] = limits[state]; return minimum + random() * (maximum - minimum);
}
