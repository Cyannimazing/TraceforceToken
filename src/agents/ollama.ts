import "server-only";
import type { InvestigationReport } from "@/domain/investigations/types";
import { readLocalAiConfiguration } from "./config";
import { runLocalInvestigatorWithConfig } from "./ollama-core";

/** The worker invokes this stage before it can complete a report. */
export async function runLocalInvestigator(report: InvestigationReport, options: { signal?: AbortSignal; onProgress?: (stage: string) => Promise<void> } = {}) {
  return runLocalInvestigatorWithConfig(report, readLocalAiConfiguration(), { fetch: globalThis.fetch, ...options });
}
