/**
 * COR-851 — `close()` reports what it could record. Once the checkpoint cleanup
 * is done the goal is marked `cleanedUpAt`; a mark that did not land must not
 * read as a closure whose cleanup succeeded, since nothing would retry it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createGoalState } from './goal-state';
import { createGoalStore, type GoalControlResult, type GoalStore } from './goal-store';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { createBureauGoals } from './goals';
import { dependencies, NOW, scriptedEngine } from './testing/goal-control-fixtures.test-support';

async function failedGoal(): Promise<GoalStore> {
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
      now: NOW,
    }),
  );
  await store.applyTransition({
    goalRunId: 'g1',
    seq: 1,
    transitionId: 'g1:t1',
    to: 'failed',
    at: NOW,
    cause: 'fail: unsupported-validation',
    terminalReason: 'unsupported-validation',
  });
  return store;
}

function goalsOver(store: GoalStore) {
  const { engine } = scriptedEngine({ workflows: {} });
  const { control } = dependencies(store, engine);
  return createBureauGoals({
    ...control,
    runtime: createManualRuntimeServices(),
    resolveFreshAttemptSource: undefined,
    planAgent: () => ({ durable: true, agentVersion: '1' }),
    catalog: createGoalValidatorCatalog([]),
  });
}

describe('close() when the cleanup is done but cannot be recorded', () => {
  it('reads as closed with its cleanup done when the mark lands', async () => {
    const store = await failedGoal();

    const closed = await goalsOver(store).close('g1');

    expect(closed).toMatchObject({ outcome: 'closed', cleanup: { status: 'not-required' } });
    const stored = await store.get('g1');
    expect(stored?.cleanedUpAt).toBeDefined();
  });

  it.each([
    ['rejected', 'cleanup-pending'],
    ['stale', 'cleanup-pending'],
  ] as const)(
    'is cleanup-pending, not closed, when the mark is %s, so a later close() or boot retries it',
    async (status, outcome) => {
      const store = await failedGoal();
      const record = (await store.get('g1'))!;
      const marking = {
        ...store,
        markCleanedUp: (): Promise<GoalControlResult> =>
          Promise.resolve(
            status === 'rejected' ? { status, reason: 'not-closed', record } : { status, record },
          ),
      };

      const closed = await goalsOver(marking).close('g1');

      expect(closed).toMatchObject({ outcome });
      expect(closed.outcome === 'cleanup-pending' ? closed.detail : '').toContain(status);
    },
  );

  it('is not-found when the record is gone by the time the mark is written', async () => {
    const store = await failedGoal();
    const marking = {
      ...store,
      markCleanedUp: (): Promise<GoalControlResult> => Promise.resolve({ status: 'missing' }),
    };

    expect(await goalsOver(marking).close('g1')).toEqual({ outcome: 'not-found' });
  });

  it('is record-unreadable when the record no longer decodes by the time the mark is written', async () => {
    const store = await failedGoal();
    const marking = {
      ...store,
      markCleanedUp: (): Promise<GoalControlResult> => Promise.resolve({ status: 'corrupt' }),
    };

    expect(await goalsOver(marking).close('g1')).toEqual({ outcome: 'record-unreadable' });
    expect(await goalsOver(marking).close('g1', { principal: 'someone' })).toEqual({
      outcome: 'not-found',
    });
  });
});
