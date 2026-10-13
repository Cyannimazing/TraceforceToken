import assert from "node:assert/strict";
import test from "node:test";
import { createVisitorSession, InvalidVisitorSessionError, visitorClientKey, visitorCookieForPage, VISITOR_COOKIE_NAME, VISITOR_SESSION_SECONDS } from "../../src/lib/visitor-session";

const secret = "test-visitor-secret-".repeat(3), now = 1_791_800_000_000;
const request = (value?: string) => new Request("http://localhost:3000/investigate", { headers: value ? { cookie: `${VISITOR_COOKIE_NAME}=${value}` } : {} });

test("independent browsers have independent opaque identities; tabs retain the signed identity", () => {
  const first = createVisitorSession(secret, now), second = createVisitorSession(secret, now);
  const key = visitorClientKey(request(first), secret, now);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, visitorClientKey(request(second), secret, now));
  const forwarded = request(first); forwarded.headers.set("x-forwarded-for", "1.1.1.1");
  assert.equal(key, visitorClientKey(forwarded, secret, now));
  assert.equal(key, visitorClientKey(request(first), secret, now + 1000));
});

test("missing, tampered, duplicate, expired and rotated-secret cookies cannot mint an API identity", () => {
  const value = createVisitorSession(secret, now);
  const invalid = [request(), request(value.replace("v1.", "v2.")), request(value.slice(0, -2) + "zz"), new Request("http://localhost:3000", { headers: { cookie: `${VISITOR_COOKIE_NAME}=${value}; ${VISITOR_COOKIE_NAME}=${value}` } })];
  for (const item of invalid) assert.throws(() => visitorClientKey(item, secret, now), InvalidVisitorSessionError);
  assert.throws(() => visitorClientKey(request(value), secret, now + VISITOR_SESSION_SECONDS * 1000), InvalidVisitorSessionError);
  assert.throws(() => visitorClientKey(request(value), secret + "rotated", now), InvalidVisitorSessionError);
  assert.throws(() => visitorClientKey(request(value), secret, now - 1000), InvalidVisitorSessionError);
});

test("only page GETs initialize sessions; APIs and RSC navigation cannot rotate a bucket", () => {
  const page = new Request("http://localhost:3000/investigate");
  const value = visitorCookieForPage(page, secret);
  assert.ok(value);
  assert.equal(visitorCookieForPage(request(value), secret), null);
  for (const item of [new Request("http://localhost:3000/api/investigations", { method: "POST" }), new Request("http://localhost:3000/api/health"), new Request(page, { headers: { rsc: "1" } })]) assert.equal(visitorCookieForPage(item, secret), null);
  assert.equal(visitorCookieForPage(page, undefined), null);
  assert.throws(() => createVisitorSession("weak", now));
});
