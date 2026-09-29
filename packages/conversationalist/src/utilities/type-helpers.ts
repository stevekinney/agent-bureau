/**
 * Type-safe hasOwnProperty check.
 * Narrows the type to include the checked property.
 */
export function hasOwnProperty<X extends object, Y extends PropertyKey>(
  obj: X,
  prop: Y,
): obj is X & Record<Y, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

/**
 * Objects `deepFreeze` has finished freezing. Every object reachable from one
 * is frozen too, so a member can never change again: it is safe to share and
 * needs no second walk.
 */
const deeplyFrozen = new WeakSet<object>();

/** Deeply freezes a JSON-compatible public value. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || deeplyFrozen.has(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  const frozen = Object.isFrozen(value) ? value : Object.freeze(value);
  deeplyFrozen.add(value);
  return frozen;
}

/**
 * `structuredClone`, except that anything below the top level that
 * `deepFreeze` has already made immutable is shared rather than copied. The
 * top-level value is always a new object, so the caller never gets its own
 * object back. Committing a conversation clones it
 * so caller-owned objects are never frozen in place; the messages it carries
 * over from the previous commit are already immutable, and copying them made
 * every commit copy the whole transcript and left history nodes sharing
 * nothing. Values that are not plain data, or that contain a cycle, fall back
 * to a full `structuredClone`.
 */
export function cloneSharingFrozen<T>(value: T): T {
  const ancestors = new Set<object>();
  let fallback = false;
  const clone = (nested: unknown, depth: number): unknown => {
    if (fallback || nested === null || typeof nested !== 'object') return nested;
    if (depth > 0 && deeplyFrozen.has(nested)) return nested;
    const prototype: unknown = Object.getPrototypeOf(nested);
    const plain = Array.isArray(nested) || prototype === Object.prototype || prototype === null;
    if (!plain || ancestors.has(nested)) {
      fallback = true;
      return nested;
    }
    ancestors.add(nested);
    const copy = Array.isArray(nested)
      ? nested.map((entry) => clone(entry, depth + 1))
      : Object.fromEntries(
          Object.entries(nested).map(([key, entry]) => [key, clone(entry, depth + 1)]),
        );
    ancestors.delete(nested);
    return copy;
  };
  const copy = clone(value, 0);
  return fallback ? structuredClone(value) : (copy as T);
}

/** Converts a value to its readonly type without changing runtime ownership. */
export function toReadonly<T>(value: T): Readonly<T> {
  return value;
}
