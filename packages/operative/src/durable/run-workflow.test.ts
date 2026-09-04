import type { WorkflowServicesResolution, WorkflowServicesResolverInfo } from '@lostgradient/weft';
import { Engine } from '@lostgradient/weft';
import { MemoryStorage, type Storage, textValueStore } from '@lostgradient/weft/storage';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { HookRegistry } from 'lifecycle';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import { GuardrailTripwireError } from '../errors';
import { SteeringAppliedEvent } from '../events';
import type { OperativeHookMap } from '../hooks';
import type { EventDispatcher } from '../run-step';
import type { GenerateContext, GenerateFunction, SteeringGate } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import { createCheckpointStore } from './checkpoint-store';
import {
  createRunWorkflow,
  isAgentRunWorkflowInput,
  normalizeAgentRunWorkflowResult,
} from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

type RegistryToolbox = DurableRunDeps['toolbox'];
type ServicesResolver = (
  info: WorkflowServicesResolverInfo,
) => WorkflowServicesResolution | Promise<WorkflowServicesResolution>;

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** A toolbox with one no-op `next` tool that lets a run take multiple steps. */
function continuingToolbox(): RegistryToolbox {
  return createToolbox([nextTool]);
}

/**
 * AB-296 — a controllable clock for `Engine.create({ getNow })`. Threading a
 * frozen/manually-advanced clock into Weft's durable-timer deadline check
 * (`processSleepOperation`'s `scheduledFireAt <= getNow()`) removes the
 * ordering dependency a real, short `ctx.sleep` has on wall-clock scheduling:
 * on a cold-started engine (the first `Engine.create` in an isolated `bun
 * test -t` run), just REACHING the `ctx.sleep` call can take longer than the
 * sleep's own short duration, making the deadline already-passed and racing
 * or entirely skipping the "genuinely parked" observation the test relies on.
 * A frozen clock never reaches the deadline on its own; the test advances it
 * explicitly and fires one `engine.runMaintenance(now)` scheduler tick
 * instead of relying on a real background poller.
 */
function createManualClock(startTime = 0) {
  let now = startTime;
  return {
    getNow: () => now,
    /** Advances the clock and returns the new value, for `runMaintenance(now)`. */
    advance: (milliseconds: number) => {
      now += milliseconds;
      return now;
    },
  };
}
type ManualClock = ReturnType<typeof createManualClock>;

/**
 * AB-296 — wraps a {@link CheckpointStore} so a test can `await` the exact
 * moment a given run's Nth step commits, instead of polling
 * `handle.snapshot()` a fixed number of times. `run-workflow.ts` calls
 * `saveCursor` exactly once per completed step, immediately before it checks
 * `pendingWakeup`/`pendingHumanWait` and (maybe) parks — so the Nth
 * `saveCursor` call for a runId is the precise, event-driven settle point
 * "step N-1 has durably committed," with no dependency on how many event-loop
 * turns that took.
 *
 * Wraps at the `CheckpointStore` level — not the `saveCursor` weft activity —
 * because `createRunWorkflow` builds its OWN activities internally from the
 * `CheckpointStore` it is given (`storage.saveCursor` in its `.activities({})`
 * call); a wrapped activity handed only to `Engine.create`'s top-level
 * `activities` map is never the one the workflow actually invokes.
 */
function createCursorSaveSignal(checkpointStore: CheckpointStore) {
  const counts = new Map<string, number>();
  // Each runId keeps its own list of independently-targeted waiters — a
  // waiter registered for target=1 must resolve at count 1 even if a LATER
  // waiter for the same runId asks for target=3; coalescing every waiter for
  // a runId onto one shared `target` (the earlier design) would have forced
  // the target=1 waiter to wait until count 3 as well.
  const waiters = new Map<string, Array<{ target: number; resolve: () => void }>>();
  const wrapped: CheckpointStore = {
    ...checkpointStore,
    saveCursor: async (runId, cursor) => {
      await checkpointStore.saveCursor(runId, cursor);
      const next = (counts.get(runId) ?? 0) + 1;
      counts.set(runId, next);
      const pending = waiters.get(runId);
      if (pending === undefined) return;
      const [ready, stillWaiting] = [
        pending.filter((waiter) => next >= waiter.target),
        pending.filter((waiter) => next < waiter.target),
      ];
      if (stillWaiting.length === 0) {
        waiters.delete(runId);
      } else {
        waiters.set(runId, stillWaiting);
      }
      for (const waiter of ready) waiter.resolve();
    },
  };
  const waitForCursorSave = (runId: string, target = 1): Promise<void> => {
    if ((counts.get(runId) ?? 0) >= target) return Promise.resolve();
    return new Promise((resolve) => {
      const existing = waiters.get(runId) ?? [];
      existing.push({ target, resolve });
      waiters.set(runId, existing);
    });
  };
  return { checkpointStore: wrapped, waitForCursorSave };
}

/**
 * Build an engine + checkpoint store over a given backend. Pass
 * `resolveWorkflowServices` to re-provide a recovered run's services on a fresh
 * engine (the cross-process recovery path). Pass `clock` (AB-296) to drive the
 * engine's `getNow` from a {@link createManualClock} instance instead of the
 * real wall clock. Returns `waitForCursorSave` ({@link createCursorSaveSignal})
 * alongside `engine`/`checkpointStore` for tests that need to observe a
 * step's commit without polling.
 */
async function buildEngine(
  storage: Storage,
  recover: boolean,
  resolveWorkflowServices?: ServicesResolver,
  version?: string,
  clock?: ManualClock,
) {
  const rawCheckpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { checkpointStore, waitForCursorSave } = createCursorSaveSignal(rawCheckpointStore);
  const runWorkflow = createRunWorkflow(checkpointStore, { version });
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover,
    ...(clock ? { getNow: clock.getNow } : {}),
    ...(resolveWorkflowServices ? { resolveWorkflowServices } : {}),
    workflows: { agentRun: runWorkflow },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  return { engine, checkpointStore, waitForCursorSave };
}

/**
 * Same as {@link buildEngine}, but with Weft's own background timer poller
 * started (`startScheduler: true`) and sped up (`schedulerPollIntervalMs`) so
 * a short-duration `ctx.sleep` in a AB-45 wakeup test actually fires within
 * the test's timeout, rather than sitting un-polled forever — `buildEngine`
 * itself leaves the scheduler off by default (`shouldStartEngineScheduler`
 * only auto-starts it when `recover !== false`, which every crash-simulation
 * test in this file relies on to keep a "hung" run genuinely parked with no
 * background activity).
 *
 * AB-296: pass `clock` (a {@link createManualClock} instance) to drive the
 * durable timer from a manual clock instead — this switches the engine to
 * `backgroundTasks: 'manual'` (no real poller at all) and the caller fires
 * due timers explicitly via `engine.runMaintenance`. Omitting `clock`
 * preserves the original real-poller behavior for every other call site in
 * this file. Returns `waitForCursorSave` alongside `engine`/`checkpointStore`,
 * same as {@link buildEngine}.
 */
async function buildWakeupEngine(
  storage: Storage,
  recover: boolean,
  resolveWorkflowServices?: ServicesResolver,
  clock?: ManualClock,
) {
  const rawCheckpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { checkpointStore, waitForCursorSave } = createCursorSaveSignal(rawCheckpointStore);
  const runWorkflow = createRunWorkflow(checkpointStore, {});
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover,
    ...(clock
      ? { getNow: clock.getNow, backgroundTasks: 'manual' as const }
      : { startScheduler: true, schedulerPollIntervalMs: 10 }),
    ...(resolveWorkflowServices ? { resolveWorkflowServices } : {}),
    workflows: { agentRun: runWorkflow },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  return { engine, checkpointStore, waitForCursorSave };
}

/**
 * Build the per-run {@link DurableRunDeps} the workflow reads as `ctx.services`.
 * One shared toolbox instance backs both `toolbox` and `options.toolbox` (the
 * memo overrides `options.toolbox` with the top-level one anyway).
 */
function makeServices(generate: GenerateFunction): DurableRunDeps {
  const toolbox = continuingToolbox();
  return {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      // The durable driver inherits executeLoop's stop semantics: a run halts
      // only when a configured stopWhen fires. `noToolCalls` is the standard
      // "agent settled" condition a real caller supplies.
      stopWhen: noToolCalls(),
    },
  };
}

/**
 * Same as {@link makeServices} but with an `afterToolExecution` hook wired in
 * (seam #11 — hook replay policy). The hook is `replay: 'effectful'`: it
 * performs an external side effect (`onEffect`) that a real hook would need to
 * be idempotent for, exactly like `createMemoryPersistHook`.
 */
function makeServicesWithEffectfulHook(
  generate: GenerateFunction,
  onEffect: () => void,
): DurableRunDeps {
  const toolbox = continuingToolbox();
  const hooks = new HookRegistry<OperativeHookMap>();
  hooks.on(
    'afterToolExecution',
    async () => {
      onEffect();
    },
    { replay: 'effectful' },
  );
  return {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
      hooks,
    },
  };
}

/** Start a run and await its result, keeping the handle off the await chain. */
async function runToCompletion(
  engine: Awaited<ReturnType<typeof buildEngine>>['engine'],
  input: {
    runId: string;
    sessionId?: string;
    agentName?: string;
    prompt?: string;
    maximumSteps?: number;
  },
  services: DurableRunDeps,
) {
  const handle = await engine.start(
    'agentRun',
    {
      ...input,
      sessionId: input.sessionId ?? input.runId,
      // F2: agentName in durable workflow input — defaults to '' in tests
      // where no specific agent name is relevant.
      agentName: input.agentName ?? '',
    },
    { id: input.runId, services },
  );
  return handle.result();
}

// Drain Weft's deferred inline-launch queue between tests. A pending setTimeout(0)
// inline-launch macrotask left by one durable run can be starved under full
// `bun test` concurrency (CI), making a later run that normally finishes in ~100ms
// blow past the 5s timeout. 0.3.0's drain-on-dispose only fires when an engine is
// disposed; it does NOT replace this BETWEEN-TEST flush, so the drain is restored.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('durable agentRun workflow', () => {
  it('treats malformed checkpoint JSON as absent data', async () => {
    const checkpointStore = createCheckpointStore({
      get: async () => '{',
      has: async () => true,
      set: async () => {},
      list: async () => [],
      delete: async () => {},
      deletePrefix: async () => 0,
      close: async () => {},
    });

    expect(await checkpointStore.loadCursor('bad-json')).toBeNull();
  });

  it('validates durable workflow input at the trust boundary', () => {
    expect(isAgentRunWorkflowInput(null)).toBe(false);
    expect(isAgentRunWorkflowInput({})).toBe(false);
    // F2: agentName is now required alongside runId and sessionId. A run
    // checkpointed before F2 (without agentName) fails this guard and is treated
    // as not-reconstructable — no compatibility-bridge fallback (cross-upgrade
    // in-flight runs are explicitly out of scope per architecture.md).
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session' })).toBe(false);
    expect(
      isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', agentName: 'researcher' }),
    ).toBe(true);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        prompt: 'Hello',
      }),
    ).toBe(true);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        prompt: 1,
      }),
    ).toBe(false);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        maximumSteps: 2,
      }),
    ).toBe(true);
    expect(
      isAgentRunWorkflowInput({
        runId: 'run',
        sessionId: 'session',
        agentName: 'researcher',
        maximumSteps: '2',
      }),
    ).toBe(false);
    expect(isAgentRunWorkflowInput({ runId: 'run', sessionId: 'session', agentName: 42 })).toBe(
      false,
    );
  });

  it('runs a single-step agent to completion when generate emits no tool calls', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);
    let calls = 0;
    const services = makeServices(async () => {
      calls++;
      return { content: 'done', toolCalls: [] };
    });

    try {
      const handle = await engine.start(
        'agentRun',
        { runId: 'run-1', sessionId: 'run-1', agentName: '', prompt: 'Hi' },
        { id: 'run-1', services },
      );
      const result = await handle.result();

      expect(result.finishReason).toBe('stop-condition');
      expect(result.steps).toBe(1);
      expect(result.content).toBe('done');
      expect(calls).toBe(1);

      const checkpoint = await checkpointStore.loadCheckpoint('run-1');
      expect(checkpoint.cursor.step).toBe(1);
      expect(checkpoint.steps).toHaveLength(1);
      expect(checkpoint.conversation).not.toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('takes multiple steps while generate keeps emitting tool calls', async () => {
    const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);
    const services = makeServices(async ({ step }) => {
      if (step < 3) {
        return { content: `step ${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
      }
      return { content: 'final', toolCalls: [] };
    });

    try {
      const result = await runToCompletion(engine, { runId: 'run-multi', prompt: 'Go' }, services);

      expect(result.steps).toBe(4); // steps 0,1,2 with tools + step 3 final
      expect(result.finishReason).toBe('stop-condition');

      const checkpoint = await checkpointStore.loadCheckpoint('run-multi');
      expect(checkpoint.steps).toHaveLength(4);
      // The transcript carries the assistant turns and tool results.
      const conversation = Conversation.from(checkpoint.conversation!);
      expect(conversation.getMessages().length).toBeGreaterThan(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  // AB-10 — workflow versioning: `createRunWorkflow`'s `version` option stamps
  // `RunCursor.workflowVersion` at creation and it survives every subsequent
  // cursor update (the multi-step case exercises the `cursor = { ...cursor, ... }`
  // rebuild at each step, which must NOT drop the stamp).
  describe('workflow version stamping', () => {
    it('stamps the configured version into the cursor for a brand-new run', async () => {
      const { engine, checkpointStore } = await buildEngine(
        new MemoryStorage(),
        false,
        undefined,
        '1.2.3',
      );
      const services = makeServices(async () => ({ content: 'done', toolCalls: [] }));

      try {
        await runToCompletion(engine, { runId: 'run-versioned', prompt: 'Hi' }, services);
        const cursor = await checkpointStore.loadCursor('run-versioned');
        expect(cursor?.workflowVersion).toBe('1.2.3');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('carries the stamped version unchanged across every step of a multi-step run', async () => {
      const { engine, checkpointStore } = await buildEngine(
        new MemoryStorage(),
        false,
        undefined,
        '2.0.0',
      );
      const services = makeServices(async ({ step }) => {
        if (step < 3) {
          return { content: `step ${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
        }
        return { content: 'final', toolCalls: [] };
      });

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'run-versioned-multi', prompt: 'Go' },
          services,
        );
        expect(result.steps).toBe(4);
        const cursor = await checkpointStore.loadCursor('run-versioned-multi');
        expect(cursor?.workflowVersion).toBe('2.0.0');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('leaves workflowVersion unset when the engine has no configured version', async () => {
      const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);
      const services = makeServices(async () => ({ content: 'done', toolCalls: [] }));

      try {
        await runToCompletion(engine, { runId: 'run-unversioned', prompt: 'Hi' }, services);
        const cursor = await checkpointStore.loadCursor('run-unversioned');
        expect(cursor?.workflowVersion).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('stops at maximumSteps when the agent never settles', async () => {
    const { engine } = await buildEngine(new MemoryStorage(), false);
    const services = makeServices(async ({ step }) => ({
      content: `step ${step}`,
      toolCalls: [{ name: 'next', arguments: {} }],
    }));

    try {
      const result = await runToCompletion(
        engine,
        {
          runId: 'run-cap',
          prompt: 'Loop',
          maximumSteps: 3,
        },
        services,
      );
      expect(result.steps).toBe(3);
      expect(result.finishReason).toBe('maximum-steps');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('serializes non-Error terminal failures across the durable workflow boundary', async () => {
    const stringRun = await buildEngine(new MemoryStorage(), false);
    try {
      const stringResult = await runToCompletion(
        stringRun.engine,
        { runId: 'run-string-error', prompt: 'Go' },
        makeServices(async () => {
          // This regression intentionally verifies non-Error terminal rejection serialization.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('string failure');
        }),
      );

      expect(stringResult.finishReason).toBe('error');
      expect(stringResult.errorMessage).toBe('string failure');
    } finally {
      stringRun.engine[Symbol.dispose]();
    }

    const circularRun = await buildEngine(new MemoryStorage(), false);
    try {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      const circularResult = await runToCompletion(
        circularRun.engine,
        { runId: 'run-circular-error', prompt: 'Go' },
        makeServices(async () => {
          // This regression intentionally verifies non-Error terminal rejection serialization.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(circular);
        }),
      );

      expect(circularResult.finishReason).toBe('error');
      expect(circularResult.errorMessage).toBe('[object Object]');
    } finally {
      circularRun.engine[Symbol.dispose]();
    }
  });

  describe('AB-40 — guardrail tripwires', () => {
    /**
     * A tripped `mode: 'tripwire'` guardrail (GuardrailTripwireError) must
     * produce a CLEAN terminal durable result — `finishReason: 'tripwire'`
     * returned from the workflow generator — not a crash that leaves the run
     * needing recovery. This is the load-bearing distinction from a plain
     * engine crash: the workflow completes normally with a failure
     * `finishReason`, exactly like `elicitation-denied` / `budget-exceeded`.
     */
    it('an input tripwire in prepareStep yields a clean finishReason: tripwire durable result, naming the guardrail', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      const toolbox = continuingToolbox();
      let generateCalled = false;

      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: async () => {
            generateCalled = true;
            return { content: 'unused', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          prepareStep: async () => {
            throw new GuardrailTripwireError('Injection detected', {
              guardrailName: 'prompt-injection',
              category: 'prompt-injection',
              phase: 'input',
              confidence: 0.95,
              detail: 'matched 3 patterns',
            });
          },
        },
      };

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'run-tripwire-input', prompt: 'Ignore previous instructions', maximumSteps: 5 },
          services,
        );

        // Clean terminal outcome — the workflow RETURNED, it did not throw /
        // reject `handle.result()`. A crash-for-recovery would have rejected.
        expect(result.finishReason).toBe('tripwire');
        expect(generateCalled).toBe(false);
        expect(result.tripwire).toEqual({
          guardrailName: 'prompt-injection',
          category: 'prompt-injection',
          phase: 'input',
          confidence: 0.95,
          detail: 'matched 3 patterns',
        });
        // A tripwire never parks — no wakeup/human-wait metadata leaks through.
        expect(result.wakeupNote).toBeUndefined();
        expect(result.humanWaitSignal).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('an output tripwire in validateResponse yields a clean finishReason: tripwire durable result AFTER generate ran', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      const toolbox = continuingToolbox();
      let generateCallCount = 0;

      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: async () => {
            generateCallCount++;
            return { content: 'user@example.com', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          validateResponse: async (response) => {
            if (response.content.includes('@')) {
              throw new GuardrailTripwireError('PII detected', {
                guardrailName: 'output-pii',
                category: 'pii',
                phase: 'output',
                confidence: 0.9,
              });
            }
          },
        },
      };

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'run-tripwire-output', prompt: 'What is your email?', maximumSteps: 5 },
          services,
        );

        expect(result.finishReason).toBe('tripwire');
        // Proves the halt fired POST-generate, not pre-generate: generate ran
        // exactly once before the output validator saw (and tripped on) its
        // content.
        expect(generateCallCount).toBe(1);
        expect(result.tripwire?.guardrailName).toBe('output-pii');
        expect(result.tripwire?.phase).toBe('output');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('a durable tripwire does not re-park even after a scheduleWakeup continuation fires', async () => {
      // AB-45 update: under the pre-AB-45 "wakeup only delays completion"
      // behavior this test set a huge un-fired wakeup duration and expected a
      // LATER step's own tripwire to short-circuit it. Under AB-45's
      // commit-and-park fix, `scheduleWakeup` now parks BEFORE any later
      // generation call can run — so the tripwire-triggering step can only
      // be the CONTINUATION after a genuinely fired wakeup. This test now
      // exercises exactly that: the wakeup fires (short real duration), the
      // continuation step returns PII and trips the guardrail — proving the
      // `isFailureOutcome` gate that excludes 'tripwire' from the post-loop
      // park block still holds for the continuation's own outcome (no
      // second park attempt after the tripwire).
      const { engine } = await buildWakeupEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: params.duration,
              note: 'check later',
            };
          }
          return 'scheduled';
        },
      });
      const toolbox = createToolbox([wakeupTool, nextTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const c = call++;
            if (c === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 20 } }],
              };
            }
            return { content: 'user@example.com', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          validateResponse: async (response) => {
            if (response.content.includes('@')) {
              throw new GuardrailTripwireError('PII detected', {
                guardrailName: 'output-pii',
                category: 'pii',
                phase: 'output',
                confidence: 0.9,
              });
            }
          },
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'run-tripwire-no-park', prompt: 'Go', maximumSteps: 5 },
          services,
        );

        expect(result.finishReason).toBe('tripwire');
        expect(call).toBe(2);
        // AB-45: `wakeupNote` IS reported — the wakeup genuinely fired before
        // the continuation step tripped the guardrail; this is a historical
        // fact, not a live-park indicator (see `wakeupNote`'s own JSDoc).
        expect(result.wakeupNote).toBe('check later');
        expect(result.humanWaitSignal).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('THE PROOF: cross-process resume-from-step-N via Weft recoverAll', () => {
    // The durability mechanism under test is Weft NATIVE recovery: engine A
    // suspends a workflow mid-run (a hanging generate), is disposed (a "crashed
    // process"), and engine B on the SAME backend calls `recoverAll()` to resume
    // it. Weft restarts the generator from the top and short-circuits each
    // `ctx.memo` to its checkpointed value, so every COMPLETED step's generate is
    // skipped and only the in-flight step re-runs — proving generate does not
    // re-execute from step 0 on recovery. Behavior for the remaining steps comes
    // from engine B's `resolveWorkflowServices` resolver (the bureau's role on a
    // fresh process), nothing hand-injected.

    /** Start a run but do NOT await — used when the run hangs mid-step. */
    function startRun(
      engine: Awaited<ReturnType<typeof buildEngine>>['engine'],
      input: { runId: string; sessionId?: string; agentName?: string; prompt?: string },
      services: DurableRunDeps,
    ) {
      return engine.start(
        'agentRun',
        {
          ...input,
          sessionId: input.sessionId ?? input.runId,
          agentName: input.agentName ?? '',
        },
        { id: input.runId, services },
      );
    }

    it('resumes a suspended run via the services RESOLVER, skipping completed steps (no re-run)', async () => {
      // One shared MemoryStorage instance both engines see, the way two processes
      // share a persistent backend.
      const storage = new MemoryStorage();

      // === Engine A: step 0 emits a tool call (commits), step 1's generate HANGS.
      // Disposing while suspended leaves the Weft workflow non-terminal. ===
      const aRunId = 'aaaaaaaa-0000-4000-8000-000000000001';
      const servicesA = makeServices(async ({ step }) =>
        step === 0
          ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
          : new Promise<never>(() => {}),
      );

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId: aRunId, prompt: 'Start' }, servicesA);
      void handle.result().catch(() => {}); // never settles; keep it off the chain
      // AB-330: wait for step 0's cursor commit instead of a fixed real-time sleep.
      await a.waitForCursorSave(aRunId, 1);

      const afterCrash = await a.checkpointStore.loadCheckpoint(aRunId);
      expect(afterCrash.steps).toHaveLength(1);
      expect(afterCrash.steps[0]!.content).toBe('A step 0');
      a.engine[Symbol.dispose]();

      // === FRESH PROCESS: a brand-new engine whose ONLY source of this run's
      // behavior is its `resolveWorkflowServices` resolver — proving deps come
      // from the resolver, not any in-process registry. recoverAll resumes the
      // suspended workflow, and the resolver re-provides a settling generate. ===
      const recoveredSteps: number[] = [];
      const b = await buildEngine(storage, false, async (info) => {
        expect(info.workflowId).toBe(aRunId);
        return {
          status: 'available',
          services: makeServices(async ({ step }) => {
            recoveredSteps.push(step);
            return { content: `recovered step ${step}`, toolCalls: [] };
          }),
        };
      });
      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const result = (await handles[0]!.result()) as { steps: number; finishReason: string };

        // ctx.memo short-circuited step 0 — generate ran ONLY for step 1.
        expect(recoveredSteps).toEqual([1]);
        expect(result.steps).toBe(2);
        expect(result.finishReason).toBe('stop-condition');

        // The recovered transcript carries step 0 from engine A plus step 1.
        const checkpoint = await b.checkpointStore.loadCheckpoint(aRunId);
        expect(checkpoint.steps.map((s) => s.content)).toEqual(['A step 0', 'recovered step 1']);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('fires an effectful step-level hook exactly once across a crash/recover cycle (seam #11)', async () => {
      // Whole-step memoization (`ctx.memo` in run-workflow.ts) is what keeps a
      // hook's replay policy sound WITHOUT gating on it: `runStep` — and every
      // hook it invokes — runs entirely inside the step's memo, so a checkpointed
      // step's hooks are never re-invoked on recovery; only the in-flight
      // (un-memoized) step's hooks fire again. This proves that contract for an
      // `afterToolExecution` hook marked `replay: 'effectful'`.
      const storage = new MemoryStorage();
      const runId = 'cccccccc-0000-4000-8000-000000000003';

      // A side effect shared across both "processes" — modelling an external
      // store an effectful hook writes to (e.g. `createMemoryPersistHook`).
      let effectCount = 0;

      // Step 0 emits a tool call (the hook fires — effectCount -> 1), then step 1
      // hangs mid-generate so we can "crash" before it commits.
      const servicesA = makeServicesWithEffectfulHook(
        async ({ step }) =>
          step === 0
            ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
            : new Promise<never>(() => {}),
        () => {
          effectCount += 1;
        },
      );

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId, prompt: 'Start' }, servicesA);
      void handle.result().catch(() => {});
      // AB-330: wait for step 0's cursor commit instead of a fixed real-time sleep.
      await a.waitForCursorSave(runId, 1);

      // Confirm step 0 actually COMMITTED (its ctx.memo resolved and checkpointed)
      // before "crashing" — otherwise a hook firing ahead of the checkpoint write
      // would make this assertion pass for the wrong reason (scheduling variance,
      // not the memoization contract under test).
      const afterCrash = await a.checkpointStore.loadCheckpoint(runId);
      expect(afterCrash.steps).toHaveLength(1);
      expect(effectCount).toBe(1);
      a.engine[Symbol.dispose]();

      // FRESH PROCESS: a new engine + a new HookRegistry closure, but the SAME
      // external effect target — recovery re-provides services via the resolver,
      // never any in-process registry. Step 1 is the FINAL step (no tool call),
      // so its own `afterToolExecution` never fires — isolating the assertion to
      // whether step 0's already-checkpointed hook re-fires.
      const b = await buildEngine(storage, false, async () => ({
        status: 'available',
        services: makeServicesWithEffectfulHook(
          async () => ({ content: 'recovered', toolCalls: [] }),
          () => {
            effectCount += 1;
          },
        ),
      }));
      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const result = (await handles[0]!.result()) as { steps: number; finishReason: string };

        expect(result.steps).toBe(2);
        expect(result.finishReason).toBe('stop-condition');

        // The step-0 hook did NOT re-fire on recovery — ctx.memo short-circuited
        // the whole step (generate + tools + hooks) to its checkpointed result.
        // Step 1 never called the tool, so its hook never fired either.
        expect(effectCount).toBe(1);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('fails just the unrecoverable resumed run (resolver unavailable) without bricking the engine', async () => {
      const storage = new MemoryStorage();
      const runId = 'bbbbbbbb-0000-4000-8000-000000000002';

      const servicesA = makeServices(async ({ step }) =>
        step === 0
          ? { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] }
          : new Promise<never>(() => {}),
      );

      const a = await buildEngine(storage, false);
      const handle = await startRun(a.engine, { runId, prompt: 'Start' }, servicesA);
      void handle.result().catch(() => {});
      // AB-330: wait for step 0's cursor commit instead of a fixed real-time sleep.
      await a.waitForCursorSave(runId, 1);
      a.engine[Symbol.dispose]();

      // Fresh process whose resolver reports the run's services unavailable: Weft
      // fails THIS run terminally (pre-replay) without aborting recoverAll or the
      // engine. recoverAll resolves; the run is left `failed`, not running.
      const b = await buildEngine(storage, false, () => ({
        status: 'unavailable',
        reason: 'no config for this run on the fresh process',
      }));
      try {
        // recoverAll itself must not throw — the engine survives.
        const recoveredHandles = await b.engine.recoverAll();
        expect(recoveredHandles).toBeDefined();
        await yieldToPortableEventLoop();

        // The single unresolvable run is now terminally `failed` (not left
        // `running`, which a later boot would re-attempt forever).
        const state = (await b.engine.get(runId)) as { status?: string } | null;
        expect(state?.status).toBe('failed');
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('never checkpoints a Conversation instance (raw bytes are plain JSON)', async () => {
      const storage = new MemoryStorage();
      const services = makeServices(async ({ step }) => {
        if (step < 2) return { content: `s${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
        return { content: 'final', toolCalls: [] };
      });

      const { engine } = await buildEngine(storage, false);
      try {
        await runToCompletion(engine, { runId: 'json-run', prompt: 'Hi' }, services);

        // Read the raw persisted transcript and assert it is plain JSON with no
        // function/prototype-bearing shape — i.e. no Conversation instance was
        // checkpointed. A `ConversationSnapshot` is a structuredClone-safe tree.
        const view = textValueStore(storage, { disposeUnderlyingStorage: false });
        const raw = await view.get('durable-run:json-run:transcript');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!) as Record<string, unknown>;
        expect(parsed).toHaveProperty('root');
        expect(parsed).toHaveProperty('currentPath');
        // structuredClone proves no functions/class-instances leaked into it.
        expect(() => structuredClone(parsed)).not.toThrow();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('keeps per-step checkpoint size O(1) — step records do not embed the growing transcript', async () => {
      const storage = new MemoryStorage();
      const services = makeServices(async ({ step }) => {
        if (step < 5) return { content: `s${step}`, toolCalls: [{ name: 'next', arguments: {} }] };
        return { content: 'final', toolCalls: [] };
      });

      const { engine, checkpointStore } = await buildEngine(storage, false);
      try {
        await runToCompletion(engine, { runId: 'size-run', prompt: 'Hi' }, services);

        const checkpoint = await checkpointStore.loadCheckpoint('size-run');
        const view = textValueStore(storage, { disposeUnderlyingStorage: false });

        // Each StepRecord is bounded by its own step's content/tools — it must
        // NOT embed the full conversation (which grows with step count). Assert
        // no step record carries a transcript-shaped field.
        for (let step = 0; step < checkpoint.steps.length; step++) {
          const raw = await view.get(`durable-run:size-run:step:${String(step).padStart(10, '0')}`);
          const record = JSON.parse(raw!) as Record<string, unknown>;
          expect(record).not.toHaveProperty('conversation');
          expect(record).not.toHaveProperty('root');
        }
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('Durable recovery: park requests survive crash-after-memo-commit', () => {
    /**
     * REGRESSION TEST for the pendingWakeup/pendingHumanWait recovery bug.
     *
     * Bug: `scheduleWakeup` (D6) and `requestHumanInput` (F3) mutate
     * `deps.pendingWakeup`/`deps.pendingHumanWait` inside `ctx.memo`. The memo
     * return value did NOT include those fields, so they were NOT checkpointed. On
     * crash recovery, Weft rebuilds fresh services (both fields unset), short-
     * circuits the memos (tools never re-run), and the post-loop read of
     * `ctx.services` saw `undefined` — causing the recovered run to COMPLETE
     * instead of re-parking.
     *
     * Fix: embed `deps.pendingWakeup`/`deps.pendingHumanWait` in the memo return
     * value, accumulate them into hoisted locals across steps, and use those locals
     * (not `ctx.services`) for the post-loop park. The checkpointed memo result
     * carries the park request, so recovery replays correctly.
     *
     * The crash is simulated by running engine A until the step memo commits, then
     * disposing it (mid-flight, before the post-loop `yield* ctx.waitForSignal`
     * executes). Engine B recovers via `recoverAll()` with FRESH services (no
     * in-process mutation on B's side) — exactly the real cross-process scenario.
     */
    it('re-parks via ctx.waitForSignal after crash-after-memo-commit on recovery (pendingHumanWait)', async () => {
      const storage = new MemoryStorage();

      // The run ID for this test; use a UUID-shaped string matching the pattern.
      const runId = 'cccccccc-0000-4000-8000-000000000003';
      const signalName = 'human-response';

      // Build the HITL tool + toolbox for engine A. The tool sets pendingHumanWait
      // on the deps object it closes over. Engine A's services carry the live dep ref.
      const depsA: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsA.ref) {
            depsA.ref.pendingHumanWait = {
              signalName: params.signalName,
            };
          }
          return 'parked';
        },
      });
      const hitlToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      // Engine A: maximumSteps=1 (workflow input), so after step 0 commits the loop
      // exits and the workflow reaches `yield* ctx.waitForSignal(signalName)`. We
      // poll until engine A is parked there (status 'running', step committed), then
      // dispose it — simulating a process crash while parked on the signal.
      //
      // THE CRASH WINDOW: after the step-0 memo commits (pendingHumanWait is in the
      // checkpointed result), the loop exits and the workflow parks. On recovery,
      // Weft replays the generator. With the BUG: the post-loop code reads
      // `ctx.services.pendingHumanWait` which is UNSET on B's fresh services →
      // `waitForSignal` is skipped → run completes. With the FIX: the post-loop code
      // reads the hoisted local fed from the checkpointed memo result → `waitForSignal`
      // is called → run parks again.
      const servicesA: DurableRunDeps = {
        options: {
          // Step 0: generate returns the HITL tool call. The tool sets pendingHumanWait.
          // Outcome is `next` (tool was called), so the loop continues — but maximumSteps=1
          // is passed in the workflow INPUT (not options), so the while-condition exits
          // after step 0 completes.
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'requestHumanInput', arguments: { signalName } }],
          }),
          toolbox: hitlToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: hitlToolbox,
      };
      depsA.ref = servicesA;

      const a = await buildEngine(storage, false);
      const handleA = await a.engine.start(
        'agentRun',
        // Pass maximumSteps=1 via the WORKFLOW INPUT so the loop exits after step 0.
        // maximumSteps in RunOptions (servicesA.options) is ignored by the durable
        // workflow; the durable driver reads it from AgentRunWorkflowInput instead.
        { runId, sessionId: runId, agentName: 'hitl-agent', prompt: 'start', maximumSteps: 1 },
        { id: runId, services: servicesA },
      );
      void handleA.result().catch(() => {}); // parks on waitForSignal; never settles

      // Poll until engine A is parked on ctx.waitForSignal: step 0 committed AND
      // the workflow is 'running' (parked, not yet completed).
      let parkedOnA = false;
      for (let i = 0; i < 100; i++) {
        await yieldToPortableEventLoop();
        const snap = await handleA.snapshot();
        if (snap?.status === 'running') {
          const cp = await a.checkpointStore.loadCheckpoint(runId);
          if (cp.steps.length >= 1) {
            parkedOnA = true;
            break;
          }
        }
      }
      expect(parkedOnA).toBe(true);

      // "Crash" engine A: dispose while parked on waitForSignal. This simulates
      // the crash window where the memo committed but the process died before the
      // run completed (or, equivalently, between saveCursor and waitForSignal).
      a.engine[Symbol.dispose]();

      // === FRESH PROCESS: Engine B recovers with brand-new services — the critical
      // invariant is that pendingHumanWait is NOT set on B's services (fresh deps,
      // no in-process tool mutation). Without the fix, the generator replays and the
      // post-loop code reads `ctx.services.pendingHumanWait` === undefined → skips
      // waitForSignal → run completes. With the fix, it reads the hoisted local fed
      // from the checkpointed step-0 memo result → waitForSignal → parks.
      const b = await buildEngine(storage, false, (_info) => ({
        status: 'available',
        // Fresh services: pendingHumanWait not set, generate won't be called (memos
        // short-circuit), toolbox has the hitlTool so Weft's schema resolution doesn't
        // error on replay.
        services: (() => {
          const freshToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;
          const freshServices: DurableRunDeps = {
            options: {
              generate: async () => ({ content: 'done after signal', toolCalls: [] }),
              toolbox: freshToolbox,
              conversation: createConversationHistory(),
              stopWhen: noToolCalls(),
            },
            toolbox: freshToolbox,
          };
          return freshServices;
        })(),
      }));

      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const recoveredHandle = handles[0]!;

        // Poll for the recovered workflow's status. With the FIX, it should be
        // 'running' (parked on waitForSignal). With the BUG, it should be
        // 'completed' — the run finished because waitForSignal was skipped.
        let reParked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await recoveredHandle.snapshot();
          if (snap?.status === 'running') {
            reParked = true;
            break;
          }
          // If it already completed or failed, the bug is present — break and let
          // the assertion below report it as a failure.
          if (snap?.status === 'completed' || snap?.status === 'failed') break;
        }

        // === THE KEY ASSERTION: the recovered run must be parked (still running),
        // not completed. On the UNFIXED code this assertion FAILS — the run completes
        // because pendingHumanWait is unset on the fresh services and the post-loop
        // code skips waitForSignal.
        expect(reParked).toBe(true);

        // Double-check: status is still running (not racing to complete).
        const parkSnap = await recoveredHandle.snapshot();
        expect(parkSnap?.status).toBe('running');
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    /**
     * AB-44 AC — "A signal delivered before waiter registration is consumed
     * once, and a crash before or after signal delivery does not lose or
     * duplicate the resumed model turn." Two crash windows, both against the
     * SAME engine-A/engine-B two-process pattern as the test above:
     *
     * (a) crash while STILL parked (before the signal is ever delivered) —
     *     recovery must re-establish the SAME wait, and delivering the signal
     *     to the recovered run resumes it exactly once.
     * (b) crash AFTER the signal is delivered to engine A but before the
     *     continuation step's memo commits — Weft's own signal delivery is
     *     itself a checkpointed operation, so recovery replays it from
     *     Weft's checkpoint (no re-delivery needed) and the un-memoized
     *     continuation step runs exactly once on B.
     */
    it('crash BEFORE the signal is delivered: recovery re-parks, and delivering the signal afterward resumes exactly once', async () => {
      const storage = new MemoryStorage();
      const runId = 'ab44-crash-before-signal';
      const signalName = 'human-response';

      const depsA: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsA.ref) {
            depsA.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const hitlToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      let generateCallsA = 0;
      const servicesA: DurableRunDeps = {
        options: {
          generate: async () => {
            generateCallsA++;
            return {
              content: '',
              toolCalls: [{ name: 'requestHumanInput', arguments: { signalName } }],
            };
          },
          toolbox: hitlToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: hitlToolbox,
      };
      depsA.ref = servicesA;

      const a = await buildEngine(storage, false);
      const handleA = await a.engine.start(
        'agentRun',
        { runId, sessionId: runId, agentName: 'hitl-agent', prompt: 'start', maximumSteps: 3 },
        { id: runId, services: servicesA },
      );
      void handleA.result().catch(() => {});

      let parkedOnA = false;
      for (let i = 0; i < 100; i++) {
        await yieldToPortableEventLoop();
        const snap = await handleA.snapshot();
        if (snap?.status === 'running') {
          const cp = await a.checkpointStore.loadCheckpoint(runId);
          if (cp.steps.length >= 1) {
            parkedOnA = true;
            break;
          }
        }
      }
      expect(parkedOnA).toBe(true);
      expect(generateCallsA).toBe(1);

      // Crash BEFORE any signal was ever sent.
      a.engine[Symbol.dispose]();

      let generateCallsB = 0;
      const b = await buildEngine(storage, false, (_info) => ({
        status: 'available',
        services: (() => {
          const freshToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;
          const freshServices: DurableRunDeps = {
            options: {
              generate: async () => {
                generateCallsB++;
                return { content: 'resumed after crash-before-signal', toolCalls: [] };
              },
              toolbox: freshToolbox,
              conversation: createConversationHistory(),
              stopWhen: noToolCalls(),
            },
            toolbox: freshToolbox,
          };
          return freshServices;
        })(),
      }));

      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const recoveredHandle = handles[0]!;

        let reParked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await recoveredHandle.snapshot();
          if (snap?.status === 'running') {
            reParked = true;
            break;
          }
        }
        expect(reParked).toBe(true);

        // NOW deliver the signal — the recovered run must consume it exactly
        // once and produce exactly one continuation generate call.
        await b.engine.signal(runId, signalName, { approved: true });

        const result = normalizeAgentRunWorkflowResult(await recoveredHandle.result());
        expect(result.finishReason).toBe('stop-condition');
        expect(result.content).toBe('resumed after crash-before-signal');
        expect(result.humanWaitSignal).toBe(signalName);
        // Exactly one continuation call — not lost, not duplicated.
        expect(generateCallsB).toBe(1);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('crash AFTER the signal is delivered but before the continuation step commits: recovery resumes exactly once, without redelivering the signal', async () => {
      const storage = new MemoryStorage();
      const runId = 'ab44-crash-after-signal';
      const signalName = 'human-response';

      const depsA: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsA.ref) {
            depsA.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const hitlToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      let generateCallsA = 0;
      const servicesA: DurableRunDeps = {
        options: {
          // Step 0 sets pendingHumanWait; the continuation step (step 1, after
          // the signal) never gets to COMMIT on engine A — A is disposed
          // immediately after the signal is sent, racing the continuation
          // step's own memo commit. Whether A's continuation memo committed
          // or not, B must reach exactly one continuation result.
          generate: async () => {
            generateCallsA++;
            if (generateCallsA === 1) {
              return {
                content: '',
                toolCalls: [{ name: 'requestHumanInput', arguments: { signalName } }],
              };
            }
            return { content: 'resumed on A (should not surface)', toolCalls: [] };
          },
          toolbox: hitlToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: hitlToolbox,
      };
      depsA.ref = servicesA;

      const a = await buildEngine(storage, false);
      const handleA = await a.engine.start(
        'agentRun',
        { runId, sessionId: runId, agentName: 'hitl-agent', prompt: 'start', maximumSteps: 3 },
        { id: runId, services: servicesA },
      );
      void handleA.result().catch(() => {});

      let parkedOnA = false;
      for (let i = 0; i < 100; i++) {
        await yieldToPortableEventLoop();
        const snap = await handleA.snapshot();
        if (snap?.status === 'running') {
          const cp = await a.checkpointStore.loadCheckpoint(runId);
          if (cp.steps.length >= 1) {
            parkedOnA = true;
            break;
          }
        }
      }
      expect(parkedOnA).toBe(true);

      // Deliver the signal to engine A, then crash IMMEDIATELY — racing the
      // continuation step's own commit. `signal()` resolving only means Weft
      // persisted the DELIVERY; the continuation step it releases may or may
      // not have started/committed before this dispose.
      await a.engine.signal(runId, signalName, { approved: true });
      a.engine[Symbol.dispose]();

      let generateCallsB = 0;
      const b = await buildEngine(storage, false, (_info) => ({
        status: 'available',
        services: (() => {
          const freshToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;
          const freshServices: DurableRunDeps = {
            options: {
              generate: async () => {
                generateCallsB++;
                return { content: 'resumed after crash-after-signal', toolCalls: [] };
              },
              toolbox: freshToolbox,
              conversation: createConversationHistory(),
              stopWhen: noToolCalls(),
            },
            toolbox: freshToolbox,
          };
          return freshServices;
        })(),
      }));

      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const recoveredHandle = handles[0]!;

        // No re-delivery: Weft's own persisted signal-delivery checkpoint
        // carries the resume forward. The run must reach a normal terminal
        // result — never lost (hung forever) and never duplicated (more than
        // one continuation generate call on B).
        const result = normalizeAgentRunWorkflowResult(await recoveredHandle.result());
        expect(result.finishReason).toBe('stop-condition');
        expect(result.humanWaitSignal).toBe(signalName);
        // Exactly one continuation call on B, whether or not A's own
        // continuation attempt had already committed before the crash: if A
        // committed it, B's memo short-circuits to that checkpointed result
        // (B's generate never runs); if A did not, B's un-memoized
        // continuation step runs exactly once. Either way `generateCallsB` is
        // never greater than 1, and the run reaches a genuine terminal result
        // — proving neither loss nor duplication of the resumed turn.
        expect(generateCallsB).toBeLessThanOrEqual(1);
        expect(['resumed after crash-after-signal', 'resumed on A (should not surface)']).toContain(
          result.content,
        );
      } finally {
        b.engine[Symbol.dispose]();
      }
    });

    it('re-parks via ctx.sleep after crash-after-memo-commit on recovery (pendingWakeup)', async () => {
      // Same crash scenario but for the D6 scheduleWakeup / ctx.sleep path.
      const storage = new MemoryStorage();
      const runId = 'dddddddd-0000-4000-8000-000000000004';

      // A tool that sets deps.pendingWakeup (mimics createScheduleWakeupTool).
      const depsA: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup after a duration',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsA.ref) {
            depsA.ref.pendingWakeup = {
              duration: params.duration,
              note: 'wakeup note',
            };
          }
          return 'scheduled';
        },
      });
      const wakeupToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const servicesA: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            // A very long sleep duration so the workflow stays parked indefinitely
            // in tests (the scheduler doesn't fire within a test run).
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
          }),
          toolbox: wakeupToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: wakeupToolbox,
      };
      depsA.ref = servicesA;

      const a = await buildEngine(storage, false);
      const handleA = await a.engine.start(
        'agentRun',
        { runId, sessionId: runId, agentName: 'wakeup-agent', prompt: 'start', maximumSteps: 1 },
        { id: runId, services: servicesA },
      );
      void handleA.result().catch(() => {});

      // Poll until engine A parks on ctx.sleep (step 0 committed, status=running).
      let parkedOnA = false;
      for (let i = 0; i < 100; i++) {
        await yieldToPortableEventLoop();
        const snap = await handleA.snapshot();
        if (snap?.status === 'running') {
          const cp = await a.checkpointStore.loadCheckpoint(runId);
          if (cp.steps.length >= 1) {
            parkedOnA = true;
            break;
          }
        }
      }
      expect(parkedOnA).toBe(true);

      // Simulate crash.
      a.engine[Symbol.dispose]();

      // Engine B with FRESH services (pendingWakeup NOT set).
      const b = await buildEngine(storage, false, (_info) => ({
        status: 'available',
        services: (() => {
          const freshToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;
          const freshServices: DurableRunDeps = {
            options: {
              generate: async () => ({ content: 'done', toolCalls: [] }),
              toolbox: freshToolbox,
              conversation: createConversationHistory(),
              stopWhen: noToolCalls(),
            },
            toolbox: freshToolbox,
          };
          return freshServices;
        })(),
      }));

      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const recoveredHandle = handles[0]!;

        // Poll: the recovered run should be 'running' (parked on ctx.sleep).
        // On the UNFIXED code: 'completed' (sleep was skipped because pendingWakeup
        // was unset on fresh services).
        let reParked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await recoveredHandle.snapshot();
          if (snap?.status === 'running') {
            reParked = true;
            break;
          }
          if (snap?.status === 'completed' || snap?.status === 'failed') break;
        }

        // === THE KEY ASSERTION: must be parked (sleeping), not completed. ===
        expect(reParked).toBe(true);
      } finally {
        b.engine[Symbol.dispose]();
      }
    });
  });

  describe('F3 — HITL via requestHumanInput tool (pendingHumanWait + ctx.waitForSignal)', () => {
    /**
     * Proves that setting `deps.pendingHumanWait` in a tool causes the run
     * workflow to park via `yield* ctx.waitForSignal(signalName)` IMMEDIATELY
     * after that step commits (AB-44's "commits its step and parks before
     * another generation call can run" fix — the tool call alone does not
     * satisfy `noToolCalls()`, so without the fix the loop would run another
     * generation call before ever reaching the park), and that a subsequent
     * `engine.signal(runId, signalName, payload)` CONTINUES the same run with
     * one more generation step (AB-41's decision record) seeded by the
     * deterministic `[signal:{name}] {payload}` conversation message AB-44
     * owns — never merely unparking into an immediate return.
     *
     * This tests the F3 seam: the tool writes `pendingHumanWait`, the workflow
     * reads it outside `ctx.memo`, parks until the signal arrives, and resumes
     * reasoning with the delivered payload.
     */
    it('parks via ctx.waitForSignal before another generation call runs, then resumes reasoning with the delivered payload', async () => {
      const storage = new MemoryStorage();
      const { engine, checkpointStore } = await buildEngine(storage, false);

      // A tool that sets deps.pendingHumanWait (mimics createRequestHumanInputTool).
      // Use a container object so the closure captures the reference before
      // `services` is constructed, avoiding a `prefer-const` lint violation.
      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = {
              signalName: params.signalName,
            };
          }
          return 'parked';
        },
      });

      const hitlToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      // Step counter so the generate function knows which step it is on. With
      // the fix, generate call 1 can ONLY happen as the continuation step
      // AFTER the signal is delivered — never as an immediate follow-on to
      // call 0's tool call.
      let stepCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const callIndex = stepCallCount++;
            if (callIndex === 0) {
              // First generate call: emit a hitl tool call to set pendingHumanWait.
              return {
                content: '',
                toolCalls: [
                  { name: 'requestHumanInput', arguments: { signalName: 'human-response' } },
                ],
              };
            }
            // Continuation call (after signal delivery): finish.
            return { content: 'done after human input', toolCalls: [] };
          },
          toolbox: hitlToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox: hitlToolbox,
      };
      // Capture the deps ref so the tool can set pendingHumanWait.
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          { runId: 'hitl-run', sessionId: 'hitl-run', agentName: 'hitl-agent', prompt: 'start' },
          { id: 'hitl-run', services },
        );

        // Let the workflow run the first step and reach ctx.waitForSignal.
        // Weft inline-launch is async: we need to give the queue several ticks.
        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          // The run stays 'running' while parked on waitForSignal.
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }

        expect(parked).toBe(true);
        // AB-44 — the fix: exactly one generate call happened before the
        // park. Without the fix, a second (immediate, pre-signal) generate
        // call would already have run by now.
        expect(stepCallCount).toBe(1);

        // Deliver the human signal to release the parked run.
        await engine.signal('hitl-run', 'human-response', { approved: true });

        // Wait for the run to complete. The CONTINUATION step (generate call
        // 1, seeded by the delivered payload) returns tool-call-free content,
        // so `noToolCalls()` stops it — 'stop-condition'.
        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        // The continuation step actually ran (not just the pre-park step).
        expect(stepCallCount).toBe(2);
        // F3: humanWaitSignal carries the signal name the run parked on.
        expect(result.humanWaitSignal).toBe('human-response');

        const finalSnap = await handle.snapshot();
        expect(finalSnap?.status).toBe('completed');

        // AB-44 AC — "The resumed step receives a deterministic conversation
        // representation of the original prompt, signal name, and validated
        // payload": the persisted transcript carries the synthetic user
        // message with the fixed, parseable format AB-41's decision ratifies.
        const checkpoint = await checkpointStore.loadCheckpoint('hitl-run');
        const conversation = Conversation.from(checkpoint.conversation!);
        const messages = conversation.getMessages();
        const continuationMessage = messages.find(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith('[signal:human-response]'),
        );
        expect(continuationMessage?.content).toBe('[signal:human-response] {"approved":true}');
        // The original prompt is still present, before the continuation message.
        expect(messages[0]?.content).toBe('start');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('re-parks when the continuation step itself calls requestHumanInput again', async () => {
      // AB-41's decision record: "Re-parking from within the continuation
      // step is permitted." The continuation step is an ordinary generation
      // step; if it writes a NEW pendingHumanWait, the workflow parks again
      // instead of returning.
      const storage = new MemoryStorage();
      const { engine } = await buildEngine(storage, false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const hitlToolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      let stepCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const callIndex = stepCallCount++;
            if (callIndex === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'first' } }],
              };
            }
            if (callIndex === 1) {
              // Continuation step re-requests human input under a new signal name.
              return {
                content: '',
                toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'second' } }],
              };
            }
            return { content: 'done after two rounds', toolCalls: [] };
          },
          toolbox: hitlToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox: hitlToolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 're-park-run',
            sessionId: 're-park-run',
            agentName: 'test-agent',
            prompt: 'start',
          },
          { id: 're-park-run', services },
        );

        let parkedFirst = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parkedFirst = true;
            break;
          }
        }
        expect(parkedFirst).toBe(true);
        expect(stepCallCount).toBe(1);

        await engine.signal('re-park-run', 'first', { ok: true });

        // Poll until the SECOND park (a fresh pendingHumanWait for 'second').
        let parkedSecond = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (
            snap?.status === 'running' &&
            depsContainer.ref?.pendingHumanWait?.signalName === 'second'
          ) {
            parkedSecond = true;
            break;
          }
        }
        expect(parkedSecond).toBe(true);
        expect(stepCallCount).toBe(2);

        await engine.signal('re-park-run', 'second', { ok: true });

        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        expect(stepCallCount).toBe(3);
        // The LAST signal the run parked on and was released for.
        expect(result.humanWaitSignal).toBe('second');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('a signal sent under the wrong name stays buffered — it does not unblock the run', async () => {
      // AC — "wrong signal names ... have explicit outcomes": Weft buffers each
      // signal under its own `(workflowId, signalName)` key; a signal delivered
      // under any name OTHER than the one `ctx.waitForSignal` is parked on has
      // no effect on that wait. This is inherent Weft behavior (AB-41's decision
      // record, "Signal-based operations"); this test proves this workflow does
      // not accidentally consume it or otherwise misbehave.
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            if (call++ === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'expected' } }],
              };
            }
            return { content: 'resumed', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'wrong-name-run',
            sessionId: 'wrong-name-run',
            agentName: 'test-agent',
            prompt: 'start',
          },
          { id: 'wrong-name-run', services },
        );

        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }
        expect(parked).toBe(true);

        // Deliver a signal under an UNRELATED name — must not unblock the run.
        await engine.signal('wrong-name-run', 'unrelated-name', { irrelevant: true });
        for (let i = 0; i < 10; i++) {
          await yieldToPortableEventLoop();
        }
        const stillParkedSnap = await handle.snapshot();
        expect(stillParkedSnap?.status).toBe('running');

        // The correct name still releases it.
        await engine.signal('wrong-name-run', 'expected', { approved: true });
        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        expect(result.humanWaitSignal).toBe('expected');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('renders the AB-46 denial sentinel as a "denied" continuation and lets the resumed step conclude the run', async () => {
      // AB-41's decision record: `resolveReview({ decision: 'deny' })` against a
      // human-wait review delivers `{ __abDenied: true, reason?: string }` on
      // the same signal channel; denial is NOT exempted from the continuation
      // step — the resumed generation step is expected to conclude the run.
      const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const c = call++;
            if (c === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'approval' } }],
              };
            }
            return { content: 'acknowledged the denial', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'denial-run',
            sessionId: 'denial-run',
            agentName: 'test-agent',
            prompt: 'start',
          },
          { id: 'denial-run', services },
        );

        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }
        expect(parked).toBe(true);

        await engine.signal('denial-run', 'approval', {
          __abDenied: true,
          reason: 'budget exceeded',
        });

        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        expect(result.content).toBe('acknowledged the denial');

        const checkpoint = await checkpointStore.loadCheckpoint('denial-run');
        const conversation = Conversation.from(checkpoint.conversation!);
        const continuationMessage = conversation
          .getMessages()
          .find(
            (message) =>
              message.role === 'user' &&
              message.content === '[signal:approval] denied: budget exceeded',
          );
        expect(continuationMessage).toBeDefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('a payload Weft cannot transport (e.g. bigint) rejects at signalSession rather than silently corrupting the parked run', async () => {
      // AC — "malformed payloads ... have explicit outcomes". Weft's own
      // signal delivery already enforces a transportable payload (its size-
      // check msgpack-encodes it before persisting) — a `bigint` throws
      // there, so it never reaches this workflow's body at all. That REJECT
      // *is* the explicit outcome for a transport-malformed payload: the
      // caller sees the failure immediately and the parked run is untouched
      // (still parked, no corrupted continuation committed). A payload that
      // Weft's transport DOES accept but `JSON.stringify` cannot faithfully
      // render (e.g. a circular structure) is this module's own concern —
      // covered directly, at the unit level, by
      // `continuation-input.test.ts`'s "falls back to a fixed placeholder"
      // case, which exercises `renderSignalContinuation`'s try/catch without
      // needing a real transport round trip.
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            if (call++ === 0) {
              return {
                content: '',
                toolCalls: [
                  { name: 'requestHumanInput', arguments: { signalName: 'weird-payload' } },
                ],
              };
            }
            return { content: 'resumed', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'malformed-run',
            sessionId: 'malformed-run',
            agentName: 'test-agent',
            prompt: 'start',
          },
          { id: 'malformed-run', services },
        );

        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }
        expect(parked).toBe(true);

        expect(engine.signal('malformed-run', 'weird-payload', 10n)).rejects.toThrow();

        // The parked run is untouched — still running, not corrupted, not
        // silently resumed with a bad payload.
        const stillParkedSnap = await handle.snapshot();
        expect(stillParkedSnap?.status).toBe('running');

        // The correct, transportable payload still resumes it normally.
        await engine.signal('malformed-run', 'weird-payload', { approved: true });
        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        expect(result.content).toBe('resumed');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('cancelling the run while parked on the signal ends it as aborted, not hung', async () => {
      // AC — "cancellation ... has explicit outcomes": aborting a run parked
      // on `ctx.waitForSignal` must not leave the durable workflow hanging.
      const controller = new AbortController();
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      const services: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'never-comes' } }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          signal: controller.signal,
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'cancel-while-parked-run',
            sessionId: 'cancel-while-parked-run',
            agentName: 'test-agent',
            prompt: 'start',
          },
          { id: 'cancel-while-parked-run', services },
        );

        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }
        expect(parked).toBe(true);

        // Cancel the durable workflow itself via Weft's own cancellation, the
        // ONLY mechanism this run's `requestHumanInput` park exposes (AB-41's
        // decision: "Cancellation: only by aborting the entire run").
        await handle.cancel();

        let settled = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (
            snap?.status === 'cancelled' ||
            snap?.status === 'completed' ||
            snap?.status === 'failed'
          ) {
            settled = true;
            break;
          }
        }
        expect(settled).toBe(true);
        const finalCancelSnap = await handle.snapshot();
        expect(finalCancelSnap?.status).not.toBe('running');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('when the park happened at maximumSteps - 1, resuming with no room left for a continuation step falls through to maximum-steps', async () => {
      // Edge case: `requestHumanInput` parks on the LAST allowed step. On
      // resume the outer resume loop's inner step loop condition
      // (`cursor.step < maximumSteps`) is immediately false — cursor.step is
      // already at the cap — so no continuation generation call happens. The
      // signal payload is still appended to the transcript (nothing is lost),
      // and the run falls through to the ordinary `maximum-steps` handling
      // rather than returning a stale pre-signal result.
      const { engine, checkpointStore } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([hitlTool]) as unknown as RegistryToolbox;

      let generateCalls = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            generateCalls++;
            // Every call emits the same tool call — a continuation call
            // would ALSO set pendingHumanWait again, but must never happen
            // here because maximumSteps=1 leaves no room for it.
            return {
              content: '',
              toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'cap-edge' } }],
            };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'cap-edge-run',
            sessionId: 'cap-edge-run',
            agentName: 'test-agent',
            prompt: 'start',
            // Only ONE step is allowed — the parking step itself.
            maximumSteps: 1,
          },
          { id: 'cap-edge-run', services },
        );

        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }
        expect(parked).toBe(true);
        expect(generateCalls).toBe(1);

        await engine.signal('cap-edge-run', 'cap-edge', { approved: true });

        const result = await handle.result();

        // No continuation generate call ran — the cap left no room.
        expect(generateCalls).toBe(1);
        // Falls through to the ordinary maximum-steps outcome, not a stale
        // pre-signal result (there was none here — the parking step never
        // itself reached a `stop`/`abort`/`error` outcome).
        expect(result.finishReason).toBe('maximum-steps');
        // The delivered payload is not lost: it is in the transcript.
        expect(result.humanWaitSignal).toBe('cap-edge');

        const checkpoint = await checkpointStore.loadCheckpoint('cap-edge-run');
        const conversation = Conversation.from(checkpoint.conversation!);
        const continuationMessage = conversation
          .getMessages()
          .find(
            (message) =>
              message.role === 'user' && message.content === '[signal:cap-edge] {"approved":true}',
          );
        expect(continuationMessage).toBeDefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('D6/AB-45 — self-scheduled wakeup (pendingWakeup + ctx.sleep)', () => {
    /**
     * Proves that setting `deps.pendingWakeup` in a tool causes the run
     * workflow to park via `yield* ctx.sleep(duration)` IMMEDIATELY after
     * that step commits (AB-45's "commits its step and parks before another
     * generation call can run" fix, mirroring AB-44's identical fix for
     * `requestHumanInput` — the tool call alone does not satisfy
     * `noToolCalls()`, so without the fix the loop would run another
     * generation call before ever reaching the park), and that the timer
     * firing CONTINUES the same run with one more generation step (AB-41's
     * decision record) seeded by the deterministic
     * `[wakeup] Resumed after sleeping ...` conversation message AB-45 owns —
     * never merely delaying terminal completion.
     *
     * Uses a short duration (not the huge 999_999_999 placeholder the
     * park-only tests above use) because these tests need the timer to
     * actually fire. AB-296: the "parks via ctx.sleep..." and "a late timer
     * ..." cases below drive that duration off a {@link createManualClock}
     * instance passed to `buildEngine`/`buildWakeupEngine` (via `getNow` and
     * `engine.runMaintenance`) rather than a real wall-clock wait — a real
     * short `ctx.sleep` on a cold-started engine could resolve before the
     * test ever observed the park, or race the real 10ms scheduler poller
     * under host load. The other two cases in this block still use a real
     * timer (unaffected — out of AB-296's three named targets).
     */
    it('parks via ctx.sleep before another generation call runs, then resumes reasoning after the timer fires', async () => {
      const storage = new MemoryStorage();
      const clock = createManualClock();
      const { engine, checkpointStore, waitForCursorSave } = await buildWakeupEngine(
        storage,
        false,
        undefined,
        clock,
      );

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number(), note: z.string().optional() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: params.duration,
              ...(params.note !== undefined ? { note: params.note } : {}),
            };
          }
          return 'scheduled';
        },
      });
      const wakeupToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      // Step counter so the generate function knows which step it is on. With
      // the fix, generate call 1 can ONLY happen as the continuation step
      // AFTER the timer fires — never as an immediate follow-on to call 0's
      // tool call.
      let stepCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const callIndex = stepCallCount++;
            if (callIndex === 0) {
              return {
                content: '',
                toolCalls: [
                  { name: 'scheduleWakeup', arguments: { duration: 20, note: 'check later' } },
                ],
              };
            }
            return { content: 'done after wakeup', toolCalls: [] };
          },
          toolbox: wakeupToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox: wakeupToolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'wakeup-run',
            sessionId: 'wakeup-run',
            agentName: 'wakeup-agent',
            prompt: 'start',
          },
          { id: 'wakeup-run', services },
        );

        // AB-296: an explicit, event-driven settle signal — step 0's cursor
        // commits right before the workflow evaluates pendingWakeup and
        // parks — instead of polling `handle.snapshot()` a fixed number of
        // times.
        await waitForCursorSave('wakeup-run', 1);
        const parkedSnap = await handle.snapshot();
        const parkedCheckpoint = await checkpointStore.loadCheckpoint('wakeup-run');
        expect(parkedSnap?.status).toBe('running');
        expect(parkedCheckpoint.steps).toHaveLength(1);
        // AB-45 — the fix: exactly one generate call happened before the
        // park. Without the fix, a second (immediate, pre-sleep) generate
        // call would already have run by now. This holds unconditionally
        // here — `saveCursor` for step 0 cannot commit before its own step's
        // `generate` call resolves, and step 1's `generate` cannot run before
        // the still-frozen clock lets `ctx.sleep` resolve.
        expect(stepCallCount).toBe(1);

        // AB-296: fire the 20ms timer explicitly via the manual clock instead
        // of waiting on a real background poller. One `yieldToPortableEventLoop`
        // drains the microtask chain from `saveCursor`'s settle through
        // `ctx.sleep`'s own `scheduler.schedule()` durable-storage write, so a
        // single `runMaintenance` tick finds the timer already registered.
        await yieldToPortableEventLoop();
        await engine.runMaintenance(clock.advance(20));
        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        // The continuation step actually ran (not just the pre-park step).
        expect(stepCallCount).toBe(2);
        // AB-45: wakeupNote carries the note attached to the wakeup that fired.
        expect(result.wakeupNote).toBe('check later');

        const finalSnap = await handle.snapshot();
        expect(finalSnap?.status).toBe('completed');

        // AB-45 AC — "timer release produces a deterministic continuation
        // input containing the requested duration [and] optional note": the
        // persisted transcript carries the synthetic user message with the
        // fixed, parseable format AB-41's decision ratifies.
        const checkpoint = await checkpointStore.loadCheckpoint('wakeup-run');
        const conversation = Conversation.from(checkpoint.conversation!);
        const messages = conversation.getMessages();
        const continuationMessage = messages.find(
          (message) =>
            message.role === 'user' &&
            message.content === '[wakeup] Resumed after sleeping 20ms. Note: check later',
        );
        expect(continuationMessage).toBeDefined();
        // The original prompt is still present, before the continuation message.
        expect(messages[0]?.content).toBe('start');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('re-parks when the continuation step itself calls scheduleWakeup again', async () => {
      const storage = new MemoryStorage();
      const { engine } = await buildWakeupEngine(storage, false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = { duration: params.duration };
          }
          return 'scheduled';
        },
      });
      const wakeupToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      let stepCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const callIndex = stepCallCount++;
            if (callIndex < 2) {
              // First two steps: sleep for 20ms each.
              return {
                content: '',
                toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 20 } }],
              };
            }
            return { content: 'done', toolCalls: [] };
          },
          toolbox: wakeupToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox: wakeupToolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 're-park-run',
            sessionId: 're-park-run',
            agentName: 'wakeup-agent',
            prompt: 'start',
          },
          { id: 're-park-run', services },
        );

        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        // Two wakeups fired, then the third generate call ended the run.
        expect(stepCallCount).toBe(3);
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('cancelling the run while parked on ctx.sleep ends it as aborted, not hung', async () => {
      const storage = new MemoryStorage();
      const { engine } = await buildEngine(storage, false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = { duration: params.duration };
          }
          return 'scheduled';
        },
      });
      const wakeupToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const services: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            // A very long sleep — the test cancels before it would ever fire.
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
          }),
          toolbox: wakeupToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: wakeupToolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'cancel-wakeup-run',
            sessionId: 'cancel-wakeup-run',
            agentName: 'wakeup-agent',
            prompt: 'start',
          },
          { id: 'cancel-wakeup-run', services },
        );

        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingWakeup !== undefined) {
            parked = true;
            break;
          }
        }
        expect(parked).toBe(true);

        // Cancel the durable workflow itself via Weft's own cancellation, the
        // ONLY mechanism this run's `scheduleWakeup` park exposes (AB-41's
        // decision: "Cancellation: none once parked; only `abortRun` on the
        // whole run").
        await handle.cancel();

        let settled = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (
            snap?.status === 'cancelled' ||
            snap?.status === 'completed' ||
            snap?.status === 'failed'
          ) {
            settled = true;
            break;
          }
        }
        expect(settled).toBe(true);
        const finalSnap = await handle.snapshot();
        expect(finalSnap?.status).not.toBe('running');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('a late timer (recovered after the deadline has already passed) still continues the run exactly once', async () => {
      // AB-41's decision record: "Missed-fire: not applicable; a durable
      // sleep fires as soon as the process observes its deadline has passed
      // on recovery." Crash while parked on a short sleep, then recover on a
      // fresh engine whose manual clock is already past the deadline — the
      // recovered run must observe the already-passed deadline and continue
      // exactly once, not duplicate the resumed step or hang.
      //
      // AB-296: engine A's clock is frozen (never advanced), so its ctx.sleep
      // can never resolve on its own — this removes the prior real-wall-clock
      // race where a cold-started engine A could take longer than the sleep's
      // own duration just to reach ctx.sleep, making the deadline already
      // passed and skipping the "genuinely parked" observation below. Engine
      // B's clock starts already past the 20ms deadline A scheduled, so
      // `processSleepOperation`'s own already-due check resolves the
      // recovered sleep immediately — the same "deadline already passed"
      // behavior AB-41 describes, with no real wall-clock wait needed.
      const storage = new MemoryStorage();
      const runId = 'late-wakeup-run';

      const depsA: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsA.ref) {
            depsA.ref.pendingWakeup = { duration: params.duration, note: 'late note' };
          }
          return 'scheduled';
        },
      });
      const wakeupToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      let stepCallCountA = 0;
      const servicesA: DurableRunDeps = {
        options: {
          generate: async () => {
            const callIndex = stepCallCountA++;
            if (callIndex === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 20 } }],
              };
            }
            return { content: 'unused-on-a', toolCalls: [] };
          },
          toolbox: wakeupToolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox: wakeupToolbox,
      };
      depsA.ref = servicesA;

      const clockA = createManualClock();
      const a = await buildEngine(storage, false, undefined, undefined, clockA);
      const handleA = await a.engine.start(
        'agentRun',
        { runId, sessionId: runId, agentName: 'wakeup-agent', prompt: 'start', maximumSteps: 5 },
        { id: runId, services: servicesA },
      );
      void handleA.result().catch(() => {});

      // AB-296: an explicit, event-driven settle signal instead of polling
      // `handle.snapshot()` a fixed number of times — see the identical
      // reasoning on the "parks via ctx.sleep..." test above.
      await a.waitForCursorSave(runId, 1);
      const parkedSnap = await handleA.snapshot();
      const parkedCheckpoint = await a.checkpointStore.loadCheckpoint(runId);
      expect(parkedSnap?.status).toBe('running');
      expect(parkedCheckpoint.steps).toHaveLength(1);

      // Simulate crash. AB-296: engine B's manual clock starts already past
      // the 20ms deadline A scheduled (see the note above), so recovery
      // observes the deadline as already-passed without a real wall-clock
      // wait.
      a.engine[Symbol.dispose]();

      let generateCallCountB = 0;
      const clockB = createManualClock(1_000);
      const b = await buildWakeupEngine(
        storage,
        false,
        (_info) => ({
          status: 'available',
          services: (() => {
            const freshToolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;
            const freshServices: DurableRunDeps = {
              options: {
                generate: async () => {
                  generateCallCountB++;
                  return { content: 'done-on-b', toolCalls: [] };
                },
                toolbox: freshToolbox,
                conversation: createConversationHistory(),
                stopWhen: noToolCalls(),
              },
              toolbox: freshToolbox,
            };
            return freshServices;
          })(),
        }),
        clockB,
      );

      try {
        const handles = await b.engine.recoverAll();
        expect(handles.length).toBe(1);
        const recoveredHandle = handles[0]!;

        const result = normalizeAgentRunWorkflowResult(await recoveredHandle.result());
        expect(result.finishReason).toBe('stop-condition');
        // Continues exactly once — never registers a second timer or
        // duplicates the resumed step.
        expect(generateCallCountB).toBe(1);
        expect(result.wakeupNote).toBe('late note');
      } finally {
        b.engine[Symbol.dispose]();
      }
    });
  });

  describe('Park request mutual exclusivity (PRRT_kwDORvupsc6MZ-vk)', () => {
    /**
     * REGRESSION TESTS for the "pick only one durable park request" finding.
     *
     * Bug: when a durable run accumulated BOTH `pendingWakeup` (from a
     * `scheduleWakeup` tool call in one step) AND `pendingHumanWait` (from a
     * `requestHumanInput` tool call in a later step), the post-loop park code had
     * two INDEPENDENT `if` branches — so the workflow would `ctx.sleep(duration)`
     * AND THEN `ctx.waitForSignal(signalName)` in sequence.  That violates the
     * `DurableRunDeps` contract: the two park types are mutually exclusive and only
     * the last-set one governs parking.
     *
     * Fix: the accumulation loop now clears the OTHER local whenever one is updated
     * (last-write-wins). The post-loop parking section uses `else if` as
     * defense-in-depth so the two primitives can never both execute.
     *
     * AB-45 update: under AB-45's commit-and-park fix, `scheduleWakeup` now
     * forces an immediate break exactly like `requestHumanInput` already did
     * (AB-44) — so a CROSS-step override ("step 0 calls scheduleWakeup, step 1
     * calls requestHumanInput") is no longer reachable: step 0's wakeup parks
     * the run before step 1 could ever run. Same-step mutual exclusivity (one
     * step's tool calls include BOTH tools) is still reachable and is what the
     * test below exercises — the accumulation loop's own inline comment at
     * `run-workflow.ts` (the `pendingWakeup`/`pendingHumanWait` accumulation
     * block) has always described exactly this case: "if the agent called both
     * tools ... the `pendingHumanWait` check runs second, so it clears a
     * same-step `pendingWakeup`". Cross-step override is still reachable
     * ACROSS park cycles instead (a fired wakeup's continuation step calls
     * `requestHumanInput`) — covered by the "re-parks when the continuation
     * step itself calls scheduleWakeup again" test in the D6/AB-45 describe
     * block above, mirrored for the other primitive.
     */

    it('only parks on ctx.waitForSignal when a single step calls both scheduleWakeup and requestHumanInput', async () => {
      // One step's tool calls include BOTH scheduleWakeup (very long, unfired
      // duration) AND requestHumanInput. Per the accumulation order,
      // pendingHumanWait is checked SECOND and so overrides the same-step
      // pendingWakeup — only ctx.waitForSignal should fire.
      //
      // Without the fix: both locals are non-undefined, the two independent
      // `if` branches fire, the workflow sleeps (very long) and then waits
      // for signal — observable as a crash or extremely long test timeout.
      // With the fix: the wakeup local is cleared when humanWait is
      // accumulated, so only waitForSignal fires, the run parks
      // (status='running'), and a subsequent engine.signal releases it.

      const storage = new MemoryStorage();
      const runId = 'eeeeeeee-0000-4000-8000-000000000005';
      const signalName = 'human-approval';

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };

      // Tool that sets pendingWakeup — mimics createScheduleWakeupTool.
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: params.duration,
            };
          }
          return 'scheduled';
        },
      });

      // Tool that sets pendingHumanWait — mimics createRequestHumanInputTool.
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Request human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = {
              signalName: params.signalName,
            };
          }
          return 'parked';
        },
      });

      const toolbox = createToolbox([wakeupTool, hitlTool]) as unknown as RegistryToolbox;

      let stepCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const call = stepCallCount++;
            if (call === 0) {
              // Single step: both tool calls, in one generation response —
              // the agent scheduled a wakeup AND requested human input in
              // the same turn. A very long wakeup duration so if ctx.sleep
              // somehow fired, the test would hang.
              return {
                content: '',
                toolCalls: [
                  { name: 'scheduleWakeup', arguments: { duration: 999_999_999 } },
                  { name: 'requestHumanInput', arguments: { signalName } },
                ],
              };
            }
            // Continuation call (after signal delivery): finish.
            return { content: 'done after human input', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox,
      };
      depsContainer.ref = services;

      const { engine } = await buildEngine(storage, false);
      try {
        const handle = await engine.start(
          'agentRun',
          { runId, sessionId: runId, agentName: 'test-agent', prompt: 'start' },
          { id: runId, services },
        );

        // Poll for the run to park on ctx.waitForSignal (status='running').
        // With the BUG: the run would sleep for 999_999_999 units before reaching
        // waitForSignal — observable as the test hanging or timing out.
        // With the FIX: only ctx.waitForSignal fires; the run parks immediately.
        let parked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running') {
            parked = true;
            break;
          }
          if (snap?.status === 'completed' || snap?.status === 'failed') break;
        }

        // The run must be parked on the signal, not sleeping.
        expect(parked).toBe(true);
        // Only ONE step committed before the park — both tool calls landed
        // in that single step.
        expect(stepCallCount).toBe(1);

        // Send the human signal to release the parked run.
        await engine.signal(runId, signalName, { approved: true });

        // The released run continues with one more generation step
        // (AB-44) — the continuation's plain content (no tool calls)
        // satisfies noToolCalls().
        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        expect(stepCallCount).toBe(2);

        // Crucially: humanWaitSignal is present and wakeupNote is absent — only the
        // human-wait path fired.
        expect(result.humanWaitSignal).toBe(signalName);
        expect(result.wakeupNote).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('AB-45 — a stale pendingWakeup from an earlier park does not resurface and re-park the next continuation step', async () => {
      // REGRESSION: `deps.pendingWakeup` is sticky (`scheduleWakeup` only ever
      // SETS it; nothing clears it once consumed) — a live `DurableRunDeps`
      // object outlives any single step's `ctx.memo`. AB-45's wakeup
      // continuation loop clears the HOISTED `pendingWakeup` local the moment
      // its sleep resolves (see the wakeup park block's "Consumed:" comment),
      // but if a later step's memoized result failed to clear the per-step
      // `deps.pendingWakeup` slot at its own start, that later step's memo
      // would still report a PRIOR park's `pendingWakeup` as if it were its
      // own — re-triggering `ctx.sleep` on a wakeup the agent never asked for
      // on that step, hanging the run.
      //
      // Step 0: scheduleWakeup(20ms) — sets pendingWakeup, fires, continues.
      // Step 1 (continuation): scheduleWakeup(999_999_999) — sets a NEW
      //   pendingWakeup, then requestHumanInput OVERRIDES it (same-step mutual
      //   exclusivity clears the LOCAL pendingWakeup); the workflow parks on
      //   ctx.waitForSignal.
      // (signal delivered)
      // Step 2 (second continuation): plain content, no tool calls. Its memo
      //   must report `pendingWakeup: undefined` (the per-step clear), not
      //   step 1's stale 999_999_999 value — otherwise the run would
      //   `ctx.sleep(999_999_999)` here and this test would hang.
      const storage = new MemoryStorage();
      const runId = 'ab45-stale-wakeup-clear';
      const signalName = 'human-response';

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = { duration: params.duration };
          }
          return 'scheduled';
        },
      });
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Request human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = { signalName: params.signalName };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([wakeupTool, hitlTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const c = call++;
            if (c === 0) {
              // Step 0: a short, real wakeup that will actually fire.
              return {
                content: '',
                toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 20 } }],
              };
            }
            if (c === 1) {
              // Step 1 (continuation after the wakeup fires): a huge wakeup
              // AND a human-input request in the same step — the human-input
              // request wins (same-step mutual exclusivity).
              return {
                content: '',
                toolCalls: [
                  { name: 'scheduleWakeup', arguments: { duration: 999_999_999 } },
                  { name: 'requestHumanInput', arguments: { signalName } },
                ],
              };
            }
            // Second continuation step (call 2): plain content, no tool
            // calls. If the bug is present, this step's memo would still
            // see step 1's `pendingWakeup` and the workflow would sleep
            // here instead of returning.
            return { content: 'done after two parks', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          maximumSteps: 5,
        },
        toolbox,
      };
      depsContainer.ref = services;

      // AB-330: drive the wakeup off a manual clock and `waitForCursorSave`
      // (AB-296's pattern above) instead of polling `handle.snapshot()`
      // against `buildWakeupEngine`'s real background scheduler poller.
      const clock = createManualClock();
      const { engine, waitForCursorSave } = await buildWakeupEngine(
        storage,
        false,
        undefined,
        clock,
      );
      try {
        const handle = await engine.start(
          'agentRun',
          { runId, sessionId: runId, agentName: 'test-agent', prompt: 'start', maximumSteps: 5 },
          { id: runId, services },
        );

        // Step 0 commits (schedules the wakeup), then fire its 20ms timer
        // explicitly via the manual clock.
        await waitForCursorSave(runId, 1);
        await yieldToPortableEventLoop();
        await engine.runMaintenance(clock.advance(20));

        // Step 1 (the continuation) commits: it sets both a new wakeup and a
        // human-input request, and the human-input request wins — the run
        // parks on ctx.waitForSignal.
        await waitForCursorSave(runId, 2);
        const snap = await handle.snapshot();
        expect(snap?.status).toBe('running');
        expect(call).toBeGreaterThanOrEqual(2);

        await engine.signal(runId, signalName, { approved: true });

        // With the bug, this hangs forever on ctx.sleep(999_999_999) — the
        // test's own timeout is the failure signal for that case.
        const result = await handle.result();
        expect(result.finishReason).toBe('stop-condition');
        expect(result.content).toBe('done after two parks');
        expect(result.humanWaitSignal).toBe(signalName);
        // The wakeup from step 1 never governs the final park — it was
        // superseded by the human-wait request in the SAME step, and must
        // not resurface as a fresh request in step 2.
        expect(result.wakeupNote).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('only parks on ctx.sleep when scheduleWakeup is the only park request set', async () => {
      // Sanity check: a run that only calls scheduleWakeup (no requestHumanInput)
      // still parks on ctx.sleep — the fix must not break the single-park-type case.
      const storage = new MemoryStorage();
      const runId = 'ffffffff-0000-4000-8000-000000000006';

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: params.duration,
              note: 'check later',
            };
          }
          return 'scheduled';
        },
      });

      const toolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const services: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 999_999_999 } }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      const { engine } = await buildWakeupEngine(storage, false);
      try {
        const handle = await engine.start(
          'agentRun',
          { runId, sessionId: runId, agentName: 'wakeup-agent', prompt: 'start', maximumSteps: 1 },
          { id: runId, services },
        );
        void handle.result().catch(() => {});

        // Poll until parked on ctx.sleep (status='running', step committed).
        let parked = false;
        for (let i = 0; i < 100; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running') {
            const cp = await engine.get(runId);
            if (cp) {
              parked = true;
              break;
            }
          }
        }
        expect(parked).toBe(true);
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('Skip durable parking after terminal failures (PRRT_kwDORvupsc6MbhP0)', () => {
    /**
     * REGRESSION TESTS for the unconditional durable park after error/abort.
     *
     * Bug: the post-loop park block (`if (pendingWakeup !== undefined) {
     * yield* ctx.sleep(...) }` / `else if (pendingHumanWait !== undefined) {
     * yield* ctx.waitForSignal(...) }`) ran unconditionally. If a step called
     * `scheduleWakeup` or `requestHumanInput` and a SUBSEQUENT step (or the same
     * step, via another failing tool) terminated with `error` or `aborted`, the
     * loop broke early setting `stoppedEarly = true` and the failure finish reason —
     * but `pendingWakeup`/`pendingHumanWait` were never cleared. The park block
     * then fired anyway, leaving an errored/aborted session parked as `running`
     * until the timer/signal arrived, hiding the real outcome from callers.
     *
     * Fix: gate the park block (and the result park-metadata fields) on
     * `!isFailureOutcome`, where `isFailureOutcome` checks `finishReason` against
     * the failure set (`error`, `aborted`, `elicitation-denied`, `budget-exceeded`).
     * This covers both failing steps and a failing `onMaximumSteps` handler,
     * because both update `finishReason` before reaching the park section.
     */

    it('returns the error result immediately without re-parking when the continuation step errors after scheduleWakeup fires', async () => {
      // AB-45 update: under the new commit-and-park semantics, `scheduleWakeup`
      // parks BEFORE any later generation call can run — so the failing step
      // can only be the CONTINUATION after a genuinely fired wakeup (short
      // real duration, not the old un-fired 999_999_999 placeholder).
      // Step 0: call scheduleWakeup(20ms). `pendingWakeup` is set and fires.
      // Continuation step: generate throws → outcome.kind === 'error',
      //   finishReason = 'error'. Expected: run completes with
      //   finishReason: 'error', wakeupNote carries the fired wakeup's note
      //   (historical fact — the wakeup genuinely fired before the failure),
      //   and no re-park.
      const { engine } = await buildWakeupEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: params.duration,
              note: 'check later',
            };
          }
          return 'scheduled';
        },
      });
      const toolbox = createToolbox([wakeupTool, nextTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const c = call++;
            if (c === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 20 } }],
              };
            }
            throw new Error('generate failed after wakeup');
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'park-skip-error', prompt: 'Go', maximumSteps: 5 },
          services,
        );

        // Must complete immediately as an error — NOT re-park on ctx.sleep.
        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('generate failed after wakeup');
        expect(call).toBe(2);
        expect(result.wakeupNote).toBe('check later');
        expect(result.humanWaitSignal).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('returns the abort result immediately without re-parking after scheduleWakeup fires and the run is aborted', async () => {
      // AB-45 update: `options.signal` (the run's own `AbortController`) is
      // checked at the TOP of each step (`run-step.ts`'s `if (signal?.aborted)
      // return { kind: 'abort' }`) — it is NOT wired into Weft's `ctx.sleep`,
      // so aborting mid-tool-execution does not interrupt an in-flight sleep;
      // it is only observed the NEXT time a step begins. Under the new
      // commit-and-park semantics that next step is the wakeup's OWN
      // continuation (short real duration so it actually fires), which
      // immediately sees the signal aborted and returns 'abort' with no
      // generate call.
      // Step 0: call scheduleWakeup(20ms) and abort the run's signal.
      // Continuation step: aborts before generate runs.
      // Expected: run completes with finishReason: 'aborted', wakeupNote
      //   carries the fired wakeup's note, no re-park.
      const { engine } = await buildWakeupEngine(new MemoryStorage(), false);

      const controller = new AbortController();
      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: params.duration,
              note: 'check later',
            };
          }
          // Trigger the abort signal after the wakeup tool runs.
          controller.abort('manual-abort');
          return 'scheduled';
        },
      });
      const toolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      let generateCallCount = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            generateCallCount++;
            return {
              content: '',
              toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 20 } }],
            };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          signal: controller.signal,
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'park-skip-abort', prompt: 'Go', maximumSteps: 5 },
          services,
        );

        // Must complete as aborted — NOT re-park on ctx.sleep.
        expect(result.finishReason).toBe('aborted');
        expect(result.wakeupNote).toBe('check later');
        expect(result.humanWaitSignal).toBeUndefined();
        // The continuation step's `generate` was never called — the abort
        // check at the top of the step short-circuited it before generate
        // could run a second time.
        expect(generateCallCount).toBe(1);
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('parks immediately on requestHumanInput (AB-44), and — a signal racing a terminal failure — the continuation step erroring afterward never re-parks', async () => {
      // AB-44 fixes the durable workflow to park on `requestHumanInput`
      // BEFORE another generation call can run without the requested input
      // (this file's other new "commits its step and parks" tests cover that
      // directly). This test covers the AC's "a signal racing terminal
      // failure has an explicit outcome": deliver the signal, let the
      // CONTINUATION step fail, and confirm the failure returns immediately
      // rather than re-entering `ctx.waitForSignal`.
      //
      // Step 0: call requestHumanInput → pendingHumanWait is set → the
      //   workflow parks on ctx.waitForSignal('approval') immediately.
      // (signal delivered) → continuation step (generate call 1): throws.
      // Expected: run completes with finishReason: 'error', no re-park, and
      //   `humanWaitSignal` is still reported — the run DID genuinely park
      //   and get released; that historical fact is not "stale" just because
      //   the resumed turn went on to fail.
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const hitlTool = createTool({
        name: 'requestHumanInput',
        description: 'Park waiting for human input',
        input: z.object({ signalName: z.string() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingHumanWait = {
              signalName: params.signalName,
            };
          }
          return 'parked';
        },
      });
      const toolbox = createToolbox([hitlTool, nextTool]) as unknown as RegistryToolbox;

      let call = 0;
      const services: DurableRunDeps = {
        options: {
          generate: async () => {
            const c = call++;
            if (c === 0) {
              return {
                content: '',
                toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: 'approval' } }],
              };
            }
            throw new Error('continuation step failed after signal delivery');
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const handle = await engine.start(
          'agentRun',
          {
            runId: 'park-skip-hitl-error',
            sessionId: 'park-skip-hitl-error',
            agentName: 'test-agent',
            prompt: 'Go',
            maximumSteps: 5,
          },
          { id: 'park-skip-hitl-error', services },
        );

        // Poll until parked on ctx.waitForSignal (step 0 committed, still running).
        let parked = false;
        for (let i = 0; i < 50; i++) {
          await yieldToPortableEventLoop();
          const snap = await handle.snapshot();
          if (snap?.status === 'running' && depsContainer.ref?.pendingHumanWait !== undefined) {
            parked = true;
            break;
          }
        }
        expect(parked).toBe(true);
        // Only ONE generate call happened before the park — proves the fix:
        // the workflow did not run another generation call before parking.
        expect(call).toBe(1);

        await engine.signal('park-skip-hitl-error', 'approval', { approved: true });

        const result = await handle.result();

        // Must complete as an error from the CONTINUATION step — NOT hang
        // waiting on another `ctx.waitForSignal`.
        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('continuation step failed after signal delivery');
        expect(result.wakeupNote).toBeUndefined();
        // The run DID genuinely park and get released before this failure —
        // that historical fact is reported regardless of the eventual outcome.
        expect(result.humanWaitSignal).toBe('approval');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('returns the error result immediately without re-parking when onMaximumSteps handler errors after scheduleWakeup fires', async () => {
      // AB-45 update: `maximumSteps: 1` means the inner step loop has room
      // for exactly one step. Step 0 calls scheduleWakeup and — under the new
      // commit-and-park semantics — parks immediately (short real duration so
      // it actually fires). The wakeup's own continuation loop resets
      // `stoppedEarly = false` before looping the outer `while` again, but the
      // inner `for` loop's bound (`step < maximumSteps`) is already exhausted
      // at `cursor.step === 1 === maximumSteps`, so it does not execute at
      // all on the second pass — `stoppedEarly` stays `false`, and
      // `onMaximumSteps` runs exactly as the pre-wakeup exhaustion case would.
      // onMaximumSteps handler throws → finishReason = 'error'.
      // Expected: run completes with finishReason: 'error', no re-park,
      // wakeupNote carries the fired wakeup's note.
      const { engine } = await buildWakeupEngine(new MemoryStorage(), false);

      const depsContainer: { ref: DurableRunDeps | undefined } = { ref: undefined };
      const wakeupTool = createTool({
        name: 'scheduleWakeup',
        description: 'Schedule a wakeup',
        input: z.object({ duration: z.number() }),
        execute: async (params) => {
          if (depsContainer.ref) {
            depsContainer.ref.pendingWakeup = {
              duration: params.duration,
              note: 'wake me later',
            };
          }
          return 'scheduled';
        },
      });
      const toolbox = createToolbox([wakeupTool]) as unknown as RegistryToolbox;

      const services: DurableRunDeps = {
        options: {
          generate: async () => ({
            content: '',
            toolCalls: [{ name: 'scheduleWakeup', arguments: { duration: 20 } }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          onMaximumSteps: async () => {
            throw new Error('handler exploded after wakeup scheduled');
          },
        },
        toolbox,
      };
      depsContainer.ref = services;

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'park-skip-oms-error', prompt: 'Go', maximumSteps: 1 },
          services,
        );

        // Must complete as an error — NOT re-park on ctx.sleep.
        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('handler exploded after wakeup scheduled');
        expect(result.wakeupNote).toBe('wake me later');
        expect(result.humanWaitSignal).toBeUndefined();
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  describe('onMaximumSteps handler (PRRT_kwDORvupsc6MZErk)', () => {
    /**
     * REGRESSION TESTS for the missing `onMaximumSteps` invocation on the durable
     * path. Bug: when the step loop exhausted `maximumSteps`, the durable workflow
     * returned immediately with `finishReason: 'maximum-steps'` and never called
     * `options.onMaximumSteps`. The in-memory `executeLoop` calls the handler to let
     * agents synthesize a final answer (e.g. via `createEarlyStoppingHandler`).
     *
     * Fix: after the while loop, if no terminal outcome broke early (`!stoppedEarly`),
     * the handler runs inside `ctx.memo('on-maximum-steps')` so crash-recovery never
     * re-charges the handler's LLM call. `cursor.lastContent` and the transcript are
     * updated and persisted when the handler returns a string.
     */

    /**
     * Build services with an agent that always emits a tool call (never
     * settles). Excludes `runId`/`steering` from the override bag rather
     * than accepting `Partial<DurableRunDeps['options']>` — AB-236 makes
     * those two a discriminated pair on `RunOptions`, and `Partial` (like
     * `Omit`) flattens a union's members into one merged, looser shape,
     * which would let this helper accept a `steering` override with no
     * `runId` again. No caller below needs to override either field.
     */
    function makeNeverSettlingServices(
      options?: Partial<Omit<DurableRunDeps['options'], 'runId' | 'steering'>>,
    ): DurableRunDeps {
      const toolbox = continuingToolbox();
      return {
        toolbox,
        options: {
          generate: async ({ step }) => ({
            content: `step ${step}`,
            toolCalls: [{ name: 'next', arguments: {} }],
          }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          ...options,
        },
      };
    }

    it('invokes the handler and propagates its content to the result when the cap is reached', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      let handlerCalled = false;

      const services = makeNeverSettlingServices({
        onMaximumSteps: async () => {
          handlerCalled = true;
          return 'Forced final answer';
        },
      });

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'oms-happy', prompt: 'Go', maximumSteps: 2 },
          services,
        );

        expect(handlerCalled).toBe(true);
        expect(result.finishReason).toBe('maximum-steps');
        expect(result.content).toBe('Forced final answer');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('does not invoke the handler when the loop exits via a stop condition', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      let handlerCalled = false;

      const services = makeNeverSettlingServices({
        // Override generate to return no tool calls on step 0 → triggers noToolCalls() stop
        generate: async () => ({ content: 'done', toolCalls: [] }),
        onMaximumSteps: async () => {
          handlerCalled = true;
          return 'Should not appear';
        },
      });

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'oms-no-call', prompt: 'Hi', maximumSteps: 10 },
          services,
        );

        expect(handlerCalled).toBe(false);
        expect(result.finishReason).toBe('stop-condition');
        expect(result.content).toBe('done');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('converts a handler error to finishReason error and propagates its message', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);

      const services = makeNeverSettlingServices({
        onMaximumSteps: async () => {
          throw new Error('handler exploded');
        },
      });

      try {
        const result = await runToCompletion(
          engine,
          { runId: 'oms-error', prompt: 'Go', maximumSteps: 1 },
          services,
        );

        expect(result.finishReason).toBe('error');
        expect(result.errorMessage).toBe('handler exploded');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('memo short-circuits the handler on recovery — it is not re-invoked', async () => {
      // Verifies that `ctx.memo('on-maximum-steps')` makes the handler idempotent:
      // after engine A completes the handler and then crashes (simulated by dispose),
      // engine B recovering via recoverAll() replays the memo from the checkpoint
      // instead of re-running the handler. Handler invocation count must be 1.
      const storage = new MemoryStorage();
      const runId = 'oms-recovery-memo';

      let handlerCallCount = 0;

      // Engine A: reaches maximumSteps, calls the handler, then is disposed.
      const a = await buildEngine(storage, false);
      try {
        const servicesA: DurableRunDeps = makeNeverSettlingServices({
          onMaximumSteps: async () => {
            handlerCallCount++;
            return 'final answer from A';
          },
        });

        await runToCompletion(a.engine, { runId, prompt: 'Go', maximumSteps: 2 }, servicesA);
      } finally {
        a.engine[Symbol.dispose]();
      }

      // The handler ran exactly once during engine A.
      expect(handlerCallCount).toBe(1);

      // Engine B: recovers the run. The run is already completed (terminal), so
      // recoverAll finds no non-terminal runs to resume. Confirm the final content
      // is the one the handler produced (proving it was checkpointed by the memo).
      const b = await buildEngine(storage, false, async () => ({
        status: 'available',
        services: makeNeverSettlingServices({
          onMaximumSteps: async () => {
            handlerCallCount++;
            return 'should not be called on B';
          },
        }),
      }));
      try {
        const handles = await b.engine.recoverAll();
        // The run completed on A, so it is terminal — recoverAll should find
        // nothing to resume. The handler count stays at 1.
        expect(handles.length).toBe(0);
        expect(handlerCallCount).toBe(1);

        // The checkpoint cursor reflects the final content written by engine A.
        const checkpoint = await b.checkpointStore.loadCheckpoint(runId);
        expect(checkpoint.cursor.lastContent).toBe('final answer from A');
      } finally {
        b.engine[Symbol.dispose]();
      }
    });
  });

  describe('AB-67: the steering boundary read reaches the durable driver too', () => {
    /**
     * `DurableRunDeps.options` IS a `RunOptions` (`types.ts:129`), and the
     * memo body calls the identical `buildStepDeps(deps.options)` the
     * in-memory driver calls (`run-workflow.ts:481`) — no separate
     * construction path exists for the durable driver to fall out of sync
     * with. These tests exercise that shared call site, not a durable-only
     * reimplementation.
     */
    it('threads DurableRunDeps.options.steering into GenerateContext.steering for the generate call inside ctx.memo', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      const gate: SteeringGate = {
        sessionId: 'test-session',
        getDesiredState: () => ({ paused: false, configVersion: 7, model: 'durable-model' }),
        awaitResume: () => new Promise<void>(() => {}), // never needed: this run never pauses
      };
      let capturedSteering: GenerateContext['steering'];
      const toolbox = continuingToolbox();
      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: async (context) => {
            capturedSteering = context.steering;
            return { content: 'done', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          steering: gate,
          runId: 'run-1',
        },
      };

      try {
        await runToCompletion(engine, { runId: 'ab-67-steering-thread-durable' }, services);
        expect(capturedSteering).toEqual({
          paused: false,
          configVersion: 7,
          model: 'durable-model',
        });
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('AB-221: steering.applied fires exactly once across multiple durable steps for an unchanged configVersion, not once per step', async () => {
      // RunCursor.lastAppliedConfigVersion is the piece specific to this
      // driver — a fresh RunState is built inside EVERY ctx.memo call
      // (run-workflow.ts), so without threading the dedupe key through the
      // checkpoint the same way schemaAttempts already is, this would fire
      // once per step instead of once per accepted command.
      const { engine } = await buildEngine(new MemoryStorage(), false);
      const gate: SteeringGate = {
        sessionId: 'test-session',
        getDesiredState: () => ({ paused: false, configVersion: 7, model: 'durable-model' }),
        awaitResume: () => new Promise<void>(() => {}), // never needed: this run never pauses
      };
      const events: Event[] = [];
      const emitter: EventDispatcher = {
        dispatch(event) {
          events.push(event);
          return true;
        },
      };
      let calls = 0;
      const toolbox = continuingToolbox();
      const services: DurableRunDeps = {
        toolbox,
        emitter,
        options: {
          generate: async () => {
            calls++;
            if (calls === 1) {
              return { content: '', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            return { content: 'done', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          steering: gate,
          runId: 'run-1',
        },
      };

      try {
        await runToCompletion(engine, { runId: 'ab-221-steering-applied-durable' }, services);
        expect(calls).toBe(2);
        const applied = events.filter(
          (event): event is SteeringAppliedEvent => event instanceof SteeringAppliedEvent,
        );
        expect(applied).toHaveLength(1);
        expect(applied[0]?.effective.configVersion).toBe(7);
        expect(applied[0]?.effective.appliedAtStep).toBe(0);
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it("AB-199: seeds a fresh durable run's cursor from SteeringGate.getAppliedFloor, so a configVersion a PRIOR run already applied is not re-fired", async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      const gate: SteeringGate = {
        sessionId: 'test-session',
        getDesiredState: () => ({ paused: false, configVersion: 3, model: 'durable-model' }),
        awaitResume: () => new Promise<void>(() => {}),
        getAppliedFloor: () => 3,
      };
      const events: Event[] = [];
      const emitter: EventDispatcher = {
        dispatch(event) {
          events.push(event);
          return true;
        },
      };
      const toolbox = continuingToolbox();
      const services: DurableRunDeps = {
        toolbox,
        emitter,
        options: {
          generate: async () => ({ content: 'done', toolCalls: [] }),
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          steering: gate,
          runId: 'run-1',
        },
      };

      try {
        await runToCompletion(engine, { runId: 'ab-199-applied-floor-durable' }, services);
        const applied = events.filter(
          (event): event is SteeringAppliedEvent => event instanceof SteeringAppliedEvent,
        );
        expect(applied).toHaveLength(0);
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('a paused steering gate blocks the durable driver at the same runStep boundary, then proceeds once resumed', async () => {
      const { engine } = await buildEngine(new MemoryStorage(), false);
      let paused = true;
      let resumeResolvers: Array<() => void> = [];
      const gate: SteeringGate = {
        sessionId: 'test-session',
        getDesiredState: () => ({ paused, configVersion: paused ? 1 : 2 }),
        awaitResume: () =>
          new Promise<void>((resolve) => {
            resumeResolvers.push(resolve);
          }),
      };

      let generateCalls = 0;
      const toolbox = continuingToolbox();
      const services: DurableRunDeps = {
        toolbox,
        options: {
          generate: async () => {
            generateCalls++;
            return { content: 'done', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
          steering: gate,
          runId: 'run-1',
        },
      };

      try {
        const resultPromise = runToCompletion(
          engine,
          { runId: 'ab-67-steering-pause-durable' },
          services,
        );

        // Let the engine drive the workflow generator far enough to reach
        // and block on the pause gate before asserting it never generated.
        await yieldToPortableEventLoop();
        await yieldToPortableEventLoop();
        expect(generateCalls).toBe(0);

        paused = false;
        const waiters = resumeResolvers;
        resumeResolvers = [];
        for (const resolve of waiters) resolve();

        const result = await resultPromise;
        expect(generateCalls).toBe(1);
        expect(result.finishReason).toBe('stop-condition');
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });
});
