import { expect, test, type Page, type Route } from "@playwright/test";
import { browserFixture, getBrowserReportFixture, getBrowserWalletFlagsFixture } from "../fixtures/report";

async function openSyntheticChat(page: Page, report = getBrowserReportFixture()) {
  await page.route("**/api/investigations", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify({ type: "report", report, chatContext: "synthetic-browser-chat-context" }) + "\n" }));
  await page.goto("/investigate");
  await page.getByLabel("Base token contract").fill(browserFixture.token);
  await page.getByRole("button", { name: "Start investigation", exact: true }).click();
  await expect(page.getByRole("heading", { name: report.token.name!, level: 2, exact: true })).toBeVisible();
  return page.getByRole("region", { name: "Questions about this token", exact: true });
}

test("synthetic conversation: user and assistant bubbles arrive separately and follow-up carries recent context", async ({ page }) => {
  const requests: { question: string; history?: { role: string; content: string }[] }[] = [];
  await page.route("**/api/questions", async (route) => {
    const body = route.request().postDataJSON(); requests.push(body);
    await new Promise((resolve) => setTimeout(resolve, 350));
    return route.fulfill({ json: { answer: requests.length === 1 ? "Hey! What would you like to know about this token?" : "Synthetic reply to your follow-up, based on this scan.", caveat: "", evidenceIds: [], needsFreshScan: false, ...(requests.length === 1 ? { model: "gemini/gemini-3.5-flash-lite" } : {}) } });
  });
  const chat = await openSyntheticChat(page);
  const conversation = chat.getByRole("list", { name: "Questions and answers" });
  await expect(conversation.getByRole("listitem")).toHaveCount(0);
  await chat.getByLabel("Ask about the observed evidence").fill("hey");
  await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(conversation.getByText("hey", { exact: true })).toBeVisible();
  await expect(chat.getByRole("status")).toHaveText("Reading report…");
  await expect(conversation.getByText("Hey! What would you like to know about this token?", { exact: true })).toBeVisible();
  await expect(conversation.getByLabel("Response model gemini/gemini-3.5-flash-lite", { exact: true })).toBeVisible();
  await expect(conversation.getByLabel("Response model gemini/gemini-3.5-flash-lite", { exact: true })).toHaveText("gemini/gemini-3.5-flash-lite");
  await chat.getByLabel("Ask about the observed evidence").fill("Can you explain the wallet links?");
  await chat.getByLabel("Ask about the observed evidence").press("Enter");
  await expect(conversation.getByText("Synthetic reply to your follow-up, based on this scan.", { exact: true })).toBeVisible();
  expect(requests[0].history ?? []).toEqual([]);
  expect(requests[1].history).toEqual([{ role: "user", content: "hey" }, { role: "assistant", content: "Hey! What would you like to know about this token?" }]);
  await chat.getByRole("button", { name: "Clear conversation", exact: true }).click();
  await expect(conversation.getByRole("listitem")).toHaveCount(0);
  await chat.getByLabel("Ask about the observed evidence").fill("Who funded the wallets?");
  await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].history ?? []).toEqual([]);
});

test("a concise contract-holding reply renders as a normal chat answer", async ({ page }) => {
  const requests: { question: string; context: string }[] = [];
  const question = "what is contract holding?";
  const answer = "Contract holding means tokens held by a smart contract. This synthetic report keeps that address separate from the 12 wallet rows.";
  await page.route("**/api/questions", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { answer, caveat: "Contract code alone does not identify its owner or purpose.", evidenceIds: [], needsFreshScan: false } });
  });
  const chat = await openSyntheticChat(page, getBrowserWalletFlagsFixture({ contractDominated: true }));
  await chat.getByLabel("Ask about the observed evidence").fill(question);
  await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(chat.getByRole("list", { name: "Questions and answers" }).getByText(answer, { exact: true })).toBeVisible();
  await expect(chat.getByRole("alert")).toHaveCount(0);
  await expect(chat).not.toContainText("RESPONSE UNAVAILABLE");
  await expect(chat).not.toContainText("holdingDenominatorRaw");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ question, context: "synthetic-browser-chat-context" });
});

test("synthetic conversation: failed generation preserves the question and does not invent an assistant answer", async ({ page }) => {
  await page.route("**/api/questions", (route) => route.fulfill({ status: 503, json: { error: "The AI could not prepare an answer. Please try again." } }));
  const chat = await openSyntheticChat(page);
  const question = "What connects these wallets?";
  await chat.getByLabel("Ask about the observed evidence").fill(question);
  await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
  await expect(chat.getByRole("alert")).toContainText("The AI could not prepare an answer");
  await expect(chat.getByLabel("Ask about the observed evidence")).toHaveValue(question);
  await expect(chat.getByRole("list", { name: "Questions and answers" }).getByText("TraceForce AI", { exact: true })).toHaveCount(0);
  await expect(chat.getByRole("button", { name: "Ask investigator", exact: true })).toBeEnabled();
});

test("synthetic chat design: reduced motion, mobile composer and evidence links preserve native interaction and CSP", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__syntheticChatCspViolations", { value: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));
  });
  const pending: Route[] = [];
  await page.route("**/api/questions", (route) => { pending.push(route); });
  const chat = await openSyntheticChat(page), composer = chat.getByLabel("Ask about the observed evidence");
  const assertReadableWidth = async () => {
    // Clipped orbital decoration may extend the section's scrollWidth. The
    // actual transcript and document must keep readable content in bounds.
    const content = await chat.getByRole("region", { name: "Conversation", exact: true }).evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(content.content).toBeLessThanOrEqual(content.width + 1);
    const pageWidth = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.width + 1);
  };
  const send = chat.getByRole("button", { name: "Ask investigator", exact: true });
  expect(await send.evaluate((button) => button.tagName)).toBe("BUTTON");
  await expect(send).toBeDisabled();
  await composer.fill("What connects these wallets?");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("What connects these wallets?\n");
  expect(pending).toHaveLength(0);
  await composer.press("Enter");
  await expect(chat.getByRole("status")).toHaveText("Reading report…");
  await expect.poll(() => pending.length).toBe(1);
  await expect(chat.getByRole("button", { name: "Cancel question", exact: true })).toBeVisible();
  await expect.poll(() => chat.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
  const id = getBrowserReportFixture().evidence.at(-1)!.id;
  const answer = "Synthetic mobile answer: the retained transfer connects these wallet addresses. " + "A".repeat(120);
  await pending.shift()!.fulfill({ json: { answer, caveat: "Synthetic fixture: a connection does not prove common ownership.", evidenceIds: [id], needsFreshScan: false } });
  await expect(chat.getByText(answer, { exact: true })).toBeVisible();
  await expect(composer).toBeFocused();
  const citation = chat.getByRole("link", { name: "Evidence 1", exact: true });
  for (const control of [send, citation]) {
    const bounds = await control.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44); expect(bounds?.width).toBeGreaterThanOrEqual(44);
  }
  await chat.screenshot({ path: ".next/aceternity-chat-mobile.png" });
  await assertReadableWidth();
  await citation.click();
  const target = page.locator(`[id="evidence-${id}"]`);
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute("data-evidence-highlighted", "true");
  const emphasis = await target.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    shadow: getComputedStyle(element).boxShadow,
    animations: element.getAnimations().filter((animation) => animation.playState === "running").length,
  }));
  expect(emphasis.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(emphasis.shadow).toContain("inset");
  expect(emphasis.animations).toBe(0);
  await expect(target.locator("[style]")).toHaveCount(0);
  await page.setViewportSize({ width: 812, height: 375 });
  await assertReadableWidth();
  expect(await page.evaluate(() => (window as unknown as { __syntheticChatCspViolations: string[] }).__syntheticChatCspViolations)).toEqual([]);
});
