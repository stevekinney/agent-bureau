import type {
  AgentRun,
  GenerateFunction,
  GenerateResponse,
  RunnableAgent,
  RunResult,
} from '@lostgradient/operative';
import { createMockGenerate } from '@lostgradient/operative/test';
import { createMockTool, createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';

import { createAgentEvaluation } from './create-agent-evaluation';
import type { EvaluationCase } from './types';

/**
 * Builds a minimal `RunnableAgent<unknown, boolean>` fixture for these tests.
 * `run()` is synchronous per the AB-15/AB-22 contract; only `.result()` is
 * exercised by `createAgentEvaluation`, so every other `AgentRun` member is a
 * stub that throws if a future change starts relying on it.
 */
function makeRunnableAgent(
  name: string,
  result: () => Promise<unknown>,
): RunnableAgent<unknown, boolean> {
  const unused = (): never => {
    throw new Error(`unexpected call on the ${name} test fixture's AgentRun`);
  };
  return {
    name,
    run: () =>
      ({
        result,
        unwrap: unused,
        abort: unused,
        [Symbol.dispose]: unused,
        [Symbol.asyncIterator]: unused,
      }) as unknown as AgentRun<unknown, boolean>,
  };
}

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

  it('uses a case-specific system prompt when provided', async () => {
    let capturedSystemMessage = '';
    const generate: GenerateFunction = async ({ conversation }) => {
      const systemMessage = conversation.getMessages().find((message) => message.role === 'system');
      capturedSystemMessage =
        typeof systemMessage?.content === 'string' ? systemMessage.content : '';
      return singleResponse('ok');
    };

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'system-prompt', input: 'test', systemPrompt: 'Case system prompt' }],
      agent: { generate, toolbox: createTestToolbox([]) },
    });

    await evaluation.run();

    expect(capturedSystemMessage).toBe('Case system prompt');
  });

  it('returns a failed case when semantic matching throws during evaluation', async () => {
    const generate = createMockGenerate([singleResponse('ok')]);
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'semantic-error',
          input: 'test',
          expectedOutput: {
            type: 'semantic',
            reference: 'reference',
            threshold: 0.8,
          },
        },
      ],
      agent: { generate, toolbox },
      embedder: async () => {
        throw new Error('embedding service unavailable');
      },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.error).toContain('embedding service unavailable');
    expect(report.cases[0]!.metrics.finishReason).toBe('error');
    expect(report.cases[0]!.metrics.totalTokens).toBe(0);
  });

  it('aborts a case when its timeout elapses', async () => {
    const generate: GenerateFunction = async ({ signal }) =>
      await new Promise<GenerateResponse>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        if (signal.aborted) {
          reject(new Error('generation aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('generation aborted'));
          },
          { once: true },
        );
      });
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'timeout', input: 'test', timeout: 0 }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.error).toContain('aborted');
    expect(report.cases[0]!.metrics.finishReason).toBe('aborted');
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

  it('preserves case order in results regardless of concurrency', async () => {
    const generate = createMockGenerate([
      singleResponse('a'),
      singleResponse('b'),
      singleResponse('c'),
    ]);
    const toolbox = createTestToolbox([]);

    const cases: EvaluationCase[] = [
      { name: 'case-1', input: 'test', expectedOutput: 'a' },
      { name: 'case-2', input: 'test', expectedOutput: 'b' },
      { name: 'case-3', input: 'test', expectedOutput: 'c' },
    ];

    const evaluation = createAgentEvaluation({
      cases,
      agent: { generate, toolbox },
      concurrency: 3,
    });

    const report = await evaluation.run();

    expect(report.cases.map((c) => c.name)).toEqual(['case-1', 'case-2', 'case-3']);
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

  it('fails when finishReason is error even if error is undefined', async () => {
    // Simulate a generate function that throws undefined, which causes
    // the operative loop to return { finishReason: 'error', error: undefined }.
    const generate = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw undefined;
    };
    const toolbox = createTestToolbox([]);

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'error-undefined', input: 'test' }],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.score).toBe(0);
    expect(report.cases[0]!.metrics.finishReason).toBe('error');
    expect(report.cases[0]!.error).toBe('Unknown error');
  });

  it('still evaluates output matching for non-error finish reasons', async () => {
    const generate = createMockGenerate([
      singleResponse('partial success', [{ id: 'call-1', name: 'noop', arguments: {} }]),
    ]);
    const toolbox = createTestToolbox([
      createMockTool({
        name: 'noop',
        impl: async () => 'done',
      }),
    ]);

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'maximum-steps-still-matches',
          input: 'test',
          expectedOutput: 'partial success',
          maxSteps: 1,
        },
      ],
      agent: { generate, toolbox },
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.score).toBe(1);
    expect(report.cases[0]!.metrics.outputMatch).toBe(true);
    expect(report.cases[0]!.metrics.finishReason).toBe('maximum-steps');
    expect(report.cases[0]!.error).toBeUndefined();
  });

  it('works with RunnableAgent input', async () => {
    // RunnableAgent path: the agent's synchronous run() returns a handle whose
    // result() is awaited.
    const runnableAgent = makeRunnableAgent('test-agent', () =>
      Promise.resolve({
        conversation: {} as RunResult['conversation'],
        steps: [],
        content: 'Hello from agent!',
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'stop-condition' as const,
      }),
    );

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'registry-agent', input: 'test', expectedOutput: 'Hello from agent!' }],
      agent: runnableAgent,
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(true);
    expect(report.cases[0]!.score).toBe(1);
  });

  it('times out a RunnableAgent that hangs past the case timeout (PRRT_kwDORvupsc6MlG1u)', async () => {
    // An agent that ignores its abort signal and never resolves. Without the
    // hard timeout race, the worker would await this forever; with it, the case
    // fails after `timeout` ms.
    const hangingAgent = makeRunnableAgent(
      'hanging-agent',
      () => new Promise<never>(() => {}), // never resolves, ignores signal
    );

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'hangs', input: 'test', timeout: 30 }],
      agent: hangingAgent,
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.score).toBe(0);
    expect(report.cases[0]!.error).toMatch(/timed out/i);
  });

  it('aborts and disposes the AgentRun handle when a timeout wins the race, even though the agent ignores its signal', async () => {
    // A losing timeout race alone does not stop the agent's own in-flight
    // work if it ignores context.signal — the handle's own abort()/dispose()
    // are the only remaining, signal-independent way to tell it to stop.
    let abortCalls = 0;
    let disposeCalls = 0;
    const hangingAgent: RunnableAgent<unknown, boolean> = {
      name: 'hanging-agent',
      run: (): AgentRun<unknown, boolean> => ({
        result: () => new Promise<never>(() => {}), // never resolves, ignores signal
        unwrap: () => {
          throw new Error('not used by this test');
        },
        abort: () => {
          abortCalls += 1;
        },
        // AB-50: children()/abortChild() joined AgentRun after this fixture
        // was first written. Not exercised by this test (the hanging agent
        // never dispatches a child), so a safe no-op matching the same
        // "empty registry" default createSubagentTool documents.
        children: () => [],
        abortChild: () => {
          throw new Error('not used by this test');
        },
        [Symbol.dispose]: () => {
          disposeCalls += 1;
        },
        [Symbol.asyncIterator]: () => {
          throw new Error('not used by this test');
        },
      }),
    };

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'hangs', input: 'test', timeout: 30 }],
      agent: hangingAgent,
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.error).toMatch(/timed out/i);
    expect(abortCalls).toBe(1);
    expect(disposeCalls).toBe(1);
  });

  it('still disposes the AgentRun handle when its abort() throws on a timed-out case (PRRT_kwDORvupsc6elFWL)', async () => {
    // An uncooperative abort() implementation must not prevent disposal —
    // otherwise resources only [Symbol.dispose]() releases leak for the rest
    // of the process. abort() and dispose() are isolated so a throw from the
    // first still lets the second run.
    let disposeCalls = 0;
    const uncooperativeAgent: RunnableAgent<unknown, boolean> = {
      name: 'uncooperative-agent',
      run: (): AgentRun<unknown, boolean> => ({
        result: () => new Promise<never>(() => {}), // never resolves, ignores signal
        unwrap: () => {
          throw new Error('not used by this test');
        },
        abort: () => {
          throw new Error('abort() is uncooperative and always throws');
        },
        children: () => [],
        abortChild: () => {
          throw new Error('not used by this test');
        },
        [Symbol.dispose]: () => {
          disposeCalls += 1;
        },
        [Symbol.asyncIterator]: () => {
          throw new Error('not used by this test');
        },
      }),
    };

    const evaluation = createAgentEvaluation({
      cases: [{ name: 'hangs', input: 'test', timeout: 30 }],
      agent: uncooperativeAgent,
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.error).toMatch(/timed out/i);
    expect(disposeCalls).toBe(1);
  });

  it('fails (does not pass by default) when a RunnableAgent returns a non-RunResult (PRRT_kwDORvupsc6MlG1z)', async () => {
    // A miswired agent: returns a plain object with `steps` but no valid
    // finishReason. Previously the `as RunResult` cast let this flow through; the
    // failure guard never triggered, and a case with no output assertion passed
    // by default. The validation guard now rejects it as a failed case.
    const miswiredAgent = makeRunnableAgent('miswired-agent', () =>
      Promise.resolve({ steps: [], somethingElse: true }),
    );

    const evaluation = createAgentEvaluation({
      // No expectedOutput — this is exactly the case that would pass by default.
      cases: [{ name: 'miswired', input: 'test' }],
      agent: miswiredAgent,
    });

    const report = await evaluation.run();

    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.score).toBe(0);
    expect(report.cases[0]!.error).toMatch(/not a RunResult/i);
  });

  it.each(['budget-exceeded', 'elicitation-denied'] as const)(
    'fails the case (not a false-positive pass) when finishReason is %s even if content matches',
    async (finishReason) => {
      // Regression (Codex re-review of 7b910a15): a run that ends with
      // 'budget-exceeded'/'elicitation-denied' is a normal operative FAILURE.
      // Previously the failure branch only covered 'error'/'aborted', so such a
      // run fell through to output matching and could PASS if its partial content
      // happened to match expectedOutput — a false positive for evaluations meant
      // to catch budget/elicitation failures.
      const runnableAgent = makeRunnableAgent('failing-agent', () =>
        Promise.resolve({
          conversation: {} as RunResult['conversation'],
          steps: [],
          // Content deliberately MATCHES expectedOutput below to prove the
          // failure short-circuits BEFORE output matching.
          content: 'the expected answer',
          usage: { prompt: 0, completion: 0, total: 0 },
          finishReason,
        }),
      );

      const evaluation = createAgentEvaluation({
        cases: [
          {
            name: `failure-${finishReason}`,
            input: 'test',
            expectedOutput: 'the expected answer',
          },
        ],
        agent: runnableAgent,
      });

      const report = await evaluation.run();

      expect(report.cases[0]!.pass).toBe(false);
      expect(report.cases[0]!.score).toBe(0);
      expect(report.cases[0]!.metrics.finishReason).toBe(finishReason);
      expect(report.cases[0]!.error).toContain(finishReason);
    },
  );

  it('fails with a clear error when RunnableAgent is used with a per-case systemPrompt', async () => {
    // RunnableAgent.run() has no systemPrompt parameter — its instructions are baked
    // in at construction time. Silently dropping the override would give misleading
    // results, so the runner must surface this as an explicit error.
    const runnableAgent = makeRunnableAgent('test-agent', () =>
      Promise.resolve({
        conversation: {} as RunResult['conversation'],
        steps: [],
        content: 'ok',
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'stop-condition' as const,
      }),
    );

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'registry-agent-with-system-prompt',
          input: 'test',
          systemPrompt: 'Override system prompt',
        },
      ],
      agent: runnableAgent,
    });

    const report = await evaluation.run();

    // The case should fail with an actionable error, not silently drop the systemPrompt
    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.error).toContain('systemPrompt');
    expect(report.cases[0]!.error).toContain('RunnableAgent');
  });

  // Regression: PRRT_kwDORvupsc6Mc3gT — RunnableAgent.run() accepts only
  // { signal, traceContext, ... } and has no per-case step cap. Silently
  // ignoring a case's maxSteps would let cases meant to catch looping run
  // under the agent's own/default limit, so the runner must reject maxSteps
  // for a RunnableAgent case the same way it rejects systemPrompt.
  it('fails with a clear error when RunnableAgent is used with a per-case maxSteps (PRRT_kwDORvupsc6Mc3gT)', async () => {
    const runnableAgent = makeRunnableAgent('test-agent', () =>
      Promise.resolve({
        conversation: {} as RunResult['conversation'],
        steps: [],
        content: 'ok',
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'stop-condition' as const,
      }),
    );

    const evaluation = createAgentEvaluation({
      cases: [
        {
          name: 'registry-agent-with-max-steps',
          input: 'test',
          maxSteps: 3,
        },
      ],
      agent: runnableAgent,
    });

    const report = await evaluation.run();

    // The case should fail with an actionable error, not silently drop maxSteps.
    expect(report.cases[0]!.pass).toBe(false);
    expect(report.cases[0]!.error).toContain('maxSteps');
    expect(report.cases[0]!.error).toContain('RunnableAgent');
  });
});
