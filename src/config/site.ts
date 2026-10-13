export const site = {
  name: "TraceForce Engine",
  tokenName: "Traceforge Token",
  description:
    "Trace token funding, wallet connections, early accumulation, and evidence of coordinated selling. An evidence-first investigation engine, starting on Base.",
  locale: "en_US",
  language: "en",
  chainName: "Base",
  chainId: 8453,
} as const;

export const publicRoutes = ["/", "/methodology", "/data-sources"] as const;

type Environment = Record<string, string | undefined>;

/** Public site settings only. Database and provider secrets belong in server-only modules. */
export function getSiteConfig(env: Environment = process.env) {
  const configured = env.SITE_URL?.trim();
  const deploymentHost = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  const raw = configured || (deploymentHost ? `https://${deploymentHost}` : "http://localhost:3000");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SITE_URL must be an absolute HTTP or HTTPS origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("SITE_URL must contain only the site origin, without credentials, a path, query, or fragment.");
  }
  if (env.ALLOW_INDEXING && !["true", "false"].includes(env.ALLOW_INDEXING)) {
    throw new Error("ALLOW_INDEXING must be true or false.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (env.ALLOW_INDEXING === "true" && (!configured || url.protocol !== "https:" || local)) {
    throw new Error("Indexing requires an explicit public HTTPS SITE_URL.");
  }
  const indexable =
    env.ALLOW_INDEXING === "true" &&
    (!env.VERCEL_ENV || env.VERCEL_ENV === "production") &&
    env.NODE_ENV === "production";

  return { origin: url.origin, url, indexable };
}

export function absoluteUrl(path: string, env?: Environment) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) {
    throw new Error("Site paths must start with one forward slash.");
  }
  const { url } = getSiteConfig(env);
  const resolved = new URL(path, url);
  if (resolved.origin !== url.origin) throw new Error("Site paths must stay on the configured origin.");
  return resolved.toString();
}
