import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { z } from "zod";
import type { ExplainedInvestigationReport } from "../../src/domain/investigations/types";
import { SWARM_CATEGORY_WEIGHTS } from "../../src/domain/investigations/swarm-assessment";
import { questionAnswerSchema, questionRequestSchema } from "../../src/domain/investigations/questions";
import { deriveSwarmGraphView, formatSwarmShare, swarmHolderFlags } from "../../src/components/investigation-swarm-graph-source";

const publicQuestionFailureSchema = z.object({
  error: z.string().min(1).max(240),
  code: z.enum(["AI_UNAVAILABLE", "AI_RATE_LIMITED", "AI_RESPONSE_UNVERIFIED", "RATE_LIMITED"]).optional(),
  retryAfterSeconds: z.number().int().nonnegative().max(3600).optional(),
}).strict();

/** Explicit operator-only retry; never a replacement for the failed UI turn. */
async function diagnoseLocalBrowserQuestion(request: z.infer<typeof questionRequestSchema>, signal: AbortSignal) {
  let calls = 0;
  try {
    const { readInvestigatorAiConfiguration } = await import("../../src/agents/config");
    const { askInvestigatorQuestion } = await import("../../src/agents/inference");
    const { readLocalAiJson } = await import("../../src/agents/model-transport");
    const configuration = readInvestigatorAiConfiguration();
    assert.ok(configuration.local && !configuration.openrouter && !configuration.gemini, "diagnostic inference must be local-only");
    const provider = configuration.local;
    assert.equal(provider.baseUrl, "http://127.0.0.1:11434", "diagnostic inference requires the reviewed local Ollama origin");
    assert.ok(process.env.RATE_LIMIT_SECRET, "diagnostic requires the existing capsule signing secret");
    const inspectedFetch: typeof fetch = async (input, init) => {
      assert.equal(String(input), "http://127.0.0.1:11434/api/chat");
      assert.equal(++calls, 1, "one diagnostic model call only");
      const response = await fetch(input, init);
      const metadata: Record<string, unknown> = { httpStatus: response.status, diagnosticRetry: true, publicRequestPassed: false };
      if (response.ok) {
        const data = await readLocalAiJson(response.clone(), provider.maxResponseBytes, signal) as { done_reason?: unknown; message?: { content?: unknown } };
        if (data.done_reason === "stop" || data.done_reason === "length") metadata.finishReason = data.done_reason;
        if (typeof data.message?.content === "string") metadata.transientRawReplyForReview = data.message.content.slice(0, 4000);
      }
      // Never redirect this explicit diagnostic to a transcript archive.
      console.info(JSON.stringify({ operatorOnlyBrowserQuestionDiagnostic: metadata }));
      return response;
    };
    await askInvestigatorQuestion(request.question, request.context, configuration, process.env.RATE_LIMIT_SECRET!, {
      fetch: inspectedFetch, signal, history: request.history,
    });
    console.info(JSON.stringify({ operatorOnlyBrowserQuestionDiagnostic: { status: "direct-retry-accepted", calls, diagnosticRetry: true, publicRequestPassed: false } }));
  } catch (error) {
    const knownCodes = ["INVALID_QUESTION", "OUT_OF_SCOPE", "INVALID_CONTEXT", "EXPIRED_CONTEXT", "CONTEXT_LIMIT", "UNAVAILABLE", "RATE_LIMITED", "INVALID_RESPONSE", "INVALID_CITATION", "RESPONSE_LIMIT", "TIMEOUT", "ABORTED"];
    const candidate = error instanceof Error && "code" in error ? error.code : undefined;
    const code = typeof candidate === "string" && knownCodes.includes(candidate) ? candidate : "UNCLASSIFIED";
    const frames = error instanceof Error ? [...(error.stack ?? "").matchAll(/\b(questions|inference|model-transport|chat-context)\.ts:(\d+):(\d+)/g)]
      .slice(0, 8).map((match) => ({ file: match[1], line: Number(match[2]), column: Number(match[3]) })) : [];
    console.info(JSON.stringify({ operatorOnlyBrowserQuestionDiagnostic: { status: "direct-retry-rejected", calls, code, frames, diagnosticRetry: true, publicRequestPassed: false } }));
  }
}

/** Check the in-memory explanation without returning or saving its prose. */
export async function verifyRenderedExplanation(page: Page, report: ExplainedInvestigationReport) {
  const summary = report.explanation.summary;
  assert.ok(summary, "a completed main review must include its plain-language summary");
  if (report.explanation.profileVersion === "1.6.0") {
    assert.equal(typeof summary.text, "string", "profile 1.6 must contain actual generated summary text");
    assert.ok(summary.text!.trim().length > 0 && summary.text!.length <= 400);
    assert.equal(summary.grounding?.mode, "source-grounded-prose");
  }
  const generated = summary.grounding?.mode === "source-grounded-prose" && typeof summary.text === "string" && summary.text.trim().length > 0;
  const explanation = page.getByRole("region", { name: generated ? "AI explanation" : "Report assessment", exact: true });
  assert.equal(await explanation.count(), 1);
  const plainSummary = explanation.getByTestId("plain-language-summary");
  assert.equal(await plainSummary.getByText(summary.action, { exact: true }).isVisible(), true);
  const generatedParagraph = page.getByTestId("ai-summary-text");
  assert.equal(await generatedParagraph.count(), generated ? 1 : 0);
  if (generated) {
    assert.equal(await generatedParagraph.isVisible(), true);
    assert.ok((await generatedParagraph.innerText()) === summary.text, "the visible paragraph must match the validated generated summary");
    assert.equal(await page.locator(".traceforce-report").getByText(summary.text!, { exact: true }).count(), 1,
      "generated summary prose must render exactly once across the report");
    assert.equal(await plainSummary.locator("li").count(), 0, "generated prose replaces repeated canonical reason paragraphs");
  } else {
    assert.equal(await plainSummary.locator("li").count(), summary.reasons.length);
    for (const reason of summary.reasons) {
      assert.equal(await plainSummary.getByText(reason.reason, { exact: true }).isVisible(), true);
      assert.equal(await plainSummary.getByText(reason.meaning, { exact: true }).isVisible(), true);
    }
  }
  const support = explanation.locator("[data-explanation-support]");
  assert.equal(await support.count(), 1);
  assert.equal(await support.getAttribute("open"), null);
  assert.equal((await support.locator(":scope > summary").innerText()).trim(), "Supporting evidence");
  assert.equal(await explanation.getByText("AI reviewed", { exact: true }).count(), 0);
  return { profileVersion: report.explanation.profileVersion, generated, characters: generated ? summary.text!.length : 0,
    grounding: summary.grounding?.mode ?? null, renderedOnce: generated ? true : null, supportingEvidenceClosed: true };
}

/** Operator-only visual verification of the one already-acquired result.
 * By default no inference occurs. Explicit conversation mode makes three real
 * public chat requests without another scan or a transcript/context archive. */
export async function verifySwarmBrowserReport(origin: string, result: { report: ExplainedInvestigationReport; chatContext?: string }, requestedScope: "full" | "window", signal: AbortSignal, options: { screenshots?: boolean; conversation?: boolean } = {}) {
  const url = new URL(origin);
  assert.ok(["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash);
  assert.equal(result.report.assessmentAuthority, "swarm");
  if (options.conversation) assert.ok(result.chatContext, "live browser conversation requires the acquired scan's active chat context");
  const view = deriveSwarmGraphView(result.report);
  assert.ok(view, "this verification requires actual validated SWARM holder data");
  const source = view.source;
  signal.throwIfAborted();
  if (options.screenshots) await mkdir(".artifacts", { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  const cancel = () => { void browser.close().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block", hasTouch: true });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    let interceptedScans = 0, pageErrors = 0, consoleErrors = 0, unexpectedQuestionRequests = 0, liveQuestionRequests = 0;
    let activeConversationTurn: number | undefined;
    const conversationTurns: { turn: number; httpStatus: number; historyMessages: number; answerCharacters: number; caveatCharacters: number; elapsedMilliseconds: number }[] = [];
    page.on("pageerror", () => { pageErrors++; });
    page.on("console", (message) => { if (message.type() === "error") consoleErrors++; });
    await page.addInitScript(() => {
      const state = { cspViolations: 0 };
      Object.defineProperty(window, "__swarmWorkflowChecks", { value: state });
      document.addEventListener("securitypolicyviolation", () => { state.cspViolations++; });
    });
    await page.route(`${origin}/api/questions`, async (route) => {
      if (options.conversation && activeConversationTurn !== undefined && liveQuestionRequests === activeConversationTurn) {
        liveQuestionRequests++; await route.continue(); return;
      }
      unexpectedQuestionRequests++; await route.abort();
    });
    await page.route(`${origin}/api/investigations`, async (route) => {
      interceptedScans++; assert.equal(interceptedScans, 1); assert.equal(route.request().method(), "POST");
      const body = route.request().postDataJSON() as { token: string; scope: string };
      assert.equal(body.token, result.report.token.address); assert.equal(body.scope, requestedScope);
      await route.fulfill({ status: 200, contentType: "application/x-ndjson", headers: { "cache-control": "no-store" }, body: `${JSON.stringify({ type: "report", ...result })}\n` });
    });
    const response = await page.goto(`${origin}/investigate`, { waitUntil: "networkidle" });
    console.info("[swarm-browser] page loaded");
    assert.equal(response?.status(), 200);
    const csp = response?.headers()["content-security-policy"] ?? "";
    assert.match(csp, /script-src[^;]*'nonce-/); assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    await page.getByLabel("Base token contract", { exact: true }).fill(result.report.token.address);
    if (requestedScope === "window") { await page.getByText("Scan settings", { exact: true }).click(); await page.getByLabel("History scope", { exact: true }).selectOption("window"); }
    await page.getByRole("button", { name: "Start investigation", exact: true }).click();
    await page.getByRole("heading", { name: "Your investigation report", exact: true }).waitFor();
    const report = page.locator(".traceforce-report"), graph = report.locator("[data-graph-source='swarm']"), canvas = graph.locator("svg[data-graph-view='swarm']");
    await canvas.waitFor();
    const generatedSummary = await verifyRenderedExplanation(page, result.report);
    assert.equal(result.report.explanation.summary!.source.name, "SWARM");
    assert.equal(result.report.explanation.summary!.verdict, source.judge.decision);
    console.info("[swarm-browser] primary source graph ready");
    const gauge = report.getByRole("region", { name: "Score", exact: true });
    assert.equal(await gauge.getAttribute("data-assessment-source"), "swarm");
    assert.equal(await gauge.getAttribute("data-score"), source.score === null ? null : String(source.score));
    assert.equal(await gauge.getAttribute("data-verdict"), source.judge.decision);
    const verdict = report.getByRole("region", { name: "Verdict output", exact: true });
    assert.equal(await verdict.getAttribute("data-assessment-source"), "swarm");
    assert.equal(await verdict.getAttribute("data-verdict"), source.judge.decision);
    for (const decision of ["avoid", "caution", "ok"] as const) {
      const row = verdict.locator(`[data-verdict-weight="${decision}"]`);
      assert.equal(await row.getAttribute("data-weight"), String(source.judge.p[decision]));
      assert.ok((await row.innerText()).includes(`${(source.judge.p[decision] * 100).toFixed(1)}%`));
    }
    const scores = report.getByRole("region", { name: "Score breakdown", exact: true });
    assert.equal(await scores.getAttribute("data-assessment-source"), "swarm");
    for (const category of Object.keys(SWARM_CATEGORY_WEIGHTS) as (keyof typeof SWARM_CATEGORY_WEIGHTS)[])
      assert.equal(await scores.locator(`[data-category-id="${category}"]`).getAttribute("data-score-points"), source.parts[category] === null ? null : String(source.parts[category]));
    const market = report.locator(".traceforce-market-strip");
    assert.equal(await market.getAttribute("data-market-source"), "swarm");
    assert.equal(await market.getAttribute("data-market-price"), source.header.price_usd === null ? null : String(source.header.price_usd));
    assert.equal(await market.locator("time").getAttribute("datetime"), source.scannedAt);
    const sourceLink = report.getByRole("link", { name: "SWARM market source", exact: true });
    assert.equal(await sourceLink.getAttribute("href"), source.sourceUrl);
    console.info("[swarm-browser] score, verdict and market matched");
    const holderRegion = report.getByRole("region", { name: "SWARM top holders", exact: true });
    while (await holderRegion.getByRole("button", { name: /^Show more holders/ }).count()) await holderRegion.getByRole("button", { name: /^Show more holders/ }).click();
    const table = holderRegion.getByRole("table", { name: "SWARM top holders", exact: true }), rows = table.locator("tbody > tr");
    // Read the already-rendered cohort in bounded browser round trips. All
    // comparisons remain per source row; these ephemeral DOM facts are not saved.
    const [renderedRows, renderedGraph] = await Promise.all([
      rows.evaluateAll((elements) => elements.map((row) => ({ address: row.getAttribute("data-source-holder-address"),
        share: row.getAttribute("data-source-share"), cells: [...row.querySelectorAll("td")].map((cell) => cell.innerText.trim()) }))),
      canvas.evaluate((element) => ({
        nodes: [...element.querySelectorAll("g[data-node-address]")].map((node) => ({ address: node.getAttribute("data-node-address"),
          share: node.getAttribute("data-source-share"), holdingShare: node.getAttribute("data-holding-share") })),
        links: element.querySelectorAll("path[data-source-link]").length,
        clusters: element.querySelectorAll("circle[data-source-cluster]").length,
      })),
    ]);
    assert.equal(renderedRows.length, view.holders.length);
    assert.equal(renderedGraph.nodes.length, view.holders.length);
    const nodesByAddress = new Map(renderedGraph.nodes.map((node) => [node.address, node]));
    assert.equal(nodesByAddress.size, renderedGraph.nodes.length, "every source address has exactly one graph node");
    for (const [index, holder] of view.holders.entries()) {
      signal.throwIfAborted();
      const row = renderedRows[index], node = nodesByAddress.get(holder.address);
      assert.ok(node, "the holder's source address must exist in the graph");
      assert.equal(row.cells.length, 7, "all holder table fields must be rendered");
      assert.equal(row.address, holder.address);
      assert.equal(row.share, holder.share === null ? null : String(holder.share));
      assert.equal(node.share, holder.share === null ? null : String(holder.share));
      assert.equal(row.cells[2], formatSwarmShare(holder.share));
      assert.equal(node.holdingShare, row.cells[2]);
      assert.equal(row.cells[3], holder.entryKind ?? "Unknown");
      assert.equal(row.cells[4], holder.transactionCount === null ? "Unknown" : String(holder.transactionCount));
      for (const flag of swarmHolderFlags(holder)) assert.ok(row.cells[5].includes(flag));
      assert.equal(row.cells[6], holder.clusterId === null ? "—" : `#${holder.clusterId}`);
    }
    assert.equal(renderedGraph.links, view.links.length);
    assert.equal(renderedGraph.clusters, view.clusters.length);
    console.info("[swarm-browser] source holder table and graph matched");
    const chat = page.getByRole("region", { name: "Questions about this token", exact: true });
    if (options.conversation) {
      const history: { role: "user" | "assistant"; content: string }[] = [];
      const questions = ["hello", "should i buy this token?", "okay but why?"];
      for (const [index, question] of questions.entries()) {
        signal.throwIfAborted();
        assert.equal(await chat.locator("[data-chat-answer]").count(), index);
        assert.equal(await chat.locator("[data-chat-failure]").count(), 0);
        await chat.getByLabel("Ask about the observed evidence", { exact: true }).fill(question);
        activeConversationTurn = index;
        const startedAt = performance.now();
        const pendingResponse = page.waitForResponse((response) => response.url() === `${origin}/api/questions` && response.request().method() === "POST", { timeout: 150_000 });
        await chat.getByRole("button", { name: "Ask investigator", exact: true }).click();
        const response = await pendingResponse;
        const request = questionRequestSchema.parse(response.request().postDataJSON());
        assert.equal(request.question, question); assert.equal(request.context, result.chatContext);
        assert.equal(request.history.length, index * 2);
        assert.deepEqual(request.history, history, "the browser must send only its actual completed turns");
        if (response.status() !== 200) {
          const body = await response.body();
          let raw: unknown;
          if (body.byteLength <= 2048) {
            try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; } catch { /* No raw failure body is printed. */ }
          }
          const failure = publicQuestionFailureSchema.safeParse(raw);
          const knownStatuses = [400, 403, 410, 413, 429, 500, 503, 504];
          console.info(JSON.stringify({ browserQuestionFailure: { turn: index + 1,
            httpStatus: knownStatuses.includes(response.status()) ? response.status() : "UNEXPECTED_HTTP_STATUS",
            code: failure.success ? failure.data.code ?? "NO_PUBLIC_CODE" : "UNCLASSIFIED", publicRequestPassed: false } }));
          if (process.argv.includes("--diagnose-question")) await diagnoseLocalBrowserQuestion(request, signal);
        }
        assert.equal(response.status(), 200, "a diagnostic retry cannot turn a failed public question into workflow success");
        const answer = questionAnswerSchema.parse(await response.json());
        const renderedAnswer = chat.locator("[data-chat-answer]").nth(index);
        await renderedAnswer.waitFor({ state: "visible" });
        assert.equal(await renderedAnswer.textContent(), answer.answer, "the visible reply must be the validated public API answer");
        assert.equal(await chat.locator("[data-chat-answer]").count(), index + 1);
        assert.equal(await chat.locator("[data-chat-failure]").count(), 0);
        assert.equal(await chat.getByRole("alert").count(), 0);
        assert.equal(liveQuestionRequests, index + 1); activeConversationTurn = undefined;
        conversationTurns.push({ turn: index + 1, httpStatus: response.status(), historyMessages: request.history.length,
          answerCharacters: answer.answer.length, caveatCharacters: answer.caveat.length, elapsedMilliseconds: Math.round(performance.now() - startedAt) });
        // Explicit, transient semantic review only; the returned verification
        // metadata never contains replies, history or the signed context.
        console.info(JSON.stringify({ browserConversationForTransientReview: { turn: index + 1, answer: answer.answer, caveat: answer.caveat } }));
        history.push({ role: "user", content: question }, { role: "assistant", content: answer.answer });
      }
      assert.equal(conversationTurns.length, 3);
      console.info("[swarm-browser] three genuine UI conversation turns matched");
    }
    const first = view.holders[0], screenshots: string[] = [], viewports = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }]) {
      signal.throwIfAborted(); await page.setViewportSize(viewport);
      console.info(viewport.width === 1440 ? "[swarm-browser] desktop interactions" : "[swarm-browser] mobile interactions");
      await page.mouse.move(0, 0); await page.keyboard.press("Escape");
      await graph.getByLabel("Inspect a reported holder", { exact: true }).selectOption("");
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1);
      if (options.screenshots) {
        const path = `.artifacts/swarm-report-${viewport.width === 1440 ? "desktop" : "mobile"}.png`;
        await report.screenshot({ path, animations: "disabled" }); screenshots.push(path);
      }
      if (first) {
        const node = canvas.locator(`g[data-node-address="${first.address}"]`);
        if (viewport.width === 393) {
          await node.tap();
          await page.waitForFunction((address) => document.querySelector(`[data-graph-source='swarm'] g[data-node-address='${address}']`)?.getAttribute("aria-pressed") === "true", first.address, { timeout: 2_000 });
          await node.press("Escape");
        }
        await node.hover();
        const card = graph.locator("[data-source-holder-card]"); await card.waitFor();
        await page.mouse.move(0, 0); await node.press("Escape");
        await graph.getByRole("button", { name: "Fit SWARM graph", exact: true }).focus();
        await page.keyboard.press("Tab");
        assert.equal(await node.evaluate((element) => element === document.activeElement), true);
        await card.waitFor();
        const [cardText, cardSource] = await Promise.all([card.innerText(), card.getByRole("link").first().getAttribute("href")]);
        assert.ok(cardText.includes(formatSwarmShare(first.share)));
        assert.equal(cardSource, `https://basescan.org/address/${first.address}`);
        if (first.entryKind !== null) assert.ok(cardText.includes(first.entryKind));
        if (first.transactionCount !== null) assert.ok(cardText.includes(first.transactionCount.toLocaleString("en-US")));
        for (const flag of swarmHolderFlags(first)) assert.ok(cardText.includes(flag));
        await node.press("Enter");
        await page.waitForFunction((address) => document.querySelector(`[data-graph-source='swarm'] g[data-node-address='${address}']`)?.getAttribute("aria-pressed") === "true", first.address);
        const transform = await canvas.locator(":scope > g").getAttribute("transform");
        await graph.getByRole("button", { name: "Zoom in SWARM graph", exact: true }).click();
        await page.waitForFunction((previous) => document.querySelector("svg[data-graph-view='swarm'] > g")?.getAttribute("transform") !== previous, transform);
        await graph.getByRole("button", { name: "Fit SWARM graph", exact: true }).click();
        await page.waitForFunction((previous) => document.querySelector("svg[data-graph-view='swarm'] > g")?.getAttribute("transform") === previous, transform);
        await graph.getByLabel("Inspect a reported holder", { exact: true }).selectOption(first.address);
        await page.waitForFunction((address) => document.querySelector(`[data-graph-source='swarm'] g[data-node-address='${address}']`)?.getAttribute("aria-pressed") === "true", first.address);
        await page.waitForFunction(() => {
          const graph = document.querySelector("[data-graph-source='swarm']");
          return graph !== null && graph.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
        }, undefined, { timeout: 2_000 });
        if (options.screenshots) {
          const path = `.artifacts/swarm-graph-details-${viewport.width === 1440 ? "desktop" : "mobile"}.png`;
          await graph.screenshot({ path, animations: "disabled" }); screenshots.push(path);
        }
      }
      if (options.conversation && options.screenshots) {
        const path = `.artifacts/swarm-conversation-${viewport.width === 1440 ? "desktop" : "mobile"}.png`;
        await chat.screenshot({ path, animations: "disabled" }); screenshots.push(path);
      }
      viewports.push({ ...viewport, horizontalOverflow: false, sourceHolderCount: view.holders.length });
    }
    assert.equal(pageErrors, 0); assert.equal(consoleErrors, 0); assert.equal(unexpectedQuestionRequests, 0); assert.equal(interceptedScans, 1);
    assert.equal(liveQuestionRequests, options.conversation ? 3 : 0);
    const cspViolations = await page.evaluate(() => (window as unknown as { __swarmWorkflowChecks: { cspViolations: number } }).__swarmWorkflowChecks.cspViolations);
    assert.equal(cspViolations, 0);
    assert.ok((await page.getByRole("region", { name: "Local snapshots", exact: true }).innerText()).includes("No reports saved in this browser."));
    return { source: "single-live-public-scan-result-replayed-in-memory", authority: "swarm", additionalAcquisitions: 0, interceptedScans,
      sourceScore: source.score, sourceVerdict: source.judge.decision, categoriesMatched: 6, decisionWeightsMatched: 3,
      generatedSummary,
      liveChat: Boolean(options.conversation), liveQuestionRequests, unexpectedQuestionRequests,
      ...(options.conversation ? { conversation: { turns: conversationTurns, allVisibleAnswersMatched: true, errorStatuses: 0 } } : {}),
      graphHolderParity: { expectedHolders: view.holders.length, matchedHolders: view.holders.length, entriesFlagsTransactionsMatched: true, sourceFloatOnly: true },
      reportedLinksDrawn: view.links.length, reportedGroupsDrawn: view.clusters.length, ownerCountNotClaimed: true,
      hoverFocusSelectionZoomChecked: first !== undefined, viewports, cspViolations, pageErrors, consoleErrors, browserSnapshotsSaved: 0,
      screenshotsSaved: screenshots.length, screenshots };
  } finally { signal.removeEventListener("abort", cancel); await browser.close(); }
}
