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

  if (value && typeof value === 'object') {
    const record: Record<string, JSONValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      record[key] = toJSONValue(entry);
    }
    return record;
  }

  return String(value as string);
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
