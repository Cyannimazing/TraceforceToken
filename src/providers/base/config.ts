import { isIP } from "node:net";
import { z } from "zod";
import type { CollectorLimits } from "./core";

export interface ProviderConfiguration {
  rpcUrl: string;
  rpcFallbackUrls: readonly string[];
  /** Explicit independent log-discovery lane; never inferred from fallbacks. */
  logRpcUrl?: string | null;
  /** Explicit fixed indexed API lane, separate from state-provider recovery. */
  alchemyRpcUrl?: string | null;
  transferSource?: "rpc" | "alchemy";
  allowedHosts: readonly string[];
  blockscoutApiKey: string | null;
  goPlusAccessToken?: string | null;
  fundingSource: "rpc" | "alchemy" | "sqd-public-testing";
  timeoutMs: number;
  scanTimeoutMs: number;
  allowLocalTests: boolean;
  limits: CollectorLimits;
}

const DEFAULT_HOSTS = ["mainnet.base.org", "base-mainnet.g.alchemy.com", "base-mainnet.infura.io", "base-rpc.publicnode.com", "base.drpc.org"];
const hostnameSchema = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/);

/** Revalidate every endpoint, including trusted configurations assembled in code.
 * Canonical duplicates never create additional recovery attempts. */
export function configuredRpcEndpoints(configuration: Pick<ProviderConfiguration, "rpcUrl" | "rpcFallbackUrls" | "allowedHosts" | "allowLocalTests">): readonly URL[] {
  const endpoints = new Map<string, URL>();
  for (const value of [configuration.rpcUrl, ...configuration.rpcFallbackUrls]) {
    let url: URL;
    try {
      if (!value.trim() || value.length > 8192 || /[\\\x00-\x1f\x7f]/.test(value)) throw new Error();
      url = new URL(value.trim());
    } catch { throw new Error("RPC endpoints must be valid approved HTTPS URLs."); }
    const host = url.hostname.toLowerCase();
    const local = configuration.allowLocalTests && ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (url.username || url.password || url.hash || (!local && (url.protocol !== "https:" || !configuration.allowedHosts.includes(host) || isIP(host) !== 0)) || (local && !["http:", "https:"].includes(url.protocol))) throw new Error("RPC endpoints must use approved public HTTPS hosts without embedded credentials or fragments.");
    endpoints.set(url.toString(), url);
  }
  if (endpoints.size > 3) throw new Error("BASE_RPC_FALLBACK_URLS supports at most two distinct fallback endpoints.");
  return [...endpoints.values()];
}

export function configuredLogRpcEndpoint(configuration: Pick<ProviderConfiguration, "logRpcUrl" | "allowedHosts" | "allowLocalTests">): URL | null {
  if (configuration.logRpcUrl === undefined || configuration.logRpcUrl === null) return null;
  if (configuration.logRpcUrl.includes(",")) throw new Error("BASE_LOG_RPC_URL must identify one approved HTTPS endpoint.");
  return configuredRpcEndpoints({ ...configuration, rpcUrl: configuration.logRpcUrl, rpcFallbackUrls: [] })[0];
}

export function configuredAlchemyRpcEndpoint(configuration: Pick<ProviderConfiguration, "alchemyRpcUrl" | "allowedHosts" | "allowLocalTests">): URL | null {
  if (!configuration.alchemyRpcUrl) return null;
  const url = configuredRpcEndpoints({ ...configuration, rpcUrl: configuration.alchemyRpcUrl, rpcFallbackUrls: [] })[0];
  const local = configuration.allowLocalTests && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && url.hostname !== "base-mainnet.g.alchemy.com") throw new Error("The indexed Base API requires an approved Base Alchemy endpoint.");
  return url;
}

/** DNS destinations are checked again by the server transport before the first request. */
export function isPublicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return isPublicAddress(lower.slice(7));
    const first = parseInt(lower.split(":")[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !lower.startsWith("2001:db8:") && !lower.startsWith("2002:");
  }
  return false;
}

function numeric(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number) {
  const value = env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} is outside the supported integer range.`);
  return value;
}

/** No defaults silently enable a paid provider, and no configured URL is echoed in errors. */
export function readProviderConfiguration(env: Record<string, string | undefined> = process.env): ProviderConfiguration {
  if (!env.BASE_RPC_URL?.trim()) throw new Error("BASE_RPC_URL must be configured before collecting a live investigation.");
  const allowLocalTests = env.NODE_ENV === "test";
  const extraHosts = (env.BASE_RPC_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (extraHosts.length > 20 || extraHosts.some((value) => !hostnameSchema.safeParse(value).success)) throw new Error("BASE_RPC_ALLOWED_HOSTS must contain exact public DNS hostnames.");
  const allowedHosts = [...new Set([...DEFAULT_HOSTS, ...extraHosts])];
  const fallbackInput = env.BASE_RPC_FALLBACK_URLS?.trim() ?? "";
  if (fallbackInput.length > 16_384) throw new Error("BASE_RPC_FALLBACK_URLS exceeds the supported configuration length.");
  const fallbackValues = fallbackInput ? fallbackInput.split(",").map((value) => value.trim()) : [];
  const [url, ...fallbacks] = configuredRpcEndpoints({ rpcUrl: env.BASE_RPC_URL, rpcFallbackUrls: fallbackValues, allowedHosts, allowLocalTests });
  const logInput = env.BASE_LOG_RPC_URL?.trim() || null;
  const logRpcUrl = configuredLogRpcEndpoint({ logRpcUrl: logInput, allowedHosts, allowLocalTests })?.toString() ?? null;
  if (logRpcUrl && env.VERCEL === "1") throw new Error("BASE_LOG_RPC_URL belongs on the protected scan engine, not the Vercel web application.");
  const key = env.BLOCKSCOUT_API_KEY?.trim() || null;
  if (key && (key.length < 8 || key.length > 512 || /[\r\n]/.test(key))) throw new Error("BLOCKSCOUT_API_KEY has an invalid format.");
  const goPlusAccessToken = env.GOPLUS_ACCESS_TOKEN?.trim() || null;
  if (goPlusAccessToken && (goPlusAccessToken.length > 4096 || /[\r\n]/.test(goPlusAccessToken))) throw new Error("GOPLUS_ACCESS_TOKEN has an invalid format.");
  const fundingSource = env.BASE_FUNDING_SOURCE?.trim() || "rpc";
  if (fundingSource !== "rpc" && fundingSource !== "alchemy" && fundingSource !== "sqd-public-testing") throw new Error("BASE_FUNDING_SOURCE must select a supported acquisition source.");
  const transferSource = env.BASE_TRANSFER_SOURCE?.trim() || "rpc";
  if (transferSource !== "rpc" && transferSource !== "alchemy") throw new Error("BASE_TRANSFER_SOURCE must select a supported acquisition source.");
  const alchemyRpcUrl = configuredAlchemyRpcEndpoint({ alchemyRpcUrl: env.BASE_ALCHEMY_RPC_URL?.trim() || null, allowedHosts, allowLocalTests })?.toString() ?? null;
  if ((transferSource === "alchemy" || fundingSource === "alchemy") && !alchemyRpcUrl) throw new Error("Selected Alchemy acquisition requires BASE_ALCHEMY_RPC_URL.");
  if (alchemyRpcUrl && env.VERCEL === "1") throw new Error("BASE_ALCHEMY_RPC_URL belongs on the protected scan engine, not the Vercel web application.");
  if (fundingSource === "sqd-public-testing" && env.VERCEL === "1") throw new Error("SQD public testing is a local evaluation source; configure production-approved access before hosting.");
  return {
    rpcUrl: url.toString(), rpcFallbackUrls: fallbacks.map((fallback) => fallback.toString()), logRpcUrl, alchemyRpcUrl, transferSource, allowedHosts, blockscoutApiKey: key, goPlusAccessToken, fundingSource, allowLocalTests,
    timeoutMs: numeric(env, "BASE_PROVIDER_TIMEOUT_MS", 12_000, 1000, 30_000),
    scanTimeoutMs: numeric(env, "BASE_PROVIDER_SCAN_TIMEOUT_MS", 120_000, 5000, 300_000),
    limits: { logChunkSize: numeric(env, "BASE_RPC_LOG_CHUNK_SIZE", 1_000_000, 10, 10_000_000), maxTransferLogs: numeric(env, "BASE_MAX_TRANSFER_LOGS", 2000, 1, 2000), callBudget: numeric(env, "BASE_RPC_CALL_BUDGET", 500, 20, 2000), fundingMaxPages: numeric(env, "BASE_FUNDING_MAX_PAGES", 2, 1, 20), nativeFundingMaxBlocks: numeric(env, "BASE_NATIVE_FUNDING_MAX_BLOCKS", 32, 1, 256) },
  };
}
