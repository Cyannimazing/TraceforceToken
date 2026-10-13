import assert from "node:assert/strict";
import test from "node:test";
import { scanClientKey } from "../../src/lib/scan-client";

const secret = "private-test-rate-limit-secret-123456789";
const request = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

test("local clients share one opaque quota bucket regardless of supplied IP headers", () => {
  const env = { RATE_LIMIT_SECRET: secret };
  const key = scanClientKey(request({}), env);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(scanClientKey(request({ "x-real-ip": "8.8.8.8", "x-forwarded-for": "1.1.1.1" }), env), key);
  assert.notEqual(scanClientKey(request({}), { RATE_LIMIT_SECRET: `${secret}rotated` }), key);
});

test("Vercel client identities use valid platform IPs and canonicalize IPv6 spellings", () => {
  const env = { RATE_LIMIT_SECRET: secret, VERCEL: "1" };
  assert.notEqual(scanClientKey(request({ "x-forwarded-for": "8.8.8.8", "x-real-ip": "8.8.8.8" }), env), scanClientKey(request({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "1.1.1.1" }), env));
  assert.equal(scanClientKey(request({ "x-forwarded-for": "2001:4860::1", "x-real-ip": "2001:4860::1" }), env), scanClientKey(request({ "x-forwarded-for": "2001:4860:0:0:0:0:0:1", "x-real-ip": "2001:4860:0:0:0:0:0:1" }), env));
  assert.equal(scanClientKey(request({ "x-forwarded-for": "malformed", "x-real-ip": "malformed" }), env), scanClientKey(request({}), env));
});

test("public scan admission refuses missing or weak private configuration", () => {
  for (const RATE_LIMIT_SECRET of [undefined, "short", `${secret}\n`]) assert.throws(() => scanClientKey(request({}), { RATE_LIMIT_SECRET }));
});
