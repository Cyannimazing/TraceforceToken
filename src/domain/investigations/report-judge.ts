import type { AssessmentCategoryId, ReportAssessment } from "./report-assessment";

export interface DecisionXrayRow {
  id: AssessmentCategoryId;
  label: string;
  /** A supported deduction, not awarded points, a probability or a confidence. */
  points: number;
  /** Sum of preceding deductions, in the same 100-point scale as points. */
  offset: number;
  basis: string;
  metric: string | null;
}

export interface DecisionXray {
  modelId: `traceforce-rules-${ReportAssessment["version"]}`;
  base: 100;
  rows: DecisionXrayRow[];
  totalKnownDeduction: number;
  unknownPossiblePoints: number;
  uncappedMaximum: number;
  maximum: number;
  minimum: number;
  /** Additional restriction on the bound; never attributed to a category. */
  gateCapDeduction?: number;
  overallScore: null;
  probabilities: { avoid: null; caution: null; ok: null };
}

const categoryIds = new Set<AssessmentCategoryId>(["swarm", "fresh", "insiders", "concentration", "snipers", "dev"]);

/** Preserve the ledger's decimal tenths instead of summing binary fractions. */
function sumPoints(values: readonly number[]): number {
  const tenths = values.map((value) => Math.round(value * 10));
  if (tenths.every((value, index) => Number.isSafeInteger(value) && value / 10 === values[index])) {
    return Number(tenths.reduce((sum, value) => sum + BigInt(value), 0n)) / 10;
  }
  return values.reduce((sum, value) => sum + value, 0);
}

/** Explain actual local deductions without filling in unknown scores or Judge masses. */
export function deriveDecisionXray(assessment: ReportAssessment): DecisionXray {
  const seen = new Set<AssessmentCategoryId>();
  let categoryPossiblePoints = 0;
  let knownPossiblePoints = 0;
  let knownAwardedPoints = 0;
  let unknownPossiblePoints = 0;
  let totalKnownDeduction = 0;
  const rows: DecisionXrayRow[] = [];
  for (const category of assessment.categories) {
    if (!categoryIds.has(category.id) || seen.has(category.id)
      || !Number.isFinite(category.possiblePoints) || category.possiblePoints <= 0
      || (category.points !== null && (!Number.isFinite(category.points) || category.points < 0 || category.points > category.possiblePoints))) {
      throw new RangeError("Assessment categories must be distinct and contain valid weighted points.");
    }
    seen.add(category.id);
    categoryPossiblePoints += category.possiblePoints;
    if (category.points === null) { unknownPossiblePoints += category.possiblePoints; continue; }
    knownPossiblePoints += category.possiblePoints;
    knownAwardedPoints = sumPoints([knownAwardedPoints, category.points]);
    const points = sumPoints([category.possiblePoints, -category.points]);
    if (points > 0) {
      rows.push({ id: category.id, label: category.label, points, offset: totalKnownDeduction, basis: category.basis, metric: category.metric });
      totalKnownDeduction = sumPoints([totalKnownDeduction, points]);
    }
  }
  if (assessment.possiblePoints !== 100 || seen.size !== categoryIds.size || categoryPossiblePoints !== assessment.possiblePoints
    || assessment.assessedPossiblePoints !== knownPossiblePoints || assessment.assessedPoints !== knownAwardedPoints) {
    throw new RangeError("Assessment category totals do not match its 100-point contract.");
  }
  const uncappedMaximum = sumPoints([assessment.possiblePoints, -totalKnownDeduction]);
  const { minimum, maximum } = assessment.scoreRange;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum > uncappedMaximum || minimum > maximum) {
    throw new RangeError("Assessment score bounds must fit its known deductions.");
  }
  const gateCapDeduction = sumPoints([uncappedMaximum, -maximum]);
  return {
    modelId: `traceforce-rules-${assessment.version}`,
    base: 100, rows, totalKnownDeduction, unknownPossiblePoints, uncappedMaximum, maximum, minimum,
    ...(gateCapDeduction > 0 ? { gateCapDeduction } : {}),
    overallScore: null, probabilities: { avoid: null, caution: null, ok: null },
  };
}

export const RULE_WEIGHTED_JUDGE_VERSION = "1.0.0" as const;
export type DecisionWeightKey = "avoid" | "caution" | "ok";
type DecisionMasses = Record<DecisionWeightKey, number>;
export type RuleWeightedJudgeInput = Pick<ReportAssessment, "categories" | "possiblePoints" | "scoreRange" | "gates" | "metrics" | "verdict" | "band">;

export interface RuleWeightedContribution {
  id: "base" | "decision-policy" | "dump-impact";
  label: string;
  masses: DecisionMasses;
  /** Primary channel shown by a compact X-ray row. Base retains all channels. */
  target: DecisionWeightKey;
  mass: number;
  /** Avoid mass preceding this contribution, for the X-ray waterfall. */
  avoidOffset: number;
  basis: string;
}

export interface RuleWeightedJudge {
  modelId: `traceforce-judge-${typeof RULE_WEIGHTED_JUDGE_VERSION}`;
  decision: ReportAssessment["verdict"];
  selectedWeight: DecisionWeightKey;
  /** Normalized policy weights, never calibrated probabilities. */
  weights: DecisionMasses;
  /** Weight of the policy-selected decision, not factual confidence. */
  decisionWeight: number;
  masses: DecisionMasses;
  totalMass: number;
  contributions: RuleWeightedContribution[];
  /** Integer tenths make the displayed three percentages total exactly 100%. */
  displayTenths: DecisionMasses;
  displayPercentages: Record<DecisionWeightKey, string>;
  calibrated: false;
  policy: string[];
}

const weightKeys: DecisionWeightKey[] = ["avoid", "caution", "ok"];
const emptyMasses = (): DecisionMasses => ({ avoid: 0, caution: 0, ok: 0 });

/**
 * A disclosed local policy ranking, not a reconstruction of SWARM's Judge.
 *
 * The category ledger contributes one unit: deductions support avoid, missing
 * assessments support caution, and established earned points support ok.
 * Two units then support the existing deterministic decision. That exceeds all
 * competing base support (at most one unit) and preserves warning precedence.
 * A validated dump warning adds its fractional modeled impact to avoid. This
 * is a severity adjustment, not a claim of statistically independent evidence.
 */
export function deriveRuleWeightedJudge(assessment: RuleWeightedJudgeInput): RuleWeightedJudge {
  const seen = new Set<AssessmentCategoryId>();
  let possible = 0, knownDeducted = 0, knownAwarded = 0, unknown = 0;
  for (const category of assessment.categories) {
    if (!categoryIds.has(category.id) || seen.has(category.id)
      || !Number.isFinite(category.possiblePoints) || category.possiblePoints <= 0
      || !["concern", "not_assessed", "measured"].includes(category.status)
      || category.points !== null && (!Number.isFinite(category.points) || category.points < 0 || category.points > category.possiblePoints)) {
      throw new RangeError("Judge categories must be distinct and contain valid weighted points.");
    }
    seen.add(category.id);
    possible += category.possiblePoints;
    if (category.status === "not_assessed") {
      // A requested zero display is not proof of a zero-point concern.
      if (category.points !== null && category.points !== 0) throw new RangeError("Unassessed categories cannot earn points.");
      unknown += category.possiblePoints;
    } else {
      if (category.points === null) throw new RangeError("Assessed categories must contain established points.");
      knownAwarded = sumPoints([knownAwarded, category.points]);
      knownDeducted = sumPoints([knownDeducted, category.possiblePoints, -category.points]);
    }
  }
  if (assessment.possiblePoints !== 100 || seen.size !== categoryIds.size || possible !== 100) {
    throw new RangeError("Judge category weights must total 100.");
  }
  const { minimum, maximum } = assessment.scoreRange;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || maximum > sumPoints([knownAwarded, unknown])) {
    throw new RangeError("Judge score bounds must fit the established category ledger.");
  }
  const verdict: string = assessment.verdict;
  if (!["AVOID", "CAUTION", "REVIEW", "INSUFFICIENT", "OK"].includes(verdict)
    || !["DANGER", "RISKY", "UNKNOWN", "OK", "CLEAN"].includes(assessment.band)) {
    throw new RangeError("Judge decision and band must be supported policy labels.");
  }
  const gateIds = new Set<string>();
  for (const gate of assessment.gates) {
    if (!gate.id || gateIds.has(gate.id) || !["hard", "soft"].includes(gate.severity)) {
      throw new RangeError("Judge gates must be distinct and have a supported severity.");
    }
    gateIds.add(gate.id);
  }
  const hard = assessment.gates.some((gate) => gate.severity === "hard");
  const soft = assessment.gates.some((gate) => gate.severity === "soft");
  if ((hard && verdict !== "AVOID") || (!hard && soft && verdict !== "CAUTION")) {
    throw new RangeError("Judge decisions must preserve hard and soft warning precedence.");
  }
  const selectedWeight: DecisionWeightKey = verdict === "AVOID" ? "avoid" : verdict === "OK" ? "ok" : "caution";
  const base = { avoid: knownDeducted / 100, caution: unknown / 100, ok: knownAwarded / 100 };
  const policyMasses = emptyMasses();
  policyMasses[selectedWeight] = 2;
  const contributions: RuleWeightedContribution[] = [
    {
      id: "base", label: "base avoid · category scores", masses: base, target: "avoid", mass: base.avoid, avoidOffset: 0,
      basis: "One unit from the 100-point category ledger: known deductions → avoid; unassessed weight → caution; established earned points → ok. Displayed zero for an unassessed category remains caution.",
    },
    {
      id: "decision-policy", label: hard ? "hard rule · DANGER" : soft ? "soft rule · RISKY" : `${verdict.toLowerCase()} policy`,
      masses: policyMasses, target: selectedWeight, mass: 2, avoidOffset: base.avoid,
      basis: "Two policy units preserve the deterministic verdict because competing category support is at most one unit. REVIEW and INSUFFICIENT support caution; this coefficient is local and uncalibrated.",
    },
  ];
  const impactGate = assessment.gates.find((gate) => gate.id === "dump-impact" && gate.severity === "hard");
  if (impactGate) {
    const rawImpact = assessment.metrics.dumpImpactPercent;
    const impact = rawImpact === null || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(rawImpact) ? Number.NaN : Number(rawImpact);
    if (!Number.isFinite(impact) || impact < 50 || impact > 100) {
      throw new RangeError("A dump warning must contain a modeled impact between 50% and 100%.");
    }
    contributions.push({
      id: "dump-impact", label: `modeled dump · ${rawImpact}%`, masses: { avoid: impact / 100, caution: 0, ok: 0 }, target: "avoid", mass: impact / 100, avoidOffset: base.avoid + policyMasses.avoid,
      basis: "Additional avoid severity equals the authenticated modeled dump impact divided by 100. This hypothetical impact is not an executable quote or independent probabilistic observation.",
    });
  }
  const masses = contributions.reduce((total, contribution) => {
    for (const key of weightKeys) total[key] += contribution.masses[key];
    return total;
  }, emptyMasses());
  const totalMass = weightKeys.reduce((sum, key) => sum + masses[key], 0);
  const weights = emptyMasses(), displayTenths = emptyMasses();
  for (const key of weightKeys) {
    weights[key] = masses[key] / totalMass;
    displayTenths[key] = Math.floor(weights[key] * 1000);
  }
  const remaining = 1000 - weightKeys.reduce((sum, key) => sum + displayTenths[key], 0);
  const remainderOrder = [...weightKeys].sort((a, b) => (weights[b] * 1000 - displayTenths[b]) - (weights[a] * 1000 - displayTenths[a]));
  for (let index = 0; index < remaining; index++) displayTenths[remainderOrder[index % remainderOrder.length]]++;
  const displayPercentages = { avoid: "", caution: "", ok: "" };
  for (const key of weightKeys) displayPercentages[key] = `${(displayTenths[key] / 10).toFixed(1)}%`;
  return {
    modelId: `traceforce-judge-${RULE_WEIGHTED_JUDGE_VERSION}`, decision: assessment.verdict, selectedWeight,
    weights, decisionWeight: weights[selectedWeight], masses, totalMass, contributions,
    displayTenths, displayPercentages, calibrated: false,
    policy: [
      "Local rule weights, not calibrated probabilities or a reproduction of SWARM's private mass functions.",
      "Base mass: known deducted points / 100 to avoid; unassessed possible points / 100 to caution; established earned points / 100 to ok.",
      "Decision policy: +2 mass to the deterministic verdict, with REVIEW and INSUFFICIENT mapped to caution.",
      "Authenticated hard dump warning: +modeled impact / 100 to avoid. This is a severity adjustment; evidence independence is not assumed.",
      "Normalize each mass by the total. Display tenths use largest remainders and total exactly 100.0%.",
    ],
  };
}
