import { expect, test, type BrowserContext } from "@playwright/test";

const origin = "http://127.0.0.1:3200";
const visitorCookieName = "traceforce_visitor";
const sessionError = { error: "Refresh this page to start a secure visitor session." };

async function visitorCookie(context: BrowserContext) {
  const cookie = (await context.cookies(origin)).find((item) => item.name === visitorCookieName);
  expect(cookie, "a page navigation establishes the anonymous visitor session").toBeDefined();
  return cookie!;
}

test("real loopback browser POST reaches public validation with its visitor session and no intercepted API", async ({ page }) => {
  await page.goto("/investigate");
  await expect(page.getByLabel("Base token contract")).toBeVisible();
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/investigations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invalid-token", lookbackBlocks: 1000 }),
    });
    return { status: response.status, body: await response.json(), origin: location.origin };
  });
  expect(result.origin).toBe(origin);
  // Input validation runs after database-backed visitor admission and before
  // scan acquisition. A normalized-URL mismatch would incorrectly return 403
  // here instead of the expected validation error.
  expect(result.status).toBe(400);
  expect(result.body).toHaveProperty("error");
  expect(result.body.error).not.toMatch(/same-origin|access|sign.in|session/i);
});

test("anonymous visitor cookies are HttpOnly, stable across tabs and distinct across browser contexts", async ({ page, context, browser }) => {
  const other = await browser.newContext();
  try {
    await page.goto("/investigate");
    const first = await visitorCookie(context);
    expect(first.httpOnly).toBe(true);
    expect(first.sameSite).toBe("Strict");
    expect(first.path).toBe("/");
    expect(first.domain).toBe("127.0.0.1");
    expect(first.secure).toBe(false); // HTTPS deployments set Secure; this origin is loopback HTTP.
    expect(first.expires).toBeGreaterThan(Date.now() / 1000 + 23 * 60 * 60);
    expect(await page.evaluate((name) => document.cookie.includes(`${name}=`), visitorCookieName)).toBe(false);
    await page.reload();
    expect((await visitorCookie(context)).value === first.value).toBe(true);
    const sameVisitorTab = await context.newPage();
    await sameVisitorTab.goto(`${origin}/investigate`);
    expect((await visitorCookie(context)).value === first.value).toBe(true);
    const otherPage = await other.newPage();
    await otherPage.goto(`${origin}/investigate`);
    expect((await visitorCookie(other)).value === first.value).toBe(false);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  } finally { await other.close(); }
});

test("public APIs reject missing or tampered visitor cookies without starting work or issuing an API cookie", async ({ request, page, context }) => {
  const bodies = [
    { path: "/api/investigations", data: { token: "0x4200000000000000000000000000000000000006", scope: "full" } },
    { path: "/api/questions", data: { question: "Who funded the examined wallets?", context: "synthetic-invalid-context" } },
  ];
  for (const body of bodies) {
    const response = await request.post(body.path, { headers: { origin }, data: body.data });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual(sessionError);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  }
  await page.goto("/investigate");
  const cookie = await visitorCookie(context);
  // Change a payload character rather than replacing the entire token: the
  // server must authenticate the cookie, not merely recognize its shape.
  const parts = cookie.value.split(".");
  const signature = parts.at(-1)!;
  parts[parts.length - 1] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  for (const body of bodies) {
    const response = await request.post(body.path, { headers: { origin, cookie: `${visitorCookieName}=${parts.join(".")}` }, data: body.data });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual(sessionError);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  }
});

test("one visitor has a shared 30-request burst across scan and questions while another visitor remains independent", async ({ page, context, browser }) => {
  const other = await browser.newContext();
  try {
    await page.goto("/investigate");
    // Invalid bodies never enter provider acquisition or model inference. They
    // do exercise real anonymous admission, including its shared route budget.
    for (let index = 0; index < 30; index++) {
      const path = index % 2 === 0 ? "/api/investigations" : "/api/questions";
      const response = await context.request.post(`${origin}${path}`, { headers: { origin }, data: {} });
      expect(response.status(), `request ${index + 1} must pass burst admission`).toBe(400);
      expect((await response.json()).error).not.toMatch(/hourly|free.*limit/i);
    }
    const limited = await context.request.post(`${origin}/api/investigations`, { headers: { origin }, data: {} });
    expect(limited.status()).toBe(429);
    expect(Number(limited.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers()["retry-after"])).toBeLessThanOrEqual(30);
    expect((await limited.json()).error).not.toMatch(/hourly|free.*limit/i);
    const otherPage = await other.newPage();
    await otherPage.goto(`${origin}/investigate`);
    const independent = await other.request.post(`${origin}/api/questions`, { headers: { origin }, data: {} });
    expect(independent.status()).toBe(400);
  } finally { await other.close(); }
});

test("real public POST rejects cross-origin and forged forwarding authority even with a valid visitor cookie", async ({ page, context }) => {
  await page.goto("/investigate");
  await visitorCookie(context);
  const attempts: Record<string, string>[] = [
    { origin: "http://localhost:3200" },
    { origin: "https://attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" },
    { origin: "http://127.0.0.1:3200", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of attempts) {
    const response = await context.request.post(`${origin}/api/investigations`, { headers, data: { token: "invalid-token", lookbackBlocks: 1000 } });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "A same-origin request is required." });
  }
});

test("visitor-bound validation rejects malformed JSON, media types and oversized bodies before execution", async ({ page, context }) => {
  await page.goto("/investigate");
  const malformed = await context.request.post(`${origin}/api/investigations`, { headers: { origin, "content-type": "application/json" }, data: "{" });
  expect(malformed.status()).toBe(400);
  const mediaType = await context.request.post(`${origin}/api/investigations`, { headers: { origin, "content-type": "text/plain" }, data: "{}" });
  expect(mediaType.status()).toBe(415);
  const oversized = await context.request.post(`${origin}/api/investigations`, { headers: { origin }, data: { token: "x".repeat(3000) } });
  expect(oversized.status()).toBe(413);
});
