/**
 * COR-851 — Bureau's side of the durable `goalRun` workflow.
 *
 * Operative owns the controller and cannot import Bureau, so everything the
 * controller does to the world crosses `GoalWorkflowPorts`. This file implements
 * those ports over Bureau's goal store, validator catalog, and durable agent
 * runs, and supplies the late binding that lets the workflow be registered
 * with the engine before the rest of Bureau exists.
 *
 * Every port runs inside a Weft activity, so each may run more than once and
 * each is idempotent:
 *
 * - `loadGoalState` and `commitTransition` are the store's own reads and
 *   compare-and-swap, so a replayed commit answers `duplicate`.
 * - `startAttempt` is start-or-adopt. The attempt's run id is deterministic, so
 *   a run that already exists is adopted, a claim left by a start that died
 *   before its workflow existed is completed from the claim, and otherwise the
 *   run starts. Either way a forwarder is attached.
 * - `runValidator` may run twice after a crash. The decision is committed once
 *   (the store keeps the first), so a validator without side effects is simply
 *   run again; one that has them should say so with `determinism`.
 * - `abortAttempt` tombstones the attempt's claim, then calls `cancelDurableRun`,
 *   which is a no-op for a run that never existed or already ended. The
 *   tombstone is what covers a start that has claimed its run but not created
 *   it: there is no transaction across the claim and the engine's start, so the
 *   run such a start goes on to create is fenced instead (`goal-attempt-fence.ts`).
 *
 * What each check in `startAttempt` covers, since several look alike:
 *
 * - the reads of the goal before each write are an in-process fast path: the
 *   goal ended while this try ran, so nothing more is written. They cover no
 *   crash and no race with another process.
 * - the activity's own signal, aborted by Weft when it times this try out, stops
 *   the writes of a try that is still running in the background after its
 *   retry began.
 * - the tombstoned claim refuses a start that reaches its own claim after the
 *   goal ended over the attempt.
 * - the read after the engine's start stops a run the goal ended over while the
 *   start was in flight, in this process.
 * - the run's own fence is the backstop for what none of those can see: a
 *   process that dies between the engine's start and the read after it, and a
 *   start that was already past its claim when the tombstone landed.
 *
 * Each attempt is its own durable run, started under its deterministic id. What
 * carries a conversation from one attempt to the next is the goal's session in
 * the `SessionStore`, which `GoalConversations` owns: it decides which session
 * an attempt runs in and what that attempt is seeded with, per the goal's
 * conversation policy, and records each attempt's run in its session. Starting
 * an attempt is therefore: adopt the run if it exists, otherwise seat it (build
 * its seed), start it, and record it. The forwarder commits a finished
 * attempt's transcript to its session before the controller hears of it.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  ATTEMPT_RUN_FAILURE_DETAIL,
  createGoalWorkflow,
  type DurableActiveRunContext,
  executeValidator,
  type GoalAttemptRecord,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowCommit,
  type GoalWorkflowLoad,
  type GoalWorkflowPorts,
  type GoalWorkflowStart,
  type GoalWorkflowStartRequest,
  type GoalWorkflowTransition,
  type GoalWorkflowValidatorRequest,
  isAgentRunWorkflowInput,
  isDeadlineElapsed,
  type ProjectedValidatorOutcome,
  type ProjectedValidatorResult,
  projectValidatorResult,
  readDurableRunResult,
  type RunOptions,
} from '@lostgradient/operative';

import {
  GoalAttemptInvalidCostEstimationError,
  GoalAttemptNotDurableCapableError,
  type GoalAttemptRun,
  type GoalAttemptStart,
  GoalAttemptTombstonedError,
} from './bureau-catalog-dispatch';
import type { GoalConversations } from './goal-conversation';
import type { AttemptForwarder } from './goal-forwarder';
import {
  GoalCorruptOwnershipRecordError,
  type RunRecordReader,
  verifyAttemptRun,
} from './goal-ownership';
import {
  attemptSessionId,
  boundValidationOutcome,
  type DurableGoalAttempt,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  type GoalState,
  goalTransitionId,
  isTerminalGoalStatus,
} from './goal-state';
import type { GoalStore } from './goal-store';
import type { GoalValidatorCatalog } from './goal-validator-catalog';
import type { CancelDurableRunOutcome } from './types';

/** The deterministic names the workflow and the store share. */
export const goalIdentifiers: GoalWorkflowPorts['identifiers'] = {
  transitionId: goalTransitionId,
  attemptId: goalAttemptId,
  attemptRunId: goalAttemptRunId,
  decisionId: goalDecisionId,
};

// ---------------------------------------------------------------------------
// Late binding
// ---------------------------------------------------------------------------

/** A goal port ran before Bureau finished composing the goal control plane. */
export class GoalPortsUnboundError extends Error {
  constructor(port: string) {
    super(`The goal port "${port}" ran before Bureau bound the goal control plane.`);
    this.name = 'GoalPortsUnboundError';
  }
}

export interface GoalWorkflowHost {
  /** The workflow to register with `createRunEngine({ goalWorkflow })`. */
  readonly workflow: ReturnType<typeof createGoalWorkflow>;
  /** The ports the workflow closes over: forwarders to whatever is bound, or loud failures until then. */
  readonly ports: GoalWorkflowPorts;
  /** Supplies the real ports once everything they close over exists. */
  bind(ports: GoalWorkflowPorts): void;
}

/**
 * The durable engine is built inside the runtime composition, which knows
 * neither the agent catalog nor the goal store. The workflow it registers
 * therefore closes over ports that forward to whatever is bound later, and a
 * port called before then fails its activity loudly rather than answering.
 */
export function createGoalWorkflowHost(): GoalWorkflowHost {
  let bound: GoalWorkflowPorts | undefined;
  const need = (port: string): GoalWorkflowPorts => {
    if (bound === undefined) throw new GoalPortsUnboundError(port);
    return bound;
  };
  const ports: GoalWorkflowPorts = {
    identifiers: goalIdentifiers,
    loadGoalState: (goalRunId) =>
      Promise.resolve().then(() => need('loadGoalState').loadGoalState(goalRunId)),
    commitTransition: (request) =>
      Promise.resolve().then(() => need('commitTransition').commitTransition(request)),
    startAttempt: (request, signal) =>
      Promise.resolve().then(() => need('startAttempt').startAttempt(request, signal)),
    runValidator: (request, signal) =>
      Promise.resolve().then(() => need('runValidator').runValidator(request, signal)),
    abortAttempt: (request) =>
      Promise.resolve().then(() => need('abortAttempt').abortAttempt(request)),
  };
  return {
    workflow: createGoalWorkflow(ports),
    ports,
    bind(next) {
      bound = next;
    },
  };
}

// ---------------------------------------------------------------------------
// The ports
// ---------------------------------------------------------------------------

export interface GoalPortsDependencies {
  readonly store: GoalStore;
  readonly catalog: GoalValidatorCatalog;
  readonly runtime: RuntimeServices;
  readonly forwarder: AttemptForwarder;
  readonly conversations: GoalConversations;
  readonly getDurable: () => DurableActiveRunContext | undefined;
  /** Reads the recovery record that says whose run holds an attempt's deterministic id. */
  readonly readRunRecord: RunRecordReader;
  /** `undefined` when the catalog has no agent by this name. */
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  readonly startAttemptRun: (start: GoalAttemptStart) => GoalAttemptRun;
  readonly cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>;
  /** Tombstones an attempt's claim before its run is stopped; see `goal-attempt-fence.ts`. */
  readonly fenceAttempt: (record: GoalState, attemptIndex: number) => Promise<unknown>;
  readonly resolveCostEstimation: (runId: string) => Promise<RunOptions['costEstimation']>;
}

const failed = (detail: string): GoalWorkflowStart => ({ status: 'failed', detail });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function toAttemptRecord(attempt: DurableGoalAttempt): GoalAttemptRecord {
  return {
    attemptId: attempt.attemptId,
    attemptIndex: attempt.attemptIndex,
    runId: attempt.runId,
    sessionId: attempt.sessionId,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    finishReason: attempt.finishReason,
    validation:
      attempt.validation === undefined
        ? undefined
        : {
            identity: attempt.validation.identity,
            startedAt: attempt.validation.startedAt,
            completedAt: attempt.validation.completedAt,
            outcome: attempt.validation.outcome,
          },
    feedback: attempt.feedback,
    usage: {
      steps: attempt.usage.steps,
      tokens: attempt.usage.tokens,
      costUsd: attempt.usage.costUsd,
    },
    status: attempt.status,
  };
}

export function createGoalPorts(dependencies: GoalPortsDependencies): GoalWorkflowPorts {
  const {
    store,
    catalog,
    runtime,
    forwarder,
    conversations,
    getDurable,
    readRunRecord,
    planAgent,
    startAttemptRun,
    cancelRun,
    fenceAttempt,
    resolveCostEstimation,
  } = dependencies;

  /** Never aborts: shutting down is a crash for the next process to recover, not a verdict. */
  const noAbort = new AbortController().signal;

  async function loadGoalState(goalRunId: string): Promise<GoalWorkflowLoad> {
    return { record: await store.get(goalRunId), nowMs: runtime.clock.now() };
  }

  async function commitTransition(request: GoalWorkflowTransition): Promise<GoalWorkflowCommit> {
    const result = await store.applyTransition(request);
    switch (result.status) {
      case 'applied':
      case 'duplicate':
      case 'stale':
        return { status: result.status };
      case 'rejected':
        return { status: 'rejected', reason: result.reason };
      case 'missing':
      case 'corrupt':
        return { status: result.status };
    }
  }

  async function startAttempt(
    request: GoalWorkflowStartRequest,
    signal?: AbortSignal,
  ): Promise<GoalWorkflowStart> {
    const record = await store.get(request.goalRunId);
    if (record === undefined) {
      return failed(ATTEMPT_RUN_FAILURE_DETAIL.runStart('the goal record is unavailable'));
    }
    const { agentName } = record.objective;
    // Inside an engine activity the engine exists, so its absence is a fault of
    // this process, never a verdict on the goal: throwing lets the activity retry.
    const durable = getDurable();
    if (durable === undefined) {
      throw new Error('The bureau has no durable engine to start a goal attempt with.');
    }
    const target = {
      goalRunId: request.goalRunId,
      attemptIndex: request.attemptIndex,
      runId: request.runId,
    };

    // The goal can be canceled, end, or run out of time at any await below, so
    // the record is read again immediately before each write that would create or
    // extend an attempt. The residual window is the gap between that read and the
    // write it guards: a cancellation landing inside it is caught by the
    // canceller, which tombstones the attempt's claim and stops the run
    // (`abortAttempt`), and by the forwarder, which re-reads the goal before it
    // commits anything; at worst a session reference for a stopped run is written.
    //
    // The aggregate deadline is one of the reasons to stand down, measured with
    // the controller's own function over the same clock, so the two cannot
    // disagree. It counts at every check but the adoption of a run that already
    // exists: the controller stops a run it knows of, and adopting one is not
    // creating one. After the engine starts a run it matters most. The controller
    // waits only for the starts it issued; a try Weft timed out that is still
    // running, or the host's own recovery start, creates its run with no one
    // waiting, and the goal's record is not yet terminal for the check to see
    // when the controller has only just found the deadline elapsed. The deadline
    // is monotonic and the controller reads the same clock, so a run stopped here
    // is one the controller would have stopped as well.
    const goalIsOver = async (withDeadline: boolean): Promise<boolean> => {
      const latest = await store.get(request.goalRunId);
      return (
        latest === undefined ||
        latest.cancellation !== undefined ||
        isTerminalGoalStatus(latest.status) ||
        (withDeadline && isDeadlineElapsed(latest, runtime.clock.now()))
      );
    };
    // Weft aborts the activity's signal when it times this try out, and the try
    // goes on running in the background while the retry that replaced it starts.
    // Such a try writes nothing further: every durable write below is preceded by
    // this check, so the only thing it can still leave is what the retry adopts.
    // It does not stop a run it already created, because the goal is still live
    // and the retry adopts that run; stopping it would hand the retry an aborted
    // one, which the controller reads as a failed attempt. A goal that really is
    // over is stopped by `goalIsOver` below, whether or not the signal fired.
    const timedOut = (): boolean => signal?.aborted === true;
    const mustStandDown = async (withDeadline: boolean): Promise<boolean> =>
      timedOut() || (await goalIsOver(withDeadline));
    const standDown = (): GoalWorkflowStart => ({ status: 'stood-down' });

    const adopt = async (): Promise<GoalWorkflowStart | undefined> => {
      let existing: Awaited<ReturnType<typeof durable.engine.get>>;
      try {
        existing = await durable.engine.get(request.runId);
      } catch (error) {
        // A record that is present but invalid fails the attempt, explicitly.
        if (error instanceof GoalCorruptOwnershipRecordError) {
          return failed(ATTEMPT_RUN_FAILURE_DETAIL.runStart(error.message));
        }
        throw error;
      }
      if (existing === null) return undefined;
      if (!isAgentRunWorkflowInput(existing.input) || existing.input.runId !== request.runId) {
        return failed(
          ATTEMPT_RUN_FAILURE_DETAIL.runStart(
            `run id "${request.runId}" names a different workflow`,
          ),
        );
      }
      // The ownership read above was made before this start waited on anything,
      // and a claim can be replaced since: by another goal's start, or by a
      // record that no longer decodes. What is adopted is read as the goal's own
      // again here, at the point of adoption, with the same test, including for
      // the run a racing start created. A record that cannot be read rejects,
      // and the activity retries.
      const holder = await verifyAttemptRun(
        { engine: durable.engine, readRunRecord },
        {
          goalRunId: record.goalRunId,
          attemptIndex: request.attemptIndex,
          agentName,
          principal: record.principal,
          maximumAttempts: record.bounds.maximumAttempts,
        },
        request.runId,
      );
      if (holder.status === 'foreign' || holder.status === 'corrupt') {
        return failed(ATTEMPT_RUN_FAILURE_DETAIL.runStart(holder.detail));
      }
      // A crash between the engine's start and this write leaves a run with no
      // ref in its session; repeating the write is idempotent.
      if (await mustStandDown(false)) return standDown();
      await conversations.recordStart(record, request);
      forwarder.watch(target);
      return {
        status: 'adopted',
        sessionId: attemptSessionId(
          record.goalRunId,
          record.conversationPolicy.kind,
          request.attemptIndex,
        ),
      };
    };

    // A cancellation that is already recorded must not be given a run to stop.
    if (
      timedOut() ||
      record.cancellation !== undefined ||
      isTerminalGoalStatus(record.status) ||
      isDeadlineElapsed(record, runtime.clock.now())
    ) {
      return standDown();
    }
    // An id is not ownership: a run, a claim, or a session already holding one
    // of this goal's deterministic ids may belong to another goal, another
    // principal, or no goal at all. Nothing is adopted, started over, or
    // appended to until it is proved to be this goal's own.
    const ownership = await verifyAttemptRun(
      { engine: durable.engine, readRunRecord },
      {
        goalRunId: record.goalRunId,
        attemptIndex: request.attemptIndex,
        agentName,
        principal: record.principal,
        maximumAttempts: record.bounds.maximumAttempts,
      },
      request.runId,
    );
    if (ownership.status === 'foreign' || ownership.status === 'corrupt') {
      return failed(ATTEMPT_RUN_FAILURE_DETAIL.runStart(ownership.detail));
    }
    const foreignSession = await conversations.verify(record, request.attemptIndex);
    if (foreignSession !== undefined) {
      return failed(ATTEMPT_RUN_FAILURE_DETAIL.conversationPolicy(foreignSession));
    }
    const adopted = await adopt();
    if (adopted !== undefined) return adopted;
    // Only a run that must be started needs the agent as the catalog holds it
    // now. A run that already exists was started from the definition of its own
    // time, and adopting it needs nothing from today's catalog: an agent that
    // was removed or made non-durable since must not strand its finished or
    // running attempt. This is deliberately after the adoption above.
    const plan = planAgent(agentName);
    if (plan === undefined) {
      return failed(
        ATTEMPT_RUN_FAILURE_DETAIL.runStart(`agent "${agentName}" is no longer in the catalog`),
      );
    }
    if (!plan.durable) {
      return failed(
        ATTEMPT_RUN_FAILURE_DETAIL.runStart(
          `agent "${agentName}" cannot run durably (agent-not-durable-capable)`,
        ),
      );
    }
    if (await mustStandDown(true)) return standDown();
    const seat = await conversations.seat(record, request);
    if (seat.status === 'failed') return failed(seat.detail);
    if (await mustStandDown(true)) return standDown();
    let started: GoalAttemptRun;
    try {
      started = startAttemptRun({
        agentName,
        input: seat.input,
        runId: request.runId,
        goalRunId: request.goalRunId,
        attemptIndex: request.attemptIndex,
        ...(record.principal === undefined ? {} : { principal: record.principal }),
      });
      // The handle is deferred: resolving the agent, claiming the recovery
      // record, and starting the engine workflow all happen after it is
      // returned. Answering before they have would let a cancellation or a
      // deadline find no run to stop, and a failed start would leave the goal
      // waiting for a run that does not exist.
      await started.durablyStarted;
    } catch (error) {
      // A start that raced this one is success; anything else fails the
      // activity, which the controller treats as its own failure and recovery
      // restarts, rather than ending the goal over a transient fault.
      const raced = await adopt();
      if (raced !== undefined) return raced;
      // The goal tombstoned this attempt's claim between this start's read of the
      // goal and its own claim: it ended over the attempt, so nothing starts.
      if (error instanceof GoalAttemptTombstonedError) return standDown();
      // A permanent property of the agent is a verdict on the attempt, not a
      // fault to retry.
      if (
        error instanceof GoalAttemptNotDurableCapableError ||
        error instanceof GoalAttemptInvalidCostEstimationError
      ) {
        return failed(ATTEMPT_RUN_FAILURE_DETAIL.runStart(`${error.reason}: ${error.message}`));
      }
      throw error;
    }
    // The cancellation marker is written before `cancelRun` looks for the run,
    // and the run existed before this read. So either this read sees the marker
    // and stops the run itself, or the marker lands after it and the
    // canceller's `cancelRun` finds the run: no start escapes both. The deadline
    // has no marker to be ordered against, so it is read here, after the run
    // exists, and the controller's own stop of a run it knows is the other half.
    if (await goalIsOver(true)) {
      await abortAttempt({ ...target, attemptId: request.attemptId });
      return standDown();
    }
    // A try Weft timed out ends here without writing the session reference or
    // attaching a forwarder: the retry adopts this run and does both. When this
    // was the last try there is no retry, and the run is left alive and
    // unadopted. That is harmless by the acknowledged-only invariant of the run's
    // own fence (`goal-attempt-fence.ts`): the run takes no step until the goal's
    // record shows this attempt open, which the controller (failed, with no
    // commit to make) does not do unless Bureau's bounded restart revives it
    // within the run's budget, in which case its adoption of this run commits
    // `running` and acknowledges it. Otherwise the run waits out its bounded budget
    // and stops with zero steps. The named residual is that zero-step workflow
    // record, which `cleanUpGoal` prunes.
    if (timedOut()) return standDown();
    await conversations.recordStart(record, request);
    forwarder.watch(target, started.run);
    return { status: 'started', sessionId: seat.sessionId };
  }

  async function runValidator(
    request: GoalWorkflowValidatorRequest,
    signal?: AbortSignal,
  ): Promise<ProjectedValidatorResult> {
    const startedAt = runtime.clock.nowISO();
    const unavailable = (
      kind: 'error' | 'unavailable',
      code: string,
      message: string,
    ): ProjectedValidatorResult => {
      const error = { kind: 'load' as const, code, message };
      const outcome: ProjectedValidatorOutcome =
        kind === 'unavailable' ? { kind, error, reason: message } : { kind, error };
      return {
        identity: request.validator,
        startedAt,
        completedAt: runtime.clock.nowISO(),
        outcome,
      };
    };

    const resolution = catalog.resolve(request.validator);
    if (!resolution.ok) {
      const message =
        resolution.reason === 'missing'
          ? `The validator "${request.validator.name}@${request.validator.version}" is not registered.`
          : `The validator "${request.validator.name}" has no version "${request.validator.version}"; registered: ${resolution.availableVersions.join(', ')}.`;
      return unavailable(
        'unavailable',
        resolution.reason === 'missing' ? 'VALIDATOR_MISSING' : 'VALIDATOR_VERSION_MISMATCH',
        message,
      );
    }

    const record = await store.get(request.goalRunId);
    const attempt = record?.attempts[request.attemptIndex];
    const durable = getDurable();
    // An absent engine is a fault to retry, not a verdict on the attempt: an
    // `error` outcome would end the goal over something the next try may not have.
    if (record !== undefined && attempt !== undefined && durable === undefined) {
      throw new Error("The bureau has no durable engine to read the attempt's result with.");
    }
    if (record === undefined || attempt === undefined || durable === undefined) {
      return unavailable(
        'error',
        'ATTEMPT_UNAVAILABLE',
        `Attempt ${request.attemptIndex} of goal "${request.goalRunId}" cannot be read.`,
      );
    }
    // Always rebuilt with the estimator the run was started with, so the
    // validator sees the same `costEstimate` the live run and the in-memory
    // controller show it, bound or not. A failing resolver fails this activity,
    // which is retried, rather than reading the result without an estimate and
    // recording the attempt's cost as unaccounted for good.
    const costEstimation = await resolveCostEstimation(attempt.runId);
    // A read that throws is a fault, not a verdict: it propagates so the
    // activity is retried, the same as a failing resolver above. Recording it as
    // an `error` outcome would end the goal over a storage hiccup that the next
    // try does not have. `not-terminal` is the same kind of fault, since the
    // forwarder only signals an attempt whose run it read as ended.
    const reading = await readDurableRunResult(durable, attempt.runId, {
      runtime,
      costEstimation,
    });
    if (reading.status === 'not-terminal') {
      throw new Error(`Run "${attempt.runId}" is not yet readable as ended; the read is retried.`);
    }
    if (reading.status !== 'completed') {
      return unavailable(
        'error',
        'ATTEMPT_RESULT_UNAVAILABLE',
        `The result of run "${attempt.runId}" cannot be read (${reading.status}).`,
      );
    }

    const execution = await executeValidator(
      resolution.entry.validator,
      {
        goalRunId: request.goalRunId,
        attemptId: request.attemptId,
        attemptIndex: request.attemptIndex,
        result: reading.result,
        history: record.attempts.slice(0, request.attemptIndex).map(toAttemptRecord),
      },
      // The activity's signal, which Weft aborts when the controller is cancelled
      // or the try times out; the executor composes it with the validator's own
      // timeout, so either stops a validator that honors its signal.
      signal ?? noAbort,
      { timeoutMs: request.validatorTimeoutMs, runtime },
    );
    const projected = projectValidatorResult({
      identity: resolution.entry.identity,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      outcome: execution.outcome,
    });
    return { ...projected, outcome: boundValidationOutcome(projected.outcome) };
  }

  async function abortAttempt(request: GoalWorkflowAbortRequest): Promise<void> {
    // The claim is tombstoned before the run is looked for. A start that has
    // claimed the run but not yet created it leaves no run to stop, and the
    // tombstone is what stops the run it goes on to create: that run's own fence
    // finds the claim tombstoned and takes no step. A rejection fails the
    // activity, which retries, because the abort is still owed.
    // A record that cannot be read is nothing to tombstone against, and nothing
    // the run needs a tombstone for: its own fence refuses a step for a goal whose
    // record is missing or unreadable (`goal-attempt-fence.ts`), and a read that
    // throws rejects here and retries.
    const record = await store.get(request.goalRunId);
    // The controller names the next attempt's index when none is in flight, and
    // for a goal at `maximumAttempts` that index is one no start can mint: there
    // is no claim to tombstone and no run to stop, and a tombstone written for it
    // would be a record nothing ever reads or prunes.
    if (record !== undefined && request.attemptIndex >= record.bounds.maximumAttempts) return;
    if (record !== undefined) await fenceAttempt(record, request.attemptIndex);
    const outcome = await cancelRun(request.runId);
    if (outcome.status === 'failed') {
      throw outcome.error instanceof Error ? outcome.error : new Error(describe(outcome.error));
    }
  }

  return {
    identifiers: goalIdentifiers,
    loadGoalState,
    commitTransition,
    startAttempt,
    runValidator,
    abortAttempt,
  };
}
