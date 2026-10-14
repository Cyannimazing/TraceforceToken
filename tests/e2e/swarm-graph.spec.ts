import { expect, test } from "@playwright/test";
import { getBrowserSwarmAssessmentFixture, getBrowserSwarmSummaryFixture } from "../fixtures/swarm-report";
import { getBrowserWalletFlagsFixture } from "../fixtures/report";
import { buildPlainLanguagePacket, restorePlainLanguageSummary } from "../../src/domain/investigations/plain-language-summary";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import type { Address } from "../../src/domain/investigations/types";
import { verifySwarmBrowserReport } from "../../scripts/verification/swarm-browser";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;

function sourceReport() {
  const report = getBrowserSwarmSummaryFixture();
  const holders = Array.from({ length: 12 }, (_, index) => ({ address: address(5000 + index),
    share: index === 0 ? 0.72 : index === 1 ? 0.2 : index === 2 ? 0.0799991 : 0.0000001,
    shareSupply: null, isContract: false, label: index === 0 ? "Synthetic source-reported creator" : null,
    clusterId: index < 2 ? "0" : null, entryKind: index === 0 ? "mint" : "buy",
    transactionCount: index === 0 ? 6263 : index === 1 ? 0 : null,
    fresh: index === 0, sniper: index === 1, insider: false, dev: index === 0, fromDev: false,
  }));
  report.swarmAssessment!.graph = { holders,
    clusters: [{ id: "0", wallets: [holders[0].address, holders[1].address], share: 0.92 }],
    links: [{ a: holders[0].address, b: holders[1].address, kind: "direct", level: "proven" }], truncated: false };
  const packet = buildPlainLanguagePacket(report);
  report.explanation.summary = restorePlainLanguageSummary(report, { reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id) });
  return validateExplainedReport(report);
}

test("SWARM source graph matches its source table and supports desktop hover, keyboard selection, mobile tap and zoom", async ({ baseURL }) => {
  test.setTimeout(90_000);
  const report = sourceReport();
  const result = await verifySwarmBrowserReport(baseURL!, { report }, "full", AbortSignal.timeout(80_000), { screenshots: true });
  expect(result.additionalAcquisitions).toBe(0);
  expect(result.graphHolderParity).toMatchObject({ expectedHolders: 12, matchedHolders: 12, entriesFlagsTransactionsMatched: true, sourceFloatOnly: true });
  expect(result.reportedLinksDrawn).toBe(1); expect(result.reportedGroupsDrawn).toBe(1);
  expect(result.screenshotsSaved).toBe(4);
  expect(result.viewports.every((viewport) => !viewport.horizontalOverflow)).toBe(true);
  expect(result.pageErrors + result.consoleErrors + result.cspViolations).toBe(0);
});

test("missing SWARM holder data remains unavailable while local checks stay separately disclosed", async ({ page }) => {
  const report = getBrowserSwarmSummaryFixture();
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "report", report })}\n` }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(report.token.address);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SWARM holder data is unavailable", exact: true })).toBeVisible();
  await expect(page.locator("svg[data-graph-view='swarm']")).toHaveCount(0);
  await expect(page.locator("[data-independent-holder-details]")).not.toHaveAttribute("open");
  await expect(page.locator("[data-graph-source='local']")).toBeHidden();
  await expect(page.getByRole("region", { name: "Score", exact: true })).toHaveAttribute("data-assessment-source", "swarm");
});

test("legacy local reports keep their local graph even when an optional SWARM snapshot is present", async ({ page }) => {
  const report = getBrowserWalletFlagsFixture();
  report.swarmAssessment = getBrowserSwarmAssessmentFixture(report);
  report.swarmAssessment.graph = sourceReport().swarmAssessment!.graph;
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "report", report })}\n` }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(report.token.address);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.locator("[data-graph-source='local']")).toBeVisible();
  await expect(page.locator("svg[data-graph-view='swarm']")).toHaveCount(0);
});
