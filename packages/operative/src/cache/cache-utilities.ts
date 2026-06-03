/**
 * Utility functions for managing the LLM response cache.
 *
 * These operate directly on a `TextValueStore` and are independent of
 * the middleware — useful for admin tasks like bulk invalidation.
 */

import type { TextValueStore } from '@lostgradient/weft/storage';

/**
 * Deletes all cache entries under the given namespace prefix.
 *
 * Uses `store.deletePrefix` when available for efficiency,
 * otherwise falls back to listing and deleting each key.
 *
 * @returns The number of entries deleted.
 */
export async function clearCache(
  store: TextValueStore,
  namespace: string = 'llm-cache:',
): Promise<number> {
  // TODO(weft-integration): TextValueStore always provides deletePrefix; the
  // list-and-delete fallback below is now reachable only via test doubles that
  // omit the method.
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
  store: TextValueStore,
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
