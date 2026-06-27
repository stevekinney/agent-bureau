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
 * and time-based cleanup. All keys are namespaced under `agent-session:`
 * in the underlying store.
 */
export interface SessionStore {
  /** Persist a session, merging on optimistic-concurrency conflicts. */
  save(session: AgentSession): Promise<void>;

  /**
   * Load the latest session and persist the updater result with optimistic
   * concurrency. Returning undefined leaves the session unchanged.
   */
  update(
    id: string,
    updater: (
      session: AgentSession | undefined,
    ) => AgentSession | undefined | Promise<AgentSession | undefined>,
  ): Promise<AgentSession | undefined>;

  /** Load a session by id. Returns undefined when no session exists. */
  load(id: string): Promise<AgentSession | undefined>;

  /** Delete a session by id. No-op if the session does not exist. */
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
