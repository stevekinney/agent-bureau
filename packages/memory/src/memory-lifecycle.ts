import type { Embedder } from '@lostgradient/embeddings';

import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from './memory-record-storage';
import type { TextSearchProvider } from './text-search-provider';
import type { Memory, MemoryListOptions, MemoryMetadata, MemorySearchResult } from './types';

interface MemoryLifecycleContext {
  storage: MemoryRecordStorage;
  defaultNamespace: string;
  textSearchProvider: TextSearchProvider | undefined;
  embedder: Embedder;
  scopeFor(namespace: string): MemoryRecordScope;
  toMemoryMetadata(record: MemoryRecord): MemoryMetadata;
}

type NamespaceClearableEmbedder = Embedder & {
  clearNamespace(namespace: string): void | Promise<void>;
};

function hasNamespaceClearer(embedder: Embedder): embedder is NamespaceClearableEmbedder {
  return 'clearNamespace' in embedder && typeof embedder.clearNamespace === 'function';
}

export function createMemoryLifecycleMethods(
  context: MemoryLifecycleContext,
): Pick<Memory, 'list' | 'forget' | 'forgetAll' | 'count' | 'init' | 'close'> {
  const { storage, defaultNamespace, textSearchProvider, embedder } = context;
  const scopeFor = (namespace: string): MemoryRecordScope => context.scopeFor(namespace);
  const toMemoryMetadata = (record: MemoryRecord): MemoryMetadata =>
    context.toMemoryMetadata(record);
  return {
    async list(listOptions?: MemoryListOptions): Promise<MemorySearchResult[]> {
      const namespace = listOptions?.namespace ?? defaultNamespace;
      const limit = listOptions?.limit ?? 100;
      const offset = listOptions?.offset ?? 0;

      // Storage returns records newest-first; pagination is pushed down.
      const records = await storage.list(scopeFor(namespace), { limit, offset });

      return records.map((record) => ({
        id: record.id,
        content: record.content,
        score: 1, // No semantic scoring for list.
        metadata: toMemoryMetadata(record),
        createdAt: record.createdAt,
      }));
    },

    async forget(id: string, namespace?: string): Promise<void> {
      const removed = await storage.delete(id, scopeFor(namespace ?? defaultNamespace));
      // Only strip the text-index entry if the scoped delete actually removed the
      // record. `textSearchProvider.remove(id)` is keyed by bare id while
      // `storage.delete` is scope-keyed, so an unmatched-namespace forget must NOT
      // evict the index entry of the record still living under its real scope.
      if (removed && textSearchProvider) {
        await textSearchProvider.remove(id);
      }
    },

    async forgetAll(namespace?: string): Promise<void> {
      const targetNamespace = namespace ?? defaultNamespace;
      await storage.deleteNamespace(scopeFor(targetNamespace));
      if (textSearchProvider) {
        await textSearchProvider.clear(targetNamespace);
      }
      // Cascade: clear embedding cache entries for this namespace if the
      // embedder supports namespace-scoped eviction.
      if (hasNamespaceClearer(embedder)) {
        await embedder.clearNamespace(targetNamespace);
      }
    },

    async count(namespace?: string): Promise<number> {
      return storage.count(scopeFor(namespace ?? defaultNamespace));
    },

    async init(): Promise<void> {
      await storage.init();
      if (textSearchProvider) {
        await textSearchProvider.init();
      }
    },

    async close(): Promise<void> {
      await storage.close();
      if (textSearchProvider) {
        await textSearchProvider.close();
      }
    },
  };
}
