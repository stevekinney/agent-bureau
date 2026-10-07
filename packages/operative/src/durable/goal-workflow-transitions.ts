/**
 * COR-851 — pure builders for the transitions the `goalRun` workflow commits.
 *
 * Everything here is a function of a record view, a clock reading, and the
 * deterministic identifiers: no I/O, no clock, no randomness. That is what lets
 * a replayed workflow rebuild byte-identical commit requests, which the store
 * recognizes as `duplicate`.
 */

import {
  type GoalBudget,
  type GoalDecision,
  type GoalDecisionContext,
  type GoalRunStatus,
  type GoalUsage,
  type ProjectedValidatorResult,
  TERMINAL_STATUS_BY_REASON,
  TERMINAL_STATUSES,
} from '../goal-decision';
import type {
  GoalAttemptTerminalSignal,
  GoalWorkflowAbortRequest,
  GoalWorkflowAttempt,
  GoalWorkflowAttemptStatus,
  GoalWorkflowIdentifiers,
  GoalWorkflowTransition,
  GoalWorkflowUsage,
  GoalWorkflowView,
} from './goal-workflow-ports';

type ViewAttempt = GoalWorkflowView['attempts'][number];

/**
 * What the aggregate duration is measured from: the record's creation and its
 * bound. The controller and the start port both measure the deadline with
 * these functions, so the two can never disagree about whether it has elapsed.
 */
export type DurationClock = Pick<GoalWorkflowView, 'createdAt' | 'bounds'>;

export const isTerminalStatus = (status: GoalRunStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

const toIso = (nowMs: number): string => new Date(nowMs).toISOString();

/**
 * The record's creation as a clock reading, or `undefined` when it cannot be
 * used to measure age at `nowMs`: it does not parse, or it is later than the
 * reading. A goal cannot have been created in the future, so a creation time
 * after now is a record (or a clock) that cannot be trusted, and its age is
 * not zero: clamping a negative age to zero would hand a duration-bounded goal
 * a fresh, full window at every reading until the clock caught up with it.
 */
const creationMilliseconds = (view: DurationClock, nowMs: number): number | undefined => {
  const createdAt = Date.parse(view.createdAt);
  return Number.isFinite(createdAt) && createdAt <= nowMs ? createdAt : undefined;
};

/**
 * The aggregate duration so far, measured from the record's creation. The
 * deadline, the decision context, and a recorded transition all start from this
 * one reading, so the controller, the start port, and the attempt fence agree on
 * it. It is a reading of the clock, not a running total: `recordedDurationMs` is
 * the figure that never goes backwards.
 *
 * A creation time that cannot be used (see `creationMilliseconds`) has no age
 * to measure, so the reading is what each kind of goal can be told. A goal
 * with a duration bound fails closed: it is read as having spent exactly its
 * bound, which exhausts it (every comparison against the bound is `>=`) rather
 * than never consuming it. A goal with no duration bound has no window to
 * spend, so it keeps running and its reading is no time at all. Neither is a
 * sentinel value: the reading is always a finite duration, because a recorded
 * duration is built on it and the transition log is append-only.
 */
export function elapsedMilliseconds(view: DurationClock, nowMs: number): number {
  const createdAt = creationMilliseconds(view, nowMs);
  return createdAt === undefined ? (view.bounds.maximumTotalDurationMs ?? 0) : nowMs - createdAt;
}

/** `undefined` when the goal has no duration bound. */
export function remainingMilliseconds(view: DurationClock, nowMs: number): number | undefined {
  const bound = view.bounds.maximumTotalDurationMs;
  if (bound === undefined) return undefined;
  return Math.max(0, bound - elapsedMilliseconds(view, nowMs));
}

export function isDeadlineElapsed(view: DurationClock, nowMs: number): boolean {
  return remainingMilliseconds(view, nowMs) === 0;
}

/**
 * The aggregate duration a transition records and the decision context reads:
 * the clock's reading, but never less than what the record already holds.
 *
 * The transition log is append-only, so the aggregate usage it records must not
 * go backwards. The clock can: a wall clock stepped back, or one that reads
 * behind the record's creation time, gives a smaller reading than the last
 * transition recorded, or the zero of a goal with no duration bound. Taking the
 * larger keeps the time already spent. It cannot disagree with the deadline:
 * every non-terminal transition is committed after the deadline was found not
 * yet elapsed, so what the record holds is below the bound, and the larger of
 * the two reaches the bound exactly when the clock reading does.
 */
const recordedDurationMs = (view: GoalWorkflowView, nowMs: number): number =>
  Math.max(view.usage.durationMs, elapsedMilliseconds(view, nowMs));

function goalUsage(view: GoalWorkflowView, nowMs: number): GoalUsage {
  return {
    attempts: view.usage.attempts,
    steps: view.usage.steps,
    tokens: view.usage.tokens,
    costUsd: view.usage.costUsd,
    durationMs: recordedDurationMs(view, nowMs),
  };
}

/** What `decideOutcome` and friends read: the budget, the retry policy, and the live usage. */
export function decisionContextFor(view: GoalWorkflowView, nowMs: number): GoalDecisionContext {
  const budget: GoalBudget = view.bounds;
  return { budget, retryOn: view.retryPolicy?.retryOn ?? [], usage: goalUsage(view, nowMs) };
}

/**
 * The feedback attempt `attemptIndex` received as input. A `fail` outcome sets
 * the attempt's `feedback`, and a retry that follows any other outcome carries
 * the evaluated attempt's own input forward, so folding the recorded attempts
 * reproduces exactly what the in-memory controller threaded through its loop.
 */
export function goalInputFeedbackFor(
  attempts: readonly ViewAttempt[],
  attemptIndex: number,
): string | undefined {
  let feedback: string | undefined;
  for (const attempt of attempts.slice(0, attemptIndex)) feedback = attempt.feedback ?? feedback;
  return feedback;
}

export function currentAttemptOf(view: GoalWorkflowView): ViewAttempt | undefined {
  return view.attempts.at(-1);
}

export const isAttemptInFlight = (attempt: ViewAttempt | undefined): attempt is ViewAttempt =>
  attempt !== undefined && (attempt.status === 'running' || attempt.status === 'evaluating');

/**
 * The run a cancellation must stop. An attempt in flight has one. Otherwise a
 * start may have crashed just short of its commit and left an orphan under the
 * next attempt's deterministic id, so name that one; stopping a run that never
 * existed is a no-op.
 */
export function abortRequestFor(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
): GoalWorkflowAbortRequest {
  const current = currentAttemptOf(view);
  const attemptIndex = isAttemptInFlight(current) ? current.attemptIndex : view.attempts.length;
  return {
    goalRunId: view.goalRunId,
    attemptIndex,
    attemptId: identifiers.attemptId(view.goalRunId, attemptIndex),
    runId: identifiers.attemptRunId(view.goalRunId, attemptIndex),
  };
}

function usageFor(
  view: GoalWorkflowView,
  nowMs: number,
  changes: Partial<Omit<GoalWorkflowUsage, 'durationMs'>> = {},
): GoalWorkflowUsage {
  const merged = { ...view.usage, ...changes };
  return {
    attempts: merged.attempts,
    steps: merged.steps,
    tokens: merged.tokens,
    ...(merged.costUsd === undefined ? {} : { costUsd: merged.costUsd }),
    durationMs: recordedDurationMs(view, nowMs),
  };
}

function baseTransition(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
  nowMs: number,
  to: GoalRunStatus,
  cause: string,
): GoalWorkflowTransition {
  const seq = view.transitionSeq + 1;
  return {
    goalRunId: view.goalRunId,
    seq,
    transitionId: identifiers.transitionId(view.goalRunId, seq),
    to,
    at: toIso(nowMs),
    cause,
  };
}

function withAttempt(
  attempt: ViewAttempt,
  changes: {
    readonly status: GoalWorkflowAttemptStatus;
    readonly completedAt?: string | undefined;
    readonly finishReason?: GoalWorkflowAttempt['finishReason'];
    readonly usage?: GoalWorkflowAttempt['usage'];
    readonly feedback?: string | undefined;
    readonly validation?: GoalWorkflowAttempt['validation'];
  },
): GoalWorkflowAttempt {
  const finishReason = changes.finishReason ?? attempt.finishReason;
  const completedAt = changes.completedAt ?? attempt.completedAt;
  return {
    attemptId: attempt.attemptId,
    attemptIndex: attempt.attemptIndex,
    runId: attempt.runId,
    sessionId: attempt.sessionId,
    startedAt: attempt.startedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(changes.validation === undefined ? {} : { validation: changes.validation }),
    ...(changes.feedback === undefined ? {} : { feedback: changes.feedback }),
    usage: changes.usage ?? attempt.usage,
    status: changes.status,
  };
}

/** `pending | retrying -> running`: the attempt's run exists, so record it and what is in flight. */
export function buildOpenAttempt(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
  nowMs: number,
  started: { readonly attemptIndex: number; readonly sessionId: string },
): GoalWorkflowTransition {
  const attemptId = identifiers.attemptId(view.goalRunId, started.attemptIndex);
  const runId = identifiers.attemptRunId(view.goalRunId, started.attemptIndex);
  const startedAt = toIso(nowMs);
  return {
    ...baseTransition(
      view,
      identifiers,
      nowMs,
      'running',
      `attempt ${started.attemptIndex} started`,
    ),
    attempt: {
      attemptId,
      attemptIndex: started.attemptIndex,
      runId,
      sessionId: started.sessionId,
      startedAt,
      usage: { steps: 0, tokens: 0 },
      status: 'running',
    },
    usage: usageFor(view, nowMs, { attempts: started.attemptIndex + 1 }),
    active: { kind: 'attempt', attemptId, runId, startedAt },
  };
}

/** The usage the finished run reported, folded into the aggregate. */
function accountAttemptUsage(
  view: GoalWorkflowView,
  nowMs: number,
  finished: GoalAttemptTerminalSignal,
): GoalWorkflowUsage {
  return usageFor(view, nowMs, {
    steps: view.usage.steps + finished.steps,
    tokens: view.usage.tokens + finished.tokens,
    ...(finished.costUsd === undefined
      ? {}
      : { costUsd: (view.usage.costUsd ?? 0) + finished.costUsd }),
  });
}

function reportedUsage(finished: GoalAttemptTerminalSignal): GoalWorkflowAttempt['usage'] {
  return {
    steps: finished.steps,
    tokens: finished.tokens,
    ...(finished.costUsd === undefined ? {} : { costUsd: finished.costUsd }),
  };
}

/** `running -> evaluating`: the run reached `stop-condition`, so the validator takes over. */
export function buildEvaluationStarted(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
  nowMs: number,
  attempt: ViewAttempt,
  finished: GoalAttemptTerminalSignal,
): GoalWorkflowTransition {
  return {
    ...baseTransition(
      view,
      identifiers,
      nowMs,
      'evaluating',
      `attempt ${attempt.attemptIndex} reached ${finished.finishReason}`,
    ),
    attempt: withAttempt(attempt, {
      status: 'evaluating',
      finishReason: finished.finishReason,
      usage: reportedUsage(finished),
    }),
    usage: accountAttemptUsage(view, nowMs, finished),
    active: {
      kind: 'validation',
      attemptId: attempt.attemptId,
      validator: view.validator,
      startedAt: toIso(nowMs),
    },
  };
}

/** The target status, reason, and detail a decision commits. */
function decisionFields(
  decision: GoalDecision,
): Pick<GoalWorkflowTransition, 'to' | 'terminalReason' | 'failureDetail'> {
  switch (decision.kind) {
    case 'retry':
      return { to: 'retrying' };
    case 'succeed':
    case 'cancel':
      return { to: TERMINAL_STATUS_BY_REASON[decision.reason], terminalReason: decision.reason };
    case 'exhaust':
      return {
        to: 'exhausted',
        terminalReason: decision.reason,
        ...(decision.failureDetail === undefined ? {} : { failureDetail: decision.failureDetail }),
      };
    case 'fail':
      return {
        to: 'failed',
        terminalReason: decision.reason,
        ...(decision.failureDetail === undefined ? {} : { failureDetail: decision.failureDetail }),
      };
  }
}

const causeFor = (decision: GoalDecision): string =>
  decision.kind === 'retry'
    ? 'retrying after a non-passing attempt'
    : `${decision.kind}: ${decision.reason}`;

/**
 * The attempt's run finished with something other than `stop-condition` (or its
 * cost could not be accounted), so validation never ran and the decision comes
 * straight from `decideRunFinish`.
 */
export function buildRunFinishDecision(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
  nowMs: number,
  attempt: ViewAttempt,
  finished: GoalAttemptTerminalSignal,
  resolution: { readonly decision: GoalDecision; readonly attemptStatus: 'failed' | 'aborted' },
): GoalWorkflowTransition {
  return {
    ...baseTransition(
      view,
      identifiers,
      nowMs,
      decisionFields(resolution.decision).to,
      causeFor(resolution.decision),
    ),
    ...decisionFields(resolution.decision),
    attempt: withAttempt(attempt, {
      status: resolution.attemptStatus,
      finishReason: finished.finishReason,
      usage: reportedUsage(finished),
      completedAt: toIso(nowMs),
    }),
    usage: accountAttemptUsage(view, nowMs, finished),
    active: null,
  };
}

function attemptStatusFor(outcome: ProjectedValidatorResult['outcome']): GoalWorkflowAttemptStatus {
  if (outcome.kind === 'pass') return 'passed';
  return outcome.kind === 'canceled' ? 'aborted' : 'failed';
}

/** `evaluating -> next`: the validator's verdict and the decision it produced, committed together. */
export function buildValidationDecision(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
  nowMs: number,
  attempt: ViewAttempt,
  result: ProjectedValidatorResult,
  decision: GoalDecision,
): GoalWorkflowTransition {
  const fields = decisionFields(decision);
  return {
    ...baseTransition(view, identifiers, nowMs, fields.to, causeFor(decision)),
    ...fields,
    attempt: withAttempt(attempt, {
      status: attemptStatusFor(result.outcome),
      completedAt: result.completedAt,
      ...(result.outcome.kind === 'fail' ? { feedback: result.outcome.feedback } : {}),
      validation: {
        identity: result.identity,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        outcome: result.outcome,
        decisionId: identifiers.decisionId(attempt.attemptId),
      },
    }),
    usage: usageFor(view, nowMs),
    active: null,
  };
}

/**
 * Ends the goal without a validator verdict: an operator cancellation or the
 * aggregate duration bound. The attempt in flight, if any, is closed as
 * `aborted` in the same transition, because once a cancellation marker is
 * present the store accepts no other write.
 */
export function buildGoalForcedFinish(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
  nowMs: number,
  decision: GoalDecision,
): GoalWorkflowTransition {
  const fields = decisionFields(decision);
  const attempt = currentAttemptOf(view);
  return {
    ...baseTransition(view, identifiers, nowMs, fields.to, causeFor(decision)),
    ...fields,
    ...(isAttemptInFlight(attempt)
      ? { attempt: withAttempt(attempt, { status: 'aborted', completedAt: toIso(nowMs) }) }
      : {}),
    usage: usageFor(view, nowMs),
    active: null,
  };
}

/** The inner run could not be started: the goal fails before any attempt opens. */
export function buildStartFailure(
  view: GoalWorkflowView,
  identifiers: GoalWorkflowIdentifiers,
  nowMs: number,
  decision: GoalDecision,
): GoalWorkflowTransition {
  return {
    ...baseTransition(view, identifiers, nowMs, 'failed', causeFor(decision)),
    ...decisionFields(decision),
    usage: usageFor(view, nowMs),
    active: null,
  };
}
