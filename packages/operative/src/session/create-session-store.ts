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
const BODY_PREFIX = 'agent-session:body:';
const SUMMARY_INDEX_KEY = 'agent-session:summary-index';
const MAXIMUM_SAVE_ATTEMPTS = 5;
const MAXIMUM_INDEX_CONTENTION_ATTEMPTS = 50;
const DEFAULT_SESSION_LIST_LIMIT = 100;
const SUMMARY_FORMAT_VERSION = 1;

export class SessionConflictError extends Error {
  readonly code = 'SessionConflictError';

  constructor(sessionId: string, operation = 'committed') {
    super(
      `Session "${sessionId}" could not be ${operation} after ${MAXIMUM_SAVE_ATTEMPTS} conflicts.`,
    );
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

function parseSummaryRecord(
  record: Record<string, unknown>,
  expectedId?: string,
): SessionSummary | undefined {
  if (
    record['formatVersion'] !== SUMMARY_FORMAT_VERSION ||
    typeof record['id'] !== 'string' ||
    (expectedId !== undefined && record['id'] !== expectedId) ||
    typeof record['agentName'] !== 'string' ||
    typeof record['messageCount'] !== 'number' ||
    !isValidDate(record['createdAt']) ||
    !isValidDate(record['updatedAt'])
  )
    return undefined;
  return {
    id: record['id'],
    agentName: record['agentName'],
    messageCount: record['messageCount'],
    createdAt: record['createdAt'] as string,
    updatedAt: record['updatedAt'] as string,
    metadata:
      typeof record['metadata'] === 'object' &&
      record['metadata'] !== null &&
      !Array.isArray(record['metadata'])
        ? (record['metadata'] as Record<string, JSONValue>)
        : {},
  };
}

function parseSummaryIndex(raw: string | null): Map<string, SessionSummary> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      record['formatVersion'] !== SUMMARY_FORMAT_VERSION ||
      typeof record['summaries'] !== 'object' ||
      record['summaries'] === null ||
      Array.isArray(record['summaries'])
    ) {
      return undefined;
    }
    const summaries = new Map<string, SessionSummary>();
    for (const [id, value] of Object.entries(record['summaries'] as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      const summary = parseSummaryRecord(
        { ...(value as Record<string, unknown>), formatVersion: SUMMARY_FORMAT_VERSION },
        id,
      );
      if (!summary) return undefined;
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

function dataKeysForStore(keys: string[]): string[] {
  return keys.filter((key) => key !== SUMMARY_INDEX_KEY);
}

function idForDataKey(key: string): string | undefined {
  if (key.startsWith(BODY_PREFIX)) {
    try {
      return decodeURIComponent(key.slice(BODY_PREFIX.length));
    } catch {
      return undefined;
    }
  }
  if (key.startsWith(KEY_PREFIX) && key !== SUMMARY_INDEX_KEY) {
    return key.slice(KEY_PREFIX.length);
  }
  return undefined;
}

/**
 * Creates a SessionStore backed by the given ConditionalTextValueStore.
 *
 * Session bodies are stored under the encoded `agent-session:body:` namespace
 * (with legacy `agent-session:<id>` lookup for pre-index records) and the aggregate summary
 * index uses the reserved `agent-session:summary-index` key so both can coexist with
 * other data in the same store.
 */
export function createSessionStore(store: ConditionalTextValueStore): SessionStore {
  if (typeof store.conditionalBatch !== 'function') {
    throw new TypeError('createSessionStore requires a ConditionalTextValueStore.');
  }

  function keyFor(id: string): string {
    return `${BODY_PREFIX}${encodeURIComponent(id)}`;
  }

  function legacyKeyFor(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  async function readBody(id: string): Promise<{ raw: string | null; key: string }> {
    const key = keyFor(id);
    const raw = await store.get(key);
    if (raw !== null) return { raw, key };
    const legacyKey = legacyKeyFor(id);
    if (legacyKey === SUMMARY_INDEX_KEY) return { raw: null, key };
    const legacyRaw = await store.get(legacyKey);
    return legacyRaw === null ? { raw: null, key } : { raw: legacyRaw, key: legacyKey };
  }

  async function summariesForMutation(
    summaryRaw: string | null,
  ): Promise<Map<string, SessionSummary>> {
    const parsed = parseSummaryIndex(summaryRaw);
    if (parsed) return parsed;

    // A malformed index cannot safely be edited in place: doing so would
    // discard summaries for bodies that are still present. Rebuild it from
    // the source of truth before applying the requested mutation.
    const summaries = new Map<string, SessionSummary>();
    const listedKeys = await store.list(KEY_PREFIX);
    const dataKeys = dataKeysForStore(listedKeys);
    await Promise.all(
      dataKeys.map(async (key) => {
        const id = idForDataKey(key);
        const session = parseSession(await store.get(key));
        if (id && session && session.id === id) summaries.set(id, toSummary(session));
      }),
    );
    return summaries;
  }

  async function commit(
    session: AgentSession,
    bodyKey: string,
    expectedValue: string | null,
    currentRevision: number,
    refreshUpdatedAt: boolean,
    expectedSummaryValue: string | null,
    currentSummaries: Map<string, SessionSummary>,
  ): Promise<AgentSession | undefined> {
    const next: AgentSession = {
      ...session,
      revision: currentRevision + 1,
      updatedAt: refreshUpdatedAt ? new Date().toISOString() : session.updatedAt,
    };
    const committed = await store.conditionalBatch(
      [
        { key: bodyKey, expectedValue },
        { key: SUMMARY_INDEX_KEY, expectedValue: expectedSummaryValue },
      ],
      [
        { type: 'set', key: bodyKey, value: JSON.stringify(next) },
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
      let saveConflicts = 0;
      let previousBodyRaw: string | null | undefined;
      for (let attempt = 1; attempt <= MAXIMUM_INDEX_CONTENTION_ATTEMPTS; attempt += 1) {
        const [body, summaryRaw] = await Promise.all([
          readBody(session.id),
          store.get(SUMMARY_INDEX_KEY),
        ]);
        const { raw, key: bodyKey } = body;
        const current = parseSession(raw);
        const candidate = current ? mergeSessions(current, session) : session;
        const committed = await commit(
          candidate,
          bodyKey,
          raw,
          current?.revision ?? 0,
          true,
          summaryRaw,
          await summariesForMutation(summaryRaw),
        );
        if (committed) {
          Object.assign(session, committed);
          return;
        }
        if (previousBodyRaw !== undefined && previousBodyRaw !== raw) saveConflicts += 1;
        previousBodyRaw = raw;
        if (saveConflicts >= MAXIMUM_SAVE_ATTEMPTS) throw new SessionConflictError(session.id);
      }

      throw new SessionConflictError(session.id);
    },

    async update(
      id: string,
      updater: (
        session: AgentSession | undefined,
      ) => AgentSession | undefined | Promise<AgentSession | undefined>,
    ): Promise<AgentSession | undefined> {
      let saveConflicts = 0;
      let previousBodyRaw: string | null | undefined;
      for (let attempt = 1; attempt <= MAXIMUM_INDEX_CONTENTION_ATTEMPTS; attempt += 1) {
        const [body, summaryRaw] = await Promise.all([readBody(id), store.get(SUMMARY_INDEX_KEY)]);
        const { raw, key: bodyKey } = body;
        const current = parseSession(raw);
        const candidate = await updater(current);
        if (!candidate) return undefined;

        const next = current ? mergeSessions(current, candidate) : candidate;
        const committed = await commit(
          next,
          bodyKey,
          raw,
          current?.revision ?? 0,
          true,
          summaryRaw,
          await summariesForMutation(summaryRaw),
        );
        if (committed) return committed;
        if (previousBodyRaw !== undefined && previousBodyRaw !== raw) saveConflicts += 1;
        previousBodyRaw = raw;
        if (saveConflicts >= MAXIMUM_SAVE_ATTEMPTS) throw new SessionConflictError(id);
      }

      throw new SessionConflictError(id);
    },

    async load(id: string): Promise<AgentSession | undefined> {
      const { raw } = await readBody(id);
      return parseSession(raw);
    },

    async delete(id: string): Promise<void> {
      let deleteConflicts = 0;
      let previousBodyRaw: string | null | undefined;
      for (let attempt = 1; attempt <= MAXIMUM_INDEX_CONTENTION_ATTEMPTS; attempt += 1) {
        const [body, summaryRaw] = await Promise.all([readBody(id), store.get(SUMMARY_INDEX_KEY)]);
        const { raw, key: bodyKey } = body;
        const nextSummaries = await summariesForMutation(summaryRaw);
        nextSummaries.delete(id);
        const operations =
          nextSummaries.size > 0
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
            { key: bodyKey, expectedValue: raw },
            { key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw },
          ],
          [{ type: 'delete', key: bodyKey }, ...operations],
        );
        if (deleted) return;
        if (previousBodyRaw !== undefined && previousBodyRaw !== raw) deleteConflicts += 1;
        previousBodyRaw = raw;
        if (deleteConflicts >= MAXIMUM_SAVE_ATTEMPTS) {
          throw new SessionConflictError(id, 'deleted');
        }
      }
      throw new SessionConflictError(id, 'deleted');
    },

    async list(options?: SessionListOptions): Promise<SessionSummary[]> {
      let summaryRaw = await store.get(SUMMARY_INDEX_KEY);
      let summaries = parseSummaryIndex(summaryRaw);
      if (!summaries) {
        const listedKeys = await store.list(KEY_PREFIX);
        const dataKeys = dataKeysForStore(listedKeys);
        const rebuiltSummaries = new Map<string, SessionSummary>();
        await Promise.all(
          dataKeys.map(async (key) => {
            const id = idForDataKey(key);
            const raw = await store.get(key);
            const session = parseSession(raw);
            if (!id || !session || session.id !== id) return;
            rebuiltSummaries.set(id, toSummary(session));
          }),
        );
        const rebuilt = await store.conditionalBatch(
          [{ key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw }],
          [
            {
              type: 'set',
              key: SUMMARY_INDEX_KEY,
              value: serializeSummaryIndex(rebuiltSummaries),
            },
          ],
        );
        if (rebuilt) {
          summaries = rebuiltSummaries;
          summaryRaw = serializeSummaryIndex(summaries);
        } else {
          const latestRaw = await store.get(SUMMARY_INDEX_KEY);
          const latestSummaries = parseSummaryIndex(latestRaw);
          if (latestSummaries) {
            summaries = latestSummaries;
            summaryRaw = latestRaw;
          } else {
            summaries = rebuiltSummaries;
          }
        }
      }

      // Filter by agentName when requested
      const filtered = options?.agentName
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
        const compareIds = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        return sortOrder === 'asc' ? compareIds : -compareIds;
      });

      // A valid aggregate index is the complete candidate set. Read only
      // enough body keys to fill the requested page; legacy and malformed
      // indexes above still rebuild from every body key.
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? DEFAULT_SESSION_LIST_LIMIT;
      if (limit <= 0) return [];
      const page: SessionSummary[] = [];
      const missingIds: string[] = [];
      let seen = 0;
      for (const summary of filtered) {
        const { raw: body } = await readBody(summary.id);
        const session = parseSession(body);
        if (!session || session.id !== summary.id) {
          missingIds.push(summary.id);
          continue;
        }
        if (seen < offset) {
          seen += 1;
          continue;
        }
        page.push(summary);
        if (page.length >= limit) break;
      }

      // Remove only ids confirmed missing by the body reads. On a CAS
      // conflict, reread both the index and each missing body so a concurrent
      // save cannot be mistaken for an orphan and then pruned.
      for (
        let attempt = 0;
        missingIds.length > 0 && attempt < MAXIMUM_SAVE_ATTEMPTS;
        attempt += 1
      ) {
        const current = parseSummaryIndex(summaryRaw);
        if (!current) break;
        const stillMissing: string[] = [];
        for (const id of missingIds) {
          const { raw: body } = await readBody(id);
          const session = parseSession(body);
          if (!session || session.id !== id) stillMissing.push(id);
        }
        if (stillMissing.length === 0) break;
        const repaired = new Map(current);
        for (const id of stillMissing) repaired.delete(id);
        const committed = await store.conditionalBatch(
          [{ key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw }],
          [{ type: 'set', key: SUMMARY_INDEX_KEY, value: serializeSummaryIndex(repaired) }],
        );
        if (committed) break;
        summaryRaw = await store.get(SUMMARY_INDEX_KEY);
      }

      return page;
    },

    async exists(id: string): Promise<boolean> {
      // `has` is a required member of Weft's TextValueStore (0.2.1), so the
      // existence check needs no get-based fallback.
      const legacyKey = legacyKeyFor(id);
      return (
        (await store.has(keyFor(id))) ||
        (legacyKey !== SUMMARY_INDEX_KEY && (await store.has(legacyKey)))
      );
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
      const listedKeys = await store.list(KEY_PREFIX);
      const keys = dataKeysForStore(listedKeys);
      const cutoff = Date.now() - options.olderThan;
      let deleted = 0;

      for (const key of keys) {
        const raw = await store.get(key);
        const id = idForDataKey(key);
        const session = parseSession(raw);
        if (!id || !session || session.id !== id) continue;

        if (options.agentName && session.agentName !== options.agentName) continue;

        const updatedAt = new Date(session.updatedAt).getTime();
        if (updatedAt < cutoff) {
          await sessionStore.delete(id);
          deleted++;
        }
      }

      return deleted;
    },
  };

  return sessionStore;
}
