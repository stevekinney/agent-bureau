import type { ConditionalTextValueStore } from '@lostgradient/weft/storage/text-value-store';
import type { ConversationHistory } from 'conversationalist';
import type { JSONValue } from 'interoperability';
import type { RuntimeServices } from 'lifecycle';
import { createDefaultRuntimeServices } from 'lifecycle';

import type { AgentSession } from '../agent-session';
import type {
  SessionCleanupOptions,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from './types';

const KEY_PREFIX = 'agent-session:';
// Keep new body keys outside the legacy `agent-session:<id>` keyspace. This
// makes ids such as `body:x` coexist with the encoded id `x`.
const BODY_PREFIX = 'agent-session-v2:body:';
const SUMMARY_INDEX_KEY = 'agent-session:summary-index';
const MAXIMUM_SAVE_ATTEMPTS = 5;
const MAXIMUM_INDEX_CONTENTION_ATTEMPTS = MAXIMUM_SAVE_ATTEMPTS;
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

function encodeSessionId(id: string): string {
  let encoded = '';
  for (let index = 0; index < id.length; index += 1) {
    encoded += id.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return encoded;
}

function decodeSessionId(encoded: string): string | undefined {
  if (encoded.length % 4 !== 0) return undefined;
  let id = '';
  for (let index = 0; index < encoded.length; index += 4) {
    const chunk = encoded.slice(index, index + 4);
    if (!/^[\da-f]{4}$/i.test(chunk)) return undefined;
    const codeUnit = Number.parseInt(chunk, 16);
    id += String.fromCharCode(codeUnit);
  }
  return id;
}

async function listDataKeys(store: ConditionalTextValueStore): Promise<string[]> {
  const [legacyKeys, currentKeys] = await Promise.all([
    store.list(KEY_PREFIX),
    store.list(BODY_PREFIX),
  ]);
  return dataKeysForStore([...new Set([...legacyKeys, ...currentKeys])]);
}

function idForDataKey(key: string): string | undefined {
  if (key.startsWith(BODY_PREFIX)) {
    return decodeSessionId(key.slice(BODY_PREFIX.length));
  }
  if (key.startsWith(KEY_PREFIX) && key !== SUMMARY_INDEX_KEY) {
    return key.slice(KEY_PREFIX.length);
  }
  return undefined;
}

/**
 * Creates a SessionStore backed by the given ConditionalTextValueStore.
 *
 * Session bodies are stored under the encoded `agent-session-v2:body:` namespace
 * (with legacy `agent-session:<id>` lookup for pre-index records) and the aggregate summary
 * index uses the reserved `agent-session:summary-index` key so both can coexist with
 * other data in the same store.
 */
export interface CreateSessionStoreOptions {
  /**
   * The AB-92/AB-252/AB-253 injectable runtime-service seam. Resolved
   * exactly once at construction — omitted, this store reads the real
   * globals via `createDefaultRuntimeServices()`; a test composes its own
   * deterministic instance with `createManualRuntimeServices()` so
   * `updatedAt` refreshes and cleanup's age cutoff are fully
   * time-controlled.
   */
  runtime?: RuntimeServices;
}

export function createSessionStore(
  store: ConditionalTextValueStore,
  options: CreateSessionStoreOptions = {},
): SessionStore {
  if (typeof store.conditionalBatch !== 'function') {
    throw new TypeError('createSessionStore requires a ConditionalTextValueStore.');
  }
  const runtime = options.runtime ?? createDefaultRuntimeServices();

  let mutationTail = Promise.resolve();
  function runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function keyFor(id: string): string {
    return `${BODY_PREFIX}${encodeSessionId(id)}`;
  }

  function legacyKeyFor(id: string): string {
    return `${KEY_PREFIX}${id}`;
  }

  async function readBody(id: string): Promise<{ raw: string | null; key: string }> {
    const key = keyFor(id);
    const raw = await store.get(key);
    if (raw !== null) {
      const current = parseSession(raw);
      if (!current || current.id !== id) {
        throw new TypeError(`Session body key for "${id}" is occupied by unrelated data.`);
      }
      return { raw, key };
    }
    const legacyKey = legacyKeyFor(id);
    if (legacyKey === SUMMARY_INDEX_KEY) {
      for (let attempt = 0; attempt < MAXIMUM_SAVE_ATTEMPTS; attempt += 1) {
        const legacyRaw = await store.get(legacyKey);
        const legacySession = parseSession(legacyRaw);
        if (legacySession?.id !== id) return { raw: null, key };
        const migratedSummaries = await summariesForMutation(legacyRaw);
        migratedSummaries.set(id, toSummary(legacySession));
        const migrated = await store.conditionalBatch(
          [
            { key: legacyKey, expectedValue: legacyRaw },
            { key, expectedValue: null },
          ],
          [
            { type: 'set', key, value: legacyRaw! },
            {
              type: 'set',
              key: SUMMARY_INDEX_KEY,
              value: serializeSummaryIndex(migratedSummaries),
            },
          ],
        );
        if (migrated) return { raw: legacyRaw, key };
        const migratedRaw = await store.get(key);
        if (migratedRaw !== null) return { raw: migratedRaw, key };
      }
      throw new SessionConflictError(id, 'migrated');
    }
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
    const dataKeys = await listDataKeys(store);
    await Promise.all(
      dataKeys.map(async (key) => {
        const id = idForDataKey(key);
        const session = parseSession(await store.get(key));
        if (id !== undefined && session && session.id === id) {
          summaries.set(id, toSummary(session));
        }
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
      updatedAt: refreshUpdatedAt ? runtime.clock.nowISO() : session.updatedAt,
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
      await runMutation(async () => {
        await readBody('summary-index');
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
          if (saveConflicts >= MAXIMUM_SAVE_ATTEMPTS) {
            throw new SessionConflictError(session.id);
          }
        }

        throw new SessionConflictError(session.id);
      });
    },

    async update(
      id: string,
      updater: (
        session: AgentSession | undefined,
      ) => AgentSession | undefined | Promise<AgentSession | undefined>,
    ): Promise<AgentSession | undefined> {
      // The updater is caller code and may itself use this store. Keep it out
      // of the local mutation queue so an asynchronous updater cannot wait on
      // an operation queued behind itself. Conditional commits still provide
      // optimistic concurrency across update attempts and store instances.
      let saveConflicts = 0;
      let previousBodyRaw: string | null | undefined;
      for (let attempt = 1; attempt <= MAXIMUM_INDEX_CONTENTION_ATTEMPTS; attempt += 1) {
        await readBody('summary-index');
        const [body, summaryRaw] = await Promise.all([readBody(id), store.get(SUMMARY_INDEX_KEY)]);
        const { raw, key: bodyKey } = body;
        const current = parseSession(raw);
        const candidate = await updater(current);
        if (!candidate) return undefined;
        if (candidate.id !== id) {
          throw new TypeError(`Session updater for "${id}" returned id "${candidate.id}".`);
        }

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
      await runMutation(async () => {
        await readBody('summary-index');
        await readBody(id);
        let deleteConflicts = 0;
        let previousBodyValues: string | undefined;
        for (let attempt = 1; attempt <= MAXIMUM_INDEX_CONTENTION_ATTEMPTS; attempt += 1) {
          const currentKey = keyFor(id);
          const legacyKey = legacyKeyFor(id);
          const [currentRaw, legacyRaw, summaryRaw] = await Promise.all([
            store.get(currentKey),
            legacyKey === SUMMARY_INDEX_KEY ? Promise.resolve(null) : store.get(legacyKey),
            store.get(SUMMARY_INDEX_KEY),
          ]);
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
              { key: currentKey, expectedValue: currentRaw },
              ...(legacyKey === SUMMARY_INDEX_KEY
                ? []
                : [{ key: legacyKey, expectedValue: legacyRaw }]),
              { key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw },
            ],
            [
              { type: 'delete', key: currentKey },
              ...(legacyKey === SUMMARY_INDEX_KEY
                ? []
                : [{ type: 'delete' as const, key: legacyKey }]),
              ...operations,
            ],
          );
          if (deleted) return;
          const bodyValues = JSON.stringify([currentRaw, legacyRaw]);
          if (previousBodyValues !== undefined && previousBodyValues !== bodyValues) {
            deleteConflicts += 1;
          }
          previousBodyValues = bodyValues;
          if (deleteConflicts >= MAXIMUM_SAVE_ATTEMPTS) {
            throw new SessionConflictError(id, 'deleted');
          }
        }
        throw new SessionConflictError(id, 'deleted');
      });
    },

    async list(options?: SessionListOptions): Promise<SessionSummary[]> {
      return runMutation(async () => {
        let summaryRaw = await store.get(SUMMARY_INDEX_KEY);
        let summaries = parseSummaryIndex(summaryRaw);
        if (!summaries) {
          const dataKeys = await listDataKeys(store);
          const rebuiltSummaries = new Map<string, SessionSummary>();
          const legacyIndexSession = parseSession(summaryRaw);
          const migratesLegacyIndexSession = legacyIndexSession?.id === 'summary-index';
          if (migratesLegacyIndexSession) {
            rebuiltSummaries.set(legacyIndexSession.id, toSummary(legacyIndexSession));
          }
          await Promise.all(
            dataKeys.map(async (key) => {
              const id = idForDataKey(key);
              const raw = await store.get(key);
              const session = parseSession(raw);
              if (id === undefined || !session || session.id !== id) return;
              rebuiltSummaries.set(id, toSummary(session));
            }),
          );
          const rebuilt = await store.conditionalBatch(
            [
              { key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw },
              ...(migratesLegacyIndexSession
                ? [{ key: keyFor(legacyIndexSession.id), expectedValue: null }]
                : []),
            ],
            [
              ...(migratesLegacyIndexSession
                ? [
                    {
                      type: 'set' as const,
                      key: keyFor(legacyIndexSession.id),
                      value: JSON.stringify(legacyIndexSession),
                    },
                  ]
                : []),
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
      });
    },

    async exists(id: string): Promise<boolean> {
      // `has` is a required member of Weft's TextValueStore (0.2.1), so the
      // existence check needs no get-based fallback.
      const legacyKey = legacyKeyFor(id);
      if (legacyKey === SUMMARY_INDEX_KEY) {
        const body = await readBody(id);
        return body.raw !== null;
      }
      return (await store.has(keyFor(id))) || (await store.has(legacyKey));
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
      return runMutation(async () => {
        const cutoff = runtime.clock.now() - options.olderThan;
        await readBody('summary-index');
        for (let attempt = 0; attempt < MAXIMUM_INDEX_CONTENTION_ATTEMPTS; attempt += 1) {
          const keys = await listDataKeys(store);
          const representations = new Map<
            string,
            Array<{ key: string; raw: string; session: AgentSession }>
          >();
          await Promise.all(
            keys.map(async (key) => {
              const raw = await store.get(key);
              const id = idForDataKey(key);
              const session = parseSession(raw);
              if (id === undefined || raw === null || !session || session.id !== id) return;
              const records = representations.get(id) ?? [];
              records.push({ key, raw, session });
              representations.set(id, records);
            }),
          );
          const expired = new Map<string, Array<{ key: string; raw: string }>>();
          for (const [id, records] of representations) {
            const newest = records.reduce((current, candidate) =>
              new Date(candidate.session.updatedAt).getTime() >
              new Date(current.session.updatedAt).getTime()
                ? candidate
                : current,
            );
            const canonical = records.find(({ key }) => key === keyFor(id)) ?? newest;
            if (options.agentName && canonical.session.agentName !== options.agentName) continue;
            if (records.some(({ session }) => new Date(session.updatedAt).getTime() >= cutoff)) {
              continue;
            }
            expired.set(
              id,
              records.map(({ key, raw }) => ({ key, raw })),
            );
          }
          if (expired.size === 0) return 0;

          const summaryRaw = await store.get(SUMMARY_INDEX_KEY);
          const nextSummaries = await summariesForMutation(summaryRaw);
          for (const id of expired.keys()) nextSummaries.delete(id);
          const indexOperation =
            nextSummaries.size > 0
              ? {
                  type: 'set' as const,
                  key: SUMMARY_INDEX_KEY,
                  value: serializeSummaryIndex(nextSummaries),
                }
              : { type: 'delete' as const, key: SUMMARY_INDEX_KEY };
          const records = [...expired.values()].flat();
          const committed = await store.conditionalBatch(
            [
              ...records.map(({ key, raw }) => ({ key, expectedValue: raw })),
              { key: SUMMARY_INDEX_KEY, expectedValue: summaryRaw },
            ],
            [...records.map(({ key }) => ({ type: 'delete' as const, key })), indexOperation],
          );
          if (committed) return expired.size;
        }
        throw new SessionConflictError('cleanup', 'completed');
      });
    },
  };

  return sessionStore;
}
