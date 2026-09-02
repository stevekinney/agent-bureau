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
import { createChildRunRegistry, dispatchChildRun } from './child-run';
import { noToolCalls } from './conditions/predicates';
import { createAgent } from './create-agent';
import { createActiveRun as createRun } from './create-run';
import type { CombinedOperativeEventMap } from './events';
import {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
  ChildWorkflowStartedEvent,
} from './events';
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
