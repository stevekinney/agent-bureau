/**
 * COR-851 — what `cancel()` answers for, one fresh read at a time.
 *
 * `goals.test.ts` shows a real cancellation end to end. These tests drive
 * `cancelGoal` with a scripted engine so that each thing the read-back waits
 * for can be left unfinished in turn, and the answer is `cancellation-pending`
 * naming exactly that.
 */
import { describe, expect, it } from 'bun:test';

import { cancelGoal, runsToStop, settleCanceledGoal } from './goal-cancellation';
import { commitCancellation, type GoalControlDependencies } from './goal-controller';
import { type GoalState, goalTransitionId } from './goal-state';
import type { GoalStore } from './goal-store';
import {
  dependencies,
  NOW,
  runningGoal,
  type Script,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

const settled = { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' };

async function cancelWith(script: Script, extra: Partial<GoalControlDependencies> = {}) {
  const store = await runningGoal();
  const { engine, calls } = scriptedEngine(script);
  const { control, diagnostics, stopped } = dependencies(store, engine, extra);
  const record = (await store.get('g1'))!;
  const outcome = await cancelGoal(control, record, { principal: 'alice', reason: 'stop' });
  return { outcome, calls, diagnostics, stopped, store };
}

describe('runsToStop', () => {
  it('names no run for the index at the attempt bound, which no start can mint', async () => {
    const store = await runningGoal();
    const record = (await store.get('g1'))!;
    const [first] = record.attempts;
    // An exhausted goal at `maximumAttempts` (2): both attempts ended, so the
    // "next" attempt is index 2, a run id nothing ever starts.
    const exhausted = {
      ...record,
      status: 'exhausted' as const,
      attempts: [
        { ...first!, status: 'completed' as const },
        { ...first!, attemptIndex: 1, runId: 'goal-g1-a1', status: 'completed' as const },
      ],
    };
    expect(runsToStop(exhausted as unknown as GoalState)).toEqual(['goal-g1-a1']);
  });

  it('still names the next attempt for a goal with room to open one', async () => {
    const store = await runningGoal();
    const record = (await store.get('g1'))!;
    const [first] = record.attempts;
    const between = { ...record, attempts: [{ ...first!, status: 'completed' as const }] };
    expect(runsToStop(between as unknown as GoalState)).toEqual(['goal-g1-a1', 'goal-g1-a0']);
  });
});

describe('cancelGoal', () => {
  it('stays pending on the durable engine when the bureau has none, and never claims an acknowledgement', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: settled });
    const { control, stopped } = dependencies(store, engine, { getEngine: () => undefined });

    const outcome = await cancelGoal(control, (await store.get('g1'))!, { reason: 'stop' });

    expect(outcome).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['durable-engine'],
      goal: { status: 'canceled' },
    });
    // Nothing could be stopped, so nothing was attempted.
    expect(stopped).toEqual([]);

    // Asking again is no more able to acknowledge it.
    const again = await cancelGoal(control, (await store.get('g1'))!, {});
    expect(again).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['durable-engine'] });
  });

  it('answers canceled only when the record, the controller, the finalizer, and the attempt are all terminal', async () => {
    const { outcome, calls, stopped } = await cancelWith({ workflows: settled });

    expect(outcome).toMatchObject({ outcome: 'canceled', goal: { status: 'canceled' } });
    // Signal first, then the durable cancel, then the attempt's run is stopped.
    expect(calls).toEqual(['signal:goal:g1:cancel', 'cancel:goal:g1']);
    expect(stopped).toEqual(['goal-g1-a0']);
  });

  it('is pending on the controller while its workflow has not reached a terminal status', async () => {
    const { outcome, store } = await cancelWith({
      workflows: { ...settled, 'goal:g1': 'running' },
      cancelThrows: true,
    });

    expect(outcome).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['controller'] });
    // The marker is durable and the host committed the goal's end regardless.
    const goal = await store.get('g1');
    expect(goal).toMatchObject({
      status: 'canceled',
      cancellation: { principal: 'alice', reason: 'stop' },
    });
  });

  it.each([
    { label: 'pending', finalizer: { status: 'pending' } },
    { label: 'running', finalizer: { status: 'running' } },
  ])('is pending on the finalizer while it is $label', async ({ finalizer }) => {
    const { outcome } = await cancelWith({ workflows: settled, finalizer });

    expect(outcome).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['finalizer'] });
  });

  it('is pending on the finalizer when its status cannot be read', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: settled });
    const unreadable = {
      ...engine,
      getFinalizerStatus: () => Promise.reject(new Error('storage unavailable')),
    } as typeof engine;
    const { control } = dependencies(store, unreadable);

    const outcome = await cancelGoal(control, (await store.get('g1'))!, {});

    expect(outcome).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['finalizer'] });
  });

  it('reports a failed finalizer explicitly, with why, and never answers canceled', async () => {
    const { outcome, diagnostics, store } = await cancelWith({
      workflows: settled,
      finalizer: { status: 'failed', attempts: 3, error: 'run adapter unreachable' },
    });

    expect(outcome).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['finalizer-failed'],
    });
    const message = diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    expect(message).toContain('failed after 3 attempts');
    expect(message).toContain('run adapter unreachable');
    // The record still says canceled: only the world's agreement is in doubt.
    expect(await store.get('g1')).toMatchObject({ status: 'canceled' });
  });

  it('names a failed finalizer next to everything else that is unfinished', async () => {
    const { outcome } = await cancelWith({
      workflows: { 'goal:g1': 'running', 'goal-g1-a0': 'running' },
      finalizer: { status: 'failed', attempts: 1, error: 'boom' },
      cancelThrows: true,
    });

    expect(outcome).toMatchObject({
      awaiting: ['controller', 'finalizer-failed', 'attempt-run'],
    });
  });

  it('accepts a finalizer that has succeeded', async () => {
    const { outcome } = await cancelWith({
      workflows: settled,
      finalizer: { status: 'succeeded' },
    });

    expect(outcome.outcome).toBe('canceled');
  });

  it('is pending on the attempt while its run has not reached a terminal status, and says why it could not stop it', async () => {
    const { outcome, diagnostics } = await cancelWith(
      { workflows: { ...settled, 'goal-g1-a0': 'running' } },
      { cancelRun: () => Promise.resolve({ status: 'failed', error: new Error('engine busy') }) },
    );

    expect(outcome).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['attempt-run'] });
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('engine busy');
  });

  it('names everything that is unfinished, not only the first', async () => {
    const { outcome } = await cancelWith({
      workflows: { 'goal:g1': 'running', 'goal-g1-a0': 'running' },
      finalizer: { status: 'running' },
      cancelThrows: true,
    });

    expect(outcome).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['controller', 'finalizer', 'attempt-run'],
    });
  });

  it('treats a controller that already committed canceled as success, not a conflict', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({
      workflows: settled,
      // The cooperative controller wins the race: it commits `canceled` while the host's cancel is in flight.
      onCancel: async () => {
        const marked = (await store.get('g1'))!;
        await commitCancellation(store, marked, Date.parse(NOW));
      },
    });
    const { control } = dependencies(store, engine);

    const outcome = await cancelGoal(control, (await store.get('g1'))!, {});

    expect(outcome).toMatchObject({
      outcome: 'canceled',
      goal: { status: 'canceled', transitionSeq: 2 },
    });
    const record = await store.get('g1');
    expect(record?.attempts.map((attempt) => attempt.status)).toEqual(['aborted']);
  });

  it('changes nothing for a goal that ended for a reason other than cancellation', async () => {
    const store = await runningGoal();
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 2,
      transitionId: goalTransitionId('g1', 2),
      to: 'failed',
      at: NOW,
      cause: 'attempt run failed',
      terminalReason: 'attempt-run-failed',
      attempt: { ...(await store.get('g1'))!.attempts[0]!, status: 'failed' },
      active: null,
    });
    const ended = (await store.get('g1'))!;
    const { engine, calls } = scriptedEngine({ workflows: settled });
    const { control, stopped } = dependencies(store, engine);

    const outcome = await cancelGoal(control, ended, {});

    expect(outcome).toEqual({ outcome: 'already-terminal', goal: ended });
    expect(calls).toEqual([]);
    expect(stopped).toEqual([]);
    expect(await store.get('g1')).toEqual(ended);
  });

  describe('a goal whose cancellation is already committed', () => {
    async function canceledGoal(): Promise<GoalStore> {
      const store = await runningGoal();
      await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
      await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
      return store;
    }

    it('is still pending while the attempt it could not stop is running, and finishes the job when asked again', async () => {
      const store = await canceledGoal();
      const workflows: Record<string, string> = { ...settled, 'goal-g1-a0': 'running' };
      const { engine, calls } = scriptedEngine({ workflows });
      const failing = dependencies(store, engine, {
        cancelRun: () => Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
      });
      const ended = (await store.get('g1'))!;

      // The record says `canceled`, but the run is not read back as stopped.
      expect(await cancelGoal(failing.control, ended, {})).toMatchObject({
        outcome: 'cancellation-pending',
        awaiting: ['attempt-run'],
      });

      // The retry stops the run, and only then is the answer `canceled`.
      const retry = dependencies(store, engine, {
        cancelRun: (runId) => {
          workflows[runId] = 'cancelled';
          return Promise.resolve({ status: 'requested' });
        },
      });
      expect(await cancelGoal(retry.control, ended, {})).toMatchObject({ outcome: 'canceled' });
      // Its controller had already ended, so there was nothing to signal or cancel.
      expect(calls).toEqual([]);
      expect(await store.get('g1')).toEqual(ended);
    });

    it('reads the finalizer back on a retry after a restart: pending, then canceled once it succeeds', async () => {
      const store = await canceledGoal();
      const ended = (await store.get('g1'))!;

      // A fresh process: the controller already ended, the finalizer is still owed.
      const owed = scriptedEngine({ workflows: settled, finalizer: { status: 'pending' } });
      expect(await cancelGoal(dependencies(store, owed.engine).control, ended, {})).toMatchObject({
        outcome: 'cancellation-pending',
        awaiting: ['finalizer'],
      });

      const done = scriptedEngine({ workflows: settled, finalizer: { status: 'succeeded' } });
      expect(await cancelGoal(dependencies(store, done.engine).control, ended, {})).toMatchObject({
        outcome: 'canceled',
      });
      // Nothing to signal or cancel: the controller had already ended.
      expect(owed.calls).toEqual([]);
      expect(done.calls).toEqual([]);
    });

    it('reports a finalizer that failed before the restart, and does not retry it', async () => {
      const store = await canceledGoal();
      const failed = scriptedEngine({
        workflows: settled,
        finalizer: { status: 'failed', attempts: 5, error: 'dead-lettered' },
      });
      const { control, diagnostics } = dependencies(store, failed.engine);

      const outcome = await cancelGoal(control, (await store.get('g1'))!, {});

      expect(outcome).toMatchObject({
        outcome: 'cancellation-pending',
        awaiting: ['finalizer-failed'],
      });
      expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
        'dead-lettered',
      );
      expect(failed.calls).toEqual([]);
    });

    it('stops the run of the attempt that was in flight, not only the next one', async () => {
      const store = await canceledGoal();
      const { engine } = scriptedEngine({ workflows: settled });
      const { control, stopped } = dependencies(store, engine);

      await cancelGoal(control, (await store.get('g1'))!, {});

      expect(stopped).toEqual(['goal-g1-a1', 'goal-g1-a0']);
    });
  });

  it('says nothing was recorded when the marker write lost the race too many times', async () => {
    const store = await runningGoal();
    const record = (await store.get('g1'))!;
    const contended: GoalStore = {
      ...store,
      requestCancellation: () => Promise.resolve({ status: 'stale', record }),
    };
    const { engine, calls } = scriptedEngine({ workflows: settled });
    const { control, stopped } = dependencies(contended, engine);

    const outcome = await cancelGoal(control, record, {});

    expect(outcome).toEqual({ outcome: 'contended', goal: record });
    expect(calls).toEqual([]);
    expect(stopped).toEqual([]);
  });
});

describe('the read-back of a run it cannot read', () => {
  it('names the fault in a diagnostic, so a retry that cannot settle is not mistaken for one in progress', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: settled });
    const unreadable = {
      ...engine,
      get: (id: string) =>
        id === 'goal-g1-a0'
          ? Promise.reject(new Error('run record goal-g1-a0 is corrupt'))
          : (engine.get as (id: string) => Promise<unknown>)(id),
    } as unknown as typeof engine;
    const { control, diagnostics } = dependencies(store, unreadable);

    const outcome = await cancelGoal(control, (await store.get('g1'))!, {});

    expect(outcome).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['attempt-run'],
    });
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
      'run record goal-g1-a0 is corrupt',
    );
  });
});

describe('the read-back of a record that vanished', () => {
  /** A canceled goal whose record the fresh read no longer finds. */
  async function vanished(unreadable: boolean) {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: settled });
    const first = dependencies(store, engine);
    await cancelGoal(first.control, (await store.get('g1'))!, {});
    const canceled = (await store.get('g1'))!;
    expect(canceled.status).toBe('canceled');
    const gone: GoalStore = {
      ...store,
      get: () => Promise.resolve(undefined),
      isUnreadable: () => Promise.resolve(unreadable),
    };
    return { canceled, ...dependencies(gone, engine) };
  }

  it('does not acknowledge a cancellation it cannot find the record for: missing reads not-found', async () => {
    const { canceled, control } = await vanished(false);

    expect(await settleCanceledGoal(control, canceled)).toEqual({ outcome: 'not-found' });
    expect(await cancelGoal(control, canceled, {})).toEqual({ outcome: 'not-found' });
  });

  it('reports the record fault when the record no longer decodes, and hides it from a scoped caller', async () => {
    const { canceled, control } = await vanished(true);

    expect(await settleCanceledGoal(control, canceled)).toEqual({ outcome: 'record-unreadable' });
    expect(await settleCanceledGoal(control, canceled, { scoped: true })).toEqual({
      outcome: 'not-found',
    });
  });
});
