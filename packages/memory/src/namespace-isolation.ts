import type {
  Memory,
  MemoryEntry,
  MemoryMetadata,
  MemorySearchOptions,
  MemorySearchResult,
  NamespaceIsolationOptions,
} from './types';

/**
 * Wraps a Memory instance with strict namespace isolation.
 *
 * The returned Memory locks all operations to a single configured namespace.
 * This is the wrapper you hand to a specific tenant's agent — it cannot
 * escape its namespace.
 *
 * - `remember()` forces the namespace, ignoring the caller's metadata.
 * - `recall()` forces the namespace, ignoring search options.
 * - `forget()` verifies the entry belongs to this namespace before deleting.
 * - `forgetAll()` and `count()` are scoped to the configured namespace.
 */
export function withNamespaceIsolation(memory: Memory, options: NamespaceIsolationOptions): Memory {
  const { namespace, onUnauthorized = 'throw' } = options;

  // Track IDs known to belong to this namespace, populated from remember()
  // and recall() results. Used by forget() to verify ownership.
  const knownIds = new Set<string>();

  return {
    async remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry> {
      const entry = await memory.remember(content, {
        ...metadata,
        namespace,
      });
      knownIds.add(entry.id);
      return entry;
    },

    async recall(
      query: string,
      searchOptions?: MemorySearchOptions,
    ): Promise<MemorySearchResult[]> {
      const results = await memory.recall(query, {
        ...searchOptions,
        namespace,
      });
      for (const result of results) {
        knownIds.add(result.id);
      }
      return results;
    },

    async forget(id: string): Promise<void> {
      if (!knownIds.has(id)) {
        if (onUnauthorized === 'throw') {
          throw new Error(
            `Cannot forget entry "${id}": it does not belong to namespace "${namespace}" or has not been seen by this isolation wrapper.`,
          );
        }
        // 'ignore' — silently no-op
        return;
      }
      await memory.forget(id);
      knownIds.delete(id);
    },

    async forgetAll(): Promise<void> {
      await memory.forgetAll(namespace);
      knownIds.clear();
    },

    async count(): Promise<number> {
      return memory.count(namespace);
    },

    async init(): Promise<void> {
      return memory.init();
    },

    async close(): Promise<void> {
      return memory.close();
    },
  };
}
