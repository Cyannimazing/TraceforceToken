import { expect, test, type Page } from "@playwright/test";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";

const publicRoutes = ["/", "/methodology", "/data-sources"] as const;
const canonicalOrigin = "http://localhost:3000";

function colorChannels(color: string) {
  const channels = color.match(/^rgb\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)\s*\)$/);
  expect(channels, `Expected an opaque resolved CSS color: ${color}`).not.toBeNull();
  return channels!.slice(1).map(Number);
}

function contrast(first: string, second: string) {
  const luminance = (color: string) => colorChannels(color).map((value) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((total, channel, index) => total + channel * [.2126, .7152, .0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

// CSS color-mix and transparent editorial surfaces must be composited over
// their actual ancestor backgrounds before testing their visible contrast.
async function renderedColors(page: Page, selectors: Record<string, string>) {
  return page.evaluate((selectors) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Contrast checks require a 2D color resolver.");
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const channels = context.getImageData(0, 0, 1, 1).data;
      return [channels[0], channels[1], channels[2], channels[3] / 255];
    };
    const blend = (foreground: number[], background: number[]) => foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
    const rgb = (channels: number[]) => `rgb(${channels.slice(0, 3).map((value) => Math.round(value)).join(", ")})`;
    const background = (element: Element) => {
      const ancestors: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
      return ancestors.reduce((color, ancestor) => blend(rgba(getComputedStyle(ancestor).backgroundColor), color), [255, 255, 255]);
    };
    return Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing contrast target: ${selector}`);
      const style = getComputedStyle(element), surface = background(element);
      return [key, { background: rgb(surface), text: rgb(blend(rgba(style.color), surface)), border: rgb(blend(rgba(style.borderTopColor), surface)) }];
    }));
  }, selectors);
}

function readNonce(policy: string) {
  const nonce = policy.match(/(?:^|;)\s*script-src\s[^;]*'nonce-([A-Za-z0-9+/]+=*)'/)?.[1];
  expect(nonce, "CSP must contain a generated script nonce").toBeTruthy();
  return nonce!;
}

function assertInlineNonces(html: string, nonce: string) {
  const inlineScripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
    .filter(([, attributes, contents]) => !/\bsrc\s*=/.test(attributes) && contents.trim());
  expect(inlineScripts.length, "SSR must include structured data and hydration scripts").toBeGreaterThan(0);
  for (const [, attributes] of inlineScripts) {
    const scriptNonce = attributes.match(/\bnonce="([^"]+)"/)?.[1];
    expect(scriptNonce, "Every inline script must use the trusted response nonce").toBe(nonce);
  }
}

for (const route of publicRoutes) {
  test(`${route} renders its SEO and content without JavaScript`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    const page = await context.newPage();
    try {
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/TraceForge/);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).not.toHaveText("");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toBeTruthy();
      expect(new URL(canonical!).href).toBe(new URL(`${canonicalOrigin}${route}`).href);
      const description = await page.locator('meta[name="description"]').getAttribute("content");
      expect(description?.length).toBeGreaterThan(70);
      expect(description?.length).toBeLessThanOrEqual(170);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /TraceForge/);
      const openGraphUrl = await page.locator('meta[property="og:url"]').getAttribute("content");
      expect(openGraphUrl).toBeTruthy();
      expect(new URL(openGraphUrl!).href).toBe(new URL(`${canonicalOrigin}${route}`).href);
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");

      const structuredData = await page.locator('script[type="application/ld+json"]').allTextContents();
      expect(structuredData.length).toBeGreaterThan(0);
      for (const json of structuredData) {
        const data = JSON.parse(json) as { "@context": string; "@graph"?: { "@type": string; name?: string }[]; "@type"?: string };
        expect(data["@context"]).toBe("https://schema.org");
        expect(Boolean(data["@graph"]?.length || data["@type"])).toBeTruthy();
      }
      expect(structuredData.some((json) => JSON.parse(json)["@graph"]?.some((entry: { "@type": string; name?: string }) => entry["@type"] === "Organization" && entry.name === "TraceForge"))).toBe(true);
      if (route === "/") {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: ".next/foundation-desktop.png", fullPage: true });
        await page.setViewportSize({ width: 375, height: 812 });
        await page.screenshot({ path: ".next/foundation-mobile.png", fullPage: true });
      }
    } finally {
      await context.close();
    }
  });
}

test("public pages fit desktop and mobile viewports", async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const route of publicRoutes) {
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1")).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(dimensions.document, `${route} document width at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
      expect(dimensions.body, `${route} body width at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
      if (route === "/") {
        await page.screenshot({ path: `.next/foundation-${viewport.width === 375 ? "mobile" : "desktop"}.png`, fullPage: true });
      }
    }
  }
});

test("system themes and a persistent visitor override preserve the current report and readable controls", async ({ page, context }) => {
  let acquisitions = 0;
  await page.route("**/api/investigations", (route) => {
    acquisitions++;
    return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report: getBrowserReportFixture() }) + "\n" });
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/investigate");
  expect(await page.evaluate(() => localStorage.getItem("traceforge-theme"))).toBeNull();
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Synthetic browser test fixture", exact: true })).toBeVisible();

  for (const scheme of ["dark", "light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect.poll(async () => {
      const background = await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
      const mean = colorChannels(background).reduce((sum, value) => sum + value, 0) / 3;
      return scheme === "light" ? mean > 220 : mean < 35;
    }, { message: `The rendered ${scheme} background must follow the system preference` }).toBe(true);
    await expect.poll(() => page.locator(".engine-shell").evaluate((element) => getComputedStyle(element).colorScheme)).toBe(scheme);
    const colors = await renderedColors(page, {
      shell: ".engine-shell", form: "#investigation-form", help: "#token-help",
      input: "#token-address", action: "#investigation-form button[type=submit]",
    });
    const mean = colorChannels(colors.shell.background).reduce((sum, value) => sum + value, 0) / 3;
    expect(scheme === "light" ? mean > 220 : mean < 35).toBe(true);
    expect(contrast(colors.shell.text, colors.shell.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.help.text, colors.help.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.input.text, colors.input.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.input.border, colors.input.background), `${scheme} input boundary contrast`).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.action.text, colors.action.background)).toBeGreaterThanOrEqual(4.5);
    await expect(page.locator(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`)).toHaveAttribute("content", scheme === "dark" ? "#111319" : "#f7f6f2");
    await page.getByRole("button", { name: "Start investigation", exact: true }).hover();
    const hovered = (await renderedColors(page, { action: "#investigation-form button[type=submit]" })).action;
    expect(contrast(hovered.text, hovered.background)).toBeGreaterThanOrEqual(4.5);
    if (scheme === "light") {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: ".next/investigation-system-light-desktop.png", fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
    }
    await page.getByRole("heading", { level: 2, name: "Synthetic browser test fixture", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.next/investigation-system-${scheme}-${page.viewportSize()?.width === 1440 ? "desktop" : "mobile"}.png`, fullPage: true });
    await expect(page.getByLabel("Base token contract")).toHaveValue(browserFixture.token);
    await expect(page.getByRole("heading", { level: 2, name: "Synthetic browser test fixture", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Switch to ${scheme === "dark" ? "light" : "dark"} mode`, exact: true })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
  expect(acquisitions).toBe(1);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  await page.getByRole("button", { name: "Switch to light mode", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("traceforge-theme"))).toBe("light");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: "Switch to dark mode", exact: true })).toBeVisible();
    await expect(page.getByLabel("Base token contract")).toHaveValue(browserFixture.token);
    await expect(page.getByRole("heading", { level: 2, name: "Synthetic browser test fixture", exact: true })).toBeVisible();
  }
  const freshTab = await context.newPage();
  try {
    await freshTab.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await freshTab.goto("/investigate");
    await expect(freshTab.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(freshTab.getByRole("button", { name: "Switch to dark mode", exact: true })).toBeVisible();
    await expect(freshTab.getByLabel("Base token contract")).toHaveValue("");
    await expect(freshTab.getByRole("heading", { level: 2, name: "Synthetic browser test fixture", exact: true })).toHaveCount(0);
  } finally { await freshTab.close(); }
  expect(acquisitions).toBe(1);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage).sort(), session: sessionStorage.length }))).toEqual({ local: ["traceforge-theme"], session: 0 });
});

test("public document bodies and cards follow the system theme while intentional hero surfaces remain readable", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const route of publicRoutes) {
      await page.goto(route);
      const bodySelector = route === "/" ? ".questions-section" : ".document-body";
      const cardSelector = route === "/" ? ".question-card" : route === "/methodology" ? ".content-card" : ".source-card";
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const colors = await renderedColors(page, {
        section: bodySelector, paragraph: `${cardSelector} p:not(.eyebrow):not(.question-label)`,
      });
      expect(await page.locator("html").evaluate((element) => getComputedStyle(element).colorScheme)).toBe(scheme);
      const mean = colorChannels(colors.section.background).reduce((sum, value) => sum + value, 0) / 3;
      expect(scheme === "light" ? mean > 220 : mean < 35).toBe(true);
      expect(contrast(colors.section.text, colors.section.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.paragraph.text, colors.paragraph.background)).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("keyboard users can skip navigation and reach the main action", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Investigate a token", exact: true })).toBeFocused();
});

test("each HTML response enforces a fresh trusted CSP nonce", async ({ request }) => {
  const first = await request.get("/", {
    headers: { "x-nonce": "attacker-controlled", "Content-Security-Policy": "script-src 'unsafe-inline'" },
  });
  const second = await request.get("/");
  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
  const policy = first.headers()["content-security-policy"];
  expect(policy).toContain("'strict-dynamic'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
  const firstNonce = readNonce(policy);
  const secondNonce = readNonce(second.headers()["content-security-policy"]);
  expect(firstNonce).not.toBe(secondNonce);
  expect(firstNonce).not.toBe("attacker-controlled");
  assertInlineNonces(await first.text(), firstNonce);
  assertInlineNonces(await second.text(), secondNonce);
  expect(first.headers()["cache-control"]).toContain("no-store");
  expect(first.headers()["x-content-type-options"]).toBe("nosniff");
  expect(first.headers()["x-frame-options"]).toBe("DENY");
  expect(first.headers()["x-powered-by"]).toBeUndefined();
});

test("unknown routes cannot bypass CSP by resembling excluded endpoints", async ({ request }) => {
  for (const path of ["/robots.txt-extra", "/api/unknown"]) {
    const response = await request.get(path);
    expect(response.status(), `${path} must remain a genuine missing route`).toBe(404);
    const nonce = readNonce(response.headers()["content-security-policy"]);
    assertInlineNonces(await response.text(), nonce);
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});

test("client navigation works without browser errors or CSP violations", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__traceforgeCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Methodology", exact: true }).click();
  await expect(page).toHaveURL(/\/methodology$/);
  await expect(page.locator("h1")).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Sources", exact: true }).click();
  await expect(page).toHaveURL(/\/data-sources$/);
  await expect(page.locator("h1")).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "TraceForge home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("h1")).toBeVisible();
  const violations = await page.evaluate(() => (window as unknown as { __traceforgeCspViolations: string[] }).__traceforgeCspViolations);
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("social image is a valid 1200 by 630 PNG", async ({ request }) => {
  const response = await request.get("/opengraph-image");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const image = await response.body();
  expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(image.readUInt32BE(16)).toBe(1200);
  expect(image.readUInt32BE(20)).toBe(630);
});

test("browser metadata serves the generated tab and Apple icons as valid local images", async ({ page }) => {
  await page.goto("/investigate");
  const links = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll((elements) => elements.map((element) => {
    const link = element as HTMLLinkElement;
    return { href: link.href, rel: link.rel, type: link.type, sizes: link.sizes.value };
  }));
  const png = links.find((link) => new URL(link.href).pathname === "/icon.png");
  const ico = links.find((link) => new URL(link.href).pathname === "/favicon.ico");
  const svg = links.find((link) => new URL(link.href).pathname === "/icon.svg");
  const apple = links.find((link) => link.rel === "apple-touch-icon" && new URL(link.href).pathname === "/apple-icon.png");
  expect(png).toBeTruthy(); expect(ico).toBeTruthy(); expect(apple).toBeTruthy(); expect(svg).toBeTruthy();
  for (const [link, size] of [[png!, 512], [apple!, 180]] as const) {
    expect(link.sizes).toBe(`${size}x${size}`);
    expect(new URL(link.href).origin).toBe(new URL(page.url()).origin);
    const response = await page.request.get(link.href);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
    const image = await response.body();
    expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image.readUInt32BE(16)).toBe(size); expect(image.readUInt32BE(20)).toBe(size);
  }
  expect(new URL(ico!.href).origin).toBe(new URL(page.url()).origin);
  const response = await page.request.get(ico!.href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/image\/(?:x-icon|vnd\.microsoft\.icon)/);
  const image = await response.body();
  expect(image.readUInt16LE(0)).toBe(0); expect(image.readUInt16LE(2)).toBe(1);
  expect(image.readUInt16LE(4)).toBeGreaterThan(0);
  expect(image[6]).toBe(32); expect(image[7]).toBe(32);
  expect(new URL(svg!.href).origin).toBe(new URL(page.url()).origin);
  expect(svg!.sizes).toBe("any");
  const vector = await page.request.get(svg!.href);
  expect(vector.status()).toBe(200);
  expect(vector.headers()["content-type"]).toContain("image/svg+xml");
  expect(await vector.text()).toMatch(/<svg\b[^>]*viewBox=/);
  const brand = page.getByRole("banner").getByRole("link", { name: "TraceForge home" });
  await expect(brand.locator("svg.tf-brand-mark")).toBeVisible();
  await expect(brand.locator("path.tf-brand-trace")).toHaveAttribute("pathLength", "1");
  await expect(brand.locator("rect.tf-brand-node")).toHaveCount(3);
});

test("health exposes liveness without database or secret details", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect(await response.json()).toEqual({ status: "ok", service: "traceforce-engine", version: "0.1.0" });
  const unsupported = await request.post("/api/health", { data: { database: "check" } });
  expect(unsupported.status()).toBe(405);
});

test("default unconfigured deployment consistently excludes indexing", async ({ request }) => {
  for (const route of publicRoutes) {
    const response = await request.get(route);
    expect(response.headers()["x-robots-tag"]).toMatch(/noindex.*nofollow/);
    expect(await response.text()).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  }
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const rules = await robots.text();
  expect(rules).toMatch(/User-Agent:\s*\*/i);
  expect(rules).toMatch(/Disallow:\s*\/(?:\r?\n|$)/i);
  expect(rules).not.toMatch(/^Sitemap:/im);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain("<urlset");
  expect(xml).not.toMatch(/<url(?:\s|>)/);
});
