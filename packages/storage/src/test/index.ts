import type { KeyValueStore } from '../types';

/**
 * Creates a mock KeyValueStore backed by a Map for testing.
 *
 * Exposes the underlying `store` Map for direct assertions in tests.
 * Implements all seven interface methods (4 required + 3 optional) so
 * consumer tests exercise realistic code paths.
 */
export function createMockKeyValueStore(): KeyValueStore & { store: Map<string, string> } {
  const store = new Map<string, string>();

  return {
    store,

    get(key: string): Promise<string | null> {
      return Promise.resolve(store.get(key) ?? null);
    },

    set(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },

    list(prefix: string): Promise<string[]> {
      return Promise.resolve([...store.keys()].filter((key) => key.startsWith(prefix)).sort());
    },

    has(key: string): Promise<boolean> {
      return Promise.resolve(store.has(key));
    },

    deletePrefix(prefix: string): Promise<number> {
      let count = 0;
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          count++;
        }
      }
      return Promise.resolve(count);
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
