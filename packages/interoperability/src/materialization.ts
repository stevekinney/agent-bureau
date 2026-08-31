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
 * Terminal rendering for a value whose own coercion hooks throw. Only reached once `String()` has
 * failed on both the value and its cycle-elided form, so there is no faithful rendering left to
 * produce — and deliberately a constant, so producing it cannot itself throw.
 */
const UNSTRINGIFIABLE_TAG = '[unstringifiable]';

/**
 * Last-resort coercion of a value that has already been proven non-JSON-serializable (it failed
 * `assertJSONValue` and either threw or round-tripped to `undefined` through `JSON.stringify`).
 * The `String()` default — including the `[object Object]` sentinel for plain objects — is the
 * documented fallback that consumers (armorer, conversationalist, operative) rely on, so it is
 * preserved deliberately.
 *
 * `String()` is attempted first and unconditionally, so whatever the engine would normally
 * produce is what callers get: a custom `toString`, `Symbol.toPrimitive`, or overridden `join`
 * is honoured, in the right order, reading any accessor-backed hook exactly once.
 *
 * The retry exists because `Array.prototype.join`'s cycle guard is an engine extension rather
 * than a spec requirement. Bun 1.3.13 renders `[1, 2, <self>]` as `'1,2,'`; Bun 1.4.0 recurses
 * until the stack overflows, throwing a `RangeError` out of what is meant to be a total
 * normalization step. Eliding the cycles and retrying reproduces the guarded result, so both
 * engines agree. Reacting to the throw rather than predicting it also means no cross-realm array
 * (whose `Array.prototype` is a different object) and no oddly-shaped hook (`Symbol.toPrimitive`
 * set to `null`, which coercion treats as absent) can be misclassified in advance.
 *
 * Known trade-off, accepted deliberately: on an engine that throws, a cyclic array whose elements
 * carry effectful coercion hooks invokes those hooks during the failed attempt and again on the
 * retry. Avoiding that would mean classifying the array before coercing it, which is the approach
 * this replaced — it produced four distinct misclassification defects, each of which let the
 * original `RangeError` back through. Duplicate invocation of a side-effecting hook, on a value
 * already proven non-JSON, on the failure path of one engine, is the cheaper failure than
 * reintroducing the crash this exists to prevent.
 */
function stringifyNonJSON(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      // Inside the try: walking the value can itself run user code — an index getter, or a
      // Proxy trap — and a throw from the traversal must not escape any more than a throw from
      // the coercion it is trying to rescue.
      const elided = elideArrayCycles(value, new WeakSet());

      // Nothing was elided, so there is no cycle to break and a retry would invoke the same
      // throwing hook on the same value and fail identically — twice for no benefit.
      if (elided === value) return UNSTRINGIFIABLE_TAG;

      return String(elided);
    } catch {
      // A coercion hook that throws for its own reasons, on a value with no cycle this function
      // can break. Materialization normalizes, it does not validate, so even here it must
      // produce a string rather than propagate.
      //
      // This is a constant rather than `Object.prototype.toString.call(value)` because that
      // performs `Get(value, Symbol.toStringTag)` — another input-controlled property, whose
      // accessor can throw and would defeat the totality this branch exists to provide. Nothing
      // here dispatches through the value at all.
      return UNSTRINGIFIABLE_TAG;
    }
  }
}

/**
 * `Array.isArray` narrows an `unknown` to `any[]`, which silently turns every element read into
 * an `any`. This predicate keeps the elements typed as `unknown` so they stay narrowed
 * deliberately rather than by accident. Like `Array.isArray`, it is realm-agnostic.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Returns `value` with every back-reference to an array already open on the current path replaced
 * by an empty string — the same substitution a cycle-guarding `Array.prototype.join` performs.
 * Non-array values are returned untouched, so object rendering is unaffected. `Array.isArray` is
 * realm-agnostic, so an array from a VM sandbox or iframe is handled like any other.
 *
 * The `WeakSet` is path-scoped (entries are removed on the way back up), so a shared-but-acyclic
 * reference is rendered normally instead of being mistaken for a cycle.
 *
 * An array is rebuilt only when something beneath it actually changed, and the original is
 * returned by reference otherwise. That keeps the rewrite confined to the cyclic path: a nested
 * acyclic array carrying its own `toString` or `join` survives intact and still renders through
 * its own hook, instead of being flattened into a plain clone. The check is purely structural —
 * nothing inspects a coercion hook to decide.
 */
function elideArrayCycles(value: unknown, open: WeakSet<object>): unknown {
  if (!isUnknownArray(value)) return value;
  if (open.has(value)) return '';

  // `length` is read once up front: `value` may be a Proxy, whose `get` trap would otherwise fire
  // on every iteration and could report a different length each time.
  const length = value.length;

  // `Array.isArray` is true for a Proxy over an array, and a trap may report any `length` at all
  // — `Infinity` would spin the loop forever, which is a worse failure than the throw this
  // function exists to prevent. Anything outside a real array's index range is left untouched.
  if (!Number.isSafeInteger(length) || length < 0) return value;

  open.add(value);

  // Indices are walked directly rather than through `value.map`. `map` is an input-controlled
  // property — an array can carry an own `map`, or be a subclass that overrides it — and
  // dispatching through it could throw from inside the one function that exists to guarantee a
  // string is always produced. `String()` never consults `map`, so neither does this.
  const elided: unknown[] = [];
  let changed = false;
  for (let index = 0; index < length; index += 1) {
    const entry: unknown = value[index];
    const elidedEntry = elideArrayCycles(entry, open);
    // `Object.is`, not `!==`: `NaN !== NaN` would report an untouched element as changed and
    // rebuild an acyclic array that should have been returned by reference, discarding its hook.
    if (!Object.is(elidedEntry, entry)) changed = true;
    elided.push(elidedEntry);
  }

  open.delete(value);

  return changed ? elided : value;
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
