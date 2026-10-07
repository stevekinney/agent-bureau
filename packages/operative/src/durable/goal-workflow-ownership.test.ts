/**
 * COR-851 — ownership, registration, and guard tests for the durable `goalRun`
 * workflow: a second controller cannot run beside the first, the workflow is
 * registered without services (so Weft writes no services marker and never
 * consults the resolver), and a controller that cannot make progress fails
 * loudly instead of writing history forever.
 */

import { KEYS } from '@lostgradient/weft';
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
  pollUntil,
  startGoalWorkflow,
  statusesOf,
} from './goal-workflow-fixtures';
import {
  GOAL_CANCEL_SIGNAL,
  GOAL_WORKFLOW_TYPE,
  type GoalWorkflowResult,
} from './goal-workflow-ports';

const attemptRunning = (harness: GoalHarness, index: number) => () =>
  harness.world.record().attempts[index]?.status === 'running';

describe('createGoalWorkflow ownership', () => {
  it('refuses a second controller for the same goal while the first is live', async () => {
    const harness = createHarness();
    const a = await createGoalEngine(harness);
    const b = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));

      expect(await throwingRejectionOf(startGoalWorkflow(a))).toThrow();
      expect(await throwingRejectionOf(startGoalWorkflow(b))).toThrow();
      // The claim is a lease: until it lapses, no other engine may run the generator.
      expect(await throwingRejectionOf(b.engine.resume(GOAL_WORKFLOW_ID))).toThrow();

      await finishAttempt(a, 0);
      const result = (await handle.result()) as GoalWorkflowResult;
      expect(result).toMatchObject({ status: 'succeeded' });
      // One controller, one start, one transition each.
      expect(harness.world.startedRuns).toEqual([`goal-${GOAL_RUN_ID}-a0`]);
      expect(statusesOf(harness.world)).toEqual(['running', 'evaluating', 'succeeded']);
    } finally {
      a.engine[Symbol.dispose]();
      b.engine[Symbol.dispose]();
    }
  });

  it('answers a deposed controller’s replayed commit with duplicate, never a second transition', async () => {
    const harness = createHarness();
    const crash = harness.world.crashAfter('commit:running');
    const a = await createGoalEngine(harness);
    await startGoalWorkflow(a);
    await crash.reached;

    const { adopter, handle } = await crashAndAdopt(harness, a);
    try {
      await pollUntil(attemptRunning(harness, 0));
      await finishAttempt(adopter, 0);
      await handle.result();
      expect(harness.world.calls.filter((call) => call.startsWith('commit:running'))).toEqual([
        'commit:running:applied',
        'commit:running:duplicate',
      ]);
      expect(
        harness.world.transitions.filter((transition) => transition.to === 'running'),
      ).toHaveLength(1);
    } finally {
      adopter.engine[Symbol.dispose]();
    }
  });
});

describe('createGoalWorkflow registration', () => {
  it('registers under the goalRun type', () => {
    expect(GOAL_WORKFLOW_TYPE).toBe('goalRun');
  });

  it('writes no services marker and never consults the services resolver, even across a recovery', async () => {
    const harness = createHarness();
    const resolverCalls: string[] = [];
    const resolveWorkflowServices = () => {
      resolverCalls.push('resolved');
      throw new Error('a goal workflow has no services to resolve');
    };
    const a = await createGoalEngine(harness, { resolveWorkflowServices });
    await startGoalWorkflow(a);
    await pollUntil(attemptRunning(harness, 0));
    expect(await harness.storage.get(KEYS.workflowHasServices(GOAL_WORKFLOW_ID))).toBeNull();

    const { adopter, handle } = await crashAndAdopt(harness, a, { resolveWorkflowServices });
    try {
      await finishAttempt(adopter, 0);
      const result = (await handle.result()) as GoalWorkflowResult;
      expect(result).toMatchObject({ status: 'succeeded' });
      expect(resolverCalls).toEqual([]);
      expect(await harness.storage.get(KEYS.workflowHasServices(GOAL_WORKFLOW_ID))).toBeNull();
    } finally {
      adopter.engine[Symbol.dispose]();
    }
  });
});

describe('createGoalWorkflow guards', () => {
  it('fails loudly when every commit is answered stale', async () => {
    const harness = createHarness();
    harness.world.forceCommit({ status: 'stale' });
    const a = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(a);
      expect(await throwingRejectionOf(handle.result())).toThrow('refused 5 times in a row');
      expect(harness.world.startedRuns).toHaveLength(1);
    } finally {
      a.engine[Symbol.dispose]();
    }
  });

  it('fails immediately on a rejection that reading the record cannot resolve', async () => {
    const harness = createHarness();
    harness.world.forceCommit({ status: 'rejected', reason: 'illegal-transition' });
    const a = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(a);
      expect(await throwingRejectionOf(handle.result())).toThrow(
        'was rejected: illegal-transition',
      );
      expect(harness.world.calls.filter((call) => call.startsWith('commit'))).toHaveLength(1);
    } finally {
      a.engine[Symbol.dispose]();
    }
  });

  it('reports the record unavailable when a commit finds it missing', async () => {
    const harness = createHarness();
    harness.world.forceCommit({ status: 'missing' });
    const a = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(a);
      expect(await handle.result()).toEqual({
        schemaVersion: 1,
        outcome: 'record-unavailable',
        goalRunId: GOAL_RUN_ID,
      });
    } finally {
      a.engine[Symbol.dispose]();
    }
  });

  it('fails loudly instead of spinning when it keeps waking with nothing to do', async () => {
    const harness = createHarness();
    const a = await createGoalEngine(harness);
    try {
      const handle = await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      // Cancel signals with no marker behind them each wake the controller and
      // each are consumed, so the record never changes underneath it.
      for (let index = 0; index < 30; index += 1) {
        await a.engine.signal(GOAL_WORKFLOW_ID, GOAL_CANCEL_SIGNAL, null, {
          signalId: `spurious-${index}`,
        });
      }
      expect(await throwingRejectionOf(handle.result())).toThrow('without anything to do');
      expect(harness.world.transitions.map((transition) => transition.to)).toEqual(['running']);
    } finally {
      a.engine[Symbol.dispose]();
    }
  });
});
