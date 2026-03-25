import type { Embedder, EmbeddingVector } from 'interoperability';

export type { Embedder, EmbeddingVector };

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
  forget(id: string): Promise<void>;
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

/**
 * Options for conflict detection during `remember()`. When `conflictThreshold`
 * is set, entries with cosine similarity between `conflictThreshold` and
 * `deduplicationThreshold` are treated as topical conflicts.
 */
export interface ConflictDetectionOptions {
  conflictThreshold?: number;
  onConflict?: OnConflictHandler;
}

export interface CreateMemoryOptions {
  embedder: Embedder;
  storage: import('vector-frankl').StorageAdapter;
  namespace?: string;
  dimension?: number;
  defaultSearchOptions?: Partial<MemorySearchOptions>;
  deduplicationThreshold?: number;
  /** Optional text search provider for database-level keyword search (e.g., FTS5). */
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
