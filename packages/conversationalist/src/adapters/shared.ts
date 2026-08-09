import type { JSONValue, ToolResult } from '../types';

/**
 * Coerces an unknown value into a JSON-serializable value.
 */
export function toJSONValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJSONValue(item));
  }

  // `null` returned above, so this is a non-null, non-array object.
  if (typeof value === 'object') {
    const record: Record<string, JSONValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = toJSONValue(entry);
    }
    return record;
  }

  // Only `undefined`, `bigint`, `symbol`, and functions remain — none are JSON
  // values, so they degrade to their string form rather than silently vanish.
  // Each is narrowed explicitly so the call resolves to that type's own
  // `toString`, never `Object.prototype.toString`.
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return value.toString();
  }

  // Every other `typeof` result is handled above, so only `undefined` reaches
  // here. The compiler still sees `unknown` — narrowing `unknown` only refines
  // the positive branch — so return the string form directly instead of
  // calling `String` on a value whose type says it could be anything.
  return 'undefined';
}

/**
 * Attempts to parse a JSON string, returning undefined on failure.
 */
export function parseJSONValue(value: string): JSONValue | undefined {
  try {
    return JSON.parse(value) as JSONValue;
  } catch {
    return undefined;
  }
}

/**
 * Type guard that checks whether a JSONValue is a canonical tool-result payload
 * (i.e., an object with `outcome` and `content` fields).
 */
export function isCanonicalToolResultPayload(value: JSONValue): value is JSONValue & {
  outcome: ToolResult['outcome'];
  content: JSONValue;
  error?: ToolResult['error'];
  action?: ToolResult['action'];
  inputDigest?: string;
  outputDigest?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return (
    'outcome' in value &&
    (value['outcome'] === 'success' ||
      value['outcome'] === 'error' ||
      value['outcome'] === 'action_required') &&
    'content' in value
  );
}
