import type { StorageAdapter } from '@/core/types.ts';

import { ChromeStorageAdapter } from './adapters/chrome-storage-adapter.ts';
import { IndexedDatabaseStorageAdapter } from './adapters/indexed-database-adapter.ts';
import { MemoryStorageAdapter } from './adapters/memory-adapter.ts';
import { OPFSStorageAdapter } from './adapters/opfs-adapter.ts';
import { SQLiteStorageAdapter } from './adapters/sqlite-adapter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StorageAdapterPreference =
  | 'sqlite'
  | 'opfs'
  | 'chromeStorage'
  | 'indexedDatabase'
  | 'memory';

export interface StorageResolutionOptions {
  sqlite?: { filename: string };
  opfs?: { directory: string; format?: 'binary' | 'json' };
  chromeStorage?: { prefix: string; area?: 'local' | 'session' };
  indexedDatabase?: { name: string; version?: number };
  memory?: { cloneOnRead?: boolean; cloneOnWrite?: boolean };
  /** Override the default preference order. */
  preference?: StorageAdapterPreference[];
}

export interface ResolvedStorageAdapter {
  adapter: StorageAdapter;
  name: StorageAdapterPreference;
}

// ---------------------------------------------------------------------------
// Default preference order
// ---------------------------------------------------------------------------

const DEFAULT_PREFERENCE: StorageAdapterPreference[] = [
  'sqlite',
  'opfs',
  'chromeStorage',
  'indexedDatabase',
  'memory',
];

// ---------------------------------------------------------------------------
// Candidate registry
// ---------------------------------------------------------------------------

interface StorageAdapterCandidate {
  isAvailable: () => boolean;
  create: (options: StorageResolutionOptions) => StorageAdapter;
  hasOptions: (options: StorageResolutionOptions) => boolean;
}

const candidates: Record<StorageAdapterPreference, StorageAdapterCandidate> = {
  sqlite: {
    isAvailable: () => SQLiteStorageAdapter.isAvailable(),
    hasOptions: (options) => options.sqlite !== undefined,
    create: (options) => new SQLiteStorageAdapter(options.sqlite!),
  },
  opfs: {
    isAvailable: () => OPFSStorageAdapter.isAvailable(),
    hasOptions: (options) => options.opfs !== undefined,
    create: (options) => new OPFSStorageAdapter(options.opfs!),
  },
  chromeStorage: {
    isAvailable: () => ChromeStorageAdapter.isAvailable(),
    hasOptions: (options) => options.chromeStorage !== undefined,
    create: (options) => new ChromeStorageAdapter(options.chromeStorage!),
  },
  indexedDatabase: {
    isAvailable: () => IndexedDatabaseStorageAdapter.isAvailable(),
    hasOptions: (options) => options.indexedDatabase !== undefined,
    create: (options) => new IndexedDatabaseStorageAdapter(options.indexedDatabase!),
  },
  memory: {
    isAvailable: () => MemoryStorageAdapter.isAvailable(),
    hasOptions: () => true, // Memory never requires explicit options.
    create: (options) => new MemoryStorageAdapter(options.memory),
  },
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Walk a preference-ordered list of storage adapters and return the first one
 * whose required runtime APIs are available and whose options have been
 * provided. Falls back to {@link MemoryStorageAdapter} when nothing else
 * matches.
 *
 * The returned adapter has **not** been initialized — callers must still call
 * `adapter.init()` before use.
 */
export function resolveStorageAdapter(
  options: StorageResolutionOptions = {},
): ResolvedStorageAdapter {
  const preference = options.preference ?? DEFAULT_PREFERENCE;

  for (const name of preference) {
    const candidate = candidates[name];

    if (candidate.isAvailable() && candidate.hasOptions(options)) {
      return { adapter: candidate.create(options), name };
    }
  }

  // Unreachable when preference includes 'memory' (the default), but a
  // consumer could pass a custom list that excludes it.
  return { adapter: new MemoryStorageAdapter(options.memory), name: 'memory' };
}
