import type {
  Memory,
  MemoryEntry,
  MemoryMetadata,
  MemorySearchOptions,
  MemorySearchResult,
  NamespaceIsolationOptions,
} from './types';

/**
 * Wraps a Memory instance with namespace-scoped access.
 *
 * The returned Memory locks all write/search operations to a single configured
 * namespace when going through this wrapper.
 *
 * - `remember()` forces the namespace, ignoring the caller's metadata.
 * - `recall()` forces the namespace, ignoring search options.
 * - `forget()` only allows deleting entries whose IDs were previously seen
 *   via this wrapper (through `remember()` or `recall()`); it does not
 *   independently re-verify the underlying namespace before deletion.
 * - `forgetAll()` and `count()` are scoped to the configured namespace.
 */
export function withNamespaceIsolation(memory: Memory, options: NamespaceIsolationOptions): Memory {
  const { namespace, onUnauthorized = 'throw' } = options;

  // Track IDs seen via this wrapper (from remember() and recall() results).
  // Used by forget() to ensure it only deletes entries previously observed
  // through this namespace-isolated view.
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
