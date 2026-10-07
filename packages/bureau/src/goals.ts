/**
 * COR-851 — `bureau.goals`: the control plane over durable goals.
 *
 * A goal is three things that must agree: a record (`GoalState`) that is the
 * truth, a Weft workflow that is its single-owner controller, and one durable
 * agent run per attempt. This file creates, reads, and closes goals; the pieces
 * that touch all three live beside it (`goal-cancellation.ts`,
 * `goal-recovery.ts`, `goal-ports.ts`).
 *
 * ## Authorization
 *
 * Each operation takes an optional `principal`, compared with the one the goal
 * was created under exactly as `bureau.children` compares them: omitting it is
 * a trusted, internal call, and a mismatch reads as `not-found`, so a caller
 * cannot tell "wrong id" from "not yours".
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  FreshAttemptArtifactError,
  type FreshAttemptSourceResolver,
  GoalConfigurationError,
  type GoalRunStatus,
  validateFreshAttemptArtifact,
} from '@lostgradient/operative';

import { cancelGoal, settleCanceledGoal } from './goal-cancellation';
import { cleanUpGoal, isCleanupDone } from './goal-cleanup';
import { ensureController, type GoalControlDependencies } from './goal-controller';
import {
  mayHaveOvertakenAStart,
  recoverEveryGoal,
  recoverGoal,
  stopOvertakenRuns,
  UNREADABLE_RECORD_DETAIL,
} from './goal-recovery';
import {
  createGoalState,
  GoalObjectiveTooLargeError,
  GoalRunIdError,
  type GoalState,
  InvalidGoalStateError,
  isTerminalGoalStatus,
} from './goal-state';
import type {
  BureauGoalActiveWork,
  BureauGoalCancelOptions,
  BureauGoalCancelOutcome,
  BureauGoalCloseOutcome,
  BureauGoalCreateOutcome,
  BureauGoalListOptions,
  BureauGoalQuery,
  BureauGoalRecoveryReport,
  BureauGoalRequest,
  BureauGoals,
} from './goal-types';
import { principalAllows } from './principal-allows';

export interface BureauGoalsDependencies extends GoalControlDependencies {
  readonly runtime: Pick<RuntimeServices, 'identifiers'>;
  /** See `BureauOptions.resolveFreshAttemptSource`. */
  readonly resolveFreshAttemptSource: FreshAttemptSourceResolver | undefined;
  /** `undefined` when the catalog has no agent by this name. */
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
}

const NO_ENGINE_TO_READ_RUN =
  "This bureau has no durable engine, so the run's workflow status cannot be read.";

const GOAL_ID_NOT_TEXT = 'The goal id must be text.';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * JSON with object keys sorted and `undefined` members dropped, so two requests
 * that list the same configuration in another key order (an artifact, a budget,
 * an identity) compare equal. Arrays keep their order: it is part of the value.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const members = Object.keys(value)
      .toSorted()
      .flatMap((key) => {
        const member: unknown = (value as Record<string, unknown>)[key];
        return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
      });
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The parts of a record that a create request determines, for telling a repeat from a conflict. */
function configurationOf(state: GoalState): string {
  return canonicalJson([
    state.identity,
    state.objective,
    state.validator,
    state.requireDeterministicValidation,
    state.validatorTimeoutMs ?? null,
    state.conversationPolicy,
    state.retryPolicy ?? null,
    state.bounds,
    state.principal ?? null,
  ]);
}

export function createBureauGoals<TName extends string = string>(
  dependencies: BureauGoalsDependencies,
): BureauGoals<TName> {
  const {
    store,
    catalog,
    runtime,
    clock,
    getEngine,
    planAgent,
    isClosing,
    resolveFreshAttemptSource,
  } = dependencies;

  async function authorized(
    goalRunId: string,
    query: BureauGoalQuery | undefined,
  ): Promise<GoalState | undefined> {
    const record = await store.get(goalRunId);
    return record !== undefined && principalAllows(query?.principal, record.principal)
      ? record
      : undefined;
  }

  /**
   * What a caller is told when no goal is visible under an id: `not-found`,
   * unless a record is stored there that cannot be decoded, which is a fault and
   * not absence (`create` says the same of the same id). A record that cannot
   * be decoded has no readable owner, so only a caller who may see every goal
   * (no principal) is told so; a principal-scoped caller gets exactly the answer
   * it gets for a goal it does not own or that does not exist.
   */
  async function absent(
    goalRunId: string,
    query: BureauGoalQuery | undefined,
  ): Promise<{ readonly outcome: 'not-found' | 'record-unreadable' }> {
    return query?.principal === undefined && (await store.isUnreadable(goalRunId))
      ? { outcome: 'record-unreadable' }
      : { outcome: 'not-found' };
  }

  async function create(request: BureauGoalRequest<TName>): Promise<BureauGoalCreateOutcome> {
    const rejected = (
      code: Extract<BureauGoalCreateOutcome, { outcome: 'rejected' }>['code'],
      reason: string,
      availableVersions?: readonly string[],
    ): BureauGoalCreateOutcome => ({
      outcome: 'rejected',
      code,
      reason,
      ...(availableVersions === undefined ? {} : { availableVersions }),
    });

    // `create` takes input the type system does not reach (a JSON body, a script),
    // so each field is read defensively: a malformed one is a typed rejection,
    // never an exception, and nothing is written for it.
    if (typeof request !== 'object' || request === null) {
      return rejected('invalid-configuration', 'The goal request must be an object.');
    }
    if (request.goalRunId !== undefined && typeof request.goalRunId !== 'string') {
      return rejected('invalid-goal-run-id', GOAL_ID_NOT_TEXT);
    }
    const conversationPolicy = request.conversationPolicy;
    const goalRunId = request.goalRunId ?? runtime.identifiers.next('goal-run');
    const validatorRequest: unknown = request.validator;
    const validator =
      typeof validatorRequest === 'object' && validatorRequest !== null
        ? {
            name: (validatorRequest as typeof request.validator).name,
            version: (validatorRequest as typeof request.validator).version,
          }
        : undefined;

    // The record this request describes, built from the request alone: nothing
    // in it depends on what the bureau can do today (the validator's identity is
    // the one requested, which the catalog only confirms), so a repeat can be
    // compared to what is stored before any current capability is consulted. A
    // request that cannot be built is reported where it always was, below.
    let built: { readonly state: GoalState } | { readonly error: unknown };
    try {
      built = {
        state: createGoalState({
          goalRunId,
          identity: request.identity,
          objective: {
            agentName: request.agentName,
            prompt: request.prompt,
            ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
          },
          // A request with no validator object is carried through as it is, for the
          // record's own check to name (`describeCreateDefect`).
          validator: validator ?? (validatorRequest as typeof request.validator),
          requireDeterministicValidation: request.requireDeterministicValidation,
          validatorTimeoutMs: request.validatorTimeoutMs,
          conversationPolicy:
            conversationPolicy === undefined ? { kind: 'continue' } : conversationPolicy,
          retryPolicy: request.retryPolicy,
          bounds: request.bounds,
          principal: request.principal,
          now: clock.nowISO(),
        }),
      };
    } catch (error) {
      built = { error };
    }

    /** A goal under this id is already stored: a repeat of the same request heals it, a different one conflicts. */
    async function repeatOf(
      existing: GoalState,
      state: GoalState,
    ): Promise<BureauGoalCreateOutcome> {
      if (configurationOf(existing) !== configurationOf(state)) {
        // A request from a different principal has no claim on what is stored.
        return principalAllows(request.principal, existing.principal)
          ? { outcome: 'conflict', goal: existing }
          : { outcome: 'conflict' };
      }
      if (isTerminalGoalStatus(existing.status)) return { outcome: 'existing', goal: existing };
      // A controller is not started once the bureau is shutting down; the goal
      // is still the one that was asked for, and the caller is told so.
      if (isClosing()) {
        return {
          outcome: 'existing',
          goal: existing,
          controller: { status: 'start-failed', reason: 'The bureau is shutting down.' },
        };
      }
      // The first call may have died between recording the goal and starting
      // its controller; repeating it is how a caller heals that. A controller
      // that cannot be ensured now (no engine, a start that fails) is reported
      // in `controller`: it does not turn a recognized repeat into a refusal.
      const ensured = await ensureController(dependencies, existing);
      return { outcome: 'existing', goal: ensured.goal, controller: ensured.controller };
    }

    // An id already in the store decides the call before anything about the
    // bureau's present capabilities does: a repeat of a request that was accepted
    // is `existing` (or `conflict`) even when its engine, agent, or validator is
    // gone now, and for a goal that has ended. Those checks decide a new record.
    // A request that could not be built (an id the store cannot key, say) names
    // no record, so it is never looked up.
    if (request.goalRunId !== undefined && 'state' in built) {
      const stored = await store.get(goalRunId);
      if (stored !== undefined) return repeatOf(stored, built.state);
      if (await store.isUnreadable(goalRunId)) {
        return rejected(
          'record-unreadable',
          `The record stored for goal "${goalRunId}" is unreadable.`,
        );
      }
    }

    if (isClosing()) return rejected('shutdown', 'The bureau is shutting down.');
    const engine = getEngine();
    if (engine === undefined) {
      return rejected(
        'durable-unavailable',
        'Durable goals need a durable engine; this bureau has none.',
      );
    }
    // Looked up by name only when there is one: any other value is a request
    // that cannot be built, whatever the bureau's agents are.
    if (typeof request.agentName !== 'string') {
      return rejected('invalid-configuration', 'The goal agent name must be text.');
    }
    const plan = planAgent(request.agentName);
    if (plan === undefined) {
      return rejected('agent-not-found', `Unknown agent "${request.agentName}".`);
    }
    if (!plan.durable) {
      return rejected(
        'agent-not-durable',
        `Agent "${request.agentName}" cannot run durably, so it cannot run a goal attempt.`,
      );
    }
    if (validator === undefined) {
      return rejected(
        'invalid-configuration',
        'The goal validator must be exactly a non-empty name and version.',
      );
    }
    const resolution = catalog.resolve(validator);
    if (!resolution.ok) {
      return resolution.reason === 'missing'
        ? rejected(
            'validator-missing',
            `The validator "${validator.name}@${validator.version}" is not registered.`,
          )
        : rejected(
            'validator-version-mismatch',
            `The validator "${validator.name}" has no version "${validator.version}".`,
            resolution.availableVersions,
          );
    }

    // Everything a `fresh-from-artifact` attempt will check about its artifact,
    // so a goal whose artifact could never seed an attempt is refused before it
    // is recorded rather than failing on its first retry. It decides only a goal
    // that is not already stored: a check that depends on the time it runs (the
    // retention window, a source that has since gone) must not turn a repeated
    // `create` into a refusal, which is how a caller heals a crash between
    // recording the goal and starting its controller.
    let artifactRefusal: BureauGoalCreateOutcome | undefined;
    if (conversationPolicy?.kind === 'fresh-from-artifact') {
      try {
        await validateFreshAttemptArtifact(conversationPolicy.artifact, {
          resolveSource: resolveFreshAttemptSource ?? (() => undefined),
          now: clock.now(),
        });
      } catch (error) {
        if (!(error instanceof FreshAttemptArtifactError)) throw error;
        artifactRefusal = rejected(
          'invalid-configuration',
          `fresh-from-artifact: ${error.message}`,
        );
      }
    }

    // A durable goal has no session before its first attempt, so the one run a
    // retry can fork through is attempt 0. Any other baseline could never be
    // satisfied, and would only be found out after an attempt had been spent.
    if (conversationPolicy?.kind === 'fork-from-baseline' && conversationPolicy.throughRun !== 0) {
      return rejected(
        'invalid-configuration',
        `fork-from-baseline: throughRun must be 0 for a durable goal, whose only baseline is its first attempt; got ${conversationPolicy.throughRun}.`,
      );
    }

    if ('error' in built) {
      const { error } = built;
      if (artifactRefusal !== undefined) return artifactRefusal;
      if (error instanceof GoalObjectiveTooLargeError) {
        return rejected('objective-too-large', error.message);
      }
      if (error instanceof GoalRunIdError) return rejected('invalid-goal-run-id', error.message);
      if (error instanceof GoalConfigurationError) {
        return rejected('invalid-configuration', `${error.reason}: ${error.message}`);
      }
      // A request the record decoder would refuse is a configuration to correct,
      // not an exception: `createGoalState` names the invariant it broke.
      if (error instanceof InvalidGoalStateError) {
        return rejected('invalid-configuration', error.message);
      }
      throw error;
    }
    const { state } = built;
    if (artifactRefusal !== undefined) return artifactRefusal;

    const created = await store.create(state);
    if (created.status === 'duplicate') {
      if (created.existing === undefined) {
        return rejected(
          'record-unreadable',
          `The record stored for goal "${goalRunId}" is unreadable.`,
        );
      }
      return repeatOf(created.existing, state);
    }

    // The shutdown check at the top of this call was made before the record was
    // written; a shutdown that began since must not get a controller. The goal is
    // recorded, and a repeat of this call or the next boot starts it.
    if (isClosing()) {
      return {
        outcome: 'created',
        goal: state,
        controller: { status: 'start-failed', reason: 'The bureau is shutting down.' },
      };
    }

    // COR-638: a validator that cannot supply the evidence a goal demands ends
    // it `failed`/`unsupported-validation` before any attempt runs, and the
    // same check guards every other place a controller is started.
    const ensured = await ensureController(dependencies, state);
    return { outcome: 'created', goal: ensured.goal, controller: ensured.controller };
  }

  async function list(options?: BureauGoalListOptions): Promise<GoalState[]> {
    // The filter is untyped input too: one that is not a status or a list of
    // them matches no goal, and is never widened to match every one.
    const requested: unknown = options?.status;
    const wanted: readonly GoalRunStatus[] | undefined =
      requested === undefined
        ? undefined
        : typeof requested === 'string'
          ? [requested as GoalRunStatus]
          : Array.isArray(requested)
            ? (requested as GoalRunStatus[])
            : [];
    const records = await store.list();
    return records
      .filter(
        (record) =>
          principalAllows(options?.principal, record.principal) &&
          (wanted === undefined || wanted.includes(record.status)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.goalRunId.localeCompare(right.goalRunId),
      );
  }

  async function active(
    goalRunId: string,
    query?: BureauGoalQuery,
  ): Promise<BureauGoalActiveWork | undefined> {
    const record = await authorized(goalRunId, query);
    const work = record?.active;
    if (record === undefined || work === undefined) return undefined;
    const attemptIndex = record.attempts.findIndex(
      (attempt) => attempt.attemptId === work.attemptId,
    );
    if (work.kind === 'validation') {
      return {
        kind: 'validation',
        attemptId: work.attemptId,
        attemptIndex,
        validator: work.validator,
        startedAt: work.startedAt,
      };
    }
    // A read that fails is not a run with no workflow: `runStatus` is `null` for
    // both, so the fault is named beside it.
    // Neither is a bureau with no durable engine: it cannot look, which is not
    // the same as looking and finding no workflow.
    let runStatusError: string | undefined;
    const engine = getEngine();
    let run: Awaited<ReturnType<NonNullable<typeof engine>['get']>> | undefined;
    if (engine === undefined) {
      runStatusError = NO_ENGINE_TO_READ_RUN;
    } else {
      run = await engine.get(work.runId).catch((error: unknown) => {
        runStatusError = describe(error);
        return null;
      });
    }
    return {
      kind: 'attempt',
      attemptId: work.attemptId,
      attemptIndex,
      runId: work.runId,
      startedAt: work.startedAt,
      runStatus: run?.status ?? null,
      ...(runStatusError === undefined ? {} : { runStatusError }),
    };
  }

  async function cancel(
    goalRunId: string,
    given?: BureauGoalCancelOptions,
  ): Promise<BureauGoalCancelOutcome> {
    // Untyped input: only an object is a set of options, and `null` is none.
    const supplied: Record<string, unknown> =
      typeof given === 'object' && given !== null ? (given as Record<string, unknown>) : {};
    // Every field is untyped too, and the store refuses a marker whose fields are
    // not text, which would reject the whole call. A principal that is not text
    // names no one, so it may act on nothing (fail closed, answered as no goal);
    // a reason that is not text is dropped, because it only annotates the marker.
    if (supplied['principal'] !== undefined && typeof supplied['principal'] !== 'string') {
      return { outcome: 'not-found' };
    }
    const options: BureauGoalCancelOptions = {
      ...(supplied['principal'] === undefined ? {} : { principal: supplied['principal'] }),
      ...(typeof supplied['reason'] === 'string' ? { reason: supplied['reason'] } : {}),
    };
    const record = await authorized(goalRunId, options);
    return record === undefined
      ? await absent(goalRunId, options)
      : cancelGoal(dependencies, record, options);
  }

  async function recover(
    goalRunId?: string,
    query?: BureauGoalQuery,
  ): Promise<BureauGoalRecoveryReport> {
    // The id is untyped input too. One that is named but is not text names no
    // goal, so it is neither carried into the report, whose ids are text, nor
    // widened into the sweep over every goal. `create` answers the same fault
    // with the same reason.
    if (goalRunId !== undefined && typeof goalRunId !== 'string') {
      return {
        goals: [],
        failures: [{ goalRunId: '*', reason: GOAL_ID_NOT_TEXT }],
      };
    }
    try {
      if (goalRunId === undefined) {
        // A record that cannot be decoded has no principal to check, so only a
        // caller who may see every goal is told which ones are unreadable.
        return await recoverEveryGoal(
          dependencies,
          (record) => principalAllows(query?.principal, record.principal),
          query?.principal === undefined,
        );
      }
      if ((await authorized(goalRunId, query)) === undefined) {
        const gone = await absent(goalRunId, query);
        return {
          goals: [
            gone.outcome === 'record-unreadable'
              ? {
                  goalRunId,
                  outcome: 'unrecoverable',
                  detail: UNREADABLE_RECORD_DETAIL(goalRunId),
                }
              : { goalRunId, outcome: 'not-found' },
          ],
          failures: [],
        };
      }
      return { goals: [await recoverGoal(dependencies, goalRunId)], failures: [] };
    } catch (error) {
      return {
        goals: [],
        failures: [{ goalRunId: goalRunId ?? '*', reason: describe(error) }],
      };
    }
  }

  async function close(
    goalRunId: string,
    query?: BureauGoalQuery,
  ): Promise<BureauGoalCloseOutcome> {
    const record = await authorized(goalRunId, query);
    if (record === undefined) return absent(goalRunId, query);
    const unsettled = await settleBeforeClosing(record, query);
    if (unsettled !== undefined) return unsettled;
    const closed = await store.close(goalRunId, clock.nowISO());
    switch (closed.status) {
      case 'updated':
      case 'unchanged': {
        // The settlement above ran against the record this call read. When that
        // record was not terminal, a transition (a cancel, an exhausted
        // deadline, a start failure) may have won the race to the close, and the
        // closure just accepted is over a goal whose controller, finalizer, or
        // run was never settled. The closure is committed and cannot be taken
        // back, so the goal stays unmarked (`cleanedUpAt` unset), and so in the
        // boot sweep, until the same settlement reads back clean.
        if (!isTerminalGoalStatus(record.status)) {
          const unsettledAfterRace = await settleBeforeClosing(closed.record, query);
          if (unsettledAfterRace !== undefined) return unsettledAfterRace;
        }
        return await finishClosure(closed.record, query);
      }
      case 'rejected':
        return { outcome: 'not-terminal', goal: closed.record };
      case 'stale':
        return { outcome: 'contended', goal: closed.record };
      case 'corrupt':
        // The record decoded a moment ago and no longer does.
        return query?.principal === undefined
          ? { outcome: 'record-unreadable' }
          : { outcome: 'not-found' };
      case 'missing':
        return { outcome: 'not-found' };
    }
  }

  /**
   * What must be true of a goal before it leaves the boot sweep. A canceled goal
   * whose controller, finalizer, or attempt run is not read back as ended, and an
   * exhausted or start-failed goal whose ending may have overtaken a run, must
   * not be closed over: nothing would be left to finish them. `undefined` when
   * nothing is owed (or the goal is not one of those).
   */
  async function settleBeforeClosing(
    record: GoalState,
    query: BureauGoalQuery | undefined,
  ): Promise<BureauGoalCloseOutcome | undefined> {
    if (record.status === 'canceled') {
      const settled = await settleCanceledGoal(dependencies, record, {
        scoped: query?.principal !== undefined,
      });
      if (settled.outcome === 'not-found' || settled.outcome === 'record-unreadable') {
        return settled;
      }
      if (settled.outcome === 'cancellation-pending') {
        return {
          outcome: 'cancellation-pending',
          goal: settled.goal,
          awaiting: settled.awaiting,
        };
      }
      return undefined;
    }
    if (mayHaveOvertakenAStart(record)) {
      // The controller waits for an attempt's start, so its own ending stops the
      // run it knows of. What is left is a run created after the goal ended (a
      // timed-out background try, the host's recovery start, or a process that
      // died before the start's own stand-down check). Closing and cleaning the
      // goal takes it out of the boot sweep, which is what stops such a run, so it
      // is stopped first and a run that cannot be stopped (or cannot be looked
      // for, with no engine) keeps the goal open.
      const stopped = await stopOvertakenRuns(dependencies, record);
      if (stopped.outcome === 'cleanup-pending') {
        return {
          outcome: 'cleanup-pending',
          goal: record,
          detail: stopped.detail ?? 'A run the goal ended over could not be stopped.',
        };
      }
    }
    return undefined;
  }

  /**
   * Applies the checkpoint retention a closure owes and, once nothing is left
   * owed, records it on the goal (`cleanedUpAt`). The closure is already
   * committed, so a process that dies before this ends is finished by the next
   * boot's sweep, and one whose cleanup could not finish leaves the goal
   * unmarked for the next `close()` or boot to retry. The acknowledgement is
   * the truthful result of this attempt either way.
   */
  async function finishClosure(
    record: GoalState,
    query: BureauGoalQuery | undefined,
  ): Promise<BureauGoalCloseOutcome> {
    const cleanup = await cleanUpGoal(dependencies, record);
    if (!isCleanupDone(cleanup) || record.cleanedUpAt !== undefined) {
      return { outcome: 'closed', goal: record, cleanup };
    }
    const marked = await store.markCleanedUp(record.goalRunId, clock.nowISO());
    switch (marked.status) {
      case 'updated':
      case 'unchanged':
        return { outcome: 'closed', goal: marked.record, cleanup };
      case 'missing':
        return { outcome: 'not-found' };
      case 'corrupt':
        // The record decoded a moment ago and no longer does.
        return query?.principal === undefined
          ? { outcome: 'record-unreadable' }
          : { outcome: 'not-found' };
      case 'rejected':
      case 'stale':
        // The pruning is done but not recorded, so the goal still owes it as far
        // as every later read can tell: reporting it closed and cleaned would
        // hide that nothing has marked it, and the next close() or boot does.
        return {
          outcome: 'cleanup-pending',
          goal: marked.record,
          detail: `The closed goal's checkpoint cleanup finished, but recording it did not (${marked.status}); the next boot or close() records it.`,
        };
    }
  }

  return { create, get: authorized, list, active, cancel, recover, close };
}
