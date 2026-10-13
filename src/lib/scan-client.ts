import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { ipAddress } from "@vercel/functions";

/** Only Vercel's trusted edge IP participates; local forwarding headers are ignored. */
export function scanClientKey(request: Pick<Request, "headers">, env: Record<string, string | undefined> = process.env) {
  const secret = env.RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512 || /[\s\u0000-\u001f]/.test(secret)) throw new Error("Configure a strong RATE_LIMIT_SECRET for public scan admission.");
  const supplied = env.VERCEL === "1" ? ipAddress(request) : undefined;
  let identity = "shared-local-client";
  if (supplied && isIP(supplied)) {
    identity = isIP(supplied) === 6 ? new URL(`http://[${supplied}]`).hostname : supplied;
  }
  return createHmac("sha256", secret).update(identity).digest("hex");
}
