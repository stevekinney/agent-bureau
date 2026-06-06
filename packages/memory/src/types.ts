import type { Embedder, EmbeddingVector } from 'interoperability';

import type {
  MemoryRecord,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemoryVectorSearchResult,
} from './memory-record-storage';

export type { Embedder, EmbeddingVector };
export type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage, MemoryVectorSearchResult };

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
