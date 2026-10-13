import { z } from "@/lib/validation";
import type { Address, BlockReference, Hash, HolderSnapshot, TokenDetails } from "./types";
import { goPlusTokenUrl } from "./token-security";

export function approvedHolderSource(provider: HolderSnapshot["discovery"]["provider"], token: Address, url: string): boolean {
  return provider === "GoPlus" ? url === goPlusTokenUrl(token)
    : [`https://base.blockscout.com/api/v2/tokens/${token}/holders`, `https://api.blockscout.com/8453/api/v2/tokens/${token}/holders`].includes(url);
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hash);
const raw = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n);
const count = z.number().int().nonnegative().safe();
const status = z.enum(["complete", "partial", "unavailable", "not_examined"]);
const reason = z.string().max(2000).nullable();

export const holderSnapshotSchema: z.ZodType<HolderSnapshot> = z.object({
  chainId: z.literal(8453), tokenAddress: address,
  block: z.object({ number: raw, hash, timestamp: count.max(8_640_000_000_000) }).strict(),
  totalSupplyRaw: raw.nullable(),
  discovery: z.object({
    provider: z.enum(["Blockscout", "GoPlus"]),
    sourceUrl: z.string().max(256),
    observedAt: z.iso.datetime(), status, pages: count, addresses: count,
    finalizedCensus: z.literal(false), reason,
  }).strict(),
  balances: z.object({ status, requestedWallets: count, verifiedWallets: count, reason }).strict(),
  holders: z.array(z.object({
    address, balanceRaw: raw.nullable(), status: z.enum(["verified", "unavailable", "not_examined"]),
    discoveredBy: z.enum(["indexed", "observed", "both"]),
  }).strict()),
  provenance: z.object({
    provider: z.literal("Base RPC"),
    method: z.literal("eth_call balanceOf(address) at pinned finalized block"), observedAt: z.iso.datetime(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const verified = value.holders.filter((item) => item.status === "verified");
  const unavailable = value.holders.some((item) => item.status === "unavailable");
  const allVerified = verified.length === value.holders.length;
  const expected = allVerified && (verified.length > 0 || value.discovery.status === "complete") ? "complete"
    : verified.length > 0 ? "partial" : unavailable ? "unavailable" : "not_examined";
  if (new Set(value.holders.map((item) => item.address)).size !== value.holders.length
    || value.holders.some((item) => (item.status === "verified") !== (item.balanceRaw !== null))
    || value.balances.requestedWallets !== value.holders.length
    || value.balances.verifiedWallets !== verified.length || value.balances.status !== expected
    || value.discovery.addresses !== value.holders.filter((item) => item.discoveredBy !== "observed").length
    || (["unavailable", "not_examined"].includes(value.discovery.status) && (value.discovery.pages !== 0 || value.discovery.addresses !== 0))
    || (["complete", "partial"].includes(value.discovery.status) && value.discovery.pages === 0)
    || !approvedHolderSource(value.discovery.provider, value.tokenAddress, value.discovery.sourceUrl)
    || (value.discovery.provider === "GoPlus" && value.discovery.status === "complete")
    || (value.totalSupplyRaw !== null && verified.reduce((sum, item) => sum + BigInt(item.balanceRaw!), 0n) > BigInt(value.totalSupplyRaw))) {
    context.addIssue({ code: "custom", message: "Inconsistent pinned holder snapshot." });
  }
});

/** Shared pure boundary: a latest index page cannot redefine pinned token/block identity. */
export function validateHolderSnapshot(value: unknown, token: TokenDetails, block: BlockReference): HolderSnapshot {
  const snapshot = holderSnapshotSchema.parse(value);
  if (snapshot.tokenAddress !== token.address || snapshot.chainId !== token.chainId
    || snapshot.totalSupplyRaw !== token.totalSupplyRaw || snapshot.block.number !== block.number
    || snapshot.block.hash !== block.hash || snapshot.block.timestamp !== block.timestamp) {
    throw new Error("Holder snapshot does not match the pinned investigated token.");
  }
  return { ...snapshot, holders: [...snapshot.holders].sort((a, b) => a.address.localeCompare(b.address)) };
}
