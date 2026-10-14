import { expect, test } from "@playwright/test";

const publicRoutes = ["/", "/methodology", "/data-sources"];

test("editorial public pages remain readable and navigable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    for (const route of publicRoutes) {
      const response = await page.goto("http://127.0.0.1:3200" + route);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/TraceForge/);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toBeVisible();
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toBeTruthy();
      expect(new URL(canonical!).pathname).toBe(route);
      await expect(page.getByRole("navigation", { name: "Footer navigation" }).getByRole("link", { name: "Investigate" })).toHaveAttribute("href", "/investigate");
    }
    await page.locator("#nansen summary").click();
    await expect(page.locator("#nansen")).toContainText("Restricted Smart Money datasets");
    await page.locator("#arkham summary").click();
    await expect(page.locator("#arkham")).toContainText("No enabled provider calls");
    await expect(page.locator("#rugcheck")).toContainText("Base support unconfirmed");
  } finally { await context.close(); }
});

test("public layouts fit mobile and desktop in both themes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"] as const) {
    await page.goto("/");
    await page.evaluate((value) => { localStorage.setItem("traceforge-theme", value); document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 1000 }]) {
      await page.setViewportSize(viewport);
      for (const route of publicRoutes) {
        await page.goto(route);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("h1")).toBeVisible();
        const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
        expect(width.page, route + " in " + theme + " at " + viewport.width).toBeLessThanOrEqual(width.viewport + 1);
        expect(await page.locator(".tf-public").locator("[style]").count()).toBe(0);
      }
    }
  }
});

test("home illustration is labeled and the main action opens the actual investigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#tf-network-caption")).toContainText("Illustrative network");
  await page.getByRole("link", { name: "Investigate a token", exact: true }).first().click();
  await expect(page).toHaveURL(/\/investigate$/);
  await expect(page.getByLabel("Base token contract")).toBeVisible();
});

test("unknown and retired report addresses preserve useful navigation and do not perform report lookups", async ({ page, request }) => {
  let lookups = 0;
  page.on("request", (operation) => { if (/\/api\/investigations/.test(operation.url())) lookups++; });
  const missing = await page.goto("/this-trail-does-not-exist");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("An uncharted");
  await expect(page.getByRole("link", { name: "Return home", exact: true })).toHaveAttribute("href", "/");
  await page.goto("/investigations/11111111-1111-4111-8111-111111111111");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Reports stay");
  await expect(page.getByRole("link", { name: "Open investigations", exact: true })).toHaveAttribute("href", "/investigate");
  const retired = await request.get("/api/investigations/11111111-1111-4111-8111-111111111111");
  expect(retired.status()).toBe(410);
  expect(lookups).toBe(0);
});
