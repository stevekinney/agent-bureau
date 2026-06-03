import type { TextValueStore } from '@lostgradient/weft/storage';
import type { ConversationSnapshot } from 'conversationalist';

import type { RunCheckpoint, RunCursor, StepRecord } from './types';

/**
 * Key layout for durable run checkpoints. All keys are namespaced under
 * `durable-run:{runId}:` so a single backing store can hold many runs alongside
 * sessions, cache, and identity data without collision.
 */
const keys = {
  cursor: (runId: string) => `durable-run:${runId}:cursor`,
  transcript: (runId: string) => `durable-run:${runId}:transcript`,
  stepPrefix: (runId: string) => `durable-run:${runId}:step:`,
  /** Steps are zero-padded so lexicographic `list()` order matches step order. */
  step: (runId: string, step: number) =>
    `durable-run:${runId}:step:${String(step).padStart(10, '0')}`,
} as const;

/**
 * A durable store for agent-run checkpoints, backed by a Weft
 * {@link TextValueStore}. Persists three independent pieces per run:
 *
 * - the {@link RunCursor} (`{ step }`) — the minimal resume position,
 * - a {@link ConversationSnapshot} of the run transcript (plain, cloneable),
 * - one {@link StepRecord} per completed step (no `Conversation` instance).
 *
 * Splitting them lets the durable workflow commit the cheap cursor at every
 * yield while writing the heavier transcript only at step boundaries.
 */
export interface CheckpointStore {
  saveCursor(runId: string, cursor: RunCursor): Promise<void>;
  loadCursor(runId: string): Promise<RunCursor | null>;
  saveConversation(runId: string, snapshot: ConversationSnapshot): Promise<void>;
  loadConversation(runId: string): Promise<ConversationSnapshot | null>;
  saveStep(runId: string, record: StepRecord): Promise<void>;
  loadSteps(runId: string): Promise<StepRecord[]>;
  /** Assemble the full checkpoint from its persisted pieces. */
  loadCheckpoint(runId: string): Promise<RunCheckpoint>;
  /** Remove every key for a run. Returns the number of keys deleted. */
  clear(runId: string): Promise<number>;
}

/** Parse JSON, returning `null` on malformed data rather than throwing. */
function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Creates a {@link CheckpointStore} backed by the given {@link TextValueStore}.
 *
 * Values are JSON-serialized strings; the store treats them as opaque, matching
 * how every other agent-bureau persistence layer (sessions, identity, skills)
 * uses the text-value surface.
 */
export function createCheckpointStore(store: TextValueStore): CheckpointStore {
  const checkpointStore: CheckpointStore = {
    async saveCursor(runId, cursor) {
      await store.set(keys.cursor(runId), JSON.stringify(cursor));
    },

    async loadCursor(runId) {
      return parseJson<RunCursor>(await store.get(keys.cursor(runId)));
    },

    async saveConversation(runId, snapshot) {
      await store.set(keys.transcript(runId), JSON.stringify(snapshot));
    },

    async loadConversation(runId) {
      return parseJson<ConversationSnapshot>(await store.get(keys.transcript(runId)));
    },

    async saveStep(runId, record) {
      await store.set(keys.step(runId, record.step), JSON.stringify(record));
    },

    async loadSteps(runId) {
      const stepKeys = await store.list(keys.stepPrefix(runId));
      // `list()` returns keys in lexicographic order; zero-padded step indices
      // make that match numeric step order, so no re-sort is required.
      const records: StepRecord[] = [];
      for (const key of stepKeys) {
        const record = parseJson<StepRecord>(await store.get(key));
        if (record) records.push(record);
      }
      return records;
    },

    async loadCheckpoint(runId) {
      const [cursor, conversation, steps] = await Promise.all([
        checkpointStore.loadCursor(runId),
        checkpointStore.loadConversation(runId),
        checkpointStore.loadSteps(runId),
      ]);
      return {
        runId,
        cursor: cursor ?? { step: 0 },
        conversation,
        steps,
      };
    },

    async clear(runId) {
      const prefix = `durable-run:${runId}:`;
      if (store.deletePrefix) {
        return store.deletePrefix(prefix);
      }
      // Fallback for stores without a native prefix delete.
      // TODO(weft-integration): Weft's TextValueStore always provides
      // deletePrefix today, so this branch is unreachable with the real
      // backend; it exists only to keep CheckpointStore decoupled from that
      // guarantee for structural test doubles.
      const allKeys = await store.list(prefix);
      for (const key of allKeys) {
        await store.delete(key);
      }
      return allKeys.length;
    },
  };

  return checkpointStore;
}
