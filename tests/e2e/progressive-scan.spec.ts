import { expect, test, type Page } from "@playwright/test";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";
import { AI_RATE_LIMIT_SCAN_MESSAGE } from "../../src/domain/investigations/scan";

type SyntheticStream = { send: (event: unknown) => void; close: () => void; cancelled: boolean; requests: number };

async function openPendingScan(page: Page) {
  await page.addInitScript(() => {
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
          fixture.send({ type: "progress", stage: "Starting a fresh Base investigation" });
        },
        cancel() { fixture.cancelled = true; },
      }), { headers: { "content-type": "application/x-ndjson" } });
    };
  });
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  const loading = page.locator("[data-scan-progress]");
  await expect(loading).toHaveAttribute("data-scan-stage", "starting");
  return loading;
}

for (const outcome of ["failed", "cancelled"] as const) {
  test(`synthetic compact loader: human phases and elapsed time survive heartbeats before ${outcome} without fake progress`, async ({ page }) => {
    const mobile = outcome === "cancelled";
    if (mobile) await page.setViewportSize({ width: 393, height: 852 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      const checks = { cspViolations: 0 };
      Object.defineProperty(window, "__syntheticLoaderChecks", { value: checks });
      document.addEventListener("securitypolicyviolation", () => { checks.cspViolations++; });
    });
    const loading = await openPendingScan(page), timer = loading.getByRole("timer"), progress = loading.getByRole("progressbar");
    await expect(timer).toHaveAttribute("aria-live", "off");
    await expect(progress).not.toHaveAttribute("aria-valuenow");
    await expect(loading.getByRole("status")).toContainText("Checking the token");
    await expect(page.getByRole("button", { name: "Investigating...", exact: true })).toBeDisabled();
    const initialTime = await timer.locator("time").innerText();
    await expect(timer.locator("time")).not.toHaveText(initialTime, { timeout: 4000 });
    const elapsedBefore = Number((await timer.locator("time").getAttribute("datetime"))!.slice(2, -1));
    for (const phase of [
      { raw: "Base token crawl: indexed page 1; 0 verified token transfers", stage: "history", title: "Checking wallet activity" },
      { raw: "Tracing observed native funding within the pinned window", stage: "funding", title: "Checking where the money came from" },
      { raw: "Checking pinned holder balances after funding investigation", stage: "checking", title: "Checking balances and trades" },
      { raw: "Analyzing the freshly collected evidence", stage: "analyzing", title: "Putting the findings together" },
      { raw: "Waiting for the AI explanation slot", stage: "waiting", title: "Preparing your report" },
      { raw: "Writing the plain English investigation explanation", stage: "explaining", title: "Finishing your report" },
      { raw: "Synthetic unknown provider diagnostics 370 balance calls", stage: "investigating", title: "Checking the token" },
    ]) {
      await page.evaluate((stage) => (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan.send({ type: "progress", stage }), phase.raw);
      await expect(loading).toHaveAttribute("data-scan-stage", phase.stage);
      await expect(loading.getByRole("status")).toContainText(phase.title);
      await expect(loading).not.toContainText(phase.raw);
      await expect(loading).not.toContainText(/\b(?:crawl|index|indexed|provider|genesis|finalized|block|slot|acquisition)\b/i);
    }
    // Repeated heartbeats keep one loader and the same elapsed clock.
    await page.evaluate(() => {
      const fixture = (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan;
      for (let i = 0; i < 3; i++) fixture.send({ type: "progress", stage: "Checking pinned holder balances after funding investigation" });
    });
    await expect(loading).toHaveCount(1);
    await expect(loading).toHaveAttribute("data-scan-stage", "checking");
    const elapsedAfter = Number((await timer.locator("time").getAttribute("datetime"))!.slice(2, -1));
    expect(elapsedAfter).toBeGreaterThanOrEqual(elapsedBefore);
    expect(await loading.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    await loading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.artifacts/token240459-synthetic-loading-${mobile ? "mobile" : "desktop"}.png`, animations: "disabled" });
    if (outcome === "cancelled") await page.getByRole("button", { name: "Cancel investigation", exact: true }).click();
    else await page.evaluate(() => {
      const fixture = (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan;
      fixture.send({ type: "error", error: "The investigation could not finish. Please try again shortly." }); fixture.close();
    });
    const alert = page.locator("#investigation-form").getByRole("alert");
    await expect(alert).toContainText(outcome === "cancelled" ? "Investigation cancelled" : "The investigation could not finish");
    await expect(loading).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start investigation", exact: true })).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save in this browser", exact: true })).toHaveCount(0);
    await alert.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.artifacts/token240459-synthetic-${outcome}-${mobile ? "mobile" : "desktop"}.png`, animations: "disabled" });
    expect(await page.evaluate(() => (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan.requests)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __syntheticLoaderChecks: { cspViolations: number } }).__syntheticLoaderChecks.cspViolations)).toBe(0);
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
  test(`synthetic progressive scan: AI quota retains incomplete evidence and waits for reset at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openAnalysisPreview(page);
    const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
    await graph.getByRole("button", { name: `Select wallet ${browserFixture.walletA}`, exact: true }).click();
    const rawDiagnostics = "Synthetic provider quota diagnostics must not appear in the report.";
    await page.evaluate((error) => {
      const fixture = (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan;
      fixture.send({ type: "error", code: "AI_RATE_LIMITED", error }); fixture.close();
    }, rawDiagnostics);
    const alert = page.locator("#investigation-form").getByRole("alert"), previewNotice = page.locator("[data-ai-rate-limit-preview]");
    await expect(alert).toHaveAttribute("data-scan-error-code", "AI_RATE_LIMITED");
    await expect(alert).toHaveText(AI_RATE_LIMIT_SCAN_MESSAGE);
    await expect(previewNotice).toHaveText("Evidence preview only. The AI explanation has not been generated. Wait for the AI limit to reset before trying again.");
    await expect(page.getByText(rawDiagnostics, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Evidence preview only. The required AI explanation did not finish; start a fresh scan to complete the report.", { exact: true })).toHaveCount(0);
    await expect(previewNotice).not.toContainText(/\b\d+\s*(?:seconds?|minutes?|hours?|days?)\b/i);
    await expect(graph).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear address filter", exact: true })).toBeVisible();
    await expect(page.locator("[data-scan-progress]")).toHaveCount(0);
    await assertIncompleteActions(page);
    await expect(page.getByTestId("ai-summary-text")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start investigation", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan.requests)).toBe(1);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    await previewNotice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.next/investigation-ai-rate-limited-${viewport.width === 375 ? "mobile" : "desktop"}.png`, animations: "disabled" });

    // The notice belongs to this failed request, not every later scan.
    await page.getByRole("button", { name: "Clear report", exact: true }).click();
    await expect(alert).toHaveCount(0); await expect(previewNotice).toHaveCount(0);
    await page.getByRole("button", { name: "Start investigation", exact: true }).click();
    await expect(page.getByText("Evidence is ready. The required AI explanation is still being prepared.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel investigation", exact: true }).click();
    await expect(alert).toContainText("Investigation cancelled");
    await expect(alert).not.toHaveAttribute("data-scan-error-code");
    await expect(page.getByText("Evidence preview only. The required AI explanation did not finish; start a fresh scan to complete the report.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __syntheticProgressiveScan: SyntheticStream }).__syntheticProgressiveScan.requests)).toBe(2);
  });
}

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
  await expect(page.getByRole("heading", { name: "Report assessment", exact: true })).toHaveCount(0);
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
  await expect(page.getByRole("heading", { name: "Report assessment", exact: true })).toBeVisible();
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
