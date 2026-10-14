import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { browserFixture, getBrowserLinkedSellingFixture, getBrowserReportFixture } from "../fixtures/report";
import { validateInvestigationExplanation } from "../../src/domain/investigations/explanation";
import { canonicalExplanationOverview, canonicalFindingClaim } from "../../src/domain/investigations/explanation-grounding";

const reportPath = `/investigations/${browserFixture.id}`;
test.use({ colorScheme: "dark" });

async function mockCompletedReport(page: Page, chatContext?: string) {
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report: getBrowserReportFixture(), ...(chatContext ? { chatContext } : {}) }) + "\n" }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Synthetic browser test fixture", level: 2, exact: true })).toBeVisible();
  await inspectDetails(page);
}

async function inspectDetails(page: Page) {
  const disclosure = page.getByText("Investigation details", { exact: true }).locator("..");
  if (!await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)) await disclosure.locator("summary").first().click();
}

async function assertNoPageOverflow(page: Page) {
  const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  expect(size.body).toBeLessThanOrEqual(size.viewport + 1);
}

async function scrollForCapture(locator: Locator) {
  await locator.evaluate((element) => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - (document.querySelector("header")?.getBoundingClientRect().height ?? 64) - 20, behavior: "instant" }));
}

test("synthetic browser fixture: progress streams into a page-only report without polling or saved navigation", async ({ page }) => {
  await page.addInitScript(({ report }) => {
    const original = window.fetch.bind(window), requests: unknown[] = [];
    const completion: { finish: () => void } = { finish: () => undefined };
    Object.defineProperty(window, "__syntheticScanRequests", { value: requests });
    Object.defineProperty(window, "__syntheticScanCompletion", { value: completion });
    window.fetch = async (input, init) => {
      if (String(input) !== "/api/investigations") return original(input, init);
      requests.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: "progress", stage: "Synthetic fixture: checking transaction receipts" }) + "\n"));
        completion.finish = () => { controller.enqueue(encoder.encode(JSON.stringify({ type: "report", report }) + "\n")); controller.close(); };
      } }), { headers: { "content-type": "application/x-ndjson" } });
    };
  }, { report: getBrowserReportFixture() });
  const statusRequests: string[] = [];
  page.on("request", (request) => { if (/\/api\/investigations\//.test(request.url())) statusRequests.push(request.url()); });
  await page.goto("/investigate");
  await expect(page.getByRole("heading", { name: /Follow the token\.\s*Trace the wallets\./, level: 1 })).toBeVisible();
  await expect(page.getByText("No wallet connection", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/access key|password/i)).toHaveCount(0);
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page).toHaveURL(/\/investigate$/);
  const loading = page.locator("[data-scan-progress]");
  await expect(loading).toHaveAttribute("data-scan-stage", "investigating");
  await expect(loading.getByRole("status").locator("p")).toHaveText(["Checking the token", "Reviewing the available information."]);
  await expect(loading).not.toContainText("Synthetic fixture: checking transaction receipts");
  await expect(page.getByRole("heading", { name: "Report assessment", exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __syntheticScanCompletion: { finish: () => void } }).__syntheticScanCompletion.finish());
  await expect(page.getByRole("heading", { name: "Synthetic browser test fixture", level: 2, exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("heading", { name: "Report assessment", exact: true })).toBeVisible();
  expect(statusRequests).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __syntheticScanRequests: unknown[] }).__syntheticScanRequests)).toEqual([{ method: "POST", body: { token: browserFixture.token, lookbackBlocks: 20000, scope: "full" } }]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("synthetic browser fixture: dark dashboard prioritizes its graph and keeps technical detail expandable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockCompletedReport(page);
  const investigation = page.getByText("Investigation details", { exact: true }).locator("..");
  await investigation.locator("summary").first().click();
  await expect(investigation).toHaveJSProperty("open", false);
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  const verdict = page.getByRole("region", { name: "Important checks", exact: true });
  const [graphBox, verdictBox] = await Promise.all([graph.boundingBox(), verdict.boundingBox()]);
  expect(graphBox!.width).toBeGreaterThan(verdictBox!.width * 1.35);
  await expect(verdict).toContainText("INSUFFICIENT");
  await expect(verdict).toContainText("not enough checked evidence");
  await expect(page.getByText("TraceForge / Report", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Report assessment", exact: true })).toBeVisible();
  await expect(page.getByLabel("Verdict receipt", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "DECISION X-RAY", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Verdict decision weights", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("AI review receipt", { exact: true })).toHaveCount(0);
  const market = page.getByRole("region", { name: "Market snapshot", exact: true });
  expect(await market.locator("dt").allTextContents()).toEqual(["Price (reported)", "MCAP", "Liquidity", "24H Vol", "Pool age", "Wallets shown"]);
  await expect(market.locator("dd > span:first-child")).toHaveText(["—", "—", "—", "—", "—", "—"]);
  await expect(graph).toContainText("Current holdings are unknown.");
  const breakdown = page.getByRole("region", { name: "Score breakdown", exact: true });
  await expect(breakdown.locator('[data-assessment-status="not_assessed"]')).toHaveCount(6);
  await expect(breakdown).toContainText("Some checks are incomplete");
  await expect(breakdown.locator("details[data-score-details]")).toHaveJSProperty("open", false);
  await inspectDetails(page);
  const cards = page.getByRole("region", { name: "Key findings", exact: true });
  await expect(cards.getByRole("heading", { level: 2 })).toHaveText(["Who funded?", "Wallet links", "Early accumulation", "Linked selling"]);
  await expect(cards.getByRole("button", { name: "Inspect findings", exact: true })).toHaveCount(4);
  const coverage = page.locator("details[data-report-checks]");
  await coverage.locator(":scope > summary").click();
  await expect(coverage).toContainText("Funding was examined for 2 of 3 eligible addresses.");
  await expect(coverage).toContainText("Some requested transaction history could not be read.");
  await expect(page.getByRole("region", { name: "Data comparison", exact: true })).toContainText("2 eligible participants");
  await expect(graph.locator('svg[viewBox="0 0 900 600"] line[data-kind="funding"]')).toHaveCount(getBrowserReportFixture().connections.filter((edge) => edge.kind === "funding").length);
  const identity = page.getByRole("region", { name: "Synthetic browser test fixture", exact: true });
  await expect(identity.getByRole("link", { name: "Explorer", exact: true })).toHaveAttribute("href", 'https://base.blockscout.com/token/' + browserFixture.token);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await assertNoPageOverflow(page);
    await expect(verdict).toBeVisible();
    await expect(page.getByRole("region", { name: "Top holders", exact: true })).toBeVisible();
  }
});

test("incomplete near-total funding coverage and nontransacting candidates remain distinct", async ({ page }) => {
  const report = getBrowserReportFixture(), template = report.wallets.find((wallet) => wallet.address === browserFixture.funder)!;
  report.wallets.push(...Array.from({ length: 198 }, (_, index) => ({ ...template, address: `0x${(1000 + index).toString(16).padStart(40, "0")}` as typeof template.address })));
  report.coverage.eligibleWallets = report.wallets.length;
  report.coverage.examinedWallets = report.wallets.length - 1;
  report.coverage.funding = report.wallets.map((wallet, index) => ({ ...report.coverage.funding[0], wallet: wallet.address, status: index < 200 ? "partial" : "not_examined" }));
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await inspectDetails(page);
  const assessment = page.locator("details[data-report-checks]");
  await assessment.locator(":scope > summary").click();
  await expect(assessment).not.toContainText("100%");
  await expect(assessment).toContainText("Funding was examined for 200 of 201 eligible addresses.");
  await expect(assessment).toContainText("0 complete · 200 partial · 0 unavailable · 1 not checked.");
  await expect(assessment).toContainText("Some requested transaction history could not be read.");
  const discovered = page.getByRole("region", { name: "Synthetic browser test fixture", exact: true }).locator("dt").filter({ hasText: /^Addresses discovered$/ }).locator("..");
  await expect(discovered.locator("dd").first()).toHaveText("201");
  await expect(page.getByRole("region", { name: "Data comparison", exact: true })).toContainText("2 eligible participants");
});

test("canonical model-selected findings are labeled as reviewed and retain exact source caveats", async ({ page }) => {
  const report = getBrowserReportFixture(), sourceIds = report.explanation.observations[0].evidenceIds;
  const finding = report.findings.find((entry) => entry.category === "funding" && entry.evidenceIds.length === sourceIds.length && entry.evidenceIds.every((id) => sourceIds.includes(id)))!;
  report.explanation = validateInvestigationExplanation(report, {
    ...report.explanation, profileVersion: "1.4.0",
    overview: { text: canonicalExplanationOverview(report, [finding], []), evidenceIds: finding.evidenceIds },
    observations: [{ category: finding.category, claim: canonicalFindingClaim(finding), caveat: finding.limitations[0], evidenceIds: finding.evidenceIds }],
    limitations: [finding.limitations[0]],
    grounding: { mode: "canonical-finding-selection", overviewFindingIds: [finding.id], overviewEvidenceIds: [], observations: [{ findingId: finding.id, caveatIndex: 0 }] },
  });
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  const reviewed = page.getByRole("region", { name: "Report assessment", exact: true }), cards = page.getByRole("region", { name: "Key findings", exact: true });
  const supporting = reviewed.getByText("Supporting evidence", { exact: true }).locator("..");
  await expect(reviewed.getByText(report.explanation.overview.text, { exact: true })).toHaveCount(0);
  await expect(supporting).toHaveJSProperty("open", false);
  await expect(reviewed.locator('dl[aria-label="AI review receipt"]')).toHaveCount(0);
  await expect(supporting.getByText(canonicalFindingClaim(finding), { exact: true })).not.toBeVisible();
  await inspectDetails(page);
  await expect(cards.getByText("AI-reviewed finding · inspect cited evidence", { exact: true })).toHaveCount(1);
  await expect(cards.getByText(finding.title, { exact: true })).toBeVisible();
  await expect(cards.getByText(finding.limitations[0], { exact: true })).toBeVisible();
  await supporting.locator("summary").click();
  await expect(supporting.getByText(canonicalFindingClaim(finding), { exact: true })).toBeVisible();
  await expect(supporting.getByText(finding.limitations[0], { exact: true })).toBeVisible();
  const citation = reviewed.getByRole("link", { name: "Evidence 1", exact: true }).first();
  await expect(citation).toHaveAttribute("href", `#evidence-${encodeURIComponent(finding.evidenceIds[0])}`);
  await citation.click();
  await expect(page.locator(`[id="evidence-${finding.evidenceIds[0]}"]`)).toBeFocused();
});

test("investigative leads give concrete follow-up targets and open their actual retained proof", async ({ page }) => {
  await mockCompletedReport(page);
  const report = getBrowserReportFixture(), judge = page.getByText("Investigation details", { exact: true }).locator("..");
  await expect(judge.getByText(/^Investigative leads \(/).locator("..")).toHaveJSProperty("open", false);
  await expect(judge.getByText("Trace the shared funder upstream", { exact: true })).not.toBeVisible();
  await judge.getByText(/^Investigative leads \(/).click();
  const leads = judge.getByRole("list", { name: "Priority investigative leads", exact: true });
  await expect(leads.locator(":scope > li")).toHaveCount(2);
  await expect(leads).toContainText("Trace the shared funder upstream");
  await expect(leads).toContainText("Inspect the direct wallet transfer");
  await expect(judge.getByText("Suggested checks; not yet performed.", { exact: true })).toBeVisible();
  const shared = leads.locator(":scope > li").first();
  await expect(shared.getByText(/source's earlier inbound funding/)).not.toBeVisible();
  await shared.getByText("Wallets and proof (2 records)", { exact: true }).click();
  await expect(shared.getByText(/source's earlier inbound funding/)).toBeVisible();
  await expect(shared).toContainText(browserFixture.funder);
  await expect(shared).toContainText(browserFixture.walletA);
  await expect(shared).toContainText(browserFixture.walletB);
  await expect(shared).toContainText("not proof of common ownership");
  const fundingIds = report.evidence.filter((event) => event.kind === "funding").map((event) => event.id).sort();
  const proof = shared.getByRole("link", { name: "Evidence 1", exact: true });
  await expect(proof).toHaveAttribute("href", `#evidence-${encodeURIComponent(fundingIds[0])}`);
  await proof.click();
  await expect(page.locator(`[id="evidence-${fundingIds[0]}"]`)).toBeFocused();
});

test("synthetic browser fixture: bubble graph zoom, fit and SVG export retain real address labels", async ({ page }) => {
  await mockCompletedReport(page);
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  const scene = graph.locator('svg[viewBox="0 0 900 600"] > g[transform]');
  const initialTransform = await scene.getAttribute("transform");
  await graph.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(scene).not.toHaveAttribute("transform", initialTransform!);
  const initialScale = Number(initialTransform!.match(/scale\(([^)]+)\)/)![1]), zoomScale = Number((await scene.getAttribute("transform"))!.match(/scale\(([^)]+)\)/)![1]);
  expect(zoomScale / initialScale).toBeCloseTo(1.15);
  await graph.getByRole("button", { name: "Fit graph", exact: true }).click();
  await expect(scene).toHaveAttribute("transform", initialTransform!);
  const pending = page.waitForEvent("download");
  await graph.getByRole("button", { name: "Export graph SVG", exact: true }).click();
  const download = await pending, content = await readFile((await download.path())!, "utf8");
  expect(download.suggestedFilename()).toBe(`traceforce-relationships-${browserFixture.token}.svg`);
  expect(content).toContain(`Select wallet ${browserFixture.walletA}`);
  expect(content).toContain(`Select wallet ${browserFixture.walletB}`);
  expect(content).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(content).not.toContain("style=");
  expect(content).not.toContain("var(--cyan)"); expect(content).not.toContain("var(--amber)");
});

test("synthetic pinned balances show supply shares while unread candidates remain unknown", async ({ page }) => {
  const report = getBrowserReportFixture(), unit = 10n ** 18n;
  report.token.totalSupplyRaw = (1000n * unit).toString();
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: { ...report.range.to }, totalSupplyRaw: (1000n * unit).toString(),
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${report.token.address}/holders`, observedAt: report.generatedAt, status: "partial", pages: 1, addresses: 2, finalizedCensus: false, reason: "Synthetic indexed discovery is partial." },
    balances: { status: "partial", requestedWallets: 4, verifiedWallets: 3, reason: "One synthetic candidate was not examined." },
    holders: [
      { address: browserFixture.walletA, balanceRaw: (125n * unit).toString(), status: "verified", discoveredBy: "both" },
      { address: browserFixture.walletB, balanceRaw: (50n * unit).toString(), status: "verified", discoveredBy: "both" },
      { address: browserFixture.funder, balanceRaw: null, status: "not_examined", discoveredBy: "observed" },
      { address: browserFixture.pool, balanceRaw: "0", status: "verified", discoveredBy: "observed" },
    ],
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: report.generatedAt },
  };
  report.wallets.forEach((wallet) => { wallet.balanceRaw = report.holderSnapshot!.holders.find((holder) => holder.address === wallet.address)?.balanceRaw ?? null; });
  report.walletActivitySnapshot = { block: { ...report.range.to }, rows: [browserFixture.walletA, browserFixture.walletB].map((address) => ({ address, code: "eoa", outgoingTransactionCountRaw: null })) };
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await inspectDetails(page);
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true }), holders = page.getByRole("region", { name: "Top holders", exact: true });
  await expect(graph).toContainText("Area: share of total supply at block 400, using one scale.");
  await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.walletA}`, exact: true })).toContainText("12.5%");
  await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.funder}`, exact: true })).toHaveCount(0);
  await graph.getByRole("button", { name: "All addresses", exact: true }).click();
  await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.funder}`, exact: true })).toContainText("—");
  await graph.getByRole("button", { name: "Wallets", exact: true }).click();
  await expect(holders).toContainText("Shares use 1,000 total supply");
  await expect(holders).toHaveAttribute("data-holding-denominator-raw", (1000n * unit).toString());
  await expect(holders.getByText("Float unavailable: 1 candidate balances unread.", { exact: true })).toBeVisible();
  await expect(holders.getByRole("table", { name: "Top holders", exact: true }).getByRole("columnheader").nth(2)).toHaveText("%");
  await expect(holders.getByRole("cell", { name: "12.5%", exact: true })).toHaveCount(1);
  await expect(holders.getByText("Unread balances (1)", { exact: true })).toBeVisible();
  const firstHolder = holders.locator("tbody tr").first();
  await expect(firstHolder.getByRole("button", { name: "transfer", exact: true })).toHaveAttribute("title", /First retained token receipt:.*Token transfer; purchase not established/);
  await expect(firstHolder.getByRole("cell").nth(4)).toHaveText("—");
  await expect(firstHolder.getByRole("cell").nth(5)).toHaveText("—");
  await expect(firstHolder.getByRole("cell").nth(6)).toHaveText("#1");
  // The broader risk basis can exclude the verified zero pool while the wallet
  // table requires a total-supply fallback for its unread candidate. Here both
  // exact denominators are 1,000; their different scope labels stay explicit.
  await expect(page.getByRole("region", { name: "Score", exact: true })).toContainText("Largest holder: 12.50% of float");
  const breakdown = page.getByRole("region", { name: "Score breakdown", exact: true });
  const concentration = breakdown.locator('[data-category-id="concentration"]');
  await expect(concentration).toContainText("0/15");
  await expect(concentration).toHaveAttribute("data-assessment-status", "not_assessed");
  await expect(concentration).toHaveAttribute("data-score-points", "0");
  await breakdown.locator("details[data-score-details] > summary").click();
  await expect(breakdown.locator('[data-category-details="concentration"]')).toContainText("17.50% top 10 examined");
  await expect(breakdown.locator('[data-assessment-status="not_assessed"]')).toHaveCount(6);
  await expect(breakdown.locator('[data-category-details="dev"]')).toContainText("could not be completed");
  const rules = page.getByRole("region", { name: "Rule evidence", exact: true });
  await expect(rules).toContainText("An eligible examined address holds at least 10% of total supply");
  await expect(rules).toContainText("Evidence behind the warnings");
  await expect(rules).not.toContainText("−15");
  await expect(holders.locator("time")).toHaveAttribute("datetime", new Date(report.holderSnapshot.block.timestamp * 1000).toISOString());
  await expect(holders.locator("time")).toHaveText("Oct 9, 2025, 9:43 AM UTC");
  await expect(firstHolder.getByRole("cell").nth(2)).toHaveAttribute("title", /tokens at block 400\./);
  const balanceSummary = page.getByRole("region", { name: "Important checks", exact: true });
  await expect(balanceSummary).toContainText("REVIEW");
  await expect(balanceSummary).not.toContainText("75%");
  await expect(balanceSummary).not.toContainText("READ COVERAGE");
  const verdictDetails = balanceSummary.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^What was checked$/ }) });
  await verdictDetails.locator("summary").first().click();
  await expect(verdictDetails).toContainText("3 of 4 candidate balances");
  await expect(verdictDetails).toContainText("Missing information is not a clean result");
  const holderMetric = page.getByRole("region", { name: "Market snapshot", exact: true }).locator("dt").filter({ hasText: /^Wallets shown$/ });
  await expect(holderMetric.locator("..").locator("dd > span:first-child")).toHaveText("2");
  await expect(holderMetric.locator("..")).toContainText("Verified positive EOA rows");
  await expect(holderMetric.locator("..")).toContainText("not a complete holder census");
  await scrollForCapture(page.getByRole("heading", { name: "Your investigation report", exact: true }));
  await page.screenshot({ path: ".next/investigation-holders-desktop.png" });
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await scrollForCapture(graph);
  await page.screenshot({ path: ".next/investigation-holders-mobile.png" });
});

test("synthetic 90% and 1% holding bubbles preserve their area ratio on desktop and mobile", async ({ page }) => {
  const report = getBrowserReportFixture(), unit = 10n ** 18n;
  report.token.totalSupplyRaw = (1000n * unit).toString();
  const balances = [
    { address: browserFixture.walletA, balanceRaw: (900n * unit).toString() },
    { address: browserFixture.walletB, balanceRaw: (10n * unit).toString() },
    { address: browserFixture.funder, balanceRaw: "0" },
    { address: browserFixture.pool, balanceRaw: (90n * unit).toString() },
  ];
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: report.range.to, totalSupplyRaw: report.token.totalSupplyRaw,
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${report.token.address}/holders`, observedAt: report.generatedAt, status: "partial", pages: 1, addresses: 4, finalizedCensus: false, reason: "Synthetic bounded discovery." },
    balances: { status: "complete", requestedWallets: 4, verifiedWallets: 4, reason: null },
    holders: balances.map((holder) => ({ ...holder, status: "verified", discoveredBy: "indexed" })),
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: report.generatedAt },
  };
  report.wallets.forEach((wallet) => { wallet.balanceRaw = balances.find((entry) => entry.address === wallet.address)?.balanceRaw ?? null; });
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  const large = graph.getByRole("button", { name: `Select wallet ${browserFixture.walletA}`, exact: true });
  const small = graph.getByRole("button", { name: `Select wallet ${browserFixture.walletB}`, exact: true });
  await expect(large).toContainText("98.9%"); await expect(small).toContainText("1.09%");
  await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.pool}`, exact: true })).toHaveAttribute("data-node-kind", "infrastructure");
  await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.funder}`, exact: true })).toContainText("0 balance");
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const ratio = await large.locator("circle[data-balance-bubble]").evaluate((circle, address) => {
      const a = circle as SVGCircleElement, b = document.querySelector(`[aria-label="Select wallet ${address}"] circle[data-balance-bubble]`) as SVGCircleElement;
      const radius = (element: SVGCircleElement) => element.r.baseVal.value * Math.hypot(element.getScreenCTM()!.a, element.getScreenCTM()!.b);
      return (radius(a) / radius(b)) ** 2;
    }, browserFixture.walletB);
    // SVGAnimatedLength exposes single-precision radii in Chromium. Keep the
    // rendered comparison within 0.001% while pure geometry tests cover math.
    expect(Math.abs(ratio - 90) / 90).toBeLessThan(0.00001);
    await assertNoPageOverflow(page); await scrollForCapture(graph);
    await page.screenshot({ path: `.next/investigation-proportional-${width === 375 ? "mobile" : "desktop"}.png` });
  }
});

test("synthetic linked-selling verdict retains exact supporting citations without inventing an overall score", async ({ page }) => {
  const report = getBrowserLinkedSellingFixture();
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await page.getByRole("region", { name: "Score breakdown", exact: true }).locator("details[data-score-details] > summary").click();
  const rules = page.getByRole("region", { name: "Rule evidence", exact: true });
  await expect(rules.getByRole("heading", { name: /^Previously linked wallets sold within 600 seconds/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Important checks", exact: true })).toContainText("REVIEW");
  await expect(rules).not.toContainText("−0");
  await expect(page.getByRole("region", { name: "Important checks", exact: true })).toContainText("REVIEW");
  const finding = report.findings.find((item) => item.category === "selling")!;
  const citations = rules.getByRole("link", { name: /^Evidence / });
  expect(await citations.count()).toBe(finding.evidenceIds.length);
  const linkedIds = await citations.evaluateAll((links) => links.map((link) => decodeURIComponent(link.getAttribute("href")!.slice(1)).replace(/^evidence-/, "")).sort());
  expect(linkedIds).toEqual([...finding.evidenceIds].sort());
  await citations.last().click();
  const target = page.locator(`[id="evidence-${linkedIds.at(-1)!}"]`);
  await expect(target).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await scrollForCapture(page.getByRole("region", { name: "Important checks", exact: true }));
  await page.screenshot({ path: ".next/investigation-verdict-mobile.png" });
});

test("time machine replays only the bounded observations and share exports a card with a fresh token link", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => { Object.defineProperty(window, "__syntheticCopiedLink", { configurable: true, value }); } } }); });
  await mockCompletedReport(page);
  const replay = page.getByRole("region", { name: "// TIME MACHINE", exact: true });
  const slider = replay.getByRole("slider", { name: "Replay observed activity by block", exact: true });
  await expect(slider).toHaveAttribute("aria-valuetext", "Block 400, 3 observed token-transfer addresses");
  await expect(replay).toContainText("not holder history since launch");
  await slider.focus(); await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", "Block 100, 0 observed token-transfer addresses");
  await replay.getByRole("button", { name: "Play activity replay", exact: true }).click();
  await expect(replay.getByRole("button", { name: "Pause activity replay", exact: true })).toBeVisible();
  await replay.getByRole("button", { name: "Pause activity replay", exact: true }).click();
  await slider.focus(); await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "Block 400, 3 observed token-transfer addresses");
  const share = page.getByRole("region", { name: "// SHARE", exact: true });
  await share.getByRole("button", { name: "Copy token link", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __syntheticCopiedLink: string }).__syntheticCopiedLink)).toBe(`http://127.0.0.1:3200/investigate?token=${browserFixture.token}`);
  const pending = page.waitForEvent("download"); await share.getByRole("button", { name: "Download card", exact: true }).click();
  const download = await pending, content = await readFile((await download.path())!, "utf8");
  expect(download.suggestedFilename()).toBe(`traceforce-base-${browserFixture.token}-400.svg`);
  expect(content).toContain(browserFixture.token); expect(content).toContain("Finalized block 400");
  expect(content).not.toContain("style="); expect(content).not.toContain(reportPath);
  await scrollForCapture(replay); await page.screenshot({ path: ".next/investigation-details-desktop.png" });
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await scrollForCapture(replay); await page.screenshot({ path: ".next/investigation-details-mobile.png" });
});

test("shared token links prefill one valid address without automatically running an investigation", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /\/api\/investigations$/.test(request.url())) requests.push(request.url()); });
  const mixedCase = `0x${"Ab".repeat(20)}`;
  await page.goto(`/investigate?token=${mixedCase}`);
  await expect(page.getByLabel("Base token contract")).toHaveValue(mixedCase.toLowerCase());
  await expect(page.getByRole("button", { name: "Start investigation", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toHaveCount(0);
  await page.goto("/investigate?token=not-a-contract");
  await expect(page.getByLabel("Base token contract")).toHaveValue("");
  await page.goto(`/investigate?token=${browserFixture.token}&token=${mixedCase}`);
  await expect(page.getByLabel("Base token contract")).toHaveValue("");
  expect(requests).toEqual([]);
});

test("synthetic browser fixture: human explanation cites retained evidence and discloses model context", async ({ page }) => {
  await mockCompletedReport(page);
  const report = getBrowserReportFixture();
  const explanation = page.getByRole("region", { name: "Report assessment", exact: true });
  await expect(explanation.getByText(report.explanation.overview.text, { exact: true })).toHaveCount(0);
  const supporting = explanation.getByText("Supporting evidence", { exact: true }).locator("..");
  await expect(supporting).toHaveJSProperty("open", false);
  await expect(explanation.locator('dl[aria-label="Engine and LLM roles"]')).toHaveCount(0);
  await expect(explanation.locator('dl[aria-label="AI review receipt"]')).toHaveCount(0);
  for (const observation of report.explanation.observations) await expect(supporting.getByText(observation.claim, { exact: true })).not.toBeVisible();
  await supporting.locator("summary").click();
  for (const observation of report.explanation.observations) {
    await expect(explanation.getByText(observation.claim, { exact: true })).toBeVisible();
    await expect(explanation).toContainText(observation.caveat);
  }
  const checked = explanation.getByText("What was checked", { exact: true }).locator("..");
  await checked.locator("summary").click();
  await expect(checked).toContainText("AI explains the supplied findings");
  await expect(checked).not.toContainText(report.explanation.model);
  const citation = explanation.getByRole("link", { name: "Evidence 1", exact: true }).last();
  const targetId = decodeURIComponent((await citation.getAttribute("href"))!.slice(1));
  await expect(page.locator(`[id="${targetId}"]`)).toHaveCount(0);
  await citation.focus();
  await page.keyboard.press("Enter");
  const target = page.locator(`[id="${targetId}"]`);
  await expect(target).toBeFocused();
  const record = report.evidence.find((record) => `evidence-${record.id}` === targetId)!;
  await expect(target.getByRole("link", { name: "Inspect transaction", exact: true })).toHaveAttribute("href", `https://base.blockscout.com/tx/${record.transactionHash}`);
});

test("a completed payload without its required explanation cannot display a partial report", async ({ page }) => {
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report: { ...getBrowserReportFixture(), explanation: null } }) + "\n" }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The investigation report could not be validated. Start a fresh investigation." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic browser test fixture", level: 2, exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Transaction evidence", exact: true })).toHaveCount(0);
});

test("synthetic browser fixture: wallet graph filtering and finding links reveal the actual evidence target", async ({ page }) => {
  await mockCompletedReport(page);
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  const wallet = graph.getByRole("button", { name: `Select wallet ${browserFixture.walletB}`, exact: true });
  await wallet.focus();
  await page.keyboard.press("Space");
  await expect(wallet).toHaveAttribute("aria-pressed", "true");
  const records = page.getByRole("region", { name: /^Transaction evidence/ });
  const expected = getBrowserReportFixture().evidence.filter((item) => item.from === browserFixture.walletB || item.to === browserFixture.walletB);
  await expect(records.getByText(`Showing 25 of ${expected.length} matching records.`, { exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: /^All findings \(/ }).click();
  const findingLink = page.getByRole("region", { name: "Findings and their limits" }).getByRole("link", { name: "Evidence 1", exact: true }).first();
  const href = await findingLink.getAttribute("href");
  const targetId = decodeURIComponent(href!.slice(1));
  await expect(page.locator(`[id="${targetId}"]`)).toHaveCount(0);
  await findingLink.focus();
  await page.keyboard.press("Enter");
  const target = page.locator(`[id="${targetId}"]`);
  await expect(target).toBeVisible();
  await expect(target).toBeFocused();
  await expect(wallet).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => decodeURIComponent(location.hash.slice(1)))).toBe(targetId);
  const record = getBrowserReportFixture().evidence.find((record) => `evidence-${record.id}` === targetId)!;
  await expect(target.getByRole("link", { name: "Inspect transaction", exact: true })).toHaveAttribute("href", `https://base.blockscout.com/tx/${record.transactionHash}`);
  await page.getByRole("combobox", { name: "Finding category", exact: true }).selectOption("coverage");
  const findings = page.getByRole("region", { name: "Findings and their limits" });
  await expect(findings.locator("article")).toHaveCount(1);
  await expect(findings).toContainText("coverage / high confidence");
});

test("synthetic browser fixture: timeline and connections expose inspectable evidence beyond pagination", async ({ page }) => {
  await mockCompletedReport(page);
  await page.getByText("Timeline and retained connections", { exact: true }).click();
  const connections = page.getByRole("region", { name: "All retained connections", exact: true });
  const lastLink = connections.getByRole("link", { name: "Evidence 1", exact: true }).last();
  const targetId = decodeURIComponent((await lastLink.getAttribute("href"))!.slice(1));
  await expect(page.locator(`[id="${targetId}"]`)).toHaveCount(0);
  await lastLink.click();
  await expect(page.locator(`[id="${targetId}"]`)).toBeFocused();
  const timeline = page.getByRole("region", { name: "Finding timeline", exact: true });
  expect(await timeline.getByRole("link", { name: /^Evidence / }).count()).toBeGreaterThan(0);
  for (const section of [timeline, connections]) {
    for (const link of await section.getByRole("link", { name: /^Evidence / }).all()) {
      const id = decodeURIComponent((await link.getAttribute("href"))!.slice(1));
      await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
    }
  }
});

test("synthetic browser fixture: partial history displays exact observed flows and unknown balances", async ({ page }) => {
  await mockCompletedReport(page);
  const activity = page.getByRole("region", { name: "Wallet activity", exact: true });
  await expect(activity).toContainText("Current holdings are unknown.");
  await expect(activity.getByRole("columnheader", { name: "Current balance", exact: true })).toHaveCount(1);
  await expect(activity.getByRole("cell", { name: "Current balance unknown", exact: true })).toHaveCount(getBrowserReportFixture().wallets.length);
  await expect(activity.locator(`[data-amount-raw="${browserFixture.exactAmount}"]`)).toHaveCount(1);
  await expect(activity.locator(`[data-amount-raw="${browserFixture.exactAmount}"] span`)).toHaveAttribute("aria-label", /tokens$/);
  await expect(activity.getByRole("cell", { name: "Not assessed", exact: true })).toHaveCount(getBrowserReportFixture().wallets.length);
  const coverage = page.locator("details[data-report-checks]");
  await coverage.locator("summary").click();
  await expect(coverage).toContainText("Some requested transaction history could not be read");
  await expect(coverage).toContainText("Funding was examined for 2 of 3 eligible addresses");
});

test("synthetic website metadata exposes its source without claiming token ownership", async ({ page }) => {
  const report = getBrowserReportFixture();
  report.token.webPresence = { source: "dexscreener", status: "reported", checkedAt: "2026-10-12T00:00:00.000Z", sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, websites: [{ url: "https://example.org/synthetic-token", pairAddresses: [browserFixture.pool] }], matchedPairs: 1, reason: null };
  report.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt: "2026-10-12T00:00:00.000Z", sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: browserFixture.pool, priceUsd: "0.01234567", marketCapUsd: 12345, liquidityUsd: 1000, volume24hUsd: 100, priceChange24hPercent: 5, pairCreatedAt: Date.parse("2026-10-10T00:00:00.000Z") };
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  const identity = page.getByRole("region", { name: "Synthetic browser test fixture", exact: true });
  await expect(identity.getByRole("link", { name: "example.org", exact: true })).toHaveAttribute("href", "https://example.org/synthetic-token");
  await expect(identity.getByText("Source-reported · ownership unverified", { exact: true })).toBeVisible();
  await expect(identity.getByRole("link", { name: "Explorer", exact: true })).toHaveAttribute("href", `https://base.blockscout.com/token/${browserFixture.token}`);
  await expect(identity.getByRole("link", { name: "DEX Screener", exact: true })).toHaveAttribute("href", `https://dexscreener.com/base/${browserFixture.pool}`);
  await expect(identity.getByText("CAUTION", { exact: true })).toHaveCount(1);
  await expect(identity.getByText("RISKY", { exact: true })).toHaveCount(1);
  for (const label of ["Explorer", "DEX Screener"]) await expect(identity.getByRole("link", { name: label, exact: true })).toHaveAttribute("rel", "noopener noreferrer nofollow");
  const market = page.getByRole("region", { name: "Market snapshot", exact: true });
  await expect(market.getByRole("link", { name: "DEX Screener · selected pool", exact: true })).toHaveAttribute("href", `https://dexscreener.com/base/${browserFixture.pool}`);
  await expect(market.getByText("$0.01234567", { exact: true })).toBeVisible();
  await expect(market.getByLabel("24-hour price change +5%", { exact: true })).toBeVisible();
  await expect(market.getByText("Pool age", { exact: true })).toBeVisible();
  await expect(market.getByText("Pool age", { exact: true })).toHaveAttribute("title", "Age of the selected pool. Token launch age is unverified.");
  await expect(market.getByText("Wallets shown", { exact: true })).toHaveAttribute("title", /Verified positive EOA rows.*not a complete holder census/);
  expect(await market.locator("dt").allTextContents()).toEqual(["Price (reported)", "MCAP", "Liquidity", "24H Vol", "Pool age", "Wallets shown"]);
  await expect(market.locator("dt").filter({ hasText: /^Price \(reported\)$/ }).locator("..")).toContainText("+5%");
  await expect(market.locator("dt").filter({ hasText: /^24H Vol$/ }).locator("..")).not.toContainText("+5%");
  await expect(market.getByText("2d", { exact: true })).toBeVisible();
  await scrollForCapture(page.getByRole("heading", { name: "Your investigation report", exact: true }));
  await page.screenshot({ path: ".next/investigation-market-desktop.png" });
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await scrollForCapture(identity); await page.screenshot({ path: ".next/investigation-market-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const references = page.getByRole("region", { name: "References", exact: true });
  await expect(references.getByRole("link", { name: "DEX Screener metadata", exact: true })).toHaveAttribute("href", report.token.webPresence.sourceUrl);
  await expect(references).toContainText(report.token.webPresence.checkedAt);
  const website = identity.getByRole("link", { name: "example.org", exact: true });
  await expect(website).toHaveAttribute("href", "https://example.org/synthetic-token");
  await expect(website).toHaveAttribute("rel", "noopener noreferrer nofollow");
});

test("source-reported holder count and contract flags retain attribution and unknown checks", async ({ page }) => {
  const report = getBrowserReportFixture(), checkedAt = "2026-10-12T00:00:00.000Z";
  report.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt, sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: browserFixture.pool, priceUsd: "0.01", marketCapUsd: 1000, liquidityUsd: 100, volume24hUsd: 10, priceChange24hPercent: null, pairCreatedAt: null };
  report.token.securitySnapshot = {
    source: "goplus", status: "reported", checkedAt, sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`,
    tokenAddress: report.token.address, chainId: 8453, holderCount: 13, creatorAddress: browserFixture.funder,
    checks: [{ id: "is_honeypot", value: "no" }, { id: "is_proxy", value: "yes" }, { id: "is_mintable", value: "unknown" }, { id: "is_open_source", value: "yes" }],
  };
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await inspectDetails(page);
  const market = page.getByRole("region", { name: "Market snapshot", exact: true }), holderMetric = market.locator("dt").filter({ hasText: /^Wallets shown$/ });
  await expect(holderMetric.locator("..").locator("dd > span:first-child")).toHaveText("—");
  await expect(market.getByText("GoPlus reports 13 holders; this separate source count is not pinned to the scan block.", { exact: true })).toBeVisible();
  await expect(holderMetric.locator("..")).toContainText("Verified positive EOA rows");
  await expect(holderMetric.locator("..")).toContainText("not a complete holder census");
  const contract = page.getByRole("region", { name: "Contract", exact: true });
  await expect(contract.getByRole("heading", { name: "GoPlus · source-reported checks", exact: true })).toBeVisible();
  for (const [label, value] of [["Honeypot flag", "No"], ["Proxy flag", "Yes"], ["Mintable flag", "Unknown"], ["Hidden owner flag", "Unknown"], ["Open source flag", "Yes"]]) {
    await expect(contract.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd")).toHaveText(value);
  }
  await expect(contract.getByText("Not assessed", { exact: true })).toHaveCount(1);
  await expect(contract.getByText("Source flags are not a guarantee of safety, renounced ownership or creator identity.", { exact: true })).toBeVisible();
  const creatorLink = contract.locator(`a[href="https://basescan.org/address/${browserFixture.funder}"]`);
  await expect(creatorLink).toHaveText(`${browserFixture.funder.slice(0, 6)}…${browserFixture.funder.slice(-4)}`);
  await expect(creatorLink).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(contract.getByRole("link", { name: "Powered by GoPlus", exact: true })).toHaveAttribute("href", "https://gopluslabs.io/");
  const logo = contract.getByRole("link", { name: "Powered by GoPlus", exact: true }).locator("img");
  await expect(logo).toHaveAttribute("src", "/providers/goplus-logo.png");
  await logo.scrollIntoViewIfNeeded(); await expect.poll(() => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(388);
  await expect(contract.getByRole("link", { name: "GoPlus source", exact: true })).toHaveAttribute("href", report.token.securitySnapshot.sourceUrl);
  await expect(contract.getByRole("link", { name: "GoPlus source", exact: true })).toHaveAttribute("rel", "noopener noreferrer nofollow");
  const references = page.getByRole("region", { name: "References", exact: true });
  await expect(references.getByRole("link", { name: "BaseScan token", exact: true })).toHaveAttribute("href", `https://basescan.org/token/${report.token.address}`);
  await expect(references.getByRole("link", { name: "DEX Screener metadata", exact: true })).toHaveAttribute("href", report.token.marketSnapshot.sourceUrl);
  await expect(references.getByRole("link", { name: "GoPlus holder and contract context", exact: true })).toHaveAttribute("href", report.token.securitySnapshot.sourceUrl);
  await expect(references.getByText(checkedAt, { exact: true })).toHaveCount(2);
  await expect(references).toContainText("separate from transaction proof");
  const transactions = new Set(report.evidence.map((item) => item.transactionHash)).size;
  await expect(references.getByRole("link", { name: `Transaction evidence (${transactions} transactions)`, exact: true })).toHaveCount(1);
  await references.getByRole("link", { name: `Transaction evidence (${transactions} transactions)`, exact: true }).click();
  await expect(page.locator(`[id="evidence-${report.evidence[0].id}"]`)).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page); await scrollForCapture(contract);
  await page.screenshot({ path: ".next/investigation-contract-goplus-mobile.png" });
});

test("reference report facts show creator holdings, liquidity, groups and exclusions without a read-coverage verdict", async ({ page }) => {
  const report = getBrowserReportFixture(), unit = 10n ** 18n;
  report.token.totalSupplyRaw = (1000n * unit).toString();
  const balances = [
    { address: browserFixture.funder, balanceRaw: (848n * unit).toString() },
    { address: browserFixture.walletA, balanceRaw: (125n * unit).toString() },
    { address: browserFixture.walletB, balanceRaw: (20n * unit).toString() },
    { address: browserFixture.pool, balanceRaw: (7n * unit).toString() },
  ];
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: report.range.to, totalSupplyRaw: report.token.totalSupplyRaw,
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${report.token.address}/holders`, observedAt: report.generatedAt, status: "partial", pages: 1, addresses: 4, finalizedCensus: false, reason: "Synthetic partial candidate discovery." },
    balances: { status: "complete", requestedWallets: 4, verifiedWallets: 4, reason: null },
    holders: balances.map((entry) => ({ ...entry, status: "verified", discoveredBy: "indexed" })),
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: report.generatedAt },
  };
  report.wallets.forEach((wallet) => { wallet.balanceRaw = balances.find((entry) => entry.address === wallet.address)?.balanceRaw ?? null; });
  report.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt: report.generatedAt, sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: browserFixture.pool, priceUsd: "0.01", marketCapUsd: 1000, liquidityUsd: 3.69, volume24hUsd: 10, priceChange24hPercent: null, pairCreatedAt: null };
  report.token.securitySnapshot = { source: "goplus", status: "reported", checkedAt: report.generatedAt, sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`, tokenAddress: report.token.address, chainId: 8453, holderCount: 13, creatorAddress: browserFixture.funder, checks: [{ id: "is_mintable", value: "yes" }] };
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  const verdict = page.getByRole("region", { name: "Important checks", exact: true });
  await expect(verdict).toContainText("CAUTION");
  await verdict.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^What was checked$/ }) }).locator("summary").first().click();
  await expect(verdict).toContainText("Creator holds 85.39% of float");
  await expect(verdict).toContainText("4 of 4 candidate balances");
  await expect(verdict).not.toContainText("100%"); await expect(verdict).not.toContainText("READ COVERAGE");
  await expect(verdict).toContainText("Thin liquidity ($3.69)");
  await inspectDetails(page);
  await expect(page.getByRole("region", { name: "Contract", exact: true })).toContainText("Mintable flag");
  const creator = page.getByRole("region", { name: "Deployer DNA", exact: true });
  await expect(creator).toContainText("Source-reported creator"); await expect(creator).toContainText("84.8%");
  await expect(creator).toContainText("Native funding sent: 2 retained records");
  await expect(creator.getByRole("link", { name: "Creator source", exact: true })).toHaveAttribute("href", report.token.securitySnapshot.sourceUrl);
  const exclusions = page.getByRole("region", { name: "Excluded addresses", exact: true });
  await expect(exclusions.getByRole("columnheader", { name: "Excluded as", exact: true })).toBeVisible();
  await expect(exclusions.locator("tbody tr")).toHaveCount(1);
  const excludedPool = exclusions.locator("tbody tr").filter({ has: page.getByRole("button", {
    name: `${browserFixture.pool.slice(0, 6)}…${browserFixture.pool.slice(-4)}`, exact: true,
  }) });
  await expect(excludedPool).toHaveCount(1);
  await expect(excludedPool.getByRole("cell", { name: "Authenticated pool", exact: true })).toBeVisible();
  await expect(excludedPool.getByRole("cell", { name: "0.7%", exact: true })).toBeVisible();
  await expect(exclusions.getByRole("cell", { name: "Unclassified", exact: true })).toHaveCount(0);
  const clusters = page.getByRole("region", { name: "Clusters", exact: true });
  await expect(clusters).toContainText("100%"); await expect(clusters).toContainText("3 / 3 balances");
  const funding = page.getByRole("region", { name: "Native funding", exact: true });
  await expect(funding.locator("tbody tr")).toHaveCount(2);
  const orderedSections = ["verdict-score-title", "score-breakdown-title", "questions-title", "time-machine-title", "clusters-title", "deployer-dna-title"];
  const offsets = await page.evaluate((ids) => ids.map((id) => document.getElementById(id)!.getBoundingClientRect().top + scrollY), orderedSections);
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  await expect(page.locator(".traceforce-primary-column").getByRole("region", { name: "Top holders", exact: true })).toHaveCount(1);
  await assertNoPageOverflow(page);
  await scrollForCapture(verdict); await page.screenshot({ path: ".next/synthetic-reference-report-desktop.png" });
  await page.screenshot({ path: ".next/synthetic-reference-report-full.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await scrollForCapture(creator); await page.screenshot({ path: ".next/synthetic-creator-report-mobile.png" });
});

test("synthetic browser fixture: report fits 375px and production CSP permits evidence interactions", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__investigationCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockCompletedReport(page);
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  await graph.hover(); await assertNoPageOverflow(page);
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.setViewportSize({ width: 375, height: 812 });
  await page.locator("details[data-report-checks] > summary").click();
  await page.locator("summary").filter({ hasText: /^Transaction evidence \(/ }).click();
  await expect(page.getByRole("link", { name: "Inspect transaction", exact: true }).first()).toHaveAttribute("href", /^https:\/\/base\.blockscout\.com\/tx\/0x[0-9a-f]{64}$/);
  await assertNoPageOverflow(page);
  await page.getByText("Timeline and retained connections", { exact: true }).click();
  await page.getByRole("region", { name: "All retained connections", exact: true }).getByRole("link", { name: "Evidence 1", exact: true }).last().click();
  await assertNoPageOverflow(page);
  // Next.js manages its own hidden routing nodes; report sections use classes.
  expect(await page.locator("section[aria-labelledby] [style]").count()).toBe(0);
  const violations = await page.evaluate(() => (window as unknown as { __investigationCspViolations: string[] }).__investigationCspViolations);
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
  await page.locator("details[open] > summary").evaluateAll((summaries) => summaries.forEach((summary) => (summary.parentElement as HTMLDetailsElement).open = false));
  await scrollForCapture(page.getByRole("heading", { name: "Your investigation report", exact: true }));
  await page.screenshot({ path: ".next/investigation-mobile.png" });
  await scrollForCapture(page.getByRole("region", { name: "Observed relationships", exact: true }));
  await page.screenshot({ path: ".next/investigation-mobile-graph.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await scrollForCapture(page.getByRole("heading", { name: "Your investigation report", exact: true }));
  await page.screenshot({ path: ".next/investigation-desktop.png" });
});

test("a public request failure preserves the form and explains the error", async ({ page }) => {
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 503, json: { error: "Investigations are temporarily unavailable." } }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Investigations are temporarily unavailable." })).toBeVisible();
  await expect(page.getByLabel("Base token contract")).toHaveValue(browserFixture.token);
  await expect(page.getByRole("button", { name: "Start investigation", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 375, height: 812 });
  await assertNoPageOverflow(page);
});

test("a former saved report address has no report lookup and links to a fresh crawl", async ({ page }) => {
  const lookups: string[] = [];
  page.on("request", (request) => { if (/\/api\/investigations\//.test(request.url())) lookups.push(request.url()); });
  await page.goto(reportPath);
  await expect(page.getByRole("heading", { name: "Reports stay with you.", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open investigations", exact: true })).toHaveAttribute("href", "/investigate");
  await expect(page.getByRole("heading", { name: "Transaction evidence", exact: true })).toHaveCount(0);
  expect(lookups).toEqual([]);
});

test("clearing, refreshing and resubmitting do not automatically save or recover a report", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/investigations", (route) => { submissions++; return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report: getBrowserReportFixture() }) + "\n" }); });
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear report", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Base token contract")).toBeFocused();
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible(); expect(submissions).toBe(2);
  await page.reload(); await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toHaveCount(0); expect(submissions).toBe(2);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test("synthetic browser fixture: questions cite current evidence, reject invented citations and request a fresh scan explicitly", async ({ page }) => {
  const context = "synthetic-signed-question-context", report = getBrowserReportFixture(), id = report.evidence.at(-1)!.id;
  const requests: unknown[] = []; let submissions = 0;
  await page.route("**/api/questions", (route) => {
    requests.push(route.request().postDataJSON()); submissions++;
    return route.fulfill({ status: 200, json: submissions === 1 ? { answer: "Synthetic answer: this transfer connects the cited addresses.", caveat: "Synthetic fixture; this does not prove ownership.", evidenceIds: [id], needsFreshScan: true } : { answer: "Unsupported invented answer.", caveat: "Synthetic invalid fixture.", evidenceIds: ["invented-id"], needsFreshScan: false } });
  });
  await mockCompletedReport(page, context);
  await page.clock.install();
  const chat = page.getByRole("region", { name: "Questions about this token", exact: true });
  await chat.getByLabel("Ask about the observed evidence").fill("What connects these wallets?"); await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(chat.getByText("Synthetic answer: this transfer connects the cited addresses.", { exact: true })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Run a fresh scan", exact: true })).toBeVisible();
  await chat.screenshot({ path: ".next/investigation-chat-desktop.png" });
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await scrollForCapture(chat); await page.screenshot({ path: ".next/investigation-chat-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const target = page.locator(`[id="evidence-${id}"]`); await expect(target).toHaveCount(0);
  const citation = chat.getByRole("link", { name: "Evidence 1", exact: true });
  await citation.click(); await expect(target).toBeFocused();
  await expect(target).toHaveAttribute("data-evidence-highlighted", "true");
  await expect.poll(() => target.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("inset");
  const highlighted = await target.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow }));
  expect(highlighted.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(highlighted.shadow).toContain("inset");
  await page.clock.fastForward(3_000);
  await citation.focus(); await page.keyboard.press("Enter");
  await expect(target).toBeFocused();
  await page.clock.fastForward(1_500);
  await expect(target).toHaveAttribute("data-evidence-highlighted", "true");
  await page.clock.fastForward(2_600);
  await expect(target).not.toHaveAttribute("data-evidence-highlighted", "true");
  await expect(target).toBeFocused();
  await expect.poll(() => target.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(highlighted.background);
  expect(requests).toEqual([{ question: "What connects these wallets?", context }]);
  await chat.getByLabel("Ask about the observed evidence").fill("Can you cite an invented record?"); await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(chat.getByRole("alert")).toContainText("The answer could not be validated."); await expect(chat.getByText("Unsupported invented answer.", { exact: true })).toHaveCount(0);
  await chat.getByRole("button", { name: "Clear conversation", exact: true }).click(); await expect(chat.getByText("What connects these wallets?", { exact: true })).toHaveCount(0);
});

test("cancelling a question aborts its own request and clearing a report removes the conversation", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window); Object.defineProperty(window, "__syntheticQuestionCancelled", { value: { aborted: false } });
    window.fetch = async (input, init) => {
      if (String(input) !== "/api/questions") return original(input, init);
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { (window as unknown as { __syntheticQuestionCancelled: { aborted: boolean } }).__syntheticQuestionCancelled.aborted = true; reject(new DOMException("Cancelled", "AbortError")); }, { once: true }); });
    };
  });
  await mockCompletedReport(page, "synthetic-question-cancellation-context");
  const chat = page.getByRole("region", { name: "Questions about this token", exact: true });
  await chat.getByLabel("Ask about the observed evidence").fill("Synthetic cancellable question"); await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(chat.getByRole("status")).toBeVisible(); await chat.getByRole("button", { name: "Cancel question", exact: true }).click();
  const cancelled = chat.getByRole("alert", { name: "Request not completed", exact: true });
  await expect(cancelled.getByText("Question cancelled.", { exact: true })).toBeVisible();
  await expect(cancelled.getByRole("button", { name: "Retry question", exact: true })).toBeEnabled();
  await expect(chat.locator("[data-chat-assistant], [data-chat-answer], [data-chat-avatar]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __syntheticQuestionCancelled: { aborted: boolean } }).__syntheticQuestionCancelled.aborted)).toBe(true);
  await page.evaluate(() => { (window as unknown as { __syntheticQuestionCancelled: { aborted: boolean } }).__syntheticQuestionCancelled.aborted = false; });
  await chat.getByLabel("Ask about the observed evidence").fill("Synthetic request cancelled by clearing the report"); await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(chat.getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "Clear report", exact: true }).click(); await expect(chat).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __syntheticQuestionCancelled: { aborted: boolean } }).__syntheticQuestionCancelled.aborted)).toBe(true);
});

test("chat shows separate thinking bubbles and retries a failed social turn without duplicate user messages", async ({ page }) => {
  const context = "synthetic-social-lifecycle-context", requests: unknown[] = [], pending: Route[] = [];
  await page.route("**/api/questions", (route) => { requests.push(route.request().postDataJSON()); pending.push(route); });
  await mockCompletedReport(page, context);
  const chat = page.getByRole("region", { name: "Questions about this token", exact: true }), conversation = chat.getByRole("list", { name: "Questions and answers", exact: true });
  const composer = chat.getByLabel("Ask about the observed evidence"), submit = chat.getByRole("button", { name: "Ask investigator", exact: true });
  await expect(conversation.getByRole("listitem")).toHaveCount(0);
  await expect(chat.getByText("TraceForge AI", { exact: true })).toHaveCount(0);
  await composer.fill("hey"); await submit.click();
  await expect(chat.getByRole("status")).toHaveText("Reading report…");
  await expect(conversation.getByText("hey", { exact: true })).toBeVisible();
  await expect(composer).toBeDisabled(); await expect(submit).toBeDisabled();
  await chat.locator("form").evaluate((form) => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
  await expect.poll(() => pending.length).toBe(1); expect(requests).toHaveLength(1);
  const greeting = "Synthetic model greeting: hello, how can I help with this scan?";
  await pending.shift()!.fulfill({ status: 200, json: { answer: greeting, caveat: "", evidenceIds: [], needsFreshScan: false } });
  await expect(conversation.getByText(greeting, { exact: true })).toBeVisible(); await expect(composer).toBeFocused();

  await composer.fill("do you know me?"); await submit.click();
  await expect(chat.getByRole("status")).toHaveText("Reading report…"); await expect.poll(() => pending.length).toBe(1);
  await pending.shift()!.fulfill({ status: 400, json: { error: "Synthetic scope failure: this question could not be answered." } });
  const failedTurn = conversation.getByRole("listitem").filter({ has: page.getByText("do you know me?", { exact: true }) });
  const failedStatus = failedTurn.getByRole("alert", { name: "Request not completed", exact: true });
  await expect(failedStatus.getByText("Synthetic scope failure: this question could not be answered.", { exact: true })).toBeVisible();
  await expect(failedTurn.locator("[data-chat-assistant], [data-chat-answer], [data-chat-avatar]")).toHaveCount(0);
  await expect(failedTurn.getByText("Response unavailable", { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("do you know me?");
  await failedTurn.screenshot({ path: ".next/investigation-chat-no-answer-desktop.png" });
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await failedTurn.screenshot({ path: ".next/investigation-chat-no-answer-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await submit.click(); await expect.poll(() => pending.length).toBe(1);
  await expect(conversation.getByRole("listitem")).toHaveCount(2); await expect(failedTurn.getByRole("status")).toBeVisible();
  await pending.shift()!.fulfill({ status: 429, json: { error: "Synthetic quota failure: please try again later." } });
  await expect(failedStatus.getByText("Synthetic quota failure: please try again later.", { exact: true })).toBeVisible();
  await expect(failedTurn.locator("[data-chat-assistant], [data-chat-answer], [data-chat-avatar]")).toHaveCount(0);
  await failedTurn.getByRole("button", { name: "Retry question", exact: true }).click();
  await expect(failedTurn.getByRole("status")).toHaveText("Reading report…"); await expect.poll(() => pending.length).toBe(1);
  await pending.shift()!.fulfill({ status: 200, json: { answer: "Synthetic model response: I do not know your personal identity.", caveat: "", evidenceIds: [], needsFreshScan: false } });
  await expect(failedTurn.getByText("Synthetic model response: I do not know your personal identity.", { exact: true })).toBeVisible();
  await expect(failedTurn.getByRole("alert")).toHaveCount(0); await expect(conversation.getByRole("listitem")).toHaveCount(2);
  const history = [{ role: "user", content: "hey" }, { role: "assistant", content: greeting }];
  expect(requests).toEqual([{ question: "hey", context }, ...Array.from({ length: 3 }, () => ({ question: "do you know me?", context, history }))]);
  await chat.screenshot({ path: ".next/investigation-chat-lifecycle-desktop.png" });
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page); await scrollForCapture(chat);
  await page.screenshot({ path: ".next/investigation-chat-lifecycle-mobile.png" });
});

test("chat keeps each failed turn visible in the transcript and scrolls to the latest error", async ({ page }) => {
  const requests: unknown[] = [];
  const failures = [
    { status: 503, json: { error: "Synthetic model unavailable. Please try again." } },
    { status: 429, json: { error: "Synthetic question quota reached. Please try again later." } },
    { status: 200, json: { answer: "Unsupported invented response must not be shown.", caveat: "", needsFreshScan: false, evidenceIds: ["invented-id"] } },
  ];
  await page.route("**/api/questions", (route) => { requests.push(route.request().postDataJSON()); return route.fulfill(failures[requests.length - 1]); });
  await mockCompletedReport(page, "synthetic-failed-turns-context");
  const chat = page.getByRole("region", { name: "Questions about this token", exact: true }), conversation = chat.getByRole("list", { name: "Questions and answers", exact: true });
  const questions = ["Synthetic model question", "Synthetic quota question", "Synthetic malformed response question"];
  for (const [index, question] of questions.entries()) {
    await chat.getByLabel("Ask about the observed evidence").fill(question); await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
    const turn = conversation.getByRole("listitem").filter({ has: page.getByText(question, { exact: true }) });
    await expect(turn.getByRole("alert")).toContainText(index === 0 ? "Synthetic model unavailable." : index === 1 ? "Synthetic question quota reached." : "The answer could not be validated.");
    await expect(turn.getByRole("button", { name: "Retry question", exact: true })).toBeEnabled();
  }
  await expect(conversation.getByRole("listitem")).toHaveCount(3); await expect(conversation.getByRole("alert")).toHaveCount(3);
  await expect(conversation.getByText("Unsupported invented response must not be shown.", { exact: true })).toHaveCount(0);
  const latestError = conversation.getByRole("alert").last(), scrollBox = chat.locator('[aria-label="Conversation"]');
  await expect.poll(async () => { const container = await scrollBox.boundingBox(), error = await latestError.boundingBox(); return container !== null && error !== null && error.y >= container.y && error.y + error.height <= container.y + container.height; }).toBe(true);
  expect(requests).toEqual(questions.map((question) => ({ question, context: "synthetic-failed-turns-context" })));
  await page.setViewportSize({ width: 375, height: 812 }); await assertNoPageOverflow(page);
  await chat.getByRole("button", { name: "Clear conversation", exact: true }).click();
  await expect(conversation.getByRole("listitem")).toHaveCount(0); await expect(chat.getByRole("alert")).toHaveCount(0);
});

test("explicit browser snapshots survive refresh without a network scan or a persisted question capsule", async ({ page }) => {
  const capsule = "synthetic-capsule-must-never-be-saved"; let scans = 0;
  page.on("request", (request) => { if (request.method() === "POST" && /\/api\/investigations$/.test(request.url())) scans++; });
  await mockCompletedReport(page, capsule);
  await expect(page.getByRole("region", { name: "Local snapshots", exact: true }).getByRole("button", { name: "Open snapshot", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save in this browser", exact: true }).click();
  await expect(page.getByText("Report saved in this browser.", { exact: true })).toBeVisible();
  const records = await page.evaluate(async () => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open("traceforce-browser-reports", 1); request.onerror = () => reject(new Error("Synthetic storage inspection failed")); request.onsuccess = () => { const database = request.result, tx = database.transaction("reports", "readonly"), read = tx.objectStore("reports").getAll(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(new Error("Synthetic storage inspection failed")); tx.oncomplete = () => database.close(); };
  }));
  expect(records).toHaveLength(1); expect(JSON.stringify(records)).not.toContain(capsule); expect(Object.keys(records[0] as object).sort()).toEqual(["bytes", "id", "lastOpenedAt", "report", "savedAt", "schemaVersion"]);
  await page.reload(); await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open snapshot", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible(); await expect(page.getByText(/Saved snapshot from/)).toBeVisible();
  await expect(page.getByText(/Opening it does not collect new data/)).toBeVisible(); expect(scans).toBe(1);
  await expect(page.getByLabel("Ask about the observed evidence")).toHaveCount(0); await expect(page.getByText("Start a fresh scan to chat about this token. Saved snapshots do not include an active chat session.", { exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Local snapshots", exact: true }).getByRole("button", { name: /^Remove saved report/ }).click();
  await expect(page.getByText("No reports saved in this browser.", { exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible();
});

test("JSON download exports report evidence without the signed session or question conversation", async ({ page }) => {
  const context = "synthetic-download-excluded-context";
  await page.route("**/api/questions", (route) => route.fulfill({ status: 200, json: { answer: "Synthetic conversation must not enter a report export.", caveat: "Synthetic fixture.", evidenceIds: [], needsFreshScan: true } }));
  await mockCompletedReport(page, context);
  await page.getByLabel("Ask about the observed evidence").fill("Synthetic private conversation"); await page.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(page.getByText("Synthetic conversation must not enter a report export.", { exact: true })).toBeVisible();
  const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "Download JSON", exact: true }).click(); const download = await pending;
  expect(download.suggestedFilename()).toBe(`traceforce-base-${browserFixture.token}-400.json`);
  const content = await readFile((await download.path())!, "utf8"); expect(JSON.parse(content)).toEqual(getBrowserReportFixture()); expect(content).not.toContain(context); expect(content).not.toContain("Synthetic private conversation");
});

test("five-snapshot eviction keeps a recently opened report and clear-all removes only browser copies", async ({ page }) => {
  test.setTimeout(60_000); let sequence = 0;
  await page.route("**/api/investigations", (route) => { const report = getBrowserReportFixture(); sequence++; report.id = `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`; report.explanation.reportId = report.id; report.token.name = `Synthetic snapshot ${sequence}`; return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }); });
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token);
  for (let index = 1; index <= 5; index++) { await page.getByRole("button", { name: "Start investigation", exact: true }).click(); await expect(page.getByRole("heading", { name: `Synthetic snapshot ${index}`, level: 2, exact: true })).toBeVisible(); await page.getByRole("button", { name: "Save in this browser", exact: true }).click(); await expect(page.getByText("Report saved in this browser.", { exact: true })).toBeVisible(); }
  const local = page.getByRole("region", { name: "Local snapshots", exact: true });
  await local.getByRole("listitem").filter({ has: page.getByText("Synthetic snapshot 1", { exact: true }) }).getByRole("button", { name: "Open snapshot", exact: true }).click();
  await expect(page.getByText("Opened a saved browser snapshot. No fresh crawl was requested.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start investigation", exact: true }).click(); await expect(page.getByRole("heading", { name: "Synthetic snapshot 6", level: 2, exact: true })).toBeVisible(); await page.getByRole("button", { name: "Save in this browser", exact: true }).click();
  await expect(local.getByRole("listitem")).toHaveCount(5); await expect(local.getByText("Synthetic snapshot 1", { exact: true })).toBeVisible(); await expect(local.getByText("Synthetic snapshot 2", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/1 older snapshot was removed/)).toBeVisible();
  await local.getByRole("button", { name: "Clear all saved reports", exact: true }).click(); await expect(local.getByRole("listitem")).toHaveCount(0); await expect(page.getByRole("heading", { name: "Synthetic snapshot 6", level: 2, exact: true })).toBeVisible();
});

test("unavailable browser storage leaves the current report usable with a readable save error", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { value: { open() { throw new DOMException("Synthetic quota fixture", "QuotaExceededError"); } } }); });
  await mockCompletedReport(page); await page.getByRole("button", { name: "Save in this browser", exact: true }).click();
  await expect(page.getByRole("region", { name: "Local snapshots", exact: true }).getByRole("alert")).toContainText("Browser storage is full."); await expect(page.getByRole("heading", { name: "Synthetic browser test fixture", level: 2, exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Download JSON", exact: true })).toBeEnabled();
});

test("corrupt browser snapshots are discarded rather than rendered or recovered from the server", async ({ page }) => {
  await mockCompletedReport(page); await page.getByRole("button", { name: "Save in this browser", exact: true }).click(); await expect(page.getByText("Report saved in this browser.", { exact: true })).toBeVisible();
  await page.evaluate(async () => new Promise<void>((resolve, reject) => { const open = indexedDB.open("traceforce-browser-reports", 1); open.onerror = () => reject(new Error("Synthetic fixture edit failed")); open.onsuccess = () => { const database = open.result, tx = database.transaction("reports", "readwrite"), store = tx.objectStore("reports"), read = store.getAll(); read.onsuccess = () => { const snapshot = read.result[0]; snapshot.report.explanation = null; store.put(snapshot); }; tx.oncomplete = () => { database.close(); resolve(); }; tx.onabort = () => { database.close(); reject(new Error("Synthetic fixture edit failed")); }; }; }));
  const lookups: string[] = []; page.on("request", (request) => { if (/\/api\/investigations/.test(request.url())) lookups.push(request.url()); });
  await page.reload(); await expect(page.getByText("No reports saved in this browser.", { exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toHaveCount(0); expect(lookups).toEqual([]);
  await expect.poll(() => page.evaluate(async () => new Promise<number>((resolve) => { const open = indexedDB.open("traceforce-browser-reports", 1); open.onsuccess = () => { const database = open.result, tx = database.transaction("reports", "readonly"), count = tx.objectStore("reports").count(); count.onsuccess = () => resolve(count.result); tx.oncomplete = () => database.close(); }; }))).toBe(0);
});

test("cancel aborts the current stream without displaying a report", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window); Object.defineProperty(window, "__syntheticStreamAborted", { value: { aborted: false } });
    window.fetch = async (input, init) => {
      if (String(input) !== "/api/investigations") return original(input, init);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"progress","stage":"Synthetic fixture: collecting"}\n'));
        init?.signal?.addEventListener("abort", () => { (window as unknown as { __syntheticStreamAborted: { aborted: boolean } }).__syntheticStreamAborted.aborted = true; controller.error(new DOMException("Cancelled", "AbortError")); }, { once: true });
      } }), { headers: { "content-type": "application/x-ndjson" } });
    };
  });
  await page.goto("/investigate"); await page.getByLabel("Base token contract").fill(browserFixture.token); await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  const loading = page.locator("[data-scan-progress]");
  await expect(loading).toHaveAttribute("data-scan-stage", "investigating");
  await expect(loading.getByRole("status").locator("p")).toHaveText(["Checking the token", "Reviewing the available information."]);
  await expect(loading).not.toContainText("Synthetic fixture: collecting");
  await page.getByRole("button", { name: "Cancel investigation", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Investigation cancelled." })).toBeVisible(); await expect(page.getByRole("button", { name: "Start investigation", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __syntheticStreamAborted: { aborted: boolean } }).__syntheticStreamAborted.aborted)).toBe(true);
});
