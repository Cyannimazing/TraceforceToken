import { createHash, timingSafeEqual } from "node:crypto";

export function equalSecret(value: string, expected: string) {
  const digest = (input: string) => createHash("sha256").update(input).digest();
  return timingSafeEqual(digest(value), digest(expected));
}
