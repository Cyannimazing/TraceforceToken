import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { config } from "dotenv";
import { z } from "zod";
import { readLocalAiConfiguration } from "../src/agents/config";
import { INVESTIGATOR_BASE_MODEL } from "../src/agents/model-definition";
import { LocalAiError, readLocalAiJson, runLocalInvestigatorWithConfig } from "../src/agents/ollama-core";
import { ON_CHAIN_INVESTIGATOR } from "../src/agents/profiles";
import { analyzeInvestigation } from "../src/domain/investigations/analyze";
import type { InvestigationDataset, InvestigationExplanation } from "../src/domain/investigations/types";

const integer = z.number().int().nonnegative().safe();
const modelSchema = z.object({ name: z.string().max(128).optional(), model: z.string().max(128).optional(), digest: z.string().max(128).optional(), size: integer.optional(), size_vram: integer.optional(), context_length: integer.optional() });
const modelList = z.object({ models: z.array(modelSchema).max(1000) });
const telemetrySchema = z.object({ model: z.string().max(128).optional(), done: z.boolean().optional(), done_reason: z.string().max(64).optional(), total_duration: integer.optional(), load_duration: integer.optional(), prompt_eval_count: integer.optional(), prompt_eval_duration: integer.optional(), eval_count: integer.optional(), eval_duration: integer.optional() });
type Sample = { elapsedMs: number; phase: "before" | "during" | "after"; models?: z.infer<typeof modelSchema>[]; error?: "unavailable" };

async function main() {
  if (process.argv.includes("--help")) {
    console.info("Usage: npm run ai:benchmark -- --dataset=.artifacts/<retained-dataset>.json\nRuns one real CPU-only inference. Writes a local artifact for pending human semantic review; no database, chain acquisition, downloads, or model changes.");
    return;
  }
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith("--dataset=")) throw new Error("A single --dataset argument is required.");
  const artifacts = resolve(".artifacts"), datasetPath = resolve(args[0].slice("--dataset=".length));
  const inside = relative(artifacts, datasetPath);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside) || !datasetPath.endsWith(".json")) throw new Error("Dataset must be a JSON file inside .artifacts.");
  const information = await stat(datasetPath);
  if (!information.isFile() || information.size > 20 * 1024 * 1024) throw new Error("Dataset exceeds the local input budget.");
  const bytes = await readFile(datasetPath);
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Dataset exceeds the local input budget.");
  const dataset = JSON.parse(bytes.toString("utf8")) as InvestigationDataset;
  const checkedAt = new Date().toISOString();
  const report = analyzeInvestigation(dataset, { id: randomUUID(), generatedAt: checkedAt });
  config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
  // Force the measured request to CPU-only/two threads even if the operator's env differs.
  const configuration = readLocalAiConfiguration({ ...process.env, LOCAL_AI_GPU_LAYERS: "0", LOCAL_AI_THREADS: "2" });
  const host = { platform: platform(), release: release(), cpuModels: [...new Set(cpus().map((cpu) => cpu.model))], logicalCpus: cpus().length, availableParallelism: availableParallelism(), totalRamBytes: totalmem(), freeRamBytesBefore: freemem() };
  const sameModel = (value: z.infer<typeof modelSchema>) => [value.name, value.model].some((name) => name === configuration.model || name === `${configuration.model}:latest`);
  const api = async (path: "/api/ps" | "/api/tags") => {
    const signal = AbortSignal.timeout(3000);
    return modelList.parse(await readLocalAiJson(await fetch(new URL(path, configuration.baseUrl), { redirect: "error", cache: "no-store", signal, headers: { accept: "application/json" } }), 262_144, signal));
  };
  let installedModel: z.infer<typeof modelSchema> | null = null;
  try { installedModel = (await api("/api/tags")).models.find(sameModel) ?? null; } catch { /* Unknown, never zero or a claimed installed digest. */ }
  const samples: Sample[] = [];
  const started = performance.now();
  let inFlight = false;
  const sample = async (phase: Sample["phase"]) => {
    const elapsedMs = Math.round(performance.now() - started);
    try { samples.push({ elapsedMs, phase, models: (await api("/api/ps")).models.filter(sameModel) }); }
    catch { samples.push({ elapsedMs, phase, error: "unavailable" }); }
  };
  let rawResponse: unknown = null;
  let modelRequest: unknown = null;
  let telemetry: z.infer<typeof telemetrySchema> | null = null;
  let httpStatus: number | null = null;
  const measuredFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== configuration.baseUrl || url.pathname !== "/api/chat" || init?.method !== "POST" || typeof init.body !== "string") throw new Error("Unexpected benchmark request.");
    modelRequest = JSON.parse(init.body) as unknown;
    const requestOptions = z.object({ options: z.object({ num_gpu: z.literal(0), num_thread: z.literal(2) }) }).safeParse(modelRequest);
    if (!requestOptions.success) throw new Error("CPU-only request invariant failed.");
    inFlight = true;
    try {
      const response = await fetch(input, init);
      httpStatus = response.status;
      if (!response.ok) return response;
      rawResponse = await readLocalAiJson(response, configuration.maxResponseBytes, init.signal ?? AbortSignal.timeout(configuration.timeoutMs));
      const measured = telemetrySchema.safeParse(rawResponse);
      if (measured.success) telemetry = measured.data;
      return new Response(JSON.stringify(rawResponse), { status: response.status, headers: { "content-type": "application/json" } });
    } finally { inFlight = false; }
  };
  await sample("before");
  let activeSample: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight && !activeSample && samples.length < 150) activeSample = sample("during").finally(() => { activeSample = null; });
  }, 1000);
  let explanation: InvestigationExplanation | null = null;
  let failure: { layer: string; code: string } | null = null;
  const inferenceStarted = performance.now();
  try { explanation = await runLocalInvestigatorWithConfig(report, configuration, { fetch: measuredFetch }); }
  catch (error) {
    const code = error instanceof LocalAiError ? error.code : "UNEXPECTED_FAILURE";
    failure = { layer: code === "INVALID_CITATION" ? "citation_validation" : code === "INVALID_RESPONSE" ? "output_validation" : "execution_or_context", code };
  } finally { clearInterval(timer); }
  const elapsedMs = Math.round(performance.now() - inferenceStarted);
  if (activeSample) await activeSample;
  await sample("after");
  const during = samples.filter((item) => item.phase === "during").flatMap((item) => item.models ?? []);
  const observed = during.filter((model) => model.size_vram !== undefined);
  const cpuStatus = observed.some((model) => model.size_vram! > 0) ? "gpu_allocation_observed" : observed.length ? "zero_vram_observed" : "unverified_no_usable_loaded_sample";
  const timings = telemetry as z.infer<typeof telemetrySchema> | null;
  const artifact = {
    schemaVersion: 1, checkedAt, status: explanation ? "structurally_valid" : "failed", failure,
    semanticReview: { status: "pending", accuracyPassed: false, note: "Schema and citation checks do not establish the truth of prose. Compare each claim with supplied context and retained evidence before acceptance." },
    input: { file: basename(datasetPath), sha256: createHash("sha256").update(bytes).digest("hex"), evidenceRecords: report.evidence.length },
    profile: { id: ON_CHAIN_INVESTIGATOR.id, version: ON_CHAIN_INVESTIGATOR.version, expectedBaseModel: INVESTIGATOR_BASE_MODEL },
    configuration: { ...configuration, baseUrl: new URL(configuration.baseUrl).origin }, installedModel,
    host: { ...host, freeRamBytesAfter: freemem(), caveat: "Host inventory is not proof of 2-vCPU/8-GB resource caps. Two inference threads do not constrain total host CPUs. Free RAM is not peak process RSS." },
    measurement: { elapsedMs, httpStatus, telemetry: timings, generatedTokensPerSecond: timings?.eval_count !== undefined && timings.eval_duration ? timings.eval_count * 1e9 / timings.eval_duration : null },
    cpuVerification: { status: cpuStatus, requestedGpuLayers: 0, requestedThreads: 2, loadedSamples: during.length, samplesWithVram: observed.length, caveat: "Matching /api/ps zero size_vram supports CPU allocation only during sampled moments. API size is model allocation, not whole-process peak RAM; this is not a KVM2 capacity benchmark." },
    runtimeSamples: samples, modelRequest, rawResponse, report: { ...report, ...(explanation ? { explanation } : {}) },
  };
  await mkdir(artifacts, { recursive: true });
  const output = resolve(artifacts, `ai-benchmark-${checkedAt.replaceAll(/[:.]/g, "-")}.json`);
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  console.info(JSON.stringify({ status: artifact.status, semanticReview: "pending", elapsedMs, cpuStatus, artifact: relative(process.cwd(), output), ...(failure ? { failure } : {}) }));
  if (!explanation || cpuStatus === "gpu_allocation_observed") process.exitCode = 1;
}

main().catch(() => { console.error(JSON.stringify({ status: "benchmark_setup_failed", semanticReview: "not_started", note: "Check the single retained dataset path, analyzer input, required local-model configuration, and artifact directory. No chain/database acquisition or model download was attempted." })); process.exitCode = 1; });
