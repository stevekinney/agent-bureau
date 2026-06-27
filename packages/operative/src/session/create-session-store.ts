import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import type { ConversationHistory } from 'conversationalist';
import type { JSONValue } from 'interoperability';

import type { AgentSession } from '../agent-session';
import type {
  SessionCleanupOptions,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from './types';

const KEY_PREFIX = 'agent-session:';
const MAXIMUM_SAVE_ATTEMPTS = 5;

export class SessionConflictError extends Error {
  readonly code = 'SessionConflictError';

  constructor(sessionId: string) {
    super(`Session "${sessionId}" could not be saved after ${MAXIMUM_SAVE_ATTEMPTS} conflicts.`);
    this.name = 'SessionConflictError';
  }
}

/** Returns true if the value is a string that parses to a valid Date. */
function isValidDate(value: unknown): boolean {
  return typeof value === 'string' && !isNaN(new Date(value).getTime());
}

/**
 * Parses a stored JSON string into an AgentSession, returning undefined
 * when the data is missing or malformed. Validates that `createdAt` and
 * `updatedAt` are valid ISO date strings to prevent silent sort failures.
 */
function parseSession(raw: string | null): AgentSession | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      'agentName' in parsed &&
      'conversationHistory' in parsed &&
      'createdAt' in parsed &&
      'updatedAt' in parsed &&
      isValidDate((parsed as Record<string, unknown>)['createdAt']) &&
      isValidDate((parsed as Record<string, unknown>)['updatedAt'])
    ) {
      return {
        ...(parsed as AgentSession),
        revision:
          typeof (parsed as Record<string, unknown>)['revision'] === 'number'
            ? ((parsed as Record<string, number>)['revision'] ?? 0)
            : 0,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function mergeConversationHistory(
  current: ConversationHistory,
  candidate: ConversationHistory,
): ConversationHistory {
  const currentIds = new Set(current.ids);
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...current.ids, ...candidateOnlyIds];
  const messages = {
    ...candidateOnlyIds.reduce<Record<string, ConversationHistory['messages'][string]>>(
      (accumulator, id) => {
        const message = candidate.messages[id];
        if (message) accumulator[id] = message;
        return accumulator;
      },
      { ...current.messages },
    ),
  };

  for (const [position, id] of ids.entries()) {
    const message = messages[id];
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    ...candidate,
    metadata: {
      ...current.metadata,
      ...candidate.metadata,
    },
    ids,
    messages,
    createdAt: current.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function mergeSessions(current: AgentSession, candidate: AgentSession): AgentSession {
  const candidateIsFresh = candidate.revision >= current.revision;
  const candidateRunsById = new Map(candidate.runs.map((run) => [run.runId, run]));
  const currentRunIds = new Set(current.runs.map((run) => run.runId));
  const mergedRuns = [
    ...current.runs.map((run) =>
      candidateIsFresh ? (candidateRunsById.get(run.runId) ?? run) : run,
    ),
    ...candidate.runs.filter((run) => !currentRunIds.has(run.runId)),
  ];
  const metadata = candidateIsFresh
    ? { ...current.metadata, ...candidate.metadata }
    : {
        ...candidate.metadata,
        ...current.metadata,
      };

  return {
    ...current,
    ...(candidateIsFresh ? candidate : {}),
    agentName: candidateIsFresh ? candidate.agentName : current.agentName,
    conversationHistory: mergeConversationHistory(
      current.conversationHistory,
      candidate.conversationHistory,
    ),
    runs: mergedRuns,
    metadata,
    createdAt: current.createdAt,
    revision: current.revision,
    updatedAt: candidate.updatedAt,
  };
}

/**
 * Extracts a lightweight summary from a full session, avoiding the need
 * to expose the entire conversation history in list responses.
 */
function toSummary(session: AgentSession): SessionSummary {
  const history = session.conversationHistory;
  const messageCount = Array.isArray(history.ids) ? history.ids.length : 0;

  return {
    id: session.id,
    agentName: session.agentName,
    messageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metadata: session.metadata,
  };
}

/**
 * Creates a SessionStore backed by the given ConditionalTextValueStore.
 *
 * All keys are prefixed with `agent-session:` so session data can coexist
 * with other data in the same store.
 */
export function createSessionStore(store: ConditionalTextValueStore): SessionStore {
  if (typeof store.conditionalBatch !== 'function') {
    throw new TypeError('createSessionStore requires a ConditionalTextValueStore.');
  }

  function keyFor(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  async function commit(
    session: AgentSession,
    expectedValue: string | null,
    currentRevision: number,
    refreshUpdatedAt: boolean,
  ): Promise<AgentSession | undefined> {
    const next: AgentSession = {
      ...session,
      revision: currentRevision + 1,
      updatedAt: refreshUpdatedAt ? new Date().toISOString() : session.updatedAt,
    };
    const committed = await store.conditionalBatch(
      [{ key: keyFor(next.id), expectedValue }],
      [{ type: 'set', key: keyFor(next.id), value: JSON.stringify(next) }],
    );
    return committed ? next : undefined;
  }

  const sessionStore: SessionStore = {
    async save(session: AgentSession): Promise<void> {
      for (let attempt = 1; attempt <= MAXIMUM_SAVE_ATTEMPTS; attempt += 1) {
        const raw = await store.get(keyFor(session.id));
        const current = parseSession(raw);
        const candidate = current ? mergeSessions(current, session) : session;
        const committed = await commit(candidate, raw, current?.revision ?? 0, true);
        if (committed) return;
      }

      throw new SessionConflictError(session.id);
    },

    async update(
      id: string,
      updater: (
        session: AgentSession | undefined,
      ) => AgentSession | undefined | Promise<AgentSession | undefined>,
    ): Promise<AgentSession | undefined> {
      for (let attempt = 1; attempt <= MAXIMUM_SAVE_ATTEMPTS; attempt += 1) {
        const raw = await store.get(keyFor(id));
        const current = parseSession(raw);
        const candidate = await updater(current);
        if (!candidate) return undefined;

        const next = current ? mergeSessions(current, candidate) : candidate;
        const committed = await commit(next, raw, current?.revision ?? 0, true);
        if (committed) return committed;
      }

      throw new SessionConflictError(id);
    },

    async load(id: string): Promise<AgentSession | undefined> {
      const raw = await store.get(keyFor(id));
      return parseSession(raw);
    },

    async delete(id: string): Promise<void> {
      await store.delete(keyFor(id));
    },

    async list(options?: SessionListOptions): Promise<SessionSummary[]> {
      const keys = await store.list(KEY_PREFIX);
      const sessions: AgentSession[] = [];

      for (const key of keys) {
        const raw = await store.get(key);
        const session = parseSession(raw);
        if (session) sessions.push(session);
      }

      // Filter by agentName when requested
      let filtered = options?.agentName
        ? sessions.filter((s) => s.agentName === options.agentName)
        : sessions;

      // Sort
      const sortBy = options?.sortBy ?? 'updatedAt';
      const sortOrder = options?.sortOrder ?? 'desc';
      filtered.sort((a, b) => {
        const aVal = new Date(a[sortBy]).getTime();
        const bVal = new Date(b[sortBy]).getTime();
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
      });

      // Paginate
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? filtered.length;
      filtered = filtered.slice(offset, offset + limit);

      return filtered.map(toSummary);
    },

    async exists(id: string): Promise<boolean> {
      // `has` is a required member of Weft's TextValueStore (0.2.1), so the
      // existence check needs no get-based fallback.
      return store.has(keyFor(id));
    },

    async updateMetadata(id: string, metadata: Record<string, JSONValue>): Promise<void> {
      await sessionStore.update(id, (session) =>
        session
          ? {
              ...session,
              metadata: { ...session.metadata, ...metadata },
            }
          : undefined,
      );
    },

    async cleanup(options: SessionCleanupOptions): Promise<number> {
      const keys = await store.list(KEY_PREFIX);
      const cutoff = Date.now() - options.olderThan;
      let deleted = 0;

      for (const key of keys) {
        const raw = await store.get(key);
        const session = parseSession(raw);
        if (!session) continue;

        if (options.agentName && session.agentName !== options.agentName) continue;

        const updatedAt = new Date(session.updatedAt).getTime();
        if (updatedAt < cutoff) {
          await store.delete(key);
          deleted++;
        }
      }

      return deleted;
    },
  };

  return sessionStore;
}
