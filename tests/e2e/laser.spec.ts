import { expect, test, type Locator, type Page } from "@playwright/test";

// The redesign replaces the laser with a persistent pixel/network canvas.
// Verify actual pixels rather than trusting a motion-state label.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
      // Chromium can migrate a GPU-backed canvas after getImageData reads,
      // changing alpha-rounding even when the app has not painted again.
      // Request a stable readback backing only for this pixel-level test;
      // production retains its normal accelerated rendering context.
      if (args[0] === "2d" && this.dataset.testid === "traceforge-network") args[1] = { ...args[1], willReadFrequently: true };
      return original.apply(this, args);
    } as typeof original;
  });
});

async function fingerprint(canvas: Locator) {
  return canvas.evaluate((element) => {
    const field = element as HTMLCanvasElement;
    const bytes = field.getContext("2d")!.getImageData(0, 0, field.width, field.height).data;
    let hash = 2166136261;
    for (let index = 0; index < bytes.length; index += 127) hash = Math.imul(hash ^ bytes[index], 16777619);
    return hash >>> 0;
  });
}
async function assertMoving(canvas: Locator) {
  const first = await fingerprint(canvas);
  await expect.poll(() => fingerprint(canvas), { timeout: 5000 }).not.toBe(first);
}
async function assertSteady(canvas: Locator) {
  // A paint queued before the preference changed may finish once.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const first = await fingerprint(canvas);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(await fingerprint(canvas)).toBe(first);
}
async function watchFailures(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.addInitScript(() => {
    const directives: string[] = [];
    Object.defineProperty(window, "__ambientCsp", { value: directives });
    document.addEventListener("securitypolicyviolation", (event) => directives.push(event.violatedDirective));
  });
  return async () => {
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __ambientCsp: string[] }).__ambientCsp)).toEqual([]);
  };
}
for (const route of ["/", "/investigate"] as const) {
  test(`pixel network on ${route} visibly animates, pauses and leaves controls usable`, async ({ page }) => {
    const checkFailures = await watchFailures(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(route);
    const field = page.getByTestId("traceforge-network");
    await expect(field).toBeVisible();
    expect(await field.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    await assertMoving(field);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
      await assertMoving(field);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.getByRole("button", { name: "Pause visual effects", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
    await assertSteady(field);
    await page.getByRole("button", { name: "Resume visual effects", exact: true }).click();
    await assertMoving(field);
    if (route === "/") {
      await page.getByRole("link", { name: "Investigate a token", exact: true }).first().click();
      await expect(page).toHaveURL(/\/investigate$/);
    }
    await page.getByLabel("Base token contract").fill("0x0000000000000000000000000000000000000001");
    await expect(page.getByLabel("Base token contract")).toBeFocused();
    await checkFailures();
  });
}
test("ambient pixels follow reduced motion and resume when it is disabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const field = page.getByTestId("traceforge-network");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
  await assertSteady(field);
  await expect(page.getByRole("button", { name: "Pause visual effects", exact: true })).toBeDisabled();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await assertMoving(field);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
  await assertSteady(field);
});
test("persistent ambient work stops while the document is hidden", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const field = page.getByTestId("traceforge-network");
  await assertMoving(field);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute("data-visibility", "hidden");
  await assertSteady(field);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await assertMoving(field);
});
