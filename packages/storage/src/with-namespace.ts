import type { KeyValueStore } from './types';

/**
 * Wraps a KeyValueStore with automatic namespace prefixing.
 *
 * All keys are transparently prefixed with `${namespace}:` on write
 * and stripped on read. This is the single source of truth for namespace
 * logic — adapters do not implement their own.
 *
 * Namespaces can be nested: `withNamespace(withNamespace(store, 'a'), 'b')`
 * produces keys prefixed `b:a:`. The `list()` method strips its own
 * prefix from returned keys; `get()` and other methods do not strip.
 */
export function withNamespace(store: KeyValueStore, namespace: string): KeyValueStore {
  const prefix = `${namespace}:`;

  const namespaced: KeyValueStore = {
    get(key: string): Promise<string | null> {
      return store.get(`${prefix}${key}`);
    },

    set(key: string, value: string): Promise<void> {
      return store.set(`${prefix}${key}`, value);
    },

    delete(key: string): Promise<void> {
      return store.delete(`${prefix}${key}`);
    },

    async list(listPrefix: string): Promise<string[]> {
      const keys = await store.list(`${prefix}${listPrefix}`);
      return keys.map((key) => key.slice(prefix.length));
    },
  };

  if (store.has) {
    const has = store.has.bind(store);
    namespaced.has = (key: string): Promise<boolean> => has(`${prefix}${key}`);
  }

  if (store.deletePrefix) {
    const deletePrefix = store.deletePrefix.bind(store);
    namespaced.deletePrefix = (dp: string): Promise<number> => deletePrefix(`${prefix}${dp}`);
  }

  if (store.close) {
    const close = store.close.bind(store);
    namespaced.close = (): Promise<void> => close();
  }

  return namespaced;
}
