/**
 * Behavioral tests for `dispatchChildRun` and `createChildRunRegistry`
 * (AB-50) — the lower-level child dispatch primitive `createSubagentTool`
 * is built on top of (see `create-subagent-tool.test.ts` for the tool-level
 * coverage, including AB-64 summary isolation).
 *
 * Acceptance criteria covered here:
 *   - the handle carries `childRunId`, `parentRunId`, `agentName`, async
 *     event iteration, `result()`, `abort()`, and disposal
 *   - the child emits started/completed/failed/aborted events, correlated
 *     by `parentRunId` and `childRunId`
 *   - a parent abort and a child-targeted abort both stop the child
 *   - two concurrently retained child handles are distinguishable
 *   - `createChildRunRegistry` backs discovery/scoped cancellation:
 *     idempotent on an unknown or already-terminal id, never propagates to
 *     a sibling
 */
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';

import { createAgentRun } from './agent-run';
import {
  attenuateDelegatedAuthority,
  createChildRunRegistry,
  dispatchChildRun,
  type DispatchChildRunOptions,
  listChildRuns,
} from './child-run';
import { noToolCalls } from './conditions/predicates';
import { createAgent } from './create-agent';
import { createActiveRun as createRun } from './create-run';
import type { CombinedOperativeEventMap } from './events';
import {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
  ChildWorkflowProgressEvent,
  ChildWorkflowReattachedEvent,
  ChildWorkflowStartedEvent,
} from './events';
import { createModelCatalog } from './providers/model-catalog.ts';
import { composePolicy, type DelegatedAuthority } from './providers/policy.ts';
import { select } from './providers/selection.ts';
import type { AgentInput, AgentRunContext, RunnableAgent } from './runnable-agent';
import { createMockGenerate } from './test/index';
import type { GenerateResponse, RunResult } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  input: AgentInput;
  context: AgentRunContext | undefined;
}

/**
 * A `RunnableAgent` test double whose `.run()` result and abort behavior are
 * fully caller-controlled — precise enough to exercise every terminal
 * classification `dispatchChildRun` distinguishes (completed/failed/aborted)
 * without depending on a real agent loop's own timing.
 */
function makeControllableAgent<O = never, H extends boolean = false>(): {
  agent: RunnableAgent<O, H>;
  calls: RecordedCall[];
  settle: (result: RunResult<O, H>) => void;
  abortedSignals: AbortSignal[];
} {
  const calls: RecordedCall[] = [];
  const abortedSignals: AbortSignal[] = [];
  let resolveResult: ((result: RunResult<O, H>) => void) | undefined;
  const resultPromise = new Promise<RunResult<O, H>>((resolve) => {
    resolveResult = resolve;
  });

  const agent: RunnableAgent<O, H> = {
    name: 'controllable',
    hasOutput: false,
    run(input, context) {
      calls.push({ input, context });
      context?.signal?.addEventListener('abort', () => {
        if (context.signal) abortedSignals.push(context.signal);
      });
      return {
        result: () => resultPromise,
        unwrap: () => resultPromise.then((r) => r.content as never),
        abort: () => {},
        [Symbol.dispose]: () => {},
        [Symbol.asyncIterator]: () => (async function* () {})(),
      } as unknown as ReturnType<RunnableAgent<O, H>['run']>;
    },
  };

  return {
    agent,
    calls,
    abortedSignals,
    settle: (result) => resolveResult?.(result),
  };
}

/**
 * A `RunnableAgent` whose `run().result()` REJECTS rather than resolving
 * with a terminal `RunResult` — an unexpected throw from the underlying
 * agent, as distinct from every ordinary terminal (including an aborted
 * one, which `AgentRun.result()` is documented to resolve, not reject).
 */
function makeRejectingAgent(error: Error): RunnableAgent {
  // `async () => { throw error; }` produces the same rejected promise as
  // `() => Promise.reject(error)` without an explicit `Promise.reject` call
  // — a test double for "the underlying `result()` promise itself rejects",
  // the one `dispatchChildRun` outcome a scripted `finishReason` can't
  // reach. `dispatchChildRun` chains `.then()` onto this synchronously, so
  // it's never left unhandled.
  const reject = async (): Promise<never> => {
    throw error;
  };
  return {
    name: 'rejecting',
    hasOutput: false,
    run: () =>
      ({
        result: reject,
        unwrap: reject,
        abort: () => {},
        [Symbol.dispose]: () => {},
        [Symbol.asyncIterator]: () => (async function* () {})(),
      }) as unknown as ReturnType<RunnableAgent['run']>,
  };
}

function makeEmitter() {
  return new CompletableEventTarget<CombinedOperativeEventMap>();
}

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    conversation: {} as never,
    content: 'ok',
    finishReason: 'stop-condition',
    steps: [],
    usage: { prompt: 1, completion: 1, total: 2 },
    ...overrides,
  };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/**
 * A `RunnableAgent` whose `.run()` returns a REAL `AgentRun` (wrapping a
 * real `ActiveRun`, via `createRun`/`createAgentRun`) rather than a hand
 * cast test double — the only kind of agent that actually implements
 * AB-88's `LivenessObservable` (`snapshot()`/`subscribeSnapshot()`),
 * needed to exercise AB-216's `attachLiveness` wiring end to end. A
 * `makeControllableAgent()`/`makeRejectingAgent()` double deliberately does
 * NOT implement this — `hasLivenessObservable`'s guard (see
 * `child-run.ts`) is what keeps `dispatchChildRun` from throwing against
 * those, exercised implicitly by every other test in this file.
 */
function makeRealAgent(responses: GenerateResponse[] = [textResponse('hello')]): RunnableAgent {
  const generate = createMockGenerate(responses);
  const toolbox = createTestToolbox([]);
  return createAgent({ name: 'real-child', generate, toolbox, stopWhen: noToolCalls() });
}

// ---------------------------------------------------------------------------
// The handle's own shape
// ---------------------------------------------------------------------------

describe('dispatchChildRun — handle shape', () => {
  it('carries childRunId, parentRunId, and agentName', () => {
    const { agent } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'do the thing', {
      agentName: 'researcher',
      parentRunId: 'run-parent-1',
      childRunId: 'child-fixed-1',
    });

    expect(handle.childRunId).toBe('child-fixed-1');
    expect(handle.parentRunId).toBe('run-parent-1');
    expect(handle.agentName).toBe('researcher');
  });

  it('generates a childRunId when none is supplied, distinct across dispatches', () => {
    const { agent } = makeControllableAgent();
    const first = dispatchChildRun(agent, 'a', { agentName: 'a', parentRunId: 'p' });
    const second = dispatchChildRun(agent, 'b', { agentName: 'b', parentRunId: 'p' });

    expect(first.childRunId).toBeTruthy();
    expect(second.childRunId).toBeTruthy();
    expect(first.childRunId).not.toBe(second.childRunId);
  });

  it('resolves result() to the child agent.run()s terminal RunResult', async () => {
    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p' });

    settle(makeResult({ content: 'done' }));

    const result = await handle.result();
    expect(result.content).toBe('done');
  });

  it('supports async iteration of the child agent.run()s own event stream', async () => {
    const { agent } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p' });

    const events: unknown[] = [];
    for await (const event of handle) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });

  it('[Symbol.dispose]() aborts the child', async () => {
    const { agent, calls } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p' });

    handle[Symbol.dispose]();

    expect(calls[0]?.context?.signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle events with parent-child correlation
// ---------------------------------------------------------------------------

describe('dispatchChildRun — lifecycle events', () => {
  it('emits ChildWorkflowStartedEvent before the child runs, correlated by parentRunId/childRunId', () => {
    const emitter = makeEmitter();
    const received: ChildWorkflowStartedEvent[] = [];
    emitter.addEventListener(ChildWorkflowStartedEvent.type, (e) => received.push(e));

    const { agent } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'researcher',
      parentAgentName: 'orchestrator',
      parentRunId: 'run-p',
      emitter,
      durable: false,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.parentAgentName).toBe('orchestrator');
    expect(received[0]?.parentRunId).toBe('run-p');
    expect(received[0]?.childAgentName).toBe('researcher');
    expect(received[0]?.childRunId).toBe(handle.childRunId);
  });

  it('emits ChildWorkflowCompletedEvent on a clean stop', async () => {
    const emitter = makeEmitter();
    const received: ChildWorkflowCompletedEvent[] = [];
    emitter.addEventListener(ChildWorkflowCompletedEvent.type, (e) => received.push(e));

    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      emitter,
    });

    settle(makeResult({ finishReason: 'stop-condition' }));
    await handle.result();

    expect(received).toHaveLength(1);
    expect(received[0]?.childRunId).toBe(handle.childRunId);
    expect(received[0]?.parentRunId).toBe('p');
  });

  it('emits ChildWorkflowFailedEvent with the finishReason on a non-abort failure', async () => {
    const emitter = makeEmitter();
    const received: ChildWorkflowFailedEvent[] = [];
    emitter.addEventListener(ChildWorkflowFailedEvent.type, (e) => received.push(e));

    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      emitter,
    });

    settle(makeResult({ finishReason: 'tripwire' }));
    await handle.result();

    expect(received).toHaveLength(1);
    expect(received[0]?.reason).toBe('tripwire');
    expect(received[0]?.childRunId).toBe(handle.childRunId);
  });

  it('emits ChildWorkflowAbortedEvent when the child settles as aborted', async () => {
    const emitter = makeEmitter();
    const received: ChildWorkflowAbortedEvent[] = [];
    emitter.addEventListener(ChildWorkflowAbortedEvent.type, (e) => received.push(e));

    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      emitter,
    });

    handle.abort('no longer needed');
    settle(makeResult({ finishReason: 'aborted' }));
    await handle.result();

    expect(received).toHaveLength(1);
    expect(received[0]?.childRunId).toBe(handle.childRunId);
  });

  it('emits ChildWorkflowAbortedEvent (not Completed/Failed) when a REAL createAgent child is stopped by an aborting parent signal', async () => {
    // The scripted `makeControllableAgent` tests above prove
    // `dispatchChildRun` classifies a scripted `finishReason: 'aborted'`
    // correctly, but that only proves the classification logic — not that a
    // real agent loop actually produces `finishReason: 'aborted'` when its
    // signal fires. This drives a real `createAgent` child through a real
    // abort to close that gap.
    const emitter = makeEmitter();
    const aborted: ChildWorkflowAbortedEvent[] = [];
    const completed: ChildWorkflowCompletedEvent[] = [];
    const failed: ChildWorkflowFailedEvent[] = [];
    emitter.addEventListener(ChildWorkflowAbortedEvent.type, (e) => aborted.push(e));
    emitter.addEventListener(ChildWorkflowCompletedEvent.type, (e) => completed.push(e));
    emitter.addEventListener(ChildWorkflowFailedEvent.type, (e) => failed.push(e));

    let resolveStarted: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const child = createAgent({
      generate: (context) => {
        resolveStarted();
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    });

    const parentController = new AbortController();
    const handle = dispatchChildRun(child, 'go', {
      agentName: 'real-child',
      parentRunId: 'p',
      signal: parentController.signal,
      emitter,
    });

    await started;
    parentController.abort('parent cancelled');
    await handle.result();

    expect(aborted).toHaveLength(1);
    expect(completed).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });

  it('emits ChildWorkflowFailedEvent and settles the registry entry when the underlying result() rejects', async () => {
    const emitter = makeEmitter();
    const received: ChildWorkflowFailedEvent[] = [];
    emitter.addEventListener(ChildWorkflowFailedEvent.type, (e) => received.push(e));
    const registry = createChildRunRegistry();

    const agent = makeRejectingAgent(new Error('boom'));
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      emitter,
      registry,
    });

    let caughtError: unknown;
    try {
      await handle.result();
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe('boom');

    expect(received).toHaveLength(1);
    expect(received[0]?.reason).toBe('boom');
    expect(received[0]?.childRunId).toBe(handle.childRunId);
    expect(registry.children()[0]?.status).toBe('failed');
  });

  it('settles the registry and emits ChildWorkflowFailedEvent when result() itself THROWS synchronously, not only when its promise rejects', async () => {
    // Regression: a misbehaving or third-party AgentRun's `result()` can
    // throw before ever returning a promise, rather than returning a
    // promise that rejects. Before this was fixed, `agentRun.result()` was
    // called directly as the receiver of `.then()` — a synchronous throw
    // there escaped before `.then()` was ever reached, leaving the
    // registry entry stuck at 'running' forever with no failed event, and
    // propagating out of `dispatchChildRun` itself instead of surfacing
    // through the handle's own `result()`.
    const emitter = makeEmitter();
    const received: ChildWorkflowFailedEvent[] = [];
    emitter.addEventListener(ChildWorkflowFailedEvent.type, (e) => received.push(e));
    const registry = createChildRunRegistry();

    const agent: RunnableAgent = {
      name: 'throws-from-result',
      hasOutput: false,
      run: () =>
        ({
          result: () => {
            throw new Error('sync boom');
          },
          unwrap: () => Promise.reject(new Error('sync boom')),
          abort: () => {},
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: () => (async function* () {})(),
        }) as unknown as ReturnType<RunnableAgent['run']>,
    };

    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      emitter,
      registry,
    });

    let caughtError: unknown;
    try {
      await handle.result();
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe('sync boom');

    expect(received).toHaveLength(1);
    expect(received[0]?.reason).toBe('sync boom');
    expect(received[0]?.childRunId).toBe(handle.childRunId);
    expect(registry.children()[0]?.status).toBe('failed');
    expect(registry.children()[0]?.result).toBeUndefined();
  });

  it('emits no events when no emitter is supplied', async () => {
    // No emitter passed at all — dispatchChildRun must not throw trying to
    // dispatch onto something that doesn't exist.
    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p' });
    settle(makeResult());
    const result = await handle.result();
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Abort semantics: parent propagation, child-targeted, sibling isolation
// ---------------------------------------------------------------------------

describe('dispatchChildRun — abort semantics', () => {
  it('stops the child when the composed parent signal aborts', () => {
    const parentController = new AbortController();
    const { agent, calls } = makeControllableAgent();
    dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      signal: parentController.signal,
    });

    expect(calls[0]?.context?.signal?.aborted).toBe(false);
    parentController.abort('parent cancelled');
    expect(calls[0]?.context?.signal?.aborted).toBe(true);
  });

  it('stops the child when the handles own abort() is called, independent of any parent signal', () => {
    const parentController = new AbortController();
    const { agent, calls } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      signal: parentController.signal,
    });

    handle.abort('child-targeted');

    expect(calls[0]?.context?.signal?.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(false);
  });

  it('a child-targeted abort on one child never reaches a sibling dispatched from the same parent', () => {
    const parentController = new AbortController();
    const first = makeControllableAgent();
    const second = makeControllableAgent();

    const handleA = dispatchChildRun(first.agent, 'a', {
      agentName: 'a',
      parentRunId: 'p',
      signal: parentController.signal,
    });
    dispatchChildRun(second.agent, 'b', {
      agentName: 'b',
      parentRunId: 'p',
      signal: parentController.signal,
    });

    handleA.abort('stop a only');

    expect(first.calls[0]?.context?.signal?.aborted).toBe(true);
    expect(second.calls[0]?.context?.signal?.aborted).toBe(false);
  });

  it('forwards to the live agentRun.abort() too — not only the private controller — so an agent that cancels solely through its own abort() still stops', () => {
    // A `RunnableAgent` is free to ignore the (optional) `AgentRunContext.signal`
    // entirely and cancel only through its returned `AgentRun.abort()`.
    // Before this was fixed, `dispatchChildRun`'s `abort()` touched only its
    // own private `AbortController`, which such an agent never observes —
    // the child would keep running and `result()` would never settle.
    const agentRunAbortCalls: (string | undefined)[] = [];
    let resolveResult: (() => void) | undefined;
    const resultPromise = new Promise<void>((resolve) => {
      resolveResult = resolve;
    });
    const agent: RunnableAgent = {
      name: 'ignores-signal',
      hasOutput: false,
      run: () =>
        ({
          // Deliberately never reads `context.signal` — cancellation is
          // observable ONLY through this `abort()` being called.
          result: () => resultPromise.then(() => makeResult({ finishReason: 'aborted' })),
          unwrap: () => resultPromise.then(() => 'unused'),
          abort: (reason?: string) => {
            agentRunAbortCalls.push(reason);
            resolveResult?.();
          },
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: () => (async function* () {})(),
        }) as unknown as ReturnType<RunnableAgent['run']>,
    };

    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p' });
    handle.abort('please stop');

    expect(agentRunAbortCalls).toEqual(['please stop']);
  });

  it("reports the PARENT signal's reason on ChildWorkflowAbortedEvent when a parent-propagated abort (not a child-targeted one) settles the child", async () => {
    // Regression: the reason was previously read off the private
    // `childController.signal` — which a parent-propagated abort never
    // touches — so a parent abort with a string reason surfaced as
    // `reason: undefined` on the event instead of the actual reason.
    const emitter = makeEmitter();
    const received: ChildWorkflowAbortedEvent[] = [];
    emitter.addEventListener(ChildWorkflowAbortedEvent.type, (e) => received.push(e));

    const parentController = new AbortController();
    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      signal: parentController.signal,
      emitter,
    });

    parentController.abort('parent said stop');
    settle(makeResult({ finishReason: 'aborted' }));
    await handle.result();

    expect(received).toHaveLength(1);
    expect(received[0]?.reason).toBe('parent said stop');
  });
});

// ---------------------------------------------------------------------------
// Two concurrent child handles are distinguishable
// ---------------------------------------------------------------------------

describe('dispatchChildRun — concurrent children', () => {
  it('a parent can retain two concurrent child handles and distinguish their events and results', async () => {
    const emitter = makeEmitter();
    const startedEvents: ChildWorkflowStartedEvent[] = [];
    emitter.addEventListener(ChildWorkflowStartedEvent.type, (e) => startedEvents.push(e));

    const alpha = makeControllableAgent();
    const beta = makeControllableAgent();

    const handleAlpha = dispatchChildRun(alpha.agent, 'alpha task', {
      agentName: 'alpha',
      parentRunId: 'run-p',
      emitter,
    });
    const handleBeta = dispatchChildRun(beta.agent, 'beta task', {
      agentName: 'beta',
      parentRunId: 'run-p',
      emitter,
    });

    expect(handleAlpha.childRunId).not.toBe(handleBeta.childRunId);
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents.map((e) => e.childAgentName).sort()).toEqual(['alpha', 'beta']);

    alpha.settle(makeResult({ content: 'alpha done' }));
    beta.settle(makeResult({ content: 'beta done' }));

    const [resultAlpha, resultBeta] = await Promise.all([
      handleAlpha.result(),
      handleBeta.result(),
    ]);
    expect(resultAlpha.content).toBe('alpha done');
    expect(resultBeta.content).toBe('beta done');
  });
});

// ---------------------------------------------------------------------------
// createChildRunRegistry — discovery and scoped cancellation
// ---------------------------------------------------------------------------

describe('createChildRunRegistry', () => {
  it('starts empty', () => {
    const registry = createChildRunRegistry();
    expect(registry.children()).toEqual([]);
  });

  it("returns frozen descriptor snapshots — mutating one never corrupts the registry's own control state", () => {
    // Regression: `children()` previously returned the registry's actual
    // stored descriptor objects. A caller (JavaScript, or TypeScript code
    // crossing the `readonly` boundary with a cast) mutating a returned
    // descriptor's `status` to `'completed'` would make a subsequent
    // `abortChild(id)` see the fake terminal status and silently no-op
    // instead of aborting the still-running child.
    const registry = createChildRunRegistry();
    const { agent, calls } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'a',
      parentRunId: 'p',
      registry,
    });

    const [descriptor] = registry.children();
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(() => {
      // @ts-expect-error — deliberately violating `readonly` to prove the
      // registry's OWN state is unaffected even if a caller does this.
      descriptor.status = 'completed';
    }).toThrow();

    registry.abortChild(handle.childRunId, 'still works');
    expect(calls[0]?.context?.signal?.aborted).toBe(true);
  });

  it('registers a child as "running" and transitions it to "completed" on settle', async () => {
    const registry = createChildRunRegistry();
    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'researcher',
      parentRunId: 'p',
      registry,
    });

    expect(registry.children()).toEqual([
      {
        id: handle.childRunId,
        parentId: 'p',
        agentName: 'researcher',
        durable: false,
        status: 'running',
      },
    ]);

    settle(makeResult({ finishReason: 'stop-condition' }));
    await handle.result();

    const [descriptor] = registry.children();
    expect(descriptor?.status).toBe('completed');
    expect(descriptor?.result?.finishReason).toBe('stop-condition');
  });

  it('settles the registry entry as "failed" and emits ChildWorkflowFailedEvent (not stuck at "running") when agent.run() throws synchronously', () => {
    const registry = createChildRunRegistry();
    const emitter = makeEmitter();
    const received: ChildWorkflowFailedEvent[] = [];
    emitter.addEventListener(ChildWorkflowFailedEvent.type, (e) => received.push(e));
    const throwingAgent: RunnableAgent = {
      name: 'throws-synchronously',
      hasOutput: false,
      run: () => {
        throw new Error('run() itself threw');
      },
    };

    expect(() =>
      dispatchChildRun(throwingAgent, 'go', {
        agentName: 'a',
        parentRunId: 'p',
        registry,
        emitter,
      }),
    ).toThrow('run() itself threw');

    expect(registry.children()[0]?.status).toBe('failed');
    expect(received).toHaveLength(1);
    expect(received[0]?.reason).toBe('run() itself threw');
  });

  it('abortChild aborts only the named child, leaving a sibling unaffected', () => {
    const registry = createChildRunRegistry();
    const alpha = makeControllableAgent();
    const beta = makeControllableAgent();
    const handleAlpha = dispatchChildRun(alpha.agent, 'a', {
      agentName: 'alpha',
      parentRunId: 'p',
      registry,
    });
    dispatchChildRun(beta.agent, 'b', { agentName: 'beta', parentRunId: 'p', registry });

    registry.abortChild(handleAlpha.childRunId, 'scoped');

    expect(alpha.calls[0]?.context?.signal?.aborted).toBe(true);
    expect(beta.calls[0]?.context?.signal?.aborted).toBe(false);
  });

  it('abortChild on an unknown id is a no-op, never throws', () => {
    const registry = createChildRunRegistry();
    expect(() => registry.abortChild('does-not-exist')).not.toThrow();
  });

  it('abortChild on an already-terminal child is idempotent and does not throw', async () => {
    const registry = createChildRunRegistry();
    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry });

    settle(makeResult({ finishReason: 'stop-condition' }));
    await handle.result();

    expect(() => registry.abortChild(handle.childRunId)).not.toThrow();
    expect(() => registry.abortChild(handle.childRunId)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AgentRun.children() / .abortChild() — the opt-in registry wiring
// ---------------------------------------------------------------------------

describe('AgentRun.children() / .abortChild()', () => {
  function makeRun(childRegistry?: ReturnType<typeof createChildRunRegistry>) {
    const generate = createMockGenerate([textResponse('hello')]);
    const toolbox = createTestToolbox([]);
    const conversation = new Conversation();
    const activeRun = createRun({ generate, toolbox, conversation, stopWhen: noToolCalls() });
    return createAgentRun(activeRun, { childRegistry });
  }

  it('returns an empty array and is a no-op abortChild when no registry was supplied', async () => {
    const run = makeRun();
    expect(run.children()).toEqual([]);
    expect(() => run.abortChild('anything')).not.toThrow();
    await run.result();
  });

  it('reflects children registered into the supplied registry', async () => {
    const registry = createChildRunRegistry();
    const run = makeRun(registry);
    const { agent } = makeControllableAgent();
    dispatchChildRun(agent, 'go', { agentName: 'researcher', parentRunId: 'p', registry });

    expect(run.children()).toHaveLength(1);
    expect(run.children()[0]?.agentName).toBe('researcher');

    await run.result();
  });

  it('abortChild delegates to the supplied registry, scoped to the named child', async () => {
    const registry = createChildRunRegistry();
    const run = makeRun(registry);
    const alpha = makeControllableAgent();
    const beta = makeControllableAgent();
    const handleAlpha = dispatchChildRun(alpha.agent, 'a', {
      agentName: 'alpha',
      parentRunId: 'p',
      registry,
    });
    dispatchChildRun(beta.agent, 'b', { agentName: 'beta', parentRunId: 'p', registry });

    run.abortChild(handleAlpha.childRunId, 'scoped via AgentRun');

    expect(alpha.calls[0]?.context?.signal?.aborted).toBe(true);
    expect(beta.calls[0]?.context?.signal?.aborted).toBe(false);

    await run.result();
  });
});

// ---------------------------------------------------------------------------
// AB-64/AB-250 — DelegatedAuthority threaded through the child-dispatch path
// ---------------------------------------------------------------------------

describe('DelegatedAuthority threading (AB-250)', () => {
  it('forwards options.delegatedAuthority to agent.run() as AgentRunContext.delegatedAuthority', () => {
    const { agent, calls } = makeControllableAgent();
    const grant: DelegatedAuthority = {
      grantedProviders: ['anthropic'],
      policyVersion: 'v1',
    };

    dispatchChildRun(agent, 'go', {
      agentName: 'researcher',
      parentRunId: 'p',
      delegatedAuthority: grant,
    });

    expect(calls[0]?.context?.delegatedAuthority).toEqual(grant);
  });

  it('omits delegatedAuthority from AgentRunContext when the dispatch options carry none', () => {
    const { agent, calls } = makeControllableAgent();

    dispatchChildRun(agent, 'go', { agentName: 'researcher', parentRunId: 'p' });

    expect(calls[0]?.context?.delegatedAuthority).toBeUndefined();
  });

  it('accepts delegatedAuthority as an optional DispatchChildRunOptions field at the type level', () => {
    const options: DispatchChildRunOptions = {
      agentName: 'researcher',
      parentRunId: 'p',
      delegatedAuthority: { policyVersion: 'v1' },
    };
    expect(options.delegatedAuthority?.policyVersion).toBe('v1');
  });
});

describe('attenuateDelegatedAuthority (AB-250)', () => {
  it('returns the child grant unchanged when the parent carries no delegated authority', () => {
    const child: DelegatedAuthority = {
      grantedProviders: ['anthropic'],
      policyVersion: 'child-v1',
    };
    expect(attenuateDelegatedAuthority(undefined, child)).toEqual(child);
  });

  it('intersects grantedProviders/grantedModels, never widening either side', () => {
    const parent: DelegatedAuthority = {
      grantedProviders: ['anthropic', 'openai'],
      grantedModels: ['claude-fable-5', 'gpt-4o'],
      policyVersion: 'parent-v1',
    };
    const child: DelegatedAuthority = {
      grantedProviders: ['anthropic', 'gemini'],
      grantedModels: ['claude-fable-5'],
      policyVersion: 'child-v1',
    };

    const attenuated = attenuateDelegatedAuthority(parent, child);

    expect(attenuated.grantedProviders).toEqual(['anthropic']);
    expect(attenuated.grantedModels).toEqual(['claude-fable-5']);
    expect(attenuated.policyVersion).toBe('child-v1');
  });

  it('narrows nothing on an absent side of either grant list', () => {
    const parent: DelegatedAuthority = { grantedProviders: ['anthropic'], policyVersion: 'p' };
    const child: DelegatedAuthority = { policyVersion: 'c' };
    expect(attenuateDelegatedAuthority(parent, child).grantedProviders).toEqual(['anthropic']);

    const parent2: DelegatedAuthority = { policyVersion: 'p' };
    const child2: DelegatedAuthority = { grantedProviders: ['openai'], policyVersion: 'c' };
    expect(attenuateDelegatedAuthority(parent2, child2).grantedProviders).toEqual(['openai']);
  });

  it('takes the lower of two maximumEffort tiers', () => {
    const parent: DelegatedAuthority = { maximumEffort: 'high', policyVersion: 'p' };
    const child: DelegatedAuthority = { maximumEffort: 'max', policyVersion: 'c' };
    expect(attenuateDelegatedAuthority(parent, child).maximumEffort).toBe('high');

    const parent2: DelegatedAuthority = { maximumEffort: 'low', policyVersion: 'p' };
    const child2: DelegatedAuthority = { maximumEffort: 'xhigh', policyVersion: 'c' };
    expect(attenuateDelegatedAuthority(parent2, child2).maximumEffort).toBe('low');
  });

  it('carries an absent maximumEffort through unchanged on either side', () => {
    const parent: DelegatedAuthority = { policyVersion: 'p' };
    const child: DelegatedAuthority = { maximumEffort: 'medium', policyVersion: 'c' };
    expect(attenuateDelegatedAuthority(parent, child).maximumEffort).toBe('medium');
    expect(attenuateDelegatedAuthority(child, parent).maximumEffort).toBe('medium');
  });

  it('excludes a parent-permitted-but-child-forbidden candidate from the child plan, with exceeds-delegated-authority and the attenuating grant’s policyVersion', () => {
    const FIXED_NOW = '2026-09-02T12:00:00.000Z';
    const catalog = createModelCatalog({ now: () => FIXED_NOW });
    const anthropicDescriptor = catalog.descriptors.find(
      (row) => row.provider === 'anthropic' && row.model === 'claude-fable-5',
    );
    const openaiDescriptor = catalog.descriptors.find(
      (row) => row.provider === 'openai' && row.model === 'gpt-4o',
    );
    if (!anthropicDescriptor || !openaiDescriptor) {
      throw new Error('fixture descriptor not found');
    }
    const twoCandidateCatalog = {
      ...catalog,
      descriptors: [anthropicDescriptor, openaiDescriptor],
    };

    // Two-level chain: a grandparent's grant permits both anthropic and
    // openai; the parent, dispatching THIS child, narrows to anthropic
    // only. `attenuateDelegatedAuthority` composes the two before the
    // child ever sees a grant — the child's plan must reflect ONLY the
    // narrower, attenuated authority.
    const grandparentGrant: DelegatedAuthority = {
      grantedProviders: ['anthropic', 'openai'],
      policyVersion: 'grandparent-v1',
    };
    const parentToChildGrant: DelegatedAuthority = {
      grantedProviders: ['anthropic'],
      policyVersion: 'parent-v2',
    };
    const childGrant = attenuateDelegatedAuthority(grandparentGrant, parentToChildGrant);

    const plan = select(
      {
        agentName: 'child-agent',
        catalogRevision: twoCandidateCatalog.revision,
        policyRevision: 1,
        availabilitySnapshotRevision: twoCandidateCatalog.revision,
      },
      {
        catalog: twoCandidateCatalog,
        delegated: childGrant,
        now: () => FIXED_NOW,
        newPlanId: () => 'plan-attenuation-0001',
      },
    );

    const openaiCandidate = plan.candidates.find((candidate) => candidate.provider === 'openai');
    const anthropicCandidate = plan.candidates.find(
      (candidate) => candidate.provider === 'anthropic',
    );

    expect(openaiCandidate?.eligible).toBe(false);
    expect(openaiCandidate?.exclusionCode).toBe('exceeds-delegated-authority');
    expect(anthropicCandidate?.eligible).toBe(true);
    expect(plan.outcome).toBe('selected');
    expect(plan.selected?.provider).toBe('anthropic');

    // Same composition, checked directly at the policy layer, confirms the
    // attenuated grant's own `policyVersion` is what's carried onto the
    // exclusion this layer produced.
    const policyCandidates = composePolicy({
      descriptors: twoCandidateCatalog.descriptors,
      delegated: childGrant,
    });
    const deniedOpenai = policyCandidates.find((candidate) => candidate.provider === 'openai');
    expect(deniedOpenai?.exclusionCode).toBe('exceeds-delegated-authority');
    // `policyVersion` is carried in the exclusion reason text (`policy.ts`'s
    // `evaluateDelegated`) — the attenuated grant's OWN version, `parent-v2`
    // (the narrowing grant, per `attenuateDelegatedAuthority`'s rule), not
    // the grandparent's `grandparent-v1`.
    expect(deniedOpenai?.exclusionReason).toContain(`policyVersion=${childGrant.policyVersion}`);
    expect(childGrant.policyVersion).toBe('parent-v2');
  });
});

// ---------------------------------------------------------------------------
// AB-216 — ChildRunRegistry.attachLiveness()/subscribeLiveness()
// ---------------------------------------------------------------------------

describe('ChildRunRegistry.attachLiveness()/subscribeLiveness() (AB-216)', () => {
  it('never calls subscribeSnapshot against a RunnableAgent whose run() lacks it (hasLivenessObservable guard)', async () => {
    // makeControllableAgent()'s handle is exactly this shape — used
    // throughout this file — so this test documents, rather than merely
    // relying on, why none of those other tests throw.
    const registry = createChildRunRegistry();
    const { agent, settle } = makeControllableAgent();

    expect(() =>
      dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry }),
    ).not.toThrow();
    settle(makeResult());

    expect(registry.children()[0]?.assessment).toBeUndefined();
  });

  it('populates ChildRunDescriptor.assessment from a real child AgentRun, synchronously at dispatch', () => {
    const registry = createChildRunRegistry();
    const agent = makeRealAgent();

    dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry });

    // `subscribeSnapshot` delivers the current snapshot synchronously
    // (AB-88's AC10) — the assessment is already set before this line, no
    // await needed.
    expect(registry.children()[0]?.assessment).toBe('healthy');
  });

  it("moves the descriptor's assessment to 'terminal' once the child settles", async () => {
    const registry = createChildRunRegistry();
    const agent = makeRealAgent();

    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry });
    await handle.result();

    expect(registry.children()[0]?.assessment).toBe('terminal');
  });

  it('notifies subscribeLiveness observers when a child assessment changes', () => {
    const registry = createChildRunRegistry();
    const agent = makeRealAgent();
    let notifications = 0;
    const subscription = registry.subscribeLiveness(() => {
      notifications += 1;
    });

    dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry });

    // The initial synchronous `subscribeSnapshot` delivery at attach time
    // counts as one liveness change.
    expect(notifications).toBeGreaterThan(0);

    subscription.unsubscribe();
  });

  it('subscribeLiveness().unsubscribe() stops further notifications', async () => {
    const registry = createChildRunRegistry();
    const agent = makeRealAgent();
    let notifications = 0;
    const subscription = registry.subscribeLiveness(() => {
      notifications += 1;
    });
    subscription.unsubscribe();

    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry });
    await handle.result();

    expect(notifications).toBe(0);
  });

  it('subscribeLiveness().unsubscribe() is idempotent and reflects .closed', () => {
    const registry = createChildRunRegistry();
    const subscription = registry.subscribeLiveness(() => undefined);

    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);
    expect(() => subscription.unsubscribe()).not.toThrow();
    expect(subscription.closed).toBe(true);
  });

  it('isolates a throwing subscribeLiveness listener — a later listener still gets notified', () => {
    const registry = createChildRunRegistry();
    const agent = makeRealAgent();
    const calls: string[] = [];
    registry.subscribeLiveness(() => {
      calls.push('first');
      throw new Error('a listener bug, not this registry’s or the child’s');
    });
    registry.subscribeLiveness(() => calls.push('second'));

    expect(() =>
      dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry }),
    ).not.toThrow();

    expect(calls).toEqual(['first', 'second']);
  });

  it('attachLiveness on an unknown id is a no-op, never throws, never subscribes', () => {
    const registry = createChildRunRegistry();
    let subscribeCalls = 0;
    const observable = {
      snapshot: () => ({}) as never,
      subscribeSnapshot: () => {
        subscribeCalls += 1;
        return { unsubscribe: () => undefined, closed: false };
      },
    };

    expect(() => registry.attachLiveness('never-registered', observable)).not.toThrow();
    expect(subscribeCalls).toBe(0);
    expect(registry.children()).toEqual([]);
  });

  it('a synchronous agent.run() throw settles the child with no assessment ever attached', () => {
    const registry = createChildRunRegistry();
    const throwingAgent: RunnableAgent = {
      name: 'throws',
      hasOutput: false,
      run: () => {
        throw new Error('boom');
      },
    };

    expect(() =>
      dispatchChildRun(throwingAgent, 'go', { agentName: 'a', parentRunId: 'p', registry }),
    ).toThrow('boom');

    expect(registry.children()[0]?.status).toBe('failed');
    expect(registry.children()[0]?.assessment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ChildRunRegistry.attachClosed()/awaitChildrenClosed() (AB-211)
// ---------------------------------------------------------------------------

describe('ChildRunRegistry.attachClosed()/awaitChildrenClosed() (AB-211)', () => {
  it('never calls closed() against a RunnableAgent whose run() lacks it (hasClosedAcknowledgement guard)', async () => {
    // makeControllableAgent()'s handle has no `closed()` — mirrors the
    // `hasLivenessObservable` guard's own coverage above.
    const registry = createChildRunRegistry();
    const { agent, settle } = makeControllableAgent();

    expect(() =>
      dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry }),
    ).not.toThrow();
    settle(makeResult());

    expect(await registry.awaitChildrenClosed()).toBeUndefined();
  });

  it("wires a real child AgentRun's closed() so awaitChildrenClosed genuinely awaits it", async () => {
    const registry = createChildRunRegistry();
    const agent = makeRealAgent();

    const handle = dispatchChildRun(agent, 'go', { agentName: 'a', parentRunId: 'p', registry });
    await handle.result();

    // The child's own `closed()` never rejects and settles once its result
    // has (AB-204) — `awaitChildrenClosed` genuinely calls it, not merely
    // reading `ChildRunDescriptor.status`.
    expect(await registry.awaitChildrenClosed()).toBeUndefined();
  });

  it('awaits every registered child, folding in one dispatched after the call started', async () => {
    const registry = createChildRunRegistry();
    const first = makeRealAgent();
    dispatchChildRun(first, 'go', { agentName: 'a', parentRunId: 'p', registry });

    const awaitAll = registry.awaitChildrenClosed();

    // Register a second child from inside the same tick the first
    // `awaitChildrenClosed()` call is already pending.
    const second = makeRealAgent();
    dispatchChildRun(second, 'go', { agentName: 'a', parentRunId: 'p', registry });

    expect(await awaitAll).toBeUndefined();
    expect(registry.children()).toHaveLength(2);
  });

  it('attachClosed on an unknown id is a no-op and never throws', () => {
    const registry = createChildRunRegistry();
    expect(() =>
      registry.attachClosed('never-registered', () => Promise.resolve({ status: 'completed' })),
    ).not.toThrow();
  });

  it('resolves immediately for a registry with zero children', async () => {
    const registry = createChildRunRegistry();
    expect(await registry.awaitChildrenClosed()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listChildRuns — relationship-query function (AB-90 child ab90-02, AB-222)
// ---------------------------------------------------------------------------

describe('listChildRuns', () => {
  it('returns an empty array for a parent with zero registered children, without throwing', () => {
    const registry = createChildRunRegistry();
    expect(() => listChildRuns(registry, 'no-such-parent')).not.toThrow();
    expect(listChildRuns(registry, 'no-such-parent')).toEqual([]);
  });

  it("returns a still-running child's status as undefined, not the internal 'running' string", () => {
    const registry = createChildRunRegistry();
    const { agent } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'researcher',
      parentRunId: 'parent-1',
      registry,
    });

    expect(listChildRuns(registry, 'parent-1')).toEqual([
      {
        id: handle.childRunId,
        parentId: 'parent-1',
        agentName: 'researcher',
        durable: false,
        status: undefined,
      },
    ]);
  });

  it("reports 'completed'/'failed'/'aborted' terminal statuses once each child settles", async () => {
    const registry = createChildRunRegistry();
    const completedChild = makeControllableAgent();
    const failedChild = makeControllableAgent();
    const abortedChild = makeControllableAgent();

    const completedHandle = dispatchChildRun(completedChild.agent, 'a', {
      agentName: 'completed-agent',
      parentRunId: 'parent-1',
      registry,
      childRunId: 'child-completed',
    });
    const failedHandle = dispatchChildRun(failedChild.agent, 'b', {
      agentName: 'failed-agent',
      parentRunId: 'parent-1',
      registry,
      childRunId: 'child-failed',
    });
    const abortedHandle = dispatchChildRun(abortedChild.agent, 'c', {
      agentName: 'aborted-agent',
      parentRunId: 'parent-1',
      registry,
      childRunId: 'child-aborted',
    });

    completedChild.settle(makeResult({ finishReason: 'stop-condition' }));
    failedChild.settle(makeResult({ finishReason: 'error' }));
    abortedChild.settle(makeResult({ finishReason: 'aborted' }));
    await Promise.all([completedHandle.result(), failedHandle.result(), abortedHandle.result()]);

    const summaries = listChildRuns(registry, 'parent-1');
    expect(summaries).toHaveLength(3);
    expect(summaries.find((c) => c.id === 'child-completed')?.status).toBe('completed');
    expect(summaries.find((c) => c.id === 'child-failed')?.status).toBe('failed');
    expect(summaries.find((c) => c.id === 'child-aborted')?.status).toBe('aborted');
  });

  it('filters to only the requested parentRunId when the registry tracks children from more than one parent', () => {
    const registry = createChildRunRegistry();
    const forParentOne = makeControllableAgent();
    const forParentTwo = makeControllableAgent();
    dispatchChildRun(forParentOne.agent, 'a', {
      agentName: 'child-of-one',
      parentRunId: 'parent-1',
      registry,
    });
    dispatchChildRun(forParentTwo.agent, 'b', {
      agentName: 'child-of-two',
      parentRunId: 'parent-2',
      registry,
    });

    const forOne = listChildRuns(registry, 'parent-1');
    const forTwo = listChildRuns(registry, 'parent-2');

    expect(forOne).toHaveLength(1);
    expect(forOne[0]?.agentName).toBe('child-of-one');
    expect(forTwo).toHaveLength(1);
    expect(forTwo[0]?.agentName).toBe('child-of-two');
  });
});

// ---------------------------------------------------------------------------
// ChildWorkflowReattachedEvent / ChildWorkflowProgressEvent (AB-90 child
// ab90-02, AB-222) — typed events this module defines; construction and
// payload shape only, since neither is dispatched by this package today
// (reattached awaits AB-53's recovery hook; see the class docstrings).
// ---------------------------------------------------------------------------

describe('ChildWorkflowReattachedEvent / ChildWorkflowProgressEvent (AB-222)', () => {
  it('constructs ChildWorkflowReattachedEvent with exactly childRunId and parentRunId', () => {
    const event = new ChildWorkflowReattachedEvent({
      childRunId: 'child-1',
      parentRunId: 'parent-1',
    });

    expect(event.type).toBe('multiagent.child-workflow.reattached');
    expect(event.childRunId).toBe('child-1');
    expect(event.parentRunId).toBe('parent-1');
  });

  it('constructs ChildWorkflowProgressEvent carrying childRunId, parentRunId, and a SemanticProgress payload', () => {
    const event = new ChildWorkflowProgressEvent({
      childRunId: 'child-1',
      parentRunId: 'parent-1',
      progress: { phase: 'researching', current: 2, total: 5, message: 'reading docs' },
    });

    expect(event.type).toBe('multiagent.child-workflow.progress');
    expect(event.childRunId).toBe('child-1');
    expect(event.parentRunId).toBe('parent-1');
    expect(event.progress).toEqual({
      phase: 'researching',
      current: 2,
      total: 5,
      message: 'reading docs',
    });
  });

  it('is registered in OperativeEventMap under its literal type string', () => {
    const emitter = makeEmitter();
    const received: Array<ChildWorkflowReattachedEvent | ChildWorkflowProgressEvent> = [];
    emitter.addEventListener(ChildWorkflowReattachedEvent.type, (e) => received.push(e));
    emitter.addEventListener(ChildWorkflowProgressEvent.type, (e) => received.push(e));

    emitter.dispatchEvent(
      new ChildWorkflowReattachedEvent({ childRunId: 'child-1', parentRunId: 'parent-1' }),
    );
    emitter.dispatchEvent(
      new ChildWorkflowProgressEvent({
        childRunId: 'child-1',
        parentRunId: 'parent-1',
        progress: {},
      }),
    );

    expect(received).toHaveLength(2);
  });
});
