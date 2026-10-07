/**
 * COR-851 — closing an exhausted goal first stops the run its ending may have
 * overtaken. A closed, cleaned goal leaves the boot sweep, which is what stops
 * such a run after a crash, so `close()` must not strand one.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { GoalControlDependencies } from './goal-controller';
import { recoverGoal, recoveryEntryFailure } from './goal-recovery';
import { createGoalState, goalTransitionId } from './goal-state';
import { createGoalStore } from './goal-store';
import { createBureauGoals } from './goals';
import { dependencies, NOW, scriptedEngine } from './testing/goal-control-fixtures.test-support';

async function exhaustedBeforeAnyAttempt(ending: 'exhausted' | 'failed' = 'exhausted') {
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
  const result = await store.applyTransition(
    ending === 'failed'
      ? {
          goalRunId: 'g1',
          seq: 1,
          transitionId: goalTransitionId('g1', 1),
          to: 'failed',
          at: NOW,
          cause: 'fail: attempt-run-failed',
          terminalReason: 'attempt-run-failed',
          failureDetail: 'Starting the inner run failed: a catalog fault',
        }
      : {
          goalRunId: 'g1',
          seq: 1,
          transitionId: goalTransitionId('g1', 1),
          to: 'exhausted',
          at: NOW,
          cause: 'the aggregate duration elapsed',
          terminalReason: 'aggregate-budget-exceeded',
        },
  );
  expect(result.status).toBe('applied');
  return store;
}

function goalsOver(
  store: Awaited<ReturnType<typeof exhaustedBeforeAnyAttempt>>,
  workflows: Record<string, string>,
  cancelRun: GoalControlDependencies['cancelRun'],
) {
  const { engine } = scriptedEngine({ workflows, finalizer: { status: 'succeeded' } });
  const { control } = dependencies(store, engine, { cancelRun });
  return createBureauGoals({
    ...control,
    runtime: { identifiers: undefined as never },
    resolveFreshAttemptSource: undefined,
    planAgent: () => undefined,
  });
}

describe('closing an exhausted goal whose ending overtook an attempt start', () => {
  it('stops the run it left behind before closing, so the sweep need not', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const workflows: Record<string, string> = { 'goal:g1': 'completed', 'goal-g1-a0': 'running' };
    const stopped: string[] = [];
    const goals = goalsOver(store, workflows, (runId) => {
      stopped.push(runId);
      workflows[runId] = 'cancelled';
      return Promise.resolve({ status: 'requested' });
    });

    const closed = await goals.close('g1');

    expect(stopped).toEqual(['goal-g1-a0']);
    expect(closed).toMatchObject({ outcome: 'closed', goal: { status: 'exhausted' } });
    const after = await store.get('g1');
    expect(after?.closedAt).toBeDefined();
  });

  it('stops the run a start-failure ending left behind before closing a failed goal', async () => {
    const store = await exhaustedBeforeAnyAttempt('failed');
    const workflows: Record<string, string> = { 'goal:g1': 'completed', 'goal-g1-a0': 'running' };
    const stopped: string[] = [];
    const goals = goalsOver(store, workflows, (runId) => {
      stopped.push(runId);
      workflows[runId] = 'cancelled';
      return Promise.resolve({ status: 'requested' });
    });

    expect(await goals.close('g1')).toMatchObject({
      outcome: 'closed',
      goal: { status: 'failed' },
    });
    expect(stopped).toEqual(['goal-g1-a0']);
  });

  it('leaves the goal open, and in the sweep, when the run cannot be stopped', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const goals = goalsOver(store, { 'goal:g1': 'completed', 'goal-g1-a0': 'running' }, () =>
      Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
    );

    const closed = await goals.close('g1');

    expect(closed).toMatchObject({
      outcome: 'cleanup-pending',
      goal: { status: 'exhausted' },
      detail: expect.stringContaining('engine busy'),
    });
    const after = await store.get('g1');
    expect(after?.closedAt).toBeUndefined();
  });

  it('closes a goal with nothing to stop without touching any run', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const stopped: string[] = [];
    const goals = goalsOver(store, { 'goal:g1': 'completed' }, (runId) => {
      stopped.push(runId);
      return Promise.resolve({ status: 'requested' });
    });

    expect(await goals.close('g1')).toMatchObject({ outcome: 'closed' });
    expect(stopped).toEqual([]);
  });
});

describe('an exhausted goal when no durable engine can look for the run its ending overtook', () => {
  const engineless = (store: Awaited<ReturnType<typeof exhaustedBeforeAnyAttempt>>) => {
    const { engine } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(store, engine, { getEngine: () => undefined });
    return control;
  };

  it('is reported cleanup-pending by recovery, a failure in the boot report, never already-terminal', async () => {
    const store = await exhaustedBeforeAnyAttempt();

    const entry = await recoverGoal(engineless(store), 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cleanup-pending' });
    expect(recoveryEntryFailure(entry)).toContain('no durable engine');
  });

  it('is not closed over, so it stays in the sweep', async () => {
    const store = await exhaustedBeforeAnyAttempt();
    const goals = createBureauGoals({
      ...engineless(store),
      runtime: { identifiers: undefined as never },
      resolveFreshAttemptSource: undefined,
      planAgent: () => undefined,
    });

    expect(await goals.close('g1')).toMatchObject({ outcome: 'cleanup-pending' });
    const after = await store.get('g1');
    expect(after?.closedAt).toBeUndefined();
  });
});
