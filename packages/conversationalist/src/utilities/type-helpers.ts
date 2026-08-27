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

/** Deeply freezes a JSON-compatible public value. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.isFrozen(value) ? value : Object.freeze(value);
}

/**
 * Converts a value to its readonly variant at both the type and runtime levels.
 */
export function toReadonly<T>(value: T): Readonly<T> {
  return deepFreeze(value);
}
