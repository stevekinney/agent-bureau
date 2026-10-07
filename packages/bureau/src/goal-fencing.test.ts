/**
 * COR-851 — a start that has claimed its attempt's run but not yet created it
 * looks absent to every read from outside, and no check closes that window: the
 * engine's start takes no precondition on the claim. So a goal that ends over an
 * attempt (a cancellation, an exhausted duration, a failed start) tombstones the
 * attempt's claim before it looks for the run, and only a goal whose claims are
 * all tombstoned is allowed to be marked cleaned up. The run such a start goes
 * on to create takes no step (`goal-attempt-fence.test.ts`).
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { cancelGoal, settleCanceledGoal } from './goal-cancellation';
import { commitCancellation, type GoalControlDependencies } from './goal-controller';
import { recoverGoal, stopOvertakenRuns } from './goal-recovery';
import { createGoalState, goalTransitionId } from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import { createBureauGoals } from './goals';
import {
  dependencies,
  NOW,
  runningGoal,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

const MARKER = { requestedAt: NOW, reason: 'operator' };

async function exhaustedBeforeAnyAttempt(): Promise<GoalStore> {
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalDurationMs: 1000 },
      now: NOW,
    }),
  );
  await store.applyTransition({
    goalRunId: 'g1',
    seq: 1,
    transitionId: goalTransitionId('g1', 1),
    to: 'exhausted',
    at: NOW,
    cause: 'the aggregate duration elapsed',
    terminalReason: 'aggregate-budget-exceeded',
  });
  return store;
}

async function canceledBeforeAnyAttempt(): Promise<GoalStore> {
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalDurationMs: 1000 },
      now: NOW,
    }),
  );
  await store.requestCancellation('g1', MARKER, NOW);
  await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
  return store;
}

/** The control plane with one shared log of fences and stops, so the order between them is visible. */
function ordered(store: GoalStore, workflows: Record<string, string>, extra = {}) {
  const log: string[] = [];
  const { engine } = scriptedEngine({ workflows, finalizer: { status: 'succeeded' } });
  const built = dependencies(store, engine, {
    fenceAttempt: (record, attemptIndex) => {
      log.push(`fence:${record.goalRunId}-a${attemptIndex}`);
      return Promise.resolve('fenced');
    },
    cancelRun: (runId) => {
      log.push(`stop:${runId}`);
      return Promise.resolve({ status: 'requested' });
    },
    ...extra,
  });
  return { ...built, log };
}

const unfenceable: Partial<GoalControlDependencies> = {
  fenceAttempt: () => Promise.reject(new Error('claim storage is down')),
};

describe('cancel()', () => {
  it('fences the attempt’s claim before it stops the attempt’s run', async () => {
    const store = await runningGoal();
    const { control, log } = ordered(store, { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' });

    const outcome = await cancelGoal(control, (await store.get('g1'))!, { reason: 'stop' });

    expect(outcome).toMatchObject({ outcome: 'canceled' });
    expect(log).toEqual(['fence:g1-a0', 'stop:goal-g1-a0']);
  });

  it('fences the next attempt’s claim too, once the goal has moved past the one in flight', async () => {
    const store = await canceledBeforeAnyAttempt();
    const { control, log } = ordered(store, { 'goal:g1': 'cancelled' });

    await settleCanceledGoal(control, (await store.get('g1'))!);

    // Nothing was ever recorded, so the attempt a start was about to open is attempt 0.
    expect(log).toEqual(['fence:g1-a0', 'stop:goal-g1-a0']);
  });

  it('is pending on an attempt run, never canceled, when a claim could not be fenced', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
      finalizer: { status: 'succeeded' },
    });
    const { control, diagnostics } = dependencies(store, engine, unfenceable);

    const outcome = await cancelGoal(control, (await store.get('g1'))!, { reason: 'stop' });

    expect(outcome).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['attempt-run'],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
      'claim storage is down',
    );
  });
});

describe('recovering a canceled goal', () => {
  it('fences, then stops, and is settled only once the claim is tombstoned', async () => {
    const store = await canceledBeforeAnyAttempt();
    const { control, log } = ordered(store, { 'goal:g1': 'cancelled' });

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'already-terminal' });
    expect(log).toEqual(['fence:g1-a0', 'stop:goal-g1-a0']);
  });

  it('reports a canceled goal whose claim cannot be fenced as still waiting on its attempt run, never settled', async () => {
    const store = await canceledBeforeAnyAttempt();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled' },
      finalizer: { status: 'succeeded' },
    });
    const { control } = dependencies(store, engine, unfenceable);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['attempt-run'] });
  });

  it('completes a cancellation recorded as a marker by fencing the claim before the run', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', MARKER, NOW);
    const { control, log } = ordered(store, { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' });

    const entry = await recoverGoal(control, 'g1');

    expect(entry.outcome).toBe('canceled');
    expect(log).toEqual(['fence:g1-a0', 'stop:goal-g1-a0']);
  });
});

describe('the sweep of a goal whose ending may have overtaken a start', () => {
  it('fences the claim of a run that does not exist, which is the start that has claimed but not created it', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const { control, log } = ordered(store, { 'goal:g1': 'completed' });

    const entry = await stopOvertakenRuns(control, (await store.get('g1'))!);

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'already-terminal' });
    // No run to stop, and the claim is tombstoned all the same.
    expect(log).toEqual(['fence:g1-a0']);
  });

  it('fences before it looks for the run, and still stops a run that exists', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const { control, log } = ordered(store, { 'goal:g1': 'completed', 'goal-g1-a0': 'running' });

    await stopOvertakenRuns(control, (await store.get('g1'))!);

    expect(log).toEqual(['fence:g1-a0', 'stop:goal-g1-a0']);
  });

  it('is cleanup-pending, and stays owed, when a claim cannot be fenced', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const { control } = ordered(store, { 'goal:g1': 'completed' }, unfenceable);

    const entry = await stopOvertakenRuns(control, (await store.get('g1'))!);

    expect(entry).toMatchObject({
      outcome: 'cleanup-pending',
      detail: expect.stringContaining('claim storage is down'),
    });
  });
});

describe('closing a goal that ended over an attempt', () => {
  const goalsOver = (store: GoalStore, extra: Partial<GoalControlDependencies> = {}) => {
    const built = ordered(store, { 'goal:g1': 'completed' }, extra);
    const goals = createBureauGoals({
      ...built.control,
      runtime: { identifiers: undefined as never },
      resolveFreshAttemptSource: undefined,
      planAgent: () => undefined,
    });
    return { goals, ...built };
  };

  it('marks the goal cleaned up once the claim of the start it overtook is tombstoned', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const { goals, log } = goalsOver(store);

    const closed = await goals.close('g1');

    expect(closed).toMatchObject({ outcome: 'closed' });
    expect(log).toContain('fence:g1-a0');
    const after = await store.get('g1');
    expect(after?.closedAt).toBeDefined();
    expect(after?.cleanedUpAt).toBeDefined();
  });

  it('does not close, so the goal stays in the sweep, when the claim cannot be fenced', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const { goals } = goalsOver(store, unfenceable);

    const closed = await goals.close('g1');

    expect(closed).toMatchObject({
      outcome: 'cleanup-pending',
      detail: expect.stringContaining('claim storage is down'),
    });
    const after = await store.get('g1');
    expect(after?.closedAt).toBeUndefined();
    expect(after?.cleanedUpAt).toBeUndefined();
  });

  it('marks a canceled goal cleaned up only after its claim is tombstoned', async () => {
    const store = await canceledBeforeAnyAttempt();
    const { goals, log } = goalsOver(store);

    const closed = await goals.close('g1');

    expect(closed).toMatchObject({ outcome: 'closed' });
    expect(log.indexOf('fence:g1-a0')).toBeGreaterThanOrEqual(0);
    const after = await store.get('g1');
    expect(after?.cleanedUpAt).toBeDefined();
  });

  it('leaves a canceled goal open when its claim cannot be fenced', async () => {
    const store = await canceledBeforeAnyAttempt();
    const { goals } = goalsOver(store, unfenceable);

    const closed = await goals.close('g1');

    expect(closed).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['attempt-run'] });
    const after = await store.get('g1');
    expect(after?.closedAt).toBeUndefined();
  });
});
