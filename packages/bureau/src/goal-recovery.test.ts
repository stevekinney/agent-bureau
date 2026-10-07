/**
 * COR-851 — what `recoverGoal` decides, driven with a scripted engine so that
 * each state the controller and the attempt's run can be found in is set
 * directly. `goals-recovery.test.ts` shows the same recovery across real
 * process restarts.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { Validator } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, WorkflowTeardownPendingError } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS } from './goal-attempt-fence';
import { commitCancellation, type GoalControlDependencies } from './goal-controller';
import {
  GOAL_BOOT_SWEEP_BUDGET_MS,
  MAXIMUM_CONTROLLER_RESTARTS,
  recoverEveryGoal,
  recoverGoal,
  recoverGoalsAtBoot,
  recoveryEntryFailure,
} from './goal-recovery';
import { createGoalState, goalRecordKey, type GoalState, goalTransitionId } from './goal-state';
import { createGoalStore } from './goal-store';
import type { GoalEngine } from './goal-types';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import {
  dependencies,
  NOW,
  runningGoal,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

function validator(determinism: 'deterministic' | 'stochastic'): Validator {
  return {
    identity: { name: 'check', version: '1' },
    determinism,
    validate: () => Promise.resolve({ kind: 'pass', evidence: [] }),
  };
}

/** The scripted engine, with `start` and `get` replaced so a test sees and shapes them. */
function engineWith(
  base: GoalEngine,
  overrides: {
    get?: GoalEngine['get'];
    start?: (...args: unknown[]) => Promise<unknown>;
    signal?: (...args: unknown[]) => Promise<unknown>;
    getFinalizerStatus?: (...args: unknown[]) => Promise<unknown>;
  },
): GoalEngine {
  return { ...base, ...overrides } as unknown as GoalEngine;
}

describe('completing a cancellation', () => {
  async function recoverCanceled(
    attemptRun: string,
    cancelRun: GoalControlDependencies['cancelRun'],
  ) {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': attemptRun },
    });
    const { control, diagnostics } = dependencies(store, engine, { cancelRun });
    const entry = await recoverGoal(control, 'g1');
    return { entry, diagnostics, store };
  }

  it('is pending, not canceled, while the attempt it could not stop is still running', async () => {
    const { entry, diagnostics, store } = await recoverCanceled('running', () =>
      Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
    );

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cancellation-pending' });
    expect(entry.detail).toContain('attempt-run');
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('engine busy');
    // The record was committed regardless: the marker is authoritative.
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  it('is canceled once the read finds the attempt stopped', async () => {
    const { entry } = await recoverCanceled('cancelled', () =>
      Promise.resolve({ status: 'requested' }),
    );

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'canceled' });
  });
});

describe('a suspended controller', () => {
  it('is resumed when no cancellation was asked for', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'suspended', 'goal-g1-a0': 'running' },
    });
    const { control } = dependencies(store, engine);

    expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'running' });

    expect(calls).toContain('resume:goal:g1');
    expect(calls).not.toContain('cancel:goal:g1');
  });

  it('is cancelled, not resumed, when the process died after marking a cancellation and before acting on it', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const workflows: Record<string, string> = {
      'goal:g1': 'suspended',
      'goal-g1-a0': 'running',
    };
    const { engine, calls } = scriptedEngine({
      workflows,
      // The cancel ends the workflow; the run is stopped through `cancelRun`.
      onCancel: () => {
        workflows['goal:g1'] = 'cancelled';
        return Promise.resolve();
      },
    });
    const stopped: string[] = [];
    const { control } = dependencies(store, engine, {
      cancelRun: (runId) => {
        stopped.push(runId);
        workflows[runId] = 'cancelled';
        return Promise.resolve({ status: 'requested' });
      },
    });

    const entry = await recoverGoal(control, 'g1');

    // A resumed controller would re-park on an attempt signal the marker never sends.
    expect(calls).not.toContain('resume:goal:g1');
    expect(calls).toContain('cancel:goal:g1');
    expect(stopped).toContain('goal-g1-a0');
    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'canceled' });
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  it('stays pending on the controller when a marked cancellation cannot end it', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'suspended', 'goal-g1-a0': 'cancelled' },
      cancelThrows: true,
    });
    const { control } = dependencies(store, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ outcome: 'cancellation-pending' });
    expect(entry.detail).toContain('controller');
  });
});

describe('a goal whose cancellation committed but whose cleanup is still owed', () => {
  async function committedCanceled() {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const marked = (await store.get('g1'))!;
    await commitCancellation(store, marked, Date.parse(NOW));
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
    return store;
  }

  it('is driven to settlement by recover(), not reported already terminal', async () => {
    const store = await committedCanceled();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'running', 'goal-g1-a0': 'running' },
    });
    const { control, stopped } = dependencies(store, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cancellation-pending' });
    expect(entry.detail).toContain('controller');
    expect(calls).toContain('cancel:goal:g1');
    expect(stopped).toContain('goal-g1-a0');
  });

  it('is already terminal once the controller, finalizer, and attempt have all settled', async () => {
    const store = await committedCanceled();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
      finalizer: { status: 'succeeded' },
    });
    const { control } = dependencies(store, engine);

    expect(await recoverGoal(control, 'g1')).toEqual({
      goalRunId: 'g1',
      outcome: 'already-terminal',
    });
    expect(calls).toEqual([]);
  });

  it('leaves a settled canceled goal out of the sweep report, like any other ended goal', async () => {
    const store = await committedCanceled();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
      finalizer: { status: 'succeeded' },
    });
    const { control } = dependencies(store, engine);

    expect(await recoverEveryGoal(control)).toEqual({ goals: [], failures: [] });
  });

  it('is included in the boot sweep, which finishes the cleanup', async () => {
    const store = await committedCanceled();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'running', 'goal-g1-a0': 'running' },
    });
    const { control } = dependencies(store, engine);

    const report = await recoverEveryGoal(control);

    expect(report.goals.map((entry) => [entry.goalRunId, entry.outcome])).toEqual([
      ['g1', 'cancellation-pending'],
    ]);
    expect(calls).toContain('cancel:goal:g1');
  });
});

/** A goal that ended `exhausted` (its aggregate duration) or `canceled` with no attempt ever recorded. */
async function endedBeforeAnyAttempt(
  status: 'exhausted' | 'canceled' | 'failed',
  closure: {
    readonly closed?: boolean;
    readonly cleanedUp?: boolean;
    readonly runFailed?: boolean;
  } = {},
) {
  const kv = textValueStore(new MemoryStorage());
  const store = createGoalStore(kv);
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
  if (status === 'canceled') {
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
  } else {
    const result = await store.applyTransition(
      status === 'failed'
        ? {
            goalRunId: 'g1',
            seq: 1,
            transitionId: goalTransitionId('g1', 1),
            to: 'failed',
            at: NOW,
            cause: 'fail: attempt-run-failed',
            terminalReason: 'attempt-run-failed',
            failureDetail:
              closure.runFailed === true
                ? 'The inner run rejected: boom'
                : 'Starting the inner run failed: a catalog fault',
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
  }
  if (closure.closed === true) await store.close('g1', NOW);
  if (closure.cleanedUp === true) await store.markCleanedUp('g1', NOW);
  return store;
}

describe('a goal that ended while its next attempt was still starting', () => {
  // The start claimed the run and was abandoned when the deadline (or a
  // cancellation) won; the late start created the run anyway and the process
  // died before the start's own stand-down check could stop it. The goal is
  // terminal, so nothing else will ever name that run: boot stops it.
  it.each(['exhausted', 'canceled', 'failed'] as const)(
    'stops the run it left behind at boot, for a goal %s',
    async (status) => {
      const store = await endedBeforeAnyAttempt(status);
      const workflows: Record<string, string> = { 'goal:g1': 'completed', 'goal-g1-a0': 'running' };
      const { engine } = scriptedEngine({ workflows, finalizer: { status: 'succeeded' } });
      const stopped: string[] = [];
      const { control } = dependencies(store, engine, {
        cancelRun: (runId) => {
          stopped.push(runId);
          workflows[runId] = 'cancelled';
          return Promise.resolve({ status: 'requested' });
        },
      });

      const report = await recoverEveryGoal(control);

      expect(stopped).toEqual(['goal-g1-a0']);
      expect(report).toEqual({ goals: [], failures: [] });
      const after = await store.get('g1');
      expect(after?.status).toBe(status);
    },
  );

  it('does not sweep a goal that failed for a reason no start can be behind', async () => {
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
      to: 'failed',
      at: NOW,
      cause: 'fail: unsupported-validation',
      terminalReason: 'unsupported-validation',
    });
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'running' },
    });
    const { control, stopped } = dependencies(store, engine);

    expect(await recoverEveryGoal(control)).toEqual({ goals: [], failures: [] });
    expect(stopped).toEqual([]);
  });

  it('does not sweep a goal whose started run failed, which no start can be behind', async () => {
    const store = await endedBeforeAnyAttempt('failed', { runFailed: true });
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'running' },
    });
    const { control, stopped } = dependencies(store, engine);

    expect(await recoverEveryGoal(control)).toEqual({ goals: [], failures: [] });
    expect(stopped).toEqual([]);
  });

  it('leaves a run that has already ended alone', async () => {
    const store = await endedBeforeAnyAttempt('exhausted');
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'cancelled' },
    });
    const { control, stopped } = dependencies(store, engine);

    expect(await recoverEveryGoal(control)).toEqual({ goals: [], failures: [] });
    expect(stopped).toEqual([]);
  });

  it('touches nothing once the goal is closed and its cleanup is recorded', async () => {
    const store = await endedBeforeAnyAttempt('exhausted', { closed: true, cleanedUp: true });
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'running' },
    });
    const { control, stopped } = dependencies(store, engine);

    expect(await recoverEveryGoal(control)).toEqual({ goals: [], failures: [] });
    expect(stopped).toEqual([]);
  });

  it('is stopped by recover(id) too', async () => {
    const store = await endedBeforeAnyAttempt('exhausted');
    const workflows: Record<string, string> = { 'goal:g1': 'completed', 'goal-g1-a0': 'running' };
    const { engine } = scriptedEngine({ workflows });
    const stopped: string[] = [];
    const { control } = dependencies(store, engine, {
      cancelRun: (runId) => {
        stopped.push(runId);
        workflows[runId] = 'cancelled';
        return Promise.resolve({ status: 'requested' });
      },
    });

    expect(await recoverGoal(control, 'g1')).toEqual({
      goalRunId: 'g1',
      outcome: 'already-terminal',
    });
    expect(stopped).toEqual(['goal-g1-a0']);
  });

  it('is a failure of the boot, kept for the next one, when the run cannot be stopped', async () => {
    const store = await endedBeforeAnyAttempt('exhausted');
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'running' },
    });
    const { control, diagnostics } = dependencies(store, engine, {
      cancelRun: () => Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
    });

    const report = await recoverEveryGoal(control);

    expect(report.goals).toEqual([
      {
        goalRunId: 'g1',
        outcome: 'cleanup-pending',
        detail: expect.stringContaining('engine busy'),
      },
    ]);
    expect(recoveryEntryFailure(report.goals[0]!)).toContain('engine busy');
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('engine busy');
    // Not closed, so the next sweep tries again.
    expect(await recoverEveryGoal(control)).toMatchObject({
      goals: [{ outcome: 'cleanup-pending' }],
    });
  });

  it('reports a run whose canceller has no capability as one that could not be stopped, with a diagnostic, not as nothing', async () => {
    const store = await endedBeforeAnyAttempt('exhausted');
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'running' },
    });
    const { control, diagnostics } = dependencies(store, engine, {
      cancelRun: () => Promise.resolve({ status: 'unsupported-capability' }),
    });

    const report = await recoverEveryGoal(control);

    expect(report.goals).toEqual([
      {
        goalRunId: 'g1',
        outcome: 'cleanup-pending',
        detail: expect.stringContaining('could not be stopped'),
      },
    ]);
    expect(report.goals[0]?.detail).toContain('goal-g1-a0');
    expect(report.goals[0]?.detail).toContain('unsupported-capability');
    expect(
      diagnostics.some(
        (diagnostic) => diagnostic.level === 'error' && diagnostic.message.includes('goal-g1-a0'),
      ),
    ).toBe(true);
  });
});

describe('a closed goal whose cleanup could not be finished by this recovery', () => {
  const closedFailedGoal = async () => {
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
    await store.close('g1', NOW);
    return store;
  };

  it.each([
    [
      'a part that failed to prune',
      () => Promise.resolve({ status: 'failed' as const, error: new Error('storage hiccup') }),
      'storage hiccup',
    ],
    [
      'a part that could not be reached',
      () => Promise.resolve({ status: 'unresolved' as const, reason: 'timed-out' as const }),
      'timed-out',
    ],
  ])('is reported as pending, not already terminal: %s', async (_name, cleanupWorkflow, detail) => {
    const store = await closedFailedGoal();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'failed' },
    });
    const { control } = dependencies(store, engine, { cleanupWorkflow });

    const entry = await recoverGoal(control, 'g1');
    const report = await recoverEveryGoal(control);

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cleanup-pending' });
    expect(entry.detail).toContain(detail);
    expect(report.goals.map((reported) => reported.outcome)).toEqual(['cleanup-pending']);
    expect(recoveryEntryFailure(entry)).toContain(detail);
    const stored = await store.get('g1');
    expect(stored?.cleanedUpAt).toBeUndefined();
  });

  it('is pending when there is no engine to prune with', async () => {
    const store = await closedFailedGoal();
    const { control } = dependencies(store, undefined as never, { getEngine: () => undefined });

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ outcome: 'cleanup-pending' });
    expect(entry.detail).toContain('durable engine');
    expect(recoveryEntryFailure(entry)).toBeDefined();
  });

  it('is already terminal, and recorded as cleaned up, once everything is pruned', async () => {
    const store = await closedFailedGoal();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'completed', 'goal-g1-a0': 'failed' },
    });
    const { control } = dependencies(store, engine);

    expect(await recoverGoal(control, 'g1')).toEqual({
      goalRunId: 'g1',
      outcome: 'already-terminal',
    });
    const stored = await store.get('g1');
    expect(stored?.cleanedUpAt).toBeDefined();
  });
});

describe('a goal that was recorded but never started', () => {
  async function pendingStore(validatorDeterminism: 'deterministic' | 'stochastic') {
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
    const catalog = createGoalValidatorCatalog([validator(validatorDeterminism)]);
    return { store, catalog };
  }

  it('is ended unsupported-validation by recovery, and no controller is started for it', async () => {
    const { store, catalog } = await pendingStore('stochastic');
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
      { catalog },
    );

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'unsupported-validation' });
    expect(await store.get('g1')).toMatchObject({
      status: 'failed',
      terminalReason: 'unsupported-validation',
      attempts: [],
    });
    expect(started).toEqual([]);
  });

  it('is started when its validator does supply the evidence it requires', async () => {
    const { store, catalog } = await pendingStore('deterministic');
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
      { catalog },
    );

    expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'started' });
    expect(started).toHaveLength(1);
    const untouched = await store.get('g1');
    expect(untouched?.status).toBe('pending');
  });
});

describe('restarting a controller that ended abnormally', () => {
  it('counts one restart when two recoveries saw the same ended controller, and starts one controller', async () => {
    const store = await runningGoal();
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'failed' } });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
    );

    const [first, second] = await Promise.all([
      recoverGoal(control, 'g1'),
      recoverGoal(control, 'g1'),
    ]);

    expect([first.outcome, second.outcome].toSorted()).toEqual(['restarted', 'running']);
    const counted = await store.get('g1');
    expect(counted?.controllerRestarts).toBe(1);
    expect(started).toHaveLength(1);
  });

  it('does not spend a restart while the ended controller still owes its finalizer', async () => {
    const store = await runningGoal();
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'failed' },
      finalizer: { status: 'pending', attempts: 0 },
    });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
    );

    const entry = await recoverGoal(control, 'g1');

    // Nothing re-triggers the restart once the finalizer settles, so this is not
    // `running`: a goal with no controller must not read as one that has it.
    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'restart-pending' });
    expect(entry.detail).toContain('finalizer');
    expect(started).toEqual([]);
    const unspent = await store.get('g1');
    expect(unspent?.controllerRestarts).toBe(0);
  });

  it('answers running, never throws, when Weft refuses the restart for a teardown that began after the check', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'failed' } });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: () => Promise.reject(new WorkflowTeardownPendingError('goal:g1')),
      }),
    );

    expect(await recoverGoal(control, 'g1')).toMatchObject({
      goalRunId: 'g1',
      outcome: 'restart-pending',
    });
  });

  it('spends no restart, and says the restart is pending, when the finalizer cannot be read', async () => {
    const store = await runningGoal();
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'failed' } });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        getFinalizerStatus: () => Promise.reject(new Error('finalizer read fault')),
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
    );

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'restart-pending' });
    expect(entry.detail).toContain('finalizer read fault');
    expect(started).toEqual([]);
    const unspent = await store.get('g1');
    expect(unspent?.controllerRestarts).toBe(0);
  });

  it('reports the goal unrecoverable, not already terminal, when its audit log has no room for the restart', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'failed' } });
    const full = {
      ...store,
      recordControllerRestart: async () => ({
        status: 'rejected' as const,
        reason: 'audit-log-full' as const,
        record: (await store.get('g1'))!,
      }),
    };
    const { control } = dependencies(full, engineWith(engine, { start: () => Promise.resolve() }));

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
    expect(entry.detail).toContain('audit log');
  });

  describe('the final permitted restart, counted but not yet started', () => {
    const countedAt = Date.parse(NOW);

    async function spent() {
      const store = await runningGoal();
      for (let restart = 0; restart < MAXIMUM_CONTROLLER_RESTARTS; restart += 1) {
        const counted = await store.recordControllerRestart('g1', NOW, restart);
        expect(counted.status).toBe('updated');
      }
      return store;
    }

    /** The old, ended controller: it predates the newest count, so that restart has not started. */
    const endedBefore = (createdAt: number) =>
      engineWith(scriptedEngine({ workflows: { 'goal-g1-a0': 'running' } }).engine, {
        get: ((id: string) =>
          Promise.resolve(
            id === 'goal:g1' ? { id, status: 'failed', createdAt } : { id, status: 'running' },
          )) as unknown as GoalEngine['get'],
      });

    it('is in progress, not unrecoverable, so a second recovery does not fence the attempt the first is about to start under', async () => {
      const store = await spent();
      const { control, fenced, stopped } = dependencies(store, endedBefore(countedAt - 60_000));

      const entry = await recoverGoal(control, 'g1');

      expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'restart-pending' });
      expect(entry.detail).toContain('counted');
      expect(recoveryEntryFailure(entry)).toContain('counted');
      expect(fenced).toEqual([]);
      expect(stopped).toEqual([]);
    });

    it('lets the counting recovery finish its restart when another read the count mid-restart', async () => {
      const store = await runningGoal();
      for (let restart = 0; restart < MAXIMUM_CONTROLLER_RESTARTS - 1; restart += 1) {
        await store.recordControllerRestart('g1', NOW, restart);
      }
      const workflows: Record<string, string> = { 'goal:g1': 'failed', 'goal-g1-a0': 'running' };
      const base = scriptedEngine({ workflows });
      const starts: string[] = [];
      let counted!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => (counted = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const engine = engineWith(base.engine, {
        get: ((id: string) =>
          Promise.resolve(
            id === 'goal:g1'
              ? { id, status: workflows[id], createdAt: countedAt - 60_000 }
              : { id, status: workflows[id] },
          )) as unknown as GoalEngine['get'],
        start: (_type, _input, options) => {
          starts.push((options as { id?: string }).id ?? '');
          workflows['goal:g1'] = 'running';
          return Promise.resolve();
        },
      });
      const counting = {
        ...store,
        recordControllerRestart: async (
          ...args: Parameters<typeof store.recordControllerRestart>
        ) => {
          const result = await store.recordControllerRestart(...args);
          counted();
          await gate;
          return result;
        },
      };
      const first = dependencies(counting, engine);
      const second = dependencies(store, engine);

      const recovering = recoverGoal(first.control, 'g1');
      await paused;
      const midway = await store.get('g1');
      expect(midway?.controllerRestarts).toBe(MAXIMUM_CONTROLLER_RESTARTS);
      const overlapped = await recoverGoal(second.control, 'g1');
      release();
      const finished = await recovering;

      expect(overlapped).toMatchObject({ outcome: 'restart-pending' });
      expect(second.fenced).toEqual([]);
      expect(finished).toMatchObject({ outcome: 'restarted' });
      expect(starts).toEqual(['goal:g1']);
      expect(first.fenced).toEqual([]);
    });

    it('is given up on once the restart has been pending past its grace, as when the counting recovery crashed', async () => {
      const store = await spent();
      const later = countedAt + GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS + 1;
      const { control, fenced } = dependencies(store, endedBefore(countedAt - 60_000), {
        clock: { now: () => later, nowISO: () => new Date(later).toISOString() },
      });

      const entry = await recoverGoal(control, 'g1');

      expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
      expect(fenced).toContain('goal-g1-a0');
    });

    it('is given up on at once when the controller it started has itself ended', async () => {
      const store = await spent();
      const { control } = dependencies(store, endedBefore(countedAt));

      expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'unrecoverable' });
    });
  });

  describe('a goal recovery gives up on', () => {
    async function spentGoal() {
      const store = await runningGoal();
      for (let restart = 0; restart < MAXIMUM_CONTROLLER_RESTARTS; restart += 1) {
        const counted = await store.recordControllerRestart('g1', NOW, restart);
        expect(counted.status).toBe('updated');
      }
      return store;
    }

    it("cancels the attempt's run, which the fence cannot stop inside a model or tool call, and says so", async () => {
      const store = await spentGoal();
      const { engine } = scriptedEngine({
        workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'running' },
      });
      const { control, stopped, fenced } = dependencies(store, engine);

      const entry = await recoverGoal(control, 'g1');

      expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
      expect(entry.detail).toContain('"goal-g1-a0" was cancelled');
      // Fenced as before, and the goal itself is left exactly as it was.
      expect(fenced).toContain('goal-g1-a0');
      expect(stopped).toContain('goal-g1-a0');
      expect(await store.get('g1')).toMatchObject({ status: 'running' });
    });

    it('cancels the attempt run when the audit log has no room for a restart', async () => {
      const store = await runningGoal();
      const { engine } = scriptedEngine({
        workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'running' },
      });
      const full = {
        ...store,
        recordControllerRestart: async () => ({
          status: 'rejected' as const,
          reason: 'audit-log-full' as const,
          record: (await store.get('g1'))!,
        }),
      };
      const { control, stopped } = dependencies(full, engine);

      const entry = await recoverGoal(control, 'g1');

      expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
      expect(entry.detail).toContain('was cancelled');
      expect(stopped).toContain('goal-g1-a0');
    });

    it('reports a run it could not cancel, without hiding the give-up, and keeps the claim fenced', async () => {
      const store = await spentGoal();
      const { engine } = scriptedEngine({
        workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'running' },
      });
      const { control, diagnostics, fenced } = dependencies(store, engine, {
        cancelRun: () => Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
      });

      const entry = await recoverGoal(control, 'g1');

      expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
      expect(entry.detail).toContain('could not be cancelled');
      expect(entry.detail).toContain('engine busy');
      expect(fenced).toContain('goal-g1-a0');
      expect(diagnostics.some((diagnostic) => diagnostic.message.includes('engine busy'))).toBe(
        true,
      );
    });

    it('reports a run whose canceller has no capability as one that could not be cancelled, not as nothing', async () => {
      const store = await spentGoal();
      const { engine } = scriptedEngine({
        workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'running' },
      });
      const { control, diagnostics } = dependencies(store, engine, {
        cancelRun: () => Promise.resolve({ status: 'unsupported-capability' }),
      });

      const entry = await recoverGoal(control, 'g1');

      expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
      expect(entry.detail).toContain('could not be cancelled');
      expect(entry.detail).toContain('goal-g1-a0');
      expect(entry.detail).toContain('unsupported-capability');
      expect(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.level === 'error' && diagnostic.message.includes('unsupported-capability'),
        ),
      ).toBe(true);
    });
  });

  it('restarts once the finalizer has settled', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'failed' },
      finalizer: { status: 'succeeded' },
    });
    const { control } = dependencies(store, engineWith(engine, { start: () => Promise.resolve() }));

    expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'restarted' });
    const spent = await store.get('g1');
    expect(spent?.controllerRestarts).toBe(1);
  });
});

describe('a controller that completed while its goal was still not terminal', () => {
  it('is not restarted for a goal whose validator cannot supply the evidence it requires', async () => {
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
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'completed' } });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
      { catalog: createGoalValidatorCatalog([validator('stochastic')]) },
    );

    expect(await recoverGoal(control, 'g1')).toEqual({
      goalRunId: 'g1',
      outcome: 'unsupported-validation',
    });
    expect(started).toEqual([]);
    expect(await store.get('g1')).toMatchObject({
      status: 'failed',
      terminalReason: 'unsupported-validation',
    });
  });
});

describe('recoverEveryGoal', () => {
  it('sweeps only the goals the caller is allowed to see', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'running' } });
    const { control } = dependencies(store, engine);

    const hidden = await recoverEveryGoal(control, () => false);
    const visible = await recoverEveryGoal(control, () => true);

    expect(hidden).toEqual({ goals: [], failures: [] });
    expect(visible.goals.map((entry) => entry.goalRunId)).toEqual(['g1']);
  });

  it('reports a record it cannot read as a failure of the sweep, but only to a caller who may see every goal', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createGoalStore(kv);
    await kv.set(goalRecordKey('broken'), 'not json');
    const { engine } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(store, engine);

    const scoped = await recoverEveryGoal(control, () => true);
    const unscoped = await recoverEveryGoal(control, () => true, true);

    expect(scoped).toEqual({ goals: [], failures: [] });
    expect(unscoped.failures).toEqual([
      { goalRunId: 'broken', reason: expect.stringContaining('unreadable') },
    ]);
  });
});

describe('a goal recovery meets with no durable engine', () => {
  it('commits a recorded cancellation and says it is waiting on the engine, rather than leaving the marker', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const { control } = dependencies(store, undefined as never, { getEngine: () => undefined });

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({
      goalRunId: 'g1',
      outcome: 'cancellation-pending',
      awaiting: ['durable-engine'],
    });
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  describe('whose recorded cancellation cannot be committed as asked', () => {
    type Commit = Awaited<ReturnType<ReturnType<typeof createGoalStore>['applyTransition']>>;

    /** A marked goal whose commit answers from `answer`, one call at a time. */
    async function recoverWithCommit(
      answer: (calls: number, real: () => Promise<Commit>, marked: GoalState) => Promise<Commit>,
    ) {
      const store = await runningGoal();
      await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
      const marked = await store.get('g1');
      if (marked === undefined) throw new Error('the marked goal is missing');
      let calls = 0;
      const scripted = {
        ...store,
        applyTransition: (...args: Parameters<typeof store.applyTransition>) => {
          calls += 1;
          return answer(calls, () => store.applyTransition(...args), marked);
        },
      };
      const { control } = dependencies(scripted, undefined as never, {
        getEngine: () => undefined,
      });
      return { entry: await recoverGoal(control, 'g1'), store, calls: () => calls };
    }

    it('retries a commit that lost to a concurrent writer and then answers pending', async () => {
      const { entry, store, calls } = await recoverWithCommit((call, real, marked) =>
        call === 1 ? Promise.resolve({ status: 'stale', record: marked }) : real(),
      );

      expect(entry).toMatchObject({
        outcome: 'cancellation-pending',
        awaiting: ['durable-engine'],
      });
      expect(calls()).toBeGreaterThan(1);
      const committed = await store.get('g1');
      expect(committed?.status).toBe('canceled');
    });

    it('answers pending on the goal record, not unrecoverable, when every commit loses', async () => {
      const { entry } = await recoverWithCommit((_call, _real, marked) =>
        Promise.resolve({ status: 'stale', record: marked }),
      );

      expect(entry).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['goal-record'] });
    });

    it('answers already-terminal when the record turned out to have ended another way', async () => {
      const { entry } = await recoverWithCommit((_call, _real, marked) =>
        Promise.resolve({
          status: 'rejected',
          reason: 'terminal',
          record: { ...marked, status: 'failed' },
        }),
      );

      expect(entry).toMatchObject({ outcome: 'already-terminal' });
    });

    it('answers not-found when the record is gone', async () => {
      const { entry } = await recoverWithCommit(() => Promise.resolve({ status: 'missing' }));

      expect(entry).toMatchObject({ outcome: 'not-found' });
    });

    it('names the cause when the record is unreadable or the write is refused', async () => {
      const corrupt = await recoverWithCommit(() => Promise.resolve({ status: 'corrupt' }));
      expect(corrupt.entry).toMatchObject({
        outcome: 'unrecoverable',
        detail: expect.stringContaining('unreadable'),
      });

      const refused = await recoverWithCommit((_call, _real, marked) =>
        Promise.resolve({ status: 'rejected', reason: 'oversized', record: marked }),
      );
      expect(refused.entry).toMatchObject({
        outcome: 'unrecoverable',
        detail: expect.stringContaining('oversized'),
      });
    });
  });

  it('still reports a goal with no cancellation as unrecoverable', async () => {
    const store = await runningGoal();
    const { control } = dependencies(store, undefined as never, { getEngine: () => undefined });

    expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'unrecoverable' });
  });
});

describe('a recorded cancellation of a goal whose controller was cancelled, with an engine', () => {
  type Commit = Awaited<ReturnType<ReturnType<typeof createGoalStore>['applyTransition']>>;

  async function recoverWithCommit(
    answer: (calls: number, real: () => Promise<Commit>, marked: GoalState) => Promise<Commit>,
  ) {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const marked = await store.get('g1');
    if (marked === undefined) throw new Error('the marked goal is missing');
    let calls = 0;
    const scripted = {
      ...store,
      applyTransition: (...args: Parameters<typeof store.applyTransition>) => {
        calls += 1;
        return answer(calls, () => store.applyTransition(...args), marked);
      },
    };
    const workflows: Record<string, string> = { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' };
    const { engine } = scriptedEngine({ workflows });
    const { control } = dependencies(scripted, engine);
    return { entry: await recoverGoal(control, 'g1'), store, calls: () => calls };
  }

  it('retries a commit that lost to a concurrent writer and then reads the world back', async () => {
    const { entry, store, calls } = await recoverWithCommit((call, real, marked) =>
      call === 1 ? Promise.resolve({ status: 'stale', record: marked }) : real(),
    );

    expect(entry).toMatchObject({ outcome: 'canceled' });
    expect(calls()).toBeGreaterThan(1);
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  it('answers pending on the goal record, not running, when every commit loses', async () => {
    const { entry } = await recoverWithCommit((_call, _real, marked) =>
      Promise.resolve({ status: 'stale', record: marked }),
    );

    expect(entry).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['goal-record'] });
  });

  it('answers already-terminal when the record ended another way', async () => {
    const { entry } = await recoverWithCommit((_call, _real, marked) =>
      Promise.resolve({
        status: 'rejected',
        reason: 'terminal',
        record: { ...marked, status: 'failed' },
      }),
    );

    expect(entry).toMatchObject({ outcome: 'already-terminal' });
  });

  it('answers not-found when the record is gone', async () => {
    const { entry } = await recoverWithCommit(() => Promise.resolve({ status: 'missing' }));

    expect(entry).toMatchObject({ outcome: 'not-found' });
  });

  it('names the cause when the record is unreadable or the write is refused', async () => {
    const corrupt = await recoverWithCommit(() => Promise.resolve({ status: 'corrupt' }));
    expect(corrupt.entry).toMatchObject({
      outcome: 'unrecoverable',
      detail: expect.stringContaining('unreadable'),
    });

    const refused = await recoverWithCommit((_call, _real, marked) =>
      Promise.resolve({ status: 'rejected', reason: 'oversized', record: marked }),
    );
    expect(refused.entry).toMatchObject({
      outcome: 'unrecoverable',
      detail: expect.stringContaining('oversized'),
    });
  });
});

describe('a running controller with a recorded cancellation', () => {
  it('is ended and its cancellation completed from the host, never left to a signal it may not read', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const workflows: Record<string, string> = { 'goal:g1': 'running', 'goal-g1-a0': 'running' };
    const { engine, calls } = scriptedEngine({
      workflows,
      onCancel: () => {
        workflows['goal:g1'] = 'cancelled';
        return Promise.resolve();
      },
    });
    const { control } = dependencies(store, engine, {
      cancelRun: (runId) => {
        workflows[runId] = 'cancelled';
        return Promise.resolve({ status: 'requested' });
      },
    });

    const entry = await recoverGoal(control, 'g1');

    expect(calls).toContain('cancel:goal:g1');
    expect(calls.some((call) => call.startsWith('signal:'))).toBe(false);
    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'canceled' });
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  it('leaves a running controller alone when no cancellation is recorded', async () => {
    const store = await runningGoal();
    const workflows: Record<string, string> = { 'goal:g1': 'running', 'goal-g1-a0': 'running' };
    const { engine, calls } = scriptedEngine({ workflows });
    const { control } = dependencies(store, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry.outcome).toBe('running');
    expect(calls).not.toContain('cancel:goal:g1');
  });
});

describe('recovery while the bureau is shutting down', () => {
  const closing = (
    store: Awaited<ReturnType<typeof runningGoal>>,
    engine: Parameters<typeof dependencies>[1],
  ) => {
    const { control } = dependencies(store, engine);
    return { ...control, isClosing: () => true };
  };

  it('starts no controller for a goal that has none, and says so', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({ workflows: {} });

    const entry = await recoverGoal(closing(store, engine), 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'shutting-down' });
    expect(calls.some((call) => call.startsWith('start:'))).toBe(false);
    expect(recoveryEntryFailure(entry)).toBeUndefined();
  });

  it('says a closed goal still owes its cleanup instead of reading already-terminal', async () => {
    const store = await endedBeforeAnyAttempt('exhausted', { closed: true });
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'completed' } });

    const entry = await recoverGoal(closing(store, engine), 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'shutting-down' });
    expect(recoveryEntryFailure(entry)).toBeUndefined();
    // Nothing was pruned or recorded: the next boot finishes it.
    const after = await store.get('g1');
    expect(after?.cleanedUpAt).toBeUndefined();
  });

  it('resumes no suspended controller', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({ workflows: { 'goal:g1': 'suspended' } });

    const entry = await recoverGoal(closing(store, engine), 'g1');

    expect(entry).toMatchObject({ outcome: 'shutting-down' });
    expect(calls.some((call) => call.startsWith('resume:'))).toBe(false);
  });

  it('restarts no ended controller and spends no restart on it', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'failed' },
      finalizer: { status: 'succeeded' },
    });

    const entry = await recoverGoal(closing(store, engine), 'g1');

    expect(entry).toMatchObject({ outcome: 'shutting-down' });
    expect(calls.some((call) => call.startsWith('start:'))).toBe(false);
    const after = await store.get('g1');
    expect(after?.controllerRestarts).toBe(0);
  });

  it('still ends a controller for a recorded cancellation, which starts nothing', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const workflows: Record<string, string> = { 'goal:g1': 'running', 'goal-g1-a0': 'running' };
    const { engine, calls } = scriptedEngine({
      workflows,
      onCancel: () => {
        workflows['goal:g1'] = 'cancelled';
        return Promise.resolve();
      },
    });
    const { control } = dependencies(store, engine, {
      cancelRun: (runId) => {
        workflows[runId] = 'cancelled';
        return Promise.resolve({ status: 'requested' });
      },
    });

    const entry = await recoverGoal({ ...control, isClosing: () => true }, 'g1');

    expect(calls).toContain('cancel:goal:g1');
    expect(entry.outcome).toBe('canceled');
  });
});

describe('recoveryEntryFailure', () => {
  const entry = (overrides: Parameters<typeof recoveryEntryFailure>[0]) => overrides;

  it.each([
    [entry({ goalRunId: 'g', outcome: 'unrecoverable', detail: 'gave up' }), 'gave up'],
    [entry({ goalRunId: 'g', outcome: 'restart-pending', detail: 'finalizer' }), 'finalizer'],
    [entry({ goalRunId: 'g', outcome: 'cleanup-pending', detail: 'pruning' }), 'pruning'],
    [entry({ goalRunId: 'g', outcome: 'running', attempt: 'failed', detail: 'no run' }), 'no run'],
    [
      entry({
        goalRunId: 'g',
        outcome: 'cancellation-pending',
        awaiting: ['finalizer-failed'],
        detail: 'dead-lettered',
      }),
      'dead-lettered',
    ],
    [
      entry({
        goalRunId: 'g',
        outcome: 'cancellation-pending',
        awaiting: ['durable-engine'],
        detail: 'no engine',
      }),
      'no engine',
    ],
  ])('is a failure for %j', (given, reason) => {
    expect(recoveryEntryFailure(given)).toContain(reason);
  });

  it.each([
    entry({ goalRunId: 'g', outcome: 'running' }),
    entry({ goalRunId: 'g', outcome: 'running', attempt: 'watching' }),
    entry({ goalRunId: 'g', outcome: 'started' }),
    entry({ goalRunId: 'g', outcome: 'canceled' }),
    entry({ goalRunId: 'g', outcome: 'cancellation-pending', awaiting: ['controller'] }),
  ])('is not a failure for %j', (given) => {
    expect(recoveryEntryFailure(given)).toBeUndefined();
  });
});

describe("recovery's own start of an attempt whose run is gone", () => {
  /** A goal whose controller is alive and whose running attempt has no run under its id. */
  async function goneRun(startAttempt: GoalControlDependencies['startAttempt']) {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'running' } });
    const runtime = createManualRuntimeServices();
    const forwarder = {
      watch: () => {},
      reconcile: () => Promise.resolve('missing' as const),
      drain: () => Promise.resolve(),
    };
    const { control, diagnostics } = dependencies(store, engine, {
      startAttempt,
      forwarder,
      timers: runtime.timers,
    });
    return { control, diagnostics, runtime };
  }

  const untilCalled = async (calls: unknown[]) => {
    for (let turn = 0; turn < 200 && calls.length === 0; turn += 1) await Promise.resolve();
    expect(calls).toHaveLength(1);
  };

  it("abandons a start that never settles at the controller's own start budget, aborts its signal, and says the attempt could not be reconciled", async () => {
    const signals: AbortSignal[] = [];
    const { control, runtime } = await goneRun((_request, signal) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise(() => {});
    });

    const recovering = recoverGoal(control, 'g1');
    await untilCalled(signals);
    await runtime.advance(GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS - 1);
    expect(signals[0]?.aborted).toBe(false);
    await runtime.advance(1);
    const entry = await recovering;

    expect(signals[0]?.aborted).toBe(true);
    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'running', attempt: 'failed' });
    expect(entry.detail).toContain(`${GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS} ms`);
    // A stuck goal is a failure of the boot, not a clean one.
    expect(recoveryEntryFailure(entry)).toBeDefined();
  });

  it('lets the boot sweep finish over a start that never settles, reporting the goal as a failure', async () => {
    const calls: unknown[] = [];
    const { control, runtime } = await goneRun(() => {
      calls.push(1);
      return new Promise(() => {});
    });

    const sweeping = recoverEveryGoal(control);
    await untilCalled(calls);
    await runtime.advance(GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS);
    const report = await sweeping;

    expect(report.failures).toEqual([]);
    expect(report.goals).toHaveLength(1);
    expect(report.goals[0]).toMatchObject({ goalRunId: 'g1', attempt: 'failed' });
    expect(recoveryEntryFailure(report.goals[0]!)).toBeDefined();
  });

  it('does not wait for the budget when the start settles, and leaves no timer behind', async () => {
    const signals: AbortSignal[] = [];
    const { control, runtime } = await goneRun((_request, signal) => {
      if (signal !== undefined) signals.push(signal);
      return Promise.resolve({ status: 'started', sessionId: 's' } as never);
    });

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ outcome: 'running', attempt: 'run-started' });
    expect(signals[0]?.aborted).toBe(false);
    expect(runtime.pendingTimers()).toEqual([]);
  });

  it('diagnoses an abandoned start that fails later instead of leaving an unhandled rejection', async () => {
    let fail: (error: Error) => void = () => {};
    const calls: unknown[] = [];
    const { control, diagnostics, runtime } = await goneRun(() => {
      calls.push(1);
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });

    const recovering = recoverGoal(control, 'g1');
    await untilCalled(calls);
    await runtime.advance(GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS);
    await recovering;
    fail(new Error('resolver fault'));
    await Promise.resolve();
    await Promise.resolve();

    expect(diagnostics.some((diagnostic) => diagnostic.message.includes('resolver fault'))).toBe(
      true,
    );
  });

  it('diagnoses nothing for a start that rejects only because recovery abandoned it', async () => {
    const calls: unknown[] = [];
    const { control, diagnostics, runtime } = await goneRun((_request, signal) => {
      calls.push(1);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const recovering = recoverGoal(control, 'g1');
    await untilCalled(calls);
    await runtime.advance(GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS);
    await recovering;
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
  });
});

describe("the boot sweep's own budget over goals whose start never settles", () => {
  /** Goals `g1`..`gN`, each running with a live controller and an attempt whose run is gone. */
  async function goneRuns(
    ids: readonly string[],
    startAttempt: GoalControlDependencies['startAttempt'],
  ) {
    const store = await runningGoal(ids[0]);
    for (const id of ids.slice(1)) await runningGoal(id, store);
    const { engine } = scriptedEngine({
      workflows: Object.fromEntries(ids.map((id) => [`goal:${id}`, 'running'])),
    });
    const runtime = createManualRuntimeServices();
    const forwarder = {
      watch: () => {},
      reconcile: () => Promise.resolve('missing' as const),
      drain: () => Promise.resolve(),
    };
    const { control, diagnostics } = dependencies(store, engine, {
      startAttempt,
      forwarder,
      timers: runtime.timers,
    });
    return { control, diagnostics, runtime };
  }

  const turns = async (count = 200) => {
    for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
  };

  it('returns once its budget is spent however many goals are stuck, reporting each as a failure, not after a start budget per goal', async () => {
    const started: string[] = [];
    const { control, runtime } = await goneRuns(['g1', 'g2', 'g3'], (request) => {
      started.push(request.goalRunId);
      return new Promise(() => {});
    });

    let report: Awaited<ReturnType<typeof recoverGoalsAtBoot>> | undefined;
    void recoverGoalsAtBoot(control).then((done) => {
      report = done;
    });
    await turns();
    // One stuck goal does not hold the others back from being tried.
    expect(started.toSorted()).toEqual(['g1', 'g2', 'g3']);
    expect(report).toBeUndefined();

    await runtime.advance(GOAL_BOOT_SWEEP_BUDGET_MS);
    await turns();

    expect(report).toBeDefined();
    expect(GOAL_BOOT_SWEEP_BUDGET_MS).toBeLessThan(GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS);
    expect(report?.failures.map((failure) => failure.goalRunId).toSorted()).toEqual([
      'g1',
      'g2',
      'g3',
    ]);
    expect(report?.failures[0]?.reason).toContain('boot');
  });

  it('reports the goals that finished inside the budget as they ended, and only the ones still recovering as failures', async () => {
    const { control, runtime } = await goneRuns(['g1', 'g2'], (request) =>
      request.goalRunId === 'g1'
        ? new Promise(() => {})
        : Promise.resolve({ status: 'started', sessionId: 's' } as never),
    );

    let report: Awaited<ReturnType<typeof recoverGoalsAtBoot>> | undefined;
    void recoverGoalsAtBoot(control).then((done) => {
      report = done;
    });
    await turns();
    await runtime.advance(GOAL_BOOT_SWEEP_BUDGET_MS);
    await turns();

    expect(report?.goals).toMatchObject([{ goalRunId: 'g2', attempt: 'run-started' }]);
    expect(report?.failures.map((failure) => failure.goalRunId)).toEqual(['g1']);
  });

  it('diagnoses a recovery that fails after the boot report was given, since nothing is left to read it', async () => {
    let fail: (error: Error) => void = () => {};
    const { control, runtime, diagnostics } = await goneRuns(
      ['g1'],
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );

    void recoverGoalsAtBoot(control);
    await turns();
    await runtime.advance(GOAL_BOOT_SWEEP_BUDGET_MS);
    await turns();
    fail(new Error('late resolver fault'));
    await turns();

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.level === 'error' &&
          diagnostic.message.includes('g1') &&
          diagnostic.message.includes('boot'),
      ),
    ).toBe(true);
  });

  it('reports a goal no worker reached within the budget as not started, apart from the ones still recovering', async () => {
    const ids = ['g1', 'g2', 'g3', 'g4', 'g5'];
    const { control, runtime } = await goneRuns(ids, () => new Promise(() => {}));

    let report: Awaited<ReturnType<typeof recoverGoalsAtBoot>> | undefined;
    void recoverGoalsAtBoot(control).then((done) => {
      report = done;
    });
    await turns();
    await runtime.advance(GOAL_BOOT_SWEEP_BUDGET_MS);
    await turns();

    const reasons = Object.fromEntries(
      (report?.failures ?? []).map((failure) => [failure.goalRunId, failure.reason]),
    );
    expect(Object.keys(reasons).toSorted()).toEqual(ids);
    for (const id of ['g1', 'g2', 'g3', 'g4']) expect(reasons[id]).toContain('still recovering');
    expect(reasons['g5']).toContain('not started');
    expect(reasons['g5']).not.toContain('still recovering');
  });

  it('lets a recovery that outlives the budget end on its own, leaving no timer behind', async () => {
    const { control, runtime, diagnostics } = await goneRuns(['g1'], () => new Promise(() => {}));

    let report: Awaited<ReturnType<typeof recoverGoalsAtBoot>> | undefined;
    void recoverGoalsAtBoot(control).then((done) => {
      report = done;
    });
    await turns();
    await runtime.advance(GOAL_BOOT_SWEEP_BUDGET_MS);
    await turns();
    const reported = report;
    await runtime.advance(GOAL_ATTEMPT_ACKNOWLEDGEMENT_BUDGET_MS);
    await turns();

    expect(report).toBe(reported);
    expect(runtime.pendingTimers()).toEqual([]);
    // The one error is the late ending itself, diagnosed because no report is left to carry it.
    expect(
      diagnostics.filter((diagnostic) => diagnostic.level === 'error').map((d) => d.message),
    ).toEqual([expect.stringContaining('ended after the boot sweep')]);
  });

  it('arms no timer and takes no further turn when there is nothing to recover, since boot runs it after the engine resumes its runs (COR-1421)', async () => {
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    const { engine } = scriptedEngine({ workflows: {} });
    const runtime = createManualRuntimeServices();
    let armed = 0;
    const { control } = dependencies(store, engine, {
      timers: {
        ...runtime.timers,
        setTimeout: (...given: Parameters<typeof runtime.timers.setTimeout>) => {
          armed += 1;
          return runtime.timers.setTimeout(...given);
        },
      },
    });

    const report = await recoverGoalsAtBoot(control);

    expect(report).toEqual({ goals: [], failures: [] });
    expect(armed).toBe(0);
  });

  it('does not wait for the budget when every goal finishes, and leaves no timer behind', async () => {
    const { control, runtime } = await goneRuns(['g1', 'g2'], () =>
      Promise.resolve({ status: 'started', sessionId: 's' } as never),
    );

    const report = await recoverGoalsAtBoot(control);

    expect(report.failures).toEqual([]);
    expect(report.goals.map((entry) => entry.goalRunId)).toEqual(['g1', 'g2']);
    expect(runtime.pendingTimers()).toEqual([]);
  });
});
