import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Public UI inspection only. No authentication, cookies, request bodies,
// provider URLs/keys, response payloads, or private account state are saved.
const origin = "https://swarmengine.tech";
const args = process.argv.slice(2);
const requestedToken = args.find((value) => /^0x[0-9a-f]{40}$/i.test(value));
const token = (requestedToken ?? "0x1641ea6eab36969fe11d71e6eb8f102889c735e1").toLowerCase();
const output = path.resolve(`.artifacts/swarm-reference/current-${token.slice(2, 10)}`);
const maxTextCharacters = 45_000;
const maxBodyBytes = 1_048_576;
const network = [];
const pending = new Set();
const summary = { capturedAt: new Date().toISOString(), origin, token, freshScanRequested: args.includes("--fresh"), pages: {}, publicSources: {}, network };

function publicUrl(value) {
  try {
    const url = new URL(value, origin);
    // Queries could contain secrets. Persist only origin and pathname.
    return `${url.origin}${url.pathname}`;
  } catch { return "[invalid URL]"; }
}

function objectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 100) : [];
}

function reportShape(payload) {
  const report = payload?.result;
  const holders = Array.isArray(report?.holders) ? report.holders : [];
  return {
    responseKeys: objectKeys(payload), exists: Boolean(report), keys: objectKeys(report),
    headerKeys: objectKeys(report?.header), reportedHolders: report?.header?.holders_count ?? null,
    analyzedHolderRows: holders.length, unreadHolderRows: holders.filter((holder) => holder?.signals?.unread).length,
    holderKeys: objectKeys(holders[0]), signalKeys: objectKeys(holders[0]?.signals),
    partKeys: objectKeys(report?.parts), metricKeys: objectKeys(report?.metrics),
    judgeKeys: objectKeys(report?.judge), securityKeys: objectKeys(report?.security),
    clusterKeys: objectKeys(report?.clusters?.[0]), linkKeys: objectKeys(report?.links?.[0]),
    infraRows: Array.isArray(report?.infra) ? report.infra.length : null,
    historyRows: Array.isArray(payload?.history) ? payload.history.length : null,
    sourceFieldNames: objectKeys(report).filter((key) => /source|provider|coverage/i.test(key)),
  };
}

function providerHosts(payload) {
  const found = new Map();
  const chains = new Set(["base", "ethereum", "bsc", "bnb", "solana", "robinhood"]);
  function visit(value, chain = "unspecified", depth = 0) {
    if (depth > 12) return;
    if (typeof value === "string") {
      const candidates = value.match(/https?:\/\/[^\s"<>]+/g) ?? [];
      if (/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(value)) candidates.push(`https://${value}`);
      for (const candidate of candidates) {
        try {
          const hostname = new URL(candidate).hostname.toLowerCase();
          if (!found.has(chain)) found.set(chain, new Set());
          found.get(chain).add(hostname);
        } catch { /* Ignore text that is not a URL. */ }
      }
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) visit(item, chain, depth + 1);
    } else if (value && typeof value === "object") {
      const label = Object.values(value).find((item) => typeof item === "string" && chains.has(item.toLowerCase()));
      if (label) chain = label.toLowerCase();
      for (const [key, item] of Object.entries(value).slice(0, 500)) visit(item, chains.has(key.toLowerCase()) ? key.toLowerCase() : chain, depth + 1);
    }
  }
  visit(payload);
  return Object.fromEntries([...found].map(([chain, hosts]) => [chain, [...hosts].sort()]));
}

function sourceDisclosures(payload) {
  const matches = [];
  function visit(value, depth = 0) {
    if (depth > 10 || matches.length >= 24) return;
    if (typeof value === "string" && /blockscout|alchemy|nodereal|helius|geckoterminal|backup rpc|transfer history|holder.*rebuild|rebuild.*holder/i.test(value)) {
      matches.push(value.replace(/https?:\/\/[^\s"<>]+/g, publicUrl).slice(0, 1200));
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) visit(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value).slice(0, 500)) visit(item, depth + 1);
    }
  }
  visit(payload);
  return matches;
}

async function layout(page) {
  return page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const elements = [...document.querySelectorAll("main,section,h1,h2,h3,canvas,svg,table")].slice(0, 120).map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName.toLowerCase(), id: element.id, className: element.getAttribute("class")?.slice(0, 180) ?? "", text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240), x: Math.round(box.x), y: Math.round(box.y + window.scrollY), width: Math.round(box.width), height: Math.round(box.height), fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius };
    });
    return { viewport: { width: innerWidth, height: innerHeight }, scrollHeight: document.documentElement.scrollHeight, body: { fontFamily: body.fontFamily, fontSize: body.fontSize, backgroundColor: body.backgroundColor, color: body.color }, elements };
  });
}

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await context.newPage();
  let scanStarted;
  let scanFinished = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith("/api/") && request.method() === "POST" && scanStarted === undefined) scanStarted = performance.now();
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/") || network.length >= 100) return;
    const record = { method: response.request().method(), path: url.pathname, status: response.status(), sinceScanMs: scanStarted === undefined ? null : Math.round(performance.now() - scanStarted) };
    network.push(record);
    if (record.method === "POST" && response.ok()) scanFinished = true;
    if ([`/api/token/base/${token}`, `/api/council/base/${token}`].includes(url.pathname) && response.ok()) {
      const task = (async () => {
        const length = Number(response.headers()["content-length"] ?? 0);
        if (length > maxBodyBytes) { record.shapeSkipped = "body limit"; return; }
        const buffer = await response.body();
        if (buffer.length > maxBodyBytes) { record.shapeSkipped = "body limit"; return; }
        const payload = JSON.parse(buffer.toString("utf8"));
        if (url.pathname.includes("/api/token/")) summary.reportShape = reportShape(payload);
        else summary.councilShape = { keys: objectKeys(payload), turnCount: Array.isArray(payload.turns) ? payload.turns.length : 0, roles: [...new Set((payload.turns ?? []).map((turn) => turn.agent))].slice(0, 20) };
      })().catch(() => { record.shapeSkipped = "not readable JSON"; });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  });

  try {
    for (const [name, urlPath] of [["home", "/"], ["docs", "/docs"]]) {
      await page.goto(`${origin}${urlPath}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1000);
      const visibleText = (await page.locator("body").innerText()).slice(0, maxTextCharacters);
      summary.pages[name] = { url: publicUrl(page.url()), title: await page.title(), headings: await page.locator("h1,h2,h3").allTextContents(), links: await page.locator("a[href]").evaluateAll((anchors) => anchors.slice(0, 100).map((anchor) => ({ text: (anchor.textContent ?? "").trim().slice(0, 160), href: anchor.href.split("?")[0] }))) };
      await writeFile(path.join(output, `${name}-visible.txt`), visibleText);
      await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    }

    await page.goto(`${origin}/t/base/${token}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1000);
    if (args.includes("--fresh")) await page.getByRole("button", { name: /fresh scan/i }).click({ timeout: 10_000 });
    await page.screenshot({ path: path.join(output, "report-entry.png"), fullPage: true });
    for (let seconds = 0; seconds < 75; seconds++) {
      const body = await page.locator("body").innerText();
      if ((!args.includes("--fresh") || scanFinished) && /VERDICT OUTPUT|JUDGE OUTPUT/i.test(body) && !/LIVE CRAWL/.test(body)) break;
      const viewResult = page.getByRole("button", { name: /view result/i });
      if (await viewResult.isVisible()) await viewResult.click();
      if (seconds === 74) summary.reportWaitLimitReached = true;
      await page.waitForTimeout(1000);
    }
    const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), 16_000);
    // Reveal sections that animate on intersection before measuring/capturing.
    for (let top = 0; top < height; top += 750) {
      await page.evaluate((value) => window.scrollTo(0, value), top);
      await page.waitForTimeout(450);
    }
    // Council text is animated locally after its public response arrives.
    // Wait for all declared turns so the capture does not stop mid-sentence.
    for (let seconds = 0; seconds < 45; seconds++) {
      const expected = summary.councilShape?.turnCount ?? 0;
      const shown = await page.locator("#cnfeed .cn-row").count();
      const typing = await page.locator("#cnfeed .typing,#cnfeed .cn-think").count();
      if (expected > 0 && shown >= expected && typing === 0) { summary.councilAnimationSettled = true; break; }
      if (expected === 0 && seconds >= 2) break;
      if (seconds === 44) summary.councilAnimationSettled = false;
      await page.waitForTimeout(1000);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    summary.pages.report = { url: publicUrl(page.url()), title: await page.title(), headings: await page.locator("h1,h2,h3").allTextContents(), layout: await layout(page) };
    await writeFile(path.join(output, "report-visible.txt"), (await page.locator("body").innerText()).slice(0, maxTextCharacters));
    await page.screenshot({ path: path.join(output, "report-desktop.png"), fullPage: true });
    for (let top = 0, index = 1; top < height; top += 900, index++) {
      await page.evaluate((value) => window.scrollTo(0, value), top);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(output, `section-${String(index).padStart(2, "0")}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    summary.pages.report.mobileLayout = await layout(page);
    await page.screenshot({ path: path.join(output, "report-mobile.png"), fullPage: true });

    for (const endpoint of ["/api/status/rpc", "/api/molt"]) {
      try {
        const response = await context.request.get(`${origin}${endpoint}`, { timeout: 30_000, maxRedirects: 0 });
        const buffer = await response.body();
        if (buffer.length > maxBodyBytes) throw new Error("BODY_LIMIT");
        const payload = JSON.parse(buffer.toString("utf8"));
        summary.publicSources[endpoint] = { status: response.status(), bytes: buffer.length, keys: objectKeys(payload), ...(endpoint.endsWith("/rpc") ? { providerHostnamesByChain: providerHosts(payload) } : { sourceDisclosures: sourceDisclosures(payload) }) };
      } catch (error) { summary.publicSources[endpoint] = { error: error instanceof Error ? error.name : "Error" }; }
    }
    await Promise.allSettled([...pending]);
  } finally { await browser.close(); }
}

try { await main(); }
catch (error) { summary.failure = error instanceof Error ? { name: error.name, message: error.message.replace(/https?:\/\/[^\s]+/g, publicUrl).slice(0, 500) } : { name: "Error" }; process.exitCode = 1; }
await writeFile(path.join(output, "inspection.json"), JSON.stringify(summary, null, 2));
console.info(JSON.stringify({ capturedAt: summary.capturedAt, output, freshScanRequested: summary.freshScanRequested, reportShape: summary.reportShape, publicSources: summary.publicSources, networkCalls: network.length, failure: summary.failure }, null, 2));
