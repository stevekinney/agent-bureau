/**
 * COR-851 — proof that what a goal adopts, stops, or signals is the goal's own.
 *
 * Every id a goal uses is a deterministic function of its caller-chosen
 * `goalRunId`: the controller workflow (`goal:<id>`), each attempt's run
 * (`goal-<id>-a<n>`), and its sessions (`goal-<id>-s<n>`). Determinism is what
 * makes a restart find its own work, and it is also what lets another goal, an
 * ordinary run, or another principal already be holding an id the goal is about
 * to treat as its own. An id is never ownership. This file is the single place
 * that decides, from a marker the goal's own start wrote, whether an existing
 * run or workflow belongs to the goal.
 *
 * - A run is the goal's when its catalog recovery record carries
 *   `goalAttempt: { goalRunId, attemptIndex }` that reproduces the run's id, and
 *   names the agent and principal of the goal that marker names (read from the
 *   goal's own record, never from the run's marker).
 * - A controller is the goal's when its workflow type is the goal workflow and
 *   its input names the goal.
 * - A session is checked by `goal-conversation.ts` against the `goalRunId` and
 *   authority its own writes recorded.
 *
 * Ownership is checked at the point of use, and the ids are also reserved: an
 * ordinary caller may not choose a run, child run, session, or schedule id in a
 * goal's namespace (`reserved-identifiers.ts`). The reservation exists because
 * ownership cannot protect everything: Weft purges every event carrying a
 * workflow's id when it retires that workflow, so an ordinary workflow that
 * merely shares a goal's audit id would erase the audit trail. The check at the
 * point of use stays as defence in depth, and it covers every other way an id
 * can come to be occupied, including a store written by something else.
 *
 * Two layers use that check. The start-attempt port verifies explicitly, because it
 * must tell "absent" from "foreign" and answer a typed failure. Everything
 * else (cancel, recovery, the read-back, the forwarder) sees the world through
 * `createOwnedGoalEngine` and `createOwnedRunCanceller`, under which a workflow
 * or run the goal does not own does not exist: it is never read, signalled,
 * resumed, cancelled, replaced, or waited on.
 */

import { GOAL_WORKFLOW_TYPE } from '@lostgradient/operative';

import { goalAttemptRunId } from './goal-state';
import type { GoalEngine } from './goal-types';
import type { CatalogRunRecoveryLoad, CatalogRunRecoveryRecord } from './runtime-composition';
import type { CancelDurableRunOutcome } from './types';

/** An id a goal tried to use belongs to something that is not the goal. */
export class GoalOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalOwnershipError';
  }
}

/**
 * Ownership could not be decided because the record that decides it could not
 * be read. This is neither "foreign" nor "absent": it says nothing about who
 * holds the id, and the same read can succeed once the fault clears. Nothing is
 * adopted, replaced, started over, or cancelled on it, and callers retry.
 */
export class GoalOwnershipUnknownError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`Ownership of run "${runId}" could not be determined: its record could not be read.`, {
      cause,
    });
    this.name = 'GoalOwnershipUnknownError';
  }
}

/**
 * A recovery record is stored at the id but is not a valid record, so who holds
 * the run cannot be decided and never will be by reading again. It is not
 * absent, so nothing is adopted, replaced, started over, or cancelled; it is
 * not retried either. It surfaces as `corrupt-ownership-record` for an
 * operator to repair.
 */
export class GoalCorruptOwnershipRecordError extends GoalOwnershipError {
  constructor(runId: string) {
    super(
      `corrupt-ownership-record: the recovery record for run "${runId}" exists but is not valid, so its owner cannot be determined.`,
    );
    this.name = 'GoalCorruptOwnershipRecordError';
  }
}

export type RunRecordReader = (runId: string) => Promise<CatalogRunRecoveryLoad>;

export interface ExpectedAttemptOwner {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly agentName: string;
  readonly principal: string | undefined;
  /** The goal's attempt bound: no start mints an index at or past it. */
  readonly maximumAttempts: number;
}

/** Whether a run's recovery record is the goal's own for exactly this attempt. */
export function isOwnAttemptRecord(
  record: CatalogRunRecoveryRecord,
  expected: ExpectedAttemptOwner,
): boolean {
  return (
    record.goalAttempt?.goalRunId === expected.goalRunId &&
    record.goalAttempt.attemptIndex === expected.attemptIndex &&
    record.agentName === expected.agentName &&
    record.principal === expected.principal
  );
}

/**
 * The complete test for a run's recovery record, given the owner its goal's own
 * record names: the marker reproduces the run's id, and the record was written
 * for that marker's goal and attempt by that agent and principal. Everything
 * that decides whether a run is a goal's own (the owned engine and canceller,
 * the start port's verification and its adoption, the run's self-fence) asks
 * this, so no two of them can disagree about who holds an id.
 */
export function isGoalOwnedRunRecord(
  record: CatalogRunRecoveryRecord,
  runId: string,
  owner: GoalOwner,
): boolean {
  const marker = record.goalAttempt;
  if (marker === undefined) return false;
  // An index is a count of attempts opened, so a fraction, a negative, or a
  // non-finite value names no attempt a goal ever made, whatever id it renders.
  if (!Number.isSafeInteger(marker.attemptIndex) || marker.attemptIndex < 0) return false;
  if (goalAttemptRunId(marker.goalRunId, marker.attemptIndex) !== runId) return false;
  // The goal never opens an attempt at or past its bound, so a marker that
  // reproduces the id of such an index names a run no start of this goal made.
  if (!(marker.attemptIndex < owner.maximumAttempts)) return false;
  return isOwnAttemptRecord(record, {
    goalRunId: marker.goalRunId,
    attemptIndex: marker.attemptIndex,
    agentName: owner.agentName,
    principal: owner.principal,
    maximumAttempts: owner.maximumAttempts,
  });
}

export type AttemptRunOwnership =
  | { readonly status: 'owned' }
  /** Nothing holds the id: no claim and no workflow. */
  | { readonly status: 'absent' }
  | { readonly status: 'foreign'; readonly detail: string }
  /** A record is present but invalid; `detail` leads with `corrupt-ownership-record`. */
  | { readonly status: 'corrupt'; readonly detail: string };

/**
 * Who holds an attempt's deterministic run id. A claim with no workflow is the
 * goal's own start that died between the two; a workflow with no goal marker, or
 * one marked for a different goal, attempt, agent, or principal, is not.
 */
export async function verifyAttemptRun(
  dependencies: {
    readonly engine: Pick<GoalEngine, 'get'>;
    readonly readRunRecord: RunRecordReader;
  },
  expected: ExpectedAttemptOwner,
  runId: string,
): Promise<AttemptRunOwnership> {
  const load = await dependencies.readRunRecord(runId);
  if (load.status === 'read-error') throw new GoalOwnershipUnknownError(runId, load.error);
  if (load.status === 'corrupt') {
    return { status: 'corrupt', detail: new GoalCorruptOwnershipRecordError(runId).message };
  }
  if (load.status === 'found') {
    return isGoalOwnedRunRecord(load.record, runId, expected) &&
      load.record.goalAttempt?.goalRunId === expected.goalRunId &&
      load.record.goalAttempt.attemptIndex === expected.attemptIndex
      ? { status: 'owned' }
      : {
          status: 'foreign',
          detail: `run id "${runId}" is held by a run that was not started for this goal attempt`,
        };
  }
  return (await dependencies.engine.get(runId)) === null
    ? { status: 'absent' }
    : {
        status: 'foreign',
        detail: `run id "${runId}" is held by a run that was not started by a goal`,
      };
}

const CONTROLLER_PREFIX = 'goal:';
const ATTEMPT_RUN_PREFIX = 'goal-';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Whether a workflow stored at a controller id is the goal's own controller. */
export function isOwnController(
  state: { readonly type: string; readonly input: unknown },
  workflowId: string,
): boolean {
  return (
    state.type === GOAL_WORKFLOW_TYPE &&
    isRecord(state.input) &&
    state.input['goalRunId'] === workflowId.slice(CONTROLLER_PREFIX.length)
  );
}

/**
 * The agent and principal a goal runs its attempts as, which are what a run
 * must have been started with to be the goal's own. Read from the goal's record
 * by id, so a run's own marker cannot vouch for itself.
 */
export interface GoalOwner {
  readonly agentName: string;
  readonly principal: string | undefined;
  /** The goal's attempt bound; a run for an index at or past it is nobody's. */
  readonly maximumAttempts: number;
}

/**
 * Looks up the owner of the goal a run's marker names; `undefined` when no
 * readable goal has that id. A lookup that fails rejects, which is a fault to
 * retry and never a verdict.
 */
export type GoalOwnerResolver = (goalRunId: string) => Promise<GoalOwner | undefined>;

/**
 * The one test for whether a goal-namespaced run is a goal's own, shared by the
 * owned engine and the owned canceller so the two cannot disagree. A run's
 * record is the goal's when its marker reproduces the run's id and the goal the
 * marker names exists and is the one that started the run: the same goal id and
 * attempt index, and the same agent and principal ({@link isOwnAttemptRecord}).
 * An id that merely reproduces is not enough, since another agent or principal
 * can hold a goal's deterministic id.
 */
async function isOwnedGoalRun(
  load: CatalogRunRecoveryLoad,
  runId: string,
  resolveGoalOwner: GoalOwnerResolver,
): Promise<boolean> {
  if (load.status !== 'found') return false;
  const marker = load.record.goalAttempt;
  if (marker === undefined) return false;
  const owner = await resolveGoalOwner(marker.goalRunId);
  return owner !== undefined && isGoalOwnedRunRecord(load.record, runId, owner);
}

/**
 * The engine as a goal is allowed to see it. A workflow at a controller id that
 * is not the goal's controller, and a run at an attempt id that no goal marked
 * as its own, read as absent; acting on one throws {@link GoalOwnershipError},
 * and starting a controller over one (which `start-new` would otherwise
 * replace) is refused.
 */
export function createOwnedGoalEngine<E extends GoalEngine>(
  engine: E,
  readRunRecord: RunRecordReader,
  resolveGoalOwner: GoalOwnerResolver,
): E {
  const isController = (id: string): boolean => id.startsWith(CONTROLLER_PREFIX);
  const ownedController = async (id: string): Promise<boolean> => {
    const state = await engine.get(id);
    return state === null || isOwnController(state, id);
  };
  const refuse = (id: string): never => {
    throw new GoalOwnershipError(`Workflow "${id}" is not a goal controller for this goal.`);
  };

  const overrides: Record<string, (...args: never[]) => unknown> = {
    get: async (id: string) => {
      const state = await engine.get(id);
      if (state === null) return null;
      if (isController(id)) return isOwnController(state, id) ? state : null;
      if (id.startsWith(ATTEMPT_RUN_PREFIX)) {
        const load = await readRunRecord(id);
        // A record that cannot be read does not say the run is foreign or
        // absent; surface it so the caller retries instead of acting on a guess.
        if (load.status === 'read-error') throw new GoalOwnershipUnknownError(id, load.error);
        // Present but invalid: not absent, and not retryable.
        if (load.status === 'corrupt') throw new GoalCorruptOwnershipRecordError(id);
        return (await isOwnedGoalRun(load, id, resolveGoalOwner)) ? state : null;
      }
      return state;
    },
    start: async (...args: unknown[]) => {
      const options = args[2] as { readonly id?: string } | undefined;
      const id = options?.id;
      if (id !== undefined && isController(id) && !(await ownedController(id))) refuse(id);
      // With the engine as the receiver, stated rather than left to how a cast
      // call is emitted: Weft's `Engine` reads its internals through `this`.
      return Reflect.apply(engine.start as (...a: unknown[]) => unknown, engine, args);
    },
    getFinalizerStatus: async (id: string) =>
      isController(id) && !(await ownedController(id)) ? null : engine.getFinalizerStatus(id),
  };
  for (const method of ['signal', 'cancel', 'resume'] as const) {
    overrides[method] = async (id: string, ...rest: unknown[]) => {
      if (isController(id) && !(await ownedController(id))) refuse(id);
      return Reflect.apply(engine[method] as (...a: unknown[]) => unknown, engine, [id, ...rest]);
    };
  }

  return new Proxy(engine, {
    get(target, property) {
      if (typeof property === 'string' && property in overrides) return overrides[property];
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
}

/**
 * `cancelRun` that stops only a run a goal marked as its own. A run at the id
 * that is not the goal's is left alone and reported `not-found`, which is what
 * the goal's own view of the id says.
 */
export function createOwnedRunCanceller(
  cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>,
  readRunRecord: RunRecordReader,
  resolveGoalOwner: GoalOwnerResolver,
): (runId: string) => Promise<CancelDurableRunOutcome> {
  return async (runId) => {
    const load = await readRunRecord(runId);
    // Unknown is not foreign: report a retryable failure and cancel nothing.
    if (load.status === 'read-error') {
      return { status: 'failed', error: new GoalOwnershipUnknownError(runId, load.error) };
    }
    if (load.status === 'corrupt') {
      return { status: 'failed', error: new GoalCorruptOwnershipRecordError(runId) };
    }
    // A claim with no workflow is cancelled too: that is the goal's own start
    // that died, and cancelling a run that never existed is a no-op.
    let owned: boolean;
    try {
      owned = await isOwnedGoalRun(load, runId, resolveGoalOwner);
    } catch (error) {
      // The goal that decides ownership could not be read: unknown, not foreign.
      return { status: 'failed', error };
    }
    return owned ? cancelRun(runId) : { status: 'not-found' };
  };
}
