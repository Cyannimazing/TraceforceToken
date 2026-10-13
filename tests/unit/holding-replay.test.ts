import assert from "node:assert/strict";
import { test } from "node:test";
import { reconstructHoldingReplay } from "../../src/domain/investigations/holding-replay";
import type { Address, EvidenceRecord, Hash, HolderSnapshot, InvestigationReport } from "../../src/domain/investigations/types";
import { browserFixture, getBrowserReportFixture } from "../fixtures/report";

const A = browserFixture.walletA, B = browserFixture.walletB, C = `0x${"c".repeat(40)}` as Address;
const ZERO = `0x${"0".repeat(40)}` as Address;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hash;
function transfer(block: number, from: Address, to: Address, amountRaw: string, index = 0): EvidenceRecord {
  return { id: `synthetic-${block}-${index}`, kind: "transfer", chainId: 8453, blockNumber: String(block), blockHash: hash(block), transactionHash: hash(block * 100 + index), transactionIndex: index,
    logIndex: index, traceId: null, timestamp: browserFixture.timestamp + (block - 100) * 10, from, to, assetAddress: browserFixture.token, amountRaw,
    provenance: { provider: "Synthetic replay fixture", method: "fabricated transfer event", observedAt: browserFixture.generatedAt }, sale: null };
}
function report(events: EvidenceRecord[], balances: { address: Address; balanceRaw: string | null }[], supply = "100"): InvestigationReport {
  const value = getBrowserReportFixture();
  value.coverage.transfers = "complete"; value.token.totalSupplyRaw = supply;
  value.evidence = events; value.findings = []; value.connections = []; value.story = [];
  value.wallets = [A, B, C].map((address) => ({ address, observedIncomingRaw: "0", observedOutgoingRaw: "0", observedNetRaw: "0", balanceRaw: balances.find((row) => row.address === address)?.balanceRaw ?? null,
    verifiedSoldRaw: "0", firstObservedAt: null, earlyAccumulator: false }));
  value.groups = [{ id: "synthetic-group", wallets: [A, B, C], evidenceIds: [], explanation: "Synthetic observed group; not common ownership." }];
  const holders: HolderSnapshot["holders"] = balances.map((row) => ({ ...row, status: row.balanceRaw === null ? "not_examined" : "verified", discoveredBy: "indexed" }));
  const verified = holders.filter((row) => row.status === "verified").length;
  value.holderSnapshot = { chainId: 8453, tokenAddress: value.token.address, block: { ...value.range.to }, totalSupplyRaw: supply,
    discovery: { provider: "Blockscout", sourceUrl: `https://base.blockscout.com/api/v2/tokens/${value.token.address}/holders`, observedAt: value.generatedAt, status: "partial", pages: 1, addresses: holders.length, finalizedCensus: false, reason: "Synthetic candidate selection, not a census." },
    balances: { status: verified === holders.length ? "complete" : verified ? "partial" : "not_examined", requestedWallets: holders.length, verifiedWallets: verified, reason: "Synthetic pinned reads." },
    holders, provenance: { provider: "Base RPC", method: "eth_call balanceOf(address) at pinned finalized block", observedAt: value.generatedAt } };
  return value;
}

test("known end balances reconstruct actual tracked supply shares and unknown group members", () => {
  const value = report([transfer(150, A, B, "10"), transfer(200, B, C, "5")], [{ address: A, balanceRaw: "40" }, { address: B, balanceRaw: "35" }, { address: C, balanceRaw: null }]);
  const replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available"); assert.equal(replay.reason, null);
  assert.deepEqual([replay.trackedAddresses, replay.knownAddresses, replay.unknownAddresses], [3, 2, 1]);
  assert.deepEqual(replay.frames.map((frame) => [frame.block.number, frame.top10KnownRaw, frame.largestKnownRaw]), [["100", "80", "50"], ["150", "80", "40"], ["200", "75", "40"], ["400", "75", "40"]]);
  assert.deepEqual(replay.frames[0].shares.top10, { amountRaw: "80", totalSupplyRaw: "100" });
  assert.equal(replay.frames[0].largestGroupKnownRaw, "80"); assert.equal(replay.frames[0].unknownGroupMembers, 1);
  assert.deepEqual(replay.anchor, { block: value.range.to, provenance: value.holderSnapshot!.provenance });
  assert.match(replay.limitations.join(" "), /not a holder census.*not independently verified/);
});

test("reverse transaction and log order is canonical even when input arrives reversed", () => {
  const value = report([transfer(150, A, B, "10", 0), transfer(150, B, A, "20", 1)], [{ address: A, balanceRaw: "20" }, { address: B, balanceRaw: "0" }]);
  const replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available"); assert.equal(replay.frames[0].largestKnownRaw, "10");
  value.evidence.reverse(); assert.deepEqual(reconstructHoldingReplay(value), replay);
});

test("mint and burn logs reverse supply and known balances together", () => {
  const value = report([transfer(150, ZERO, A, "20"), transfer(200, B, ZERO, "10")], [{ address: A, balanceRaw: "40" }, { address: B, balanceRaw: "60" }]);
  const replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available");
  assert.deepEqual(replay.frames.map((frame) => [frame.block.number, frame.totalSupplyRaw, frame.top10KnownRaw]), [["100", "90", "90"], ["150", "110", "110"], ["200", "100", "100"], ["400", "100", "100"]]);
  assert.deepEqual(replay.frames[1].shares.top10, { amountRaw: "110", totalSupplyRaw: "110" });
});

test("declared start is after its block, and same-block ranges never create a pre-range frame", () => {
  const value = report([transfer(100, ZERO, A, "10")], [{ address: A, balanceRaw: "10" }], "10");
  const replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available"); assert.equal(replay.frames[0].block.number, "100"); assert.equal(replay.frames[0].top10KnownRaw, "10");
  value.range.to = { ...value.range.from }; value.holderSnapshot!.block = { ...value.range.to };
  const same = reconstructHoldingReplay(value); assert.equal(same.status, "available"); assert.equal(same.frames.length, 1); assert.equal(same.frames[0].top10KnownRaw, "10");
});

test("full-crawl replay starts at acquired token activity instead of the genesis search boundary", () => {
  const value = report([transfer(150, ZERO, A, "100"), transfer(200, A, B, "20")], [{ address: A, balanceRaw: "80" }, { address: B, balanceRaw: "20" }, { address: C, balanceRaw: null }]);
  value.range.from = { number: "0", hash: hash(0), timestamp: 0 };
  const before = structuredClone(value), replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available");
  assert.deepEqual(replay.frames.map((frame) => [frame.block.number, frame.totalSupplyRaw, frame.largestKnownRaw]), [["150", "100", "100"], ["200", "100", "80"], ["400", "100", "80"]]);
  assert.equal(replay.totalFrames, 3);
  assert.ok(replay.frames.every((frame) => frame.shares.top10 !== null));
  assert.equal(replay.unknownAddresses, 1);
  assert.deepEqual(value, before);
  // Cropping the displayed boundary must not skip opening-state validation.
  value.evidence[0].amountRaw = "101";
  assert.equal(reconstructHoldingReplay(value).status, "unavailable");
});

test("a full-crawl mint at the pinned endpoint remains one known state without fabricated earlier ratios", () => {
  const value = report([transfer(400, ZERO, A, "100")], [{ address: A, balanceRaw: "100" }]);
  value.range.from = { number: "0", hash: hash(0), timestamp: 0 };
  const replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available");
  assert.equal(replay.frames.length, 1);
  assert.equal(replay.frames[0].block.number, "400");
  assert.deepEqual(replay.frames[0].shares.largest, { amountRaw: "100", totalSupplyRaw: "100" });
});

test("empty zero-supply full-crawl history retains both boundaries without inventing defined percentages", () => {
  const value = report([], [{ address: A, balanceRaw: "0" }], "0");
  value.range.from = { number: "0", hash: hash(0), timestamp: 0 };
  const replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available");
  assert.deepEqual(replay.frames.map((frame) => frame.block.number), ["0", "400"]);
  assert.ok(replay.frames.every((frame) => frame.largestKnownRaw === "0" && frame.shares.largest === null));
});

test("self transfers, quote assets, native funding and sale annotations do not double-count holdings", () => {
  const self = transfer(150, A, A, ((1n << 256n) - 1n).toString());
  const quote = { ...transfer(160, A, B, "999"), assetAddress: C };
  const native: EvidenceRecord = { ...transfer(170, B, A, "1000"), kind: "funding", assetAddress: null, logIndex: null };
  const sale: EvidenceRecord = { ...transfer(180, A, B, "999"), kind: "sale", sale: { pool: B, factory: C, protocol: "uniswap-v3", quoteAsset: C, quoteAmountRaw: "999", swapLogIndex: 0, supportingEvidenceIds: [quote.id] } };
  const value = report([self, quote, native, sale, transfer(190, ZERO, ZERO, "50")], [{ address: A, balanceRaw: "10" }]);
  const replay = reconstructHoldingReplay(value); assert.equal(replay.status, "available");
  assert.deepEqual(replay.frames.map((frame) => frame.top10KnownRaw), ["10", "10", "10", "10"]);
  assert.ok(replay.frames.every((frame) => frame.totalSupplyRaw === "100"));
});

test("identical logical observations deduplicate; conflicting events and forks fail closed", () => {
  const event = transfer(150, A, B, "10");
  const value = report([event, { ...event, id: "different-provider-id", provenance: { ...event.provenance, provider: "Other synthetic provider" } }], [{ address: A, balanceRaw: "40" }, { address: B, balanceRaw: "30" }]);
  assert.equal(reconstructHoldingReplay(value).status, "available");
  assert.equal(reconstructHoldingReplay(value).frames[0].largestKnownRaw, "50");
  for (const replacement of [{ ...event, amountRaw: "11" }, { ...event, blockHash: hash(151) }]) {
    const invalid = report([event, replacement], [{ address: A, balanceRaw: "40" }, { address: B, balanceRaw: "30" }]);
    const replay = reconstructHoldingReplay(invalid); assert.equal(replay.status, "unavailable"); assert.deepEqual(replay.frames, []); assert.match(replay.reason!, /conflict|disagree/);
  }
});

test("partial coverage, absent anchors, unknown supply and wholly unread cohorts never manufacture history", () => {
  const base = report([], [{ address: A, balanceRaw: "0" }]);
  for (const mutate of [
    (value: InvestigationReport) => { value.coverage.transfers = "partial"; },
    (value: InvestigationReport) => { delete value.holderSnapshot; },
    (value: InvestigationReport) => { value.token.totalSupplyRaw = null; value.holderSnapshot!.totalSupplyRaw = null; },
    (value: InvestigationReport) => { value.holderSnapshot!.block.hash = hash(999); },
    (value: InvestigationReport) => { value.wallets = value.wallets.filter((wallet) => wallet.address !== A); },
  ]) { const value = structuredClone(base); mutate(value); const replay = reconstructHoldingReplay(value); assert.equal(replay.status, "unavailable"); assert.ok(replay.reason); assert.deepEqual(replay.frames, []); }
});

test("negative balances, uint256 overflow, negative supply and known balances above supply are rejected", () => {
  const max = ((1n << 256n) - 1n).toString();
  for (const value of [
    report([transfer(150, B, A, "20")], [{ address: A, balanceRaw: "10" }]),
    report([transfer(150, A, C, "1")], [{ address: A, balanceRaw: max }], max),
    report([transfer(150, ZERO, C, "200")], [{ address: A, balanceRaw: "0" }]),
    report([transfer(150, ZERO, C, "100")], [{ address: A, balanceRaw: "100" }]),
  ]) { const replay = reconstructHoldingReplay(value); assert.equal(replay.status, "unavailable"); assert.deepEqual(replay.frames, []); assert.match(replay.reason!, /negative|exceed/); }
});

test("exact uint256 holdings and supply fractions do not round through Number", () => {
  const amount = (2n ** 255n + 9_007_199_254_740_993n).toString(), other = "9007199254740993", supply = ((1n << 256n) - 1n).toString();
  const replay = reconstructHoldingReplay(report([transfer(150, A, B, "7")], [{ address: A, balanceRaw: amount }, { address: B, balanceRaw: other }], supply));
  assert.equal(replay.status, "available");
  assert.equal(replay.frames[0].largestKnownRaw, (BigInt(amount) + 7n).toString());
  assert.deepEqual(replay.frames[0].shares.top10, { amountRaw: (BigInt(amount) + BigInt(other)).toString(), totalSupplyRaw: supply });
});

test("zero-supply frames have undefined ratios without inventing zero percentages", () => {
  const replay = reconstructHoldingReplay(report([transfer(150, ZERO, A, "10"), transfer(200, A, ZERO, "10")], [{ address: A, balanceRaw: "0" }], "0"));
  assert.equal(replay.status, "available");
  assert.equal(replay.frames[0].shares.top10, null); assert.equal(replay.frames[1].shares.top10!.totalSupplyRaw, "10");
  assert.equal(replay.frames.at(-1)!.shares.largest, null);
});

test("more than 200 frames preserve endpoints and validate even undisplayed intermediate states", () => {
  const events = Array.from({ length: 250 }, (_, index) => transfer(101 + index, A, A, "1"));
  const value = report(events, [{ address: A, balanceRaw: "10" }]);
  const replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available"); assert.equal(replay.totalFrames, 252); assert.equal(replay.frames.length, 200);
  assert.equal(replay.frames[0].block.number, "100"); assert.equal(replay.frames.at(-1)!.block.number, "400");
  const hidden = events.find((event) => !replay.frames.some((frame) => frame.block.number === event.blockNumber))!;
  value.evidence = events.map((event) => event === hidden ? { ...event, from: B, to: A, amountRaw: "11" } : event);
  const invalid = reconstructHoldingReplay(value); assert.equal(invalid.status, "unavailable"); assert.deepEqual(invalid.frames, []);
});

test("foreign block identity, out-of-window transfers, malformed amounts and transaction conflicts are rejected", () => {
  for (const events of [
    [{ ...transfer(100, A, B, "1"), blockHash: hash(999) }],
    [transfer(99, A, B, "1")],
    [transfer(150, A, B, "-1")],
    [transfer(150, A, B, "1"), { ...transfer(150, A, B, "1", 1), transactionIndex: 0 }],
    [transfer(150, A, B, "1"), { ...transfer(150, B, A, "1", 1), logIndex: 0 }],
    [{ ...transfer(150, A, B, "1"), logIndex: 2 }, transfer(150, B, A, "1", 1)],
    [transfer(150, A, B, "1"), { ...transfer(200, B, A, "1"), timestamp: browserFixture.timestamp + 100 }],
  ]) { const replay = reconstructHoldingReplay(report(events, [{ address: A, balanceRaw: "50" }, { address: B, balanceRaw: "50" }])); assert.equal(replay.status, "unavailable"); assert.deepEqual(replay.frames, []); }
});

test("top ten means the ten largest known tracked balances, not all holders or all known balances", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, "0")}` as Address, balanceRaw: String(index + 1) }));
  const value = report([], rows);
  value.wallets = rows.map((row) => ({ ...value.wallets[0], address: row.address, balanceRaw: row.balanceRaw })); value.groups = [];
  const frame = reconstructHoldingReplay(value).frames[0];
  assert.equal(frame.top10KnownRaw, "75"); assert.equal(frame.largestKnownRaw, "12"); assert.equal(frame.largestGroupKnownRaw, null); assert.equal(frame.shares.largestGroup, null);
});

test("empty complete windows retain the pinned values and derivation is immutable and serializable", () => {
  const value = report([], [{ address: A, balanceRaw: "40" }, { address: B, balanceRaw: "20" }]);
  const before = structuredClone(value), replay = reconstructHoldingReplay(value);
  assert.equal(replay.status, "available"); assert.equal(replay.frames.length, 2);
  assert.ok(replay.frames.every((frame) => frame.top10KnownRaw === "60"));
  assert.deepEqual(value, before); assert.doesNotThrow(() => JSON.stringify(replay));
  value.groups.reverse(); value.holderSnapshot!.holders.reverse(); assert.deepEqual(reconstructHoldingReplay(value), replay);
});
