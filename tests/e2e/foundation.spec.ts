import { expect, test } from "@playwright/test";
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
  test(`${route} renders its SEO and content without JavaScript`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      const response = await page.goto(`http://127.0.0.1:3200${route}`);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/TraceForce Engine/);
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
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /TraceForce Engine/);
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
      expect(structuredData.some((json) => JSON.parse(json)["@graph"]?.some((entry: { "@type": string; name?: string }) => entry["@type"] === "Organization" && entry.name === "TraceForce Engine"))).toBe(true);
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

test("system light/dark changes preserve the current report and readable scan controls without an app theme setting", async ({ page }) => {
  let acquisitions = 0;
  await page.route("**/api/investigations", (route) => {
    acquisitions++;
    return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report: getBrowserReportFixture() }) + "\n" });
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Synthetic browser test fixture", exact: true })).toBeVisible();

  for (const scheme of ["dark", "light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Edge can update media/custom properties before their dependent colors,
    // even across two frames at mobile widths. Wait for the actual background
    // to follow the preference, then assert every original contrast boundary.
    await expect.poll(async () => {
      const background = await page.locator(".engine-shell").evaluate((element) => getComputedStyle(element).backgroundColor);
      const mean = colorChannels(background).reduce((sum, value) => sum + value, 0) / 3;
      return scheme === "light" ? mean > 220 : mean < 35;
    }, { message: `The rendered ${scheme} background must follow the system preference` }).toBe(true);
    await expect.poll(() => page.locator(".engine-shell").evaluate((element) => getComputedStyle(element).colorScheme)).toBe(scheme);
    const colors = await page.evaluate(() => {
      const shell = getComputedStyle(document.querySelector(".engine-shell")!);
      const form = getComputedStyle(document.querySelector("#investigation-form")!);
      const input = getComputedStyle(document.querySelector("#token-address")!);
      const action = getComputedStyle(document.querySelector(".engine-primary-fill")!);
      return { background: shell.backgroundColor, backgroundToken: shell.getPropertyValue("--background").trim(), text: shell.color, surface: form.backgroundColor,
        muted: getComputedStyle(document.querySelector("#token-help")!).color,
        input: input.backgroundColor, inputText: input.color, inputBorder: input.borderTopColor,
        action: action.backgroundColor, actionText: action.color };
    });
    const mean = colorChannels(colors.background).reduce((sum, value) => sum + value, 0) / 3;
    expect(scheme === "light" ? mean > 220 : mean < 35).toBe(true);
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.muted, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.inputText, colors.input)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.inputBorder, colors.input)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.actionText, colors.action)).toBeGreaterThanOrEqual(4.5);
    await expect(page.locator(`meta[name="theme-color"][media="(prefers-color-scheme: ${scheme})"]`)).toHaveAttribute("content", colors.backgroundToken);
    await page.getByRole("button", { name: "Start investigation", exact: true }).hover();
    const hovered = await page.locator(".engine-primary-fill").evaluate((element) => ({ text: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
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
    await expect(page.getByRole("button", { name: /theme|light mode|dark mode/i })).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 812 });
    const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
  expect(acquisitions).toBe(1);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("public document bodies and cards follow the system theme while intentional hero surfaces remain readable", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const route of publicRoutes) {
      await page.goto(route);
      const bodySelector = route === "/" ? ".questions-section" : ".document-body";
      const cardSelector = route === "/" ? ".question-card" : route === "/methodology" ? ".content-card" : ".source-card";
      const colors = await page.evaluate(({ bodySelector, cardSelector }) => {
        const section = getComputedStyle(document.querySelector(bodySelector)!);
        const card = getComputedStyle(document.querySelector(cardSelector)!);
        const paragraph = getComputedStyle(document.querySelector(`${cardSelector} p:not(.eyebrow):not(.question-label)`)!);
        return { scheme: getComputedStyle(document.documentElement).colorScheme,
          section: section.backgroundColor, text: section.color, card: card.backgroundColor, paragraph: paragraph.color };
      }, { bodySelector, cardSelector });
      expect(colors.scheme).toBe(scheme);
      const mean = colorChannels(colors.section).reduce((sum, value) => sum + value, 0) / 3;
      expect(scheme === "light" ? mean > 220 : mean < 35).toBe(true);
      expect(contrast(colors.text, colors.section)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.paragraph, colors.card)).toBeGreaterThanOrEqual(4.5);
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
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Data sources" }).click();
  await expect(page).toHaveURL(/\/data-sources$/);
  await expect(page.locator("h1")).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "TraceForce Engine home" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3200/");
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
    return { href: link.href, rel: link.rel, type: link.type };
  }));
  const png = links.find((link) => new URL(link.href).pathname === "/icon.png");
  const ico = links.find((link) => new URL(link.href).pathname === "/favicon.ico");
  const apple = links.find((link) => link.rel === "apple-touch-icon" && new URL(link.href).pathname === "/apple-icon.png");
  expect(png).toBeTruthy(); expect(ico).toBeTruthy(); expect(apple).toBeTruthy();
  for (const [link, size] of [[png!, 32], [apple!, 180]] as const) {
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
  await expect(page.getByRole("banner").getByRole("link", { name: "TraceForce Engine home" }).locator("img")).toHaveAttribute("src", "/brand/traceforce-mark.png");
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
