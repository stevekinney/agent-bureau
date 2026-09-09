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
 * Producer wiring (AB-311's coordinator amendment, 2026-09-03; widened by
 * AB-320, 2026-09-03): `createDurableEventProducer` below sinks the
 * run/session/schedule-fire durability rows AB-87's matrix classifies as
 * durable into `record()`, from the same `bureau.addEventListener('action',
 * ...)` path `createAuditTrail` subscribes through (plus
 * `schedule.completed`/`schedule.failed`, which never traverse the
 * `'action'` stream — see that function's own doc comment for exactly why).
 * `DurableEventOwnerKind` is now `'run' | 'session' | 'schedule'`
 * (`@lostgradient/operative`, AB-320): a schedule's four DEFINITION events
 * (`schedule.created`/`paused`/`resumed`/`cancelled`, AB-298/AB-223) are
 * recorded under `{ kind: 'schedule', id: scheduleId }`, from their own
 * bureau-level listeners (they too never traverse the `'action'` stream —
 * see `BureauEventMap`'s own doc comment). A schedule FIRE is "an ordinary
 * run" per AB-87, so `schedule.completed`/`schedule.failed` stay recorded
 * under the fired run's own `{ kind: 'run', id: runId }` owner — never
 * under `'schedule'`, so a schedule's own durable page never carries a fire.
 *
 * Widened again by AB-224, 2026-09-04: the seven `review.*` lifecycle
 * events (`approved`/`denied`/`rejected`/`expired`/`revoked`/`canceled`/
 * `superseded`, AB-87/AB-46's `ReviewStatus` vocabulary minus the
 * no-event `'pending'` resting state) are a fourth bureau-level-emitter
 * source, same reasoning as `schedule.*` — dispatched directly by
 * `create-bureau.ts`'s `recordReviewDecision`/`recordReviewStatusTransition`,
 * never through `'action'`. Every review belongs to a run, so all seven are
 * recorded under the fired review's own `{ kind: 'run', id: runId }` owner —
 * never a distinct `'review'` owner kind, which `DurableEventOwnerKind` does
 * not define.
 *
 * Widened again by AB-372, 2026-09-08: a fifth bureau-level-emitter source,
 * `SessionDeletedEvent` — `deleteSession` (`create-bureau.ts`) dispatches it
 * directly onto the bureau-level emitter, never through `'action'` (a
 * deleted session may own zero live runs, so there is nothing for
 * `store.recordAction` to attach it to). Before this widening,
 * `SESSION_DURABLE_ACTION_TYPES` below listed `'session.deleted'` as a
 * durable action type, but nothing ever dispatched it onto the `'action'`
 * stream this producer's `actionListener` reads — the entry described what
 * a producer WOULD forward if something dispatched it that way, not
 * anything that actually happened (AB-228/AB-313 both documented this exact
 * gap; see `audit-trail.ts`'s own `AUDIT_EVENT_TYPES` doc comment). The
 * dedicated `sessionDeletedListener` below closes it, writing the same
 * `{ kind: 'session', id: sessionId }`-owned `'session.deleted'` record
 * `Bureau.eventHistory`'s deleted-aggregate detection (AB-313,
 * `resolveEventHistory` in `create-bureau.ts`) already knows how to read —
 * previously exercised only by that detection's own synthetic tests
 * (`Store.recordAction`/`bureau.store.recordAction`), never by a real
 * deletion. De-duplicated on a duplicate dispatch of the same event via a
 * per-owner IN-FLIGHT map, never a read of the owner's own durable history
 * — see the listener's own doc comment for why a durable-history scan
 * cannot tell a duplicate dispatch apart from a session id's legitimate
 * later reuse, and exactly which duplicate-dispatch case the in-flight map
 * does and does not cover.
 */
import type {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  SessionDeletedEvent,
} from '@lostgradient/operative';
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
import type {
  ActionEvent,
  ReviewApprovedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
  RunRemovedEvent,
} from './events';
import { resolveDiagnosticSink, serializeActionDetail } from './serialization';
import type { Bureau, DiagnosticSink } from './types';

// ── Public surface ──────────────────────────────────────────────────

/** Options for {@link DurableEventHistory.page}. */
export interface DurableEventHistoryPageOptions {
  /** Exclusive cursor — an event AT `since` is never returned. Omit to page from the beginning. */
  since?: string;
  /** Maximum events to return. Defaults to {@link DEFAULT_PAGE_LIMIT}. Must be a positive integer. */
  limit?: number;
  /**
   * AB-313 — the authenticated caller's principal, consulted by
   * `Bureau.eventHistory`'s authorization and deleted-aggregate checks
   * (see that method's own doc comment). `page()` itself (this store's
   * lower-level primitive) does not read or use this field at all — it is
   * carried here purely so `Bureau.eventHistory` can accept one options
   * bag for both the store's own paging options and its own
   * authorization concern, rather than a second parameter.
   */
  principal?: string;
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
  /**
   * Snapshots the `run`-owner ids that still have at least one durable
   * event at or above the feed's CURRENT retention floor — the primitive
   * `Bureau.runDurableMaintenance` uses to prune a session's
   * `lastRunOwningPrincipals` entries once a run's entire durable history
   * has been compacted away (AB-363's coordinator ruling). A single full
   * replay of the currently-retained window, not one `page()` call per
   * candidate run: `feed.replay()` with no cursor already walks exactly
   * the retained records once (Weft's own `retain()` pays the same cost),
   * so this collects every survivor's owner in one pass rather than
   * re-scanning the feed once per run.
   *
   * Returns `undefined` when the floor is still 0 — nothing has been
   * retired yet, so nothing can be "entirely below" it, and an
   * empty-so-far history is still fully pageable (an empty page, never a
   * gap); reporting a real (possibly empty) set at floor 0 would
   * indistinguishably read as "prune everything," which is wrong.
   * `retain()` never runs on its own — nothing in this codebase calls it
   * yet — so in practice this returns `undefined` until an operator or a
   * future retention driver advances the floor.
   */
  retainedRunOwnerIds(): Promise<Set<string> | undefined>;
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

/**
 * Thrown when a stored durable event record carries a `schemaVersion` this
 * build does not recognize (AB-313, mirroring
 * `UnsupportedRunResultVersionError` — `packages/operative/src/run-envelope.ts`).
 * A record fails closed per record: `toDurableEventEnvelope` throws this for
 * exactly the one offending record, and every caller that decodes more than
 * one record ({@link DurableEventHistory.page}) catches it, reports it to
 * the {@link DiagnosticSink}, and skips only that record — it never aborts
 * or corrupts the read of the rest of the page. Exported so a caller
 * decoding a single envelope directly can distinguish this from the
 * unrelated "not the stored-wrapper shape at all" corrupt-record case.
 */
export class UnsupportedDurableEventSchemaVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(
      `Unsupported durable event schema version ${String(version)}; expected ${CURRENT_SCHEMA_VERSION}`,
    );
    this.name = 'UnsupportedDurableEventSchemaVersionError';
    this.version = version;
  }
}

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
  if (envelope.payload.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedDurableEventSchemaVersionError(envelope.payload.schemaVersion);
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
      // AB-313 (AC2): decode BEFORE checking `limit` — a corrupt record
      // (unparseable payload, or a recognized-shape record carrying a
      // `schemaVersion` this build does not know) is skipped with a
      // diagnostic and never consumes a `limit` slot, but it must not be
      // allowed to set `hasMore: true` either: checking `events.length >=
      // limit` before decode would report an additional page for a
      // candidate that turns out to be corrupt-and-skipped, when the next
      // page could in fact be empty (Copilot review, PR #551). Decoding
      // first means `hasMore` only ever reflects a genuine, valid
      // additional record.
      let decoded: DurableEventEnvelope;
      try {
        decoded = toDurableEventEnvelope(envelope, owner);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[durable-event-history] Skipped corrupt durable record at sequence ${envelope.sequence} for ${owner.kind}:${owner.id}:`,
          cause: error,
        });
        continue;
      }
      if (events.length >= limit) {
        hasMore = true;
        break;
      }
      events.push(decoded);
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

  async function retainedRunOwnerIds(): Promise<Set<string> | undefined> {
    const floor = await feed.snapshotRetentionFloor();
    if (floor === 0) return undefined;

    const owners = new Set<string>();
    // No `since`/`fromCursor`: this walks every record the feed currently
    // retains, exactly once. A record at or before the floor never
    // appears here (weft's own `retain()` already deleted it) — we don't
    // decode the stored payload at all (unlike `page()`), since only the
    // envelope's `workflowId` is needed and a corrupt/unrecognized
    // `schemaVersion` on some OTHER owner's record must never stop this
    // scan.
    for await (const envelope of feed.replay()) {
      const workflowId = envelope.workflowId;
      if (workflowId === undefined) continue; // e.g. the internal `fleet:gap` marker
      const separator = workflowId.indexOf(':');
      if (separator < 0) continue;
      const ownerKind = workflowId.slice(0, separator);
      if (ownerKind !== 'run') continue;
      owners.add(workflowId.slice(separator + 1));
    }
    return owners;
  }

  function dispose(): Promise<void> {
    feed.dispose();
    return Promise.resolve();
  }

  return { record, page, subscribeEventHistory, retainedRunOwnerIds, dispose };
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
   * Whether a `history.record()` write for `owner` is currently in flight
   * — started (synchronously, at the same moment this producer's listener
   * observed the source action/bureau event) but not yet settled.
   *
   * AB-363's `pruneStaleRunOwnership` uses this, alongside the SESSION's
   * own `lastRequestAuthorities` presence, to close the race a run's own
   * terminal transition can open: this producer's `sink()` increments the
   * owner's count BEFORE starting `history.record()`, which itself starts
   * only once the source action (e.g. the bureau-level `'action'` event
   * carrying `run.completed`) has already been dispatched — and that
   * action's dispatch happens no later than the SAME completion sequence
   * that removes the run's `lastRequestAuthorities` entry (Codex review,
   * PR #568: "Preserve ownership until pending event writes have
   * settled"). So either `lastRequestAuthorities` still names the run
   * (live, or a pending approval awaiting a future `review.*` event —
   * both excluded on their own) or, once it doesn't, this method is the
   * one remaining signal for "a write this transition started has not
   * yet committed" — checking it is a non-destructive peek at a live
   * count, unlike `RuntimeServices.deferred.drain()` (destructive, and
   * shared with other consumers — never call it from here).
   */
  hasActiveWrite(owner: DurableEventOwner): boolean;
  /**
   * Await every `owner`-scoped write currently in flight at the moment
   * this is called — never rejects (an individual write's own failure is
   * diagnosed by its own listener, not surfaced here), and never waits on
   * a write that starts AFTER this call (a snapshot, not an open-ended
   * subscription). AB-372 (Codex review finding, PR #580, "Wait for the
   * deletion projection before serving history"): `Bureau.eventHistory`
   * calls this before reading, so a caller that awaits `deleteSession`/
   * `deleteRun` and immediately calls `eventHistory` for the same owner
   * observes the deletion this producer's own listener is still writing,
   * rather than racing an ordinary page ahead of it — mirroring
   * `AuditTrail.query()`'s own `activeWritesByRunId`-based read-your-writes
   * fix (AB-228, PR #566, "Wait for schedule audit writes before returning
   * success").
   */
  waitForActiveWrites(owner: DurableEventOwner): Promise<void>;
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
 * Public alias of {@link RUN_DURABLE_ACTION_TYPES} (AB-312). The gateway's
 * SSE/WebSocket durable-history reconnect fallback (`live-events.ts`) must
 * suppress its own ORDINARY live broadcast of one of these action kinds for
 * a run currently in durable-fallback mode — that run's own durable
 * subscription (`Bureau.subscribeEventHistory`) already owns delivering it
 * exactly once, and forwarding it a second time through the live path
 * would double-deliver the same terminal fact. Exported here, rather than
 * re-declared as a second literal list in `packages/gateway`, so the two
 * packages can never drift out of sync on which kinds this applies to.
 *
 * A DEFENSIVE COPY, never the same `Set` instance as
 * {@link RUN_DURABLE_ACTION_TYPES} — a `Set` is mutable at runtime
 * regardless of its `ReadonlySet` type, so exporting the internal instance
 * directly would let a downstream mutation (accidental or otherwise) also
 * corrupt this module's own `createDurableEventProducer` classification
 * (copilot review, PR #505).
 */
export const RUN_DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set(RUN_DURABLE_ACTION_TYPES);

/**
 * `session.*` action types AB-87's matrix classifies as durable — the
 * lifecycle and reattachment facts. `session.deleted` is listed here for
 * completeness (an `'action'`-stream dispatch of that type, if one ever
 * existed, would be forwarded the same way every other entry is), but no
 * production code dispatches `'session.deleted'` onto the `'action'` stream
 * — `deleteSession` dispatches a real `SessionDeletedEvent` directly onto
 * the bureau-level emitter instead, handled by the dedicated
 * `sessionDeletedListener` below (AB-372), not by this set.
 * `session.cancel`/`sleep`/`signal`/`update`/`query` (process-local per
 * AB-39) and `session.monitor.tick`/`done` (explicitly non-cursor-advancing)
 * are deliberately excluded.
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
 * Four independent event sources, all required because `schedule.*` and
 * `review.*` lifecycle events never traverse the bureau's `'action'`
 * stream — `events.ts`'s own `BureauEventMap` doc comment: they are
 * dispatched directly onto the bureau-level emitter, not through a per-run
 * `CombinedOperativeEventMap` the way `run.*`/`session.*` action types are
 * (a schedule create/pause/resume/cancel/fire-outcome, or a review
 * decision/expiry/revocation/cancellation/supersession, is a bureau-level
 * fact recorded from `create-bureau.ts` directly rather than surfaced by
 * an in-progress run's own event stream):
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
 *   the fired run's own `{ kind: 'run', id: runId }` owner, never under
 *   `'schedule'`.
 * - `bureau.addEventListener('schedule.created'|'paused'|'resumed'|
 *   'cancelled', ...)` (AB-320) — a schedule's DEFINITION lifecycle,
 *   recorded exactly once each under `{ kind: 'schedule', id: scheduleId }`
 *   — the owner kind AB-310 originally shipped without (see this module's
 *   top-of-file doc comment). `schedule.completed`/`failed` never reach
 *   this owner: a schedule's own durable page carries its four definition
 *   events only, never a fire.
 * - `bureau.addEventListener('review.approved'|'denied'|'rejected'|
 *   'expired'|'revoked'|'canceled'|'superseded', ...)` (AB-224) — the
 *   review lifecycle family, all seven recorded under the fired review's
 *   own `{ kind: 'run', id: runId }` owner with a minimal, privileged
 *   payload (`reviewId`/`runId`/`principal`/`kind`) — see this module's
 *   top-of-file doc comment.
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
  // AB-363 — per-owner in-flight write counts, checked by
  // `hasActiveWrite()` below. Keyed by the SAME `encodeOwner` string
  // `record()`/`page()` use, incremented synchronously BEFORE
  // `history.record()` starts (so a caller that checks `hasActiveWrite`
  // anywhere after this action's dispatch already sees it — see that
  // method's own doc comment for why this closes the pruning race) and
  // decremented in the same `.finally` that already prunes `activeWrites`.
  const activeWriteCountsByOwner = new Map<string, number>();
  // AB-372 — the SAME writes `activeWriteCountsByOwner` counts, also kept
  // as a per-owner Set of the actual promises (not just a count) so
  // `waitForActiveWrites()` can await exactly the writes in flight for one
  // owner at the moment it is called, mirroring `AuditTrail`'s own
  // `activeWritesByRunId` (AB-228, PR #566).
  const activeWritesByOwner = new Map<string, Set<Promise<void>>>();

  // AB-372 — extracted out of `sink()` below so `sessionDeletedListener`'s
  // conditional write (which does not call `sink()` directly, since it
  // needs to skip the write entirely on a duplicate in-flight dispatch)
  // still participates in the SAME `activeWrites`/`activeWriteCountsByOwner`/
  // `activeWritesByOwner` bookkeeping every other listener's write does
  // (Copilot review finding, PR #580).
  function trackWrite(ownerKey: string, work: () => Promise<void>): void {
    activeWriteCountsByOwner.set(ownerKey, (activeWriteCountsByOwner.get(ownerKey) ?? 0) + 1);
    const write = work();
    activeWrites.add(write);
    let ownerWrites = activeWritesByOwner.get(ownerKey);
    if (!ownerWrites) {
      ownerWrites = new Set();
      activeWritesByOwner.set(ownerKey, ownerWrites);
    }
    ownerWrites.add(write);
    void write.finally(() => {
      activeWrites.delete(write);
      ownerWrites.delete(write);
      if (ownerWrites.size === 0) activeWritesByOwner.delete(ownerKey);
      const remaining = (activeWriteCountsByOwner.get(ownerKey) ?? 1) - 1;
      if (remaining > 0) {
        activeWriteCountsByOwner.set(ownerKey, remaining);
      } else {
        activeWriteCountsByOwner.delete(ownerKey);
      }
    });
    runtime.deferred.track(write, 'durable-event-record');
  }

  function sink(owner: DurableEventOwner, kind: string, payload: unknown): void {
    if (signal?.aborted) return;
    trackWrite(encodeOwner(owner), () =>
      history.record(owner, kind, payload).then(
        () => undefined,
        (error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message: `[durable-event-history] Failed to record durable event "${kind}" for ${owner.kind}:${owner.id}:`,
            cause: error,
          });
        },
      ),
    );
  }

  // AB-372 — the session.deleted in-flight de-duplication map, declared
  // here so it is visible to `sessionDeletedListener` below. An earlier
  // round of this change also cleared it from an `action.type ===
  // 'session.created'` branch in `actionListener` below, intending to
  // close the overlapping-incarnations edge case described on
  // `sessionDeletedListener`'s own doc comment. That branch was DEAD CODE
  // in production (Codex review finding, PR #580, "Clear the guard from
  // the actual session creation path"): a repo-wide search
  // (`grep -rn "new SessionCreatedEvent("`) finds `SessionCreatedEvent`
  // defined and type-mapped in `@lostgradient/operative` but constructed
  // NOWHERE — no production code path ever dispatches a `'session.created'`
  // action onto the bureau's `'action'` stream, so the clearing branch
  // could only ever fire from a test that synthesized the action directly.
  // Removed rather than left in as harmless-looking dead code; see
  // `sessionDeletedListener`'s own doc comment for the resulting known,
  // accepted limitation.
  const pendingSessionDeletionWrites = new Map<string, Promise<void>>();

  // AB-372 (Codex review findings, PR #580, "Remember handled deletion
  // events after writes settle" / "Deduplicate a SessionDeletedEvent after
  // its write settles"): the in-flight map above only de-dupes a duplicate
  // dispatch that arrives WHILE the first write is still pending — once
  // that write settles, its entry is removed, so the SAME event OBJECT
  // dispatched again afterward (a literal replay, as opposed to a genuinely
  // later, distinct deletion) would be treated as new and write a second
  // record. That is a real gap against this issue's own acceptance
  // criterion, phrased in terms of "the same `SessionDeletedEvent`," not
  // "the same owner." A `WeakSet` keyed on event OBJECT IDENTITY closes it
  // without reintroducing the read-then-write idempotency check already
  // rejected above: two DIFFERENT `SessionDeletedEvent` instances for the
  // same session id (the reused-id case) are never confused with each
  // other, however this map's per-object membership persists indefinitely
  // (no session id cardinality bound applies — a `WeakSet` holds no strong
  // reference, so an event object is only ever retained by whatever else in
  // the process is still holding it, typically nothing once dispatch
  // finishes).
  const recordedDeletionEvents = new WeakSet<SessionDeletedEvent>();

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

  // Schedule DEFINITION lifecycle (AB-320) — recorded under
  // `{ kind: 'schedule', id: scheduleId }`, never under `'run'`/`'session'`.
  const scheduleCreatedListener = (event: AgentScheduledEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'schedule', id: event.scheduleId }, 'schedule.created', {
      scheduleId: event.scheduleId,
      agentName: event.agentName,
      spec: event.spec,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    });
  };
  const schedulePausedListener = (event: SchedulePausedEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'schedule', id: event.scheduleId }, 'schedule.paused', {
      scheduleId: event.scheduleId,
    });
  };
  const scheduleResumedListener = (event: ScheduleResumedEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'schedule', id: event.scheduleId }, 'schedule.resumed', {
      scheduleId: event.scheduleId,
    });
  };
  const scheduleCancelledListener = (event: ScheduleCancelledEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'schedule', id: event.scheduleId }, 'schedule.cancelled', {
      scheduleId: event.scheduleId,
    });
  };
  bureau.addEventListener('schedule.created', scheduleCreatedListener);
  bureau.addEventListener('schedule.paused', schedulePausedListener);
  bureau.addEventListener('schedule.resumed', scheduleResumedListener);
  bureau.addEventListener('schedule.cancelled', scheduleCancelledListener);

  // AB-313 — a run's explicit removal (`Bureau.deleteRun`) is the
  // "Bureau-level record was removed" evidence `bureau.eventHistory`'s
  // deleted-aggregate detection looks for inside a run's own durable page.
  // Recorded under the removed run's own `{ kind: 'run', id: runId }`
  // owner, same as every other run-durable kind — never as a distinct
  // owner, since the run itself is what was removed.
  const runRemovedListener = (event: RunRemovedEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'run.removed', { runId: event.runId });
  };
  bureau.addEventListener('run.removed', runRemovedListener);

  // AB-372 — `deleteSession` dispatches `SessionDeletedEvent` directly onto
  // the bureau-level emitter (never through `'action'`; see this module's
  // top-of-file doc comment), so it needs its own listener the same way
  // `run.removed` above does. Recorded under the deleted session's own
  // `{ kind: 'session', id: sessionId }` owner — the SAME owner and kind
  // `Bureau.eventHistory`'s deleted-aggregate detection (`create-bureau.ts`'s
  // `resolveEventHistory`) already reads.
  //
  // De-duplication on a duplicate dispatch is done via an IN-FLIGHT map,
  // never a read of the owner's own durable history (Codex review findings,
  // PR #580, on an earlier round of this change that scanned `history.page()`
  // before writing):
  //
  // - A read-then-write check against durable history cannot tell "the
  //   SAME underlying deletion, re-dispatched" apart from "a DIFFERENT,
  //   LATER deletion of a session id that was legitimately recreated after
  //   its first incarnation was deleted" (proved by
  //   `create-bureau.test.ts`'s own "does not coalesce a deleteSession call
  //   for a session RECREATED with the same id" test) — a stale historical
  //   marker would silently swallow the second incarnation's real deletion
  //   fact forever.
  // - It is also unbounded work: `page()`'s default limit means a session
  //   with 100+ prior durable events would miss its own marker on a later
  //   page, and every deletion would replay the fleet-global feed looking
  //   for it regardless.
  // - It cannot be made atomic across processes anyway (two page() reads
  //   can both complete before either append()s), so it was buying, at
  //   best, protection against a same-process duplicate — which the
  //   in-flight map below provides for free, correctly, and synchronously.
  //
  // The map below is keyed by owner and holds the CURRENTLY in-flight
  // write's promise; a second dispatch for the SAME owner arriving while
  // that write is still pending is dropped (checked and set synchronously,
  // before any `await`, so two dispatches on the same microtask cannot both
  // pass the check — a read-then-write check against a store necessarily
  // can). Once the in-flight write settles, its entry is removed: a LATER,
  // separate dispatch for the same owner (a genuine second deletion of a
  // recreated session, or simply time having passed) starts and completes
  // its own write, exactly as it should. This closes the same-process
  // duplicate-dispatch case this issue's own acceptance criterion tests;
  // the cross-process race `deleteSession`'s own single-process coalescing
  // (`create-bureau.ts`) does not cover is NOT closed by this map (each
  // process holds its own, independent map) — matching every other
  // out-of-band durable write in this package (the audit trail's own
  // `session.deleted`/`schedule.*` listeners, AB-228, never de-dupe at
  // all), and consistent with `resolveEventHistory`'s deleted-aggregate
  // detection already tolerating more than one `'session.deleted'` record
  // for the same owner (it checks only for PRESENCE via `.some(...)`,
  // never exactly one).
  //
  // The in-flight map alone does NOT close a literal replay of the SAME
  // event object once its write has already settled (Codex review findings,
  // PR #580, "Remember/Deduplicate a SessionDeletedEvent after its write
  // settles") — that entry is gone by then, so the replay would look
  // identical to a genuinely later, distinct deletion. `recordedDeletionEvents`
  // (the `WeakSet` above) closes that specific case by object identity,
  // independent of and checked before the in-flight map.
  //
  // Routed through `trackWrite` (not `sink()`, which always writes,
  // unconditionally) so `hasActiveWrite(owner)` reports `true` for this
  // owner for the write's full duration, exactly as it does for every
  // other listener's write (Copilot review finding, PR #580).
  //
  // KNOWN, ACCEPTED LIMITATION (Codex review findings, PR #580, "Preserve
  // overlapping deletions of reused session IDs" and the follow-up "Clear
  // the guard from the actual session creation path" that caught an
  // earlier attempted fix relying on a production-dead action type): this
  // in-flight-by-owner map still conflates a session id recreated and
  // deleted again WHILE the prior incarnation's own `session.deleted`
  // write is still pending (e.g. a slow durable append) — the second,
  // genuinely distinct deletion is dropped as if it were a duplicate of
  // the first. Closing this properly needs a real signal that fires when a
  // session is (re)created; none exists in production today
  // (`SessionCreatedEvent`/`SessionSavedEvent` are both defined and
  // type-mapped in `@lostgradient/operative` but never constructed
  // anywhere — verified by `grep -rn "new Session(Created|Saved)Event("`
  // across `packages/`), and adding one is an `@lostgradient/operative`
  // change (this issue's delivery boundary is `packages/bureau` only), or
  // else a per-incarnation identity on `SessionDeletedEvent` itself,
  // equally out of this boundary. The window is extremely narrow in
  // practice (it requires the FIRST incarnation's own durable append to
  // still be pending at the moment the id is recreated AND deleted again),
  // and `resolveEventHistory` (`create-bureau.ts`) already checks the
  // session's LIVE record before trusting a historical `'session.deleted'`
  // marker (see that function's own doc comment), so this residual gap can
  // only ever manifest as a MISSING durable fact for the second
  // incarnation's deletion, never a false `deleted-aggregate` report for a
  // session that is actually still live.
  const sessionDeletedListener = (event: SessionDeletedEvent): void => {
    if (signal?.aborted) return;
    // A literal replay of the SAME event object — checked first, and
    // independent of the in-flight-by-owner map below, since that map's
    // entry is already gone by the time a settled write's event could be
    // redispatched.
    if (recordedDeletionEvents.has(event)) return;
    const owner: DurableEventOwner = { kind: 'session', id: event.sessionId };
    const ownerKey = encodeOwner(owner);
    if (pendingSessionDeletionWrites.has(ownerKey)) return;
    recordedDeletionEvents.add(event);
    trackWrite(ownerKey, () => {
      const write = history.record(owner, 'session.deleted', { sessionId: event.sessionId }).then(
        () => undefined,
        (error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message: `[durable-event-history] Failed to record durable event "session.deleted" for ${owner.kind}:${owner.id}:`,
            cause: error,
          });
        },
      );
      pendingSessionDeletionWrites.set(ownerKey, write);
      void write.finally(() => {
        if (pendingSessionDeletionWrites.get(ownerKey) === write) {
          pendingSessionDeletionWrites.delete(ownerKey);
        }
      });
      return write;
    });
  };
  bureau.addEventListener('session.deleted', sessionDeletedListener);

  // AB-224's `review.*` lifecycle family (AB-87/AB-46) — like `schedule.*`
  // above, these are dispatched directly onto the bureau-level emitter
  // (`create-bureau.ts`'s `recordReviewDecision`/`recordReviewStatusTransition`),
  // never through the `'action'` stream, so they need their own listeners
  // here to reach `Bureau.eventHistory` at all. Every review belongs to a
  // run (both `PendingToolApprovalReview` and `PendingHumanWaitReview` carry
  // `runId`), so all seven are recorded under the SAME `{ kind: 'run', id:
  // event.runId }` owner `run.*`/`session.*` use — never a distinct
  // `'review'` owner kind, which `DurableEventOwnerKind` does not define.
  // The payload mirrors the live event's own minimal, privileged shape
  // (`reviewId`/`runId`/`principal`/`kind`) — no approval arguments,
  // signal payloads, or decision reasons, matching AB-87's redaction
  // column for this surface.
  function reviewPayload(
    event:
      | ReviewApprovedEvent
      | ReviewCanceledEvent
      | ReviewDeniedEvent
      | ReviewExpiredEvent
      | ReviewRejectedEvent
      | ReviewRevokedEvent
      | ReviewSupersededEvent,
  ): { reviewId: string; runId: string; principal: string; kind: string } {
    return {
      reviewId: event.reviewId,
      runId: event.runId,
      principal: event.principal,
      kind: event.kind,
    };
  }
  const reviewApprovedListener = (event: ReviewApprovedEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'review.approved', reviewPayload(event));
  };
  const reviewDeniedListener = (event: ReviewDeniedEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'review.denied', reviewPayload(event));
  };
  const reviewRejectedListener = (event: ReviewRejectedEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'review.rejected', reviewPayload(event));
  };
  const reviewExpiredListener = (event: ReviewExpiredEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'review.expired', reviewPayload(event));
  };
  const reviewRevokedListener = (event: ReviewRevokedEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'review.revoked', reviewPayload(event));
  };
  const reviewCanceledListener = (event: ReviewCanceledEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'review.canceled', reviewPayload(event));
  };
  const reviewSupersededListener = (event: ReviewSupersededEvent): void => {
    if (signal?.aborted) return;
    sink({ kind: 'run', id: event.runId }, 'review.superseded', reviewPayload(event));
  };
  bureau.addEventListener('review.approved', reviewApprovedListener);
  bureau.addEventListener('review.denied', reviewDeniedListener);
  bureau.addEventListener('review.rejected', reviewRejectedListener);
  bureau.addEventListener('review.expired', reviewExpiredListener);
  bureau.addEventListener('review.revoked', reviewRevokedListener);
  bureau.addEventListener('review.canceled', reviewCanceledListener);
  bureau.addEventListener('review.superseded', reviewSupersededListener);

  return {
    hasActiveWrite(owner: DurableEventOwner): boolean {
      return (activeWriteCountsByOwner.get(encodeOwner(owner)) ?? 0) > 0;
    },
    async waitForActiveWrites(owner: DurableEventOwner): Promise<void> {
      // Snapshot the current Set before awaiting: a write that starts
      // AFTER this call (e.g. because settling one write's listener kicks
      // off a fresh one for the same owner) is a NEW write this call never
      // promised to wait for, exactly like `AuditTrail.query()`'s own
      // snapshot-then-await.
      const ownerWrites = activeWritesByOwner.get(encodeOwner(owner));
      if (!ownerWrites || ownerWrites.size === 0) return;
      await Promise.allSettled([...ownerWrites]);
    },
    async dispose(): Promise<void> {
      bureau.removeEventListener('action', actionListener);
      bureau.removeEventListener('schedule.completed', scheduleCompletedListener);
      bureau.removeEventListener('schedule.failed', scheduleFailedListener);
      bureau.removeEventListener('schedule.created', scheduleCreatedListener);
      bureau.removeEventListener('schedule.paused', schedulePausedListener);
      bureau.removeEventListener('schedule.resumed', scheduleResumedListener);
      bureau.removeEventListener('schedule.cancelled', scheduleCancelledListener);
      bureau.removeEventListener('run.removed', runRemovedListener);
      bureau.removeEventListener('session.deleted', sessionDeletedListener);
      bureau.removeEventListener('review.approved', reviewApprovedListener);
      bureau.removeEventListener('review.denied', reviewDeniedListener);
      bureau.removeEventListener('review.rejected', reviewRejectedListener);
      bureau.removeEventListener('review.expired', reviewExpiredListener);
      bureau.removeEventListener('review.revoked', reviewRevokedListener);
      bureau.removeEventListener('review.canceled', reviewCanceledListener);
      bureau.removeEventListener('review.superseded', reviewSupersededListener);
      await Promise.allSettled([...activeWrites]);
    },
  };
}
