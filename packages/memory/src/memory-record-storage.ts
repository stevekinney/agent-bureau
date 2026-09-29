import type { EmbeddingVectorLike } from '@lostgradient/embeddings';

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
  /**
   * Change marker. Starts at `1` and is bumped on `update()`. A plain `update()`
   * is a read-modify-write without compare-and-swap, so two overlapping plain
   * updates can both observe version N and both write N+1. A writer that must
   * not lose a concurrent change passes the version it read as
   * `expectedVersion` to `update()` or on a `deleteMany()` reference, which
   * turns the write into a compare-and-swap.
   */
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
 * One record addressed by id within its scope, as {@link MemoryRecordStorage.deleteMany} takes it.
 */
export interface MemoryRecordReference {
  id: string;
  scope: MemoryRecordScope;
  /**
   * When set, the record is deleted only if it is still at this version. A live
   * record at any other version aborts the whole `deleteMany()` with a
   * {@link MemoryRecordVersionConflictError}; an absent record is still ignored.
   */
  expectedVersion?: number;
}

/** Options for {@link MemoryRecordStorage.update}. */
export interface MemoryRecordUpdateOptions {
  /**
   * Apply the update only if the live record is still at this version. A live
   * record at any other version is left unchanged and the update rejects with a
   * {@link MemoryRecordVersionConflictError}.
   */
  expectedVersion?: number;
}

/**
 * A version-conditional write found a record changed since the writer read it.
 * Nothing was written; the writer re-reads and decides again. `recordIds` names
 * the record that changed or, when the backend cannot tell which of a
 * transaction's conditions failed, every record the transaction conditioned on.
 */
export class MemoryRecordVersionConflictError extends Error {
  readonly code = 'version-conflict';

  constructor(readonly recordIds: readonly string[]) {
    super(`Memory record(s) ${recordIds.join(', ')} changed since they were read.`);
    this.name = 'MemoryRecordVersionConflictError';
  }
}

/**
 * Result of an operation-keyed insert. `inserted` is `true` only for the caller
 * that created the record; duplicate callers receive the existing live record.
 */
export type MemoryRecordPutOnceResult =
  { record: MemoryRecord; inserted: true } | { record: MemoryRecord; inserted: false };

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
  /**
   * Fetch the live record in scope that owns `dedupeKey`, or `undefined` when
   * no live record owns it. Implementations that provide `putOnce()` should
   * provide this keyed lookup too so callers can avoid expensive record
   * materialization when the operation key already exists.
   */
  getByDedupeKey?(scope: MemoryRecordScope, dedupeKey: string): Promise<MemoryRecord | undefined>;
  /**
   * Atomically insert a live record if no live record in the same scope already
   * owns `record.metadata.dedupeKey`. Returns the existing record unchanged when
   * the key is already present. Built-in backends implement this; custom
   * backends that do not support it can still satisfy the base storage contract
   * and will fail only when `Memory.rememberOnce()` is called.
   */
  putOnce?(record: MemoryRecord): Promise<MemoryRecordPutOnceResult>;
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
   *
   * **Search strategy is a backend choice, not part of this contract.** The
   * local backends (in-memory and Weft) compute exact cosine similarity by
   * brute force over every live record in scope — O(n) per query, with the
   * whole scope materialized in memory. This is deliberate: it needs no index
   * to maintain, stays exact, and is sub-millisecond at the per-namespace
   * scale agent memory actually reaches. The Cloudflare backend instead
   * delegates to a Vectorize approximate-nearest-neighbor index. A future
   * locally-embeddable indexed backend (e.g. PGLite + pgvector, or LanceDB)
   * would be a drop-in: implement this interface and prove it against
   * `runMemoryRecordStorageContract`. Reach for one only when a scope routinely
   * holds tens of thousands of vectors on a hot query path and the brute-force
   * scan is a measured bottleneck — not before.
   */
  searchByVector(
    vector: EmbeddingVectorLike,
    scope: MemoryRecordScope,
    options: { limit: number; threshold?: number },
  ): Promise<MemoryVectorSearchResult[]>;
  /**
   * Apply a partial update to a live record and bump its `version`. Returns the
   * updated record, or `undefined` if no live record matched. With
   * `options.expectedVersion`, the update is a compare-and-swap: it rejects with
   * a {@link MemoryRecordVersionConflictError} instead of overwriting a record
   * that changed since it was read.
   */
  update(
    id: string,
    scope: MemoryRecordScope,
    patch: { content?: string; vector?: Float32Array; metadata?: Record<string, unknown> },
    options?: MemoryRecordUpdateOptions,
  ): Promise<MemoryRecord | undefined>;
  /**
   * Delete a record so it vanishes from every subsequent read. Returns `true`
   * if a record was present and is now gone, `false` if none matched. (How the
   * removal is realized — physical row deletion locally, tombstone on
   * Cloudflare — is a backend detail; see the interface-level delete invariant.)
   */
  delete(id: string, scope: MemoryRecordScope): Promise<boolean>;
  /**
   * Delete every referenced record in ONE storage transaction: either every live
   * record in `references` is gone afterwards or none is. References may span
   * scopes; absent references are ignored, so repeating a completed deletion is a
   * no-op. Returns the number of live records removed. A reference carrying
   * `expectedVersion` makes the whole transaction conditional on that record
   * being unchanged: if it changed, nothing is deleted and the call rejects
   * with a {@link MemoryRecordVersionConflictError}.
   *
   * Memory governance requires this primitive, with its version conditions
   * (COR-806's synchronous deletion lane removes source evidence, canonical
   * projections, identity views, and the managed-asset canonical record
   * together, and never a record placed under legal hold after it was read); a
   * custom backend that omits it still satisfies the base contract but cannot
   * back a governed memory.
   */
  deleteMany?(references: readonly MemoryRecordReference[]): Promise<number>;
  /**
   * Remove every record in the scope. Returns the number of records removed;
   * afterwards every read in that scope is empty.
   */
  deleteNamespace(scope: MemoryRecordScope): Promise<number>;
}
