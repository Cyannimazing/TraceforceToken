import assert from "node:assert/strict";
import test from "node:test";
import { sameOrigin } from "../../src/lib/request-origin";

const request = (headers: Record<string, string>, url = "https://traceforge.example/api/investigations") => new Request(url, { headers });

test("browser writes require an exact origin and reject cross-site or same-site fetch context", () => {
  assert.equal(sameOrigin(request({ origin: "https://traceforge.example", "sec-fetch-site": "same-origin" })), true);
  for (const origin of ["https://attacker.example", "https://traceforge.example:8443", "http://traceforge.example", "null", "https://traceforge.example/path", "https://traceforge.example/", "https://traceforge.example https://attacker.example"]) {
    assert.equal(sameOrigin(request({ origin })), false, origin);
  }
  assert.equal(sameOrigin(request({})), false);
  for (const site of ["same-site", "cross-site"]) assert.equal(sameOrigin(request({ origin: "https://traceforge.example", "sec-fetch-site": site })), false);
});

test("received Host authority survives NextURL loopback normalization without aliasing origins", () => {
  const url = "http://localhost:3200/api/investigations";
  assert.equal(sameOrigin(request({ host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200", "sec-fetch-site": "same-origin" }, url)), true);
  assert.equal(sameOrigin(request({ host: "127.0.0.1:3200", origin: "http://localhost:3200" }, url)), false);
  assert.equal(sameOrigin(request({ host: "localhost:3200", origin: "http://127.0.0.1:3200" }, url)), false);
  assert.equal(sameOrigin(request({ host: "127.0.0.1:3201", origin: "http://127.0.0.1:3200" }, url)), false);
  assert.equal(sameOrigin(request({ host: "127.0.0.1:3200", origin: "https://127.0.0.1:3200" }, url)), false);
});

test("Host validation rejects malformed authorities instead of falling back to the URL", () => {
  const malformed = ["", "attacker.example/path", "attacker.example?x=1", "attacker.example#x", "user@traceforge.example", "traceforge.example,attacker.example", "traceforge.example:443:80", "traceforge.example:65536", "traceforge.example:0443", "traceforge..example", "-traceforge.example", "traceforge-.example", "a".repeat(64) + ".example", "traceforge .example", "traceforge%2eexample", "traceforge.example\\attacker", "[::1", "[:::1]", "127.1", "127.000.0.1"];
  for (const host of malformed) assert.equal(sameOrigin(request({ host, origin: "https://traceforge.example" })), false, host);
  assert.equal(sameOrigin(request({ host: "127.1:3200", origin: "http://127.0.0.1:3200" }, "http://localhost:3200/api/investigations")), false);
});

test("forwarded host and protocol never override the received authority or request scheme", () => {
  assert.equal(sameOrigin(request({ host: "traceforge.example", origin: "https://attacker.example", "x-forwarded-host": "attacker.example" })), false);
  assert.equal(sameOrigin(request({ host: "traceforge.example", origin: "https://traceforge.example", "x-forwarded-host": "attacker.example,traceforge.example" })), true);
  assert.equal(sameOrigin(request({ host: "traceforge.example", origin: "http://traceforge.example", "x-forwarded-proto": "http" })), false);
  assert.equal(sameOrigin(request({ origin: "https://attacker.example", "x-forwarded-host": "attacker.example" })), false);
});

test("valid DNS, IPv4, IPv6 and default ports use their exact serialized origin", () => {
  assert.equal(sameOrigin(request({ host: "TRACEFORGE.example:443", origin: "https://traceforge.example" })), true);
  assert.equal(sameOrigin(request({ host: "traceforge.example:8443", origin: "https://traceforge.example:8443" })), true);
  assert.equal(sameOrigin(request({ host: "[::1]:3200", origin: "http://[::1]:3200" }, "http://localhost:3200/api/investigations")), true);
  assert.equal(sameOrigin(request({ host: "[::1]:3200", origin: "http://localhost:3200" }, "http://localhost:3200/api/investigations")), false);
});

test("native Request tests fall back to URL authority only when Host is absent", () => {
  assert.equal(sameOrigin(request({ origin: "https://traceforge.example" })), true);
  assert.equal(sameOrigin(request({ host: "other.example", origin: "https://traceforge.example" })), false);
  assert.equal(sameOrigin(request({ origin: "ftp://traceforge.example" }, "ftp://traceforge.example/api/investigations")), false);
});
