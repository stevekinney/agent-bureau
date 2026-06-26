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
      // All writes go to the private namespace only. Strip `namespace` from the
      // caller-supplied metadata so that createMemory cannot be redirected to an
      // arbitrary or session namespace via the metadata field — the private
      // memory's configured namespace must always win. Same rationale as the
      // namespace suppression in forget() / forgetAll() below.
      const { namespace: _namespace, ...restMetadata } = metadata ?? {};
      return privateMemory.remember(content, restMetadata);
    },

    async rememberOnce(
      content: string,
      metadata: Partial<MemoryMetadata> & { dedupeKey: string },
    ): Promise<MemoryEntry> {
      // All idempotent writes go to the private namespace only. Strip `namespace`
      // for the same reason as remember() — the caller cannot redirect the write
      // to a non-private namespace by supplying one in metadata. `dedupeKey` is
      // preserved in `rest` since it is a required lookup key, not a routing key.
      const { namespace: _namespace, ...rest } = metadata;
      return privateMemory.rememberOnce(content, rest);
    },

    async recall(
      query: string,
      searchOptions?: MemorySearchOptions,
    ): Promise<MemorySearchResult[]> {
      // Strip a caller-supplied `namespace` from the search options. createMemory's
      // recall gives `options.namespace` precedence over each memory's configured
      // private/shared namespace, so forwarding it would redirect the underlying
      // reads away from the intended pools (and usually return nothing). Each
      // underlying memory must read its own configured namespace. Same rationale
      // as the namespace suppression in remember()/rememberOnce()/forget().
      const { namespace: _namespace, ...recallOptions } = searchOptions ?? {};

      if (sharedMemory === undefined) {
        // Standalone agent: no shared pool, recall private only.
        return privateMemory.recall(query, recallOptions);
      }

      const limit = recallOptions.limit ?? 10;
      // Over-fetch from each namespace so that after merging we can still
      // return a full `limit` of high-quality results. A 2× multiplier gives
      // each side room without materialising the full corpus.
      const fetchLimit = limit * 2;
      const mergedOptions = { ...recallOptions, limit: fetchLimit };

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
      // Strip a caller-supplied `namespace` from the list options so that each
      // underlying memory reads its own configured namespace. createMemory.list
      // gives `options.namespace` precedence over the memory's configured
      // namespace, so forwarding it would redirect both underlying list() calls
      // to the caller namespace (typically a session id) instead of the private
      // and shared pools — returning empty or wrong records. Same rationale as
      // the namespace suppression in recall() / remember() / rememberOnce().
      const { namespace: _namespace, ...listOptionsWithoutNamespace } = listOptions ?? {};

      if (sharedMemory === undefined) {
        return privateMemory.list(listOptionsWithoutNamespace);
      }

      const limit = listOptionsWithoutNamespace.limit ?? 100;
      const offset = listOptionsWithoutNamespace.offset ?? 0;

      // We must fetch at least (offset + limit) records from each namespace so
      // that after merge + sort we can always slice the correct page. Passing
      // `limit: undefined` would be capped at 100 by the underlying Memory
      // implementation's default, producing empty or truncated pages for
      // callers with `offset >= 100` or large combined result sets.
      const fetchLimit = offset + limit;

      // No offset push-down across two sources — merge first, then paginate.
      const [privateEntries, sharedEntries] = await Promise.all([
        privateMemory.list({ ...listOptionsWithoutNamespace, limit: fetchLimit, offset: 0 }),
        sharedMemory.list({ ...listOptionsWithoutNamespace, limit: fetchLimit, offset: 0 }),
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

    async forget(id: string): Promise<void> {
      // Deletes target the private namespace only. The `namespace` argument is
      // intentionally not forwarded: if private and shared memories share the
      // same underlying storage (prefix-namespaced), forwarding a caller-
      // supplied namespace (e.g. the shared namespace name) would let the
      // caller bypass the private-write constraint and delete a shared record.
      return privateMemory.forget(id);
    },

    async forgetAll(): Promise<void> {
      // Clears the private namespace only. Same rationale as forget() above —
      // the namespace argument is dropped to prevent the caller from targeting
      // the shared namespace through this wrapper.
      return privateMemory.forgetAll();
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
