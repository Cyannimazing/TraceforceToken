import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewDeploymentEnvironment } from "./preflight";

const vercel = {
  SITE_URL: "https://scan.traceforce.org", ALLOW_INDEXING: "false",
  SCAN_ENGINE_URL: "https://engine.traceforce.org/scan", SCAN_ENGINE_SECRET: "synthetic-engine-secret-private-123456789",
  RATE_LIMIT_SECRET: "synthetic-quota-secret-private-987654321",
  DATABASE_URL: "mysql://traceforce_web:synthetic-db-password@database.traceforce.org/traceforce", DATABASE_SSL: "true", DATABASE_POOL_SIZE: "2",
};
const engine = {
  SCAN_ENGINE_SECRET: vercel.SCAN_ENGINE_SECRET, BASE_RPC_URL: "https://mainnet.base.org", LOCAL_AI_MODEL: "traceforce-investigator",
};
const failed = (value: Record<string, string | undefined>, target: "vercel" | "engine") => reviewDeploymentEnvironment(value, target).checks.filter((check) => !check.ok).map((check) => check.id);

test("offline preflight distinguishes configuration readiness from unverified hosting", () => {
  for (const [target, value] of [["vercel", vercel], ["engine", engine]] as const) {
    const result = reviewDeploymentEnvironment(value, target);
    assert.equal(result.configurationReady, true);
    assert.ok(result.unverified.length > 0);
  }
});

test("local development values cannot accidentally pass as a Vercel deployment", () => {
  const development = { SITE_URL: "http://localhost:3000", DATABASE_URL: "mysql://traceforge_local:synthetic@127.0.0.1/traceforge_local", DATABASE_SSL: "false", DATABASE_MIGRATION_URL: "mysql://root:synthetic@localhost/traceforge_local", BASE_RPC_URL: engine.BASE_RPC_URL, LOCAL_AI_MODEL: engine.LOCAL_AI_MODEL };
  const errors = failed(development, "vercel");
  for (const expected of ["site-origin", "remote-engine", "quota-secret", "quota-database", "credential-separation"]) assert.ok(errors.includes(expected));
});

test("Vercel preflight rejects plaintext remote DB, admin credentials, excess pools and reserved engine hosts", () => {
  for (const [change, id] of [
    [{ DATABASE_SSL: "false" }, "quota-database"],
    [{ DATABASE_URL: "mysql://root:synthetic@database.traceforce.org/traceforce" }, "quota-database"],
    [{ DATABASE_POOL_SIZE: "5" }, "quota-pool"],
    [{ SCAN_ENGINE_URL: "https://engine.example.invalid/scan" }, "remote-engine"],
    [{ SITE_URL: "https://localhost/" }, "site-origin"],
  ] as const) assert.ok(failed({ ...vercel, ...change }, "vercel").includes(id));
});

test("credentials remain separated and no secret or input URL is included in any review output", () => {
  const sentinel = "secret-sentinel-that-must-never-appear-123";
  const value = { ...vercel, DATABASE_MIGRATION_URL: sentinel, NEXT_PUBLIC_SCAN_ENGINE_SECRET: sentinel, BASE_RPC_URL: `https://mainnet.base.org/?key=${sentinel}` };
  const result = reviewDeploymentEnvironment(value, "vercel");
  assert.ok(failed(value, "vercel").includes("browser-secrets"));
  assert.ok(failed(value, "vercel").includes("credential-separation"));
  const output = JSON.stringify(result);
  assert.ok(!output.includes(sentinel)); assert.ok(!output.includes(vercel.DATABASE_URL)); assert.ok(!output.includes(vercel.SCAN_ENGINE_SECRET));
  assert.ok(failed({ ...engine, DATABASE_URL: vercel.DATABASE_URL }, "engine").includes("credential-separation"));
});

test("engine preflight rejects remote inference, oversized CPU context and published-secret placeholders", () => {
  for (const [change, id] of [
    [{ LOCAL_AI_BASE_URL: "https://model.traceforce.org" }, "cpu-model"],
    [{ LOCAL_AI_CONTEXT_TOKENS: "8192" }, "cpu-model"],
    [{ LOCAL_AI_GPU_LAYERS: "1" }, "cpu-model"],
    [{ SCAN_ENGINE_PORT: "443" }, "engine-port"],
    [{ SCAN_ENGINE_SECRET: "replace_me_with_a_private_secret_123456789" }, "engine-secret"],
    [{ BASE_PROVIDER_SCAN_TIMEOUT_MS: "300000" }, "provider"],
  ] as const) assert.ok(failed({ ...engine, ...change }, "engine").includes(id));
});

test("GoPlus operator tokens stay on the engine and never enter public configuration or review output", () => {
  const token = "synthetic-private-goplus-token-123456789";
  assert.ok(failed({ ...vercel, GOPLUS_ACCESS_TOKEN: token }, "vercel").includes("credential-separation"));
  for (const target of ["vercel", "engine"] as const) {
    const value = { ...(target === "vercel" ? vercel : engine), NEXT_PUBLIC_GOPLUS_ACCESS_TOKEN: token };
    assert.ok(failed(value, target).includes("browser-secrets"));
    assert.ok(!JSON.stringify(reviewDeploymentEnvironment(value, target)).includes(token));
  }
  assert.equal(reviewDeploymentEnvironment({ ...engine, GOPLUS_ACCESS_TOKEN: token }, "engine").configurationReady, true);
});

test("public testing funding cannot pass a production engine review or leak into Vercel configuration", () => {
  assert.ok(failed({ ...engine, BASE_FUNDING_SOURCE: "sqd-public-testing" }, "engine").includes("production-indexer-plan"));
  assert.ok(failed({ ...vercel, BASE_FUNDING_SOURCE: "rpc" }, "vercel").includes("credential-separation"));
  assert.equal(reviewDeploymentEnvironment({ ...engine, BASE_FUNDING_SOURCE: "rpc" }, "engine").configurationReady, true);
});

test("the optional log lane is engine-only and never browser public configuration", () => {
  const endpoint = "https://base-rpc.publicnode.com";
  assert.ok(failed({ ...vercel, BASE_LOG_RPC_URL: endpoint }, "vercel").includes("credential-separation"));
  assert.ok(failed({ ...vercel, NEXT_PUBLIC_BASE_LOG_RPC_URL: endpoint }, "vercel").includes("browser-secrets"));
  assert.equal(reviewDeploymentEnvironment({ ...engine, BASE_LOG_RPC_URL: endpoint }, "engine").configurationReady, true);
  assert.ok(failed({ ...engine, BASE_LOG_RPC_URL: "http://127.0.0.1:8545" }, "engine").includes("provider"));
});

test("preflight uses production validation even when called from a test or local process", () => {
  assert.ok(failed({ ...engine, NODE_ENV: "test", BASE_RPC_URL: "http://127.0.0.1:9999" }, "engine").includes("provider"));
  assert.ok(failed({ ...vercel, NODE_ENV: "test", VERCEL: "0", SCAN_ENGINE_URL: "http://127.0.0.1:8787/scan" }, "vercel").includes("remote-engine"));
  for (const version of ["20.0.0", "23.0.0", "25.0.0", "26.0.0"]) {
    assert.equal(reviewDeploymentEnvironment(vercel, "vercel", version).checks.find((check) => check.id === "node-runtime")!.ok, false);
  }
});
