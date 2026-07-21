import { describe, expect, it } from 'bun:test';
import type { GenerateFunction, JSONValue, RunResult, StepResult } from 'operative';

import {
  computeTrajectoryRegression,
  describeTrajectory,
  judgeTrajectoryQuality,
  matchTrajectory,
} from './trajectory';
import type { EvaluationCaseResult, GoldenTrajectoryStep } from './types';

function createMockRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    content: '',
    conversation: {} as RunResult['conversation'],
    steps: [],
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop-condition',
    ...overrides,
  };
}

function createMockStep(
  toolCalls: Array<{ name: string; arguments?: Record<string, JSONValue> }> = [],
): StepResult {
  return {
    step: 1,
    conversation: {} as StepResult['conversation'],
    content: '',
    toolCalls: toolCalls.map((tc) => ({
      id: `call-${tc.name}`,
      name: tc.name,
      arguments: (tc.arguments ?? {}) as JSONValue,
    })),
    results: [],
    final: false,
  };
}

function createCaseResult(overrides: Partial<EvaluationCaseResult> = {}): EvaluationCaseResult {
  return {
    name: 'case',
    tags: [],
    pass: true,
    score: 1,
    metrics: {
      outputMatch: true,
      toolCallMatch: true,
      steps: 3,
      totalTokens: 100,
      duration: 10,
      finishReason: 'stop-condition',
    },
    ...overrides,
  };
}

describe('matchTrajectory', () => {
  it('passes with score 1 when the golden path matches exactly', () => {
    const steps = [createMockStep([{ name: 'search' }, { name: 'summarize' }, { name: 'save' }])];
    const golden: GoldenTrajectoryStep[] = [
      { name: 'search' },
      { name: 'summarize' },
      { name: 'save' },
    ];
    const result = matchTrajectory(createMockRunResult({ steps }), golden);

    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
    expect(result.missingCallCount).toBe(0);
    expect(result.extraCallCount).toBe(0);
    expect(result.reorderedCount).toBe(0);
    expect(result.steps.every((s) => s.matched && !s.reordered)).toBe(true);
  });

  it('checks arguments when provided in the golden step', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'test' } }])];
    const golden: GoldenTrajectoryStep[] = [{ name: 'search', arguments: { query: 'test' } }];
    const result = matchTrajectory(createMockRunResult({ steps }), golden);

    expect(result.pass).toBe(true);
    expect(result.steps[0]?.argumentsMatch).toBe(true);
  });

  it('passes by default when the golden path is empty', () => {
    const result = matchTrajectory(createMockRunResult(), []);
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails when a golden step is never called', () => {
    const steps = [createMockStep([{ name: 'search' }])];
    const golden: GoldenTrajectoryStep[] = [{ name: 'search' }, { name: 'summarize' }];
    const result = matchTrajectory(createMockRunResult({ steps }), golden);

    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.missingCallCount).toBe(1);
    expect(result.steps[1]).toMatchObject({ name: 'summarize', matched: false });
  });

  describe('reordering tolerance', () => {
    it('fails a swapped pair under strict (default) order', () => {
      // golden: A, B, C — actual: B, A, C (A and B swapped)
      const steps = [createMockStep([{ name: 'B' }, { name: 'A' }, { name: 'C' }])];
      const golden: GoldenTrajectoryStep[] = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden);

      expect(result.reorderedCount).toBe(1);
      expect(result.pass).toBe(false);
    });

    it('passes the same swapped pair when reorderTolerance covers it', () => {
      const steps = [createMockStep([{ name: 'B' }, { name: 'A' }, { name: 'C' }])];
      const golden: GoldenTrajectoryStep[] = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden, {
        reorderTolerance: 1,
      });

      expect(result.reorderedCount).toBe(1);
      expect(result.pass).toBe(true);
      // Score should reflect the reorder penalty even though it passes.
      expect(result.score).toBeLessThan(1);
      expect(result.score).toBeGreaterThan(0);
    });
  });

  describe('extra-call handling', () => {
    it('allows and penalizes extra calls by default', () => {
      const steps = [
        createMockStep([{ name: 'search' }, { name: 'unexpected' }, { name: 'save' }]),
      ];
      const golden: GoldenTrajectoryStep[] = [{ name: 'search' }, { name: 'save' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden);

      expect(result.extraCallCount).toBe(1);
      expect(result.pass).toBe(true);
      expect(result.score).toBeLessThan(1);
    });

    it('fails when allowExtraCalls is false and an extra call occurs', () => {
      const steps = [
        createMockStep([{ name: 'search' }, { name: 'unexpected' }, { name: 'save' }]),
      ];
      const golden: GoldenTrajectoryStep[] = [{ name: 'search' }, { name: 'save' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden, {
        allowExtraCalls: false,
      });

      expect(result.pass).toBe(false);
    });

    it('passes without a score penalty when extra calls are disallowed but none occur', () => {
      const steps = [createMockStep([{ name: 'search' }, { name: 'save' }])];
      const golden: GoldenTrajectoryStep[] = [{ name: 'search' }, { name: 'save' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden, {
        allowExtraCalls: false,
      });

      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
      expect(result.extraCallCount).toBe(0);
    });

    it('fails when extra calls exceed maxExtraCalls', () => {
      const steps = [
        createMockStep([
          { name: 'search' },
          { name: 'unexpected-1' },
          { name: 'unexpected-2' },
          { name: 'save' },
        ]),
      ];
      const golden: GoldenTrajectoryStep[] = [{ name: 'search' }, { name: 'save' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden, {
        maxExtraCalls: 1,
      });

      expect(result.extraCallCount).toBe(2);
      expect(result.pass).toBe(false);
    });

    it('passes when extra calls are within maxExtraCalls', () => {
      const steps = [
        createMockStep([{ name: 'search' }, { name: 'unexpected' }, { name: 'save' }]),
      ];
      const golden: GoldenTrajectoryStep[] = [{ name: 'search' }, { name: 'save' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden, {
        maxExtraCalls: 1,
      });

      expect(result.pass).toBe(true);
    });

    it('keeps allowExtraCalls: false authoritative even when maxExtraCalls also permits extras', () => {
      const steps = [
        createMockStep([{ name: 'search' }, { name: 'unexpected' }, { name: 'save' }]),
      ];
      const golden: GoldenTrajectoryStep[] = [{ name: 'search' }, { name: 'save' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden, {
        allowExtraCalls: false,
        maxExtraCalls: 1,
      });

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
    });

    it('enforces allowExtraCalls: false against an empty golden trajectory', () => {
      const steps = [createMockStep([{ name: 'unexpected' }])];
      const result = matchTrajectory(createMockRunResult({ steps }), [], {
        allowExtraCalls: false,
      });

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.extraCallCount).toBe(1);
    });

    it('still passes an empty golden trajectory with no calls when extras are disallowed', () => {
      const result = matchTrajectory(createMockRunResult(), [], {
        allowExtraCalls: false,
      });

      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
      expect(result.extraCallCount).toBe(0);
    });
  });

  describe('duplicate tool names', () => {
    it('prefers an in-order match over consuming an earlier duplicate', () => {
      // actual: B, A, B — golden: A, B
      // A matches at index 1, B matches at index 2 (in order); the earlier
      // B at index 0 becomes an extra call rather than causing a spurious
      // reorder.
      const steps = [createMockStep([{ name: 'B' }, { name: 'A' }, { name: 'B' }])];
      const golden: GoldenTrajectoryStep[] = [{ name: 'A' }, { name: 'B' }];
      const result = matchTrajectory(createMockRunResult({ steps }), golden);

      expect(result.reorderedCount).toBe(0);
      expect(result.extraCallCount).toBe(1);
      expect(result.pass).toBe(true);
      expect(result.steps[0]).toMatchObject({ name: 'A', actualIndex: 1, reordered: false });
      expect(result.steps[1]).toMatchObject({ name: 'B', actualIndex: 2, reordered: false });
    });
  });
});

describe('describeTrajectory', () => {
  it('renders an ordered, readable list of tool calls', () => {
    const steps = [createMockStep([{ name: 'search', arguments: { query: 'test' } }])];
    const description = describeTrajectory(createMockRunResult({ steps }));

    expect(description).toBe('1. search({"query":"test"})');
  });

  it('renders a placeholder when there are no tool calls', () => {
    const description = describeTrajectory(createMockRunResult());
    expect(description).toBe('(no tool calls)');
  });
});

describe('judgeTrajectoryQuality', () => {
  it('delegates to the judge seam with a rendered trajectory as output', async () => {
    let capturedOutput = '';
    const mockJudge: GenerateFunction = async (context) => {
      const messages = context.conversation.getMessages();
      const userMessage = messages[messages.length - 1];
      const content =
        userMessage && typeof userMessage.content === 'string' ? userMessage.content : '';
      capturedOutput = content;
      return {
        content: JSON.stringify({ score: 4, reasoning: 'Sensible path' }),
        toolCalls: [],
      };
    };

    const steps = [createMockStep([{ name: 'search' }, { name: 'save' }])];
    const result = await judgeTrajectoryQuality(
      { judge: mockJudge, rubric: 'Rate whether the path taken was efficient' },
      'Find and save the report',
      createMockRunResult({ steps }),
      [{ name: 'search' }, { name: 'save' }],
    );

    expect(result.score).toBe(4);
    expect(result.reasoning).toBe('Sensible path');
    expect(capturedOutput).toContain('1. search({})');
    expect(capturedOutput).toContain('2. save({})');
    expect(capturedOutput).toContain('Reference answer: 1. search\n2. save');
  });
});

describe('computeTrajectoryRegression', () => {
  it('reports no regression when step count and cost are unchanged', () => {
    const baseline = createCaseResult({ name: 'case-a' });
    const current = createCaseResult({ name: 'case-a' });
    const report = computeTrajectoryRegression(baseline, current);

    expect(report.regressed).toBe(false);
    expect(report.stepCount).toEqual({ baseline: 3, current: 3, delta: 0, regressed: false });
    expect(report.cost).toEqual({ baseline: 100, current: 100, delta: 0, regressed: false });
  });

  it('reports a step-count regression when steps increase beyond the threshold', () => {
    const baseline = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, steps: 3 },
    });
    const current = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, steps: 5 },
    });
    const report = computeTrajectoryRegression(baseline, current);

    expect(report.stepCount.regressed).toBe(true);
    expect(report.stepCount.delta).toBe(2);
    expect(report.regressed).toBe(true);
  });

  it('reports a cost regression when tokens increase beyond the ratio threshold', () => {
    const baseline = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, totalTokens: 100 },
    });
    const current = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, totalTokens: 150 },
    });
    const report = computeTrajectoryRegression(baseline, current, { maxCostIncreaseRatio: 0.2 });

    expect(report.cost.regressed).toBe(true);
    expect(report.cost.delta).toBe(50);
    expect(report.regressed).toBe(true);
  });

  it('does not report a cost regression within the ratio threshold', () => {
    const baseline = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, totalTokens: 100 },
    });
    const current = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, totalTokens: 110 },
    });
    const report = computeTrajectoryRegression(baseline, current, { maxCostIncreaseRatio: 0.2 });

    expect(report.cost.regressed).toBe(false);
  });

  it('does not report a cost regression when baseline cost is zero', () => {
    const baseline = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, totalTokens: 0 },
    });
    const current = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, totalTokens: 10 },
    });
    const report = computeTrajectoryRegression(baseline, current);

    expect(report.cost.regressed).toBe(false);
  });

  it('respects a custom maxStepIncrease threshold', () => {
    const baseline = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, steps: 3 },
    });
    const current = createCaseResult({
      name: 'case-a',
      metrics: { ...createCaseResult().metrics, steps: 4 },
    });
    const report = computeTrajectoryRegression(baseline, current, { maxStepIncrease: 1 });

    expect(report.stepCount.regressed).toBe(false);
    expect(report.regressed).toBe(false);
  });
});
