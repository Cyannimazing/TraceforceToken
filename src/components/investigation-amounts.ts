/** Presentation only: exact raw quantities remain in the report and provenance. */
export function tokenAmount(raw: string, decimals: number | null): string {
  if (decimals === null) return raw;
  const negative = raw.startsWith("-"), padded = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = (decimals ? padded.slice(0, -decimals) : padded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = decimals ? padded.slice(-decimals) : "", shown = fraction.slice(0, 6).replace(/0+$/, "");
  return `${negative ? "−" : ""}${whole}${shown ? `.${shown}` : ""}${/[1-9]/.test(fraction.slice(6)) ? "…" : ""}`;
}

/** Detailed share of the supplied pinned denominator. */
export function supplyShare(balanceRaw: string | null, totalSupplyRaw: string | null): string | null {
  if (balanceRaw === null || totalSupplyRaw === null || BigInt(totalSupplyRaw) <= 0n) return null;
  const numerator = BigInt(balanceRaw) * 10_000n, supply = BigInt(totalSupplyRaw), hundredths = numerator / supply;
  if (numerator > 0n && hundredths === 0n) return "<0.01%";
  const fraction = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${numerator % supply ? "≈" : ""}${hundredths / 100n}${fraction ? `.${fraction}` : ""}%`;
}

/** Compact holder percentage; raw amounts and denominator stay available in its tooltip. */
export function compactHoldingShare(balanceRaw: string | null, denominatorRaw: string | null, fixedDecimal = false): string | null {
  if (balanceRaw === null || denominatorRaw === null || BigInt(denominatorRaw) <= 0n) return null;
  const balance = BigInt(balanceRaw), denominator = BigInt(denominatorRaw);
  if (balance > 0n && balance * 1000n < denominator) return "<0.1%";
  const tenths = (balance * 1000n + denominator / 2n) / denominator;
  return `${tenths / 10n}${fixedDecimal || tenths % 10n ? `.${tenths % 10n}` : ""}%`;
}
