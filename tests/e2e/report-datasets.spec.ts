import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Address, ExplainedInvestigationReport } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";
import { assessInvestigationReport } from "../../src/domain/investigations/report-assessment";
import { expectedDecisionWeights } from "../fixtures/decision-weights";

test.use({ colorScheme: "dark" });

async function openReport(page: Page, report: ExplainedInvestigationReport) {
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report }) + "\n" }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible();
}

/** Keep the fabricated accounting intact while moving a young token to a mature chain. */
function sparseFullHistoryReport(): ExplainedInvestigationReport {
  const report = getBrowserWalletFlagsFixture(), offset = 52_000_000n;
  const shifted = (block: string) => (BigInt(block) + offset).toString();
  report.range.from.timestamp = browserFixture.timestamp - 74_000_000;
  report.range.to.number = shifted(report.range.to.number);
  for (const event of report.evidence) event.blockNumber = shifted(event.blockNumber);
  for (const snapshot of [report.holderSnapshot, report.walletActivitySnapshot, report.liquiditySnapshot]) {
    if (snapshot) snapshot.block = { ...report.range.to };
  }
  report.coverage.transferCrawl = { scope: "full", source: "rpc-logs", completedRanges: [{ fromBlock: "0", toBlock: report.range.to.number }] };
  for (const funding of report.coverage.funding) funding.toBlock = report.range.to.number;
  return report;
}

test("dataset comparison keeps missing observations unknown and links directly from the report overview", async ({ page }) => {
  const report = getBrowserReportFixture();
  await openReport(page, report);
  const comparison = page.getByRole("region", { name: "Data comparison", exact: true });
  const balances = comparison.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Pinned candidate balances", exact: true }) });
  await expect(balances).toContainText("Unknown");
  await expect(balances).toContainText("Missing balance observations remain unknown");
  await expect(balances).not.toContainText("0 positive");
  await expect(comparison.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Token activity", exact: true }) })).toContainText("26 receipt-verified transfer records · 26 transactions");
  await expect(comparison).toContainText("3 nonzero endpoints · 2 eligible participants");
  await page.getByRole("link", { name: "Compare acquired datasets and coverage", exact: true }).click();
  await expect(comparison.getByRole("heading", { name: "Data comparison", exact: true })).toBeFocused();
  const judge = page.getByRole("region", { name: "Explanation in plain English", exact: true });
  await expect(judge.locator('dl[aria-label="AI review receipt"]')).toContainText("synthetic-qwen3:4b-test-fixture");
  await expect(judge.locator('dl[aria-label="AI review receipt"]')).toContainText("3 of 28 records");
  await expect(judge.locator('dl[aria-label="AI review receipt"]')).toContainText("25 records");
  await expect(judge.locator('dl[aria-label="AI review receipt"]')).toContainText("Legacy AI commentary");
  await expect(judge.locator('dl[aria-label="AI review receipt"] time')).toHaveAttribute("datetime", report.explanation.generatedAt);
});

test("source comparison preserves distinct counts and time anchors at mobile width under CSP", async ({ page }) => {
  const report = getBrowserReportFixture(), indexedAt = "2026-10-12T00:00:02.000Z", balancedAt = "2026-10-12T00:00:03.000Z";
  const extra = "0x00000000000000000000000000000000000000ff" as Address;
  report.token.totalSupplyRaw = "1000";
  report.coverage.transferCrawl = { scope: "window", source: "rpc-logs", completedRanges: [{ fromBlock: "100", toBlock: "150" }, { fromBlock: "200", toBlock: "210" }] };
  report.holderSnapshot = {
    chainId: 8453, tokenAddress: report.token.address, block: report.range.to, totalSupplyRaw: report.token.totalSupplyRaw,
    discovery: { provider: "GoPlus", sourceUrl: `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${report.token.address}`, observedAt: indexedAt, status: "partial", pages: 1, addresses: 3, finalizedCensus: false, reason: null },
    balances: { status: "partial", requestedWallets: 5, verifiedWallets: 3, reason: null },
    holders: [
      { address: browserFixture.walletA, balanceRaw: "100", status: "verified", discoveredBy: "indexed" },
      { address: browserFixture.walletB, balanceRaw: "0", status: "verified", discoveredBy: "observed" },
      { address: browserFixture.funder, balanceRaw: null, status: "unavailable", discoveredBy: "observed" },
      { address: browserFixture.pool, balanceRaw: "700", status: "verified", discoveredBy: "indexed" },
      { address: extra, balanceRaw: null, status: "not_examined", discoveredBy: "indexed" },
    ],
    provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: balancedAt },
  };
  for (const wallet of report.wallets) wallet.balanceRaw = report.holderSnapshot.holders.find((holder) => holder.address === wallet.address)?.balanceRaw ?? null;
  report.token.securitySnapshot = { source: "goplus", status: "reported", checkedAt: indexedAt, sourceUrl: report.holderSnapshot.discovery.sourceUrl, tokenAddress: report.token.address, chainId: 8453, holderCount: 0, creatorAddress: null, checks: [{ id: "is_mintable", value: "unknown" }] };
  report.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt: "2026-10-12T00:00:04.000Z", sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: browserFixture.pool, priceUsd: "0.01", marketCapUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPercent: null, pairCreatedAt: null };
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__datasetCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await openReport(page, report);
  const comparison = page.getByRole("region", { name: "Data comparison", exact: true });
  await page.getByRole("link", { name: "Compare acquired datasets and coverage", exact: true }).click();
  await expect(comparison).toContainText("3 indexed candidates · 1 pages");
  await expect(comparison).toContainText("5 merged balance candidates retained");
  await expect(comparison).toContainText("3 / 5 reads verified");
  await expect(comparison).toContainText("2 positive · 1 verified zero");
  await expect(comparison).toContainText("1 unavailable · 1 not examined");
  await expect(comparison).toContainText("0 source-reported holders");
  const market = page.getByRole("region", { name: "Market snapshot", exact: true });
  const holderMetric = market.locator("dl > div").filter({ has: page.locator("dt").filter({ hasText: /^Wallets shown$/ }) });
  await expect(holderMetric.locator("dd > span:first-child")).toHaveText("0");
  await expect(market).toContainText("GoPlus reported 0 holders; the pinned snapshot verifies 2 positive addresses. Its reported zero is not used as a total.");
  await expect(page.getByRole("region", { name: "Top holders", exact: true })).toContainText("GoPlus count inconsistent");
  await expect(comparison).toContainText("Finalized block 400");
  await expect(comparison).toContainText(`Retrieved ${balancedAt}`);
  await expect(comparison).toContainText("Unpinned source context");
  await expect(comparison).toContainText("do not establish independent corroboration");
  await expect(comparison).toContainText("Recent-window crawl requested");
  await comparison.getByText("2 completed discovery ranges", { exact: true }).click();
  await expect(comparison.getByText("Blocks 100–150", { exact: true })).toBeVisible();
  await expect(comparison.getByText("Blocks 200–210", { exact: true })).toBeVisible();
  await expect(comparison).toContainText("Crawl start is not token launch");
  const goPlus = comparison.getByRole("link", { name: "GoPlus", exact: true });
  await expect(goPlus).toHaveCount(2);
  await expect(goPlus.first()).toHaveAttribute("href", report.token.securitySnapshot.sourceUrl);
  await expect(comparison.locator("[style]")).toHaveCount(0);
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(await page.evaluate(() => (window as unknown as { __datasetCspViolations: string[] }).__datasetCspViolations)).toEqual([]);
  await comparison.screenshot({ path: ".next/report-datasets-mobile.png" });
});

test("reference report geometry keeps the graph beside the stacked sidebar and fits desktop, mobile and landscape", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__layoutCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openReport(page, getBrowserReportFixture());
  const shell = page.locator(".traceforce-report"), graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  const gauge = page.getByRole("region", { name: "Score", exact: true });
  const verdict = page.getByRole("region", { name: "VERDICT OUTPUT", exact: true }), breakdown = page.getByRole("region", { name: "Score breakdown", exact: true });
  const [shellBox, graphBox, gaugeBox, verdictBox, breakdownBox] = await Promise.all([shell.boundingBox(), graph.boundingBox(), gauge.boundingBox(), verdict.boundingBox(), breakdown.boundingBox()]);
  expect(shellBox!.width).toBe(1196);
  expect(graphBox!.width / gaugeBox!.width).toBeGreaterThan(1.5);
  expect(graphBox!.width / gaugeBox!.width).toBeLessThan(1.6);
  expect(Math.abs(graphBox!.y - gaugeBox!.y)).toBeLessThan(1);
  expect(gaugeBox!.y).toBeLessThan(verdictBox!.y);
  expect(verdictBox!.y).toBeLessThan(breakdownBox!.y);
  expect(await graph.evaluate((element) => getComputedStyle(element.parentElement!).position)).toBe("static");
  expect(await graph.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("2px");
  const primary = shell.locator(".traceforce-primary-column"), holders = page.getByRole("region", { name: "Top holders", exact: true });
  await expect(primary.getByRole("region", { name: "Observed relationships", exact: true })).toHaveCount(1);
  await expect(primary.getByRole("region", { name: "Top holders", exact: true })).toHaveCount(1);
  const holdersBox = await holders.boundingBox(), timeMachineBox = await page.getByRole("region", { name: "// TIME MACHINE", exact: true }).boundingBox();
  expect(Math.abs(holdersBox!.x - graphBox!.x)).toBeLessThan(1);
  expect(Math.abs(holdersBox!.width - graphBox!.width)).toBeLessThan(1);
  expect(holdersBox!.y).toBeGreaterThanOrEqual(graphBox!.y + graphBox!.height);
  expect(holdersBox!.y).toBeLessThan(timeMachineBox!.y);
  expect(holdersBox!.x + holdersBox!.width).toBeLessThan(verdictBox!.x);
  await expect(gauge).toContainText("UNKNOWN");
  await expect(gauge.getByText("0", { exact: true })).toBeVisible();
  await expect(gauge).toContainText("/ 100 · PARTIAL");
  await expect(gauge.locator("svg circle")).toHaveCount(1);
  await expect(verdict.getByLabel("Verdict decision weights", { exact: true }).locator("dd")).toHaveText(["0.0%", "100.0%", "0.0%"]);
  const ids = ["token-identity-title", "market-title", "judge-output-title", "holders-title", "score-gauge-title", "verdict-score-title", "score-breakdown-title", "questions-title", "time-machine-title", "clusters-title", "deployer-dna-title", "dataset-comparison-title"];
  const order = await page.evaluate((values) => values.every((id, index) => index === 0 || Boolean(document.getElementById(values[index - 1])!.compareDocumentPosition(document.getElementById(id)!) & Node.DOCUMENT_POSITION_FOLLOWING)), ids);
  expect(order).toBe(true);
  await mkdir(".artifacts/traceforce-reference-parity", { recursive: true });
  const positionHeader = async () => shell.evaluate((element) => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - (document.querySelector("header")?.getBoundingClientRect().height ?? 64) - 18, behavior: "instant" }));
  await positionHeader();
  await page.screenshot({ path: ".artifacts/traceforce-reference-parity/desktop.png" });
  for (const [name, width, height] of [["mobile", 375, 812], ["landscape", 844, 390]] as const) {
    await page.setViewportSize({ width, height });
    await positionHeader();
    const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
    expect(await graph.evaluate((element) => getComputedStyle(element.parentElement!).position)).toBe("static");
    await page.screenshot({ path: `.artifacts/traceforce-reference-parity/${name}.png` });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  const explanation = page.getByRole("region", { name: "Explanation in plain English", exact: true });
  await explanation.getByText(/^Supporting observations \(/).click();
  const proof = explanation.getByRole("link", { name: "Evidence 1", exact: true }).last();
  const target = decodeURIComponent((await proof.getAttribute("href"))!.slice(1));
  await proof.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(`[id="${target}"]`)).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __layoutCspViolations: string[] }).__layoutCspViolations)).toEqual([]);
});

test("reference wallet table shows concise evidence-backed flags, entries and pinned transaction counts", async ({ page }) => {
  const report = getBrowserWalletFlagsFixture();
  const deployment = report.evidence.find((event) => event.kind === "transfer" && event.assetAddress === report.token.address && event.from === "0x0000000000000000000000000000000000000000")!;
  deployment.creation = { creator: browserFixture.funder, contractAddress: report.token.address, transactionTo: null, receiptStatus: "0x1" };
  if (report.token.securitySnapshot?.status === "reported") report.token.securitySnapshot.creatorAddress = null;
  const contractHolder = report.walletActivitySnapshot!.rows.at(-1)!;
  contractHolder.code = "contract";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.addInitScript(() => {
    const checks = { csp: 0 };
    Object.defineProperty(window, "__flagsChecks", { value: checks });
    document.addEventListener("securitypolicyviolation", () => { checks.csp++; });
  });
  await openReport(page, report);
  const holders = page.getByRole("region", { name: "Top holders", exact: true });
  const mainTable = holders.getByRole("table", { name: "Top holders", exact: true });
  const contracts = holders.getByRole("region", { name: "Contract holdings", exact: true });
  await expect(holders).toContainText("12 positive addresses checked: 10 wallets + 1 contract + 1 pool/burn address · 11 source-reported total");
  await expect(holders).toContainText("1 contract holds 1.5% of total supply");
  await expect(contracts).toContainText("Contract balances remain in concentration and dump-risk checks.");
  await expect(mainTable.getByRole("columnheader")).toHaveText(["#", "Wallet", "Float", "Entry", "Txs", "Flags", "Swarm"]);
  await expect(mainTable.locator("tbody tr")).toHaveCount(10);
  const retainedContract = contracts.locator("tbody tr").filter({ has: page.getByRole("button", { name: `${contractHolder.address.slice(0, 6)}…${contractHolder.address.slice(-4)}`, exact: true }) });
  await expect(retainedContract).toHaveCount(1);
  await expect(retainedContract).toContainText("1.5%");
  const creator = mainTable.locator("tbody tr").first();
  await expect(creator).toContainText("86.2%");
  await expect(creator.getByRole("button", { name: "mint", exact: true })).toBeVisible();
  await expect(creator.getByText("Creator", { exact: true })).toBeVisible();
  await expect(creator.getByText("fresh", { exact: true })).toBeVisible();
  await expect(creator.getByRole("cell").nth(4)).toHaveText("6");
  const sniper = mainTable.locator("tbody tr").filter({ has: page.getByText("sniper", { exact: true }) });
  await expect(sniper).toHaveCount(1);
  await expect(sniper.getByRole("button", { name: "buy", exact: true })).toBeVisible();
  await expect(sniper.getByRole("cell").nth(4)).toHaveText("606");
  await expect(holders.getByText("insider", { exact: true })).toBeVisible();
  await expect(page.locator('[data-wallet-marker="creator"]')).toHaveCount(1);
  await expect(page.locator('[data-wallet-marker="fresh"]')).toHaveCount(1);
  const gauge = page.getByRole("region", { name: "Score", exact: true });
  await expect(gauge).toContainText("10 wallets · 1 linked group");
  await expect(page.getByRole("region", { name: "Observed relationships", exact: true })).toContainText("10 wallets · 1 linked group");
  const market = page.getByRole("region", { name: "Market snapshot", exact: true });
  const marketHolders = market.locator("dl > div").filter({ has: page.locator("dt").filter({ hasText: /^Wallets shown$/ }) });
  await expect(marketHolders.locator("dd > span:first-child")).toHaveText("10");
  await expect(market).toContainText("GoPlus reports 11 holders; this separate source count is not pinned to the scan block.");
  await expect(gauge).toContainText("DANGER");
  await expect(gauge).toContainText("modeled dump");
  await expect(gauge).not.toContainText("UNSCORED");
  await expect(page.getByRole("region", { name: "VERDICT OUTPUT", exact: true })).toContainText("AVOID");
  const dna = page.getByRole("region", { name: "Deployer DNA", exact: true });
  await expect(dna.getByText("Receipt-backed creator · Base RPC", { exact: true })).toBeVisible();
  await expect(dna.getByRole("link", { name: "Creator source", exact: true })).toHaveAttribute("href", `https://basescan.org/tx/${deployment.transactionHash}`);
  await expect(dna.getByText("Verified at block 10", { exact: true })).toBeVisible();
  const score = page.getByRole("region", { name: "Score breakdown", exact: true });
  await score.locator("details[data-score-details] > summary").click();
  const dev = score.locator('[data-category-details="dev"]');
  await expect(dev).toContainText(assessInvestigationReport(report).categories.find((category) => category.id === "dev")!.metric!);
  await expect(dev).not.toContainText("Creator not confirmed");
  await creator.getByText("Creator", { exact: true }).click();
  const creatorProof = creator.getByRole("link", { name: "Evidence 1", exact: true }).first();
  await expect(creatorProof).toHaveAttribute("href", `#evidence-${encodeURIComponent(deployment.id)}`);
  await creatorProof.focus(); await page.keyboard.press("Enter");
  const creationEvidence = page.locator(`[id="evidence-${deployment.id}"]`);
  await expect(creationEvidence).toBeFocused();
  await expect(creationEvidence).toHaveAttribute("data-evidence-highlighted", "true");
  await expect(creationEvidence).toContainText("Verified direct contract deployment");
  await expect(creationEvidence).toContainText(browserFixture.funder);
  await expect(creationEvidence).toContainText(report.token.address);
  await creator.getByText("Creator", { exact: true }).click();
  await mkdir(".artifacts/traceforce-reference-parity", { recursive: true });
  await page.locator(".traceforce-report").evaluate((element) => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - (document.querySelector("header")?.getBoundingClientRect().height ?? 64) - 18, behavior: "instant" }));
  await page.screenshot({ path: ".artifacts/traceforce-reference-parity/evidence-report-desktop.png" });
  await holders.scrollIntoViewIfNeeded();
  await mkdir(".artifacts/traceforce-reference-parity", { recursive: true });
  await page.screenshot({ path: ".artifacts/traceforce-reference-parity/wallet-flags-desktop.png" });
  await sniper.getByText("sniper", { exact: true }).click();
  await expect(sniper).toContainText("receipt-verified purchase");
  const proof = sniper.getByRole("link", { name: "Evidence 1", exact: true });
  const id = decodeURIComponent((await proof.getAttribute("href"))!.slice(1));
  await proof.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(`[id="${id}"]`)).toBeFocused();
  await sniper.getByText("sniper", { exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await holders.evaluate((element) => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - (document.querySelector("header")?.getBoundingClientRect().height ?? 64) - 18, behavior: "instant" }));
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  await page.screenshot({ path: ".artifacts/traceforce-reference-parity/wallet-flags-mobile.png" });
  const table = holders.getByRole("region", { name: "Holder table", exact: true });
  await table.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await table.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await sniper.getByText("sniper", { exact: true }).click();
  expect(await sniper.locator("details[open] > div").evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(200);
  await expect.poll(() => sniper.locator("details[open]").evaluate((element) => {
    const viewport = element.closest('[aria-label="Holder table"]')!.getBoundingClientRect();
    return [element.querySelector("[data-flag-basis]")!, element.querySelector("summary span")!].every((node) => {
      const box = node.getBoundingClientRect(); return box.left >= viewport.left && box.right <= viewport.right;
    });
  })).toBe(true);
  await expect(sniper.getByRole("link", { name: "Evidence 1", exact: true })).toBeVisible();
  await page.screenshot({ path: ".artifacts/traceforce-reference-parity/wallet-flags-mobile-detail.png" });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __flagsChecks: { csp: number } }).__flagsChecks.csp)).toBe(0);
});

for (const balanceRaw of ["1", "0"] as const) test(`contract balance ${balanceRaw} stays distinct from rounded zero or unknown`, async ({ page }) => {
  const report = getBrowserWalletFlagsFixture();
  const contract = report.walletActivitySnapshot!.rows.at(-1)!;
  contract.code = "contract";
  report.wallets.find((wallet) => wallet.address === contract.address)!.balanceRaw = balanceRaw;
  report.holderSnapshot!.holders.find((holder) => holder.address === contract.address)!.balanceRaw = balanceRaw;
  await openReport(page, report);
  const holders = page.getByRole("region", { name: "Top holders", exact: true });
  const contracts = holders.getByRole("region", { name: "Contract holdings", exact: true });
  await expect(holders.getByRole("table", { name: "Top holders", exact: true }).locator("tbody tr")).toHaveCount(10);
  if (balanceRaw === "1") {
    await expect(holders).toContainText("1 contract holds <0.01% of total supply");
    await expect(holders).not.toContainText("contract holds 0.00%");
    await expect(contracts.getByRole("cell", { name: "<0.01%", exact: true })).toBeVisible();
    await expect(contracts.getByRole("cell", { name: "1", exact: true })).toHaveAttribute("title", "Exact raw balance: 1");
  } else {
    await expect(contracts).toHaveCount(0);
    const comparison = page.getByRole("region", { name: "Data comparison", exact: true });
    const balances = comparison.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Pinned candidate balances", exact: true }) });
    await expect(balances).toContainText("1 verified zero");
    await expect(balances).toContainText("0 unavailable · 0 not examined");
  }
});

test("a dominant contract stays visible while twelve wallet rows use their own Float and risks retain every holding", async ({ page }) => {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  await openReport(page, report);
  const holders = page.getByRole("region", { name: "Top holders", exact: true });
  const main = holders.getByRole("table", { name: "Top holders", exact: true });
  const contracts = holders.getByRole("region", { name: "Contract holdings", exact: true });
  await expect(main.locator("tbody tr")).toHaveCount(12);
  await expect(main.getByRole("columnheader")).toHaveText(["#", "Wallet", "Float", "Entry", "Txs", "Flags", "Swarm"]);
  await expect(holders).toContainText("14 positive addresses checked: 12 wallets + 1 contract + 1 pool/burn address · 13 source-reported total");
  await expect(holders).toContainText("Shares use 14,355 float");
  await expect(main.locator("tbody tr").first().getByRole("cell").nth(2)).toHaveText("8.4%");
  await expect(main.locator("tbody tr").nth(1).getByRole("cell").nth(2)).toHaveText("8.3%");
  await expect(contracts.locator("tbody tr")).toHaveCount(1);
  await expect(contracts.getByRole("cell", { name: "≈84.64%", exact: true })).toBeVisible();
  await expect(contracts.getByRole("cell", { name: "84,645", exact: true })).toBeVisible();
  await expect(contracts).toContainText("Contract code does not establish a pool, locker or owner.");
  const graph = page.getByRole("region", { name: "Observed relationships", exact: true });
  const contractNode = graph.getByRole("button", { name: `Select wallet ${browserFixture.funder}`, exact: true });
  await expect(graph).toContainText("12 wallets · 0 linked groups");
  await expect(graph).toContainText("Same wallets and Float as Top holders.");
  await expect(contractNode).toHaveCount(0);
  const gauge = page.getByRole("region", { name: "Score", exact: true });
  await expect(gauge).toContainText("12 wallets · 0 linked groups");
  await expect(gauge.getByText(String(assessInvestigationReport(report).displayedScore), { exact: true })).toBeVisible();
  await expect(gauge.getByText("/ 100 · PARTIAL", { exact: true })).toBeVisible();
  const score = page.getByRole("region", { name: "Score breakdown", exact: true });
  await score.locator("details[data-score-details] > summary").click();
  await expect(score.locator('[data-category-details="concentration"]')).toContainText("83.33% top 10 examined");
  await score.locator("details[data-score-details] > summary").click();
  await expect(page.getByRole("region", { name: "VERDICT OUTPUT", exact: true }).getByText("AVOID", { exact: true }).first()).toBeVisible();
  const address = contracts.getByRole("button", { name: `${browserFixture.funder.slice(0, 6)}…${browserFixture.funder.slice(-4)}`, exact: true });
  await address.focus(); await page.keyboard.press("Enter");
  await expect(graph).toContainText("12 wallets + 1 contract shown");
  await expect(graph).toContainText("All addresses includes contracts and funding context.");
  await expect(contractNode).toContainText("85.5%");
  await expect(contractNode).toHaveAttribute("aria-pressed", "true");
  await expect(graph).toContainText("Pinned balance: 84,645 · float share: 85.5%");
  for (const width of [1440, 393]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 852 });
    const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
    await expect(contracts.getByRole("table", { name: "Contract holdings", exact: true })).toBeVisible();
  }
});

test("missing and unavailable account code stay unclassified without manufacturing wallet Float", async ({ page }) => {
  for (const mode of ["missing", "unavailable"] as const) {
    const report = getBrowserWalletFlagsFixture({ contractDominated: true });
    if (mode === "missing") delete report.walletActivitySnapshot;
    else report.walletActivitySnapshot!.rows[0].code = "unavailable";
    await page.unroute("**/api/investigations");
    await openReport(page, report);
    const holders = page.getByRole("region", { name: "Top holders", exact: true });
    const main = holders.getByRole("table", { name: "Top holders", exact: true });
    const unknown = holders.getByRole("region", { name: "Unclassified addresses", exact: true });
    await expect(main.getByRole("columnheader").nth(2)).toHaveText("%");
    await expect(holders).toContainText("Wallet Float is unavailable.");
    await expect(holders).toContainText("Shares use 100,000 total supply");
    await expect(unknown).toBeVisible();
    await expect(unknown).toContainText("Account type was not verified at this block. These addresses are not treated as wallets or pools.");
    await expect(unknown.getByRole("cell", { name: "≈84.64%", exact: true })).toBeVisible();
    await expect(holders.getByRole("region", { name: "Contract holdings", exact: true })).toHaveCount(0);
    await expect(main.locator("tbody tr")).toHaveCount(mode === "missing" ? 0 : 12);
    if (mode === "missing") await expect(holders.getByText("No verified wallet rows. Other retained addresses appear below.", { exact: true })).toBeVisible();
    else await expect(main.locator("tbody tr").first().getByRole("cell").nth(2)).toHaveText("1.2%");
    await expect(page.getByRole("region", { name: "Observed relationships", exact: true })).toContainText(mode === "missing" ? "13 unclassified addresses shown" : "12 wallets · 0 linked groups");
  }
});

test("compact category scores preserve measured credits, remaining unknowns and readable warning evidence", async ({ page }) => {
  const report = getBrowserWalletFlagsFixture(), assessment = assessInvestigationReport(report);
  await openReport(page, report);
  const breakdown = page.getByRole("region", { name: "Score breakdown", exact: true });
  const gauge = page.getByRole("region", { name: "Score", exact: true });
  await expect(gauge.getByText(String(assessment.displayedScore), { exact: true })).toBeVisible();
  await expect(gauge.getByText(assessment.overallScore === null ? "/ 100 · PARTIAL" : "/ 100", { exact: true })).toBeVisible();
  for (const id of ["fresh", "snipers"] as const) {
    const category = assessment.categories.find((entry) => entry.id === id)!;
    expect(category.points, `${id} has supported measurements in this synthetic fixture`).not.toBeNull();
    expect(category.points).toBeGreaterThan(0);
    const row = breakdown.getByLabel("Category scores", { exact: true }).locator(`[data-category-id="${id}"]`);
    await expect(row).toHaveAttribute("data-score-points", String(category.points));
  }
  await expect(breakdown.getByLabel("Category scores", { exact: true }).locator("svg")).toHaveCount(6);
  const details = breakdown.locator("details[data-score-details]");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  const category = (label: string) => breakdown.locator(`[data-category-details="${label.toLowerCase()}"]`);
  for (const label of ["Fresh", "Snipers"]) {
    const expected = assessment.categories.find((entry) => entry.label === label)!, row = category(label);
    await expect(row).toContainText(expected.metric!);
    await expect(row).toContainText(`Earned points: ${expected.points}/${expected.possiblePoints}`);
    await expect(row.getByText("Measurement unavailable in this report.", { exact: true })).toHaveCount(0);
  }
  const insiders = category("Insiders");
  const insiderAssessment = assessment.categories.find((entry) => entry.id === "insiders")!;
  if (insiderAssessment.points === null) {
    await expect(insiders).toContainText("not assessed");
    await expect(insiders).toContainText("0/15");
  } else await expect(insiders).toContainText(`Earned points: ${insiderAssessment.points}/15`);
  const rules = page.getByRole("region", { name: "Rule evidence", exact: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const points of assessment.triggeredRules.map((rule) => rule.deductedPoints).filter((points) => points > 0)) {
      const deduction = rules.getByLabel(`${points} points deducted`, { exact: true });
      await expect(deduction).toHaveText(`−${points}`);
      const geometry = await deduction.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
        const row = element.parentElement!.getBoundingClientRect();
        const panel = element.closest('[aria-label="Rule evidence"]')!.getBoundingClientRect();
        return {
          lines: range.getClientRects().length,
          whiteSpace: getComputedStyle(element).whiteSpace,
          unclipped: text.left >= box.left - 1 && text.right <= box.right + 1
            && text.left >= row.left - 1 && text.right <= row.right + 1
            && text.top >= row.top - 1 && text.bottom <= row.bottom + 1
            && text.left >= panel.left - 1 && text.right <= panel.right + 1,
        };
      });
      expect(geometry).toEqual({ lines: 1, whiteSpace: "nowrap", unclipped: true });
    }
    const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
    await expect(gauge.getByText(String(assessment.displayedScore), { exact: true })).toBeVisible();
  }
});

test("the compact verdict shows its decision and deductions while folding receipts and source detail", async ({ page }) => {
  const report = getBrowserWalletFlagsFixture();
  const assessment = assessInvestigationReport(report), expected = expectedDecisionWeights(assessment);
  await openReport(page, report);
  const verdict = page.getByRole("region", { name: "VERDICT OUTPUT", exact: true });
  await expect(verdict.getByText("AVOID", { exact: true }).first()).toBeVisible();
  const percentages = verdict.getByLabel("Verdict decision weights", { exact: true });
  const basis = verdict.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Details$/ }) });
  await expect(basis).toHaveJSProperty("open", false);
  await expect(percentages).toBeVisible();
  const displayed = await percentages.locator("dd").allTextContents();
  expect(displayed.reduce((sum, value) => sum + Math.round(parseFloat(value) * 10), 0)).toBe(1000);
  displayed.forEach((value, index) => expect(Math.abs(parseFloat(value) / 100 - Object.values(expected.weights)[index])).toBeLessThanOrEqual(0.001));
  await expect(verdict.getByLabel("Verdict receipt", { exact: true })).not.toBeVisible();
  const warnings = verdict.getByRole("list", { name: "Observed warnings", exact: true });
  await expect(warnings).not.toBeVisible();
  await expect(verdict.getByText(/candidate balances checked at block/)).not.toBeVisible();
  const xray = verdict.getByRole("region", { name: "DECISION X-RAY", exact: true });
  await expect(xray).toBeVisible();
  await expect(basis.getByText("Largest holder", { exact: true })).not.toBeVisible();
  await basis.locator("summary").first().click();
  await expect(percentages).toBeVisible();
  await expect(basis).toContainText("calibrated probabilities");
  await expect(percentages.locator("svg")).toHaveCount(3);
  await expect(warnings).toBeVisible();
  await expect(verdict.getByText(/candidate balances checked at block/)).toBeVisible();
  await expect(xray).toContainText("base");
  await expect(xray).toContainText("hard rule");
  await expect(xray).toContainText("modeled dump");
  await expect(verdict).toContainText(`receipt ${report.id}`);
  const receipt = JSON.parse(await verdict.getByLabel("Verdict receipt", { exact: true }).innerText());
  expect(receipt).toMatchObject({ model: "traceforce-judge-1.0.0", decision: "AVOID", confidence: null, weight_kind: "normalized-rule-weights", score_range: assessment.scoreRange });
  for (const key of ["avoid", "caution", "ok"] as const) expect(receipt.p[key]).toBeCloseTo(expected.weights[key], 10);
  await expect(basis.getByText("Largest holder", { exact: true })).toBeVisible();
  await expect(basis).toContainText("normalized rule weights, not calibrated probabilities or confidence");
});

test("a young token's full crawl shows stepped holding history across the chart without plotting empty chain history", async ({ page }) => {
  const report = sparseFullHistoryReport();
  await openReport(page, report);
  const replay = page.getByRole("region", { name: "// TIME MACHINE", exact: true });
  await expect(replay).toContainText("Reconstructed tracked holdings in this scan");
  await expect(replay).toContainText("not all holders or history since launch");
  await expect(replay.locator("[data-holding-range]")).toContainText("Blocks 52000010–52000400");
  const slider = replay.getByRole("slider", { name: "Replay tracked holdings by block", exact: true });
  await expect(slider).toHaveAttribute("aria-valuetext", /^Block 52000400, .*top 10 known 97\.5% of reconstructed supply$/);
  await slider.focus(); await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", /^Block 52000010, .*top 10 known 100% of reconstructed supply$/);
  const largest = replay.locator('polyline[data-holding-series="largest"]');
  await expect(largest).toHaveCount(1);
  const shape = await largest.evaluate((element) => {
    const points = [...(element as SVGPolylineElement).points].map(({ x, y }) => ({ x, y }));
    return {
      firstX: points[0].x,
      lastX: points.at(-1)!.x,
      hasPlateau: points.some((point, index) => index > 0 && point.x > points[index - 1].x && point.y === points[index - 1].y),
      hasDiscreteChange: points.some((point, index) => index > 0 && point.x === points[index - 1].x && point.y !== points[index - 1].y),
      hasDiagonalChange: points.some((point, index) => index > 0 && point.x !== points[index - 1].x && point.y !== points[index - 1].y),
    };
  });
  expect(shape.firstX).toBeLessThanOrEqual(10);
  expect(shape.lastX).toBeGreaterThanOrEqual(990);
  expect(shape).toMatchObject({ hasPlateau: true, hasDiscreteChange: true, hasDiagonalChange: false });
  await expect(replay.locator('circle[data-holding-point="largest"]')).toHaveCount(1);
  await slider.focus(); await page.keyboard.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", /^Block 52000400, .*top 10 known 97\.5% of reconstructed supply$/);
  const comparison = page.getByRole("region", { name: "Data comparison", exact: true });
  await expect(comparison).toContainText("Full token-history crawl requested");
  await comparison.getByText("1 completed discovery ranges", { exact: true }).click();
  await expect(comparison.getByText("Blocks 0–52000400", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(replay.locator("[data-holding-range]")).toBeVisible();
  const bounds = await replay.getByRole("img", { name: "Known tracked holdings as shares of reconstructed total supply", exact: true }).boundingBox();
  expect(bounds!.width).toBeGreaterThan(240);
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
});
