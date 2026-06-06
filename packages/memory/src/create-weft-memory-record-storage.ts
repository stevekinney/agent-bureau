import {
  encodeStorageKeyComponent,
  type Storage,
  storageCount,
  storageDeletePrefix,
  storageKeys,
} from '@lostgradient/weft/storage/interface';
import { cosineSimilarity, type EmbeddingVectorLike } from 'interoperability';

import type {
  MemoryRecord,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemoryVectorSearchResult,
} from './memory-record-storage';

/**
 * Default key prefix under which every memory record is stored. Chosen to be
 * disjoint from every entry in `WEFT_RESERVED_KEY_PREFIXES`, so memory records
 * and Weft's own engine keys can share one underlying {@link Storage} without
 * colliding (asserted in a unit test).
 */
export const DEFAULT_MEMORY_KEY_PREFIX = 'app:agent-bureau:memory:v1:';

/**
 * Options for {@link createWeftMemoryRecordStorage}.
 */
export interface CreateWeftMemoryRecordStorageOptions {
  /**
   * Key prefix for every stored record. Defaults to
   * {@link DEFAULT_MEMORY_KEY_PREFIX}. Must not collide with
   * `WEFT_RESERVED_KEY_PREFIXES`.
   */
  keyPrefix?: string;
  /**
   * When `true`, `close()` disposes the underlying {@link Storage}. Defaults to
   * `false` — the backend is a non-owning view over storage shared with (e.g.)
   * a Weft engine, and tearing that down here would be incorrect.
   */
  disposeUnderlyingStorage?: boolean;
}

/**
 * Serializable form of a {@link MemoryRecord}. The dense `vector` is persisted
 * as a plain `number[]` because `Float32Array` does not survive JSON
 * round-trips; it is rehydrated to a `Float32Array` on read.
 */
interface StoredMemoryRecord {
  id: string;
  tenantId?: string;
  namespace: string;
  content: string;
  vector: number[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  version: number;
  status: 'active' | 'deleted';
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeRecord(record: MemoryRecord): Uint8Array {
  const stored: StoredMemoryRecord = {
    id: record.id,
    ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
    namespace: record.namespace,
    content: record.content,
    vector: Array.from(record.vector),
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    status: record.status,
  };
  return textEncoder.encode(JSON.stringify(stored));
}

function decodeRecord(bytes: Uint8Array): MemoryRecord {
  const stored = JSON.parse(textDecoder.decode(bytes)) as StoredMemoryRecord;
  return {
    id: stored.id,
    ...(stored.tenantId !== undefined ? { tenantId: stored.tenantId } : {}),
    namespace: stored.namespace,
    content: stored.content,
    vector: new Float32Array(stored.vector),
    metadata: stored.metadata,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    version: stored.version,
    status: stored.status,
  };
}

/**
 * Creates a {@link MemoryRecordStorage} backed by a Weft {@link Storage}.
 *
 * Records are JSON-encoded under
 * `<keyPrefix>t:<tenantId>:n:<namespace>:<id>`, where the `tenantId` and
 * `namespace` components are percent-encoded with
 * {@link encodeStorageKeyComponent} so the colon delimiters can never be
 * injected. This layout lets every scoped read prefix-scan `{ tenantId,
 * namespace }` without enumerating other scopes.
 *
 * This is the LOCAL backend: `delete()` and `deleteNamespace()` physically
 * remove the underlying rows. Stored records therefore always carry
 * `status: 'active'`; `version` starts at `1` and is incremented on every
 * `update()`. (The Cloudflare backend, a later phase, keeps `status: 'deleted'`
 * tombstones; both satisfy the shared delete invariant — a deleted record
 * vanishes from every read.)
 */
export function createWeftMemoryRecordStorage(
  storage: Storage,
  options?: CreateWeftMemoryRecordStorageOptions,
): MemoryRecordStorage {
  const keyPrefix = options?.keyPrefix ?? DEFAULT_MEMORY_KEY_PREFIX;
  const disposeUnderlyingStorage = options?.disposeUnderlyingStorage ?? false;

  function scopePrefix(scope: MemoryRecordScope): string {
    const tenant = encodeStorageKeyComponent(scope.tenantId ?? '');
    const namespace = encodeStorageKeyComponent(scope.namespace);
    return `${keyPrefix}t:${tenant}:n:${namespace}:`;
  }

  function recordKey(scope: MemoryRecordScope, id: string): string {
    return `${scopePrefix(scope)}${encodeStorageKeyComponent(id)}`;
  }

  async function readActive(key: string): Promise<MemoryRecord | undefined> {
    const bytes = await storage.get(key);
    if (bytes === null) return undefined;
    const record = decodeRecord(bytes);
    return record.status === 'active' ? record : undefined;
  }

  async function listAllInScope(scope: MemoryRecordScope): Promise<MemoryRecord[]> {
    const prefix = scopePrefix(scope);
    const out: MemoryRecord[] = [];
    for await (const key of storageKeys(storage, prefix)) {
      const record = await readActive(key);
      if (record) out.push(record);
    }
    return out;
  }

  return {
    init(): Promise<void> {
      return Promise.resolve();
    },

    close(): Promise<void> {
      if (disposeUnderlyingStorage) {
        storage[Symbol.dispose]();
      }
      return Promise.resolve();
    },

    async put(record: MemoryRecord): Promise<void> {
      const scope: MemoryRecordScope = {
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        namespace: record.namespace,
      };
      await storage.put(recordKey(scope, record.id), encodeRecord(record));
    },

    async get(id: string, scope: MemoryRecordScope): Promise<MemoryRecord | undefined> {
      return readActive(recordKey(scope, id));
    },

    async getMany(ids: string[], scope: MemoryRecordScope): Promise<MemoryRecord[]> {
      const out: MemoryRecord[] = [];
      for (const id of ids) {
        const record = await readActive(recordKey(scope, id));
        if (record) out.push(record);
      }
      return out;
    },

    async list(
      scope: MemoryRecordScope,
      listOptions?: { limit?: number; offset?: number },
    ): Promise<MemoryRecord[]> {
      const records = await listAllInScope(scope);
      const sorted = records.sort((a, b) => b.createdAt - a.createdAt);
      const offset = listOptions?.offset ?? 0;
      const limit = listOptions?.limit ?? sorted.length;
      return sorted.slice(offset, offset + limit);
    },

    async count(scope: MemoryRecordScope): Promise<number> {
      return storageCount(storage, scopePrefix(scope));
    },

    async searchByVector(
      vector: EmbeddingVectorLike,
      scope: MemoryRecordScope,
      searchOptions: { limit: number; threshold?: number },
    ): Promise<MemoryVectorSearchResult[]> {
      const records = await listAllInScope(scope);
      const scored: MemoryVectorSearchResult[] = records.map((record) => ({
        id: record.id,
        score: cosineSimilarity(vector, record.vector),
        record,
      }));
      const filtered =
        searchOptions.threshold === undefined
          ? scored
          : scored.filter((hit) => hit.score >= searchOptions.threshold!);
      filtered.sort((a, b) => b.score - a.score);
      return filtered.slice(0, searchOptions.limit);
    },

    async update(
      id: string,
      scope: MemoryRecordScope,
      patch: { content?: string; vector?: Float32Array; metadata?: Record<string, unknown> },
    ): Promise<MemoryRecord | undefined> {
      const key = recordKey(scope, id);
      const existing = await readActive(key);
      if (!existing) return undefined;

      const updated: MemoryRecord = {
        ...existing,
        content: patch.content ?? existing.content,
        vector: patch.vector ? new Float32Array(patch.vector) : existing.vector,
        metadata: patch.metadata ?? existing.metadata,
        updatedAt: Date.now(),
        version: existing.version + 1,
      };
      await storage.put(key, encodeRecord(updated));
      return updated;
    },

    async delete(id: string, scope: MemoryRecordScope): Promise<boolean> {
      const key = recordKey(scope, id);
      const existing = await storage.get(key);
      if (existing === null) return false;
      await storage.delete(key);
      return true;
    },

    async deleteNamespace(scope: MemoryRecordScope): Promise<number> {
      return storageDeletePrefix(storage, scopePrefix(scope));
    },
  };
}
