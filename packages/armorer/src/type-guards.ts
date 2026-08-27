/**
 * Type guard: returns true if the value implements the AsyncIterable protocol.
 */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
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

/**
 * Returns true when the current process is running inside a test runner.
 */
export function isTestRuntime(): boolean {
  // `createTool` and `createToolbox` are also valid in browser bundles. Reading
  // `process` directly makes their constructors throw before a tool executes.
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined>; argv?: string[] };
    }
  ).process;
  const nodeEnvIsTest = runtimeProcess?.env?.NODE_ENV === 'test';
  const entry = runtimeProcess?.argv?.[1] ?? '';
  const testEntrypoint = /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry);
  return nodeEnvIsTest || testEntrypoint;
}
