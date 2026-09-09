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
import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import { createDefaultRuntimeServices, type RuntimeServices } from 'lifecycle';

import type { AgentDefinitions } from './agent-catalog';
import type { EventTimestampResolver } from './event-timestamp';
import {
  resolveDiagnosticSink,
  serializeActionDetail,
  serializeUnknownError,
} from './serialization';
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

/**
 * AB-388: retention policy for {@link AuditTrail.prune}. `'forever'` (the
 * default everywhere this type is consumed) means no record is ever pruned
 * — today's unbounded behavior, unchanged until an operator opts in.
 * `{ olderThan }` prunes any record whose `timestampMs` is more than
 * `olderThan` milliseconds before the pruning pass's own clock reading —
 * see `create-bureau.ts`'s `pruneAuditTrail` for how that cutoff is further
 * clamped to never remove a record the Weft fleet feed's own retention
 * floor still protects.
 */
export type AuditRetentionOption = 'forever' | { olderThan: number };

/** The outcome of one {@link AuditTrail.prune} pass. */
export interface AuditPruneResult {
  /** How many records this pass deleted. Zero when nothing qualified. */
  prunedCount: number;
  /** The effective cutoff this pass pruned against (epoch milliseconds). */
  cutoffMs: number;
}

/** A single entry in the durable audit log. */
export interface AuditRecord {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Epoch milliseconds (for range queries). */
  timestampMs: number;
  /**
   * AB-370: one monotonic sequence counter shared by every write path this
   * trail has — the action-stream listener below AND every out-of-band write
   * (`record()`, the schedule-definition listeners, `sessionDeletedListener`)
   * all draw the next value from the SAME per-bureau counter (see
   * `allocateSequence` in {@link createAuditTrail}), seeded above the highest
   * sequence already persisted at boot (`computeInitialAuditSequence`, called
   * by `create-bureau.ts` before this factory runs). Before this change,
   * action-stream records carried the operative store's own per-process
   * `action.sequence` while out-of-band records carried a deliberately huge,
   * disjoint `manualSequence` — two numbering domains that could never be
   * compared for true relative order, so a `session.deleted` record and a
   * released run's own terminal action landing in the same millisecond had
   * no way to record which one genuinely happened first (see AB-228's
   * `create-bureau.ts` comment this fix replaces). Because every write now
   * draws from one counter at the moment it is dispatched (before the
   * fire-and-forget `kv.set` even starts), the persisted value reflects true
   * call order regardless of which write's `kv.set` promise happens to
   * settle first.
   *
   * Optional because a record written before this field existed at all
   * carries none — {@link AuditTrail.query} falls back to timestamp-only
   * ordering for those, exactly as it did before this field was introduced;
   * see the schema-versioning note in `packages/bureau/README.md`.
   */
  sequence?: number;
  /**
   * AB-370: the originating operative-store `Action`'s own per-process
   * `sequence` (`action.sequence`) — present ONLY on records the
   * action-stream listener below writes, never on an out-of-band record
   * (there is no `Action` to draw one from). This is a different number
   * than {@link sequence} above and exists for a different reason: it lets a
   * consumer correlate a durable record back to the live, in-memory
   * `Action` it was sunk from — the gateway's `GET /api/v1/audit` route
   * dedups its merged live+durable view on this field (`packages/gateway/
   * src/routes/audit.ts`), since the live store's own action log still
   * exposes `action.sequence`, not this trail's shared `sequence`.
   */
  actionSequence?: number;
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
    /**
     * AB-391: the true commit time of the fact this record describes, for a
     * caller replaying a previously-appended `session.attachment` outbox
     * entry (`create-bureau.ts`'s `drainOutbox`) long after that entry was
     * committed — a delayed drain, or a replay after a process restart.
     * Defaults to `runtime.clock.now()`, matching every direct (non-replay)
     * caller.
     */
    timestampMs?: number;
    /**
     * AB-391 (Codex review finding, PR #601, "Make attachment replay
     * deduplication atomic"): when provided, this write is dedupe-guarded
     * by an atomic storage-level compare-and-swap on a marker key derived
     * from `dedupeKey` — mirroring {@link DurableEventRecordOptions.dedupeKey}
     * (`durable-event-history.ts`) — rather than this trail's own
     * `sequence`, which always mints a fresh value and so can never by
     * itself prevent two callers racing to record the identical fact (this
     * is exactly the case `create-bureau.ts`'s outbox attachment replay
     * needs: two Bureau processes both reclaiming the same outbox entry
     * after a lease renewal race must never BOTH durably record it). A
     * caller supplying `dedupeKey` gets the ATOMICITY, and also opts into
     * this call's returned promise REJECTING on a genuine storage failure
     * (unlike the default best-effort `record()` path, which never
     * rejects) — the caller is expected to leave its own outer unit of
     * work (an outbox entry) unacknowledged and retry on that rejection,
     * exactly the "leave it pending" contract the read-before/verify-after
     * pattern this replaces used to provide, just without the race. This
     * REJECTS on an already-aborted shutdown signal too, rather than
     * silently resolving the way every other out-of-band write does post-
     * shutdown — a silent no-op here would be indistinguishable from
     * "already recorded" to a caller like `drainOutboxAttachmentEntry`,
     * which would then acknowledge an entry whose fact was never actually
     * written, reintroducing the exact durable-record loss this issue
     * exists to close (just at shutdown instead of a crash).
     */
    dedupeKey?: string;
  }): Promise<void>;
  /**
   * AB-388: delete every durable record whose `timestampMs` is strictly
   * before `cutoffMs`, EXCEPT one whose `runId` satisfies
   * `pruneOptions.protectRunId` (if supplied) — see that option's own doc
   * comment. The caller (`create-bureau.ts`'s `pruneAuditTrail`) computes
   * `cutoffMs` already clamped to the fleet feed's own global retention
   * floor timestamp, but a single scalar cutoff cannot express "protect
   * THIS owner's entire history" when that owner's only currently-retained
   * durable event is a single, later terminal transition — `protectRunId`
   * closes that gap. A no-op, returning `undefined`, when no KV store is
   * configured (ephemeral bureau, nothing to prune).
   *
   * When at least one record is pruned, persists the highest pruned
   * `sequence` (so {@link computeInitialAuditSequence} seeds correctly
   * after a restart even if every remaining record was itself pruned) and
   * writes one out-of-band `audit.pruned` record naming the count and
   * cutoff — skipped when nothing qualified, so a pass with nothing to do
   * does not itself grow the trail it is pruning.
   */
  prune(
    cutoffMs: number,
    pruneOptions?: {
      /**
       * AB-388 (Codex review, PR #597, "Protect earlier audit records for
       * retained owners"): a record whose `runId` this returns `true` for
       * is never pruned, no matter how old `timestampMs` is —
       * `create-bureau.ts`'s `pruneAuditTrail` passes a predicate backed by
       * `eventHistoryInstance.retainedRunOwnerIds()`'s snapshot, so a run
       * whose durable history retains only its own terminal `run.*` event
       * keeps its EARLIER `tool.*`/`step.completed` audit records too,
       * honoring the README's "a retained run history keeps that run's
       * audit records" promise instead of only protecting records at or
       * after the fleet feed's global floor timestamp.
       */
      protectRunId?: (runId: string) => boolean;
    },
  ): Promise<AuditPruneResult | undefined>;
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
  /**
   * AB-370: the value the shared `sequence` counter starts from. Pass
   * {@link computeInitialAuditSequence}'s result (computed by scanning `kv`
   * for the highest already-persisted `sequence`, plus one) so a fresh
   * process never re-issues a value a prior process lifetime already used —
   * the boot test this issue requires. Defaults to `0`, matching a brand
   * new, never-before-persisted trail.
   */
  initialSequence?: number;
  /**
   * AB-388: shared `emittedAtMs` resolver (see `event-timestamp.ts`) — when
   * supplied, the `schedule.*`/`session.deleted` out-of-band listeners
   * below stamp their record with this resolver's reading for the event
   * instance, instead of an independent `runtime.clock.now()` call, so the
   * same event's durable-event-history record (via
   * `createDurableEventProducer`, sharing the SAME resolver instance) never
   * diverges from this audit record's `timestampMs`. Falls back to
   * `runtime.clock.now()` when omitted, matching every prior caller.
   */
  eventTimestamp?: EventTimestampResolver;
}

/**
 * AB-370 (Copilot review finding, PR #594): `encodeKey` bakes `sequence` into
 * the key itself (`audit:v1:<ts16>:<seq>:<runId>`), so
 * {@link computeInitialAuditSequence} can read it straight off a `kv.list()`
 * result WITHOUT a `kv.get` round trip per key — the difference between one
 * network call and `1 + keys.length` on a network-backed `kv` (R2, etc.),
 * which otherwise makes bureau boot time scale with total audit history
 * size. Returns `undefined` for any key that doesn't match this exact,
 * fixed-width shape (wrong prefix, a non-16-digit timestamp segment, or no
 * numeric segment before the next `:`) — safe fallback for the hypothetical
 * "record written before `sequence` existed" case {@link AuditRecord.sequence}'s
 * own doc comment describes, and for anything unrelated an unexpected caller
 * ever wrote under this prefix.
 *
 * `runId` is deliberately NOT parsed by position (it can itself contain
 * `:`, e.g. the synthetic `schedule:<id>`/`session:<id>` owners this file's
 * own listeners use) — this only needs the two FIXED-width segments before
 * it, so runId's own content never matters here.
 */
/**
 * AB-388: parses BOTH fixed-width segments `encodeKey` guarantees —
 * timestamp and sequence — directly from a key, with no I/O. Used by
 * {@link AuditTrail.prune} so a well-formed key can be judged against
 * `cutoffMs` and, if pruned, contribute to the highest-pruned-sequence
 * floor WITHOUT a `kv.get` round trip per key — the same "one network call
 * instead of `1 + keys.length`" saving {@link parseSequenceFromKey} gives
 * {@link computeInitialAuditSequence} (Codex review, PR #594), applied to
 * the prune path this issue adds.
 *
 * A separate function from {@link parseSequenceFromKey} rather than a
 * shared refactor: that function tolerates a non-numeric timestamp
 * segment (it never reads timestamp, only sequence, so it doesn't need
 * to validate one) — changing its tolerance would risk an existing,
 * already-tested fast-path boundary for a caller that has nothing to do
 * with pruning. This function validates BOTH segments as digits, since a
 * pruning decision genuinely needs a numeric `timestampMs` to compare
 * against `cutoffMs` — a key whose timestamp segment fails that check
 * safely falls back to {@link AuditTrail.prune}'s own slow
 * `kv.get`-then-`JSON.parse` path, exactly like an unparseable key does
 * for {@link computeInitialAuditSequence}.
 *
 * Returns `undefined` for any key that doesn't match this exact shape —
 * wrong prefix, a non-16-digit or non-numeric timestamp segment, or no
 * numeric sequence segment before the next `:` — safe fallback for the
 * same edge cases {@link parseSequenceFromKey}'s own doc comment covers.
 *
 * AB-388 (Codex review, PR #597, "Protect earlier audit records for
 * retained owners"): also returns `runId` — everything after the sequence
 * segment, exactly as `encodeKey` appended it, colons and all (a
 * `schedule:<id>`/`session:<id>` synthetic owner embeds its own `:`) — so
 * {@link AuditTrail.prune}'s caller can protect a specific owner's records
 * without a `kv.get`/`JSON.parse` round trip on this fast path either.
 */
function parsePruneCandidateFromKey(
  key: string,
): { timestampMs: number; sequence: number; runId: string } | undefined {
  if (!key.startsWith(PREFIX)) return undefined;
  const rest = key.slice(PREFIX.length);
  const TIMESTAMP_WIDTH = 16;
  if (rest.length <= TIMESTAMP_WIDTH + 1 || rest[TIMESTAMP_WIDTH] !== ':') return undefined;
  const timestampSegment = rest.slice(0, TIMESTAMP_WIDTH);
  if (!/^\d+$/.test(timestampSegment)) return undefined;
  const timestampMs = Number(timestampSegment);
  if (!Number.isSafeInteger(timestampMs)) return undefined;
  const afterTimestamp = rest.slice(TIMESTAMP_WIDTH + 1);
  const nextColon = afterTimestamp.indexOf(':');
  if (nextColon === -1) return undefined;
  const sequenceSegment = afterTimestamp.slice(0, nextColon);
  if (!/^\d+$/.test(sequenceSegment)) return undefined;
  const sequence = Number(sequenceSegment);
  if (!Number.isSafeInteger(sequence)) return undefined;
  const runId = afterTimestamp.slice(nextColon + 1);
  return { timestampMs, sequence, runId };
}

/**
 * AB-388 (Codex review, PR #597, "Validate decoded records before
 * pruning"): a narrowing guard for the slow-path decode both
 * {@link AuditTrail.prune} and {@link AuditTrail.query} use — `JSON.parse`
 * on a value under this trail's prefix can succeed while producing
 * something that is not an {@link AuditRecord} at all (`null`, a string, an
 * array, or an object missing/mistyping one of the fields either caller
 * reads). Casting that result straight to `AuditRecord` and reading a field
 * off it would THROW for such a value, aborting the entire pass/query at
 * that one key — including every record after it in `kv.list()`'s order —
 * rather than skipping just the one corrupt record. `prune()` only ever
 * reads `timestampMs`/`sequence` off the result; `query()` additionally
 * reads `runId`/`type`, both validated here too so the same guard serves
 * both callers.
 */
function isPrunableAuditRecordShape(
  value: unknown,
): value is { timestampMs: number; sequence?: number; runId: string; type: string } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('timestampMs' in value) || typeof value.timestampMs !== 'number') return false;
  if (!('runId' in value) || typeof value.runId !== 'string') return false;
  if (!('type' in value) || typeof value.type !== 'string') return false;
  if ('sequence' in value && value.sequence !== undefined && typeof value.sequence !== 'number') {
    return false;
  }
  return true;
}

function parseSequenceFromKey(key: string): number | undefined {
  if (!key.startsWith(PREFIX)) return undefined;
  const rest = key.slice(PREFIX.length);
  const TIMESTAMP_WIDTH = 16;
  if (rest.length <= TIMESTAMP_WIDTH + 1 || rest[TIMESTAMP_WIDTH] !== ':') return undefined;
  const afterTimestamp = rest.slice(TIMESTAMP_WIDTH + 1);
  const nextColon = afterTimestamp.indexOf(':');
  if (nextColon === -1) return undefined;
  const sequenceSegment = afterTimestamp.slice(0, nextColon);
  if (!/^\d+$/.test(sequenceSegment)) return undefined;
  const parsed = Number(sequenceSegment);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * AB-370: scans every record already persisted under this trail's `kv` and
 * returns the value {@link AuditTrailOptions.initialSequence} should start
 * from — one past the highest `sequence` any record already carries, or `0`
 * when there is no `kv` (ephemeral bureau), no record carries a `sequence`
 * yet, or every scan attempt below fails. `create-bureau.ts` calls this and
 * passes the result into {@link createAuditTrail} BEFORE the trail starts
 * admitting new writes, so the shared counter this issue introduces resumes
 * above anything a prior process lifetime already persisted rather than
 * colliding with it.
 *
 * The fast path ({@link parseSequenceFromKey}) reads every key returned by
 * one `kv.list()` call with no further I/O; a key it cannot parse falls back
 * to reading and JSON-parsing that one record (validated the same way —
 * `Number.isSafeInteger`, non-negative — so a corrupted record whose stored
 * `sequence` is fractional, negative, or astronomically large, e.g. `1e308`,
 * cannot poison the floor: incrementing a value that large no longer even
 * changes it, which would make every write in the same millisecond for the
 * same run collide on the exact same key, Codex P2 review finding, PR
 * #594), mirroring {@link AuditTrail.query}'s own tolerance for a malformed
 * stored record — this is a best-effort scan, not a second source of truth
 * for data integrity.
 *
 * A `kv.get`/`kv.list` failure is retried up to three times (immediate
 * retry, no artificial delay — a genuinely transient blip resolves quickly,
 * and this package's determinism rule rules out a real timer here anyway)
 * before falling back to `0` and diagnosing loudly (Codex review, PR #594,
 * two rounds): the first round's `0` fallback was flagged as unsafe (a scan
 * failure against a store that already holds records could silently
 * reissue a value a prior lifetime used); the fix tried next — seeding from
 * a caller-supplied clock reading instead of `0` — was ALSO flagged as
 * unsafe, correctly: a deployment upgraded from this trail's OWN prior
 * `manualSequence` scheme (seeded near `Number.MAX_SAFE_INTEGER`,
 * ~9×10^15) can already hold out-of-band sequences far ABOVE any real
 * epoch-millisecond clock reading (~1.8×10^12 today), so a clock-based
 * floor is not actually guaranteed to exceed persisted history either —
 * it just LOOKS safe. There is no floor this function can compute or guess
 * that is provably correct without a successful scan, so `0` — the
 * pre-existing, understood fallback every other boot-time KV failure in
 * `create-bureau.ts` already degrades to (diagnose and continue, never
 * hard-fail bureau construction over a single subsystem) — is what it
 * falls back to after retries are exhausted, loudly, rather than a value
 * that merely appears safer. `0` can only misorder two records that
 * collide on the SAME millisecond after a clock rewind — the exact
 * scenario `encodeKey`'s own `runId` segment already guards the append-only
 * invariant against — and never changes order for two records that do not
 * share a millisecond, this issue's own rollback trigger.
 */
export async function computeInitialAuditSequence(
  kv: ConditionalTextValueStore | undefined,
  onDiagnostic?: DiagnosticSink,
): Promise<number> {
  if (!kv) return 0;
  const diagnose = resolveDiagnosticSink(onDiagnostic);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const keys = await kv.list(PREFIX);
      let highest = -1;
      for (const key of keys) {
        const fromKey = parseSequenceFromKey(key);
        if (fromKey !== undefined) {
          if (fromKey > highest) highest = fromKey;
          continue;
        }

        // Fallback for a key this fast path could not parse — read and
        // decode the record the slow way, same as `query()`.
        const raw = await kv.get(key);
        if (!raw) continue;
        try {
          const record = JSON.parse(raw) as AuditRecord;
          if (
            typeof record.sequence === 'number' &&
            Number.isSafeInteger(record.sequence) &&
            record.sequence >= 0 &&
            record.sequence > highest
          ) {
            highest = record.sequence;
          }
        } catch {
          continue;
        }
      }

      // AB-388: a pruning pass can remove EVERY record this scan above
      // would otherwise have seen (the whole trail is older than the
      // configured cutoff), which would leave `highest` at `-1` and make
      // this function return `0` — reissuing sequence values a prior
      // process lifetime already used, exactly the collision
      // `AuditRecord.sequence`'s own doc comment says this function exists
      // to prevent. `AuditTrail.prune` persists the highest sequence it
      // ever deletes under this separate, non-`PREFIX` key precisely so
      // this scan (which only ever sees SURVIVING records) can still
      // recover that watermark. A key under a different top-level prefix
      // than `PREFIX` so `kv.list(PREFIX)` above — and every other
      // `PREFIX`-scoped scan in this file (`query()`) — never encounters
      // it as a bogus "record".
      const prunedFloorRaw = await kv.get(PRUNE_FLOOR_KEY);
      if (prunedFloorRaw) {
        try {
          const prunedFloor: unknown = JSON.parse(prunedFloorRaw);
          if (
            typeof prunedFloor === 'number' &&
            Number.isSafeInteger(prunedFloor) &&
            prunedFloor >= 0 &&
            prunedFloor > highest
          ) {
            highest = prunedFloor;
          }
        } catch {
          // Malformed meta record — ignore it, same tolerance as every
          // other malformed-record fallback in this function.
        }
      }

      return highest + 1;
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[audit-trail] Boot sequence floor scan failed (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        cause: error,
      });
    }
  }
  diagnose({
    level: 'error',
    scope: 'audit-trail',
    message: `[audit-trail] Could not compute the boot sequence floor after ${MAX_ATTEMPTS} attempts; starting the shared counter from 0. This can only misorder two records colliding on the exact same millisecond after a clock rewind — the same residual risk \`encodeKey\`'s own \`runId\` segment already guards the append-only invariant against.`,
  });
  return 0;
}

// ── Key encoding ────────────────────────────────────────────────────

const PREFIX = 'audit:v1:';

/**
 * AB-388: where {@link AuditTrail.prune} persists the highest `sequence` it
 * has ever pruned, so {@link computeInitialAuditSequence} can recover that
 * watermark after a restart even when every record at or below it has since
 * been deleted. Deliberately NOT under {@link PREFIX} — every `PREFIX`-scoped
 * scan in this file (`query()`'s `kv.list(PREFIX)`, `computeInitialAuditSequence`'s
 * own fast-path key parse) must never encounter this key and misread it as a
 * malformed `AuditRecord`.
 */
const PRUNE_FLOOR_KEY = 'audit-retention:v1:highest-pruned-sequence';

/**
 * AB-391 (Codex review finding, PR #601, "Make attachment replay
 * deduplication atomic"): the reserved key prefix for
 * {@link AuditTrail.record}'s `dedupeKey` marker — mirrors
 * `durable-event-history.ts`'s own `DEDUPE_MARKER_PREFIX`. Deliberately NOT
 * under {@link PREFIX}, same reason as {@link PRUNE_FLOOR_KEY}: every
 * `PREFIX`-scoped scan in this file must never encounter one of these
 * markers and misread it as a malformed `AuditRecord`.
 */
const DEDUPE_MARKER_PREFIX = 'audit-dedupe:v1:';

/**
 * AB-388 (Codex review, PR #597, "Commit deletion summaries atomically
 * with deletions"): a durable RECORD OF INTENT, written alongside
 * {@link PRUNE_FLOOR_KEY} before this pass deletes anything, and cleared
 * only after the pass's own `audit.pruned` summary has been durably
 * written. If the process terminates after some `kv.delete()` calls have
 * already committed but before the summary lands, this key survives —
 * the deleted records themselves carry no evidence of their own removal
 * once gone, but this intent record does, letting the NEXT pass emit the
 * missing summary on this pass's behalf before doing any new work of its
 * own. Deliberately NOT under {@link PREFIX}, for the same reason
 * {@link PRUNE_FLOOR_KEY} is not.
 */
const PRUNE_INTENT_KEY = 'audit-retention:v1:prune-intent';

/** The shape persisted at {@link PRUNE_INTENT_KEY}. */
interface PruneIntentValue {
  readonly count: number;
  readonly cutoffMs: number;
}

function isPruneIntentValue(value: unknown): value is PruneIntentValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { count?: unknown }).count === 'number' &&
    typeof (value as { cutoffMs?: unknown }).cutoffMs === 'number'
  );
}

/**
 * AB-388 (Codex review, PR #597, "Coordinate pruning across shared-store
 * instances"): `prunePassQueue` only serializes `prune()` calls made
 * WITHIN one `createAuditTrail()` instance — two Bureau PROCESSES sharing
 * the same KV store (the same supported configuration `SessionStore`
 * already handles via `durableOwnership: { ownership: 'workflow-lease' }`)
 * each construct their OWN queue, so their passes can still overlap: both
 * can list and delete the SAME qualifying keys, and both can race the
 * read-modify-write of {@link PRUNE_FLOOR_KEY}, letting a later-committing
 * pass overwrite a higher watermark with a lower one. A CAS-guarded lease
 * key closes this the same way `SessionStore`'s own leases do: whichever
 * instance's {@link ConditionalTextValueStore.conditionalBatch} commits
 * first holds exclusive pruning rights for the duration of its pass; every
 * other instance's own acquisition attempt fails its precondition and that
 * instance skips this tick entirely (mirroring the in-process overlap
 * guard's own "skip rather than double-run" choice) rather than attempting
 * to merge or partially proceed.
 */
const PRUNE_LEASE_KEY = 'audit-retention:v1:prune-lease';

/**
 * AB-388: how long a held {@link PRUNE_LEASE_KEY} is honored before another
 * instance is allowed to steal it. Set well above
 * `AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS` (`create-bureau.ts`, 5
 * minutes) so a live pass is never preempted mid-flight by a sibling
 * instance's own next tick, while still bounding how long a crash that
 * left the lease held (the crashed process never reached its `finally`
 * release) can block every future pass indefinitely.
 */
const PRUNE_LEASE_TTL_MS = 900_000;

/** The value {@link PRUNE_LEASE_KEY} is written with while a pass holds it. */
interface PruneLeaseValue {
  acquiredAtMs: number;
  token: string;
}

function isPruneLeaseValue(value: unknown): value is PruneLeaseValue {
  if (typeof value !== 'object' || value === null) return false;
  if (!('acquiredAtMs' in value) || typeof value.acquiredAtMs !== 'number') return false;
  if (!('token' in value) || typeof value.token !== 'string') return false;
  return true;
}

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

/**
 * The synthetic `runId` a session deletion's out-of-band audit record is
 * filed under — there is no run to attribute a session deletion to, so the
 * session id is encoded the same way a schedule's own definition events
 * are (`schedule:<id>`). `query({ runId: auditTrailSessionOwnerId(id) })`
 * retrieves one session's own durable deletion record — exported so
 * `create-bureau.ts`'s outbox drain (AB-389) can verify a `session.deleted`
 * replay's audit write actually persisted before acknowledging the outbox
 * entry, using the SAME encoding this module's own listener writes under,
 * rather than a second, drifting literal.
 */
export function auditTrailSessionOwnerId(sessionId: string): string {
  return `session:${sessionId}`;
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
  kv: ConditionalTextValueStore | undefined,
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
  // AB-388: see `event-timestamp.ts` — shared with `createDurableEventProducer`
  // so a `schedule.*`/`session.deleted` event stamped by whichever
  // subsystem's listener runs first is reused by the other, instead of each
  // independently calling `runtime.clock.now()`. Falls back to a
  // per-instance resolver (still `runtime.clock`-backed) when the caller
  // supplies none, so every pre-existing direct caller of this factory is
  // unaffected.
  const eventTimestamp: EventTimestampResolver =
    auditTrailOptions?.eventTimestamp ?? (() => runtime.clock.now());
  // Determine which event types qualify as audit events.
  const auditEventSet = new Set<string>(AUDIT_EVENT_TYPES);

  // Every write kicked off by the listener or by `record()`, so `dispose()`
  // can await terminal state deterministically (AB-207) rather than leaving
  // an in-flight `kv.set` unobserved.
  const activeWrites = new Set<Promise<void>>();
  // AB-228 (Codex P2 review finding, PR #566, "Avoid blocking every audit
  // query on unrelated writes"): `query()` needs read-your-writes against
  // the SPECIFIC owner (`runId`, or the synthetic `schedule:<id>`/
  // `session:<id>` owner) a caller is asking about, not against every
  // write in flight anywhere in the process. Draining the global
  // `activeWrites` set (the first cut of this fix) made one unrelated
  // stalled write — a slow storage backend, any run's own write — hang
  // every other `query()` call, including the gateway's public
  // `GET /api/v1/audit` endpoint, indefinitely. Tracking writes ALSO by
  // their owning `runId` lets `query({ runId })` await only the writes
  // that could actually affect ITS OWN result, so a hung write for a
  // different owner no longer blocks it. A query with no `runId` filter
  // (a full/paginated scan) does not wait on anything here — narrowing
  // that case to "only wait for writes matching every constituent owner in
  // the store" would need iterating live owners, which is out of scope for
  // this fix; a caller that needs read-your-writes for a specific owner
  // already gets it by filtering on that owner's `runId`.
  const activeWritesByRunId = new Map<string, Set<Promise<void>>>();
  function trackWrite(promise: Promise<void>, ownerRunId?: string): void {
    activeWrites.add(promise);
    void promise.finally(() => activeWrites.delete(promise));
    if (ownerRunId !== undefined) {
      let owned = activeWritesByRunId.get(ownerRunId);
      if (!owned) {
        owned = new Set();
        activeWritesByRunId.set(ownerRunId, owned);
      }
      owned.add(promise);
      void promise.finally(() => {
        const stillOwned = activeWritesByRunId.get(ownerRunId);
        if (!stillOwned) return;
        stillOwned.delete(promise);
        if (stillOwned.size === 0) activeWritesByRunId.delete(ownerRunId);
      });
    }
    // AB-260: layered on top of `activeWrites` (never replacing it) — every
    // audit write also registers with the bureau's composed
    // `RuntimeServices.deferred`, so `deferred.drain()` reports it under the
    // stable `'audit-write'` label alongside every other subsystem's
    // fire-and-forget work.
    runtime.deferred.track(promise, 'audit-write');
  }

  // AB-370: ONE monotonic counter shared by the action-stream listener below
  // AND every out-of-band write (`record()`, the schedule-definition
  // listeners, `sessionDeletedListener`) — see `AuditRecord.sequence`'s own
  // doc comment for why this replaced two disjoint numbering domains.
  // Seeded from `auditTrailOptions.initialSequence`
  // (`computeInitialAuditSequence`, called by `create-bureau.ts` before this
  // factory runs) so a fresh process resumes above anything a prior process
  // lifetime already persisted rather than reissuing a value. Each call
  // returns the next value and advances the counter — called synchronously,
  // at the moment a write is DISPATCHED (before its `kv.set` starts), so the
  // assigned value reflects true call order regardless of which write's
  // fire-and-forget `kv.set` promise happens to settle first.
  let nextSequence = auditTrailOptions?.initialSequence ?? 0;
  function allocateSequence(): number {
    return nextSequence++;
  }

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

    const sequence = allocateSequence();
    const record: AuditRecord = {
      timestamp: new Date(action.timestamp).toISOString(),
      timestampMs: action.timestamp,
      sequence,
      // AB-370: the operative store's own per-process sequence, kept
      // separately from the shared `sequence` above — see
      // `AuditRecord.actionSequence`'s own doc comment.
      actionSequence: action.sequence,
      runId: action.runId,
      type: action.type,
      detail: serializedDetail,
    };

    const key = encodeKey(action.timestamp, sequence, action.runId);
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
      action.runId,
    );
  };

  bureau.addEventListener('action', listener);

  // Shared write path behind both the public out-of-band `record()` below
  // and the schedule-definition listeners further down (AB-228) — the same
  // manual-sequence-numbered, out-of-band key encoding, since neither has an
  // operative-store `Action` to draw a `sequence`/`timestamp` from. Returns
  // the write promise (already tracked in `activeWrites`) so both callers
  // can await it.
  //
  // `writeOptions.bypassAbortCheck` (AB-388, Codex review PR #597, "Finish
  // the prune summary after shutdown begins") skips the `signal?.aborted`
  // refusal above — used ONLY by `prune()`'s own summary write, for a pass
  // that was already admitted (passed ITS OWN abort check) before
  // `shutdown()` aborted the shared signal partway through deleting
  // records. Every other caller of this function keeps the default refusal.
  //
  // `writeOptions.strict` (AB-388, Codex review PR #597, "Propagate
  // failures to persist the prune summary") makes the RETURNED promise
  // reject on a write failure, instead of the default best-effort
  // swallow-and-diagnose every other caller relies on (an approve/deny
  // decision or a schedule pause/resume/cancel must never fail because the
  // audit trail happened to be unavailable). The write is STILL tracked in
  // `activeWrites`/`activeWritesByRunId` through a separate, never-rejecting
  // derived promise, so this rejection can never surface as an unhandled
  // rejection through that internal bookkeeping — only through the promise
  // this call returns, which `prune()` awaits directly.
  function writeOutOfBandRecord(
    entry: {
      runId: string;
      type: string;
      detail: unknown;
      principal?: string;
    },
    writeOptions?: {
      strict?: boolean;
      bypassAbortCheck?: boolean;
      timestampMs?: number;
      dedupeKey?: string;
    },
  ): Promise<void> {
    if (!kv) return Promise.resolve();
    if (!writeOptions?.bypassAbortCheck && signal?.aborted) {
      // AB-391: a `dedupeKey` caller opted into this call's promise
      // REJECTING on a genuine failure (see `dedupeKey`'s own doc
      // comment) so it can leave its own outer unit of work — an outbox
      // entry — unacknowledged and retry later. Resolving silently here,
      // the way every OTHER out-of-band write does post-shutdown, would
      // let `drainOutboxAttachmentEntry` acknowledge an entry whose audit
      // write never actually happened: a late `SessionOutboxAppendedEvent`
      // trigger (that listener carries no admission check of its own) can
      // still reach this function after `shutdown()` aborts `signal`,
      // and a silent no-write-no-error resolve here is indistinguishable
      // from "already recorded, nothing to do" to that caller — exactly
      // the durable-record loss this issue exists to close, just moved to
      // a shutdown race instead of a crash. Every other caller (no
      // `dedupeKey`) keeps the original silent-resolve behavior.
      if (writeOptions?.dedupeKey !== undefined) {
        return Promise.reject(
          new Error(
            `[audit-trail] Refusing dedupeKey-guarded write for "${writeOptions.dedupeKey}": the audit trail's shutdown signal is already aborted.`,
          ),
        );
      }
      return Promise.resolve();
    }

    // AB-388: `writeOptions.timestampMs` lets the schedule-definition and
    // session-deletion listeners below stamp with the shared
    // `eventTimestamp` resolver's reading for THEIR event instance, instead
    // of a fresh `runtime.clock.now()` call here — see `event-timestamp.ts`.
    // Every other caller (the action-stream listener writes its own record
    // directly; `record()` and `prune()`'s summary have no event to share a
    // reading with) keeps the original per-write clock reading.
    const timestampMs = writeOptions?.timestampMs ?? runtime.clock.now();
    const sequence = allocateSequence();

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

    // AB-391 (Codex review finding, PR #601, "Make attachment replay
    // deduplication atomic"): `dedupeKey` routes this write through an
    // atomic storage-level compare-and-swap instead of a plain `kv.set` —
    // two callers racing to record the SAME `dedupeKey` (two Bureau
    // processes both believing they hold the claim on one outbox entry
    // after a lease-renewal race) can never both durably write, unlike a
    // plain `kv.set` under a freshly minted `sequence`, which has no
    // precondition at all. `conditionalBatch`'s own atomicity guarantee
    // (the SAME guarantee `durable-event-history.ts`'s `dedupeKey` and
    // this codebase's session outbox `claim()` both already rely on) means
    // a caller that gets `committed: true` back knows the write already
    // durably landed — no separate read-your-writes query needed. A
    // caller that gets `committed: false` back knows a DIFFERENT writer
    // (an earlier attempt by this same caller, or a peer) already recorded
    // this exact fact; this function treats that as a successful no-op,
    // never a duplicate write. This path REJECTS on a genuine storage
    // failure — deliberately, unlike the default best-effort path below —
    // because the one caller that supplies `dedupeKey`
    // (`create-bureau.ts`'s `drainOutboxAttachmentEntry`) needs to know a
    // write failed so it can leave its own outbox entry pending for a
    // later retry, rather than silently swallowing it the way a
    // fire-and-forget schedule/session out-of-band write does.
    if (writeOptions?.dedupeKey !== undefined) {
      const markerKey = `${DEDUPE_MARKER_PREFIX}${writeOptions.dedupeKey}`;
      const conditionalWrite = kv.conditionalBatch(
        [{ key: markerKey, expectedValue: null }],
        [
          { type: 'set', key: markerKey, value: key },
          { type: 'set', key, value: JSON.stringify(record) },
        ],
      );
      // AB-391 (Codex P2 review finding, PR #601, "Track deduplicated audit
      // writes before returning"): unlike every other write path in this
      // function, this branch used to return `conditionalWrite` directly
      // without ever calling `trackWrite` — a caller that started this call
      // and then, without awaiting it, called `query({ runId })`,
      // `runtime.deferred.drain()`, or `dispose()` could miss the in-flight
      // write (a query racing ahead of it) or have storage torn down while
      // `conditionalBatch` was still running. Tracked here via a
      // NEVER-REJECTING derivative — mirroring the `strict` path just below
      // — while the REJECTING `conditionalWrite` itself is still what this
      // function returns to the `dedupeKey` caller, which needs to observe
      // a genuine failure (see this branch's own doc comment above).
      trackWrite(
        conditionalWrite.then(
          () => undefined,
          () => undefined,
        ),
        entry.runId,
      );
      return conditionalWrite.then((committed) => {
        // `committed === false` means the marker already existed — this
        // exact fact was already recorded, by this call or a peer's.
        // Nothing further to do; this is success, not a skipped write.
        void committed;
      });
    }

    const rawWrite = kv.set(key, JSON.stringify(record));

    // Best-effort observability path: never rejects. This is what gets
    // tracked in `activeWrites`/`activeWritesByRunId` — `dispose()` awaits
    // that set with `Promise.allSettled`, so nothing here needs to reject
    // to be observed there.
    const observedWrite = rawWrite.catch((error: unknown) => {
      // Best-effort, matching the action-stream listener above: a write
      // failure must never fail the caller (an approve/deny decision, or a
      // schedule pause/resume/cancel) UNLESS `writeOptions.strict` asked
      // for the failure to propagate — handled separately below so this
      // shared, tracked promise itself never rejects.
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[audit-trail] Failed to persist audit record for key "${key}":`,
        cause: error,
      });
    });
    // Tracked (AB-207) in addition to being returned: a caller that does not
    // await the result must not strand this write past `dispose()`. Also
    // tracked by `entry.runId` (AB-228) so a `query({ runId: entry.runId })`
    // immediately following this write observes it without waiting on any
    // OTHER owner's in-flight write.
    trackWrite(observedWrite, entry.runId);

    if (writeOptions?.strict) {
      return rawWrite.catch((error: unknown) => {
        // Already diagnosed via `observedWrite` above — this second
        // `.catch` on the SAME underlying `rawWrite` only re-raises for
        // the strict caller, it does not diagnose a second time.
        throw error;
      });
    }
    return observedWrite;
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
    void writeOutOfBandRecord(
      {
        runId: scheduleOwnerId(event.scheduleId),
        type: 'schedule.created',
        detail: {
          scheduleId: event.scheduleId,
          agentName: event.agentName,
          spec: event.spec,
          ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        },
      },
      { timestampMs: eventTimestamp(event) },
    );
  };
  const schedulePausedListener = (event: SchedulePausedEvent): void => {
    if (!auditEventSet.has('schedule.paused')) return;
    void writeOutOfBandRecord(
      {
        runId: scheduleOwnerId(event.scheduleId),
        type: 'schedule.paused',
        detail: { scheduleId: event.scheduleId },
      },
      { timestampMs: eventTimestamp(event) },
    );
  };
  const scheduleResumedListener = (event: ScheduleResumedEvent): void => {
    if (!auditEventSet.has('schedule.resumed')) return;
    void writeOutOfBandRecord(
      {
        runId: scheduleOwnerId(event.scheduleId),
        type: 'schedule.resumed',
        detail: { scheduleId: event.scheduleId },
      },
      { timestampMs: eventTimestamp(event) },
    );
  };
  const scheduleCancelledListener = (event: ScheduleCancelledEvent): void => {
    if (!auditEventSet.has('schedule.cancelled')) return;
    void writeOutOfBandRecord(
      {
        runId: scheduleOwnerId(event.scheduleId),
        type: 'schedule.cancelled',
        detail: { scheduleId: event.scheduleId },
      },
      { timestampMs: eventTimestamp(event) },
    );
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
  // either, so the session id is encoded into `runId` via the module-level
  // `auditTrailSessionOwnerId` — `query({ runId: auditTrailSessionOwnerId(id) })`
  // retrieves one session's own durable deletion record.
  const sessionOwnerId = auditTrailSessionOwnerId;
  const sessionDeletedListener = (event: SessionDeletedEvent): void => {
    if (!auditEventSet.has('session.deleted')) return;
    void writeOutOfBandRecord(
      {
        runId: sessionOwnerId(event.sessionId),
        type: 'session.deleted',
        // AB-384 (Codex P2 review finding, PR #592, "Preserve the incarnation
        // in deletion audit records"): `SessionDeletedEvent` now carries the
        // deleted record's own `incarnation` — omitting it here would leave a
        // consumer of `bureau.auditTrail` unable to tell WHICH live body a
        // deletion removed when a session id was deleted, recreated, and
        // deleted again, even though that identity is available.
        detail: { sessionId: event.sessionId, incarnation: event.incarnation },
      },
      // AB-389: `event.committedAtMs` — the session outbox entry's own
      // authoritative commit time — is used directly here rather than the
      // shared `eventTimestamp` resolver the schedule-definition listeners
      // above use: this event is dispatched by a REPLAYED outbox drain,
      // possibly long after its real commit, so a fresh clock read at
      // dispatch time would misdate it. `durable-event-history.ts`'s own
      // `sessionDeletedListener` reads the SAME `event.committedAtMs` for
      // the identical reason, so the two records still never diverge —
      // just by each independently reading the same event field, rather
      // than through the shared resolver.
      { timestampMs: event.committedAtMs },
    );
  };
  bureau.addEventListener('session.deleted', sessionDeletedListener);

  // AB-388 (Codex review, PR #597, "Serialize concurrent audit-pruning
  // passes"): two overlapping `prune()` calls on THIS instance — e.g. an
  // explicit `runDurableMaintenance()` call landing while the automatic
  // timer's own tick is still running, or two manual calls racing — could
  // both list the SAME qualifying key before either deletion completes,
  // double-counting `prunedCount` and writing two competing `audit.pruned`
  // summaries. `create-bureau.ts`'s own
  // `automaticRunOwnershipPruneCurrentPass` guard only prevents the
  // AUTOMATIC timer's own ticks from overlapping EACH OTHER — it says
  // nothing about a concurrent manual call reaching this method while that
  // tick is still in flight. Serializing every `prune()` call through one
  // promise chain, at the SOURCE, closes the gap regardless of which
  // caller races which. (Two SEPARATE bureau processes sharing the same KV
  // store is a distinct, cross-process race this in-process queue cannot
  // and does not attempt to solve.)
  let prunePassQueue: Promise<AuditPruneResult | undefined> = Promise.resolve(undefined);

  async function runPrunePass(
    cutoffMs: number,
    protectRunId?: (runId: string) => boolean,
  ): Promise<AuditPruneResult | undefined> {
    if (!kv) return undefined;
    // AB-207: once the owner-issued signal aborts (shutdown() has
    // begun), refuse to START a new pruning pass — same rule the
    // action-stream listener and `writeOutOfBandRecord` already apply to
    // new writes. A pass already in flight when the signal aborts still
    // runs to completion, including its own summary write below, which
    // bypasses this same check (AB-388, Codex review PR #597, "Finish the
    // prune summary after shutdown begins").
    if (signal?.aborted) return undefined;

    // AB-388 (Codex review, PR #597, "Reject non-finite and negative
    // retention durations"): a non-finite `cutoffMs` (`NaN`, `Infinity`,
    // `-Infinity`) reaching here would make every comparison below either
    // always-false (pruning the ENTIRE trail — `NaN` compares false
    // against anything) or always-true (silently pruning nothing),
    // depending on sign — neither is a safe default for a destructive
    // operation. `create-bureau.ts` already validates
    // `options.auditRetention.olderThan` at construction time, but this
    // method is part of the PUBLIC `AuditTrail` surface — a caller
    // reaching it directly must get the same protection.
    if (!Number.isFinite(cutoffMs)) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[audit-trail] prune() called with a non-finite cutoffMs (${cutoffMs}); refusing to prune anything.`,
      });
      return undefined;
    }

    // AB-388 (Codex review, PR #597, "Coordinate pruning across
    // shared-store instances"): acquire the cross-process lease BEFORE
    // reading anything else — see `PRUNE_LEASE_KEY`'s own doc comment.
    // Failure to acquire (another instance currently holds it, and it is
    // not yet stale) skips this pass entirely, exactly like the
    // in-process overlap guard (`prunePassQueue`) skips an overlapping
    // call within one instance — never a partial or merged attempt.
    const leaseToken = runtime.identifiers.next('audit-prune-lease');
    const acquired = await acquirePruneLease(leaseToken);
    if (!acquired) return undefined;

    try {
      return await runPrunePassLocked(cutoffMs, protectRunId, leaseToken);
    } finally {
      await releasePruneLease(leaseToken);
    }
  }

  /**
   * AB-388 (Codex review, PR #597, "Coordinate pruning across shared-store
   * instances"): attempt to write {@link PRUNE_LEASE_KEY} via
   * `conditionalBatch`, so the write only commits when no OTHER instance
   * currently holds a live lease. Two cases both count as "no live lease
   * to respect": the key is genuinely absent (`expectedValue: null`), or
   * the existing value is malformed/older than {@link PRUNE_LEASE_TTL_MS}
   * (a prior holder crashed before releasing) — in the second case the
   * CAS precondition targets the STALE value exactly, so a THIRD instance
   * racing the same takeover cannot also succeed against a precondition
   * that already changed.
   */
  async function acquirePruneLease(token: string): Promise<boolean> {
    if (!kv) return false;
    const existingRaw = await kv.get(PRUNE_LEASE_KEY);
    if (existingRaw === null) {
      return kv.conditionalBatch(
        [{ key: PRUNE_LEASE_KEY, expectedValue: null }],
        [
          {
            type: 'set',
            key: PRUNE_LEASE_KEY,
            value: JSON.stringify({ acquiredAtMs: runtime.clock.now(), token }),
          },
        ],
      );
    }

    let existing: unknown;
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existing = undefined;
    }
    const isStale =
      !isPruneLeaseValue(existing) ||
      runtime.clock.now() - existing.acquiredAtMs >= PRUNE_LEASE_TTL_MS;
    if (!isStale) return false;

    return kv.conditionalBatch(
      [{ key: PRUNE_LEASE_KEY, expectedValue: existingRaw }],
      [
        {
          type: 'set',
          key: PRUNE_LEASE_KEY,
          value: JSON.stringify({ acquiredAtMs: runtime.clock.now(), token }),
        },
      ],
    );
  }

  /**
   * Release the lease ONLY if it still names THIS pass's own `token` — a
   * lease this pass's own acquisition already lost (stolen by another
   * instance after this one's TTL expired, which can only happen if this
   * pass ran unexpectedly long) must never be released out from under
   * whichever instance now legitimately holds it.
   */
  async function releasePruneLease(token: string): Promise<void> {
    if (!kv) return;
    const existingRaw = await kv.get(PRUNE_LEASE_KEY);
    if (existingRaw === null) return;
    let existing: unknown;
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existing = undefined;
    }
    if (!isPruneLeaseValue(existing) || existing.token !== token) return;
    await kv.conditionalBatch(
      [{ key: PRUNE_LEASE_KEY, expectedValue: existingRaw }],
      [{ type: 'delete', key: PRUNE_LEASE_KEY }],
    );
  }

  /**
   * AB-388 (Codex review, PR #597, "Renew or fence the prune lease"):
   * standard lease-renewal — extends THIS pass's own lease with a fresh
   * `acquiredAtMs`, but ONLY if the lease still names `token` (a CAS
   * precondition on the exact current value, mirroring
   * {@link releasePruneLease}'s own token check). Called right before the
   * potentially-slow delete loop below, so a pass whose listing/decoding
   * phase alone already consumed a meaningful fraction of
   * {@link PRUNE_LEASE_TTL_MS} gets a fresh full TTL for the deletes and
   * summary write that remain — a pass that is still genuinely running
   * (not crashed) is never preempted mid-flight by a sibling instance's
   * own stale-lease takeover.
   *
   * This still assumes every instance's clock is reasonably synchronized
   * (the same assumption {@link acquirePruneLease}'s own staleness check
   * already makes) — a lease is a lightweight, best-effort coordination
   * primitive here, not a fenced, monotonic-counter-backed lock; a
   * pathologically skewed clock on another instance remains a known,
   * accepted residual, consistent with this codebase's existing
   * cross-process residuals (see `create-bureau.ts`'s own
   * `drainOutbox` doc comment for an analogous ACCEPTED RESIDUAL).
   *
   * AB-388 (Codex review, PR #597, "Abort pruning when lease renewal
   * loses its CAS"): returns whether THIS pass still holds the lease
   * after the call, rather than silently tolerating a lost renewal — a
   * `false` return (the token no longer matches, the lease key is gone,
   * or the `conditionalBatch` itself lost its CAS to a concurrent
   * takeover) means another instance now owns the lease, and every
   * caller MUST abort the pass immediately rather than continue deleting
   * candidates that instance could be deleting or has already deleted,
   * or racing its own watermark/summary writes.
   */
  async function renewPruneLease(token: string): Promise<boolean> {
    if (!kv) return true;
    const existingRaw = await kv.get(PRUNE_LEASE_KEY);
    if (existingRaw === null) return false;
    let existing: unknown;
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      return false;
    }
    if (!isPruneLeaseValue(existing) || existing.token !== token) return false;
    return kv.conditionalBatch(
      [{ key: PRUNE_LEASE_KEY, expectedValue: existingRaw }],
      [
        {
          type: 'set',
          key: PRUNE_LEASE_KEY,
          value: JSON.stringify({ acquiredAtMs: runtime.clock.now(), token }),
        },
      ],
    );
  }

  /**
   * AB-388 (Codex review, PR #597, "Commit deletion summaries atomically
   * with deletions"): recovers a pass whose deletions committed but whose
   * `audit.pruned` summary never landed — a crash between the two. Reads
   * {@link PRUNE_INTENT_KEY}; if present, emits the missing summary from
   * the intent's own recorded `count`/`cutoffMs` (the deleted records
   * themselves are long gone by now and carry no evidence of their own
   * removal — the intent is the only surviving account of what happened),
   * then clears the intent key. Called at the very start of every pass,
   * BEFORE that pass does any new listing or deleting of its own, so a
   * missed summary is reconciled at the first opportunity rather than
   * waiting for some unrelated future trigger.
   *
   * AB-388 (Codex review, PR #597, "Make prune-summary recovery
   * idempotent"): the summary write and the intent clear commit through
   * ONE `kv.conditionalBatch` call, CAS-guarded on the intent's own raw
   * value — never two separate calls. Without this, a crash (or a
   * rejected delete) between a successful summary write and the
   * following `kv.delete(PRUNE_INTENT_KEY)` would leave the intent
   * behind even though its summary is already durable, and the NEXT
   * pass's own call to this function would emit a SECOND, duplicate
   * `audit.pruned` record for the same already-accounted-for deletions —
   * inflating any consumer aggregating `detail.count`. The CAS
   * precondition also makes two instances racing this same reconciliation
   * safe: only the first commits, and it doesn't matter WHICH one — the
   * loser's own conditionalBatch simply reports `false` and this function
   * returns without emitting anything, exactly as if nothing needed
   * reconciling. Deliberately bypasses `writeOutOfBandRecord` (and its
   * `activeWrites` bookkeeping) for this one write — this call is always
   * awaited as the first step of `runPrunePassLocked`, itself awaited the
   * whole way up through `prune()`, so it is already covered by that
   * chain's own tracking; see `writeOutOfBandRecord`'s own doc comment for
   * what that bookkeeping is for.
   */
  async function reconcileOrphanedPruneIntent(): Promise<void> {
    if (!kv) return;
    const raw = await kv.get(PRUNE_INTENT_KEY);
    if (raw === null) return;
    let intent: unknown;
    try {
      intent = JSON.parse(raw);
    } catch {
      // Malformed intent record — nothing recoverable from it; clear it
      // so it does not block every future pass forever.
      await kv.delete(PRUNE_INTENT_KEY);
      return;
    }
    if (!isPruneIntentValue(intent)) {
      await kv.delete(PRUNE_INTENT_KEY);
      return;
    }

    const timestampMs = runtime.clock.now();
    const sequence = allocateSequence();
    const record: AuditRecord = {
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      sequence,
      runId: 'bureau:audit-retention',
      type: 'audit.pruned',
      detail: { count: intent.count, cutoffMs: intent.cutoffMs, recovered: true },
    };
    const summaryKey = encodeKey(timestampMs, sequence, 'bureau:audit-retention');

    // A `false` result means the intent no longer matches what was just
    // read — another instance already reconciled it (or a fresh pass
    // already overwrote it with a new intent of its own) — either way,
    // there is nothing left for THIS call to do.
    await kv.conditionalBatch(
      [{ key: PRUNE_INTENT_KEY, expectedValue: raw }],
      [
        { type: 'set', key: summaryKey, value: JSON.stringify(record) },
        { type: 'delete', key: PRUNE_INTENT_KEY },
      ],
    );
  }

  async function runPrunePassLocked(
    cutoffMs: number,
    protectRunId?: (runId: string) => boolean,
    leaseToken?: string,
  ): Promise<AuditPruneResult | undefined> {
    if (!kv) return undefined;

    await reconcileOrphanedPruneIntent();

    // AB-388: list once, then judge each key against `cutoffMs` from the
    // KEY alone via `parsePruneCandidateFromKey` wherever possible — no
    // `kv.get`/`JSON.parse` per record, the same "one network call
    // instead of `1 + keys.length`" saving `computeInitialAuditSequence`
    // already applies to the boot scan (Codex review, PR #594). A key
    // this fast path cannot parse falls back to reading and decoding the
    // record the slow way, same tolerance `query()` uses for a
    // corrupted stored record: skip it, never crash the pass over it.
    const keys = await kv.list(PREFIX);

    // AB-388 (Codex review, PR #597, "Persist the sequence watermark
    // before deleting records"): collect every qualifying key FIRST,
    // without deleting anything yet, so the highest-pruned-sequence floor
    // can be durably raised BEFORE any `kv.delete()` runs. Deleting first
    // and persisting the floor last (the original order) left a window
    // where a crash after one or more deletes but before the floor write
    // loses track of those sequences entirely: the next boot's
    // `computeInitialAuditSequence` scan sees neither the deleted keys nor
    // an updated floor, and can reissue an already-used sequence.
    const candidates: { key: string; sequence: number | undefined }[] = [];
    for (const key of keys) {
      const fromKey = parsePruneCandidateFromKey(key);
      if (fromKey) {
        if (fromKey.timestampMs >= cutoffMs) continue;
        // AB-388 (Codex review, PR #597, "Protect earlier audit records
        // for retained owners"): checked on the fast path too, so a
        // protected run's records never even reach the slow decode path.
        if (protectRunId?.(fromKey.runId)) continue;
        candidates.push({ key, sequence: fromKey.sequence });
        continue;
      }

      const raw = await kv.get(key);
      if (!raw) continue;

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        continue;
      }

      // AB-388 (Codex review, PR #597, "Validate decoded records before
      // pruning"): a syntactically valid JSON value that is not an
      // `AuditRecord` at all (`null`, an array, an object with no
      // numeric `timestampMs`) must be skipped like any other corrupt
      // record, never cast and dereferenced — the same tolerance
      // `query()` extends to its own decode. Without this, one such value
      // throws on `.timestampMs` access and aborts the ENTIRE pass at
      // that key, never reaching any subsequent key `kv.list()` returned.
      if (!isPrunableAuditRecordShape(decoded)) continue;

      if (decoded.timestampMs >= cutoffMs) continue;
      if (protectRunId?.(decoded.runId)) continue;
      candidates.push({ key, sequence: decoded.sequence });
    }

    // AB-391 (Codex P2 review finding, PR #601, "Prune dedupe markers with
    // expired audit records"): every `record({ dedupeKey })` write
    // (`writeOutOfBandRecord`'s `dedupeKey` branch) leaves a permanent
    // `audit-dedupe:v1:<dedupeKey>` marker behind — nothing else in this
    // file ever deletes one, so without this, retention bounds the audit
    // records themselves but not this marker family, which grows forever.
    // RECONCILIATION, not a filter over this pass's own `candidates`: a
    // marker's value is the key of the record it guards, so a marker whose
    // named record no longer exists is orphaned regardless of whether THIS
    // pass's delete loop below just removed that record, or an EARLIER
    // pass crashed between deleting the record and deleting its marker —
    // the latter could never be found again by matching against this
    // pass's own candidate list, since an already-deleted record is gone
    // from the `kv.list(PREFIX)` scan above and so never becomes a
    // candidate a second time. Called from BOTH the "nothing qualified"
    // early return just below AND after the delete loop further down —
    // an orphan from an earlier pass can be the only work a pass has to do,
    // so this must not be skipped just because `candidates` is empty here.
    // Listing every marker every call matches this function's own existing
    // cost profile (it already lists every `PREFIX` audit-record key every
    // call, regardless of the retention floor). Best-effort and isolated in
    // its own try/catch: a marker-cleanup failure must never turn an
    // otherwise-successful record prune into a rejected pass, and marker
    // deletions are deliberately never added to `prunedCount` — that count,
    // and the `audit.pruned` summary it feeds, describe audit RECORDS
    // pruned, not markers.
    const reconcileOrphanedDedupeMarkers = async (): Promise<void> => {
      try {
        const markerKeys = await kv.list(DEDUPE_MARKER_PREFIX);
        for (const markerKey of markerKeys) {
          const recordKey = await kv.get(markerKey);
          if (recordKey === null) continue;
          if (await kv.has(recordKey)) continue;
          await kv.delete(markerKey);
        }
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'audit-trail',
          message: '[audit-trail] Failed to reconcile orphaned dedupe markers during a prune pass:',
          cause: error,
        });
      }
    };

    // Nothing qualified — deliberately no `audit.pruned` record and no
    // floor update, so a pass that prunes nothing does not itself grow
    // the trail it exists to bound. Marker reconciliation still runs,
    // independent of that guarantee.
    if (candidates.length === 0) {
      await reconcileOrphanedDedupeMarkers();
      return { prunedCount: 0, cutoffMs };
    }

    let highestPrunedSequence = -1;
    for (const candidate of candidates) {
      if (typeof candidate.sequence === 'number' && candidate.sequence > highestPrunedSequence) {
        highestPrunedSequence = candidate.sequence;
      }
    }

    if (highestPrunedSequence >= 0) {
      // Read-modify-max, never a blind overwrite: a record with no
      // `sequence` at all (legacy, pre-AB-370) never raises this floor,
      // and a floor already persisted by an earlier pass never regresses.
      const existingRaw = await kv.get(PRUNE_FLOOR_KEY);
      let existing = -1;
      if (existingRaw) {
        try {
          const parsed: unknown = JSON.parse(existingRaw);
          if (typeof parsed === 'number' && Number.isSafeInteger(parsed)) existing = parsed;
        } catch {
          // Malformed meta record — treat as absent, same as
          // `computeInitialAuditSequence`'s own tolerance.
        }
      }
      if (highestPrunedSequence > existing) {
        await kv.set(PRUNE_FLOOR_KEY, JSON.stringify(highestPrunedSequence));
      }
    }

    // AB-388 (Codex review, PR #597, "Renew or fence the prune lease"):
    // renewed HERE, right before the potentially-slow delete loop — the
    // listing/decoding phase above (candidate collection, floor read) can
    // itself consume a meaningful fraction of the lease's TTL for a large
    // trail, so this gives the deletes and summary write that remain a
    // fresh full TTL rather than racing whatever budget was left over.
    //
    // AB-388 (Codex review, PR #597, "Abort pruning when lease renewal
    // loses its CAS"): a `false` return means another instance now holds
    // the lease — abort BEFORE the delete loop below even starts, rather
    // than proceeding to delete candidates that instance could be
    // deleting (or has already deleted) concurrently. The watermark write
    // just above already landed durably, so aborting here loses nothing
    // — the NEXT pass (this instance's retry, or the new holder's own
    // pass) simply re-lists and re-deletes the same still-present keys.
    if (leaseToken !== undefined && !(await renewPruneLease(leaseToken))) {
      throw new Error(
        'Aborting audit-trail prune pass: lost the prune lease before the delete phase',
      );
    }

    // AB-388 (Codex review, PR #597, "Commit deletion summaries atomically
    // with deletions"): declares this pass's intent to delete UP TO
    // `candidates.length` records under `cutoffMs`, right before the
    // delete loop below actually starts — never before the lease-renewal
    // check above, which can still abort with NOTHING deleted; writing
    // the intent before that check would falsely claim deletions that
    // never happened. See `PRUNE_INTENT_KEY`'s own doc comment for why
    // this exists and `reconcileOrphanedPruneIntent`'s own doc comment
    // for why `count` here is an upper bound, not a guarantee, for the
    // one case this recovers: a process that terminates mid-delete-loop
    // with no code left to run to record what actually committed.
    // Cleared once THIS pass's own summary write below lands, whether
    // that summary reports a full or partial `prunedCount`.
    await kv.set(PRUNE_INTENT_KEY, JSON.stringify({ count: candidates.length, cutoffMs }));

    // Only NOW, after the watermark durably reflects every sequence this
    // pass is about to remove, actually delete the qualifying records.
    //
    // AB-388 (Codex review, PR #597, "Record successful deletions when a
    // later delete fails"): if `kv.delete()` rejects partway through (a
    // later candidate, after one or more earlier deletions already
    // committed), the loop below stops immediately rather than continuing
    // past a failure the caller needs to know about — but `deleteError`
    // is captured, not rethrown yet, so the summary write further down
    // still runs and records the PARTIAL `prunedCount` that actually
    // committed. Without this, those already-deleted records would be
    // permanently gone with no `audit.pruned` evidence naming them, and a
    // retry would only see the remaining keys — no future summary could
    // reconstruct what this pass actually removed.
    //
    // AB-388 (Codex review, PR #597, "Renew or fence the prune lease"):
    // also renewed periodically DURING a large delete loop (every 200
    // deletions) — the same TTL-refresh rationale as the renewal above,
    // for a pass whose delete phase alone is long enough to approach the
    // lease's TTL.
    const RENEW_EVERY_N_DELETES = 200;
    let prunedCount = 0;
    let deleteError: Error | undefined;
    for (const candidate of candidates) {
      try {
        await kv.delete(candidate.key);
        prunedCount += 1;
        if (
          leaseToken !== undefined &&
          prunedCount % RENEW_EVERY_N_DELETES === 0 &&
          !(await renewPruneLease(leaseToken))
        ) {
          // AB-388 (Codex review, PR #597, "Abort pruning when lease
          // renewal loses its CAS"): treated exactly like a `kv.delete()`
          // failure below — stop deleting further candidates immediately,
          // but still let the partial summary write (further down) record
          // what THIS pass already committed before another instance took
          // over the lease.
          deleteError = new Error(
            'Aborting audit-trail prune pass: lost the prune lease mid-delete',
          );
          break;
        }
      } catch (error: unknown) {
        // Normalized to a real `Error` here (never re-thrown as `unknown`)
        // so the eventual `throw deleteError` below satisfies
        // `@typescript-eslint/only-throw-error` — the ORIGINAL cause is
        // still preserved via `Error.cause`, not lost.
        deleteError = error instanceof Error ? error : new Error(serializeUnknownError(error));
        break;
      }
    }

    // See `reconcileOrphanedDedupeMarkers`'s own doc comment above — called
    // again here (not just from the early-return branch) so a marker for a
    // record THIS pass's own delete loop just removed is also caught.
    await reconcileOrphanedDedupeMarkers();

    // AB-388 (Codex review, PR #597, "Skip summaries when no deletion
    // committed"): if the very FIRST candidate's `kv.delete()` rejects,
    // `prunedCount` stays `0` — this must be treated the same as the
    // "nothing qualified" early return above and write no summary. A
    // zero-progress pass under automatic maintenance (e.g. a persistent
    // delete-path outage) must not add a fresh zero-count `audit.pruned`
    // record on every tick while retaining every original record — that
    // violates the documented "a pass that prunes nothing writes no
    // summary" guarantee and would itself grow the trail unboundedly. The
    // delete failure is still surfaced via the `throw` below either way;
    // only the summary write is skipped.
    if (prunedCount > 0) {
      // Out-of-band, through the same shared-sequence-counter path every
      // other manual write in this file uses — this record's own
      // `sequence` is allocated from the SAME counter `computeInitialAuditSequence`
      // seeded, so it never collides with a surviving or future record.
      // Attributed to a synthetic, non-run owner (mirrors the
      // `schedule:<id>`/`session:<id>` convention above) since a retention
      // pass belongs to no single run.
      //
      // AB-388 (Codex review, PR #597, "Give prune summaries
      // cross-instance-unique keys"): the owner also embeds THIS pass's
      // own `leaseToken` — two `AuditTrail` instances over the same
      // shared store can each start their own local `sequence` counter
      // from the same value (e.g. both booting before either has ever
      // written), so a bare constant owner risks two SEQUENTIAL passes
      // (never concurrent ones — the lease already prevents that)
      // producing the identical encoded key at the same millisecond, with
      // the later summary silently overwriting the earlier one.
      // `leaseToken` (`runtime.identifiers.next(...)`) is unique per
      // pass, closing that gap the same way `encodeKey`'s own doc comment
      // already relies on a unique `runId` to guarantee global uniqueness.
      //
      // `bypassAbortCheck` (Codex review PR #597, "Finish the prune summary
      // after shutdown begins"): this pass was already admitted (passed the
      // `signal?.aborted` check above) before starting — if `shutdown()`
      // aborts the shared signal while the deletions above were still
      // running, this summary write must still land; the deletions already
      // happened, so losing the summary would report success with no
      // corresponding audit evidence. `strict` (Codex review PR #597,
      // "Propagate failures to persist the prune summary") makes a write
      // failure here reject this pass, rather than the best-effort swallow
      // every other out-of-band caller relies on — reporting success after
      // permanently deleting records without the promised evidence would be
      // worse than surfacing the failure to whatever called `prune()`.
      await writeOutOfBandRecord(
        {
          runId:
            leaseToken !== undefined
              ? `bureau:audit-retention:${leaseToken}`
              : 'bureau:audit-retention',
          type: 'audit.pruned',
          detail: {
            count: prunedCount,
            cutoffMs,
            ...(deleteError !== undefined ? { partial: true } : {}),
          },
        },
        { strict: true, bypassAbortCheck: true },
      );
    }

    // AB-388 (Codex review, PR #597, "Commit deletion summaries atomically
    // with deletions"): reaching this line means either the summary above
    // was durably written, or there was nothing to summarize
    // (`prunedCount === 0`) — either way THIS pass's own outcome is now
    // fully accounted for, so the intent recorded before the delete loop
    // no longer needs recovering. A `strict` `writeOutOfBandRecord`
    // failure above throws out of this function before reaching here,
    // deliberately leaving the intent in place for the NEXT pass's
    // `reconcileOrphanedPruneIntent` to recover.
    //
    // ACCEPTED RESIDUAL (Codex review, PR #597, "Make prune-summary
    // recovery idempotent"): unlike `reconcileOrphanedPruneIntent`'s own
    // summary-write-plus-clear (made atomic via `conditionalBatch` for
    // exactly this reason), this `kv.delete()` is a SEPARATE call from the
    // `writeOutOfBandRecord` above it — a crash (or a rejected delete)
    // between the two would leave this intent behind even though its
    // summary already landed, and the next pass's own reconciliation
    // would then emit ONE duplicate `audit.pruned` record for it. Left
    // as-is rather than rewritten onto the same raw `conditionalBatch`
    // primitive: that write's `strict`/`bypassAbortCheck` behavior and its
    // `activeWrites` tracking are exercised by several existing tests
    // (this pass's shutdown-race and summary-failure-propagation
    // coverage), and this window is narrower than the recovery path's own
    // — no listing/decoding/deleting happens between this summary write
    // succeeding and this line, unlike the gap between a crash mid-delete-
    // loop and a LATER pass's reconciliation. A future fix that also
    // closes this specific window should extend the SAME idempotency
    // guarantee here, not silently duplicate the accepted-residual pattern
    // without documenting it, consistent with this file's existing
    // residuals (see `pruneAuditTrail`'s own cross-process write-race
    // doc comment in `create-bureau.ts`).
    await kv.delete(PRUNE_INTENT_KEY);

    // Surfaced only AFTER the partial summary above has been durably
    // written — a caller (`pruneAuditTrail`'s `runDurableMaintenance`
    // wrapper) still learns the pass did not fully complete, but the
    // records it DID remove are never silently unaccounted for.
    if (deleteError !== undefined) {
      throw deleteError;
    }

    return { prunedCount, cutoffMs };
  }

  return {
    async record(entry: {
      runId: string;
      type: string;
      detail: unknown;
      principal?: string;
      timestampMs?: number;
      dedupeKey?: string;
    }): Promise<void> {
      await writeOutOfBandRecord(entry, {
        timestampMs: entry.timestampMs,
        dedupeKey: entry.dedupeKey,
      });
    },

    prune(
      cutoffMs: number,
      pruneOptions?: { protectRunId?: (runId: string) => boolean },
    ): Promise<AuditPruneResult | undefined> {
      // AB-388 (Codex review, PR #597, "Serialize concurrent audit-pruning
      // passes"): chained onto the shared queue (declared above, outside
      // this returned object) so this call only starts once every
      // previously queued pass has settled. `prunePassQueue` is always
      // reassigned through its own `.catch(() => undefined)` below, so it
      // never itself rejects — a single `onFulfilled` handler is enough,
      // no `onRejected` branch would ever run.
      const scheduled = prunePassQueue.then(() =>
        runPrunePass(cutoffMs, pruneOptions?.protectRunId),
      );
      // Keep the queue alive even when this pass rejects (a strict
      // summary-write failure) — a future call must still run rather than
      // being stuck forever behind a permanently-rejected link. This
      // catch is on a SEPARATE derived promise from `scheduled`, which is
      // what the caller actually awaits and sees the rejection through.
      prunePassQueue = scheduled.catch(() => undefined);
      return scheduled;
    },

    async query(options: AuditQueryOptions = {}): Promise<AuditRecord[]> {
      if (!kv) return [];

      const { since, runId, type, limit = 500 } = options;

      // AB-228 (Codex P2 review findings, PR #566: "Wait for schedule audit
      // writes before returning success", then "Avoid blocking every audit
      // query on unrelated writes"): every out-of-band write
      // (`writeOutOfBandRecord`, backing the schedule-definition and
      // session-deletion listeners) is fire-and-forget from its
      // dispatching caller's perspective — `pauseSchedule`/
      // `resumeSchedule`/`cancelSchedule`/`deleteSession` all return as
      // soon as the synchronous event dispatch completes, not once the
      // underlying `kv.set` actually commits. A `TextValueStore` whose
      // `set()` resolves asynchronously (the controllable-KV test helper
      // demonstrates this is a real, supported shape, not a hypothetical
      // one) can then have a query immediately following a successful
      // schedule transition or session deletion observe no record at all,
      // even though the write is genuinely in flight.
      //
      // The first cut of this fix drained the ENTIRE `activeWrites` set —
      // correct for read-your-writes, but it made any one unrelated stalled
      // write (a different run, a slow backend) hang every OTHER
      // `query()` call too, including the gateway's public
      // `GET /api/v1/audit` endpoint. Scoped instead: when the caller
      // filters by `runId` (which every schedule/session caller chasing
      // read-your-writes for ITS OWN just-issued write does — schedules and
      // deletions are recorded under the synthetic `schedule:<id>`/
      // `session:<id>` owner), only that owner's own in-flight writes are
      // awaited — a snapshot, not a loop until empty, so this can't
      // livelock under continuous writes to the same owner. `trackWrite`
      // registers synchronously inside the listener, so anything a
      // caller's own synchronous dispatch triggered is already present by
      // the time that caller's `await` reaches here. A query with no
      // `runId` filter (a broad scan) does not wait on anything — it has
      // no single owner to scope the wait to, and waiting on every writer
      // in the process would reopen the exact unrelated-write hang this
      // fix closes.
      if (runId !== undefined) {
        const owned = activeWritesByRunId.get(runId);
        if (owned && owned.size > 0) {
          await Promise.allSettled([...owned]);
        }
      }

      // List all audit keys under the prefix, then filter. For large logs a
      // range-prefix trick could narrow further (the timestamp is the first
      // segment after the prefix), but correctness-first: list all, filter in
      // memory. Suitable for per-run/per-session audit volumes.
      //
      // AB-370 (Codex P2 review finding, PR #594, "Sort keys before
      // stopping at the query limit"): `kv.list()`'s contract only
      // promises "the underlying storage's natural scan order" — NOT
      // lexicographic — so the early break below could otherwise select
      // an arbitrary `limit`-sized subset from a backend that doesn't
      // happen to return keys pre-sorted, rather than genuinely the
      // oldest matches. Sorting the keys here is in-memory string
      // comparison with no I/O (`kv.list` already materialized every key
      // into this array), and since `encodeKey` embeds
      // `<timestamp16>:<sequence>` right after the prefix, lexicographic
      // key order IS chronological order for SELECTION purposes — the
      // early break below can then safely stop at `limit` matches. The
      // explicit `sequence`-tiebreak sort further down still runs
      // afterward, over the (already limit-bounded) collected records, to
      // handle a same-millisecond tie precisely and a legacy
      // no-`sequence` record's `-1` mapping — this key sort alone is not
      // enough for that (a `sequence`'s decimal-digit WIDTH can vary,
      // e.g. a boot floor inherited from the old, much larger
      // `manualSequence` scheme, so `<sequence>` segments of different
      // lengths do not always compare correctly as plain strings).
      const unsortedKeys = await kv.list(PREFIX);
      const keys = unsortedKeys.sort();

      const records: AuditRecord[] = [];
      for (const key of keys) {
        const raw = await kv.get(key);
        if (!raw) continue;

        let decoded: unknown;
        try {
          decoded = JSON.parse(raw);
        } catch {
          continue;
        }

        // A syntactically valid JSON value that is not an `AuditRecord` at
        // all (`null`, a string, an array) must be skipped like any other
        // corrupt record — casting it straight to `AuditRecord` and reading
        // `.timestampMs`/`.runId` off it would THROW here and abort this
        // entire query at that one key, same failure class `prune()`'s own
        // decode had (AB-388, Codex review PR #597, "Validate decoded
        // records before pruning").
        if (!isPrunableAuditRecordShape(decoded)) continue;
        // `isPrunableAuditRecordShape` has already validated every field
        // this function reads (`timestampMs`, `runId`, `type`, `sequence`);
        // the remaining `AuditRecord` fields (`timestamp`, `detail`,
        // `principal`, `actionSequence`) are carried through unread and
        // untyped-checked here, same as before this validation existed.
        const record = decoded as AuditRecord;

        if (since !== undefined && record.timestampMs < since) continue;
        if (runId !== undefined && record.runId !== runId) continue;
        if (type !== undefined && record.type !== type) continue;

        records.push(record);

        // Apply the limit AFTER filtering so we count only records that match all
        // predicates. Stopping before filtering would cause the loop to break on
        // non-matching records and miss in-range entries later in the key scan.
        // AB-370 (Copilot review finding, PR #594): keeping this early break —
        // rather than scanning every matching key before ever truncating —
        // is what keeps this call's `kv.get`/`JSON.parse` cost bounded by
        // `limit` instead of by total audit history size, which matters for
        // the gateway's `GET /api/v1/audit` route calling `query({ limit })`
        // on every request.
        if (records.length >= limit) break;
      }

      // AB-370: explicit, timestamp-primary sort over the (already
      // limit-bounded) collected records, rather than trusting the KV
      // backend's raw key-scan order alone for the same-millisecond
      // tiebreak. `encodeKey` still embeds `sequence` in the key for
      // uniqueness (via the trailing `runId` tiebreak) and for backends
      // whose scan order already happens to be lexicographic, but this
      // sort is what actually GUARANTEES "sequence breaks a timestamp tie"
      // for every backend.
      //
      // Deliberately timestamp-first, sequence only as the tiebreak — NOT
      // sequence-first — so a query's order for two records that do NOT
      // share a millisecond never changes by this fix (this issue's own
      // rollback trigger). The shared counter only disambiguates a genuine
      // same-millisecond collision; it is not a replacement for the
      // timestamp as the primary ordering key.
      //
      // A record with no `sequence` (written before this field existed)
      // maps to `-1` for this comparison — NOT a `0`-returning special
      // case (Codex P2 review finding, PR #594: a comparator that returns
      // `0` for any pair involving an undefined `sequence` is not
      // transitive — A vs legacy and legacy vs B can both compare "equal"
      // even when A and B themselves compare unequal, and `Array.sort` is
      // only required to produce the claimed order for a genuinely
      // transitive comparator; some engines' sort algorithms can leave a
      // non-transitive comparator's inputs in their original scan order
      // instead). `-1` sorts a sequence-less record before every real
      // `sequence` (which is always `>= 0`) within the same millisecond —
      // a reasonable default (older code wrote it, before this field
      // existed) — while keeping the comparator a genuine, transitive
      // total order: two sequence-less records both map to `-1` and
      // compare equal to each other, exactly as intended.
      records.sort((a, b) => {
        if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
        return (a.sequence ?? -1) - (b.sequence ?? -1);
      });

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
      // AB-388 (Codex review, PR #597, "Await manual pruning before storage
      // teardown"): `activeWrites` only tracks individual `kv.set` calls —
      // a `prune()` pass's `kv.list()`/`kv.delete()` sequence and its
      // watermark write are NOT writes tracked there until the very last
      // summary write starts. `prunePassQueue` (declared below, closed over
      // here) resolves only once every `prune()` call ever chained onto it
      // — including one still in flight right now — has settled, so
      // awaiting it here (in addition to `activeWrites` above) means a
      // caller reaching `bureau.auditTrail.prune()` directly, with no
      // `runDurableMaintenance()` in between, is also fully drained before
      // this trail is disposed. No `.catch()` needed here: `prunePassQueue`
      // is always reassigned through its OWN `.catch(() => undefined)`
      // inside `prune()` below, so the reference closed over here can
      // never itself reject.
      await prunePassQueue;
    },
  };
}
