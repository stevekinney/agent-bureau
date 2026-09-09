import type { JSONValue } from 'interoperability';
import type { TypedEventTarget } from 'lifecycle';

import type { AgentSession } from '../agent-session';
import type { OperativeEventMap } from '../events';

/**
 * Options for listing sessions with filtering, pagination, and sorting.
 */
export interface SessionListOptions {
  agentName?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

/**
 * A lightweight summary of a session, returned by list operations
 * to avoid loading full conversation histories.
 */
export interface SessionSummary {
  id: string;
  agentName: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, JSONValue>;
}

/**
 * Options for cleaning up old sessions.
 */
export interface SessionCleanupOptions {
  /** Delete sessions older than this many milliseconds. */
  olderThan: number;
  /** When provided, only clean up sessions for this agent. */
  agentName?: string;
}

/**
 * One pending outbox entry (AB-389) — appended atomically, in the SAME
 * `conditionalBatch` as the session commit it describes, by `save()`,
 * `update()`, or `delete()`. `ordinal` is the store-wide, monotonically
 * increasing commit ordinal a caller drains in order — never a per-session
 * `revision`, which only orders one lineage, not the whole store. A drain
 * loop replays each entry as the matching `SessionCreatedEvent`/
 * `SessionSavedEvent`/`SessionDeletedEvent` and calls
 * `SessionStore.outbox.acknowledge(ordinal)` only once that replay's
 * downstream durable write has settled — never before, and never merely
 * because the event was dispatched.
 *
 * A discriminated union on `kind` (Codex P2 review finding, PR #598,
 * "Require agent names on created and saved entries"): `agentName` is
 * REQUIRED for `'session.created'`/`'session.saved'` — every live commit
 * always names an agent — and absent only for `'session.deleted'`, which
 * has no live body left to describe. A caller-supplied `SessionStore`
 * that used to be able to omit `agentName` for a created/saved entry and
 * have Bureau silently record `''` as the attributed agent can no longer
 * construct that value at all.
 */
/**
 * The lease a drainer currently holds on an outbox entry (AB-390). Absent
 * means unclaimed — every entry appended before this field existed, and
 * every entry no drainer has yet attempted, reads as unclaimed. `until` is
 * an absolute `RuntimeServices.clock.now()` timestamp: a drainer whose
 * lease has not reached `until` holds the entry exclusively; once `until`
 * passes, ANY drainer (including a different owner) may reclaim it via
 * `SessionStore.outbox.claim()` — see that method's own doc comment for the
 * compare-and-swap semantics that make this safe across processes sharing
 * one backend.
 */
export interface SessionOutboxClaim {
  /** Opaque identifier of the drainer holding this lease. */
  readonly owner: string;
  /** Absolute `RuntimeServices.clock.now()` timestamp the lease expires at. */
  readonly until: number;
}

export type SessionOutboxEntry =
  | {
      readonly ordinal: number;
      readonly kind: 'session.created' | 'session.saved';
      readonly sessionId: string;
      readonly agentName: string;
      readonly incarnation: string;
      /**
       * The wall-clock time (`RuntimeServices.clock.now()`) this entry was
       * appended — the true commit time, persisted so a drain replaying
       * this entry long after it was appended (a delayed maintenance pass,
       * or after a process restart) can stamp durable history and the
       * audit trail with when the commit ACTUALLY happened, not when the
       * replay happens to run (Codex P2 review finding, PR #598, "Persist
       * the commit time with each outbox entry").
       */
      readonly committedAtMs: number;
      /** See {@link SessionOutboxClaim}. Absent means unclaimed. */
      readonly claim?: SessionOutboxClaim;
    }
  | {
      readonly ordinal: number;
      readonly kind: 'session.deleted';
      readonly sessionId: string;
      readonly incarnation: string;
      /** See the `'session.created' | 'session.saved'` variant's own doc comment. */
      readonly committedAtMs: number;
      /** See {@link SessionOutboxClaim}. Absent means unclaimed. */
      readonly claim?: SessionOutboxClaim;
    };

/**
 * A high-level store for agent sessions, built on top of ConditionalTextValueStore.
 *
 * Provides CRUD operations plus listing, filtering, metadata updates,
 * and time-based cleanup. Session bodies are namespaced under `agent-session:`
 * in the underlying store; the summary index is stored in the reserved
 * `agent-session:summary-index` key.
 */
export interface SessionStore {
  /**
   * Persist a session, merging on optimistic-concurrency conflicts. Rejects
   * with `StaleSessionIncarnationError` (AB-384) when `session.incarnation`
   * is nonempty and does not match the live body's current incarnation — a
   * caller writing back a specific prior incarnation's own object after
   * that body was deleted and the id recreated. A candidate with
   * `incarnation: ''` (the `createAgentSession()` default) is never
   * rejected this way.
   */
  save(session: AgentSession): Promise<void>;

  /**
   * Load the latest session and persist the updater result with optimistic
   * concurrency. Returning undefined leaves the session unchanged.
   *
   * `options.refreshActivity` (default `true`) controls whether a
   * successful write stamps a fresh `updatedAt`. Pass `false` for a write
   * that must not read as session activity — `list()` sorts by
   * `updatedAt` by default and `cleanup({ olderThan })` uses the same field
   * as its age cutoff, so an ordinary content update refreshing it is
   * correct, but a background maintenance write (pruning stale metadata,
   * for example) must not reorder or resurrect an otherwise-inactive
   * session purely by touching it (AB-363, Codex review PR #568, "Avoid
   * refreshing session activity during retention pruning").
   *
   * Also rejects with `StaleSessionIncarnationError` (AB-384) under the
   * same condition `save()` does, checked against the updater's own
   * returned candidate.
   */
  update(
    id: string,
    updater: (
      session: AgentSession | undefined,
    ) => AgentSession | undefined | Promise<AgentSession | undefined>,
    options?: { refreshActivity?: boolean },
  ): Promise<AgentSession | undefined>;

  /** Load a session by id. Returns undefined when no session exists. */
  load(id: string): Promise<AgentSession | undefined>;

  /**
   * Delete a session by id, atomically (a single delete-and-count operation,
   * never a separate existence check followed by a delete). Resolves `true`
   * only when this call itself removed a live record; resolves `false` when
   * there was nothing to remove, whether the session never existed or another
   * call already deleted it. Two Bureau processes sharing one persistent
   * store can race this call for the same id — the `boolean` return is how a
   * caller tells which of them actually won, without a process-local guard
   * (AB-371). Rejects with SessionConflictError when repeated conflicts
   * prevent removing its body and summary atomically, so a live summary is
   * never silently left behind.
   */
  delete(id: string): Promise<boolean>;
  /**
   * The same atomic delete as `delete(id)`, additionally reporting the
   * `AgentSession.incarnation` of the body actually removed (AB-384). A
   * caller that needs to know WHICH incarnation it deleted — to stamp on a
   * `SessionDeletedEvent`, say — must use this overload rather than reading
   * `load(id)` beforehand: a separate `load()` has a real race window (a
   * concurrent process can delete-and-recreate the id between that read and
   * this delete), where this overload has none — `incarnation` is parsed
   * from the exact value the same CAS attempt verified was still current
   * when it committed. `incarnation` is `undefined` when `removed` is
   * `false` (nothing was removed to describe), and can also be `undefined`
   * for a `removed: true` result if the removed body predates
   * `AgentSession.incarnation` and was never re-saved after (see that
   * field's own doc comment) — treat that the same as `''`.
   */
  delete(
    id: string,
    options: { returnIncarnation: true },
  ): Promise<{ removed: boolean; incarnation: string | undefined }>;

  /** List sessions with optional filtering, pagination, and sorting. */
  list(options?: SessionListOptions): Promise<SessionSummary[]>;

  /** Check whether a session exists without loading the full data. */
  exists(id: string): Promise<boolean>;

  /** Merge metadata into an existing session without overwriting the conversation. */
  updateMetadata(id: string, metadata: Record<string, JSONValue>): Promise<void>;

  /** Delete sessions older than the specified threshold. Returns the number deleted. */
  cleanup(options: SessionCleanupOptions): Promise<number>;

  /**
   * Session lifecycle drain trigger (AB-384, re-scoped by AB-389): `save()`,
   * `update()`, and `delete()` no longer dispatch `SessionCreatedEvent`/
   * `SessionSavedEvent`/`SessionDeletedEvent` directly from inside the
   * commit — that fire-and-forget dispatch is exactly the KNOWN LIMITATION
   * AB-389 closes (a crash between commit and dispatch used to lose the
   * fact forever, and two store instances over one shared backend could
   * record events out of true commit order). Every commit that used to
   * dispatch one of those three events now instead appends a
   * `SessionOutboxEntry` to `outbox` in the SAME atomic batch as the
   * commit, and dispatches only `SessionOutboxAppendedEvent` here — a
   * best-effort trigger a drain loop uses to wake up promptly, never the
   * durable fact itself (see that event's own doc comment). A caller that
   * needs the actual `session.created`/`session.saved`/`session.deleted`
   * facts must drain `outbox` and replay them itself (Bureau's own drain
   * loop does this, dispatching the replayed event onto its bureau-level
   * emitter) — listening here alone is not enough. A `SessionStore`
   * implementation supplied by a caller (not `createSessionStore()`'s own)
   * must provide this member — it is required, not optional, on this
   * interface.
   */
  readonly events: TypedEventTarget<OperativeEventMap>;

  /**
   * The commit outbox (AB-389) — every `SessionOutboxEntry` a committing
   * write has appended and no drain has yet acknowledged, exposed so a
   * caller (Bureau's own drain loop) can replay each entry's durable fact
   * exactly once, in ordinal order, coupled to the commit that produced it
   * rather than to a separate, uncoupled fire-and-forget dispatch.
   */
  readonly outbox: {
    /**
     * Pending entries, oldest (lowest `ordinal`) first. Safe to call
     * repeatedly and concurrently — it never mutates state, only reads.
     * Entries are returned regardless of claim state; a caller intending to
     * drain must `claim()` each entry before replaying it (AB-390) — this
     * alone never grants exclusivity.
     */
    pending(): Promise<readonly SessionOutboxEntry[]>;
    /**
     * Claims exclusive replay rights to the entry at `ordinal` for `owner`
     * until the absolute timestamp `until` (AB-390), by compare-and-swap on
     * the entry's own `claim` field — never a separate lock record, so a
     * claim can never drift out of sync with the entry it protects. Resolves
     * `true` when the entry was unclaimed, its prior claim's `until` has
     * already passed (by this store's own `RuntimeServices.clock.now()`), or
     * `owner` already held it (renewing a claim is always allowed — the
     * ruling's exclusivity concern is cross-owner, not same-owner reentry,
     * and refusing renewal would let a slow-but-alive drainer's own retry
     * lock itself out before its lease naturally lapses). Resolves `false`
     * when a DIFFERENT owner holds an unexpired claim, or the entry no
     * longer exists (already acknowledged) — a caller must treat `false` as
     * "do not replay this entry right now", never as an error.
     */
    claim(ordinal: number, lease: { owner: string; until: number }): Promise<boolean>;
    /**
     * Removes the entry at `ordinal`, once its replay's downstream durable
     * write has settled, but ONLY if `owner` still holds the claim on it
     * (AB-390) — verified by compare-and-swap against the exact stored
     * value `claim()` last wrote, so a claim reclaimed by a different owner
     * in between (this owner's lease lapsed and someone else took over)
     * makes the delete a no-op rather than removing an entry this owner no
     * longer has any right to retire. A caller must never call this before
     * the replay's durable write settles — doing so re-introduces exactly
     * the lost-fact hazard this outbox exists to close. Resolves `true` when
     * the entry is gone after this call returns — either because this call
     * removed it, or because it was already gone (a concurrent drain, in
     * another process sharing this store, already acknowledged it —
     * acknowledging a vanished entry is idempotent, not a conflict).
     * Resolves `false` only when the entry still exists and a DIFFERENT
     * owner holds its claim — this owner's own lease lapsed and someone
     * else reclaimed it first, so THIS replay must not be trusted as the
     * one that retires the entry.
     */
    acknowledge(ordinal: number, owner: string): Promise<boolean>;
  };
}
