/**
 * A generic key-value store for string data.
 *
 * This is the foundational storage primitive for agent-bureau. Identity,
 * skills, proposals, scheduler state, and session persistence all use this
 * interface. Platform-specific adapters (SQLite, IndexedDB, Chrome storage,
 * etc.) implement it, and higher-level systems program against it.
 *
 * Keys are hierarchical strings with colon separators (e.g., "identity:soul:orchestrator",
 * "skill:pdf-processing:metadata"). The `list(prefix)` method enables efficient
 * namespace scanning.
 *
 * Values are opaque strings. Consumers are responsible for serialization
 * (typically JSON.stringify/parse).
 */
export interface KeyValueStore {
  /** Retrieve a value by key. Returns null if the key does not exist. */
  get(key: string): Promise<string | null>;

  /** Store a value at a key. Overwrites any existing value. */
  set(key: string, value: string): Promise<void>;

  /** Delete a key. No-op if the key does not exist. */
  delete(key: string): Promise<void>;

  /**
   * List all keys that start with the given prefix.
   * Returns an empty array if no keys match.
   * The prefix itself is included in returned keys (not stripped).
   */
  list(prefix: string): Promise<string[]>;

  /**
   * Check if a key exists.
   * Default implementation uses get() !== null, but adapters
   * may override for efficiency.
   */
  has?(key: string): Promise<boolean>;

  /**
   * Delete all keys that start with the given prefix.
   * Returns the number of keys deleted.
   * Default implementation uses list() + delete(), but adapters
   * may override for efficiency.
   */
  deletePrefix?(prefix: string): Promise<number>;

  /**
   * Close any underlying connections or resources.
   * Called during graceful shutdown.
   */
  close?(): Promise<void>;
}

/** Options for creating a KeyValueStore adapter. */
export interface KeyValueStoreOptions {
  /** Optional namespace prefix applied to all keys automatically. */
  namespace?: string;
}

/** Configuration for the resolver. */
export type KeyValueStoreConfiguration =
  | { type: 'memory' }
  | { type: 'sqlite'; path: string }
  | { type: 'indexeddb'; databaseName?: string }
  | { type: 'chrome-storage'; area?: 'local' | 'session' }
  | { type: 'remote'; baseUrl: string; headers?: Record<string, string> }
  | { type: 'auto' };
