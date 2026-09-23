/**
 * Type guard: returns true if the value implements the AsyncIterable protocol.
 */
export function isAsyncIterable<T>(value: T): value is T & AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

/**
 * Type guard: returns true if the value is a PromiseLike (has a callable `.then`).
 */
export function isPromise<T>(value: unknown): value is PromiseLike<T> {
  if (!value || typeof value !== 'object') return false;
  if (!('then' in value)) return false;
  const candidate = value as PromiseLike<unknown>;
  return typeof candidate.then === 'function';
}
