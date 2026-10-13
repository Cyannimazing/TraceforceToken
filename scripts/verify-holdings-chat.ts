import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createChatContext } from "../src/agents/chat-context";
import { readLocalAiConfiguration } from "../src/agents/config";
import { questionAnswerSchema, type InvestigationChatMessage } from "../src/domain/investigations/questions";
import { deriveHolderTableDistribution } from "../src/domain/investigations/holder-table-distribution";
import { loadDatabaseEnvironment } from "./database/environment";
import { getBrowserWalletFlagsFixture } from "../tests/fixtures/report";
import { chatClaimsRemainQualified, contractSupplyShareMatches, lockUncertainty } from "./verification/chat-semantics";

let verificationPhase = "setup";
let receivedHttpStatus: number | null = null;
let receivedError: string | null = null;
let receivedSemanticChecks: Record<string, boolean> | null = null;

/** Operator-only, synthetic report over the actual local HTTP/model path.
 * Only aggregate verification metadata is written; no capsule or dialogue is saved. */
async function main() {
  loadDatabaseEnvironment();
  const originArgument = process.argv.find((argument) => argument.startsWith("--origin="))?.slice("--origin=".length);
  assert.ok(originArgument && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(originArgument), "Supply an owned loopback test server with --origin=http://127.0.0.1:PORT.");
  const origin = new URL(originArgument).origin;
  const secret = process.env.RATE_LIMIT_SECRET;
  assert.ok(secret && secret.length >= 32, "A private context signing secret must be configured locally.");
  const config = readLocalAiConfiguration();
  const report = getBrowserWalletFlagsFixture({ contractDominated: true });
  report.token.marketSnapshot = { source: "dexscreener", status: "reported", checkedAt: report.generatedAt,
    sourceUrl: `https://api.dexscreener.com/token-pairs/v1/base/${report.token.address}`, pairAddress: report.infrastructure!.pools[0],
    priceUsd: "0.25", liquidityUsd: 0.01, marketCapUsd: 100, volume24hUsd: 25, priceChange24hPercent: -99, pairCreatedAt: null };
  const capsule = createChatContext(report, config, secret);
  const expectedContractShare = deriveHolderTableDistribution(report).contractSupplySharePercent;
  const page = await fetch(`${origin}/investigate`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert.equal(page.status, 200);
  const cookie = page.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  assert.ok(cookie, "The local page must initialize a signed visitor session.");
  await page.body?.cancel();
  const history: InvestigationChatMessage[] = [];
  const turns = [
    { purpose: "contract-holding-definition", question: "what is contract holding?", checks: {
      definesTokenBalance: (text: string) => /\bcontract\b/i.test(text) && /\b(?:tokens?|balances?|holdings?)\b/i.test(text),
      distinguishesAccountCode: (text: string) => /\b(?:code|program|software)\b|smart contract/i.test(text),
    } },
    { purpose: "contract-excluded-from-wallet-table", question: "why is that contract not in Top holders?", checks: {
      explainsSeparateContractRows: (text: string) => /\b(?:separate(?:ly)?|excluded?|omitted|different section)\b/i.test(text) && /\bcontract\b/i.test(text),
      identifiesWalletSubset: (text: string) => /\bEOAs?\b|externally[- ]owned|(?:ordinary|regular|non[- ]contract) wallets?|wallets?.{0,30}(?:without|no) (?:deployed )?code/i.test(text),
      retainsContractRisk: (text: string) => /\brisk\b/i.test(text) && /\b(?:still|included|count(?:s|ed)?|remain(?:s)?)\b/i.test(text),
    } },
    { purpose: "lock-status-remains-unknown", question: "Is it locked?", checks: {
      // The question already supplies "locked"; a valid short follow-up may
      // refer to "it" or "that status" without repeating the noun.
      preservesUnknownLockStatus: (text: string) => { const flags = lockUncertainty(text); return flags.explicitUncertainty || flags.needsAdditionalEvidence; },
    } },
    { purpose: "deterministic-verdict-explanation", question: "Why AVOID? Explain the dump and liquidity warnings.", checks: {
      explainsAvoidWarning: (text: string) => /\bAVOID\b/i.test(text) && /\b(?:dump|sale|selling|warning)\b/i.test(text),
      qualifiesSaleModel: (text: string) => /\b(?:modeled|modelled|model|hypothetical|simulation|simulated)\b|\bif\b.{0,60}\b(?:sold|sell|dumped)\b/i.test(text),
      qualifiesLiquiditySource: (text: string) => /\bliquidity\b/i.test(text) && /DEX\s?Screener|source[- ]reported|third[- ]party|reported/i.test(text),
    } },
  ];
  const checks: { purpose: string; httpStatus: number; model: string | null; durationMs: number; evidenceCitations: number; semanticChecks: Record<string, boolean>; relevantAnswer: boolean }[] = [];
  for (const turn of turns) {
    verificationPhase = turn.purpose;
    receivedSemanticChecks = null;
    const started = performance.now();
    const response = await fetch(`${origin}/api/questions`, { method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(145_000),
      headers: { "content-type": "application/json", accept: "application/json", origin, cookie }, body: JSON.stringify({ question: turn.question, context: capsule, history }) });
    receivedHttpStatus = response.status;
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: unknown } | null;
      // API errors are fixed public status messages, never the generated answer.
      if (typeof failure?.error === "string" && failure.error.length <= 200) receivedError = failure.error;
    }
    assert.equal(response.status, 200, `The ${turn.purpose} turn must return a verified AI response.`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const answer = questionAnswerSchema.parse(await response.json());
    const prose = `${answer.answer} ${answer.caveat}`;
    const semanticChecks: Record<string, boolean> = { ...Object.fromEntries(Object.entries(turn.checks).map(([name, check]) => [name, check(prose)])),
      ...(turn.purpose === "lock-status-remains-unknown" ? { additionalEvidenceRequired: answer.needsFreshScan } : {}),
      ...chatClaimsRemainQualified(answer.answer, answer.caveat),
      contractSupplyShareMatches: contractSupplyShareMatches(prose, expectedContractShare),
      noInventedTransactionCitations: answer.evidenceIds.length === 0,
      configuredLocalModel: answer.model === config.model,
      readableReportTerms: !/\b(?:walletTable|sourceContext|rawStats)\b/.test(prose),
    };
    receivedSemanticChecks = semanticChecks;
    const relevantAnswer = Object.values(semanticChecks).every(Boolean);
    checks.push({ purpose: turn.purpose, httpStatus: response.status, model: answer.model ?? null, durationMs: Math.round(performance.now() - started), evidenceCitations: answer.evidenceIds.length, semanticChecks, relevantAnswer });
    // Finish every HTTP-verified turn before judging operator wording checks.
    // Generated answers remain in this process only; all output is metadata.
    process.stdout.write(`${JSON.stringify({ turn: turn.purpose, passed: relevantAnswer, durationMs: checks.at(-1)!.durationMs, semanticChecks, conversationNotSaved: true })}\n`);
    history.push({ role: "user", content: turn.question }, { role: "assistant", content: answer.answer });
  }
  const metadata = { verifiedAt: new Date().toISOString(), input: "synthetic-contract-dominated-report", execution: "actual-local-question-HTTP-and-configured-Ollama", providerAcquisitions: 0,
    signedContextNotSaved: true, reportNotSaved: true, conversationNotSaved: true, screenshotsSaved: 0, passed: checks.every((check) => check.relevantAnswer), checks,
    scope: "Four narrow concept/exclusion/lock/verdict questions with explicit lexical semantic checks; not proof of broad AI correctness." };
  await mkdir(".artifacts", { recursive: true });
  await writeFile(".artifacts/synthetic-holdings-chat-http.json", `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
  if (!metadata.passed) process.exitCode = 1;
}

main().catch(() => { process.stderr.write(`${JSON.stringify({ verification: "synthetic-holdings-chat", failedPhase: verificationPhase, httpStatus: receivedHttpStatus, publicError: receivedError, semanticChecks: receivedSemanticChecks, reportNotSaved: true, conversationNotSaved: true })}\n`); process.exitCode = 1; });
