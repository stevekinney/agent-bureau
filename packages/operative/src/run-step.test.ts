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
import type { OperativeHookMap } from './hooks';
import { executeLoop } from './loop';
import { awaitResumeOrAbort } from './run-step';
import type { GenerateContext, GenerateResponse, SteeringGate } from './types';

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
 */
function createTestSteeringGate(
  initial: SteeringDesiredState,
): SteeringGate & { setDesiredState: (next: SteeringDesiredState) => void } {
  let desired = initial;
  let resumeWaiters: Array<() => void> = [];

  return {
    getDesiredState: () => desired,
    setDesiredState(next) {
      desired = next;
      if (!next.paused) {
        const waiters = resumeWaiters;
        resumeWaiters = [];
        for (const resolve of waiters) resolve();
      }
    },
    awaitResume: () =>
      new Promise<void>((resolve) => {
        resumeWaiters.push(resolve);
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
});
