import { sha256HexSync } from '@lostgradient/cryptography';

import type { JsonValue } from '../core/serialization/json';
import { assertJsonValue } from '../core/serialization/json';
import type { ToolDigestOptions } from '../is-tool';

export function normalizeDigestOptions(input?: ToolDigestOptions): {
  input: boolean;
  output: boolean;
  algorithm: 'sha256';
} {
  if (!input) return { input: false, output: false, algorithm: 'sha256' };
  if (input === true) return { input: true, output: true, algorithm: 'sha256' };
  return {
    input: input.input !== false,
    output: input.output !== false,
    algorithm: input.algorithm ?? 'sha256',
  };
}

export function computeDigest(value: unknown, _algorithm: 'sha256'): string {
  return sha256HexSync(stableStringify(value) ?? '');
}

export function normalizeToolContent(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    assertJsonValue(value, 'tool result');
    return value;
  } catch {
    return normalizeNonJsonContent(value);
  }
}

function normalizeNonJsonContent(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return primitiveFallbackContent(value);
    return normalizeParsedJsonContent(JSON.parse(serialized));
  } catch {
    return stableStringify(value) ?? primitiveFallbackContent(value);
  }
}

export function stableStringify(value: unknown): string | undefined {
  if (isNullish(value)) return String(value);
  if (isPrimitiveStringifiable(value)) return String(value);
  if (value instanceof Error) return stringifyError(value);
  if (Array.isArray(value)) return stringifyArray(value);
  if (typeof value === 'object') return stringifyObject(value);
  return JSON.stringify(value);
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function isPrimitiveStringifiable(value: unknown): value is string | number | boolean | bigint {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

function stringifyError(value: Error): string {
  return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
}

function stringifyArray(value: unknown[]): string {
  return `[${value.map((item) => stableStringify(item)).join(',')}]`;
}

function normalizeParsedJsonContent(value: JsonValue): JsonValue {
  return value;
}

function primitiveFallbackContent(value: unknown): string {
  if (typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return value.name ? `[function ${value.name}]` : '[function]';
  return '';
}

function stringifyObject(value: object): string {
  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
}
