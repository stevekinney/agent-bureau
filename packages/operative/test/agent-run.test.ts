/**
 * Behavioral tests for `createAgentRun` — the non-thenable run handle (B1).
 *
 * Acceptance criteria from plan.md §B1:
 *   (a) iterate-then-result() returns the cached terminal value without re-running
 *   (b) result() is idempotent (callable before/after/without iteration)
 *   (c) the async iterator is independent of result-resolution state
 *   (d) a second `for await` on a completed run errors or replays predictably, never hangs
 */
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { CompletedRunIterationError, createAgentRun } from '../src/agent-run';
import { noToolCalls } from '../src/conditions/predicates';
import { type ActiveRun, createActiveRun as createRun } from '../src/create-run';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

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
