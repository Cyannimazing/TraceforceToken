import "server-only";
import { readScanEngineConfiguration } from "@/config/scan-engine";
import { readProviderConfiguration } from "@/providers/base/config";
import { readInvestigatorAiConfiguration } from "@/agents/config";
import { collectInvestigationWithConfig } from "@/providers/base/collector";
import { runInvestigatorWithConfig, createInvestigatorChatContext } from "@/agents/inference";
import { createScanResponse } from "@/services/scan-stream";
import { proxyScanResponse } from "./scan-proxy";
import type { ScanParameters } from "@/domain/investigations/types";


export function prepareScanExecution(): (parameters: ScanParameters, signal: AbortSignal) => Response | Promise<Response> {
  const engine = readScanEngineConfiguration();
  if (engine.mode === "remote") return (parameters, signal) => proxyScanResponse(parameters, engine, signal);
  const provider = readProviderConfiguration();
  const ai = readInvestigatorAiConfiguration();
  const secret = process.env.RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512 || /[\s\x00-\x1f\x7f]/.test(secret)) throw new Error("Configure a private local context signing secret.");
  return (parameters, signal) => createScanResponse(parameters, {
    collect: (input, options) => collectInvestigationWithConfig(input, provider, options),
    explain: (report, options) => runInvestigatorWithConfig(report, ai, { fetch: globalThis.fetch, ...options }),
    createChatContext: (report) => createInvestigatorChatContext(report, ai, secret),
  }, signal);
}
