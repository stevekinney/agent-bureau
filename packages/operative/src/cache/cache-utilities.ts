/**
 * Utility functions for managing the LLM response cache.
 *
 * These operate directly on a `KeyValueStore` and are independent of
 * the middleware — useful for admin tasks like bulk invalidation.
 */

import type { KeyValueStore } from 'storage';

/**
 * Deletes all cache entries under the given namespace prefix.
 *
 * Uses `store.deletePrefix` when available for efficiency,
 * otherwise falls back to listing and deleting each key.
 *
 * @returns The number of entries deleted.
 */
export async function clearCache(
  store: KeyValueStore,
  namespace: string = 'llm-cache:',
): Promise<number> {
  if (store.deletePrefix) {
    return store.deletePrefix(namespace);
  }

  const keys = await store.list(namespace);
  for (const key of keys) {
    await store.delete(key);
  }
  return keys.length;
}

/**
 * Deletes cache entries whose keys contain the given pattern
 * within the specified namespace.
 *
 * @returns The number of entries deleted.
 */
export async function invalidateCache(
  store: KeyValueStore,
  namespace: string,
  pattern: string,
): Promise<number> {
  const keys = await store.list(namespace);
  let count = 0;

  for (const key of keys) {
    if (key.includes(pattern)) {
      await store.delete(key);
      count++;
    }
  }

  return count;
}
