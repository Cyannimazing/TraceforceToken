import { randomBytes } from "node:crypto";
import { config as loadEnvironment } from "dotenv";
import { readLocalAiConfiguration } from "../src/agents/config";
import { createChatContext } from "../src/agents/chat-context";
import { askInvestigatorQuestion } from "../src/agents/inference";
import { readLocalAiJson } from "../src/agents/model-transport";
import type { InvestigationChatMessage } from "../src/domain/investigations/questions";
import { getBrowserReportFixture } from "../tests/fixtures/report";

/** Explicit synthetic local inference only; no paid provider, database or report/chat output. */
async function main() {
  if (!process.argv.includes("--run-local")) {
    console.log("Run with --run-local to measure two real local greeting turns using an ephemeral synthetic signed scope. Prints timing/model/acceptance metadata only; no report or conversation is saved. Gemini is never called."); return;
  }
  loadEnvironment({ path: ".env.local", quiet: true });
  const local = readLocalAiConfiguration();
  const secret = randomBytes(32).toString("hex");
  const capsule = createChatContext(getBrowserReportFixture(), local, secret);
  const history: InvestigationChatMessage[] = [];
  for (let turn = 1; turn <= 2; turn++) {
    const started = performance.now(); let loadMs: number | undefined; let outputTokens: number | undefined; let predictBudget: number | undefined;
    try {
      const answer = await askInvestigatorQuestion("hi", capsule, { local }, secret, { history, fetch: async (url, init) => {
        const request = JSON.parse(String(init?.body)) as { options: { num_predict: number } };
        predictBudget = request.options.num_predict;
        const response = await globalThis.fetch(url, init);
        const raw = await readLocalAiJson(response.clone(), local.maxResponseBytes, init?.signal ?? new AbortController().signal) as Record<string, unknown>;
        if (typeof raw.load_duration === "number") loadMs = Math.round(raw.load_duration / 1_000_000);
        if (typeof raw.eval_count === "number") outputTokens = raw.eval_count;
        return response;
      } });
      history.push({ role: "user", content: "hi" }, { role: "assistant", content: answer.answer });
      console.log(JSON.stringify({ turn, accepted: true, elapsedMs: Math.round(performance.now() - started), model: answer.model, keepAliveSeconds: local.keepAliveSeconds, predictBudget, loadMs, outputTokens }));
    } catch (error) {
      console.log(JSON.stringify({ turn, accepted: false, elapsedMs: Math.round(performance.now() - started), code: error instanceof Error && "code" in error ? String(error.code) : "UNAVAILABLE" }));
      process.exitCode = 1; return;
    }
  }
}
main().catch(() => { console.error("Local chat verification could not run; configuration and provider details were not logged."); process.exitCode = 1; });
