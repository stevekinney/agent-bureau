import {
  encodeStorageKeyComponent,
  type Storage,
  storageConditionalBatch,
  storageDeletePrefix,
  storageKeys,
  WEFT_RESERVED_KEY_PREFIXES,
} from '@lostgradient/weft/storage/interface';
import { cosineSimilarity, type EmbeddingVectorLike } from 'interoperability';
import { z } from 'zod';

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
 * Schema for the serializable form of a {@link MemoryRecord}. The dense `vector`
 * is persisted as a plain `number[]` because `Float32Array` does not survive
 * JSON round-trips; it is rehydrated to a `Float32Array` on read. Decoding runs
 * untrusted durable bytes through this schema, so a corrupt or partially-written
 * record fails loudly at the read boundary instead of yielding a garbage record.
 */
const storedMemoryRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string().optional(),
  namespace: z.string(),
  content: z.string(),
  vector: z.array(z.number().finite()),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  version: z.number().finite(),
  status: z.union([z.literal('active'), z.literal('deleted')]),
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeRecord(record: MemoryRecord): Uint8Array {
  const stored: z.infer<typeof storedMemoryRecordSchema> = {
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
  const stored = storedMemoryRecordSchema.parse(JSON.parse(textDecoder.decode(bytes)));
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

  // The key prefix is public and documented "must not collide with Weft's
  // reserved prefixes" — but the backend is explicitly meant to share one
  // underlying Storage with a Weft engine, so a colliding custom prefix would
  // let memory records overwrite engine keys. Enforce it here rather than trust
  // the caller.
  if (keyPrefix.length === 0) {
    throw new Error('keyPrefix must be a non-empty string.');
  }
  for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
    if (keyPrefix.startsWith(reserved) || reserved.startsWith(keyPrefix)) {
      throw new Error(
        `keyPrefix "${keyPrefix}" collides with the reserved Weft prefix "${reserved}".`,
      );
    }
  }

  function scopePrefix(scope: MemoryRecordScope): string {
    // The public contract requires a non-empty namespace. Direct storage callers
    // (not just createMemory) reach this boundary, so validate here so every
    // scoped operation shares the check.
    if (scope.namespace.length === 0) {
      throw new Error('namespace must be a non-empty string.');
    }
    const tenant = encodeStorageKeyComponent(scope.tenantId ?? '');
    const namespace = encodeStorageKeyComponent(scope.namespace);
    return `${keyPrefix}t:${tenant}:n:${namespace}:`;
  }

  function recordKey(scope: MemoryRecordScope, id: string): string {
    return `${scopePrefix(scope)}${encodeStorageKeyComponent(id)}`;
  }

  function dedupeScopePrefix(scope: MemoryRecordScope): string {
    scopePrefix(scope);
    const tenant = encodeStorageKeyComponent(scope.tenantId ?? '');
    const namespace = encodeStorageKeyComponent(scope.namespace);
    return `${keyPrefix}dedupe:t:${tenant}:n:${namespace}:`;
  }

  function dedupeIndexKey(scope: MemoryRecordScope, dedupeKey: string): string {
    return `${dedupeScopePrefix(scope)}${encodeStorageKeyComponent(dedupeKey)}`;
  }

  function requireRecordDedupeKey(record: MemoryRecord): string {
    const dedupeKey = record.metadata['dedupeKey'];
    if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) {
      throw new Error('record.metadata.dedupeKey must be a non-empty string.');
    }
    return dedupeKey;
  }

  function recordDedupeKey(record: MemoryRecord): string | undefined {
    const dedupeKey = record.metadata['dedupeKey'];
    return typeof dedupeKey === 'string' ? dedupeKey : undefined;
  }

  async function readActive(key: string): Promise<MemoryRecord | undefined> {
    const bytes = await storage.get(key);
    if (bytes === null) return undefined;
    const record = decodeRecord(bytes);
    return record.status === 'active' ? record : undefined;
  }

  async function readRecordId(key: string): Promise<string | undefined> {
    const bytes = await storage.get(key);
    return bytes === null ? undefined : textDecoder.decode(bytes);
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

  async function readByDedupeKey(
    scope: MemoryRecordScope,
    dedupeKey: string,
  ): Promise<MemoryRecord | undefined> {
    const existingId = await readRecordId(dedupeIndexKey(scope, dedupeKey));
    return existingId === undefined ? undefined : readActive(recordKey(scope, existingId));
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
      const key = recordKey(scope, record.id);
      const existing = await readActive(key);
      const oldDedupeKey = existing === undefined ? undefined : recordDedupeKey(existing);
      const newDedupeKey = record.status === 'active' ? recordDedupeKey(record) : undefined;
      const mutations: Parameters<typeof storageConditionalBatch>[2] = [
        { type: 'put', key, value: encodeRecord(record) },
      ];
      if (oldDedupeKey !== undefined && oldDedupeKey !== newDedupeKey) {
        mutations.push({ type: 'delete', key: dedupeIndexKey(scope, oldDedupeKey) });
      }
      if (newDedupeKey !== undefined) {
        mutations.push({
          type: 'put',
          key: dedupeIndexKey(scope, newDedupeKey),
          value: textEncoder.encode(record.id),
        });
      }
      await storageConditionalBatch(storage, [], mutations);
    },

    async getByDedupeKey(
      scope: MemoryRecordScope,
      dedupeKey: string,
    ): Promise<MemoryRecord | undefined> {
      return readByDedupeKey(scope, dedupeKey);
    },

    async putOnce(record: MemoryRecord) {
      const dedupeKey = requireRecordDedupeKey(record);
      const scope: MemoryRecordScope = {
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        namespace: record.namespace,
      };
      const key = recordKey(scope, record.id);
      const indexKey = dedupeIndexKey(scope, dedupeKey);
      const applied = await storageConditionalBatch(
        storage,
        [
          { key: indexKey, expectedValue: null },
          { key, expectedValue: null },
        ],
        [
          { type: 'put', key, value: encodeRecord(record) },
          { type: 'put', key: indexKey, value: textEncoder.encode(record.id) },
        ],
      );

      if (applied) {
        return { record, inserted: true };
      }

      const existing = await readByDedupeKey(scope, dedupeKey);
      if (existing !== undefined) return { record: existing, inserted: false };

      throw new Error(`dedupeKey "${dedupeKey}" exists but its memory record is missing.`);
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
      // Count only active records, consistent with get/list/searchByVector. A
      // raw key-count would diverge from those reads if a caller ever `put()` a
      // record with `status: 'deleted'` (the contract permits passing one), so
      // count is derived from the same active-record scan rather than a fast
      // key-count that can't see status.
      const active = await listAllInScope(scope);
      return active.length;
    },

    /**
     * Brute-force exact cosine similarity over every live record in scope —
     * O(n) per query, materializing the whole scope. This backend keeps no
     * vector index by design; see {@link MemoryRecordStorage.searchByVector}
     * for why brute force is the right default here and when an indexed backend
     * (Cloudflare's Vectorize today; a local PGLite/pgvector or LanceDB backend
     * if a real need appears) becomes worth its cost.
     */
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
      // Read-modify-write without compare-and-swap. `version` is a monotonic
      // change marker, NOT a concurrency guard: two interleaved updates to the
      // same id can both read version N and write N+1, losing one write. That is
      // acceptable for the single-process local backend; a multi-writer backend
      // would need conditional writes keyed on the prior version.
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
      const oldDedupeKey = recordDedupeKey(existing);
      const newDedupeKey = updated.status === 'active' ? recordDedupeKey(updated) : undefined;
      const mutations: Parameters<typeof storageConditionalBatch>[2] = [
        { type: 'put', key, value: encodeRecord(updated) },
      ];
      if (oldDedupeKey !== undefined && oldDedupeKey !== newDedupeKey) {
        mutations.push({ type: 'delete', key: dedupeIndexKey(scope, oldDedupeKey) });
      }
      if (newDedupeKey !== undefined) {
        mutations.push({
          type: 'put',
          key: dedupeIndexKey(scope, newDedupeKey),
          value: textEncoder.encode(updated.id),
        });
      }
      await storageConditionalBatch(storage, [], mutations);
      return updated;
    },

    async delete(id: string, scope: MemoryRecordScope): Promise<boolean> {
      const key = recordKey(scope, id);
      const existing = await readActive(key);
      if (existing === undefined) return false;
      const dedupeKey = existing.metadata['dedupeKey'];
      if (typeof dedupeKey === 'string') {
        await storageConditionalBatch(
          storage,
          [],
          [
            { type: 'delete', key },
            { type: 'delete', key: dedupeIndexKey(scope, dedupeKey) },
          ],
        );
      } else {
        await storage.delete(key);
      }
      return true;
    },

    async deleteNamespace(scope: MemoryRecordScope): Promise<number> {
      const removed = await storageDeletePrefix(storage, scopePrefix(scope));
      await storageDeletePrefix(storage, dedupeScopePrefix(scope));
      return removed;
    },
  };
}
