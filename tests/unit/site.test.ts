import assert from "node:assert/strict";
import test from "node:test";
import { absoluteUrl, getSiteConfig } from "../../src/config/site";
import { serializeStructuredData } from "../../src/lib/seo";
import { createContentSecurityPolicy } from "../../src/lib/security";
import robots from "../../src/app/robots";
import sitemap from "../../src/app/sitemap";

test("indexing requires deliberate public configuration and excludes previews", () => {
  assert.equal(getSiteConfig({}).indexable, false);
  const published = { SITE_URL: "https://traceforge.example", ALLOW_INDEXING: "true", NODE_ENV: "production" };
  assert.equal(getSiteConfig(published).indexable, true);
  assert.equal(getSiteConfig({ ...published, VERCEL_ENV: "preview" }).indexable, false);
  assert.equal(getSiteConfig({ ...published, VERCEL_ENV: "development" }).indexable, false);
  assert.equal(getSiteConfig({ ...published, NODE_ENV: "development" }).indexable, false);
  assert.equal(getSiteConfig({ ...published, NODE_ENV: "test" }).indexable, false);
  assert.equal(getSiteConfig({ ...published, NODE_ENV: undefined }).indexable, false);
  assert.equal(getSiteConfig({ ...published, VERCEL_ENV: "unknown" }).indexable, false);
  for (const env of [
    { ALLOW_INDEXING: "true" },
    { SITE_URL: "http://traceforge.example", ALLOW_INDEXING: "true" },
    { SITE_URL: "https://localhost", ALLOW_INDEXING: "true" },
    { ALLOW_INDEXING: "yes" },
  ]) assert.throws(() => getSiteConfig(env));
});

test("canonical origin validation rejects credentials and URL components", () => {
  for (const SITE_URL of ["invalid", "ftp://traceforge.example", "https://user:secret@traceforge.example", "https://traceforge.example/path", "https://traceforge.example?x=1", "https://traceforge.example#section"]) {
    assert.throws(() => getSiteConfig({ SITE_URL }));
  }
  assert.equal(getSiteConfig({ SITE_URL: "https://traceforge.example/" }).origin, "https://traceforge.example");
  assert.equal(getSiteConfig({ VERCEL_PROJECT_PRODUCTION_URL: "traceforge.example" }).indexable, false);
  assert.equal(absoluteUrl("/methodology", { SITE_URL: "https://traceforge.example" }), "https://traceforge.example/methodology");
  assert.throws(() => absoluteUrl("//external.example"));
  assert.throws(() => absoluteUrl("methodology"));
  assert.throws(() => absoluteUrl("/\\external.example/path"));
  assert.throws(() => absoluteUrl("/\t/external.example"));
});

test("a deliberately public production configuration exposes only the intended sitemap routes", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { SITE_URL: "https://traceforge.example", ALLOW_INDEXING: "true", NODE_ENV: "production", VERCEL_ENV: "production" });
    assert.deepEqual(sitemap().map((entry) => entry.url), ["https://traceforge.example/", "https://traceforge.example/methodology", "https://traceforge.example/data-sources"]);
    assert.equal(robots().sitemap, "https://traceforge.example/sitemap.xml");
    process.env.VERCEL_ENV = "preview";
    assert.deepEqual(sitemap(), []);
    assert.deepEqual(robots().rules, { userAgent: "*", disallow: "/" });
  } finally {
    for (const key of ["SITE_URL", "ALLOW_INDEXING", "NODE_ENV", "VERCEL_ENV"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("JSON-LD serialization cannot terminate its enclosing script", () => {
  const data = { name: '</script><script>alert("example")</script>', nested: { text: "< & >" } };
  const serialized = serializeStructuredData(data);
  assert.equal(serialized.includes("<"), false);
  assert.deepEqual(JSON.parse(serialized), data);
});

test("production CSP requires nonces and excludes development relaxations", () => {
  const nonce = Buffer.from("fixture-only-nonce-value").toString("base64");
  const policy = createContentSecurityPolicy(nonce);
  assert.ok(policy.includes(`'nonce-${nonce}'`));
  assert.ok(policy.includes("'strict-dynamic'"));
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(policy.includes("object-src 'none'"));
  assert.ok(policy.includes("upgrade-insecure-requests"));
  assert.equal(policy.includes("'unsafe-inline'"), false);
  assert.equal(policy.includes("'unsafe-eval'"), false);
  const developmentPolicy = createContentSecurityPolicy(nonce, true, false);
  assert.ok(developmentPolicy.includes("'unsafe-eval'"));
  assert.ok(developmentPolicy.includes("style-src 'self' 'unsafe-inline'"));
  assert.equal(developmentPolicy.includes("upgrade-insecure-requests"), false);
  assert.throws(() => createContentSecurityPolicy("' injected-directive"));
});
