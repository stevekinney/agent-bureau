import type { KeyValueStore } from './types';

/**
 * Wraps a KeyValueStore with automatic namespace prefixing.
 *
 * All keys are transparently prefixed with `${namespace}:` on write
 * and stripped on read. This is the single source of truth for namespace
 * logic — adapters do not implement their own.
 *
 * Namespaces can be nested: wrapping a namespaced store with another
 * namespace produces `outer:inner:key`.
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
    namespaced.has = (key: string): Promise<boolean> => {
      return store.has!(`${prefix}${key}`);
    };
  }

  if (store.deletePrefix) {
    namespaced.deletePrefix = (deletePrefix: string): Promise<number> => {
      return store.deletePrefix!(`${prefix}${deletePrefix}`);
    };
  }

  if (store.close) {
    namespaced.close = (): Promise<void> => {
      return store.close!();
    };
  }

  return namespaced;
}
