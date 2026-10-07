/**
 * COR-851 — recovery and the controller guard decide on a record read before
 * several awaits. A cancellation (or an ending) that lands in that gap must be
 * honored by the start it would otherwise still make, and a result the guard
 * cannot read or the record cannot take must not read as success.
 */
import type { Validator } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { commitCancellation, ensureController } from './goal-controller';
import { recoverGoal } from './goal-recovery';
import { createGoalState } from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import type { GoalEngine } from './goal-types';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import {
  dependencies,
  NOW,
  runningGoal,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

const MARKER = { requestedAt: NOW, reason: 'operator' };

function startsOf(calls: readonly string[]): string[] {
  return calls.filter((call) => call.startsWith('start:'));
}

/** The scripted engine with `get` and `getFinalizerStatus` hooks that run inside recovery's awaits. */
function engineWithHooks(
  base: GoalEngine,
  hooks: { get?: () => Promise<void>; getFinalizerStatus?: () => Promise<void> },
  calls: string[],
): GoalEngine {
  return {
    ...base,
    get: async (id: string) => {
      await hooks.get?.();
      return base.get(id);
    },
    getFinalizerStatus: async (id: string) => {
      await hooks.getFinalizerStatus?.();
      return base.getFinalizerStatus(id);
    },
    start: (_type: string, _input: unknown, options?: { id?: string }) => {
      calls.push(`start:${options?.id ?? ''}`);
      return Promise.resolve();
    },
  } as unknown as GoalEngine;
}

describe('recovery when a cancellation lands between its read and its start', () => {
  it('starts no controller for a goal whose workflow was never found, and completes the cancellation', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({ workflows: { 'goal-g1-a0': 'cancelled' } });
    const hooked = engineWithHooks(
      engine,
      {
        get: async () => {
          await store.requestCancellation('g1', MARKER, NOW);
        },
      },
      calls,
    );
    const { control } = dependencies(store, hooked);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  it('starts no replacement controller and spends no restart for a goal canceled while its finalizer was read', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'cancelled' },
    });
    const hooked = engineWithHooks(
      engine,
      {
        getFinalizerStatus: async () => {
          await store.requestCancellation('g1', MARKER, NOW);
        },
      },
      calls,
    );
    const { control } = dependencies(store, hooked);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
    const unspent = await store.get('g1');
    expect(unspent?.controllerRestarts).toBe(0);
  });
});

describe('recovery when a cancellation lands between counting a restart and starting it', () => {
  it('starts no replacement controller and completes the cancellation', async () => {
    const store = await runningGoal();
    const racing: GoalStore = {
      ...store,
      recordControllerRestart: async (goalRunId, now, expectedCount) => {
        const counted = await store.recordControllerRestart(goalRunId, now, expectedCount);
        await store.requestCancellation(goalRunId, MARKER, NOW);
        return counted;
      },
    };
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'cancelled' },
    });
    const { control } = dependencies(racing, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
  });

  it('completes the cancellation instead of counting a restart when the marker landed before the count', async () => {
    const store = await runningGoal();
    const racing: GoalStore = {
      ...store,
      recordControllerRestart: async (goalRunId, now, expectedCount) => {
        await store.requestCancellation(goalRunId, MARKER, NOW);
        return store.recordControllerRestart(goalRunId, now, expectedCount);
      },
    };
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'cancelled' },
    });
    const { control } = dependencies(racing, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
    const unspent = await store.get('g1');
    expect(unspent?.controllerRestarts).toBe(0);
  });
});

describe('completing a cancellation another caller committed first', () => {
  it('settles the canceled goal instead of answering already-terminal without stopping anything', async () => {
    const store = await runningGoal();
    const racing: GoalStore = {
      ...store,
      requestCancellation: async (goalRunId, marker, now) => {
        // The goal ends canceled, with no marker, before this recovery's marker lands,
        // so the store refuses the marker of a goal that is already over.
        await commitCancellation(store, (await store.get(goalRunId))!, Date.parse(NOW));
        return store.requestCancellation(goalRunId, marker, now);
      },
    };
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
    });
    const { control, stopped } = dependencies(racing, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'canceled' });
    expect(stopped).toContain('goal-g1-a0');
  });
});

describe('the cleanup a closed goal owes', () => {
  it('is reported pending when recording it done did not land', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', MARKER, NOW);
    await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
    await store.close('g1', NOW);
    const lossy: GoalStore = {
      ...store,
      markCleanedUp: async (goalRunId) => ({
        status: 'stale',
        record: (await store.get(goalRunId))!,
      }),
    };
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
    });
    const { control } = dependencies(lossy, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cleanup-pending' });
    const unmarked = await store.get('g1');
    expect(unmarked?.cleanedUpAt).toBeUndefined();
  });
});

describe('ensureController when its guard cannot be trusted', () => {
  it('starts no controller for a goal whose record can no longer be read', async () => {
    const store = await runningGoal();
    const stale = (await store.get('g1'))!;
    const unreadable: GoalStore = { ...store, get: () => Promise.resolve(undefined) };
    const { engine, calls } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(unreadable, engine);

    const ensured = await ensureController(control, stale);

    expect(ensured.controller).toMatchObject({ status: 'start-failed' });
    expect(startsOf(calls)).toEqual([]);
  });

  it('starts no controller when a cancellation made the determinism failure it tried to record a rejection', async () => {
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    await store.create(
      createGoalState({
        goalRunId: 'g1',
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'worker', prompt: 'work' },
        validator: { name: 'check', version: '1' },
        requireDeterministicValidation: true,
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
        now: NOW,
      }),
    );
    const stale = (await store.get('g1'))!;
    const racing: GoalStore = {
      ...store,
      applyTransition: async (request) => {
        await store.requestCancellation('g1', MARKER, NOW);
        return store.applyTransition(request);
      },
    };
    const stochastic: Validator = {
      identity: { name: 'check', version: '1' },
      determinism: 'stochastic',
      validate: () => Promise.resolve({ kind: 'pass', evidence: [] }),
    };
    const { engine, calls } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(racing, engine, {
      catalog: createGoalValidatorCatalog([stochastic]),
    });

    const ensured = await ensureController(control, stale);

    expect(ensured.controller).toEqual({ status: 'not-needed' });
    expect(startsOf(calls)).toEqual([]);
  });
});
