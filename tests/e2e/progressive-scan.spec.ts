import { expect, test, type Page } from "@playwright/test";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";

type SyntheticStream = { send: (event: unknown) => void; close: () => void; cancelled: boolean; requests: number };

/** Browser-only transport fixture. No provider, model or application fallback participates. */
async function openAnalysisPreview(page: Page) {
  const report = getBrowserReportFixture(), analysis = { ...report };
  Reflect.deleteProperty(analysis, "explanation");
  await page.addInitScript(({ analysis }) => {
    const original = window.fetch.bind(window), encoder = new TextEncoder();
    const fixture: SyntheticStream = { send: () => undefined, close: () => undefined, cancelled: false, requests: 0 };
    Object.defineProperty(window, "__syntheticProgressiveScan", { value: fixture });
    window.fetch = async (input, init) => {
      if (String(input) !== "/api/investigations") return original(input, init);
      fixture.requests++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          fixture.send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          fixture.close = () => controller.close();
          fixture.send({ type: "progress", stage: "Synthetic fixture: evidence collection completed" });
          fixture.send({ type: "analysis", report: analysis });
          fixture.send({ type: "progress", stage: "Synthetic fixture: required model generation pending" });
        },
        cancel() { fixture.cancelled = true; },
      }), { headers: { "content-type": "application/x-ndjson" } });
    };
  }, { analysis });
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic browser test fixture", level: 2, exact: true })).toBeVisible();
  await expect(page.getByText("Evidence is ready. The required AI explanation is still being prepared.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeFocused();
  return report;
}

async function assertIncompleteActions(page: Page) {
  await expect(page.getByRole("button", { name: "Save in this browser", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download JSON", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download card", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy token link", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Questions about this token", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Explanation in plain English", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export graph SVG", exact: true })).toBeDisabled();
}

test("synthetic progressive scan: actual analysis is inspectable before required AI and completion preserves its wallet filter", async ({ page }) => {
  const report = await openAnalysisPreview(page);
  await assertIncompleteActions(page);
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  await expect(graph).toBeVisible();
  await graph.getByRole("button", { name: `Select wallet ${browserFixture.walletA}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear address filter", exact: true })).toBeVisible();
  await page.screenshot({ path: ".next/investigation-analysis-preview-desktop.png" });
  await page.getByRole("button", { name: "Clear address filter", exact: true }).focus();
  expect(await page.evaluate(() => (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan.requests)).toBe(1);
  await page.evaluate((report) => {
    const fixture = (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan;
    fixture.send({ type: "report", report, chatContext: "synthetic-progressive-completed-chat-context" }); fixture.close();
  }, report);
  await expect(page.getByRole("heading", { name: "Explanation in plain English", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save in this browser", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download JSON", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Questions about this token", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear address filter", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear address filter", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Export graph SVG", exact: true })).toBeEnabled();
  await expect(page.getByText("No reports saved in this browser.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

for (const outcome of ["failed", "cancelled"] as const) {
  test(`synthetic progressive scan: ${outcome} AI retains clearly incomplete evidence without chat or save`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openAnalysisPreview(page);
    if (outcome === "cancelled") await page.getByRole("button", { name: "Cancel investigation", exact: true }).click();
    else await page.evaluate(() => {
      const fixture = (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan;
      fixture.send({ type: "error", error: "Synthetic fixture: required AI did not finish." }); fixture.close();
    });
    await expect(page.locator("#investigation-form").getByRole("alert")).toContainText(outcome === "cancelled" ? "Investigation cancelled" : "Synthetic fixture: required AI did not finish.");
    await expect(page.getByText("Evidence preview only. The required AI explanation did not finish; start a fresh scan to complete the report.", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Observed relationships", exact: true })).toBeVisible();
    await assertIncompleteActions(page);
    await expect(page.getByRole("button", { name: "Start investigation", exact: true })).toBeEnabled();
    if (outcome === "cancelled") await expect.poll(() => page.evaluate(() => (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan.cancelled)).toBe(true);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    await page.screenshot({ path: `.next/investigation-analysis-preview-${outcome}-mobile.png` });
  });
}
