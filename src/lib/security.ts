/** Strict scripts in production; development-only relaxations support Next.js HMR. */
export function createContentSecurityPolicy(nonce: string, development = false, https = true) {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(nonce)) {
    throw new Error("The CSP nonce must be a generated base64 value.");
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
