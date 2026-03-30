import { compareEvaluationReports } from './comparison';
import { createAgentEvaluation } from './create-agent-evaluation';
import { loadDataset, loadDatasets } from './datasets';
import type {
  EvaluationCase,
  EvaluationReport,
  EvaluationSuiteOptions,
  EvaluationSuiteResult,
} from './types';

/** Returns true when a path contains glob metacharacters (`*`, `?`, `{`, `[`). */
function isGlobPattern(path: string): boolean {
  return /[*?{[]/.test(path);
}

/**
 * Loads evaluation cases from one or more dataset file paths or glob patterns.
 * Literal file paths are loaded directly; glob patterns are expanded via `loadDatasets`.
 */
async function loadCasesFromDatasets(datasets: string | string[]): Promise<EvaluationCase[]> {
  const paths = Array.isArray(datasets) ? datasets : [datasets];
  const allCases: EvaluationCase[] = [];

  for (const path of paths) {
    const cases = isGlobPattern(path) ? await loadDatasets(path) : await loadDataset(path);
    allCases.push(...cases);
  }

  return allCases;
}

/** Type guard that validates the minimal shape of a baseline report. */
function isEvaluationReport(value: unknown): value is EvaluationReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['timestamp'] === 'string' &&
    Array.isArray(record['cases']) &&
    typeof record['summary'] === 'object' &&
    record['summary'] !== null
  );
}

/**
 * Loads a baseline evaluation report from a JSON file.
 */
async function loadBaselineReport(path: string): Promise<EvaluationReport> {
  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    throw new Error(`Baseline report file not found: ${path}`);
  }

  const content = await file.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in baseline file "${path}": failed to parse`);
  }

  if (!isEvaluationReport(parsed)) {
    throw new Error(
      `Baseline file "${path}" does not contain a valid EvaluationReport (missing timestamp, cases, or summary)`,
    );
  }

  return parsed;
}

/**
 * Runs a full evaluation suite: loads datasets, executes all evaluation cases,
 * optionally compares against a baseline report for regression detection, and
 * writes the report to a JSON file.
 *
 * Returns an exit code suitable for CI gating: 0 when all checks pass,
 * 1 when a regression is detected against the baseline.
 *
 * @example
 * ```ts
 * const { report, comparison, exitCode } = await runEvaluationSuite({
 *   datasets: 'datasets/basic.json',
 *   agent: { generate, toolbox },
 *   baseline: 'reports/baseline.json',
 *   output: 'reports/current.json',
 * });
 *
 * process.exit(exitCode);
 * ```
 */
export async function runEvaluationSuite(
  options: EvaluationSuiteOptions,
): Promise<EvaluationSuiteResult> {
  // Validate the baseline file early — before running the (potentially expensive)
  // evaluation — so a missing or invalid baseline surfaces immediately rather
  // than after all cases have completed. Loading it here also prevents a same-path
  // configuration (output === baseline) from overwriting the baseline before it's read.
  const baselineReport = options.baseline ? await loadBaselineReport(options.baseline) : undefined;

  const cases = await loadCasesFromDatasets(options.datasets);

  const evaluation = createAgentEvaluation({
    cases,
    agent: options.agent,
    concurrency: options.concurrency,
    embedder: options.embedder,
  });

  const report = await evaluation.run();

  // Write report to output path if specified
  if (options.output) {
    await Bun.write(options.output, JSON.stringify(report, null, 2));
  }

  // Compare against the pre-loaded baseline if provided
  if (baselineReport) {
    const comparison = compareEvaluationReports(baselineReport, report, options.thresholds);
    const hasRegressions = comparison.regressions.length > 0;

    return {
      report,
      comparison,
      exitCode: hasRegressions ? 1 : 0,
    };
  }

  return {
    report,
    exitCode: 0,
  };
}
