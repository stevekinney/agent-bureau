import { compareEvaluationReports } from './comparison';
import { createAgentEvaluation } from './create-agent-evaluation';
import { loadDataset } from './datasets';
import type {
  EvaluationCase,
  EvaluationReport,
  EvaluationSuiteOptions,
  EvaluationSuiteResult,
} from './types';

/**
 * Loads evaluation cases from one or more dataset file paths.
 * Accepts either a single path string or an array of paths.
 */
async function loadCasesFromDatasets(datasets: string | string[]): Promise<EvaluationCase[]> {
  const paths = Array.isArray(datasets) ? datasets : [datasets];
  const allCases: EvaluationCase[] = [];

  for (const path of paths) {
    const cases = await loadDataset(path);
    allCases.push(...cases);
  }

  return allCases;
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
  return JSON.parse(content) as EvaluationReport;
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

  // Compare against baseline if provided
  if (options.baseline) {
    const baselineReport = await loadBaselineReport(options.baseline);
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
