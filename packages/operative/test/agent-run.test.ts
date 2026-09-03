/**
 * Behavioral tests for `createAgentRun` — the non-thenable run handle (B1).
 *
 * Acceptance criteria from plan.md §B1:
 *   (a) iterate-then-result() returns the cached terminal value without re-running
 *   (b) result() is idempotent (callable before/after/without iteration)
 *   (c) the async iterator is independent of result-resolution state
 *   (d) a second `for await` on a completed run errors or replays predictably, never hangs
 */
import { createMockTool, createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  CompletedRunIterationError,
  createAgentRun,
  createDiagnosticAgentRun,
  isSuccessfulRunResult,
} from '../src/agent-run';
import { createChildRunRegistry, dispatchChildRun } from '../src/child-run';
import { noToolCalls } from '../src/conditions/predicates';
import { type ActiveRun, createActiveRun as createRun } from '../src/create-run';
import { AbortAgentRunError, MaximumStepsExceededError } from '../src/errors';
import { TOOL_CALL_POLICY } from '../src/liveness';
import type { RunnableAgent } from '../src/runnable-agent';
import { createMockGenerate } from '../src/test/index';
import type {
  CleanupAcknowledgement,
  ClosedOptions,
  GenerateResponse,
  RunResult,
} from '../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function makeRun(responses: GenerateResponse[] = [textResponse('Hello')]) {
  const generate = createMockGenerate(responses);
  const toolbox = createTestToolbox([]);
  const conversation = new Conversation();
  const activeRun = createRun({ generate, toolbox, conversation, stopWhen: noToolCalls() });
  return createAgentRun(activeRun);
}

function createResolvedActiveRun(result: Awaited<ActiveRun['result']>): ActiveRun {
  return {
    result: Promise.resolve(result),
    abort: () => undefined,
    closed: () => Promise.resolve({ status: 'completed' }) as Promise<CleanupAcknowledgement>,
    [Symbol.dispose]: () => undefined,
    toObservable: () => ({
      subscribe() {
        return { unsubscribe: () => undefined };
      },
    }),
  } as unknown as ActiveRun;
}

/**
 * An `ActiveRun` stub whose `closed()` returns a caller-supplied
 * acknowledgement (optionally per-call, honoring `options.signal` the way
 * the real `closed-acknowledgement.ts` contract requires) — for testing
 * `AgentRun.closed()`/`DiagnosticAgentRun.closed()` delegation (AB-204 AC5,
 * AC6) against every outcome without depending on a real run's timing.
 */
function createActiveRunWithClosed(
  acknowledgement: CleanupAcknowledgement,
  overrides: Partial<ActiveRun> = {},
): { activeRun: ActiveRun; closedCalls: (ClosedOptions | undefined)[] } {
  const closedCalls: (ClosedOptions | undefined)[] = [];
  const activeRun = {
    result: new Promise(() => {}),
    abort: () => undefined,
    closed: (options?: ClosedOptions): Promise<CleanupAcknowledgement> => {
      closedCalls.push(options);
      if (options?.signal?.aborted) {
        return Promise.resolve({ status: 'unresolved', reason: 'timed-out' });
      }
      return Promise.resolve(acknowledgement);
    },
    [Symbol.dispose]: () => undefined,
    toObservable: () => ({
      subscribe() {
        return { unsubscribe: () => undefined };
      },
    }),
    ...overrides,
  } as unknown as ActiveRun;
  return { activeRun, closedCalls };
}

// ---------------------------------------------------------------------------
// result() — idempotency and caching
// ---------------------------------------------------------------------------

describe('AgentRun.result()', () => {
  it('stamps events when an active run has identity metadata', async () => {
    const activeRun = createRun({
      generate: createMockGenerate([textResponse('metadata')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      agentName: 'agent',
      runId: 'run-1',
    });
    const run = createAgentRun(activeRun);
    const events: string[] = [];

    for await (const event of run) events.push(event.type);

    expect(events).toContain('run.started');
    expect(events).toContain('step.started');
  });

  it('resolves to the terminal RunResult', async () => {
    const run = makeRun([textResponse('done')]);
    const result = await run.result();
    expect(result.content).toBe('done');
    expect(result.finishReason).toBe('stop-condition');
  });

  it('is idempotent — returns the same promise on repeated calls', () => {
    const run = makeRun();
    const p1 = run.result();
    const p2 = run.result();
    expect(p1).toBe(p2);
  });

  it('resolves before iteration begins', async () => {
    const run = makeRun([textResponse('early result')]);
    // Call result() without starting for-await.
    const result = await run.result();
    expect(result.content).toBe('early result');
  });

  it('resolves after full iteration with the same cached value (acceptance criteria a)', async () => {
    const generate = createMockGenerate([textResponse('cached')]);
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({ generate, toolbox, conversation, stopWhen: noToolCalls() });
    const run = createAgentRun(activeRun);

    // Iterate the event stream to completion.
    const events: string[] = [];
    for await (const event of run) {
      events.push(event.type);
    }

    // result() after full iteration should return cached terminal value.
    const result = await run.result();
    expect(result.content).toBe('cached');
    expect(result.finishReason).toBe('stop-condition');

    // Calling result() again returns the same promise — no re-run.
    const result2 = await run.result();
    expect(result2).toBe(result);

    // generate was called exactly once (no re-run on result() calls).
    expect(generate.callCount).toBe(1);
  });
});

describe('AgentRun.unwrap() and output()', () => {
  it('unwraps plain text for an untyped successful run', async () => {
    const run = makeRun([textResponse('plain text')]);

    await expect(run.unwrap()).resolves.toBe('plain text');
  });

  it('unwraps schema-backed output when output is configured', async () => {
    const activeRun = createResolvedActiveRun({
      content: '{"answer":"validated"}',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: true },
      output: { answer: 'validated' },
    });
    const run = createAgentRun<{ answer: string }, true>(activeRun, { hasOutput: true });

    await expect(run.unwrap()).resolves.toEqual({ answer: 'validated' });
    await expect(run.output()).resolves.toEqual({ answer: 'validated' });
  });

  it('preserves a validated undefined output', async () => {
    const activeRun = createResolvedActiveRun({
      content: '{"answer":"validated"}',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: true },
      output: undefined,
    });
    const run = createAgentRun<undefined, true>(activeRun, { hasOutput: true });

    await expect(run.unwrap()).resolves.toBeUndefined();
    await expect(run.output()).resolves.toBeUndefined();
  });

  it('omits output() from direct handles when no output schema is configured', () => {
    const activeRun = createResolvedActiveRun({
      content: 'plain text',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
    });
    const run = createAgentRun(activeRun);

    expect('output' in run).toBe(false);
  });

  it('throws a synthesized missing-output error when unwrap() expects output but none exists', async () => {
    const activeRun = createResolvedActiveRun({
      content: '{"answer":"missing"}',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: true },
    });
    const run = createAgentRun<{ answer: string }, true>(activeRun, { hasOutput: true });

    await expect(run.unwrap()).rejects.toThrow('Agent run has no validated output');
  });

  it('throws the terminal run error when unwrap() is called on a failed run', async () => {
    const failure = new Error('provider failed');
    const activeRun = createResolvedActiveRun({
      content: '',
      conversation: {} as never,
      finishReason: 'error',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      error: failure,
    });
    const run = createAgentRun(activeRun);

    await expect(run.unwrap()).rejects.toBe(failure);
  });

  it('throws a synthesized failure when unwrap() is called on an unsuccessful run without an Error', async () => {
    const activeRun = createResolvedActiveRun({
      content: '',
      conversation: {} as never,
      finishReason: 'aborted',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
    });
    const run = createAgentRun(activeRun);

    await expect(run.unwrap()).rejects.toThrow('Agent run did not finish successfully: aborted');
  });

  it('throws a synthesized failure when output() is called on an unsuccessful run without an Error', async () => {
    const activeRun = createResolvedActiveRun({
      content: '',
      conversation: {} as never,
      finishReason: 'budget-exceeded',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
    });
    const run = createAgentRun<{ answer: string }, true>(activeRun, { hasOutput: true });

    await expect(run.output()).rejects.toThrow(
      'Agent run did not finish successfully: budget-exceeded',
    );
  });

  it('throws the schema validation error before returning content from unwrap()', async () => {
    const validationError = new Error('invalid answer');
    const activeRun = createResolvedActiveRun({
      content: '{"answer":1}',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: false, error: validationError },
    });
    const run = createAgentRun(activeRun);

    await expect(run.unwrap()).rejects.toBe(validationError);
  });

  it('throws a synthesized schema failure when unwrap() sees failed validation without an Error', async () => {
    const activeRun = createResolvedActiveRun({
      content: '{"answer":1}',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: false, error: 'wrong shape' },
    });
    const run = createAgentRun(activeRun);

    await expect(run.unwrap()).rejects.toThrow('Agent run output failed schema validation');
  });

  it('throws the schema validation error when output() has no validated output', async () => {
    const validationError = new Error('missing output');
    const activeRun = createResolvedActiveRun({
      content: '{"answer":"missing"}',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: false, error: validationError },
    });
    const run = createAgentRun<{ answer: string }, true>(activeRun, { hasOutput: true });

    await expect(run.output()).rejects.toBe(validationError);
  });

  it('throws a synthesized missing-output error when output() has no schema error', async () => {
    const activeRun = createResolvedActiveRun({
      content: '{"answer":"missing"}',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: true },
    });
    const run = createAgentRun<{ answer: string }, true>(activeRun, { hasOutput: true });

    await expect(run.output()).rejects.toThrow('Agent run has no validated output');
  });

  it('throws the maximum-steps policy error when output() is called on a capped run', async () => {
    const maximumStepsError = new MaximumStepsExceededError(3);
    const activeRun = createResolvedActiveRun({
      content: '{"answer":"missing"}',
      conversation: {} as never,
      finishReason: 'maximum-steps',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
      schemaValidation: { success: true },
      error: maximumStepsError,
    });
    const run = createAgentRun<{ answer: string }, true>(activeRun, { hasOutput: true });

    await expect(run.output()).rejects.toBe(maximumStepsError);
  });
});

describe('createDiagnosticAgentRun()', () => {
  it('removes schema-specific accessors from a recovered diagnostic run', async () => {
    const activeRun = createResolvedActiveRun({
      content: 'diagnostic result',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
    });
    const run = createDiagnosticAgentRun(activeRun);

    expect('unwrap' in run).toBe(false);
    expect('output' in run).toBe(false);
    await expect(run.result()).resolves.toMatchObject({ content: 'diagnostic result' });
  });

  it('forwards a supplied childRegistry option to children()/abortChild(), same as createAgentRun', async () => {
    // AB-34 applies the Required capabilities table's children()/abortChild()
    // requirement to a DiagnosticAgentRun exactly as it does to AgentRun —
    // this proves createDiagnosticAgentRun actually has a way to receive
    // the registry that backs both, not only the always-empty default.
    const activeRun = createResolvedActiveRun({
      content: 'diagnostic result',
      conversation: {} as never,
      finishReason: 'stop-condition',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
    });
    const registry = createChildRunRegistry();
    const abortCalls: (string | undefined)[] = [];
    registry.register({
      id: 'child-1',
      parentId: 'p',
      agentName: 'researcher',
      durable: false,
      abort: (reason) => abortCalls.push(reason),
    });

    const run = createDiagnosticAgentRun(activeRun, { childRegistry: registry });

    expect(run.children()).toHaveLength(1);
    expect(run.children()[0]?.agentName).toBe('researcher');
    run.abortChild('child-1', 'stop it');
    expect(abortCalls).toEqual(['stop it']);
  });

  // AB-204 AC6 — durability is undeterminable from a recovered `ActiveRun`
  // wrapper (declared gap, AB-88). `'completed'` is the one status that
  // would otherwise assert the durable boundary this handle cannot vouch
  // for, so it is downgraded; every other outcome passes through unchanged.
  describe('closed()', () => {
    it('downgrades a wrapped "completed" acknowledgement to unresolved/unknown-effect', async () => {
      const { activeRun } = createActiveRunWithClosed({ status: 'completed' });
      const run = createDiagnosticAgentRun(activeRun);

      expect(await run.closed()).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
    });

    it.each([
      ['not-required', { status: 'not-required' }],
      ['failed', { status: 'failed', error: new Error('teardown failed') }],
      ['unresolved/persistence-failed', { status: 'unresolved', reason: 'persistence-failed' }],
      ['unresolved/unreachable', { status: 'unresolved', reason: 'unreachable' }],
    ] as const)(
      'passes a wrapped %s acknowledgement through unchanged',
      async (_label, expected) => {
        const { activeRun } = createActiveRunWithClosed(expected);
        const run = createDiagnosticAgentRun(activeRun);

        expect(await run.closed()).toEqual(expected);
      },
    );

    it('caches the downgraded acknowledgement: repeated calls return the identical object by reference', async () => {
      const { activeRun } = createActiveRunWithClosed({ status: 'completed' });
      const run = createDiagnosticAgentRun(activeRun);

      const first = await run.closed();
      const second = await run.closed();
      expect(second).toBe(first);
    });

    it('does not cache a per-call signal timeout, racing the caller-supplied signal against the shared settlement rather than forwarding it to the wrapped closed()', async () => {
      const { activeRun, closedCalls } = createActiveRunWithClosed({ status: 'completed' });
      const run = createDiagnosticAgentRun(activeRun);

      const controller = new AbortController();
      controller.abort();
      const timedOut = await run.closed({ signal: controller.signal });
      expect(timedOut).toEqual({ status: 'unresolved', reason: 'timed-out' });
      // The wrapped call is invoked with no signal — this wrapper races the
      // caller's own signal against the shared settlement itself, so an
      // abandoned wait here never depends on (or corrupts) a concurrent
      // signal-free call's memoized transform.
      expect(closedCalls).toEqual([undefined]);

      // A later signal-free call is unaffected by the abandoned one, and
      // still applies the completed → unknown-effect downgrade.
      expect(await run.closed()).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
    });

    it('resolves the identical cached downgraded object for a signal-bearing call made after genuine settlement', async () => {
      const { activeRun } = createActiveRunWithClosed({ status: 'completed' });
      const run = createDiagnosticAgentRun(activeRun);

      const first = await run.closed();
      const controller = new AbortController();
      controller.abort();
      const second = await run.closed({ signal: controller.signal });

      expect(second).toBe(first);
    });

    it('shares the identical downgraded object across two concurrent calls made before the transform settles', async () => {
      const { activeRun } = createActiveRunWithClosed({ status: 'completed' });
      const run = createDiagnosticAgentRun(activeRun);

      const [first, second] = await Promise.all([run.closed(), run.closed()]);
      expect(second).toBe(first);
    });

    it('resolves unresolved/timed-out for a signal that fires after the call starts but before settlement wins', async () => {
      let releaseUnderlying!: (acknowledgement: CleanupAcknowledgement) => void;
      const underlyingClosed = new Promise<CleanupAcknowledgement>((resolve) => {
        releaseUnderlying = resolve;
      });
      const activeRun = {
        result: new Promise(() => {}),
        abort: () => undefined,
        closed: () => underlyingClosed,
        [Symbol.dispose]: () => undefined,
        toObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
      } as unknown as ActiveRun;
      const run = createDiagnosticAgentRun(activeRun);

      const controller = new AbortController();
      const timedOutCall = run.closed({ signal: controller.signal });
      controller.abort();

      expect(await timedOutCall).toEqual({ status: 'unresolved', reason: 'timed-out' });

      // Settling the real cleanup afterward is unaffected by the abandoned wait.
      releaseUnderlying({ status: 'completed' });
      expect(await run.closed()).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
    });

    it('resolves a signal-bearing call with the real transformed value when settlement wins before the signal fires', async () => {
      const { activeRun } = createActiveRunWithClosed({ status: 'completed' });
      const run = createDiagnosticAgentRun(activeRun);

      const controller = new AbortController();
      const result = await run.closed({ signal: controller.signal });
      expect(result).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
    });
  });
});

// AB-204 AC5 — `AgentRun.closed()` delegates to the wrapped `ActiveRun.closed()`
// and returns the identical `CleanupAcknowledgement` the wrapped call produces.
describe('AgentRun.closed()', () => {
  it.each([
    ['not-required', { status: 'not-required' }],
    ['completed', { status: 'completed' }],
    ['failed', { status: 'failed', error: new Error('teardown failed') }],
    ['unresolved/unknown-effect', { status: 'unresolved', reason: 'unknown-effect' }],
  ] as const)(
    'delegates to the wrapped ActiveRun.closed() and returns %s unchanged',
    async (_label, expected) => {
      const { activeRun } = createActiveRunWithClosed(expected);
      const run = createAgentRun(activeRun);

      expect(await run.closed()).toBe(await activeRun.closed());
      expect(await run.closed()).toEqual(expected);
    },
  );

  it('forwards its options.signal to the wrapped ActiveRun.closed()', async () => {
    const { activeRun, closedCalls } = createActiveRunWithClosed({ status: 'completed' });
    const run = createAgentRun(activeRun);
    const controller = new AbortController();

    await run.closed({ signal: controller.signal });

    expect(closedCalls).toEqual([{ signal: controller.signal }]);
  });

  it('resolves closed() against a real run once it settles', async () => {
    const run = makeRun([textResponse('done')]);
    await run.result();
    expect(await run.closed()).toEqual({ status: 'not-required' });
  });
});

// ---------------------------------------------------------------------------
// AsyncIterable — event streaming
// ---------------------------------------------------------------------------

describe('AgentRun[Symbol.asyncIterator]()', () => {
  it('returns an empty iterator for a concurrent second iteration when configured', async () => {
    const generate = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return textResponse('slow');
    };
    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    const run = createAgentRun(activeRun, { onCompletedIteration: 'empty' });

    const firstIterator = run[Symbol.asyncIterator]();
    const secondIterator = run[Symbol.asyncIterator]();

    expect(await secondIterator.next()).toEqual({ value: undefined, done: true });
    await firstIterator.return?.();
    await activeRun.result;
  });

  it('throws for a concurrent second iteration by default', async () => {
    const generate = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return textResponse('slow');
    };
    const activeRun = createRun({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    const run = createAgentRun(activeRun);
    const firstIterator = run[Symbol.asyncIterator]();

    expect(() => run[Symbol.asyncIterator]()).toThrow(CompletedRunIterationError);
    await firstIterator.return?.();
    await activeRun.result;
  });

  it('completes iteration when the run settles before the observable completes', async () => {
    const activeRun = {
      result: Promise.resolve({
        content: 'done',
        conversation: {} as never,
        finishReason: 'stop-condition',
        steps: [],
        usage: { prompt: 0, completion: 0, total: 0 },
      }),
      abort: () => undefined,
      [Symbol.dispose]: () => undefined,
      toObservable: () => ({
        subscribe() {
          return { unsubscribe: () => undefined };
        },
      }),
    } as unknown as ActiveRun;
    const run = createAgentRun(activeRun);
    const iterator = run[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('surfaces observable errors while an iterator is waiting', async () => {
    let observer: { error: (error: unknown) => void } | undefined;
    const activeRun = {
      result: new Promise(() => undefined),
      abort: () => undefined,
      [Symbol.dispose]: () => undefined,
      toObservable: () => ({
        subscribe(nextObserver: { error: (error: unknown) => void }) {
          observer = nextObserver;
          return { unsubscribe: () => undefined };
        },
      }),
    } as unknown as ActiveRun;
    const run = createAgentRun(activeRun);
    const iterator = run[Symbol.asyncIterator]();
    const next = iterator.next();

    observer?.error('stream failed');

    await expect(next).rejects.toThrow('stream failed');
  });

  it('surfaces buffered observable errors on the next pull', async () => {
    const activeRun = {
      result: new Promise(() => undefined),
      abort: () => undefined,
      [Symbol.dispose]: () => undefined,
      toObservable: () => ({
        subscribe(observer: { error: (error: unknown) => void }) {
          observer.error('buffered failure');
          return { unsubscribe: () => undefined };
        },
      }),
    } as unknown as ActiveRun;
    const run = createAgentRun(activeRun);
    const iterator = run[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow('buffered failure');
  });

  it('resolves a waiting iterator when the observable completes', async () => {
    let observer: { complete: () => void } | undefined;
    const activeRun = {
      result: new Promise(() => undefined),
      abort: () => undefined,
      [Symbol.dispose]: () => undefined,
      toObservable: () => ({
        subscribe(nextObserver: { complete: () => void }) {
          observer = nextObserver;
          return { unsubscribe: () => undefined };
        },
      }),
    } as unknown as ActiveRun;
    const run = createAgentRun(activeRun);
    const iterator = run[Symbol.asyncIterator]();
    const next = iterator.next();

    observer?.complete();

    expect(await next).toEqual({ value: undefined, done: true });
  });

  it('cleans up the subscription when iteration returns early', async () => {
    let unsubscribed = false;
    const activeRun = {
      result: new Promise(() => undefined),
      abort: () => undefined,
      [Symbol.dispose]: () => undefined,
      toObservable: () => ({
        subscribe() {
          return { unsubscribe: () => (unsubscribed = true) };
        },
      }),
    } as unknown as ActiveRun;
    const run = createAgentRun(activeRun);
    const iterator = run[Symbol.asyncIterator]();

    expect(await iterator.return?.()).toEqual({ value: undefined, done: true });
    expect(unsubscribed).toBe(true);
  });

  it('yields run events during iteration', async () => {
    const run = makeRun([textResponse('streaming')]);
    const types: string[] = [];
    for await (const event of run) {
      types.push(event.type);
    }
    // The loop must have emitted at least run.started and run.completed.
    expect(types).toContain('run.started');
    expect(types).toContain('run.completed');
  });

  it('can iterate independently of result() resolution (acceptance criteria c)', async () => {
    const generate = createMockGenerate([textResponse('independent')]);
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({ generate, toolbox, conversation, stopWhen: noToolCalls() });
    const run = createAgentRun(activeRun);

    // Start result() and iteration concurrently.
    const resultPromise = run.result();
    const events: string[] = [];
    for await (const event of run) {
      events.push(event.type);
    }
    const result = await resultPromise;

    expect(result.content).toBe('independent');
    expect(events.length).toBeGreaterThan(0);
  });

  it('a second for-await on a completed run throws CompletedRunIterationError (acceptance criteria d)', async () => {
    const run = makeRun();

    // First iteration consumes the stream.
    for await (const _ of run) {
      /* drain */
    }

    // Second iteration on the same completed run must throw, not hang.
    let threw = false;
    try {
      for await (const _ of run) {
        /* should not reach */
      }
    } catch (error) {
      threw = true;
      expect(error).toBeInstanceOf(CompletedRunIterationError);
    }
    expect(threw).toBe(true);
  });

  it('second for-await can be configured to return empty rather than throw', async () => {
    const generate = createMockGenerate([textResponse('empty path')]);
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({ generate, toolbox, conversation, stopWhen: noToolCalls() });
    const run = createAgentRun(activeRun, { onCompletedIteration: 'empty' });

    for await (const _ of run) {
      /* drain first iteration */
    }

    // Second iteration should return immediately without yielding or throwing.
    const events: string[] = [];
    for await (const event of run) {
      events.push(event.type);
    }
    expect(events).toEqual([]);
  });

  it('a for-await on an already-completed run does not hang (acceptance criteria d)', async () => {
    // Ensure result() completes the underlying run before iterating.
    const run = makeRun([textResponse('pre-completed')]);
    await run.result();

    // Now try to iterate — must throw immediately, never hang.
    let threw = false;
    const deadline = new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('iteration hung — did not complete within 1s')), 1000),
    );
    try {
      await Promise.race([
        (async () => {
          for await (const _ of run) {
            /* should not reach */
          }
        })(),
        deadline,
      ]);
    } catch (error) {
      threw = true;
      if (error instanceof CompletedRunIterationError) {
        // Expected — threw immediately.
      } else {
        throw error; // deadline fired — re-throw.
      }
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// abort()
// ---------------------------------------------------------------------------

describe('AgentRun.abort()', () => {
  it('aborts an in-flight run and the result() promise rejects or resolves as aborted', async () => {
    // Use a generate that parks until aborted.
    let abortSignal: AbortSignal | undefined;
    const parkingGenerate = async (context: { signal?: AbortSignal }) => {
      abortSignal = context.signal;
      // Wait until aborted.
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
      return textResponse('should not reach');
    };

    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({
      generate: parkingGenerate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });
    const run = createAgentRun(activeRun);

    // Abort after a brief wait to let generate start.
    setTimeout(() => run.abort('user cancelled'), 10);

    // The result() promise should settle (either resolve with finishReason='aborted'
    // or reject — either is acceptable as long as it doesn't hang).
    const settled = await Promise.race([
      run.result().then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((_resolve, reject) =>
        setTimeout(() => reject(new Error('result() hung after abort')), 500),
      ),
    ]);
    expect(['resolved', 'rejected']).toContain(settled);
    expect(abortSignal?.aborted).toBe(true);
  });

  it('emits a typed abort error and resolves result() with the same abort error contract', async () => {
    let eventError: AbortAgentRunError | undefined;
    const parkingGenerate = async (context: { signal?: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener(
          'abort',
          () => reject(new Error('generate observed abort')),
          { once: true },
        );
      });
      return textResponse('unreachable');
    };

    const activeRun = createRun({
      generate: parkingGenerate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    activeRun.addEventListener('run.aborted', (event) => {
      eventError = event.error;
    });
    const run = createAgentRun(activeRun);

    setTimeout(() => run.abort('user cancelled'), 10);

    const result = await run.result();

    expect(result.finishReason).toBe('aborted');
    expect(result.error).toBeInstanceOf(AbortAgentRunError);
    expect((result.error as AbortAgentRunError).kind).toBe('abort');
    expect((result.error as AbortAgentRunError).code).toBe('ABORTED');
    expect((result.error as AbortAgentRunError).message).toBe('user cancelled');
    expect(eventError).toBeInstanceOf(AbortAgentRunError);
    expect(eventError).toBe(result.error);
  });
});

// ---------------------------------------------------------------------------
// [Symbol.dispose]()
// ---------------------------------------------------------------------------

describe('AgentRun[Symbol.dispose]()', () => {
  it('can be called without throwing', async () => {
    const run = makeRun();
    await run.result();
    expect(() => run[Symbol.dispose]()).not.toThrow();
  });

  it('aborts an in-flight run when disposed', async () => {
    let signalSeen: AbortSignal | undefined;
    const parkingGenerate = async (context: { signal?: AbortSignal }) => {
      signalSeen = context.signal;
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
      return textResponse('unreachable');
    };

    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({
      generate: parkingGenerate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });
    const run = createAgentRun(activeRun);

    setTimeout(() => run[Symbol.dispose](), 10);

    await Promise.race([
      run.result().then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error('dispose did not abort the run within 500ms')), 500),
      ),
    ]);

    expect(signalSeen?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-thenable structural check (runtime)
// ---------------------------------------------------------------------------

describe('AgentRun non-thenable contract', () => {
  it('does not have a .then property', () => {
    const run = makeRun();
    // If AgentRun were thenable, `(run as any).then` would be a function.
    expect((run as any).then).toBeUndefined();
  });

  it('is not auto-unwrapped by Promise.resolve()', async () => {
    const run = makeRun();
    // Promise.resolve(x) auto-unwraps thenables. Since AgentRun has no .then,
    // Promise.resolve(run) should resolve to the AgentRun handle itself, not
    // a RunResult.
    const resolved = await Promise.resolve(run);
    // resolved must be the run handle, not a RunResult.
    expect(resolved).toBe(run);
    // Confirm: it still has the AgentRun API.
    expect(typeof resolved.result).toBe('function');
    expect(typeof resolved.abort).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// isSuccessfulRunResult — the hasOutput witness parameter (AB-234)
// ---------------------------------------------------------------------------

describe('isSuccessfulRunResult', () => {
  function stopResult(overrides: Partial<RunResult> = {}): RunResult {
    return {
      conversation: {} as RunResult['conversation'],
      steps: [],
      content: 'ok',
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: 'stop-condition',
      ...overrides,
    };
  }

  it('narrows successfully when schemaValidation is absent and hasOutput is omitted (pre-AB-234 behavior preserved)', () => {
    expect(isSuccessfulRunResult(stopResult())).toBe(true);
  });

  it('narrows successfully when schemaValidation is absent and hasOutput is explicitly false', () => {
    expect(isSuccessfulRunResult(stopResult(), false)).toBe(true);
  });

  it('rejects when schemaValidation is absent but hasOutput is true — the gap AB-234 closes', () => {
    // A hand-written `RunnableAgent<O, true>` that never actually attaches
    // `schemaValidation` at all: before AB-234, this fell through the
    // `schemaValidation === undefined` branch and narrowed successfully
    // regardless of the caller's real `H`. Passing the agent's own
    // `hasOutput` witness closes that.
    expect(isSuccessfulRunResult(stopResult(), true)).toBe(false);
  });

  it('still requires the output key when schemaValidation reports success, regardless of hasOutput', () => {
    const result = stopResult({ schemaValidation: { success: true } });
    expect(isSuccessfulRunResult(result, true)).toBe(false);
    expect(isSuccessfulRunResult(result, false)).toBe(false);
  });

  it('narrows successfully when schemaValidation reports success and output is present', () => {
    const result = { ...stopResult({ schemaValidation: { success: true } }), output: 'value' };
    expect(isSuccessfulRunResult(result, true)).toBe(true);
  });

  it('rejects a failed schemaValidation regardless of hasOutput', () => {
    const result = stopResult({ schemaValidation: { success: false } });
    expect(isSuccessfulRunResult(result, true)).toBe(false);
    expect(isSuccessfulRunResult(result, false)).toBe(false);
  });

  it('rejects a non-stop-condition finishReason regardless of hasOutput', () => {
    const result = stopResult({ finishReason: 'aborted' });
    expect(isSuccessfulRunResult(result, true)).toBe(false);
    expect(isSuccessfulRunResult(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AB-88/AB-214 — snapshot()/subscribeSnapshot() delegate to the wrapped ActiveRun
// ---------------------------------------------------------------------------

describe('AgentRun.snapshot()/subscribeSnapshot()', () => {
  it('snapshot() delegates to the wrapped ActiveRun', async () => {
    const run = makeRun();

    const snapshot = run.snapshot();
    expect(snapshot.kind).toBe('agent-run');
    expect(snapshot.id.length).toBeGreaterThan(0);

    await run.result();
  });

  it('subscribeSnapshot() delegates to the wrapped ActiveRun, delivering the current snapshot synchronously', async () => {
    const run = makeRun();

    const received: number[] = [];
    const subscription = run.subscribeSnapshot((snapshot) => received.push(snapshot.revision));
    expect(received.length).toBeGreaterThan(0);
    subscription.unsubscribe();

    await run.result();
  });
});

// ---------------------------------------------------------------------------
// AB-216 — child-liveness rollup into worstChildAssessment
// ---------------------------------------------------------------------------

function createManualClock(): {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  advance(ms: number): void;
} {
  let time = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: time + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      time += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [handle, timer] of [...timers.entries()]) {
          if (timer.at <= time) {
            timers.delete(handle);
            timer.callback();
            fired = true;
          }
        }
      }
    },
  };
}

/**
 * A `RunnableAgent` whose `run()` builds a real `ActiveRun` (via
 * `createActiveRun`, wrapped by `createAgentRun`) against an injected
 * clock — needed so a test can advance the CHILD's own stall-watchdog
 * clock independently of the PARENT's, without any real `setTimeout`
 * delay (this repository's "no real sleeps in deterministic tests" rule).
 */
function makeClockedAgent(
  clock: ReturnType<typeof createManualClock>,
  responses: GenerateResponse[],
  toolbox: ReturnType<typeof createTestToolbox>,
): RunnableAgent {
  return {
    name: 'clocked-child',
    run: (input, context) => {
      const conversation = new Conversation();
      conversation.appendUserMessage(typeof input === 'string' ? input : 'go');
      const generate = createMockGenerate(responses);
      const activeRun = createRun(
        { generate, toolbox, conversation, agentName: 'clocked-child', signal: context?.signal },
        undefined,
        { clock },
      );
      return createAgentRun(activeRun);
    },
  };
}

/** `TOOL_CALL_POLICY.cadenceMs + graceMs + jitterMs`, times the missed-pulse threshold. */
const TOOL_STALL_ADVANCE_MS =
  ((TOOL_CALL_POLICY.cadenceMs ?? 0) + TOOL_CALL_POLICY.graceMs + TOOL_CALL_POLICY.jitterMs) *
  TOOL_CALL_POLICY.missedPulseThreshold;

describe('AgentRun worstChildAssessment rollup (AB-216)', () => {
  function makeParent(childRegistry: ReturnType<typeof createChildRunRegistry>) {
    const generate = createMockGenerate([textResponse('parent done')]);
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      childRegistry,
    });
    return createAgentRun(activeRun, { childRegistry });
  }

  /**
   * A parent whose own turn never resolves — needed whenever a test awaits
   * something else (a child settling, a clock advance) and must observe
   * `worstChildAssessment` while the PARENT is still non-terminal. Once a
   * parent's own run goes terminal it disposes its watchdogs (including
   * the child-registry subscription — AB-88's AC1 terminal-collapse rule
   * has no exception for a rollup field), so a parent that raced to its
   * own completion first would freeze `worstChildAssessment` at whatever
   * it last was, which is a different (and separately correct) behavior
   * from the live-rollup behavior these tests exercise.
   */
  function makeLongLivedParent(childRegistry: ReturnType<typeof createChildRunRegistry>) {
    const generate = () => new Promise<GenerateResponse>(() => {});
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      childRegistry,
    });
    return createAgentRun(activeRun, { childRegistry });
  }

  it('is absent on a parent with no children', async () => {
    const registry = createChildRunRegistry();
    const parent = makeParent(registry);

    expect(parent.snapshot().worstChildAssessment).toBeUndefined();

    await parent.result();
  });

  it('reflects a real dispatched child, healthy, then absent again once the child settles', async () => {
    const registry = createChildRunRegistry();
    const parent = makeLongLivedParent(registry);
    const child: RunnableAgent = {
      name: 'child',
      run: (_input, context) => {
        const generate = createMockGenerate([textResponse('child done')]);
        const toolbox = createTestToolbox([]);
        const conversation = new Conversation();
        const activeRun = createRun({
          generate,
          toolbox,
          conversation,
          stopWhen: noToolCalls(),
          signal: context?.signal,
        });
        return createAgentRun(activeRun);
      },
    };

    const handle = dispatchChildRun(child, 'go', {
      agentName: 'child',
      parentRunId: 'p',
      registry,
    });

    expect(parent.snapshot().worstChildAssessment).toBe('healthy');

    await handle.result();

    expect(parent.snapshot().worstChildAssessment).toBeUndefined();
  });

  it(
    'a breached child never flips the parent’s own reachability/progress/status — only ' +
      'worstChildAssessment reflects it',
    async () => {
      // `TOOL_CALL_POLICY` (AB-214) uses ONE `missedPulseThreshold` for
      // both `reachability` and `progress` — they cross into `unreachable`/
      // `stalled` on the exact same tick, so `deriveAssessment`'s
      // `reachability === 'unreachable'` branch always wins over the
      // `progress === 'stalled'` branch for a real tool-call-only child:
      // a genuinely stalled child's own top-level assessment is
      // `'unreachable'`, never `'alive-but-stalled'`, under the shipped
      // policy. This test proves the real end-to-end wiring with the
      // assessment the system actually produces; the fold's
      // `'alive-but-stalled'` case (and every other severity value) is
      // exercised directly, against a controlled assessment, in
      // `active-run-liveness.test.ts`'s "worstChildAssessment" suite —
      // together they cover both "the fold is correct" and "the fold is
      // wired to something real".
      const registry = createChildRunRegistry();
      const parent = makeLongLivedParent(registry);
      const parentBefore = parent.snapshot();
      expect(parentBefore.status).toBe('running');
      expect(parentBefore.reachability).toBe('unknown');
      expect(parentBefore.progress).toBe('unknown');

      const childClock = createManualClock();
      const hangingTool = createMockTool({
        name: 'hang',
        impl: () => new Promise<never>(() => {}), // never resolves
      });
      const childToolbox = createTestToolbox([hangingTool]);
      const child = makeClockedAgent(
        childClock,
        [{ content: '', toolCalls: [{ name: 'hang', arguments: {} }] }],
        childToolbox,
      );

      const toolDispatched = new Promise<void>((resolve) => {
        childToolbox.addEventListener('execute-start', () => resolve(), { once: true });
      });
      dispatchChildRun(child, 'go', { agentName: 'child', parentRunId: 'p', registry });

      // Wait for the child's tool call to actually start (the real
      // `execute-start` event, not a guessed number of microtask ticks),
      // then stall it by advancing ONLY the child's own clock — the
      // parent's clock (the real one, untouched) never advances.
      await toolDispatched;
      childClock.advance(TOOL_STALL_ADVANCE_MS);

      const parentAfter = parent.snapshot();
      expect(parentAfter.worstChildAssessment).toBe('unreachable');
      // The parent's own dimensions are exactly as they were BEFORE the
      // child stalled — its own never-resolving `generate()` call has by
      // now started (moving reachability/progress from 'unknown' to
      // 'reachable'/'progressing' on its own provider-turn pulse, nothing
      // to do with the child) but a breached child never additionally
      // flips them toward 'unreachable'/'stalled'.
      expect(parentAfter.status).toBe('running');
      expect(parentAfter.reachability).toBe('reachable');
      expect(parentAfter.progress).toBe('progressing');
    },
  );

  it(
    'delegated policy: the child classifies against its OWN tool-call StallPolicy/clock, ' +
      'never the parent’s — changing what the parent does has no effect on the child’s ' +
      'own assessment',
    async () => {
      const registry = createChildRunRegistry();
      const parent = makeLongLivedParent(registry);

      const childClock = createManualClock();
      const hangingTool = createMockTool({
        name: 'hang',
        impl: () => new Promise<never>(() => {}),
      });
      const childToolbox = createTestToolbox([hangingTool]);
      const child = makeClockedAgent(
        childClock,
        [{ content: '', toolCalls: [{ name: 'hang', arguments: {} }] }],
        childToolbox,
      );

      const toolDispatched = new Promise<void>((resolve) => {
        childToolbox.addEventListener('execute-start', () => resolve(), { once: true });
      });
      dispatchChildRun(child, 'go', { agentName: 'child', parentRunId: 'p', registry });

      await toolDispatched;
      childClock.advance(TOOL_STALL_ADVANCE_MS);

      // The registry's tracked assessment for the child (fed only from the
      // child's own `subscribeSnapshot`) and the parent's rollup of it
      // agree — the parent applies no policy of its own to the child's
      // evidence, it only reads the child's already-computed assessment
      // (AB-88's "delegated policy" obligation; AB-216's own acceptance
      // criteria).
      expect(registry.children()[0]?.assessment).toBe('unreachable');
      expect(parent.snapshot().worstChildAssessment).toBe('unreachable');

      // The parent constructs no watchdog for the child and reads no
      // `StallPolicy` selection from it — the parent's OWN provider-turn
      // dimensions are governed by `AGENT_RUN_PROVIDER_TURN_POLICY`
      // against the REAL clock the whole time, never the child's
      // `TOOL_CALL_POLICY`/manual clock: 'reachable'/'progressing' here
      // reflect only the parent's own never-resolving `generate()` call
      // having started, unaffected by the child's stall either way.
      expect(parent.snapshot().reachability).toBe('reachable');
      expect(parent.snapshot().progress).toBe('progressing');
    },
  );
});
