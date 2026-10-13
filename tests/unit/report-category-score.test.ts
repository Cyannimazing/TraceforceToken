import assert from "node:assert/strict";
import test from "node:test";
import { linearCategoryEarnedPoints, linearCategoryEarnedPointsFromShare, LOCAL_CATEGORY_SCORE_POLICY, sumCategoryEarnedPoints } from "../../src/domain/investigations/report-category-score";

test("local category thresholds are immutable and independently versioned", () => {
  assert.equal(LOCAL_CATEGORY_SCORE_POLICY.version, "1.3.0");
  assert.deepEqual(LOCAL_CATEGORY_SCORE_POLICY.saturationPercent, { swarm: "50", fresh: "100", insiders: "30", concentration: "50", snipers: "25", dev: "40" });
  assert.equal(Object.isFrozen(LOCAL_CATEGORY_SCORE_POLICY), true);
  assert.equal(Object.isFrozen(LOCAL_CATEGORY_SCORE_POLICY.saturationPercent), true);
});

test("missing measurements remain null while established zero risk earns the full weight", () => {
  for (const [weight, saturation] of [[30, "50"], [20, "100"], [15, "30"], [15, "50"], [10, "25"], [10, "40"]] as const) {
    assert.equal(linearCategoryEarnedPoints(null, weight, saturation), null);
    assert.equal(linearCategoryEarnedPoints("0", weight, saturation), weight);
    assert.equal(linearCategoryEarnedPoints("0.000000000000000000", weight, saturation), weight);
    assert.equal(linearCategoryEarnedPoints(saturation, weight, saturation), 0);
    assert.equal(linearCategoryEarnedPoints("100", weight, saturation), 0);
  }
});

test("earned credits decrease monotonically as measured risk increases", () => {
  for (const [weight, saturation] of [[30, "50"], [20, "100"], [15, "30"], [15, "50"], [10, "25"], [10, "40"]] as const) {
    let previous: number = weight;
    for (let risk = 0; risk <= 100; risk++) {
      const earned = linearCategoryEarnedPoints(String(risk), weight, saturation)!;
      assert.ok(earned <= previous && earned >= 0 && earned <= weight);
      previous = earned;
    }
  }
});

test("rounding distinguishes exact decimal values on either side of a half tenth", () => {
  assert.equal(linearCategoryEarnedPoints("99.5", 10, "100"), 0.1);
  assert.equal(linearCategoryEarnedPoints("99.5000000000000000000000000000000000001", 10, "100"), 0);
  assert.equal(linearCategoryEarnedPoints("99.4999999999999999999999999999999999999", 10, "100"), 0.1);
  assert.equal(linearCategoryEarnedPoints("98.5", 10, "100"), 0.2);
  assert.equal(linearCategoryEarnedPoints("0.5", 10, "100"), 10);
});

test("fractional saturation and very precise risk use exact rational arithmetic", () => {
  assert.equal(linearCategoryEarnedPoints("0.125", 10, "0.25"), 5);
  assert.equal(linearCategoryEarnedPoints("0.249999999999999999999999999999999999", 10, "0.25"), 0);
  assert.equal(linearCategoryEarnedPoints("123456789012345678901234567890", 10, "40"), 0);
});

test("chain fractions are scored before display truncation even one raw unit beyond a rounding boundary", () => {
  const supply = 10n ** 72n;
  assert.equal(linearCategoryEarnedPointsFromShare([supply / 500n, supply], 10, "40"), 10);
  assert.equal(linearCategoryEarnedPointsFromShare([supply / 500n + 1n, supply], 10, "40"), 9.9);
  assert.equal(linearCategoryEarnedPointsFromShare([995000001n, 1000000000n], 10, "100"), 0);
  assert.equal(linearCategoryEarnedPoints("99.50", 10, "100"), 0.1);
  assert.equal(linearCategoryEarnedPointsFromShare([0n, supply], 10, "40"), 10);
  for (const share of [null, [0n, 0n], [-1n, supply], [supply + 1n, supply]] as const) assert.equal(linearCategoryEarnedPointsFromShare(share, 10, "40"), null);
});

test("invalid decimals, weights and saturation cannot yield numeric credits", () => {
  for (const risk of ["-1", "01", "1.", ".1", "NaN", "Infinity", "1e-7", " 0", "0 ", "1.2.3", "0." + "1".repeat(79), "1".repeat(97)]) {
    assert.throws(() => linearCategoryEarnedPoints(risk, 10, "40"), RangeError);
  }
  for (const weight of [0, -1, 1.1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => linearCategoryEarnedPoints("0", weight, "40"), RangeError);
  }
  for (const saturation of ["0", "0.0", "-1", "100.0000000000001", "Infinity"]) {
    assert.throws(() => linearCategoryEarnedPoints("0", 10, saturation), RangeError);
    assert.throws(() => linearCategoryEarnedPoints(null, 10, saturation), RangeError);
  }
});

test("category tenths sum before the overall nearest-integer rounding", () => {
  const ledger = [
    { possiblePoints: 30, points: 0 }, { possiblePoints: 20, points: 20 },
    { possiblePoints: 15, points: 15 }, { possiblePoints: 15, points: 0 },
    { possiblePoints: 10, points: 0.6 }, { possiblePoints: 10, points: 9.2 },
  ];
  const before = structuredClone(ledger), result = sumCategoryEarnedPoints(ledger);
  assert.deepEqual(result, { earnedPoints: 44.8, roundedScore: 45, overallScore: 45, unknownPossiblePoints: 0, complete: true, scoreRange: { minimum: 44.8, maximum: 44.8 } });
  ledger[5].points = 8.9;
  assert.equal(sumCategoryEarnedPoints(ledger).roundedScore, 45, "44.5 rounds half up");
  ledger[5].points = 8.8;
  assert.equal(sumCategoryEarnedPoints(ledger).roundedScore, 44);
  assert.deepEqual(before[5], { possiblePoints: 10, points: 9.2 });
});

test("partial earned totals retain the full unknown range without an exact overall score", () => {
  const categories = [
    { possiblePoints: 30, points: 0 }, { possiblePoints: 20, points: 20 },
    { possiblePoints: 15, points: null }, { possiblePoints: 15, points: 0 },
    { possiblePoints: 10, points: 0.6 }, { possiblePoints: 10, points: 9.2 },
  ];
  const before = structuredClone(categories), result = sumCategoryEarnedPoints(categories);
  assert.deepEqual(result, { earnedPoints: 29.8, roundedScore: 30, overallScore: null, unknownPossiblePoints: 15, complete: false, scoreRange: { minimum: 29.8, maximum: 44.8 } });
  assert.deepEqual(categories, before);
  for (const category of categories) category.points = null;
  assert.deepEqual(sumCategoryEarnedPoints(categories), { earnedPoints: 0, roundedScore: 0, overallScore: null, unknownPossiblePoints: 100, complete: false, scoreRange: { minimum: 0, maximum: 100 } });
});

test("every valid decimal tenth is accepted without floating multiplication drift", () => {
  for (let tenths = 0; tenths <= 1000; tenths++) {
    const points = tenths / 10;
    const result = sumCategoryEarnedPoints([{ possiblePoints: 100, points }]);
    assert.equal(result.earnedPoints, points);
    assert.equal(result.roundedScore, Math.floor((tenths + 5) / 10));
  }
  assert.equal(sumCategoryEarnedPoints([{ possiblePoints: 50, points: 0.1 }, { possiblePoints: 50, points: 0.2 }]).earnedPoints, 0.3);
});

test("malformed category sums and fractional credits are rejected", () => {
  for (const categories of [
    [], [{ possiblePoints: 99, points: 0 }], [{ possiblePoints: 101, points: 0 }],
    [{ possiblePoints: 100, points: 100.1 }], [{ possiblePoints: 100, points: -1 }],
    [{ possiblePoints: 100, points: 0.01 }], [{ possiblePoints: 100, points: Number.NaN }],
    [{ possiblePoints: 100, points: Number.POSITIVE_INFINITY }],
  ]) assert.throws(() => sumCategoryEarnedPoints(categories), RangeError);
});
