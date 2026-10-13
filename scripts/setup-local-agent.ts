import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { z } from "zod";
import { readLocalAiConfiguration } from "../src/agents/config";
import { investigatorModelfile, INVESTIGATOR_BASE_MODEL, INVESTIGATOR_MODEL_NAME, INVESTIGATOR_MODEL_PARAMETERS } from "../src/agents/model-definition";
import { readLocalAiJson } from "../src/agents/ollama-core";
import { ON_CHAIN_INVESTIGATOR } from "../src/agents/profiles";

// Explicit local model creation only. There is no install, pull, or inference call.
async function main() {
  config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
  const configuration = readLocalAiConfiguration({ ...process.env, LOCAL_AI_MODEL: INVESTIGATOR_MODEL_NAME });
  const definition = await readFile("models/traceforce-investigator.Modelfile", "utf8");
  if (definition.replaceAll("\r\n", "\n") !== investigatorModelfile()) throw new Error("The checked-in Modelfile does not match the versioned agent profile.");
  const signal = AbortSignal.timeout(120_000);
  const call = async (path: string, body?: unknown) => readLocalAiJson(await fetch(new URL(path, configuration.baseUrl), {
    method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", signal,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), 262_144, signal);
  const models = z.object({ models: z.array(z.object({ name: z.string(), model: z.string().optional() })).max(1000) }).parse(await call("/api/tags"));
  // Require the exact reviewed instruction-only tag; an installed hybrid qwen3:4b is insufficient.
  if (!models.models.some((model) => model.name === INVESTIGATOR_BASE_MODEL || model.model === INVESTIGATOR_BASE_MODEL)) {
    console.error(JSON.stringify({ status: "base-model-missing", baseModel: INVESTIGATOR_BASE_MODEL, note: "Install the reviewed base model separately, then rerun. No download was attempted." })); process.exitCode = 1; return;
  }
  const created = z.object({ status: z.literal("success") }).parse(await call("/api/create", {
    model: INVESTIGATOR_MODEL_NAME, from: INVESTIGATOR_BASE_MODEL, stream: false,
    system: ON_CHAIN_INVESTIGATOR.systemInstructions, parameters: INVESTIGATOR_MODEL_PARAMETERS,
  }));
  if (created.status !== "success") throw new Error("Named agent creation did not complete.");
  const available = z.object({ models: z.array(z.object({ name: z.string(), model: z.string().optional() })).max(1000) }).parse(await call("/api/tags"));
  if (!available.models.some((model) => model.name === `${INVESTIGATOR_MODEL_NAME}:latest` || model.name === INVESTIGATOR_MODEL_NAME || model.model === `${INVESTIGATOR_MODEL_NAME}:latest`)) throw new Error("Named agent was not listed after creation.");
  console.info(JSON.stringify({ status: "created", model: INVESTIGATOR_MODEL_NAME, baseModel: INVESTIGATOR_BASE_MODEL, profileVersion: ON_CHAIN_INVESTIGATOR.version, inferenceVerified: false, note: "Instruction-specialized existing weights; no fine-tuning was performed." }));
}

main().catch(() => { console.error(JSON.stringify({ status: "setup-failed", note: "Check the loopback runtime, installed base model, and Modelfile. No upstream response or private path was logged." })); process.exitCode = 1; });
