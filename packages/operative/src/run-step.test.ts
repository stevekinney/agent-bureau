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
import { createManualRuntimeServices, HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import type { SteeringDesiredState } from './durable/types';
import {
  GenerateCompletedEvent,
  GenerateErrorEvent,
  RunErrorEvent,
  SteeringAppliedEvent,
} from './events';
import { createGuardrails } from './guardrails';
import type { OutputValidator } from './guardrails/types';
import type { OperativeHookMap } from './hooks';
import { buildStepDeps, executeLoop } from './loop';
import { awaitResumeOrAbort, type EventDispatcher, type RunState, runStep } from './run-step';
import type { GenerateContext, GenerateResponse, RunOptions, SteeringGate } from './types';

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

/**
 * AB-236 compile-only proof: `RunOptions` makes `runId` required whenever
 * `steering` is set (see `types.ts`'s `RunOptions` doc comment). This file
 * is checked under the package's main `tsconfig.json` (it lives under
 * `src/`, which the `include` covers), so the `@ts-expect-error` below
 * fails `check-types` immediately if the constraint ever regresses — the
 * same pattern `durable/steering-types.check.ts` uses for
 * `SteeringCommandFailure`. The function body below is never CALLED (only
 * `void`-referenced, at the bottom of this block, to satisfy
 * `noUnusedLocals`) — `bun test` still evaluates that module-level
 * reference when it runs this file, same as any other top-level statement,
 * but a reference is not a call: nothing inside the function body ever
 * executes, so `someSteeringGate` never needs a real runtime value and only
 * `tsc` (via `check-types`, not `bun test`) ever looks at the body's
 * `RunOptions` literals.
 */
function steeringRunOptionsCompileOnlyChecks(
  someSteeringGate: SteeringGate,
  maybeSteeringGate: SteeringGate | undefined,
): void {
  function acceptRunOptions(_options: RunOptions): void {}

  // A steering-enabled run with no `runId` must fail to type-check.
  // @ts-expect-error — `RunOptions` requires `runId` whenever `steering` is set.
  acceptRunOptions({
    generate: async () => textResponse('done'),
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    steering: someSteeringGate,
  });
  // The same shape WITH `runId` type-checks with no cast or suppression.
  acceptRunOptions({
    generate: async () => textResponse('done'),
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    steering: someSteeringGate,
    runId: 'run-1',
  });
  // A run with no `steering` at all still doesn't require `runId`.
  acceptRunOptions({
    generate: async () => textResponse('done'),
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
  });
  // A `runId`-carrying helper forwarding a `SteeringGate | undefined`-typed
  // value (not a literal presence/absence the compiler can discriminate)
  // must also type-check with no cast or runtime branch — the pairing this
  // type enforces is one-directional (an actual gate requires `runId`),
  // not "steering must be exactly present or exactly absent."
  acceptRunOptions({
    generate: async () => textResponse('done'),
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    runId: 'run-1',
    steering: maybeSteeringGate,
  });
}
void steeringRunOptionsCompileOnlyChecks;

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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
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
      runId: 'run-1',
    });

    const expected = { paused: false, configVersion: 1, model: 'real-model' };
    expect(secondHandlerSawSteering).toEqual(expected);
    expect(generateSawSteering).toEqual(expected);
  });
});

describe('runStep: AB-232 registry-level onError for manually iterated hook waterfalls', () => {
  it('routes a throwing beforeGenerate handler to the registry-level onError exactly as run() would', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'continue',
    });
    let secondHandlerRan = false;
    let generateSawMaximumTokens: number | undefined;

    hooks.on(
      'beforeGenerate',
      () => {
        throw new Error('first beforeGenerate handler failed');
      },
      { priority: 10 },
    );
    hooks.on(
      'beforeGenerate',
      async (context) => {
        secondHandlerRan = true;
        return { ...context, maximumTokens: 42 };
      },
      { priority: 5 },
    );

    const result = await executeLoop({
      generate: async (context) => {
        generateSawMaximumTokens = context.maximumTokens;
        return textResponse('done');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(secondHandlerRan).toBe(true);
    expect(generateSawMaximumTokens).toBe(42);
    expect(result.finishReason).not.toBe('error');
  });

  it('routes a throwing afterGenerate handler to the registry-level onError exactly as run() would', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'continue',
    });
    let secondHandlerRan = false;

    hooks.on(
      'afterGenerate',
      () => {
        throw new Error('first afterGenerate handler failed');
      },
      { priority: 10 },
    );
    hooks.on(
      'afterGenerate',
      async (context) => {
        secondHandlerRan = true;
        return { ...context.response, content: 'rewritten by second handler' };
      },
      { priority: 5 },
    );

    const result = await executeLoop({
      generate: async () => textResponse('original'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(secondHandlerRan).toBe(true);
    expect(result.content).toBe('rewritten by second handler');
  });

  it('re-throws when the registry-level onError decides abort, matching run()', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'abort',
    });
    let secondHandlerRan = false;

    hooks.on(
      'beforeGenerate',
      () => {
        throw new Error('critical beforeGenerate failure');
      },
      { priority: 10 },
    );
    hooks.on(
      'beforeGenerate',
      async (context) => {
        secondHandlerRan = true;
        return context;
      },
      { priority: 5 },
    );

    const result = await executeLoop({
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(secondHandlerRan).toBe(false);
    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('critical beforeGenerate failure');
  });

  it('propagates the error unchanged when no onError is configured at any level, matching run()', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterGenerate', () => {
      throw new Error('unhandled afterGenerate failure');
    });

    const result = await executeLoop({
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toBe('unhandled afterGenerate failure');
  });

  it("a handler's own per-registration onError still overrides the registry-level fallback", async () => {
    const hooks = new HookRegistry<OperativeHookMap>({
      onError: () => 'continue',
    });
    let secondHandlerRan = false;

    hooks.on(
      'beforeGenerate',
      () => {
        throw new Error('per-handler abort wins');
      },
      { priority: 10, onError: () => 'abort' },
    );
    hooks.on(
      'beforeGenerate',
      async (context) => {
        secondHandlerRan = true;
        return context;
      },
      { priority: 5 },
    );

    const result = await executeLoop({
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(secondHandlerRan).toBe(false);
    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toBe('per-handler abort wins');
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
    // AB-236 makes a steering-enabled `RunOptions` literal with no `runId`
    // a compile error (see `types.ts`'s `RunOptions` doc comment) — a real
    // caller can no longer construct this through `executeLoop`/
    // `createActiveRun`. `runStep`'s own `deps.runId !== undefined` guard
    // (see its "declared, tested gap" comment) stays as defense in depth
    // regardless, since `StepDeps` itself does not carry the same
    // type-level pairing — this drives `runStep` directly against a
    // `StepDeps` built from a valid, type-checked `RunOptions` and then
    // stripped of `runId`, the only way left to reach this shape.
    const recorder = createEventRecorder();
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, model: 'real-model' });
    const deps = {
      ...buildStepDeps({
        generate: async () => textResponse('done'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        steering: gate,
        runId: 'run-1',
      }),
      runId: undefined,
    };
    const runState: RunState = {
      steps: [],
      totalUsage: { prompt: 0, completion: 0, total: 0 },
      lastContent: '',
      schemaAttempts: 0,
      lastAppliedConfigVersion: 0,
    };

    await runStep(deps, runState, new Conversation(), 0, recorder);

    expect(steeringAppliedEvents(recorder)).toHaveLength(0);
  });

  it('does not advance lastAppliedConfigVersion when there is no emitter to dispatch to', async () => {
    // Regression: `runStep` used to advance `runState.lastAppliedConfigVersion`
    // unconditionally (guarded only by `deps.runId !== undefined`), then
    // dispatch through `emitter?.dispatch(...)`. With no `emitter` at all,
    // that silently "consumed" the configVersion in `RunState` — no event
    // was ever observed, but a later step (or, durably, a resumed run) that
    // DOES have an emitter would then see `configVersion` already marked
    // applied and never fire `steering.applied` for it either. Call
    // `runStep` directly (not through `executeLoop`) so `runState` stays a
    // handle this test owns and can inspect after the call.
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, model: 'real-model' });
    const deps = buildStepDeps({
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
      runId: 'run-1',
    });
    const runState: RunState = {
      steps: [],
      totalUsage: { prompt: 0, completion: 0, total: 0 },
      lastContent: '',
      schemaAttempts: 0,
      lastAppliedConfigVersion: 0,
    };

    await runStep(deps, runState, new Conversation(), 0, undefined);

    expect(runState.lastAppliedConfigVersion).toBe(0);
  });

  it("does not re-fire steering.applied for a configVersion BELOW the run's own seeded lastAppliedConfigVersion (PR #430 review, Codex P2, second wave — 'Do not seed a run above its visible steering version')", async () => {
    // A brand-new run's `lastAppliedConfigVersion` is seeded from the
    // gate's SESSION-WIDE `getAppliedFloor()` (see `executeLoop`), which
    // can already exceed this particular run's own VISIBLE configVersion —
    // e.g. a pause bound to a different, earlier run raised the floor past
    // an identity-only baseline this run actually starts at. The dedupe
    // check must compare `>`, not merely `!==`, or a state genuinely BELOW
    // the seed re-fires as if it were new.
    const recorder = createEventRecorder();
    // Seeded floor (2) is ABOVE this run's own visible configVersion (1) —
    // exactly the cross-run scenario above.
    const gate = createTestSteeringGate({ paused: false, configVersion: 1, model: 'real-model' });
    const deps = buildStepDeps({
      generate: async () => textResponse('done'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      steering: gate,
      runId: 'run-2',
    });
    const runState: RunState = {
      steps: [],
      totalUsage: { prompt: 0, completion: 0, total: 0 },
      lastContent: '',
      schemaAttempts: 0,
      lastAppliedConfigVersion: 2,
    };

    await runStep(deps, runState, new Conversation(), 0, recorder);

    expect(steeringAppliedEvents(recorder)).toHaveLength(0);
    expect(runState.lastAppliedConfigVersion).toBe(2);
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

describe('runStep/executeLoop: AB-92/AB-252 RuntimeServices migration boundary', () => {
  it('generate-duration timing reads the injected runtime.monotonic clock, not a real elapsed-time measurement', async () => {
    const runtime = createManualRuntimeServices();
    const recorder = createEventRecorder();

    await executeLoop(
      {
        generate: async () => {
          // Advances the SAME runtime instance `deps.runtime` reads from —
          // a real-clock implementation would report near-zero here since
          // no real time elapses inside this synchronous test.
          await runtime.advance(750);
          throw new Error('generate failed');
        },
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        runtime,
      },
      recorder,
    );

    const errorEvent = recorder.events.find(
      (event): event is GenerateErrorEvent => event instanceof GenerateErrorEvent,
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.durationMilliseconds).toBe(750);
  });

  it('retry backoff waits on the injected runtime.timers, never a real timer — the retry never proceeds until advance() fires it', async () => {
    const runtime = createManualRuntimeServices();
    let attempts = 0;

    const resultPromise = executeLoop({
      generate: async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient');
        return textResponse('recovered');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runtime,
      retry: { attempts: 2, delay: 300, jitter: false },
    });

    // The retry's backoff timer is registered on `runtime` (the same
    // instance passed above) — poll on the microtask queue (never a real
    // timer) until it appears armed.
    while (runtime.pendingTimers().length === 0) {
      await Promise.resolve();
    }
    expect(attempts).toBe(1);

    await runtime.advance(300);
    const result = await resultPromise;

    expect(attempts).toBe(2);
    expect(result.finishReason).not.toBe('error');
    expect(result.content).toBe('recovered');
  });
});

describe('runStep: AB-302 generate.completed carries post-guardrail content', () => {
  const secret = 'sk-real-secret-do-not-leak-1234567890';
  const redactedText = '[redacted]';

  /** Flags any response containing `secret` and offers `redactedText` as the substitute. */
  const secretValidator: OutputValidator = {
    name: 'secret-detector',
    validate: async (output) => ({
      valid: !output.includes(secret),
      category: 'secret',
      confidence: 1,
      redacted: redactedText,
    }),
  };

  it('the built-in output guardrail (deps.validateResponseHooks) redacts before generate.completed dispatches, never the raw content', async () => {
    const recorder = createEventRecorder();
    const guardrails = createGuardrails({
      output: { validators: [secretValidator], action: 'redact' },
    });

    const result = await executeLoop(
      {
        generate: async () => textResponse(`Contact us at ${secret} for help.`),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        validateResponse: guardrails.validateResponse,
      },
      recorder,
    );

    const generateCompleted = recorder.events.find(
      (event): event is GenerateCompletedEvent => event instanceof GenerateCompletedEvent,
    );
    expect(generateCompleted).toBeDefined();
    expect(generateCompleted?.response.content).toBe(redactedText);
    expect(generateCompleted?.response.content).not.toContain(secret);
    expect(result.content).toBe(redactedText);
  });

  it('a user-registered validateResponse hook also redacts before generate.completed dispatches', async () => {
    const recorder = createEventRecorder();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (response) =>
      response.content.includes(secret) ? { content: redactedText, toolCalls: [] } : undefined,
    );

    const result = await executeLoop(
      {
        generate: async () => textResponse(`Contact us at ${secret} for help.`),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      },
      recorder,
    );

    const generateCompleted = recorder.events.find(
      (event): event is GenerateCompletedEvent => event instanceof GenerateCompletedEvent,
    );
    expect(generateCompleted).toBeDefined();
    expect(generateCompleted?.response.content).toBe(redactedText);
    expect(generateCompleted?.response.content).not.toContain(secret);
    expect(result.content).toBe(redactedText);
  });

  it('a step whose generation is entirely short-circuited by prepareStep never dispatches generate.completed', async () => {
    const recorder = createEventRecorder();

    await executeLoop(
      {
        generate: async () => textResponse('should never run'),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        prepareStep: async () => textResponse('short-circuited'),
      },
      recorder,
    );

    const generateCompleted = recorder.events.find(
      (event): event is GenerateCompletedEvent => event instanceof GenerateCompletedEvent,
    );
    expect(generateCompleted).toBeUndefined();
  });

  it('a tripwire guardrail hard-halts the step before generate.completed would ever dispatch — no leaked event, no leaked span-bearing state', async () => {
    const recorder = createEventRecorder();
    const guardrails = createGuardrails({
      output: { validators: [secretValidator] },
      mode: 'tripwire',
    });

    const result = await executeLoop(
      {
        generate: async () => textResponse(`Contact us at ${secret} for help.`),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        validateResponse: guardrails.validateResponse,
      },
      recorder,
    );

    expect(result.finishReason).toBe('tripwire');
    const generateCompleted = recorder.events.find(
      (event): event is GenerateCompletedEvent => event instanceof GenerateCompletedEvent,
    );
    expect(generateCompleted).toBeUndefined();
    const runError = recorder.events.find(
      (event): event is RunErrorEvent => event instanceof RunErrorEvent,
    );
    expect(runError).toBeDefined();
    expect(runError?.error.kind).toBe('policy');
  });
});
