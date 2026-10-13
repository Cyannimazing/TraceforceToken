import { z } from "zod";
import type { Address, TokenSecuritySnapshot } from "@/domain/investigations/types";
import { goPlusTokenUrl, TOKEN_SECURITY_CHECKS, tokenSecuritySnapshotSchema } from "@/domain/investigations/token-security";
import { createDeadline } from "@/lib/deadline";
import { abortable, boundedJson } from "./transport";
import { ProviderIntegrityError, UpstreamFailure } from "./errors";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const resultSchema = z.object({
  holder_count: z.string().max(20).optional(),
  creator_address: z.string().max(42).optional(),
  holders: z.array(z.object({ address })).max(100).optional(),
}).passthrough();
const envelopeSchema = z.object({ code: z.number().int(), result: z.record(z.string().max(42), z.unknown()).optional() });

export interface GoPlusTokenData { snapshot: TokenSecuritySnapshot; addresses: Address[] }

export function emptyGoPlusSnapshot(token: Address, status: "not_listed" | "unavailable", checkedAt: string): TokenSecuritySnapshot {
  return { source: "goplus", status, checkedAt, sourceUrl: goPlusTokenUrl(token), tokenAddress: token, chainId: 8453, holderCount: null, creatorAddress: null, checks: [] };
}

/** Accept only the exact requested chain/token key. Source balances/percentages,
 * tags and contract claims never become pinned facts or findings. */
export function parseGoPlusTokenData(value: unknown, token: Address, checkedAt: string): GoPlusTokenData {
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new ProviderIntegrityError("Invalid token context request identity.");
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) throw new ProviderIntegrityError("Malformed token context response.");
  if (envelope.data.code !== 1) throw new UpstreamFailure();
  if (!envelope.data.result) throw new ProviderIntegrityError("Missing token context result.");
  const entries = Object.entries(envelope.data.result);
  if (!entries.length) return { snapshot: emptyGoPlusSnapshot(token, "not_listed", checkedAt), addresses: [] };
  if (entries.length !== 1 || entries[0][0].toLowerCase() !== token) throw new ProviderIntegrityError("The token context response identified another token.");
  const parsed = resultSchema.safeParse(entries[0][1]);
  if (!parsed.success) throw new ProviderIntegrityError("Malformed token context fields.");
  const data = parsed.data;
  const holderCount = typeof data.holder_count === "string" && /^(0|[1-9][0-9]{0,15})$/.test(data.holder_count) && Number.isSafeInteger(Number(data.holder_count)) ? Number(data.holder_count) : null;
  const creator = address.safeParse(data.creator_address);
  const creatorAddress = creator.success && creator.data !== `0x${"0".repeat(40)}` ? creator.data : null;
  // A reported creator is a balance candidate, never verified identity or a
  // provider holder row. Source-reported balances/percentages remain unused.
  const addresses = [...new Set([...(data.holders ?? []).map((item) => item.address), ...(creatorAddress ? [creatorAddress] : [])])].filter((value) => value !== `0x${"0".repeat(40)}`).sort();
  const snapshot = tokenSecuritySnapshotSchema.parse({
    source: "goplus", status: "reported", checkedAt, sourceUrl: goPlusTokenUrl(token), tokenAddress: token, chainId: 8453,
    holderCount, creatorAddress,
    checks: TOKEN_SECURITY_CHECKS.map((id) => ({ id, value: data[id] === "1" ? "yes" : data[id] === "0" ? "no" : "unknown" })),
  });
  return { snapshot, addresses };
}

/** One fixed-host read, one response; no hidden retries, user URLs or raw bodies in errors. */
export function createGoPlusTokenQuery(timeoutMs: number, signal?: AbortSignal, accessToken?: string | null) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) throw new Error("Invalid token context timeout.");
  if (accessToken && (accessToken.length > 4096 || /[\r\n]/.test(accessToken))) throw new Error("Invalid GoPlus access token.");
  return async (token: Address): Promise<GoPlusTokenData> => {
    if (!/^0x[0-9a-f]{40}$/.test(token)) throw new ProviderIntegrityError("Invalid token context request identity.");
    const checkedAt = new Date().toISOString();
    const deadline = createDeadline(timeoutMs, signal ? [signal] : []);
    try {
      deadline.signal.throwIfAborted();
      const response = await abortable(() => fetch(goPlusTokenUrl(token), { headers: { accept: "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, redirect: "error", cache: "no-store", signal: deadline.signal }), deadline.signal);
      const value = await abortable(() => boundedJson(response, 1_000_000), deadline.signal);
      deadline.signal.throwIfAborted();
      return parseGoPlusTokenData(value, token, checkedAt);
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.signal.aborted || error instanceof TypeError) throw new UpstreamFailure(true);
      throw error;
    } finally { deadline.dispose(); }
  };
}
