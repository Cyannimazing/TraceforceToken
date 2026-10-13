import { z } from "@/lib/validation";
import type { Address, TokenWebPresence } from "./types";

/** Validate a displayed external link. This never fetches the destination. */
export function normalizeTokenWebsite(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
      || /\.(?:local|localhost|internal|test|invalid|example|onion)$/i.test(host)) return null;
    url.hash = "";
    const result = url.toString();
    return result.length <= 2048 ? result : null;
  } catch { return null; }
}

const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
export const tokenWebPresenceSchema: z.ZodType<TokenWebPresence> = z.object({
  source: z.literal("dexscreener"),
  status: z.enum(["reported", "not_listed", "unavailable"]),
  checkedAt: z.iso.datetime(),
  sourceUrl: z.string().regex(/^https:\/\/api\.dexscreener\.com\/token-pairs\/v1\/base\/0x[0-9a-f]{40}$/),
  websites: z.array(z.object({
    url: z.string().max(2048).refine((value) => normalizeTokenWebsite(value) === value),
    pairAddresses: z.array(address).min(1).max(100).refine((items) => new Set(items).size === items.length),
  }).strict()).max(5),
  matchedPairs: z.number().int().min(0).max(100),
  reason: z.string().max(300).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "reported") !== (value.websites.length > 0)
    || (value.status === "reported" && value.matchedPairs === 0)
    || new Set(value.websites.map((site) => site.url)).size !== value.websites.length
    || value.websites.some((site) => site.pairAddresses.length > value.matchedPairs)) {
    context.addIssue({ code: "custom", message: "Inconsistent token website metadata." });
  }
});
