import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { config } from "dotenv";
import { z } from "zod";
import { analyzeInvestigation } from "../src/domain/investigations/analyze";
import type { Address, EvidenceRecord, InvestigationDataset } from "../src/domain/investigations/types";
import { collectInvestigationWithConfig } from "../src/providers/base/collector";
import { readProviderConfiguration } from "../src/providers/base/config";
import { ProviderBudgetError, ProviderIntegrityError, TRANSFER_TOPIC, UpstreamFailure } from "../src/providers/base/core";
import { createProviderTransport, validateProviderDestination } from "../src/providers/base/transport";

// Script-only public defaults. Application collectors always require explicit BASE_RPC_URL.
// WETH reference: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const PUBLIC_PROVIDERS = [
  { label: "official-public-base", url: "https://mainnet.base.org" },
  { label: "publicnode-base", url: "https://base-rpc.publicnode.com" },
];
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const crossReceiptSchema = z.object({ transactionHash: hashSchema, blockHash: hashSchema, blockNumber: hexSchema, status: z.literal("0x1"), logs: z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), logIndex: hexSchema, topics: z.array(hashSchema), data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/) })) });

function failureCode(error: unknown) {
  if (error instanceof ProviderIntegrityError || error instanceof assert.AssertionError) return "EVIDENCE_DISAGREEMENT";
  if (error instanceof ProviderBudgetError) return "PROVIDER_BUDGET_EXHAUSTED";
  if (error instanceof UpstreamFailure) return error.rpcCode !== undefined ? `RPC_ERROR_${error.rpcCode}` : error.httpStatus !== undefined ? `HTTP_ERROR_${error.httpStatus}` : "UPSTREAM_UNAVAILABLE";
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "PROVIDER_DEADLINE_EXCEEDED";
  return "PROVIDER_VERIFICATION_FAILED";
}

async function main() {
  config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
  const lookbackBlocks = z.coerce.number().int().min(1).max(100).parse(process.argv.find((argument) => argument.startsWith("--blocks="))?.slice(9) ?? "100");
  await mkdir(".artifacts", { recursive: true });
  const artifactPrefix = `.artifacts/base-provider-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const attempts: { source: string; status: string; code?: string }[] = [];
  const configured = process.argv.includes("--public") ? undefined : process.env.BASE_RPC_URL?.trim();
  const providers = configured ? [{ label: "configured-base-provider", url: configured }] : PUBLIC_PROVIDERS;
  let dataset: InvestigationDataset | null = null;
  let selected: { label: string; url: string } | null = null;
  const savedDatasetArgument = process.argv.find((argument) => argument.startsWith("--dataset="))?.slice(10);
  let savedDatasetReference: string | undefined;
  if (savedDatasetArgument) {
    // A saved artifact deliberately omits credential-bearing endpoints; the operator
    // must identify its public acquisition source instead of the script guessing.
    const primary = z.enum(["drpc", "official-base", "publicnode"]).parse(process.argv.find((argument) => argument.startsWith("--dataset-primary="))?.slice(18));
    const primaryUrl = primary === "drpc" ? "https://base.drpc.org" : primary === "official-base" ? PUBLIC_PROVIDERS[0].url : PUBLIC_PROVIDERS[1].url;
    const artifactDirectory = resolve(".artifacts");
    const savedPath = resolve(savedDatasetArgument);
    const withinArtifacts = relative(artifactDirectory, savedPath);
    if (!withinArtifacts || isAbsolute(withinArtifacts) || withinArtifacts.startsWith(`..${sep}`) || withinArtifacts === ".." || resolve(artifactDirectory, withinArtifacts) !== savedPath || !savedPath.endsWith("-dataset.json")) throw new Error("Invalid saved artifact path.");
    const saved: unknown = JSON.parse(await readFile(savedPath, "utf8"));
    // The analyzer validates and normalizes the saved boundary before any cross-check.
    const validated = analyzeInvestigation(saved as InvestigationDataset, { id: randomUUID(), generatedAt: new Date().toISOString() });
    assert.equal(validated.token.address, WETH, "This verification script samples Base WETH only.");
    dataset = { token: validated.token, range: validated.range, evidence: validated.evidence, coverage: validated.coverage, pools: [], hubs: [] };
    selected = { label: `saved-${primary}-dataset`, url: primaryUrl };
    savedDatasetReference = savedDatasetArgument;
    attempts.push({ source: selected.label, status: "loaded-for-secondary-comparison" });
  }
  for (const provider of dataset ? [] : providers) {
    try {
      const configuration = readProviderConfiguration({ ...process.env, BASE_RPC_URL: provider.url, BASE_RPC_FALLBACK_URLS: "", BASE_LOG_RPC_URL: "", BASE_FUNDING_SOURCE: "rpc", BLOCKSCOUT_API_KEY: "", BASE_RPC_LOG_CHUNK_SIZE: "10", BASE_MAX_TRANSFER_LOGS: "300", BASE_RPC_CALL_BUDGET: "300", BASE_FUNDING_MAX_PAGES: "1", BASE_PROVIDER_TIMEOUT_MS: "12000", BASE_PROVIDER_SCAN_TIMEOUT_MS: "120000" });
      const result = await collectInvestigationWithConfig({ token: WETH, lookbackBlocks }, configuration);
      if (!result.evidence.some((record) => record.kind === "transfer")) {
        await writeFile(`${artifactPrefix}-${provider.label}-partial-dataset.json`, `${JSON.stringify(result, null, 2)}\n`);
        let code = "NO_VERIFIED_TRANSFERS_IN_SAMPLE";
        try { await createProviderTransport(configuration).rpc("eth_getLogs", [{ address: WETH, fromBlock: `0x${BigInt(result.range.from.number).toString(16)}`, toBlock: `0x${(BigInt(result.range.from.number) + BigInt(Math.min(lookbackBlocks, 10)) - 1n).toString(16)}`, topics: [TRANSFER_TOPIC] }]); }
        catch (error) { code = failureCode(error); }
        attempts.push({ source: provider.label, status: "failed", code });
        continue;
      }
      dataset = result; selected = provider;
      attempts.push({ source: provider.label, status: "collected" });
      break;
    } catch (error) { attempts.push({ source: provider.label, status: "failed", code: failureCode(error) }); }
  }
  if (!dataset || !selected) {
    const summary = { status: "failed", token: WETH, lookbackBlocks, attempts, note: "No successful live collection. No synthetic fallback or accuracy claim." };
    await writeFile(`${artifactPrefix}-verification.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.error(JSON.stringify(summary)); process.exitCode = 1; return;
  }
  const report = analyzeInvestigation(dataset, { id: randomUUID(), generatedAt: new Date().toISOString() });
  await writeFile(`${artifactPrefix}-dataset.json`, `${JSON.stringify(dataset, null, 2)}\n`);
  await writeFile(`${artifactPrefix}-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  const secondaryProvider = PUBLIC_PROVIDERS.find((provider) => new URL(provider.url).hostname !== new URL(selected.url).hostname)!;
  const crosscheck: { status: string; source: string; receiptsChecked: number; caveat: string; code?: string; rawReceipts?: unknown[] } = { status: "unavailable", source: secondaryProvider.label, receiptsChecked: 0, caveat: "Different public endpoints may share upstream infrastructure. This bounded agreement is not an accuracy benchmark or proof of source independence." };
  try {
    const configuration = readProviderConfiguration({ ...process.env, BASE_RPC_URL: secondaryProvider.url, BASE_RPC_FALLBACK_URLS: "", BASE_LOG_RPC_URL: "", BASE_FUNDING_SOURCE: "rpc", BLOCKSCOUT_API_KEY: "", BASE_PROVIDER_TIMEOUT_MS: "12000" });
    await validateProviderDestination(configuration);
    const reader = createProviderTransport(configuration, AbortSignal.timeout(60_000));
    assert.equal(BigInt(String(await reader.rpc("eth_chainId", []))), 8453n);
    const block = z.object({ number: hexSchema, hash: hashSchema }).parse(await reader.rpc("eth_getBlockByNumber", [`0x${BigInt(dataset.range.to.number).toString(16)}`, false]));
    assert.equal(block.hash.toLowerCase(), dataset.range.to.hash);
    assert.equal(BigInt(block.number).toString(), dataset.range.to.number);
    const sample = [...new Set(dataset.evidence.filter((record) => record.kind === "transfer").map((record) => record.transactionHash))].slice(0, 3);
    const rawReceipts: unknown[] = [];
    for (const transactionHash of sample) {
      const raw = await reader.rpc("eth_getTransactionReceipt", [transactionHash]);
      const receipt = crossReceiptSchema.parse(raw);
      assert.equal(receipt.transactionHash.toLowerCase(), transactionHash);
      const records: EvidenceRecord[] = dataset.evidence.filter((record) => record.transactionHash === transactionHash && record.kind === "transfer");
      for (const evidence of records) {
        assert.equal(receipt.blockHash.toLowerCase(), evidence.blockHash);
        assert.equal(BigInt(receipt.blockNumber).toString(), evidence.blockNumber);
        const log = receipt.logs.find((item) => Number(BigInt(item.logIndex)) === evidence.logIndex);
        assert.ok(log);
        assert.equal(log.address.toLowerCase(), evidence.assetAddress);
        assert.equal(log.topics[0].toLowerCase(), TRANSFER_TOPIC);
        assert.equal(`0x${log.topics[1].slice(-40)}`.toLowerCase(), evidence.from);
        assert.equal(`0x${log.topics[2].slice(-40)}`.toLowerCase(), evidence.to);
        assert.equal(BigInt(log.data).toString(), evidence.amountRaw);
      }
      rawReceipts.push(raw); crosscheck.receiptsChecked++;
    }
    crosscheck.status = "matched"; crosscheck.rawReceipts = rawReceipts;
  } catch (error) { crosscheck.code = failureCode(error); crosscheck.status = crosscheck.code === "EVIDENCE_DISAGREEMENT" ? "disagreed" : "unavailable"; }
  const verification = { status: crosscheck.status === "matched" ? "passed" : "partial", source: selected.label, savedDatasetReference, token: WETH, range: dataset.range, evidenceCount: dataset.evidence.length, verifiedSaleAnnotations: dataset.evidence.filter((record) => record.kind === "sale").length, transferCoverage: dataset.coverage.transfers, funding: "Keyless validation does not query the optional funding indexer.", attempts, crosscheck };
  await writeFile(`${artifactPrefix}-verification.json`, `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify({ ...verification, crosscheck: { ...crosscheck, rawReceipts: undefined }, artifactPrefix }));
  if (crosscheck.status !== "matched") process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  const failure = { status: "failed", code: failureCode(error), note: "No live verification success is claimed." };
  console.error(JSON.stringify(failure)); process.exitCode = 1;
});
