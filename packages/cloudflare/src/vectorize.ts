/**
 * The minimal Vectorize surface the Cloudflare memory backend needs.
 *
 * Modeled on Cloudflare's `Vectorize` binding so the real index satisfies this
 * interface structurally. A recording, adversarial fake (see
 * `src/test/fake-vectorize.ts`) satisfies the same shape for tests. The backend
 * treats Vectorize strictly as a SECONDARY index: it never trusts a returned
 * match's metadata as a security boundary — every hit is rehydrated and
 * re-scoped against canonical SQLite rows.
 */

/**
 * A metadata value Vectorize can store and filter on. The backend only ever
 * writes a server-owned, allowlisted subset (`tenant_id`, `namespace`,
 * `memory_id`, `created_at`, `version`) — never caller content or arbitrary
 * caller metadata.
 */
export type VectorizeMetadataValue = string | number | boolean;

/**
 * A vector to upsert: its id, dense values, and server-owned metadata. The
 * `values` array length must match the index dimensionality in production.
 */
export interface VectorizeUpsertVector {
  id: string;
  values: number[];
  metadata: Record<string, VectorizeMetadataValue>;
}

/**
 * Options for a {@link VectorizeIndex.query}. The backend always sets a
 * server-owned `filter` (tenant + namespace) and `returnMetadata: true` so it
 * can read back the per-hit `version` during rehydration.
 */
export interface VectorizeQueryOptions {
  /** Maximum number of nearest neighbors to return. */
  topK: number;
  /** Server-owned equality filter applied to vector metadata. */
  filter: Record<string, VectorizeMetadataValue>;
  /** When `true`, each match carries back its stored metadata. */
  returnMetadata: boolean;
}

/**
 * A single similarity match returned by {@link VectorizeIndex.query}. `metadata`
 * is present only when `returnMetadata` was requested; it is UNTRUSTED — the
 * backend re-checks every field against canonical SQLite rows.
 */
export interface VectorizeMatch {
  id: string;
  /** Similarity score; higher is more similar. */
  score: number;
  metadata?: Record<string, VectorizeMetadataValue>;
}

/**
 * The result of a {@link VectorizeIndex.query}.
 */
export interface VectorizeQueryResult {
  matches: VectorizeMatch[];
}

/**
 * The injectable Vectorize interface. In production this is a Vectorize binding;
 * in tests it is a recording, adversarial fake.
 */
export interface VectorizeIndex {
  /** Insert or replace vectors by id. */
  upsert(vectors: VectorizeUpsertVector[]): Promise<void>;
  /** Nearest-neighbor query against the index, scoped by a server-owned filter. */
  query(vector: number[], options: VectorizeQueryOptions): Promise<VectorizeQueryResult>;
  /** Delete vectors by id. */
  deleteByIds(ids: string[]): Promise<void>;
}
