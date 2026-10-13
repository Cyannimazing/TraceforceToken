import { expect, test, type Locator, type Page } from "@playwright/test";

const collisionField = "[data-aceternity='background-beams-with-collision']";

async function headCoordinates(field: Locator) {
  return field.locator("[data-laser-head='0']").evaluate((head) => ({
    x: Number(head.getAttribute("cx")), y: Number(head.getAttribute("cy")),
  }));
}

async function assertMoving(field: Locator) {
  await field.scrollIntoViewIfNeeded();
  await expect(field).toHaveAttribute("data-motion", "running");
  const initial = await headCoordinates(field);
  await expect.poll(async () => {
    const next = await headCoordinates(field);
    return Math.hypot(next.x - initial.x, next.y - initial.y);
  }, { message: "The visible laser head must actually move", timeout: 4000 }).toBeGreaterThan(1);
}

async function assertSteady(field: Locator) {
  await expect(field).toHaveAttribute("data-motion", "paused");
  const first = await headCoordinates(field);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const second = await headCoordinates(field);
  expect(second).toEqual(first);
}

async function watchBrowserFailures(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const directives: string[] = [];
    Object.defineProperty(window, "__laserCspViolations", { value: directives });
    document.addEventListener("securitypolicyviolation", (event) => directives.push(event.violatedDirective));
  });
  return async () => {
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __laserCspViolations: string[] }).__laserCspViolations)).toEqual([]);
  };
}

for (const route of ["/", "/investigate"] as const) {
  test(`Aceternity laser on ${route} moves visibly, respects pause and leaves native controls usable`, async ({ page }) => {
    const checkFailures = await watchBrowserFailures(page);
    let scanRequests = 0;
    await page.route("**/api/investigations", (request) => { scanRequests++; return request.abort(); });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
    await page.goto(route);
    const field = page.locator(collisionField).first();
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("data-variant", route === "/" ? "hero" : "compact");
    await expect(field.locator("svg")).toHaveAttribute("aria-hidden", "true");
    expect(await field.locator("svg").evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    await assertMoving(field);
    await expect.poll(async () => Number(await field.locator("[data-laser-impact='0']").getAttribute("opacity")), {
      message: "The moving beam must visibly reach a target and produce an impact", timeout: 7000,
    }).toBeGreaterThan(0.05);

    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => page.locator(".engine-shell").evaluate((element) => getComputedStyle(element).colorScheme)).toBe(scheme);
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
        await field.scrollIntoViewIfNeeded();
        await assertMoving(field);
        const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
        expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
        await page.screenshot({ path: `.next/laser-${route === "/" ? "home" : "scan"}-${scheme}-${width === 375 ? "mobile" : "desktop"}.png` });
      }
    }

    const pause = page.getByRole("button", { name: "Pause visual effects", exact: true });
    await pause.click();
    await assertSteady(field);
    await page.getByRole("button", { name: "Resume visual effects", exact: true }).click();
    await assertMoving(field);
    if (route === "/") {
      await page.getByRole("link", { name: "Investigate a token", exact: true }).click();
      await expect(page).toHaveURL(/\/investigate$/);
      await expect(page.getByLabel("Base token contract")).toBeVisible();
    } else {
      const token = page.getByLabel("Base token contract");
      await token.fill("0x0000000000000000000000000000000000000001");
      await expect(token).toHaveValue("0x0000000000000000000000000000000000000001");
      await expect(token).toBeFocused();
    }
    expect(scanRequests).toBe(0);
    await checkFailures();
  });
}

test("laser heads stay still with reduced motion and resume when the system preference permits", async ({ page }) => {
  const checkFailures = await watchBrowserFailures(page);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  for (const route of ["/", "/investigate"] as const) {
    await page.goto(route);
    const field = page.locator(collisionField).first();
    await expect(field).toBeVisible();
    await assertSteady(field);
    await expect(page.getByRole("button", { name: "Pause visual effects", exact: true })).toBeDisabled();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await assertMoving(field);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await assertSteady(field);
  }
  await checkFailures();
});

test("laser work pauses offscreen and on a simulated document visibility change", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "dark" });
  await page.goto("/");
  const field = page.locator(collisionField).first();
  await assertMoving(field);
  await page.locator("footer").scrollIntoViewIfNeeded();
  await assertSteady(field);
  await field.scrollIntoViewIfNeeded();
  await assertMoving(field);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await assertSteady(field);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await assertMoving(field);
});
