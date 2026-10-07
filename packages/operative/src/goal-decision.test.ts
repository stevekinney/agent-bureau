import { describe, expect, it } from 'bun:test';

import { GoalConfigurationError, type ValidatorError } from './errors';
import {
  ATTEMPT_RUN_FAILURE_DETAIL,
  canTransitionGoalRun,
  decideAttemptRunFailure,
  decideCancellation,
  decideDeterminismRequirement,
  decideDurationElapsed,
  decideOutcome,
  decideRetryOrExhaust,
  decideRunFinish,
  GOAL_RUN_TRANSITIONS,
  goalAttemptInput,
  isAttemptStartFailureDetail,
  isBudgetExceeded,
  isFailedReason,
  normalizeValidatorOutcome,
  OPERATOR_ABORT_DETAIL,
  projectValidatorError,
  projectValidatorOutcome,
  projectValidatorResult,
  stripValidatorErrorCause,
  TERMINAL_STATUS_BY_REASON,
  toJsonSafe,
  validateGoalConfiguration,
  type GoalBudget,
  type GoalDecisionContext,
  type GoalRetryableReason,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  type GoalUsage,
  type ValidatorOutcome,
} from './goal-decision';
import type { FinishReason } from './types';

const ALL_STATUSES: readonly GoalRunStatus[] = [
  'pending',
  'running',
  'evaluating',
  'retrying',
  'succeeded',
  'exhausted',
  'failed',
  'canceled',
];

const ALL_REASONS: readonly GoalRunTerminalReason[] = [
  'validator-passed',
  'attempt-limit-reached',
  'aggregate-budget-exceeded',
  'validator-fail-non-retryable',
  'validator-infrastructure-error',
  'unsupported-validation',
  'attempt-run-failed',
  'goal-canceled',
];

const ALL_RETRYABLE: readonly GoalRetryableReason[] = [
  'validator-fail-retryable',
  'validator-unavailable',
  'validator-canceled',
];

const ROOMY_BUDGET: GoalBudget = { maximumAttempts: 3, maximumTotalSteps: 100 };

const FRESH_USAGE: GoalUsage = {
  attempts: 1,
  steps: 1,
  tokens: 10,
  costUsd: undefined,
  durationMs: 5,
};

function context(
  overrides: {
    budget?: GoalBudget;
    retryOn?: readonly GoalRetryableReason[];
    usage?: Partial<GoalUsage>;
  } = {},
): GoalDecisionContext {
  return {
    budget: overrides.budget ?? ROOMY_BUDGET,
    retryOn: overrides.retryOn ?? [],
    usage: { ...FRESH_USAGE, ...overrides.usage },
  };
}

const validatorError: ValidatorError = {
  kind: 'execute',
  code: 'BOOM',
  message: 'the validator exploded',
  cause: { secret: 'internal' },
};

describe('the transition table', () => {
  it('has no outgoing edge from a terminal status', () => {
    for (const terminal of ['succeeded', 'exhausted', 'failed', 'canceled'] as const) {
      expect(GOAL_RUN_TRANSITIONS[terminal]).toEqual([]);
      for (const next of ALL_STATUSES) expect(canTransitionGoalRun(terminal, next)).toBe(false);
    }
  });

  it('reaches canceled from every non-terminal status and from no terminal one', () => {
    for (const status of ['pending', 'running', 'evaluating', 'retrying'] as const) {
      expect(canTransitionGoalRun(status, 'canceled')).toBe(true);
    }
  });

  it('follows COR-638 main path edges', () => {
    expect(canTransitionGoalRun('pending', 'running')).toBe(true);
    expect(canTransitionGoalRun('running', 'evaluating')).toBe(true);
    expect(canTransitionGoalRun('evaluating', 'succeeded')).toBe(true);
    expect(canTransitionGoalRun('evaluating', 'retrying')).toBe(true);
    expect(canTransitionGoalRun('retrying', 'running')).toBe(true);
    expect(canTransitionGoalRun('pending', 'succeeded')).toBe(false);
    expect(canTransitionGoalRun('running', 'succeeded')).toBe(false);
    expect(canTransitionGoalRun('retrying', 'evaluating')).toBe(false);
  });
});

describe('terminal reasons', () => {
  it('maps every reason to exactly one terminal status', () => {
    expect(Object.keys(TERMINAL_STATUS_BY_REASON).toSorted()).toEqual([...ALL_REASONS].toSorted());
    expect(TERMINAL_STATUS_BY_REASON['validator-passed']).toBe('succeeded');
    expect(TERMINAL_STATUS_BY_REASON['attempt-limit-reached']).toBe('exhausted');
    expect(TERMINAL_STATUS_BY_REASON['aggregate-budget-exceeded']).toBe('exhausted');
    expect(TERMINAL_STATUS_BY_REASON['goal-canceled']).toBe('canceled');
  });

  it('classifies failed reasons', () => {
    const failed = ALL_REASONS.filter((reason) => isFailedReason(reason));
    expect(failed).toEqual([
      'validator-fail-non-retryable',
      'validator-infrastructure-error',
      'unsupported-validation',
      'attempt-run-failed',
    ]);
  });
});

describe('isBudgetExceeded', () => {
  it('is false while every configured bound has headroom', () => {
    expect(isBudgetExceeded(ROOMY_BUDGET, FRESH_USAGE)).toBe(false);
  });

  it('trips on each aggregate bound at equality', () => {
    expect(
      isBudgetExceeded(
        { maximumAttempts: 9, maximumTotalDurationMs: 5 },
        { ...FRESH_USAGE, durationMs: 5 },
      ),
    ).toBe(true);
    expect(
      isBudgetExceeded({ maximumAttempts: 9, maximumTotalSteps: 1 }, { ...FRESH_USAGE, steps: 1 }),
    ).toBe(true);
    expect(
      isBudgetExceeded(
        { maximumAttempts: 9, maximumTotalTokens: 10 },
        { ...FRESH_USAGE, tokens: 10 },
      ),
    ).toBe(true);
    expect(
      isBudgetExceeded(
        { maximumAttempts: 9, maximumTotalCostUsd: 0.5 },
        { ...FRESH_USAGE, costUsd: 0.5 },
      ),
    ).toBe(true);
  });

  it('never trips the cost bound before any cost is reported', () => {
    expect(
      isBudgetExceeded(
        { maximumAttempts: 9, maximumTotalCostUsd: 0.5 },
        { ...FRESH_USAGE, costUsd: undefined },
      ),
    ).toBe(false);
  });

  it('ignores the attempt count, which is a separate reason', () => {
    expect(isBudgetExceeded({ maximumAttempts: 1, maximumTotalSteps: 100 }, FRESH_USAGE)).toBe(
      false,
    );
  });
});

describe('decideRetryOrExhaust', () => {
  it('retries with headroom and carries the feedback', () => {
    expect(decideRetryOrExhaust(context(), 'try again')).toEqual({
      kind: 'retry',
      feedback: 'try again',
    });
  });

  it('exhausts as attempt-limit-reached when the attempt count is met', () => {
    expect(decideRetryOrExhaust(context({ usage: { attempts: 3 } }), 'x')).toEqual({
      kind: 'exhaust',
      reason: 'attempt-limit-reached',
    });
  });

  it('exhausts as aggregate-budget-exceeded when a bound is crossed', () => {
    expect(
      decideRetryOrExhaust(context({ budget: { maximumAttempts: 9, maximumTotalSteps: 1 } }), 'x'),
    ).toEqual({ kind: 'exhaust', reason: 'aggregate-budget-exceeded' });
  });

  it('prefers the budget reason when both limits are crossed', () => {
    expect(
      decideRetryOrExhaust(
        context({ budget: { maximumAttempts: 1, maximumTotalSteps: 1 }, usage: { attempts: 1 } }),
        'x',
      ),
    ).toEqual({ kind: 'exhaust', reason: 'aggregate-budget-exceeded' });
  });

  it('attaches failure detail to an exhaust decision only', () => {
    expect(decideRetryOrExhaust(context({ usage: { attempts: 3 } }), 'x', 'why')).toEqual({
      kind: 'exhaust',
      reason: 'attempt-limit-reached',
      failureDetail: 'why',
    });
    expect(decideRetryOrExhaust(context(), 'x', 'why')).toEqual({ kind: 'retry', feedback: 'x' });
  });
});

describe('decideOutcome (every COR-638 outcome row)', () => {
  const pass: ValidatorOutcome = { kind: 'pass', evidence: [] };
  const retryableFail: ValidatorOutcome = {
    kind: 'fail',
    feedback: 'not yet',
    evidence: [],
    retryable: true,
  };
  const finalFail: ValidatorOutcome = {
    kind: 'fail',
    feedback: 'never',
    evidence: [],
    retryable: false,
  };

  const decide = (
    outcome: ValidatorOutcome,
    overrides: Parameters<typeof context>[0] = {},
    extra: { inputFeedback?: string; operatorAborted?: boolean } = {},
  ) =>
    decideOutcome(context(overrides), {
      outcome,
      inputFeedback: extra.inputFeedback,
      operatorAborted: extra.operatorAborted ?? false,
    });

  it('pass succeeds regardless of the retry policy', () => {
    expect(decide(pass)).toEqual({ kind: 'succeed', reason: 'validator-passed' });
    expect(decide(pass, { retryOn: ALL_RETRYABLE })).toEqual({
      kind: 'succeed',
      reason: 'validator-passed',
    });
  });

  it('retryable fail with the policy retries carrying the new feedback', () => {
    expect(
      decide(retryableFail, { retryOn: ['validator-fail-retryable'] }, { inputFeedback: 'old' }),
    ).toEqual({ kind: 'retry', feedback: 'not yet' });
  });

  it('retryable fail without the policy entry is terminal', () => {
    expect(decide(retryableFail)).toEqual({
      kind: 'fail',
      reason: 'validator-fail-non-retryable',
    });
    expect(decide(retryableFail, { retryOn: ['validator-unavailable'] })).toEqual({
      kind: 'fail',
      reason: 'validator-fail-non-retryable',
    });
  });

  it('fail with retryable:false is terminal even when the policy declares retry', () => {
    expect(decide(finalFail, { retryOn: ALL_RETRYABLE })).toEqual({
      kind: 'fail',
      reason: 'validator-fail-non-retryable',
    });
  });

  it('retryable fail exhausts at the attempt limit and at an aggregate bound', () => {
    expect(
      decide(retryableFail, { retryOn: ['validator-fail-retryable'], usage: { attempts: 3 } }),
    ).toEqual({ kind: 'exhaust', reason: 'attempt-limit-reached' });
    expect(
      decide(retryableFail, {
        retryOn: ['validator-fail-retryable'],
        budget: { maximumAttempts: 9, maximumTotalTokens: 10 },
      }),
    ).toEqual({ kind: 'exhaust', reason: 'aggregate-budget-exceeded' });
  });

  it('error is never retryable and carries the validator error', () => {
    expect(decide({ kind: 'error', error: validatorError }, { retryOn: ALL_RETRYABLE })).toEqual({
      kind: 'fail',
      reason: 'validator-infrastructure-error',
      validatorError,
    });
  });

  it('unavailable retries only when declared, carrying the input feedback', () => {
    const unavailable: ValidatorOutcome = {
      kind: 'unavailable',
      error: validatorError,
      reason: 'down',
    };
    expect(
      decide(unavailable, { retryOn: ['validator-unavailable'] }, { inputFeedback: 'carry' }),
    ).toEqual({ kind: 'retry', feedback: 'carry' });
    expect(decide(unavailable)).toEqual({
      kind: 'fail',
      reason: 'validator-infrastructure-error',
      validatorError,
      failureDetail: 'down',
    });
  });

  it('unavailable exhausts when declared but no headroom remains', () => {
    expect(
      decide(
        { kind: 'unavailable', error: validatorError, reason: 'down' },
        { retryOn: ['validator-unavailable'], usage: { attempts: 3 } },
      ),
    ).toEqual({ kind: 'exhaust', reason: 'attempt-limit-reached' });
  });

  it('canceled retries only when declared', () => {
    expect(decide({ kind: 'canceled' }, { retryOn: ['validator-canceled'] })).toEqual({
      kind: 'retry',
      feedback: undefined,
    });
    expect(decide({ kind: 'canceled' })).toEqual({
      kind: 'fail',
      reason: 'validator-infrastructure-error',
      failureDetail: 'The validator was canceled.',
    });
  });

  it('an operator abort needs no policy entry and always carries the abort detail', () => {
    expect(
      decide({ kind: 'canceled' }, {}, { operatorAborted: true, inputFeedback: 'carry' }),
    ).toEqual({ kind: 'retry', feedback: 'carry' });
    expect(
      decide({ kind: 'canceled' }, { usage: { attempts: 3 } }, { operatorAborted: true }),
    ).toEqual({
      kind: 'exhaust',
      reason: 'attempt-limit-reached',
      failureDetail: OPERATOR_ABORT_DETAIL,
    });
  });

  it('indeterminate is terminal, never retried', () => {
    expect(decide({ kind: 'indeterminate', reason: 'unsure' }, { retryOn: ALL_RETRYABLE })).toEqual(
      {
        kind: 'fail',
        reason: 'validator-infrastructure-error',
        failureDetail: 'unsure',
      },
    );
  });
});

describe('decideRunFinish (FinishReason mapping)', () => {
  const finish = (
    finishReason: FinishReason,
    extra: {
      operatorAborted?: boolean;
      costEstimateReported?: boolean;
      budget?: GoalBudget;
      usage?: Partial<GoalUsage>;
    } = {},
  ) =>
    decideRunFinish(
      context({
        ...(extra.budget === undefined ? {} : { budget: extra.budget }),
        ...(extra.usage === undefined ? {} : { usage: extra.usage }),
      }),
      {
        finishReason,
        operatorAborted: extra.operatorAborted ?? false,
        costEstimateReported: extra.costEstimateReported ?? true,
        feedback: 'input',
      },
    );

  it('hands only stop-condition to the validator', () => {
    expect(finish('stop-condition')).toEqual({ kind: 'validate' });
  });

  it('skips validation for every other FinishReason and fails the attempt run', () => {
    const others: readonly FinishReason[] = [
      'maximum-steps',
      'error',
      'elicitation-denied',
      'budget-exceeded',
      'tripwire',
    ];
    for (const reason of others) {
      expect(finish(reason)).toEqual({
        kind: 'decision',
        attemptStatus: 'failed',
        decision: {
          kind: 'fail',
          reason: 'attempt-run-failed',
          failureDetail: `The inner run finished with ${reason}.`,
        },
      });
    }
  });

  it('records an aborted inner run as an aborted attempt when it was not the operator', () => {
    expect(finish('aborted')).toEqual({
      kind: 'decision',
      attemptStatus: 'aborted',
      decision: {
        kind: 'fail',
        reason: 'attempt-run-failed',
        failureDetail: 'The inner run finished with aborted.',
      },
    });
  });

  it('retries when the operator aborted the attempt', () => {
    expect(finish('aborted', { operatorAborted: true })).toEqual({
      kind: 'decision',
      attemptStatus: 'aborted',
      decision: { kind: 'retry', feedback: 'input' },
    });
  });

  it('exhausts when the operator aborted the attempt and no headroom remains', () => {
    expect(finish('aborted', { operatorAborted: true, usage: { attempts: 3 } })).toEqual({
      kind: 'decision',
      attemptStatus: 'aborted',
      decision: {
        kind: 'exhaust',
        reason: 'attempt-limit-reached',
        failureDetail: OPERATOR_ABORT_DETAIL,
      },
    });
  });

  it('fails when a cost bound is set and the attempt reported no cost', () => {
    expect(
      finish('stop-condition', {
        budget: { maximumAttempts: 3, maximumTotalCostUsd: 1 },
        costEstimateReported: false,
      }),
    ).toEqual({
      kind: 'decision',
      attemptStatus: 'failed',
      decision: {
        kind: 'fail',
        reason: 'attempt-run-failed',
        failureDetail: ATTEMPT_RUN_FAILURE_DETAIL.costUnaccounted,
      },
    });
  });

  it('lets the validator run when the operator aborted despite a missing cost', () => {
    expect(
      finish('stop-condition', {
        budget: { maximumAttempts: 3, maximumTotalCostUsd: 1 },
        costEstimateReported: false,
        operatorAborted: true,
      }),
    ).toEqual({ kind: 'validate' });
  });

  it('does not require a cost report when no cost bound is set', () => {
    expect(finish('stop-condition', { costEstimateReported: false })).toEqual({
      kind: 'validate',
    });
  });
});

describe('every site that ends attempt-run-failed', () => {
  it('builds a fail decision for each detail', () => {
    const details = [
      ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy('nope'),
      ATTEMPT_RUN_FAILURE_DETAIL.runStart('nope'),
      ATTEMPT_RUN_FAILURE_DETAIL.runRejected('nope'),
      ATTEMPT_RUN_FAILURE_DETAIL.runFinish('error'),
      ATTEMPT_RUN_FAILURE_DETAIL.costUnaccounted,
      ATTEMPT_RUN_FAILURE_DETAIL.controller('nope'),
    ];
    expect(new Set(details).size).toBe(details.length);
    for (const detail of details) {
      expect(decideAttemptRunFailure(detail)).toEqual({
        kind: 'fail',
        reason: 'attempt-run-failed',
        failureDetail: detail,
      });
    }
  });

  it('words each site distinctly', () => {
    expect(ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy('m')).toBe(
      'Applying the conversation policy failed: m',
    );
    expect(ATTEMPT_RUN_FAILURE_DETAIL.runStart('m')).toBe('Starting the inner run failed: m');
    expect(ATTEMPT_RUN_FAILURE_DETAIL.runRejected('m')).toBe('The inner run rejected: m');
    expect(ATTEMPT_RUN_FAILURE_DETAIL.runFinish('error')).toBe(
      'The inner run finished with error.',
    );
    expect(ATTEMPT_RUN_FAILURE_DETAIL.controller('m')).toBe(
      'The goal controller failed unexpectedly: m',
    );
  });
});

describe('start-time and cancellation decisions', () => {
  it('rejects a stochastic or unspecified validator when determinism is required', () => {
    expect(decideDeterminismRequirement(true, 'stochastic')).toEqual({
      kind: 'fail',
      reason: 'unsupported-validation',
      failureDetail: 'The validator cannot supply the deterministic evidence this goal requires.',
    });
    expect(decideDeterminismRequirement(true, undefined)?.kind).toBe('fail');
  });

  it('accepts a deterministic validator or an unmet requirement', () => {
    expect(decideDeterminismRequirement(true, 'deterministic')).toBeUndefined();
    expect(decideDeterminismRequirement(false, 'stochastic')).toBeUndefined();
    expect(decideDeterminismRequirement(undefined, undefined)).toBeUndefined();
  });

  it('exhausts as aggregate-budget-exceeded when the duration bound elapses', () => {
    expect(decideDurationElapsed()).toEqual({
      kind: 'exhaust',
      reason: 'aggregate-budget-exceeded',
    });
  });

  it('cancels with goal-canceled', () => {
    expect(decideCancellation()).toEqual({ kind: 'cancel', reason: 'goal-canceled' });
  });
});

describe('validateGoalConfiguration', () => {
  const validator = { identity: { name: 'v', version: '1' }, validate: () => ({}) };
  const valid = {
    validator,
    budget: ROOMY_BUDGET,
    conversationPolicy: { kind: 'continue' as const },
  };
  const reasonOf = (input: unknown): string | undefined => {
    try {
      validateGoalConfiguration(input as Parameters<typeof validateGoalConfiguration>[0]);
      return undefined;
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(GoalConfigurationError);
      return (thrown as GoalConfigurationError).reason;
    }
  };

  it('accepts a valid configuration', () => {
    expect(reasonOf(valid)).toBeUndefined();
  });

  it('rejects each invalid configuration with its own reason', () => {
    expect(reasonOf({ ...valid, validator: undefined })).toBe('missing-validator');
    expect(reasonOf({ ...valid, validator: { identity: { name: 'v' } } })).toBe(
      'missing-validator',
    );
    expect(reasonOf({ ...valid, budget: { maximumTotalSteps: 1 } })).toBe(
      'invalid-maximum-attempts',
    );
    expect(reasonOf({ ...valid, budget: { maximumAttempts: 1.5, maximumTotalSteps: 1 } })).toBe(
      'invalid-maximum-attempts',
    );
    expect(reasonOf({ ...valid, budget: { maximumAttempts: 1 } })).toBe('missing-aggregate-bound');
    expect(reasonOf({ ...valid, budget: { maximumAttempts: 1, maximumTotalSteps: 0 } })).toBe(
      'invalid-aggregate-bound',
    );
    expect(
      reasonOf({ ...valid, budget: { maximumAttempts: 1, maximumTotalTokens: Infinity } }),
    ).toBe('invalid-aggregate-bound');
    expect(reasonOf({ ...valid, retryPolicy: { retryOn: [] } })).toBe('invalid-retry-policy');
    expect(reasonOf({ ...valid, retryPolicy: { retryOn: ['nope'] } })).toBe('invalid-retry-policy');
    expect(reasonOf({ ...valid, conversationPolicy: { kind: 'fork-from-baseline' } })).toBe(
      'invalid-baseline',
    );
    expect(reasonOf({ ...valid, conversationPolicy: { kind: 'fresh-from-artifact' } })).toBe(
      'missing-instructions',
    );
    expect(reasonOf({ ...valid, conversationPolicy: { kind: 'other' } })).toBe(
      'invalid-conversation-policy',
    );
  });

  it('accepts a declared baseline and fresh-from-artifact with instructions', () => {
    expect(
      reasonOf({ ...valid, conversationPolicy: { kind: 'fork-from-baseline', throughRun: 0 } }),
    ).toBeUndefined();
    expect(
      reasonOf({
        ...valid,
        instructions: 'go',
        conversationPolicy: { kind: 'fresh-from-artifact' },
      }),
    ).toBeUndefined();
  });
});

describe('normalizeValidatorOutcome (fail closed)', () => {
  const outputError = (value: unknown) => {
    const outcome = normalizeValidatorOutcome(value);
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.error.kind).toBe('output');
    expect(outcome.error.code).toBe('MALFORMED_VALIDATOR_OUTPUT');
  };

  it('treats every malformed shape as an output error', () => {
    outputError(undefined);
    outputError('pass');
    outputError({ kind: 'nope' });
    outputError({ kind: 'pass' });
    outputError({ kind: 'fail', feedback: 1, evidence: [], retryable: true });
    outputError({ kind: 'fail', feedback: 'x', evidence: [] });
    outputError({ kind: 'error', error: { kind: 'bogus', code: 'c', message: 'm' } });
    outputError({ kind: 'unavailable', error: validatorError });
    outputError({ kind: 'indeterminate' });
  });

  it('treats a malformed evidence entry as an output error, in a pass and in a fail', () => {
    const malformedEntries: unknown[] = [
      null,
      undefined,
      'unit',
      42,
      {},
      { detail: 'no source' },
      { source: 7, detail: 'numeric source' },
    ];
    for (const entry of malformedEntries) {
      outputError({ kind: 'pass', evidence: [entry] });
      outputError({ kind: 'pass', evidence: [{ source: 'ok', detail: 1 }, entry] });
      outputError({ kind: 'fail', feedback: 'x', evidence: [entry], retryable: true });
    }
    // A detail is any value; only the source is constrained.
    expect(
      normalizeValidatorOutcome({ kind: 'pass', evidence: [{ source: 's', detail: null }] }),
    ).toEqual({ kind: 'pass', evidence: [{ source: 's', detail: null }] });
  });

  it('passes well-formed outcomes through', () => {
    expect(normalizeValidatorOutcome({ kind: 'pass', evidence: [] })).toEqual({
      kind: 'pass',
      evidence: [],
    });
    expect(normalizeValidatorOutcome({ kind: 'canceled' })).toEqual({ kind: 'canceled' });
    expect(normalizeValidatorOutcome({ kind: 'indeterminate', reason: 'r' })).toEqual({
      kind: 'indeterminate',
      reason: 'r',
    });
  });
});

describe('toJsonSafe', () => {
  it('passes JSON primitives and plain structures through', () => {
    expect(toJsonSafe({ a: [1, 'b', null, true], c: { d: 0 } })).toEqual({
      a: [1, 'b', null, true],
      c: { d: 0 },
    });
  });

  it('projects non-JSON values without throwing', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(toJsonSafe(date)).toBe('2026-01-02T03:04:05.000Z');
    expect(toJsonSafe(new Date(Number.NaN))).toBeNull();
    expect(toJsonSafe(10n)).toBe('10');
    expect(toJsonSafe(Number.NaN)).toBeNull();
    expect(toJsonSafe(Infinity)).toBeNull();
    expect(toJsonSafe(undefined)).toBeNull();
    expect(toJsonSafe(() => 1)).toBeNull();
    expect(toJsonSafe(Symbol('s'))).toBeNull();
    expect(toJsonSafe({ keep: 1, drop: undefined, fn: () => 1 })).toEqual({ keep: 1 });
    expect(toJsonSafe([undefined, () => 1])).toEqual([null, null]);
    expect(toJsonSafe(new Set([1, 2]))).toEqual([1, 2]);
    expect(toJsonSafe(new Map([['k', 1]]))).toEqual([['k', 1]]);
  });

  it('projects errors to name and message, never the stack', () => {
    const projected = toJsonSafe(new TypeError('bad'));
    expect(projected).toEqual({ name: 'TypeError', message: 'bad' });
  });

  it('marks cycles and bounds depth', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(toJsonSafe(cyclic)).toEqual({ name: 'loop', self: '[Circular]' });
    let deep: unknown = 'leaf';
    for (let level = 0; level < 100; level += 1) deep = { next: deep };
    expect(() => JSON.stringify(toJsonSafe(deep))).not.toThrow();
    expect(JSON.stringify(toJsonSafe(deep))).toContain('[Truncated]');
  });

  it('does not let a hostile key pollute the prototype', () => {
    const projected = toJsonSafe(JSON.parse('{"__proto__":{"polluted":true}}')) as Record<
      string,
      unknown
    >;
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(projected)).toEqual(['__proto__']);
  });

  it('survives a throwing getter and a throwing toJSON', () => {
    const hostile = {
      get boom(): never {
        throw new Error('getter');
      },
      ok: 1,
    };
    expect(toJsonSafe(hostile)).toEqual({ boom: '[Unserializable]', ok: 1 });
    expect(
      toJsonSafe({
        toJSON(): never {
          throw new Error('toJSON');
        },
      }),
    ).toBe('[Unserializable]');
  });

  it('always yields a value JSON.stringify accepts', () => {
    const value = { big: 1n, date: new Date(0), fn: () => 1, nested: [new Set([1n])] };
    expect(() => JSON.stringify(toJsonSafe(value))).not.toThrow();
  });
});

describe('validator projection', () => {
  it('projects error cause and keeps the discriminating fields', () => {
    expect(projectValidatorError(validatorError)).toEqual({
      kind: 'execute',
      code: 'BOOM',
      message: 'the validator exploded',
      cause: { secret: 'internal' },
    });
    expect(projectValidatorError({ kind: 'load', code: 'c', message: 'm' })).toEqual({
      kind: 'load',
      code: 'c',
      message: 'm',
    });
  });

  it('projects a non-JSON cause to a JSON-safe form', () => {
    const projected = projectValidatorError({
      kind: 'execute',
      code: 'c',
      message: 'm',
      cause: new Error('inner'),
    });
    expect(projected.cause).toEqual({ name: 'Error', message: 'inner' });
  });

  it('strips the cause for events', () => {
    expect(stripValidatorErrorCause(validatorError)).toEqual({
      kind: 'execute',
      code: 'BOOM',
      message: 'the validator exploded',
    });
  });

  it('projects evidence detail for pass and fail outcomes', () => {
    const evidence = [{ source: 's', detail: { when: new Date(0), size: 5n } }];
    expect(projectValidatorOutcome({ kind: 'pass', evidence })).toEqual({
      kind: 'pass',
      evidence: [{ source: 's', detail: { when: '1970-01-01T00:00:00.000Z', size: '5' } }],
    });
    expect(
      projectValidatorOutcome({ kind: 'fail', feedback: 'f', evidence, retryable: true }),
    ).toEqual({
      kind: 'fail',
      feedback: 'f',
      retryable: true,
      evidence: [{ source: 's', detail: { when: '1970-01-01T00:00:00.000Z', size: '5' } }],
    });
  });

  it('projects error, unavailable, canceled, and indeterminate outcomes', () => {
    expect(projectValidatorOutcome({ kind: 'error', error: validatorError })).toEqual({
      kind: 'error',
      error: projectValidatorError(validatorError),
    });
    expect(
      projectValidatorOutcome({ kind: 'unavailable', error: validatorError, reason: 'r' }),
    ).toEqual({
      kind: 'unavailable',
      error: projectValidatorError(validatorError),
      reason: 'r',
    });
    expect(projectValidatorOutcome({ kind: 'canceled' })).toEqual({ kind: 'canceled' });
    expect(projectValidatorOutcome({ kind: 'indeterminate', reason: 'r' })).toEqual({
      kind: 'indeterminate',
      reason: 'r',
    });
  });

  it('projects a whole validator result to a JSON round trip', () => {
    const projected = projectValidatorResult({
      identity: { name: 'v', version: '1' },
      startedAt: 's',
      completedAt: 'c',
      outcome: { kind: 'pass', evidence: [{ source: 'x', detail: 1n }] },
    });
    expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
    expect(projected.identity).toEqual({ name: 'v', version: '1' });
  });
});

describe('goalAttemptInput', () => {
  const prompt = 'work';
  const cases = [
    ['continue', 0, 'ignored', 'work'],
    ['continue', 1, 'fix it', 'fix it'],
    ['continue', 1, undefined, 'work'],
    ['fork-from-baseline', 0, 'ignored', 'work'],
    ['fork-from-baseline', 2, 'fix it', 'work\n\nfix it'],
    ['fork-from-baseline', 2, undefined, 'work'],
    ['fresh-from-artifact', 0, 'ignored', 'work'],
    ['fresh-from-artifact', 1, 'fix it', 'work'],
  ] as const;

  it.each(cases)(
    'under %s, attempt %d with feedback %p is %p',
    (kind, index, feedback, expected) => {
      expect(goalAttemptInput(kind, prompt, index, feedback)).toBe(expected);
    },
  );
});

describe('isAttemptStartFailureDetail', () => {
  it('is true for a start that failed and false for a run that was started', () => {
    expect(isAttemptStartFailureDetail(ATTEMPT_RUN_FAILURE_DETAIL.runStart('boom'))).toBe(true);
    expect(isAttemptStartFailureDetail(ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy('boom'))).toBe(
      true,
    );
    expect(isAttemptStartFailureDetail(ATTEMPT_RUN_FAILURE_DETAIL.runRejected('boom'))).toBe(false);
    expect(isAttemptStartFailureDetail(ATTEMPT_RUN_FAILURE_DETAIL.runFinish('error'))).toBe(false);
    expect(isAttemptStartFailureDetail(ATTEMPT_RUN_FAILURE_DETAIL.costUnaccounted)).toBe(false);
    expect(isAttemptStartFailureDetail(undefined)).toBe(false);
  });
});
