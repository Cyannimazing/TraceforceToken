import type { AssessmentCategoryId } from "./report-assessment";

/** Disclosed local thresholds, not SWARM's private conversion curves. */
export const LOCAL_CATEGORY_SCORE_POLICY = Object.freeze({
  version: "1.3.0" as const,
  saturationPercent: Object.freeze({
    swarm: "50", fresh: "100", insiders: "30", concentration: "50", snipers: "25", dev: "40",
  } satisfies Record<AssessmentCategoryId, string>),
});

function decimal(value: string): { amount: bigint; scale: bigint } {
  if (typeof value !== "string" || value.length > 96 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,78})?$/.test(value)) {
    throw new RangeError("Score percentages must be bounded nonnegative decimal strings.");
  }
  const [whole, fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  return { amount: BigInt(whole) * scale + BigInt(fraction || "0"), scale };
}

/**
 * possiblePoints × max(0, 1 − riskPercent / saturationPercent), rounded half up
 * to one decimal. Unknown measurements remain null; only an established zero
 * risk measurement earns the full category weight. Caller owns evidence and
 * coverage qualification and any category-specific concern overrides.
 */
function earnedFromRationalPercent(risk: { amount: bigint; scale: bigint } | null, possiblePoints: number, saturationPercent: string): number | null {
  if (!Number.isSafeInteger(possiblePoints) || possiblePoints <= 0 || possiblePoints > 100) {
    throw new RangeError("Category weights must be positive integers at most 100.");
  }
  const saturation = decimal(saturationPercent);
  if (saturation.amount === 0n || saturation.amount > 100n * saturation.scale) {
    throw new RangeError("Category saturation must be greater than zero and at most 100 percent.");
  }
  if (risk === null) return null;
  const denominator = saturation.amount * risk.scale;
  const remaining = denominator - risk.amount * saturation.scale;
  if (remaining <= 0n) return 0;
  const numerator = BigInt(possiblePoints) * remaining;
  const earnedTenths = (numerator * 20n + denominator) / (denominator * 2n);
  // This is bounded display credit (0–100), never a blockchain quantity.
  return Number(earnedTenths) / 10;
}

export function linearCategoryEarnedPoints(riskPercent: string | null, possiblePoints: number, saturationPercent: string): number | null {
  return earnedFromRationalPercent(riskPercent === null ? null : decimal(riskPercent), possiblePoints, saturationPercent);
}

/** Preserve exact chain fractions through credit rounding; display percentages
 * must never be fed back into scoring because they have already lost precision. */
export function linearCategoryEarnedPointsFromShare(share: readonly [bigint, bigint] | null, possiblePoints: number, saturationPercent: string): number | null {
  const valid = share !== null && share[0] >= 0n && share[1] > 0n && share[0] <= share[1];
  return earnedFromRationalPercent(valid ? { amount: share[0] * 100n, scale: share[1] } : null, possiblePoints, saturationPercent);
}

export interface EarnedCategoryLedger {
  earnedPoints: number;
  /** Nearest integer of the earned subtotal, including partial ledgers. */
  roundedScore: number;
  /** Complete only when all category measurements earned established credits. */
  overallScore: number | null;
  unknownPossiblePoints: number;
  complete: boolean;
  scoreRange: { minimum: number; maximum: number };
}

/** Sum rounded category tenths exactly, then round the total once. */
export function sumCategoryEarnedPoints(categories: readonly { points: number | null; possiblePoints: number }[]): EarnedCategoryLedger {
  let earnedTenths = 0n, unknownPoints = 0n, possiblePoints = 0n;
  for (const category of categories) {
    if (!Number.isSafeInteger(category.possiblePoints) || category.possiblePoints <= 0 || category.possiblePoints > 100) {
      throw new RangeError("Category ledger weights must be positive integers at most 100.");
    }
    possiblePoints += BigInt(category.possiblePoints);
    if (category.points === null) {
      unknownPoints += BigInt(category.possiblePoints);
      continue;
    }
    const pointsInTenths = Math.round(category.points * 10);
    if (!Number.isFinite(category.points) || category.points < 0 || category.points > category.possiblePoints
      || !Number.isSafeInteger(pointsInTenths) || pointsInTenths / 10 !== category.points) {
      throw new RangeError("Established category credits must fit their weight and use at most one decimal.");
    }
    earnedTenths += BigInt(pointsInTenths);
  }
  if (possiblePoints !== 100n) throw new RangeError("A complete category ledger must have 100 possible points.");
  const earnedPoints = Number(earnedTenths) / 10;
  const roundedScore = Number((earnedTenths + 5n) / 10n);
  const complete = unknownPoints === 0n;
  return {
    earnedPoints, roundedScore, overallScore: complete ? roundedScore : null,
    unknownPossiblePoints: Number(unknownPoints), complete,
    scoreRange: { minimum: earnedPoints, maximum: Number(earnedTenths + unknownPoints * 10n) / 10 },
  };
}
