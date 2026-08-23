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
const SUMMARY_INDEX_KEY = 'agent-session-index';
const MAXIMUM_SAVE_ATTEMPTS = 5;
const SUMMARY_FORMAT_VERSION = 1;

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
    const record = parsed as Record<string, unknown>;
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
        metadata:
          typeof record['metadata'] === 'object' &&
          record['metadata'] !== null &&
          !Array.isArray(record['metadata'])
            ? (record['metadata'] as Record<string, JSONValue>)
            : {},
        revision:
          typeof record['revision'] === 'number'
            ? ((record as Record<string, number>)['revision'] ?? 0)
            : 0,
        runs: Array.isArray(record['runs']) ? (record['runs'] as AgentSession['runs']) : [],
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
  candidateIsFresh: boolean,
): ConversationHistory {
  if (candidateIsFresh) {
    const messages = { ...candidate.messages };
    for (const [position, id] of candidate.ids.entries()) {
      const message = messages[id];
      if (message) messages[id] = { ...message, position };
    }
    return {
      ...candidate,
      messages,
    };
  }

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
    metadata: {
      ...candidate.metadata,
      ...current.metadata,
    },
    ids,
    messages,
    createdAt: current.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function mergeSessions(current: AgentSession, candidate: AgentSession): AgentSession {
  const candidateIsFresh = candidate.revision >= current.revision;
  const currentRunIds = new Set(current.runs.map((run) => run.runId));
  const mergedRuns = candidateIsFresh
    ? candidate.runs
    : [...current.runs, ...candidate.runs.filter((run) => !currentRunIds.has(run.runId))];
  const metadata = candidateIsFresh
    ? candidate.metadata
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
      candidateIsFresh,
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

function parseSummary(raw: string | null): SessionSummary | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as Record<string, unknown>)['formatVersion'] !== SUMMARY_FORMAT_VERSION ||
      typeof (parsed as Record<string, unknown>)['id'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['agentName'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['messageCount'] !== 'number' ||
      !isValidDate((parsed as Record<string, unknown>)['createdAt']) ||
      !isValidDate((parsed as Record<string, unknown>)['updatedAt'])
    )
      return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      id: record['id'] as string,
      agentName: record['agentName'] as string,
      messageCount: record['messageCount'] as number,
      createdAt: record['createdAt'] as string,
      updatedAt: record['updatedAt'] as string,
      metadata:
        typeof record['metadata'] === 'object' &&
        record['metadata'] !== null &&
        !Array.isArray(record['metadata'])
          ? (record['metadata'] as Record<string, JSONValue>)
          : {},
    };
  } catch {
    return undefined;
  }
}

function parseSummaryIndex(raw: string | null): Map<string, SessionSummary> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      record['formatVersion'] !== SUMMARY_FORMAT_VERSION ||
      typeof record['summaries'] !== 'object'
    ) {
      return undefined;
    }
    const summaries = new Map<string, SessionSummary>();
    for (const [id, value] of Object.entries(record['summaries'] as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      const summary = parseSummary(
        JSON.stringify({
          formatVersion: SUMMARY_FORMAT_VERSION,
          ...(value as Record<string, unknown>),
        }),
      );
      if (!summary || summary.id !== id) return undefined;
      summaries.set(id, summary);
    }
    return summaries;
  } catch {
    return undefined;
  }
}

function serializeSummaryIndex(summaries: Map<string, SessionSummary>): string {
  return JSON.stringify({
    formatVersion: SUMMARY_FORMAT_VERSION,
    summaries: Object.fromEntries(summaries),
  });
}

/**
 * Creates a SessionStore backed by the given ConditionalTextValueStore.
 *
 * Session bodies are prefixed with `agent-session:` and the aggregate summary
 * index uses the reserved `agent-session-index` key so both can coexist with
 * other data in the same store.
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
    expectedSummaryValue: string | null,
    currentSummaries: Map<string, SessionSummary> | undefined,
  ): Promise<AgentSession | undefined> {
    const next: AgentSession = {
      ...session,
      revision: currentRevision + 1,
      updatedAt: refreshUpdatedAt ? new Date().toISOString() : session.updatedAt,
    };
    const committed = await store.conditionalBatch(
      [
        { key: keyFor(next.id), expectedValue },
        { key: SUMMARY_INDEX_KEY, expectedValue: expectedSummaryValue },
      ],
      [
        { type: 'set', key: keyFor(next.id), value: JSON.stringify(next) },
        {
          type: 'set',
          key: SUMMARY_INDEX_KEY,
          value: serializeSummaryIndex(new Map(currentSummaries).set(next.id, toSummary(next))),
        },
      ],
    );
    return committed ? next : undefined;
  }

  const sessionStore: SessionStore = {
    async save(session: AgentSession): Promise<void> {
      for (let attempt = 1; attempt <= MAXIMUM_SAVE_ATTEMPTS; attempt += 1) {
        const [raw, summaryRaw] = await Promise.all([
          store.get(keyFor(session.id)),
          store.get(SUMMARY_INDEX_KEY),
        ]);
        const current = parseSession(raw);
        const candidate = current ? mergeSessions(current, session) : session;
        const committed = await commit(
          candidate,
          raw,
          current?.revision ?? 0,
          true,
          summaryRaw,
          parseSummaryIndex(summaryRaw),
        );
        if (committed) {
          Object.assign(session, committed);
          return;
        }
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
        const [raw, summaryRaw] = await Promise.all([
          store.get(keyFor(id)),
          store.get(SUMMARY_INDEX_KEY),
        ]);
        const current = parseSession(raw);
        const candidate = await updater(current);
        if (!candidate) return undefined;

        const next = current ? mergeSessions(current, candidate) : candidate;
        const committed = await commit(
          next,
          raw,
          current?.revision ?? 0,
          true,
          summaryRaw,
          parseSummaryIndex(summaryRaw),
        );
        if (committed) return committed;
      }

      throw new SessionConflictError(id);
    },

    async load(id: string): Promise<AgentSession | undefined> {
      const raw = await store.get(keyFor(id));
      return parseSession(raw);
    },

    async delete(id: string): Promise<void> {
      for (let attempt = 1; attempt <= MAXIMUM_SAVE_ATTEMPTS; attempt += 1) {
        const [raw, summaryRaw] = await Promise.all([
          store.get(keyFor(id)),
          store.get(SUMMARY_INDEX_KEY),
        ]);
        const summaries = parseSummaryIndex(summaryRaw);
        const nextSummaries = summaries ? new Map(summaries) : undefined;
        nextSummaries?.delete(id);
        const operations =
          nextSummaries && nextSummaries.size > 0
            ? [
                {
                  type: 'set' as const,
                  key: SUMMARY_INDEX_KEY,
                  value: serializeSummaryIndex(nextSummaries),
                },
              ]
            : [{ type: 'delete' as const, key: SUMMARY_INDEX_KEY }];
        const deleted = await store.conditionalBatch(
          [
            { key: keyFor(id), expectedValue: raw },
            { key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw },
          ],
          [{ type: 'delete', key: keyFor(id) }, ...operations],
        );
        if (deleted) return;
      }
      throw new SessionConflictError(id);
    },

    async list(options?: SessionListOptions): Promise<SessionSummary[]> {
      const dataKeys = await store.list(KEY_PREFIX);
      const summaryRaw = await store.get(SUMMARY_INDEX_KEY);
      let summaries = parseSummaryIndex(summaryRaw);
      if (!summaries) {
        summaries = new Map();
        await Promise.all(
          dataKeys.map(async (key) => {
            const id = key.slice(KEY_PREFIX.length);
            const raw = await store.get(key);
            const session = parseSession(raw);
            if (!session) return;
            summaries!.set(id, toSummary(session));
          }),
        );
        await store.conditionalBatch(
          [{ key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw }],
          [{ type: 'set', key: SUMMARY_INDEX_KEY, value: serializeSummaryIndex(summaries) }],
        );
      }

      // An index entry must never make a deleted or otherwise missing body
      // visible. This also keeps orphaned records from surviving migrations
      // from stores that predate the atomic data/index writes.
      const dataIds = new Set(dataKeys.map((key) => key.slice(KEY_PREFIX.length)));
      for (const id of summaries.keys()) {
        if (!dataIds.has(id)) summaries.delete(id);
      }

      // Filter by agentName when requested
      let filtered = options?.agentName
        ? [...summaries.values()].filter((s) => s.agentName === options.agentName)
        : [...summaries.values()];

      // Sort
      const sortBy = options?.sortBy ?? 'updatedAt';
      const sortOrder = options?.sortOrder ?? 'desc';
      filtered.sort((a, b) => {
        const aVal = new Date(a[sortBy]).getTime();
        const bVal = new Date(b[sortBy]).getTime();
        const primary = sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
        if (primary !== 0) return primary;
        return sortOrder === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
      });

      // Paginate
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? filtered.length;
      filtered = filtered.slice(offset, offset + limit);

      return filtered;
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
          await sessionStore.delete(session.id);
          deleted++;
        }
      }

      return deleted;
    },
  };

  return sessionStore;
}
