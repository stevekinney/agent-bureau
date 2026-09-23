import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import type {
  JSONValue,
  ToolAction,
  ToolApprovalAction,
  ToolApprovalOperation,
  ToolApprovalRisk,
  ToolApprovalSandbox,
  ToolCall,
  ToolCallInput,
  ToolResult,
  ToolResultInput,
} from './types';

export interface MaterializeToolCallOptions {
  generateId?: () => string;
  /** Runtime services from `lifecycle`; its `identifiers` seam backs the default id when neither `toolCall.id` nor `generateId` is supplied. Defaults to the real (`crypto.randomUUID()`-backed) implementation. */
  runtime?: RuntimeServices;
}

export interface MaterializeToolResultOptions {
  signal?: AbortSignal | undefined;
}

export function materializeToolCall(
  toolCall: ToolCallInput,
  options: MaterializeToolCallOptions = {},
): ToolCall {
  return {
    id:
      toolCall.id ??
      options.generateId?.() ??
      (options.runtime ?? createDefaultRuntimeServices()).identifiers.next('tool-call'),
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
  if (action.type === 'input') {
    return {
      type: 'input',
      ...(action.message ? { message: action.message } : {}),
      ...(action.schema !== undefined ? { schema: normalizeJSONValue(action.schema) } : {}),
    };
  }
  if (action.type !== 'approval') {
    throw new Error('Tool action type must be "approval" or "input".');
  }
  return normalizeApprovalAction(action);
}

function normalizeApprovalAction(
  action: NonNullable<ToolResultInput['action']>,
): ToolApprovalAction {
  assertKnownKeys(action, 'approval action', [
    'type',
    'message',
    'risk',
    'operation',
    'sandbox',
    'env',
    'snapshotId',
    'expiresAt',
    'editableArgs',
    'policyVersion',
    'idempotencyKey',
  ]);
  const risk = normalizeApprovalRisk(action.risk);
  const operation = normalizeApprovalOperation(action.operation);
  const policyVersion = requiredString(action.policyVersion, 'approval action policyVersion');
  const idempotencyKey = requiredString(action.idempotencyKey, 'approval action idempotencyKey');
  return {
    type: 'approval',
    ...(action.message ? { message: action.message } : {}),
    risk,
    operation,
    ...(action.sandbox !== undefined ? { sandbox: normalizeApprovalSandbox(action.sandbox) } : {}),
    ...(action.env !== undefined
      ? { env: normalizeStringArray(action.env, 'approval action env') }
      : {}),
    ...(action.snapshotId !== undefined
      ? { snapshotId: requiredString(action.snapshotId, 'approval action snapshotId') }
      : {}),
    ...(action.expiresAt !== undefined
      ? { expiresAt: normalizeApprovalExpiresAt(action.expiresAt) }
      : {}),
    ...(action.editableArgs !== undefined
      ? { editableArgs: requiredBoolean(action.editableArgs, 'approval action editableArgs') }
      : {}),
    policyVersion,
    idempotencyKey,
  };
}

function normalizeApprovalRisk(value: unknown): ToolApprovalRisk {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('Approval action risk must be "low", "medium", or "high".');
}

function normalizeApprovalOperation(value: unknown): ToolApprovalOperation {
  const operation = requiredRecord(value, 'approval action operation');
  const kind = operation['kind'];
  switch (kind) {
    case 'command':
      assertKnownKeys(operation, 'approval command operation', [
        'kind',
        'command',
        'filesTouched',
        'argsPreview',
      ]);
      return {
        kind,
        command: requiredString(operation['command'], 'approval command operation command'),
        ...optionalFilesTouched(operation),
        ...optionalArgsPreview(operation),
      };
    case 'file-write':
      assertKnownKeys(operation, 'approval file-write operation', [
        'kind',
        'filesTouched',
        'argsPreview',
      ]);
      return {
        kind,
        filesTouched: normalizeFilesTouched(operation['filesTouched'], {
          required: true,
          label: 'approval file-write operation filesTouched',
        }),
        ...optionalArgsPreview(operation),
      };
    case 'patch':
      assertKnownKeys(operation, 'approval patch operation', [
        'kind',
        'filesTouched',
        'argsPreview',
        'diff',
      ]);
      return {
        kind,
        ...optionalFilesTouched(operation),
        ...optionalArgsPreview(operation),
        diff: requiredString(operation['diff'], 'approval patch operation diff'),
      };
    case 'other':
      assertKnownKeys(operation, 'approval other operation', [
        'kind',
        'filesTouched',
        'argsPreview',
      ]);
      return {
        kind,
        ...optionalFilesTouched(operation),
        ...optionalArgsPreview(operation),
      };
    default:
      throw new Error('Approval action operation kind is invalid.');
  }
}

function optionalFilesTouched(operation: Record<string, unknown>): {
  filesTouched?: string[];
} {
  if (operation['filesTouched'] === undefined) return {};
  return {
    filesTouched: normalizeFilesTouched(operation['filesTouched'], {
      required: false,
      label: 'approval operation filesTouched',
    }),
  };
}

function normalizeFilesTouched(
  value: unknown,
  options: { required: boolean; label: string },
): string[] {
  const files = normalizeStringArray(value, options.label);
  if (options.required && files.length === 0) {
    throw new Error(`${options.label} must contain at least one path.`);
  }
  return files;
}

function optionalArgsPreview(operation: Record<string, unknown>): {
  argsPreview?: JSONValue | undefined;
} {
  if (operation['argsPreview'] === undefined) return {};
  return { argsPreview: normalizeJSONValue(operation['argsPreview']) };
}

function normalizeApprovalSandbox(value: unknown): ToolApprovalSandbox {
  const sandbox = requiredRecord(value, 'approval action sandbox');
  assertKnownKeys(sandbox, 'approval action sandbox', ['provider', 'name', 'workingDir']);
  return {
    provider: requiredString(sandbox['provider'], 'approval action sandbox provider'),
    name: requiredString(sandbox['name'], 'approval action sandbox name'),
    workingDir: requiredString(sandbox['workingDir'], 'approval action sandbox workingDir'),
  };
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return [...value];
}

function normalizeApprovalExpiresAt(value: unknown): string {
  const expiresAt = requiredString(value, 'approval action expiresAt');
  if (!isExplicitTimezoneIsoDateTime(expiresAt)) {
    throw new Error('Approval action expiresAt must be a valid ISO8601 date-time with timezone.');
  }
  return expiresAt;
}

function isExplicitTimezoneIsoDateTime(value: string): boolean {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?<fraction>\.\d+)?(?<timezone>Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match?.groups) return false;
  const year = Number(match.groups['year']);
  const month = Number(match.groups['month']);
  const day = Number(match.groups['day']);
  const hour = Number(match.groups['hour']);
  const minute = Number(match.groups['minute']);
  const second = Number(match.groups['second']);
  const timezone = match.groups['timezone']!;
  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (timezone !== 'Z') {
    const timezoneHour = Number(timezone.slice(1, 3));
    const timezoneMinute = Number(timezone.slice(4, 6));
    if (timezoneHour > 23 || timezoneMinute > 59) return false;
  }
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day &&
    (timezone !== 'Z' || utc.getUTCHours() === hour) &&
    (timezone !== 'Z' || utc.getUTCMinutes() === minute) &&
    (timezone !== 'Z' || utc.getUTCSeconds() === second)
  );
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: object, label: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new Error(`${label} has unknown field "${unknownKey}".`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
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
      return serialized === undefined ? stringifyNonJSON(value) : parseJSONValue(serialized);
    } catch {
      return stringifyNonJSON(value);
    }
  }
}

function parseJSONValue(serialized: string): JSONValue {
  const parsed: unknown = JSON.parse(serialized);
  assertJSONValue(parsed);
  return parsed;
}

/**
 * Terminal rendering for a value whose own coercion hooks throw. Only reached once `String()` has
 * failed on both the value and its cycle-elided form, so there is no faithful rendering left to
 * produce — and deliberately a constant, so producing it cannot itself throw.
 */
const UNSTRINGIFIABLE_TAG = '[unstringifiable]';

/** Largest length a real array can report: `2 ** 32 - 1` per ECMA-262. A Proxy may claim more. */
const MAXIMUM_ARRAY_LENGTH = 0xffff_ffff;

/**
 * Ceiling on how many entries one cycle-elision traversal may visit in total.
 *
 * The array-length cap bounds a single array, but `0xffff_ffff` is a *legitimate* length for a
 * sparse array, and a nested structure can multiply out well past any single-array bound. Since
 * this runs only after coercion has already thrown, abandoning an oversized traversal and
 * returning the terminal tag is strictly better than spending minutes rebuilding a value nobody
 * can render anyway. Exceeding it throws, which the caller already treats as "no rescue possible".
 */
const MAXIMUM_TRAVERSAL_ENTRIES = 1_000_000;

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
      const elided = elideArrayCycles(value, new WeakSet(), {
        remaining: MAXIMUM_TRAVERSAL_ENTRIES,
      });

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
function elideArrayCycles(
  value: unknown,
  open: WeakSet<object>,
  budget: { remaining: number },
): unknown {
  if (!isUnknownArray(value)) return value;
  if (open.has(value)) return '';

  // `length` is read once up front: `value` may be a Proxy, whose `get` trap would otherwise fire
  // on every iteration and could report a different length each time.
  const length = value.length;

  // `Array.isArray` is true for a Proxy over an array, and a trap may report any `length` at all.
  // `Infinity` would spin the loop forever, and a merely large safe integer is nearly as bad:
  // `Number.isSafeInteger(2 ** 32)` is `true`, so a bare safe-integer check still admits billions
  // of indexed reads. A real array's length cannot exceed 2^32 - 1, so anything outside that
  // range is not a length this walk can honour and the value is left untouched. Hanging would be
  // a worse failure than the throw this function exists to prevent.
  if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_ARRAY_LENGTH) return value;

  open.add(value);

  // Indices are walked directly rather than through `value.map`. `map` is an input-controlled
  // property — an array can carry an own `map`, or be a subclass that overrides it — and
  // dispatching through it could throw from inside the one function that exists to guarantee a
  // string is always produced. `String()` never consults `map`, so neither does this.
  const elided: unknown[] = [];
  let changed = false;
  for (let index = 0; index < length; index += 1) {
    budget.remaining -= 1;
    if (budget.remaining < 0) {
      throw new RangeError('Cycle elision exceeded its traversal budget');
    }

    const entry: unknown = value[index];
    const elidedEntry = elideArrayCycles(entry, open, budget);
    // `Object.is`, not `!==`: `NaN !== NaN` would report an untouched element as changed and
    // rebuild an acyclic array that should have been returned by reference, discarding its hook.
    if (!Object.is(elidedEntry, entry)) changed = true;
    elided.push(elidedEntry);
  }

  open.delete(value);

  return changed ? elided : value;
}

/**
 * Asserts that `value` is a recursive {@link JSONValue}: finite numbers only;
 * dense arrays (every index present, no own keys beyond indices and
 * `length`); plain objects (`Object.prototype` or null prototype) with
 * enumerable string own keys only — no symbols, no non-enumerable custom
 * properties; and no cycles anywhere in the structure. `undefined`, `Date`,
 * `Map`, `Set`, `bigint`, functions, and class instances are all rejected.
 *
 * Exported (AB-18) so operative's structured `output` validation can reuse
 * this exact contract instead of re-implementing it — see
 * {@link isJSONValue} for the non-throwing predicate form.
 */
export function assertJSONValue(value: unknown, path = '$'): asserts value is JSONValue {
  const stack = new WeakSet<object>();
  walkJSONValue(value, path, stack);
}

function walkJSONValue(current: unknown, currentPath: string, stack: WeakSet<object>): void {
  if (current === null || typeof current === 'string' || typeof current === 'boolean') return;

  if (typeof current === 'number') {
    if (Number.isFinite(current)) return;
    throw new TypeError(`Non-finite number at ${currentPath}`);
  }

  if (typeof current !== 'object') {
    throw new TypeError(`Invalid JSON value at ${currentPath}`);
  }

  if (Array.isArray(current)) {
    walkJSONArray(current, currentPath, stack);
    return;
  }

  walkJSONObject(current, currentPath, stack);
}

function walkJSONArray(
  current: readonly unknown[],
  currentPath: string,
  stack: WeakSet<object>,
): void {
  if (stack.has(current)) throw new TypeError(`Circular reference detected at ${currentPath}`);
  if (Object.keys(current).length !== current.length) {
    throw new TypeError(`Sparse array or non-index own property at ${currentPath}`);
  }

  stack.add(current);
  for (let index = 0; index < current.length; index += 1) {
    walkJSONValue(current[index], `${currentPath}[${index}]`, stack);
  }
  stack.delete(current);
}

function walkJSONObject(current: object, currentPath: string, stack: WeakSet<object>): void {
  if (!isPlainObject(current)) {
    throw new TypeError(`Non-plain object is not valid JSON at ${currentPath}`);
  }
  const record = current;
  if (Object.getOwnPropertySymbols(current).length > 0) {
    throw new TypeError(`Symbol-keyed property at ${currentPath}`);
  }

  const enumerableKeys = Object.keys(current);
  if (enumerableKeys.length !== Object.getOwnPropertyNames(current).length) {
    throw new TypeError(`Non-enumerable own property at ${currentPath}`);
  }
  if (stack.has(current)) throw new TypeError(`Circular reference detected at ${currentPath}`);

  stack.add(current);
  for (const key of enumerableKeys) {
    walkJSONValue(record[key], `${currentPath}.${key}`, stack);
  }
  stack.delete(current);
}

/**
 * Non-throwing predicate form of {@link assertJSONValue}. Prefer the
 * `assert` form when a caller wants the failure reason; this form is for
 * plain boolean guards.
 */
export function isJSONValue(value: unknown): value is JSONValue {
  try {
    assertJSONValue(value);
    return true;
  } catch {
    return false;
  }
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
        return resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        return reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
