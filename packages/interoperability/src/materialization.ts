import type {
  JSONValue,
  ToolAction,
  ToolCall,
  ToolCallInput,
  ToolResult,
  ToolResultInput,
} from './types';

export interface MaterializeToolCallOptions {
  generateId?: () => string;
}

export interface MaterializeToolResultOptions {
  signal?: AbortSignal | undefined;
}

export function materializeToolCall(
  toolCall: ToolCallInput,
  options: MaterializeToolCallOptions = {},
): ToolCall {
  return {
    id: toolCall.id ?? options.generateId?.() ?? crypto.randomUUID(),
    name: toolCall.name,
    arguments: normalizeJSONValue(toolCall.arguments ?? {}),
  };
}

export function materializeToolCalls(
  toolCalls: ReadonlyArray<ToolCallInput>,
  options: MaterializeToolCallOptions = {},
): ToolCall[] {
  return toolCalls.map((toolCall) => materializeToolCall(toolCall, options));
}

export function materializeToolResult(toolResult: ToolResultInput): ToolResult {
  if (hasStreamingPayload(toolResult)) {
    throw new Error(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  }

  return stripRuntimeToolResultFields(toolResult, normalizeJSONValue(toolResult.content));
}

export function materializeToolResults(toolResults: ReadonlyArray<ToolResultInput>): ToolResult[] {
  return toolResults.map((toolResult) => materializeToolResult(toolResult));
}

export async function materializeToolResultAsync(
  toolResult: ToolResultInput,
  options: MaterializeToolResultOptions = {},
): Promise<ToolResult> {
  const streamingPayload = getStreamingPayload(toolResult);
  if (!streamingPayload) {
    return stripRuntimeToolResultFields(toolResult, normalizeJSONValue(toolResult.content));
  }

  const chunks = await collectAsyncIterable(streamingPayload, options.signal);
  return stripRuntimeToolResultFields(toolResult, normalizeJSONValue(chunks));
}

export async function materializeToolResultsAsync(
  toolResults: ReadonlyArray<ToolResultInput>,
  options: MaterializeToolResultOptions = {},
): Promise<ToolResult[]> {
  return Promise.all(
    toolResults.map((toolResult) => materializeToolResultAsync(toolResult, options)),
  );
}

function stripRuntimeToolResultFields(toolResult: ToolResultInput, content: JSONValue): ToolResult {
  return {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content,
    ...(toolResult.error
      ? {
          error: {
            code: toolResult.error.code,
            category: toolResult.error.category,
            retryable: toolResult.error.retryable,
            message: toolResult.error.message,
            ...(toolResult.error.details !== undefined
              ? { details: normalizeJSONValue(toolResult.error.details) }
              : {}),
          },
        }
      : {}),
    ...(toolResult.action ? { action: normalizeToolAction(toolResult.action) } : {}),
    ...(toolResult.inputDigest ? { inputDigest: toolResult.inputDigest } : {}),
    ...(toolResult.outputDigest ? { outputDigest: toolResult.outputDigest } : {}),
  };
}

function normalizeToolAction(
  action: NonNullable<ToolResultInput['action']>,
): NonNullable<ToolAction> {
  return {
    type: action.type,
    ...(action.message ? { message: action.message } : {}),
    ...(action.schema !== undefined ? { schema: normalizeJSONValue(action.schema) } : {}),
  };
}

function hasStreamingPayload(toolResult: ToolResultInput): boolean {
  return getStreamingPayload(toolResult) !== undefined;
}

function getStreamingPayload(toolResult: ToolResultInput): AsyncIterable<unknown> | undefined {
  if (toolResult.stream) {
    return toolResult.stream;
  }

  if (isAsyncIterable(toolResult.result)) {
    return toolResult.result;
  }

  return undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  return Symbol.asyncIterator in value;
}

function normalizeJSONValue(value: unknown): JSONValue {
  if (value === undefined) {
    return null;
  }

  try {
    assertJSONValue(value, 'tool materialization');
    return value;
  } catch {
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined
        ? stringifyNonJSON(value)
        : (JSON.parse(serialized) as JSONValue);
    } catch {
      return stringifyNonJSON(value);
    }
  }
}

/**
 * Last-resort coercion of a value that has already been proven non-JSON-serializable (it failed
 * `assertJSONValue` and either threw or round-tripped to `undefined` through `JSON.stringify`).
 * The `String()` default — including the `[object Object]` sentinel for plain objects — is the
 * documented fallback that consumers (armorer, conversationalist, operative) rely on, so it is
 * preserved deliberately.
 *
 * Self-referential arrays are elided first because `String()` is not safe to call on them across
 * every supported runtime. `Array.prototype.join`'s cycle guard is an engine extension, not a
 * spec requirement: Bun 1.3.13 yields `'1,2,'` for `[1, 2, <self>]`, while Bun 1.4.0 recurses
 * until the stack overflows and throws a `RangeError` out of what is supposed to be a total
 * normalization step. Eliding cycles here reproduces the documented result on both, so the output
 * no longer depends on the host's `join` implementation. Circular plain objects are untouched:
 * `String()` renders them as `[object Object]` without recursing, and consumers assert that.
 */
function stringifyNonJSON(value: unknown): string {
  return String(elideArrayCycles(value, new WeakSet()));
}

/**
 * Returns `value` with every back-reference to an array already open on the current path replaced
 * by an empty string — the same substitution a cycle-guarding `Array.prototype.join` performs.
 * Non-array values are returned untouched, so object rendering is unaffected. The `WeakSet` is
 * path-scoped (entries are removed on the way back up), so a shared-but-acyclic reference is
 * rendered normally instead of being mistaken for a cycle.
 *
 * Arrays carrying their own coercion hook are left alone: `String()` routes through the hook
 * rather than through the default comma-join, so the hook's output is what the caller documented
 * and eliding would silently replace it with a joined clone.
 */
function elideArrayCycles(value: unknown, open: WeakSet<object>): unknown {
  if (!Array.isArray(value)) return value;
  if (!usesDefaultArrayCoercion(value)) return value;
  if (open.has(value)) return '';

  open.add(value);

  // Indices are walked directly rather than through `value.map`. `map` is an input-controlled
  // property — an array can carry an own `map` of its own, or be a subclass that overrides it —
  // and dispatching through it could throw from inside the one function that exists to guarantee
  // a string is always produced. `String()` never consults `map`, so neither does this.
  const elided: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    elided.push(elideArrayCycles(value[index], open));
  }

  open.delete(value);

  return elided;
}

/**
 * Whether `String(value)` would render this array through the built-in comma-join — the only path
 * that recurses on a cycle, and therefore the only one that needs eliding. `Array.prototype
 * .toString` delegates to `this.join` when it is callable, so an overridden `join` counts as a
 * custom hook just as much as an overridden `toString` or a `Symbol.toPrimitive`.
 */
function usesDefaultArrayCoercion(value: unknown[]): boolean {
  const coercible = value as { [Symbol.toPrimitive]?: unknown };
  return (
    coercible[Symbol.toPrimitive] === undefined &&
    value.toString === Array.prototype.toString &&
    value.join === Array.prototype.join
  );
}

function assertJSONValue(value: unknown, path: string): asserts value is JSONValue {
  const stack = new WeakSet<object>();

  const walk = (current: unknown, currentPath: string) => {
    if (current === null) return;

    const type = typeof current;
    if (type === 'string' || type === 'boolean') return;

    if (type === 'number') {
      if (Number.isFinite(current)) return;
      throw new TypeError(`Non-finite number at ${currentPath}`);
    }

    if (type === 'undefined' || type === 'bigint' || type === 'function' || type === 'symbol') {
      throw new TypeError(`Invalid JSON value at ${currentPath}`);
    }

    if (Array.isArray(current)) {
      if (stack.has(current)) {
        throw new TypeError(`Circular reference detected at ${currentPath}`);
      }
      stack.add(current);
      for (let index = 0; index < current.length; index += 1) {
        walk(current[index], `${currentPath}[${index}]`);
      }
      stack.delete(current);
      return;
    }

    if (type === 'object') {
      if (!isPlainObject(current)) {
        throw new TypeError(`Non-plain object is not valid JSON at ${currentPath}`);
      }

      const record = current;
      if (stack.has(record)) {
        throw new TypeError(`Circular reference detected at ${currentPath}`);
      }
      stack.add(record);
      for (const key of Object.keys(record)) {
        walk(record[key], `${currentPath}.${key}`);
      }
      stack.delete(record);
    }
  };

  walk(value, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function collectAsyncIterable(
  stream: AsyncIterable<unknown>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const iterator = stream[Symbol.asyncIterator]();

  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await nextWithSignal(iterator, signal);
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    if (signal?.aborted) await iterator.return?.();
  }

  return chunks;
}

async function nextWithSignal<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next();

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
