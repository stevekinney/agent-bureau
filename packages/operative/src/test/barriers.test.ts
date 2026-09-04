import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { createManualRuntimeServices, HookRegistry } from 'lifecycle';

import { createAgentSession } from '../agent-session';
import { createChildRunRegistry, dispatchChildRun } from '../child-run';
import { noToolCalls } from '../conditions/predicates';
import { createAgent } from '../create-agent';
import { createActiveRun } from '../create-run';
import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RunCursor } from '../durable/types';
import type { OperativeHookMap } from '../hooks';
import { createSessionStore } from '../session/create-session-store';
import type { GenerateResponse } from '../types';
import { createBarrierRegistry } from './barriers';
import { createManualCheckpointStore } from './durable-engine';
import { createEventRecorder } from './event-recorder';
import { createMockGenerate } from './index';
import { createScriptedGenerate } from './scripted-generate';
import { createScriptedHook, createScriptedTool } from './scripted-tool';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

const RUN_CURSOR: RunCursor = {
  step: 0,
  totalUsage: { prompt: 0, completion: 0, total: 0 },
  lastContent: '',
  schemaAttempts: 0,
  lastAppliedConfigVersion: 0,
};

// ---------------------------------------------------------------------------
// Core semantics
// ---------------------------------------------------------------------------

describe('createBarrierRegistry — core semantics', () => {
  it('barrier(name) returns the same instance for the same name', () => {
    const registry = createBarrierRegistry();
    expect(registry.barrier('a')).toBe(registry.barrier('a'));
    expect(registry.barrier('a')).not.toBe(registry.barrier('b'));
  });

  it('names() lists every barrier requested so far, in first-request order', () => {
    const registry = createBarrierRegistry();
    registry.barrier('first');
    registry.barrier('second');
    registry.barrier('first');
    expect(registry.names()).toEqual(['first', 'second']);
  });

  it('resolves reached() when arrive() is called after reached() was already awaited (subscription before arrival)', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('b');

    let reachedResolved = false;
    const wait = barrier.reached().then(() => {
      reachedResolved = true;
    });
    expect(reachedResolved).toBe(false);

    const arrival = barrier.arrive();
    await wait;
    expect(reachedResolved).toBe(true);

    barrier.release('value');
    expect(await arrival).toBe('value');
  });

  it('resolves reached() immediately when arrive() already happened (arrival before subscription)', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('b');

    const arrival = barrier.arrive();
    // Give the microtask queue a turn so arrive()'s synchronous work has run.
    await Promise.resolve();

    let reachedResolved = false;
    await barrier.reached().then(() => {
      reachedResolved = true;
    });
    expect(reachedResolved).toBe(true);

    barrier.release();
    await arrival;
  });

  it('release() lets exactly one waiting arrival through', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('b');

    const first = barrier.arrive();
    const second = barrier.arrive();
    expect(barrier.inspect()).toEqual({ name: 'b', arrivals: 2, released: 0, pending: true });

    barrier.release('one');
    expect(await first).toBe('one');
    expect(barrier.inspect().pending).toBe(true);

    barrier.release('two');
    expect(await second).toBe('two');
    expect(barrier.inspect()).toEqual({ name: 'b', arrivals: 2, released: 2, pending: false });
  });

  it('over-release is recorded and lets the next arrivals through without blocking', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('b');

    barrier.release('early-one');
    barrier.release('early-two');
    expect(barrier.inspect()).toEqual({ name: 'b', arrivals: 0, released: 2, pending: false });

    expect(await barrier.arrive()).toBe('early-one');
    expect(await barrier.arrive()).toBe('early-two');
    expect(barrier.inspect()).toEqual({ name: 'b', arrivals: 2, released: 2, pending: false });

    // A third arrival, with nothing banked, blocks for real.
    const third = barrier.arrive();
    expect(barrier.inspect().pending).toBe(true);
    barrier.release('third');
    expect(await third).toBe('third');
  });

  it('reject(error) makes the waiting arrive() call throw that error', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('b');

    const arrival = barrier.arrive();
    const error = new Error('injected fault');
    barrier.reject(error);

    let caught: unknown;
    try {
      await arrival;
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
    expect(barrier.inspect()).toEqual({ name: 'b', arrivals: 1, released: 1, pending: false });
  });

  it('reject() banked ahead of arrival makes the next arrive() throw immediately, without leaving the barrier pending', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('b');
    const error = new Error('pre-reject');

    barrier.reject(error);
    expect(barrier.inspect().pending).toBe(false);

    let caught: unknown;
    try {
      await barrier.arrive();
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
    expect(barrier.inspect()).toEqual({ name: 'b', arrivals: 1, released: 1, pending: false });
  });

  it('assertNoPending() is silent when nothing is blocked', () => {
    const registry = createBarrierRegistry();
    registry.barrier('a');
    const barrier = registry.barrier('b');
    barrier.release();
    expect(() => registry.assertNoPending()).not.toThrow();
  });

  it('assertNoPending() throws, naming every still-blocked barrier, when an arrival was never released', () => {
    const registry = createBarrierRegistry();
    const stuck = registry.barrier('stuck-one');
    const alsoStuck = registry.barrier('stuck-two');
    const fine = registry.barrier('fine');

    void stuck.arrive();
    void alsoStuck.arrive();
    fine.release();
    void fine.arrive();

    expect(() => registry.assertNoPending()).toThrow(/stuck-one/);
    expect(() => registry.assertNoPending()).toThrow(/stuck-two/);
    expect(() => registry.assertNoPending()).not.toThrow(/\bfine\b/);
  });
});

// ---------------------------------------------------------------------------
// CausalTraceEntry recording
// ---------------------------------------------------------------------------

describe('createBarrierRegistry — CausalTraceEntry recording', () => {
  it('records nothing when no recorder is supplied', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('unrecorded');
    const arrival = barrier.arrive();
    barrier.release('value');
    await arrival;
    // No recorder means no CausalTraceEntry surface exists to assert
    // against at all — this test exists to prove `barriers.ts` doesn't
    // require one, not to assert an empty array (there is nowhere to read
    // one from without a recorder).
    expect(barrier.inspect().released).toBe(1);
  });

  it('records reached, released, and rejected transitions with resource "barrier:<name>" and event "barrier.<transition>"', async () => {
    const runtime = createManualRuntimeServices();
    const recorder = createEventRecorder(runtime);
    const registry = createBarrierRegistry(recorder);
    const barrier = registry.barrier('my-barrier');

    const first = barrier.arrive();
    barrier.release('ok');
    await first;

    const second = barrier.arrive();
    const error = new Error('boom');
    barrier.reject(error);
    let caught: unknown;
    try {
      await second;
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);

    const entries = recorder.normalize();
    expect(entries.map((entry) => [entry.resource, entry.event])).toEqual([
      ['barrier:my-barrier', 'barrier.reached'],
      ['barrier:my-barrier', 'barrier.released'],
      ['barrier:my-barrier', 'barrier.reached'],
      ['barrier:my-barrier', 'barrier.rejected'],
    ]);
  });

  it('assertHappensBefore orders a barrier release after its own reached transition', async () => {
    const runtime = createManualRuntimeServices();
    const recorder = createEventRecorder(runtime);
    const registry = createBarrierRegistry(recorder);
    const barrier = registry.barrier('ordered');

    const arrival = barrier.arrive();
    barrier.release();
    await arrival;

    expect(() => recorder.assertHappensBefore('barrier.reached', 'barrier.released')).not.toThrow();
  });

  it('two separately named barriers on one registry each get their own resource in the trace', async () => {
    const runtime = createManualRuntimeServices();
    const recorder = createEventRecorder(runtime);
    const registry = createBarrierRegistry(recorder);

    const a = registry.barrier('a');
    const b = registry.barrier('b');
    a.release();
    b.release();
    await a.arrive();
    await b.arrive();

    const resources = new Set(recorder.normalize().map((entry) => entry.resource));
    expect(resources).toEqual(new Set(['barrier:a', 'barrier:b']));
  });
});

// ---------------------------------------------------------------------------
// Placement at AB-95's nine coordination points
// ---------------------------------------------------------------------------

describe("createBarrierRegistry — placement at AB-95's nine coordination points", () => {
  it('a model call, through a scripted generate block step (tst-02f)', async () => {
    const runtime = createManualRuntimeServices();
    const generate = createScriptedGenerate([
      { kind: 'block', barrier: 'model' },
      { kind: 'respond', response: textResponse('done') },
    ]);
    const order: string[] = [];

    const activeRun = createActiveRun({
      generate,
      toolbox: createToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
    });
    void activeRun.result.then(() => order.push('run-completed'));

    await generate.reached('model');
    // The block step arrives at and releases through the SAME named
    // Barrier a test obtains from `generate.barriers` — no separate bridge.
    expect(generate.barriers.barrier('model').inspect().pending).toBe(true);
    expect(order).toEqual([]);

    order.push('barrier-released');
    generate.release('model');
    await activeRun.result;

    expect(order).toEqual(['barrier-released', 'run-completed']);
  });

  it('a tool call, through a scripted tool block step (tst-02f)', async () => {
    const runtime = createManualRuntimeServices();
    const tool = createScriptedTool('search', [
      { kind: 'block', barrier: 'tool' },
      { kind: 'resolve', result: 'ok' },
    ]);
    const order: string[] = [];

    const activeRun = createActiveRun({
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 't1', name: 'search', arguments: {} }] },
        textResponse('done'),
      ]),
      toolbox: createToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
    });
    void activeRun.result.then(() => order.push('run-completed'));

    await tool.reached('tool');
    expect(tool.barriers.barrier('tool').inspect().pending).toBe(true);
    expect(order).toEqual([]);

    order.push('barrier-released');
    tool.release('tool');
    await activeRun.result;

    expect(order).toEqual(['barrier-released', 'run-completed']);
  });

  it('a hook phase, through a scripted hook block step (tst-02f)', async () => {
    const runtime = createManualRuntimeServices();
    const hook = createScriptedHook('after-tool', [
      { kind: 'block', barrier: 'hook' },
      { kind: 'resolve', value: undefined },
    ]);
    const order: string[] = [];

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on(hook.hookName, hook);
    const tool = createScriptedTool('search', [{ kind: 'resolve', result: 'ok' }]);

    const activeRun = createActiveRun({
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 't1', name: 'search', arguments: {} }] },
        textResponse('done'),
      ]),
      toolbox: createToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      runtime,
    });
    void activeRun.result.then(() => order.push('run-completed'));

    await hook.reached('hook');
    expect(hook.barriers.barrier('hook').inspect().pending).toBe(true);
    expect(order).toEqual([]);

    order.push('barrier-released');
    hook.release('hook');
    await activeRun.result;

    expect(order).toEqual(['barrier-released', 'run-completed']);
  });

  it('a durable checkpoint, through the manual checkpoint store (durable-engine.ts)', async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('durable-checkpoint');
    const order: string[] = [];
    const base = createManualCheckpointStore();
    const store: CheckpointStore = {
      ...base,
      async saveCursor(runId, cursor) {
        await barrier.arrive();
        order.push('checkpoint-saved');
        return base.saveCursor(runId, cursor);
      },
    };

    const savePromise = store
      .saveCursor('run-1', RUN_CURSOR)
      .then(() => order.push('save-settled'));
    await barrier.reached();
    expect(barrier.inspect().pending).toBe(true);
    expect(order).toEqual([]);

    barrier.release();
    await savePromise;

    expect(order).toEqual(['checkpoint-saved', 'save-settled']);
  });

  it("a session commit, through the session store's conditionalBatch", async () => {
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('session-commit');
    const order: string[] = [];
    const rawStore = textValueStore(new MemoryStorage());
    const gated = {
      ...rawStore,
      async conditionalBatch(
        conditions: Parameters<typeof rawStore.conditionalBatch>[0],
        operations: Parameters<typeof rawStore.conditionalBatch>[1],
      ) {
        await barrier.arrive();
        order.push('committed');
        return rawStore.conditionalBatch(conditions, operations);
      },
    };

    const sessionStore = createSessionStore(gated);
    const session = createAgentSession({
      agentName: 'test-agent',
      conversationHistory: createConversationHistory(),
    });

    const savePromise = sessionStore.save(session).then(() => order.push('save-settled'));
    await barrier.reached();
    expect(barrier.inspect().pending).toBe(true);
    expect(order).toEqual([]);

    barrier.release();
    await savePromise;

    expect(order).toEqual(['committed', 'save-settled']);
  });

  it('a child registration, through dispatchChildRun + ChildRunRegistry (AB-50)', async () => {
    const order: string[] = [];

    const generate = createScriptedGenerate([
      { kind: 'block', barrier: 'child' },
      { kind: 'respond', response: textResponse('child-done') },
    ]);
    const childAgent = createAgent({
      name: 'child-agent',
      generate,
      toolbox: createToolbox([]),
      stopWhen: noToolCalls(),
    });

    const childRegistry = createChildRunRegistry();
    const handle = dispatchChildRun(childAgent, 'do work', {
      agentName: 'child-agent',
      parentRunId: 'parent-1',
      registry: childRegistry,
    });

    // Registration is synchronous — the child is already discoverable,
    // status 'running', before its own generate call has even reached the
    // barrier.
    expect(childRegistry.children()).toHaveLength(1);
    expect(childRegistry.children()[0]?.status).toBe('running');

    await generate.reached('child');
    expect(generate.barriers.barrier('child').inspect().pending).toBe(true);
    expect(childRegistry.children()[0]?.status).toBe('running');

    order.push('barrier-released');
    generate.release('child');
    await handle.result();
    // Let the registry's own result().then(settle) callback run.
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['barrier-released']);
    expect(childRegistry.children()[0]?.status).toBe('completed');
  });

  it('a signal delivery, gated before createDurableMultiAgentHarness.signal()', async () => {
    const { workflow } = await import('@lostgradient/weft');
    const { createDurableMultiAgentHarness } = await import('./durable-multi-agent-harness');

    const registry = createBarrierRegistry();
    const barrier = registry.barrier('signal-delivery');
    const order: string[] = [];

    const hitlWorkflow = workflow({ name: 'agentRun' }).execute(async function* (
      ctx,
      input: { requestId: string },
    ) {
      const result = yield* ctx.waitForSignal<{ approved: boolean }>('human-response');
      return { requestId: input.requestId, approved: result.approved };
    });

    const harness = await createDurableMultiAgentHarness({ runWorkflow: hitlWorkflow });
    try {
      const handle = await harness.engine.engine.start('agentRun', { requestId: 'r1' });
      await harness.waitForSuspend(handle.id);

      const deliver = (async () => {
        await barrier.arrive();
        await harness.signal(handle.id, 'human-response', { approved: true });
        order.push('signal-delivered');
      })();

      expect(barrier.inspect().pending).toBe(true);
      expect(order).toEqual([]);

      barrier.release();
      await deliver;

      const result = await handle.result();
      expect(order).toEqual(['signal-delivered']);
      expect(result).toEqual({ requestId: 'r1', approved: true });
    } finally {
      harness.dispose();
    }
  });

  it('an event publication, gated before EventRecorder observes the dispatch', async () => {
    const runtime = createManualRuntimeServices();
    const recorder = createEventRecorder(runtime);
    const registry = createBarrierRegistry();
    const barrier = registry.barrier('event-publication');

    const producer = new EventTarget();
    recorder.attach<{ 'example.published': Event }>(producer, { kind: 'example', id: 'p' }, [
      'example.published',
    ]);

    const publish = (async () => {
      await barrier.arrive();
      producer.dispatchEvent(new Event('example.published'));
    })();

    expect(barrier.inspect().pending).toBe(true);
    expect(recorder.normalize()).toEqual([]);

    barrier.release();
    await publish;

    expect(recorder.normalize().map((entry) => entry.event)).toEqual(['example.published']);
  });

  it('a cleanup boundary, through ActiveRun.closed()', async () => {
    const runtime = createManualRuntimeServices();
    const tool = createScriptedTool('search', [
      { kind: 'block', barrier: 'cleanup' },
      { kind: 'resolve', result: 'ok' },
    ]);
    const order: string[] = [];

    const activeRun = createActiveRun({
      generate: createMockGenerate([
        { content: '', toolCalls: [{ id: 't1', name: 'search', arguments: {} }] },
        textResponse('done'),
      ]),
      toolbox: createToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
    });
    void activeRun.closed().then(() => order.push('closed'));

    await tool.reached('cleanup');
    expect(tool.barriers.barrier('cleanup').inspect().pending).toBe(true);
    expect(order).toEqual([]);

    order.push('barrier-released');
    tool.release('cleanup');
    await activeRun.result;
    await activeRun.closed();

    expect(order).toEqual(['barrier-released', 'closed']);
  });
});
