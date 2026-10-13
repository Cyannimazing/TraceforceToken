import { expect, test } from "@playwright/test";
import { browserFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { expectedDecisionWeights } from "../fixtures/decision-weights";

test.use({ colorScheme: "dark" });

for (const contractDominated of [false, true]) {
  test(`the ${contractDominated ? "contract" : "creator"} concern report distinguishes earned points from its possible score`, async ({ page }) => {
    const report = getBrowserWalletFlagsFixture({ contractDominated });
    const assessment = assessInvestigationReport(report), expected = expectedDecisionWeights(assessment);
    // Independently worked examples of the disclosed 1.3 policy. These fixtures
    // have exact integer balances: 99,000 wallet Float in the creator case and
    // 14,355 wallet Float after excluding the contract in the second case.
    // A blank creator identity leaves both insiders and dev unassessed.
    const knownExample = contractDominated
      ? { points: [0, 20, null, 0, 6.7, null], earned: 26.7, displayed: 27, measured: 75 }
      : { points: [0, 20, 14.2, 0, 9.4, 0], earned: 43.6, displayed: 44, measured: 100 };
    expect(assessment.categories.map((category) => category.points)).toEqual(knownExample.points);
    expect(assessment.assessedPoints).toBe(knownExample.earned);
    expect(assessment.displayedScore).toBe(knownExample.displayed);
    expect(assessment.assessedPossiblePoints).toBe(knownExample.measured);
    expect(assessment.overallScore).toBe(contractDominated ? null : 44);
    const { minimum, maximum } = assessment.scoreRange;
    await page.route("**/api/investigations", (route) => route.fulfill({
      status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n",
    }));
    await page.goto("/investigate");
    await page.getByLabel("Base token contract").fill(browserFixture.token);
    await page.getByRole("button", { name: "Start investigation", exact: true }).click();
    const gauge = page.getByRole("region", { name: "Score", exact: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport);
      await expect(gauge.getByText(String(assessment.displayedScore), { exact: true })).toBeVisible();
      await expect(gauge.getByText(assessment.overallScore === null ? "/ 100 · PARTIAL" : "/ 100", { exact: true })).toBeVisible();
      const range = gauge.getByLabel("Score range", { exact: true });
      await expect(range).not.toBeVisible();
      await gauge.locator("details > summary").click();
      await expect(range).toHaveText(`Possible score: ${minimum}–${maximum} · ${assessment.overallScore === null ? "incomplete" : "assessed"}`);
      await expect(range).toBeVisible();
      const geometry = await range.evaluate((element) => {
        const box = element.getBoundingClientRect(), panel = element.closest("section")!.getBoundingClientRect();
        return { fits: box.left >= panel.left && box.right <= panel.right, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      });
      expect(geometry).toEqual({ fits: true, overflow: false });
      await expect(gauge.getByText("DANGER", { exact: true })).toBeVisible();
      await gauge.locator("details > summary").click();
    }
    const verdict = page.getByRole("region", { name: "VERDICT OUTPUT", exact: true });
    await expect(verdict.getByText("AVOID", { exact: true }).first()).toBeVisible();
    await verdict.locator("details > summary").first().click();
    const receipt = JSON.parse(await verdict.getByLabel("Verdict receipt", { exact: true }).innerText());
    expect(receipt).toMatchObject({ model: "traceforce-judge-1.0.0", confidence: null, weight_kind: "normalized-rule-weights", score: assessment.displayedScore, earned_points: assessment.assessedPoints, score_range: { minimum, maximum } });
    for (const key of ["avoid", "caution", "ok"] as const) expect(receipt.p[key]).toBeCloseTo(expected.weights[key], 10);
    const xray = verdict.getByRole("region", { name: "DECISION X-RAY", exact: true });
    await expect(xray).toBeVisible();
    await expect(xray).toContainText(/normali[sz]ed/);
    const displayed = await verdict.getByLabel("Verdict decision weights", { exact: true }).locator("dd").allTextContents();
    expect(displayed.reduce((sum, value) => sum + Math.round(parseFloat(value) * 10), 0)).toBe(1000);
    displayed.forEach((value, index) => expect(Math.abs(parseFloat(value) - Object.values(expected.weights)[index] * 100)).toBeLessThanOrEqual(0.1));
  });
}
