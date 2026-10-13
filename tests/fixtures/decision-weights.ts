import type { ReportAssessment } from "../../src/domain/investigations/report-assessment";

/** Independent arithmetic oracle for the documented local decision policy. */
export function expectedDecisionWeights(assessment: ReportAssessment) {
  const keys = ["avoid", "caution", "ok"] as const;
  const masses = { avoid: 0, caution: 0, ok: 0 };
  for (const category of assessment.categories) {
    if (category.status === "not_assessed") masses.caution += category.possiblePoints / 100;
    else {
      masses.avoid += (category.possiblePoints - category.points!) / 100;
      masses.ok += category.points! / 100;
    }
  }
  masses[assessment.verdict === "AVOID" ? "avoid" : "caution"] += 2;
  if (assessment.gates.some((gate) => gate.id === "dump-impact" && gate.severity === "hard")) {
    masses.avoid += Number(assessment.metrics.dumpImpactPercent) / 100;
  }
  const total = keys.reduce((sum, key) => sum + masses[key], 0);
  const weights = { avoid: masses.avoid / total, caution: masses.caution / total, ok: masses.ok / total };
  return { masses, total, weights };
}
