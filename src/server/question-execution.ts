import "server-only";
import { readScanEngineConfiguration } from "@/config/scan-engine";
import { readInvestigatorAiConfiguration } from "@/agents/config";
import { verifyInvestigatorChatContext, askInvestigatorQuestion } from "@/agents/inference";

import { questionAnswerSchema, type InvestigationAnswer, type InvestigationChatMessage } from "@/domain/investigations/questions";
import { getScanCapacity } from "@/services/scan-capacity";
import { createDeadline } from "@/lib/deadline";
import { HttpError } from "@/lib/http";
import { boundedJson } from "@/providers/base/transport";
import { validateScanEngineDestination } from "./scan-proxy";

export function prepareQuestionExecution(): (question: string, context: string, signal: AbortSignal, history?: InvestigationChatMessage[]) => Promise<InvestigationAnswer> {
  const engine = readScanEngineConfiguration();
  if (engine.mode === "remote") return async (question, context, parent, history = []) => {
    const deadline = createDeadline(140_000, [parent]);
    try {
      deadline.signal.throwIfAborted();
      await validateScanEngineDestination(engine);
      const response = await fetch(new URL("/ask", engine.url), { method: "POST", redirect: "error", cache: "no-store", signal: deadline.signal,
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${engine.secret}` }, body: JSON.stringify({ question, context, history }) });
      if (response.status === 429) throw new HttpError(429, "The investigation engine is busy. Please try again shortly.");
      if (response.status === 400) throw new HttpError(400, "Ask a question within this scan's scope using its current question context.");
      if (response.status === 410) throw new HttpError(410, "This scan's chat context is unavailable or expired. Run a fresh scan.");
      if (response.redirected || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new Error("Invalid question response.");
      const answer = questionAnswerSchema.parse(await boundedJson(response, 65536));
      deadline.signal.throwIfAborted();
      return answer;
    } finally { deadline.dispose(); }
  };
  const configuration = readInvestigatorAiConfiguration();
  const secret = process.env.RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512 || /[\s\x00-\x1f\x7f]/.test(secret)) throw new Error("Configure a private local context signing secret.");
  return async (question, context, parent, history = []) => {
    verifyInvestigatorChatContext(context, configuration, secret);
    const capacity = getScanCapacity();
    const leave = capacity.enter();
    const deadline = createDeadline(135_000, [parent]);
    let release: (() => void) | undefined;
    try {
      release = await capacity.explanation(deadline.signal);
      return questionAnswerSchema.parse(await askInvestigatorQuestion(question, context, configuration, secret, { signal: deadline.signal, fetch: globalThis.fetch, history }));
    } finally { release?.(); leave(); deadline.dispose(); }
  };
}
