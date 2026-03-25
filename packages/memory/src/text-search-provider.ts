/**
 * Interface for pluggable text search backends.
 *
 * The default recall() path uses in-memory BM25 scoring. When a
 * TextSearchProvider is supplied via CreateMemoryOptions, it is used
 * instead — allowing database-level FTS for better scalability.
 */
export interface TextSearchProvider {
  /** Initialize the provider (create tables, etc.). */
  init(): Promise<void>;
  /** Tear down (close connections, etc.). */
  close(): Promise<void>;
  /** Index content for a given entry. Called from remember(). */
  index(id: string, content: string, namespace: string): Promise<void>;
  /** Remove an entry from the index. Called from forget(). */
  remove(id: string): Promise<void>;
  /** Clear all indexed entries, optionally scoped by namespace. Called from forgetAll(). */
  clear(namespace?: string): Promise<void>;
  /** Search for matching documents. Returns a map of entry id to BM25-derived score. */
  search(query: string, namespace: string): Promise<Map<string, number>>;
}
