/**
 * Tests for AB-67's runStep boundary read: the session's desired steering
 * state (`RunOptions.steering`, a {@link SteeringGate}) is read once per
 * step at `runStep`'s entry — immediately after the existing abort check
 * and before backpressure — and a `paused: true` desired state blocks the
 * step there until a matching `resume` releases it OR the step's own
 * `AbortSignal` fires, whichever comes first.
 *
 * These tests drive `runStep` through the in-memory `executeLoop` driver
 * (`buildStepDeps` + the step `for` loop), the same construction site the
 * durable driver shares — see `src/durable/run-workflow.test.ts` for the
 * durable-driver coverage of the identical boundary.
 *
 * No real timers: every "does this block" assertion controls a
 * manually-resolved gate double (`createTestSteeringGate` below), never a
 * `setTimeout`.
 */
import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import type { SteeringDesiredState } from './durable/types';
import { SteeringAppliedEvent } from './events';
import type { OperativeHookMap } from './hooks';
import { executeLoop } from './loop';
import { awaitResumeOrAbort, type EventDispatcher } from './run-step';
import type { GenerateContext, GenerateResponse, SteeringGate } from './types';

/** A minimal {@link EventDispatcher} test double that records every dispatched event. */
function createEventRecorder(): EventDispatcher & { events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    dispatch(event) {
      events.push(event);
      return true;
    },
  };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/**
 * A manually-controlled `SteeringGate` double. `setDesiredState` is the
 * test's stand-in for a `SteeringCommand` reaching `accepted`: it updates
 * the value `getDesiredState()` returns and, when the new state reports
 * `paused: false`, releases every pending `awaitResume()` caller. No real
 * timers are involved — `awaitResume()` returns a promise this function
 * resolves directly.
 *
 * Also models the cleanup `SteeringGate.awaitResume`'s optional `signal`
 * parameter exists for: when the passed signal fires first, this gate drops
 * its own registered waiter instead of leaving it pending forever —
 * `pendingWaiterCount()` lets a test assert that drop actually happened.
 */
function createTestSteeringGate(initial: SteeringDesiredState): SteeringGate & {
  setDesiredState: (next: SteeringDesiredState) => void;
  pendingWaiterCount: () => number;
} {
  let desired = initial;
  let resumeWaiters: Array<() => void> = [];

  return {
    sessionId: 'test-session',
    getDesiredState: () => desired,
    setDesiredState(next) {
      desired = next;
      if (!next.paused) {
        const waiters = resumeWaiters;
        resumeWaiters = [];
        for (const resolve of waiters) resolve();
      }
    },
    pendingWaiterCount: () => resumeWaiters.length,
    awaitResume: (signal) =>
      new Promise<void>((resolve) => {
        resumeWaiters.push(resolve);
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => {
            resumeWaiters = resumeWaiters.filter((waiter) => waiter !== resolve);
          },
          { once: true },
        );
      }),
  };
}

const nextTool = createTool({
  name: 'next',
  description: 'continue to another step',
  input: z.object({}),
  execute: async () => 'ok',
});

describe('awaitResumeOrAbort (the pause-gate/AbortSignal race runStep consults)', () => {
  it('resolves aborted: true immediately for an already-aborted signal, without awaiting the gate', async () => {
    const controller = new AbortController();
    controller.abort('already gone');
    let awaitResumeCalls = 0;
    const gate: SteeringGate = {
      sessionId: 'test-session',
      getDesiredState: () => ({ paused: true, configVersion: 1 }),
      awaitResume: () => {
        awaitResumeCalls++;
        return new Promise<void>(() => {});
      },
    };

    const outcome = await awaitResumeOrAbort(gate, controller.signal);

    expect(outcome).toEqual({ aborted: true });
    expect(awaitResumeCalls).toBe(0);
  });

  it('resolves aborted: true when the signal fires mid-wait, before the gate resolves', async () => {
    const controller = new AbortController();
    const gate: SteeringGate = {
      sessionId: 'test-session',
      getDesiredState: () => ({ paused: true, configVersion: 1 }),
      awaitResume: () => new Promise<void>(() => {}), // never resolves on its own
    };

    const outcomePromise = awaitResumeOrAbort(gate, controller.signal);
    await Promise.resolve();
    controller.abort('stop now');

    expect(await outcomePromise).toEqual({ aborted: true });
  });

  it('resolves aborted: false once the gate resolves before any abort', async () => {
    let resolveGate: (() => void) | undefined;
    const gate: SteeringGate = {
      sessionId: 'test-session',
      getDesiredState: () => ({ paused: false, configVersion: 2 }),
      awaitResume: () =>
        new Promise<void>((resolve) => {
          resolveGate = resolve;
        }),
    };

    const outcomePromise = awaitResumeOrAbort(gate, undefined);
    await Promise.resolve();
    resolveGate?.();

    expect(await outcomePromise).toEqual({ aborted: false });
  });

  it('resolves aborted: false with no signal at all — resume is the only possible outcome', async () => {
    const gate: SteeringGate = {
      sessionId: 'test-session',
      getDesiredState: () => ({ paused: false, configVersion: 1 }),
      awaitResume: () => Promise.resolve(),
    };

    expect(await awaitResumeOrAbort(gate, undefined)).toEqual({ aborted: false });
  });
});

describe('runStep: AB-67 steering boundary read', () => {
  it('a run with no steering dependency proceeds exactly as it does today', async () => {
    let generateCalls = 0;
    let capturedSteering: GenerateContext['steering'];

    const result = await executeLoop({
      generate: async (context) => {
        generateCalls++;
        capturedSteering = context.steering;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(generateCalls).toBe(1);
    expect(capturedSteering).toBeUndefined();
    expect(result.finishReason).not.toBe('aborted');
    expect(result.finishReason).not.toBe('error');
  });

  it('threads the boundary-read desired state into GenerateContext for the generate function to read', async () => {
    const gate = createTestSteeringGate({
      paused: false,
      configVersion: 5,
      model: 'gpt-5',
      effort: 'high',
    });
    let captured: GenerateContext['steering'];

    await executeLoop({
      generate: async (context) => {
        captured = context.steering;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
    });

    expect(captured).toEqual({ paused: false, configVersion: 5, model: 'gpt-5', effort: 'high' });
  });

  it('a paused desired state blocks the step until the gate resolves, then proceeds', async () => {
    const gate = createTestSteeringGate({ paused: true, configVersion: 1 });
    let generateCalls = 0;

    const resultPromise = executeLoop({
      generate: async () => {
        generateCalls++;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
    });

    // Let the loop reach and block on the pause gate before asserting it
    // never called generate.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(generateCalls).toBe(0);

    gate.setDesiredState({ paused: false, configVersion: 2 });

    const result = await resultPromise;
    expect(generateCalls).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('re-checks paused after a resume: a pause re-admitted before the continuation re-reads state is not bypassed', async () => {
    const gate = createTestSteeringGate({ paused: true, configVersion: 1 });
    let generateCalls = 0;

    const resultPromise = executeLoop({
      generate: async () => {
        generateCalls++;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(generateCalls).toBe(0);

    // Resume, then immediately re-pause within the same synchronous turn —
    // simulating a command handler that resolves one pause's waiters and
    // admits a second pause before runStep's continuation gets a chance to
    // re-read desired state. A single-shot re-read (rather than looping
    // while still paused) would miss this and proceed anyway.
    gate.setDesiredState({ paused: false, configVersion: 2 });
    gate.setDesiredState({ paused: true, configVersion: 3 });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(generateCalls).toBe(0); // still blocked by the re-admitted pause

    gate.setDesiredState({ paused: false, configVersion: 4 });

    const result = await resultPromise;
    expect(generateCalls).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('AB-67: the boundary read is a snapshot, not a live reference into a mutable gate object', async () => {
    // `SteeringDesiredState`'s fields are `readonly` in the public type, but
    // a real gate implementation is free to hold one mutable object behind
    // that readonly view (e.g. a session cache it updates in place) — a
    // plain mutable local is structurally assignable to the readonly public
    // shape (readonly only restricts writes through that view, not
    // assignability), so no cast is needed to model that here.
    const state = { paused: false, configVersion: 1, route: 'r1' };
    const gate: SteeringGate = {
      sessionId: 'test-session',
      getDesiredState: () => state, // SAME object reference every call
      awaitResume: () => new Promise<void>(() => {}),
    };
    let capturedRoute: string | undefined;

    await executeLoop({
      generate: async (context) => {
        // Mutate the gate's live object mid-step, simulating a command
        // admitted concurrently with this step's own generate call.
        state.route = 'r2';
        capturedRoute = context.steering?.route;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
    });

    // If the boundary read had forwarded the gate's own object reference
    // rather than a copy, this would read back 'r2' — the mutation this
    // step made to the *gate's* state — instead of the value the boundary
    // actually captured before generate ever ran.
    expect(capturedRoute).toBe('r1');
  });

  it('AB-67: a retry mutator that omits steering does not drop it from the retried GenerateContext', async () => {
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, model: 'real-model' });
    const observedSteering: Array<GenerateContext['steering']> = [];
    let attempts = 0;

    const result = await executeLoop({
      generate: async (context) => {
        observedSteering.push(context.steering);
        attempts++;
        if (attempts === 1) {
          throw new Error('transient');
        }
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
      retry: {
        attempts: 2,
        delay: 0,
        mutate: () => ({
          // A mutator written with no knowledge of AB-67 — omits `steering`
          // entirely, the way most existing retry mutators would.
          conversation: new Conversation(),
          step: 0,
          toolbox: createTestToolbox([]),
        }),
      },
    });

    expect(attempts).toBe(2);
    const expected = { paused: false, configVersion: 1, model: 'real-model' };
    expect(observedSteering).toEqual([expected, expected]);
    expect(result.finishReason).not.toBe('error');
  });

  it('an abort while paused resolves the step as an abort, not a hang', async () => {
    const gate = createTestSteeringGate({ paused: true, configVersion: 1 });
    const controller = new AbortController();
    let generateCalls = 0;

    const resultPromise = executeLoop({
      generate: async () => {
        generateCalls++;
        return textResponse('unreachable');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: controller.signal,
      steering: gate,
    });

    // Let the loop reach and block on the pause gate, then abort instead of
    // ever resolving the gate — the gate is never released.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort('stop while paused');

    const result = await resultPromise;
    expect(result.finishReason).toBe('aborted');
    expect(generateCalls).toBe(0);
  });

  it('passes its own AbortSignal to awaitResume() so a real gate can drop its waiter on abort, not leak it', async () => {
    const gate = createTestSteeringGate({ paused: true, configVersion: 1 });
    const controller = new AbortController();

    const resultPromise = executeLoop({
      generate: async () => textResponse('unreachable'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: controller.signal,
      steering: gate,
    });

    // Let the loop reach and register a waiter on the pause gate.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.pendingWaiterCount()).toBe(1);

    controller.abort('stop while paused');
    await resultPromise;

    // The gate's own waiter is gone — a real implementation given `signal`
    // has the same opportunity to release whatever it registered, instead
    // of an abort-while-paused leaking a waiter for the gate's lifetime.
    expect(gate.pendingWaiterCount()).toBe(0);
  });

  it('a pre-aborted signal short-circuits before the pause gate is even consulted', async () => {
    const gate = createTestSteeringGate({ paused: true, configVersion: 1 });
    const controller = new AbortController();
    controller.abort('already gone');
    let awaitResumeCalls = 0;
    const originalAwaitResume = gate.awaitResume.bind(gate);
    gate.awaitResume = () => {
      awaitResumeCalls++;
      return originalAwaitResume();
    };

    const result = await executeLoop({
      generate: async () => textResponse('unreachable'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      signal: controller.signal,
      steering: gate,
    });

    expect(result.finishReason).toBe('aborted');
    expect(awaitResumeCalls).toBe(0);
  });

  it('a steering command admitted mid-step applies at step N+1 entry, never mid-step N', async () => {
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, route: 'r1' });
    const observedRoutes: Array<string | undefined> = [];
    let calls = 0;

    const result = await executeLoop({
      generate: async (context) => {
        observedRoutes.push(context.steering?.route);
        calls++;
        if (calls === 1) {
          // Simulate a SteeringCommand admitted while step 0's `deps.generate`
          // call is in flight (run-step.ts:612-617 in the decision record's
          // terms) — it must not be visible to this same step's context.
          gate.setDesiredState({ paused: false, configVersion: 2, route: 'r2' });
          return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        return textResponse('done');
      },
      toolbox: createTestToolbox([nextTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
    });

    expect(observedRoutes).toEqual(['r1', 'r2']);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('a steering command admitted during tool execution applies at step N+1 entry, never mid-step N', async () => {
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, route: 'r1' });
    const observedRoutes: Array<string | undefined> = [];

    const toolThatSteers = createTool({
      name: 'next',
      description: 'continue to another step',
      input: z.object({}),
      execute: async () => {
        // Simulate a SteeringCommand admitted during tool execution
        // (run-step.ts:814-1097 in the decision record's terms) — it must
        // not be visible to the step already in flight, only to the next
        // step's boundary read.
        gate.setDesiredState({ paused: false, configVersion: 2, route: 'r2' });
        return 'ok';
      },
    });

    let calls = 0;
    const result = await executeLoop({
      generate: async (context) => {
        observedRoutes.push(context.steering?.route);
        calls++;
        if (calls === 1) {
          return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        return textResponse('done');
      },
      toolbox: createTestToolbox([toolThatSteers]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
    });

    expect(observedRoutes).toEqual(['r1', 'r2']);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('AB-67: steering desired state survives a beforeGenerate hook that returns a replacement context', async () => {
    const gate = createTestSteeringGate({ paused: false, configVersion: 3, model: 'real-model' });
    const hooks = new HookRegistry<OperativeHookMap>();
    let capturedBeforeGenSteering: GenerateContext['steering'];
    let capturedGenerateSteering: GenerateContext['steering'];
    let capturedMaximumTokens: number | undefined;

    hooks.on('beforeGenerate', async (context) => {
      capturedBeforeGenSteering = context.steering;
      // A replacement context that omits `steering` entirely — the hook
      // never claims to carry it forward, and shouldn't need to.
      return {
        conversation: context.conversation,
        step: context.step,
        toolbox: context.toolbox,
        maximumTokens: 999,
      };
    });

    await executeLoop({
      generate: async (context) => {
        capturedGenerateSteering = context.steering;
        capturedMaximumTokens = context.maximumTokens;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      steering: gate,
    });

    const expected = { paused: false, configVersion: 3, model: 'real-model' };
    expect(capturedBeforeGenSteering).toEqual(expected);
    expect(capturedGenerateSteering).toEqual(expected);
    expect(capturedMaximumTokens).toBe(999);
  });

  it('AB-67: a beforeGenerate hook cannot override the steering field even if it tries to', async () => {
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, model: 'real-model' });
    const hooks = new HookRegistry<OperativeHookMap>();
    let capturedSteering: GenerateContext['steering'];

    hooks.on('beforeGenerate', async (context) => ({
      conversation: context.conversation,
      step: context.step,
      toolbox: context.toolbox,
      steering: { paused: false, configVersion: 999, model: 'hook-injected' },
    }));

    await executeLoop({
      generate: async (context) => {
        capturedSteering = context.steering;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      steering: gate,
    });

    expect(capturedSteering).toEqual({ paused: false, configVersion: 1, model: 'real-model' });
  });

  it('AB-67: steering is re-applied between beforeGenerate handlers, not only after the last one', async () => {
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, model: 'real-model' });
    const hooks = new HookRegistry<OperativeHookMap>();
    let secondHandlerSawSteering: GenerateContext['steering'];
    let generateSawSteering: GenerateContext['steering'];

    // Priority 10 runs first and returns a replacement that omits `steering`
    // entirely — the way a hook written before AB-67 existed naturally
    // would. Priority 5 runs second: if the boundary value were only
    // reapplied once at the very end of the waterfall (not between
    // handlers), this second handler would see it missing.
    hooks.on(
      'beforeGenerate',
      async (context) => ({
        conversation: context.conversation,
        step: context.step,
        toolbox: context.toolbox,
        maximumTokens: 111,
      }),
      { priority: 10 },
    );
    hooks.on(
      'beforeGenerate',
      async (context) => {
        secondHandlerSawSteering = context.steering;
        return { ...context, maximumTokens: 222 };
      },
      { priority: 5 },
    );

    await executeLoop({
      generate: async (context) => {
        generateSawSteering = context.steering;
        expect(context.maximumTokens).toBe(222);
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      steering: gate,
    });

    const expected = { paused: false, configVersion: 1, model: 'real-model' };
    expect(secondHandlerSawSteering).toEqual(expected);
    expect(generateSawSteering).toEqual(expected);
  });
});

describe('runStep: AB-221 steering.applied dispatch', () => {
  function steeringAppliedEvents(recorder: EventDispatcher & { events: Event[] }) {
    return recorder.events.filter(
      (event): event is SteeringAppliedEvent => event instanceof SteeringAppliedEvent,
    );
  }

  it('never fires for a run with no steering dependency', async () => {
    const recorder = createEventRecorder();

    await executeLoop(
      {
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runId: 'run-1',
      },
      recorder,
    );

    expect(steeringAppliedEvents(recorder)).toHaveLength(0);
  });

  it('never fires when configVersion is 0 — the un-steered default, no command ever accepted', async () => {
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({ paused: false, configVersion: 0 });

    await executeLoop(
      {
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        runId: 'run-1',
      },
      recorder,
    );

    expect(steeringAppliedEvents(recorder)).toHaveLength(0);
  });

  it('never fires when the run has no runId to stamp appliedAtRunId with', async () => {
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, model: 'real-model' });

    await executeLoop(
      {
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        // no runId
      },
      recorder,
    );

    expect(steeringAppliedEvents(recorder)).toHaveLength(0);
  });

  it('fires once at the boundary for an already-accepted command, with sessionId and the exact SteeringEffectiveState payload', async () => {
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({
      paused: false,
      configVersion: 1,
      model: 'real-model',
    });

    await executeLoop(
      {
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        runId: 'run-1',
      },
      recorder,
    );

    const applied = steeringAppliedEvents(recorder);
    expect(applied).toHaveLength(1);
    const [event] = applied;
    if (!event) throw new Error('expected a steering.applied event');
    expect(event.sessionId).toBe('test-session');
    expect(event.effective).toEqual({
      paused: false,
      configVersion: 1,
      model: 'real-model',
      appliedAtStep: 0,
      appliedAtRunId: 'run-1',
      appliedAt: event.effective.appliedAt,
    });
    expect(new Date(event.effective.appliedAt).toISOString()).toBe(event.effective.appliedAt);
  });

  it('fires exactly once per distinct configVersion across multiple steps, never once per step', async () => {
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, route: 'r1' });
    let calls = 0;

    const result = await executeLoop(
      {
        generate: async () => {
          calls++;
          if (calls === 1) {
            return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          if (calls === 2) {
            // A second accepted command lands between step 0 and step 1.
            gate.setDesiredState({ paused: false, configVersion: 2, route: 'r2' });
            return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return textResponse('done');
        },
        toolbox: createTestToolbox([nextTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        runId: 'run-1',
      },
      recorder,
    );

    expect(result.finishReason).toBe('stop-condition');
    const applied = steeringAppliedEvents(recorder);
    expect(applied.map((event) => event.effective.configVersion)).toEqual([1, 2]);
    expect(applied.map((event) => event.effective.appliedAtStep)).toEqual([0, 2]);
  });

  it('does not re-fire on a second step for the SAME already-observed configVersion', async () => {
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({ paused: false, configVersion: 1 });
    let calls = 0;

    await executeLoop(
      {
        generate: async () => {
          calls++;
          if (calls === 1) {
            return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return textResponse('done');
        },
        toolbox: createTestToolbox([nextTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        runId: 'run-1',
      },
      recorder,
    );

    // configVersion never changed after step 0's boundary read, so step 1
    // must not re-fire for the same already-applied configVersion.
    expect(steeringAppliedEvents(recorder)).toHaveLength(1);
  });

  it('fires for a pause AND its resume — the pause boundary read is itself an application, not only the resume', async () => {
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({ paused: true, configVersion: 1 });

    const resultPromise = executeLoop(
      {
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        runId: 'run-1',
      },
      recorder,
    );

    // Let the loop reach and block on the pause gate — the pause's own
    // `steering.applied` (configVersion 1) must already have fired here,
    // before any resume, per AB-67's pause row: "applied at the boundary".
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(steeringAppliedEvents(recorder).map((event) => event.effective.configVersion)).toEqual([
      1,
    ]);

    gate.setDesiredState({ paused: false, configVersion: 2 });
    await resultPromise;

    const applied = steeringAppliedEvents(recorder);
    expect(applied.map((event) => event.effective.configVersion)).toEqual([1, 2]);
    // Both observed at step 0's boundary: the pause blocked step 0 itself,
    // not a later step.
    expect(applied.map((event) => event.effective.appliedAtStep)).toEqual([0, 0]);
  });

  it('never fires for a configVersion that was superseded before the boundary ever read it (an unobserved intermediate value)', async () => {
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({ paused: true, configVersion: 1 });

    const resultPromise = executeLoop(
      {
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        runId: 'run-1',
      },
      recorder,
    );

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A resume (cv2) immediately superseded by a re-pause (cv3) in the same
    // synchronous turn, exactly as the pre-existing "re-checks paused after
    // a resume" boundary-read test drives it — cv2 is never observed by
    // `getDesiredState()` at all, so it must never fire `steering.applied`.
    gate.setDesiredState({ paused: false, configVersion: 2 });
    gate.setDesiredState({ paused: true, configVersion: 3 });

    // More ticks than the batch above: enough for `awaitResumeOrAbort`'s own
    // internal microtask chain (its `.then()`, its `Promise.race`, its own
    // `async` return) to fully unwind and the boundary to actually call
    // `getDesiredState()` again before this test moves on — verified
    // empirically against `createTestSteeringGate`'s resolution chain, not
    // guessed.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    gate.setDesiredState({ paused: false, configVersion: 4 });
    await resultPromise;

    const applied = steeringAppliedEvents(recorder);
    expect(applied.map((event) => event.effective.configVersion)).toEqual([1, 3, 4]);
  });
});
