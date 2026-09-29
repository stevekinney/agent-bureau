import { cosineSimilarity, type EmbeddingVectorLike } from '@lostgradient/embeddings';

import {
  type MemoryRecord,
  type MemoryRecordReference,
  type MemoryRecordScope,
  type MemoryRecordStorage,
  type MemoryRecordUpdateOptions,
  MemoryRecordVersionConflictError,
  type MemoryVectorSearchResult,
} from '../memory-record-storage';

/**
 * Deterministic hash-based embedder for testing.
 * Same text always produces the same vector. Different texts produce different vectors.
 */
export function createMockEmbedder(dimension: number = 128): (texts: string[]) => number[][] {
  return (texts: string[]): number[][] => {
    return texts.map((text) => textToVector(text, dimension));
  };
}

function textToVector(text: string, dimension: number): number[] {
  const vector = Array.from({ length: dimension }, () => 0);

  // Simple deterministic hash seeding
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  // Generate deterministic pseudo-random values from the hash
  for (let i = 0; i < dimension; i++) {
    hash = ((hash << 13) ^ hash) | 0;
    hash = (hash * 1597 + 51749) | 0;
    vector[i] = (hash & 0x7fffffff) / 0x7fffffff;
  }

  // Normalize to unit vector
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimension; i++) {
      vector[i] = vector[i]! / magnitude;
    }
  }

  return vector;
}

/**
 * Builds the lookup key that isolates a record by scope. Records never leak
 * across `{ tenantId, namespace }` boundaries because the scope is folded into
 * the map key alongside the record id.
 */
function scopeMapKey(scope: MemoryRecordScope, id: string): string {
  return `${scope.tenantId ?? ''}\u0000${scope.namespace}\u0000${id}`;
}

function scopeMatches(record: MemoryRecord, scope: MemoryRecordScope): boolean {
  return record.namespace === scope.namespace && (record.tenantId ?? '') === (scope.tenantId ?? '');
}

function dedupeMapKey(scope: MemoryRecordScope, dedupeKey: string): string {
  return `${scope.tenantId ?? ''}\0${scope.namespace}\0${dedupeKey}`;
}

function requireRecordDedupeKey(record: MemoryRecord): string {
  const dedupeKey = record.metadata['dedupeKey'];
  if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) {
    throw new Error('record.metadata.dedupeKey must be a non-empty string.');
  }
  return dedupeKey;
}

/**
 * Returns a defensive deep copy of a record. The Weft backend decodes a fresh
 * object on every read; cloning here keeps the in-memory helper behaviorally
 * identical so callers can never mutate stored state through a read result.
 */
function cloneRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    vector: new Float32Array(record.vector),
    metadata: { ...record.metadata },
  };
}

/**
 * In-memory {@link MemoryRecordStorage} for tests.
 *
 * Mirrors the local Weft backend's observable contract exactly so the two are
 * behaviorally interchangeable: physical delete (drops the entry, returns
 * whether one existed), newest-first `list()`, `status: 'active'` on every
 * stored record, `version` starting at `1` and bumping on `update()`, and
 * scope-isolated reads. Vector similarity is scored with the same
 * `cosineSimilarity` from `interoperability` the local backend uses.
 */
export interface InMemoryMemoryRecordStorageOptions {
  /**
   * Clock used to stamp `updatedAt` on `update()`. Defaults to the real `Date.now` so ordinary
   * callers are unaffected; a deterministic test injects a fixed or stepped clock here instead
   * of reaching a real wall clock (AB-278's determinism gate flags a direct `Date.now()` call
   * site inside this directory).
   */
  now?: () => number;
}

export function createInMemoryMemoryRecordStorage(
  options: InMemoryMemoryRecordStorageOptions = {},
): MemoryRecordStorage {
  const now = options.now ?? Date.now;
  const records = new Map<string, MemoryRecord>();
  const dedupeKeys = new Map<string, string>();

  function liveInScope(scope: MemoryRecordScope): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    for (const record of records.values()) {
      if (record.status === 'active' && scopeMatches(record, scope)) {
        out.push(record);
      }
    }
    return out;
  }

  function removeDedupeIndex(record: MemoryRecord): void {
    const dedupeKey = record.metadata['dedupeKey'];
    if (typeof dedupeKey !== 'string') return;
    dedupeKeys.delete(
      dedupeMapKey(
        {
          ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
          namespace: record.namespace,
        },
        dedupeKey,
      ),
    );
  }

  return {
    async init(): Promise<void> {},
    async close(): Promise<void> {},

    async put(record: MemoryRecord): Promise<void> {
      const scope: MemoryRecordScope = {
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        namespace: record.namespace,
      };
      const key = scopeMapKey(scope, record.id);
      const previous = records.get(key);
      if (previous) removeDedupeIndex(previous);
      records.set(key, {
        ...record,
        vector: new Float32Array(record.vector),
        metadata: { ...record.metadata },
      });
      const dedupeKey = record.metadata['dedupeKey'];
      if (record.status === 'active' && typeof dedupeKey === 'string') {
        dedupeKeys.set(dedupeMapKey(scope, dedupeKey), record.id);
      }
    },

    async getByDedupeKey(
      scope: MemoryRecordScope,
      dedupeKey: string,
    ): Promise<MemoryRecord | undefined> {
      const existingId = dedupeKeys.get(dedupeMapKey(scope, dedupeKey));
      if (existingId === undefined) return undefined;
      const existing = records.get(scopeMapKey(scope, existingId));
      return existing && existing.status === 'active' ? cloneRecord(existing) : undefined;
    },

    async putOnce(record: MemoryRecord) {
      if (record.status !== 'active') {
        throw new Error('putOnce requires an active record.');
      }
      const dedupeKey = requireRecordDedupeKey(record);
      const scope: MemoryRecordScope = {
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        namespace: record.namespace,
      };
      const dedupeIndexKey = dedupeMapKey(scope, dedupeKey);
      const existingId = dedupeKeys.get(dedupeIndexKey);
      if (existingId !== undefined) {
        const existing = records.get(scopeMapKey(scope, existingId));
        if (existing && existing.status === 'active')
          return { record: cloneRecord(existing), inserted: false };
      }

      records.set(scopeMapKey(scope, record.id), cloneRecord(record));
      dedupeKeys.set(dedupeIndexKey, record.id);
      return { record: cloneRecord(record), inserted: true };
    },

    async get(id: string, scope: MemoryRecordScope): Promise<MemoryRecord | undefined> {
      const record = records.get(scopeMapKey(scope, id));
      if (!record || record.status !== 'active') return undefined;
      return cloneRecord(record);
    },

    async getMany(ids: string[], scope: MemoryRecordScope): Promise<MemoryRecord[]> {
      const out: MemoryRecord[] = [];
      for (const id of ids) {
        const record = records.get(scopeMapKey(scope, id));
        if (record && record.status === 'active') out.push(cloneRecord(record));
      }
      return out;
    },

    async list(
      scope: MemoryRecordScope,
      listOptions?: { limit?: number; offset?: number },
    ): Promise<MemoryRecord[]> {
      const sorted = liveInScope(scope).toSorted((a, b) => b.createdAt - a.createdAt);
      const offset = listOptions?.offset ?? 0;
      const limit = listOptions?.limit ?? sorted.length;
      return sorted.slice(offset, offset + limit).map(cloneRecord);
    },

    async count(scope: MemoryRecordScope): Promise<number> {
      return liveInScope(scope).length;
    },

    /**
     * Brute-force exact cosine similarity over every live record in scope,
     * mirroring the Weft local backend so the two stay behaviorally identical
     * under `runMemoryRecordStorageContract`. No vector index by design — see
     * {@link MemoryRecordStorage.searchByVector}.
     */
    async searchByVector(
      vector: EmbeddingVectorLike,
      scope: MemoryRecordScope,
      searchOptions: { limit: number; threshold?: number },
    ): Promise<MemoryVectorSearchResult[]> {
      const scored: MemoryVectorSearchResult[] = liveInScope(scope).map((record) => ({
        id: record.id,
        score: cosineSimilarity(vector, record.vector),
        record: cloneRecord(record),
      }));
      const filtered =
        searchOptions.threshold === undefined
          ? scored
          : scored.filter((hit) => hit.score >= searchOptions.threshold!);
      return filtered.toSorted((a, b) => b.score - a.score).slice(0, searchOptions.limit);
    },

    async update(
      id: string,
      scope: MemoryRecordScope,
      patch: { content?: string; vector?: Float32Array; metadata?: Record<string, unknown> },
      updateOptions: MemoryRecordUpdateOptions = {},
    ): Promise<MemoryRecord | undefined> {
      const key = scopeMapKey(scope, id);
      const existing = records.get(key);
      if (!existing || existing.status !== 'active') return undefined;
      // Check and write with no await in between: nothing can change the record
      // after the version is compared, which is this helper's compare-and-swap.
      if (
        updateOptions.expectedVersion !== undefined &&
        existing.version !== updateOptions.expectedVersion
      ) {
        throw new MemoryRecordVersionConflictError([id]);
      }

      const updated: MemoryRecord = {
        ...existing,
        content: patch.content ?? existing.content,
        vector: patch.vector ? new Float32Array(patch.vector) : new Float32Array(existing.vector),
        metadata: patch.metadata ? { ...patch.metadata } : { ...existing.metadata },
        updatedAt: now(),
        version: existing.version + 1,
      };
      removeDedupeIndex(existing);
      records.set(key, updated);
      const dedupeKey = updated.metadata['dedupeKey'];
      if (updated.status === 'active' && typeof dedupeKey === 'string') {
        dedupeKeys.set(dedupeMapKey(scope, dedupeKey), updated.id);
      }
      return cloneRecord(updated);
    },

    async delete(id: string, scope: MemoryRecordScope): Promise<boolean> {
      const key = scopeMapKey(scope, id);
      const existing = records.get(key);
      const removed = records.delete(key);
      if (removed && existing) {
        const dedupeKey = existing.metadata['dedupeKey'];
        if (typeof dedupeKey === 'string') {
          dedupeKeys.delete(dedupeMapKey(scope, dedupeKey));
        }
      }
      return removed;
    },

    async deleteMany(references: readonly MemoryRecordReference[]): Promise<number> {
      // Synchronous map mutations with no await between them: no other caller
      // can observe a partially applied deletion, which is this helper's
      // equivalent of the Weft backend's single atomic batch. Every version
      // condition is checked before anything is removed.
      for (const reference of references) {
        const existing = records.get(scopeMapKey(reference.scope, reference.id));
        if (
          existing?.status === 'active' &&
          reference.expectedVersion !== undefined &&
          existing.version !== reference.expectedVersion
        ) {
          throw new MemoryRecordVersionConflictError([reference.id]);
        }
      }
      let removed = 0;
      for (const reference of references) {
        const key = scopeMapKey(reference.scope, reference.id);
        const existing = records.get(key);
        if (existing?.status !== 'active') continue;
        records.delete(key);
        removeDedupeIndex(existing);
        removed++;
      }
      return removed;
    },

    async deleteNamespace(scope: MemoryRecordScope): Promise<number> {
      let removed = 0;
      for (const [key, record] of records) {
        if (scopeMatches(record, scope)) {
          records.delete(key);
          removed++;
        }
      }
      for (const key of dedupeKeys.keys()) {
        if (key.startsWith(`${scope.tenantId ?? ''}\0${scope.namespace}\0`)) {
          dedupeKeys.delete(key);
        }
      }
      return removed;
    },
  };
}
