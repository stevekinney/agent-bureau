import type { Embedder, EmbeddingVector } from 'interoperability';

import type {
  MemoryRecord,
  MemoryRecordPutOnceResult,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemoryVectorSearchResult,
} from './memory-record-storage';

export type { Embedder, EmbeddingVector };
export type {
  MemoryRecord,
  MemoryRecordPutOnceResult,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemoryVectorSearchResult,
};

export interface MemoryEntry {
  id: string;
  content: string;
  vector: number[];
  metadata: MemoryMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryMetadata {
  namespace: string;
  source: 'auto-capture' | 'tool' | 'manual' | 'experiential';
  conversationId?: string;
  agentId?: string;
  importance?: number;
  evergreen?: boolean;
  tags?: string[];
  dedupeKey?: string;
  /**
   * AB-61 spike (opt-in via `CreateMemoryOptions.experimentalTemporalValidity`):
   * epoch-millisecond start of this fact's validity window. Defaults to the
   * record's `createdAt` when unset. Set explicitly to backdate a fact (e.g.
   * importing something that was true before it was recorded).
   */
  validFrom?: number;
  /**
   * AB-61 spike: epoch-millisecond end of this fact's validity window,
   * exclusive. Unset for currently-valid facts. Stamped automatically on the
   * superseded record when `remember()` is called with `supersedes`.
   */
  invalidatedAt?: number;
  /**
   * AB-61 spike: id of the record that superseded this one. Stamped
   * automatically alongside `invalidatedAt`.
   */
  supersededBy?: string;
  /**
   * AB-61 spike, write-only directive: id of an existing record this new
   * fact supersedes. Only read by `remember()`; never persisted onto the
   * new record's stored metadata. Requires `experimentalTemporalValidity`.
   */
  supersedes?: string;
  [key: string]: unknown;
}

export interface MemorySearchOptions {
  limit?: number;
  threshold?: number;
  namespace?: string;
  includeVector?: boolean;
  vectorWeight?: number;
  textWeight?: number;
  temporalDecay?: { halfLifeMilliseconds: number; evergreenExempt?: boolean };
  diversify?: { lambda: number };
  /**
   * When true, skip text/BM25 search and return pure cosine similarity scores.
   * Useful when thresholds assume cosine semantics (e.g., deduplication at 0.95).
   */
  vectorOnly?: boolean;
  /**
   * AB-61 spike, requires `CreateMemoryOptions.experimentalTemporalValidity`:
   * epoch-millisecond timestamp to answer an "as of" query. `recall()` filters
   * out records that were not valid at this instant — i.e. `validFrom > asOf`
   * or `invalidatedAt <= asOf`. Defaults to `Date.now()` when the flag is
   * enabled and `asOf` is omitted, so recall shows only currently-valid facts.
   */
  asOf?: number;
}

/**
 * Options for listing entries without semantic search.
 */
export interface MemoryListOptions {
  /** Maximum number of entries to return. Default: 100. */
  limit?: number;
  /** Number of entries to skip. Default: 0. */
  offset?: number;
  /** Namespace to list entries from. */
  namespace?: string;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  metadata: MemoryMetadata;
  createdAt: number;
}

export interface Memory {
  remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry>;
  rememberOnce(
    content: string,
    metadata: Partial<MemoryMetadata> & { dedupeKey: string },
  ): Promise<MemoryEntry>;
  recall(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  /** List entries without semantic search. Returns entries sorted by creation time (newest first). */
  list(options?: MemoryListOptions): Promise<MemorySearchResult[]>;
  /**
   * Remove a specific entry by id. Records are scope-keyed, so `namespace`
   * selects the scope to delete from; it defaults to the configured default
   * namespace. Callers that stored an entry under a non-default namespace must
   * pass the same namespace here.
   */
  forget(id: string, namespace?: string): Promise<void>;
  forgetAll(namespace?: string): Promise<void>;
  count(namespace?: string): Promise<number>;
  init(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Handler called when a conflicting entry is detected during `remember()`.
 * Returns an instruction for how to handle the conflict.
 */
export type OnConflictHandler = (
  incoming: { content: string; metadata: Partial<MemoryMetadata> },
  existing: { id: string; content: string; metadata: MemoryMetadata; similarity: number },
) => Promise<'keep-both' | 'replace' | 'skip'> | 'keep-both' | 'replace' | 'skip';

export interface CreateMemoryOptions {
  embedder: Embedder;
  storage: MemoryRecordStorage;
  namespace?: string;
  dimension?: number;
  defaultSearchOptions?: Partial<MemorySearchOptions>;
  deduplicationThreshold?: number;
  /**
   * Optional EXTERNAL keyword-search index (e.g. a database-level FTS backend).
   * When unset (the default), `recall()` uses in-memory BM25 scoring over the
   * record corpus enumerated via `storage.list()`.
   */
  textSearchProvider?: import('./text-search-provider').TextSearchProvider;
  /**
   * When true, `remember()` throws if no namespace is provided in metadata
   * and the effective namespace (either the configured `namespace` option or
   * its default) resolves to the built-in `"default"` namespace. This helps
   * prevent orphaned entries that exist in storage but are invisible to
   * namespace-scoped queries.
   */
  requireNamespace?: boolean;
  /**
   * Cosine similarity threshold for conflict detection. Entries with similarity
   * between `conflictThreshold` and `deduplicationThreshold` are treated as
   * topical conflicts. When undefined, conflict detection is disabled.
   */
  conflictThreshold?: number;
  /**
   * Handler called when a conflicting entry is detected. If not provided,
   * conflicting entries default to `'keep-both'`.
   */
  onConflict?: OnConflictHandler;
  /**
   * AB-61 spike: opt-in flag for temporal fact-validity (validFrom /
   * invalidatedAt / supersededBy). When `true`:
   * - `remember(content, { supersedes: id, ... })` stamps `supersededBy` and
   *   `invalidatedAt` onto the record at `id` once the new record is stored.
   * - `recall()` filters results to those valid at `options.asOf` (defaulting
   *   to `Date.now()`), running before temporal decay and MMR.
   * Default `false` — existing consumers see no behavior change. This is a
   * prototype flag for the AB-61 spike, not a stable feature.
   */
  experimentalTemporalValidity?: boolean;
}

/**
 * Options for the `withNamespaceIsolation` wrapper that enforces strict
 * tenant boundaries on a Memory instance.
 */
export interface NamespaceIsolationOptions {
  /** The tenant's namespace — all operations are locked to this value. */
  namespace: string;
  /**
   * Behavior when `forget()` targets an entry not known to belong to this
   * namespace. Default: `'throw'`.
   */
  onUnauthorized?: 'throw' | 'ignore';
}
