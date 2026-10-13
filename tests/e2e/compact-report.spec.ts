import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { browserFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";
import { expectedDecisionWeights } from "../fixtures/decision-weights";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import type { Hash } from "../../src/domain/investigations/types";

test.use({ colorScheme: "dark", reducedMotion: "reduce" });

async function openSyntheticReport(page: Page, report = getBrowserWalletFlagsFixture({ contractDominated: true })) {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__compactReportCsp", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));
  });
  await page.route("**/api/investigations", (route) => route.fulfill({
    status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "report", report })}\n`,
  }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("region", { name: "Score", exact: true })).toBeVisible();
  return report;
}

async function assertContained(panel: Locator) {
  const layout = await panel.evaluate((element) => {
    const panelBox = element.getBoundingClientRect();
    const visible = [...element.querySelectorAll("dt, dd, summary, svg")].filter((child) => child.getClientRects().length > 0);
    return {
      height: panelBox.height,
      unclipped: visible.every((child) => {
        const box = child.getBoundingClientRect();
        return box.left >= panelBox.left - 1 && box.right <= panelBox.right + 1;
      }),
    };
  });
  expect(layout.unclipped).toBe(true);
  await expect(panel.locator("[style]")).toHaveCount(0);
  return layout.height;
}

test("compact score, verdict and gauge keep real values readable with details folded on desktop and mobile", async ({ page }) => {
  const report = await openSyntheticReport(page), assessment = assessInvestigationReport(report);
  const gauge = page.getByRole("region", { name: "Score", exact: true });
  const verdict = page.getByRole("region", { name: "VERDICT OUTPUT", exact: true });
  const score = page.getByRole("region", { name: "Score breakdown", exact: true });
  const categories = score.getByLabel("Category scores", { exact: true });
  await expect(categories.locator("[data-category-id]")).toHaveCount(6);
  for (const category of assessment.categories) {
    const row = categories.locator(`[data-category-id="${category.id}"]`);
    await expect(row).toContainText(`${category.points ?? 0}/${category.possiblePoints}`);
    await expect(row.locator("dt")).toHaveText(category.label);
    await expect(row.locator("dt")).toHaveCSS("text-transform", "lowercase");
    await expect(row).toHaveAttribute("data-score-points", String(category.points ?? 0));
    await expect(row).toHaveAttribute("data-assessment-status", category.status);
    const fill = row.locator("svg rect.fill-foreground");
    await expect(fill).toHaveCount(category.points !== null && category.points > 0 ? 1 : 0);
    if (category.points !== null && category.points > 0) expect(Number(await fill.getAttribute("width"))).toBeCloseTo(category.points / category.possiblePoints * 100, 8);
  }
  const decisionWeights = verdict.getByLabel("Verdict decision weights", { exact: true });
  await expect(decisionWeights.locator("dt")).toHaveText(["avoid", "caution", "ok"]);
  const expected = expectedDecisionWeights(assessment), displayed = await decisionWeights.locator("dd").allTextContents();
  expect(displayed.reduce((sum, value) => sum + Math.round(parseFloat(value) * 10), 0)).toBe(1000);
  for (const [index, weight] of Object.values(expected.weights).entries()) {
    expect(Math.abs(parseFloat(displayed[index]) / 100 - weight)).toBeLessThanOrEqual(0.001);
    const bar = decisionWeights.locator("dd").nth(index).locator("svg rect").nth(1);
    expect(Number(await bar.getAttribute("width"))).toBeCloseTo(weight * 100, 8);
  }
  const xray = verdict.getByRole("region", { name: "DECISION X-RAY", exact: true });
  const total = xray.locator("[data-total-mass]");
  expect(Number(await total.getAttribute("data-total-mass"))).toBeCloseTo(expected.total, 10);
  expect(Number(await total.getAttribute("data-selected-mass"))).toBeCloseTo(expected.masses.avoid, 10);
  await expect(verdict.getByText("AVOID", { exact: true }).first()).toBeVisible();
  await expect(verdict.getByLabel("Verdict receipt", { exact: true })).not.toBeVisible();
  await expect(gauge.locator("details > summary")).toHaveText(["Details"]);
  await expect(score.locator("details > summary")).toHaveText(["Details"]);
  const scoreDetails = score.locator("details[data-score-details]");
  await expect(scoreDetails).toHaveJSProperty("open", false);
  const measurements: { width: number; gauge: number; verdict: number; score: number }[] = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(gauge.getByText(String(assessment.displayedScore), { exact: true })).toBeVisible();
    await expect(gauge.getByText("/ 100 · PARTIAL", { exact: true })).toBeVisible();
    await expect(gauge.getByText("12 wallets · 0 linked groups", { exact: true })).toBeVisible();
    await expect(gauge.getByText("DANGER", { exact: true })).toBeVisible();
    const heights = { gauge: await assertContained(gauge), verdict: await assertContained(verdict), score: await assertContained(score) };
    expect(heights.gauge).toBeLessThan(414);
    expect(heights.verdict).toBeLessThan(650);
    expect(heights.score).toBeLessThan(500);
    measurements.push({ width: viewport.width, ...heights });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await mkdir(".artifacts/compact-report", { recursive: true });
    for (const [name, panel] of [["gauge", gauge], ["verdict", verdict], ["score", score]] as const) {
      await panel.screenshot({ path: `.artifacts/compact-report/${name}-${viewport.width}.png` });
    }
    const sidebar = page.locator(".traceforce-report-overview > aside");
    // Keep the whole sidebar inside the viewport so a sticky page header is
    // outside this panel capture, just as it is for each individual card.
    const captureHeight = await sidebar.evaluate((element) => Math.ceil(
      element.getBoundingClientRect().height + (document.querySelector("header")?.getBoundingClientRect().height ?? 0) + 80,
    ));
    await page.setViewportSize({ ...viewport, height: captureHeight });
    await sidebar.evaluate((element) => window.scrollTo({
      top: element.getBoundingClientRect().top + window.scrollY - (document.querySelector("header")?.getBoundingClientRect().height ?? 0) - 16,
      behavior: "instant",
    }));
    await sidebar.screenshot({ path: `.artifacts/compact-report/sidebar-${viewport.width}.png` });
    await page.setViewportSize(viewport);
  }
  await writeFile(".artifacts/compact-report/measurements.json", JSON.stringify({
    synthetic: true, assessmentVersion: assessment.version, displayedScore: assessment.displayedScore,
    earnedPoints: assessment.assessedPoints, scoreRange: assessment.scoreRange,
    decisionWeights: expected.weights, measurements,
  }, null, 2));
  const summary = scoreDetails.locator("summary").first();
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(scoreDetails).toHaveJSProperty("open", true);
  for (const category of assessment.categories.filter((category) => category.points === null)) {
    const details = scoreDetails.locator(`[data-category-details="${category.id}"]`);
    await expect(details).toContainText(`Earned points: 0/${category.possiblePoints} · not assessed`);
    await expect(details).toContainText(category.metric === null ? "Measurement unavailable" : "numeric score not established");
  }
  expect(await page.evaluate(() => (window as unknown as { __compactReportCsp: string[] }).__compactReportCsp)).toEqual([]);
});

test("one observed funding group does not turn eleven wallets into six inferred owners", async ({ page }) => {
  const original = getBrowserWalletFlagsFixture();
  const funding = original.evidence.find((event) => event.kind === "funding")!;
  const otherRecipients = original.walletActivitySnapshot!.rows.filter((row) => row.address !== funding.from && row.address !== funding.to).slice(0, 4);
  const additionalFunding = otherRecipients.map((row, index) => ({ ...funding,
    id: `synthetic-linked-funding-${index}`, to: row.address,
    transactionHash: `0x${(20_000 + index).toString(16).padStart(64, "0")}` as Hash,
    transactionIndex: index + 1,
  }));
  const analysis = analyzeInvestigation({ ...original, evidence: [...original.evidence, ...additionalFunding],
    pools: original.infrastructure!.pools, hubs: original.infrastructure!.hubs,
  }, { id: original.id, generatedAt: original.generatedAt });
  const report = validateExplainedReport({ ...analysis, explanation: { ...original.explanation,
    context: { ...original.explanation.context, omittedEvidence: analysis.evidence.length - original.explanation.context.suppliedEvidence },
  } });
  expect(report.groups).toHaveLength(1);
  expect(report.groups[0].wallets).toHaveLength(6);
  await openSyntheticReport(page, report);
  const gauge = page.getByRole("region", { name: "Score", exact: true });
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  const holders = page.getByRole("region", { name: "Top holders", exact: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(gauge.getByText("11 wallets · 1 linked group", { exact: true })).toBeVisible();
    await expect(graph.getByText("11 wallets · 1 linked group", { exact: true })).toBeVisible();
    const linkExplanation = gauge.locator("p").filter({ hasText: "6 linked · 5 unlinked in this scan" });
    await expect(linkExplanation).toBeVisible();
    await expect(linkExplanation).toContainText("Links do not prove the same owner.");
    await expect(gauge).not.toContainText(/\bhands\b|real owners|real people/i);
    await expect(graph).not.toContainText(/\bhands\b|real owners|real people/i);
    await expect(holders.getByRole("table", { name: "Top holders", exact: true }).locator("tbody tr")).toHaveCount(11);
    await expect(holders).toContainText("12 positive addresses checked: 11 wallets + 1 pool/burn address");
    await expect(graph.locator("svg[data-graph-view='wallets'] [data-node-address]")).toHaveCount(11);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
});
