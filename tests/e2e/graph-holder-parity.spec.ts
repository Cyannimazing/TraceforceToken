import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { analyzeInvestigation } from "../../src/domain/investigations/analyze";
import { validateInvestigationExplanation } from "../../src/domain/investigations/explanation";
import type { Address, EvidenceRecord, ExplainedInvestigationReport, Hash, InvestigationDataset } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

test.use({ colorScheme: "dark", reducedMotion: "reduce" });

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hash;
const graphRegion = (page: Page) => page.getByRole("region", { name: "Observed relationships", exact: true });
const holderTable = (page: Page) => page.getByRole("table", { name: "Top holders", exact: true });

async function openReport(page: Page, report: ExplainedInvestigationReport) {
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "report", report })}\n` }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(report.token.address);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your investigation report", exact: true })).toBeVisible();
}

async function safetyChecks(page: Page) {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__graphParityCsp", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));
  });
}

async function assertNoOverflowOrCsp(page: Page) {
  const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(await page.evaluate(() => (window as unknown as { __graphParityCsp: string[] }).__graphParityCsp)).toEqual([]);
  await expect(graphRegion(page).locator("[style]")).toHaveCount(0);
}

/** Compare separately rendered DOM surfaces; never derive either side with the graph helper. */
async function assertVisibleGraphMatchesTable(page: Page, denominator: string, label: "float" | "total supply") {
  const graph = graphRegion(page), table = holderTable(page), canvas = graph.locator('svg[data-graph-view="wallets"]');
  await expect(graph.getByRole("button", { name: "Wallets", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-denominator-raw", denominator);
  await expect(canvas).toHaveAttribute("data-denominator-label", label);
  const pinnedDenominator = page.getByRole("region", { name: "Top holders", exact: true }).locator(`[data-holding-denominator-raw="${denominator}"]`);
  await expect(pinnedDenominator).toHaveCount(1);
  const rows = await table.locator("tbody tr").evaluateAll((elements) => elements.map((row) => {
    const cells = row.querySelectorAll("td"), button = cells[1].querySelector("button")!;
    return { address: button.title.split("\n")[0], share: cells[2].textContent!.trim(), balance: button.getAttribute("data-balance-raw")! };
  }));
  const nodes = await canvas.locator('g[data-node-address][data-node-kind="holding"]').evaluateAll((elements) => elements.map((node) => ({
    address: node.getAttribute("data-node-address"), share: node.getAttribute("data-holding-share"),
    visibleShare: [...node.querySelectorAll("text")].map((text) => text.textContent!.trim()).find((text) => text.endsWith("%")),
  })));
  for (const node of nodes) {
    const row = rows.find((entry) => entry.address === node.address);
    expect(row, `bubble ${node.address} must have a main wallet-table row`).toBeDefined();
    expect(node.share).toBe(row!.share);
    expect(node.visibleShare).toBe(row!.share);
    const balance = BigInt(row!.balance), divisor = BigInt(denominator);
    const roundedTenths = (balance * 1000n + divisor / 2n) / divisor;
    const expected = balance > 0n && balance * 1000n < divisor ? "<0.1%" : `${roundedTenths / 10n}.${roundedTenths % 10n}%`;
    expect(row!.share, `independent exact integer percentage for ${row!.address}`).toBe(expected);
  }
  expect(nodes.map((node) => node.address)).toEqual(rows.filter((row) => nodes.some((node) => node.address === row.address)).map((row) => row.address));
  return { rows, nodes };
}

/** Rendered circles and labels must not intersect after fitting, at any page or viewport. */
async function assertPackedAndVisible(graph: Locator) {
  const geometry = await graph.locator('svg[data-graph-view] g[data-node-address]').evaluateAll((nodes) => nodes.map((node) => {
    const circle = node.querySelector("circle[data-balance-bubble]") as SVGCircleElement | null;
    const label = node.querySelector("text") as SVGTextElement | null;
    const box = node.getBoundingClientRect(), svgBox = node.closest("svg")!.getBoundingClientRect();
    return { address: node.getAttribute("data-node-address"), box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom },
      svg: { x: svgBox.x, y: svgBox.y, right: svgBox.right, bottom: svgBox.bottom },
      circle: circle ? (() => { const b = circle.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; })() : null,
      label: label ? (() => { const b = label.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }; })() : null };
  }));
  for (const node of geometry) {
    expect(node.box.x, `left viewport: ${node.address}`).toBeGreaterThanOrEqual(node.svg.x - 1);
    expect(node.box.right, `right viewport: ${node.address}`).toBeLessThanOrEqual(node.svg.right + 1);
    expect(node.box.y, `top viewport: ${node.address}`).toBeGreaterThanOrEqual(node.svg.y - 1);
    expect(node.box.bottom, `bottom viewport: ${node.address}`).toBeLessThanOrEqual(node.svg.bottom + 1);
  }
  const intersects = (a: NonNullable<(typeof geometry)[number]["circle"]>, b: NonNullable<(typeof geometry)[number]["circle"]>) => a.x < b.right - 0.1 && a.right > b.x + 0.1 && a.y < b.bottom - 0.1 && a.bottom > b.y + 0.1;
  for (let first = 0; first < geometry.length; first++) for (let second = first + 1; second < geometry.length; second++) {
    const a = geometry[first], b = geometry[second];
    if (a.circle && b.circle) expect(intersects(a.circle, b.circle), `circle overlap: ${a.address} and ${b.address}`).toBe(false);
    if (a.label && b.label) expect(intersects(a.label, b.label), `address-label overlap: ${a.address} and ${b.address}`).toBe(false);
  }
}

function largeIntegerReport() {
  const report = getBrowserWalletFlagsFixture({ contractDominated: true }), scale = (1n << 180n) + 9_007_199_254_740_993n;
  const weights = [12000n, 12000n, 11700n, 11600n, 10900n, 10100n, 8500n, 8300n, 6600n, 3000n, 2800n, 1n];
  const balances = new Map<Address, bigint>(weights.map((weight, index) => [address(1000 + index), weight * scale]));
  balances.set(browserFixture.funder, 84645n * scale); balances.set(browserFixture.pool, 1000n * scale);
  const total = [...balances.values()].reduce((sum, balance) => sum + balance, 0n);
  report.token.totalSupplyRaw = total.toString(); report.holderSnapshot!.totalSupplyRaw = total.toString();
  for (const holder of report.holderSnapshot!.holders) holder.balanceRaw = balances.get(holder.address)!.toString();
  for (const wallet of report.wallets) wallet.balanceRaw = balances.get(wallet.address)!.toString();
  return { report, denominator: (weights.reduce((sum, value) => sum + value, 0n) * scale).toString() };
}

function pagedReport(): ExplainedInvestigationReport {
  const original = getBrowserWalletFlagsFixture({ contractDominated: true }), extraCount = 53;
  const extras = Array.from({ length: extraCount }, (_, index) => address(2000 + index));
  const template = original.evidence.find((record) => record.kind === "transfer")!;
  const extraRecord = (index: number, from: Address, to: Address, amountRaw: string): EvidenceRecord => ({ ...template,
    id: `synthetic-page-${index}`, blockNumber: String(200 + index), blockHash: hash(200 + index), transactionHash: hash(5000 + index), transactionIndex: 0, logIndex: 0,
    timestamp: browserFixture.timestamp + 500 + index, from, to, amountRaw, creation: undefined, liquidity: undefined, purchase: undefined, sale: null,
  });
  const extraSupply = BigInt(extraCount) * 1000n, total = (100000n + extraSupply).toString();
  const snapshot = structuredClone(original.holderSnapshot!);
  snapshot.totalSupplyRaw = total;
  snapshot.holders.push(...extras.map((wallet) => ({ address: wallet, balanceRaw: "1000", status: "verified" as const, discoveredBy: "observed" as const })));
  snapshot.balances.requestedWallets += extraCount; snapshot.balances.verifiedWallets += extraCount;
  const input: InvestigationDataset = {
    token: { ...original.token, totalSupplyRaw: total }, range: original.range,
    evidence: [...original.evidence, extraRecord(0, address(0), browserFixture.pool, extraSupply.toString()), ...extras.map((wallet, index) => extraRecord(index + 1, browserFixture.pool, wallet, "1000"))],
    pools: original.infrastructure!.pools, hubs: original.infrastructure!.hubs,
    coverage: { ...original.coverage, eligibleWallets: original.coverage.eligibleWallets + extraCount,
      funding: [...original.coverage.funding, ...extras.map((wallet) => ({ wallet, status: "not_examined" as const, fromBlock: "0", toBlock: "400", internalTransfers: "not_examined" as const, reason: "Synthetic pagination fixture." }))] },
    holderSnapshot: snapshot,
    walletActivitySnapshot: { block: original.range.to, rows: [...original.walletActivitySnapshot!.rows, ...extras.map((wallet) => ({ address: wallet, code: "eoa" as const, outgoingTransactionCountRaw: "0" }))] },
    liquiditySnapshot: original.liquiditySnapshot,
  };
  const report = analyzeInvestigation(input, { id: original.id, generatedAt: original.generatedAt });
  const explanation = validateInvestigationExplanation(report, { ...original.explanation, context: { ...original.explanation.context, omittedEvidence: report.evidence.length - original.explanation.context.suppliedEvidence } });
  return { ...report, explanation };
}

test("every default wallet bubble matches its table address, Float and percentage on desktop and mobile", async ({ page }) => {
  await safetyChecks(page);
  await openReport(page, getBrowserWalletFlagsFixture({ contractDominated: true }));
  const graph = graphRegion(page);
  for (const width of [1440, 393]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 852 });
    const { rows, nodes } = await assertVisibleGraphMatchesTable(page, "14355", "float");
    expect(rows).toHaveLength(12); expect(nodes).toHaveLength(12);
    await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.funder}`, exact: true })).toHaveCount(0);
    await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.pool}`, exact: true })).toHaveCount(0);
    await assertPackedAndVisible(graph); await assertNoOverflowOrCsp(page);
    await mkdir(".artifacts/graph-holder-parity", { recursive: true });
    await graph.screenshot({ path: `.artifacts/graph-holder-parity/wallets-${width}.png` });
  }
});

test("exact large integer balances preserve tied order, rounding and tiny shares in graph and table", async ({ page }) => {
  await safetyChecks(page);
  const { report, denominator } = largeIntegerReport();
  await openReport(page, report);
  const { rows, nodes } = await assertVisibleGraphMatchesTable(page, denominator, "float");
  expect(nodes).toHaveLength(12);
  expect(rows.slice(0, 2).map((row) => row.address)).toEqual([address(1000), address(1001)]);
  expect(rows.at(-1)!.share).toBe("<0.1%");
  await expect(graphRegion(page).getByRole("button", { name: `Select wallet ${address(1011)}`, exact: true }).locator("circle[data-balance-bubble]")).toHaveCount(1);
  await assertPackedAndVisible(graphRegion(page)); await assertNoOverflowOrCsp(page);
});

test("unverified classification and unread balances use the same explicit total-supply fallback", async ({ page }) => {
  test.setTimeout(60_000);
  await safetyChecks(page);
  for (const mode of ["unavailable-code", "unread-balance", "missing-code"] as const) {
    const report = getBrowserWalletFlagsFixture({ contractDominated: true });
    if (mode === "unavailable-code") report.walletActivitySnapshot!.rows[0].code = "unavailable";
    else if (mode === "missing-code") delete report.walletActivitySnapshot;
    else {
      const unread = report.holderSnapshot!.holders.find((holder) => holder.address === address(1011))!;
      unread.status = "unavailable"; unread.balanceRaw = null;
      report.holderSnapshot!.balances.status = "partial"; report.holderSnapshot!.balances.verifiedWallets--;
      report.wallets.find((wallet) => wallet.address === unread.address)!.balanceRaw = null;
    }
    await page.unroute("**/api/investigations"); await openReport(page, report);
    const graph = graphRegion(page);
    if (mode === "missing-code") {
      await expect(holderTable(page).locator("tbody tr")).toHaveCount(0);
      await expect(graph.getByRole("button", { name: "Wallets", exact: true })).toBeDisabled();
      await expect(graph.getByRole("button", { name: "All addresses", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(graph).toContainText("No verified wallet rows.");
      await expect(graph.locator('svg[data-graph-view="all-addresses"]')).toHaveCount(1);
    } else {
      const { nodes } = await assertVisibleGraphMatchesTable(page, "100000", "total supply");
      expect(nodes).toHaveLength(mode === "unread-balance" ? 11 : 12);
      if (mode === "unread-balance") await expect(graph.getByRole("button", { name: `Select wallet ${address(1011)}`, exact: true })).toHaveCount(0);
    }
    await assertPackedAndVisible(graph); await assertNoOverflowOrCsp(page);
  }
});

test("keyboard selection reveals a separate contract in context and Wallets restores table parity", async ({ page }) => {
  await safetyChecks(page); await openReport(page, getBrowserWalletFlagsFixture({ contractDominated: true }));
  const graph = graphRegion(page), contracts = page.getByRole("region", { name: "Contract holdings", exact: true });
  const contract = graph.getByRole("button", { name: `Select wallet ${browserFixture.funder}`, exact: true });
  await expect(contract).toHaveCount(0);
  await contracts.getByRole("button", { name: "0x0000…000d", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(graph.getByRole("button", { name: "All addresses", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(graph.locator('svg[data-graph-view="all-addresses"]')).toHaveAttribute("data-denominator-raw", "99000");
  await expect(contract).toHaveAttribute("aria-pressed", "true");
  await expect(contract).toContainText("85.5%");
  await expect(graph.getByRole("button", { name: `Select wallet ${browserFixture.pool}`, exact: true })).toHaveAttribute("data-node-kind", "infrastructure");
  const walletMode = graph.getByRole("button", { name: "Wallets", exact: true });
  await walletMode.focus(); await page.keyboard.press("Space");
  expect((await assertVisibleGraphMatchesTable(page, "14355", "float")).nodes).toHaveLength(12);
  await expect(contract).toHaveCount(0);
  const wallet = graph.getByRole("button", { name: `Select wallet ${address(1011)}`, exact: true });
  await wallet.focus(); await page.keyboard.press("Enter");
  await expect(wallet).toHaveAttribute("aria-pressed", "true");
  await expect(graph).toContainText("float share: 8.4%");
  await assertNoOverflowOrCsp(page);
});

test("wallet pagination uses the entire cohort denominator and context switches preserve fitted nonoverlapping pages", async ({ page }) => {
  test.setTimeout(60_000);
  await safetyChecks(page); await openReport(page, pagedReport());
  const graph = graphRegion(page), table = holderTable(page), denominator = "67355";
  while (await page.getByRole("button", { name: /^Show more candidates/ }).count()) await page.getByRole("button", { name: /^Show more candidates/ }).click();
  await expect(table.locator("tbody tr")).toHaveCount(65);
  const seen: string[] = [];
  for (let index = 0; index < 2; index++) {
    const { nodes } = await assertVisibleGraphMatchesTable(page, denominator, "float");
    expect(nodes).toHaveLength(index === 0 ? 48 : 17);
    seen.push(...nodes.map((node) => node.address!));
    await assertPackedAndVisible(graph);
    if (index === 0) await graph.getByRole("button", { name: "Next address view", exact: true }).click();
  }
  expect(new Set(seen).size).toBe(65);
  await expect(graph.getByRole("button", { name: "Next address view", exact: true })).toBeDisabled();
  await graph.getByRole("button", { name: "All addresses", exact: true }).click();
  await expect(graph).toContainText("VIEW 1/2");
  await expect(graph.locator('svg[data-graph-view="all-addresses"]')).toHaveAttribute("data-denominator-raw", "152000");
  await assertPackedAndVisible(graph);
  await graph.getByRole("button", { name: "Next address view", exact: true }).click();
  await expect(graph).toContainText("VIEW 2/2");
  await assertPackedAndVisible(graph);
  await page.setViewportSize({ width: 375, height: 812 });
  await assertPackedAndVisible(graph); await assertNoOverflowOrCsp(page);
  await graph.getByRole("button", { name: "Wallets", exact: true }).click();
  await expect(graph).toContainText("VIEW 1/2");
  expect((await assertVisibleGraphMatchesTable(page, denominator, "float")).nodes).toHaveLength(48);
  await assertPackedAndVisible(graph); await assertNoOverflowOrCsp(page);
});
