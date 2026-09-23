import { toolResultSchema } from '../schemas';
import type { JSONValue, ToolResult } from '../types';

const canonicalToolResultSchema = toolResultSchema.omit({ callId: true }).strip();

/**
 * Coerces an unknown value into a JSON-serializable value.
 */
export function toJSONValue(value: unknown): JSONValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJSONValue(item));
  }

  // `null` returned above, so this is a non-null, non-array object.
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJSONValue(entry)]),
    );
  }

  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return value.toString();
  }

  return 'undefined';
}

/**
 * Attempts to parse a JSON string, returning undefined on failure.
 */
export function parseJSONValue(value: string): JSONValue | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return toJSONValue(parsed);
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
  return canonicalToolResultSchema.safeParse(value).success;
}
