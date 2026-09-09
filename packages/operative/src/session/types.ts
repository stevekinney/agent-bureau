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
   * Session lifecycle events (AB-384): `SessionCreatedEvent` on the first
   * successful commit of an id's body (a brand-new id, or one recreated
   * after deletion), `SessionSavedEvent` on every later commit of the same
   * live body. Dispatched by `save()`/`update()` after a commit succeeds —
   * never by `delete()`, which has no body left to describe. Deliberately
   * not special-cased for `update(id, updater, { refreshActivity: false })`
   * (a background maintenance write, e.g. pruning stale metadata): that call
   * is still a real, successful commit of the live body, so it still
   * dispatches `SessionSavedEvent` — only `updatedAt` itself is withheld.
   * A caller that needs these facts on a shared bus (Bureau forwards them
   * onto its own bureau-level emitter, the same one `SessionDeletedEvent` is
   * dispatched directly onto) attaches a listener here; a caller with no
   * interest in them can ignore this target entirely — the store still
   * mints and carries `AgentSession.incarnation` (see its own doc comment)
   * independently of whether anything is listening. A `SessionStore`
   * implementation supplied by a caller (not `createSessionStore()`'s own)
   * must provide this member — it is required, not optional, on this
   * interface.
   */
  readonly events: TypedEventTarget<OperativeEventMap>;
}
