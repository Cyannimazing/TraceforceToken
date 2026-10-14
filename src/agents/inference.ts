import { createDeadline } from "@/lib/deadline";
import type { ExplainedInvestigationReport, InvestigationReport } from "@/domain/investigations/types";
import { aiModelIdentifier, aiModelMatchesConfiguration, validateAiConfiguration, type AiConfiguration, type InvestigatorAiConfiguration } from "./config";
import { runLocalInvestigatorWithConfig, type LocalAiDependencies } from "./ollama-core";
import { LocalAiError } from "./model-transport";
import { askInvestigationQuestion, InvestigationQuestionError } from "./questions";
import { createChatContext, verifyChatContext } from "./chat-context";

function configurations(configuration: InvestigatorAiConfiguration): AiConfiguration[] {
  const openrouter: AiConfiguration | undefined = configuration.openrouter ? validateAiConfiguration(configuration.openrouter) : undefined;
  if (openrouter && (!("provider" in openrouter) || openrouter.provider !== "openrouter")) throw new Error("Invalid OpenRouter provider configuration.");
  const freeOnly = openrouter && "freeOnly" in openrouter && openrouter.freeOnly === true;
  const values = [configuration.local, openrouter, freeOnly ? undefined : configuration.gemini].filter((value) => value !== undefined).map(validateAiConfiguration);
  if (!values.length) throw new Error("Configure an investigator AI provider.");
  return values;
}
/** Selected providers only; availability/limit/deadline failures permit the next provider. */
async function withAvailableAi<T>(configuration: InvestigatorAiConfiguration, parent: AbortSignal | undefined, run: (config: AiConfiguration, signal: AbortSignal) => Promise<T>): Promise<T> {
  const providers = configurations(configuration);
  const totalBudget = Math.max(...providers.map((config) => config.timeoutMs));
  const deadline = createDeadline(totalBudget, parent ? [parent] : []);
  const started = performance.now();
  try {
    for (let index = 0; index < providers.length; index++) {
      deadline.signal.throwIfAborted();
      const remaining = Math.floor(totalBudget - (performance.now() - started));
      if (remaining < 1) throw new LocalAiError("TIMEOUT");
      const provider = providers[index];
      // An owned child timer can use a sub-second share while provider settings
      // retain their validated 1,000ms minimum. Even a 1s total reserves fallback.
      const attemptsLeft = providers.length - index;
      const attemptBudget = Math.min(provider.timeoutMs, attemptsLeft > 1 ? Math.min(60_000, Math.max(1, Math.floor(remaining / attemptsLeft))) : remaining);
      const attempt = createDeadline(attemptBudget, [deadline.signal]);
      const attemptStarted = performance.now();
      try {
        const result = await run(provider, attempt.signal);
        attempt.signal.throwIfAborted();
        // A stalled event loop can delay timer dispatch until after publication.
        if (performance.now() - attemptStarted >= attemptBudget || performance.now() - started >= totalBudget) throw new LocalAiError("TIMEOUT");
        return result;
      }
      catch (error) {
        if (parent?.aborted) throw error;
        const timedOut = attempt.signal.aborted && attempt.signal.reason instanceof DOMException && attempt.signal.reason.name === "TimeoutError";
        const failure = timedOut ? error instanceof InvestigationQuestionError ? new InvestigationQuestionError("TIMEOUT") : new LocalAiError("TIMEOUT") : error;
        if (deadline.signal.aborted) throw failure;
        const canFallback = (failure instanceof LocalAiError || failure instanceof InvestigationQuestionError) && ["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT"].includes(failure.code);
        if (!canFallback || index === providers.length - 1) throw failure;
      } finally { attempt.dispose(); }
    }
    throw new LocalAiError("UNAVAILABLE");
  } catch (error) {
    if (parent?.aborted) throw error instanceof InvestigationQuestionError ? new InvestigationQuestionError("ABORTED") : new LocalAiError("ABORTED");
    if (deadline.signal.aborted) throw error instanceof InvestigationQuestionError ? new InvestigationQuestionError("TIMEOUT") : new LocalAiError("TIMEOUT");
    throw error;
  } finally { deadline.dispose(); }
}

export function runInvestigatorWithConfig(report: InvestigationReport, configuration: InvestigatorAiConfiguration, dependencies: LocalAiDependencies) {
  return withAvailableAi(configuration, dependencies.signal, (config, signal) => runLocalInvestigatorWithConfig(report, config, { ...dependencies, signal }));
}
export function createInvestigatorChatContext(report: ExplainedInvestigationReport, configuration: InvestigatorAiConfiguration, secret: string): string {
  const config = configurations(configuration).find((candidate) => aiModelMatchesConfiguration(candidate, report.explanation.model));
  if (!config) throw new Error("Report model does not match a configured provider.");
  return createChatContext(report, config, secret);
}
export function verifyInvestigatorChatContext(capsule: string, configuration: InvestigatorAiConfiguration, secret: string) {
  const providers = configurations(configuration);
  return verifyChatContext(capsule, providers[0], secret, { allowedModels: providers.map(aiModelIdentifier) });
}
export function askInvestigatorQuestion(question: string, capsule: string, configuration: InvestigatorAiConfiguration, secret: string, dependencies: Parameters<typeof askInvestigationQuestion>[4]) {
  const allowedModels = configurations(configuration).map(aiModelIdentifier);
  return withAvailableAi(configuration, dependencies.signal, (config, signal) => askInvestigationQuestion(question, capsule, config, secret, { ...dependencies, signal, allowedModels })).catch((error: unknown) => {
    if (error instanceof LocalAiError) throw new InvestigationQuestionError(error.code);
    throw error;
  });
}
