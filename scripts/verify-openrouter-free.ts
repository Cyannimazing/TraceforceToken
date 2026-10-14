import { randomBytes } from "node:crypto";
import { config as loadEnvironment } from "dotenv";
import { readInvestigatorAiConfiguration } from "../src/agents/config";
import { askInvestigatorQuestion, createInvestigatorChatContext, runInvestigatorWithConfig, verifyInvestigatorChatContext } from "../src/agents/inference";
import { readLocalAiJson } from "../src/agents/model-transport";
import { validateExplainedReport } from "../src/domain/investigations/report-validation";
import { getBrowserReportFixture } from "../tests/fixtures/report";

/** Three deliberate free-only requests; synthetic facts, no report/chat archive. */
async function main() {
  if (!process.argv.includes("--run-free")) {
    console.log("Use --run-free for three actual zero-price OpenRouter checks with synthetic report context. Prints verification metadata only; never uses a paid provider or saves reports/conversations.");
    return;
  }
  loadEnvironment({ path: ".env.local", quiet: true });
  const configuration = readInvestigatorAiConfiguration({ ...process.env, INVESTIGATOR_AI_PROVIDER: "openrouter" });
  const provider = configuration.openrouter;
  if (!provider?.freeOnly || (provider.model !== "openrouter/free" && !provider.model.endsWith(":free"))) throw new Error("Configure free-only protection and a free model before verification.");
  let stage = "canonical report", calls = 0;
  const receipts: { stage: string; httpStatus: number; servedModel?: string; cost?: number | null; finish?: string; outputTokens?: number; reasoningTokens?: number; contentCharacters?: number; reason?: string }[] = [];
  const checkedFetch: typeof globalThis.fetch = async (url, init) => {
    if (++calls > 3 || String(url) !== "https://openrouter.ai/api/v1/chat/completions") throw new Error("Verification call limit or destination rejected.");
    const body = JSON.parse(String(init?.body));
    if (body.model !== provider.model || body.provider?.max_price?.prompt !== 0 || body.provider?.max_price?.completion !== 0 || body.provider?.max_price?.request !== 0 || body.provider?.allow_fallbacks !== false
      || body.provider?.data_collection !== (provider.allowDataCollection ? "allow" : "deny"))
      throw new Error("Zero-price protection is required before sending a request.");
    const response = await globalThis.fetch(url, init);
    const receipt: typeof receipts[number] = { stage, httpStatus: response.status };
    receipts.push(receipt);
    if (!response.ok) {
      try {
        const diagnostic = new Response(response.clone().body, { status: 200, headers: response.headers });
        const raw = await readLocalAiJson(diagnostic, provider.maxResponseBytes, init?.signal ?? new AbortController().signal) as { error?: { message?: unknown; metadata?: { raw?: unknown } } };
        const reason = [raw.error?.message, raw.error?.metadata?.raw].filter((value): value is string => typeof value === "string").join(" ");
        if (reason) receipt.reason = reason.replaceAll(provider.apiKey, "[redacted]").replace(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1000);
      } catch { /* Untrusted diagnostics never bypass the production error path. */ }
    }
    if (response.ok) {
      const raw = await readLocalAiJson(response.clone(), provider.maxResponseBytes, init?.signal ?? new AbortController().signal) as Record<string, unknown>;
      if (typeof raw.model === "string" && raw.model.length <= 117) receipt.servedModel = raw.model;
      const usage = raw.usage as Record<string, unknown> | undefined;
      if (usage && (typeof usage.cost === "number" || usage.cost === null)) receipt.cost = usage.cost;
      if (typeof usage?.completion_tokens === "number") receipt.outputTokens = usage.completion_tokens;
      const details = usage?.completion_tokens_details as Record<string, unknown> | undefined;
      if (typeof details?.reasoning_tokens === "number") receipt.reasoningTokens = details.reasoning_tokens;
      const choices = raw.choices as { finish_reason?: unknown; message?: { content?: unknown } }[] | undefined;
      if (Array.isArray(choices) && typeof choices[0]?.finish_reason === "string") receipt.finish = choices[0].finish_reason.slice(0, 32);
      if (typeof choices?.[0]?.message?.content === "string") receipt.contentCharacters = choices[0].message.content.length;
      if (stage === "cited funding question" && process.argv.includes("--inspect-synthetic-answer") && typeof choices?.[0]?.message?.content === "string") {
        // Explicit operator review of synthetic wording only; never enabled for
        // public requests and never saves a conversation or capsule.
        console.log(JSON.stringify({ syntheticAnswerForReview: choices[0].message.content.slice(0, 2000) }));
      }
    }
    return response;
  };
  const started = performance.now();
  try {
    console.log(JSON.stringify({ stage, context: "explicitly synthetic", requestModel: provider.model, zeroPriceEnforced: true, providerDataCollectionAllowed: provider.allowDataCollection }));
    const source = getBrowserReportFixture();
    const explanation = await runInvestigatorWithConfig(source, configuration, { fetch: checkedFetch });
    const report = validateExplainedReport({ ...source, explanation });
    const secret = randomBytes(32).toString("hex");
    const capsule = createInvestigatorChatContext(report, configuration, secret);
    const verified = verifyInvestigatorChatContext(capsule, configuration, secret);
    console.log(JSON.stringify({ stage, accepted: true, model: explanation.model, canonicalGrounding: explanation.grounding?.mode, verdict: explanation.summary?.verdict, observations: explanation.observations.length, capsuleScope: verified.model }));
    for (const question of ["hi", "Who funded the wallets?"]) {
      stage = question === "hi" ? "greeting" : "cited funding question";
      console.log(JSON.stringify({ stage }));
      const answer = await askInvestigatorQuestion(question, capsule, configuration, secret, { fetch: checkedFetch });
      console.log(JSON.stringify({ stage, accepted: true, model: answer.model, answerCharacters: answer.answer.length, citations: answer.evidenceIds.length, needsFreshScan: answer.needsFreshScan }));
    }
    console.log(JSON.stringify({ verified: true, verifiedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), calls, receipts, providerDataCollectionAllowed: provider.allowDataCollection, archivedReport: false, archivedConversation: false }));
  } catch (error) {
    console.log(JSON.stringify({ verified: false, stage, elapsedMs: Math.round(performance.now() - started), calls, receipts, code: error instanceof Error && "code" in error ? String(error.code) : "UNAVAILABLE" }));
    process.exitCode = 1;
  }
}
main().catch(() => { console.error("Free OpenRouter verification could not start. Check private key and free-only configuration; credentials were not logged."); process.exitCode = 1; });
