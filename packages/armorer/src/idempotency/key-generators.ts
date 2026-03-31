import { sha256HexSync } from 'interoperability';

/**
 * Recursively sorts object keys to produce deterministic JSON serialization.
 * Arrays preserve element order; only object key order is normalized.
 */
function stableSortKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(stableSortKeys);
  }

  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = stableSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

/**
 * Extracts a field value from an input, returning empty string for null/undefined or non-object input.
 */
function extractField(input: unknown, fieldName: string): unknown {
  if (input === null || input === undefined || typeof input !== 'object') {
    return '';
  }

  const value = (input as Record<string, unknown>)[fieldName];
  return value === null || value === undefined ? '' : value;
}

/**
 * Generates an idempotency key by hashing the entire input with sorted keys.
 * Safe for pure/read-only tools where the full input determines the result.
 */
export function fullInputKey(input: unknown): string {
  const sorted = stableSortKeys(input);
  const serialized = sorted === undefined ? 'undefined' : JSON.stringify(sorted);
  return sha256HexSync(serialized);
}

/**
 * Creates an idempotency key generator that hashes a single field from the input.
 * Useful when only one field (e.g., an ID) determines uniqueness.
 */
export function fieldKey(fieldName: string): (input: unknown) => string {
  return (input: unknown): string => {
    const value = extractField(input, fieldName);
    return sha256HexSync(JSON.stringify(value));
  };
}

/**
 * Creates an idempotency key generator that hashes multiple fields from the input.
 * Fields are extracted in order and concatenated into an array before hashing.
 */
export function compositeKey(...fieldNames: string[]): (input: unknown) => string {
  return (input: unknown): string => {
    const values = fieldNames.map((name) => extractField(input, name));
    return sha256HexSync(JSON.stringify(values));
  };
}

/**
 * Creates an idempotency key generator that prefixes the result of another key generator
 * with a tool name. Prevents key collisions across tools sharing the same cache.
 */
export function namespacedKey(
  toolName: string,
  keyFn: (input: unknown) => string,
): (input: unknown) => string {
  return (input: unknown): string => {
    return `${toolName}:${keyFn(input)}`;
  };
}
