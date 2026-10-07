/**
 * COR-851 — the `goalRun` workflow's definition-level finalizer.
 *
 * A hard `engine.cancel` ends the generator mid-flight, so the cooperative
 * `abortAttempt` never runs. The finalizer is what still stops the active
 * attempt's run: the controller stages the run to stop at every decision point,
 * and Weft drives `finalizeGoal` with the last staged value after the
 * `cancelled` terminal, across a crash.
 */

import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';

import {
  crashAndAdopt,
  createGoalEngine,
  createHarness,
  finishAttempt,
  GOAL_RUN_ID,
  GOAL_WORKFLOW_ID,
  type GoalHarness,
  identifiers,
  pollUntil,
  startGoalWorkflow,
  statusesOf,
} from './goal-workflow-fixtures';
import type { GoalWorkflowResult } from './goal-workflow-ports';

type Engine = Awaited<ReturnType<typeof createGoalEngine>>;

const runIdOf = (index: number) => `goal-${GOAL_RUN_ID}-a${index}`;

const attemptRunning = (harness: GoalHarness, index: number) => () =>
  harness.world.record().attempts[index]?.status === 'running';

async function finalizerStatusOf(run: Engine, harness: GoalHarness) {
  await run.engine.runMaintenance(harness.clock.getNow());
  const finalizer = await run.engine.getFinalizerStatus(GOAL_WORKFLOW_ID);
  return finalizer?.status ?? null;
}

async function untilFinalized(run: Engine, harness: GoalHarness): Promise<void> {
  await pollUntil(async () => (await finalizerStatusOf(run, harness)) === 'succeeded');
}

describe('createGoalWorkflow finalizer', () => {
  it('stops the active attempt run after a hard cancel the controller never saw', async () => {
    const harness = createHarness();
    const run = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(run);
      await pollUntil(attemptRunning(harness, 0));
      expect(harness.world.abortedRuns).toEqual([]);

      await run.engine.cancel(GOAL_WORKFLOW_ID);
      expect(await throwingRejectionOf(handle.result())).toThrow('Workflow cancelled');
      await untilFinalized(run, harness);

      // The generator was killed: it committed nothing. The finalizer alone stopped the run.
      expect(harness.world.abortedRuns).toEqual([runIdOf(0)]);
      expect(statusesOf(harness.world)).toEqual(['running']);
    } finally {
      run.engine[Symbol.dispose]();
    }
  });

  it('runs with the recorded state after a crash-adopt and then a cancel', async () => {
    const harness = createHarness();
    const a = await createGoalEngine(harness);
    await startGoalWorkflow(a);
    await pollUntil(attemptRunning(harness, 0));

    const { adopter, handle } = await crashAndAdopt(harness, a);
    try {
      // The adopted controller replayed from the top and re-staged the same state.
      expect(harness.world.abortedRuns).toEqual([]);
      await adopter.engine.cancel(GOAL_WORKFLOW_ID);
      expect(await throwingRejectionOf(handle.result())).toThrow('Workflow cancelled');
      await untilFinalized(adopter, harness);

      expect(harness.world.abortedRuns).toEqual([runIdOf(0)]);
      expect(harness.world.startedRuns).toEqual([runIdOf(0)]);
      expect(harness.world.calls.filter((call) => call === 'start:0')).toHaveLength(1);
    } finally {
      adopter.engine[Symbol.dispose]();
    }
  });

  it('targets the attempt in flight, not an earlier one, once a retry is running', async () => {
    const harness = createHarness({ retryOn: ['validator-fail-retryable'] });
    harness.world.validatorOutcomes.push({
      kind: 'fail',
      feedback: 'try again',
      evidence: [],
      retryable: true,
    });
    const run = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(run);
      await pollUntil(attemptRunning(harness, 0));
      await finishAttempt(run, 0);
      await pollUntil(attemptRunning(harness, 1));

      await run.engine.cancel(GOAL_WORKFLOW_ID);
      expect(await throwingRejectionOf(handle.result())).toThrow('Workflow cancelled');
      await untilFinalized(run, harness);

      expect(harness.world.abortedRuns).toEqual([runIdOf(1)]);
    } finally {
      run.engine[Symbol.dispose]();
    }
  });

  it('stops the in-flight run when a hard cancel lands before the replaying controller reaches the live frontier', async () => {
    const harness = createHarness();
    const a = await createGoalEngine(harness);
    await startGoalWorkflow(a);
    await pollUntil(attemptRunning(harness, 0));

    // The controller is down while the goal moves on: attempt 0 ends and attempt 1
    // starts, so the record is two iterations ahead of what a replaying controller
    // has read. The replay window is not externally steppable, so hold the
    // adopted controller at that earlier iteration by advancing the record while
    // it is down. It re-stages attempt 0's run, the last value it can stage until
    // it reaches the frontier.
    a.engine[Symbol.dispose]();
    const [first] = harness.world.record().attempts;
    if (first === undefined) throw new Error('Expected attempt 0 to be recorded.');
    await harness.world.ports.startAttempt({
      goalRunId: GOAL_RUN_ID,
      attemptIndex: 1,
      attemptId: identifiers.attemptId(GOAL_RUN_ID, 1),
      runId: runIdOf(1),
    });
    harness.world.patchRecord({
      attempts: [
        { ...first, status: 'aborted' },
        {
          ...first,
          attemptIndex: 1,
          attemptId: identifiers.attemptId(GOAL_RUN_ID, 1),
          runId: runIdOf(1),
          status: 'running',
        },
      ],
    });

    const { adopter, handle } = await crashAndAdopt(harness, a);
    try {
      expect(harness.world.abortedRuns).toEqual([]);
      await adopter.engine.cancel(GOAL_WORKFLOW_ID);
      expect(await throwingRejectionOf(handle.result())).toThrow('Workflow cancelled');
      await untilFinalized(adopter, harness);

      // No recover() or cancel() follow-up: the finalizer alone must end the
      // in-flight run. It also repeats the stale staged target, an idempotent
      // no-op on a real run that already ended.
      expect(harness.world.abortedRuns).toEqual([runIdOf(0), runIdOf(1)]);
    } finally {
      adopter.engine[Symbol.dispose]();
    }
  });

  it('owes no finalizer to a goal that ended on its own', async () => {
    const harness = createHarness();
    const run = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(run);
      await pollUntil(attemptRunning(harness, 0));
      await finishAttempt(run, 0);
      const result = (await handle.result()) as GoalWorkflowResult;
      expect(result).toMatchObject({ status: 'succeeded' });

      expect(await finalizerStatusOf(run, harness)).toBeNull();
      expect(harness.world.abortedRuns).toEqual([]);
    } finally {
      run.engine[Symbol.dispose]();
    }
  });
});
