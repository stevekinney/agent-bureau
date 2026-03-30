import type {
  EvaluationChange,
  EvaluationComparison,
  EvaluationReport,
  RegressionThresholds,
} from './types';

const DEFAULT_PASS_RATE_DROP = 0.05;
const DEFAULT_COST_INCREASE = 0.2;

/**
 * Compares two evaluation reports and detects regressions, improvements,
 * and unchanged cases. Applies configurable thresholds for determining
 * what constitutes a regression.
 *
 * Default thresholds:
 * - Pass rate drop > 5% is a regression
 * - Total cost increase > 20% is a regression
 * - Any previously passing case that now fails is a regression
 */
export function compareEvaluationReports(
  baseline: EvaluationReport,
  current: EvaluationReport,
  thresholds?: RegressionThresholds,
): EvaluationComparison {
  const passRateDropThreshold = thresholds?.passRateDrop ?? DEFAULT_PASS_RATE_DROP;
  const costIncreaseThreshold = thresholds?.costIncrease ?? DEFAULT_COST_INCREASE;
  const failPreviouslyPassing = thresholds?.failPreviouslyPassing ?? true;

  const regressions: EvaluationChange[] = [];
  const improvements: EvaluationChange[] = [];
  const unchanged: string[] = [];

  const baselineCases = new Map(baseline.cases.map((c) => [c.name, c]));
  const currentCases = new Map(current.cases.map((c) => [c.name, c]));

  for (const [name, baselineCase] of baselineCases) {
    const currentCase = currentCases.get(name);
    if (!currentCase) continue;

    const baselinePass = baselineCase.pass ? 1 : 0;
    const currentPass = currentCase.pass ? 1 : 0;

    if (baselinePass === 1 && currentPass === 0 && failPreviouslyPassing) {
      regressions.push({
        caseName: name,
        metric: 'pass',
        baseline: baselinePass,
        current: currentPass,
        delta: currentPass - baselinePass,
      });
    } else if (baselinePass === 0 && currentPass === 1) {
      improvements.push({
        caseName: name,
        metric: 'pass',
        baseline: baselinePass,
        current: currentPass,
        delta: currentPass - baselinePass,
      });
    } else if (baselinePass === currentPass) {
      unchanged.push(name);
    }
    // When baselinePass !== currentPass but the change wasn't captured above
    // (e.g., failPreviouslyPassing is false for a pass→fail transition),
    // the case is intentionally omitted from all three lists rather than
    // being misclassified as unchanged.
  }

  // Only compare cases present in both reports — new or removed cases should
  // not skew the pass rate or cost and trigger spurious regressions.
  const matchedCaseNames = [...baselineCases.keys()].filter((name) => currentCases.has(name));

  const matchedCount = matchedCaseNames.length;
  if (matchedCount > 0) {
    const baselinePassRate =
      matchedCaseNames.filter((name) => baselineCases.get(name)!.pass).length / matchedCount;
    const currentPassRate =
      matchedCaseNames.filter((name) => currentCases.get(name)!.pass).length / matchedCount;
    const passRateDelta = currentPassRate - baselinePassRate;
    if (passRateDelta < 0 && Math.abs(passRateDelta) > passRateDropThreshold) {
      regressions.push({
        caseName: 'summary',
        metric: 'passRate',
        baseline: baselinePassRate,
        current: currentPassRate,
        delta: passRateDelta,
      });
    }
  }
  const baselineTotalCost = matchedCaseNames.reduce(
    (sum, name) => sum + baselineCases.get(name)!.metrics.totalTokens,
    0,
  );
  const currentTotalCost = matchedCaseNames.reduce(
    (sum, name) => sum + currentCases.get(name)!.metrics.totalTokens,
    0,
  );

  if (baselineTotalCost > 0) {
    const costIncreaseRatio = (currentTotalCost - baselineTotalCost) / baselineTotalCost;
    if (costIncreaseRatio > costIncreaseThreshold) {
      regressions.push({
        caseName: 'summary',
        metric: 'costIncrease',
        baseline: baselineTotalCost,
        current: currentTotalCost,
        delta: currentTotalCost - baselineTotalCost,
      });
    }
  }

  return {
    baseline,
    current,
    regressions,
    improvements,
    unchanged,
  };
}
