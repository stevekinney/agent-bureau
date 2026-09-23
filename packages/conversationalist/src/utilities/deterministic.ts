import type { JSONValue } from '../types';

function isJSONArray(value: JSONValue): value is readonly JSONValue[] {
  return Array.isArray(value);
}

/**
 * Recursively sorts object keys alphabetically for deterministic JSON output.
 * Arrays are processed recursively but maintain their element order.
 * Primitives and null are returned as-is.
 *
 * @param obj - The value to process
 * @returns A new object with sorted keys (or the original value for non-objects)
 *
 * @example
 * ```ts
 * sortObjectKeys({ z: 1, a: 2 });
 * // Returns: { a: 2, z: 1 }
 *
 * sortObjectKeys({ b: { y: 1, x: 2 }, a: 1 });
 * // Returns: { a: 1, b: { x: 2, y: 1 } }
 * ```
 */
export function sortObjectKeys<T extends JSONValue | undefined>(obj: T): T;
export function sortObjectKeys(obj: JSONValue | undefined): JSONValue | undefined {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (isJSONArray(obj)) {
    return obj.map((value) => sortObjectKeys(value));
  }

  return Object.fromEntries(
    Object.entries(obj)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => [key, sortObjectKeys(value)]),
  );
}

/**
 * Sorts messages by position for deterministic output.
 * When positions are equal, falls back to createdAt, then id.
 *
 * @param messages - Array of messages to sort
 * @returns A new sorted array (does not mutate the original)
 *
 * @example
 * ```ts
 * const sorted = sortMessagesByPosition(messages);
 * // Messages are ordered by position (ascending)
 * ```
 */
export function sortMessagesByPosition<
  T extends { position: number; createdAt: string; id: string },
>(messages: readonly T[]): T[] {
  return messages.toSorted((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
  });
}
