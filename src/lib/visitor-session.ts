import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const VISITOR_COOKIE_NAME = "traceforce_visitor";
export const VISITOR_SESSION_SECONDS = 86_400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class InvalidVisitorSessionError extends Error {
  constructor() { super("Refresh this page to start a secure visitor session."); this.name = "InvalidVisitorSessionError"; }
}

function signingSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32 || secret.length > 512 || /[\s\x00-\x1f\x7f]/.test(secret)) throw new Error("Configure a private visitor signing secret.");
  return secret;
}

function signature(value: string, secret: string): Buffer {
  return createHmac("sha256", secret).update("traceforce:visitor:v1:").update(value).digest();
}

/** Browser security identity only; it grants no report access or wallet identity. */
export function createVisitorSession(secret: string | undefined, now = Date.now()): string {
  const value = `v1.${randomUUID()}.${Math.floor(now / 1000) + VISITOR_SESSION_SECONDS}`;
  return `${value}.${signature(value, signingSecret(secret)).toString("base64url")}`;
}

export function visitorClientKey(request: Pick<Request, "headers">, secret: string | undefined, now = Date.now()): string {
  const key = signingSecret(secret);
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 8192) throw new InvalidVisitorSessionError();
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${VISITOR_COOKIE_NAME}=`));
  if (matches.length !== 1) throw new InvalidVisitorSessionError();
  const value = matches[0].slice(VISITOR_COOKIE_NAME.length + 1);
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !UUID.test(parts[1]) || !/^[0-9]{1,12}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) throw new InvalidVisitorSessionError();
  const expiry = Number(parts[2]), seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= seconds || expiry > seconds + VISITOR_SESSION_SECONDS) throw new InvalidVisitorSessionError();
  const expected = signature(parts.slice(0, 3).join("."), key), supplied = Buffer.from(parts[3], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || supplied.toString("base64url") !== parts[3]) throw new InvalidVisitorSessionError();
  return createHmac("sha256", key).update("traceforce:visitor-counter:v1:").update(parts[1]).digest("hex");
}

/** API requests never mint identities, so omitting a cookie cannot renew a bucket. */
export function visitorCookieForPage(request: Pick<Request, "headers" | "method" | "url">, secret: string | undefined): string | null {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET" || path.startsWith("/api/") || path === "/api" || request.headers.get("rsc") === "1") return null;
  try { visitorClientKey(request, secret); return null; }
  catch (error) {
    if (!(error instanceof InvalidVisitorSessionError)) return null;
    return createVisitorSession(secret);
  }
}
