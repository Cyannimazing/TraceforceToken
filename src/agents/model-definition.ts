import { ON_CHAIN_INVESTIGATOR } from "./profiles";

export const INVESTIGATOR_BASE_MODEL = "qwen3:4b-instruct-2507-q4_K_M";
export const INVESTIGATOR_MODEL_NAME = "traceforce-investigator";
export const INVESTIGATOR_MODEL_PARAMETERS = Object.freeze({ temperature: 0, num_ctx: 4096, num_thread: 2, num_predict: 800 });

/** Instruction specialization reuses the base weights; this performs no training. */
export function investigatorModelfile(): string {
  if (ON_CHAIN_INVESTIGATOR.systemInstructions.includes('"""')) throw new Error("Agent instructions cannot contain a Modelfile delimiter.");
  return [
    `# TraceForge Engine investigator profile ${ON_CHAIN_INVESTIGATOR.version}`,
    "# Instruction-specialized model; not fine-tuned weights.",
    `FROM ${INVESTIGATOR_BASE_MODEL}`,
    ...Object.entries(INVESTIGATOR_MODEL_PARAMETERS).map(([name, value]) => `PARAMETER ${name} ${value}`),
    `SYSTEM """\n${ON_CHAIN_INVESTIGATOR.systemInstructions}\n"""`,
    "",
  ].join("\n");
}
