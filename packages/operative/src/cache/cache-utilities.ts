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
 * `deletePrefix` is a required member of Weft's TextValueStore (0.2.1), so the
 * prefix wipe needs no list-and-delete fallback.
 *
 * @returns The number of entries deleted.
 */
export async function clearCache(
  store: TextValueStore,
  namespace: string = 'llm-cache:',
): Promise<number> {
  return store.deletePrefix(namespace);
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
