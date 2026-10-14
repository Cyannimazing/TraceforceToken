import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { ExplainedInvestigationReport, TokenMarketSnapshot } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

test.use({ colorScheme: "dark", reducedMotion: "reduce" });

const checkedAt = "2026-10-12T12:18:33.000Z";
const exactTinyPrice = "0.0000000002326";
const pairUrl = `https://dexscreener.com/base/${browserFixture.pool}`;
const quoteWarning = "Negligible liquidity: this pool quote is not a reliable sale price.";
const lowLiquidityWarning = "Low liquidity: this pool quote is not a reliable sale price.";

/** Every value and address in these tests is fabricated; no providers or models run. */
function marketReport(overrides: Partial<TokenMarketSnapshot> = {}): ExplainedInvestigationReport {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  report.token.marketSnapshot = {
    source: "dexscreener", status: "reported", checkedAt,
    sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`,
    pairAddress: browserFixture.pool, priceUsd: exactTinyPrice, marketCapUsd: 1,
    liquidityUsd: 0.01, volume24hUsd: 1800, priceChange24hPercent: -99.98,
    pairCreatedAt: Date.parse(checkedAt) - 3_600_000,
    ...overrides,
  };
  return report;
}

async function openReport(page: Page, report: ExplainedInvestigationReport) {
  await page.route("**/api/investigations", (route) => route.fulfill({
    status: 200, contentType: "application/x-ndjson",
    body: JSON.stringify({ type: "report", report }) + "\n",
  }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible();
  return page.getByRole("region", { name: "Market snapshot", exact: true });
}

function metric(page: Page, market: Locator, label: string) {
  return market.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });
}

test("tiny reported pool price stays exact, warns about liquidity and shows its visible source and time", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__marketCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  const market = await openReport(page, marketReport());
  const price = metric(page, market, "Price (reported)");
  await expect(price.locator("dd > span").first()).toHaveText(`$${exactTinyPrice}`);
  await expect(price.locator("dd > span").first()).toHaveAttribute("title", new RegExp(exactTinyPrice.replaceAll(".", "\\.")));
  await expect(price.getByLabel("24-hour price change -99.98%", { exact: true })).toBeVisible();
  await expect(metric(page, market, "24H Vol")).toContainText("$1.8K");
  await expect(metric(page, market, "24H Vol").getByLabel(/24-hour price change/)).toHaveCount(0);
  await expect(metric(page, market, "MCAP").locator("dd > span").first()).toHaveText("$1");
  await expect(metric(page, market, "Liquidity").locator("dd > span").first()).toHaveText("$0.01");
  await expect(metric(page, market, "Wallets shown").locator("dd > span").first()).toHaveText("12");
  await expect(market.getByText(quoteWarning, { exact: true })).toBeVisible();
  const source = market.getByRole("link", { name: /DEX Screener/ });
  await expect(source).toHaveAttribute("href", pairUrl);
  await expect(source).toHaveAttribute("rel", /noopener/);
  const retrieved = market.locator("time");
  await expect(retrieved).toHaveCount(1);
  await expect(retrieved).toHaveAttribute("datetime", checkedAt);
  await expect(retrieved).toBeVisible();
  await expect(market.getByText("GoPlus reports 13 holders; this separate source count is not pinned to the scan block.", { exact: true })).toBeVisible();
  await mkdir(".artifacts/market-price", { recursive: true });
  // Secondary analysis stays collapsed until the visitor asks for it.
  const details = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Investigation details$/ }) }).first();
  await expect(details).not.toHaveAttribute("open");
  await details.locator(":scope > summary").click();

  for (const [width, height] of [[1440, 1000], [375, 812]] as const) {
    await page.setViewportSize({ width, height });
    const overview = page.locator(".traceforce-report-overview");
    const cards = page.getByRole("region", { name: "Key findings", exact: true });
    const dna = page.getByRole("region", { name: "Deployer DNA", exact: true });
    const [overviewBox, cardsBox, dnaBox] = await Promise.all([overview.boundingBox(), cards.boundingBox(), dna.boundingBox()]);
    expect(overviewBox).not.toBeNull();
    expect(cardsBox).not.toBeNull();
    expect(dnaBox).not.toBeNull();
    expect(cardsBox!.y).toBeGreaterThanOrEqual(overviewBox!.y + overviewBox!.height);
    expect(cardsBox!.y).toBeGreaterThanOrEqual(dnaBox!.y + dnaBox!.height);
    await expect(cards.getByRole("heading", { level: 2 })).toHaveText(["Who funded?", "Wallet links", "Early accumulation", "Linked selling"]);
    await expect(cards.getByRole("button", { name: "Inspect findings", exact: true })).toHaveCount(4);
    await expect(market.locator("[style]")).toHaveCount(0);
    const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
    const priceLines = await price.locator("dd > span").first().evaluate((element) => ({ height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight) }));
    expect(priceLines.height).toBeLessThanOrEqual(priceLines.lineHeight + 1);
    await market.screenshot({ path: `.artifacts/market-price/market-${width}.png` });
    await cards.evaluate((element) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const headerHeight = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
      window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - headerHeight - 16, behavior: "instant" });
    });
    await page.screenshot({ path: `.artifacts/market-price/findings-${width}.png` });
  }
  await page.getByRole("region", { name: "Key findings", exact: true }).getByRole("button", { name: "Inspect findings", exact: true }).first().click();
  await expect(page.getByLabel("Finding category", { exact: true })).toHaveValue("funding");
  expect(await page.evaluate(() => (window as unknown as { __marketCspViolations: string[] }).__marketCspViolations)).toEqual([]);
  expect(errors).toEqual([]);
});

test("reported zero price, money values and price change remain zero rather than unknown", async ({ page }) => {
  const market = await openReport(page, marketReport({ priceUsd: "0", marketCapUsd: 0, liquidityUsd: 0, volume24hUsd: 0, priceChange24hPercent: 0 }));
  for (const label of ["Price (reported)", "MCAP", "Liquidity", "24H Vol"]) {
    await expect(metric(page, market, label).locator("dd > span").first()).toHaveText("$0");
  }
  await expect(metric(page, market, "Price (reported)").getByLabel("24-hour price change 0%", { exact: true })).toBeVisible();
  await expect(market.getByText(quoteWarning, { exact: true })).toBeVisible();
});

test("unknown liquidity is disclosed without inventing zero or hiding an available exact quote", async ({ page }) => {
  const market = await openReport(page, marketReport({ liquidityUsd: null, marketCapUsd: null, volume24hUsd: null, priceChange24hPercent: null, pairCreatedAt: null }));
  await expect(metric(page, market, "Price (reported)").locator("dd > span").first()).toHaveText(`$${exactTinyPrice}`);
  for (const label of ["MCAP", "Liquidity", "24H Vol", "Pool age"]) {
    await expect(metric(page, market, label).locator("dd > span").first()).toHaveText("—");
  }
  await expect(market.getByLabel(/24-hour price change/)).toHaveCount(0);
  await expect(market.getByText("Quote liquidity unavailable; sale value is unverified.", { exact: true })).toBeVisible();
  await expect(market.getByText(quoteWarning, { exact: true })).toHaveCount(0);
  await expect(market.getByText(lowLiquidityWarning, { exact: true })).toHaveCount(0);
  await expect(market.getByRole("link", { name: /DEX Screener/ })).toHaveAttribute("href", pairUrl);
});

test("unavailable market context stays unknown without a price, pair or liquidity claim", async ({ page }) => {
  const market = await openReport(page, marketReport({ status: "unavailable", pairAddress: null, priceUsd: null, marketCapUsd: null, liquidityUsd: null, volume24hUsd: null, priceChange24hPercent: null, pairCreatedAt: null }));
  for (const label of ["Price (reported)", "MCAP", "Liquidity", "24H Vol", "Pool age"]) {
    await expect(metric(page, market, label).locator("dd > span").first()).toHaveText("—");
  }
  await expect(metric(page, market, "Wallets shown").locator("dd > span").first()).toHaveText("12");
  await expect(market).toContainText(/market metadata unavailable/i);
  await expect(market.getByRole("link", { name: /DEX Screener/ })).toHaveCount(0);
  await expect(market.getByText(quoteWarning, { exact: true })).toHaveCount(0);
  await expect(market.getByText(lowLiquidityWarning, { exact: true })).toHaveCount(0);
});

test("a listed pool without a price keeps its other metrics but publishes no sale-price warning", async ({ page }) => {
  const market = await openReport(page, marketReport({ priceUsd: null }));
  await expect(metric(page, market, "Price (reported)").locator("dd > span").first()).toHaveText("—");
  await expect(metric(page, market, "Liquidity").locator("dd > span").first()).toHaveText("$0.01");
  await expect(metric(page, market, "24H Vol")).toContainText("$1.8K");
  await expect(market.getByText(quoteWarning, { exact: true })).toHaveCount(0);
  await expect(market.getByText(lowLiquidityWarning, { exact: true })).toHaveCount(0);
  await expect(market.getByRole("link", { name: /DEX Screener/ })).toHaveAttribute("href", pairUrl);
});

for (const liquidity of [1, 9999, 10000]) {
  test(`pool quote liquidity warning respects the ${liquidity} USD boundary`, async ({ page }) => {
    const market = await openReport(page, marketReport({ liquidityUsd: liquidity }));
    await expect(market.getByText(quoteWarning, { exact: true })).toHaveCount(0);
    await expect(market.getByText(lowLiquidityWarning, { exact: true })).toHaveCount(liquidity < 10000 ? 1 : 0);
  });
}
