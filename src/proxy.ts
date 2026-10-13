import { NextRequest, NextResponse } from "next/server";
import { createContentSecurityPolicy } from "@/lib/security";
import { VISITOR_COOKIE_NAME, VISITOR_SESSION_SECONDS, visitorCookieForPage } from "@/lib/visitor-session";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const csp = createContentSecurityPolicy(nonce, development, request.nextUrl.protocol === "https:");
  const requestHeaders = new Headers(request.headers);
  // Always replace caller-controlled values; a visitor cannot supply the trusted nonce.
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // A response bearing a per-request nonce must not be shared across visitors.
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  const visitor = visitorCookieForPage(request, process.env.RATE_LIMIT_SECRET);
  if (visitor) response.cookies.set(VISITOR_COOKIE_NAME, visitor, {
    httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:",
    path: "/", maxAge: VISITOR_SESSION_SECONDS,
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/|(?:favicon\\.ico|icon\\.png|apple-icon\\.png|opengraph-image|manifest\\.webmanifest|robots\\.txt|sitemap\\.xml)$).*)"],
};
