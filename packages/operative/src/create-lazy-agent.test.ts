import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import type { AgentRun, RunEvent } from './agent-run';
import { CompletedRunIterationError } from './agent-run';
import { createLazyAgent } from './create-lazy-agent';
import {
  AbortAgentRunError,
  AgentContractError,
  AgentRunError,
  AsyncDefinitionLoadError,
} from './errors';
import { RunCompletedEvent } from './events';
import type { RunnableAgent } from './runnable-agent';
import { OPERATIVE_RESOLVE_RUN_OPTIONS } from './runnable-agent';
import type { CleanupAcknowledgement, RunOptions, RunResult } from './types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A controllable fake AgentRun: push events, settle the result, and record abort()/dispose() calls. */
function createFakeAgentRun(): {
  handle: AgentRun<string, false>;
  push: (event: RunEvent) => void;
  settle: (result: RunResult<string, false>) => void;
  abortCalls: (string | undefined)[];
  abortChildCalls: { childId: string; reason: string | undefined }[];
  disposed: boolean;
  returnCalls: number;
} {
  const abortCalls: (string | undefined)[] = [];
  const abortChildCalls: { childId: string; reason: string | undefined }[] = [];
  let disposed = false;
  let returnCalls = 0;
  const buffered: RunEvent[] = [];
  let done = false;
  let waitResolve: ((value: IteratorResult<RunEvent>) => void) | null = null;
  let settleResult!: (result: RunResult<string, false>) => void;
  const resultPromise = new Promise<RunResult<string, false>>((resolve) => {
    settleResult = resolve;
  });

  const handle = {
    result(): Promise<RunResult<string, false>> {
      return resultPromise;
    },
    unwrap(): Promise<string> {
      return resultPromise.then((result) => {
        if (result.finishReason !== 'stop-condition') {
          throw result.error instanceof Error ? result.error : new Error('failed');
        }
        return result.content;
      });
    },
    abort(reason?: string): void {
      abortCalls.push(reason);
    },
    children(): readonly never[] {
      return [];
    },
    abortChild(childId: string, reason?: string): void {
      abortChildCalls.push({ childId, reason });
    },
    closed(): Promise<CleanupAcknowledgement> {
      return resultPromise.then(() => ({ status: 'completed' }) as const);
    },
    [Symbol.dispose](): void {
      disposed = true;
    },
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      return {
        next(): Promise<IteratorResult<RunEvent>> {
          if (buffered.length > 0) {
            const event = buffered.shift();
            if (event !== undefined) return Promise.resolve({ value: event, done: false });
          }
          if (done) return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
          return new Promise((resolve) => {
            waitResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<RunEvent>> {
          returnCalls += 1;
          done = true;
          if (waitResolve) {
            const resolve = waitResolve;
            waitResolve = null;
            resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
        },
      };
    },
  } as AgentRun<string, false>;

  return {
    handle,
    abortChildCalls,
    push(event) {
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        resolve({ value: event, done: false });
      } else {
        buffered.push(event);
      }
    },
    settle(result) {
      done = true;
      settleResult(result);
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        resolve({ value: undefined, done: true });
      }
    },
    abortCalls,
    get disposed() {
      return disposed;
    },
    get returnCalls() {
      return returnCalls;
    },
  };
}

function successResult(content: string): RunResult<string, false> {
  return {
    conversation: {} as RunResult['conversation'],
    steps: [],
    content,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop-condition',
  };
}

/**
 * Drains the microtask queue deterministically. Used where a test needs the
 * internal resolution chain (loader -> validate -> agent.run() -> store the
 * handle) to have fully settled before proceeding, without depending on a
 * guessed number of `Promise.resolve()` hops — which can shift under
 * coverage instrumentation or load and produce a flaky branch count rather
 * than a flaky assertion.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function drain(run: AgentRun<unknown, boolean>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of run) {
    events.push(event);
  }
  return events;
}

async function expectRejects(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<unknown> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect(error).toMatchObject(expected);
    return error;
  }
}

describe('createLazyAgent', () => {
  it('loads a direct agent once and caches it, sharing it across run() calls', () => {
    let loads = 0;
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => {
      loads += 1;
      return agent;
    });

    lazy.run('one');
    lazy.run('two');
    expect(loads).toBe(1);
  });

  it('shares the exact pending load across concurrent run() calls', async () => {
    let loads = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fakes = [createFakeAgentRun(), createFakeAgentRun()];
    let callIndex = 0;
    const lazy = createLazyAgent(async () => {
      loads += 1;
      await pending;
      const agent: RunnableAgent<string, false> = {
        name: 'fake',
        run: () => fakes[callIndex++]?.handle ?? fakes[0]!.handle,
      };
      return agent;
    });

    const first = lazy.run('one');
    const second = lazy.run('two');
    release();

    fakes[0]!.settle(successResult('a'));
    fakes[1]!.settle(successResult('b'));

    await first.result();
    await second.result();
    expect(loads).toBe(1);
  });

  it('retries after a failed load and preserves its cause', async () => {
    const cause = new Error('network');
    let loads = 0;
    const fake = createFakeAgentRun();
    const lazy = createLazyAgent(
      async () => {
        loads += 1;
        if (loads === 1) throw cause;
        return { name: 'fake', run: () => fake.handle } satisfies RunnableAgent<string, false>;
      },
      { label: 'retrying-agent' },
    );

    const failed = lazy.run('one');
    const result = await failed.result();
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(AsyncDefinitionLoadError);
    expect((result.error as AsyncDefinitionLoadError).cause).toBe(cause);
    expect((result.error as AsyncDefinitionLoadError).message).toBe(
      'Failed to load lazy agent "retrying-agent"',
    );

    fake.settle(successResult('ok'));
    const retried = lazy.run('two');
    const retriedResult = await retried.result();
    expect(retriedResult.content).toBe('ok');
    expect(loads).toBe(2);
  });

  it('handles a synchronous loader throw the same as an async load failure', async () => {
    const cause = new Error('sync');
    const lazy = createLazyAgent(() => {
      throw cause;
    });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(AsyncDefinitionLoadError);
    expect((result.error as AsyncDefinitionLoadError).cause).toBe(cause);
  });

  it('rejects a resolved value with no callable run() as an AgentContractError, not a load failure', async () => {
    const lazy = createLazyAgent(() => ({}) as unknown as RunnableAgent<never, false>, {
      label: 'bad-export',
    });

    const events: RunEvent[] = [];
    const run = lazy.run('one');
    for await (const event of run) events.push(event);
    const result = await run.result();

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect(result.error).toBeInstanceOf(AgentRunError);
    expect((result.error as AgentContractError).code).toBe('INVALID_AGENT_HANDLE');
    expect(events.map((event) => event.type)).toEqual(['run.error', 'run.completed']);
    expect((events.at(-1) as RunCompletedEvent).result).toBe(result);
  });

  it('rejects an invalid run() handle (missing abort) as an AgentContractError', async () => {
    const badHandle = { result: () => Promise.resolve(successResult('x')) } as unknown as AgentRun<
      string,
      false
    >;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => badHandle };
    const lazy = createLazyAgent(() => agent, { label: 'bad-handle' });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect((result.error as AgentContractError).code).toBe('INVALID_AGENT_HANDLE');
  });

  it('rejects a run() handle missing children()/abortChild() (AB-50) as an AgentContractError, not a raw TypeError', async () => {
    // Regression: without validating these two, a lazy-loaded older or
    // untyped third-party handle would pass this guard, start and finish
    // normally, and only fail later — as a raw `TypeError:
    // underlying.children is not a function` — the first time something
    // called the wrapper's own children()/abortChild(), instead of the
    // contract failure this validator exists to surface up front.
    const preAb50Handle = {
      result: () => Promise.resolve(successResult('x')),
      unwrap: () => Promise.resolve('x'),
      abort: () => {},
      [Symbol.dispose]: () => {},
      [Symbol.asyncIterator]: () => (async function* () {})(),
      // Deliberately omits `children`/`abortChild`.
    } as unknown as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => preAb50Handle };
    const lazy = createLazyAgent(() => agent, { label: 'pre-ab50-handle' });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect((result.error as AgentContractError).code).toBe('INVALID_AGENT_HANDLE');
  });

  it('rejects a run() handle missing closed() (AB-204) as an AgentContractError, not a raw TypeError', async () => {
    // Regression: a code-review finding on the AB-204 pull request — an
    // untyped or older lazy-loaded handle predating closed() would
    // otherwise pass this guard and only fail later, as a raw
    // `TypeError: underlying.closed is not a function`, the first time
    // this wrapper's own closed() delegates to it.
    let disposed = false;
    const preAb204Handle = {
      result: () => Promise.resolve(successResult('x')),
      unwrap: () => Promise.resolve('x'),
      abort: () => {},
      children: () => [],
      abortChild: () => {},
      [Symbol.dispose]: () => {
        disposed = true;
      },
      [Symbol.asyncIterator]: () => (async function* () {})(),
      // Deliberately omits `closed`.
    } as unknown as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => preAb204Handle };
    const lazy = createLazyAgent(() => agent, { label: 'pre-ab204-handle' });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect((result.error as AgentContractError).code).toBe('INVALID_AGENT_HANDLE');
    // Regression: a code-review finding on the AB-204 pull request —
    // agent.run() already started this handle's underlying work before the
    // validator rejected it; the rejection path must still dispose it
    // rather than leaking provider/tool work unobserved.
    expect(disposed).toBe(true);
    // Regression: a code-review finding on the AB-204 pull request —
    // cleanup was attempted, so this is not "nothing needed cleanup"
    // (`not-required`); but a non-throwing `[Symbol.dispose]()` is not
    // proof cleanup has actually completed either (the built-in `AgentRun`
    // disposer, for example, only requests cancellation synchronously and
    // lets the underlying work continue winding down) — without the
    // rejected handle's own acknowledgement, closed() can only report
    // `unresolved`/`unknown-effect`.
    expect(await run.closed()).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
  });

  it('rejects a run() handle that is null, not a raw TypeError probing its disposer', async () => {
    // Regression: a code-review finding on the AB-204 pull request —
    // `isValidAgentRunHandle(null)` correctly rejects a null handle, but
    // probing `[Symbol.dispose]` on it directly (without checking it is an
    // object first) would throw a raw TypeError outside the disposal
    // `try`, rejecting the detached resolution task and leaving
    // `resultPromise`/`closed()` pending forever instead of reaching
    // `finalizeSynthetic()`.
    const agent: RunnableAgent<string, false> = {
      name: 'fake',
      run: () => null as unknown as AgentRun<string, false>,
    };
    const lazy = createLazyAgent(() => agent, { label: 'null-handle' });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect((result.error as AgentContractError).code).toBe('INVALID_AGENT_HANDLE');
    expect(await run.closed()).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
  });

  it('swallows a throwing [Symbol.dispose] on a rejected invalid handle without masking the AgentContractError, but still reports the disposal failure through closed()', async () => {
    const disposalError = new Error('disposer itself is broken');
    const preAb204Handle = {
      result: () => Promise.resolve(successResult('x')),
      unwrap: () => Promise.resolve('x'),
      abort: () => {},
      children: () => [],
      abortChild: () => {},
      [Symbol.dispose]: () => {
        throw disposalError;
      },
      [Symbol.asyncIterator]: () => (async function* () {})(),
      // Deliberately omits `closed`.
    } as unknown as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => preAb204Handle };
    const lazy = createLazyAgent(() => agent, { label: 'pre-ab204-handle-throwing-dispose' });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect((result.error as AgentContractError).code).toBe('INVALID_AGENT_HANDLE');
    // Regression: a code-review finding on the AB-204 pull request — a
    // throwing disposer means cleanup genuinely failed; closed() must not
    // silently claim `completed`/`not-required` for that.
    expect(await run.closed()).toEqual({ status: 'failed', error: disposalError });
  });

  it('reports closed() as unresolved/unknown-effect for a rejected invalid handle with no disposer to call at all', async () => {
    const noDisposeHandle = {
      result: () => Promise.resolve(successResult('x')),
      unwrap: () => Promise.resolve('x'),
      abort: () => {},
      children: () => [],
      abortChild: () => {},
      [Symbol.asyncIterator]: () => (async function* () {})(),
      // Deliberately omits both `closed` and `[Symbol.dispose]`.
    } as unknown as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => noDisposeHandle };
    const lazy = createLazyAgent(() => agent, { label: 'no-dispose-handle' });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.error).toBeInstanceOf(AgentContractError);

    expect(await run.closed()).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
  });

  it('wraps a synchronous throw from the underlying run() as an AgentContractError', async () => {
    const agent: RunnableAgent<string, false> = {
      name: 'fake',
      run: () => {
        throw new Error('boom');
      },
    };
    const lazy = createLazyAgent(() => agent, { label: 'throwing-run' });

    const run = lazy.run('one');
    const result = await run.result();
    expect(result.error).toBeInstanceOf(AgentContractError);
    expect((result.error as AgentContractError).cause).toBeInstanceOf(Error);
  });

  it('does not retry the loader for a contract failure, since the load itself succeeded', async () => {
    let loads = 0;
    const lazy = createLazyAgent(
      () => {
        loads += 1;
        return {} as unknown as RunnableAgent<never, false>;
      },
      { label: 'bad-export' },
    );

    await lazy.run('one').result();
    await lazy.run('two').result();
    expect(loads).toBe(1);
  });

  it('returns synchronously, buffers events emitted before load resolves, and forwards the real result', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(async () => {
      await pending;
      return agent;
    });

    const run = lazy.run('hello');
    // Synchronous return — no await needed before this point.
    expect(typeof run.result).toBe('function');

    const collecting = drain(run);
    release();
    await flushMicrotasks();
    fake.push(new RunCompletedEvent(successResult('done')));
    fake.settle(successResult('done'));

    const events = await collecting;
    expect(events).toHaveLength(1);
    expect(await run.result()).toEqual(successResult('done'));
    expect(await run.unwrap()).toBe('done');
  });

  it('aborts before resolution: the underlying agent.run() is never called', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    let runCalls = 0;
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = {
      name: 'fake',
      run: () => {
        runCalls += 1;
        return fake.handle;
      },
    };
    const lazy = createLazyAgent(async () => {
      await pending;
      return agent;
    });

    const run = lazy.run('hello');
    run.abort('cancelled before load');
    release();

    const result = await run.result();
    expect(runCalls).toBe(0);
    expect(result.finishReason).toBe('aborted');
    expect(result.error).toBeInstanceOf(AbortAgentRunError);
  });

  it('closed() resolves completed once settled when no underlying run ever existed, cached across repeat calls (AB-204)', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(async () => {
      await pending;
      return agent;
    });

    const run = lazy.run('hello');
    const closedAcknowledgement = run.closed();
    run.abort('cancelled before load');
    release();
    await run.result();

    const first = await closedAcknowledgement;
    expect(first).toEqual({ status: 'completed' });
    expect(await run.closed()).toBe(first);
  });

  // Regression: a code-review finding on the AB-204 pull request — closed()
  // used to await `resultPromise` before ever consulting `options.signal`,
  // so a caller-supplied timeout could not bound this call's wait; it just
  // hung until the underlying agent resolved (or never, if the loader hangs).
  it('closed({ signal }) resolves unresolved/timed-out promptly even while the underlying agent is still loading', async () => {
    const neverResolves = new Promise<RunnableAgent<string, false>>(() => {});
    const lazy = createLazyAgent(() => neverResolves);

    const run = lazy.run('hello');
    const controller = new AbortController();
    const timedOutCall = run.closed({ signal: controller.signal });
    controller.abort();

    expect(await timedOutCall).toEqual({ status: 'unresolved', reason: 'timed-out' });
  });

  it('emits an aborted event followed by completion when abort wins before resolution', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(async () => {
      await pending;
      return agent;
    });

    const run = lazy.run('hello');
    const collecting = drain(run);
    run.abort('cancelled');
    release();

    const events = await collecting;
    expect(events.map((event) => event.type)).toEqual(['run.aborted', 'run.completed']);
  });

  it('aborts after resolution: stores the handle, then forwards to it exactly once', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    // Give the internal resolution microtask a turn to store the handle.
    await flushMicrotasks();

    run.abort('first');
    run.abort('second');
    fake.settle(successResult('done'));
    await run.result();

    expect(fake.abortCalls).toEqual(['first']);
  });

  it('closed() delegates to the underlying handle once one exists (AB-204)', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    await flushMicrotasks();

    const closedAcknowledgement = run.closed();
    fake.settle(successResult('done'));

    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  // Regression: a code-review finding on the AB-204 pull request —
  // [Symbol.dispose]() delegates straight to the underlying handle's own
  // disposer without setting cancelRequested when underlying already
  // exists, so a first closed() call after settlement could wrongly take
  // the not-required fast path and skip delegation, potentially hiding a
  // real underlying cleanup outcome. Uses a handle whose closed() reports
  // something distinguishable from both `completed` and `not-required` to
  // prove delegation genuinely happened.
  it('marks the wrapper as cancelled when [Symbol.dispose]() is called after resolution, disqualifying the not-required fast path', async () => {
    const closedFailure = {
      status: 'failed',
      error: new Error('underlying cleanup failed'),
    } as const;
    let resultSettled!: (result: RunResult<string, false>) => void;
    const resultPromise = new Promise<RunResult<string, false>>((resolve) => {
      resultSettled = resolve;
    });
    const underlyingHandle = {
      result: () => resultPromise,
      unwrap: () => resultPromise.then((r) => r.content),
      abort() {},
      children: () => [],
      abortChild() {},
      closed: () => Promise.resolve(closedFailure),
      [Symbol.dispose]() {},
      [Symbol.asyncIterator]: () => (async function* () {})(),
    } as unknown as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => underlyingHandle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    await flushMicrotasks();

    run[Symbol.dispose]();
    resultSettled(successResult('done'));
    await run.result();
    await Promise.resolve();

    expect(await run.closed()).toEqual(closedFailure);
  });

  it('closed() delegates to the underlying run once it exists, even with no cancellation (AB-204)', async () => {
    // Regression: a code-review finding on the AB-204 pull request
    // (PRRT_kwDORvupsc6esJjg) — once `underlying` exists, its own
    // acknowledgement must always be consulted, even with no cancellation
    // at all. An underlying run can fulfill `result()` with a nontrivial
    // cleanup outcome entirely on its own (e.g. a durable Bureau path
    // hitting an engine disposal it classifies `unresolved`/`unreachable`
    // with no cancellation involved); taking the `not-required` fast path
    // here instead would silently hide that. Same class of bug the session
    // wrapper's `activeInnerRun` check already fixed
    // (PRRT_kwDORvupsc6enump).
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    await flushMicrotasks();
    fake.settle(successResult('done'));
    await run.result();
    await Promise.resolve();

    // `createFakeAgentRun`'s `closed()` resolves `completed` once its
    // result settles — this proves `underlying.closed()` was actually
    // consulted, not a `not-required` fast path that never called it.
    expect(await run.closed()).toEqual({ status: 'completed' });
  });

  // Regression: a code-review finding on the AB-204 pull request — once
  // `underlying` exists, this wrapper detaches its own `context.signal`
  // listener and ownership transfers directly to the underlying agent's
  // run() (see `detachSignalListener`). A cancellation delivered through
  // that same signal AFTER detachment never sets `cancelRequested`, so the
  // disqualifier must still read the signal directly.
  it('closed() disqualifies not-required when context.signal fires after this wrapper has already detached its own listener', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);
    const controller = new AbortController();

    const run = lazy.run('hello', { signal: controller.signal });
    await flushMicrotasks();
    fake.settle(successResult('done'));
    await run.result();
    await Promise.resolve();

    // Fires AFTER settlement — well after this wrapper's own listener
    // (detached once `underlying` was stored) could ever observe it.
    controller.abort('fired after detachment');

    expect(await run.closed()).not.toEqual({ status: 'not-required' });
  });

  it('children()/abortChild() read empty/no-op before resolution and delegate to the underlying handle once resolved', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');

    // Before the internal resolution microtask has run, there is no
    // underlying handle yet — both read as the safe, opt-in default.
    expect(run.children()).toEqual([]);
    expect(() => run.abortChild('child-1', 'too soon')).not.toThrow();

    await flushMicrotasks();

    run.abortChild('child-1', 'now resolved');
    fake.settle(successResult('done'));
    await run.result();

    expect(fake.abortChildCalls).toEqual([{ childId: 'child-1', reason: 'now resolved' }]);
  });

  it('honors an already-aborted context.signal without calling the loader', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    let loads = 0;
    const lazy = createLazyAgent(async () => {
      loads += 1;
      const fake = createFakeAgentRun();
      return { name: 'fake', run: () => fake.handle } satisfies RunnableAgent<string, false>;
    });

    const run = lazy.run('hello', { signal: controller.signal });
    const result = await run.result();
    expect(result.finishReason).toBe('aborted');
    expect(result.error).toBeInstanceOf(AbortAgentRunError);
    // The loader itself is still invoked (module load isn't cancellable),
    // but the underlying agent's run() must not be — proven by the
    // synthesized 'aborted' result rather than a delegated one.
    expect(loads).toBe(1);
  });

  it('routes a context.signal abort fired during load through the same abort path', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    let runCalls = 0;
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = {
      name: 'fake',
      run: () => {
        runCalls += 1;
        return fake.handle;
      },
    };
    const lazy = createLazyAgent(async () => {
      await pending;
      return agent;
    });

    const run = lazy.run('hello', { signal: controller.signal });
    controller.abort('mid-load');
    release();

    const result = await run.result();
    expect(runCalls).toBe(0);
    expect(result.finishReason).toBe('aborted');
  });

  it('disposes the underlying handle when started, or aborts when still waiting', async () => {
    const fakeStarted = createFakeAgentRun();
    const startedAgent: RunnableAgent<string, false> = { name: 'a', run: () => fakeStarted.handle };
    const startedLazy = createLazyAgent(() => startedAgent);
    const startedRun = startedLazy.run('hello');
    await flushMicrotasks();
    startedRun[Symbol.dispose]();
    expect(fakeStarted.disposed).toBe(true);

    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fakeWaiting = createFakeAgentRun();
    const waitingLazy = createLazyAgent(async () => {
      await pending;
      return { name: 'b', run: () => fakeWaiting.handle } satisfies RunnableAgent<string, false>;
    });
    const waitingRun = waitingLazy.run('hello');
    waitingRun[Symbol.dispose]();
    release();
    const result = await waitingRun.result();
    expect(result.finishReason).toBe('aborted');
  });

  it('output() delegates to the underlying handle when present, and rejects with a contract error otherwise', async () => {
    const fake = createFakeAgentRun();
    const withOutput = {
      ...fake.handle,
      output: () => Promise.resolve('typed-value'),
    } as unknown as AgentRun<string, true>;
    const agent: RunnableAgent<string, true> = { name: 'fake', run: () => withOutput };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    fake.settle(successResult('typed-value'));
    const outputValue = await run.output();
    expect(outputValue).toBe('typed-value');

    const noOutputFake = createFakeAgentRun();
    const noOutputAgent: RunnableAgent<never, false> = {
      name: 'fake',
      run: () => noOutputFake.handle,
    };
    const noOutputLazy = createLazyAgent(() => noOutputAgent);
    const noOutputRun = noOutputLazy.run('hello') as unknown as AgentRun<never, true>;
    await flushMicrotasks();
    noOutputFake.settle(successResult('x'));
    await expectRejects(noOutputRun.output(), {
      name: 'AgentContractError',
      code: 'INVALID_AGENT_HANDLE',
    });
  });

  it('returns an ordinary RunnableAgent with no stateful helper API', () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent, { label: 'named' });

    expect(lazy.name).toBe('named');
    expect(typeof lazy.run).toBe('function');
    expect('then' in lazy).toBe(false);
    const run = lazy.run('hi');
    expect('then' in run).toBe(false);
  });

  it('forwards the definition-resolution protocol without invoking the public run() handle', async () => {
    let runCalls = 0;
    const resolvedOptions = { marker: 'resolved-run-options' } as unknown as RunOptions;
    const agent: RunnableAgent<never, false> & {
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: string) => Promise<RunOptions>;
    } = {
      name: 'durable-agent',
      run: () => {
        runCalls += 1;
        return createFakeAgentRun().handle;
      },
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: async () => resolvedOptions,
    };
    const lazy = createLazyAgent(() => agent);

    const resolver = (
      lazy as RunnableAgent<never, false> & {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: string) => Promise<RunOptions>;
      }
    )[OPERATIVE_RESOLVE_RUN_OPTIONS];
    const options = await resolver('hello');

    expect(options).toBe(resolvedOptions);
    expect(runCalls).toBe(0);
  });

  it('rejects definition resolution with an AgentContractError when the underlying agent has none', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const resolver = (
      lazy as RunnableAgent<string, false> & {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: string) => Promise<RunOptions>;
      }
    )[OPERATIVE_RESOLVE_RUN_OPTIONS];

    await expectRejects(resolver('hello'), {
      name: 'AgentContractError',
      code: 'INVALID_AGENT_HANDLE',
    });
  });

  it('builds the fallback conversation from a resumed {conversation} input for a synthetic result', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    const lazy = createLazyAgent(async () => {
      const fake = createFakeAgentRun();
      return { name: 'fake', run: () => fake.handle } satisfies RunnableAgent<string, false>;
    });

    const seed = new Conversation();
    seed.appendUserMessage('resumed');
    const run = lazy.run({ conversation: seed.current }, { signal: controller.signal });
    const result = await run.result();

    expect(result.finishReason).toBe('aborted');
    expect(result.conversation).toBeDefined();
  });

  it('unwrap() throws the synthetic error when the run never started', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    const lazy = createLazyAgent(async () => {
      const fake = createFakeAgentRun();
      return { name: 'fake', run: () => fake.handle } satisfies RunnableAgent<string, false>;
    });

    const run = lazy.run('hello', { signal: controller.signal });
    await expectRejects(run.unwrap(), { name: 'AbortAgentRunError' });
  });

  it('output() throws the synthetic error when the run never started', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    const lazy = createLazyAgent(async () => {
      const fake = createFakeAgentRun();
      return {
        name: 'fake',
        run: () => fake.handle as unknown as AgentRun<string, true>,
      } satisfies RunnableAgent<string, true>;
    });

    const run = lazy.run('hello', { signal: controller.signal });
    await expectRejects(run.output(), { name: 'AbortAgentRunError' });
  });

  it('surfaces an error thrown mid-iteration while a consumer is already parked (direct-reject path)', async () => {
    let releaseNext!: () => void;
    const nextGate = new Promise<void>((resolve) => (releaseNext = resolve));
    const throwingHandle = {
      result: () => new Promise<RunResult<string, false>>(() => {}),
      unwrap: () => new Promise<string>(() => {}),
      abort() {},
      children: () => [],
      abortChild() {},
      closed: () => Promise.resolve({ status: 'completed' }),
      [Symbol.dispose]() {},
      [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
        return {
          async next(): Promise<IteratorResult<RunEvent>> {
            await nextGate;
            throw new Error('iteration failed');
          },
        };
      },
    } as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => throwingHandle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    const collecting = drain(run);
    // Give `pump()` a turn to reach the parked `next()` call before the
    // underlying iterator actually rejects — this is the "consumer already
    // waiting" (direct-reject) path, distinct from the buffered path below.
    await flushMicrotasks();
    releaseNext();
    await expectRejects(collecting, { message: 'iteration failed' });
  });

  it('surfaces an error thrown mid-iteration by the underlying handle, buffered for a later consumer', async () => {
    const throwingHandle = {
      result: () => new Promise<RunResult<string, false>>(() => {}),
      unwrap: () => new Promise<string>(() => {}),
      abort() {},
      children: () => [],
      abortChild() {},
      closed: () => Promise.resolve({ status: 'completed' }),
      [Symbol.dispose]() {},
      [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
        return {
          next(): Promise<IteratorResult<RunEvent>> {
            return Promise.reject(new Error('iteration failed'));
          },
        };
      },
    } as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => throwingHandle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    // Start iteration (which starts the deferred event pump) but don't call
    // `next()` yet — let the underlying failure land in the queue BEFORE
    // anyone is parked waiting for it, exercising the "buffer the error, no
    // active waiter" path (`hasPendingError`) rather than the direct-reject
    // path a synchronous `for await` would hit instead.
    const iterator = run[Symbol.asyncIterator]();
    await flushMicrotasks();
    await expectRejects(iterator.next(), { message: 'iteration failed' });

    // A second, fresh iteration of a different run exercises early-exit
    // (`return()`), which the first run's already-failed queue cannot.
    const earlyFake = createFakeAgentRun();
    const earlyAgent: RunnableAgent<string, false> = { name: 'early', run: () => earlyFake.handle };
    const earlyLazy = createLazyAgent(() => earlyAgent);
    const earlyRun = earlyLazy.run('hello');
    earlyFake.push(new RunCompletedEvent(successResult('first')));
    for await (const _event of earlyRun) {
      break;
    }
    earlyFake.settle(successResult('first'));
    await earlyRun.result();
  });

  it('stops pumping and propagates return() to the underlying run when the consumer exits early', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    fake.push(new RunCompletedEvent(successResult('first')));
    for await (const _event of run) {
      break;
    }
    await flushMicrotasks();

    // The pump loop must have stopped draining `fake` and forwarded the
    // early exit onto its iterator — not kept pulling and buffering events
    // nobody will ever read.
    expect(fake.returnCalls).toBe(1);

    // The queue itself is marked done by the early return, so a later
    // iteration attempt is rejected the same way re-iterating an already
    // completed run is, rather than silently splitting or replaying events.
    expect(() => run[Symbol.asyncIterator]()).toThrowError(CompletedRunIterationError);

    fake.settle(successResult('first'));
    await run.result();
  });

  it('rejects a second concurrent iteration of the same run with CompletedRunIterationError', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    // Establish the first iterator (buffers, doesn't need to complete).
    const iterator = run[Symbol.asyncIterator]();
    void iterator.next();

    expect(() => run[Symbol.asyncIterator]()).toThrowError(CompletedRunIterationError);

    fake.settle(successResult('done'));
    await run.result();
  });

  it('rejects re-iterating an already-completed run with CompletedRunIterationError', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    fake.settle(successResult('done'));
    await drain(run);

    expect(() => run[Symbol.asyncIterator]()).toThrowError(CompletedRunIterationError);
  });

  it('folds a rejected underlying result() into an error RunResult instead of hanging forever', async () => {
    const rejection = new Error('result rejected');
    const queuelessHandle = {
      result: () => Promise.reject(rejection),
      unwrap: () => Promise.reject(rejection),
      abort() {},
      children: () => [],
      abortChild() {},
      closed: () => Promise.resolve({ status: 'completed' }),
      [Symbol.dispose]() {},
      [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
        return {
          next(): Promise<IteratorResult<RunEvent>> {
            return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
          },
        };
      },
    } as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => queuelessHandle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    const result = await run.result();

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(AgentRunError);
    expect((result.error as AgentRunError).cause).toBe(rejection);
  });

  it('never subscribes to the underlying event stream for a result()-only consumer', async () => {
    let iteratorRequests = 0;
    const fake = createFakeAgentRun();
    const trackedHandle = {
      ...fake.handle,
      [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
        iteratorRequests += 1;
        return fake.handle[Symbol.asyncIterator]();
      },
    } as AgentRun<string, false>;
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => trackedHandle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    await flushMicrotasks();
    fake.settle(successResult('done'));
    const result = await run.result();

    expect(result.content).toBe('done');
    expect(iteratorRequests).toBe(0);
  });

  it('starts draining the underlying event stream once the consumer iterates, even if that happens after resolution', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello');
    await flushMicrotasks();
    fake.push(new RunCompletedEvent(successResult('done')));
    fake.settle(successResult('done'));

    const events = await drain(run);
    expect(events).toHaveLength(1);
  });

  it('resolveRunOptions surfaces AgentContractError, not a raw TypeError, for an invalid loaded value', async () => {
    const lazy = createLazyAgent(() => ({}) as unknown as RunnableAgent<never, false>, {
      label: 'bad-export',
    });

    const resolver = (
      lazy as RunnableAgent<never, false> & {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: string) => Promise<RunOptions>;
      }
    )[OPERATIVE_RESOLVE_RUN_OPTIONS];

    await expectRejects(resolver('hello'), {
      name: 'AgentContractError',
      code: 'INVALID_AGENT_HANDLE',
    });
  });

  it('invokes a method-style definition resolver with the resolved agent as its receiver', async () => {
    let capturedThis: unknown;
    const resolvedOptions = { marker: 'resolved' } as unknown as RunOptions;
    const agent = {
      name: 'stateful',
      run: () => createFakeAgentRun().handle,
      [OPERATIVE_RESOLVE_RUN_OPTIONS](this: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- deliberately capturing the receiver to assert on it
        capturedThis = this;
        return Promise.resolve(resolvedOptions);
      },
    } satisfies RunnableAgent<never, false> & {
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: string) => Promise<RunOptions>;
    };
    const lazy = createLazyAgent(() => agent);

    const resolver = (
      lazy as RunnableAgent<never, false> & {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: string) => Promise<RunOptions>;
      }
    )[OPERATIVE_RESOLVE_RUN_OPTIONS];
    const options = await resolver('hello');

    expect(options).toBe(resolvedOptions);
    expect(capturedThis).toBe(agent);
  });

  it('gives each synthetic RunResult its own usage object, never a shared mutable singleton', async () => {
    const first = createLazyAgent(() => {
      throw new Error('boom-1');
    });
    const second = createLazyAgent(() => {
      throw new Error('boom-2');
    });

    const firstResult = await first.run('one').result();
    const secondResult = await second.run('two').result();

    expect(firstResult.usage).not.toBe(secondResult.usage);
    firstResult.usage.total = 999;
    expect(secondResult.usage.total).toBe(0);
  });

  it('disposes a handle returned by agent.run() when abort raced it synchronously', async () => {
    const controller = new AbortController();
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = {
      name: 'fake',
      run: () => {
        // A custom agent that reacts to the shared signal synchronously,
        // inside its own run() — before this call even returns a handle.
        controller.abort('synchronous abort inside run()');
        return fake.handle;
      },
    };
    const lazy = createLazyAgent(() => agent);

    const run = lazy.run('hello', { signal: controller.signal });
    const result = await run.result();

    expect(result.finishReason).toBe('aborted');
    expect(fake.disposed).toBe(true);
  });

  it('does not forward a signal-driven abort to the underlying handle twice once started', async () => {
    const controller = new AbortController();
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => agent);

    lazy.run('hello', { signal: controller.signal });
    await flushMicrotasks();
    controller.abort('after started');

    expect(fake.abortCalls).toEqual([]);
    fake.settle(successResult('done'));
  });

  it('snapshots context at run() call time, so a later mutation of the caller object does not leak in', async () => {
    let observedAgentName: string | undefined;
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = {
      name: 'fake',
      run: (_input, context) => {
        observedAgentName = context?.agentName;
        return fake.handle;
      },
    };
    const lazy = createLazyAgent(() => agent);

    const mutableContext = { agentName: 'original' };
    lazy.run('hello', mutableContext);
    mutableContext.agentName = 'mutated-after-run';
    await flushMicrotasks();

    expect(observedAgentName).toBe('original');
    fake.settle(successResult('done'));
  });

  it('accepts a loader resolving to a { default } module namespace object, per AB-15', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    const lazy = createLazyAgent(() => Promise.resolve({ default: agent }));

    const run = lazy.run('hello');
    fake.settle(successResult('done'));
    const result = await run.result();

    expect(result.content).toBe('done');
  });

  it('unwraps a module namespace default even when it also exports an unrelated top-level run function', async () => {
    const fake = createFakeAgentRun();
    const agent: RunnableAgent<string, false> = { name: 'fake', run: () => fake.handle };
    let unrelatedRunCalls = 0;
    // A module namespace object: `default` is the real agent, but the module
    // also happens to export an unrelated top-level `run` function (e.g. a
    // helper re-exported alongside the agent). The namespace object itself
    // has no `name`, so `isRunnableAgent` must reject it and fall through to
    // unwrapping `default` — never invoke the unrelated `run`.
    const moduleNamespace = {
      default: agent,
      run: (): void => {
        unrelatedRunCalls += 1;
      },
    };
    const lazy = createLazyAgent(() => Promise.resolve(moduleNamespace));

    const run = lazy.run('hello');
    fake.settle(successResult('done'));
    const result = await run.result();

    expect(result.content).toBe('done');
    expect(unrelatedRunCalls).toBe(0);
  });

  it('snapshots resolveRunOptions input before awaiting the loader', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    let observedOptions: RunOptions | undefined;
    const agent: RunnableAgent<never, false> & {
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: {
        conversation: { marker: string };
      }) => Promise<RunOptions>;
    } = {
      name: 'fake',
      run: () => createFakeAgentRun().handle,
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input) => {
        observedOptions = input as unknown as RunOptions;
        return Promise.resolve({} as RunOptions);
      },
    };
    const lazy = createLazyAgent(async () => {
      await pending;
      return agent;
    });

    const resolver = (
      lazy as RunnableAgent<never, false> & {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: (input: {
          conversation: { marker: string };
        }) => Promise<RunOptions>;
      }
    )[OPERATIVE_RESOLVE_RUN_OPTIONS];

    const mutableHistory = { marker: 'original' };
    const resolving = resolver({ conversation: mutableHistory });
    mutableHistory.marker = 'mutated-during-load';
    release();
    await resolving;

    expect(
      (observedOptions as unknown as { conversation: { marker: string } } | undefined)?.conversation
        .marker,
    ).toBe('original');
  });

  it('snapshots resolveRunOptions context before awaiting the loader', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    let observedAgentName: string | undefined;
    const agent: RunnableAgent<never, false> & {
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: (
        input: string,
        context?: { agentName?: string },
      ) => Promise<RunOptions>;
    } = {
      name: 'fake',
      run: () => createFakeAgentRun().handle,
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: (_input, context) => {
        observedAgentName = context?.agentName;
        return Promise.resolve({} as RunOptions);
      },
    };
    const lazy = createLazyAgent(async () => {
      await pending;
      return agent;
    });

    const resolver = (
      lazy as RunnableAgent<never, false> & {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: (
          input: string,
          context?: { agentName?: string },
        ) => Promise<RunOptions>;
      }
    )[OPERATIVE_RESOLVE_RUN_OPTIONS];

    const mutableContext = { agentName: 'original' };
    const resolving = resolver('hello', mutableContext);
    mutableContext.agentName = 'mutated-during-load';
    release();
    await resolving;

    expect(observedAgentName).toBe('original');
  });
});
