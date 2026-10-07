/**
 * COR-851 — crash-and-adopt tests for the durable `goalRun` workflow.
 *
 * Every test runs two engines over one `MemoryStorage`, one manual clock, and
 * one fake world. Engine A is "crashed" by disposing it (the process died: no
 * terminal state was written) and letting the manual clock pass its workflow
 * claim's TTL; engine B then adopts the workflow and replays it. A port call
 * that `crashAfter` names performs its effect and never returns, so the effect
 * landed in the world but A never recorded its result, which is the window a
 * real crash leaves.
 */

import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  crashAndAdopt,
  type CrashLabel,
  createGoalEngine,
  createHarness,
  finishAttempt,
  GOAL_RUN_ID,
  GOAL_WORKFLOW_ID,
  type GoalHarness,
  type GoalWorld,
  pollUntil,
  startGoalWorkflow,
  statusesOf,
} from './goal-workflow-fixtures';
import { GOAL_CANCEL_SIGNAL, type GoalWorkflowResult } from './goal-workflow-ports';

type Engine = Awaited<ReturnType<typeof createGoalEngine>>;

const attemptRunning = (harness: GoalHarness, index: number) => () =>
  harness.world.record().attempts[index]?.status === 'running';

/** Lets a parked controller register its waiters before the test crashes it. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await yieldToPortableEventLoop();
}

const runIdOf = (index: number) => `goal-${GOAL_RUN_ID}-a${index}`;

/** What must match between a crashed-and-adopted goal and one that never crashed. */
function summarize(world: GoalWorld) {
  const record = world.record();
  return {
    status: record.status,
    terminalReason: record.terminalReason,
    failureDetail: record.failureDetail,
    transitionSeq: record.transitionSeq,
    statuses: statusesOf(world),
    attempts: record.attempts.map((attempt) => ({
      status: attempt.status,
      finishReason: attempt.finishReason,
      feedback: attempt.feedback,
      usage: attempt.usage,
      decision: attempt.validation?.decisionId,
    })),
    usage: {
      attempts: record.usage.attempts,
      steps: record.usage.steps,
      tokens: record.usage.tokens,
    },
    startedRuns: world.startedRuns,
    abortedRuns: world.abortedRuns,
  };
}

describe('createGoalWorkflow crash and adopt', () => {
  describe('restart while the goal is in each status', () => {
    it('resumes a goal that is running, without starting its attempt a second time', async () => {
      const harness = createHarness();
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      await settle();

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        await finishAttempt(adopter, 0);
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'succeeded', terminalReason: 'validator-passed' });
        expect(harness.world.startedRuns).toEqual([runIdOf(0)]);
        expect(harness.world.calls.filter((call) => call === 'start:0')).toHaveLength(1);
        expect(statusesOf(harness.world)).toEqual(['running', 'evaluating', 'succeeded']);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('re-runs the validator for a goal that crashed while evaluating and commits one decision', async () => {
      const harness = createHarness();
      const crash = harness.world.crashAfter('validate');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      await finishAttempt(a, 0);
      await crash.reached;
      expect(harness.world.record().status).toBe('evaluating');

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'succeeded' });
        // At-least-once: the validator ran again. The decision still committed once.
        expect(harness.world.calls.filter((call) => call === 'validate:0')).toHaveLength(2);
        expect(statusesOf(harness.world)).toEqual(['running', 'evaluating', 'succeeded']);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('re-arms the deadline for a goal that crashed parked on its timer', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 2, maximumTotalDurationMs: 120 },
      });
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      await settle();

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        harness.clock.advance(10_000);
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({
          status: 'exhausted',
          terminalReason: 'aggregate-budget-exceeded',
        });
        expect(statusesOf(harness.world)).toEqual(['running', 'exhausted']);
        expect(harness.world.abortedRuns).toEqual([runIdOf(0)]);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('starts the next attempt for a goal that crashed after committing retrying', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 3, maximumTotalDurationMs: 3_600_000 },
        retryOn: ['validator-fail-retryable'],
      });
      harness.world.validatorOutcomes.push({
        kind: 'fail',
        feedback: 'try again',
        evidence: [],
        retryable: true,
      });
      const crash = harness.world.crashAfter('commit:retrying');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      await finishAttempt(a, 0);
      await crash.reached;
      expect(harness.world.record().status).toBe('retrying');

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        await pollUntil(attemptRunning(harness, 1));
        await finishAttempt(adopter, 1);
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'succeeded' });
        expect(harness.world.startedRuns).toEqual([runIdOf(0), runIdOf(1)]);
        expect(harness.world.startFeedback.get(1)).toBe('try again');
        // The replayed commit answered `duplicate`: the same transition was already current.
        expect(harness.world.calls).toContain('commit:retrying:duplicate');
        expect(statusesOf(harness.world)).toEqual([
          'running',
          'evaluating',
          'retrying',
          'running',
          'evaluating',
          'succeeded',
        ]);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('finishes a cancellation that crashed after stopping the attempt', async () => {
      const harness = createHarness();
      const crash = harness.world.crashAfter('abort');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      harness.world.requestCancellation();
      await a.engine.signal(GOAL_WORKFLOW_ID, GOAL_CANCEL_SIGNAL, null);
      await crash.reached;
      expect(harness.world.record().status).toBe('running');

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'canceled', terminalReason: 'goal-canceled' });
        expect(statusesOf(harness.world)).toEqual(['running', 'canceled']);
        // The second abort found the run already stopped.
        expect(harness.world.abortedRuns).toEqual([runIdOf(0)]);
        expect(harness.world.calls.filter((call) => call === 'abort:0')).toHaveLength(2);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('returns the result of a goal that crashed after committing canceled', async () => {
      const harness = createHarness();
      const crash = harness.world.crashAfter('commit:canceled');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      harness.world.requestCancellation();
      await a.engine.signal(GOAL_WORKFLOW_ID, GOAL_CANCEL_SIGNAL, null);
      await crash.reached;

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'canceled', transitionSeq: 2 });
        expect(harness.world.calls).toContain('commit:canceled:duplicate');
        expect(statusesOf(harness.world)).toEqual(['running', 'canceled']);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('returns the result of a goal that crashed after its terminal commit, committing nothing more', async () => {
      const harness = createHarness();
      const crash = harness.world.crashAfter('commit:succeeded');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await pollUntil(attemptRunning(harness, 0));
      await finishAttempt(a, 0);
      await crash.reached;

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'succeeded', transitionSeq: 3 });
        expect(harness.world.transitions).toHaveLength(3);
        // Engine A's ten calls end at the commit it never recorded. Engine B replays
        // every earlier slot from history (no second start, no second validator run),
        // re-issues only that commit, and reads the terminal record once.
        expect(harness.world.calls).toEqual([
          'load',
          'start:0',
          'commit:running:applied',
          'load',
          'load',
          'commit:evaluating:applied',
          'load',
          'validate:0',
          'load',
          'commit:succeeded:applied',
          'commit:succeeded:duplicate',
          'load',
        ]);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });
  });

  describe('start-or-adopt after a crash around the attempt start', () => {
    it('completes a start whose claim was recorded but whose run never started', async () => {
      const harness = createHarness();
      const crash = harness.world.crashAfter('start:claimed');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await crash.reached;
      expect(harness.world.claims.has(runIdOf(0))).toBe(true);
      expect(harness.world.startedRuns).toEqual([]);

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(adopter, 0);
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'succeeded' });
        // Started once, from the claim; never a second claim, never attempt 1.
        expect(harness.world.startedRuns).toEqual([runIdOf(0)]);
        expect([...harness.world.claims]).toEqual([runIdOf(0)]);
        expect(harness.world.calls.filter((call) => call === 'start:0')).toHaveLength(2);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('adopts a run that started but whose start result was never recorded', async () => {
      const harness = createHarness();
      const crash = harness.world.crashAfter('start:started');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await crash.reached;
      expect(harness.world.startedRuns).toEqual([runIdOf(0)]);
      expect(harness.world.record().status).toBe('pending');

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(adopter, 0);
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'succeeded' });
        expect(harness.world.startedRuns).toEqual([runIdOf(0)]);
        expect(harness.world.abortedRuns).toEqual([]);
        expect(harness.world.record().attempts[0]?.sessionId).toBe(`session-${runIdOf(0)}`);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('stops a started run exactly once when the deadline passed between starting it and recording it', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 2, maximumTotalDurationMs: 25 },
      });
      const crash = harness.world.crashAfter('start:started');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await crash.reached;
      expect(harness.world.startedRuns).toEqual([runIdOf(0)]);

      // The takeover outlasts the bound, so the replayed start finds the goal over.
      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({
          status: 'exhausted',
          terminalReason: 'aggregate-budget-exceeded',
        });
        expect(harness.world.startedRuns).toEqual([runIdOf(0)]);
        expect(harness.world.abortedRuns).toEqual([runIdOf(0)]);
        expect(harness.world.calls.filter((call) => call === 'abort:0')).toHaveLength(1);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });

    it('stops an orphaned run when the goal was canceled between starting it and committing it', async () => {
      const harness = createHarness();
      const crash = harness.world.crashAfter('start:started');
      const a = await createGoalEngine(harness);
      await startGoalWorkflow(a);
      await crash.reached;
      harness.world.requestCancellation();

      const { adopter, handle } = await crashAndAdopt(harness, a);
      try {
        const result = (await handle.result()) as GoalWorkflowResult;
        expect(result).toMatchObject({ status: 'canceled' });
        expect(harness.world.abortedRuns).toEqual([runIdOf(0)]);
        expect(statusesOf(harness.world)).toEqual(['canceled']);
      } finally {
        adopter.engine[Symbol.dispose]();
      }
    });
  });

  describe('replaying each branch', () => {
    interface Scenario {
      readonly name: string;
      readonly options?: Parameters<typeof createHarness>[0];
      readonly finalCommit: CrashLabel;
      readonly arrange?: (harness: GoalHarness) => void;
      readonly drive: (harness: GoalHarness, run: Engine) => Promise<void>;
    }

    const failRetryable = {
      kind: 'fail',
      feedback: 'fix it',
      evidence: [],
      retryable: true,
    } as const;

    const scenarios: readonly Scenario[] = [
      {
        name: 'pass',
        finalCommit: 'commit:succeeded',
        drive: async (harness, run) => {
          await pollUntil(attemptRunning(harness, 0));
          await finishAttempt(run, 0);
        },
      },
      {
        name: 'retry then pass',
        options: {
          bounds: { maximumAttempts: 3, maximumTotalDurationMs: 3_600_000 },
          retryOn: ['validator-fail-retryable'],
        },
        arrange: (harness) => {
          harness.world.validatorOutcomes.push(failRetryable, { kind: 'pass', evidence: [] });
        },
        finalCommit: 'commit:succeeded',
        drive: async (harness, run) => {
          await pollUntil(attemptRunning(harness, 0));
          await finishAttempt(run, 0);
          await pollUntil(attemptRunning(harness, 1));
          await finishAttempt(run, 1);
        },
      },
      {
        name: 'exhaustion',
        options: {
          bounds: { maximumAttempts: 2, maximumTotalDurationMs: 3_600_000 },
          retryOn: ['validator-fail-retryable'],
        },
        arrange: (harness) => {
          harness.world.validatorOutcomes.push(failRetryable, failRetryable);
        },
        finalCommit: 'commit:exhausted',
        drive: async (harness, run) => {
          await pollUntil(attemptRunning(harness, 0));
          await finishAttempt(run, 0);
          await pollUntil(attemptRunning(harness, 1));
          await finishAttempt(run, 1);
        },
      },
      {
        name: 'a run that did not reach a stop condition',
        finalCommit: 'commit:failed',
        drive: async (harness, run) => {
          await pollUntil(attemptRunning(harness, 0));
          await finishAttempt(run, 0, { finishReason: 'maximum-steps' });
        },
      },
      {
        name: 'a start that failed',
        finalCommit: 'commit:failed',
        arrange: (harness) => harness.world.failNextStart('Starting the inner run failed: no room'),
        drive: () => Promise.resolve(),
      },
      {
        name: 'cancellation',
        finalCommit: 'commit:canceled',
        drive: async (harness, run) => {
          await pollUntil(attemptRunning(harness, 0));
          harness.world.requestCancellation();
          await run.engine.signal(GOAL_WORKFLOW_ID, GOAL_CANCEL_SIGNAL, null);
        },
      },
      {
        name: 'a cancellation that races a commit and is adopted from the rejection',
        finalCommit: 'commit:canceled',
        arrange: (harness) =>
          harness.world.beforeNextCommit('evaluating', () => harness.world.requestCancellation()),
        drive: async (harness, run) => {
          await pollUntil(attemptRunning(harness, 0));
          await finishAttempt(run, 0);
        },
      },
      {
        name: 'the deadline branch winning the race',
        options: { bounds: { maximumAttempts: 2, maximumTotalDurationMs: 25 } },
        finalCommit: 'commit:exhausted',
        drive: async (harness) => {
          await pollUntil(attemptRunning(harness, 0));
          harness.clock.advance(1_000);
        },
      },
    ];

    for (const scenario of scenarios) {
      it(`replays ${scenario.name} to the same record as an uninterrupted run`, async () => {
        const uninterrupted = createHarness(scenario.options);
        scenario.arrange?.(uninterrupted);
        const baselineEngine = await createGoalEngine(uninterrupted);
        const baselineHandle = await startGoalWorkflow(baselineEngine);
        await scenario.drive(uninterrupted, baselineEngine);
        const baselineResult = await baselineHandle.result();
        baselineEngine.engine[Symbol.dispose]();

        const crashed = createHarness(scenario.options);
        scenario.arrange?.(crashed);
        const crash = crashed.world.crashAfter(scenario.finalCommit);
        const a = await createGoalEngine(crashed);
        await startGoalWorkflow(a);
        await scenario.drive(crashed, a);
        await crash.reached;

        const { adopter, handle } = await crashAndAdopt(crashed, a);
        try {
          const result = await handle.result();
          expect(result).toEqual(baselineResult);
          expect(summarize(crashed.world)).toEqual(summarize(uninterrupted.world));
        } finally {
          adopter.engine[Symbol.dispose]();
        }
      });
    }
  });
});
