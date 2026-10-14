import { expect, test, type Page } from "@playwright/test";
import type { ExplainedInvestigationReport } from "../../src/domain/investigations/types";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { browserFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";
import { getBrowserSwarmSummaryFixture } from "../fixtures/swarm-report";
import { validateExplainedReport } from "../../src/domain/investigations/report-validation";
import { buildPlainLanguagePacket, restorePlainLanguageSummary } from "../../src/domain/investigations/plain-language-summary";
import { formatSwarmShare } from "../../src/components/investigation-swarm-graph-source";

test.use({ colorScheme: "dark", reducedMotion: "reduce" });

function sourceReport() {
  const report = getBrowserSwarmSummaryFixture();
  const shares = [0.136, 0.12, 0.117, 0.116, 0.109, 0.101, 0.085, 0.083, 0.066, 0.03, 0.028, 0.009];
  report.swarmAssessment!.graph = {
    holders: shares.map((share, index) => ({ address: `0x${(0x101 + index).toString(16).padStart(40, "0")}` as `0x${string}`, share, shareSupply: share / 10,
      isContract: false, label: null, clusterId: null, entryKind: index === 9 ? "mint" : "buy", transactionCount: 7000 + index,
      fresh: index === 9, sniper: index === 1 || index === 3, insider: false, dev: index === 9, fromDev: false })),
    links: [], clusters: [], truncated: false,
  };
  return validateExplainedReport(report);
}

function refreshSummary(report: ExplainedInvestigationReport) {
  const packet = buildPlainLanguagePacket(report);
  report.explanation.summary = restorePlainLanguageSummary(report, { reportRef: packet.reportRef, verdict: packet.verdict, reasonIds: packet.reasons.map((reason) => reason.id) });
  return validateExplainedReport(report);
}

async function openReport(page: Page, report: ExplainedInvestigationReport) {
  let scans = 0;
  await page.route("**/api/investigations", (route) => {
    scans++; return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "report", report })}\n` });
  });
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible(); return () => scans;
}

test("the main report uses one SWARM response for score, verdict weights, categories, market and holder rows", async ({ page }) => {
  const report = sourceReport(), source = report.swarmAssessment!, local = assessInvestigationReport(report), expected = report.explanation.summary!;
  expect(local.displayedScore).not.toBe(report.swarmAssessment!.score);
  await openReport(page, report);
  await expect(page.getByRole("region", { name: "Report assessment", exact: true })).toBeVisible();
  await expect(page.getByText("AI reviewed", { exact: true })).toHaveCount(0);
  const summary = page.getByTestId("plain-language-summary"), gauge = page.getByRole("region", { name: "Score", exact: true });
  const verdict = page.getByRole("region", { name: "Verdict output", exact: true });
  const holders = page.getByRole("region", { name: "SWARM top holders", exact: true });
  await expect(page.getByText("Investigation details", { exact: true }).locator("..")).toHaveJSProperty("open", false);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("traceforge-crawler")).toBeHidden();
    await expect(page.locator("[data-crawler-control]")).toBeHidden();
    await expect(summary.getByText(expected.action, { exact: true })).toBeVisible();
    await expect(summary.locator("li")).toHaveCount(expected.reasons.length);
    for (const reason of expected.reasons) { await expect(summary.getByText(reason.reason, { exact: true })).toBeVisible(); await expect(summary.getByText(reason.meaning, { exact: true })).toBeVisible(); }
    await expect(summary).toContainText("Based on SWARM");
    await expect(gauge.getByText(String(source.score), { exact: true })).toBeVisible();
    await expect(gauge).toHaveAttribute("data-assessment-source", "swarm");
    await expect(verdict.getByText(source.judge.decision, { exact: true })).toBeVisible();
    for (const [id, points] of Object.entries(source.parts)) await expect(page.locator(`[data-category-id="${id}"]`)).toHaveAttribute("data-score-points", String(points));
    for (const [label, weight] of Object.entries(source.judge.p)) { await expect(verdict.locator(`[data-verdict-weight="${label}"]`)).toHaveAttribute("data-weight", String(weight)); await expect(verdict.locator(`[data-verdict-weight="${label}"]`)).toContainText(`${(weight * 100).toFixed(1)}%`); }
    await expect(page.locator('[data-market-source="swarm"]')).toContainText(`$${source.header.price_usd}`);
    await expect(page.locator('[data-market-source="swarm"]')).toContainText("Holders (SWARM)");
    for (const holder of source.graph!.holders) { const row = holders.locator(`[data-source-holder-address="${holder.address}"]`); await expect(row).toContainText(formatSwarmShare(holder.share)); await expect(row).toContainText(String(holder.transactionCount)); }
    await expect(page.locator("[data-independent-holder-details] > div")).not.toBeVisible();
    const gaugeBounds = await gauge.boundingBox(), holderBounds = await holders.boundingBox();
    expect(gaugeBounds).not.toBeNull(); expect(holderBounds).not.toBeNull();
    if (viewport.width === 375) expect(gaugeBounds!.y + gaugeBounds!.height).toBeLessThan(holderBounds!.y);
    else expect(holderBounds!.x + holderBounds!.width).toBeLessThanOrEqual(gaugeBounds!.x);
    await expect(page.locator(".traceforce-report pre")).toHaveCount(0);
    await expect(page.getByLabel("Verdict receipt", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await expect(gauge.locator("time")).toHaveAttribute("datetime", source.scannedAt);
  await expect(gauge).toContainText("could not be verified against this request");
  await page.locator("[data-independent-holder-details] > summary").click();
  await expect(page.getByRole("region", { name: "Top holders", exact: true })).toBeVisible();
});

test("synthetic generated summary is shown once as an AI explanation while canonical proof stays folded", async ({ page }) => {
  const report = sourceReport(), packet = buildPlainLanguagePacket(report, { profileVersion: "1.6.0" });
  const text = "SWARM recommends avoiding this token because a large sale could sharply lower its price. This is a modeled risk rather than a prediction of what will happen.";
  report.explanation.profileVersion = "1.6.0";
  report.explanation.summary = restorePlainLanguageSummary(report, { reportRef: packet.reportRef, verdict: packet.verdict,
    reasonIds: packet.reasons.map((reason) => reason.id), text }, { profileVersion: "1.6.0" });
  await openReport(page, validateExplainedReport(report));
  const explanation = page.getByRole("region", { name: "AI explanation", exact: true });
  const support = explanation.locator("[data-explanation-support]");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(explanation.getByTestId("ai-summary-text")).toHaveText(text);
    await expect(explanation.getByText(text, { exact: true })).toHaveCount(1);
    await expect(explanation.getByTestId("plain-language-summary").locator("li")).toHaveCount(0);
    await expect(explanation.getByText(report.explanation.summary!.action, { exact: true })).toBeVisible();
    await expect(support).toHaveJSProperty("open", false);
    await expect(explanation.getByText(report.explanation.observations[0].claim, { exact: true })).not.toBeVisible();
    await expect(explanation.getByText("AI reviewed", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await support.locator("summary").click();
  const proof = support.getByRole("link", { name: "Evidence 1", exact: true }).first();
  const target = decodeURIComponent((await proof.getAttribute("href"))!.slice(1));
  await proof.click(); await expect(page.locator(`[id="${target}"]`)).toBeFocused();
});

test("a browser snapshot restores the same SWARM report without another scan", async ({ page }) => {
  const report = sourceReport(), scans = await openReport(page, report);
  await page.getByRole("button", { name: "Save in this browser", exact: true }).click();
  await expect(page.getByText("Report saved in this browser.", { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: "Open snapshot", exact: true }).click();
  await expect(page.getByText(/Saved snapshot from/)).toBeVisible();
  await expect(page.getByTestId("plain-language-summary")).toContainText(report.explanation.summary!.action);
  await expect(page.getByRole("region", { name: "Score", exact: true }).getByText(String(report.swarmAssessment!.score), { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Score", exact: true })).toHaveAttribute("data-assessment-source", "swarm");
  expect(scans()).toBe(1);
});

test("an unavailable SWARM assessment never substitutes a local score, verdict weights or holder cohort", async ({ page }) => {
  const report = sourceReport(); delete report.swarmAssessment;
  report.swarmAvailability = { status: "unavailable", reason: "stale_result", checkedAt: report.generatedAt };
  await openReport(page, refreshSummary(report));
  const status = page.getByRole("status", { name: "SWARM assessment status", exact: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute("data-source-unavailable-reason", "stale_result");
    await expect(status).toContainText("SWARM returned an older result. It was not used as this request’s assessment.");
    await expect(status).toContainText("Independent blockchain checks are shown below.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  const gauge = page.getByRole("region", { name: "Score", exact: true });
  await expect(gauge).toContainText("SWARM assessment unavailable");
  await expect(gauge).toContainText("returned an older result");
  await expect(gauge).not.toHaveAttribute("data-score");
  await expect(page.locator('[data-primary-verdict="Unavailable"]')).toBeVisible();
  await expect(page.locator("[data-verdict-weight]")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "SWARM top holders", exact: true }).locator("tbody tr")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Independent TraceForge checks", exact: true })).toBeVisible();
  await expect(page.getByTestId("plain-language-summary")).toContainText("Not enough information");
});

test("a changed source result updates the whole main assessment instead of copying reference numbers or DEX gaps", async ({ page }) => {
  const report = sourceReport(), source = report.swarmAssessment!;
  source.score = 55; source.band = "RISKY"; source.parts.snipers = 10; source.parts.dev = 10;
  source.judge.p = { avoid: 0.81, caution: 0.19, ok: 0 }; source.judge.confidence = 0.81;
  source.header.price_usd = 0.000002; source.header.holders_count = 33;
  await openReport(page, refreshSummary(report));
  await expect(page.getByRole("region", { name: "Score", exact: true })).toHaveAttribute("data-score", "55");
  await expect(page.locator('[data-category-id="snipers"]')).toContainText("10/10");
  await expect(page.locator('[data-category-id="dev"]')).toContainText("10/10");
  await expect(page.locator('[data-verdict-weight="avoid"]')).toContainText("81.0%");
  await expect(page.locator('[data-market-source="swarm"]')).toHaveAttribute("data-market-price", "0.000002");
  await expect(page.locator('[data-market-source="swarm"]')).toContainText("33");
  await expect(page.locator('[data-market-source="swarm"]')).not.toContainText("No usable market pair");
});

test("legacy snapshots remain readable and never invent an external source", async ({ page }) => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true }), local = assessInvestigationReport(report);
  await openReport(page, report);
  await expect(page.getByTestId("plain-language-summary")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "External assessment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Score", exact: true }).getByText(String(local.displayedScore), { exact: true })).toBeVisible();
});

test("a snapshot with a changed canonical verdict explanation is discarded", async ({ page }) => {
  const scans = await openReport(page, getBrowserSwarmSummaryFixture());
  await page.getByRole("button", { name: "Save in this browser", exact: true }).click();
  await expect(page.getByText("Report saved in this browser.", { exact: true })).toBeVisible();
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("traceforce-browser-reports", 1); open.onerror = () => reject(new Error("Synthetic snapshot edit failed"));
    open.onsuccess = () => {
      const database = open.result, transaction = database.transaction("reports", "readwrite"), store = transaction.objectStore("reports"), read = store.getAll();
      read.onsuccess = () => { const snapshot = read.result[0]; snapshot.report.explanation.summary.action = "Guaranteed profit"; store.put(snapshot); };
      transaction.oncomplete = () => { database.close(); resolve(); }; transaction.onabort = () => { database.close(); reject(new Error("Synthetic snapshot edit failed")); };
    };
  }));
  await page.reload(); await expect(page.getByText("No reports saved in this browser.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("plain-language-summary")).toHaveCount(0); expect(scans()).toBe(1);
});

test("optional enrichment discloses source leads and independently checked balances in plain language", async ({ page }) => {
  const report = getBrowserSwarmSummaryFixture(), candidates = report.holderSnapshot!.holders.slice(0, 3).map((holder) => ({ address: holder.address, role: "holder" as const, label: "UNVERIFIED LABEL MUST NOT APPEAR", reportedSharePercent: null }));
  report.providerEnrichment = {
    schemaVersion: 1, chainId: 8453, tokenAddress: report.token.address, checkedAt: report.generatedAt,
    capabilities: [{ provider: "bubblemaps", status: "available" }, { provider: "nansen", status: "not-configured" }, { provider: "arkham", status: "rights-required" }, { provider: "rugcheck", status: "unsupported-chain" }],
    sources: [{ provider: "bubblemaps", authority: "source-reported", chainId: 8453, tokenAddress: report.token.address,
      requestedAt: report.generatedAt, checkedAt: report.generatedAt, sourceObservedAt: null,
      sourceUrl: `https://v2.bubblemaps.io/map?chain=base&address=${report.token.address}`, candidates, relationships: [],
      coverage: { scope: "top-holders-and-context", returnedCandidates: 3, limitReached: false } }],
  };
  await openReport(page, validateExplainedReport(report));
  const context = page.getByRole("region", { name: "Additional investigation leads", exact: true });
  await expect(context).not.toBeVisible();
  await page.locator("[data-investigation-details] > summary").click();
  await expect(context).toBeVisible();
  const row = context.locator('[data-enrichment-provider="bubblemaps"]');
  const checked = candidates.filter((candidate) => report.holderSnapshot!.holders.some((holder) => holder.address === candidate.address && holder.status === "verified")).length;
  await expect(row).toContainText("source-reported leads");
  await expect(row).toContainText(`3 address leads supplied; ${checked} balances checked at the report time.`);
  await expect(row).not.toContainText("UNVERIFIED LABEL MUST NOT APPEAR");
  await expect(row).toHaveAttribute("data-enrichment-balances-checked", String(checked));
  await expect(context.locator("pre")).toHaveCount(0);
});
