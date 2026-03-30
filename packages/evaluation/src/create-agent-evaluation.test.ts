import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import type { GenerateResponse, RunResult } from 'operative';
import { createMockGenerate } from 'operative/test';

import { createAgentEvaluation } from './create-agent-evaluation';
import type { EvaluationCase } from './types';

function singleResponse(
  content: string,
  toolCalls: GenerateResponse['toolCalls'] = [],
): GenerateResponse {
  return { content, toolCalls, usage: { prompt: 10, completion: 5, total: 15 } };
}

describe('createAgentEvaluation', () => {
  it('runs a single case that passes with expected output', async () => {
    const generate = createMockGenerate([singleResponse('Hello, world!')]);
    const toolbox = createTestToolbox([]);

    const evaluationCase: EvaluationCase = {
      name: 'greeting',
      input: 'Say hello',
      expectedOutput: 'Hello, world!',
    };

    const evaluation = createAgentEvaluation({
      cases: [evaluationCase],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]!.name).toBe('greeting');
    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.score).toBe(1);
    expect(report.cases[0]!.metrics.outputMatch).toBe(true);
  });

  it('runs a single case that fails when output does not match', async () => {
    const generate = createMockGenerate([singleResponse('Wrong answer')]);
    const toolbox = createTestToolbox([]);

    const evaluationCase: EvaluationCase = {
      name: 'wrong-answer',
      input: 'Say hello',
      expectedOutput: 'Hello, world!',
    };

    const evaluation = createAgentEvaluation({
      cases: [evaluationCase],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.score).toBe(0);
    expect(report.cases[0]!.metrics.outputMatch).toBe(false);
  });

  it('runs multiple cases independently', async () => {
    const generate = createMockGenerate([singleResponse('pass'), singleResponse('fail')]);
    const toolbox = createTestToolbox([]);

    const cases: EvaluationCase[] = [
      { name: 'case-1', input: 'input-1', expectedOutput: 'pass' },
      { name: 'case-2', input: 'input-2', expectedOutput: 'not-fail' },
    ];

    const evaluation = createAgentEvaluation({
      cases,
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases).toHaveLength(2);
    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[1]!.pass).toBe(false);
  });

  it('preserves tags in results', async () => {
    const generate = createMockGenerate([singleResponse('ok')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'tagged', input: 'test', tags: ['smoke', 'fast'] }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.tags).toEqual(['smoke', 'fast']);
  });

  it('applies custom assert function', async () => {
    const generate = createMockGenerate([singleResponse('custom content')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'custom-assert',
          input: 'test',
          assert: (result: RunResult) => ({
            pass: result.content.includes('custom'),
            score: 0.75,
            message: 'partial credit',
          }),
        },
      ],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.score).toBe(0.75);
  });

  it('captures errors and marks case as failed', async () => {
    const generate = createMockGenerate([]);
    // createMockGenerate with empty array will throw when called
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'error-case', input: 'test' }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.error).toBeDefined();
    expect(report.cases[0]!.score).toBe(0);
  });

  it('enforces maxSteps via stop condition', async () => {
    // Agent responds without tool calls, so loop finishes in 1 step
    const generate = createMockGenerate([singleResponse('done')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'max-steps', input: 'test', maxSteps: 2 }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.metrics.steps).toBeLessThanOrEqual(2);
  });

  it('computes summary statistics correctly', async () => {
    const generate = createMockGenerate([
      singleResponse('a'),
      singleResponse('b'),
      singleResponse('c'),
    ]);
    const toolbox = createTestToolbox([]);

    const cases: EvaluationCase[] = [
      { name: 'pass-1', input: 'test', expectedOutput: 'a' },
      { name: 'fail-1', input: 'test', expectedOutput: 'wrong' },
      { name: 'pass-2', input: 'test', expectedOutput: 'c' },
    ];

    const evaluation = createAgentEvaluation({
      cases,
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.summary.total).toBe(3);
    expect(report.summary.passed).toBe(2);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.passRate).toBeCloseTo(2 / 3, 5);
  });

  it('includes a timestamp in the report', async () => {
    const generate = createMockGenerate([singleResponse('ok')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'timestamp', input: 'test' }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.timestamp).toBeDefined();
    // Verify it's a valid ISO string
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  it('records duration for each case', async () => {
    const generate = createMockGenerate([singleResponse('ok')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'duration', input: 'test' }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.metrics.duration).toBeGreaterThanOrEqual(0);
  });

  it('records token usage from the run', async () => {
    const generate = createMockGenerate([
      { content: 'ok', toolCalls: [], usage: { prompt: 100, completion: 50, total: 150 } },
    ]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'tokens', input: 'test' }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.metrics.totalTokens).toBe(150);
  });

  it('records finish reason from the run', async () => {
    const generate = createMockGenerate([singleResponse('ok')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'finish-reason', input: 'test' }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    // Without tool calls, it should hit stop-condition
    expect(report.cases[0]!.metrics.finishReason).toBeDefined();
  });

  it('handles regex expectedOutput', async () => {
    const generate = createMockGenerate([singleResponse('The answer is 42')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'regex',
          input: 'what is the answer',
          expectedOutput: /answer is \d+/,
        },
      ],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.metrics.outputMatch).toBe(true);
  });

  it('supports concurrency control', async () => {
    // Run 3 cases with concurrency 2
    const generate = createMockGenerate([
      singleResponse('a'),
      singleResponse('b'),
      singleResponse('c'),
    ]);
    const toolbox = createTestToolbox([]);

    const cases: EvaluationCase[] = [
      { name: 'case-1', input: 'test' },
      { name: 'case-2', input: 'test' },
      { name: 'case-3', input: 'test' },
    ];

    const evaluation = createAgentEvaluation({
      cases,
      agent: { generate, toolbox },
      concurrency: 2,
    });

    const report = await evaluation.run();

    expect(report.cases).toHaveLength(3);
  });

  it('computes averageDuration in summary', async () => {
    const generate = createMockGenerate([singleResponse('a'), singleResponse('b')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [
        { name: 'case-1', input: 'test' },
        { name: 'case-2', input: 'test' },
      ],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.summary.averageDuration).toBeGreaterThanOrEqual(0);
  });

  it('includes tool call match in metrics', async () => {
    const generate = createMockGenerate([
      {
        content: 'done',
        toolCalls: [{ id: 'call-1', name: 'search', arguments: { query: 'test' } }],
        usage: { prompt: 10, completion: 5, total: 15 },
      },
      singleResponse('result'),
    ]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'tool-calls',
          input: 'search for something',
          expectedToolCalls: [{ name: 'search' }],
        },
      ],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.metrics.toolCallMatch).toBe(true);
  });

  it('zeros score when output matches but tool calls do not', async () => {
    const generate = createMockGenerate([singleResponse('correct output')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'output-pass-tools-fail',
          input: 'test',
          expectedOutput: 'correct output',
          expectedToolCalls: [{ name: 'nonexistent-tool' }],
        },
      ],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.metrics.outputMatch).toBe(true);
    expect(report.cases[0]!.metrics.toolCallMatch).toBe(false);
    expect(report.cases[0]!.score).toBe(0);
  });

  it('works with AgentDefinition input', async () => {
    const generate = createMockGenerate([singleResponse('Hello from agent!')]);
    const toolbox = createTestToolbox([]);

    // Simulate an AgentDefinition-shaped object with a `run` method and `options`
    const agentDefinition = {
      name: 'test-agent',
      options: { name: 'test-agent', generate, toolbox },
      run: async () => ({
        conversation: {} as RunResult['conversation'],
        steps: [],
        content: 'Hello from agent!',
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'stop-condition' as const,
      }),
      createRun: () => ({}) as never,
    };

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'agent-def', input: 'test', expectedOutput: 'Hello from agent!' }],
      agent: agentDefinition,
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.score).toBe(1);
  });
});
