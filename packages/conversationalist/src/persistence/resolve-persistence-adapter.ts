import type { SessionPersistenceAdapter } from '../environment';
import type { ConversationHistory } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PersistenceAdapterPreference = 'sqlite' | 'jsonl' | 'memory';

export interface PersistenceResolutionOptions {
  sqlite?: { path: string; tableName?: string };
  jsonl?: { directory: string };
  memory?: { initialData?: Map<string, ConversationHistory> };
  /** Override the default preference order. */
  preference?: PersistenceAdapterPreference[];
}

export interface ResolvedPersistenceAdapter {
  adapter: SessionPersistenceAdapter;
  name: PersistenceAdapterPreference;
}

// ---------------------------------------------------------------------------
// Default preference order
// ---------------------------------------------------------------------------

const DEFAULT_PREFERENCE: PersistenceAdapterPreference[] = ['sqlite', 'jsonl', 'memory'];

// ---------------------------------------------------------------------------
// Capability probes
// ---------------------------------------------------------------------------

const isAvailable: Record<PersistenceAdapterPreference, () => boolean> = {
  sqlite: () => typeof globalThis.Bun !== 'undefined',
  jsonl: () => typeof globalThis.Bun !== 'undefined',
  memory: () => true,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Walk a preference-ordered list of persistence adapters and return the first
 * one whose required runtime APIs are available and whose options have been
 * provided. Falls back to an in-memory adapter when nothing else matches.
 *
 * This function is async because the SQLite adapter factory performs a dynamic
 * import (`await import('bun:sqlite')`).
 */
export async function resolvePersistenceAdapter(
  options: PersistenceResolutionOptions = {},
): Promise<ResolvedPersistenceAdapter> {
  const preference = options.preference ?? DEFAULT_PREFERENCE;

  for (const name of preference) {
    if (!isAvailable[name]()) continue;

    switch (name) {
      case 'sqlite': {
        if (options.sqlite === undefined) continue;
        const { createSQLitePersistenceAdapter } = await import('./sqlite-adapter');
        return { adapter: await createSQLitePersistenceAdapter(options.sqlite), name };
      }
      case 'jsonl': {
        if (options.jsonl === undefined) continue;
        const { JsonlSessionPersistenceAdapter } = await import('./jsonl-adapter');
        return { adapter: new JsonlSessionPersistenceAdapter(options.jsonl.directory), name };
      }
      case 'memory': {
        const { createInMemoryPersistenceAdapter } = await import('./in-memory-adapter');
        return { adapter: createInMemoryPersistenceAdapter(options.memory), name };
      }
    }
  }

  // Unreachable when preference includes 'memory' (the default), but a
  // consumer could pass a custom list that excludes it.
  const { createInMemoryPersistenceAdapter } = await import('./in-memory-adapter');
  return { adapter: createInMemoryPersistenceAdapter(options.memory), name: 'memory' };
}
