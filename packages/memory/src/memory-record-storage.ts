import type { EmbeddingVectorLike } from 'interoperability';

/**
 * Scope that isolates a set of memory records. Every storage operation is
 * keyed by a scope so records never leak across tenants or namespaces.
 *
 * `namespace` is required and non-empty; it is matched case-sensitively and
 * exactly. `tenantId` is optional for local backends but required by the
 * Cloudflare backend (a later phase).
 */
export interface MemoryRecordScope {
  /** Optional tenant identifier. Required by the Cloudflare backend. */
  tenantId?: string;
  /** Non-empty, case-sensitive, exact-match namespace. */
  namespace: string;
}

/**
 * A single stored memory record.
 *
 * `version` and `status` are backend lifecycle fields. The local backend always
 * writes `status: 'active'` (it removes rows physically on delete, so a stored
 * record is never `'deleted'`) and starts `version` at `1`, bumping it on every
 * `update()`. The Cloudflare backend (a later phase) additionally uses
 * `status: 'deleted'` as a tombstone marker; that divergence is intentional and
 * invisible to readers — see {@link MemoryRecordStorage} for the shared
 * delete invariant.
 */
export interface MemoryRecord {
  id: string;
  tenantId?: string;
  namespace: string;
  content: string;
  /** Dense embedding for the record's content. */
  vector: Float32Array;
  metadata: Record<string, unknown>;
  /** Creation timestamp in epoch milliseconds. */
  createdAt: number;
  /** Last-update timestamp in epoch milliseconds. */
  updatedAt: number;
  /** Monotonically increasing version; starts at `1` and is incremented on every `update()`. */
  version: number;
  /**
   * Lifecycle status. Reads only ever surface live records, so callers always
   * observe `'active'`. The Cloudflare backend uses `'deleted'` internally as a
   * tombstone marker; the local backend never stores `'deleted'`.
   */
  status: 'active' | 'deleted';
}

/**
 * A vector-similarity search hit: the matched record plus its similarity score.
 */
export interface MemoryVectorSearchResult {
  id: string;
  /** Similarity score. Higher is more similar. */
  score: number;
  record: MemoryRecord;
}

/**
 * Persistence contract for memory records.
 *
 * Implementations expose vector similarity search and full lifecycle
 * management (create, read, list, update, delete). Text/BM25 search is
 * intentionally NOT part of this contract — keyword search is layered on top
 * of `list()` in-process (or via an optional external `TextSearchProvider`),
 * not pushed down into storage.
 *
 * **Delete invariant (the shared observable contract for every backend):**
 * - Once a record is deleted, it disappears from EVERY read — `get`,
 *   `getMany`, `list`, `searchByVector`, and `count` all behave as if it never
 *   existed.
 * - `deleteNamespace()` clears an entire scope: afterwards every read in that
 *   scope is empty.
 *
 * *How* a delete is realized is a backend-specific implementation detail and is
 * NOT part of this contract: the local backend physically removes the row,
 * while the Cloudflare backend (a later phase) writes a `status: 'deleted'`
 * tombstone to bridge its Vectorize-rehydration consistency window. Both
 * satisfy the same observable invariant above.
 *
 * Every operation is scoped by a {@link MemoryRecordScope}; records are never
 * returned across scope boundaries.
 */
export interface MemoryRecordStorage {
  /** Initialize the backend (open connections, create tables, etc.). */
  init(): Promise<void>;
  /** Tear down the backend (close connections, flush, etc.). */
  close(): Promise<void>;
  /** Insert or replace a record. */
  put(record: MemoryRecord): Promise<void>;
  /** Fetch a single live record by id, or `undefined` if absent (deleted records never appear). */
  get(id: string, scope: MemoryRecordScope): Promise<MemoryRecord | undefined>;
  /** Fetch multiple live records by id. Missing and deleted ids are omitted. */
  getMany(ids: string[], scope: MemoryRecordScope): Promise<MemoryRecord[]>;
  /** List live records, newest-first, with optional pagination. */
  list(
    scope: MemoryRecordScope,
    options?: { limit?: number; offset?: number },
  ): Promise<MemoryRecord[]>;
  /** Count live records in the scope. */
  count(scope: MemoryRecordScope): Promise<number>;
  /**
   * Find live records most similar to `vector`. Returns at most `limit`
   * results; when `threshold` is supplied, only results scoring at or above it
   * are returned.
   */
  searchByVector(
    vector: EmbeddingVectorLike,
    scope: MemoryRecordScope,
    options: { limit: number; threshold?: number },
  ): Promise<MemoryVectorSearchResult[]>;
  /**
   * Apply a partial update to a live record and bump its `version`. Returns the
   * updated record, or `undefined` if no live record matched.
   */
  update(
    id: string,
    scope: MemoryRecordScope,
    patch: { content?: string; vector?: Float32Array; metadata?: Record<string, unknown> },
  ): Promise<MemoryRecord | undefined>;
  /**
   * Delete a record so it vanishes from every subsequent read. Returns `true`
   * if a record was present and is now gone, `false` if none matched. (How the
   * removal is realized — physical row deletion locally, tombstone on
   * Cloudflare — is a backend detail; see the interface-level delete invariant.)
   */
  delete(id: string, scope: MemoryRecordScope): Promise<boolean>;
  /**
   * Remove every record in the scope. Returns the number of records removed;
   * afterwards every read in that scope is empty.
   */
  deleteNamespace(scope: MemoryRecordScope): Promise<number>;
}
