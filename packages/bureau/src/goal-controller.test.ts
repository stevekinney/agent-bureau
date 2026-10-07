/**
 * COR-851 — what `ensureController` claims about a goal's controller, driven
 * with a scripted engine.
 */
import { WorkflowAlreadyExistsError } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { attemptIndexesToStop, commitCancellation, ensureController } from './goal-controller';
import type { GoalState } from './goal-state';
import type { GoalEngine } from './goal-types';
import {
  dependencies,
  NOW,
  runningGoal,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

function existingControllerEngine(status: string): GoalEngine {
  const { engine } = scriptedEngine({ workflows: { 'goal:g1': status } });
  return {
    ...engine,
    start: () => Promise.reject(new WorkflowAlreadyExistsError('goal:g1')),
  };
}

describe('ensureController', () => {
  it('says a controller that is already running is started', async () => {
    const store = await runningGoal();
    const record = (await store.get('g1'))!;
    const { control } = dependencies(store, existingControllerEngine('running'));

    const ensured = await ensureController(control, record);
    expect(ensured.controller).toEqual({ status: 'started' });
  });

  it.each(['failed', 'timed-out', 'completed', 'cancelled'])(
    'does not claim a controller that already ended %s is started, and points at recover()',
    async (status) => {
      const store = await runningGoal();
      const record = (await store.get('g1'))!;
      const { control } = dependencies(store, existingControllerEngine(status));

      const { controller } = await ensureController(control, record);

      expect(controller).toMatchObject({ status: 'start-failed' });
      expect(controller.status === 'start-failed' && controller.reason).toContain(status);
      expect(controller.status === 'start-failed' && controller.reason).toContain('recover()');
    },
  );

  // A cancel or a close can land while a caller awaited something else (a store
  // observer in `create`, a repeat's read), after it read the goal as running.
  describe('when the goal changed after the caller read it', () => {
    it('starts no controller for a goal whose cancellation is now recorded', async () => {
      const store = await runningGoal();
      const stale = (await store.get('g1'))!;
      await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
      const { engine, calls } = scriptedEngine({ workflows: {} });
      const { control } = dependencies(store, engine);

      const ensured = await ensureController(control, stale);

      expect(ensured.controller).toEqual({ status: 'not-needed' });
      expect(ensured.goal.cancellation).toBeDefined();
      expect(calls.filter((call) => call.startsWith('start:'))).toEqual([]);
    });

    it('starts no controller for a goal that has since ended', async () => {
      const store = await runningGoal();
      const stale = (await store.get('g1'))!;
      await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
      await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
      const { engine, calls } = scriptedEngine({ workflows: {} });
      const { control } = dependencies(store, engine);

      const ensured = await ensureController(control, stale);

      expect(ensured.controller).toEqual({ status: 'not-needed' });
      expect(ensured.goal.status).toBe('canceled');
      expect(calls.filter((call) => call.startsWith('start:'))).toEqual([]);
    });
  });
});

describe('attemptIndexesToStop', () => {
  const recordOf = (
    maximumAttempts: number,
    statuses: readonly ('running' | 'failed')[],
  ): GoalState =>
    ({
      goalRunId: 'g1',
      bounds: { maximumAttempts },
      attempts: statuses.map((status, attemptIndex) => ({ attemptIndex, status })),
    }) as unknown as GoalState;

  it('names the in-flight attempt, and the next one a start may have died short of committing', () => {
    expect(attemptIndexesToStop(recordOf(3, []))).toEqual([0]);
    expect(attemptIndexesToStop(recordOf(3, ['running']))).toEqual([0]);
    expect(attemptIndexesToStop(recordOf(3, ['failed']))).toEqual([1, 0]);
  });

  it('never names an index at or past the attempt bound, which no start can claim', () => {
    // An attempt-limit-reached goal has used every attempt: the next index is the
    // bound itself, and a tombstone for it would be a record nothing prunes.
    expect(attemptIndexesToStop(recordOf(2, ['failed', 'failed']))).toEqual([1]);
    expect(attemptIndexesToStop(recordOf(1, ['failed']))).toEqual([0]);
  });
});
