import { createMockTool, createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import type { GenerateResponse, JSONValue, RunResult, StepResult } from 'operative';
import { createMockGenerate } from 'operative/test';

import { createAgentEvaluation } from './create-agent-evaluation';
import { promoteRunToCase } from './promote-run';
import type { EvaluationCase } from './types';

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

function createMockRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    content: '',
    conversation: {} as RunResult['conversation'],
    steps: [],
    usage: { prompt: 10, completion: 5, total: 15 },
    finishReason: 'stop-condition',
    ...overrides,
  };
}

const sourceCase: EvaluationCase = {
  name: 'checkout-flow',
  input: 'Check out my cart',
  tags: ['checkout'],
};

describe('promoteRunToCase', () => {
  it('snapshots the run content as expectedOutput by default', () => {
    const runResult = createMockRunResult({ content: 'Your order has shipped.' });

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'report-2026-01-01T00:00:00.000Z:checkout-flow',
    });

    expect(promoted.expectedOutput).toBe('Your order has shipped.');
  });

  it('uses an explicit expectedOutput override instead of the run content', () => {
    const runResult = createMockRunResult({ content: 'I could not complete the checkout.' });

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'production-failure',
      runId: 'run-42',
      expectedOutput: 'Your order has shipped.',
    });

    expect(promoted.expectedOutput).toBe('Your order has shipped.');
  });

  it('snapshots the tool-call sequence as ordered expectedToolCalls', () => {
    const runResult = createMockRunResult({
      steps: [
        createMockStep([{ name: 'lookup-cart' }]),
        createMockStep([{ name: 'charge-card', arguments: { amount: 42 } }]),
      ],
    });

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-1',
    });

    expect(promoted.expectedToolCalls).toEqual([
      { name: 'lookup-cart', index: 0, arguments: {} },
      { name: 'charge-card', index: 1, arguments: { amount: 42 } },
    ]);
  });

  it('sets expectedToolCallCount to the recorded call count, locking the trajectory length', () => {
    const runResult = createMockRunResult({
      steps: [
        createMockStep([{ name: 'lookup-cart' }]),
        createMockStep([{ name: 'charge-card', arguments: { amount: 42 } }]),
      ],
    });

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-1',
    });

    expect(promoted.expectedToolCallCount).toBe(2);
  });

  it('omits arguments for a non-object tool-call argument value', () => {
    const runResult = createMockRunResult({
      steps: [createMockStep([{ name: 'lookup-cart' }])],
    });
    // Force a non-object arguments value the way a malformed tool call could.
    (runResult.steps[0]!.toolCalls[0] as { arguments: unknown }).arguments = 'not-an-object';

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-1',
    });

    expect(promoted.expectedToolCalls).toEqual([{ name: 'lookup-cart', index: 0 }]);
  });

  it('carries over input, systemPrompt, maxSteps, timeout, and tags from the source case', () => {
    const detailedSourceCase: EvaluationCase = {
      name: 'detailed-case',
      input: 'Do the thing',
      systemPrompt: 'Be terse.',
      maxSteps: 4,
      timeout: 5_000,
      tags: ['smoke'],
    };
    const runResult = createMockRunResult({ content: 'Done.' });

    const promoted = promoteRunToCase({
      sourceCase: detailedSourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-2',
    });

    expect(promoted.input).toBe('Do the thing');
    expect(promoted.systemPrompt).toBe('Be terse.');
    expect(promoted.maxSteps).toBe(4);
    expect(promoted.timeout).toBe(5_000);
    expect(promoted.tags).toEqual(['smoke', 'promoted']);
  });

  it('defaults the name to "<source> (promoted)" and accepts an explicit override', () => {
    const runResult = createMockRunResult({ content: 'ok' });

    const defaultNamed = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-3',
    });
    expect(defaultNamed.name).toBe('checkout-flow (promoted)');

    const explicitlyNamed = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-3',
      name: 'checkout-flow-regression',
    });
    expect(explicitlyNamed.name).toBe('checkout-flow-regression');
  });

  it('records provenance — origin, runId, sourceCaseName, finishReason, and promotedAt', () => {
    const runResult = createMockRunResult({ content: 'ok', finishReason: 'stop-condition' });
    const before = new Date().toISOString();

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'production-failure',
      runId: 'run-42',
    });

    const after = new Date().toISOString();

    expect(promoted.provenance).toBeDefined();
    expect(promoted.provenance?.origin).toBe('production-failure');
    expect(promoted.provenance?.runId).toBe('run-42');
    expect(promoted.provenance?.sourceCaseName).toBe('checkout-flow');
    expect(promoted.provenance?.finishReason).toBe('stop-condition');
    const promotedAt = promoted.provenance?.promotedAt;
    expect(promotedAt).toBeDefined();
    expect(promotedAt! >= before).toBe(true);
    expect(promotedAt! <= after).toBe(true);
  });

  it('yields a runnable case: re-running the promoted case against the same behavior passes', async () => {
    // Simulate a recorded run: a tool call step followed by a final response.
    const recordedResponses: GenerateResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'lookup-cart', arguments: {} }],
        usage: { prompt: 5, completion: 2, total: 7 },
      },
      {
        content: 'Your order has shipped.',
        toolCalls: [],
        usage: { prompt: 6, completion: 3, total: 9 },
      },
    ];

    const runResult = createMockRunResult({
      content: 'Your order has shipped.',
      steps: [createMockStep([{ name: 'lookup-cart' }])],
    });

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-4',
    });

    // Re-run the promoted case against a mock agent that reproduces the same
    // recorded behavior (same tool call, same final content).
    const generate = createMockGenerate(recordedResponses);
    const toolbox = createTestToolbox([createMockTool({ name: 'lookup-cart' })]);

    const evaluation = createAgentEvaluation({
      cases: [promoted],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.metrics.outputMatch).toBe(true);
    expect(report.cases[0]!.metrics.toolCallMatch).toBe(true);
  });

  it('the promoted case FAILS when the agent regresses from the recorded behavior (neutered check)', async () => {
    const runResult = createMockRunResult({
      content: 'Your order has shipped.',
      steps: [createMockStep([{ name: 'lookup-cart' }])],
    });

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-5',
    });

    // Regressed agent: skips the tool call entirely and returns different content.
    const generate = createMockGenerate([
      {
        content: 'Sorry, something went wrong.',
        toolCalls: [],
        usage: { prompt: 5, completion: 2, total: 7 },
      },
    ]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [promoted],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
  });

  it('the promoted case FAILS when the agent makes an extra, unlisted tool call', async () => {
    // Recorded run: exactly one tool call.
    const runResult = createMockRunResult({
      content: 'Your order has shipped.',
      steps: [createMockStep([{ name: 'lookup-cart' }])],
    });

    const promoted = promoteRunToCase({
      sourceCase,
      runResult,
      origin: 'evaluation-run',
      runId: 'run-6',
    });

    // Regressed agent: performs the recorded call AND an extra, unlisted one
    // before returning the same content — matchToolCallsOrdered alone only
    // checks the positions it was told about, so this would otherwise pass.
    const generate = createMockGenerate([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'lookup-cart', arguments: {} }],
        usage: { prompt: 5, completion: 2, total: 7 },
      },
      {
        content: '',
        toolCalls: [{ id: 'c2', name: 'send-marketing-email', arguments: {} }],
        usage: { prompt: 5, completion: 2, total: 7 },
      },
      {
        content: 'Your order has shipped.',
        toolCalls: [],
        usage: { prompt: 6, completion: 3, total: 9 },
      },
    ]);
    const toolbox = createTestToolbox([
      createMockTool({ name: 'lookup-cart' }),
      createMockTool({ name: 'send-marketing-email' }),
    ]);

    const evaluation = createAgentEvaluation({
      cases: [promoted],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.metrics.toolCallMatch).toBe(false);
    expect(report.cases[0]!.pass).toBe(false);
  });
});
