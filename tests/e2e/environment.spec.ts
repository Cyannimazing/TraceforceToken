import { expect, test } from "@playwright/test";

test("persistent environment animates its articulated crawler without capturing page interactions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const network = page.getByTestId("traceforge-network"), stage = page.getByTestId("traceforge-crawler"), rig = stage.locator("[data-crawler-rig]");
  await expect(network).toBeVisible(); await expect(stage).toHaveAttribute("data-motion", "active");
  await expect(rig).toHaveAttribute("visibility", "visible");
  expect(await stage.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  await expect(stage.locator("[data-crawler-leg]")).toHaveCount(6);
  const firstPose = await rig.getAttribute("transform");
  await expect.poll(() => rig.getAttribute("transform")).not.toBe(firstPose);
  const leg = stage.locator("[data-crawler-leg]").first(), initialLeg = await leg.getAttribute("d");
  await expect.poll(() => leg.getAttribute("d")).not.toBe(initialLeg);
  await page.getByRole("button", { name: "Hide robotic crawler" }).click();
  await expect(rig).toHaveAttribute("visibility", "hidden");
  await page.getByRole("button", { name: "Show robotic crawler" }).click();
  await expect(rig).toHaveAttribute("visibility", "visible");
  await network.evaluate((element) => element.setAttribute("data-persistence-proof", "same-canvas"));
  await page.getByRole("link", { name: "Methodology", exact: true }).first().click();
  await expect(network).toHaveAttribute("data-persistence-proof", "same-canvas");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("reduced motion stops ambient and crawler motion while preserving an operable hide control", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/");
  const stage = page.getByTestId("traceforge-crawler"), rig = stage.locator("[data-crawler-rig]");
  await expect(stage).toHaveAttribute("data-motion", "reduced");
  await expect(rig).toHaveAttribute("visibility", "visible");
  const first = await rig.getAttribute("transform"); await page.waitForTimeout(250);
  expect(await rig.getAttribute("transform")).toBe(first);
  await page.getByRole("button", { name: "Hide robotic crawler" }).click(); await expect(rig).toHaveAttribute("visibility", "hidden");
  await page.getByRole("button", { name: "Show robotic crawler" }).click(); await expect(rig).toHaveAttribute("visibility", "visible");
});

test("crawler protects viewport controls even after many earlier offscreen nodes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const rig = page.getByTestId("traceforge-crawler").locator("[data-crawler-rig]");
  await expect(rig).toHaveAttribute("visibility", "visible");
  await page.evaluate(() => {
    const earlier = document.createElement("div");
    earlier.id = "offscreen-crawler-fixture";
    for (let index = 0; index < 1000; index++) { const paragraph = document.createElement("p"); paragraph.hidden = true; earlier.append(paragraph); }
    document.body.prepend(earlier);
    // Test CSS uses the existing same-origin stylesheet, with no inline style
    // or production policy change. Covering every safe area must hide the rig.
    const sheet = [...document.styleSheets].find((entry) => entry.href?.startsWith(location.origin))!;
    sheet.insertRule(".crawler-fixture-control{position:fixed;inset:0;width:100vw;height:100vh;margin:0;z-index:60}", sheet.cssRules.length);
    const control = document.createElement("button");
    control.id = "crawler-fixture-control";
    control.className = "crawler-fixture-control";
    control.textContent = "Protected control";
    document.body.append(control);
  });
  await expect(rig).toHaveAttribute("visibility", "hidden");
  await page.evaluate(() => { document.getElementById("crawler-fixture-control")?.remove(); document.getElementById("offscreen-crawler-fixture")?.remove(); });
  await expect(rig).toHaveAttribute("visibility", "visible");
});
