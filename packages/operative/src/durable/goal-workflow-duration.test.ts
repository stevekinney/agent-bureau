import { describe, expect, it } from 'bun:test';

import {
  decideAttemptRunFailure,
  decideCancellation,
  decideDurationElapsed,
  decideOutcome,
  type GoalBudget,
  type GoalOutcomeInput,
  isBudgetExceeded,
  type ProjectedValidatorResult,
} from '../goal-decision';
import { identifiers } from './goal-workflow-fixtures';
import type { GoalAttemptTerminalSignal, GoalWorkflowView } from './goal-workflow-ports';
import {
  buildEvaluationStarted,
  buildGoalForcedFinish,
  buildOpenAttempt,
  buildRunFinishDecision,
  buildStartFailure,
  buildValidationDecision,
  decisionContextFor,
  elapsedMilliseconds,
  isDeadlineElapsed,
  remainingMilliseconds,
} from './goal-workflow-transitions';

const NOW = Date.parse('2026-10-02T01:00:00.000Z');
const bounded = (createdAt: string) =>
  ({ createdAt, bounds: { maximumTotalDurationMs: 60_000 } }) as never;
const unbounded = (createdAt: string) =>
  ({ createdAt, bounds: { maximumTotalTokens: 10 } }) as never;

describe('the aggregate duration of a goal', () => {
  it('is measured from the record creation time', () => {
    const view = bounded('2026-10-02T00:59:30.000Z');
    expect(elapsedMilliseconds(view, NOW)).toBe(30_000);
    expect(remainingMilliseconds(view, NOW)).toBe(30_000);
    expect(isDeadlineElapsed(view, NOW)).toBe(false);
    expect(isDeadlineElapsed(bounded('2026-10-02T00:58:00.000Z'), NOW)).toBe(true);
  });

  it.each(['corrupt', '', 'not-a-date', 'Invalid Date'])(
    'spends a duration bound, rather than never consuming it, when the creation time is %p',
    (createdAt) => {
      const view = bounded(createdAt);
      expect(elapsedMilliseconds(view, NOW)).toBe(60_000);
      expect(remainingMilliseconds(view, NOW)).toBe(0);
      expect(isDeadlineElapsed(view, NOW)).toBe(true);
    },
  );

  it('reads a goal created at the very instant of the reading as no time elapsed', () => {
    const view = bounded('2026-10-02T01:00:00.000Z');
    expect(elapsedMilliseconds(view, NOW)).toBe(0);
    expect(remainingMilliseconds(view, NOW)).toBe(60_000);
    expect(isDeadlineElapsed(view, NOW)).toBe(false);
  });

  it.each(['2026-10-02T01:00:00.001Z', '2026-10-02T01:00:30.000Z', '2099-01-01T00:00:00.000Z'])(
    'spends a duration bound, rather than granting a fresh window at every reading, when the creation time %p is later than the reading',
    (createdAt) => {
      const view = bounded(createdAt);
      expect(elapsedMilliseconds(view, NOW)).toBe(60_000);
      expect(remainingMilliseconds(view, NOW)).toBe(0);
      expect(isDeadlineElapsed(view, NOW)).toBe(true);
    },
  );

  it('has no deadline to spend when the goal has no duration bound, whatever the creation time', () => {
    for (const createdAt of ['corrupt', '2026-10-02T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
      expect(remainingMilliseconds(unbounded(createdAt), NOW)).toBeUndefined();
      expect(isDeadlineElapsed(unbounded(createdAt), NOW)).toBe(false);
    }
  });

  it.each(['corrupt', '2026-10-02T01:00:00.001Z', '2099-01-01T00:00:00.000Z'])(
    'reads no time for a goal with no duration bound whose creation time %p cannot be used',
    (createdAt) => {
      expect(elapsedMilliseconds(unbounded(createdAt), NOW)).toBe(0);
    },
  );
});

const UNBOUNDED_IN_TIME: GoalBudget = { maximumAttempts: 3, maximumTotalTokens: 10 };
const BOUNDED_IN_TIME: GoalBudget = { maximumAttempts: 3, maximumTotalDurationMs: 60_000 };

const goalView = (
  createdAt: string,
  bounds: GoalBudget,
  recordedDurationMs = 0,
): GoalWorkflowView => ({
  goalRunId: 'goal-1',
  status: 'running',
  transitionSeq: 2,
  validator: { name: 'test-validator', version: '1.0.0' },
  bounds,
  retryPolicy: { retryOn: ['validator-fail-retryable'] },
  attempts: [
    {
      attemptId: 'goal-1:a0',
      attemptIndex: 0,
      runId: 'goal-goal-1-a0',
      sessionId: 'session-0',
      startedAt: '2026-10-02T00:59:00.000Z',
      usage: { steps: 0, tokens: 0 },
      status: 'running',
    },
  ],
  usage: { attempts: 1, steps: 0, tokens: 0, durationMs: recordedDurationMs },
  active: {
    kind: 'attempt',
    attemptId: 'goal-1:a0',
    runId: 'goal-goal-1-a0',
    startedAt: '2026-10-02T00:59:00.000Z',
  },
  createdAt,
});

const retryableFailure: GoalOutcomeInput = {
  outcome: { kind: 'fail', feedback: 'again', evidence: [], retryable: true },
  inputFeedback: undefined,
  operatorAborted: false,
};

const finished: GoalAttemptTerminalSignal = {
  finishReason: 'stop-condition',
  steps: 1,
  tokens: 5,
};

const validated: ProjectedValidatorResult = {
  identity: { name: 'test-validator', version: '1.0.0' },
  startedAt: '2026-10-02T00:59:50.000Z',
  completedAt: '2026-10-02T00:59:59.000Z',
  outcome: { kind: 'pass', evidence: [] },
};

/**
 * Every transition builder that records the aggregate usage, over one view,
 * and the usage the decision context reads. `usageFor` serves the first six
 * and `goalUsage` serves the last, so a clamp missing from either shows here.
 */
const recordedDurations = (view: GoalWorkflowView): Record<string, number | undefined> => {
  const attempt = view.attempts[0]!;
  return {
    buildOpenAttempt: buildOpenAttempt(view, identifiers, NOW, {
      attemptIndex: 1,
      sessionId: 'session-1',
    }).usage?.durationMs,
    buildEvaluationStarted: buildEvaluationStarted(view, identifiers, NOW, attempt, finished).usage
      ?.durationMs,
    buildRunFinishDecision: buildRunFinishDecision(view, identifiers, NOW, attempt, finished, {
      decision: decideCancellation(),
      attemptStatus: 'aborted',
    }).usage?.durationMs,
    buildValidationDecision: buildValidationDecision(
      view,
      identifiers,
      NOW,
      attempt,
      validated,
      decideCancellation(),
    ).usage?.durationMs,
    buildGoalForcedFinish: buildGoalForcedFinish(view, identifiers, NOW, decideCancellation()).usage
      ?.durationMs,
    buildStartFailure: buildStartFailure(view, identifiers, NOW, decideAttemptRunFailure('refused'))
      .usage?.durationMs,
    decisionContextFor: decisionContextFor(view, NOW).usage.durationMs,
  };
};

const allRecorded = (durationMs: number): Record<string, number> => ({
  buildOpenAttempt: durationMs,
  buildEvaluationStarted: durationMs,
  buildRunFinishDecision: durationMs,
  buildValidationDecision: durationMs,
  buildGoalForcedFinish: durationMs,
  buildStartFailure: durationMs,
  decisionContextFor: durationMs,
});

describe('the duration a goal transition records', () => {
  const UNUSABLE = ['corrupt', '2026-10-02T01:00:00.001Z', '2099-01-01T00:00:00.000Z'];

  it.each(UNUSABLE)(
    'records no time, not an unreadable-creation sentinel, for a goal with no duration bound created at %p',
    (createdAt) => {
      const view = goalView(createdAt, UNBOUNDED_IN_TIME);
      expect(recordedDurations(view)).toEqual(allRecorded(0));
    },
  );

  it.each(UNUSABLE)(
    'records exactly the spent bound, a finite reading, for a duration-bounded goal created at %p',
    (createdAt) => {
      const view = goalView(createdAt, BOUNDED_IN_TIME);
      expect(recordedDurations(view)).toEqual(allRecorded(60_000));
    },
  );

  it.each(UNUSABLE)(
    'still ends a duration-bounded goal created at %p as exhausted, and leaves an unbounded one running',
    (createdAt) => {
      const bounded = goalView(createdAt, BOUNDED_IN_TIME);
      expect(isDeadlineElapsed(bounded, NOW)).toBe(true);
      const boundedContext = decisionContextFor(bounded, NOW);
      expect(isBudgetExceeded(boundedContext.budget, boundedContext.usage)).toBe(true);
      expect(
        buildGoalForcedFinish(bounded, identifiers, NOW, decideDurationElapsed()),
      ).toMatchObject({
        to: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
        usage: { durationMs: 60_000 },
      });
      expect(decideOutcome(boundedContext, retryableFailure)).toMatchObject({
        kind: 'exhaust',
        reason: 'aggregate-budget-exceeded',
      });

      const open = goalView(createdAt, UNBOUNDED_IN_TIME);
      const openContext = decisionContextFor(open, NOW);
      expect(isDeadlineElapsed(open, NOW)).toBe(false);
      expect(isBudgetExceeded(openContext.budget, openContext.usage)).toBe(false);
      expect(decideOutcome(openContext, retryableFailure)).toMatchObject({ kind: 'retry' });
    },
  );

  it('records the time since creation for a goal whose creation time can be used', () => {
    const view = goalView('2026-10-02T00:59:30.000Z', BOUNDED_IN_TIME);
    expect(recordedDurations(view)).toEqual(allRecorded(30_000));
  });
});

describe('the duration a goal transition records after the clock reads behind what it recorded', () => {
  const UNUSABLE = ['corrupt', '2026-10-02T01:00:00.001Z', '2099-01-01T00:00:00.000Z'];

  it.each(UNUSABLE)(
    'keeps the time a goal with no duration bound already recorded when its creation time %p cannot be used',
    (createdAt) => {
      const view = goalView(createdAt, UNBOUNDED_IN_TIME, 30_000);
      expect(recordedDurations(view)).toEqual(allRecorded(30_000));
    },
  );

  it('keeps the time a goal with no duration bound already recorded when the clock steps back but stays after creation', () => {
    const view = goalView('2026-10-02T00:59:30.000Z', UNBOUNDED_IN_TIME, 50_000);
    expect(elapsedMilliseconds(view, NOW)).toBe(30_000);
    expect(recordedDurations(view)).toEqual(allRecorded(50_000));
  });

  it('records the clock reading once it passes what was already recorded', () => {
    const view = goalView('2026-10-02T00:59:30.000Z', UNBOUNDED_IN_TIME, 10_000);
    expect(recordedDurations(view)).toEqual(allRecorded(30_000));
  });

  it('keeps the time a duration-bounded goal already recorded when the clock steps back, and still measures its deadline from the clock', () => {
    const view = goalView('2026-10-02T00:59:50.000Z', BOUNDED_IN_TIME, 50_000);
    expect(recordedDurations(view)).toEqual(allRecorded(50_000));
    expect(remainingMilliseconds(view, NOW)).toBe(50_000);
    expect(isDeadlineElapsed(view, NOW)).toBe(false);
  });

  it.each(UNUSABLE)(
    'still records exactly the spent bound for a duration-bounded goal that recorded less, when its creation time %p cannot be used',
    (createdAt) => {
      const view = goalView(createdAt, BOUNDED_IN_TIME, 50_000);
      expect(recordedDurations(view)).toEqual(allRecorded(60_000));
      expect(isDeadlineElapsed(view, NOW)).toBe(true);
    },
  );

  it('never reads the decision context as exceeding the duration bound when the deadline has not elapsed', () => {
    // Every committed non-terminal view was recorded while the deadline had not
    // elapsed, so its recorded duration is below the bound. The context the
    // decision table reads must then agree with the deadline at any reading.
    const bound = BOUNDED_IN_TIME.maximumTotalDurationMs!;
    const createdAts = [
      'corrupt',
      '2099-01-01T00:00:00.000Z',
      '2026-10-02T01:00:00.001Z',
      '2026-10-02T01:00:00.000Z',
      '2026-10-02T00:59:59.000Z',
      '2026-10-02T00:59:30.000Z',
      '2026-10-02T00:59:00.001Z',
      '2026-10-02T00:59:00.000Z',
      '2026-10-02T00:58:59.999Z',
      '2026-10-02T00:00:00.000Z',
    ];
    for (const createdAt of createdAts) {
      for (const recorded of [0, 1, 30_000, bound - 1]) {
        const view = goalView(createdAt, BOUNDED_IN_TIME, recorded);
        const context = decisionContextFor(view, NOW);
        expect(isBudgetExceeded(context.budget, context.usage)).toBe(isDeadlineElapsed(view, NOW));
      }
    }
  });
});
