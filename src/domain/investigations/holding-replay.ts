import { evidenceId } from "./analyze";
import { validateHolderSnapshot } from "./holder-snapshot";
import type { ExactSupplyShare } from "./report-facts";
import type { Address, BlockReference, EvidenceRecord, HolderSnapshot, InvestigationReport } from "./types";

export interface HoldingReplayFrame {
  /** State after this block, not before its first transaction. */
  block: BlockReference;
  totalSupplyRaw: string;
  top10KnownRaw: string;
  largestKnownRaw: string;
  largestKnownAddress: Address;
  largestGroupKnownRaw: string | null;
  largestGroupId: string | null;
  unknownGroupMembers: number;
  shares: { top10: ExactSupplyShare | null; largest: ExactSupplyShare | null; largestGroup: ExactSupplyShare | null };
}
export interface HoldingReplay {
  status: "available" | "unavailable";
  reason: string | null;
  frames: HoldingReplayFrame[];
  totalFrames: number;
  trackedAddresses: number;
  knownAddresses: number;
  unknownAddresses: number;
  anchor: { block: BlockReference; provenance: HolderSnapshot["provenance"] } | null;
  limitations: string[];
}

const ZERO = `0x${"0".repeat(40)}`;
const MAX = (1n << 256n) - 1n;
const RAW = /^(?:0|[1-9][0-9]{0,77})$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const MAX_FRAMES = 200;
const LIMITATIONS = [
  "Transfer-reconstructed balances for the current eligible address cohort, not a holder census or history since launch.",
  "Missing pinned balance anchors stay unknown; known-address and known-group shares are lower bounds on broader holdings.",
  "This assumes standard transfer-event balance accounting. Rebases and nonstandard balance changes were not independently verified.",
  "Frames show state after each displayed block. Large histories are sampled to at most 200 frames after every transfer state is checked.",
  "A full-crawl view starts at the first retained token transfer, not Base genesis. That observation does not establish the token's launch time.",
];
class ReplayInputError extends Error {}
function requireReplay(condition: unknown, reason: string): asserts condition { if (!condition) throw new ReplayInputError(reason); }
function uint(value: string): bigint {
  requireReplay(typeof value === "string" && RAW.test(value) && BigInt(value) <= MAX, "A token amount or block number is outside the exact uint256 range.");
  return BigInt(value);
}
const numeric = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const unique = (addresses: Address[]) => [...new Set(addresses)].sort();
const ratio = (amount: bigint, supply: bigint): ExactSupplyShare | null => supply > 0n ? { amountRaw: amount.toString(), totalSupplyRaw: supply.toString() } : null;

function orderedTransfers(report: InvestigationReport): EvidenceRecord[] {
  const blocks = new Map<string, { hash: string; timestamp: number }>();
  for (const block of [report.range.from, report.range.to]) {
    uint(block.number);
    requireReplay(HASH.test(block.hash) && Number.isSafeInteger(block.timestamp) && block.timestamp >= 0, "The declared block identity is invalid.");
    const previous = blocks.get(block.number);
    requireReplay(!previous || previous.hash === block.hash && previous.timestamp === block.timestamp, "The declared range has conflicting block identities.");
    blocks.set(block.number, { hash: block.hash, timestamp: block.timestamp });
  }
  requireReplay(BigInt(report.range.from.number) <= BigInt(report.range.to.number) && report.range.from.timestamp <= report.range.to.timestamp, "The declared block range is inconsistent.");
  const events = new Map<string, EvidenceRecord>();
  const signatures = new Map<string, string>();
  const transactionPositions = new Map<string, string>();
  const positions = new Map<string, string>();
  for (const event of report.evidence) {
    if (event.kind !== "transfer" || event.assetAddress !== report.token.address) continue;
    const number = uint(event.blockNumber); uint(event.amountRaw);
    requireReplay(event.chainId === 8453 && HASH.test(event.blockHash) && HASH.test(event.transactionHash)
      && ADDRESS.test(event.from) && ADDRESS.test(event.to) && event.logIndex !== null && Number.isSafeInteger(event.logIndex) && event.logIndex >= 0
      && Number.isSafeInteger(event.transactionIndex) && event.transactionIndex >= 0 && event.traceId === null
      && Number.isSafeInteger(event.timestamp) && event.timestamp >= report.range.from.timestamp && event.timestamp <= report.range.to.timestamp
      && number >= BigInt(report.range.from.number) && number <= BigInt(report.range.to.number), "A retained token transfer has an invalid identity or lies outside the declared range.");
    const block = blocks.get(event.blockNumber);
    requireReplay(!block || block.hash === event.blockHash && block.timestamp === event.timestamp, "Retained token transfers disagree on canonical block identity.");
    blocks.set(event.blockNumber, { hash: event.blockHash, timestamp: event.timestamp });
    const canonical = evidenceId(event), logical = `${event.transactionHash}:${event.logIndex}`;
    const signature = JSON.stringify([event.blockNumber, event.blockHash, event.transactionHash, event.transactionIndex, event.logIndex, event.timestamp, event.from, event.to, event.amountRaw]);
    requireReplay(!signatures.has(logical) || signatures.get(logical) === signature, "Repeated logical token transfers conflict.");
    signatures.set(logical, signature);
    const transactionPosition = `${event.blockHash}:${event.transactionIndex}`;
    requireReplay(!positions.has(transactionPosition) || positions.get(transactionPosition) === event.transactionHash, "Two transactions occupy the same canonical transaction position.");
    positions.set(transactionPosition, event.transactionHash);
    requireReplay(!transactionPositions.has(event.transactionHash) || transactionPositions.get(event.transactionHash) === transactionPosition, "A transaction has conflicting block or transaction positions.");
    transactionPositions.set(event.transactionHash, transactionPosition);
    events.set(canonical, event); // Identical observations from different providers count once.
  }
  const orderedBlocks = [...blocks].sort(([a], [b]) => numeric(a, b));
  requireReplay(orderedBlocks.every(([, block], index) => index === 0 || block.timestamp >= orderedBlocks[index - 1][1].timestamp), "Canonical block timestamps are inconsistent.");
  const ordered = [...events.values()].sort((a, b) => numeric(a.blockNumber, b.blockNumber) || a.transactionIndex - b.transactionIndex || a.logIndex! - b.logIndex!);
  requireReplay(ordered.every((event, index) => index === 0 || ordered[index - 1].blockNumber !== event.blockNumber
    || ordered[index - 1].logIndex! < event.logIndex!), "Token log positions conflict with canonical transaction order.");
  return ordered;
}

/** Reverse complete target-token transfers from verified finalized balance anchors. */
export function reconstructHoldingReplay(report: InvestigationReport): HoldingReplay {
  const tracked = unique(report.wallets.map((wallet) => wallet.address));
  const result: HoldingReplay = { status: "unavailable", reason: null, frames: [], totalFrames: 0,
    trackedAddresses: tracked.length, knownAddresses: 0, unknownAddresses: tracked.length, anchor: null, limitations: [...LIMITATIONS] };
  try {
    requireReplay(report.coverage.transfers === "complete", "Complete target-token transfer coverage is required for this bounded window.");
    requireReplay(report.range.finality === "finalized" && report.token.chainId === 8453 && ADDRESS.test(report.token.address), "A finalized Base token identity is required.");
    requireReplay(report.holderSnapshot, "A pinned finalized holder snapshot is required.");
    let snapshot: HolderSnapshot;
    try { snapshot = validateHolderSnapshot(report.holderSnapshot, report.token, report.range.to); }
    catch { throw new ReplayInputError("The holder snapshot does not match a valid token and finalized end-block anchor."); }
    requireReplay(snapshot.totalSupplyRaw !== null, "An exact pinned total-supply anchor is required.");
    requireReplay(tracked.length > 0 && tracked.every((address) => ADDRESS.test(address) && address !== ZERO), "An eligible tracked address cohort is required.");
    const cohort = new Set(tracked);
    const balances = new Map(snapshot.holders.filter((holder) => holder.status === "verified" && cohort.has(holder.address)).map((holder) => [holder.address, BigInt(holder.balanceRaw!)]));
    requireReplay(balances.size > 0, "At least one eligible address needs a verified pinned balance anchor.");
    result.knownAddresses = balances.size; result.unknownAddresses = tracked.length - balances.size;
    const transfers = orderedTransfers(report), byBlock = new Map<string, EvidenceRecord[]>();
    for (const event of transfers) { const values = byBlock.get(event.blockNumber) ?? []; values.push(event); byBlock.set(event.blockNumber, values); }
    // Genesis is the requested full-crawl search boundary, not useful token
    // history. Keep validating/reversing every event, but display the acquired
    // token activity rather than compressing it into the end of a chain-wide axis.
    const firstTransfer = transfers[0];
    const displayStart = report.range.from.number === "0" && firstTransfer
      ? { number: firstTransfer.blockNumber, hash: firstTransfer.blockHash, timestamp: firstTransfer.timestamp }
      : report.range.from;
    const numbers = [...new Set([displayStart.number, report.range.to.number, ...byBlock.keys()])].sort(numeric);
    const selected = new Set(numbers.length <= MAX_FRAMES ? numbers : Array.from({ length: MAX_FRAMES }, (_, index) => numbers[Math.floor(index * (numbers.length - 1) / (MAX_FRAMES - 1))]));
    const groups = [...report.groups].sort((a, b) => a.id.localeCompare(b.id)).map((group) => ({ id: group.id, members: unique(group.wallets) }));
    requireReplay(groups.every((group) => group.members.every((address) => cohort.has(address))), "A retained group contains an address outside the tracked cohort.");
    let supply = uint(snapshot.totalSupplyRaw);
    const check = () => {
      let sum = 0n;
      requireReplay(supply >= 0n && supply <= MAX, "Reversed supply is negative or exceeds uint256; transfer-based replay is inconsistent.");
      for (const balance of balances.values()) { requireReplay(balance >= 0n && balance <= MAX, "A reversed balance is negative or exceeds uint256; transfer-based replay is inconsistent."); sum += balance; }
      requireReplay(sum <= supply, "Known reconstructed balances exceed reconstructed total supply.");
    };
    const frames = new Map<string, HoldingReplayFrame>();
    const capture = (block: BlockReference) => {
      if (!selected.has(block.number) || frames.has(block.number)) return;
      const ranked = [...balances].sort(([a, left], [b, right]) => left === right ? a.localeCompare(b) : left > right ? -1 : 1);
      const top10 = ranked.slice(0, 10).reduce((sum, [, balance]) => sum + balance, 0n), [largestAddress, largest] = ranked[0];
      let largestGroup: { id: string; balance: bigint; unknown: number } | null = null;
      for (const group of groups) {
        const known = group.members.filter((address) => balances.has(address));
        if (!known.length) continue;
        const balance = known.reduce((sum, address) => sum + balances.get(address)!, 0n);
        if (!largestGroup || balance > largestGroup.balance) largestGroup = { id: group.id, balance, unknown: group.members.length - known.length };
      }
      frames.set(block.number, { block: { ...block }, totalSupplyRaw: supply.toString(), top10KnownRaw: top10.toString(), largestKnownRaw: largest.toString(), largestKnownAddress: largestAddress,
        largestGroupKnownRaw: largestGroup?.balance.toString() ?? null, largestGroupId: largestGroup?.id ?? null, unknownGroupMembers: largestGroup?.unknown ?? 0,
        shares: { top10: ratio(top10, supply), largest: ratio(largest, supply), largestGroup: largestGroup ? ratio(largestGroup.balance, supply) : null } });
    };
    check(); capture(report.range.to);
    for (const [number, events] of [...byBlock].sort(([a], [b]) => numeric(b, a))) {
      const first = events[0]; capture({ number, hash: first.blockHash, timestamp: first.timestamp });
      for (const event of [...events].reverse()) {
        if (event.from === event.to) continue;
        const amount = BigInt(event.amountRaw);
        if (balances.has(event.from)) balances.set(event.from, balances.get(event.from)! + amount);
        if (balances.has(event.to)) balances.set(event.to, balances.get(event.to)! - amount);
        if (event.from === ZERO) supply -= amount;
        if (event.to === ZERO) supply += amount;
        check();
      }
      // The start frame is after its block; reversing that block validates the
      // opening accounting state but must never replace the captured frame.
      if (number === report.range.from.number) break;
    }
    capture(report.range.from);
    return { ...result, status: "available", reason: null, frames: [...frames.values()].sort((a, b) => numeric(a.block.number, b.block.number)), totalFrames: numbers.length,
      anchor: { block: { ...snapshot.block }, provenance: { ...snapshot.provenance } } };
  } catch (error) {
    if (!(error instanceof ReplayInputError)) throw error;
    return { ...result, reason: error.message };
  }
}
