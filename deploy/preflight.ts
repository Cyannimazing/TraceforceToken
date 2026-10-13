import { basename } from "node:path";
import { readScanEngineConfiguration } from "../src/config/scan-engine";
import { getSiteConfig } from "../src/config/site";
import { readDatabaseConfig } from "../src/db/config";
import { readInvestigatorAiConfiguration } from "../src/agents/config";
import { readProviderConfiguration } from "../src/providers/base/config";
import { normalizeTokenWebsite } from "../src/domain/investigations/token-web-presence";

export type DeploymentTarget = "vercel" | "engine";
type Environment = Record<string, string | undefined>;
interface DeploymentCheck { id: string; ok: boolean; message: string }
export interface DeploymentReview {
  target: DeploymentTarget;
  configurationReady: boolean;
  checks: DeploymentCheck[];
  unverified: string[];
}

const PRIVATE_DATABASE_ENV = ["DATABASE_URL", "DATABASE_MIGRATION_URL", "TEST_DATABASE_URL", "DATABASE_CA_CERT", "DATABASE_SSL", "DATABASE_POOL_SIZE"];
const PRIVATE_ADMIN_ENV = ["DATABASE_MIGRATION_URL", "TEST_DATABASE_URL", "CRON_SECRET"];
const ENGINE_ONLY_ENV = ["BASE_RPC_URL", "BASE_RPC_FALLBACK_URLS", "BASE_LOG_RPC_URL", "BASE_ALCHEMY_RPC_URL", "BASE_TRANSFER_SOURCE", "BASE_RPC_ALLOWED_HOSTS", "BASE_FUNDING_SOURCE", "BLOCKSCOUT_API_KEY", "GOPLUS_ACCESS_TOKEN", "LOCAL_AI_BASE_URL", "LOCAL_AI_MODEL", "LOCAL_AI_KEEP_ALIVE_SECONDS", "GEMINI_API_KEY", "GEMINI_MODEL"];
const PUBLIC_SECRET_ENV = ["NEXT_PUBLIC_DATABASE_URL", "NEXT_PUBLIC_DATABASE_MIGRATION_URL", "NEXT_PUBLIC_RATE_LIMIT_SECRET", "NEXT_PUBLIC_SCAN_ENGINE_SECRET", "NEXT_PUBLIC_BASE_RPC_URL", "NEXT_PUBLIC_BASE_RPC_FALLBACK_URLS", "NEXT_PUBLIC_BASE_LOG_RPC_URL", "NEXT_PUBLIC_BASE_ALCHEMY_RPC_URL", "NEXT_PUBLIC_BLOCKSCOUT_API_KEY", "NEXT_PUBLIC_GOPLUS_ACCESS_TOKEN", "NEXT_PUBLIC_GEMINI_API_KEY"];
const present = (environment: Environment, names: readonly string[]) => names.some((name) => Boolean(environment[name]?.trim()));
const secret = (value: string | undefined) => Boolean(value && value.length >= 32 && value.length <= 512
  && /^[\x21-\x7e]+$/.test(value) && !/(?:replace[_-]?me|your[_-]?(?:secret|password)|change[_-]?me)/i.test(value));
const publicHost = (host: string) => normalizeTokenWebsite(`https://${host}/`) !== null;

/** Offline checks only. Never return config objects, credential values or errors. */
export function reviewDeploymentEnvironment(
  environment: Environment, target: DeploymentTarget, nodeVersion = process.versions.node,
): DeploymentReview {
  const checks: DeploymentCheck[] = [];
  const check = (id: string, message: string, validate: () => boolean) => {
    let ok = false;
    try { ok = validate(); } catch { /* Reader errors never leave this boundary. */ }
    checks.push({ id, ok, message });
  };
  const production = { ...environment, NODE_ENV: "production" };
  check("node-runtime", "Use a patched Node.js 22 or 24 LTS release within the project's supported range; Node.js 23 is end-of-life.", () => {
    const major = Number(nodeVersion.split(".")[0]); return major === 22 || major === 24;
  });
  check("browser-secrets", "Infrastructure credentials must not appear in NEXT_PUBLIC variables.", () => !present(environment, PUBLIC_SECRET_ENV));
  if (target === "vercel") {
    const vercel = { ...production, VERCEL: "1" };
    check("site-origin", "Set an explicit public HTTPS SITE_URL and valid indexing settings for the intended deployment.", () => {
      if (!environment.SITE_URL?.trim()) return false;
      const site = getSiteConfig(vercel); return site.url.protocol === "https:" && publicHost(site.url.hostname) && !site.url.port;
    });
    check("remote-engine", "Configure a public HTTPS /scan engine endpoint and a private printable ASCII secret; local fallback is unavailable on Vercel.", () => {
      const engine = readScanEngineConfiguration(vercel);
      return engine.mode === "remote" && publicHost(new URL(engine.url).hostname) && secret(engine.secret);
    });
    check("quota-secret", "Configure a distinct private RATE_LIMIT_SECRET of 32–512 printable non-space ASCII characters.", () => secret(environment.RATE_LIMIT_SECRET)
      && environment.RATE_LIMIT_SECRET !== environment.SCAN_ENGINE_SECRET);
    check("quota-database", "Configure a non-admin remote quota account with a private password, public DNS hostname and certificate/hostname-verified TLS.", () => {
      const database = readDatabaseConfig(vercel);
      const tls = database.ssl;
      return typeof database.host === "string" && publicHost(database.host)
        && Boolean(database.password) && !/(?:replace[_-]?me|percent_encoded_password)/i.test(String(database.password))
        && typeof database.user === "string" && !/(?:^root$|migrat|admin)/i.test(database.user)
        && typeof tls === "object" && tls.rejectUnauthorized === true && tls.verifyIdentity === true;
    });
    check("quota-pool", "For the prepared cohost budget, explicitly set DATABASE_POOL_SIZE to 1 or 2 per independently scaled Vercel instance.", () => {
      const size = Number(environment.DATABASE_POOL_SIZE); return Boolean(environment.DATABASE_POOL_SIZE?.trim()) && Number.isInteger(size) && size >= 1 && size <= 2;
    });
    check("credential-separation", "Vercel must receive no migration/test credentials, retired cron secret, provider credentials or local inference configuration.", () => !present(environment, [...PRIVATE_ADMIN_ENV, ...ENGINE_ONLY_ENV]));
  } else {
    check("engine-secret", "Set a private SCAN_ENGINE_SECRET of 32–512 printable non-space ASCII characters, identical to the proxy's engine secret.", () => secret(environment.SCAN_ENGINE_SECRET));
    check("engine-port", "Use an unprivileged engine port (the reviewed loopback/reverse-proxy layout uses 8787).", () => {
      const port = Number(environment.SCAN_ENGINE_PORT ?? 8787); return Number.isInteger(port) && port >= 1024 && port <= 65535;
    });
    check("provider", "Configure an approved production HTTPS Base provider within the prepared 120-second acquisition budget.", () => readProviderConfiguration(production).scanTimeoutMs <= 120_000);
    check("production-indexer-plan", "SQD public testing funding is local development only; configure an approved production funding plan before deploying the engine.", () => readProviderConfiguration(production).fundingSource !== "sqd-public-testing");
    check("cpu-model", "Configure an approved bounded AI provider; local inference retains the prepared private CPU layout.", () => {
      const providers = readInvestigatorAiConfiguration(production);
      if (providers.gemini && (providers.gemini.maxContextBytes > 8000 || providers.gemini.maxEvidenceRecords > 12 || providers.gemini.maxOutputTokens > 800 || providers.gemini.contextTokens > 4096)) return false;
      const ai = providers.local;
      if (!ai) return Boolean(providers.gemini);
      return ai.baseUrl === "http://127.0.0.1:11434" && ai.model === "traceforce-investigator"
        && ai.threads === 2 && ai.gpuLayers === 0 && ai.contextTokens <= 4096
        && ai.maxEvidenceRecords <= 12 && ai.maxOutputTokens <= 800 && ai.maxContextBytes <= 8000;
    });
    check("credential-separation", "The stateless engine must receive no database, migration/test, quota or retired cron credentials.", () => !present(environment, [...PRIVATE_DATABASE_ENV, ...PRIVATE_ADMIN_ENV, "RATE_LIMIT_SECRET"]));
  }
  return {
    target, configurationReady: checks.every((item) => item.ok), checks,
    unverified: target === "vercel" ? [
      "Account/project linking, environment scope, region, Fluid compute and actual route duration.",
      "Engine DNS/TLS/authentication and incremental streaming through Vercel and the reverse proxy.",
      "Database DNS/TLS certificate identity, exact quota-only grants, schema, fixed egress/firewall rules and total scaled connections.",
    ] : [
      "Linux/systemd/cgroup support, effective resource overrides, executable paths, permissions and private listeners.",
      "Actual named model weights/profile, cloud-off Ollama settings and provider DNS/reachability.",
      "Real KVM CPU/RSS/latency, cancellation, stream/log hygiene, capacity and reverse-proxy TLS.",
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Offline deployment configuration review. Use: node --import tsx deploy/preflight.ts --target vercel|engine. Load only the intended private environment explicitly with Node --env-file before the script. Prints static checks only; never connects, deploys, migrates, loads .env.local automatically or validates live host readiness.");
    return;
  }
  if (args.length !== 2 || args[0] !== "--target" || !["vercel", "engine"].includes(args[1])) {
    console.error("Use deploy/preflight.ts --target vercel|engine (or --help)."); process.exitCode = 2; return;
  }
  const result = reviewDeploymentEnvironment(process.env, args[1] as DeploymentTarget);
  console.log(JSON.stringify(result, null, 2));
  if (!result.configurationReady) process.exitCode = 1;
}

if (basename(process.argv[1] ?? "") === "preflight.ts") main();
