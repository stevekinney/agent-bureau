/**
 * COR-851 — the self-fence of a goal attempt's run. A start that has claimed its
 * run but not created it can be overtaken by the goal's ending, and the run it
 * then creates must take no step. These tests drive real durable runs under the
 * hook, and the fence over the real goal store.
 */
import {
  createDefaultRuntimeServices,
  HookRegistry,
  mergeHookRegistries,
} from '@lostgradient/lifecycle';
import {
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  type DurableActiveRunContext,
  GuardrailTripwireError,
  type OperativeHookMap,
  type RunOptions,
  startDurableRunResult,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import {
  createGoalAttemptFence,
  createGoalAttemptFenceHost,
  GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS,
  GOAL_ATTEMPT_FENCE_HOOK_ID,
  GOAL_ATTEMPT_FENCE_READ_TRIES,
  type GoalAttemptFence,
  type GoalAttemptFenceRegistration,
  type GoalAttemptTarget,
  type GoalAttemptVerdict,
  registerGoalAttemptFence,
} from './goal-attempt-fence';
import { createGoalState, goalAttemptId, goalSessionId } from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import { type CatalogRunRecoveryLoad, createRuntimeComposition } from './runtime-composition';

const NOW = '2026-10-02T12:00:00.000Z';
const RUN: GoalAttemptVerdict = { status: 'run' };
const REFUSE: GoalAttemptVerdict = { status: 'refuse' };
const clock = { now: () => Date.parse(NOW) };
const target: GoalAttemptTarget = { goalRunId: 'g1', attemptIndex: 0, runId: 'goal-g1-a0' };

const claimOf = (
  goalAttempt: {
    goalRunId: string;
    attemptIndex: number;
    tombstonedAt?: string;
  },
  holder: { agentName?: string; principal?: string } = {},
): CatalogRunRecoveryLoad => ({
  status: 'found',
  record: {
    schemaVersion: 1,
    agentName: holder.agentName ?? 'worker',
    definitionRevision: 1,
    input: 'work',
    ...(holder.principal === undefined ? {} : { principal: holder.principal }),
    goalAttempt,
    costEstimation: null,
  },
});

async function liveGoal(
  principal?: string,
  bounds: { maximumAttempts: number; maximumTotalDurationMs?: number } = { maximumAttempts: 2 },
): Promise<GoalStore> {
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumTotalSteps: 10, ...bounds },
      ...(principal === undefined ? {} : { principal }),
      now: NOW,
    }),
  );
  return store;
}

/** Commits what the controller commits when it opens an attempt: the attempt running and the goal's active work. */
async function openAttempt(
  store: GoalStore,
  options: { attemptIndex?: number; runId?: string; status?: 'running' | 'aborted' } = {},
): Promise<void> {
  const attemptIndex = options.attemptIndex ?? 0;
  const runId = options.runId ?? `goal-g1-a${attemptIndex}`;
  const current = await store.get('g1');
  if (current === undefined) throw new Error('the goal is missing');
  const attemptId = goalAttemptId('g1', attemptIndex);
  const result = await store.applyTransition({
    goalRunId: 'g1',
    seq: current.transitionSeq + 1,
    transitionId: `g1:t${current.transitionSeq + 1}`,
    to: 'running',
    at: NOW,
    cause: 'attempt started',
    attempt: {
      attemptId,
      attemptIndex,
      runId,
      sessionId: goalSessionId('g1', 0),
      startedAt: NOW,
      usage: { steps: 0, tokens: 0 },
      status: options.status ?? 'running',
    },
    usage: { ...current.usage, attempts: attemptIndex + 1 },
    active: { kind: 'attempt', attemptId, runId, startedAt: NOW },
  });
  if (result.status !== 'applied') {
    throw new Error(
      `the attempt did not open: ${result.status} ${result.status === 'rejected' ? result.reason : ''}`,
    );
  }
}

describe('createGoalAttemptFence', () => {
  const own = claimOf({ goalRunId: 'g1', attemptIndex: 0 });

  it('lets a live goal’s own, untombstoned attempt run once the goal shows it open', async () => {
    const store = await liveGoal();
    await openAttempt(store);
    const fence = createGoalAttemptFence({
      store,
      readRunRecord: () => Promise.resolve(own),
      clock,
    });

    expect(await fence.mayRun(target)).toEqual(RUN);
  });

  it('refuses an acknowledged attempt once the goal’s aggregate duration has elapsed, and lets it run before', async () => {
    const store = await liveGoal(undefined, { maximumAttempts: 2, maximumTotalDurationMs: 1_000 });
    await openAttempt(store);
    const at = (offsetMs: number) =>
      createGoalAttemptFence({
        store,
        readRunRecord: () => Promise.resolve(own),
        clock: { now: () => Date.parse(NOW) + offsetMs },
      });

    expect(await at(999).mayRun(target)).toEqual(RUN);
    expect(await at(1_000).mayRun(target)).toEqual(REFUSE);
    expect(await at(60_000).mayRun(target)).toEqual(REFUSE);
  });

  it('refuses once the goal’s cancellation is recorded', async () => {
    const store = await liveGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const fence = createGoalAttemptFence({
      store,
      readRunRecord: () => Promise.resolve(own),
      clock,
    });

    expect(await fence.mayRun(target)).toEqual(REFUSE);
  });

  it('refuses once the goal is terminal', async () => {
    const store = await liveGoal();
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 1,
      transitionId: 'g1:t1',
      to: 'failed',
      at: NOW,
      cause: 'fail: unsupported-validation',
      terminalReason: 'unsupported-validation',
    });
    const fence = createGoalAttemptFence({
      store,
      readRunRecord: () => Promise.resolve(own),
      clock,
    });

    expect(await fence.mayRun(target)).toEqual(REFUSE);
  });

  it('refuses a goal that cannot be found or read', async () => {
    const fence = createGoalAttemptFence({
      store: { get: () => Promise.resolve(undefined) },
      readRunRecord: () => Promise.resolve(own),
      clock,
    });

    expect(await fence.mayRun(target)).toEqual(REFUSE);
  });

  it.each([
    ['a tombstoned claim', claimOf({ goalRunId: 'g1', attemptIndex: 0, tombstonedAt: NOW })],
    ['another attempt’s claim', claimOf({ goalRunId: 'g1', attemptIndex: 1 })],
    ['another goal’s claim', claimOf({ goalRunId: 'g2', attemptIndex: 0 })],
    ['no claim', { status: 'missing' }],
    ['a claim that is not a valid record', { status: 'corrupt' }],
  ] satisfies Array<[string, CatalogRunRecoveryLoad]>)('refuses on %s', async (_label, load) => {
    const fence = createGoalAttemptFence({
      store: await liveGoal(),
      readRunRecord: () => Promise.resolve(load),
      clock,
    });

    expect(await fence.mayRun(target)).toEqual(REFUSE);
  });

  it.each([
    [
      'another agent',
      'goal-g1-a0',
      claimOf({ goalRunId: 'g1', attemptIndex: 0 }, { agentName: 'intruder' }),
      undefined,
    ],
    [
      'another principal',
      'goal-g1-a0',
      claimOf({ goalRunId: 'g1', attemptIndex: 0 }, { principal: 'mallory' }),
      undefined,
    ],
    [
      'no principal where the goal has one',
      'goal-g1-a0',
      claimOf({ goalRunId: 'g1', attemptIndex: 0 }),
      'alice',
    ],
    [
      'a different principal where the goal has one',
      'goal-g1-a0',
      claimOf({ goalRunId: 'g1', attemptIndex: 0 }, { principal: 'mallory' }),
      'alice',
    ],
    [
      'a marker that does not reproduce the run id',
      'goal-g1-a7',
      claimOf({ goalRunId: 'g1', attemptIndex: 0 }),
      undefined,
    ],
  ] satisfies Array<[string, string, CatalogRunRecoveryLoad, string | undefined]>)(
    'refuses a claim held by %s, which the goal did not start',
    async (_label, runId, load, goalPrincipal) => {
      const fence = createGoalAttemptFence({
        store: await liveGoal(goalPrincipal),
        readRunRecord: () => Promise.resolve(load),
        clock,
      });

      expect(await fence.mayRun({ ...target, runId })).toEqual(REFUSE);
    },
  );

  it('lets a claim held by the goal’s own agent and principal run', async () => {
    const store = await liveGoal('alice');
    await openAttempt(store);
    const fence = createGoalAttemptFence({
      store,
      readRunRecord: () =>
        Promise.resolve(claimOf({ goalRunId: 'g1', attemptIndex: 0 }, { principal: 'alice' })),
      clock,
    });

    expect(await fence.mayRun(target)).toEqual(RUN);
  });

  it('rejects when the claim cannot be read, which is not a verdict', async () => {
    const fence = createGoalAttemptFence({
      store: await liveGoal(),
      readRunRecord: () =>
        Promise.resolve({ status: 'read-error', error: new Error('storage is down') }),
      clock,
    });

    let caught: unknown;
    try {
      await fence.mayRun(target);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error | undefined)?.message).toBe('storage is down');
  });
});

describe('the late-bound fence', () => {
  it('refuses until it is bound, so a step that beats the binding fails closed', async () => {
    const host = createGoalAttemptFenceHost();

    let caught: unknown;
    try {
      await host.fence.mayRun(target);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.name).toBe('GoalAttemptFenceUnboundError');

    host.bind({ mayRun: () => Promise.resolve(RUN) });
    expect(await host.fence.mayRun(target)).toEqual(RUN);
  });
});

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function durableContext(): Promise<DurableActiveRunContext> {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  disposers.push(() => engine[Symbol.dispose]());
  return { engine, checkpointStore };
}

/** A run of the attempt under the fence, counting the model calls it makes. */
async function fencedRun(
  fence: GoalAttemptFence,
  extras: {
    registration?: GoalAttemptFenceRegistration;
    contextManagement?: RunOptions['contextManagement'];
    signal?: AbortSignal;
    onGenerate?: () => void;
    /** Hooks of a lower tier, composed behind Bureau's as the dispatcher composes them. */
    agentTier?: (hooks: HookRegistry<OperativeHookMap>) => void;
  } = {},
) {
  const context = await durableContext();
  const bureauTier = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
  registerGoalAttemptFence(bureauTier, fence, target, extras.registration);
  const agentTier = new HookRegistry<OperativeHookMap>({ source: 'agent' });
  extras.agentTier?.(agentTier);
  const hooks = mergeHookRegistries(bureauTier, agentTier);
  let generates = 0;
  const result = await startDurableRunResult(context, {
    runId: target.runId,
    sessionId: target.runId,
    ...(extras.signal === undefined ? {} : { signal: extras.signal }),
    options: {
      generate: () => {
        generates += 1;
        extras.onGenerate?.();
        return Promise.resolve({ content: 'done', toolCalls: [] });
      },
      toolbox: createToolbox([]),
      conversation: createConversationHistory(),
      stopWhen: stopWhen.noToolCalls(),
      hooks,
      ...(extras.contextManagement === undefined
        ? {}
        : { contextManagement: extras.contextManagement }),
    },
    prompt: 'go',
  });
  return { result, generates: () => generates, context };
}

/** Context management that is always over the synchronous threshold. */
const overThreshold = (onCompact: () => void): RunOptions['contextManagement'] => ({
  maxTokens: 100_000,
  compactionThreshold: 10,
  tokenEstimator: () => 50,
  onCompact: () => {
    onCompact();
    return Promise.resolve();
  },
});

describe('registerGoalAttemptFence', () => {
  it('registers a replay-safe prepareStep handler under its own id', () => {
    const hooks = new HookRegistry<OperativeHookMap>({ source: 'bureau' });

    registerGoalAttemptFence(hooks, { mayRun: () => Promise.resolve(RUN) }, target);

    expect(hooks.getHandlers('prepareStep').map((entry) => entry.id)).toEqual([
      GOAL_ATTEMPT_FENCE_HOOK_ID,
    ]);
    expect(hooks.getHandlers('beforeCompaction').map((entry) => entry.id)).toEqual([
      `${GOAL_ATTEMPT_FENCE_HOOK_ID}:compaction`,
    ]);
    expect(hooks.getHandlers('beforeBackgroundCompaction').map((entry) => entry.id)).toEqual([
      `${GOAL_ATTEMPT_FENCE_HOOK_ID}:background-compaction`,
    ]);
  });

  it('lets an allowed run take its step', async () => {
    const { result, generates } = await fencedRun({ mayRun: () => Promise.resolve(RUN) });

    expect(result.finishReason).toBe('stop-condition');
    expect(generates()).toBe(1);
  });

  it('stops a run the goal no longer allows before its first agent step, ending it cleanly', async () => {
    const { result, generates, context } = await fencedRun({
      mayRun: () => Promise.resolve(REFUSE),
    });

    expect(generates()).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.finishReason).toBe('tripwire');
    expect(result.error).toBeInstanceOf(GuardrailTripwireError);
    // The run ended: a workflow in a terminal state, not one left running.
    const state = await context.engine.get(target.runId);
    expect(state?.status).toBe('completed');
  });

  it('takes zero steps for a run whose claim another agent or principal holds, over the real fence', async () => {
    for (const holder of [{ agentName: 'intruder' }, { principal: 'mallory' }]) {
      const fence = createGoalAttemptFence({
        store: await liveGoal(),
        readRunRecord: () => Promise.resolve(claimOf({ goalRunId: 'g1', attemptIndex: 0 }, holder)),
        clock,
      });
      const { result, generates } = await fencedRun(fence);

      expect(generates()).toBe(0);
      expect(result.steps).toHaveLength(0);
      expect(result.finishReason).toBe('tripwire');
    }
  });

  it('retries a read that failed, and lets the run go on once one succeeds', async () => {
    let reads = 0;
    const { result, generates } = await fencedRun({
      mayRun: () => {
        reads += 1;
        return reads < GOAL_ATTEMPT_FENCE_READ_TRIES
          ? Promise.reject(new Error('storage hiccup'))
          : Promise.resolve(RUN);
      },
    });

    expect(reads).toBe(GOAL_ATTEMPT_FENCE_READ_TRIES);
    expect(result.finishReason).toBe('stop-condition');
    expect(generates()).toBe(1);
  });

  it('fails closed when the goal and claim can never be read: no step is taken on an unknown', async () => {
    let reads = 0;
    const { result, generates } = await fencedRun({
      mayRun: () => {
        reads += 1;
        return Promise.reject(new Error('storage is down'));
      },
    });

    expect(reads).toBe(GOAL_ATTEMPT_FENCE_READ_TRIES);
    expect(generates()).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.finishReason).toBe('tripwire');
    expect(String(result.error)).toContain('storage is down');
  });

  it('rides out a fault that outlasts a burst of back-to-back reads by backing off on the runtime clock', async () => {
    const base = createDefaultRuntimeServices();
    let waits = 0;
    const runtime = {
      timers: {
        ...base.timers,
        setTimeout: (callback: () => void, milliseconds?: number) => {
          waits += 1;
          return base.timers.setTimeout(callback, milliseconds);
        },
      },
    };
    let reads = 0;
    const { result, generates } = await fencedRun(
      {
        mayRun: () => {
          reads += 1;
          // The store recovers only once the fence has waited twice, which no
          // number of back-to-back reads could produce.
          return waits >= 2
            ? Promise.resolve(RUN)
            : Promise.reject(new Error('storage is briefly down'));
        },
      },
      { registration: { runtime, delaysMs: [1, 1, 1, 1] } },
    );

    expect(waits).toBe(2);
    expect(reads).toBe(3);
    expect(result.finishReason).toBe('stop-condition');
    expect(generates()).toBe(1);
  });

  describe('the backoff timer a wait arms (COR-1418)', () => {
    /** Timers that hand back one fixed handle after running `arm`, recording every handle they are asked to clear. */
    function scriptedTimers(arm: (callback: () => void) => void) {
      const handle = Symbol('armed timer');
      const cleared: unknown[] = [];
      const runtime = {
        timers: {
          ...createDefaultRuntimeServices().timers,
          setTimeout: (callback: () => void) => {
            arm(callback);
            return handle;
          },
          clearTimeout: (armed: unknown) => {
            cleared.push(armed);
          },
        },
      };
      return { runtime, handle, cleared };
    }

    it('ends a wait whose timer fires before setTimeout has returned its handle, instead of reading the handle first', async () => {
      // A runtime that calls back from inside setTimeout ends the wait while the handle
      // it is about to return does not exist yet.
      const { runtime } = scriptedTimers((callback) => callback());
      let reads = 0;

      const { result, generates } = await fencedRun(
        {
          mayRun: () => {
            reads += 1;
            return reads < 3
              ? Promise.reject(new Error('storage is briefly down'))
              : Promise.resolve(RUN);
          },
        },
        { registration: { runtime, delaysMs: [1, 1] } },
      );

      expect(reads).toBe(3);
      expect(result.finishReason).toBe('stop-condition');
      expect(generates()).toBe(1);
    });

    it('clears the very timer setTimeout returned when an abort lands as the timer is armed', async () => {
      const controller = new AbortController();
      const { runtime, handle, cleared } = scriptedTimers(() => controller.abort());

      await fencedRun(
        { mayRun: () => Promise.reject(new Error('storage is down')) },
        {
          registration: { runtime, delaysMs: [3_600_000] },
          signal: controller.signal,
        },
      );

      expect(cleared).toEqual([handle]);
    });
  });

  it('does not compact the conversation of a step it refuses, since compaction can reach a model', async () => {
    let compactions = 0;
    const { result, generates } = await fencedRun(
      { mayRun: () => Promise.resolve(REFUSE) },
      {
        contextManagement: {
          maxTokens: 100_000,
          compactionThreshold: 10,
          tokenEstimator: () => 50,
          onCompact: () => {
            compactions += 1;
            return Promise.resolve();
          },
        },
      },
    );

    expect(compactions).toBe(0);
    expect(generates()).toBe(0);
    expect(result.finishReason).toBe('tripwire');
  });

  it('leaves the compaction of a step it allows to run', async () => {
    let compactions = 0;
    const { result } = await fencedRun(
      { mayRun: () => Promise.resolve(RUN) },
      {
        contextManagement: {
          maxTokens: 100_000,
          compactionThreshold: 10,
          tokenEstimator: () => 50,
          onCompact: () => {
            compactions += 1;
            return Promise.resolve();
          },
        },
      },
    );

    expect(compactions).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('makes one decision for a step that compacts and then prepares, not one per hook', async () => {
    let reads = 0;
    const { result, generates } = await fencedRun(
      {
        mayRun: () => {
          reads += 1;
          return Promise.resolve(RUN);
        },
      },
      { contextManagement: overThreshold(() => undefined) },
    );

    expect(reads).toBe(1);
    expect(generates()).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('spends one run of tries, not two, on a read that never succeeds before a compacting step', async () => {
    let reads = 0;
    const { result } = await fencedRun(
      {
        mayRun: () => {
          reads += 1;
          return Promise.reject(new Error('storage is down'));
        },
      },
      { contextManagement: overThreshold(() => undefined) },
    );

    expect(reads).toBe(GOAL_ATTEMPT_FENCE_READ_TRIES);
    expect(result.finishReason).toBe('tripwire');
  });

  it('stops waiting out a backoff the moment the run is aborted during a compaction decision', async () => {
    const base = createDefaultRuntimeServices();
    const controller = new AbortController();
    let compactions = 0;
    const runtime = {
      timers: {
        ...base.timers,
        // The abort lands as the wait begins; a wait that cannot be aborted would sit
        // out the hour-long delay below.
        setTimeout: (callback: () => void, milliseconds?: number) => {
          controller.abort();
          return base.timers.setTimeout(callback, milliseconds);
        },
      },
    };
    let reads = 0;
    await fencedRun(
      {
        mayRun: () => {
          reads += 1;
          return Promise.reject(new Error('storage is down'));
        },
      },
      {
        registration: { runtime, delaysMs: [3_600_000, 3_600_000] },
        signal: controller.signal,
        contextManagement: overThreshold(() => {
          compactions += 1;
        }),
      },
    );

    expect(reads).toBe(1);
    expect(compactions).toBe(0);
  });

  it('is not a handler an onError hook can retry or skip', async () => {
    const context = await durableContext();
    const hooks = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
    registerGoalAttemptFence(hooks, { mayRun: () => Promise.resolve(REFUSE) }, target);
    // An agent-tier hook that answers every error with `retry` and then `skip`.
    hooks.on('onError', () => Promise.resolve('skip'));
    let generates = 0;

    const result = await startDurableRunResult(context, {
      runId: target.runId,
      sessionId: target.runId,
      options: {
        generate: () => {
          generates += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        },
        toolbox: createToolbox([]),
        conversation: createConversationHistory(),
        stopWhen: stopWhen.noToolCalls(),
        hooks,
      },
      prompt: 'go',
    });

    expect(generates).toBe(0);
    expect(result.finishReason).toBe('tripwire');
  });
});

describe('the fence over the real tombstone', () => {
  const OWNER = {
    goalRunId: 'g1',
    attemptIndex: 0,
    agentName: 'worker',
    principal: undefined,
  } as const;
  const claim = {
    agentName: 'worker',
    definitionRevision: 1,
    input: 'work',
    goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
    costEstimation: null,
  } as const;

  /** The goal is live throughout: only the claim decides whether the run may work. */
  async function composed() {
    const runtime = await createRuntimeComposition({
      storage: { type: 'memory' },
      durableExecution: true,
    });
    disposers.push(() => runtime.durable?.engine[Symbol.dispose]?.());
    const store = await liveGoal();
    const fence = createGoalAttemptFence({
      store,
      readRunRecord: (runId) => runtime.loadCatalogRunRecoveryRecord(runId),
      clock,
    });
    return { runtime, fence, store };
  }

  it('lets a run work under the claim a start made, as the control for the tombstone', async () => {
    const { runtime, fence, store } = await composed();
    await runtime.claimCatalogRunRecoveryRecord(target.runId, claim);
    await openAttempt(store);

    const { result, generates } = await fencedRun(fence);

    expect(generates()).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('takes zero steps when the goal tombstoned the claim between the start’s claim and its engine start', async () => {
    const { runtime, fence } = await composed();
    // The start claims, the goal's ending tombstones the claim, and only then does
    // the engine start create the run: the interleaving no read from outside can close.
    expect(await runtime.claimCatalogRunRecoveryRecord(target.runId, claim)).toBe(true);
    expect(
      await runtime.fenceGoalAttemptRecoveryRecord(target.runId, OWNER, '2026-10-02T12:30:00.000Z'),
    ).toBe('fenced');

    const { result, generates, context } = await fencedRun(fence);

    expect(generates()).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.finishReason).toBe('tripwire');
    const ended = await context.engine.get(target.runId);
    expect(ended?.status).toBe('completed');
  });

  it('takes zero steps, and the start claims nothing, when the tombstone was created where no claim existed', async () => {
    const { runtime, fence } = await composed();
    await runtime.fenceGoalAttemptRecoveryRecord(target.runId, OWNER, '2026-10-02T12:30:00.000Z');

    expect(await runtime.claimCatalogRunRecoveryRecord(target.runId, claim)).toBe(false);
    const { result, generates } = await fencedRun(fence);

    expect(generates()).toBe(0);
    expect(result.finishReason).toBe('tripwire');
  });
});

describe('acknowledged-only runs', () => {
  const own = claimOf({ goalRunId: 'g1', attemptIndex: 0 });
  const fenceOver = (store: Pick<GoalStore, 'get'>, now: () => number = clock.now) =>
    createGoalAttemptFence({
      store,
      readRunRecord: () => Promise.resolve(own),
      clock: { now },
    });

  /** Timers that fire on the next turn whatever the delay, recording each delay; `onWait` runs before the callback. */
  function virtualRuntime(onWait: (wait: number) => Promise<void> | void = () => undefined) {
    const base = createDefaultRuntimeServices();
    const waits: number[] = [];
    const runtime = {
      timers: {
        ...base.timers,
        setTimeout: (callback: () => void, milliseconds?: number) => {
          waits.push(milliseconds ?? 0);
          const wait = waits.length;
          return base.timers.setTimeout(() => {
            void (async () => {
              await onWait(wait);
              callback();
            })();
          }, 0);
        },
      },
    };
    return { runtime, waits };
  }

  it('waits, rather than refuses, for a live goal that has not yet opened the attempt', async () => {
    const fence = fenceOver(await liveGoal());

    expect(await fence.mayRun(target)).toEqual({
      status: 'await-open',
      budgetMs: GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS,
    });
  });

  it('bounds the wait by what remains of the goal’s aggregate duration, when that is less', async () => {
    const store = await liveGoal(undefined, { maximumAttempts: 2, maximumTotalDurationMs: 30_000 });

    expect(await fenceOver(store).mayRun(target)).toEqual({
      status: 'await-open',
      budgetMs: 30_000,
    });
    expect(await fenceOver(store, () => Date.parse(NOW) + 12_000).mayRun(target)).toEqual({
      status: 'await-open',
      budgetMs: 18_000,
    });
    expect(await fenceOver(store, () => Date.parse(NOW) + 30_000).mayRun(target)).toEqual(REFUSE);
  });

  it('refuses a run for an attempt later than the next one, which has no open attempt to wait for', async () => {
    const fence = fenceOver(await liveGoal());

    expect(await fence.mayRun({ ...target, attemptIndex: 1, runId: 'goal-g1-a1' })).toEqual(REFUSE);
  });

  describe('a run whose attempt the record shows another way', () => {
    async function opened() {
      const store = await liveGoal();
      await openAttempt(store);
      const record = await store.get('g1');
      if (record === undefined) throw new Error('the goal is missing');
      return record;
    }
    const over = (record: unknown) => fenceOver({ get: () => Promise.resolve(record as never) });

    it('refuses a run whose id is not the one the open attempt names', async () => {
      const record = await opened();
      const attempt = record.attempts[0]!;

      expect(
        await over({ ...record, attempts: [{ ...attempt, runId: 'goal-g1-other' }] }).mayRun(
          target,
        ),
      ).toEqual(REFUSE);
    });

    it('refuses a run for attempt N when the record shows attempt N+1 open', async () => {
      const record = await opened();
      const first = record.attempts[0]!;
      const second = {
        ...first,
        attemptId: goalAttemptId('g1', 1),
        attemptIndex: 1,
        runId: 'goal-g1-a1',
      };
      const updated = {
        ...record,
        attempts: [{ ...first, status: 'failed' }, second],
        active: {
          kind: 'attempt',
          attemptId: second.attemptId,
          runId: second.runId,
          startedAt: NOW,
        },
      };
      const fence = over(updated);

      expect(await fence.mayRun(target)).toEqual(REFUSE);
      // The control: the attempt the record does show open is let through.
      const next = createGoalAttemptFence({
        store: { get: () => Promise.resolve(updated as never) },
        readRunRecord: () => Promise.resolve(claimOf({ goalRunId: 'g1', attemptIndex: 1 })),
        clock,
      });
      expect(await next.mayRun({ ...target, attemptIndex: 1, runId: 'goal-g1-a1' })).toEqual(RUN);
    });

    it.each([
      ['an attempt that is no longer running', { status: 'evaluating' }],
      ['an attempt that was aborted', { status: 'aborted' }],
    ])('refuses a run for %s', async (_label, patch) => {
      const record = await opened();

      expect(
        await over({ ...record, attempts: [{ ...record.attempts[0]!, ...patch }] }).mayRun(target),
      ).toEqual(REFUSE);
    });

    it('refuses a run the goal’s active work does not name', async () => {
      const record = await opened();

      expect(await over({ ...record, active: undefined }).mayRun(target)).toEqual(REFUSE);
      expect(
        await over({
          ...record,
          active: {
            kind: 'validation',
            attemptId: record.attempts[0]!.attemptId,
            validator: record.validator,
            startedAt: NOW,
          },
        }).mayRun(target),
      ).toEqual(REFUSE);
    });
  });

  it('takes zero steps, and finishes cleanly after its bounded wait, for a run no controller ever opens (a start that outlived its last try)', async () => {
    const store = await liveGoal();
    const { runtime, waits } = virtualRuntime();

    const { result, generates, context } = await fencedRun(fenceOver(store), {
      registration: { runtime },
    });

    expect(generates()).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.finishReason).toBe('tripwire');
    expect(String(result.error)).toContain('never acknowledged');
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(
      GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS,
    );
    const ended = await context.engine.get(target.runId);
    expect(ended?.status).toBe('completed');
  });

  it('waits for the controller’s open-attempt commit, then proceeds exactly once', async () => {
    const store = await liveGoal();
    const order: string[] = [];
    const { runtime, waits } = virtualRuntime(async (wait) => {
      if (wait === 3) {
        order.push('commit');
        await openAttempt(store);
      }
    });

    const { result, generates } = await fencedRun(fenceOver(store), {
      registration: { runtime },
      onGenerate: () => order.push('step'),
    });

    expect(order).toEqual(['commit', 'step']);
    expect(waits).toHaveLength(3);
    expect(generates()).toBe(1);
    expect(result.finishReason).toBe('stop-condition');
  });

  it('has two runs under one goal each wait for the open-attempt commit and then step once', async () => {
    // The controller side of a crash between the start's return and the commit
    // (the replay that commits, or adopts and commits) is covered by the crash-and-adopt
    // tests of the controller in `goal-workflow-recovery.test.ts`. This test covers
    // the run side: whichever run waits for the commit, however late the controller's
    // replay makes it, steps exactly once after it.
    const store = await liveGoal();
    const { runtime } = virtualRuntime(async (wait) => {
      if (wait === 2) await openAttempt(store);
    });
    const first = await fencedRun(fenceOver(store), { registration: { runtime } });
    const resumed = await fencedRun(fenceOver(store), { registration: { runtime } });

    expect(first.generates()).toBe(1);
    expect(resumed.generates()).toBe(1);
    const recorded = await store.get('g1');
    expect(recorded?.attempts).toHaveLength(1);
  });

  it('stops with zero steps when the goal ends or is canceled during the wait', async () => {
    const store = await liveGoal();
    const { runtime } = virtualRuntime(async () => {
      await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    });

    const { result, generates } = await fencedRun(fenceOver(store), { registration: { runtime } });

    expect(generates()).toBe(0);
    expect(result.finishReason).toBe('tripwire');
  });

  it('ends the wait promptly when the run is aborted during it', async () => {
    const base = createDefaultRuntimeServices();
    const controller = new AbortController();
    const runtime = {
      timers: {
        ...base.timers,
        // The abort lands as the wait begins; a wait that cannot be aborted would
        // sit out the hour-long delay below.
        setTimeout: (callback: () => void, milliseconds?: number) => {
          controller.abort();
          return base.timers.setTimeout(callback, milliseconds);
        },
      },
    };
    let reads = 0;
    const fence = fenceOver(await liveGoal());

    const { generates } = await fencedRun(
      {
        mayRun: (candidate) => {
          reads += 1;
          return fence.mayRun(candidate);
        },
      },
      { registration: { runtime, delaysMs: [3_600_000] }, signal: controller.signal },
    );

    expect(generates()).toBe(0);
    expect(reads).toBe(1);
  });

  it('polls for the open-attempt commit at its own short cadence, not at the read-error backoff', async () => {
    const store = await liveGoal();
    const { runtime, waits } = virtualRuntime(async (wait) => {
      if (wait === 3) await openAttempt(store);
    });

    const { generates } = await fencedRun(fenceOver(store), { registration: { runtime } });

    // The commit follows the start's return within milliseconds; a backoff that
    // grew to seconds would hold the first step of nearly every attempt.
    expect(waits).toEqual([50, 100, 250]);
    expect(generates()).toBe(1);
  });

  it('spends its budget by the monotonic clock when reads are slow, not only by the delays it waited', async () => {
    const store = await liveGoal();
    const { runtime } = virtualRuntime();
    let now = 0;
    let reads = 0;
    const fence = fenceOver(store);

    const { result, generates } = await fencedRun(
      {
        mayRun: async (candidate) => {
          reads += 1;
          // Every read takes half the budget.
          now += GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS / 2;
          return fence.mayRun(candidate);
        },
      },
      { registration: { runtime: { ...runtime, monotonic: { now: () => now } } } },
    );

    expect(generates()).toBe(0);
    expect(result.finishReason).toBe('tripwire');
    // Two readings spend the budget; waiting out its delays alone would have taken hundreds.
    expect(reads).toBeLessThanOrEqual(3);
  });

  it('counts the first read against the budget: a first read that outlasts it is not given a further wait', async () => {
    const store = await liveGoal();
    const { runtime, waits } = virtualRuntime();
    let now = 0;
    let reads = 0;
    const fence = fenceOver(store);

    const { result, generates } = await fencedRun(
      {
        mayRun: async (candidate) => {
          reads += 1;
          // The first read alone takes the whole budget.
          now += GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS;
          return fence.mayRun(candidate);
        },
      },
      { registration: { runtime: { ...runtime, monotonic: { now: () => now } } } },
    );

    expect(generates()).toBe(0);
    expect(result.finishReason).toBe('tripwire');
    expect(reads).toBe(1);
    expect(waits).toEqual([]);
  });

  it('does not spin on a zero delay: every wait spends part of the budget', async () => {
    const store = await liveGoal(undefined, { maximumAttempts: 2, maximumTotalDurationMs: 5 });
    const { runtime, waits } = virtualRuntime();

    const { result, generates } = await fencedRun(fenceOver(store), {
      registration: { runtime, acknowledgementDelaysMs: [0] },
    });

    expect(generates()).toBe(0);
    expect(result.finishReason).toBe('tripwire');
    expect(waits.every((wait) => wait >= 1)).toBe(true);
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(5);
  });

  it('is first in the composed plan, so an agent-tier compaction handler cannot decide for a step the goal does not allow', async () => {
    let compactions = 0;
    let agentDecisions = 0;
    const { generates } = await fencedRun(
      { mayRun: () => Promise.resolve(REFUSE) },
      {
        contextManagement: overThreshold(() => {
          compactions += 1;
        }),
        agentTier: (agent) => {
          agent.on('beforeCompaction', () => {
            agentDecisions += 1;
            return Promise.resolve(true);
          });
        },
      },
    );

    expect(agentDecisions).toBe(0);
    expect(compactions).toBe(0);
    expect(generates()).toBe(0);
  });
});
