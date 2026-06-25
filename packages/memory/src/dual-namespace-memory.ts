import type {
  Memory,
  MemoryEntry,
  MemoryListOptions,
  MemoryMetadata,
  MemorySearchOptions,
  MemorySearchResult,
} from './types';

/**
 * Configuration for a dual-namespace memory instance.
 *
 * The bureau is the tenant boundary (one bureau = one deployment); agents are
 * namespaces within it. This models the architecture spec's tenant model:
 * `tenantId` = bureau id, `namespace` = agent name.
 */
export interface DualNamespaceMemoryOptions {
  /**
   * The agent-private namespace. All writes go here. Reads include both this
   * namespace and the shared bureau namespace.
   */
  privateNamespace: string;
  /**
   * The shared bureau-global namespace. Reads include this namespace; writes
   * are never directed here (promotion is a deliberate act).
   */
  sharedNamespace: string;
}

/**
 * Wraps two {@link Memory} instances — `privateMemory` and `sharedMemory` — to
 * implement merged-read / private-write semantics.
 *
 * **Semantics (from the architecture spec):**
 * - `remember()` — writes to the PRIVATE (agent) namespace only.
 * - `recall()` — searches both private and shared namespaces, merges the
 *   results, re-ranks by score, and returns the top N across both.
 * - `list()` — returns entries from both namespaces, merged newest-first.
 * - `forget()` — deletes from the PRIVATE namespace only (a shared record
 *   cannot be deleted through this wrapper; that is a bureau-level promotion
 *   operation, not an agent one).
 * - `forgetAll()` — clears the PRIVATE namespace only.
 * - `count()` — returns the combined count of both namespaces.
 *
 * **Rationale:** a shared pool any agent can write is a fleet-wide mutable
 * namespace — one bad memory poisons everyone's recall. Benefit-on-read,
 * isolate-on-write, promote-on-purpose.
 *
 * **Standalone agent path:** when `sharedMemory` is undefined the wrapper
 * degrades to private-only reads and writes — the correct behaviour for a
 * bureau-less (standalone) agent that has no shared pool to merge from.
 *
 * @param privateMemory - Memory instance scoped to the agent's private
 *   namespace. This is where all writes land.
 * @param sharedMemory - Memory instance scoped to the bureau-global namespace.
 *   Optional: omit when constructing a standalone agent that has no shared
 *   pool (standalone = ungoverned, no bureau to share with).
 */
export function createDualNamespaceMemory(privateMemory: Memory, sharedMemory?: Memory): Memory {
  return {
    async remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry> {
      // All writes go to the private namespace only.
      return privateMemory.remember(content, metadata);
    },

    async rememberOnce(
      content: string,
      metadata: Partial<MemoryMetadata> & { dedupeKey: string },
    ): Promise<MemoryEntry> {
      // All idempotent writes go to the private namespace only.
      return privateMemory.rememberOnce(content, metadata);
    },

    async recall(
      query: string,
      searchOptions?: MemorySearchOptions,
    ): Promise<MemorySearchResult[]> {
      if (sharedMemory === undefined) {
        // Standalone agent: no shared pool, recall private only.
        return privateMemory.recall(query, searchOptions);
      }

      const limit = searchOptions?.limit ?? 10;
      // Over-fetch from each namespace so that after merging we can still
      // return a full `limit` of high-quality results. A 2× multiplier gives
      // each side room without materialising the full corpus.
      const fetchLimit = limit * 2;
      const mergedOptions = { ...searchOptions, limit: fetchLimit };

      const [privateResults, sharedResults] = await Promise.all([
        privateMemory.recall(query, mergedOptions),
        sharedMemory.recall(query, mergedOptions),
      ]);

      // Merge the two result lists, deduplicate by id (private wins on tie),
      // re-rank by score descending, and return the top limit.
      const seen = new Set<string>();
      const merged: MemorySearchResult[] = [];

      // Private results take precedence in deduplication — if the same entry
      // somehow appears in both (unusual, but possible after promotion), the
      // private copy is kept.
      for (const result of privateResults) {
        if (!seen.has(result.id)) {
          seen.add(result.id);
          merged.push(result);
        }
      }
      for (const result of sharedResults) {
        if (!seen.has(result.id)) {
          seen.add(result.id);
          merged.push(result);
        }
      }

      merged.sort((a, b) => b.score - a.score);
      return merged.slice(0, limit);
    },

    async list(listOptions?: MemoryListOptions): Promise<MemorySearchResult[]> {
      if (sharedMemory === undefined) {
        return privateMemory.list(listOptions);
      }

      const limit = listOptions?.limit ?? 100;
      const offset = listOptions?.offset ?? 0;

      // Fetch all from both (no offset push-down across two sources), merge,
      // sort newest-first, then apply offset + limit.
      const [privateEntries, sharedEntries] = await Promise.all([
        privateMemory.list({ ...listOptions, limit: undefined, offset: 0 }),
        sharedMemory.list({ ...listOptions, limit: undefined, offset: 0 }),
      ]);

      const seen = new Set<string>();
      const merged: MemorySearchResult[] = [];

      for (const entry of privateEntries) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          merged.push(entry);
        }
      }
      for (const entry of sharedEntries) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          merged.push(entry);
        }
      }

      // Newest-first (consistent with the single-namespace list contract).
      merged.sort((a, b) => b.createdAt - a.createdAt);
      return merged.slice(offset, offset + limit);
    },

    async forget(id: string, namespace?: string): Promise<void> {
      // Deletes target the private namespace only. Shared records cannot be
      // removed through this wrapper; promotion (private → shared) is a
      // deliberate bureau-level act, and the inverse must be too.
      return privateMemory.forget(id, namespace);
    },

    async forgetAll(namespace?: string): Promise<void> {
      // Clears the private namespace only, for the same reason.
      return privateMemory.forgetAll(namespace);
    },

    async count(): Promise<number> {
      if (sharedMemory === undefined) {
        return privateMemory.count();
      }
      // Sum of both namespaces' live records.
      const [privateCount, sharedCount] = await Promise.all([
        privateMemory.count(),
        sharedMemory.count(),
      ]);
      return privateCount + sharedCount;
    },

    async init(): Promise<void> {
      await privateMemory.init();
      if (sharedMemory !== undefined) {
        await sharedMemory.init();
      }
    },

    async close(): Promise<void> {
      await privateMemory.close();
      if (sharedMemory !== undefined) {
        await sharedMemory.close();
      }
    },
  };
}
