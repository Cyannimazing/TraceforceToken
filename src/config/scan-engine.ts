export type ScanEngineConfiguration = { mode: "local" } | { mode: "remote"; url: string; secret: string; localTest: boolean };

/** Trusted operator settings only; visitors never select an engine. */
export function readScanEngineConfiguration(env: Record<string, string | undefined> = process.env): ScanEngineConfiguration {
  const configured = env.SCAN_ENGINE_URL?.trim();
  if (!configured) {
    if (env.VERCEL === "1") throw new Error("Configure the protected scan engine before deployment.");
    return { mode: "local" };
  }
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("Invalid scan engine endpoint."); }
  const localTest = env.NODE_ENV === "test" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/scan" || configured.includes("\\")
    || (!localTest && (url.protocol !== "https:" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)))
    || (localTest && !["http:", "https:"].includes(url.protocol))) throw new Error("The scan engine must use a trusted HTTPS /scan endpoint.");
  const secret = env.SCAN_ENGINE_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512 || /[\s\x00-\x1f\x7f]/.test(secret)) throw new Error("Configure a strong private scan engine secret.");
  return { mode: "remote", url: url.toString(), secret, localTest };
}
