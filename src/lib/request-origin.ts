/** Exact browser-origin check, independent of NextURL's loopback normalization. */
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) return false;
  try {
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = request.headers.get("host");
    if (host === null) return origin === url.origin;
    // NextURL canonicalizes loopback hosts to localhost. Preserve the received
    // Host authority; untrusted forwarding headers never replace that authority.
    if (host.length > 260) return false;
    const parts = /^(\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::(0|[1-9][0-9]{0,4}))?$/.exec(host);
    if (!parts) return false;
    const hostname = parts[1].toLowerCase();
    if (!hostname.startsWith("[") && hostname.replace(/\.$/, "").split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
    const target = new URL(`${url.protocol}//${host}`);
    // Reject alternate numeric-IP spellings and other parser reinterpretations.
    if (target.hostname !== hostname) return false;
    return origin === target.origin;
  } catch { return false; }
}
