/**
 * Audit trail — Layer B (durable append-only trail).
 *
 * Sinks `tool.*`, memory-write, and run-transition events from the bureau's
 * action stream into the KV store as an append-only audit log under the
 * `audit:v1:` prefix. The trail survives process restarts and outlives the
 * in-memory operative/store ring buffer (`maxActions`).
 *
 * Key schema: `audit:v1:<timestamp-padded>:<sequence>` so natural sort order
 * is chronological. Values are JSON-serialized {@link AuditRecord}.
 *
 * Layer A (live) is the operative/store; Layer B is this trail. Together they
 * form the glass-box audit surface for the gateway.
 */
import type {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  SessionDeletedEvent,
} from '@lostgradient/operative';
import type { TextValueStore } from '@lostgradient/weft/storage';
import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

import type { AgentDefinitions } from './agent-catalog';
import { resolveDiagnosticSink, serializeActionDetail } from './serialization';
import type { Bureau, DiagnosticSink } from './types';

// ── Public surface ──────────────────────────────────────────────────

/**
 * Event types that are sunk into the durable audit trail.
 *
 * AB-228 closed the parity gaps AB-87's durability matrix named against the
 * original eight-entry list (`tool.started`/`settled`/`error`,
 * `run.completed`/`error`/`aborted`/`tripwire`, `step.completed`). Two of
 * the new entries below reach this trail through the SAME `'action'`-stream
 * listener the original eight do; three reach it through dedicated
 * bureau-level listeners this file also had to add, because their source
 * events never traverse `'action'` at all:
 *
 * - `session.deleted` — NOT already reachable when this issue started,
 *   despite `SESSION_DURABLE_ACTION_TYPES` in `durable-event-history.ts`
 *   listing it: that array only describes what a producer would forward IF
 *   something dispatched it, and a repo-wide production search (Codex
 *   review, PR #566) found no such dispatch anywhere — `deleteSession`
 *   deleted the session without ever emitting a `session.deleted` fact of
 *   any kind. Fixed as part of closing this gap, not merely worked around:
 *   `deleteSession` (`create-bureau.ts`) now dispatches `SessionDeletedEvent`
 *   directly on the bureau-level emitter once a live session is actually
 *   deleted (no run necessarily exists to anchor an `'action'`-stream
 *   record to, so `store.recordAction` — which silently no-ops for any
 *   runId not currently live — was not an option); this file's dedicated
 *   `sessionDeletedListener` below turns that into a durable record the
 *   same way the schedule-definition listeners do. This closes the gap for
 *   THIS trail only — `durable-event-history.ts`'s own `'action'`-stream
 *   producer still has no listener for a directly-dispatched
 *   `SessionDeletedEvent`, so AB-313's deleted-aggregate detection for
 *   sessions remains synthetic-only in its own tests; that is a separate
 *   file and a separate durable layer, out of this issue's
 *   `AUDIT_EVENT_TYPES` boundary, and is flagged as a follow-up.
 * - `budget.exceeded` — `BudgetExceededEvent`
 *   (`packages/operative/src/events.ts`) is a real `OperativeEventMap`
 *   member and, if ever dispatched, would reach `'action'` the same way.
 *   Verified (`grep -rn "new BudgetExceededEvent" packages`, non-test files
 *   only): NOTHING dispatches THAT SPECIFIC CLASS in production, and that
 *   part is a SETTLED non-gap — AB-231 (merged, `bbfe5178`) considered this
 *   exact question and chose a different path: it reclassifies a
 *   toolbox-level budget rejection to `BudgetExceededError` inside
 *   `run-step.ts`, upstream of `run.completed`'s `finishReason`
 *   classification, specifically so the run terminates with
 *   `finishReason: 'budget-exceeded'` — never by dispatching
 *   `BudgetExceededEvent`. That terminal `run.completed` record is already
 *   durably audited (it was one of the original eight entries). This entry
 *   is listed for allowlist completeness against AB-87's matrix and costs
 *   nothing (there is nothing to filter in), but `BudgetExceededEvent`
 *   itself is orphaned production code post-AB-231 — flagged as a
 *   follow-up (dispatch it for real, since it's still exported public
 *   surface of `@lostgradient/operative`, `packages/operative/src/index.ts`
 *   — removing it would be a breaking change, not a same-PR cleanup)
 *   rather than fixed here, which is out of this child's
 *   `packages/bureau`-only boundary. That verification, though, only
 *   covered the bare operative event class — it MISSED a completely
 *   different, real production path (Codex review finding, PR #566):
 *   armorer's toolbox itself emits its OWN `'budget-exceeded'` event
 *   (`ToolboxBudgetExceededEvent`, `create-toolbox.ts`'s `checkBudget`
 *   rejection) whenever a toolbox call exceeds its configured
 *   calls/time/cost budget — forwarded with the `toolbox.` prefix the same
 *   way `loop-warning`/`loop-blocked` are (see the very next bullet), so
 *   the real wire string is `toolbox.budget-exceeded`, never `budget.exceeded`.
 *   That IS a real, currently-reachable production emission this trail was
 *   missing — see `toolbox.budget-exceeded` below, added alongside the
 *   loop-detection pair for exactly this reason.
 * - `toolbox.loop-warning` / `toolbox.loop-blocked` / `toolbox.budget-exceeded`
 *   — AB-87's prose names the first two `loop-warning`/`loop-blocked`; the
 *   bare type strings `ToolboxLoopWarningEvent`/`ToolboxLoopBlockedEvent`/
 *   `ToolboxBudgetExceededEvent` (`packages/armorer/src/events.ts`) carry
 *   at the armorer layer. But EVERY toolbox event is re-dispatched onto the
 *   run's own emitter with a `toolbox.` prefix (`forwardEvents`,
 *   `packages/operative/src/toolbox-event-forwarding.ts`) before the
 *   operative store turns it into an `Action` — so the strings that
 *   actually reach this trail's `'action'` listener are
 *   `toolbox.loop-warning`/`toolbox.loop-blocked`/`toolbox.budget-exceeded`.
 *   The bare, un-prefixed names would never match a real `action.type` and
 *   were deliberately NOT used here.
 * - `schedule.created` / `schedule.paused` / `schedule.resumed` /
 *   `schedule.cancelled` — the four schedule-DEFINITION lifecycle events
 *   AB-223/`ab90-03` actually built (verified:
 *   `grep -rn "'schedule.deleted'\|ScheduleDeletedEvent" packages` — zero
 *   matches; a `schedule.deleted` event, which AB-87's own summary sentence
 *   never names either ("schedule pause/resume/cancel", three, not four),
 *   does not exist anywhere in the codebase and was NOT invented for this
 *   allowlist). All four are dispatched directly on the bureau-level
 *   emitter (`create-bureau.ts`'s `createSchedule`/`pauseSchedule`/
 *   `resumeSchedule`/`cancelSchedule`) and never traverse `'action'` at
 *   all — see this file's own schedule listeners below, added specifically
 *   to reach them. `schedule.created` is durable via a SECOND mechanism
 *   too (AB-91/AB-320's `FleetEventFeed`-backed `durable-event-history.ts`
 *   already records it under the same `{ kind: 'schedule', id }` owner
 *   shape this file's synthetic `schedule:<id>` runId mirrors) — that does
 *   not make it redundant here: this trail and that one are independent
 *   durable layers with independent retention/query surfaces, and a
 *   schedule's own postmortem page in THIS trail would otherwise carry
 *   pause/resume/cancel with no creation marker.
 *
 * `review.*` (AB-87's "review decisions taken through the live path") is
 * NOT represented here at all, on purpose: every one of the seven
 * `ReviewStatus` outcomes (`approved`/`denied`/`rejected`/`expired`/
 * `revoked`/`canceled`/`superseded`) already reaches this trail's durable
 * write today, via `create-bureau.ts`'s `recordReviewDecision`/
 * `recordReviewStatusTransition` calling `AuditTrail.record()` directly
 * (the SAME out-of-band path `resolveReview`'s approve/deny always used) —
 * this bypasses `AUDIT_EVENT_TYPES` entirely, by design (see
 * {@link AuditTrail.record}'s own doc comment). Those durable writes use
 * `review.<kind>.<status>` (kind-namespaced) type strings, never the bare
 * `review.<status>` AB-87's prose uses for the LIVE event family
 * (`ReviewApprovedEvent` et al., AB-224) — so no bare `review.*` string
 * belongs in this array; it would never match a record this trail ever
 * writes. Confirmed durably queryable today for all seven statuses in
 * `create-bureau.test.ts`.
 */
export const AUDIT_EVENT_TYPES = [
  // Tool lifecycle
  'tool.started',
  'tool.settled',
  'tool.error',
  // Run lifecycle transitions
  'run.completed',
  'run.error',
  'run.aborted',
  'run.tripwire',
  // Step lifecycle
  'step.completed',
  // AB-228 — session lifecycle beyond creation (dispatched via a dedicated
  // listener below, never through 'action').
  'session.deleted',
  // AB-228 — budget accounting (no production emitter; see doc comment).
  'budget.exceeded',
  // AB-228 — toolbox-level safety events, under their forwarded wire strings.
  'toolbox.loop-warning',
  'toolbox.loop-blocked',
  // AB-228 (Codex P2 review finding, PR #566) — the toolbox's OWN real
  // budget-exceeded emission, distinct from the orphaned bare
  // `budget.exceeded` above; see this array's own doc comment.
  'toolbox.budget-exceeded',
  // AB-228 — schedule-definition lifecycle (dispatched via dedicated
  // listeners below, never through 'action').
  'schedule.created',
  'schedule.paused',
  'schedule.resumed',
  'schedule.cancelled',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** A single entry in the durable audit log. */
export interface AuditRecord {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Epoch milliseconds (for range queries). */
  timestampMs: number;
  /** Monotonically increasing per-process counter from the operative store. */
  sequence: number;
  /** The originating run id. */
  runId: string;
  /** The event type (one of {@link AuditEventType}). */
  type: string;
  /** Serializable detail snapshot from the operative store's action. */
  detail: unknown;
  /**
   * The authenticated principal attributed with this record (e.g.
   * `api-key:<id>` or `static-token`). Only present on records written via
   * {@link AuditTrail.record} — out-of-band human decisions (AB-20 review
   * queue approve/deny). Bureau-action-stream records (`tool.*`, `run.*`,
   * `step.completed`, `budget.exceeded`,
   * `toolbox.loop-warning`/`loop-blocked`/`budget-exceeded`) have no principal; they are
   * attributed to the run. The AB-228 `schedule.*` and `session.deleted`
   * listeners below also write through the out-of-band path but likewise
   * carry no principal — a schedule pause/resume/cancel, or a session
   * deletion, has no authenticated caller to attribute today.
   */
  principal?: string;
}

/**
 * Query options for {@link AuditTrail.query}.
 *
 * All filters are AND-ed together. Omitting a filter means "no restriction".
 */
export interface AuditQueryOptions {
  /** Only records at or after this epoch-millisecond timestamp. */
  since?: number;
  /** Only records whose `runId` matches this run. */
  runId?: string;
  /** Only records whose `type` equals this string. */
  type?: string;
  /** Maximum number of records to return. Defaults to 500. */
  limit?: number;
}

/**
 * The audit trail object returned by {@link createAuditTrail}. Call
 * `dispose()` to unsubscribe from the bureau's action stream.
 */
export interface AuditTrail {
  /**
   * Query the durable trail. Returns records in chronological order (oldest
   * first) matching all supplied filters. Falls back to an empty array when
   * no KV store is available (non-persistent bureau).
   */
  query(options?: AuditQueryOptions): Promise<AuditRecord[]>;
  /**
   * Write an out-of-band record directly into the durable trail, bypassing the
   * bureau action-stream listener. Used by `resolveReview` (AB-20 review
   * queue) to attribute a human's approve/deny decision to `entry.principal` —
   * a decision made outside any run's step loop, so it never appears on the
   * bureau's `action` event stream. A no-op when no KV store is configured
   * (ephemeral bureau); the review is still resolved, just not durably
   * recorded — Layer A (live) has no equivalent for out-of-band records.
   */
  record(entry: {
    runId: string;
    type: string;
    detail: unknown;
    principal?: string;
  }): Promise<void>;
  /**
   * Stop listening to bureau events, release the subscription, and await
   * every write already in flight (from the action-stream listener and from
   * {@link record}) before resolving (AB-207). Never rejects — an
   * individual write's own failure is diagnosed by its own `.catch`, not
   * surfaced here. Calling `dispose()` more than once is safe; the second
   * call resolves promptly.
   */
  dispose(): Promise<void>;
}

/** Options for {@link createAuditTrail}. */
export interface AuditTrailOptions {
  /**
   * Owner-issued signal (AB-207/AB-206's same "no `AbortSignal` anywhere"
   * gap, closed for audit writes here). `kv.set` has no cancellation hook,
   * so aborting this signal cannot cancel a write already in flight; once
   * aborted, the listener and {@link AuditTrail.record} refuse to START a
   * new write. `dispose()` still fully awaits every write that was already
   * in flight before the abort.
   */
  signal?: AbortSignal;
}

// ── Key encoding ────────────────────────────────────────────────────

const PREFIX = 'audit:v1:';

/**
 * Encode a key so chronological sort is lexicographic. Exported so a reader
 * of an already-queried {@link AuditRecord} (AB-263's Bureau-scoped
 * audit-write fault selector, `packages/bureau/src/test/fault-plan.ts`) can
 * reconstruct the exact key a record was written under from its own public
 * fields (`timestampMs`, `sequence`, `runId`) — never a second, drifting
 * reimplementation of this encoding.
 */
export function encodeKey(timestampMs: number, sequence: number, runId: string): string {
  // 16-digit zero-padded timestamp covers dates through year 9999.
  // Append the sequence number (within-millisecond tiebreak) and the runId
  // (cross-process-lifetime tiebreak) so the full key is globally unique.
  //
  // Why runId is required: `sequence` is a per-store-lifetime counter that resets
  // to 0 on every process restart. A clock rewind (NTP step-back, VM snapshot
  // restore, manual clock set) after restart means a new event can share both
  // `timestamp` and `sequence` with a previously-persisted record, silently
  // overwriting it and violating the append-only invariant. Including `runId` —
  // which is derived from sessionId + run-sequence and thus unique across
  // restarts — makes collision impossible: two keys can match only if they share
  // the same runId, which only occurs for the *same* run, whose new events land
  // at strictly later timestamps due to Weft's replay ordering.
  const ts = timestampMs.toString().padStart(16, '0');
  const seq = sequence.toString().padStart(12, '0');
  return `${PREFIX}${ts}:${seq}:${runId}`;
}

// ── Audit trail factory ─────────────────────────────────────────────

/**
 * Creates an audit trail attached to the given bureau.
 *
 * When `kv` is provided (bureau has `.persistence()`), sinks qualifying
 * action events into the KV store. When `kv` is absent, the trail still
 * subscribes (so `dispose()` is always safe) but writes nowhere — the
 * glass-box audit surface is Layer A only.
 *
 * @param bureau - The bureau to observe.
 * @param kv - The KV store to persist audit records into. `undefined` when
 *   the bureau has no persistence configured.
 * @param onDiagnostic - Host sink for operational diagnostics (persistence
 *   failures). Omit to log to the console, matching prior behavior.
 */
export function createAuditTrail<D extends AgentDefinitions = AgentDefinitions>(
  bureau: Bureau<D>,
  kv: TextValueStore | undefined,
  onDiagnostic?: DiagnosticSink,
  auditTrailOptions?: AuditTrailOptions,
  // AB-260: the bureau's single composed `RuntimeServices` instance. Defaults
  // to the real-globals runtime so every pre-existing direct caller of this
  // exported factory (including this package's own test suite) is
  // unaffected by construction.
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): AuditTrail {
  const diagnose = resolveDiagnosticSink(onDiagnostic);
  const signal = auditTrailOptions?.signal;
  // Determine which event types qualify as audit events.
  const auditEventSet = new Set<string>(AUDIT_EVENT_TYPES);

  // Every write kicked off by the listener or by `record()`, so `dispose()`
  // can await terminal state deterministically (AB-207) rather than leaving
  // an in-flight `kv.set` unobserved.
  const activeWrites = new Set<Promise<void>>();
  function trackWrite(promise: Promise<void>): void {
    activeWrites.add(promise);
    void promise.finally(() => activeWrites.delete(promise));
    // AB-260: layered on top of `activeWrites` (never replacing it) — every
    // audit write also registers with the bureau's composed
    // `RuntimeServices.deferred`, so `deferred.drain()` reports it under the
    // stable `'audit-write'` label alongside every other subsystem's
    // fire-and-forget work.
    runtime.deferred.track(promise, 'audit-write');
  }

  // Out-of-band records (via `record()`) have no operative store `Action` to
  // draw a `sequence` from — they happen outside any run's step loop.
  // `encodeKey` zero-pads `sequence` as an unsigned decimal, so the counter
  // must stay non-negative for the lexicographic key sort to hold, and
  // `query()`/`/api/v1/audit` order ties by ASCENDING sequence — so it must
  // count UP (not down) for later same-millisecond records to sort after
  // earlier ones. Starting well below `Number.MAX_SAFE_INTEGER` (10 billion
  // of headroom — far more manual records than any process could plausibly
  // emit) keeps every value in that same large, real-action-sequence-proof
  // range (the store's own sequence always starts at 0) while leaving room
  // to increment without exceeding `MAX_SAFE_INTEGER`.
  let manualSequence = Number.MAX_SAFE_INTEGER - 10_000_000_000;

  // Subscribe to the bureau's action stream. The bureau re-emits every
  // operative store action as an ActionEvent, so we don't need to reach into
  // the store directly — the event surface is the intended integration point.
  const listener = (event: import('./events').ActionEvent) => {
    const { action } = event;
    if (!auditEventSet.has(action.type)) return;
    if (!kv) return;
    // AB-207: once the owner-issued signal aborts (Bureau's shutdown() has
    // begun), refuse new writes — a write already in flight (tracked below)
    // still runs to completion and `dispose()` still awaits it.
    if (signal?.aborted) return;

    // Serialize the detail through the same pipeline used for WebSocket frames:
    // strips Conversation instances, serializes Error objects, and removes
    // other non-JSON-safe values so the record is safe to JSON.stringify.
    const serializedDetail = serializeActionDetail(action.type, action.detail);

    const record: AuditRecord = {
      timestamp: new Date(action.timestamp).toISOString(),
      timestampMs: action.timestamp,
      sequence: action.sequence,
      runId: action.runId,
      type: action.type,
      detail: serializedDetail,
    };

    const key = encodeKey(action.timestamp, action.sequence, action.runId);
    // Fire-and-forget from the run's perspective: a write failure must never
    // crash the run, so nothing here is awaited inline. Tracked in
    // `activeWrites` so `dispose()` can await it (AB-207) instead of racing
    // storage closure against a write still in flight.
    trackWrite(
      kv.set(key, JSON.stringify(record)).catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'audit-trail',
          message: `[audit-trail] Failed to persist audit record for key "${key}":`,
          cause: error,
        });
      }),
    );
  };

  bureau.addEventListener('action', listener);

  // Shared write path behind both the public out-of-band `record()` below
  // and the schedule-definition listeners further down (AB-228) — the same
  // manual-sequence-numbered, out-of-band key encoding, since neither has an
  // operative-store `Action` to draw a `sequence`/`timestamp` from. Returns
  // the write promise (already tracked in `activeWrites`) so both callers
  // can await it.
  function writeOutOfBandRecord(entry: {
    runId: string;
    type: string;
    detail: unknown;
    principal?: string;
  }): Promise<void> {
    if (!kv) return Promise.resolve();
    if (signal?.aborted) return Promise.resolve();

    const timestampMs = runtime.clock.now();
    const sequence = manualSequence++;

    const record: AuditRecord = {
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      sequence,
      runId: entry.runId,
      type: entry.type,
      detail: entry.detail,
      ...(entry.principal !== undefined ? { principal: entry.principal } : {}),
    };

    const key = encodeKey(timestampMs, sequence, entry.runId);
    const writePromise = kv.set(key, JSON.stringify(record)).catch((error: unknown) => {
      // Best-effort, matching the action-stream listener above: a write
      // failure must never fail the caller (an approve/deny decision, or a
      // schedule pause/resume/cancel).
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[audit-trail] Failed to persist audit record for key "${key}":`,
        cause: error,
      });
    });
    // Tracked (AB-207) in addition to being returned: a caller that does not
    // await the result must not strand this write past `dispose()`.
    trackWrite(writePromise);
    return writePromise;
  }

  // AB-228 — schedule-DEFINITION lifecycle listeners. `pauseSchedule`/
  // `resumeSchedule`/`cancelSchedule` (`create-bureau.ts`) dispatch these
  // directly on the bureau-level emitter; they never traverse the `'action'`
  // stream the listener above subscribes through (same reason `schedule.*`
  // needs its own listeners in `durable-event-history.ts`'s producer), so
  // without a dedicated subscription here they would never reach this
  // trail no matter what `AUDIT_EVENT_TYPES` lists. Each is still gated on
  // `auditEventSet` so the array stays the single source of truth for what
  // this trail durably records. There is no run for a schedule DEFINITION
  // event to attribute to, so the schedule id is encoded into `runId` as
  // `schedule:<scheduleId>` — `AuditRecord.runId` and `encodeKey` require a
  // string but never validate that it names a real run; `query({ runId:
  // \`schedule:${id}\` })` is how a caller retrieves one schedule's own
  // durable definition history.
  function scheduleOwnerId(scheduleId: string): string {
    return `schedule:${scheduleId}`;
  }
  const scheduleCreatedListener = (event: AgentScheduledEvent): void => {
    if (!auditEventSet.has('schedule.created')) return;
    void writeOutOfBandRecord({
      runId: scheduleOwnerId(event.scheduleId),
      type: 'schedule.created',
      detail: {
        scheduleId: event.scheduleId,
        agentName: event.agentName,
        spec: event.spec,
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      },
    });
  };
  const schedulePausedListener = (event: SchedulePausedEvent): void => {
    if (!auditEventSet.has('schedule.paused')) return;
    void writeOutOfBandRecord({
      runId: scheduleOwnerId(event.scheduleId),
      type: 'schedule.paused',
      detail: { scheduleId: event.scheduleId },
    });
  };
  const scheduleResumedListener = (event: ScheduleResumedEvent): void => {
    if (!auditEventSet.has('schedule.resumed')) return;
    void writeOutOfBandRecord({
      runId: scheduleOwnerId(event.scheduleId),
      type: 'schedule.resumed',
      detail: { scheduleId: event.scheduleId },
    });
  };
  const scheduleCancelledListener = (event: ScheduleCancelledEvent): void => {
    if (!auditEventSet.has('schedule.cancelled')) return;
    void writeOutOfBandRecord({
      runId: scheduleOwnerId(event.scheduleId),
      type: 'schedule.cancelled',
      detail: { scheduleId: event.scheduleId },
    });
  };
  bureau.addEventListener('schedule.created', scheduleCreatedListener);
  bureau.addEventListener('schedule.paused', schedulePausedListener);
  bureau.addEventListener('schedule.resumed', scheduleResumedListener);
  bureau.addEventListener('schedule.cancelled', scheduleCancelledListener);

  // AB-228 (Codex P1 review finding, PR #566) — session-deletion listener.
  // `deleteSession` (`create-bureau.ts`) dispatches `SessionDeletedEvent`
  // directly on the bureau-level emitter, never through `'action'` (a
  // deleted session may own zero live runs, and `store.recordAction`
  // silently no-ops for any runId not currently in `store.runs`), so this
  // needs the same dedicated-listener treatment as the schedule-definition
  // events above. There is no run to attribute a session deletion to
  // either, so the session id is encoded into `runId` the same way the
  // schedule owner is: `session:<sessionId>` — `query({ runId:
  // `session:${id}` })` retrieves one session's own durable deletion record.
  function sessionOwnerId(sessionId: string): string {
    return `session:${sessionId}`;
  }
  const sessionDeletedListener = (event: SessionDeletedEvent): void => {
    if (!auditEventSet.has('session.deleted')) return;
    void writeOutOfBandRecord({
      runId: sessionOwnerId(event.sessionId),
      type: 'session.deleted',
      detail: { sessionId: event.sessionId },
    });
  };
  bureau.addEventListener('session.deleted', sessionDeletedListener);

  return {
    async record(entry: {
      runId: string;
      type: string;
      detail: unknown;
      principal?: string;
    }): Promise<void> {
      await writeOutOfBandRecord(entry);
    },

    async query(options: AuditQueryOptions = {}): Promise<AuditRecord[]> {
      if (!kv) return [];

      const { since, runId, type, limit = 500 } = options;

      // List all audit keys under the prefix, then filter. For large logs a
      // range-prefix trick could narrow further (the timestamp is the first
      // segment after the prefix), but correctness-first: list all, filter in
      // memory. Suitable for per-run/per-session audit volumes.
      const keys = await kv.list(PREFIX);

      const records: AuditRecord[] = [];
      for (const key of keys) {
        const raw = await kv.get(key);
        if (!raw) continue;

        let record: AuditRecord;
        try {
          record = JSON.parse(raw) as AuditRecord;
        } catch {
          continue;
        }

        if (since !== undefined && record.timestampMs < since) continue;
        if (runId !== undefined && record.runId !== runId) continue;
        if (type !== undefined && record.type !== type) continue;

        records.push(record);

        // Apply the limit AFTER filtering so we count only records that match all
        // predicates. Stopping before filtering would cause the loop to break on
        // non-matching records and miss in-range entries later in the key scan.
        if (records.length >= limit) break;
      }

      return records;
    },

    async dispose(): Promise<void> {
      bureau.removeEventListener('action', listener);
      bureau.removeEventListener('schedule.created', scheduleCreatedListener);
      bureau.removeEventListener('schedule.paused', schedulePausedListener);
      bureau.removeEventListener('schedule.resumed', scheduleResumedListener);
      bureau.removeEventListener('schedule.cancelled', scheduleCancelledListener);
      bureau.removeEventListener('session.deleted', sessionDeletedListener);
      // Await every write already in flight (AB-207) — `kv.set` has no
      // cancellation hook, so there is nothing for the owner-issued `signal`
      // to bound here beyond refusing new writes (above); a write already
      // started runs to completion and `dispose()` waits for it.
      await Promise.allSettled([...activeWrites]);
    },
  };
}
