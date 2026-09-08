import type { JSONValue } from 'interoperability';

import type { AgentSession } from '../agent-session';

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
  /** Persist a session, merging on optimistic-concurrency conflicts. */
  save(session: AgentSession): Promise<void>;

  /**
   * Load the latest session and persist the updater result with optimistic
   * concurrency. Returning undefined leaves the session unchanged.
   *
   * `options.refreshActivity` (default `true`) controls whether a
   * successful write stamps a fresh `updatedAt`. Pass `false` for a write
   * that must not read as session activity — `listSessions()` sorts by
   * `updatedAt` by default and `cleanup({ olderThan })` uses the same field
   * as its age cutoff, so an ordinary content update refreshing it is
   * correct, but a background maintenance write (pruning stale metadata,
   * for example) must not reorder or resurrect an otherwise-inactive
   * session purely by touching it (AB-363, Codex review PR #568, "Avoid
   * refreshing session activity during retention pruning").
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
   * Delete a session by id. No-op if the session does not exist. Rejects with
   * SessionConflictError when repeated conflicts prevent removing its body and
   * summary atomically, so a live summary is never silently left behind.
   */
  delete(id: string): Promise<void>;

  /** List sessions with optional filtering, pagination, and sorting. */
  list(options?: SessionListOptions): Promise<SessionSummary[]>;

  /** Check whether a session exists without loading the full data. */
  exists(id: string): Promise<boolean>;

  /** Merge metadata into an existing session without overwriting the conversation. */
  updateMetadata(id: string, metadata: Record<string, JSONValue>): Promise<void>;

  /** Delete sessions older than the specified threshold. Returns the number deleted. */
  cleanup(options: SessionCleanupOptions): Promise<number>;
}
