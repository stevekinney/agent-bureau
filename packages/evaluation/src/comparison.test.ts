import { describe, expect, it } from 'bun:test';

import { compareEvaluationReports } from './comparison';
import type { EvaluationCaseResult, EvaluationReport } from './types';

function createCaseResult(
  overrides: Partial<EvaluationCaseResult> & { name: string },
): EvaluationCaseResult {
  return {
    tags: [],
    pass: true,
    score: 1,
    metrics: {
      outputMatch: true,
      toolCallMatch: true,
      steps: 1,
      totalTokens: 100,
      duration: 500,
      finishReason: 'stop-condition',
    },
    ...overrides,
  };
}

function createReport(
  cases: EvaluationCaseResult[],
  summaryOverrides: Partial<EvaluationReport['summary']> = {},
): EvaluationReport {
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  const failed = total - passed;
  const passRate = total > 0 ? passed / total : 0;
  const averageScore = total > 0 ? cases.reduce((s, c) => s + c.score, 0) / total : 0;
  const averageSteps = total > 0 ? cases.reduce((s, c) => s + c.metrics.steps, 0) / total : 0;
  const averageTokens =
    total > 0 ? cases.reduce((s, c) => s + c.metrics.totalTokens, 0) / total : 0;
  const averageDuration = total > 0 ? cases.reduce((s, c) => s + c.metrics.duration, 0) / total : 0;

  return {
    timestamp: new Date().toISOString(),
    cases,
    summary: {
      total,
      passed,
      failed,
      passRate,
      averageScore,
      averageSteps,
      averageTokens,
      averageDuration,
      ...summaryOverrides,
    },
  };
}

describe('compareEvaluationReports', () => {
  it('returns no regressions or improvements for identical reports', () => {
    const cases = [createCaseResult({ name: 'case-1' }), createCaseResult({ name: 'case-2' })];
    const baseline = createReport(cases);
    const current = createReport(cases);

    const comparison = compareEvaluationReports(baseline, current);

    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements).toHaveLength(0);
    expect(comparison.unchanged).toEqual(['case-1', 'case-2']);
  });

  it('detects regression when a previously passing case now fails', () => {
    const baseline = createReport([createCaseResult({ name: 'case-1', pass: true })]);
    const current = createReport([createCaseResult({ name: 'case-1', pass: false, score: 0 })]);

    const comparison = compareEvaluationReports(baseline, current);

    expect(comparison.regressions.length).toBeGreaterThan(0);
    const passRegression = comparison.regressions.find(
      (r) => r.caseName === 'case-1' && r.metric === 'pass',
    );
    expect(passRegression).toBeDefined();
    expect(passRegression!.baseline).toBe(1);
    expect(passRegression!.current).toBe(0);
  });

  it('detects improvement when a previously failing case now passes', () => {
    const baseline = createReport([createCaseResult({ name: 'case-1', pass: false, score: 0 })]);
    const current = createReport([createCaseResult({ name: 'case-1', pass: true, score: 1 })]);

    const comparison = compareEvaluationReports(baseline, current);

    expect(comparison.improvements.length).toBeGreaterThan(0);
    const passImprovement = comparison.improvements.find(
      (i) => i.caseName === 'case-1' && i.metric === 'pass',
    );
    expect(passImprovement).toBeDefined();
    expect(passImprovement!.baseline).toBe(0);
    expect(passImprovement!.current).toBe(1);
  });

  it('detects pass rate drop exceeding threshold as regression', () => {
    const baseline = createReport([
      createCaseResult({ name: 'case-1', pass: true }),
      createCaseResult({ name: 'case-2', pass: true }),
      createCaseResult({ name: 'case-3', pass: true }),
    ]);
    const current = createReport([
      createCaseResult({ name: 'case-1', pass: true }),
      createCaseResult({ name: 'case-2', pass: false, score: 0 }),
      createCaseResult({ name: 'case-3', pass: false, score: 0 }),
    ]);

    const comparison = compareEvaluationReports(baseline, current);

    const passRateRegression = comparison.regressions.find(
      (r) => r.caseName === 'summary' && r.metric === 'passRate',
    );
    expect(passRateRegression).toBeDefined();
  });

  it('does not flag pass rate drop below threshold', () => {
    const baseline = createReport(
      Array.from({ length: 100 }, (_, i) => createCaseResult({ name: `case-${i}`, pass: true })),
    );
    const currentCases = Array.from({ length: 100 }, (_, i) =>
      createCaseResult({ name: `case-${i}`, pass: i !== 99, score: i !== 99 ? 1 : 0 }),
    );
    const current = createReport(currentCases);

    const comparison = compareEvaluationReports(baseline, current);

    const passRateRegression = comparison.regressions.find(
      (r) => r.caseName === 'summary' && r.metric === 'passRate',
    );
    expect(passRateRegression).toBeUndefined();
  });

  it('uses custom thresholds when provided', () => {
    const baseline = createReport([
      createCaseResult({ name: 'case-1', pass: true }),
      createCaseResult({ name: 'case-2', pass: true }),
    ]);
    const current = createReport([
      createCaseResult({ name: 'case-1', pass: true }),
      createCaseResult({ name: 'case-2', pass: false, score: 0 }),
    ]);

    const comparison = compareEvaluationReports(baseline, current, { passRateDrop: 0.6 });

    const passRateRegression = comparison.regressions.find(
      (r) => r.caseName === 'summary' && r.metric === 'passRate',
    );
    expect(passRateRegression).toBeUndefined();
  });

  it('does not flag individual case regression when failPreviouslyPassing is false', () => {
    const baseline = createReport([createCaseResult({ name: 'case-1', pass: true })]);
    const current = createReport([createCaseResult({ name: 'case-1', pass: false, score: 0 })]);

    const comparison = compareEvaluationReports(baseline, current, {
      failPreviouslyPassing: false,
    });

    const caseRegression = comparison.regressions.find(
      (r) => r.caseName === 'case-1' && r.metric === 'pass',
    );
    expect(caseRegression).toBeUndefined();
  });

  it('does not misclassify suppressed regressions as unchanged', () => {
    const baseline = createReport([createCaseResult({ name: 'case-1', pass: true })]);
    const current = createReport([createCaseResult({ name: 'case-1', pass: false, score: 0 })]);

    const comparison = compareEvaluationReports(baseline, current, {
      failPreviouslyPassing: false,
    });

    // The case changed from pass to fail but was suppressed — it should NOT
    // appear in unchanged since its status actually changed.
    expect(comparison.unchanged).not.toContain('case-1');
  });

  it('detects cost increase exceeding threshold as regression', () => {
    const baseline = createReport([
      createCaseResult({
        name: 'case-1',
        metrics: {
          outputMatch: true,
          toolCallMatch: true,
          steps: 1,
          totalTokens: 100,
          duration: 500,
          finishReason: 'stop-condition',
        },
      }),
    ]);
    const current = createReport([
      createCaseResult({
        name: 'case-1',
        metrics: {
          outputMatch: true,
          toolCallMatch: true,
          steps: 1,
          totalTokens: 150,
          duration: 500,
          finishReason: 'stop-condition',
        },
      }),
    ]);

    const comparison = compareEvaluationReports(baseline, current, { costIncrease: 0.2 });

    const costRegression = comparison.regressions.find(
      (r) => r.caseName === 'summary' && r.metric === 'costIncrease',
    );
    expect(costRegression).toBeDefined();
    expect(costRegression!.baseline).toBe(100);
    expect(costRegression!.current).toBe(150);
    expect(costRegression!.delta).toBe(50);
  });

  it('does not flag cost increase below threshold', () => {
    const baseline = createReport([
      createCaseResult({
        name: 'case-1',
        metrics: {
          outputMatch: true,
          toolCallMatch: true,
          steps: 1,
          totalTokens: 100,
          duration: 500,
          finishReason: 'stop-condition',
        },
      }),
    ]);
    const current = createReport([
      createCaseResult({
        name: 'case-1',
        metrics: {
          outputMatch: true,
          toolCallMatch: true,
          steps: 1,
          totalTokens: 110,
          duration: 500,
          finishReason: 'stop-condition',
        },
      }),
    ]);

    const comparison = compareEvaluationReports(baseline, current, { costIncrease: 0.2 });

    const costRegression = comparison.regressions.find(
      (r) => r.caseName === 'summary' && r.metric === 'costIncrease',
    );
    expect(costRegression).toBeUndefined();
  });

  it('handles new cases in current report', () => {
    const baseline = createReport([createCaseResult({ name: 'case-1' })]);
    const current = createReport([
      createCaseResult({ name: 'case-1' }),
      createCaseResult({ name: 'case-2' }),
    ]);

    const comparison = compareEvaluationReports(baseline, current);

    expect(comparison.regressions.find((r) => r.caseName === 'case-2')).toBeUndefined();
    expect(comparison.unchanged).toContain('case-1');
  });

  it('handles removed cases in current report', () => {
    const baseline = createReport([
      createCaseResult({ name: 'case-1' }),
      createCaseResult({ name: 'case-2' }),
    ]);
    const current = createReport([createCaseResult({ name: 'case-1' })]);

    const comparison = compareEvaluationReports(baseline, current);

    expect(comparison.unchanged).toContain('case-1');
  });

  it('includes both reports in the comparison result', () => {
    const baseline = createReport([createCaseResult({ name: 'case-1' })]);
    const current = createReport([createCaseResult({ name: 'case-1' })]);

    const comparison = compareEvaluationReports(baseline, current);

    expect(comparison.baseline).toBe(baseline);
    expect(comparison.current).toBe(current);
  });

  it('computes correct delta values', () => {
    const baseline = createReport([createCaseResult({ name: 'case-1', pass: true, score: 1 })]);
    const current = createReport([createCaseResult({ name: 'case-1', pass: false, score: 0 })]);

    const comparison = compareEvaluationReports(baseline, current);
    const regression = comparison.regressions.find(
      (r) => r.caseName === 'case-1' && r.metric === 'pass',
    );

    expect(regression).toBeDefined();
    expect(regression!.delta).toBe(-1);
  });
});
