import type { JSONValue } from 'interoperability';
import type { KeyValueStore } from 'storage';

import type { AgentSession } from '../agent-session';
import type {
  SessionCleanupOptions,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from './types';

const KEY_PREFIX = 'agent-session:';

/**
 * Parses a stored JSON string into an AgentSession, returning undefined
 * when the data is missing or malformed.
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
      'updatedAt' in parsed
    ) {
      return parsed as AgentSession;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
 * Creates a SessionStore backed by the given KeyValueStore.
 *
 * All keys are prefixed with `agent-session:` so session data can coexist
 * with other data in the same store.
 */
export function createSessionStore(store: KeyValueStore): SessionStore {
  function keyFor(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  const sessionStore: SessionStore = {
    async save(session: AgentSession): Promise<void> {
      await store.set(keyFor(session.id), JSON.stringify(session));
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
      if (store.has) {
        return store.has(keyFor(id));
      }
      const raw = await store.get(keyFor(id));
      return raw !== null;
    },

    async updateMetadata(id: string, metadata: Record<string, JSONValue>): Promise<void> {
      const session = await sessionStore.load(id);
      if (!session) return;

      const updated: AgentSession = {
        ...session,
        metadata: { ...session.metadata, ...metadata },
        updatedAt: new Date().toISOString(),
      };
      await sessionStore.save(updated);
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
