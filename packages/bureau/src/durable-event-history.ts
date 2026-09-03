/**
 * Durable event history — the restart-durable, owner-scoped read/write
 * surface over Weft's `FleetEventFeed` (AB-91's `ab91-01` slice, AB-310).
 *
 * Every durable event Bureau records is appended to ONE shared, fleet-wide
 * `FleetEventFeed` built over `engine.storage` (the same backend the
 * durable-run engine already persists to — no second durable log). A
 * run's or a session's own history is a FILTER over that global stream,
 * never a separate storage partition: `FleetEventFeed`'s sequence is
 * fleet-global, not owner-scoped (verified — `FleetEventFeed.append`/
 * `replay` carry no per-owner cursor namespace, only the optional
 * `workflowId` field on the input/envelope), so `page()` walks the global
 * replay stream and keeps only the events whose encoded owner matches.
 * Sequence gaps between consecutive returned events are legal and expected
 * — another owner's events occupy the skipped sequence numbers.
 *
 * Owner-scoping convention (binding on every later reader/writer of this
 * store, per the 2026-09-03 coordinator ruling): `FleetEventInput.workflowId`
 * is a single opaque string, so a `DurableEventOwner` is encoded into it as
 * `${owner.kind}:${owner.id}` for exact-string-match filtering in `page()`.
 * The returned `DurableEventEnvelope.owner` is not re-parsed out of that
 * string — both `record()` and `page()` already know the owner
 * authoritatively (the argument just appended, or the filter that just
 * selected the record) — so it is attached directly rather than decoded a
 * second time from the very string that was used to select the record. A
 * grep of `packages/bureau` for every existing `FleetEventFeed` writer and
 * every `appendWorkflowEventIfPresent` call, performed before this
 * convention was adopted, found NONE — this module is the first
 * `FleetEventFeed` writer/reader in the package, so there was no existing
 * convention to adopt instead.
 *
 * Producer wiring (AB-311's coordinator amendment, 2026-09-03):
 * `createDurableEventProducer` below sinks the run/session/schedule-fire
 * durability rows AB-87's matrix classifies as durable into `record()`, from
 * the same `bureau.addEventListener('action', ...)` path `createAuditTrail`
 * subscribes through (plus `schedule.completed`/`schedule.failed`, which
 * never traverse the `'action'` stream — see that function's own doc
 * comment for exactly why). `DurableEventOwnerKind` is `'run' | 'session'`
 * only; a schedule DEFINITION event (`schedule.created`/`paused`/`resumed`/
 * `cancelled`) has no run or session to own it and is not recorded here —
 * widening that union is an `@lostgradient/operative` (published-package)
 * change outside this slice's delivery boundary. A schedule FIRE is "an
 * ordinary run" per AB-87, so `schedule.completed`/`schedule.failed` are
 * recorded under the fired run's own `{ kind: 'run', id: runId }` owner.
 */
import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
} from '@lostgradient/operative/durable';
import type { Subscription } from '@lostgradient/operative/liveness';
import {
  createFleetEventFeed,
  type FleetEventEnvelope,
  type FleetEventFeed,
} from '@lostgradient/weft/server/handler';
import type { Storage } from '@lostgradient/weft/storage';
import type { RuntimeServices } from 'lifecycle';

import type { AgentDefinitions } from './agent-catalog';
import type { ActionEvent } from './events';
import { resolveDiagnosticSink, serializeActionDetail } from './serialization';
import type { Bureau, DiagnosticSink } from './types';

// ── Public surface ──────────────────────────────────────────────────

/** Options for {@link DurableEventHistory.page}. */
export interface DurableEventHistoryPageOptions {
  /** Exclusive cursor — an event AT `since` is never returned. Omit to page from the beginning. */
  since?: string;
  /** Maximum events to return. Defaults to {@link DEFAULT_PAGE_LIMIT}. Must be a positive integer. */
  limit?: number;
}

/** Options for {@link DurableEventHistory.subscribeEventHistory}. */
export interface DurableEventHistorySubscribeOptions {
  /** Exclusive cursor to replay from. Omit to replay from the beginning. */
  since?: string;
  /** Ends the subscription (equivalent to calling `unsubscribe()`) when aborted. */
  signal?: AbortSignal;
}

/**
 * The durable event history object returned by
 * {@link createDurableEventHistory}. Call `dispose()` to release the
 * underlying `FleetEventFeed` (its listener set and live-poll lifecycle
 * signal) — this is a per-STORE release, shared by every subscription this
 * instance ever created via {@link DurableEventHistory.subscribeEventHistory}
 * (AB-311); an individual subscription's own `unsubscribe()` releases only
 * that subscription's resources (its wake listener and poll timer), never
 * the shared feed.
 */
export interface DurableEventHistory {
  /**
   * Durably append one owner-scoped event. Delegates to
   * `FleetEventFeed.append`, stamping `owner` into the envelope's
   * `workflowId` via the `${owner.kind}:${owner.id}` convention.
   */
  record(owner: DurableEventOwner, kind: string, payload: unknown): Promise<DurableEventEnvelope>;
  /**
   * A bounded, sequence-ordered page of `owner`'s durable events after the
   * exclusive `since` cursor — or a {@link DurableEventGap} when `since`
   * predates the store's retention floor. See this module's top-of-file
   * doc comment for the owner-filtering algorithm.
   */
  page(
    owner: DurableEventOwner,
    options?: DurableEventHistoryPageOptions,
  ): Promise<DurableEventPage | DurableEventGap>;
  /**
   * Replays every durable event for `owner` strictly after `since`, then
   * transitions to live delivery with no gap and no duplicate at the
   * handoff (AB-311) — built entirely on `FleetEventFeed.subscribe()`,
   * Weft's own race-free replay-then-tail composition
   * (`createReplayLiveFeed`/`createDurableSubscription`,
   * `packages/weft/src/server/replay-live-feed-internals.ts`); this module
   * adds no sequencing of its own, only owner filtering (`filterEnvelope`)
   * and envelope decoding.
   *
   * Construction never starts work: a fresh, never-appended-to `owner`
   * replays zero events and then waits live with no error. A `since` older
   * than the store's retention floor is NOT reported as a
   * {@link DurableEventGap} the way `page()` reports one — unlike `page()`,
   * a live subscription cannot return a value to signal the gap, and
   * `FleetEventFeed.subscribe()`'s own retained-history replay already
   * skips silently past a compacted floor (yielding an internal
   * `fleet:gap` envelope with no `workflowId`, which this owner filter
   * necessarily excludes) — every event still within retention is still
   * delivered, in order; nothing beyond the floor is fabricated or
   * reported as missing.
   *
   * A listener that throws is isolated (reported to the diagnostic sink,
   * delivery continues); a corrupt stored record ends the subscription
   * (reported to the diagnostic sink, since `Subscription` has no error
   * channel) rather than throwing out of an event-loop callback.
   *
   * Disposing the returned `Subscription` (`unsubscribe()`, or aborting
   * `options.signal`) stops delivery to that listener only — a second,
   * independent subscription to the same owner is unaffected, and the
   * underlying `FleetEventFeed` is released only by
   * {@link DurableEventHistory.dispose}.
   */
  subscribeEventHistory(
    owner: DurableEventOwner,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
  /** Releases the underlying `FleetEventFeed`. Idempotent. */
  dispose(): Promise<void>;
}

/** Default `limit` for {@link DurableEventHistory.page} when the caller omits one. */
export const DEFAULT_PAGE_LIMIT = 100;

/**
 * The wrapper this store persists as a `FleetEventInput.payload` — carries
 * the caller's raw `payload` plus a schema version. Schema negotiation
 * itself (rejecting/migrating an unrecognized version) is AB-313's job
 * (`ab91-04`, conformance/versioning); this slice only stamps and reads
 * the field.
 */
interface StoredDurableEventPayload {
  readonly schemaVersion: number;
  readonly payload: unknown;
}

/** The only schema version this slice ever writes. */
const CURRENT_SCHEMA_VERSION = 1;

function encodeOwner(owner: DurableEventOwner): string {
  return `${owner.kind}:${owner.id}`;
}

function isStoredDurableEventPayload(value: unknown): value is StoredDurableEventPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    typeof value.schemaVersion === 'number' &&
    'payload' in value
  );
}

/**
 * Reconstructs a `DurableEventEnvelope` from the underlying
 * `FleetEventEnvelope` plus the `owner` this record was filtered/appended
 * under — `owner` is not re-parsed out of `envelope.workflowId`: both call
 * sites below (`record()`'s own just-appended owner, `page()`'s exact-
 * string-match owner filter) already know it authoritatively, so decoding
 * it a second time out of the very string that was just used to select
 * this record would be redundant. Throws if the payload isn't the
 * `{ schemaVersion, payload }` wrapper this module stamps — corrupt-record
 * TOLERANCE (skip-and-continue, or a typed error result) is AB-313's job;
 * this slice fails loudly on a shape it did not itself produce rather than
 * silently coercing or dropping it.
 */
function toDurableEventEnvelope(
  envelope: FleetEventEnvelope,
  owner: DurableEventOwner,
): DurableEventEnvelope {
  if (!isStoredDurableEventPayload(envelope.payload)) {
    throw new Error(
      `Durable event history: fleet event at sequence ${envelope.sequence} does not carry a recognized stored payload.`,
    );
  }
  return {
    kind: envelope.kind,
    owner,
    sequence: envelope.sequence,
    cursor: envelope.cursor,
    emittedAtMs: envelope.emittedAtMs,
    payload: envelope.payload.payload,
    schemaVersion: envelope.payload.schemaVersion,
  };
}

/**
 * Decodes a `since`/cursor string to its numeric sequence position for the
 * retention-floor comparison, mirroring Weft's own cursor format (an
 * unsigned decimal, or the `-1` sentinel for "before the first event") —
 * `@lostgradient/weft` does not export its `decodeCursor`/`encodeCursor`
 * codec publicly, so this is a narrow, LOCAL re-implementation used only
 * for this one comparison; the cursor value itself is always round-
 * tripped verbatim from `FleetEventEnvelope.cursor`, never re-encoded by
 * this function.
 */
const CURSOR_PATTERN = /^(?:-1|\d+)$/;

function decodeSincePosition(since: string | undefined): number {
  if (since === undefined) return -1;
  if (!CURSOR_PATTERN.test(since)) {
    throw new Error(`Durable event history: invalid cursor "${since}".`);
  }
  const position = Number(since);
  if (!Number.isSafeInteger(position) || position < -1) {
    throw new Error(`Durable event history: invalid cursor "${since}".`);
  }
  return position;
}

/**
 * Builds a `DurableEventHistory` over `storage` — typically
 * `runtime.durable.engine.storage`, the SAME backend the durable-run
 * engine already persists to (no second durable log). `runtime` supplies
 * `clock.now()` for each recorded event's `emittedAtMs`; every ordering
 * assertion this module's own tests make uses a manual clock, never a
 * real sleep.
 *
 * A three-argument factory with no `Bureau` handle: this module ships the
 * store, its owner-scoped read (`page`), write (`record`), and subscribe
 * (`subscribeEventHistory`) primitives; `createDurableEventProducer` below
 * is the separate, `Bureau`-aware piece that sinks bureau's action stream
 * into `record()` — kept as its own factory (rather than folded into this
 * one) because it needs a `Bureau` to subscribe to, which
 * `createDurableEventHistory(storage, runtime)`'s own two required
 * parameters deliberately do not carry (AB-310's ratified signature;
 * `create-bureau.ts` composes both together).
 */
export function createDurableEventHistory(
  storage: Storage,
  runtime: RuntimeServices,
  onDiagnostic?: DiagnosticSink,
): DurableEventHistory {
  const feed: FleetEventFeed = createFleetEventFeed(storage);
  const diagnose = resolveDiagnosticSink(onDiagnostic);

  async function record(
    owner: DurableEventOwner,
    kind: string,
    payload: unknown,
  ): Promise<DurableEventEnvelope> {
    const stored: StoredDurableEventPayload = { schemaVersion: CURRENT_SCHEMA_VERSION, payload };
    const appended = await feed.append({
      kind,
      workflowId: encodeOwner(owner),
      emittedAtMs: runtime.clock.now(),
      payload: stored,
    });
    return toDurableEventEnvelope(appended, owner);
  }

  async function page(
    owner: DurableEventOwner,
    options?: DurableEventHistoryPageOptions,
  ): Promise<DurableEventPage | DurableEventGap> {
    const limit = options?.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(
        `Durable event history: limit must be a positive integer, got ${limit}.`,
      );
    }
    const since = options?.since;
    const sincePosition = decodeSincePosition(since);

    const floor = await feed.snapshotRetentionFloor();
    if (sincePosition + 1 < floor) {
      return {
        outcome: 'gap',
        requestedCursor: since ?? '-1',
        firstRetainedSequence: floor,
      };
    }

    const targetWorkflowId = encodeOwner(owner);
    const events: DurableEventEnvelope[] = [];
    let hasMore = false;
    for await (const envelope of feed.replay(since === undefined ? {} : { fromCursor: since })) {
      if (envelope.workflowId !== targetWorkflowId) continue;
      if (events.length >= limit) {
        hasMore = true;
        break;
      }
      events.push(toDurableEventEnvelope(envelope, owner));
    }

    const lastEvent = events.at(-1);
    return {
      events,
      hasMore,
      ...(lastEvent !== undefined ? { nextCursor: lastEvent.cursor } : {}),
    };
  }

  function subscribeEventHistory(
    owner: DurableEventOwner,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription {
    const since = options?.since;
    // Validated synchronously, before any async work starts — matching
    // `FleetEventFeed.subscribe()`'s own synchronous cursor validation
    // (`createDurableSubscription` calls `decodeRequestedCursor` directly
    // in its function body, before returning the async generator). The
    // decoded position itself is unused here; `page()` is the only caller
    // that needs it for the retention-floor comparison.
    decodeSincePosition(since);

    const targetWorkflowId = encodeOwner(owner);
    const ownController = new AbortController();
    const combinedSignal = options?.signal
      ? AbortSignal.any([options.signal, ownController.signal])
      : ownController.signal;
    let closed = false;

    const subscription: Subscription = {
      unsubscribe() {
        if (closed) return;
        closed = true;
        ownController.abort();
      },
      get closed() {
        return closed;
      },
    };

    void deliver();

    async function deliver(): Promise<void> {
      try {
        for await (const envelope of feed.subscribe({
          fromCursor: since,
          signal: combinedSignal,
          filterEnvelope: (candidate) => candidate.workflowId === targetWorkflowId,
        })) {
          let mapped: DurableEventEnvelope;
          try {
            mapped = toDurableEventEnvelope(envelope, owner);
          } catch (error) {
            // A corrupt stored record. `Subscription` has no error channel
            // (AB-34/AB-88's `LivenessObservable` precedent this mirrors
            // has none either), so this ends the subscription rather than
            // throwing out of an internal event loop.
            diagnose({
              level: 'error',
              scope: 'durable-event-history',
              message: `[durable-event-history] Ending subscription for ${owner.kind}:${owner.id}: corrupt durable record.`,
              cause: error,
            });
            return;
          }
          try {
            listener(mapped);
          } catch (error) {
            // Isolate a throwing listener — one bad observer must not end
            // the subscription or affect any other subscriber (AB-88's
            // non-consuming-observation precedent).
            diagnose({
              level: 'error',
              scope: 'durable-event-history',
              message: `[durable-event-history] Listener threw for ${owner.kind}:${owner.id} event "${mapped.kind}":`,
              cause: error,
            });
          }
        }
      } catch (error) {
        // The iterable itself rejected (a storage failure, corrupt
        // watermark/tail record, etc.) — not a clean unsubscribe/abort,
        // which weft's own generator returns from normally rather than
        // throwing.
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[durable-event-history] Subscription for ${owner.kind}:${owner.id} ended with an error:`,
          cause: error,
        });
      } finally {
        closed = true;
      }
    }

    return subscription;
  }

  function dispose(): Promise<void> {
    feed.dispose();
    return Promise.resolve();
  }

  return { record, page, subscribeEventHistory, dispose };
}

// ── Producer wiring (AB-311) ────────────────────────────────────────

/** Options for {@link createDurableEventProducer}. */
export interface DurableEventProducerOptions {
  /**
   * Owner-issued signal (mirrors `AuditTrailOptions.signal`): once aborted,
   * the listener and any write already in flight refuse to START a new
   * one; `dispose()` still fully awaits every write that was already in
   * flight before the abort.
   */
  signal?: AbortSignal;
}

/**
 * The producer object returned by {@link createDurableEventProducer}. Call
 * `dispose()` to unsubscribe from the bureau's event streams and await
 * every in-flight `record()` write.
 */
export interface DurableEventProducer {
  /**
   * Stop listening to the bureau's event streams and await every write
   * already in flight before resolving. Never rejects. Idempotent.
   */
  dispose(): Promise<void>;
}

/** `run.*` action types AB-87's matrix classifies as durable/cursor-advancing for `AgentRun`. */
const RUN_DURABLE_ACTION_TYPES = new Set<string>([
  'run.completed',
  'run.error',
  'run.aborted',
  'run.tripwire',
]);

/**
 * `session.*` action types AB-87's matrix classifies as durable — the
 * lifecycle and reattachment facts (`session.deleted`'s own row calls the
 * pre-AB-311 state "durable only via the generic action stream, a gap";
 * this producer closes it). `session.cancel`/`sleep`/`signal`/`update`/
 * `query` (process-local per AB-39) and `session.monitor.tick`/`done`
 * (explicitly non-cursor-advancing) are deliberately excluded.
 */
const SESSION_DURABLE_ACTION_TYPES = new Set<string>([
  'session.created',
  'session.saved',
  'session.loaded',
  'session.deleted',
  'session.fork',
  'session.recover',
]);

/**
 * Narrows an action's `detail` to a `sessionId` string field — every
 * `session.*` event class in `@lostgradient/operative/events.ts` carries
 * one, but `Action.detail` is `unknown` by the time it reaches the bureau
 * action stream (`store.ts` copies the event's own enumerable properties
 * verbatim), so this is a runtime type guard, not a cast.
 */
function extractSessionId(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined;
  if (!('sessionId' in detail)) return undefined;
  const { sessionId } = detail;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * Sinks the run/session/schedule-fire families AB-87's matrix classifies as
 * durable into `history.record()` — closing the gap AB-310 left open (see
 * this module's top-of-file doc comment): AB-310 shipped `record()`/
 * `page()` with nothing calling `record()` in production, so the store was
 * empty until this producer existed.
 *
 * Two independent event sources, both required because `schedule.*`
 * lifecycle events never traverse the bureau's `'action'` stream —
 * `events.ts`'s own `BureauEventMap` doc comment: they are dispatched
 * directly onto the bureau-level emitter, not through a per-run
 * `CombinedOperativeEventMap` the way `run.*`/`session.*` action types are
 * (a schedule create/pause/resume/cancel/fire-outcome is a bureau-level
 * fact with no owning per-run surface):
 *
 * - `bureau.addEventListener('action', ...)` — the SAME path
 *   `createAuditTrail` subscribes through — for `run.*` (owner: the
 *   action's own `runId`) and `session.*` (owner: `detail.sessionId`,
 *   type-guarded; an action whose `detail` carries no string `sessionId`
 *   is dropped with a diagnostic rather than recorded under a fabricated
 *   owner).
 * - `bureau.addEventListener('schedule.completed'|'schedule.failed', ...)`
 *   — a scheduled fire's terminal outcome. AB-87: "Schedule fire: an
 *   ordinary run (same rows as AgentRun)" — so these are recorded under
 *   the fired run's own `{ kind: 'run', id: runId }` owner, not a
 *   `'schedule'` owner kind (which `DurableEventOwnerKind` does not have —
 *   see this module's top-of-file doc comment). `schedule.created`/
 *   `paused`/`resumed`/`cancelled` carry only a `scheduleId`, with no run
 *   or session to own them; they are not recorded by this slice.
 */
export function createDurableEventProducer<D extends AgentDefinitions = AgentDefinitions>(
  bureau: Bureau<D>,
  history: DurableEventHistory,
  runtime: RuntimeServices,
  onDiagnostic?: DiagnosticSink,
  producerOptions?: DurableEventProducerOptions,
): DurableEventProducer {
  const diagnose = resolveDiagnosticSink(onDiagnostic);
  const signal = producerOptions?.signal;

  // Every write kicked off by a listener below, so `dispose()` can await
  // terminal state deterministically (mirrors `createAuditTrail`'s own
  // `activeWrites`/`trackWrite` pattern) rather than leaving an in-flight
  // `record()` unobserved.
  const activeWrites = new Set<Promise<void>>();
  function sink(owner: DurableEventOwner, kind: string, payload: unknown): void {
    if (signal?.aborted) return;
    const write = history.record(owner, kind, payload).then(
      () => undefined,
      (error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[durable-event-history] Failed to record durable event "${kind}" for ${owner.kind}:${owner.id}:`,
          cause: error,
        });
      },
    );
    activeWrites.add(write);
    void write.finally(() => activeWrites.delete(write));
    runtime.deferred.track(write, 'durable-event-record');
  }

  const actionListener = (event: ActionEvent): void => {
    const { action } = event;
    if (signal?.aborted) return;

    if (RUN_DURABLE_ACTION_TYPES.has(action.type)) {
      sink(
        { kind: 'run', id: action.runId },
        action.type,
        serializeActionDetail(action.type, action.detail),
      );
      return;
    }

    if (SESSION_DURABLE_ACTION_TYPES.has(action.type)) {
      const sessionId = extractSessionId(action.detail);
      if (sessionId === undefined) {
        diagnose({
          level: 'warn',
          scope: 'durable-event-history',
          message: `[durable-event-history] Dropped "${action.type}" action for run "${action.runId}": no string sessionId on its detail.`,
        });
        return;
      }
      sink(
        { kind: 'session', id: sessionId },
        action.type,
        serializeActionDetail(action.type, action.detail),
      );
    }
  };
  bureau.addEventListener('action', actionListener);

  const scheduleCompletedListener = (event: {
    readonly scheduleId: string;
    readonly runId: string;
  }): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'schedule.completed', {
      scheduleId: event.scheduleId,
      runId: event.runId,
    });
  };
  const scheduleFailedListener = (event: {
    readonly scheduleId: string;
    readonly runId: string;
  }): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'schedule.failed', {
      scheduleId: event.scheduleId,
      runId: event.runId,
    });
  };
  bureau.addEventListener('schedule.completed', scheduleCompletedListener);
  bureau.addEventListener('schedule.failed', scheduleFailedListener);

  return {
    async dispose(): Promise<void> {
      bureau.removeEventListener('action', actionListener);
      bureau.removeEventListener('schedule.completed', scheduleCompletedListener);
      bureau.removeEventListener('schedule.failed', scheduleFailedListener);
      await Promise.allSettled([...activeWrites]);
    },
  };
}
