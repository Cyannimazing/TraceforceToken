import { z } from "@/lib/validation";
import type { Address, TokenSecuritySnapshot } from "./types";

export const TOKEN_SECURITY_CHECKS = ["is_honeypot", "is_proxy", "is_mintable", "hidden_owner", "can_take_back_ownership", "owner_change_balance", "transfer_pausable", "is_blacklisted", "is_open_source"] as const;
export const goPlusTokenUrl = (token: Address) => `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${token}`;
export const tokenSecuritySnapshotSchema: z.ZodType<TokenSecuritySnapshot> = z.object({
  source: z.literal("goplus"), status: z.enum(["reported", "not_listed", "unavailable"]),
  checkedAt: z.iso.datetime(),
  sourceUrl: z.string().regex(/^https:\/\/api\.gopluslabs\.io\/api\/v1\/token_security\/8453\?contract_addresses=0x[0-9a-f]{40}$/),
  tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address), chainId: z.literal(8453),
  holderCount: z.number().int().nonnegative().safe().nullable(),
  creatorAddress: z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address).nullable(),
  checks: z.array(z.object({ id: z.enum(TOKEN_SECURITY_CHECKS), value: z.enum(["yes", "no", "unknown"]) }).strict()).max(TOKEN_SECURITY_CHECKS.length),
}).strict().superRefine((value, context) => {
  if (value.sourceUrl !== goPlusTokenUrl(value.tokenAddress)
    || new Set(value.checks.map((item) => item.id)).size !== value.checks.length
    || (value.status !== "reported" && (value.holderCount !== null || value.creatorAddress !== null || value.checks.length !== 0))) {
    context.addIssue({ code: "custom", message: "Inconsistent source-reported token context." });
  }
});
