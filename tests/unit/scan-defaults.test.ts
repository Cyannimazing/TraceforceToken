import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LOOKBACK_BLOCKS } from "../../src/domain/investigations/scan-defaults";
import { scanParametersSchema } from "../../src/domain/investigations/scan";

const token = `0x${"1".repeat(40)}`;

test("public requests default to full history and retain an explicit bounded window option", () => {
  const automatic = scanParametersSchema.parse({ token });
  assert.equal(automatic.lookbackBlocks, DEFAULT_LOOKBACK_BLOCKS);
  assert.equal(automatic.lookbackBlocks, 20_000);
  assert.equal(automatic.scope, "full");
  assert.equal(scanParametersSchema.parse({ token, scope: "window", lookbackBlocks: 100 }).scope, "window");
  assert.equal(scanParametersSchema.parse({ token, lookbackBlocks: 100 }).lookbackBlocks, 100);
  assert.equal(scanParametersSchema.parse({ token, lookbackBlocks: 1000 }).lookbackBlocks, 1000);
});

test("the wider default does not expand request bounds or permit a visitor-supplied source", () => {
  for (const lookbackBlocks of [99, 20_001, 100.5, "20000", null]) assert.equal(scanParametersSchema.safeParse({ token, lookbackBlocks }).success, false);
  assert.equal(scanParametersSchema.safeParse({ token, rpcUrl: "https://untrusted.invalid" }).success, false);
  assert.equal(scanParametersSchema.safeParse({ token, scope: "lifetime-wallet-ownership" }).success, false);
});
