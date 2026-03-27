import type { KeyValueStore } from '../types';

/**
 * Creates a mock KeyValueStore backed by a Map for testing.
 *
 * Exposes the underlying `store` Map for direct assertions in tests.
 * Replaces the hand-rolled mocks in memory and skills test directories.
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
      return Promise.resolve([...store.keys()].filter((key) => key.startsWith(prefix)));
    },
  };
}
