import type { RunResult } from 'operative';

import { createLLMJudge } from './llm-judge';
import { deepEqual, extractToolCallSequence } from './metrics';
import type {
  EvaluationCaseResult,
  GoldenTrajectoryStep,
  LLMJudgeOptions,
  LLMJudgeResult,
  TrajectoryMatchResult,
  TrajectoryMetricDelta,
  TrajectoryRegressionReport,
  TrajectoryRegressionThresholds,
  TrajectoryStepMatch,
  TrajectoryTolerance,
} from './types';

const DEFAULT_REORDER_TOLERANCE = 0;
const REORDER_PENALTY_WEIGHT = 0.5;
const EXTRA_CALL_PENALTY_WEIGHT = 0.25;

/**
 * Greedily assigns each golden step to the earliest unconsumed actual call
 * matching its name (and arguments, when specified). This mirrors the
 * first-fit strategy `matchToolCalls` already uses for unordered matching —
 * each actual call can satisfy at most one golden step.
 */
function assignGoldenSteps(
  actualCalls: Array<{ name: string; arguments: unknown }>,
  golden: GoldenTrajectoryStep[],
): Array<number | undefined> {
  const consumed = new Set<number>();
  const assignments: Array<number | undefined> = [];

  for (const step of golden) {
    const foundIndex = actualCalls.findIndex((call, index) => {
      if (consumed.has(index)) return false;
      if (call.name !== step.name) return false;
      if (step.arguments && !deepEqual(call.arguments, step.arguments)) return false;
      return true;
    });

    if (foundIndex === -1) {
      assignments.push(undefined);
    } else {
      consumed.add(foundIndex);
      assignments.push(foundIndex);
    }
  }

  return assignments;
}

/**
 * Scores an actual tool-call trajectory (extracted from a `RunResult`)
 * against an ordered golden path, under configurable tolerance for extra
 * calls and reordering.
 *
 * This is a purely deterministic, objective check — it compares tool names,
 * arguments, order, and counts. For subjective judgments about the
 * trajectory (e.g. "was this a sensible path?"), use
 * `judgeTrajectoryQuality`, which routes through the package's existing
 * LLM-judge seam instead of duplicating judging logic here.
 *
 * Matching: each golden step is assigned to the earliest unconsumed actual
 * call with a matching name (and arguments, if specified) — the same
 * first-fit strategy `matchToolCalls` uses. A golden step with no match is a
 * "missing call" and always fails the trajectory. Assigned actual indexes
 * are then scanned in golden order against a running maximum: any step
 * whose assigned index does not exceed the running maximum is "reordered"
 * relative to the steps already accepted in order. Actual calls never
 * assigned to a golden step are "extra calls".
 */
export function matchTrajectory(
  result: RunResult,
  golden: GoldenTrajectoryStep[],
  tolerance?: TrajectoryTolerance,
): TrajectoryMatchResult {
  const allowExtraCalls = tolerance?.allowExtraCalls ?? true;
  const maxExtraCalls = tolerance?.maxExtraCalls ?? (allowExtraCalls ? Infinity : 0);
  const reorderTolerance = tolerance?.reorderTolerance ?? DEFAULT_REORDER_TOLERANCE;

  const actualCalls = extractToolCallSequence(result);

  if (golden.length === 0) {
    return {
      pass: true,
      score: 1,
      message: 'No golden trajectory provided; case passed by default',
      steps: [],
      missingCallCount: 0,
      extraCallCount: 0,
      reorderedCount: 0,
    };
  }

  const assignments = assignGoldenSteps(actualCalls, golden);

  const steps: TrajectoryStepMatch[] = [];
  let runningMax = -1;
  let missingCallCount = 0;
  let reorderedCount = 0;

  golden.forEach((goldenStep, goldenIndex) => {
    const actualIndex = assignments[goldenIndex];

    if (actualIndex === undefined) {
      missingCallCount += 1;
      steps.push({
        goldenIndex,
        name: goldenStep.name,
        matched: false,
        reordered: false,
      });
      return;
    }

    const reordered = actualIndex <= runningMax;
    if (reordered) {
      reorderedCount += 1;
    } else {
      runningMax = actualIndex;
    }

    const actualCall = actualCalls[actualIndex];
    const argumentsMatch = goldenStep.arguments
      ? deepEqual(actualCall?.arguments, goldenStep.arguments)
      : undefined;

    steps.push({
      goldenIndex,
      name: goldenStep.name,
      matched: true,
      actualIndex,
      reordered,
      argumentsMatch,
    });
  });

  const consumedCount = assignments.filter((index) => index !== undefined).length;
  const extraCallCount = actualCalls.length - consumedCount;
  const extraCallsOk = extraCallCount <= maxExtraCalls;

  const pass = missingCallCount === 0 && reorderedCount <= reorderTolerance && extraCallsOk;

  const reorderedRatio = reorderedCount / golden.length;
  const extraRatio = extraCallCount / Math.max(actualCalls.length, 1);
  const score =
    missingCallCount > 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            1 -
              reorderedRatio * REORDER_PENALTY_WEIGHT -
              (allowExtraCalls
                ? extraRatio * EXTRA_CALL_PENALTY_WEIGHT
                : extraCallCount > 0
                  ? 1
                  : 0),
          ),
        );

  const messageParts: string[] = [];
  if (missingCallCount > 0) messageParts.push(`${missingCallCount} golden step(s) not called`);
  if (reorderedCount > 0) messageParts.push(`${reorderedCount} step(s) out of order`);
  if (extraCallCount > 0) messageParts.push(`${extraCallCount} extra call(s)`);
  const message =
    messageParts.length === 0
      ? 'Trajectory matched the golden path exactly'
      : `Trajectory deviated from the golden path: ${messageParts.join(', ')}`;

  return {
    pass,
    score,
    message,
    steps,
    missingCallCount,
    extraCallCount,
    reorderedCount,
  };
}

/**
 * Renders a `RunResult`'s tool-call trajectory as a readable, ordered list
 * for subjective LLM judging (e.g. "was this an efficient/sensible path?").
 * Objective properties — order, extra calls, argument equality — are
 * deterministic and handled by `matchTrajectory`; this is only for
 * judge-consumed prose.
 */
export function describeTrajectory(result: RunResult): string {
  const calls = extractToolCallSequence(result);
  if (calls.length === 0) return '(no tool calls)';
  return calls
    .map((call, index) => `${index + 1}. ${call.name}(${JSON.stringify(call.arguments)})`)
    .join('\n');
}

/**
 * Scores the SUBJECTIVE quality of a trajectory (e.g. efficiency or
 * sensibility of the path taken) using an LLM judge. Objective
 * properties — order, missing/extra calls, argument equality — are
 * deterministic and must go through `matchTrajectory` instead; this
 * function exists only for genuinely subjective judgments, and reuses the
 * package's existing judge seam (`createLLMJudge`) rather than introducing
 * a second judging mechanism.
 */
export function judgeTrajectoryQuality(
  options: LLMJudgeOptions,
  input: string,
  result: RunResult,
  golden?: GoldenTrajectoryStep[],
): Promise<LLMJudgeResult> {
  const judge = createLLMJudge(options);
  const reference = golden?.map((step, index) => `${index + 1}. ${step.name}`).join('\n');

  return judge(input, describeTrajectory(result), reference);
}

/**
 * Compares baseline and current step count.
 */
function compareStepCount(
  baseline: EvaluationCaseResult,
  current: EvaluationCaseResult,
  maxStepIncrease: number,
): TrajectoryMetricDelta {
  const delta = current.metrics.steps - baseline.metrics.steps;
  return {
    baseline: baseline.metrics.steps,
    current: current.metrics.steps,
    delta,
    regressed: delta > maxStepIncrease,
  };
}

/**
 * Compares baseline and current total token cost. Mirrors
 * `compareEvaluationReports`'s cost-regression guard: when the baseline is
 * zero, a ratio can't be computed, so no regression is reported.
 */
function compareCost(
  baseline: EvaluationCaseResult,
  current: EvaluationCaseResult,
  maxCostIncreaseRatio: number,
): TrajectoryMetricDelta {
  const baselineTokens = baseline.metrics.totalTokens;
  const currentTokens = current.metrics.totalTokens;
  const delta = currentTokens - baselineTokens;
  const regressed = baselineTokens > 0 && delta / baselineTokens > maxCostIncreaseRatio;

  return {
    baseline: baselineTokens,
    current: currentTokens,
    delta,
    regressed,
  };
}

/**
 * Computes a per-case step-count and cost regression report comparing a
 * baseline evaluation case result against a current one. This is a
 * deterministic, objective check — separate from `compareEvaluationReports`,
 * which aggregates across an entire suite rather than reporting per-case
 * step/cost deltas.
 */
export function computeTrajectoryRegression(
  baseline: EvaluationCaseResult,
  current: EvaluationCaseResult,
  thresholds?: TrajectoryRegressionThresholds,
): TrajectoryRegressionReport {
  const maxStepIncrease = thresholds?.maxStepIncrease ?? 0;
  const maxCostIncreaseRatio = thresholds?.maxCostIncreaseRatio ?? 0.2;

  const stepCount = compareStepCount(baseline, current, maxStepIncrease);
  const cost = compareCost(baseline, current, maxCostIncreaseRatio);

  return {
    caseName: current.name,
    stepCount,
    cost,
    regressed: stepCount.regressed || cost.regressed,
  };
}
