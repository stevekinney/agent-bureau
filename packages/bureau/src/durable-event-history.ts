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
 *
 * Widened again by AB-384, 2026-09-09: a sixth and seventh bureau-level-
 * emitter source, `SessionCreatedEvent`/`SessionSavedEvent` — closing the
 * same shape of gap `SessionDeletedEvent` closed above.
 * `SESSION_DURABLE_ACTION_TYPES` has listed `'session.created'`/
 * `'session.saved'` since AB-91, but nothing ever dispatched either onto the
 * `'action'` stream. `@lostgradient/operative`'s `SessionStore` now
 * dispatches both directly on its own `events` target as `save()`/`update()`
 * commits succeed, forwarded by `create-bureau.ts` onto this bureau-level
 * emitter; the dedicated `sessionCreatedListener`/`sessionSavedListener`
 * below record them under the same `{ kind: 'session', id: sessionId }`
 * owner `session.deleted` uses. No in-flight dedupe is needed for either:
 * unlike `deleteSession`, `SessionStore` dispatches each exactly once per
 * real commit, with no documented duplicate-dispatch or cross-process race
 * to guard against. This same AB-384 change also gives `SessionDeletedEvent`
 * a real `incarnation` field (`AgentSession.incarnation`, minted by
 * `SessionStore` on create, preserved across save/update, fresh on recreate
 * after delete) — see `sessionDeletedListener`'s own doc comment for how
 * that closes its previously KNOWN, ACCEPTED overlapping-incarnations
 * limitation.
 */
import type {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionSavedEvent,
} from '@lostgradient/operative';
import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
} from '@lostgradient/operative/durable';
import type { Subscription } from '@lostgradient/operative/liveness';
import { encode } from '@lostgradient/weft';
import {
  createFleetEventFeed,
  type Cursor,
  type FleetEventEnvelope,
  type FleetEventFeed,
} from '@lostgradient/weft/server/handler';
import type { Storage } from '@lostgradient/weft/storage';
import type { RuntimeServices } from 'lifecycle';

import type { AgentDefinitions } from './agent-catalog';
import type { EventTimestampResolver } from './event-timestamp';
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

/**
 * Options for {@link DurableEventHistory.record}.
 *
 * AB-389 (Codex P2 review finding, PR #598, "Keep deduplication metadata
 * out of application payloads"): the outbox drain used to embed
 * `dedupeKey` directly in the recorded `payload`, which silently collapsed
 * any two unrelated events an ordinary caller happened to give the same
 * `dedupeKey`-named payload field. Both fields here live OUTSIDE the
 * payload entirely — `dedupeKey` drives a storage-level compare-and-swap
 * marker `record()` writes atomically alongside the event itself (never
 * visible to a reader of the payload), and `emittedAtMs` overrides the
 * envelope's timestamp for a caller that knows the true commit time (a
 * replayed outbox entry) rather than the moment this call happens to run.
 */
export interface DurableEventRecordOptions {
  /**
   * Makes this write idempotent: a second `record()` call for the same
   * `owner`/`kind`/`dedupeKey` is a no-op read of the first call's own
   * result rather than a second durable append. Enforced by an atomic
   * storage compare-and-swap (a `conditionalBatch` condition requiring a
   * reserved marker key to be absent, committed in the SAME batch as the
   * event append) — not a read-before-write scan, so two processes racing
   * to record the identical `dedupeKey` can never both succeed (Codex P1
   * review finding, PR #598, "Make cross-process outbox deduplication
   * atomic").
   */
  dedupeKey?: string;
  /**
   * Overrides the envelope's `emittedAtMs` (otherwise `runtime.clock.now()`
   * at call time). A caller replaying a fact that actually committed
   * earlier — the session outbox drain, replaying a `SessionOutboxEntry`
   * possibly long after its commit — passes the ORIGINAL commit time here
   * so a delayed replay does not misdate the event as happening now
   * (Codex P2 review finding, PR #598, "Persist the commit time with each
   * outbox entry").
   */
  emittedAtMs?: number;
}

/** The reserved storage-key prefix for {@link DurableEventRecordOptions.dedupeKey} markers — never a Weft-reserved prefix (see `WEFT_RESERVED_KEY_PREFIXES`). */
const DEDUPE_MARKER_PREFIX = 'outbox-dedupe:';

function dedupeMarkerKey(owner: DurableEventOwner, kind: string, dedupeKey: string): string {
  return `${DEDUPE_MARKER_PREFIX}${encodeOwner(owner)}:${kind}:${dedupeKey}`;
}

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

/**
 * A resumable point-in-time view of which `run`-owner ids the fleet feed's
 * current retention floor still has at least one durable event for, as
 * returned by {@link DurableEventHistory.retainedRunOwnerIds}. `cursor` is
 * opaque — pass the WHOLE snapshot back to
 * {@link DurableEventHistory.refreshRetainedRunOwnerIds} to extend it
 * cheaply rather than re-scanning from scratch. See AB-363's
 * `pruneStaleRunOwnership` (`create-bureau.ts`) for the caller.
 */
export interface RetainedRunOwnerSnapshot {
  readonly ownerIds: ReadonlySet<string>;
  /** Resume point for `feed.replay({ fromCursor: cursor })`. `undefined` means "replay from the start". */
  readonly cursor: Cursor | undefined;
  /**
   * AB-393 (Codex review, PR #600, "Batch retained-owner refreshes instead
   * of replaying per record"): the `sequence` of the last envelope this
   * snapshot walked (including a `fleet:gap` marker, same as `cursor`).
   * Lets {@link DurableEventHistory.refreshRetainedRunOwnerIds} cheaply
   * rule out "nothing new" with a single
   * `FleetEventFeed.snapshotTailSequence()` read (the same tail record
   * `FleetEventFeed.append()` always advances IN THE SAME storage batch
   * as the event it appends — see that function's own doc comment)
   * instead of unconditionally paying for a full `feed.replay()` page
   * load on every call, most of which return nothing new. Opaque like
   * `cursor` — never compare it to anything but another
   * `snapshotTailSequence()` reading.
   *
   * AB-393 (Codex review, PR #600, "Fast-path refreshes for an initially
   * empty feed"): never `undefined` in practice — a snapshot whose scan
   * walked no `run` owner (nothing retained yet, or every envelope
   * walked named a non-`run` owner — schedules, sessions, reviews) still
   * gets a real, comparable value here via
   * `FleetEventFeed.snapshotTailSequence()`, so a later refresh against
   * an owner set that STAYS empty can still short-circuit instead of
   * falling through to a full scan every single call. `undefined` is
   * retained in the type only for a caller constructing a snapshot from
   * scratch outside this module, which this module's own factories never
   * do.
   *
   * ACCEPTED RESIDUAL (Codex review, PR #600, "Fast-path refreshes for an
   * initially empty feed", round 2): this does NOT make every refresh
   * against a feed cheap — a feed that has NEVER had a single event
   * appended (no `KEYS.fleetEventTail()` record has ever been written)
   * makes `FleetEventFeed.snapshotTailSequence()` ITSELF fall back to its
   * own `storage.scan()` (see that function's own implementation in
   * `fleet-event-feed.ts`), since there is no tail record yet to read
   * cheaply. Every call against a genuinely virgin feed therefore still
   * costs a scan, no cheaper than `feed.replay()`'s own scan would have
   * — this module has no primitive available to distinguish "virgin,
   * never appended" from "empty right now" any more cheaply than
   * `FleetEventFeed` itself can. The moment ANY event is ever appended
   * (by any run, schedule, or session action), the tail record exists
   * permanently from then on and every later refresh becomes the cheap,
   * single-`get` path described above — so this residual is bounded to
   * the window before the very first durable event a bureau ever
   * records. See this issue's own `upstreamDefects` for the weft-side
   * enhancement (a cheap "has anything ever been appended" read, or an
   * eagerly-written tail sentinel) that would close it fully.
   */
  readonly tailSequence: number | undefined;
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
   *
   * `emittedAtMs` defaults to `runtime.clock.now()` — the clock reading at
   * the moment this call executes. Pass it explicitly (AB-388, Codex review
   * PR #597, "Clamp at an audit-safe timestamp boundary") when the caller
   * has an earlier, more authoritative timestamp for the SAME logical
   * event: `createDurableEventProducer`'s `actionListener` passes the
   * originating `Action.timestamp` for `run`/`session`-kind events, so this
   * envelope's `emittedAtMs` exactly matches the timestamp
   * `createAuditTrail`'s own action-stream listener stamps onto ITS record
   * for the identical action — no clock read taken independently, later,
   * at whatever moment this listener happens to run. Without this, the
   * durable event's own `emittedAtMs` could read later than the audit
   * record's `timestampMs` for the very same action (the runtime clock can
   * advance between the action being created and this producer recording
   * it), and `AuditTrail.prune`'s floor-based clamp (derived from
   * `retentionFloorTimestamp()`, which reads this field) would then treat
   * the durable event's later timestamp as the protection boundary and
   * delete the audit record it was supposed to protect.
   */
  record(
    owner: DurableEventOwner,
    kind: string,
    payload: unknown,
    options?: DurableEventRecordOptions,
  ): Promise<DurableEventEnvelope>;
  /**
   * AB-389 — whether a durable record for `owner`/`kind` carrying the
   * given `dedupeKey` has already been committed. Built for the session
   * outbox drain (`create-bureau.ts`'s `drainOutbox`), which must
   * not acknowledge (permanently remove) an outbox entry unless the
   * durable write it triggered actually succeeded: awaiting
   * `DurableEventProducer.waitForActiveWrites` alone only proves the write
   * SETTLED, never that it succeeded — a storage failure is diagnosed and
   * swallowed by the write's own listener (`trackWrite`), never surfaced
   * to a caller that merely awaited settlement (Codex P1 review finding,
   * PR #598, "Retain the outbox entry when its durable write fails"). A
   * direct O(1) read of `record()`'s own dedupe marker key (Codex P2
   * review finding, PR #598, "Avoid rescanning retained history for every
   * outbox entry") — never a history scan.
   */
  wasRecorded(owner: DurableEventOwner, kind: string, dedupeKey: string): Promise<boolean>;
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
   * so this collects every survivor's owner in one pass.
   *
   * Returns `undefined` when the floor is still 0 — nothing has been
   * retired yet, so nothing can be "entirely below" it, and an
   * empty-so-far history is still fully pageable (an empty page, never a
   * gap); reporting a real (possibly empty) set at floor 0 would
   * indistinguishably read as "prune everything," which is wrong.
   * `retain()` never runs on its own — nothing in this codebase calls it
   * yet — so in practice this returns `undefined` until an operator or a
   * future retention driver advances the floor.
   *
   * This is the EXPENSIVE, from-scratch call — use it once, at the start
   * of a pruning pass, to obtain a {@link RetainedRunOwnerSnapshot}. Every
   * later revalidation within the SAME pass (immediately before each
   * session's write, per Codex review PR #568's "Revalidate retained
   * owners before pruning") must go through
   * {@link refreshRetainedRunOwnerIds} instead, passing this snapshot
   * back — see that function's doc comment for why (PR #568, "Avoid
   * replaying the full fleet feed per candidate session").
   */
  retainedRunOwnerIds(): Promise<RetainedRunOwnerSnapshot | undefined>;
  /**
   * Like {@link retainedRunOwnerIds}, but NEVER returns `undefined` at
   * floor 0 — it scans and returns the real (possibly empty) owner set
   * regardless of the current retention floor.
   *
   * AB-388 (Codex review, PR #597, "Scan retained run owners at floor
   * zero"): `retainedRunOwnerIds()`'s floor-0 `undefined` is the RIGHT
   * answer for its one existing caller, `pruneStaleRunOwnership`, which
   * uses the returned set to decide what is prune-ELIGIBLE — an empty
   * set there would indistinguishably read as "everything is eligible,"
   * so floor 0 (nothing retired yet, nothing eligible) must return
   * `undefined` instead of an empty set for that caller specifically (see
   * that function's own doc comment above).
   *
   * `Bureau.pruneAuditTrail`'s `protectRunId` consumer has the OPPOSITE
   * polarity: the returned set says what to PROTECT, and a small or empty
   * real set is never ambiguous with "protect everything." Reusing
   * `retainedRunOwnerIds()` there made a retained run's OWN audit records
   * (e.g. an earlier `tool.result`/`step.completed` write than that run's
   * later terminal durable event) prunable whenever the fleet feed floor
   * happened to still be 0 — the floor-0 "nothing has been retired"
   * escape hatch silently dropped ALL owner-based protection instead of
   * computing the real (and at floor 0, complete) set that a full
   * `feed.replay()` already gives for free. This function is that same
   * scan, called unconditionally, so `pruneAuditTrail` gets accurate
   * per-run protection at every floor value including 0.
   */
  retainedRunOwnerIdsForAuditRetention(): Promise<RetainedRunOwnerSnapshot>;
  /**
   * Cheaply extends a {@link RetainedRunOwnerSnapshot} to reflect any
   * durable event appended to the feed since it was taken, WITHOUT
   * rescanning the records the snapshot already walked.
   *
   * `pruneStaleRunOwnership` (`create-bureau.ts`) revalidates immediately
   * before every session's write, and again on every optimistic-
   * concurrency retry — a correctness requirement (PR #568, "Revalidate
   * retained owners before pruning": a run can complete and its terminal
   * event become pageable entirely within the time this function's
   * caller spends paging through other sessions). Re-running
   * {@link retainedRunOwnerIds} for that check would replay the ENTIRE
   * retained window once per candidate session (and again per retry),
   * turning one maintenance pass into O(candidate sessions × retained
   * events) storage reads (PR #568, "Avoid replaying the full fleet feed
   * per candidate session").
   *
   * Instead, this resumes `feed.replay()` from `snapshot.cursor` — the
   * position the previous call (either `retainedRunOwnerIds` or this same
   * function) stopped at — so it only ever walks records appended since
   * then, never the retained window from the start. It reads the SAME
   * shared feed every other write goes through, so it also observes a
   * write committed by another Bureau instance in the interim, not only
   * this process's own in-flight writes.
   *
   * AB-393 (Codex review, PR #600, "Avoid replaying the feed for every
   * unprotected audit record" / "Batch retained-owner refreshes instead
   * of replaying per record"): "no new records to walk" is NOT the same
   * as "zero storage reads" for `feed.replay()` ITSELF — it always issues
   * one consistency-checked page load (the retention floor, then a scan
   * for anything past the cursor) even when that scan comes back empty,
   * to confirm there genuinely is nothing new rather than merely
   * assuming it. This function avoids paying that cost on every call by
   * checking `feed.snapshotTailSequence()` FIRST — a single `storage.get`
   * against the same tail record `FleetEventFeed.append()` always
   * advances in the SAME storage batch as the event it appends (see that
   * function's own doc comment), so `tailSequence <= snapshot.tailSequence`
   * is a sound, safe-to-trust proof that nothing has been appended since
   * this snapshot's own last scan — never a false negative, since the
   * tail and the event it names always commit atomically together. Only
   * when the tail has genuinely moved does this fall through to the full
   * `feed.replay()` scan above. The common "nothing new" case this
   * function exists for is therefore one cheap `storage.get`, not a page
   * load — a caller invoking this once per SURVIVING candidate across a
   * large backlog (see `AuditTrail.prune`'s `protectRunId` option in
   * `audit-trail.ts`, and `pruneAuditTrail`'s own predicate in
   * `create-bureau.ts`) now pays that single-read cost per candidate, not
   * a page-load per candidate.
   *
   * `snapshot.tailSequence` is never `undefined` in practice — see that
   * field's own doc comment on {@link RetainedRunOwnerSnapshot} for why
   * even a snapshot taken against a genuinely empty feed still carries a
   * real, comparable value (`FleetEventFeed.snapshotTailSequence()`'s own
   * `-1` "nothing appended yet" sentinel), so THIS pre-check still
   * short-circuits correctly for a feed that stays empty across
   * repeated refreshes, rather than falling through to a full scan every
   * single time (Codex review, PR #600, "Fast-path refreshes for an
   * initially empty feed").
   *
   * The floor is monotonically non-decreasing once it has left 0 (nothing
   * un-retires a record), so a snapshot obtained while the floor was
   * already > 0 never needs re-checking for floor-0; this never returns
   * `undefined`. Never rescans anything before `snapshot.cursor` — an
   * owner already retired between the two calls (the floor having
   * advanced past it) is NOT removed from the returned set. That is
   * deliberately the same "safe to be wrong" direction as the rest of
   * this pruning pass: treating an already-retired run as still retained
   * costs one extra no-op write this cycle and leaves it for the next
   * one; it never causes an incorrect deletion.
   */
  refreshRetainedRunOwnerIds(snapshot: RetainedRunOwnerSnapshot): Promise<RetainedRunOwnerSnapshot>;
  /**
   * The owner's own latest retained deletion-marker event (`session.deleted`
   * for a `session` owner, `run.removed` for a `run` owner), scanned across
   * the ENTIRE retained fleet feed — independent of any `since`/`limit`
   * window. AB-385 (coordinator ruling, 2026-09-08): `page()`'s own
   * deleted-aggregate detection in `Bureau.eventHistory`'s
   * `resolveEventHistory` (`create-bureau.ts`) used to scan only the single
   * requested page, so a caller whose window paged around the marker was
   * told the owner was live. This primitive answers "has this owner's
   * deletion marker EVER been retained" directly, so that classification no
   * longer depends on the caller's own pagination parameters.
   *
   * Returns `undefined` for a `schedule` owner (no deletion-marker concept
   * exists for that kind) without scanning anything, and `undefined` when no
   * matching marker is retained (never deleted, or its marker has aged out
   * of retention). A corrupt or unsupported-schema-version record at a
   * candidate sequence is skipped with a diagnostic, exactly like `page()`'s
   * own per-record tolerance — one bad record never aborts this scan.
   *
   * "Latest" matters only in that a marker record is, at most, ever written
   * once per incarnation of an id (`createDurableEventProducer`'s dedicated
   * listeners); this returns the highest-sequence match the feed currently
   * retains. Callers needing the AB-372 "is a reused id live again" override
   * still consult the live session/run record separately — this primitive
   * only answers whether a marker exists, not whether it is stale.
   */
  latestDeletionMarker(owner: DurableEventOwner): Promise<DurableEventEnvelope | undefined>;
  /**
   * AB-388: the earliest `emittedAtMs` across every durable event the fleet
   * feed currently retains — the timestamp `AuditTrail.prune` must never
   * delete an audit record at or after, so audit evidence always outlives
   * the durable events it describes. Returns `undefined` only when the feed
   * currently retains no events at all (fresh feed, or the floor has
   * advanced past everything that ever existed) — a caller reading
   * `undefined` applies no floor-based clamp.
   *
   * A retention floor of `0` (nothing has ever been retired) is NOT treated
   * as "no floor" — every currently-retained event still needs protecting,
   * same as any other floor value. Returning `undefined` for a zero floor
   * was a real bug this fixed (Codex review, PR #597): it removed the
   * clamp entirely for the normal, common case (`retain()` is never called
   * automatically — see this module's own top-of-file doc comment), letting
   * `auditRetention` delete audit records for durable events that remain
   * fully pageable.
   *
   * Scans the ENTIRE retained window via `feed.replay({})` rather than
   * trusting the first envelope's own `emittedAtMs` — retained events are
   * not guaranteed to be timestamp-monotonic in sequence order (skewed
   * fleet-writer clocks, a clock moving backward, or concurrent appends
   * racing into a different sequence order than their own timestamps), so
   * the true floor timestamp is the MINIMUM `emittedAtMs` across every
   * retained envelope, not merely the one at the lowest sequence. The
   * internal `fleet:gap` marker `retain()` leaves at the head of replay
   * carries no meaningful `emittedAtMs` for this purpose and is skipped.
   */
  retentionFloorTimestamp(): Promise<number | undefined>;
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
  /**
   * AB-389 — `record()`'s own {@link DurableEventRecordOptions.dedupeKey},
   * stamped onto this WRAPPER rather than the caller's `payload` (Codex P2
   * review finding, PR #598, "Keep deduplication metadata out of
   * application payloads"): `toDurableEventEnvelope` strips this wrapper
   * down to `payload.payload` before returning a `DurableEventEnvelope` to
   * any caller, so this field is never visible outside this module — a
   * caller's own payload carrying a same-named `dedupeKey` property is
   * unaffected. Present only on a write that opted in via `options`; used
   * exclusively by this module's own collision-recovery scan
   * (`findByDedupeKey`), never read by `page()`/`subscribeEventHistory`.
   */
  readonly dedupeKey?: string;
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

/**
 * The durable event `kind` this module's own deletion-marker writers record
 * for each owner kind that has a deletion concept — `undefined` for
 * `schedule`, which has none. Used by
 * {@link DurableEventHistory.latestDeletionMarker} (AB-385) and exported so
 * `create-bureau.ts`'s `resolveEventHistory` can check the SAME kind
 * against its own already-fetched `page.events` (the race-safety and
 * scan-avoidance optimizations documented on `latestDeletionMarker` and
 * `resolveEventHistory` respectively) without a second, divergent literal
 * mapping.
 */
export function deletionMarkerKindFor(ownerKind: DurableEventOwner['kind']): string | undefined {
  switch (ownerKind) {
    case 'session':
      return 'session.deleted';
    case 'run':
      return 'run.removed';
    case 'schedule':
      return undefined;
  }
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

  /**
   * AB-389 — finds an already-recorded event for `owner`/`kind` carrying
   * `dedupeKey` on its internal storage wrapper (never the caller's own
   * `payload` — see {@link StoredDurableEventPayload.dedupeKey}), by
   * replaying the raw feed directly rather than going through `page()`
   * (which strips the wrapper down to the caller-visible payload before
   * returning). `feed.replay()` resumes past any compacted retention floor
   * on its own (its `fleet:gap` marker carries no `workflowId`, so this
   * owner filter excludes it without any floor bookkeeping here) — closing
   * the same gap a per-page bounded scan would otherwise need to retry
   * across (Codex P2 review finding, PR #598, "Continue dedupe lookup from
   * the retention floor").
   *
   * Used ONLY as `record()`'s collision-recovery path, never on every
   * write (Codex P2 review finding, PR #598, "Avoid rescanning retained
   * history for every outbox entry") — the common case is resolved by one
   * atomic compare-and-swap with no scan at all.
   */
  async function findByDedupeKey(
    owner: DurableEventOwner,
    kind: string,
    dedupeKey: string,
  ): Promise<DurableEventEnvelope | undefined> {
    const targetWorkflowId = encodeOwner(owner);
    for await (const envelope of feed.replay()) {
      if (envelope.workflowId !== targetWorkflowId || envelope.kind !== kind) continue;
      if (!isStoredDurableEventPayload(envelope.payload)) continue;
      if (envelope.payload.dedupeKey !== dedupeKey) continue;
      try {
        return toDurableEventEnvelope(envelope, owner);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[durable-event-history] Skipped corrupt durable record at sequence ${envelope.sequence} for ${owner.kind}:${owner.id} while resolving a dedupe collision:`,
          cause: error,
        });
        continue;
      }
    }
    return undefined;
  }

  async function record(
    owner: DurableEventOwner,
    kind: string,
    payload: unknown,
    options?: DurableEventRecordOptions,
  ): Promise<DurableEventEnvelope> {
    const emittedAtMs = options?.emittedAtMs ?? runtime.clock.now();
    const dedupeKey = options?.dedupeKey;
    if (dedupeKey === undefined) {
      const stored: StoredDurableEventPayload = { schemaVersion: CURRENT_SCHEMA_VERSION, payload };
      const appended = await feed.append({
        kind,
        workflowId: encodeOwner(owner),
        emittedAtMs,
        payload: stored,
      });
      return toDurableEventEnvelope(appended, owner);
    }
    const stored: StoredDurableEventPayload = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload,
      dedupeKey,
    };
    const markerKey = dedupeMarkerKey(owner, kind, dedupeKey);
    // Fast pre-check: a redelivery of an entry this store already recorded
    // (the common outbox-replay case, not a genuine cross-process race)
    // resolves here with a single key read — no doomed compare-and-swap
    // attempt, and no scan.
    if ((await storage.get(markerKey)) !== null) {
      const existing = await findByDedupeKey(owner, kind, dedupeKey);
      if (existing) return existing;
    }
    // AB-389 (Codex P1 review finding, PR #598, "Make cross-process outbox
    // deduplication atomic"): the marker is written in the SAME
    // `conditionalBatch` as the event append itself (via
    // `FleetEventFeed.append`'s own `options.conditions`/`operations`,
    // which thread straight through to `Storage.conditionalBatch`) — so
    // two processes racing to record the identical `dedupeKey` can never
    // both succeed. The loser's `feed.append()` retries against the
    // now-failing marker condition until it exhausts its internal retry
    // budget and throws; that throw is caught below and resolved by
    // reading back the winner's own record, rather than surfaced as an
    // error to a caller that merely lost an idempotent race.
    try {
      const appended = await feed.append(
        { kind, workflowId: encodeOwner(owner), emittedAtMs, payload: stored },
        {
          conditions: [{ key: markerKey, expectedValue: null }],
          operations: [{ type: 'put', key: markerKey, value: encode(true) }],
        },
      );
      return toDurableEventEnvelope(appended, owner);
    } catch (error) {
      const existing = await findByDedupeKey(owner, kind, dedupeKey);
      if (existing) return existing;
      throw error;
    }
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
    // AB-389 — no read-side dedupe skip is needed here: record()'s own
    // write-side compare-and-swap (a dedupeKey-marker condition passed to
    // feed.append()) guarantees a duplicate (kind, dedupeKey) pair can
    // never be appended in the first place, across processes or
    // otherwise (Codex P1 review finding, PR #598, "Make cross-process
    // outbox deduplication atomic"). The earlier read-side Set this
    // replaced could still expose a duplicate across separately-cursored
    // page() calls (Codex P1 review finding, PR #598, "Preserve dedupe
    // state across paginated history reads"); that is now moot for the
    // same reason.
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

  /**
   * Shared scan body for both `retainedRunOwnerIds` and
   * `refreshRetainedRunOwnerIds`: resumes `feed.replay()` from
   * `fromCursor` (or the very start, when `undefined`), adding every `run`
   * owner it walks to `owners`, MUTATED IN PLACE (Codex review, PR #579,
   * "Stop copying the full owner set on every refresh") — callers pass
   * the SAME underlying `Set` back on every refresh rather than a fresh
   * clone of it, so the O(1)-per-new-record cost this cursor-resumed scan
   * already achieves for storage reads is not immediately undone by an
   * O(retained owners) clone on every call. This is safe only because
   * every caller of `refreshRetainedRunOwnerIds` in this codebase
   * processes ONE pruning pass at a time, sequentially, reassigning its
   * own snapshot variable rather than comparing an old snapshot against a
   * new one — see `pruneStaleRunOwnership`'s own doc comment
   * (`create-bureau.ts`). Never share one `RetainedRunOwnerSnapshot`
   * across two concurrent passes for this reason. We don't decode the
   * stored payload at all (unlike `page()`), since only the envelope's
   * `workflowId` is needed and a corrupt/unrecognized `schemaVersion` on
   * some OTHER owner's record must never stop this scan. `cursor` is
   * captured from EVERY envelope, including one with no `workflowId`
   * (e.g. the internal `fleet:gap` marker) — the resume point must
   * advance regardless of whether that particular record named an owner.
   */
  async function scanRunOwnerIdsFrom(
    owners: Set<string>,
    fromCursor: Cursor | undefined,
    fromTailSequence: number | undefined,
  ): Promise<RetainedRunOwnerSnapshot> {
    // AB-393 (Codex review, PR #600, "Do not advance the tail past an
    // unscanned first append"): captured BEFORE `feed.replay()` starts
    // below, ONLY for a fresh scan (`fromCursor === undefined` — a
    // refresh always already carries a real `fromTailSequence` from its
    // own originating scan, so this fallback is unreachable there; see
    // this function's own note further down). A genuinely new event can
    // commit at any point AFTER this read: reading the tail again AFTER
    // the replay below (the original, buggy shape of this fast path)
    // could then observe THAT new event's sequence even though the
    // replay above never walked it — recording a `tailSequence` that
    // claims coverage the scan never actually did, with `cursor` still
    // `undefined` and that event's owner missing from `owners`. Every
    // LATER `refreshRetainedRunOwnerIds()` call would then see its own
    // fresh tail reading already `<=` this falsely-advanced value and
    // skip scanning forever, permanently losing that owner. Reading the
    // tail BEFORE the scan instead gives a reading the replay is
    // GUARANTEED to cover at least up to (real time only moves forward),
    // so the worst this can do is under-report — safe to be wrong in the
    // "rescans a bit more than strictly needed next time" direction only,
    // never the direction that skips a scan a real new owner needs.
    const tailBeforeScan = fromCursor === undefined ? await feed.snapshotTailSequence() : undefined;
    let cursor = fromCursor;
    let tailSequence = fromTailSequence;
    for await (const envelope of feed.replay(fromCursor === undefined ? {} : { fromCursor })) {
      cursor = envelope.cursor;
      tailSequence = envelope.sequence;
      const workflowId = envelope.workflowId;
      if (workflowId === undefined) continue;
      const separator = workflowId.indexOf(':');
      if (separator < 0) continue;
      const ownerKind = workflowId.slice(0, separator);
      if (ownerKind !== 'run') continue;
      owners.add(workflowId.slice(separator + 1));
    }

    // AB-393 (Codex review, PR #600, "Fast-path refreshes for an
    // initially empty feed"): `tailSequence` only advances from an
    // envelope `feed.replay()` actually yields above — a scan that walks
    // nothing (a genuinely virgin feed) OR walks only non-`run` owners
    // (see `RetainedRunOwnerSnapshot.tailSequence`'s own doc comment for
    // that distinction and its accepted residual) leaves `tailSequence`
    // at whatever `fromTailSequence` already was — `undefined` for a
    // fresh scan. Falling back to `tailBeforeScan` (rather than a FRESH
    // `snapshotTailSequence()` read taken here, after the scan, which is
    // exactly the race this comment block's own doc comment above
    // documents and closes) gives `tailSequence` a value that is safe to
    // trust: the scan above is guaranteed to have covered everything at
    // or before it. Only runs when nothing was walked above, so it costs
    // nothing on every OTHER call.
    if (tailSequence === undefined) {
      tailSequence = tailBeforeScan;
    }
    return { ownerIds: owners, cursor, tailSequence };
  }

  async function retainedRunOwnerIds(): Promise<RetainedRunOwnerSnapshot | undefined> {
    const floor = await feed.snapshotRetentionFloor();
    if (floor === 0) return undefined;

    // No `fromCursor`: this walks every record the feed currently retains,
    // exactly once. A record at or before the floor never appears here
    // (weft's own `retain()` already deleted it).
    return scanRunOwnerIdsFrom(new Set(), undefined, undefined);
  }

  function retainedRunOwnerIdsForAuditRetention(): Promise<RetainedRunOwnerSnapshot> {
    // No floor-0 short-circuit (see this function's own doc comment on
    // the interface): `pruneAuditTrail`'s `protectRunId` consumer needs
    // the real owner set at every floor value, including 0, where the
    // real set is simply "every owner the feed has ever retained" — no
    // different in cost from the floor>0 case, since `scanRunOwnerIdsFrom`
    // already walks exactly the currently-retained window either way.
    return scanRunOwnerIdsFrom(new Set(), undefined, undefined);
  }

  async function refreshRetainedRunOwnerIds(
    snapshot: RetainedRunOwnerSnapshot,
  ): Promise<RetainedRunOwnerSnapshot> {
    // The floor is monotonically non-decreasing once above 0, so a
    // snapshot taken while it was already > 0 never needs a fresh
    // floor === 0 check here.
    //
    // AB-393 (Codex review, PR #600, "Batch retained-owner refreshes
    // instead of replaying per record"): a cheap, single `storage.get`
    // proof that nothing has landed since `snapshot`'s own last scan —
    // see this method's own doc comment for why comparing against the
    // tail record is sound (it always advances atomically with the event
    // it names). Skips the full `feed.replay()` page load entirely for
    // the common case this function exists to optimize.
    if (snapshot.tailSequence !== undefined) {
      const currentTailSequence = await feed.snapshotTailSequence();
      if (currentTailSequence <= snapshot.tailSequence) return snapshot;
    }

    // `snapshot.ownerIds` is publicly typed `ReadonlySet` so a CONSUMER of
    // this interface cannot mutate it — but this module is the only place
    // that ever constructs one, and it always constructs the underlying
    // value as a real, mutable `Set` (see `scanRunOwnerIdsFrom` above and
    // `retainedRunOwnerIds`'s `new Set()`). This cast reclaims that
    // module-private knowledge to mutate the SAME object in place rather
    // than cloning it — see this function's own doc comment on
    // `scanRunOwnerIdsFrom` for why that clone would be a real cost, and
    // why reusing it here is safe.
    return scanRunOwnerIdsFrom(
      snapshot.ownerIds as Set<string>,
      snapshot.cursor,
      snapshot.tailSequence,
    );
  }

  async function latestDeletionMarker(
    owner: DurableEventOwner,
  ): Promise<DurableEventEnvelope | undefined> {
    const markerKind = deletionMarkerKindFor(owner.kind);
    if (markerKind === undefined) return undefined;

    const targetWorkflowId = encodeOwner(owner);
    let latest: DurableEventEnvelope | undefined;
    // No `fromCursor`: this must see the owner's marker no matter where it
    // falls relative to any caller's own `since`/`limit` window (AB-385) —
    // that independence is the entire point of this primitive. Filtering on
    // `envelope.kind` BEFORE decoding (same ordering `page()` uses for
    // `workflowId`) means a corrupt or unsupported-schema-version record for
    // some OTHER kind, or for a different owner entirely, is never even
    // decoded here.
    //
    // "Highest sequence wins" is enforced EXPLICITLY by comparing
    // `envelope.sequence` (Copilot review, PR #591, "track the highest
    // envelope.sequence explicitly and skip decoding older candidates") —
    // never by assuming `feed.replay()` yields envelopes in increasing
    // order and letting the last match win by iteration position alone.
    // `feed.replay()` does document strictly increasing sequence order
    // today, but this comparison makes that an explicit invariant of THIS
    // function rather than an implicit one it would silently mis-answer if
    // that ordering guarantee ever changed. The comparison also runs before
    // decoding, so an older candidate is never decoded at all once a
    // newer, already-decoded match exists.
    for await (const envelope of feed.replay({})) {
      if (envelope.workflowId !== targetWorkflowId) continue;
      if (envelope.kind !== markerKind) continue;
      if (latest !== undefined && envelope.sequence <= latest.sequence) continue;
      try {
        latest = toDurableEventEnvelope(envelope, owner);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[durable-event-history] Skipped corrupt deletion marker at sequence ${envelope.sequence} for ${owner.kind}:${owner.id}:`,
          cause: error,
        });
        continue;
      }
    }
    return latest;
  }

  async function retentionFloorTimestamp(): Promise<number | undefined> {
    let minTimestamp: number | undefined;
    for await (const envelope of feed.replay({})) {
      // The internal gap marker carries no meaningful `emittedAtMs` for
      // this purpose — it announces the floor's SEQUENCE, not a real
      // event's own timestamp.
      if (envelope.kind === 'fleet:gap') continue;
      if (minTimestamp === undefined || envelope.emittedAtMs < minTimestamp) {
        minTimestamp = envelope.emittedAtMs;
      }
    }
    // `undefined` when nothing is currently retained (fresh feed, or the
    // floor has advanced past every event that ever existed) — nothing
    // needs protecting either way.
    return minTimestamp;
  }

  function dispose(): Promise<void> {
    feed.dispose();
    return Promise.resolve();
  }

  async function wasRecorded(
    owner: DurableEventOwner,
    kind: string,
    dedupeKey: string,
  ): Promise<boolean> {
    // A direct O(1) read of record()'s own dedupe marker key — never a
    // history scan (Codex P2 review finding, PR #598, "Avoid rescanning
    // retained history for every outbox entry").
    return (await storage.get(dedupeMarkerKey(owner, kind, dedupeKey))) !== null;
  }

  return {
    record,
    wasRecorded,
    page,
    subscribeEventHistory,
    retainedRunOwnerIds,
    retainedRunOwnerIdsForAuditRetention,
    refreshRetainedRunOwnerIds,
    latestDeletionMarker,
    retentionFloorTimestamp,
    dispose,
  };
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
  /**
   * AB-388: shared `emittedAtMs` resolver (see `event-timestamp.ts`) — when
   * supplied, the `schedule.*`/`session.deleted` listeners below stamp
   * their durable event with this resolver's reading for the event
   * instance, instead of an independent `runtime.clock.now()` call inside
   * `sink()`/`history.record()`, so the same event's audit-trail record
   * (via `createAuditTrail`, sharing the SAME resolver instance) never
   * diverges from this durable event's own `emittedAtMs`. Falls back to
   * `runtime.clock.now()` when omitted, matching every prior caller.
   */
  eventTimestamp?: EventTimestampResolver;
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
   * AB-388 (Codex review, PR #597, "Wait for durable event writes before
   * reading the floor"): await EVERY owner's write currently in flight, not
   * one owner's — `create-bureau.ts`'s `pruneAuditTrail` calls this
   * immediately before `retentionFloorTimestamp()`/`retainedRunOwnerIds()`,
   * so an audit write that already committed (e.g. on an asynchronously
   * delayed storage backend where the audit-trail's own write settles
   * before this producer's corresponding `history.record()` append does)
   * cannot have its protection computed from a floor/owner-set snapshot
   * that omits the still-in-flight durable event describing the SAME
   * action. Never rejects (an individual write's own failure is diagnosed
   * by its own listener); a snapshot, like {@link waitForActiveWrites} —
   * never waits on a write that starts after this call.
   */
  waitForAllActiveWrites(): Promise<void>;
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
 * lifecycle and reattachment facts. `session.created`, `session.saved`, and
 * `session.deleted` are listed here for completeness (an `'action'`-stream
 * dispatch of any of the three, if one ever existed, would be forwarded the
 * same way every other entry is), but no production code dispatches any of
 * them onto the `'action'` stream: `@lostgradient/operative`'s `SessionStore`
 * dispatches `SessionCreatedEvent`/`SessionSavedEvent` on its own `events`
 * target, forwarded by `create-bureau.ts` onto the bureau-level emitter
 * (AB-384), and `deleteSession` dispatches a real `SessionDeletedEvent`
 * directly onto that same emitter (AB-372) — all three handled by their own
 * dedicated listeners below (`sessionCreatedListener`/`sessionSavedListener`/
 * `sessionDeletedListener`), not by this set.
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
  // AB-388: see `event-timestamp.ts`. Falls back to a per-instance
  // resolver (still `runtime.clock`-backed) when the caller supplies none.
  const eventTimestamp: EventTimestampResolver =
    producerOptions?.eventTimestamp ?? (() => runtime.clock.now());

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

  function sink(
    owner: DurableEventOwner,
    kind: string,
    payload: unknown,
    options?: DurableEventRecordOptions,
  ): void {
    if (signal?.aborted) return;
    trackWrite(encodeOwner(owner), () =>
      history.record(owner, kind, payload, options).then(
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
  // in production at the time (Codex review finding, PR #580, "Clear the
  // guard from the actual session creation path"): `SessionCreatedEvent`
  // was defined and type-mapped in `@lostgradient/operative` but never
  // constructed anywhere — no production code path dispatched a
  // `'session.created'` action onto the bureau's `'action'` stream, so the
  // clearing branch could only ever fire from a test that synthesized the
  // action directly. Removed rather than left in as harmless-looking dead
  // code. AB-384 later closed the underlying gap for real — see this
  // module's top-of-file doc comment and `sessionDeletedListener`'s own
  // below — by giving `SessionDeletedEvent` a real per-incarnation
  // identity instead of resurrecting this clearing branch.
  // AB-384 — keyed by `JSON.stringify([encodeOwner(owner), incarnation])`,
  // not owner alone; see `sessionDeletedListener`'s own doc comment below.
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
      // AB-388 (Codex review, PR #597, "Clamp at an audit-safe timestamp
      // boundary"): pass the originating action's OWN timestamp rather
      // than letting `record()` read the clock fresh at this listener's
      // invocation — see `DurableEventHistory.record`'s own doc comment
      // for why a divergent read here can otherwise make
      // `retentionFloorTimestamp()` under-protect the audit record
      // `createAuditTrail`'s listener stamps for this SAME action.
      sink(
        { kind: 'run', id: action.runId },
        action.type,
        serializeActionDetail(action.type, action.detail),
        { emittedAtMs: action.timestamp },
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
        { emittedAtMs: action.timestamp },
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
    sink(
      { kind: 'schedule', id: event.scheduleId },
      'schedule.created',
      {
        scheduleId: event.scheduleId,
        agentName: event.agentName,
        spec: event.spec,
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      },
      { emittedAtMs: eventTimestamp(event) },
    );
  };
  const schedulePausedListener = (event: SchedulePausedEvent): void => {
    if (signal?.aborted) return;
    sink(
      { kind: 'schedule', id: event.scheduleId },
      'schedule.paused',
      { scheduleId: event.scheduleId },
      { emittedAtMs: eventTimestamp(event) },
    );
  };
  const scheduleResumedListener = (event: ScheduleResumedEvent): void => {
    if (signal?.aborted) return;
    sink(
      { kind: 'schedule', id: event.scheduleId },
      'schedule.resumed',
      { scheduleId: event.scheduleId },
      { emittedAtMs: eventTimestamp(event) },
    );
  };
  const scheduleCancelledListener = (event: ScheduleCancelledEvent): void => {
    if (signal?.aborted) return;
    sink(
      { kind: 'schedule', id: event.scheduleId },
      'schedule.cancelled',
      { scheduleId: event.scheduleId },
      { emittedAtMs: eventTimestamp(event) },
    );
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
  // CLOSED by AB-384 (previously a KNOWN, ACCEPTED LIMITATION — Codex review
  // findings, PR #580, "Preserve overlapping deletions of reused session
  // IDs" and the follow-up "Clear the guard from the actual session
  // creation path" that caught an earlier attempted fix relying on a
  // production-dead action type): the in-flight map used to be keyed by
  // OWNER alone, so a session id recreated and deleted again WHILE the
  // prior incarnation's own `session.deleted` write was still pending (e.g.
  // a slow durable append) was conflated with a duplicate dispatch of that
  // prior deletion and silently dropped. `SessionDeletedEvent` now carries
  // `AgentSession.incarnation` (AB-384 — minted by the store on create,
  // preserved across save/update, fresh on recreate after delete), so the
  // dedupe map below is keyed by `(id, incarnation)`, never `id` alone:
  // `trackWrite`'s own bookkeeping (`activeWriteCountsByOwner`/
  // `activeWritesByOwner`, read by `hasActiveWrite()`) stays keyed by OWNER,
  // since a per-incarnation key there would make `hasActiveWrite(owner)`
  // blind to a second incarnation's in-flight write against the exact same
  // owner. The `recordedDeletionEvents` `WeakSet` above needs no equivalent
  // change: it already partitions by event OBJECT identity, and two
  // incarnations' deletions are always two distinct `SessionDeletedEvent`
  // instances.
  const sessionDeletedListener = (event: SessionDeletedEvent): void => {
    if (signal?.aborted) return;
    // A literal replay of the SAME event object — checked first, and
    // independent of the in-flight-by-owner map below, since that map's
    // entry is already gone by the time a settled write's event could be
    // redispatched.
    if (recordedDeletionEvents.has(event)) return;
    const owner: DurableEventOwner = { kind: 'session', id: event.sessionId };
    const ownerKey = encodeOwner(owner);
    // AB-384 — keyed by `(id, incarnation)`, not `ownerKey` alone (see this
    // listener's own doc comment above): two different incarnations of the
    // same session id are two independent deletions, never duplicates of
    // each other, even when their writes overlap. `JSON.stringify` of the
    // two-element tuple, not template-string concatenation (Codex P2 review
    // finding, PR #592, "Encode deletion dedupe keys without delimiter
    // collisions"): a plain `${ownerKey}:${incarnation}` is not a unique
    // encoding once an injected `RuntimeIdentifiers.next` policy can emit a
    // colon — `('x:y', 'z')` and `('x', 'y:z')` would both concatenate to
    // the same string. `JSON.stringify` escapes each element's own
    // delimiter-like characters, so distinct tuples always serialize to
    // distinct strings.
    const dedupeKey = JSON.stringify([ownerKey, event.incarnation]);
    if (pendingSessionDeletionWrites.has(dedupeKey)) return;
    trackWrite(ownerKey, () => {
      const write = history
        .record(
          owner,
          'session.deleted',
          {
            sessionId: event.sessionId,
            incarnation: event.incarnation,
          },
          {
            // AB-389 — the outbox entry's own ordinal, so a redelivery of
            // the SAME entry (a crash between this write settling and the
            // outbox drain acknowledging it, or two drains racing) is a
            // no-op read instead of a second durable record — see
            // `record()`'s own doc comment for the general mechanism.
            //
            // AB-388: `event.committedAtMs` — the outbox entry's own
            // authoritative commit time — is used here directly rather
            // than the shared `eventTimestamp` resolver this file's other
            // dedicated listeners (`schedule.*`) use: this event is
            // dispatched by a REPLAYED outbox drain, possibly long after
            // its real commit, so a fresh `runtime.clock.now()` read at
            // dispatch time would misdate it. `audit-trail.ts`'s own
            // `sessionDeletedListener` reads the SAME `event.committedAtMs`
            // for the identical reason, so the two records still never
            // diverge — just by each independently reading the same
            // event field, rather than through the shared resolver.
            dedupeKey: String(event.ordinal),
            emittedAtMs: event.committedAtMs,
          },
        )
        .then(
          () => {
            // Only remember this event as handled on SUCCESS (Codex review
            // finding, PR #580, "Allow retries after a failed deletion
            // write"): marking it before the write even started would
            // permanently block a legitimate retry of the SAME event object
            // after a transient storage failure recovers — the in-flight map
            // above already prevents a genuinely concurrent duplicate from
            // starting a second write while this one is pending, so nothing
            // is lost by waiting for success here.
            recordedDeletionEvents.add(event);
          },
          (error: unknown) => {
            diagnose({
              level: 'error',
              scope: 'durable-event-history',
              message: `[durable-event-history] Failed to record durable event "session.deleted" for ${owner.kind}:${owner.id}:`,
              cause: error,
            });
          },
        );
      pendingSessionDeletionWrites.set(dedupeKey, write);
      void write.finally(() => {
        if (pendingSessionDeletionWrites.get(dedupeKey) === write) {
          pendingSessionDeletionWrites.delete(dedupeKey);
        }
      });
      return write;
    });
  };
  bureau.addEventListener('session.deleted', sessionDeletedListener);

  // AB-384, re-scoped by AB-389 — `SessionCreatedEvent`/`SessionSavedEvent`
  // (and `SessionDeletedEvent` above) are no longer dispatched directly by
  // a live commit; Bureau's own outbox drain loop (`create-bureau.ts`)
  // replays each persisted `SessionOutboxEntry` as the matching event,
  // dispatched onto this SAME bureau-level emitter, in ordinal order. No
  // in-flight dedupe by object identity is needed here the way
  // `sessionDeletedListener` above still keeps one for `session.deleted`:
  // the `dedupeKey` on `record()`'s payload below is what makes a
  // redelivery of the SAME outbox entry (a crash-recovery replay, or two
  // drains racing over one shared backend) a no-op read instead of a
  // second durable record — see `record()`'s own doc comment.
  const sessionCreatedListener = (event: SessionCreatedEvent): void => {
    if (signal?.aborted) return;
    sink(
      { kind: 'session', id: event.sessionId },
      'session.created',
      {
        sessionId: event.sessionId,
        agentName: event.agentName,
        incarnation: event.incarnation,
      },
      { dedupeKey: String(event.ordinal), emittedAtMs: event.committedAtMs },
    );
  };
  const sessionSavedListener = (event: SessionSavedEvent): void => {
    if (signal?.aborted) return;
    sink(
      { kind: 'session', id: event.sessionId },
      'session.saved',
      {
        sessionId: event.sessionId,
        agentName: event.agentName,
        incarnation: event.incarnation,
      },
      { dedupeKey: String(event.ordinal), emittedAtMs: event.committedAtMs },
    );
  };
  bureau.addEventListener('session.created', sessionCreatedListener);
  bureau.addEventListener('session.saved', sessionSavedListener);

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
    async waitForAllActiveWrites(): Promise<void> {
      if (activeWrites.size === 0) return;
      await Promise.allSettled([...activeWrites]);
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
      bureau.removeEventListener('session.created', sessionCreatedListener);
      bureau.removeEventListener('session.saved', sessionSavedListener);
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
