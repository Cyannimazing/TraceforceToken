export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN = "base" as const;
export const UINT256_MAX = (1n << 256n) - 1n;

export type CanonicalAddress = `0x${string}`;

/** Store EVM identity in a single lowercase form; checksum display is a UI concern. */
export function canonicalBaseAddress(value: string): CanonicalAddress {
  const address = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Expected a 20-byte EVM address starting with 0x.");
  }
  return address.toLowerCase() as CanonicalAddress;
}

/** Raw on-chain amounts are decimal strings, never floating point numbers. */
export function canonicalRawAmount(value: string): string {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > UINT256_MAX) {
    throw new Error("Expected a canonical unsigned uint256 decimal string.");
  }
  return value;
}
