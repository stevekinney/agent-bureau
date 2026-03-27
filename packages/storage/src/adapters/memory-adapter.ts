import type { KeyValueStore, KeyValueStoreOptions } from '../types';
import { withNamespace } from '../with-namespace';

/**
 * Creates an in-memory KeyValueStore backed by a Map.
 *
 * Suitable for testing and ephemeral use. All data is lost when the
 * process exits. Zero external dependencies.
 */
export function createMemoryKeyValueStore(options?: KeyValueStoreOptions): KeyValueStore {
  const map = new Map<string, string>();

  const store: KeyValueStore = {
    get(key: string): Promise<string | null> {
      return Promise.resolve(map.get(key) ?? null);
    },

    set(key: string, value: string): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      map.delete(key);
      return Promise.resolve();
    },

    list(prefix: string): Promise<string[]> {
      const matching = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
      return Promise.resolve(matching);
    },

    has(key: string): Promise<boolean> {
      return Promise.resolve(map.has(key));
    },

    deletePrefix(prefix: string): Promise<number> {
      let count = 0;
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) {
          map.delete(key);
          count++;
        }
      }
      return Promise.resolve(count);
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };

  if (options?.namespace) {
    return withNamespace(store, options.namespace);
  }

  return store;
}
