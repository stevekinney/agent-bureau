/**
 * Behavioral tests for typed in-memory parent-child signals (COR-814).
 *
 * Acceptance criteria covered here:
 *   - the child dispatch contract accepts a typed signal map
 *     (`defineChildSignals`, `DispatchChildRunOptions.signals`)
 *   - the parent handle sends a signal and receives an explicit
 *     acknowledgement or a typed rejection
 *   - the child emits a typed event the parent observes before completion
 *   - delivery is correlated to one parent-child pair and cannot reach an
 *     unrelated run
 *   - abort, completion, and disposal close the channel deterministically
 *     and reject later sends
 *   - concurrent children, signal-before-listener, cancellation races, and
 *     terminal cleanup
 */
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { getEventListeners } from 'node:events';
import { z } from 'zod';

import { dispatchChildRun } from './child-run';
import {
  type ChildSignalPort,
  createChildSignalChannel,
  defineChildSignals,
  readParentSignals,
} from './child-signals';
import { noToolCalls } from './conditions/predicates';
import { createAgent } from './create-agent';
import { createSubagentTool } from './create-subagent-tool';
import type { AgentRunContext, RunnableAgent } from './runnable-agent';
import { createMockGenerate } from './test/index';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';
import type { GenerateResponse, RunResult } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const contract = defineChildSignals({
  signals: {
    focus: z.object({ topic: z.string() }),
    pause: z.object({ reason: z.string().optional() }),
    anything: z.any(),
  },
  events: {
    progress: z.object({ percent: z.number().min(0).max(100) }),
    request: z.object({ question: z.string() }),
    anything: z.any(),
  },
});

type TestContract = typeof contract;

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

/**
 * A `RunnableAgent` test double that records the `AgentRunContext` it was
 * started with (so a test can reach the child-side signal port) and whose
 * terminal result is caller-controlled.
 */
function makeControllableAgent(): {
  agent: RunnableAgent;
  contexts: (AgentRunContext | undefined)[];
  settle: (result: RunResult) => void;
  fail: (error: Error) => void;
} {
  const contexts: (AgentRunContext | undefined)[] = [];
  let resolveResult: ((result: RunResult) => void) | undefined;
  let rejectResult: ((error: Error) => void) | undefined;
  const resultPromise = new Promise<RunResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A rejection nobody awaits yet must not surface as unhandled.
  resultPromise.catch(() => {});

  const agent: RunnableAgent = {
    name: 'controllable',
    hasOutput: false,
    run(_input, context) {
      contexts.push(context);
      return {
        result: () => resultPromise,
        abort: () => {},
        [Symbol.dispose]: () => {},
        [Symbol.asyncIterator]: () => (async function* () {})(),
      } as unknown as ReturnType<RunnableAgent['run']>;
    },
  };

  return {
    agent,
    contexts,
    settle: (result) => resolveResult?.(result),
    fail: (error) => rejectResult?.(error),
  };
}

/** Reads the child-side port the child was started with, typed against `contract`. */
function childPortOf(contexts: (AgentRunContext | undefined)[], index = 0) {
  const port = readParentSignals(contexts[index], contract);
  if (port === undefined) throw new Error(`child ${index} received no parent signal port`);
  return port;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value) => settle?.(value) };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

// ---------------------------------------------------------------------------
// The dispatch contract
// ---------------------------------------------------------------------------

describe('child signals — dispatch contract', () => {
  it('defineChildSignals returns a frozen contract whose maps cannot be mutated', () => {
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.signals)).toBe(true);
    expect(Object.isFrozen(contract.events)).toBe(true);
  });

  it('hands the child a port correlated to the same parent-child pair as the handle', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      signals: contract,
    });

    const port = childPortOf(contexts);
    expect(handle.signals.parentRunId).toBe('parent-1');
    expect(handle.signals.childRunId).toBe('child-1');
    expect(port.parentRunId).toBe('parent-1');
    expect(port.childRunId).toBe('child-1');
    expect(port.contract).toBe(contract);
    expect(handle.signals.closeReason).toBeUndefined();
    expect(port.closeReason).toBeUndefined();
  });

  it('dispatches without a signal port or endpoint when no contract is supplied', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', { agentName: 'worker', parentRunId: 'p' });

    expect('signals' in handle).toBe(false);
    expect(contexts[0]?.parentSignals).toBeUndefined();
    expect(readParentSignals(contexts[0], contract)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Parent → child signals
// ---------------------------------------------------------------------------

describe('child signals — parent sends, child acknowledges or rejects', () => {
  it('delivers a validated, correlated signal and resolves an explicit acknowledgement', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      signals: contract,
    });
    const received: unknown[] = [];
    childPortOf(contexts).onSignal('focus', (message) => {
      received.push(message);
    });

    const outcome = await handle.signals.send('focus', { topic: 'birds' });

    expect(outcome).toEqual({
      status: 'acknowledged',
      id: 'child-1:signal:1',
      sequence: 1,
      name: 'focus',
      parentRunId: 'parent-1',
      childRunId: 'child-1',
    });
    expect(received).toEqual([
      {
        id: 'child-1:signal:1',
        sequence: 1,
        name: 'focus',
        payload: { topic: 'birds' },
        parentRunId: 'parent-1',
        childRunId: 'child-1',
      },
    ]);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it('acknowledges only once an asynchronous handler settles', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const gate = deferred();
    childPortOf(contexts).onSignal('pause', () => gate.promise);

    let settled = false;
    const pending = handle.signals.send('pause', {}).then((outcome) => {
      settled = true;
      return outcome;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    expect(await pending).toMatchObject({ status: 'acknowledged' });
  });

  it('rejects with handler-failed when the child handler throws or rejects', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      childRunId: 'c',
      signals: contract,
    });
    const port = childPortOf(contexts);
    port.onSignal('focus', () => {
      throw new Error('not now');
    });
    port.onSignal('pause', async () => {
      throw new Error('cannot pause');
    });
    port.onSignal('anything', () => {
      // Throwing a non-Error value is the handler's bug; the rejection
      // still carries a readable reason.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain string';
    });

    expect(await handle.signals.send('focus', { topic: 'x' })).toEqual({
      status: 'rejected',
      id: 'c:signal:1',
      sequence: 1,
      name: 'focus',
      parentRunId: 'p',
      childRunId: 'c',
      code: 'handler-failed',
      reason: 'not now',
      delivered: true,
    });
    const asyncRejection = await handle.signals.send('pause', {});
    expect(asyncRejection).toMatchObject({
      status: 'rejected',
      code: 'handler-failed',
      reason: 'cannot pause',
    });
    expect(await handle.signals.send('anything', 1)).toMatchObject({
      code: 'handler-failed',
      reason: 'plain string',
    });
  });

  it('rejects an invalid payload with invalid-payload without delivering it', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    let calls = 0;
    childPortOf(contexts).onSignal('focus', () => {
      calls++;
    });

    const outcome = await handle.signals.send('focus', { topic: 42 } as never);

    expect(outcome).toMatchObject({
      status: 'rejected',
      code: 'invalid-payload',
      delivered: false,
    });
    expect(outcome.status === 'rejected' && outcome.reason.length > 0).toBe(true);
    expect(calls).toBe(0);
  });

  it('rejects a payload that cannot be structurally cloned with invalid-payload', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    let calls = 0;
    childPortOf(contexts).onSignal('anything', () => {
      calls++;
    });

    const outcome = await handle.signals.send('anything', { callback: () => 'secret' });

    expect(outcome).toMatchObject({ status: 'rejected', code: 'invalid-payload' });
    expect(calls).toBe(0);
  });

  it('rejects an unknown signal name with unknown-name', async () => {
    const { agent } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });

    const outcome = await handle.signals.send('nope' as never, {} as never);

    expect(outcome).toMatchObject({
      status: 'rejected',
      name: 'nope',
      code: 'unknown-name',
      delivered: false,
    });
  });

  it('never shares a payload reference between sender and recipient', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const sent = { nested: { value: 1 } };
    let received: { nested: { value: number } } | undefined;
    childPortOf(contexts).onSignal('anything', (message) => {
      received = message.payload as typeof sent;
    });

    await handle.signals.send('anything', sent);
    sent.nested.value = 2;

    expect(received).toEqual({ nested: { value: 1 } });
    expect(received).not.toBe(sent);
  });
});

// ---------------------------------------------------------------------------
// Signal-before-listener
// ---------------------------------------------------------------------------

describe('child signals — signal before listener', () => {
  it('buffers signals sent before the child registers a handler and delivers them in order', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });

    const first = handle.signals.send('focus', { topic: 'a' });
    const second = handle.signals.send('focus', { topic: 'b' });
    const topics: string[] = [];
    childPortOf(contexts).onSignal('focus', (message) => {
      topics.push(message.payload.topic);
    });

    expect(topics).toEqual(['a', 'b']);
    expect(await first).toMatchObject({ status: 'acknowledged' });
    expect(await second).toMatchObject({ status: 'acknowledged' });
  });

  it('keeps FIFO order when a handler causes another send while the buffer is flushing', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const pending = [
      handle.signals.send('focus', { topic: 'a' }),
      handle.signals.send('focus', { topic: 'b' }),
    ];
    const topics: string[] = [];
    childPortOf(contexts).onSignal('focus', (message) => {
      topics.push(message.payload.topic);
      if (message.payload.topic === 'a') {
        pending.push(handle.signals.send('focus', { topic: 'c' }));
      }
    });

    expect(topics).toEqual(['a', 'b', 'c']);
    const outcomes = await Promise.all(pending);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'acknowledged',
      'acknowledged',
      'acknowledged',
    ]);
  });

  it('rejects with buffer-full once the pending-signal bound is reached', async () => {
    const { agent } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
      signalBufferLimit: 1,
    });

    void handle.signals.send('focus', { topic: 'a' });
    const overflow = await handle.signals.send('pause', {});

    expect(overflow).toMatchObject({ status: 'rejected', code: 'buffer-full', delivered: false });
  });

  it('rejects every signal sent before a handler exists when the bound is zero', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
      signalBufferLimit: 0,
    });

    const early = await handle.signals.send('focus', { topic: 'early' });
    childPortOf(contexts).onSignal('focus', () => {});
    const late = await handle.signals.send('focus', { topic: 'late' });

    expect(early).toMatchObject({ status: 'rejected', code: 'buffer-full' });
    expect(late).toMatchObject({ status: 'acknowledged' });
  });

  it('refuses to dispatch with a buffer bound that is not a non-negative integer', () => {
    for (const signalBufferLimit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { agent, contexts } = makeControllableAgent();
      expect(() =>
        dispatchChildRun(agent, 'go', {
          agentName: 'worker',
          parentRunId: 'p',
          signals: contract,
          signalBufferLimit,
        }),
      ).toThrow(RangeError);
      expect(contexts).toHaveLength(0);
    }
  });

  it('buffers again after the handler unsubscribes and flushes to the next handler', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const port = childPortOf(contexts);
    const firstHandler: string[] = [];
    const subscription = port.onSignal('focus', (message) => {
      firstHandler.push(message.payload.topic);
    });
    expect(subscription.closed).toBe(false);
    subscription.unsubscribe();
    subscription.unsubscribe(); // idempotent
    expect(subscription.closed).toBe(true);

    const pending = handle.signals.send('focus', { topic: 'late' });
    const secondHandler: string[] = [];
    port.onSignal('focus', (message) => {
      secondHandler.push(message.payload.topic);
    });

    expect(await pending).toMatchObject({ status: 'acknowledged' });
    expect(firstHandler).toEqual([]);
    expect(secondHandler).toEqual(['late']);
  });

  it('allows one handler per signal name and rejects registration of an unknown name', () => {
    const { agent, contexts } = makeControllableAgent();
    dispatchChildRun(agent, 'go', { agentName: 'worker', parentRunId: 'p', signals: contract });
    const port = childPortOf(contexts);
    port.onSignal('focus', () => {});

    expect(() => port.onSignal('focus', () => {})).toThrow(/already has a handler/);
    expect(() => port.onSignal('nope' as never, () => {})).toThrow(TypeError);
  });

  it('a stale subscription cannot remove a newer handler for the same name', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const port = childPortOf(contexts);
    const stale = port.onSignal('focus', () => {});
    stale.unsubscribe();
    const received: string[] = [];
    port.onSignal('focus', (message) => {
      received.push(message.payload.topic);
    });

    stale.unsubscribe();
    await handle.signals.send('focus', { topic: 'still-here' });

    expect(received).toEqual(['still-here']);
  });
});

// ---------------------------------------------------------------------------
// Child → parent events
// ---------------------------------------------------------------------------

describe('child signals — child emits, parent observes', () => {
  it('delivers a validated, correlated event to the parent listener', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      signals: contract,
    });
    const observed: unknown[] = [];
    handle.signals.on('progress', (message) => {
      observed.push(message);
    });

    const outcome = childPortOf(contexts).emit('progress', { percent: 40 });

    expect(outcome).toEqual({
      status: 'emitted',
      id: 'child-1:event:1',
      sequence: 1,
      name: 'progress',
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      delivered: true,
    });
    expect(observed).toEqual([
      {
        id: 'child-1:event:1',
        sequence: 1,
        name: 'progress',
        payload: { percent: 40 },
        parentRunId: 'parent-1',
        childRunId: 'child-1',
      },
    ]);
  });

  it('buffers events emitted before the parent listens and flushes them in order', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const port = childPortOf(contexts);

    expect(port.emit('request', { question: 'one?' })).toMatchObject({
      status: 'emitted',
      delivered: false,
    });
    port.emit('request', { question: 'two?' });
    const questions: string[] = [];
    handle.signals.on('request', (message) => {
      questions.push(message.payload.question);
      if (message.payload.question === 'one?') port.emit('request', { question: 'three?' });
    });

    expect(questions).toEqual(['one?', 'two?', 'three?']);
  });

  it('rejects invalid, unknown, and over-bound events with typed codes', () => {
    const { agent, contexts } = makeControllableAgent();
    dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
      signalBufferLimit: 1,
    });
    const port = childPortOf(contexts);

    expect(port.emit('progress', { percent: 400 })).toMatchObject({
      status: 'rejected',
      code: 'invalid-payload',
      delivered: false,
    });
    expect(port.emit('anything', { fn: () => 1 })).toMatchObject({ code: 'invalid-payload' });
    expect(port.emit('nope' as never, {} as never)).toMatchObject({ code: 'unknown-name' });
    expect(port.emit('progress', { percent: 1 })).toMatchObject({ status: 'emitted' });
    expect(port.emit('progress', { percent: 2 })).toMatchObject({ code: 'buffer-full' });
  });

  it('isolates a throwing parent listener from the emitting child', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    handle.signals.on('progress', () => {
      throw new Error('listener bug');
    });

    expect(childPortOf(contexts).emit('progress', { percent: 5 })).toMatchObject({
      status: 'emitted',
      delivered: true,
    });
  });

  it('allows one listener per event name, releases it on unsubscribe, and rejects unknown names', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const subscription = handle.signals.on('progress', () => {});

    expect(() => handle.signals.on('progress', () => {})).toThrow(/already has a listener/);
    expect(() => handle.signals.on('nope' as never, () => {})).toThrow(TypeError);

    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);
    expect(childPortOf(contexts).emit('progress', { percent: 1 })).toMatchObject({
      delivered: false,
    });
  });

  it('lets the parent observe a real child run emit before the child completes', async () => {
    const release = deferred();
    const observed: number[] = [];
    let observedBeforeCompletion = false;
    const work = createTool({
      name: 'work',
      description: 'Does work and reports progress.',
      input: z.object({}),
      async execute(_input, toolContext) {
        const port = readParentSignals(toolContext.executionContext, contract);
        port?.emit('progress', { percent: 50 });
        await release.promise;
        return 'done';
      },
    });
    const child = createAgent({
      name: 'real-child',
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 'call-1', name: 'work', arguments: {} }] },
        textResponse('finished'),
      ]),
      toolbox: createTestToolbox([work]),
      stopWhen: noToolCalls(),
    });

    const handle = dispatchChildRun(child, 'go', {
      agentName: 'real-child',
      parentRunId: 'p',
      signals: contract,
    });
    let completed = false;
    const result = handle.result().then((value) => {
      completed = true;
      return value;
    });
    const firstProgress = deferred();
    handle.signals.on('progress', (message) => {
      observed.push(message.payload.percent);
      observedBeforeCompletion = !completed;
      firstProgress.resolve();
    });

    await firstProgress.promise;
    expect(observed).toEqual([50]);
    expect(observedBeforeCompletion).toBe(true);

    release.resolve();
    expect(await result).toMatchObject({ finishReason: 'stop-condition' });
    expect(handle.signals.closeReason).toBe('completed');
  });

  it('lets a real child run tool handle a parent signal and acknowledge it', async () => {
    const handled = deferred<string>();
    const listening = deferred();
    const wait = createTool({
      name: 'wait-for-focus',
      description: 'Waits for the parent to choose a topic.',
      input: z.object({}),
      async execute(_input, toolContext) {
        const port = readParentSignals(toolContext.executionContext, contract);
        if (port === undefined) return 'no port';
        const topic = await new Promise<string>((resolve) => {
          const subscription = port.onSignal('focus', (message) => {
            subscription.unsubscribe();
            resolve(message.payload.topic);
          });
          listening.resolve();
        });
        handled.resolve(topic);
        return topic;
      },
    });
    const child = createAgent({
      name: 'real-child',
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 'call-1', name: 'wait-for-focus', arguments: {} }] },
        textResponse('finished'),
      ]),
      toolbox: createTestToolbox([wait]),
      stopWhen: noToolCalls(),
    });

    const handle = dispatchChildRun(child, 'go', {
      agentName: 'real-child',
      parentRunId: 'p',
      signals: contract,
    });
    await listening.promise;
    const outcome = await handle.signals.send('focus', { topic: 'owls' });

    expect(outcome.status).toBe('acknowledged');
    expect(await handled.promise).toBe('owls');
    expect(await handle.result()).toMatchObject({ finishReason: 'stop-condition' });
  });
});

// ---------------------------------------------------------------------------
// Schemas that throw while validating
// ---------------------------------------------------------------------------

/**
 * `safeParse` reports only schema issues. An error thrown inside a
 * refinement or a transform escapes it, and a schema with an asynchronous
 * refinement throws because a synchronous parse cannot await it. Each entry
 * is declared as both a signal and an event.
 */
const throwingSchemas = {
  throwingRefine: z.object({ topic: z.string() }).refine(() => {
    throw new Error('refine threw');
  }),
  throwingTransform: z.string().transform((): string => {
    throw new Error('transform threw');
  }),
  asyncRefine: z.object({ topic: z.string() }).refine(async () => true),
};

const throwingContract = defineChildSignals({
  signals: throwingSchemas,
  events: throwingSchemas,
});

const throwingCases = [
  ['throwingRefine', { topic: 'x' }, /refine threw/],
  ['throwingTransform', 'x', /transform threw/],
  ['asyncRefine', { topic: 'x' }, /Promise/],
] as const;

function dispatchWithThrowingContract() {
  const { agent, contexts } = makeControllableAgent();
  const handle = dispatchChildRun(agent, 'go', {
    agentName: 'worker',
    parentRunId: 'p',
    childRunId: 'c',
    signals: throwingContract,
  });
  const port = readParentSignals(contexts[0], throwingContract);
  if (port === undefined) throw new Error('the child received no parent signal port');
  return { handle, port };
}

describe('child signals — schemas that throw while validating', () => {
  it.each(throwingCases)(
    'resolves a %s signal to invalid-payload without throwing or delivering it',
    async (name, payload, reason) => {
      const { handle, port } = dispatchWithThrowingContract();
      let calls = 0;
      port.onSignal(name, () => {
        calls++;
      });

      let sent: ReturnType<typeof handle.signals.send> | undefined;
      expect(() => {
        sent = handle.signals.send(name, payload);
      }).not.toThrow();
      const outcome = await sent;

      expect(outcome).toMatchObject({
        status: 'rejected',
        name,
        code: 'invalid-payload',
        delivered: false,
      });
      expect(outcome?.status === 'rejected' ? outcome.reason : '').toMatch(reason);
      expect(calls).toBe(0);
    },
  );

  it.each(throwingCases)(
    'returns invalid-payload for a %s event without throwing or delivering it',
    (name, payload, reason) => {
      const { handle, port } = dispatchWithThrowingContract();
      let calls = 0;
      handle.signals.on(name, () => {
        calls++;
      });

      let emitted: ReturnType<typeof port.emit> | undefined;
      expect(() => {
        emitted = port.emit(name, payload);
      }).not.toThrow();

      expect(emitted).toMatchObject({
        status: 'rejected',
        name,
        code: 'invalid-payload',
        delivered: false,
      });
      expect(emitted?.status === 'rejected' ? emitted.reason : '').toMatch(reason);
      expect(calls).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

describe('child signals — correlation to one parent-child relationship', () => {
  it('keeps two concurrent children with the same contract fully separate', async () => {
    const { agent, contexts } = makeControllableAgent();
    const alpha = dispatchChildRun(agent, 'a', {
      agentName: 'alpha',
      parentRunId: 'p',
      childRunId: 'child-alpha',
      signals: contract,
    });
    const beta = dispatchChildRun(agent, 'b', {
      agentName: 'beta',
      parentRunId: 'p',
      childRunId: 'child-beta',
      signals: contract,
    });
    const alphaPort = childPortOf(contexts, 0);
    const betaPort = childPortOf(contexts, 1);
    const alphaReceived: string[] = [];
    const betaReceived: string[] = [];
    alphaPort.onSignal('focus', (message) => {
      alphaReceived.push(`${message.childRunId}:${message.payload.topic}`);
    });
    betaPort.onSignal('focus', (message) => {
      betaReceived.push(`${message.childRunId}:${message.payload.topic}`);
    });
    const alphaObserved: string[] = [];
    const betaObserved: string[] = [];
    alpha.signals.on('progress', (message) => alphaObserved.push(message.id));
    beta.signals.on('progress', (message) => betaObserved.push(message.id));

    const [toAlpha, toBeta] = await Promise.all([
      alpha.signals.send('focus', { topic: 'one' }),
      beta.signals.send('focus', { topic: 'two' }),
    ]);
    betaPort.emit('progress', { percent: 10 });
    alphaPort.emit('progress', { percent: 20 });

    expect(alphaReceived).toEqual(['child-alpha:one']);
    expect(betaReceived).toEqual(['child-beta:two']);
    expect(toAlpha).toMatchObject({ status: 'acknowledged', childRunId: 'child-alpha' });
    expect(toBeta).toMatchObject({ status: 'acknowledged', childRunId: 'child-beta' });
    expect(alphaObserved).toEqual(['child-alpha:event:1']);
    expect(betaObserved).toEqual(['child-beta:event:1']);

    alpha.abort('done with alpha');
    expect(alpha.signals.closeReason).toBe('aborted');
    expect(beta.signals.closeReason).toBeUndefined();
    expect(await alpha.signals.send('focus', { topic: 'late' })).toMatchObject({
      status: 'rejected',
    });
    expect(await beta.signals.send('focus', { topic: 'three' })).toMatchObject({
      status: 'acknowledged',
    });
    expect(betaReceived).toEqual(['child-beta:two', 'child-beta:three']);
  });

  it('readParentSignals returns a port only for the exact contract the channel was built with', () => {
    const { agent, contexts } = makeControllableAgent();
    dispatchChildRun(agent, 'go', { agentName: 'worker', parentRunId: 'p', signals: contract });
    const otherContract = defineChildSignals({
      signals: contract.signals,
      events: contract.events,
    });

    expect(readParentSignals(contexts[0], contract)).toBeDefined();
    expect(readParentSignals(contexts[0], otherContract)).toBeUndefined();
    expect(readParentSignals(undefined, contract)).toBeUndefined();
  });

  it('readParentSignals rejects a structurally identical port that no channel created', () => {
    const { child } = createChildSignalChannel(contract, {
      parentRunId: 'p',
      childRunId: 'c',
    });
    const forged = { ...child, contract } as unknown as ChildSignalPort<TestContract>;

    expect(readParentSignals({ parentSignals: child }, contract)).toBe(child);
    expect(readParentSignals({ parentSignals: forged }, contract)).toBeUndefined();
    expect(readParentSignals({ parentSignals: 'nope' }, contract)).toBeUndefined();
    expect(readParentSignals({ parentSignals: null }, contract)).toBeUndefined();
  });

  it('does not hand a child port to a grandchild dispatched from inside the child', async () => {
    const grandchildContexts: (AgentRunContext | undefined)[] = [];
    const grandchild: RunnableAgent = {
      name: 'grandchild',
      hasOutput: false,
      run(_input, context) {
        grandchildContexts.push(context);
        return {
          result: async () => makeResult(),
          abort: () => {},
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: () => (async function* () {})(),
        } as unknown as ReturnType<RunnableAgent['run']>;
      },
    };
    let childToolSawPort = false;
    const probe = createTool({
      name: 'probe',
      description: 'Checks for a port.',
      input: z.object({}),
      async execute(_input, toolContext) {
        childToolSawPort = readParentSignals(toolContext.executionContext, contract) !== undefined;
        return 'ok';
      },
    });
    const delegate = createSubagentTool({
      name: 'delegate',
      description: 'Delegates to a grandchild.',
      agentName: 'grandchild',
      agent: grandchild,
      input: z.object({}),
      toAgentInput: () => 'go deeper',
    });
    const child = createAgent({
      name: 'real-child',
      generate: createMockGenerate([
        {
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'probe', arguments: {} },
            { id: 'call-2', name: 'delegate', arguments: {} },
          ],
        },
        textResponse('finished'),
      ]),
      toolbox: createTestToolbox([probe, delegate]),
      stopWhen: noToolCalls(),
    });

    const handle = dispatchChildRun(child, 'go', {
      agentName: 'real-child',
      parentRunId: 'p',
      signals: contract,
    });
    await handle.result();

    expect(childToolSawPort).toBe(true);
    expect(grandchildContexts).toHaveLength(1);
    expect(grandchildContexts[0]?.parentSignals).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Close semantics: abort, completion, disposal
// ---------------------------------------------------------------------------

describe('child signals — deterministic close', () => {
  it('closes on a child-targeted abort and rejects every later send and emit', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      childRunId: 'c',
      signals: contract,
    });
    const port = childPortOf(contexts);

    handle.abort('stop');

    expect(handle.signals.closeReason).toBe('aborted');
    expect(port.closeReason).toBe('aborted');
    expect(await handle.signals.send('focus', { topic: 'late' })).toEqual({
      status: 'rejected',
      id: 'c:signal:1',
      sequence: 1,
      name: 'focus',
      parentRunId: 'p',
      childRunId: 'c',
      code: 'channel-closed',
      reason: 'The parent-child signal channel closed: aborted.',
      closeReason: 'aborted',
      delivered: false,
    });
    expect(port.emit('progress', { percent: 1 })).toMatchObject({
      status: 'rejected',
      code: 'channel-closed',
      closeReason: 'aborted',
    });
  });

  it('closes when the parent signal aborts', async () => {
    const { agent } = makeControllableAgent();
    const parent = new AbortController();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signal: parent.signal,
      signals: contract,
    });

    parent.abort('parent gone');

    expect(handle.signals.closeReason).toBe('aborted');
    expect(await handle.signals.send('pause', {})).toMatchObject({ code: 'channel-closed' });
  });

  it('starts closed when the parent signal is already aborted at dispatch', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signal: AbortSignal.abort('already'),
      signals: contract,
    });

    expect(handle.signals.closeReason).toBe('aborted');
    expect(childPortOf(contexts).emit('progress', { percent: 1 })).toMatchObject({
      code: 'channel-closed',
    });
  });

  it('resolves a buffered send and an in-flight send as channel-closed when abort races them', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const gate = deferred();
    childPortOf(contexts).onSignal('pause', () => gate.promise);

    const inFlight = handle.signals.send('pause', {});
    const buffered = handle.signals.send('focus', { topic: 'never delivered' });
    handle.abort();
    gate.resolve();

    expect(await inFlight).toMatchObject({
      status: 'rejected',
      code: 'channel-closed',
      closeReason: 'aborted',
      delivered: true,
    });
    expect(await buffered).toMatchObject({
      status: 'rejected',
      code: 'channel-closed',
      closeReason: 'aborted',
      delivered: false,
    });
  });

  it('resolves an in-flight send as channel-closed when the child completes first', async () => {
    const { agent, contexts, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const gate = deferred();
    childPortOf(contexts).onSignal('pause', () => gate.promise);

    const inFlight = handle.signals.send('pause', {});
    settle(makeResult());
    await handle.result();
    gate.resolve();

    expect(await inFlight).toMatchObject({
      code: 'channel-closed',
      closeReason: 'completed',
      delivered: true,
    });
  });

  it('rejects a buffered signal when a real child run is aborted before it listens', async () => {
    const entered = deferred();
    const blocked = createTool({
      name: 'blocked',
      description: 'Waits for the run to abort.',
      input: z.object({}),
      async execute(_input, toolContext) {
        entered.resolve();
        await new Promise<void>((resolve) => {
          toolContext.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'stopped';
      },
    });
    const child = createAgent({
      name: 'real-child',
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 'call-1', name: 'blocked', arguments: {} }] },
        textResponse('unreachable'),
      ]),
      toolbox: createTestToolbox([blocked]),
      stopWhen: noToolCalls(),
    });
    const handle = dispatchChildRun(child, 'go', {
      agentName: 'real-child',
      parentRunId: 'p',
      signals: contract,
    });
    await entered.promise;

    const buffered = handle.signals.send('focus', { topic: 'too late' });
    handle.abort('parent changed its mind');
    const result = await handle.result();

    expect(await buffered).toMatchObject({
      status: 'rejected',
      code: 'channel-closed',
      closeReason: 'aborted',
      delivered: false,
    });
    expect(result).toMatchObject({ finishReason: 'aborted' });
    expect(handle.signals.closeReason).toBe('aborted');
  });

  it('ignores a handler failure that settles after the channel already closed', async () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    let fail: ((error: Error) => void) | undefined;
    childPortOf(contexts).onSignal(
      'pause',
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );

    const inFlight = handle.signals.send('pause', {});
    handle.abort();
    fail?.(new Error('too late'));

    expect(await inFlight).toMatchObject({ code: 'channel-closed' });
  });

  it('closes with completed once the child completes and rejects later sends', async () => {
    const { agent, contexts, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const pending = handle.signals.send('focus', { topic: 'unhandled' });

    settle(makeResult());
    await handle.result();

    expect(handle.signals.closeReason).toBe('completed');
    expect(childPortOf(contexts).closeReason).toBe('completed');
    expect(await pending).toMatchObject({ code: 'channel-closed', closeReason: 'completed' });
    expect(await handle.signals.send('focus', { topic: 'after' })).toMatchObject({
      code: 'channel-closed',
      closeReason: 'completed',
    });
  });

  it('closes with failed when the child fails, rejects, or throws from run()', async () => {
    const failing = makeControllableAgent();
    const failed = dispatchChildRun(failing.agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    failing.settle(makeResult({ finishReason: 'error' }));
    await failed.result();
    expect(failed.signals.closeReason).toBe('failed');

    const rejecting = makeControllableAgent();
    const rejected = dispatchChildRun(rejecting.agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    rejecting.fail(new Error('boom'));
    expect(await throwingRejectionOf(rejected.result())).toThrow('boom');
    expect(rejected.signals.closeReason).toBe('failed');

    let capturedPort: ChildSignalPort<TestContract> | undefined;
    const throwing: RunnableAgent = {
      name: 'throwing',
      hasOutput: false,
      run(_input, context) {
        capturedPort = readParentSignals(context, contract);
        throw new Error('synchronous failure');
      },
    };
    expect(() =>
      dispatchChildRun(throwing, 'go', {
        agentName: 'worker',
        parentRunId: 'p',
        signals: contract,
      }),
    ).toThrow('synchronous failure');
    expect(capturedPort?.closeReason).toBe('failed');
  });

  it('closes with aborted when the child settles as aborted', async () => {
    const { agent, settle } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });

    settle(makeResult({ finishReason: 'aborted' }));
    await handle.result();

    expect(handle.signals.closeReason).toBe('aborted');
  });

  it('closes with disposed on disposal, and keeps the first close reason afterwards', async () => {
    const disposedAgent = makeControllableAgent();
    const disposed = dispatchChildRun(disposedAgent.agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    disposed[Symbol.dispose]();
    expect(disposed.signals.closeReason).toBe('disposed');
    expect(await disposed.signals.send('pause', {})).toMatchObject({
      code: 'channel-closed',
      closeReason: 'disposed',
    });

    const completedAgent = makeControllableAgent();
    const completed = dispatchChildRun(completedAgent.agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    completedAgent.settle(makeResult());
    await completed.result();
    completed[Symbol.dispose]();
    completed.abort();
    expect(completed.signals.closeReason).toBe('completed');
  });

  it('releases buffered events, handlers, and listeners on close', () => {
    const { agent, contexts } = makeControllableAgent();
    const handle = dispatchChildRun(agent, 'go', {
      agentName: 'worker',
      parentRunId: 'p',
      signals: contract,
    });
    const port = childPortOf(contexts);
    port.emit('progress', { percent: 1 });
    const handlerSubscription = port.onSignal('focus', () => {});
    const listenerSubscription = handle.signals.on('request', () => {});

    handle.abort();

    expect(handlerSubscription.closed).toBe(true);
    expect(listenerSubscription.closed).toBe(true);
    const late: number[] = [];
    const lateSubscription = handle.signals.on('progress', (message) => {
      late.push(message.payload.percent);
    });
    const lateHandler = port.onSignal('pause', () => {});
    expect(late).toEqual([]);
    expect(lateSubscription.closed).toBe(true);
    expect(lateHandler.closed).toBe(true);
    lateSubscription.unsubscribe();
    lateHandler.unsubscribe();
  });

  it('detaches its abort listener from the composed signal once the channel closes while the parent signal stays live', async () => {
    // A long-lived supervisor reuses one parent signal across many children.
    // A listener left on each child's composed signal keeps that signal —
    // and the finished child's whole run — reachable from the parent signal
    // until the parent itself aborts.
    const parent = new AbortController();
    const dispatch = (agent: RunnableAgent) =>
      dispatchChildRun(agent, 'go', {
        agentName: 'worker',
        parentRunId: 'p',
        signal: parent.signal,
        signals: contract,
      });
    const abortListenersOn = (context: AgentRunContext | undefined): number => {
      if (context?.signal === undefined) throw new Error('the child received no signal');
      return getEventListeners(context.signal, 'abort').length;
    };

    const completing = makeControllableAgent();
    const completed = dispatch(completing.agent);
    expect(abortListenersOn(completing.contexts[0])).toBe(1);
    completing.settle(makeResult());
    await completed.result();
    expect(completed.signals.closeReason).toBe('completed');
    expect(abortListenersOn(completing.contexts[0])).toBe(0);

    const settlingAborted = makeControllableAgent();
    const settledAborted = dispatch(settlingAborted.agent);
    settlingAborted.settle(makeResult({ finishReason: 'aborted' }));
    await settledAborted.result();
    expect(settledAborted.signals.closeReason).toBe('aborted');
    expect(abortListenersOn(settlingAborted.contexts[0])).toBe(0);

    const failing = makeControllableAgent();
    const failed = dispatch(failing.agent);
    failing.settle(makeResult({ finishReason: 'error' }));
    await failed.result();
    expect(failed.signals.closeReason).toBe('failed');
    expect(abortListenersOn(failing.contexts[0])).toBe(0);

    const rejecting = makeControllableAgent();
    const rejected = dispatch(rejecting.agent);
    rejecting.fail(new Error('boom'));
    expect(await throwingRejectionOf(rejected.result())).toThrow('boom');
    expect(rejected.signals.closeReason).toBe('failed');
    expect(abortListenersOn(rejecting.contexts[0])).toBe(0);

    let throwingContext: AgentRunContext | undefined;
    const throwing: RunnableAgent = {
      name: 'throwing',
      hasOutput: false,
      run(_input, context) {
        throwingContext = context;
        throw new Error('synchronous failure');
      },
    };
    expect(() => dispatch(throwing)).toThrow('synchronous failure');
    expect(abortListenersOn(throwingContext)).toBe(0);

    const disposing = makeControllableAgent();
    const disposed = dispatch(disposing.agent);
    disposed[Symbol.dispose]();
    expect(disposed.signals.closeReason).toBe('disposed');
    expect(abortListenersOn(disposing.contexts[0])).toBe(0);

    expect(parent.signal.aborted).toBe(false);
  });
});
