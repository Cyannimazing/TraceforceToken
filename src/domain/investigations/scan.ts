import { z } from "zod";
import type { Address, ExplainedInvestigationReport, InvestigationReport } from "./types";
import { DEFAULT_LOOKBACK_BLOCKS } from "./scan-defaults";

export const scanParametersSchema = z.object({
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address),
  lookbackBlocks: z.number().int().min(100).max(20_000).default(DEFAULT_LOOKBACK_BLOCKS),
  scope: z.enum(["full", "window"]).default("full"),
}).strict();

export type ScanEvent =
  | { type: "progress"; stage: string }
  | { type: "analysis"; report: InvestigationReport }
  | { type: "report"; report: ExplainedInvestigationReport; chatContext?: string }
  | { type: "error"; error: string };

export const MAX_SCAN_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_SCAN_STREAM_BYTES = 16 * 1024 * 1024;
export const SCAN_RESPONSE_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "x-accel-buffering": "no",
} as const;
