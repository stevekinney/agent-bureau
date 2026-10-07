/**
 * COR-851 — the Weft activities behind the `goalRun` workflow.
 *
 * Each activity is a thin, idempotent wrapper over one port. The workflow body
 * never calls a port directly: every effect goes through `ctx.run`, so its
 * result is recorded once and replayed from history afterwards.
 */

import { activity, type ActivityContext } from '@lostgradient/weft';

import type { ProjectedValidatorResult } from '../goal-decision';
import type {
  GoalWorkflowAbortRequest,
  GoalWorkflowCommit,
  GoalWorkflowPorts,
  GoalWorkflowRecord,
  GoalWorkflowStart,
  GoalWorkflowStartRequest,
  GoalWorkflowTransition,
  GoalWorkflowValidatorRequest,
  GoalWorkflowView,
} from './goal-workflow-ports';
import { abortRequestFor } from './goal-workflow-transitions';

export interface GoalWorkflowLoadResult {
  /** `undefined` when the record is missing or unreadable. */
  readonly view: GoalWorkflowView | undefined;
  readonly nowMs: number;
}

/**
 * Built field by field. `GoalState` satisfies `GoalWorkflowRecord` structurally
 * and carries far more at runtime (the objective, the conversation policy and
 * its artifact, the principal, the audit log), and every load is cached in the
 * workflow's history, so a spread would copy all of it on every load.
 */
export function toGoalWorkflowView(record: GoalWorkflowRecord): GoalWorkflowView {
  return {
    goalRunId: record.goalRunId,
    status: record.status,
    transitionSeq: record.transitionSeq,
    validator: record.validator,
    ...(record.validatorTimeoutMs === undefined
      ? {}
      : { validatorTimeoutMs: record.validatorTimeoutMs }),
    bounds: record.bounds,
    ...(record.retryPolicy === undefined ? {} : { retryPolicy: record.retryPolicy }),
    attempts: record.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      attemptIndex: attempt.attemptIndex,
      runId: attempt.runId,
      sessionId: attempt.sessionId,
      startedAt: attempt.startedAt,
      ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
      ...(attempt.finishReason === undefined ? {} : { finishReason: attempt.finishReason }),
      ...(attempt.feedback === undefined ? {} : { feedback: attempt.feedback }),
      usage: attempt.usage,
      status: attempt.status,
    })),
    usage: record.usage,
    ...(record.active === undefined ? {} : { active: record.active }),
    ...(record.cancellation === undefined
      ? {}
      : { cancellation: { requestedAt: record.cancellation.requestedAt } }),
    ...(record.terminalReason === undefined ? {} : { terminalReason: record.terminalReason }),
    ...(record.failureDetail === undefined ? {} : { failureDetail: record.failureDetail }),
    createdAt: record.createdAt,
  };
}

export function createGoalWorkflowActivities(ports: GoalWorkflowPorts) {
  return {
    loadGoalState: activity({
      name: 'loadGoalState',
      idempotent: true,
      execute: async (input: { goalRunId: string }): Promise<GoalWorkflowLoadResult> => {
        const { record, nowMs } = await ports.loadGoalState(input.goalRunId);
        return { view: record === undefined ? undefined : toGoalWorkflowView(record), nowMs };
      },
    }),

    commitTransition: activity({
      name: 'commitTransition',
      idempotent: true,
      execute: (input: GoalWorkflowTransition): Promise<GoalWorkflowCommit> =>
        ports.commitTransition(input),
    }),

    startAttempt: activity({
      name: 'startAttempt',
      idempotent: true,
      execute: (
        input: GoalWorkflowStartRequest,
        context?: ActivityContext,
      ): Promise<GoalWorkflowStart> => ports.startAttempt(input, context?.signal),
    }),

    runValidator: activity({
      name: 'runValidator',
      idempotent: true,
      execute: (
        input: GoalWorkflowValidatorRequest,
        context?: ActivityContext,
      ): Promise<ProjectedValidatorResult> => ports.runValidator(input, context?.signal),
    }),

    abortAttempt: activity({
      name: 'abortAttempt',
      idempotent: true,
      execute: (input: GoalWorkflowAbortRequest): Promise<void> => ports.abortAttempt(input),
    }),

    /**
     * The definition-level finalizer: Weft drives it after a `cancelled` or
     * `timed-out` terminal, with the state the controller last staged, so a
     * hard `engine.cancel` that killed the generator mid-flight still stops the
     * active attempt's run. The same idempotent port call as `abortAttempt`,
     * under its own name so the finalizer is recognizable in a history.
     *
     * The staged value is only as fresh as the controller's last read. A
     * crash-adopted controller re-stages every iteration's recorded read while
     * it replays, so a cancel that lands before it reaches the live frontier
     * flushes an older attempt's run. The finalizer runs live, never inside a
     * replay, so it also reads the record now and stops the run that is in
     * flight there. Both targets are idempotent aborts, and a staged target
     * that is already terminal is a no-op, so stopping both is always safe.
     */
    finalizeGoal: activity({
      name: 'finalizeGoal',
      idempotent: true,
      execute: async (input: GoalWorkflowAbortRequest): Promise<void> => {
        await ports.abortAttempt(input);
        const { record } = await ports.loadGoalState(input.goalRunId);
        if (record === undefined) return;
        const live = abortRequestFor(toGoalWorkflowView(record), ports.identifiers);
        if (live.runId !== input.runId) await ports.abortAttempt(live);
      },
    }),
  };
}

export type GoalWorkflowActivities = ReturnType<typeof createGoalWorkflowActivities>;
