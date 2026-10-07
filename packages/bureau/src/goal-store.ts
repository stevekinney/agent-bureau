/**
 * COR-851 — the durable store for `GoalState`, over Bureau's conditional
 * key-value store.
 *
 * Every write is a revision compare-and-swap against the exact stored text,
 * modeled on `child-topology-store.ts`. A lost race never throws: it is
 * re-read and re-evaluated a bounded number of times, then reported as
 * `stale` carrying whatever is stored now.
 *
 * Two kinds of writer share a record, and the store keeps them apart:
 *
 * - The goal controller commits state-machine transitions through
 *   {@link GoalStore.applyTransition}. Each carries the `transitionSeq` it
 *   produces and a `transitionId`. The store applies it only when the record
 *   is exactly one transition behind (`seq - 1`), so a replayed or
 *   duplicated delivery of the transition that is already the record's
 *   current one is a `duplicate` (success, no write), and anything late,
 *   conflicting, out of order, or illegal under COR-638's transition table
 *   is `rejected` or `stale` with no mutation. The same commit appends the
 *   transition's audit entry to the record's append-only `auditLog` (see
 *   `GoalAuditEntry`), so no audit event depends on a later write surviving.
 *   Terminal statuses have no outgoing edges, so a late attempt completion can
 *   neither double count usage nor resurrect a finished goal. Only the CURRENT
 *   transition is provably idempotent: the log records audit events, not
 *   state, so a replay of an older transition answers `stale` with the
 *   authoritative record, which a controller adopts.
 * - The control plane writes the cancellation marker, the controller
 *   restart count (with its audit entry, in the same commit), `closedAt`, and `cleanedUpAt`. These advance `revision` but never
 *   `transitionSeq`, so they can interleave with a controller transition;
 *   the transition's CAS loop re-reads and re-evaluates. Once a
 *   cancellation marker is present the marker wins: the only transition the
 *   store then accepts is the one to `canceled`.
 *
 * Every read fails closed: a record that does not decode to its exact shape
 * is treated as absent and reported through `onCorrupt`.
 */

import {
  canTransitionGoalRun,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  TERMINAL_STATUS_BY_REASON,
} from '@lostgradient/operative';
import type { ConditionalTextValueStore } from '@lostgradient/weft';

import {
  auditEventForRestart,
  auditEventsForTransition,
  restartEntryId,
} from './goal-event-projection';
import {
  type ActiveGoalWork,
  decodeGoalState,
  type DurableGoalAttempt,
  type DurableGoalUsage,
  GOAL_AUDIT_LOG_MAXIMUM_ENTRIES,
  GOAL_RECORD_KEY_PREFIX,
  GOAL_VALIDATION_MAXIMUM_BYTES,
  goalAttemptId,
  type GoalAuditEntry,
  type GoalCancellationMarker,
  goalRecordKey,
  type GoalState,
  InvalidGoalStateError,
  isGoalState,
  isTerminalGoalStatus as isTerminal,
  validationByteLength,
} from './goal-state';

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/** One controller state-machine transition. */
export interface GoalTransitionRequest {
  readonly goalRunId: string;
  /** The `transitionSeq` this commit produces; the record must be at `seq - 1`. */
  readonly seq: number;
  /** Stable across replays; see `goalTransitionId`. */
  readonly transitionId: string;
  readonly to: GoalRunStatus;
  /** ISO-8601, from Bureau's runtime clock. */
  readonly at: string;
  readonly cause: string;
  /** Required exactly when `to` is terminal, and must map to `to` in COR-638's table. */
  readonly terminalReason?: GoalRunTerminalReason | undefined;
  readonly failureDetail?: string | undefined;
  /**
   * Inserts the attempt at `attempts.length` or replaces the one at its own
   * index. A replacement may not change a validation decision already
   * recorded: the first committed decision wins.
   */
  readonly attempt?: DurableGoalAttempt | undefined;
  /** The new aggregate. Omitted keeps the stored one. */
  readonly usage?: DurableGoalUsage | undefined;
  /** What is in flight after this transition. `null` clears; omitted keeps. */
  readonly active?: ActiveGoalWork | null | undefined;
}

export type GoalTransitionRejection =
  /** The record is already terminal. */
  | 'terminal'
  | 'illegal-transition'
  /** A cancellation marker is present, so only the transition to `canceled` is accepted. */
  | 'cancellation-requested'
  | 'invalid-terminal-reason'
  | 'invalid-attempt'
  /** The attempt's first committed validation decision cannot be replaced. */
  | 'decision-already-recorded'
  | 'oversized'
  /** The write would produce a record that does not decode. */
  | 'invalid-record';

export type GoalTransitionResult =
  | { readonly status: 'applied'; readonly record: GoalState }
  /** The record's current transition is this one: success, no write. */
  | { readonly status: 'duplicate'; readonly record: GoalState }
  /** Late, out of order, or conflicting: carries the authoritative record. */
  | { readonly status: 'stale'; readonly record: GoalState }
  | {
      readonly status: 'rejected';
      readonly reason: GoalTransitionRejection;
      readonly record: GoalState;
    }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' };

export type GoalCreation =
  | { readonly status: 'created'; readonly record: GoalState }
  /** `existing` is absent when the record already stored there is unreadable. */
  | { readonly status: 'duplicate'; readonly existing?: GoalState };

export type GoalControlRejection =
  | 'terminal'
  | 'not-terminal'
  /** Cleanup is recorded only for a goal that was closed. */
  | 'not-closed'
  /** The audit log is at its cap; a restart cannot be counted without dropping an entry. */
  | 'audit-log-full'
  /** A cancellation is recorded: the goal is ending, so a controller is not restarted for it. */
  | 'cancellation-requested';

export type GoalControlResult =
  | { readonly status: 'updated'; readonly record: GoalState }
  /** The record already says what the call asked for. */
  | { readonly status: 'unchanged'; readonly record: GoalState }
  | {
      readonly status: 'rejected';
      readonly reason: GoalControlRejection;
      readonly record: GoalState;
    }
  /** Lost the compare-and-swap too many times in a row; carries what is stored now. */
  | { readonly status: 'stale'; readonly record: GoalState }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' };

export interface GoalStore {
  /**
   * Create-if-absent. The record must be a fresh `pending` one (revision 1,
   * transition 0): throws `InvalidGoalStateError` otherwise.
   */
  create(state: GoalState): Promise<GoalCreation>;
  get(goalRunId: string): Promise<GoalState | undefined>;
  /** Every readable record. One that cannot be decoded is left out: see `listUnreadable`. */
  list(): Promise<GoalState[]>;
  /**
   * `list` and `listUnreadable` from one read of the store. The boot sweep uses
   * this: it runs while recovered runs are already executing, so a second pass
   * over the same keys is time those runs spend ahead of the boot that
   * recovered them.
   */
  scan(): Promise<GoalScan>;
  /**
   * The goal ids whose stored record exists but cannot be decoded. `get` and
   * `list` treat such a record as absent (they fail closed), so this is how a
   * caller tells a permanent fault from absence.
   */
  listUnreadable(): Promise<string[]>;
  /** Whether a record is stored under this id that cannot be decoded. */
  isUnreadable(goalRunId: string): Promise<boolean>;
  applyTransition(request: GoalTransitionRequest): Promise<GoalTransitionResult>;
  /** First marker wins; later requests are `unchanged`. A terminal goal is `rejected`. */
  requestCancellation(
    goalRunId: string,
    marker: GoalCancellationMarker,
    now: string,
  ): Promise<GoalControlResult>;
  /**
   * Increments `controllerRestarts`. A terminal goal is `rejected`. With
   * `expectedCount`, the increment is a compare-and-swap on the count: a record
   * already at another count is `stale`, so of several recoveries that observed
   * the same ended controller, exactly one is counted and may restart it.
   */
  recordControllerRestart(
    goalRunId: string,
    now: string,
    expectedCount?: number,
  ): Promise<GoalControlResult>;
  /** Sets `closedAt` once. A non-terminal goal is `rejected`. */
  close(goalRunId: string, at: string): Promise<GoalControlResult>;
  /**
   * Sets `cleanedUpAt` once, recording that a closed goal's checkpoint history
   * has been pruned. A goal that is not closed is `rejected` (`not-closed`).
   */
  markCleanedUp(goalRunId: string, at: string): Promise<GoalControlResult>;
}

/** What a write left behind, as the store's observer sees it. */
export type GoalStoreObservation =
  | { readonly kind: 'created'; readonly record: GoalState }
  /** Applied, or answered `duplicate`: either way `record` is the transition's post-state. */
  | { readonly kind: 'transitioned'; readonly record: GoalState }
  | { readonly kind: 'controller-restarted'; readonly record: GoalState };

export interface GoalStoreOptions {
  /** Called once per unreadable key encountered. Defaults to a no-op. */
  readonly onCorrupt?: ((key: string) => void) | undefined;
  /**
   * Awaited after a creation, an applied or duplicate transition, or a
   * controller restart, before the call returns. A `duplicate` is observed too,
   * so a controller that replays a commit whose first run died before this ran
   * gives the observer another chance. It must be idempotent and must not
   * throw: an error is routed to `onObserverError` and never changes the
   * result, because the record is the truth.
   */
  readonly observe?: ((observation: GoalStoreObservation) => Promise<void> | void) | undefined;
  /** Called with whatever `observe` threw. Defaults to a no-op. */
  readonly onObserverError?: ((error: unknown) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** What one read of every goal record found. */
export interface GoalScan {
  readonly records: GoalState[];
  readonly unreadable: string[];
}

/** A re-read-and-retry bound for compare-and-swap loss; past it a write reports `stale`. */
const MAXIMUM_CAS_ATTEMPTS = 16;

/**
 * Whether `value` can name a record: text that is well-formed, which is what
 * its percent encoding needs. The store's lookups take ids from callers the
 * type system does not reach (a JSON body, a script), so a number or a missing
 * id names no goal rather than throwing.
 */
function isKeyableGoalRunId(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed();
}

/** The goal id a record key was built from; the raw suffix when it does not decode. */
function decodeGoalRunIdFromKey(key: string): string {
  const encoded = key.slice(GOAL_RECORD_KEY_PREFIX.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

type Stored =
  | { readonly kind: 'found'; readonly raw: string; readonly record: GoalState }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' };

type Evaluation =
  | { readonly outcome: 'write'; readonly next: GoalState }
  | { readonly outcome: 'done'; readonly result: GoalTransitionResult | GoalControlResult };

export function createGoalStore(
  kv: ConditionalTextValueStore,
  options: GoalStoreOptions = {},
): GoalStore {
  const onCorrupt = options.onCorrupt ?? (() => {});
  const onObserverError = options.onObserverError ?? (() => {});

  async function notify(observation: GoalStoreObservation): Promise<void> {
    if (options.observe === undefined) return;
    try {
      await options.observe(observation);
    } catch (error) {
      onObserverError(error);
    }
  }

  async function read(key: string): Promise<Stored> {
    const raw = await kv.get(key);
    if (raw === null) return { kind: 'missing' };
    const record = decodeGoalState(raw);
    // A record is the goal named by its own id, and the key it is stored under
    // is that id's key. A valid record for another goal sitting under this key
    // is not this goal's, and returning it would let every read, and so every
    // write, act on the wrong goal: fail closed like any other corruption.
    if (record === undefined || goalRecordKey(record.goalRunId) !== key) {
      onCorrupt(key);
      return { kind: 'corrupt' };
    }
    return { kind: 'found', raw, record };
  }

  /**
   * Read, evaluate, and compare-and-swap, re-reading when another writer won.
   * `evaluate` is pure: it either decides the outcome without a write or
   * names the next record, which is stamped with `revision + 1`.
   */
  async function get(goalRunId: string): Promise<GoalState | undefined> {
    // An id that is not well-formed text cannot key a record (its percent
    // encoding throws), so it names no goal: absent, as every lookup answers.
    if (!isKeyableGoalRunId(goalRunId)) return undefined;
    const stored = await read(goalRecordKey(goalRunId));
    return stored.kind === 'found' ? stored.record : undefined;
  }

  async function scan(): Promise<GoalScan> {
    const keys = await kv.list(GOAL_RECORD_KEY_PREFIX);
    const stored = await Promise.all(keys.map(async (key) => ({ key, entry: await read(key) })));
    return {
      records: stored.flatMap(({ entry }) => (entry.kind === 'found' ? [entry.record] : [])),
      unreadable: stored
        .filter(({ entry }) => entry.kind === 'corrupt')
        .map(({ key }) => decodeGoalRunIdFromKey(key)),
    };
  }

  async function mutate<Result extends GoalTransitionResult | GoalControlResult>(
    goalRunId: string,
    evaluate: (current: GoalState) => Evaluation,
    stale: (current: GoalState) => Result,
    written: (record: GoalState) => Result,
  ): Promise<Result | { status: 'missing' } | { status: 'corrupt' }> {
    if (!isKeyableGoalRunId(goalRunId)) return { status: 'missing' };
    const key = goalRecordKey(goalRunId);
    let latest: GoalState | undefined;
    for (let attempt = 0; attempt < MAXIMUM_CAS_ATTEMPTS; attempt += 1) {
      const stored = await read(key);
      if (stored.kind !== 'found') return { status: stored.kind };
      latest = stored.record;
      const evaluation = evaluate(stored.record);
      if (evaluation.outcome === 'done') return evaluation.result as Result;
      const record: GoalState = { ...evaluation.next, revision: stored.record.revision + 1 };
      if (!isGoalState(record)) {
        // Unreachable for a request the evaluator accepted; fail closed rather than write it.
        throw new InvalidGoalStateError(`Bureau goal "${goalRunId}" produced an invalid record.`);
      }
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: stored.raw }],
        [{ type: 'set', key, value: JSON.stringify(record) }],
      );
      if (committed) return written(record);
    }
    return stale(latest as GoalState);
  }

  const reject = (record: GoalState, reason: GoalTransitionRejection): Evaluation => ({
    outcome: 'done',
    result: { status: 'rejected', reason, record },
  });

  function evaluateTransition(request: GoalTransitionRequest, current: GoalState): Evaluation {
    const done = (result: GoalTransitionResult): Evaluation => ({ outcome: 'done', result });
    const { currentTransition } = current;
    if (currentTransition.transitionId === request.transitionId) {
      // The same id at a different target is a conflicting writer, not a replay.
      return currentTransition.to === request.to && currentTransition.seq === request.seq
        ? done({ status: 'duplicate', record: current })
        : done({ status: 'stale', record: current });
    }
    if (current.transitionSeq !== request.seq - 1) {
      return done({ status: 'stale', record: current });
    }
    if (isTerminal(current.status)) return reject(current, 'terminal');
    if (current.auditLog.length >= GOAL_AUDIT_LOG_MAXIMUM_ENTRIES)
      return reject(current, 'oversized');
    if (current.cancellation !== undefined && request.to !== 'canceled') {
      return reject(current, 'cancellation-requested');
    }
    if (!canTransitionGoalRun(current.status, request.to)) {
      return reject(current, 'illegal-transition');
    }
    if (!hasValidTerminalReason(request)) return reject(current, 'invalid-terminal-reason');
    const attempts = applyAttempt(current, request);
    if (typeof attempts === 'string') return reject(current, attempts);
    const next = buildNext(current, request, attempts);
    return isGoalState(next) ? { outcome: 'write', next } : reject(current, 'invalid-record');
  }

  async function control(
    goalRunId: string,
    evaluate: (current: GoalState) => Evaluation,
  ): Promise<GoalControlResult> {
    return mutate<GoalControlResult>(
      goalRunId,
      evaluate,
      (record) => ({ status: 'stale', record }),
      (record) => ({ status: 'updated', record }),
    );
  }

  const unchanged = (record: GoalState): Evaluation => ({
    outcome: 'done',
    result: { status: 'unchanged', record },
  });

  const refuse = (record: GoalState, reason: GoalControlRejection): Evaluation => ({
    outcome: 'done',
    result: { status: 'rejected', reason, record },
  });

  return {
    async create(state) {
      if (!isGoalState(state)) {
        throw new InvalidGoalStateError('Bureau goal does not describe a valid goal record.');
      }
      if (state.revision !== 1 || state.transitionSeq !== 0 || state.status !== 'pending') {
        throw new InvalidGoalStateError(
          `Bureau goal "${state.goalRunId}" must be created pending at revision 1, transition 0.`,
        );
      }
      const key = goalRecordKey(state.goalRunId);
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: JSON.stringify(state) }],
      );
      if (committed) {
        await notify({ kind: 'created', record: state });
        return { status: 'created', record: state };
      }
      const existing = await get(state.goalRunId);
      return existing === undefined ? { status: 'duplicate' } : { status: 'duplicate', existing };
    },
    get,
    scan,
    async list() {
      const { records } = await scan();
      return records;
    },
    async listUnreadable() {
      const { unreadable } = await scan();
      return unreadable;
    },
    async isUnreadable(goalRunId) {
      if (!isKeyableGoalRunId(goalRunId)) return false;
      const stored = await read(goalRecordKey(goalRunId));
      return stored.kind === 'corrupt';
    },
    async applyTransition(request) {
      const result = await mutate<GoalTransitionResult>(
        request.goalRunId,
        (current) => evaluateTransition(request, current),
        (record) => ({ status: 'stale', record }),
        (record) => ({ status: 'applied', record }),
      );
      if (result.status === 'applied' || result.status === 'duplicate') {
        await notify({ kind: 'transitioned', record: result.record });
      }
      return result;
    },
    requestCancellation(goalRunId, marker, now) {
      return control(goalRunId, (current) => {
        if (current.cancellation !== undefined) return unchanged(current);
        if (isTerminal(current.status)) return refuse(current, 'terminal');
        return { outcome: 'write', next: { ...current, cancellation: marker, updatedAt: now } };
      });
    },
    async recordControllerRestart(goalRunId, now, expectedCount) {
      const result = await control(goalRunId, (current) =>
        isTerminal(current.status)
          ? refuse(current, 'terminal')
          : current.cancellation !== undefined
            ? refuse(current, 'cancellation-requested')
            : expectedCount !== undefined && current.controllerRestarts !== expectedCount
              ? { outcome: 'done', result: { status: 'stale', record: current } }
              : current.auditLog.length >= GOAL_AUDIT_LOG_MAXIMUM_ENTRIES
                ? refuse(current, 'audit-log-full')
                : { outcome: 'write', next: withRestart(current, now) },
      );
      if (result.status === 'updated') {
        await notify({ kind: 'controller-restarted', record: result.record });
      }
      return result;
    },
    close(goalRunId, at) {
      return control(goalRunId, (current) => {
        if (!isTerminal(current.status)) return refuse(current, 'not-terminal');
        if (current.closedAt !== undefined) return unchanged(current);
        return { outcome: 'write', next: { ...current, closedAt: at, updatedAt: at } };
      });
    },
    markCleanedUp(goalRunId, at) {
      return control(goalRunId, (current) => {
        if (current.closedAt === undefined) return refuse(current, 'not-closed');
        if (current.cleanedUpAt !== undefined) return unchanged(current);
        return { outcome: 'write', next: { ...current, cleanedUpAt: at, updatedAt: at } };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Transition evaluation helpers
// ---------------------------------------------------------------------------

function hasValidTerminalReason(request: GoalTransitionRequest): boolean {
  if (!isTerminal(request.to)) return request.terminalReason === undefined;
  return (
    request.terminalReason !== undefined &&
    TERMINAL_STATUS_BY_REASON[request.terminalReason] === request.to
  );
}

/** The attempts after applying the request's attempt patch, or the rejection that stops it. */
function applyAttempt(
  current: GoalState,
  request: GoalTransitionRequest,
): readonly DurableGoalAttempt[] | 'invalid-attempt' | 'decision-already-recorded' | 'oversized' {
  const patch = request.attempt;
  if (patch === undefined) return current.attempts;
  const index = patch.attemptIndex;
  if (
    index > current.attempts.length ||
    patch.attemptId !== goalAttemptId(current.goalRunId, index)
  ) {
    return 'invalid-attempt';
  }
  if (
    patch.validation !== undefined &&
    validationByteLength(patch.validation) > GOAL_VALIDATION_MAXIMUM_BYTES
  ) {
    return 'oversized';
  }
  const existing = current.attempts[index];
  const recorded = existing?.validation;
  if (recorded !== undefined && recorded.decisionId !== patch.validation?.decisionId) {
    return 'decision-already-recorded';
  }
  const attempts = [...current.attempts];
  attempts[index] = patch;
  return attempts;
}

/** The restart's post-state, with its audit entry appended in the same commit. */
function withRestart(current: GoalState, now: string): GoalState {
  const counted: GoalState = {
    ...current,
    controllerRestarts: current.controllerRestarts + 1,
    updatedAt: now,
  };
  const entry: GoalAuditEntry = {
    seq: counted.transitionSeq,
    transitionId: restartEntryId(counted),
    events: [auditEventForRestart(counted)],
  };
  return { ...counted, auditLog: [...current.auditLog, entry] };
}

function buildNext(
  current: GoalState,
  request: GoalTransitionRequest,
  attempts: readonly DurableGoalAttempt[],
): GoalState {
  const { active: _active, terminalReason: _reason, failureDetail: _detail, ...rest } = current;
  const active = request.active === undefined ? current.active : (request.active ?? undefined);
  const next: GoalState = {
    ...rest,
    transitionSeq: request.seq,
    status: request.to,
    currentTransition: {
      seq: request.seq,
      transitionId: request.transitionId,
      from: current.status,
      to: request.to,
      at: request.at,
      cause: request.cause,
    },
    attempts,
    usage: request.usage ?? current.usage,
    updatedAt: request.at,
    ...(request.terminalReason === undefined ? {} : { terminalReason: request.terminalReason }),
    ...(request.failureDetail === undefined ? {} : { failureDetail: request.failureDetail }),
    ...(active === undefined ? {} : { active }),
  };
  // The audit entry is derived from the post-transition record and committed
  // with it, so a transition and its audit events can never be separated.
  const entry: GoalAuditEntry = {
    seq: request.seq,
    transitionId: request.transitionId,
    events: auditEventsForTransition(next),
  };
  return { ...next, auditLog: [...current.auditLog, entry] };
}
