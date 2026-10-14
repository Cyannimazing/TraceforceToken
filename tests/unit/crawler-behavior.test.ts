import assert from "node:assert/strict";
import test from "node:test";
import { chooseCrawlerDestination, crawlerStateDuration, isCrawlerPathSafe, isCrawlerPositionSafe, nextCrawlerState, type CrawlerState } from "../../src/lib/crawler-behavior";

const viewport = { width: 1000, height: 700 };
const field = { left: 350, top: 250, right: 650, bottom: 400 };
function seeded(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

test("crawler footprints avoid text and controls, viewport edges, and invalid coordinates", () => {
  assert.equal(isCrawlerPositionSafe({ x: 345, y: 300 }, viewport, [field]), false);
  assert.equal(isCrawlerPositionSafe({ x: 100, y: 100 }, viewport, [field]), true);
  assert.equal(isCrawlerPositionSafe({ x: 10, y: 100 }, viewport, []), false);
  assert.equal(isCrawlerPositionSafe({ x: Number.NaN, y: 100 }, viewport, []), false);
});

test("swept crawler paths avoid a field even when both endpoints are clear", () => {
  assert.equal(isCrawlerPathSafe({ x: 100, y: 300 }, { x: 900, y: 300 }, viewport, [field]), false);
  assert.equal(isCrawlerPathSafe({ x: 100, y: 100 }, { x: 900, y: 100 }, viewport, [field]), true);
  assert.equal(isCrawlerPathSafe({ x: 100, y: 100 }, { x: 100, y: 600 }, viewport, [field]), true);
});

test("random destinations remain safe across desktop and mobile layouts", () => {
  for (const size of [viewport, { width: 393, height: 852 }]) {
    const random = seeded(37), obstacles = [{ left: 60, right: size.width - 60, top: 100, bottom: size.height - 150 }];
    let origin = chooseCrawlerDestination(size, obstacles, random)!;
    assert.ok(origin);
    const points = new Set<string>();
    for (let index = 0; index < 150; index++) {
      const destination = chooseCrawlerDestination(size, obstacles, random, origin);
      if (!destination) continue;
      assert.ok(isCrawlerPositionSafe(destination, size, obstacles));
      assert.ok(isCrawlerPathSafe(origin, destination, size, obstacles));
      points.add(`${destination.x}:${destination.y}`); origin = destination;
    }
    assert.ok(points.size > 20);
  }
});

test("crowded and tiny viewports suspend exploration rather than overlap content", () => {
  assert.equal(chooseCrawlerDestination(viewport, [{ left: 0, top: 0, right: 1000, bottom: 700 }], seeded(1)), null);
  assert.equal(chooseCrawlerDestination({ width: 40, height: 40 }, [], seeded(1)), null);
});

test("autonomous state transitions have finite randomized durations and revisit exploration", () => {
  const random = seeded(12), states: CrawlerState[] = ["IDLE", "EXPLORE", "CRAWL", "INSPECT", "REACT", "REST"];
  for (const state of states) {
    assert.ok(states.includes(nextCrawlerState(state, random)));
    const first = crawlerStateDuration(state, random), second = crawlerStateDuration(state, random);
    assert.ok(first >= 350 && first <= 12000); assert.notEqual(first, second);
  }
  assert.equal(nextCrawlerState("REACT"), "EXPLORE"); assert.equal(nextCrawlerState("REST"), "IDLE");
});
