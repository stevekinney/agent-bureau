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
 * Casts a value to its readonly variant.
 * Used to enforce immutability at the type level.
 */
export function toReadonly<T>(value: T): Readonly<T> {
  return value as Readonly<T>;
}
