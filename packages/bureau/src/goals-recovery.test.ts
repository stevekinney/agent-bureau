/**
 * COR-851 — what a durable goal does across a process restart.
 *
 * Bureau A runs a goal until a precise point and then "dies": its generate or
 * validator never resolves and it is deliberately not disposed. Bureau B boots
 * over the same SQLite file, and everything it knows about the goal it learns
 * from storage. Records a dead process could have left behind at points no
 * public call can stop at (between claiming an attempt's run and starting it,
 * in `retrying`, with a controller that cannot reason about its record) are
 * written directly through the goal store, which is the only thing that ever
 * writes them.
 */
import { OPERATIVE_RESOLVE_RUN_OPTIONS, readGenerationProfile } from '@lostgradient/operative';
import { decode, KEYS, MemoryStorage, textValueStore } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { commitCancellation } from './goal-controller';
import { MAXIMUM_CONTROLLER_RESTARTS } from './goal-recovery';
import { goalRecordKey, type GoalState, goalTransitionId } from './goal-state';
import { createGoalStore } from './goal-store';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './runtime-composition';
import {
  cancelUntilSettled,
  CHECK,
  createCheckValidator,
  createDiagnostics,
  createLatch,
  createTestDatabase,
  currentEpochMilliseconds,
  durableIds,
  goalRequest,
  goalStatus,
  hangForever,
  hangUntilAborted,
  lastPromptOf,
  pollUntil,
  TERMINAL_STATUSES,
  type TestDatabase,
  workerAgent,
  workflowStatus,
} from './testing/goal-fixtures.test-support';
import {
  bootOver,
  inspect,
  pendingGoal,
  repairPoisoned,
  seedFinishedRun,
  seedPoisoned,
  seedRetrying,
  seedRunning,
} from './testing/goal-recovery-fixtures.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
let database: TestDatabase = createTestDatabase('unset');

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await database.remove();
});

async function track<T extends Bureau>(bureau: T): Promise<T> {
  cleanups.push(() => bureau.dispose());
  return bureau;
}

async function inspection() {
  const view = await inspect(database.path);
  cleanups.push(() => view.dispose());
  return view;
}

async function status(bureau: Bureau, wanted: GoalState['status'], goalRunId = 'g1') {
  const reached = await pollUntil(async () => (await goalStatus(bureau, goalRunId)) === wanted);
  expect(reached).toBe(true);
}

async function ended(bureau: Bureau, goalRunId = 'g1'): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get(goalRunId);
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  if (latest === undefined) throw new Error(`goal ${goalRunId} never ended`);
  return latest;
}

/** Starts a goal in a bureau whose attempt never finishes, and waits for it to be running. */
async function crashWhileRunning(
  request: Parameters<Bureau['goals']['create']>[0] = goalRequest(),
) {
  const diagnostics = createDiagnostics();
  const { bureau } = await bootOver({
    path: database.path,
    agents: { worker: workerAgent(hangForever) },
    validators: [createCheckValidator()],
    diagnostics,
  });
  cleanups.push(() => bureau.dispose());
  await bureau.goals.create(request);
  await status(bureau, 'running');
  return bureau;
}

describe('a goal across a process restart', () => {
  it('finishes a goal whose attempt was running when the process died, in exactly one attempt', async () => {
    database = createTestDatabase('running');
    const dead = await crashWhileRunning(
      goalRequest({ bounds: { maximumAttempts: 3, maximumTotalDurationMs: 600_000 } }),
    );
    const view = await inspection();

    let steps = 0;
    const { bureau, diagnostics } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    const report = await bureau.waitForRecovery?.();

    // Recovery neither cancelled the controller as an unowned run nor reported a failure.
    expect(report).toMatchObject({ outcome: 'clean', perRunFailures: [] });
    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded', terminalReason: 'validator-passed' });
    expect(goal.attempts.map((attempt) => [attempt.runId, attempt.status])).toEqual([
      ['goal-g1-a0', 'passed'],
    ]);
    expect(goal.controllerRestarts).toBe(0);
    expect(steps).toBe(1);
    expect(await workflowStatus(bureau, 'goal:g1')).toBe('completed');
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('completed');
    expect(await durableIds(bureau, 'goal')).toEqual(
      expect.arrayContaining(['goal:g1', 'goal-g1-a0']),
    );
    const goalWorkflows = await durableIds(bureau, 'goal');
    expect(goalWorkflows).toHaveLength(2);
    // A goal controller has no services, so Weft wrote no marker for it.
    expect(await view.storage.get(KEYS.workflowHasServices('goal:g1'))).toBeNull();
    expect(diagnostics.scope('goals')).toEqual([]);

    // The dead process's late writes are stale updates: the goal does not move.
    await dead.dispose();
    await pollUntil(() => false, 10);
    expect(await bureau.goals.get('g1')).toEqual(goal);
  });

  it('keeps a goal parked on its attempt, then finishes it when the attempt ends', async () => {
    database = createTestDatabase('parked');
    await crashWhileRunning(
      goalRequest({ bounds: { maximumAttempts: 3, maximumTotalDurationMs: 600_000 } }),
    );
    const release = createLatch();
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(async () => {
          await release.promise;
          return { content: 'done', toolCalls: [] };
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();

    // Still waiting, and recovery knows what on.
    expect(await goalStatus(bureau, 'g1')).toBe('running');
    expect(await bureau.goals.active('g1')).toMatchObject({
      kind: 'attempt',
      runId: 'goal-g1-a0',
      runStatus: 'running',
    });
    expect(await bureau.goals.recover('g1')).toEqual({
      goals: [{ goalRunId: 'g1', outcome: 'running', attempt: 'watching' }],
      failures: [],
    });

    release.release();
    const goal = await ended(bureau);
    expect(goal.status).toBe('succeeded');
  });

  it('re-runs a validator that was executing when the process died, and commits one decision', async () => {
    database = createTestDatabase('evaluating');
    const stuck = createLatch();
    const { bureau: dead } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator({ before: () => stuck.promise })],
    });
    cleanups.push(() => dead.dispose());
    await dead.goals.create(goalRequest());
    await status(dead, 'evaluating');

    const validatorCalls: Parameters<ReturnType<typeof createCheckValidator>['validate']>[0][] = [];
    let steps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator({ calls: validatorCalls })],
    });
    await track(bureau);

    const goal = await ended(bureau);
    expect(goal.status).toBe('succeeded');
    expect(goal.attempts).toHaveLength(1);
    expect(goal.attempts[0]?.validation).toMatchObject({
      decisionId: 'g1:a0:decision',
      outcome: { kind: 'pass' },
    });
    expect(validatorCalls).toHaveLength(1);
    // The attempt's run had already finished, so it is never run again.
    expect(steps).toBe(0);

    stuck.release();
    await pollUntil(() => false, 10);
    expect(await bureau.goals.get('g1')).toEqual(goal);
  });

  it('starts the next attempt of a goal that died in retrying, carrying the feedback it recorded', async () => {
    database = createTestDatabase('retrying');
    const prompts: string[] = [];
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(({ conversation }) => {
          prompts.push(lastPromptOf(conversation));
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    await seedRetrying(view);
    expect(await goalStatus(bureau, 'g1')).toBe('retrying');

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started' }],
      failures: [],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 2 } });
    expect(goal.attempts.map((attempt) => [attempt.runId, attempt.status])).toEqual([
      ['goal-g1-a0', 'failed'],
      ['goal-g1-a1', 'passed'],
    ]);
    expect(prompts).toEqual(['say done']);
  });

  it('does not run again a goal that had already ended, whether it succeeded or was canceled', async () => {
    database = createTestDatabase('terminal');
    let firstSteps = 0;
    const { bureau: first } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          firstSteps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
        hanging: workerAgent(hangUntilAborted, 'hanging'),
      },
      validators: [createCheckValidator()],
    });
    cleanups.push(() => first.dispose());
    await first.goals.create(goalRequest());
    await first.goals.create(goalRequest({ goalRunId: 'g2', agentName: 'hanging' as 'worker' }));
    const succeeded = await ended(first, 'g1');
    await status(first, 'running', 'g2');
    await first.goals.cancel('g2');
    const canceled = await ended(first, 'g2');
    expect(firstSteps).toBe(1);

    let secondSteps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          secondSteps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
        hanging: workerAgent(hangUntilAborted, 'hanging'),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();

    expect(await bureau.goals.get('g1')).toEqual(succeeded);
    expect(await bureau.goals.get('g2')).toEqual(canceled);
    // The canceled goal's finalizer, which stops its attempt, may still be owed
    // in this process, and the sweep says so until it has settled. After that
    // nothing is left to recover for either ended goal.
    expect(
      await pollUntil(async () => {
        const report = await bureau.goals.recover();
        return report.goals.length === 0 && report.failures.length === 0;
      }),
    ).toBe(true);
    expect(await bureau.goals.recover()).toEqual({ goals: [], failures: [] });
    expect(await bureau.goals.recover('g1')).toEqual({
      goals: [{ goalRunId: 'g1', outcome: 'already-terminal' }],
      failures: [],
    });
    expect(await bureau.goals.recover('missing')).toEqual({
      goals: [{ goalRunId: 'missing', outcome: 'not-found' }],
      failures: [],
    });
    expect(secondSteps).toBe(0);
  });

  it('leaves a goal interrupted by shutdown unfinished for the next process, never failed or canceled', async () => {
    database = createTestDatabase('shutdown');
    const { bureau: first } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await first.goals.create(goalRequest());
    await status(first, 'running');
    const report = await first.shutdown();
    // Nothing the goal owns is left unresolved by the shutdown.
    expect(report).toMatchObject({ unresolved: 0, failed: 0 });

    const view = await inspection();
    const left = await view.store.get('g1');
    expect(left?.status).toBe('running');
    expect(left?.cancellation).toBeUndefined();

    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    expect(await ended(bureau)).toMatchObject({ status: 'succeeded' });
  });
});

describe('a goal that ended while its next attempt was still starting', () => {
  const NOW = '2026-10-02T12:00:00.000Z';
  /**
   * The deadline (or a cancellation) won the race against the attempt's start
   * after the start had claimed the run, so the goal ended with no attempt
   * recorded. The abandoned start then created the run anyway, and the process
   * died before the start's own stand-down check. Bureau A really starts the
   * run and parks it; the goal's record is then rewritten to the ending that
   * overtook it, which is the record the dead process left.
   */
  async function overtakingRecord(ending: 'exhausted' | 'canceled') {
    const scratch = createGoalStore(textValueStore(new MemoryStorage()));
    await scratch.create(pendingGoal());
    if (ending === 'canceled') {
      await scratch.requestCancellation('g1', { requestedAt: NOW }, NOW);
      await commitCancellation(scratch, (await scratch.get('g1'))!, Date.parse(NOW));
    } else {
      await scratch.applyTransition({
        goalRunId: 'g1',
        seq: 1,
        transitionId: goalTransitionId('g1', 1),
        to: 'exhausted',
        at: NOW,
        cause: 'the aggregate duration elapsed',
        terminalReason: 'aggregate-budget-exceeded',
      });
    }
    const record = await scratch.get('g1');
    expect(record).toMatchObject({ status: ending, attempts: [] });
    return record!;
  }

  async function overtaken(ending: 'exhausted' | 'canceled') {
    await crashWhileRunning();
    const view = await inspection();
    await view.overwrite(await overtakingRecord(ending));
  }

  it.each(['exhausted', 'canceled'] as const)(
    'has the run it created stopped by the next boot, and stays %s',
    async (ending) => {
      database = createTestDatabase(`late-start-${ending}`);
      await overtaken(ending);

      let steps = 0;
      const { bureau } = await bootOver({
        path: database.path,
        agents: {
          worker: workerAgent((context) => {
            steps += 1;
            return hangUntilAborted(context);
          }),
        },
        validators: [createCheckValidator()],
      });
      await track(bureau);
      await bureau.waitForRecovery?.();

      // Ended either way: the resumed run's own fence stops it before its first
      // step, or the sweep cancels it first. Neither lets it work for a goal that is over.
      expect(
        await pollUntil(async () =>
          ['cancelled', 'completed'].includes((await workflowStatus(bureau, 'goal-g1-a0')) ?? ''),
        ),
      ).toBe(true);
      expect(steps).toBe(0);
      const goal = await bureau.goals.get('g1');
      expect(goal).toMatchObject({ status: ending, attempts: [] });
    },
  );

  it.each(['exhausted', 'canceled'] as const)(
    'tombstones the claim of a start that claimed its run and never created it, so close() may mark the %s goal cleaned up',
    async (ending) => {
      database = createTestDatabase(`claimed-never-started-${ending}`);
      const view = await inspection();
      await view.store.create(pendingGoal());
      await view.overwrite(await overtakingRecord(ending));
      // The start died after claiming the run and before the engine created it.
      await view.claimRun('goal-g1-a0', {
        agentName: 'worker',
        definitionRevision: 1,
        input: 'work',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
      });

      const { bureau } = await bootOver({
        path: database.path,
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      await track(bureau);
      await bureau.waitForRecovery?.();

      // Nothing was created, and the claim a late start would continue from is now a tombstone.
      expect(await workflowStatus(bureau, 'goal-g1-a0')).toBeUndefined();
      const stored = await view.storage.get(`${CATALOG_RUN_RECOVERY_KEY_PREFIX}goal-g1-a0`);
      expect(stored).toBeDefined();
      expect(decode(stored!)).toMatchObject({
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0, tombstonedAt: expect.any(String) },
      });
      const closed = await bureau.goals.close('g1');
      expect(closed).toMatchObject({ outcome: 'closed' });
      const after = await bureau.goals.get('g1');
      expect(after?.cleanedUpAt).toBeDefined();
    },
  );

  it('has the run stopped by close() when the ending lands after the boot sweep, so the goal does not leave the sweep with it alive', async () => {
    database = createTestDatabase('late-start-close');
    await crashWhileRunning();
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('running');
    const view = await inspection();
    await view.overwrite(await overtakingRecord('exhausted'));

    const closed = await bureau.goals.close('g1');

    expect(closed).toMatchObject({ outcome: 'closed', goal: { status: 'exhausted' } });
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('cancelled');
  });
});

describe('a run that existed before its controller opened the attempt', () => {
  /**
   * The late-start window, over real runs on shared storage: the start created
   * the attempt's run and returned, and the process died before the controller's
   * open-attempt commit, with the controller itself gone. Bureau A really starts
   * the run and parks it; the goal's record and the controller are then reset to
   * what a controller that never committed leaves.
   */
  it('takes exactly one agent step, after a restarted controller adopts the run and commits it open', async () => {
    database = createTestDatabase('late-adopted');
    await crashWhileRunning();
    const view = await inspection();
    await view.overwrite(pendingGoal());
    await view.storage.delete(KEYS.workflow('goal:g1'));

    let steps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts.map((attempt) => attempt.runId)).toEqual(['goal-g1-a0']);
    // The run waited for the commit and then worked once; it neither stepped
    // unacknowledged nor was refused for waiting.
    expect(steps).toBe(1);
  });
});

describe('a goal when the validator it names is no longer registered', () => {
  it.each([
    { label: 'removed', validators: [], code: 'VALIDATOR_MISSING' },
    {
      label: 're-versioned',
      validators: [createCheckValidator({ version: '2' })],
      code: 'VALIDATOR_VERSION_MISMATCH',
    },
  ])(
    'ends the attempt unavailable, explicitly, when it was $label',
    async ({ validators, code }) => {
      database = createTestDatabase('validator');
      const stuck = createLatch();
      const { bureau: dead } = await bootOver({
        path: database.path,
        agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
        validators: [createCheckValidator({ before: () => stuck.promise })],
      });
      cleanups.push(() => dead.dispose());
      await dead.goals.create(goalRequest());
      await status(dead, 'evaluating');

      const { bureau } = await bootOver({
        path: database.path,
        agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
        validators,
      });
      await track(bureau);

      const goal = await ended(bureau);
      expect(goal).toMatchObject({
        status: 'failed',
        terminalReason: 'validator-infrastructure-error',
      });
      const outcome = goal.attempts[0]?.validation?.outcome;
      expect(outcome).toMatchObject({ kind: 'unavailable', error: { kind: 'load', code } });
      expect(goal.attempts[0]?.validation?.identity).toEqual(CHECK);
    },
  );
});

describe('a cancellation that a process died in the middle of', () => {
  it('is completed by the next process once the marker is durable', async () => {
    database = createTestDatabase('marker');
    await crashWhileRunning();
    const view = await inspection();
    // The control plane wrote the marker and died before it could do anything else.
    await view.store.requestCancellation(
      'g1',
      { requestedAt: '2026-10-02T12:00:00.000Z', reason: 'operator' },
      '2026-10-02T12:00:00.000Z',
    );

    let steps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent((context) => {
          steps += 1;
          return hangUntilAborted(context);
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);

    const goal = await ended(bureau);
    expect(goal).toMatchObject({
      status: 'canceled',
      terminalReason: 'goal-canceled',
      cancellation: { reason: 'operator' },
    });
    expect(goal.attempts.map((attempt) => attempt.status)).toEqual(['aborted']);
    // The marker is durable, so the resumed run's own fence refuses its first step,
    // or the completion of the cancellation stops it first: it ended either way,
    // and took no step for a goal that was being canceled.
    expect(
      await pollUntil(async () =>
        ['cancelled', 'completed'].includes((await workflowStatus(bureau, 'goal-g1-a0')) ?? ''),
      ),
    ).toBe(true);
    expect(steps).toBe(0);
  });

  it('is completed when the controller workflow was cancelled out from under its goal', async () => {
    database = createTestDatabase('outside');
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.goals.create(goalRequest());
    await status(bureau, 'running');

    // Someone cancels the controller's workflow directly, not through the goal.
    expect(await bureau.cancelDurableRun('goal:g1')).toEqual({ status: 'requested' });
    expect(await goalStatus(bureau, 'g1')).toBe('running');

    // The controller's finalizer stops the attempt in the background, so recovery
    // may find it still owed. It has committed the cancellation either way.
    const recovered = await bureau.goals.recover('g1');
    expect(recovered.failures).toEqual([]);
    expect(recovered.goals).toHaveLength(1);
    const [result] = recovered.goals;
    expect(['canceled', 'cancellation-pending']).toContain(result?.outcome ?? '');
    if (result?.outcome === 'cancellation-pending') {
      expect(result.detail).toBe('Still waiting on: finalizer.');
    }
    // The run's own status cannot tell the finalizer from completeCancellation,
    // which also stops it, so wait on the finalizer itself. The record is already
    // `canceled`, which makes recover() answer `already-terminal`; cancel() is the
    // operation that re-reads the finalizer on a committed record. It answers
    // `canceled` only once the finalizer has succeeded or is not owed.
    const pendingAnswers: (readonly string[])[] = [];
    const settled = await pollUntil(async () => {
      const answer = await bureau.goals.cancel('g1');
      if (answer.outcome === 'cancellation-pending') pendingAnswers.push(answer.awaiting);
      return answer.outcome === 'canceled';
    });
    expect(settled).toBe(true);
    for (const awaiting of pendingAnswers) expect(awaiting).toEqual(['finalizer']);
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('cancelled');
    const goal = await bureau.goals.get('g1');
    expect(goal).toMatchObject({
      status: 'canceled',
      terminalReason: 'goal-canceled',
      cancellation: { reason: 'The goal controller was cancelled.' },
    });
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('cancelled');
  });
});

describe('a controller left running in a superseded process', () => {
  it('cannot move a goal that was canceled in the process that replaced it', async () => {
    database = createTestDatabase('stale');
    const supersededVerdict = createLatch();
    const verdictDelivered = createLatch();
    const { bureau: superseded } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [
        createCheckValidator({
          before: async () => {
            await supersededVerdict.promise;
            verdictDelivered.release();
          },
        }),
      ],
    });
    cleanups.push(() => superseded.dispose());
    await superseded.goals.create(goalRequest());
    await status(superseded, 'evaluating');

    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator({ before: () => new Promise(() => {}) })],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const { settled } = await cancelUntilSettled(bureau);
    expect(settled).toMatchObject({ outcome: 'canceled' });
    const canceled = await bureau.goals.get('g1');

    // The superseded controller's verdict arrives late and passes. Its commit is refused.
    supersededVerdict.release();
    await verdictDelivered.promise;
    await pollUntil(() => false, 20);

    expect(await bureau.goals.get('g1')).toEqual(canceled);
    expect(canceled).toMatchObject({ status: 'canceled', terminalReason: 'goal-canceled' });
  });
});

describe('the attempt behind a running goal', () => {
  it('is re-sent to a controller that never heard it end, once the run is found finished', async () => {
    database = createTestDatabase('lost-forwarder');
    const worker = workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] }));
    // The attempt's run finished while nobody was forwarding it: it is a durable
    // run under the attempt's deterministic id, marked as the goal's own by the
    // start that created it, and the goal's record says it was running. Ordinary
    // callers cannot choose an id in the goal's namespace, so the run is written
    // the way the goal's own start would have left it.
    await seedFinishedRun(database.path, 'goal-g1-a0');
    const view = await inspection();
    await view.claimRun('goal-g1-a0', {
      agentName: 'worker',
      definitionRevision: readGenerationProfile(worker).revision,
      input: 'work',
      goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
    });
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker, planner: workerAgent(hangUntilAborted, 'planner') },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    await seedRunning(view);

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started', attempt: 'signal-resent' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts).toHaveLength(1);
  });

  describe('pricing an attempt that already ran', () => {
    const COST_BOUNDS = { maximumAttempts: 3, maximumTotalSteps: 1000, maximumTotalCostUsd: 100 };

    /** A worker whose run options declare an estimator, counting how often they are resolved. */
    function pricedWorker(resolutions: { count: number }) {
      const base = workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] }));
      const resolveOptions = (
        base as unknown as Record<
          symbol,
          (input: unknown, context: unknown) => Promise<Record<string, unknown>>
        >
      )[OPERATIVE_RESOLVE_RUN_OPTIONS];
      if (resolveOptions === undefined) throw new Error('the worker has no run-option resolver');
      return Object.create(base, {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: {
          value: (input: unknown, context: unknown) => {
            resolutions.count += 1;
            return resolveOptions
              .call(base, input, context)
              .then((options) => ({ ...options, costEstimation: { model: 'gpt-4o' } }));
          },
        },
      }) as typeof base;
    }

    /** A finished attempt run whose recovery record persists `costEstimation` and names `definitionRevision`. */
    async function finishedAttempt(definitionRevision: number, costEstimation: unknown) {
      await seedFinishedRun(database.path, 'goal-g1-a0');
      const view = await inspection();
      await view.claimRun('goal-g1-a0', {
        agentName: 'worker',
        definitionRevision,
        input: 'work',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
        costEstimation,
      });
      return view;
    }

    async function recoverCostBounded(
      view: Awaited<ReturnType<typeof inspection>>,
      agents: Parameters<typeof bootOver>[0]['agents'],
    ) {
      const { bureau } = await bootOver({
        path: database.path,
        agents,
        validators: [createCheckValidator()],
      });
      await track(bureau);
      await bureau.waitForRecovery?.();
      await seedRunning(view, pendingGoal({ bounds: COST_BOUNDS }));
      const report = await bureau.goals.recover('g1');
      return { bureau, report };
    }

    it('prices it with the persisted estimator after the catalog moved to another revision, without resolving the agent', async () => {
      database = createTestDatabase('priced-persisted-newer');
      const resolutions = { count: 0 };
      const worker = pricedWorker(resolutions);
      const view = await finishedAttempt(readGenerationProfile(worker).revision + 1, {
        model: 'gpt-4o',
      });
      const { bureau } = await recoverCostBounded(view, { worker });

      expect(await ended(bureau)).toMatchObject({ status: 'succeeded' });
      expect(resolutions.count).toBe(0);
    });

    it('prices it with the persisted estimator after the catalog lost the agent', async () => {
      database = createTestDatabase('priced-persisted-agent-gone');
      const view = await finishedAttempt(1, { model: 'gpt-4o' });
      const { bureau } = await recoverCostBounded(view, {
        planner: workerAgent(hangUntilAborted, 'planner'),
      });

      expect(await ended(bureau)).toMatchObject({ status: 'succeeded' });
    });

    it('prices an attempt persisted with no estimator as unaccounted, whatever the catalog now declares', async () => {
      database = createTestDatabase('priced-persisted-none');
      const resolutions = { count: 0 };
      const worker = pricedWorker(resolutions);
      const view = await finishedAttempt(readGenerationProfile(worker).revision, null);
      const { bureau } = await recoverCostBounded(view, { worker });

      expect(await ended(bureau)).toMatchObject({
        status: 'failed',
        terminalReason: 'attempt-run-failed',
      });
      expect(resolutions.count).toBe(0);
    });

    it('treats a corrupt persisted estimator as a corrupt record, leaving the goal as it was and naming the fault', async () => {
      database = createTestDatabase('priced-persisted-corrupt');
      const resolutions = { count: 0 };
      const worker = pricedWorker(resolutions);
      const view = await finishedAttempt(readGenerationProfile(worker).revision, { model: 7 });
      const { bureau, report } = await recoverCostBounded(view, { worker });

      expect(await goalStatus(bureau, 'g1')).toBe('running');
      expect(resolutions.count).toBe(0);
      expect(JSON.stringify(report)).toContain('corrupt-ownership-record');
    });
  });

  describe('the estimator an attempt is started with', () => {
    it.each([
      { label: 'declared', declared: true, persisted: { model: 'gpt-4o' } },
      { label: 'not declared', declared: false, persisted: null },
    ])('is persisted with the run when it is $label', async ({ declared, persisted }) => {
      database = createTestDatabase(`persisted-${declared}`);
      const resolutions = { count: 0 };
      const base = workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] }));
      const resolveOptions = (
        base as unknown as Record<
          symbol,
          (input: unknown, context: unknown) => Promise<Record<string, unknown>>
        >
      )[OPERATIVE_RESOLVE_RUN_OPTIONS];
      if (resolveOptions === undefined) throw new Error('the worker has no run-option resolver');
      const worker = Object.create(base, {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: {
          value: (input: unknown, context: unknown) => {
            resolutions.count += 1;
            return resolveOptions
              .call(base, input, context)
              .then((options) =>
                declared ? { ...options, costEstimation: { model: 'gpt-4o' } } : options,
              );
          },
        },
      }) as typeof base;
      const { bureau } = await bootOver({
        path: database.path,
        agents: { worker },
        validators: [createCheckValidator()],
      });
      await track(bureau);
      await bureau.goals.create(goalRequest());
      await ended(bureau);

      const view = await inspection();
      const raw = await view.storage.get(`${CATALOG_RUN_RECOVERY_KEY_PREFIX}goal-g1-a0`);
      expect(raw).not.toBeNull();
      const stored = decode(raw as Uint8Array) as Record<string, unknown>;
      expect(stored['costEstimation']).toEqual(persisted);
    });
  });

  it('is started again when the controller recorded it as running but its run was never created', async () => {
    database = createTestDatabase('never-created');
    let steps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    // The start returned its handle and the controller committed `running`, then the
    // process died before the run's workflow existed.
    const view = await inspection();
    await seedRunning(view);
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBeUndefined();

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started', attempt: 'run-started' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts.map((attempt) => attempt.runId)).toEqual(['goal-g1-a0']);
    expect(steps).toBe(1);
  });

  it('reports a corrupt-ownership-record against the attempt, and starts nothing, when its recovery record is present but invalid', async () => {
    database = createTestDatabase('corrupt-record');
    let steps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    await seedRunning(view);
    await view.corruptRunRecord('goal-g1-a0');

    const recovered = await bureau.goals.recover('g1');

    expect(recovered.goals[0]).toMatchObject({ goalRunId: 'g1', attempt: 'failed' });
    expect(recovered.goals[0]?.detail).toContain('corrupt-ownership-record');
    // Not absent: no run was started over it, and its record was left as it was.
    expect(steps).toBe(0);
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBeUndefined();
  });

  it('does not report a run it cannot read as a run with no workflow, in active()', async () => {
    database = createTestDatabase('active-corrupt-record');
    // A run that exists, whose ownership record is then damaged: the engine
    // cannot say whether it is the goal's, so reading it fails.
    await seedFinishedRun(database.path, 'goal-g1-a0');
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangForever) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    await seedRunning(view);
    await view.corruptRunRecord('goal-g1-a0');

    const active = await bureau.goals.active('g1');

    // `null` alone would say no workflow exists; the read fault is named.
    expect(active).toMatchObject({ kind: 'attempt', runId: 'goal-g1-a0', runStatus: null });
    expect(active).toHaveProperty('runStatusError', expect.stringContaining('goal-g1-a0'));
  });

  it("does not adopt a run something else created at the attempt's id, and leaves it as it was", async () => {
    database = createTestDatabase('foreign-run');
    let steps = 0;
    const worker = workerAgent(() => {
      steps += 1;
      return Promise.resolve({ content: 'done', toolCalls: [] });
    });
    // Admission refuses a caller-chosen id in the goal's namespace, so this is a
    // run another writer left in the store: a catalog run with no goal marker.
    await seedFinishedRun(database.path, 'goal-g1-a0');
    const view = await inspection();
    await view.claimRun('goal-g1-a0', {
      agentName: 'worker',
      definitionRevision: readGenerationProfile(worker).revision,
      input: 'work',
    });
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker, planner: workerAgent(hangUntilAborted, 'planner') },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    await seedRunning(view);

    const recovered = await bureau.goals.recover('g1');

    // The goal refuses the run; it neither forwards its result nor starts over it.
    expect(recovered.goals[0]).toMatchObject({ goalRunId: 'g1', attempt: 'failed' });
    expect(recovered.goals[0]?.detail).toContain('goal-g1-a0');
    // The goal's worker never ran: nothing was started over the foreign run.
    expect(steps).toBe(0);
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('completed');
  });

  it('is started from the claim a start left behind when it died before the workflow existed', async () => {
    database = createTestDatabase('claim');
    let steps = 0;
    const worker = workerAgent(() => {
      steps += 1;
      return Promise.resolve({ content: 'done', toolCalls: [] });
    });
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    await view.claimRun('goal-g1-a0', {
      agentName: 'worker',
      definitionRevision: readGenerationProfile(worker).revision,
      input: 'work',
      goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
    });
    await view.store.create(pendingGoal());
    expect(await bureau.getDurableRun('goal-g1-a0')).toBeNull();

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts.map((attempt) => attempt.runId)).toEqual(['goal-g1-a0']);
    expect(steps).toBe(1);
  });
});

describe('two bureaus recovering the same goal', () => {
  it('start one controller and run one attempt between them', async () => {
    database = createTestDatabase('duplicate');
    let steps = 0;
    const agents = {
      worker: workerAgent(() => {
        steps += 1;
        return Promise.resolve({ content: 'done', toolCalls: [] });
      }),
    };
    const first = await bootOver({
      path: database.path,
      agents,
      validators: [createCheckValidator()],
    });
    const second = await bootOver({
      path: database.path,
      agents,
      validators: [createCheckValidator()],
    });
    await track(first.bureau);
    await track(second.bureau);
    await first.bureau.waitForRecovery?.();
    await second.bureau.waitForRecovery?.();
    const view = await inspection();
    await view.store.create(pendingGoal());

    const reports = await Promise.all([
      first.bureau.goals.recover('g1'),
      second.bureau.goals.recover('g1'),
    ]);

    const outcomes = reports.flatMap((report) => report.goals.map((entry) => entry.outcome));
    expect(outcomes.filter((outcome) => outcome === 'started')).toHaveLength(1);
    const goal = await ended(first.bureau);
    expect(goal).toMatchObject({ status: 'succeeded', controllerRestarts: 0 });
    expect(goal.attempts).toHaveLength(1);
    expect(steps).toBe(1);
    expect(await durableIds(first.bureau, 'goal:')).toEqual(['goal:g1']);
  });
});

describe('a create that died between recording the goal and starting its controller', () => {
  it('is healed by repeating it, which starts the controller and finishes the goal', async () => {
    database = createTestDatabase('repeat-create');
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    // The record is there; the process died before the controller was started.
    await view.store.create(pendingGoal());
    expect(await workflowStatus(bureau, 'goal:g1')).toBeUndefined();

    const repeated = await bureau.goals.create(goalRequest());

    expect(repeated).toMatchObject({
      outcome: 'existing',
      controller: { status: 'started' },
      goal: { goalRunId: 'g1' },
    });
    expect(await ended(bureau)).toMatchObject({ status: 'succeeded' });
  });
});

describe('a controller that ends abnormally while its goal is unfinished', () => {
  async function bootForPoison() {
    database = createTestDatabase('poison');
    const { bureau, diagnostics } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    return { bureau, diagnostics, view };
  }

  const controllerFailed = (bureau: Bureau) =>
    pollUntil(async () => (await workflowStatus(bureau, 'goal:g1')) === 'failed');

  it('restarts it from the record, up to a bound, then reports the goal unrecoverable', async () => {
    const { bureau, view } = await bootForPoison();
    await seedPoisoned(view);

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started' }],
    });
    for (let restart = 1; restart <= MAXIMUM_CONTROLLER_RESTARTS; restart += 1) {
      expect(await controllerFailed(bureau)).toBe(true);
      const report = await bureau.goals.recover('g1');
      expect(report.goals[0]).toMatchObject({ goalRunId: 'g1', outcome: 'restarted' });
      const restarted = await bureau.goals.get('g1');
      expect(restarted?.controllerRestarts).toBe(restart);
    }

    expect(await controllerFailed(bureau)).toBe(true);
    const past = await bureau.goals.recover('g1');
    expect(past.goals[0]).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
    // No terminal reason is invented: the goal is exactly as it was.
    const goal = await bureau.goals.get('g1');
    expect(goal).toMatchObject({
      status: 'pending',
      controllerRestarts: MAXIMUM_CONTROLLER_RESTARTS,
    });
    expect(goal?.terminalReason).toBeUndefined();
  });

  it('tombstones the claim of the attempt a controller it gave up on may have left starting, so no run works for a goal nothing reads', async () => {
    const { bureau, view } = await bootForPoison();
    await seedPoisoned(view);
    await bureau.goals.recover('g1');
    for (let restart = 1; restart <= MAXIMUM_CONTROLLER_RESTARTS; restart += 1) {
      expect(await controllerFailed(bureau)).toBe(true);
      await bureau.goals.recover('g1');
    }
    expect(await controllerFailed(bureau)).toBe(true);
    expect(await view.storage.get(`${CATALOG_RUN_RECOVERY_KEY_PREFIX}goal-g1-a0`)).toBeNull();

    const past = await bureau.goals.recover('g1');

    expect(past.goals[0]).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
    // A start that reaches its claim now finds the tombstone and starts nothing, and a
    // run already past its claim reads it in its own fence.
    const stored = await view.storage.get(`${CATALOG_RUN_RECOVERY_KEY_PREFIX}goal-g1-a0`);
    expect(stored).toBeDefined();
    expect(decode(stored!)).toMatchObject({
      goalAttempt: { goalRunId: 'g1', attemptIndex: 0, tombstonedAt: expect.any(String) },
    });
    // The goal itself is exactly as it was: no terminal reason is invented.
    expect(await bureau.goals.get('g1')).toMatchObject({ status: 'pending' });
  });

  it('is reported by the boot sweep as a recovery failure, so the report is not clean', async () => {
    const { bureau, view } = await bootForPoison();
    await seedPoisoned(view);
    await bureau.goals.recover('g1');
    for (let restart = 1; restart <= MAXIMUM_CONTROLLER_RESTARTS; restart += 1) {
      expect(await controllerFailed(bureau)).toBe(true);
      await bureau.goals.recover('g1');
    }
    expect(await controllerFailed(bureau)).toBe(true);

    const diagnostics = createDiagnostics();
    const next = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator()],
      diagnostics,
    });
    await track(next.bureau);
    const report = await next.bureau.waitForRecovery?.();

    // The bytes that keep the controller from starting its attempt are also a run
    // record the engine's own batch recovery cannot read, so the batch failed too.
    expect(report?.outcome).toBe('failed');
    expect(report?.batchFailure).toBeDefined();
    expect(report?.perRunFailures).toEqual([
      { runId: 'g1', reason: expect.stringContaining('restarted') },
    ]);
    expect(
      diagnostics
        .scope('recovery')
        .some((diagnostic) => diagnostic.message.includes('Goal "g1" is unrecoverable')),
    ).toBe(true);
  });

  it('finishes the goal once the restarted controller can read its record', async () => {
    const { bureau, view } = await bootForPoison();
    await seedPoisoned(view);
    await bureau.goals.recover('g1');
    expect(await controllerFailed(bureau)).toBe(true);

    // Repaired: the goal session can be read, so the first attempt can start.
    await repairPoisoned(view);

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'restarted' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded', controllerRestarts: 1 });
    expect(goal.attempts).toHaveLength(1);
  });
});

describe('a goal record that contradicts itself', () => {
  it('is reported unreadable at boot, never handed to a controller that would burn its restart allowance', async () => {
    database = createTestDatabase('self-contradicting');
    const view = await inspection();
    await seedRunning(view);
    // Running, but with no attempt and no active work behind it.
    const stored = JSON.parse((await view.kv.get(goalRecordKey('g1'))) as string) as Record<
      string,
      unknown
    >;
    stored['attempts'] = [];
    delete stored['active'];
    await view.kv.set(goalRecordKey('g1'), JSON.stringify(stored));
    const { bureau, diagnostics } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangForever) },
      validators: [createCheckValidator()],
    });
    await track(bureau);

    const report = await bureau.waitForRecovery?.();
    const recovered = await bureau.goals.recover('g1');

    expect(report?.perRunFailures).toEqual([
      { runId: 'g1', reason: expect.stringContaining('unreadable') },
    ]);
    expect(recovered.failures).toEqual([]);
    expect(recovered.goals).toEqual([
      {
        goalRunId: 'g1',
        outcome: 'unrecoverable',
        detail: expect.stringContaining('unreadable'),
      },
    ]);
    expect(await bureau.goals.get('g1')).toBeUndefined();
    expect(await durableIds(bureau, 'goal:')).toEqual([]);
    expect(
      diagnostics.scope('goals').filter((diagnostic) => diagnostic.message.includes('restart')),
    ).toEqual([]);
  });
});

describe('a recorded cancellation whose controller is stuck in a validator that never returns', () => {
  it('is completed by recover(): the controller is ended and the goal commits canceled', async () => {
    database = createTestDatabase('stuck-validator');
    const stuck = createLatch();
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator({ before: () => stuck.promise })],
    });
    await track(bureau);
    cleanups.push(() => stuck.release());
    await bureau.goals.create(goalRequest());
    await status(bureau, 'evaluating');
    // The marker is recorded without the signal (the process that wrote it died
    // first), and the controller is inside an activity that will not return.
    const view = await inspection();
    const marked = await view.store.requestCancellation(
      'g1',
      { requestedAt: '2026-10-02T12:00:00.000Z' },
      '2026-10-02T12:00:00.000Z',
    );
    expect(marked.status).toBe('updated');

    const report = await bureau.goals.recover('g1');

    // The controller was not left running: it was ended and the record committed.
    expect(['canceled', 'cancellation-pending']).toContain(report.goals[0]?.outcome as string);
    await status(bureau, 'canceled');
    expect(await workflowStatus(bureau, 'goal:g1')).toBe('cancelled');
    // The controller's finalizer finishes on its own, after which nothing is owed.
    const finished = await pollUntil(async () => {
      const again = await bureau.goals.recover('g1');
      return again.goals[0]?.outcome === 'already-terminal';
    });
    expect(finished).toBe(true);
  });
});

describe('a canceled goal whose workflow this bureau cannot read', () => {
  /** A canceled record with its marker, as a process that committed it and then died left it. */
  async function seedCanceled() {
    const view = await inspection();
    await seedRunning(view);
    const marked = await view.store.requestCancellation(
      'g1',
      { requestedAt: '2026-10-02T12:00:00.000Z' },
      '2026-10-02T12:00:00.000Z',
    );
    if (marked.status !== 'updated')
      throw new Error(`could not mark the cancellation: ${marked.status}`);
    const committed = await commitCancellation(
      view.store,
      marked.record,
      currentEpochMilliseconds(),
    );
    expect(committed.status).toBe('applied');
  }

  async function bootWithoutEngine() {
    const bureau = await createBureau({
      agents: { worker: workerAgent(hangForever) },
      validators: [createCheckValidator()],
      storage: { type: 'sqlite', path: database.path },
      durableExecution: false,
      onDiagnostic: createDiagnostics().onDiagnostic,
    });
    return track(bureau as unknown as Bureau);
  }

  it('is not acknowledged by a bureau with no durable engine, and is not closed over either', async () => {
    database = createTestDatabase('no-engine');
    await seedCanceled();
    const bureau = await bootWithoutEngine();

    expect(await bureau.goals.cancel('g1')).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['durable-engine'],
    });
    // Closing would take it out of the boot sweep with its workflow unconfirmed.
    expect(await bureau.goals.close('g1')).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['durable-engine'],
    });
    const stillOpen = await bureau.goals.get('g1');
    expect(stillOpen?.closedAt).toBeUndefined();
  });

  it('has its marked cancellation committed at boot, and the boot report says the goal cannot be verified', async () => {
    database = createTestDatabase('no-engine-marked');
    const view = await inspection();
    await seedRunning(view);
    const marked = await view.store.requestCancellation(
      'g1',
      { requestedAt: '2026-10-02T12:00:00.000Z' },
      '2026-10-02T12:00:00.000Z',
    );
    expect(marked.status).toBe('updated');
    const bureau = await bootWithoutEngine();

    const report = await bureau.waitForRecovery?.();

    // The boot sweep ran without an engine: the marker the user asked for is committed.
    const committed = await bureau.goals.get('g1');
    expect(committed?.status).toBe('canceled');
    // But nothing was read back, so the boot is not clean.
    expect(report?.outcome).toBe('partial');
    expect(report?.perRunFailures).toEqual([
      { runId: 'g1', reason: expect.stringContaining('durable engine') },
    ]);
  });

  it('is acknowledged and closed once a bureau with an engine reads its workflow ended', async () => {
    database = createTestDatabase('no-engine-then-engine');
    await seedCanceled();
    const idle = await bootWithoutEngine();
    expect(await idle.goals.close('g1')).toMatchObject({ outcome: 'cancellation-pending' });
    await idle.dispose();

    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangForever) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();

    expect(await bureau.goals.close('g1')).toMatchObject({
      outcome: 'closed',
      goal: { status: 'canceled' },
    });
    const closedGoal = await bureau.goals.get('g1');
    expect(typeof closedGoal?.closedAt).toBe('string');
  });
});

describe('a goal whose stored record cannot be read', () => {
  async function bootOverUnreadable() {
    database = createTestDatabase('unreadable-record');
    const view = await inspection();
    await seedRunning(view);
    await view.kv.set(goalRecordKey('g1'), 'not json');
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangForever) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    return bureau;
  }

  it('is a failure of the boot, not a clean recovery', async () => {
    const bureau = await bootOverUnreadable();

    const report = await bureau.waitForRecovery?.();

    expect(report?.outcome).toBe('partial');
    expect(report?.perRunFailures).toEqual([
      { runId: 'g1', reason: expect.stringContaining('unreadable') },
    ]);
  });

  it('is not called not-found by cancel, close, or recover', async () => {
    const bureau = await bootOverUnreadable();
    await bureau.waitForRecovery?.();

    expect(await bureau.goals.cancel('g1')).toEqual({ outcome: 'record-unreadable' });
    expect(await bureau.goals.close('g1')).toEqual({ outcome: 'record-unreadable' });
    const recovered = await bureau.goals.recover('g1');
    expect(recovered.goals).toEqual([
      { goalRunId: 'g1', outcome: 'unrecoverable', detail: expect.stringContaining('unreadable') },
    ]);
    // An id nothing was ever stored under is still absent.
    expect(await bureau.goals.cancel('nobody')).toEqual({ outcome: 'not-found' });
  });

  it('reads to a principal-scoped caller exactly as a goal it does not own or that is not there', async () => {
    const bureau = await bootOverUnreadable();
    await bureau.waitForRecovery?.();
    const scoped = { principal: 'alice' };

    // The record has no readable owner, so a scoped caller has no claim on it
    // and must not learn that a fault is stored there.
    expect(await bureau.goals.cancel('g1', scoped)).toEqual(
      await bureau.goals.cancel('nobody', scoped),
    );
    expect(await bureau.goals.close('g1', scoped)).toEqual(
      await bureau.goals.close('nobody', scoped),
    );
    expect(await bureau.goals.recover('g1', scoped)).toEqual({
      goals: [{ goalRunId: 'g1', outcome: 'not-found' }],
      failures: [],
    });
    expect(await bureau.goals.get('g1', scoped)).toBeUndefined();
    expect(await bureau.goals.active('g1', scoped)).toBeUndefined();
    expect(await bureau.goals.list(scoped)).toEqual([]);
    const sweep = await bureau.goals.recover(undefined, scoped);
    expect(sweep).toEqual({ goals: [], failures: [] });
  });
});

describe('a goal read by a bureau with no durable engine', () => {
  async function bootWithoutEngine() {
    const bureau = await createBureau({
      agents: { worker: workerAgent(hangForever) },
      validators: [createCheckValidator()],
      storage: { type: 'sqlite', path: database.path },
      durableExecution: false,
      onDiagnostic: createDiagnostics().onDiagnostic,
    });
    return track(bureau as unknown as Bureau);
  }

  it('does not call a missing engine a missing run: active() names the fault', async () => {
    database = createTestDatabase('no-engine-active');
    await seedRunning(await inspection());
    const bureau = await bootWithoutEngine();

    const active = await bureau.goals.active('g1');

    expect(active).toMatchObject({ kind: 'attempt', runStatus: null });
    expect(
      active !== undefined && 'runStatusError' in active ? active.runStatusError : undefined,
    ).toContain('durable engine');
  });

  it('is a failure of the boot, not a clean one, when the cleanup a closed goal owes has no engine to run on', async () => {
    database = createTestDatabase('no-engine-owed-cleanup');
    const view = await inspection();
    const attempt = await seedRunning(view);
    await view.store.applyTransition({
      goalRunId: 'g1',
      seq: 2,
      transitionId: goalTransitionId('g1', 2),
      to: 'failed',
      at: '2026-10-02T12:00:00.000Z',
      cause: 'attempt run failed',
      terminalReason: 'attempt-run-failed',
      attempt: { ...attempt, status: 'failed' },
      active: null,
    });
    // The closure committed and the process died before it cleaned up.
    const closure = await view.store.close('g1', '2026-10-02T12:00:01.000Z');
    expect(closure.status).toBe('updated');
    const bureau = await bootWithoutEngine();

    const report = await bureau.waitForRecovery?.();

    expect(report?.outcome).toBe('partial');
    expect(report?.perRunFailures).toEqual([
      { runId: 'g1', reason: expect.stringContaining('durable engine') },
    ]);
    const stored = await bureau.goals.get('g1');
    expect(stored?.cleanedUpAt).toBeUndefined();
  });

  it('does not call a controller it could not look for one it never had: close() leaves cleanup unresolved', async () => {
    database = createTestDatabase('no-engine-close');
    const view = await inspection();
    const attempt = await seedRunning(view);
    await view.store.applyTransition({
      goalRunId: 'g1',
      seq: 2,
      transitionId: goalTransitionId('g1', 2),
      to: 'failed',
      at: '2026-10-02T12:00:00.000Z',
      cause: 'attempt run failed',
      terminalReason: 'attempt-run-failed',
      attempt: { ...attempt, status: 'failed' },
      active: null,
    });
    const bureau = await bootWithoutEngine();

    const closed = await bureau.goals.close('g1');

    expect(closed).toMatchObject({
      outcome: 'closed',
      goal: { status: 'failed' },
      cleanup: { status: 'unresolved', reason: 'unreachable' },
    });
  });
  describe('a repeated create is recognized before the current capabilities are asked', () => {
    it('answers existing for a goal still running when the bureau has no durable engine, naming the controller it could not ensure', async () => {
      database = createTestDatabase('repeat-no-engine');
      await seedRunning(await inspection());
      const bureau = await bootWithoutEngine();

      const repeated = await bureau.goals.create(goalRequest());

      expect(repeated).toMatchObject({
        outcome: 'existing',
        goal: { goalRunId: 'g1', status: 'running' },
        controller: { status: 'start-failed', reason: expect.stringContaining('durable engine') },
      });
    });

    it('answers existing for a goal that has ended, whatever the bureau can do now', async () => {
      database = createTestDatabase('repeat-terminal');
      const view = await inspection();
      const attempt = await seedRunning(view);
      await view.store.applyTransition({
        goalRunId: 'g1',
        seq: 2,
        transitionId: goalTransitionId('g1', 2),
        to: 'failed',
        at: '2026-10-02T12:00:00.000Z',
        cause: 'attempt run failed',
        terminalReason: 'attempt-run-failed',
        attempt: { ...attempt, status: 'failed' },
        active: null,
      });
      const bureau = await bootWithoutEngine();

      const repeated = await bureau.goals.create(goalRequest());

      expect(repeated).toMatchObject({ outcome: 'existing', goal: { status: 'failed' } });
      expect('controller' in repeated).toBe(false);
    });

    it('answers existing when the catalog no longer holds the goal agent or its validator', async () => {
      database = createTestDatabase('repeat-catalog-gone');
      await seedRunning(await inspection());
      const { bureau } = await bootOver({
        path: database.path,
        agents: { other: workerAgent(hangForever) },
        validators: [],
      });
      await track(bureau);

      const repeated = await bureau.goals.create(goalRequest());

      expect(repeated).toMatchObject({ outcome: 'existing', goal: { goalRunId: 'g1' } });
    });

    it('still refuses a different request under a stored id, and a new id with no capability, as before', async () => {
      database = createTestDatabase('repeat-conflict');
      await seedRunning(await inspection());
      const bureau = await bootWithoutEngine();

      expect(await bureau.goals.create(goalRequest({ prompt: 'another' }))).toMatchObject({
        outcome: 'conflict',
      });
      expect(await bureau.goals.create(goalRequest({ goalRunId: 'g2' }))).toMatchObject({
        outcome: 'rejected',
        code: 'durable-unavailable',
      });
    });
  });
});
